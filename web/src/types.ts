export type Podcast = {
  id: number
  title: string
  image?: string
  author?: string
  language?: string
  feedUrl?: string
  url?: string
}

export type Episode = {
  id: number
  feedId: number
  feedTitle?: string
  title: string
  description?: string
  datePublished?: number
  datePublishedPretty?: string
  enclosureUrl?: string
  image?: string
  duration?: number
}

export type QueueItem = {
  id?: number
  episode_id: number
  feed_id: number
  title: string
  podcast_title?: string
  audio_url: string
  image?: string
  published_at?: string
  duration_sec?: number
  sort_order?: number
}

export type ProgressItem = {
  episode_id: number
  feed_id: number
  title: string
  audio_url: string
  position_sec: number
  duration_sec: number
}
