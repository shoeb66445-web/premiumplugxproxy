/**
 * /api/slivstream — SonyLiv streaming via premiumplugx cookie source
 *
 * Fetches fresh playlist from premiumplugx.com/Sliv/sony_playlist.php?m3u
 * which has fresh hdnea cookies already embedded in URLs.
 * Rewrites all URLs through /api/proxy for CORS-bypass worldwide playback.
 *
 * Routes:
 *   GET /api/slivstream                → M3U playlist (all channels, proxied)
 *   GET /api/slivstream?ch=set-hd      → 302 redirect to /api/proxy with authed CDN URL
 *   GET /api/slivstream?format=json    → JSON channel list
 */
import { createFileRoute } from '@tanstack/react-router'

// ─── Upstream source ─────────────────────────────────────────────────────────

const UPSTREAM_URL = 'https://premiumplugx.com/Sliv/sony_playlist.php?m3u'
const CACHE_TTL_MS = 4 * 60_000  // refresh every 4 min
const SONY_REFERER = 'https://www.sonyliv.com/'

interface SlivChannel {
  slug: string
  name: string
  group: string
  logo: string
  url: string  // CDN URL with ?hdnea= already embedded
}

// ─── In-memory cache ─────────────────────────────────────────────────────────

let channelCache: { at: number; channels: SlivChannel[] } | null = null

// ─── Parse upstream M3U ──────────────────────────────────────────────────────

function parseUpstreamPlaylist(text: string): SlivChannel[] {
  const channels: SlivChannel[] = []
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ''
    if (!line.startsWith('#EXTINF')) continue

    // Extract name (after last comma)
    const name = line.split(',').pop()?.trim() || 'Unknown'

    // Extract tvg-id → slug (remove .sonyliv suffix)
    const tvgId = /tvg-id="([^"]*)"/.exec(line)?.[1] ?? ''
    const slug = tvgId.replace(/\.sonyliv$/, '').toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

    // Extract logo
    const logo = /tvg-logo="([^"]*)"/.exec(line)?.[1] ?? ''

    // Extract group
    const group = /group-title="([^"]*)"/.exec(line)?.[1]?.replace(/^SonyLIV\s*/i, '') ?? ''

    // Find the CDN URL (skip #EXTVLCOPT, #EXTHTTP lines)
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j]?.trim() ?? ''
      if (!u) continue
      if (u.startsWith('#')) continue
      if (/^https?:\/\//.test(u)) {
        channels.push({ slug, name, group, logo, url: u })
      }
      break
    }
  }

  return channels
}

// ─── Fetch channels from upstream ────────────────────────────────────────────

async function getChannels(): Promise<SlivChannel[]> {
  // Return cache if fresh
  if (channelCache && Date.now() - channelCache.at < CACHE_TTL_MS && channelCache.channels.length) {
    return channelCache.channels
  }

  try {
    const r = await fetch(UPSTREAM_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),  // PHP may take time to generate cookies
      cache: 'no-store',
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const text = await r.text()
    const channels = parseUpstreamPlaylist(text)
    if (channels.length) {
      channelCache = { at: Date.now(), channels }
      return channels
    }
  } catch (e) {
    console.error('[slivstream] Upstream fetch error:', (e as Error).message)
  }

  return channelCache?.channels ?? []
}

// ─── CORS headers ────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Location',
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────

async function handle(request: Request): Promise<Response> {
  const reqUrl = new URL(request.url)
  const ch = reqUrl.searchParams.get('ch')?.toLowerCase().replace(/[^a-z0-9-]/g, '') || ''
  const format = (reqUrl.searchParams.get('format') || '').toLowerCase()
  const proxyBase = reqUrl.origin + '/api/proxy'
  const streamBase = reqUrl.origin + '/api/slivstream'

  const channels = await getChannels()

  if (!channels.length) {
    return new Response('# ERROR: No channels available. Upstream may be down.', {
      status: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
    })
  }

  // ── Single channel: ?ch=slug → 302 redirect to /api/proxy ──────────────────

  if (ch) {
    const channel = channels.find(c => c.slug === ch)
    if (!channel) {
      return new Response(
        `# 404: Channel '${ch}' not found.\n# Valid: ${channels.map(c => c.slug).join(', ')}`,
        { status: 404, headers: { ...corsHeaders(), 'Content-Type': 'text/plain' } },
      )
    }

    // Redirect to /api/proxy which will:
    // 1. Fetch the master.m3u8 from slivcdn with the hdnea cookie
    // 2. Rewrite all sub-URLs through itself
    // 3. If browser → show native player; if player → return HLS
    const proxiedUrl = `${proxyBase}?u=${encodeURIComponent(channel.url)}&ref=${encodeURIComponent(SONY_REFERER)}`

    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders(),
        'Location': proxiedUrl,
        'Cache-Control': 'no-store',
      },
    })
  }

  // ── JSON format ────────────────────────────────────────────────────────────

  if (format === 'json') {
    const list = channels.map(c => ({
      slug: c.slug,
      name: c.name,
      group: c.group,
      logo: c.logo,
      stream: `${streamBase}?ch=${c.slug}`,
      proxy: `${proxyBase}?u=${encodeURIComponent(c.url)}&ref=${encodeURIComponent(SONY_REFERER)}`,
    }))
    return Response.json(
      { count: list.length, channels: list },
      { headers: { ...corsHeaders(), 'Cache-Control': 'no-cache' } },
    )
  }

  // ── Default: M3U playlist ──────────────────────────────────────────────────
  // Each channel URL goes through /api/proxy for CORS bypass + Indian proxy pool

  const body =
    '#EXTM3U\n# SonyLiv Stream Proxy — ' + new Date().toISOString() + '\n# Channels: ' + channels.length + '\n\n' +
    channels.map(c => {
      const attrs =
        ` tvg-id="${c.slug}"` +
        ` tvg-name="${c.name}"` +
        (c.logo ? ` tvg-logo="${c.logo}"` : '') +
        ` group-title="${c.group}"`
      const proxiedUrl = `${proxyBase}?u=${encodeURIComponent(c.url)}&ref=${encodeURIComponent(SONY_REFERER)}`
      return `#EXTINF:-1${attrs},${c.name}\n${proxiedUrl}`
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
