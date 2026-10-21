/**
 * HLS + DASH CORS proxy — /api/proxy?u=<encoded url>[&cookie=][&ref=][&ua=][&via=host:port]
 */
import { createFileRoute } from '@tanstack/react-router'

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
const FANCODE_ORIGIN  = 'https://www.fancode.com'
const FANCODE_REFERER = 'https://www.fancode.com/'

// ─── Geo-restricted host registry ─────────────────────────────────────────────
//
// Maps hostname suffix → ISO 3166-1 alpha-2 country code.
// Proxies are sourced from the matching country pool first, then global.
// Hosts not in this map go direct (no geo check needed).

const GEO_HOSTS: Record<string, string> = {
  'jiotvmblive.cdn.jio.com':    'in',
  'jiotvpllive.cdn.jio.com':    'in',
  'jio.com':                    'in',
  'jiocinema.com':              'in',
  'hotstar.com':                'in',
  'slivcdn.com':                'in',
  'sonydaimenew.akamaized.net': 'in',
  'sonymtmnew.akamaized.net':   'in',
  'fancode.com':                'in',
  'dai.google.com':             'in',
}

// Hosts that unconditionally need a residential proxy (CF ASN blocked)
const NEEDS_RESIDENTIAL = [
  'slivcdn.com',
  'sonydaimenew.akamaized.net',
  'sonymtmnew.akamaized.net',
  'hotstar.com',
  'jiotvpllive.cdn.jio.com',
  'jiotvmblive.cdn.jio.com',
  'fancode.com',
  'dai.google.com',
]

const ALLOWED = [
  'fancode.com',
  'dai.google.com',
  'akamaized.net',
  'sonymtmnew.akamaized.net',
  'akamaihd.net',
  'hotstar.com',
  'slivcdn.com',
  'jio.com',
  'jiotvpllive.cdn.jio.com',
  'jiotvmblive.cdn.jio.com',
  'jiocinema.com',
  // Worldwide streaming CDNs
  'akamaihd.net',
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

const SONY_HOSTS = ['slivcdn.com', 'sonydaimenew.akamaized.net', 'sonymtmnew.akamaized.net']
const JIO_HOSTS  = ['jiotvmblive.cdn.jio.com', 'jiotvpllive.cdn.jio.com', 'jiocinema.com', 'jio.com']

const hostMatch    = (list: string[], h: string) => list.some(s => h === s || h.endsWith('.' + s))
const allowed          = (h: string) => hostMatch(ALLOWED, h)
const needsResidential = (h: string) => hostMatch(NEEDS_RESIDENTIAL, h)
const needsMobileUA    = (h: string) => hostMatch(HOTSTAR_MOBILE_UA_HOSTS, h)
const isDashHost       = (h: string) => hostMatch(DASH_HOSTS, h)
const isSonyHost       = (h: string) => hostMatch(SONY_HOSTS, h)
const isHotstarHost    = (h: string) => h === 'hotstar.com' || h.endsWith('.hotstar.com')
const isSlivCDN        = (h: string) => h === 'slivcdn.com' || h.endsWith('.slivcdn.com')
const isJioHost        = (h: string) => hostMatch(JIO_HOSTS, h)
const isFanCodeHost    = (h: string) =>
  h === 'dai.google.com' || h.endsWith('.dai.google.com') || h === 'fancode.com' || h.endsWith('.fancode.com')
const isJioMobileCDN   = (h: string) =>
  h === 'jiotvmblive.cdn.jio.com' || h === 'jiotvpllive.cdn.jio.com'

/** Return ISO country code required for this host, or null for direct. */
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
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag',
  }
}

// ─── Multi-region proxy pool ───────────────────────────────────────────────────
//
// Sources:
//   databay-labs/free-proxy-list  — by-country lists, refreshed every 15 min
//   proxyscrape.com               — global HTTP list, refreshed every 10 min
//   openproxylist.net             — global, refreshed every 20 min
//
// Each pool entry is "ip:port". Entries are validated against the regex before
// being stored. Country pools are keyed by ISO 3166-1 alpha-2 lowercase code.
// The global pool is keyed "global".

