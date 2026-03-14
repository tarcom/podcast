import axios from 'axios'
import type { Episode, Podcast, ProgressItem, QueueItem } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || '/api/index.php'

const client = axios.create({
  baseURL: API_BASE,
  timeout: 20000,
})

type ApiResponse<T> = {
  status: boolean | number
  feeds?: T[]
  items?: T[]
  item?: T | null
}

type RawRecord = Record<string, unknown>

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value || 0)
}

function upgradeToHttps(url: string): string {
  return url.startsWith('http://') ? 'https://' + url.slice(7) : url
}

function normalizePodcast(feed: RawRecord): Podcast {
  return {
    id: asNumber(feed.id),
    title: asString(feed.title) || 'Ukendt podcast',
    image: upgradeToHttps(asString(feed.image) || asString(feed.artwork)),
    author: asString(feed.author) || asString(feed.ownerName),
    language: asString(feed.language),
    feedUrl: upgradeToHttps(asString(feed.url) || asString(feed.feedUrl)),
    url: asString(feed.link),
  }
}

function normalizeEpisode(raw: RawRecord): Episode {
  return {
    id: asNumber(raw.id),
    feedId: asNumber(raw.feedId),
    feedTitle: asString(raw.feedTitle),
    title: asString(raw.title) || 'Ukendt episode',
    description: asString(raw.description),
    datePublished: asNumber(raw.datePublished),
    datePublishedPretty: asString(raw.datePublishedPretty),
    enclosureUrl: upgradeToHttps(asString(raw.enclosureUrl) || asString(raw.url)),
    image: upgradeToHttps(asString(raw.image)),
    duration: asNumber(raw.duration),
  }
}

export async function discover(lang = 'da', max = 80): Promise<Podcast[]> {
  const { data } = await client.get<ApiResponse<RawRecord>>('', {
    params: { action: 'discover', lang, max },
  })

  return (data.feeds || []).map(normalizePodcast)
}

export async function search(q: string, max = 80): Promise<Podcast[]> {
  const { data } = await client.get<ApiResponse<RawRecord>>('', {
    params: { action: 'search', q, max },
  })

  return (data.feeds || []).map(normalizePodcast)
}

export async function episodesByFeed(feedId: number, max = 80): Promise<Episode[]> {
  const { data } = await client.get<ApiResponse<RawRecord>>('', {
    params: { action: 'episodes', id: feedId, max },
  })

  return (data.items || []).map(normalizeEpisode)
}

export async function listSubscriptions(deviceId: string): Promise<Podcast[]> {
  const { data } = await client.get<ApiResponse<RawRecord>>('', {
    params: { action: 'subscriptions.list', deviceId },
  })

  return (data.items || []).map((item) => ({
    id: asNumber(item.feed_id),
    title: asString(item.title),
    image: upgradeToHttps(asString(item.image)),
    author: asString(item.author),
    language: asString(item.language),
    feedUrl: upgradeToHttps(asString(item.feed_url)),
  }))
}

export async function addSubscription(deviceId: string, podcast: Podcast): Promise<void> {
  await client.post('', {
    deviceId,
    feedId: podcast.id,
    title: podcast.title,
    image: podcast.image || '',
    feedUrl: podcast.feedUrl || '',
    author: podcast.author || '',
    language: podcast.language || '',
  }, { params: { action: 'subscriptions.add' } })
}

export async function removeSubscription(deviceId: string, feedId: number): Promise<void> {
  await client.delete('', {
    params: { action: 'subscriptions.remove' },
    data: { deviceId, feedId },
  })
}

export async function listQueue(deviceId: string): Promise<QueueItem[]> {
  const { data } = await client.get<ApiResponse<RawRecord>>('', {
    params: { action: 'queue.list', deviceId },
  })

  return (data.items || []).map((item) => ({
    id: asNumber(item.id),
    episode_id: asNumber(item.episode_id),
    feed_id: asNumber(item.feed_id),
    title: asString(item.title),
    podcast_title: asString(item.podcast_title),
    audio_url: upgradeToHttps(asString(item.audio_url)),
    image: upgradeToHttps(asString(item.image)),
    published_at: asString(item.published_at),
    duration_sec: asNumber(item.duration_sec),
    sort_order: asNumber(item.sort_order),
  }))
}

export async function addQueueItem(deviceId: string, item: QueueItem): Promise<void> {
  await client.post('', {
    deviceId,
    episodeId: item.episode_id,
    feedId: item.feed_id,
    title: item.title,
    podcastTitle: item.podcast_title || '',
    audioUrl: item.audio_url,
    image: item.image || '',
    publishedAt: item.published_at || '',
    durationSec: item.duration_sec || 0,
  }, { params: { action: 'queue.add' } })
}

export async function removeQueueItem(deviceId: string, episodeId: number): Promise<void> {
  await client.delete('', {
    params: { action: 'queue.remove' },
    data: { deviceId, episodeId },
  })
}

export async function getProgress(deviceId: string): Promise<ProgressItem | null> {
  const { data } = await client.get<ApiResponse<RawRecord>>('', {
    params: { action: 'progress.get', deviceId },
  })

  const item = data.item
  if (!item) {
    return null
  }

  return {
    episode_id: asNumber(item.episode_id),
    feed_id: asNumber(item.feed_id),
    title: asString(item.title),
    audio_url: upgradeToHttps(asString(item.audio_url)),
    position_sec: asNumber(item.position_sec),
    duration_sec: asNumber(item.duration_sec),
  }
}

export async function setProgress(
  deviceId: string,
  payload: {
    episodeId: number
    feedId: number
    title: string
    audioUrl: string
    positionSec: number
    durationSec: number
  },
): Promise<void> {
  await client.post(
    '',
    {
      deviceId,
      ...payload,
    },
    { params: { action: 'progress.set' } },
  )
}
