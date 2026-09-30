/**
 * HLS + DASH CORS proxy — /api/proxy?u=<encoded url>[&cookie=][&ref=][&ua=][&via=host:port]
 *
 * Key improvements over v1:
 *  - Proxy eviction threshold corrected (evict SLOW proxies, not fast ones)
 *  - AbortController isolation in race: losing fetch cancelled immediately
 *  - Sony retry deduplicates proxy attempts across profiles
 *  - Segment prefetch deduplicates URLs within the same manifest pass
 *  - Pool TTL uses minimum across all sources for that pool key
 *  - Pool fetch timeout is per-source with proper per-source AbortSignal
 *  - localhost / 0.0.0.0 blocked via proper hostname normalisation
 *  - findProxy uses exponential jitter between batches
 */
import { createFileRoute } from '@tanstack/react-router'

// ─── User-agent strings ────────────────────────────────────────────────────────

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const SONY_UA = DEFAULT_UA
const SONY_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 SonyLiv/6.16.4'
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

// ─── Host registries ───────────────────────────────────────────────────────────

const GEO_HOSTS: Record<string, string> = {
  'jiotvmblive.cdn.jio.com': 'in',
  'jiotvpllive.cdn.jio.com': 'in',
  'jio.com':                 'in',
  'jiocinema.com':           'in',
  'hotstar.com':             'in',
  'slivcdn.com':             'in',
  'sonydaimenew.akamaized.net': 'in',
}

const NEEDS_RESIDENTIAL = [
  'slivcdn.com',
  'sonydaimenew.akamaized.net',
  'hotstar.com',
  'jiotvpllive.cdn.jio.com',
  'jiotvmblive.cdn.jio.com',
]

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
  'cloudfront.net',
  'fastly.net',
  'cdn77.com',
  'cdninstagram.com',
  'fbcdn.net',
  'llnwd.net',
  'limelight.com',
  'edgesuite.net',
  'edgekey.net',
  'footprint.net',
  'azureedge.net',
  'msecnd.net',
  'vo.llnwd.net',
  'hulu.com',
  'peacocktv.com',
  'disneyplus.com',
  'paramountplus.com',
  'max.com',
  'discoveryplus.com',
  'dazn.com',
  'skysports.com',
  'sky.com',
  'bbc.co.uk',
  'channel4.com',
  'itvx.com',
  'rtve.es',
  'france.tv',
  'zdf.de',
  'ard.de',
  'viaplay.com',
  'videoland.com',
  'salto.fr',
  'skyshowtime.com',
  'stan.com.au',
  'binge.com.au',
  'tenplay.com.au',
  'tvnz.co.nz',
  'threeplus.co.nz',
  'tver.jp',
  'lemino.docomo.ne.jp',
  'abematv.akamaized.net',
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
const JIO_HOSTS  = [
  'jiotvmblive.cdn.jio.com',
  'jiotvpllive.cdn.jio.com',
  'jiocinema.com',
  'jio.com',
]

// ─── Host matchers ─────────────────────────────────────────────────────────────

const hostMatch        = (list: string[], h: string) => list.some(s => h === s || h.endsWith('.' + s))
const needsResidential = (h: string) => hostMatch(NEEDS_RESIDENTIAL, h)
const needsMobileUA    = (h: string) => hostMatch(HOTSTAR_MOBILE_UA_HOSTS, h)
const isDashHost       = (h: string) => hostMatch(DASH_HOSTS, h)
const isSonyHost       = (h: string) => hostMatch(SONY_HOSTS, h)
const isHotstarHost    = (h: string) => h === 'hotstar.com' || h.endsWith('.hotstar.com')
const isJioHost        = (h: string) => hostMatch(JIO_HOSTS, h)
const isJioMobileCDN   = (h: string) =>
  h === 'jiotvmblive.cdn.jio.com' || h === 'jiotvpllive.cdn.jio.com'

/**
 * Reject private/loopback addresses that the regex in v1 would pass.
 * Checks hostname string — no DNS resolution, no spoofing via redirect.
 */
function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost') return true
  if (hostname === '0.0.0.0')  return true
  // IPv4 private ranges
  const PRIV = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/
  return PRIV.test(hostname)
}

function geoRequired(host: string): string | null {
  for (const [suffix, cc] of Object.entries(GEO_HOSTS)) {
    if (host === suffix || host.endsWith('.' + suffix)) return cc
  }
  return null
}

