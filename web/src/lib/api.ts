import axios from 'axios'
import type { EpisodeRow, Favorite, Podcast } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || '/podcast/api/index.php'
const client = axios.create({ baseURL: API_BASE, timeout: 30000 })

type RawRecord = Record<string, unknown>
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v || 0))
const https = (url: string): string => (url.startsWith('http://') ? 'https://' + url.slice(7) : url)

function normalizePodcast(feed: RawRecord): Podcast {
  const cats = feed.categories && typeof feed.categories === 'object'
    ? Object.values(feed.categories as Record<string, string>).map(String)
    : undefined
  return {
    id: n(feed.id),
    title: s(feed.title) || 'Ukendt podcast',
    image: https(s(feed.image) || s(feed.artwork)),
    author: s(feed.author) || s(feed.ownerName),
    language: s(feed.language),
    feedUrl: https(s(feed.url) || s(feed.feedUrl)),
    url: s(feed.link),
    description: s(feed.description),
    categories: cats,
  }
}

function normalizeEpisodeRow(r: RawRecord): EpisodeRow {
  return {
    feedId: n(r.feed_id),
    episodeId: n(r.episode_id),
    title: s(r.title) || 'Ukendt episode',
    description: s(r.description),
    publishedAt: n(r.published_at),
    audioUrl: r.audio_url ? https(s(r.audio_url)) : undefined,
    linkUrl: r.link_url ? https(s(r.link_url)) : undefined,
    image: https(s(r.image)),
    durationSec: n(r.duration_sec),
    podcastTitle: s(r.podcast_title),
    podcastImage: https(s(r.podcast_image)),
    playedAt: (r.played_at as string | null) ?? null,
    positionSec: n(r.position_sec),
  }
}

// --- Discovery ---
export async function discover(lang = 'da', max = 80): Promise<Podcast[]> {
  const { data } = await client.get('', { params: { action: 'discover', lang, max } })
  return (data.feeds || []).map(normalizePodcast)
}

export async function search(q: string, max = 80): Promise<Podcast[]> {
  const { data } = await client.get('', { params: { action: 'search', q, max } })
  return (data.feeds || []).map(normalizePodcast)
}

export async function resolveUrl(url: string): Promise<Podcast | null> {
  const { data } = await client.get('', { params: { action: 'resolveUrl', url } })
  if (data.feed) return normalizePodcast(data.feed)
  return null
}

// Tilføj et Podimo-show via dets show-URL. Afsnit hentes af HTPC-scraperen bagefter.
export async function addPodimoShow(deviceId: string, url: string): Promise<string | null> {
  const { data } = await client.post('', { deviceId, url }, { params: { action: 'podimo.add' } })
  return data && data.status ? (data.title as string) : null
}

export async function getPodcast(feedId: number): Promise<Podcast | null> {
  const { data } = await client.get('', { params: { action: 'podcast', id: feedId } })
  if (data.feed) return normalizePodcast(data.feed)
  return null
}

// --- Favorites ---
export async function listFavorites(deviceId: string): Promise<Favorite[]> {
  const { data } = await client.get('', { params: { action: 'favorites.list', deviceId } })
  return (data.items || []).map((it: RawRecord) => ({
    feedId: n(it.feed_id),
    title: s(it.title),
    image: https(s(it.image)),
    author: s(it.author),
    language: s(it.language),
    feedUrl: https(s(it.feed_url)),
    addedVia: s(it.added_via),
  }))
}

export async function addFavorite(deviceId: string, p: Podcast, addedVia = 'search'): Promise<void> {
  await client.post(
    '',
    {
      deviceId,
      feedId: p.id,
      title: p.title,
      image: p.image || '',
      author: p.author || '',
      language: p.language || '',
      feedUrl: p.feedUrl || '',
      addedVia,
    },
    { params: { action: 'favorites.add' } },
  )
}

export async function removeFavorite(deviceId: string, feedId: number): Promise<void> {
  await client.delete('', { params: { action: 'favorites.remove' }, data: { deviceId, feedId } })
}

// --- Episodes ---
export async function newestEpisodes(deviceId: string): Promise<EpisodeRow[]> {
  const { data } = await client.get('', { params: { action: 'episodes.newest', deviceId } })
  return (data.items || []).map(normalizeEpisodeRow)
}

export async function feedEpisodes(deviceId: string, feedId: number): Promise<EpisodeRow[]> {
  const { data } = await client.get('', { params: { action: 'episodes.feed', deviceId, id: feedId } })
  return (data.items || []).map(normalizeEpisodeRow)
}

// --- Played / position state ---
export async function setState(
  deviceId: string,
  payload: { episodeId: number; feedId: number; played?: boolean; positionSec?: number; durationSec?: number },
): Promise<void> {
  await client.post('', { deviceId, ...payload }, { params: { action: 'state.set' } })
}

// Bulk: markér mange afsnit hørt/uhørt på én gang (til "ryd alt herunder").
export async function setStateMany(
  deviceId: string,
  episodes: { episodeId: number; feedId: number }[],
  played: boolean,
): Promise<void> {
  if (!episodes.length) return
  await client.post('', { deviceId, episodes, played }, { params: { action: 'state.setMany' } })
}