type PoolKey = string   // country code or "global"

interface PoolEntry { list: string[]; at: number }
const poolCache   = new Map<PoolKey, PoolEntry>()
const knownProxies = new Map<string, { proxy: string; ms: number; at: number }>()
const PROXY_EVICT_MS  = 3000
const IP_PORT_RE      = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/

const POOL_SOURCES: Record<PoolKey, Array<{ url: string; ttlMs: number }>> = {
  in: [
    {
      url:   'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt',
      ttlMs: 15 * 60_000,
    },
    {
      url:   'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/https.txt',
      ttlMs: 15 * 60_000,
    },
  ],
  us: [
    {
      url:   'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/http.txt',
      ttlMs: 15 * 60_000,
    },
  ],
  gb: [
    {
      url:   'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/gb/http.txt',
      ttlMs: 15 * 60_000,
    },
  ],
  au: [
    {
      url:   'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/au/http.txt',
      ttlMs: 15 * 60_000,
    },
  ],
  de: [
    {
      url:   'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/de/http.txt',
      ttlMs: 15 * 60_000,
    },
  ],
  jp: [
    {
      url:   'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/jp/http.txt',
      ttlMs: 15 * 60_000,
    },
  ],
  global: [
    {
      url:   'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
      ttlMs: 10 * 60_000,
    },
    {
      url:   'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt',
      ttlMs: 15 * 60_000,
    },
    {
      url:   'https://openproxylist.net/http.txt',
      ttlMs: 20 * 60_000,
    },
  ],
}

async function fetchPoolText(url: string): Promise<string[]> {
  try {
    const r   = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    const txt = await r.text()
    return txt
      .split('\n')
      .map(l => l.trim())
      .filter(l => IP_PORT_RE.test(l))
  } catch { return [] }
}

async function getPool(key: PoolKey): Promise<string[]> {
  const cached = poolCache.get(key)
  const sources = POOL_SOURCES[key] ?? POOL_SOURCES['global'] ?? []
  const ttl     = sources[0]?.ttlMs ?? 15 * 60_000

  if (cached && cached.list.length && Date.now() - cached.at < ttl) return cached.list

  const results = await Promise.allSettled(sources.map(s => fetchPoolText(s.url)))
  const merged  = new Set<string>()
  for (const r of results) {
    if (r.status === 'fulfilled') r.value.forEach(p => merged.add(p))
  }

  const list = [...merged]
  if (list.length) poolCache.set(key, { list, at: Date.now() })
  return list.length ? list : (cached?.list ?? [])
}

/**
 * Build the ordered proxy list for a given hostname.
 * Country-specific pool comes first; global pool fills the tail.
 * Deduplication preserves order.
 */