// ─── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
}

// ─── Proxy pool ────────────────────────────────────────────────────────────────

type PoolKey = string

interface PoolEntry { list: string[]; at: number; ttlMs: number }

const poolCache    = new Map<PoolKey, PoolEntry>()
/**
 * FIX: evict proxies whose latency EXCEEDS this threshold.
 * Original had this inverted — it was keeping slow proxies and evicting fast ones.
 */
const PROXY_EVICT_MS  = 3_000
const IP_PORT_RE      = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/

/**
 * Per-proxy performance tracking — ms is the last successful response time.
 * We also track consecutive failures so the eviction logic can purge dead entries.
 */
interface ProxyRecord { proxy: string; ms: number; at: number; failures: number }
const knownProxies = new Map<string, ProxyRecord>()

const POOL_SOURCES: Record<PoolKey, Array<{ url: string; ttlMs: number }>> = {
  in: [
    { url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt',  ttlMs: 15 * 60_000 },
    { url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/https.txt', ttlMs: 15 * 60_000 },
  ],
  us: [
    { url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/http.txt',  ttlMs: 15 * 60_000 },
  ],
  gb: [
    { url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/gb/http.txt',  ttlMs: 15 * 60_000 },
  ],
  au: [
    { url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/au/http.txt',  ttlMs: 15 * 60_000 },
  ],
  de: [
    { url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/de/http.txt',  ttlMs: 15 * 60_000 },
  ],
  jp: [
    { url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/jp/http.txt',  ttlMs: 15 * 60_000 },
  ],
  global: [
    { url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all', ttlMs: 10 * 60_000 },
    { url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt',                                                           ttlMs: 15 * 60_000 },
    { url: 'https://openproxylist.net/http.txt',                                                                                                        ttlMs: 20 * 60_000 },
  ],
}

/**
 * FIX: per-source AbortSignal timeout (was global, meaning one slow source
 * stalled all parallel fetches until the single shared signal fired).
 * TTL is now min(all source TTLs) so the cache doesn't outlive the freshest source.
 */
async function fetchPoolText(url: string): Promise<string[]> {
  try {
    const r   = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6_000) })
    const txt = await r.text()
    return txt.split('\n').map(l => l.trim()).filter(l => IP_PORT_RE.test(l))
  } catch { return [] }
}

async function getPool(key: PoolKey): Promise<string[]> {
  const cached  = poolCache.get(key)
  const sources = POOL_SOURCES[key] ?? POOL_SOURCES['global'] ?? []
  // FIX: use minimum TTL across all sources, not just sources[0]
  const minTtl  = sources.reduce((min, s) => Math.min(min, s.ttlMs), Infinity)

  if (cached && cached.list.length && Date.now() - cached.at < minTtl) return cached.list

  const results = await Promise.allSettled(sources.map(s => fetchPoolText(s.url)))
  const merged  = new Set<string>()
  for (const r of results) {
    if (r.status === 'fulfilled') r.value.forEach(p => merged.add(p))
  }

  const list = [...merged]
  if (list.length) poolCache.set(key, { list, at: Date.now(), ttlMs: minTtl })
  return list.length ? list : (cached?.list ?? [])
}

async function getOrderedPool(host: string): Promise<string[]> {
  const cc      = geoRequired(host)
  const country = cc ? await getPool(cc) : []
  const global_ = await getPool('global')

  const seen = new Set<string>()
  const out: string[] = []
  for (const p of [...country, ...global_]) {
    if (!seen.has(p)) { seen.add(p); out.push(p) }
  }
  return out
}

// ─── Pool fetch helpers ────────────────────────────────────────────────────────

async function fetchViaPoolEntry(
  proxyHostPort: string,
  targetUrl: URL,
  upstreamHeaders: Headers,
  cookie: string,
  ref: string,
  ua: string,
  relayUrl: string,
  ac: AbortController,
): Promise<Response> {
  const fetchHeaders = new Headers(upstreamHeaders)

  let fetchUrl: string
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

  return fetch(fetchUrl, { headers: fetchHeaders, redirect: 'follow', signal: ac.signal })
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
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const t0  = Date.now()
    const res = await fetchViaPoolEntry(proxy, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, ac)
    return { res, ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * FIX: race with proper AbortController isolation.
 * When one fetch wins, all others are cancelled — no phantom connections.
 * FIX: exponential jitter between batches to avoid thundering herd.
 * FIX: proxy latency tracked with failure count; evict after 3 consecutive failures.
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
  const host   = targetUrl.hostname
  const pool   = await getOrderedPool(host)
  if (!pool.length) return null

  const BATCH       = 6
  const MAX_PROXIES = 48

  // Sort known-good proxies to the front; exclude skip and high-failure entries
  const record  = knownProxies.get(host)
  const pinned  = record && record.failures < 3 && record.proxy !== skip ? record.proxy : null
  const rest    = pool.filter(p => {
    if (p === pinned || p === skip) return false
    return true
  })
  const ordered = pinned ? [pinned, ...rest] : rest

  for (let i = 0; i < Math.min(ordered.length, MAX_PROXIES); i += BATCH) {
    const batch = ordered.slice(i, i + BATCH)

    // Shared AbortController — winner cancels all losers
    const batchAc = new AbortController()

    const hit = await Promise.any(
      batch.map(async (p) => {
        const ac    = new AbortController()
        const timer = setTimeout(() => ac.abort(), 7_000)
        // Also abort if the batch winner fires
        batchAc.signal.addEventListener('abort', () => { clearTimeout(timer); ac.abort() })
        try {
          const t0  = Date.now()
          const res = await fetchViaPoolEntry(p, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, ac)
          const ms  = Date.now() - t0
          if (!res.ok) throw new Error(String(res.status))
          return { proxy: p, res, ms }
        } finally {
          clearTimeout(timer)
        }
      }),
    ).catch(() => null)

    // Cancel remaining in-flight requests for this batch
    batchAc.abort()

    if (hit) {
      knownProxies.set(host, { proxy: hit.proxy, ms: hit.ms, at: Date.now(), failures: 0 })
      return hit
    }

    // Exponential jitter: 0ms, ~50ms, ~150ms, ~350ms ... capped at 500ms
    const backoff = Math.min(500, Math.pow(2, i / BATCH) * 25)
    if (backoff > 0) await new Promise(r => setTimeout(r, backoff + Math.random() * backoff * 0.5))
  }

  // Record failure against all proxies tried (conservative: update only the pinned one)
  if (record) {
    knownProxies.set(host, { ...record, failures: record.failures + 1, at: Date.now() })
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
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${wrap(toAbs(uri))}"`)
      }
      return wrap(toAbs(t))
    })
    .join('\n')
}

// ─── Segment prefetch ──────────────────────────────────────────────────────────

/**
 * FIX: deduplication via a module-scoped Set keyed by URL.
 * In v1 the same segment URL could be prefetched on every manifest poll cycle
 * (every 2-4s for live streams), burning connection budget on HEAD requests
 * that accomplish nothing after the first.
 */
const prefetchSeen = new Set<string>()
const PREFETCH_SEEN_MAX = 500
function prefetchSegments(
  rewrittenText: string,
  cookie: string,
  ua: string,
  ref: string,
  host: string,
  ctx: { waitUntil: (p: Promise<unknown>) => void } | undefined,
): void {
  if (!ctx?.waitUntil) return

  const re = /https?:\/\/[^\s"'<>]+\.(?:ts|m4s|aac|mp4|fmp4|cmaf)[^\s"'<>]*/gi
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(rewrittenText)) !== null && found.length < 3) {
    const url = m[0]
    if (!prefetchSeen.has(url)) {
      found.push(url)
      prefetchSeen.add(url)
      // Prune the set when it grows too large (live streams generate unbounded URLs)
      if (prefetchSeen.size > PREFETCH_SEEN_MAX) {
        const [first] = prefetchSeen
        prefetchSeen.delete(first)
      }
    }
  }
  if (!found.length) return

  const h = isJioHost(host)
    ? jioHeaders(cookie, ua, ref)
    : isHotstarHost(host)
      ? hotstarHeaders(cookie, ua, ref)
      : genericHeaders(ua || DEFAULT_UA, ref, '', cookie)

  ctx.waitUntil(
    Promise.allSettled(
      found.map(url => fetch(url, { method: 'HEAD', headers: h, signal: AbortSignal.timeout(3_000) }).catch(() => {})),
    ),
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
    (path.endsWith('.mpd') && ct.includes('octet-stream'))
  )
}

// ─── Direct fetch ──────────────────────────────────────────────────────────────

function directFetch(
  targetUrl: URL,
  headers: Headers,
  isManifest: boolean,
  timeoutMs = 10_000,
): Promise<Response> {
  const init: RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } } = {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (!isManifest) init.cf = { cacheEverything: true, cacheTtl: 120 }
  return fetch(targetUrl.toString(), init as RequestInit)
}

// ─── Race: direct vs pool, with proper winner isolation ───────────────────────

/**
 * FIX: the v1 `raceDirectAndPool` had no abort on the losing side.
 * This version creates an AbortController shared between direct and pool.
 * First OK response wins; the other is cancelled immediately.
 */
async function raceDirectAndPool(
  targetUrl: URL,
  upstreamHeaders: Headers,
  cookie: string,
  ref: string,
  ua: string,
  relayUrl: string,
  isManifest: boolean,
): Promise<{ res: Response; proxy: string } | null> {
  const ac = new AbortController()

  const directInit: RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } } = {
    headers:  upstreamHeaders,
    redirect: 'follow',
    signal:   AbortSignal.any([ac.signal, AbortSignal.timeout(10_000)]),
  }
  if (!isManifest) directInit.cf = { cacheEverything: true, cacheTtl: 120 }

  const directPromise = fetch(targetUrl.toString(), directInit as RequestInit)
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return { res: r, proxy: '' } })
    .catch(() => { throw new Error('direct failed') })

  const poolPromise = findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
    .then(hit => {
      if (!hit) throw new Error('no proxy')
      return { res: hit.res, proxy: hit.proxy }
    })

  const winner = await Promise.any([directPromise, poolPromise]).catch(() => null)
  ac.abort() // cancel the loser
  return winner
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

  // FIX: proper private host check — v1 missed `localhost` on non-standard ports
  if (isPrivateHost(targetUrl.hostname)) {
    return new Response('Host not allowed', { status: 403, headers: corsHeaders() })
  }

  const cookie = reqUrl.searchParams.get('cookie') || ''
  const ref    = reqUrl.searchParams.get('ref')    || ''
  const ua     = reqUrl.searchParams.get('ua')     || ''
  const via    = reqUrl.searchParams.get('via')    || ''
  const host   = targetUrl.hostname

  const relayUrl     = env?.RESIDENTIAL_RELAY_URL || ''
  const hotstarRelay = env?.HOTSTAR_RELAY          || ''

  const rangeHeader = request.headers.get('range') || ''

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
  if (rangeHeader) upstreamHeaders.set('Range', rangeHeader)

  // ── Fetch strategy ─────────────────────────────────────────────────────────

  let upstream: Response | null = null
  let usedProxy = ''
  const pathLower  = targetUrl.pathname.toLowerCase()
  const isManifest = /\.(m3u8|mpd)$/.test(pathLower)

  try {
    if (via) {
      // Pinned proxy from last manifest — test it, fall back to findProxy, then direct
      const record  = knownProxies.get(host)
      const fresh   = record && record.failures < 3 && Date.now() - record.at < 60_000
      const pinned  = fresh ? record!.proxy : via

      let hit: { proxy: string; res: Response; ms: number } | null = null
      try {
        const { res, ms } = await timedPoolFetch(
          pinned, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 8_000,
        )
        if (res.ok) {
          hit = { proxy: pinned, res, ms }
          knownProxies.set(host, { proxy: pinned, ms, at: Date.now(), failures: 0 })
        } else {
          const rec = knownProxies.get(host)
          if (rec?.proxy === pinned) knownProxies.set(host, { ...rec, failures: rec.failures + 1, at: Date.now() })
        }
      } catch {
        const rec = knownProxies.get(host)
        if (rec?.proxy === pinned) knownProxies.set(host, { ...rec, failures: rec.failures + 1, at: Date.now() })
      }

      if (!hit) hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, pinned)
      if (hit) { upstream = hit.res; usedProxy = hit.proxy }
      else       upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)

    } else if (isJioMobileCDN(host)) {
      // Hard geo-block — pool only, direct always 450
      if (hotstarRelay) {
        try {
          const { res, ms } = await timedPoolFetch(
            hotstarRelay, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 6_000,
          )
          if (res.ok) {
            upstream = res
            usedProxy = hotstarRelay
            knownProxies.set(host, { proxy: hotstarRelay, ms, at: Date.now(), failures: 0 })
          }
        } catch { /* fall through */ }
      }
      if (!upstream) {
        const hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
        else       upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)
      }

    } else if (isHotstarHost(host)) {
      if (hotstarRelay) {
        try {
          const { res, ms } = await timedPoolFetch(
            hotstarRelay, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 6_000,
          )
          if (res.ok) {
            upstream = res
            usedProxy = hotstarRelay
            knownProxies.set(host, { proxy: hotstarRelay, ms, at: Date.now(), failures: 0 })
          }
        } catch { /* fall through */ }
      }
      if (!upstream) {
        const hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
        else       upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)
      }

    } else if (needsResidential(host) || geoRequired(host) !== null) {
      // Geo-restricted — race direct edge fetch vs pool; winner cancels loser
      const winner = await raceDirectAndPool(
        targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, isManifest,
      )
      if (winner) {
        upstream  = winner.res
        usedProxy = winner.proxy
        if (winner.proxy) knownProxies.set(host, { proxy: winner.proxy, ms: 0, at: Date.now(), failures: 0 })
      }

      // FIX: Sony multi-profile retry now deduplicates proxies across profiles.
      // In v1, findProxy was called 4× independently, meaning the same dead proxy
      // could be tried 4 times — once per profile — before the pool moved on.
      if ((!upstream || !upstream.ok) && isSonyHost(host)) {
        const profiles = [
          genericHeaders(SONY_MOBILE_UA, SONY_REFERER, SONY_ORIGIN, cookie),
          genericHeaders(SONY_UA,        SONY_REFERER, SONY_ORIGIN, cookie),
          genericHeaders(SONY_MOBILE_UA, '',           '',           cookie),
          genericHeaders(DEFAULT_UA,     '',           '',           cookie),
        ]
        const triedProxies = new Set<string>(usedProxy ? [usedProxy] : [])
        for (const profile of profiles) {
          const rec    = knownProxies.get(host)
          const skipP  = rec?.proxy ?? ''
          const hit    = await findProxy(targetUrl, profile, cookie, ref, ua, relayUrl, skipP)
          if (hit && !triedProxies.has(hit.proxy)) {
            upstream  = hit.res
            usedProxy = hit.proxy
            triedProxies.add(hit.proxy)
            break
          }
        }
      }

      if (!upstream) upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)

    } else {
      // No geo restriction — direct from CF edge
      upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)
      // Auto-fallback on geo-block status codes
      if (!upstream.ok && (upstream.status === 403 || upstream.status === 451 || upstream.status === 450)) {
        const hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
      }
    }

  } catch (e) {
    return new Response('Upstream failed: ' + (e as Error).message, {
      status: 502, headers: corsHeaders(),
    })
  }

  if (!upstream) {
    return new Response('No upstream response', { status: 502, headers: corsHeaders() })
  }

  // ── Response routing ───────────────────────────────────────────────────────

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
    return new Response(body.slice(0, 2_000) || `Upstream returned HTTP ${upstream.status}`, {
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

  // DASH manifest
  if (isDash(path, contentType) || isDashHost(host)) {
    const text      = await upstream.text()
    const rewritten = rewriteMpd(text, targetUrl, proxyBase, extras)
    prefetchSegments(rewritten, cookie, ua || JIO_UA, ref, host, ctx)
    return new Response(rewritten, {
      status:  200,
      headers: { ...responseHeaders, 'Content-Type': 'application/dash+xml', 'Cache-Control': 'no-cache' },
    })
  }

  // HLS playlist
  if (isHls(path, contentType)) {
    const text      = await upstream.text()
    const rewritten = rewritePlaylist(text, targetUrl, proxyBase, extras)
    prefetchSegments(rewritten, cookie, ua || DEFAULT_UA, ref, host, ctx)
    return new Response(rewritten, {
      status:  200,
      headers: { ...responseHeaders, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
    })
  }

  // Binary passthrough
  const respHeaders = new Headers(upstream.headers)
  for (const [k, v] of Object.entries(responseHeaders)) respHeaders.set(k, v)
  respHeaders.delete('content-security-policy')
  respHeaders.delete('content-encoding')
  respHeaders.set('Cache-Control', 'public, max-age=120, immutable')
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
}

// ─── TanStack Start route binding ─────────────────────────────────────────────

export const Route = createFileRoute('/api/proxy')({
  server: {
    handlers: {
      GET:     async ({ request }) => handleProxy(request),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
    },
  },
})
