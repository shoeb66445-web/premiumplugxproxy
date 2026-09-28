/**
 * HLS/DASH CORS proxy — /api/proxy?u=<encoded stream url>[&cookie=][&ref=][&ua=]
 *
 * Pipe-delimited URL format (VLC/Kodi/IPTV players) is parsed automatically:
 *   url|cookie=hdntl=...&referer=https://...&user-agent=...
 * The pipe splits the actual URL from its companion headers. Query-string
 * format (?u=url&cookie=...&ref=...&ua=...) is also accepted — callers can use
 * either. When both are present, pipe-extracted values win.
 *
 * Rewrites both HLS (.m3u8) AND DASH (.mpd) manifests so every child URL
 * (variants, segments, init, keys, BaseURL entries, SegmentTemplate paths)
 * routes back through this proxy with the same headers attached.
 *
 * Sony-friendly defaults: slivcdn / sonydaimenew.akamaized.net get the SonyLiv
 * Referer/Origin and a desktop Chrome UA automatically.
 *
 * Hotstar: jcevents.hotstar.com + livetv.hotstar.com + live09p.hotstar.com
 * require the mobile app UA — desktop UA gets 403 regardless of token.
 * All other *.hotstar.com subdomains get hotstar Origin + desktop UA.
 *
 * NOTE: Cloudflare Workers cannot tunnel egress through a residential proxy
 * (no CONNECT in fetch). Geo-blocked hosts that refuse datacenter IPs need
 * a Mumbai-pinned Vercel deployment. Indian-IP routing is on the caller side.
 */
import { createFileRoute } from '@tanstack/react-router'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SONY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SONY_ORIGIN = 'https://www.sonyliv.com'
const SONY_REFERER = 'https://www.sonyliv.com/'

/**
 * Hotstar mobile app UA — required by jcevents / livetv / live09p segment CDNs.
 * These hosts return 403 for any desktop UA even with a valid hdntl token.
 * Format: "<brand>;<bundle-id>/<version>@<tier> <device>(<os>/<os-version>)"
 */
const HOTSTAR_MOBILE_UA =
  'Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)'

/**
 * Secondary Hotstar UA — newer JioHotstar client string seen on post-2024
 * streams. Some CDN edges accept either; a small number only accept this one.
 */
const HOTSTAR_MOBILE_UA_ALT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 ' +
  'JioHotstar/25.02.24.8.11169'

const HOTSTAR_ORIGIN = 'https://www.hotstar.com'
const HOTSTAR_REFERER = 'https://www.hotstar.com/'

/** Allowlist — prevents this from acting as an open relay. Subdomain-matched. */
const ALLOWED_HOSTS = [
  'slivcdn.com',
  'akamaized.net',
  'akamaihd.net',
  'fancode.com',
  'hotstar.com',
  'jio.com',
  'jiocinema.com',
]

/**
 * Sony/SonyLiv CDN hosts that need SonyLiv Referer/Origin identity.
 * sonydaimenew.akamaized.net — Akamai-signed SonyLiv streams. The hdnea token
 * on these URLs uses acl=/* (wildcard), meaning the same token covers the master
 * playlist AND every child segment/key URL, so token inheritance is critical and
 * the ~ * characters in the token MUST NOT be percent-encoded (breaks HMAC).
 * All subdomain variants (sonydaime*.akamaized.net) are caught by the
 * endsWith('.akamaized.net') allowlist check; add specific overrides here only
 * when a host needs different identity headers than the default.
 */
const SONY_HOSTS = [
  'slivcdn.com',
  'sonydaimenew.akamaized.net',
  'sonydaime.akamaized.net',       // alternate edge cluster
  'sonyliv.akamaized.net',          // fallback CDN
]

/**
 * Hotstar CDN hosts that REQUIRE the mobile app UA on every request.
 * The check is: exact match OR subdomain of any entry.
 * live09p is a CDN prefix — match *.live09p.hotstar.com too via subdomain rule.
 */
const HOTSTAR_MOBILE_UA_HOSTS = [
  'jcevents.hotstar.com',   // JioHotstar live events
  'livetv.hotstar.com',     // Star/Disney linear channels
  'live09p.hotstar.com',    // 24/7 live feeds
  'cf-imgp.hotstar.com',    // image CDN — mobile UA required
  'api.hotstar.com',        // license/key endpoint
]

const allowed = (h: string) =>
  ALLOWED_HOSTS.some((s) => h === s || h.endsWith('.' + s))

const isSonyHost = (h: string) =>
  SONY_HOSTS.some((s) => h === s || h.endsWith('.' + s))

