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
  kind?: 'tv' // sat af backendens DR TV-søgning; alt andet er podcast
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
  kind?: 'torrent' // hentet af qBittorrent på HTPC (listTorrents) — hverken podcast eller TV
  sizeBytes?: number // kun torrents
  rawName?: string // kun torrents: navnet på disken (/5TB_DISK/Torrents/<navn>) — til "Afspil på tv'et"
  hash?: string // kun torrents: infohash'en, eller sha1('drtv:'+DR's nummer) for et DR TV-afsnit hentet som video
}

export type Favorite = {
  feedId: number
  title: string
  image?: string
  author?: string
  language?: string
  feedUrl?: string
  addedVia?: string
  priority?: number // stjerner minus én: 0 = ★, 1 = ★★, 2 = ★★★ (★★/★★★ markeres i køen)
}
