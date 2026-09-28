/**
 * HLS + DASH CORS proxy — /api/proxy?u=<encoded url>[&cookie=][&ref=][&ua=][&via=host:port]
 */
import { createFileRoute } from '@tanstack/react-router'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SONY_UA = DEFAULT_UA

const HOTSTAR_MOBILE_UA =
  'Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)'

const JIO_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

const SONY_ORIGIN     = 'https://www.sonyliv.com'
const SONY_REFERER    = 'https://www.sonyliv.com/'
const HOTSTAR_ORIGIN  = 'https://www.hotstar.com'
const HOTSTAR_REFERER = 'https://www.hotstar.com/'
const JIO_ORIGIN      = 'https://www.jio.com'
const JIO_REFERER     = 'https://www.jio.com/'

// ─── Allowlist ─────────────────────────────────────────────────────────────────

const ALLOWED = [
  'fancode.com',
  'akamaized.net',
  'akamaihd.net',
  'hotstar.com',
  'slivcdn.com',
  'jio.com',
  'jiotvpllive.cdn.jio.com',
  'jiotvmblive.cdn.jio.com',
  'jiocinema.com',
]

const NEEDS_RESIDENTIAL = [
  'slivcdn.com',
  'sonydaimenew.akamaized.net',
  'hotstar.com',
  'jiotvpllive.cdn.jio.com',
  'jiotvmblive.cdn.jio.com',
]

const HOTSTAR_MOBILE_UA_HOSTS = [
  'jcevents.hotstar.com',
  'livetv.hotstar.com',
  'live09p.hotstar.com',
  'adfree.hotstar.com',
]

const DASH_HOSTS = [
  'live09p.hotstar.com',
  'adfree.hotstar.com',
  'jiotvmblive.cdn.jio.com',
  'jiotvpllive.cdn.jio.com',
]

const SONY_HOSTS = ['slivcdn.com', 'sonydaimenew.akamaized.net']
const JIO_HOSTS  = ['jiotvmblive.cdn.jio.com', 'jiotvpllive.cdn.jio.com', 'jiocinema.com', 'jio.com']

const allowed          = (h: string) => ALLOWED.some(s => h === s || h.endsWith('.' + s))
const needsResidential = (h: string) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s))
const needsMobileUA    = (h: string) => HOTSTAR_MOBILE_UA_HOSTS.some(s => h === s || h.endsWith('.' + s))
const isDashHost       = (h: string) => DASH_HOSTS.some(s => h === s || h.endsWith('.' + s))
const isSonyHost       = (h: string) => SONY_HOSTS.some(s => h === s || h.endsWith('.' + s))
const isHotstarHost    = (h: string) => h === 'hotstar.com' || h.endsWith('.hotstar.com')
const isSlivCDN        = (h: string) => h === 'slivcdn.com' || h.endsWith('.slivcdn.com')
const isJioHost        = (h: string) => JIO_HOSTS.some(s => h === s || h.endsWith('.' + s))
const isJioMobileCDN   = (h: string) => h === 'jiotvmblive.cdn.jio.com' || h === 'jiotvpllive.cdn.jio.com'

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