const isHotstarHost = (h: string) =>
  h === 'hotstar.com' || h.endsWith('.hotstar.com')

const needsHotstarMobileUA = (h: string) =>
  HOTSTAR_MOBILE_UA_HOSTS.some((s) => h === s || h.endsWith('.' + s))

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
}

/**
 * Pipe-format parser: "https://host/path.m3u8?token=...|cookie=hdntl=...&referer=...&user-agent=..."
 *
 * The segment after the first `|` is treated as a URL-encoded query string.
 * Keys accepted: cookie, referer (also ref), origin, user-agent (also ua).
 * Values must NOT be percent-encoded by the caller — the raw string is used as-is,
 * matching what VLC/Kodi/IPTV players emit.
 *
 * Returns the real stream URL and any extracted override headers.
 */
function parsePipeFormat(raw: string): {
  streamUrl: string
  pipeCookie: string
  pipeRef: string
  pipeOrigin: string
  pipeUA: string
} {
  const pipeIdx = raw.indexOf('|')
  if (pipeIdx === -1) {
    return { streamUrl: raw, pipeCookie: '', pipeRef: '', pipeOrigin: '', pipeUA: '' }
  }

  const streamUrl = raw.slice(0, pipeIdx)
  const paramStr = raw.slice(pipeIdx + 1)

  // Split on & but only at top level — cookie values contain = signs, not &
  const parts = paramStr.split('&')
  let pipeCookie = ''
  let pipeRef = ''
  let pipeOrigin = ''
  let pipeUA = ''

  for (const part of parts) {
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) continue
    const key = part.slice(0, eqIdx).toLowerCase().trim()
    const val = part.slice(eqIdx + 1)

    if (key === 'cookie') pipeCookie = val
    else if (key === 'referer' || key === 'ref') pipeRef = val
    else if (key === 'origin') pipeOrigin = val
    else if (key === 'user-agent' || key === 'ua') pipeUA = val
  }

  return { streamUrl, pipeCookie, pipeRef, pipeOrigin, pipeUA }
}

/**
 * HLS (.m3u8) manifest rewriter.
 *
 * Every child URL — variants in master playlists, segments in media playlists,
 * EXT-X-KEY URIs, EXT-X-MAP URIs — is resolved to absolute form, then wrapped
 * in a proxy URL so the browser fetches it through this endpoint.
 *
 * Parent query string inheritance: SonyLiv/Akamai signs with hdnea=... on the
 * master playlist URL. Relative child references resolve without a query string,
 * dropping the token. We re-attach the parent's raw search string verbatim to
 * any child that resolves without one.
 *
 * ENCODING RULE — this is the source of the Akamai EdgeSuite error:
 * Akamai's hdnea token contains `~` and `*` characters that are meaningful to
 * their HMAC validator. encodeURIComponent turns `~` → `%7E` and `*` → `%2A`.
 * When the proxy receives a child request, it decodes %u=...% back — but if
 * the token was double-encoded, the acl path arrives as `/%2A` instead of `/*`
 * and the HMAC check fails, producing the EdgeSuite error page.
 *
 * Solution: the ?u= parameter uses encodeURIComponent ONLY on characters that
 * would break URL parsing (space, &, #, ?). The token characters (~, *, =, /)
 * are left literal. We achieve this by wrapping with a custom encoder that
 * only encodes what the browser's query parser would misread.
 */
function rewriteHLS(text: string, baseUrl: URL, proxyBase: string, extras: string): string {
  const parentQuery = baseUrl.search

  const toAbs = (ref: string): string => {
    try {
      // If already absolute, just ensure token inheritance
      const u = new URL(ref, baseUrl)
      if (!u.search && parentQuery) {
        // Attach parent query string as raw string — do NOT use u.search = parentQuery
        // because the URL setter will re-encode the hdnea token characters.
        return u.origin + u.pathname + parentQuery
      }
      return u.toString()
    } catch {
      return ref
    }
  }

  /**
   * Wrap an absolute URL into a proxy URL.
   *
   * We must NOT call encodeURIComponent(absUrl) here — that double-encodes
   * the hdnea token. Instead we encode only the characters that are unsafe
   * as a query param value: space, &, #, and bare + signs. The token's ~, *,
   * =, /, : characters are safe inside a query value per RFC 3986 §3.4 and
   * must stay literal for Akamai's HMAC validator.
   */
  const wrap = (absUrl: string): string => {
    const encoded = absUrl
      .replace(/%/g, '%25')   // must be first — escape any existing % to avoid triple-encode
      .replace(/ /g, '%20')
      .replace(/&/g, '%26')
      .replace(/#/g, '%23')
    return proxyBase + '?u=' + encoded + extras
  }

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${wrap(toAbs(uri))}"`)
      }

      return wrap(toAbs(trimmed))
    })
    .join('\n')
}

