/**
 * HLS CORS proxy — /api/proxy?u=<encoded stream url>[&cookie=][&ref=][&ua=]
 *
 * Fetches the stream server-side, adds CORS, and rewrites .m3u8 playlists so
 * every variant, segment, and key routes back through this proxy. Caller-
 * supplied cookie/ref/ua ride along on every rewritten URL, because CDNs like
 * slivcdn and Akamai check those headers on each segment, not just the master
 * playlist — a signed playlist with bare segments is how a stream plays for
 * two seconds and then 403s.
 *
 * Sony-friendly defaults: slivcdn / sonydaimenew.akamaized.net get the SonyLiv
 * Referer/Origin and a desktop Chrome UA automatically.
 *
 * NOTE: this runs on Cloudflare's edge, which cannot tunnel egress through
 * the Indian residential proxy list (no CONNECT support in Workers fetch).
 * Hosts that only block by geography work fine; hosts that refuse datacenter
 * IPs outright still need a Mumbai-pinned deployment (see the Vercel variant).
 */
import { createFileRoute } from '@tanstack/react-router'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SONY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SONY_ORIGIN = 'https://www.sonyliv.com'
const SONY_REFERER = 'https://www.sonyliv.com/'

/* Only these hosts — prevents this from acting as an open relay. */
const ALLOWED = [
  'slivcdn.com', // Dish/SonyLiv: dishmt.slivcdn.com, dishmt2, slivevents…
  'akamaized.net', // SonyLiv Akamai signed streams (sonydaimenew…)
  'akamaihd.net',
  'fancode.com',
  'hotstar.com',
  'jio.com',
  'jiocinema.com',
]

/* Hosts that answer better with the SonyLiv identity than a bare fetch. */
const SONY_HOSTS = ['slivcdn.com', 'sonydaimenew.akamaized.net']

const allowed = (h: string) => ALLOWED.some((s) => h === s || h.endsWith('.' + s))
const isSonyHost = (h: string) => SONY_HOSTS.some((s) => h === s || h.endsWith('.' + s))

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
}

function rewritePlaylist(text: string, baseUrl: URL, proxyBase: string, extras: string) {
  const wrap = (absUrl: string) => proxyBase + '?u=' + encodeURIComponent(absUrl) + extras

  /* A child URL with no query of its own inherits the parent's. SonyLiv signs
     with hdnea in the query and an acl of /*, so every variant and segment
     needs the token too — but a playlist names them relatively, and resolving
     a relative reference throws the query away. */
  const parentQuery = baseUrl.search
  const toAbs = (ref: string) => {
    const u = new URL(ref, baseUrl)
    if (!u.search && parentQuery) u.search = parentQuery
    return u.toString()
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

async function handleProxy(request: Request) {
  const reqUrl = new URL(request.url)
  const target = reqUrl.searchParams.get('u') || reqUrl.searchParams.get('url')
  if (!target) {
    return new Response('Missing ?u=', { status: 400, headers: corsHeaders() })
  }

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return new Response('Invalid url', { status: 400, headers: corsHeaders() })
  }
  if (!allowed(targetUrl.hostname)) {
    return new Response('Host not allowed', { status: 403, headers: corsHeaders() })
  }

  /* Optional caller-supplied headers, for CDNs that want more than CORS.
     slivcdn checks Cookie, Referer, and Origin together — missing any one of
     the three answers 403, and a browser cannot set Cookie cross-origin,
     which is the whole reason these streams need a proxy. */
  const cookie = reqUrl.searchParams.get('cookie') || ''
  const ref = reqUrl.searchParams.get('ref') || ''
  const ua = reqUrl.searchParams.get('ua') || ''

  let effectiveUA: string
  let effectiveRef: string
  let effectiveOrigin: string

  if (isSonyHost(targetUrl.hostname)) {
    effectiveUA = ua || SONY_UA
    effectiveRef = ref || SONY_REFERER
    effectiveOrigin = SONY_ORIGIN
  } else {
    effectiveUA = ua || DEFAULT_UA
    let refOrigin = targetUrl.origin
    if (ref) {
      try {
        refOrigin = new URL(ref).origin
      } catch {
        /* keep target's */
      }
    }
    effectiveRef = ref || targetUrl.origin + '/'
    effectiveOrigin = refOrigin
  }

  let upstream: Response
  try {
    upstream = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent': effectiveUA,
        Referer: effectiveRef,
        Origin: effectiveOrigin,
        Accept: '*/*',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'follow',
    })
  } catch (e) {
    return new Response('Upstream failed: ' + (e as Error).message, {
      status: 502,
      headers: corsHeaders(),
    })
  }

  const contentType = upstream.headers.get('content-type') || ''
  const path = targetUrl.pathname.toLowerCase()
  const isPlaylist =
    path.endsWith('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('vnd.apple.mpegurl')

  const proxyBase = reqUrl.origin + reqUrl.pathname

  /* A refusal is not a playlist, whatever the path says. Hand the failure
     back as-is so the player sees the actual status rather than a mangled
     manifest full of proxy URLs. */
  if (!upstream.ok) {
    const body = await upstream.text()
    return new Response(body.slice(0, 2000), {
      status: upstream.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/plain',
        'X-Proxy-Upstream': String(upstream.status),
      },
    })
  }

  if (isPlaylist) {
    const text = await upstream.text()
    /* The same headers have to ride along on every segment, not just the
       playlist — the CDN checks each request. */
    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref ? '&ref=' + encodeURIComponent(ref) : '') +
      (ua ? '&ua=' + encodeURIComponent(ua) : '')
    const rewritten = rewritePlaylist(text, targetUrl, proxyBase, extras)
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      },
    })
  }

  // Segments / keys / anything else: stream bytes straight through with CORS added.
  const headers = new Headers(upstream.headers)
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v)
  headers.delete('content-security-policy')
  headers.delete('content-encoding') // body is passed through decoded
  return new Response(upstream.body, { status: upstream.status, headers })
}

export const Route = createFileRoute('/api/proxy')({
  server: {
    handlers: {
      GET: async ({ request }) => handleProxy(request),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
    },
  },
})
