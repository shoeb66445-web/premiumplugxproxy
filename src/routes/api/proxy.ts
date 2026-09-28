/**
 * HLS + DASH CORS proxy — /api/proxy?u=<encoded url>[&cookie=][&ref=][&ua=][&via=host:port]
 *
 * Runs on Cloudflare Workers (TanStack Start / Nitro target).
 * Cloudflare Workers fetch() cannot CONNECT to SOCKS5, so residential proxies
 * are reached via an HTTP CONNECT-capable relay endpoint, not a ProxyAgent.
 * The pool from databay-labs/free-proxy-list is tried through a relay shim.
 *
 * Fetch strategy by CDN surface:
 *
 *   Hotstar (live09p, adfree, livetv, jcevents)
 *     1. HOTSTAR_RELAY env var (single known residential IP — fast, stable).
 *     2. Public Indian proxy pool via relay shim — races in batches of 8.
 *     3. Direct fetch — will 403 from CF datacenter but better than silence.
 *
 *   slivcdn / sonydaimenew.akamaized.net
 *     1. Public Indian proxy pool — batches of 12 (larger dead-entry tail).
 *     2. Direct fetch fallback.
 *
 *   FanCode, jio.com, jiocinema.com
 *     Direct from Cloudflare edge — geo check passes, no proxy needed.
 *
 * via= advisory (pinned proxy written into rewritten playlist URLs):
 *   Tried first. Evicted on latency > PROXY_EVICT_MS or on hard failure.
 *   New winner rides back in X-Proxy-Via header so the next manifest
 *   refresh picks it up automatically.
 *
 * Pool source:
 *   https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt
 *   Refreshed every 15 minutes. Cached in module scope between requests.
 *   Format: one "ip:port" per line. Lines not matching the pattern are dropped.
 *
 * RESIDENTIAL_RELAY_URL (env var):
 *   An HTTP endpoint that accepts:
 *     GET <relay>?url=<encoded>&cookie=<encoded>&ref=<encoded>&ua=<encoded>
 *   and fetches the target URL from a Mumbai residential / campus IP, returning
 *   the upstream response verbatim. Compatible with:
 *     - A second CF Worker on Bright Data / IPRoyal residential egress (IN-MH).
 *     - A Bun/Node server on a Mumbai VPS (DO BLR1, AWS ap-south-1, Hetzner BLR).
 *   If unset, pool entries are reached by constructing the same relay URL pattern
 *   against each pool IP directly (treated as open HTTP proxies).
 *
 * HOTSTAR_RELAY (env var):
 *   A single "host:port" or full HTTP URL for a known residential relay.
 *   Tried before the pool for every Hotstar host. Leave unset to skip.
 */
import { createFileRoute } from '@tanstack/react-router'

// ─── Identity constants ────────────────────────────────────────────────────────

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SONY_UA = DEFAULT_UA

const HOTSTAR_MOBILE_UA =
  'Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)'

const SONY_ORIGIN   = 'https://www.sonyliv.com'
const SONY_REFERER  = 'https://www.sonyliv.com/'
const HOTSTAR_ORIGIN  = 'https://www.hotstar.com'
const HOTSTAR_REFERER = 'https://www.hotstar.com/'

// ─── Allowlist ─────────────────────────────────────────────────────────────────

const ALLOWED = [
  'fancode.com',
  'akamaized.net',
  'akamaihd.net',
  'hotstar.com',
  'slivcdn.com',
  'jio.com',
  'jiocinema.com',
]

/* These hosts reject CF datacenter ASNs — need residential egress. */
const NEEDS_RESIDENTIAL = [
  'slivcdn.com',
  'sonydaimenew.akamaized.net',
  'hotstar.com',
]

/* jcevents returns 403 to a desktop UA regardless of token validity. */
const HOTSTAR_MOBILE_UA_HOSTS = [
  'jcevents.hotstar.com',
  'livetv.hotstar.com',
  'live09p.hotstar.com',
  'adfree.hotstar.com',
]