/**
 * DASH (.mpd) manifest rewriter.
 *
 * An MPD is XML. Three URL patterns need rewriting:
 *   1. <BaseURL>https://...</BaseURL> — absolute base for relative references
 *   2. SegmentTemplate media="..." initialization="..." — template strings that
 *      expand to segment URLs; we wrap the template base so expanded URLs route
 *      through the proxy. Only the scheme+host+path prefix is wrapped — the
 *      $Number$ / $Time$ / $RepresentationID$ tokens stay intact.
 *   3. <Initialization sourceURL="..." /> — init segment absolute URLs
 *
 * A full DASH rewriter needs an XML parser + BaseURL inheritance across levels
 * (MPD → Period → AdaptationSet → Representation). We handle the common
 * JioHotstar pattern: one top-level <BaseURL> and segment templates relative to it.
 *
 * For complex multi-period MPDs with per-representation BaseURLs, the
 * BaseURL regex catches each occurrence independently — correct for flat layouts.
 */
function rewriteDASH(text: string, baseUrl: URL, proxyBase: string, extras: string): string {
  const parentQuery = baseUrl.search

  const toAbsAndWrap = (href: string): string => {
    try {
      const u = new URL(href, baseUrl)
      // Inherit parent query without going through the URL setter (avoids re-encoding)
      const absStr = (!u.search && parentQuery)
        ? u.origin + u.pathname + parentQuery
        : u.toString()
      // Same safe-encode as rewriteHLS — preserve ~ * = / : for Akamai HMAC
      const encoded = absStr
        .replace(/%/g, '%25')
        .replace(/ /g, '%20')
        .replace(/&/g, '%26')
        .replace(/#/g, '%23')
      return proxyBase + '?u=' + encoded + extras
    } catch {
      return href
    }
  }

  return (
    text
      // <BaseURL>https://cdn.example.com/path/</BaseURL>
      .replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_, url) => {
        return `<BaseURL>${toAbsAndWrap(url.trim())}</BaseURL>`
      })
      // initialization="https://.../$RepresentationID$/init.mp4"
      .replace(/initialization="([^"]+)"/g, (_, url) => {
        return `initialization="${toAbsAndWrap(url.trim())}"`
      })
      // media="https://.../$Number%06d$.m4s"
      .replace(/\smedia="([^"]+)"/g, (_, url) => {
        return ` media="${toAbsAndWrap(url.trim())}"`
      })
      // <Initialization sourceURL="..." />
      .replace(/sourceURL="([^"]+)"/g, (_, url) => {
        return `sourceURL="${toAbsAndWrap(url.trim())}"`
      })
      // <SegmentURL media="..." />
      .replace(/SegmentURL media="([^"]+)"/g, (_, url) => {
        return `SegmentURL media="${toAbsAndWrap(url.trim())}"`
      })
  )
}