let poolCache: { list: string[]; at: number } = { list: [], at: 0 }
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
  let fetchUrl: string
  const fetchHeaders = new Headers(upstreamHeaders)

  if (relayUrl) {
    const u = new URL(relayUrl)
    u.searchParams.set('url',   targetUrl.toString())
    u.searchParams.set('proxy', proxyHostPort)
    if (cookie) u.searchParams.set('cookie', cookie)
    if (ref)    u.searchParams.set('ref',    ref)
    if (ua)     u.searchParams.set('ua',     ua)
    fetchUrl = u.toString()
    fetchHeaders.set('X-Proxy-IP', proxyHostPort)
  } else {
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
  /* Wider batch for slivcdn and Jio mobile CDN — both have high dead-entry rates. */
  const BATCH = (isSlivCDN(hostname) || isJioMobileCDN(hostname)) ? 14 : 8

  const entry  = knownProxies.get(hostname)
  const stale  = entry && entry.ms > PROXY_EVICT_MS
  const pinned = entry && !stale && entry.proxy !== skip ? entry.proxy : null
  const rest   = list.filter(p => p !== pinned && p !== skip)
  const ordered = pinned ? [pinned, ...rest] : rest

  for (let i = 0; i < Math.min(ordered.length, 56); i += BATCH) {
    const batch = ordered.slice(i, i + BATCH)

    const hit = await Promise.any(
      batch.map(async (p) => {
        const { res, ms } = await timedPoolFetch(p, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 7000)
        /*
         * Jio CDN returns 450 for geo-blocked ASNs and 403 for missing auth.
         * Treat both as proxy failure so we keep racing until an Indian
         * residential exit node returns 200.
         */
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
    'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
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

function jioHeaders(cookie: string, ua: string, ref: string): Headers {
  const referer = ref || JIO_REFERER
  let origin: string
  try { origin = new URL(referer).origin } catch { origin = JIO_ORIGIN }

  const h = new Headers({
    'Accept':          '*/*',
    'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
    'User-Agent':      ua || JIO_UA,
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

function rewriteMpd(text: string, baseUrl: URL, proxyBase: string, extras: string): string {
  const wrap  = (abs: string) => proxyBase + '?u=' + encodeURIComponent(abs) + extras
  const toAbs = (ref: string) => {
    try { return new URL(ref.trim(), baseUrl).toString() } catch { return ref }
  }
  const dir = baseUrl.href.slice(0, baseUrl.href.lastIndexOf('/') + 1)

  let found = false
  let out = text.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (_, u) => {
    found = true
    return `<BaseURL>${wrap(toAbs(u))}</BaseURL>`
  })

  out = out.replace(
    /\b(media|initialization)="(https?:\/\/[^"]+)"/gi,
    (_, attr, u) => `${attr}="${wrap(u)}"`,
  )
  out = out.replace(
    /\b(media|initialization)='(https?:\/\/[^']+)'/gi,
    (_, attr, u) => `${attr}='${wrap(u)}'`,
  )

  if (!found) {
    out = out.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${wrap(dir)}</BaseURL>`)
  }

  return out
}

// ─── HLS rewriter ──────────────────────────────────────────────────────────────

function rewritePlaylist(text: string, baseUrl: URL, proxyBase: string, extras: string): string {
  const wrap = (abs: string) => proxyBase + '?u=' + encodeURIComponent(abs) + extras

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
  const h = jioHeaders(cookie, ua, ref)
  ctx.waitUntil(
    Promise.allSettled(found.map(url => fetch(url, { method: 'HEAD', headers: h }).catch(() => {}))),
  )
}

// ─── Content-type detectors ────────────────────────────────────────────────────

function isHls(path: string, ct: string): boolean {
  return path.endsWith('.m3u8') || ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl')
}

function isDash(path: string, ct: string): boolean {
  return (
    path.endsWith('.mpd') ||
    ct.includes('dash+xml') ||
    ct.includes('application/xml') ||
    /* Jio CDN sometimes returns octet-stream for .mpd */
    (path.endsWith('.mpd') && ct.includes('octet-stream'))
  )
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

  // ── Upstream headers ───────────────────────────────────────────────────────

  let upstreamHeaders: Headers

  if (isJioHost(host)) {
    upstreamHeaders = jioHeaders(cookie, ua, ref)
  } else if (isHotstarHost(host)) {
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
      else       upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })

    } else if (isJioMobileCDN(host)) {
      /*
       * jiotvmblive / jiotvpllive — Jio's Akamai edge hard-blocks CF ASNs.
       * 450 = geo-reject from Akamai token enforcement on non-Indian ASNs.
       * Must go through Indian residential pool. No direct fallback — a direct
       * fetch will always 450 from a CF datacenter.
       */
      const hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
      if (hit) {
        upstream  = hit.res
        usedProxy = hit.proxy
      } else {
        /* Pool exhausted — last resort direct. Will likely 450 but beats silence. */
        upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })
      }

    } else if (isHotstarHost(host)) {
      if (hotstarRelay) {
        try {
          const { res, ms } = await timedPoolFetch(hotstarRelay, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 6000)
          if (res.ok) {
            upstream  = res
            usedProxy = hotstarRelay
            knownProxies.set(host, { proxy: hotstarRelay, ms, at: Date.now() })
          }
        } catch { /* fall through */ }
      }

      if (!upstream) {
        const hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
        else       upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })
      }

    } else if (needsResidential(host)) {
      let hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
      if (hit) { upstream = hit.res; usedProxy = hit.proxy }
      else       upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(15000) })

      if (!upstream!.ok && upstream!.status === 403 && isSonyHost(host)) {
        const fallback = genericHeaders(SONY_UA, SONY_REFERER, SONY_ORIGIN, cookie)
        hit = await findProxy(targetUrl, fallback, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
      }

    } else {
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

  if (isDash(path, contentType) || isDashHost(host)) {
    const text      = await upstream.text()
    const rewritten = rewriteMpd(text, targetUrl, proxyBase, extras)
    prefetchSegments(rewritten, cookie, ua || JIO_UA, ref, ctx)
    return new Response(rewritten, {
      status: 200,
      headers: { ...responseHeaders, 'Content-Type': 'application/dash+xml', 'Cache-Control': 'no-cache' },
    })
  }

  // ── HLS playlist ───────────────────────────────────────────────────────────

  if (isHls(path, contentType)) {
    const text      = await upstream.text()
    const rewritten = rewritePlaylist(text, targetUrl, proxyBase, extras)
    prefetchSegments(rewritten, cookie, ua || JIO_UA, ref, ctx)
    return new Response(rewritten, {
      status: 200,
      headers: { ...responseHeaders, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
    })
  }

  // ── Binary passthrough ─────────────────────────────────────────────────────

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