/* DASH (.mpd) surfaces — need rewriteMpd(), not rewritePlaylist(). */
const DASH_HOSTS = [
  'live09p.hotstar.com',
  'adfree.hotstar.com',
]

const SONY_HOSTS = ['slivcdn.com', 'sonydaimenew.akamaized.net']

const allowed            = (h: string) => ALLOWED.some(s => h === s || h.endsWith('.' + s))
const needsResidential   = (h: string) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s))
const needsMobileUA      = (h: string) => HOTSTAR_MOBILE_UA_HOSTS.some(s => h === s || h.endsWith('.' + s))
const isDashHost         = (h: string) => DASH_HOSTS.some(s => h === s || h.endsWith('.' + s))
const isSonyHost         = (h: string) => SONY_HOSTS.some(s => h === s || h.endsWith('.' + s))
const isHotstarHost      = (h: string) => h === 'hotstar.com' || h.endsWith('.hotstar.com')
const isSlivCDN          = (h: string) => h === 'slivcdn.com' || h.endsWith('.slivcdn.com')

// ─── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
}

// ─── Proxy pool ────────────────────────────────────────────────────────────────

const PROXY_LIST_URL =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt'

/* Module-scope pool cache — survives across requests within one Worker isolate. */
let poolCache: { list: string[]; at: number } = { list: [], at: 0 }

/*
 * known: hostname → { proxy, ms, at }
 * Stores the last proxy that returned 200 and how long it took.
 * Entries with ms > PROXY_EVICT_MS are treated as stale and re-raced.
 */
const knownProxies = new Map<string, { proxy: string; ms: number; at: number }>()
const PROXY_EVICT_MS = 3000

async function getProxyList(): Promise<string[]> {
  if (poolCache.list.length && Date.now() - poolCache.at < 15 * 60_000) {
    return poolCache.list
  }
  try {
    const r    = await fetch(PROXY_LIST_URL, { cache: 'no-store' })
    const txt  = await r.text()
    const list = txt
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l))
    if (list.length) poolCache = { list, at: Date.now() }
  } catch { /* keep existing */ }
  return poolCache.list
}

/*
 * Workers fetch() cannot use ProxyAgent (undici) or CONNECT tunnels.
 * Instead each pool entry is treated as an HTTP relay that accepts:
 *   GET http://<proxyIp:port>/?url=<encoded>&cookie=&ref=&ua=
 *
 * If RESIDENTIAL_RELAY_URL is set, pool entries are forwarded to it with
 * an X-Proxy-IP header so the relay can open the CONNECT tunnel itself.
 * This is the correct Workers-compatible pattern.
 */
async function fetchViaPoolEntry(
  proxyHostPort: string,
  targetUrl: URL,
  upstreamHeaders: Headers,
  cookie: string,
  ref: string,
  ua: string,
  relayUrl: string,
  timeoutMs: number,
): Promise<Response> {
  /*
   * Two modes:
   *   1. RESIDENTIAL_RELAY_URL set: send to the relay with X-Proxy-IP so it
   *      CONNECT-tunnels through the pool entry.
   *   2. No relay: treat the pool entry as a plain HTTP proxy that accepts
   *      a target URL in the query string (open-proxy compatible format).
   */
  let fetchUrl: string
  const fetchHeaders = new Headers(upstreamHeaders)

  if (relayUrl) {
    const u = new URL(relayUrl)
    u.searchParams.set('url',    targetUrl.toString())
    u.searchParams.set('proxy',  proxyHostPort)
    if (cookie) u.searchParams.set('cookie', cookie)
    if (ref)    u.searchParams.set('ref',    ref)
    if (ua)     u.searchParams.set('ua',     ua)
    fetchUrl = u.toString()
    fetchHeaders.set('X-Proxy-IP', proxyHostPort)
  } else {
    /* Open-proxy format: http://proxyip:port/?url=encoded */
    const u = new URL(`http://${proxyHostPort}/`)
    u.searchParams.set('url', targetUrl.toString())
    if (cookie) u.searchParams.set('cookie', cookie)
    if (ref)    u.searchParams.set('ref',    ref)
    if (ua)     u.searchParams.set('ua',     ua)
    fetchUrl = u.toString()
  }

  return fetch(fetchUrl, {
    headers:  fetchHeaders,
    redirect: 'follow',
    signal:   AbortSignal.timeout(timeoutMs),
  })
}