async function handleProxy(request: Request): Promise<Response> {
  const reqUrl = new URL(request.url)

  // Accept both 'u' and 'url' param names
  const rawTarget = reqUrl.searchParams.get('u') || reqUrl.searchParams.get('url')
  if (!rawTarget) {
    return new Response('Missing ?u=', { status: 400, headers: corsHeaders() })
  }

  // Parse pipe-format header overrides out of the raw target string
  const { streamUrl, pipeCookie, pipeRef, pipeOrigin, pipeUA } = parsePipeFormat(rawTarget)

  let targetUrl: URL
  try {
    targetUrl = new URL(streamUrl)
  } catch {
    return new Response('Invalid url', { status: 400, headers: corsHeaders() })
  }

  if (!allowed(targetUrl.hostname)) {
    return new Response('Host not allowed', { status: 403, headers: corsHeaders() })
  }

  // Query-string params as fallback if pipe format didn't supply them
  const qsCookie = reqUrl.searchParams.get('cookie') || ''
  const qsRef    = reqUrl.searchParams.get('ref')    || ''
  const qsUA     = reqUrl.searchParams.get('ua')     || ''

  // Pipe values win over query-string values
  const cookie = pipeCookie || qsCookie
  const ref    = pipeRef    || qsRef
  const ua     = pipeUA     || qsUA

  // Determine effective identity headers per CDN
  let effectiveUA: string
  let effectiveRef: string
  let effectiveOrigin: string

  if (isSonyHost(targetUrl.hostname)) {
    effectiveUA     = ua  || SONY_UA
    effectiveRef    = ref || SONY_REFERER
    effectiveOrigin = SONY_ORIGIN
  } else if (needsHotstarMobileUA(targetUrl.hostname)) {
    // Segment CDNs that 403 on desktop UA — mobile app string required
    effectiveUA     = ua  || HOTSTAR_MOBILE_UA
    effectiveRef    = ref || HOTSTAR_REFERER
    effectiveOrigin = pipeOrigin || HOTSTAR_ORIGIN
  } else if (isHotstarHost(targetUrl.hostname)) {
    // Other Hotstar subdomains (playlist fetch, API calls) — desktop UA fine
    effectiveUA     = ua  || DEFAULT_UA
    effectiveRef    = ref || HOTSTAR_REFERER
    effectiveOrigin = pipeOrigin || HOTSTAR_ORIGIN
  } else {
    effectiveUA = ua || DEFAULT_UA
    let refOrigin = targetUrl.origin
    if (ref) {
      try { refOrigin = new URL(ref).origin } catch { /* keep target's */ }
    }
    effectiveRef    = ref || targetUrl.origin + '/'
    effectiveOrigin = refOrigin
  }

  // Build the upstream request headers.
  // Akamai edges on sonydaimenew.akamaized.net check Accept-Encoding — sending
  // 'identity' prevents gzip/br on manifest responses, which simplifies body
  // handling (no Content-Encoding to strip). Segments are binary and unaffected.
  const upstreamHeaders: Record<string, string> = {
    'User-Agent':      effectiveUA,
    'Referer':         effectiveRef,
    'Origin':          effectiveOrigin,
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
  }

  if (cookie) {
    upstreamHeaders['Cookie'] = cookie
  }

  // Sony/Akamai: add the SonyLiv app version header that some edge configs check
  if (isSonyHost(targetUrl.hostname)) {
    upstreamHeaders['X-Platform'] = 'browser'
    upstreamHeaders['X-Requested-With'] = 'XMLHttpRequest'
  }

  let upstream: Response
  try {
    upstream = await fetch(targetUrl.toString(), {
      headers: upstreamHeaders,
      redirect: 'follow',
    })
  } catch (e) {
    return new Response('Upstream failed: ' + (e as Error).message, {
      status: 502,
      headers: corsHeaders(),
    })
  }

  // Upstream 4xx/5xx — pass the status back verbatim so the player shows the real error
  if (!upstream.ok) {
    const body = await upstream.text()
    return new Response(body.slice(0, 2000), {
      status: upstream.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/plain',
        'X-Proxy-Upstream-Status': String(upstream.status),
        'X-Proxy-Target-Host': targetUrl.hostname,
      },
    })
  }

  const contentType = upstream.headers.get('content-type') || ''
  const path = targetUrl.pathname.toLowerCase()

  const isHLS =
    path.endsWith('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('vnd.apple.mpegurl')

  const isDASH =
    path.endsWith('.mpd') ||
    contentType.includes('dash+xml') ||
    contentType.includes('application/xml')

  const proxyBase = reqUrl.origin + reqUrl.pathname

  // Carry credential headers through rewritten child URLs as query params.
  // cookie/ref/ua values ARE correctly encodeURIComponent'd here — they are
  // header-value strings, not Akamai token paths, so full encoding is safe.
  // The ?u= value is handled separately in wrap() with minimal encoding.
  const extras =
    (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
    (ref    ? '&ref='    + encodeURIComponent(ref)    : '') +
    (ua     ? '&ua='     + encodeURIComponent(ua)     : '')

  if (isHLS) {
    const text = await upstream.text()
    const rewritten = rewriteHLS(text, targetUrl, proxyBase, extras)
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      },
    })
  }

  if (isDASH) {
    const text = await upstream.text()
    const rewritten = rewriteDASH(text, targetUrl, proxyBase, extras)
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/dash+xml',
        'Cache-Control': 'no-cache',
      },
    })
  }

  // Segments, init chunks, encryption keys — stream bytes through with CORS headers
  const headers = new Headers(upstream.headers)
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v)
  headers.delete('content-security-policy')
  headers.delete('content-encoding')
  return new Response(upstream.body, { status: upstream.status, headers })
}

export const Route = createFileRoute('/api/proxy')({
  server: {
    handlers: {
      GET:     async ({ request }) => handleProxy(request),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
    },
  },
})
