import axios from 'axios'
import type { EpisodeRow, Favorite, Podcast } from '../types'

const API_BASE = import.meta.env.VITE_API_BASE || '/podcast/api/index.php'
const client = axios.create({ baseURL: API_BASE, timeout: 30000 })

// ---------------------------------------------------------------------------------------------
// VIGTIG one.com-grænse (målt 2026-08-10 i browseren mod den live side):
//   1 samtidig forespørgsel → 13 ms · 2 samtidige → 17 ms · 3 samtidige → ÉN af dem tager 1030 ms
//   · 4 samtidige → TO af dem tager ~1015 ms.
// Hosten serverer altså kun 2 PHP-kald ad gangen pr. klient og parkerer resten i **præcis ét
// sekund**. Det ramte hver eneste sideindlæsning (start fyrede favorites+kø+charts+discover af
// på én gang), og det var i praksis det sekund hvor køen manglede indhold. Bemærk at det IKKE
// kan ses med curl fra kommandolinjen — der får hver forespørgsel sin egen forbindelse.
// Derfor holder vi selv loftet på 2; så venter et kald højst på et andet der tager ~15 ms.
const MAX_INFLIGHT = 2
let inflight = 0
const waiting: (() => void)[] = []

async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>((resolve) => waiting.push(resolve))
  inflight++
  try {
    return await run()
  } finally {
    inflight--
    waiting.shift()?.()
  }
}

// Fuld URL til ét endpoint — bruges af sendBeacon i offline.ts, som ikke kan gå gennem axios.
export const apiUrl = (action: string) => `${API_BASE}?action=${encodeURIComponent(action)}`

type Params = Record<string, unknown>
const apiGet = (params: Params) => limited(() => client.get('', { params }))
const apiPost = (body: unknown, params: Params) => limited(() => client.post('', body, { params }))
const apiDelete = (params: Params, data: unknown) => limited(() => client.delete('', { params, data }))

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
    kind: feed.kind === 'tv' ? 'tv' : undefined,
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
    updatedAt: (r.updated_at as string | null) ?? null,
  }
}

// --- Discovery ---
export async function discover(lang = 'da', max = 80): Promise<Podcast[]> {
  const { data } = await apiGet({ action: 'discover', lang, max })
  return (data.feeds || []).map(normalizePodcast)
}

export async function search(q: string, max = 80): Promise<Podcast[]> {
  const { data } = await apiGet({ action: 'search', q, max })
  return (data.feeds || []).map(normalizePodcast)
}

export async function resolveUrl(url: string): Promise<Podcast | null> {
  const { data } = await apiGet({ action: 'resolveUrl', url })
  if (data.feed) return normalizePodcast(data.feed)
  return null
}

// Tilføj et Podimo-show via dets show-URL. Afsnit hentes af HTPC-scraperen bagefter.
export async function addPodimoShow(deviceId: string, url: string): Promise<string | null> {
  const { data } = await apiPost({ deviceId, url }, { action: 'podimo.add' })
  return data && data.status ? (data.title as string) : null
}

export async function getPodcast(feedId: number): Promise<Podcast | null> {
  const { data } = await apiGet({ action: 'podcast', id: feedId })
  if (data.feed) return normalizePodcast(data.feed)
  return null
}

// --- Favorites ---
export async function listFavorites(deviceId: string): Promise<Favorite[]> {
  const { data } = await apiGet({ action: 'favorites.list', deviceId })
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
  await apiPost({
      deviceId,
      feedId: p.id,
      title: p.title,
      image: p.image || '',
      author: p.author || '',
      language: p.language || '',
      feedUrl: p.feedUrl || '',
      addedVia,
    },
    { action: 'favorites.add' },
  )
}

export async function removeFavorite(deviceId: string, feedId: number): Promise<void> {
  await apiDelete({ action: 'favorites.remove' }, { deviceId, feedId })
}

// --- Episodes ---
// Køen fra cachen. Rører ikke nettet på serveren → svarer på ~80 ms.
// NB: hørte afsnit kommer med i køen (de beholder deres plads i listen), men UDEN
// `description` — den fylder ~halvdelen af payloaden. Hent den ved behov med episodeDescription().
export async function newestEpisodes(deviceId: string): Promise<EpisodeRow[]> {
  const { data } = await apiGet({ action: 'episodes.newest', deviceId })
  return (data.items || []).map(normalizeEpisodeRow)
}

// Beskrivelsen for ét afsnit — bruges af "læs mere" når køen ikke sendte den med (hørte afsnit).
export async function episodeDescription(feedId: number, episodeId: number): Promise<string> {
  const { data } = await apiGet({ action: 'episode.get', feedId, id: episodeId })
  return data && data.item ? s((data.item as RawRecord).description) : ''
}

// Den langsomme del: serveren henter forældede feeds' RSS (1-3 sek.). Kaldes FØRST når køen er
// tegnet, så ventetiden ligger bag en spinner i stedet for foran hele indholdet.
// `changed` = der kom nye afsnit ind, dvs. det kan betale sig at hente køen igen.
export async function refreshFeeds(deviceId: string): Promise<{ feeds: number; inserted: number; changed: boolean }> {
  const { data } = await apiGet({ action: 'episodes.refresh', deviceId })
  return { feeds: Number(data.feeds || 0), inserted: Number(data.inserted || 0), changed: !!data.changed }
}

export async function feedEpisodes(deviceId: string, feedId: number): Promise<EpisodeRow[]> {
  const { data } = await apiGet({ action: 'episodes.feed', deviceId, id: feedId })
  return (data.items || []).map(normalizeEpisodeRow)
}

// --- Played / position state ---
export async function setState(
  deviceId: string,
  payload: { episodeId: number; feedId: number; played?: boolean; positionSec?: number; durationSec?: number },
): Promise<void> {
  await apiPost({ deviceId, ...payload }, { action: 'state.set' })
}

// Bulk: markér mange afsnit hørt/uhørt på én gang (til "ryd alt herunder").
export async function setStateMany(
  deviceId: string,
  episodes: { episodeId: number; feedId: number }[],
  played: boolean,
): Promise<void> {
  if (!episodes.length) return
  await apiPost({ deviceId, episodes, played }, { action: 'state.setMany' })
}

// --- Popularitet: Apples danske hitlister (top 50 podcasts + 25 trending afsnit) ---
// Ægte downloadtal er private hos udbyderne og findes ikke offentligt; Apples
// hitliste er det bedste gratis, danske signal. Serveren cacher i 6 timer.
export type ChartShow = { rank: number; name: string; artist: string; itunesId: string; artwork: string; url: string; norm: string }
export type ChartEpisode = { rank: number; name: string; artist: string; artwork: string; norm: string }

export async function getCharts(): Promise<{ shows: ChartShow[]; episodes: ChartEpisode[] }> {
  const { data } = await apiGet({ action: 'charts' })
  return { shows: data.shows || [], episodes: data.episodes || [] }
}