/*
 * Timed fetch via a single pool entry.
 * Returns { res, ms } so callers can evict slow proxies.
 */
async function timedPoolFetch(
  proxy: string,
  targetUrl: URL,
  upstreamHeaders: Headers,
  cookie: string,
  ref: string,
  ua: string,
  relayUrl: string,
  timeoutMs: number,
): Promise<{ res: Response; ms: number }> {
  const t0  = Date.now()
  const res = await fetchViaPoolEntry(proxy, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, timeoutMs)
  return { res, ms: Date.now() - t0 }
}

/*
 * Race the pool in batches. Returns the first proxy + response that answered
 * 200, or null. Batch size: 12 for slivcdn (larger dead-entry tail), 8 elsewhere.
 *
 * The remembered proxy for this hostname is tried first unless its last
 * recorded latency exceeded PROXY_EVICT_MS — in that case it's moved to the
 * end and a fresh proxy leads.
 */
async function findProxy(
  targetUrl: URL,
  upstreamHeaders: Headers,
  cookie: string,
  ref: string,
  ua: string,
  relayUrl: string,
  skip = '',
): Promise<{ proxy: string; res: Response; ms: number } | null> {
  const list = await getProxyList()
  if (!list.length) return null

  const hostname = targetUrl.hostname
  const BATCH    = isSlivCDN(hostname) ? 12 : 8

  const entry   = knownProxies.get(hostname)
  const stale   = entry && entry.ms > PROXY_EVICT_MS
  const pinned  = entry && !stale && entry.proxy !== skip ? entry.proxy : null
  const rest    = list.filter(p => p !== pinned && p !== skip)
  const ordered = pinned ? [pinned, ...rest] : rest

  for (let i = 0; i < Math.min(ordered.length, 48); i += BATCH) {
    const batch = ordered.slice(i, i + BATCH)

    const hit = await Promise.any(
      batch.map(async (p) => {
        const { res, ms } = await timedPoolFetch(p, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 7000)
        if (!res.ok) throw new Error(String(res.status))
        return { proxy: p, res, ms }
      }),
    ).catch(() => null)

    if (hit) {
      knownProxies.set(hostname, { proxy: hit.proxy, ms: hit.ms, at: Date.now() })
      return hit
    }
  }
  return null
}

// ─── Header builders ───────────────────────────────────────────────────────────

function hotstarHeaders(cookie: string, ua: string, ref: string): Headers {
  const referer = ref || HOTSTAR_REFERER
  let origin: string
  try { origin = new URL(referer).origin } catch { origin = HOTSTAR_ORIGIN }

  const h = new Headers({
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent':      ua || HOTSTAR_MOBILE_UA,
    'Referer':         referer,
    'Origin':          origin,
    'Sec-Fetch-Dest':  'empty',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Site':  'cross-site',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
  })
  if (cookie) h.set('Cookie', cookie)
  return h
}

function genericHeaders(ua: string, ref: string, origin: string, cookie: string): Headers {
  const h = new Headers({
    'User-Agent':    ua || DEFAULT_UA,
    'Accept':        'application/vnd.apple.mpegurl, application/x-mpegURL, application/octet-stream;q=0.9, */*;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma':        'no-cache',
  })
  if (ref)    h.set('Referer', ref)
  if (origin) h.set('Origin', origin)
  if (cookie) h.set('Cookie', cookie)
  return h
}

// ─── DASH rewriter ─────────────────────────────────────────────────────────────

/*
 * v2 DASH rewriter — handles all three BaseURL levels per DASH spec.
 *
 * Priority order in DASH: AdaptationSet-level > Period-level > MPD-level.
 * Old v1 approach (inject one MPD-level BaseURL when absent) silently breaks
 * when the manifest carries Period-level or AdaptationSet-level declarations
 * that override the injected one.
 *
 * v2 approach:
 *   1. Resolve every existing <BaseURL> at all levels to absolute and proxy it.
 *   2. Rewrite SegmentTemplate media= and initialization= absolute URLs.
 *   3. If no <BaseURL> existed at any level, inject one at MPD level pointing
 *      at the manifest's directory (v1 fallback, still correct for simple MPDs).
 */
