/**
 * /api/slivstream — SonyLiv CORS-bypass streaming endpoint
 *
 * Ported from sony.php v15.0 — gets fresh Sony session cookies via API,
 * fetches master playlist directly from CDN edge, rewrites all URLs
 * through /api/proxy so clients worldwide can play via browser/VLC/IPTV.
 *
 * Routes:
 *   GET /api/slivstream                → M3U playlist of all channels
 *   GET /api/slivstream?ch=set-hd      → proxied master.m3u8 for that channel
 *   GET /api/slivstream?ch=set-hd&play → browser player page
 *   GET /api/slivstream?format=json    → JSON channel list
 */
import { createFileRoute } from '@tanstack/react-router'

// ─── Channel registry (from sony.php) ────────────────────────────────────────

interface SlivChannel {
  slug: string
  name: string
  group: string
  url: string
  logo: string
}

const CHANNELS: SlivChannel[] = [
  { slug: 'set-hd',    name: 'SONY HD',        group: 'Entertainment', url: 'https://dishmt.slivcdn.com/hls/live/2011671-b/SETHD/master.m3u8',         logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_HD.png' },
  { slug: 'sab-hd',    name: 'SAB HD',          group: 'Entertainment', url: 'https://dishmt.slivcdn.com/hls/live/2011749-b/SABHD/master.m3u8',         logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_SAB_HD.png' },
  { slug: 'marathi',   name: 'SONY MARATHI',    group: 'Entertainment', url: 'https://dishmt.slivcdn.com/hls/live/2011740-b/SonyMarathi/master.m3u8',    logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_Marathi_SD.png' },
  { slug: 'aath',      name: 'SONY AATH',       group: 'Entertainment', url: 'https://dishmt.slivcdn.com/hls/live/2011641-b/SonyAathSD/master.m3u8',     logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_aath.png' },
  { slug: 'pal',       name: 'SONY PAL',        group: 'Movies',        url: 'https://dishmt.slivcdn.com/hls/live/2011741-b/SonyPalSD/master.m3u8',      logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_Pal.png' },
  { slug: 'max-hd',    name: 'SONY MAX HD',     group: 'Movies',        url: 'https://dishmt.slivcdn.com/hls/live/2011670-b/SonyMaxhd/master.m3u8',      logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_Max_HD.png' },
  { slug: 'max',       name: 'SONY MAX',        group: 'Movies',        url: 'https://dishmt.slivcdn.com/hls/live/2011745-b/SonyMaxSD/master.m3u8',      logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_Max_SD.png' },
  { slug: 'wah',       name: 'SONY WAH',        group: 'Movies',        url: 'https://dishmt.slivcdn.com/hls/live/2011906-b/SonyWah/master.m3u8',        logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_Wah.png' },
  { slug: 'max2',      name: 'SONY MAX 2',      group: 'Movies',        url: 'https://dishmt.slivcdn.com/hls/live/2011908-b/MAX2/master.m3u8',           logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_MAX2.png' },
  { slug: 'pix-hd',    name: 'SONY PIX HD',     group: 'Movies',        url: 'https://dishmt.slivcdn.com/hls/live/2011748/PIXHD/master.m3u8',            logo: 'https://ltsk-cdn.s3.eu-west-1.amazonaws.com/jumpstart/Temp_Live/cdn/HLS/Channel/imageContent-93-j5fjv614-v3/imageContent-93-j5fjv614-m3.png' },
  { slug: 'yay',       name: 'SONY YAY',        group: 'Kids',          url: 'https://dishmt.slivcdn.com/hls/live/2011746-b/SonyYaySD/master.m3u8',      logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_Yay_Hindi.png' },
  { slug: 'ten1-hd',   name: 'SONY TEN 1 HD',   group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2011747/TEN1HD/master.m3u8',           logo: 'https://ltsk-cdn.s3.eu-west-1.amazonaws.com/jumpstart/Temp_Live/cdn/HLS/Channel/imageContent-261-j5fz9bvk-v4/imageContent-261-j5fz9bvk-m4.png' },
  { slug: 'ten1',      name: 'SONY TEN 1',      group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2011739/TEN1SD/master.m3u8',           logo: 'https://raw.githubusercontent.com/vijay-iptv/logos/refs/heads/main/Sony_Ten_1.png' },
  { slug: 'ten2-hd',   name: 'SONY TEN 2 HD',   group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2020434/TEN2HD/master.m3u8',           logo: 'https://ltsk-cdn.s3.eu-west-1.amazonaws.com/jumpstart/Temp_Live/cdn/HLS/Channel/imageContent-11784-j9kylfd4-v2/imageContent-11784-j9kylfd4-m3.png' },
  { slug: 'ten2',      name: 'SONY TEN 2',      group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2020590/TEN2SD/master.m3u8',           logo: 'https://raw.githubusercontent.com/vijay-iptv/logos/refs/heads/main/Sony_Ten_2.png' },
  { slug: 'ten3-hd',   name: 'SONY TEN 3 HD',   group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2020591/TEN3HD/master.m3u8',           logo: 'https://ltsk-cdn.s3.eu-west-1.amazonaws.com/jumpstart/Temp_Live/cdn/HLS/Channel/imageContent-11787-j9kynnm0-v3/imageContent-11787-j9kynnm0-m3.png' },
  { slug: 'ten3',      name: 'SONY TEN 3',      group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2020592/TEN3SD/master.m3u8',           logo: 'https://raw.githubusercontent.com/vijay-iptv/logos/refs/heads/main/Sony_Ten_3.png' },
  { slug: 'ten4-hd',   name: 'SONY TEN 4 HD',   group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2020589/ten4hd/master.m3u8',           logo: 'https://raw.githubusercontent.com/vijay-iptv/logos/refs/heads/main/Sony_Ten_4.png' },
  { slug: 'ten4',      name: 'SONY TEN 4',      group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2020437/ten4sd/master.m3u8',           logo: 'https://raw.githubusercontent.com/vijay-iptv/logos/refs/heads/main/Sony_Ten_4.png' },
  { slug: 'ten5-hd',   name: 'SONY TEN 5 HD',   group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2020593/SONYSIXHD/master.m3u8',        logo: 'https://ltsk-cdn.s3.eu-west-1.amazonaws.com/jumpstart/Temp_Live/cdn/HLS/Channel/imageContent-108-j5fl5wwg-v3/imageContent-108-j5fl5wwg-m3.png' },
  { slug: 'ten5',      name: 'SONY TEN 5',      group: 'Sports',        url: 'https://dishmt.slivcdn.com/hls/live/2020594-b/SONYSIXSD/master.m3u8',      logo: 'https://raw.githubusercontent.com/vijay-iptv/logos/refs/heads/main/Sony_Ten_5.png' },
  { slug: 'bbc-earth', name: 'BBC EARTH',       group: 'Infotainment',  url: 'https://dishmt.slivcdn.com/hls/live/2011907-b/SonyBBCEarthHD/master.m3u8', logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Sony_BBC_Earth_HD.png' },
]

// ─── Sony API token + cookie extraction ──────────────────────────────────────

const API_BASE = 'https://apiv2.sonyliv.com'
const APP_VER = '3.4.2'
const SAMPLE_VODS = ['1090491205', '1700001659', '1700000121', '1700000456', '1700001234']
const SONY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const SONY_ORIGIN = 'https://www.sonyliv.com'
const SONY_REFERER = 'https://www.sonyliv.com/'

interface SonyCookie {
  query: string
  expiry: number
}

let cookieCache: SonyCookie | null = null

async function sonyApiFetch(url: string, headers?: Record<string, string>): Promise<unknown | null> {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': SONY_UA,
        'Accept': 'application/json',
        ...headers,
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

async function getToken(): Promise<string | null> {
  for (const v of ['1.6', '1.4']) {
    const d = await sonyApiFetch(`${API_BASE}/AGL/${v}/A/ENG/WEB/ALL/GETTOKEN`) as Record<string, unknown> | null
    if (!d) continue
    const r = d.resultObj as Record<string, unknown> | string | null
    if (!r) continue
    if (typeof r === 'string') return r
    if (typeof r === 'object') return (r.token ?? r.securityToken ?? null) as string | null
  }
  return null
}

async function getVodUrl(token: string): Promise<string | null> {
  for (const vod of SAMPLE_VODS) {
    const d = await sonyApiFetch(
      `${API_BASE}/AGL/1.5/A/ENG/WEB/IN/CONTENT/VIDEOURL/VOD/${vod}/freepreview`,
      {
        'Content-Type': 'application/json',
        'x-via-device': 'true',
        'security_token': token,
        'app_version': APP_VER,
      },
    ) as Record<string, unknown> | null
    const url = (d?.resultObj as Record<string, unknown>)?.videoURL as string | undefined
    if (url) return url
  }
  return null
}

function extractCookie(url: string): SonyCookie | null {
  try {
    const u = new URL(url)
    const query = u.search.slice(1)
    if (!query) return null
    let expiry = Math.floor(Date.now() / 1000) + 7200
    const expMatch = /[?&]exp=(\d+)/.exec(url)
    if (expMatch) expiry = parseInt(expMatch[1])
    return { query, expiry }
  } catch {
    return null
  }
}

async function refreshCookie(): Promise<SonyCookie | null> {
  let delay = 400
  for (let i = 0; i < 5; i++) {
    const token = await getToken()
    if (!token) { await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 2, 3200); continue }
    const vodUrl = await getVodUrl(token)
    if (!vodUrl) { await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 2, 3200); continue }
    const ck = extractCookie(vodUrl)
    if (ck) {
      cookieCache = ck
      return ck
    }
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 2, 3200)
  }
  return null
}

async function getCookie(force = false): Promise<SonyCookie | null> {
  if (!force && cookieCache && cookieCache.expiry > Math.floor(Date.now() / 1000) + 900) {
    return cookieCache
  }
  return refreshCookie()
}

function withCk(url: string, cq: string): string {
  if (!cq) return url
  try {
    const u = new URL(url)
    const newParams = new URLSearchParams(cq)
    for (const [k, v] of newParams) {
      if (!u.searchParams.has(k)) u.searchParams.set(k, v)
    }
    return u.toString()
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return url + sep + cq
  }
}

// ─── M3U8 rewriter ───────────────────────────────────────────────────────────
// Rewrites all URLs in the playlist to go through /api/proxy.
// The CLIENT (browser/player) will fetch these URLs — NOT the server.
// This avoids the self-fetch deadlock on Cloudflare Workers.

function resolveUrl(base: string, rel: string): string {
  if (/^https?:\/\//i.test(rel)) return rel
  if (rel.startsWith('//')) return 'https:' + rel
  try { return new URL(rel, base).toString() }
  catch { return base.substring(0, base.lastIndexOf('/') + 1) + rel }
}

function rewriteM3u8(body: string, baseUrl: string, proxyBase: string, cookieQuery: string): string {
  const wrap = (absUrl: string) => {
    const withAuth = withCk(absUrl, cookieQuery)
    return `${proxyBase}?u=${encodeURIComponent(withAuth)}&ref=${encodeURIComponent(SONY_REFERER)}`
  }

  return body.replace(/\r\n/g, '\n').split('\n').map(line => {
    const trimmed = line.trim()
    if (!trimmed) return line

    // Rewrite URI= in HLS tags
    if (/^#EXT-X-(?:KEY|MAP|MEDIA|SESSION-DATA|I-FRAME-STREAM-INF|STREAM-INF):/i.test(trimmed)) {
      return trimmed.replace(/URI="([^"]+)"/g, (_m, uri) => {
        return `URI="${wrap(resolveUrl(baseUrl, uri))}"`
      })
    }

    if (trimmed[0] === '#') return line

    // Plain URL line
    return wrap(resolveUrl(baseUrl, trimmed))
  }).join('\n')
}

// ─── Direct CDN fetch (from edge, not via /api/proxy) ────────────────────────
// Fetches the master playlist directly from slivcdn.
// This runs server-side on Cloudflare edge. slivcdn may geo-block from
// non-Indian IPs, but the master playlist (unlike segments) often works
// globally. If it fails, we return a constructed playlist pointing through
// /api/proxy which will use the Indian proxy pool for segments.

async function fetchMasterPlaylist(
  channelUrl: string,
  cookieQuery: string,
): Promise<{ body: string; effectiveUrl: string } | null> {
  const url = withCk(channelUrl, cookieQuery)
  const headers = new Headers({
    'User-Agent': SONY_UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': SONY_ORIGIN,
    'Referer': SONY_REFERER,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Cache-Control': 'no-cache',
  })

  // Try direct fetch first
  try {
    const r = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    })
    if (r.ok) {
      const body = await r.text()
      if (body.includes('#EXTM3U')) {
        return { body, effectiveUrl: r.url || url }
      }
    }
  } catch { /* direct failed, try via proxy below */ }

  // Direct fetch failed (geo-block) — return null, we'll build a synthetic playlist
  return null
}

// Build a synthetic master playlist that points directly through /api/proxy
// This is used when we can't fetch the master playlist from edge
function buildSyntheticMaster(channelUrl: string, cookieQuery: string, proxyBase: string): string {
  const authedUrl = withCk(channelUrl, cookieQuery)
  const proxied = `${proxyBase}?u=${encodeURIComponent(authedUrl)}&ref=${encodeURIComponent(SONY_REFERER)}`

  // Return a simple redirect-style master playlist
  // The /api/proxy endpoint will fetch the actual master, rewrite it, and serve it
  return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
${proxied}
`
}

// ─── CORS headers ────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
  }
}

// ─── Browser player page ─────────────────────────────────────────────────────

function playerPage(channelName: string, streamUrl: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${channelName} — SonyLiv Stream</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
</style>
</head>
<body>
<video id="v" autoplay playsinline controls></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js" crossorigin="anonymous"><\\/script>
<script>
(() => {
  const v = document.getElementById('v');
  const src = '${streamUrl}';

  if (!window.Hls || !Hls.isSupported()) {
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
    }
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
    v.play().catch(() => {});
  });

  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
      return;
    }
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      hls.startLoad();
      return;
    }
    hls.destroy();
  });

  hls.loadSource(src);
  hls.attachMedia(v);
})();
<\\/script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    },
  })
}

// ─── Main handler ────────────────────────────────────────────────────────────

async function handle(request: Request): Promise<Response> {
  const reqUrl = new URL(request.url)
  const ch = reqUrl.searchParams.get('ch')?.toLowerCase().replace(/[^a-z0-9-]/g, '') || ''
  const format = (reqUrl.searchParams.get('format') || '').toLowerCase()
  const wantPlay = reqUrl.searchParams.has('play')
  const proxyBase = reqUrl.origin + '/api/proxy'
  const streamBase = reqUrl.origin + '/api/slivstream'
  const accept = request.headers.get('accept') || ''

  // ── Single channel stream: ?ch=slug ────────────────────────────────────────

  if (ch) {
    const channel = CHANNELS.find(c => c.slug === ch)
    if (!channel) {
      return new Response(
        `# 404: Channel '${ch}' not found.\n# Valid: ${CHANNELS.map(c => c.slug).join(', ')}`,
        { status: 404, headers: { ...corsHeaders(), 'Content-Type': 'text/plain' } },
      )
    }

    // Browser navigation → player page
    if (wantPlay || (accept.includes('text/html') && !accept.includes('mpegurl'))) {
      // Point hls.js at the raw M3U8 endpoint (not play mode)
      const m3u8Url = `${streamBase}?ch=${ch}&raw=1`
      return playerPage(channel.name, m3u8Url)
    }

    // Get fresh Sony cookie
    const ck = await getCookie()
    if (!ck) {
      return new Response('# ERROR: Cannot get Sony session. Retrying...', {
        status: 502,
        headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
      })
    }

    // Try to fetch master playlist directly from edge
    const master = await fetchMasterPlaylist(channel.url, ck.query)

    let responseBody: string
    if (master) {
      // Got the real master — rewrite all URLs through /api/proxy
      responseBody = rewriteM3u8(master.body, master.effectiveUrl, proxyBase, ck.query)
    } else {
      // Edge fetch failed (geo-block) — build synthetic playlist
      // This makes /api/proxy fetch the master + sub-playlists + segments
      // using the Indian proxy pool
      responseBody = buildSyntheticMaster(channel.url, ck.query, proxyBase)
    }

    return new Response(responseBody, {
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'X-Sliv-Cookie': ck.expiry > 0 ? 'valid' : 'expired',
        'X-Sliv-Source': master ? 'direct' : 'proxy',
      },
    })
  }

  // ── JSON format ────────────────────────────────────────────────────────────

  if (format === 'json') {
    const channels = CHANNELS.map(c => ({
      ...c,
      stream: `${streamBase}?ch=${c.slug}&raw=1`,
      player: `${streamBase}?ch=${c.slug}&play`,
      proxy: `${proxyBase}?u=${encodeURIComponent(c.url)}&ref=${encodeURIComponent(SONY_REFERER)}`,
    }))
    return Response.json(
      { count: channels.length, channels },
      { headers: { ...corsHeaders(), 'Cache-Control': 'no-cache' } },
    )
  }

  // ── Default: M3U playlist ──────────────────────────────────────────────────

  const body =
    '#EXTM3U x-tvg-url="" \n# SonyLiv Stream Proxy — ' + new Date().toISOString() + '\n\n' +
    CHANNELS.map(c => {
      const attrs =
        ` tvg-name="${c.name}"` +
        (c.logo ? ` tvg-logo="${c.logo}"` : '') +
        ` group-title="${c.group}"`
      return `#EXTINF:-1${attrs},${c.name}\n${streamBase}?ch=${c.slug}&raw=1`
    }).join('\n') +
    '\n'

  return new Response(body, {
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Disposition': 'inline; filename="sonyliv.m3u"',
    },
  })
}

// ─── TanStack route binding ──────────────────────────────────────────────────

export const Route = createFileRoute('/api/slivstream')({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
    },
  },
})
