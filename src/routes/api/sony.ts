/**
 * /api/sony — live SonyLiv channel directory with fresh tokens.
 *
 * Fetches the upstream SonyLiv playlist on every request (short cache),
 * rewrites every stream URL through /api/proxy, and returns either
 * JSON (?format=json, default) or a ready-to-play M3U (?format=m3u).
 *
 * Query params:
 *   format=json|m3u   output format (default json)
 *   q=<text>          filter channels by name (case-insensitive)
 */
import { createFileRoute } from '@tanstack/react-router'

const PLAYLIST_SOURCES = [
  'https://raw.githubusercontent.com/srhady/SonyLiv/refs/heads/main/sonyliv_playlist.m3u',
  'https://raw.githubusercontent.com/srhady/SonyLiv/main/sonyliv_playlist.m3u',
]

const CACHE_TTL_MS = 5 * 60_000
let cache: { at: number; channels: Channel[] } | null = null

interface Channel {
  name: string
  logo: string
  group: string
  url: string
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
}

function parsePlaylist(text: string): Channel[] {
  const channels: Channel[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('#EXTINF')) continue
    const name = line.split(',').pop()?.trim() || 'Unknown'
    const logo = /tvg-logo="([^"]*)"/.exec(line)?.[1] ?? ''
    const group = /group-title="([^"]*)"/.exec(line)?.[1] ?? ''
    // URL may be on the next non-empty, non-# line
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j].trim()
      if (!u) continue
      if (u.startsWith('#')) continue
      if (/^https?:\/\//.test(u)) channels.push({ name, logo, group, url: u })
      break
    }
  }
  return channels
}

async function getChannels(): Promise<Channel[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS && cache.channels.length) {
    return cache.channels
  }
  for (const src of PLAYLIST_SOURCES) {
    try {
      const r = await fetch(src, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      if (!r.ok) continue
      const channels = parsePlaylist(await r.text())
      if (channels.length) {
        cache = { at: Date.now(), channels }
        return channels
      }
    } catch { /* try next source */ }
  }
  return cache?.channels ?? []
}

async function handle(request: Request): Promise<Response> {
  const reqUrl = new URL(request.url)
  const format = (reqUrl.searchParams.get('format') || 'json').toLowerCase()
  const q = (reqUrl.searchParams.get('q') || '').toLowerCase()
  const proxyBase = reqUrl.origin + '/api/proxy'

  let channels = await getChannels()
  if (q) channels = channels.filter(c => c.name.toLowerCase().includes(q))

  const proxied = channels.map(c => ({
    ...c,
    url: proxyBase + '?u=' + encodeURIComponent(c.url),
  }))

  if (format === 'm3u') {
    const body =
      '#EXTM3U\n' +
      proxied
        .map(c => {
          const attrs =
            (c.logo ? ` tvg-logo="${c.logo}"` : '') +
            (c.group ? ` group-title="${c.group}"` : '')
          return `#EXTINF:-1${attrs},${c.name}\n${c.url}`
        })
        .join('\n') +
      '\n'
    return new Response(body, {
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    })
  }

  return Response.json(
    {
      count: proxied.length,
      fetchedAt: new Date().toISOString(),
      channels: proxied,
    },
    { headers: { ...corsHeaders(), 'Cache-Control': 'no-cache' } },
  )
}

export const Route = createFileRoute('/api/sony')({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
    },
  },
})