function rewriteMpd(text: string, baseUrl: URL, proxyBase: string, extras: string): string {
  const wrap  = (abs: string) => proxyBase + '?u=' + encodeURIComponent(abs) + extras
  const toAbs = (ref: string) => {
    try { return new URL(ref.trim(), baseUrl).toString() } catch { return ref }
  }
  const dir = baseUrl.href.slice(0, baseUrl.href.lastIndexOf('/') + 1)

  /* Step 1: resolve + proxy all existing <BaseURL> elements. */
  let found = false
  let out = text.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (_, u) => {
    found = true
    return `<BaseURL>${wrap(toAbs(u))}</BaseURL>`
  })

  /* Step 2: SegmentTemplate absolute URL attributes — double-quoted. */
  out = out.replace(
    /\b(media|initialization)="(https?:\/\/[^"]+)"/gi,
    (_, attr, u) => `${attr}="${wrap(u)}"`,
  )
  /* Single-quoted variants. */
  out = out.replace(
    /\b(media|initialization)='(https?:\/\/[^']+)'/gi,
    (_, attr, u) => `${attr}='${wrap(u)}'`,
  )

  /* Step 3: no BaseURL at any level — inject at MPD root (simple manifest fallback). */
  if (!found) {
    out = out.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${wrap(dir)}</BaseURL>`)
  }

  return out
}

// ─── HLS rewriter ──────────────────────────────────────────────────────────────

function rewritePlaylist(text: string, baseUrl: URL, proxyBase: string, extras: string): string {
  const wrap = (abs: string) => proxyBase + '?u=' + encodeURIComponent(abs) + extras

  /* SonyLiv / slivcdn sign at folder level — child URLs without a query string
     inherit the parent's token via this parentQuery injection. */
  const parentQuery = baseUrl.search
  const toAbs = (ref: string) => {
    const u = new URL(ref, baseUrl)
    if (!u.search && parentQuery) u.search = parentQuery
    return u.toString()
  }

  return text
    .split('\n')
    .map(line => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${wrap(toAbs(uri))}"`)
      return wrap(toAbs(t))
    })
    .join('\n')
}

// ─── Segment prefetch ──────────────────────────────────────────────────────────

/*
 * Fire HEAD requests to the first 2 segments after rewriting any manifest.
 * Keeps Hotstar CDN warm — kills the ~800ms cold-start stall that depletes
 * hls.js / dash.js buffer below the panic threshold.
 * ctx.waitUntil() runs these after the manifest is already sent to the player.
 */
function prefetchSegments(
  rewrittenText: string,
  cookie: string,
  ua: string,
  ref: string,
  ctx: { waitUntil: (p: Promise<unknown>) => void } | undefined,
): void {
  if (!ctx?.waitUntil) return
  const re = /https?:\/\/[^\s"'<>]+\.(?:ts|m4s|aac|mp4|fmp4|cmaf)[^\s"'<>]*/gi
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(rewrittenText)) !== null && found.length < 2) found.push(m[0])
  if (!found.length) return
  const h = hotstarHeaders(cookie, ua, ref)
  ctx.waitUntil(
    Promise.allSettled(found.map(url => fetch(url, { method: 'HEAD', headers: h }).catch(() => {}))),
  )
}

// ─── Content-type detectors ────────────────────────────────────────────────────

function isHls(path: string, ct: string): boolean {
  return path.endsWith('.m3u8') || ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl')
}

function isDash(path: string, ct: string): boolean {
  return path.endsWith('.mpd') || ct.includes('dash+xml') || ct.includes('application/xml')
}

// ─── Core proxy handler ────────────────────────────────────────────────────────

