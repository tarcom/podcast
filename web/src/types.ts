export type Podcast = {
  id: number
  title: string
  image?: string
  author?: string
  language?: string
  feedUrl?: string
  url?: string
  description?: string
  categories?: string[]
}

// A cached episode joined with this device's played/position state.
export type EpisodeRow = {
  feedId: number
  episodeId: number
  title: string
  description?: string
  publishedAt: number // unix seconds
  audioUrl?: string // empty/undefined => not playable in-app (link out)
  linkUrl?: string // provider page for link-out (DR / Podimo etc.)
  image?: string
  durationSec: number
  podcastTitle?: string
  podcastImage?: string
  playedAt?: string | null // non-null => heard (greyed)
  positionSec: number
  updatedAt?: string | null // hvornår state sidst blev rørt => "senest lyttet" i Fortsætter
}

export type Favorite = {
  feedId: number
  title: string
  image?: string
  author?: string
  language?: string
  feedUrl?: string
  addedVia?: string
}