async function getOrderedPool(host: string): Promise<string[]> {
  const cc      = geoRequired(host)
  const [country, global_] = await Promise.all([
    cc ? getPool(cc) : Promise.resolve([]),
    getPool('global'),
  ])

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

/** Free relays sometimes answer HTTP 200 with an HTML block/error page. */
async function isValidHlsManifest(response: Response, targetUrl: URL): Promise<boolean> {
  if (!targetUrl.pathname.toLowerCase().endsWith('.m3u8')) return true
  try {
    const prefix = await response.clone().text()
    return /^\uFEFF?\s*#EXTM3U(?:\s|$)/.test(prefix)
  } catch {
    return false
  }
}

async function findProxy(
  targetUrl: URL,
  upstreamHeaders: Headers,
  cookie: string,
  ref: string,
  ua: string,
  relayUrl: string,
  skip = '',
  maxAttempts = 6,
): Promise<{ proxy: string; res: Response; ms: number } | null> {
  const host    = targetUrl.hostname
  const pool    = await getOrderedPool(host)
  if (!pool.length) return null

  /* Runtime allows 6 concurrent outbound connections — larger batches just queue */
  const BATCH = 6

  const entry   = knownProxies.get(host)
  const stale   = entry && entry.ms > PROXY_EVICT_MS
  const pinned  = entry && !stale && entry.proxy !== skip ? entry.proxy : null
  const rest    = pool.filter(p => p !== pinned && p !== skip)
  const ordered = pinned ? [pinned, ...rest] : rest

  /* Bound fallback time: two batches of six are enough to find a responsive proxy
     without making a failed manifest request stall player startup for minutes. */
  for (let i = 0; i < Math.min(ordered.length, maxAttempts); i += BATCH) {
    const batch = ordered.slice(i, i + BATCH)

    const hit = await Promise.any(
      batch.map(async (p) => {
        const { res, ms } = await timedPoolFetch(
          p, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 3500,
        )
        if (!res.ok) throw new Error(String(res.status))
        if (!(await isValidHlsManifest(res, targetUrl))) throw new Error('Invalid HLS manifest')
        return { proxy: p, res, ms }
      }),
    ).catch(() => null)

    if (hit) {
      knownProxies.set(host, { proxy: hit.proxy, ms: hit.ms, at: Date.now() })
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
  const wrap = (abs: string) => {
    if (!/^https?:\/\//i.test(abs)) return abs
    return proxyBase + '?u=' + encodeURIComponent(abs) + extras
  }
  const toAbs = (ref: string) => {
    const value = ref.trim()
    if (!value || /^(data|skd|urn):/i.test(value)) return value
    const u = new URL(value, baseUrl)
    // Child playlists and media segments commonly omit Akamai's signed query.
    // Carry over only missing parent parameters so child-specific values win.
    if (u.hostname === baseUrl.hostname) {
      for (const [key, val] of baseUrl.searchParams) {
        if (!u.searchParams.has(key)) u.searchParams.append(key, val)
      }
    }
    return u.toString()
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) {
        return line.replace(/\b(URI|X-ASSET-LIST)=("|')([^"']+)\2/g, (_match, attribute: string, quote: string, uri: string) => {
          return `${attribute}=${quote}${wrap(toAbs(uri))}${quote}`
        })
      }
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
  host: string,
  ctx: { waitUntil: (p: Promise<unknown>) => void } | undefined,
): void {
  if (!ctx?.waitUntil) return
  const re = /https?:\/\/[^\s"'<>]+\.(?:ts|m4s|aac|mp4|fmp4|cmaf)[^\s"'<>]*/gi
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(rewrittenText)) !== null && found.length < 2) found.push(m[0])
  if (!found.length) return
  const h = isJioHost(host)
    ? jioHeaders(cookie, ua, ref)
    : isHotstarHost(host)
      ? hotstarHeaders(cookie, ua, ref)
      : genericHeaders(ua || DEFAULT_UA, ref, '', cookie)
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
    (path.endsWith('.mpd') && ct.includes('octet-stream'))
  )
}

// ─── Direct fetch with edge caching ───────────────────────────────────────────
// Segments are immutable and shared across viewers — cache them at the edge so
// repeat requests are served instantly without hitting the origin.

function directFetch(
  targetUrl: URL,
  headers: Headers,
  isManifest: boolean,
  timeoutMs = 10000,
): Promise<Response> {
  const init: RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } } = {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (!isManifest) init.cf = { cacheEverything: true, cacheTtl: 120 }
  return fetch(targetUrl.toString(), init as RequestInit)
}

// ─── Built-in browser player page ─────────────────────────────────────────────
// Chrome and Firefox cannot play HLS natively. When a proxied .m3u8 URL is
// opened directly in a browser (top-level navigation → Accept includes
// text/html), serve a self-contained hls.js page that plays the same URL.
// Player-side fetches send Accept: */* and still receive the raw manifest.

function playerPage(host: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${host} — live player</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  #overlay {
    position: fixed; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    background: radial-gradient(ellipse at center, #111 0%, #000 75%);
    font-family: system-ui, -apple-system, sans-serif; color: #e5e7eb;
    transition: opacity .4s; z-index: 2;
  }
  #overlay.done { opacity: 0; pointer-events: none; }
  .spinner {
    width: 42px; height: 42px; border-radius: 50%;
    border: 3px solid #333; border-top-color: #f43f5e;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #msg { font-size: 14px; opacity: .85; max-width: 80%; text-align: center; line-height: 1.5; }
  #err { color: #fb7185; }
  #unmute {
    position: fixed; right: 16px; bottom: 16px; z-index: 3; display: none;
    padding: 8px 14px; border-radius: 999px; border: 1px solid #444;
    background: rgba(20,20,20,.8); color: #fff; font-size: 13px; cursor: pointer;
  }
</style>
</head>
<body>
<video id="v" autoplay playsinline muted controls></video>
<div id="overlay">
  <div class="spinner"></div>
  <div id="msg">Connecting to ${host}&hellip;</div>
</div>
<button id="unmute">Tap to unmute</button>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js" crossorigin="anonymous"><\/script>
<script>
(() => {
  const v = document.getElementById('v');
  const overlay = document.getElementById('overlay');
  const msg = document.getElementById('msg');
  const unmute = document.getElementById('unmute');
  const src = window.location.href;
  let manifestRetries = 0;

  const fail = (text) => {
    overlay.classList.remove('done');
    document.querySelector('.spinner').style.display = 'none';
    msg.innerHTML = '<span id="err">' + text + '</span>';
  };

  const start = () => {
    if (!window.Hls || !Hls.isSupported()) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = src;
        v.addEventListener('loadeddata', () => overlay.classList.add('done'));
      } else fail('This browser cannot play HLS streams.');
      return;
    }
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      liveSyncDurationCount: 3,
      backBufferLength: 90,
      maxBufferLength: 30,
      fragLoadingMaxRetry: 6,
      manifestLoadingMaxRetry: 4,
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      overlay.classList.add('done');
      v.play().catch(() => {});
      if (v.muted) unmute.style.display = 'block';
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      console.warn('[player] error', data.type, data.details, data.fatal, (data.response || {}).code);
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
          data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR
        ) {
          manifestRetries++;
          if (manifestRetries > 3) {
            hls.destroy();
            fail('Stream unavailable — the link may have expired or the source is blocked.');
            return;
          }
        }
        hls.startLoad();
        return;
      }
      hls.destroy();
      fail('Playback failed. Please reload the page.');
    });
    hls.loadSource(src);
    hls.attachMedia(v);
  };

  v.addEventListener('playing', () => {
    overlay.classList.add('done');
    if (v.muted) unmute.style.display = 'block';
  });
  unmute.addEventListener('click', () => {
    v.muted = false;
    unmute.style.display = 'none';
  });
  v.addEventListener('click', () => {
    if (v.muted) { v.muted = false; unmute.style.display = 'none'; }
  });

  start();
})();
<\/script>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type':   'text/html; charset=utf-8',
      'Cache-Control':  'no-store',
      'X-Proxy-Player': '1',
    },
  })
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

  /* Open-allowlist mode: if host not in ALLOWED, still proxy it — treat all
     streaming CDN traffic as fair game. Only block obvious non-CDN hosts. */
  const NON_CDN_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
  if (NON_CDN_RE.test(targetUrl.hostname)) {
    return new Response('Host not allowed', { status: 403, headers: corsHeaders() })
  }

  const cookie = reqUrl.searchParams.get('cookie') || ''
  const ref    = reqUrl.searchParams.get('ref')    || ''
  const ua     = reqUrl.searchParams.get('ua')     || ''
  const via    = reqUrl.searchParams.get('via')    || ''
  const host   = targetUrl.hostname
  const pathLower = targetUrl.pathname.toLowerCase()
  const isManifest = /\.(m3u8|mpd)$/.test(pathLower)

  // ── Browser navigation → built-in HLS player ───────────────────────────────
  // A top-level browser navigation to a playlist URL cannot play it natively
  // (no HLS support in Chrome/Firefox). Serve the hls.js player page instead.
  // Players requesting the same URL send Accept: */* and bypass this entirely.
  const accept = request.headers.get('accept') || ''
  if (
    isManifest &&
    pathLower.endsWith('.m3u8') &&
    !reqUrl.searchParams.has('raw') &&
    accept.includes('text/html') &&
    !accept.includes('vnd.apple.mpegurl')
  ) {
    return playerPage(host)
  }

  const relayUrl     = env?.RESIDENTIAL_RELAY_URL || ''
  const hotstarRelay = env?.HOTSTAR_RELAY          || ''

  // Forward Range so players can seek / resume partial segments
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
  } else if (isFanCodeHost(host)) {
    upstreamHeaders = genericHeaders(
      ua || DEFAULT_UA,
      ref || FANCODE_REFERER,
      FANCODE_ORIGIN,
      cookie,
    )
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
  if (rangeHeader && !isManifest) upstreamHeaders.set('Range', rangeHeader)

  // ── Fetch strategy ─────────────────────────────────────────────────────────

  let upstream: Response | null = null
  let usedProxy = ''
  const needsProxy = needsResidential(host) || geoRequired(host) !== null

  /** Race direct edge fetch against the proxy pool — first OK response wins. */
  async function raceDirectAndPool(): Promise<void> {
    const direct = directFetch(targetUrl, upstreamHeaders, isManifest)
      .then(async r => {
        if (!r.ok) throw new Error(String(r.status))
        if (!(await isValidHlsManifest(r, targetUrl))) throw new Error('Invalid HLS manifest')
        return { res: r, proxy: '' }
      })
    const pooled = findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
      .then(hit => {
        if (!hit) throw new Error('no proxy')
        knownProxies.set(host, { proxy: hit.proxy, ms: hit.ms, at: Date.now() })
        return { res: hit.res, proxy: hit.proxy }
      })
    const winner = await Promise.any([direct, pooled]).catch(() => null)
    if (winner) { upstream = winner.res; usedProxy = winner.proxy }
  }

  try {
    if (via) {
      // Pinned proxy from last manifest — try it first, re-race on failure
      const entry  = knownProxies.get(host)
      const stale  = entry && entry.ms > PROXY_EVICT_MS
      const pinned = (entry && !stale) ? entry.proxy : via

      let hit: { proxy: string; res: Response; ms: number } | null = null
      try {
        const { res, ms } = await timedPoolFetch(
          pinned, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 8000,
        )
        if (res.ok && await isValidHlsManifest(res, targetUrl)) {
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
      else       upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)

    } else if (isJioMobileCDN(host)) {
      // Hard geo-block — pool only, direct will always 450
      if (hotstarRelay) {
        try {
          const { res, ms } = await timedPoolFetch(
            hotstarRelay, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 6000,
          )
          if (res.ok) { upstream = res; usedProxy = hotstarRelay; knownProxies.set(host, { proxy: hotstarRelay, ms, at: Date.now() }) }
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
            hotstarRelay, targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl, 6000,
          )
          if (res.ok) { upstream = res; usedProxy = hotstarRelay; knownProxies.set(host, { proxy: hotstarRelay, ms, at: Date.now() }) }
        } catch { /* fall through */ }
      }
      if (!upstream) {
        const hit = await findProxy(targetUrl, upstreamHeaders, cookie, ref, ua, relayUrl)
        if (hit) { upstream = hit.res; usedProxy = hit.proxy }
        else       upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)
      }

    } else if (needsProxy) {
      // Geo-restricted — race direct edge fetch against the pool; first OK wins
      await raceDirectAndPool()

      // Sony multi-profile retry: CDNs fingerprint UA+Referer combos, so on
      // 403 rotate through desktop, mobile-app, and bare profiles via the pool.
      const upstreamRes = upstream as Response | null
      if ((!upstreamRes || !upstreamRes.ok) && isSonyHost(host)) {
      const profiles = [
          genericHeaders(SONY_MOBILE_UA, SONY_REFERER, SONY_ORIGIN, cookie),
          genericHeaders(SONY_MOBILE_UA, '', '', cookie),
        ]
        for (const profile of profiles) {
          const hit = await findProxy(targetUrl, profile, cookie, ref, ua, relayUrl, '', 6)
          if (hit) { upstream = hit.res; usedProxy = hit.proxy; break }
        }
      }
      if (!upstream) upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)

    } else {
      // No geo restriction — straight from CF edge (segments edge-cached)
      upstream = await directFetch(targetUrl, upstreamHeaders, isManifest)
      // If direct gets a geo-block response, fall back to pool automatically
      const retryableBlock = upstream.status === 400 || upstream.status === 403 || upstream.status === 404 ||
        upstream.status === 429 || upstream.status === 450 || upstream.status === 451 || upstream.status >= 500
      const invalidFanCodeManifest = isFanCodeHost(host) && upstream.ok && isManifest &&
        !(await isValidHlsManifest(upstream, targetUrl))
      if ((!upstream.ok && (isFanCodeHost(host) ? retryableBlock : [403, 450, 451].includes(upstream.status))) || invalidFanCodeManifest) {
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

  // A relay can return a branded HTML block page with HTTP 200. Do not wrap it
  // as a playlist: strict HLS clients report a confusing parse error and retry
  // indefinitely. Surface a clear upstream failure instead.
  if (upstream.ok && isManifest && !(await isValidHlsManifest(upstream, targetUrl))) {
    if (usedProxy && knownProxies.get(host)?.proxy === usedProxy) knownProxies.delete(host)
    return new Response('Upstream did not return a valid HLS playlist. The source may be blocked, expired, or unavailable.', {
      status: 502,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Proxy-Upstream': String(upstream.status),
        'X-Proxy-Upstream-Host': host,
        'X-Proxy-Upstream-Content-Type': upstream.headers.get('content-type') || 'unknown',
      },
    })
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
    let manifestBase = targetUrl
    if (!usedProxy && upstream.url) {
      try { manifestBase = new URL(upstream.url) } catch { /* retain request URL */ }
    }
    const rewritten = rewriteMpd(text, manifestBase, proxyBase, extras)
    prefetchSegments(rewritten, cookie, ua || JIO_UA, ref, host, ctx)
    return new Response(rewritten, {
      status: 200,
      headers: { ...responseHeaders, 'Content-Type': 'application/dash+xml; charset=utf-8', 'Cache-Control': 'no-cache' },
    })
  }

  // ── HLS playlist ───────────────────────────────────────────────────────────

  if (isHls(path, contentType)) {
    const text      = await upstream.text()
    // Use the final URL after upstream redirects so relative child paths resolve
    // against the actual playlist location. Relay responses keep the requested URL.
    let playlistBase = targetUrl
    if (!usedProxy && upstream.url) {
      try { playlistBase = new URL(upstream.url) } catch { /* retain request URL */ }
    }
    const rewritten = rewritePlaylist(text, playlistBase, proxyBase, extras)
    prefetchSegments(rewritten, cookie, ua || DEFAULT_UA, ref, host, ctx)
    return new Response(rewritten, {
      status: 200,
      headers: { ...responseHeaders, 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Cache-Control': 'no-cache' },
    })
  }

  // ── Binary passthrough ─────────────────────────────────────────────────────

  const respHeaders = new Headers(upstream.headers)
  for (const [k, v] of Object.entries(responseHeaders)) respHeaders.set(k, v)
  respHeaders.delete('content-security-policy')
  respHeaders.delete('content-encoding')
  // Segments are immutable — let browser + edge cache them aggressively
  if (upstream.status === 200) {
    respHeaders.set('Cache-Control', 'public, max-age=120, immutable')
  } else {
    respHeaders.set('Cache-Control', 'no-store')
  }
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