async function handleProxy(
  request: Request,
  env?: { RESIDENTIAL_RELAY_URL?: string; HOTSTAR_RELAY?: string },
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const reqUrl = new URL(request.url)
  const target = reqUrl.searchParams.get('u') || reqUrl.searchParams.get('url')
  if (!target) return new Response('Missing ?u=', { status: 400, headers: corsHeaders() })

  let targetUrl: URL
  try { targetUrl = new URL(target) }
  catch { return new Response('Invalid url', { status: 400, headers: corsHeaders() }) }

  if (!allowed(targetUrl.hostname)) {
    return new Response('Host not allowed', { status: 403, headers: corsHeaders() })
  }

  const cookie = reqUrl.searchParams.get('cookie') || ''
  const ref    = reqUrl.searchParams.get('ref')    || ''
  const ua     = reqUrl.searchParams.get('ua')     || ''
  const via    = reqUrl.searchParams.get('via')    || ''
  const host   = targetUrl.hostname

  const relayUrl     = env?.RESIDENTIAL_RELAY_URL || ''
  const hotstarRelay = env?.HOTSTAR_RELAY          || ''

  // ── Assemble upstream headers ──────────────────────────────────────────────

  let upstreamHeaders: Headers

  if (isHotstarHost(host)) {
    const effectiveUA = needsMobileUA(host) ? (ua || HOTSTAR_MOBILE_UA) : (ua || DEFAULT_UA)
    upstreamHeaders = hotstarHeaders(cookie, effectiveUA, ref)
  } else if (isSonyHost(host)) {
    upstreamHeaders = genericHeaders(ua || SONY_UA, ref || SONY_REFERER, SONY_ORIGIN, cookie)
  } else {
    let refOrigin = targetUrl.origin
    if (ref) { try { refOrigin = new URL(ref).origin } catch { /* keep */ } }
    upstreamHeaders = genericHeaders(
      ua || DEFAULT_UA,
      ref || targetUrl.origin + '/',
      refOrigin,
      cookie,
    )
  }

  // ── Fetch strategy ─────────────────────────────────────────────────────────

  let upstream: Response | null = null
  let usedProxy = ''

  try {
    if (via) {
      /*
       * via= advisory path — the pinned proxy was written into the playlist URLs
       * by the previous manifest fetch. Try it first. Evict on latency or failure.
       * Re-race the pool if it's dead. New winner rides back in X-Proxy-Via.
       */
      const entry  = knownProxies.get(host)
      const stale  = entry && entry.ms > PROXY_EVICT_MS
      const pinned = (entry && !stale) ? entry.proxy : via

      let hit: { proxy: string; res: Response; ms: number } | null = null
      try {
        const { res, ms } = await timedPoolFetch(pinned, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 8000)
        if (res.ok) {
          hit = { proxy: pinned, res, ms }
          knownProxies.set(host, { proxy: pinned, ms, at: Date.now() })
        } else {
          if (knownProxies.get(host)?.proxy === pinned) knownProxies.delete(host)
        }
      } catch {
        if (knownProxies.get(host)?.proxy === pinned) knownProxies.delete(host)
      }

      if (!hit) hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, pinned)

      if (hit) { upstream = hit.res; usedProxy = hit.proxy }
      else     upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })

    } else if (isHotstarHost(host)) {
      /*
       * Hotstar fast path:
       *   1. HOTSTAR_RELAY — known residential IP, tried first, no pool roulette.
       *   2. Public pool via relay shim — batches of 8, max 48 attempts.
       *   3. Direct fetch — will likely 403 from CF datacenter but avoids silence.
       */
      if (hotstarRelay) {
        try {
          const { res, ms } = await timedPoolFetch(hotstarRelay, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 6000)
          if (res.ok) {
            upstream  = res
            usedProxy = hotstarRelay
            knownProxies.set(host, { proxy: hotstarRelay, ms, at: Date.now() })
          }
        } catch { /* fall through to pool */ }
      }

      if (!upstream) {
        const hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
        else       upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })
      }

      /* slivcdn: retry once with canonical Sony profile on 403. */
      if (!upstream!.ok && upstream!.status === 403 && isSlivCDN(host)) {
        const fallback = genericHeaders(SONY_UA, SONY_REFERER, SONY_ORIGIN, cookie)
        const hit = await findProxy(targetUrl, fallback, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
      }

    } else if (needsResidential(host)) {
      /*
       * slivcdn / sonydaimenew.akamaized.net — pool path.
       * Wider batch (12) because slivcdn pool has more dead entries.
       * 403-retry with canonical Sony profile if entire pool comes back 403.
       */
      let hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
      if (hit) { upstream = hit.res; usedProxy = hit.proxy }
      else       upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })

      if (!upstream!.ok && upstream!.status === 403 && isSonyHost(host)) {
        const fallback = genericHeaders(SONY_UA, SONY_REFERER, SONY_ORIGIN, cookie)
        hit = await findProxy(targetUrl, fallback, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
      }

    } else {
      /* FanCode, jio.com, jiocinema.com — straight from CF edge, geo passes. */
      upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })
    }
  } catch (e) {
    return new Response('Upstream failed: ' + (e as Error).message, {
      status: 502, headers: corsHeaders(),
    })
  }

  if (!upstream) {
    return new Response('No upstream response', { status: 502, headers: corsHeaders() })
  }

  const contentType = upstream.headers.get('content-type') || ''
  const path        = targetUrl.pathname.toLowerCase()
  const proxyBase   = reqUrl.origin + reqUrl.pathname
  const extras      =
    (cookie    ? '&cookie=' + encodeURIComponent(cookie)    : '') +
    (ref       ? '&ref='    + encodeURIComponent(ref)       : '') +
    (ua        ? '&ua='     + encodeURIComponent(ua)        : '') +
    (usedProxy ? '&via='    + encodeURIComponent(usedProxy) : '')

  const responseHeaders: Record<string, string> = { ...corsHeaders() }
  if (usedProxy) responseHeaders['X-Proxy-Via'] = usedProxy

  /* Non-2xx: hand the raw failure back so the player sees the real status. */
  if (!upstream.ok) {
    const body = await upstream.text()
    return new Response(body.slice(0, 2000) || `Upstream returned HTTP ${upstream.status}`, {
      status: upstream.status,
      headers: {
        ...responseHeaders,
        'Content-Type':          'text/plain; charset=utf-8',
        'Cache-Control':         'no-store',
        'X-Proxy-Upstream':      String(upstream.status),
        'X-Proxy-Upstream-Host': host,
        'X-Proxy-Target-Path':   targetUrl.pathname,
      },
    })
  }

  // ── DASH manifest ──────────────────────────────────────────────────────────

  if (isDash(path, contentType)) {
    const text      = await upstream.text()
    const rewritten = rewriteMpd(text, targetUrl, proxyBase, extras)
    prefetchSegments(rewritten, cookie, ua || HOTSTAR_MOBILE_UA, ref, ctx)
    return new Response(rewritten, {
      status: 200,
      headers: { ...responseHeaders, 'Content-Type': 'application/dash+xml', 'Cache-Control': 'no-cache' },
    })
  }

  // ── HLS playlist ───────────────────────────────────────────────────────────

  if (isHls(path, contentType)) {
    const text      = await upstream.text()
    const rewritten = rewritePlaylist(text, targetUrl, proxyBase, extras)
    prefetchSegments(rewritten, cookie, ua || HOTSTAR_MOBILE_UA, ref, ctx)
    return new Response(rewritten, {
      status: 200,
      headers: { ...responseHeaders, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
    })
  }

  // ── Segments / keys / binary passthrough ───────────────────────────────────

  const respHeaders = new Headers(upstream.headers)
  for (const [k, v] of Object.entries(responseHeaders)) respHeaders.set(k, v)
  respHeaders.delete('content-security-policy')
  respHeaders.delete('content-encoding')
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
}

// ─── TanStack Start route binding ─────────────────────────────────────────────

export const Route = createFileRoute('/api/proxy')({
  server: {
    handlers: {
      GET: async ({ request }) => handleProxy(request),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
    },
  },
})
