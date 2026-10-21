/**
 * /slivstream/$ — Clean URL handler for SonyLiv streams
 *
 * Matches: /slivstream/set-hd.m3u8, /slivstream/sonymaxsd.m3u8, etc.
 * Redirects to /api/proxy with the authed CDN URL from premiumplugx.
 */
import { createFileRoute } from '@tanstack/react-router'

const UPSTREAM_URL = 'https://premiumplugx.com/Sliv/sony_playlist.php?m3u'
const CACHE_TTL_MS = 4 * 60_000
const SONY_REFERER = 'https://www.sonyliv.com/'

interface SlivChannel {
  slug: string
  name: string
  url: string
}

let channelCache: { at: number; channels: SlivChannel[] } | null = null

// Slug aliases — map common names to channel CDN path keywords
const SLUG_ALIASES: Record<string, string[]> = {
  'set-hd':    ['sethd', 'set-hd', 'sonyhd', 'sony-hd'],
  'sab-hd':    ['sabhd', 'sab-hd', 'sonysabhd', 'sony-sab-hd'],
  'marathi':   ['sonymarathi', 'sony-marathi', 'marathi'],
  'aath':      ['sonyaathsd', 'sonyaath', 'sony-aath', 'aath'],
  'pal':       ['sonypalsd', 'sonypal', 'sony-pal', 'pal'],
  'max-hd':    ['sonymaxhd', 'sonymaxhd', 'sony-max-hd', 'max-hd', 'maxhd'],
  'max':       ['sonymaxsd', 'sonymax', 'sony-max', 'max'],
  'wah':       ['sonywah', 'sony-wah', 'wah'],
  'max2':      ['max2', 'sonymax2', 'sony-max-2', 'sony-max2'],
  'pix-hd':    ['pixhd', 'pix-hd', 'sonypixhd', 'sony-pix-hd'],
  'yay':       ['sonyyaysd', 'sonyyay', 'sony-yay', 'yay'],
  'ten1-hd':   ['ten1hd', 'ten1-hd', 'sonyten1hd', 'sony-ten-1-hd'],
  'ten1':      ['ten1sd', 'ten1', 'sonyten1', 'sony-ten-1'],
  'ten2-hd':   ['ten2hd', 'ten2-hd', 'sonyten2hd', 'sony-ten-2-hd'],
  'ten2':      ['ten2sd', 'ten2', 'sonyten2', 'sony-ten-2'],
  'ten3-hd':   ['ten3hd', 'ten3-hd', 'sonyten3hd', 'sony-ten-3-hd'],
  'ten3':      ['ten3sd', 'ten3', 'sonyten3', 'sony-ten-3'],
  'ten4-hd':   ['ten4hd', 'ten4-hd', 'sonyten4hd', 'sony-ten-4-hd'],
  'ten4':      ['ten4sd', 'ten4', 'sonyten4', 'sony-ten-4'],
  'ten5-hd':   ['ten5hd', 'ten5-hd', 'sonysixhd', 'sony-six-hd', 'sony-ten-5-hd'],
  'ten5':      ['ten5sd', 'ten5', 'sonysixsd', 'sony-six', 'sony-ten-5'],
  'bbc-earth': ['sonybbcearthhd', 'bbc-earth', 'bbcearth', 'sony-bbc-earth'],
}

function parseUpstreamPlaylist(text: string): SlivChannel[] {
  const channels: SlivChannel[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ''
    if (!line.startsWith('#EXTINF')) continue
    const name = line.split(',').pop()?.trim() || 'Unknown'
    const tvgId = /tvg-id="([^"]*)"/.exec(line)?.[1] ?? ''
    const slug = tvgId.replace(/\.sonyliv$/, '').toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j]?.trim() ?? ''
      if (!u || u.startsWith('#')) continue
      if (/^https?:\/\//.test(u)) channels.push({ slug, name, url: u })
      break
    }
  }
  return channels
}

async function getChannels(): Promise<SlivChannel[]> {
  if (channelCache && Date.now() - channelCache.at < CACHE_TTL_MS && channelCache.channels.length) {
    return channelCache.channels
  }
  try {
    const r = await fetch(UPSTREAM_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const channels = parseUpstreamPlaylist(await r.text())
    if (channels.length) channelCache = { at: Date.now(), channels }
    return channels
  } catch { return channelCache?.channels ?? [] }
}

function findChannel(channels: SlivChannel[], input: string): SlivChannel | undefined {
  const q = input.toLowerCase().replace(/\.m3u8$/, '').replace(/[^a-z0-9]/g, '')

  // Direct slug match
  const direct = channels.find(c => c.slug.replace(/[^a-z0-9]/g, '') === q)
  if (direct) return direct

  // Alias match
  for (const [slug, aliases] of Object.entries(SLUG_ALIASES)) {
    if (aliases.some(a => a.replace(/[^a-z0-9]/g, '') === q)) {
      return channels.find(c => c.slug === slug)
    }
  }

  // Fuzzy: check if query is contained in channel URL path
  return channels.find(c => {
    const path = new URL(c.url).pathname.toLowerCase().replace(/[^a-z0-9]/g, '')
    return path.includes(q)
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
}

async function handle(request: Request): Promise<Response> {
  const reqUrl = new URL(request.url)
  const proxyBase = reqUrl.origin + '/api/proxy'

  // Extract channel slug from path: /slivstream/something.m3u8
  const pathParts = reqUrl.pathname.split('/').filter(Boolean)
  // pathParts = ['slivstream', 'something.m3u8']
  const rawSlug = pathParts[pathParts.length - 1] || ''

  if (!rawSlug) {
    return new Response('# Missing channel. Use /slivstream/channelname.m3u8', {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
    })
  }

  const channels = await getChannels()
  if (!channels.length) {
    return new Response('# Upstream unavailable', {
      status: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
    })
  }

  const channel = findChannel(channels, rawSlug)
  if (!channel) {
    const validSlugs = channels.map(c => c.slug).join(', ')
    return new Response(
      `# 404: '${rawSlug}' not found.\n# Valid: ${validSlugs}\n# Aliases: sonymaxsd, sethd, sabhd, ten1hd, etc.`,
      { status: 404, headers: { ...corsHeaders(), 'Content-Type': 'text/plain' } },
    )
  }

  // 302 redirect to /api/proxy — proxy handles HLS rewriting + browser player
  const proxiedUrl = `${proxyBase}?u=${encodeURIComponent(channel.url)}&ref=${encodeURIComponent(SONY_REFERER)}`

  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(),
      'Location': proxiedUrl,
      'Cache-Control': 'no-store',
      'X-Sliv-Channel': channel.name,
    },
  })
}

export const Route = createFileRoute('/slivstream/$')({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
    },
  },
})
