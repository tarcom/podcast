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
    priority: n(it.priority),
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

// Stjerner: priority 0-2 = ★ til ★★★. Egen action frem for et felt på favorites.add, så
// markeringen ikke kan nulstilles af en almindelig gen-tilføjelse af podcasten.
export async function setFavoritePriority(deviceId: string, feedId: number, priority: number): Promise<void> {
  await apiPost({ deviceId, feedId, priority }, { action: 'favorites.setPriority' })
}

// --- Torrents fra HTPC (bag PIN-kode; se api/torrents.php) ---
// Samme tal som TORRENT_FEED_ID i api/torrents.php. Torrents er ikke et rigtigt feed: de ligger
// i deres egen tabel, kommer kun med et gyldigt token, og flettes ind i køen her i appen.
export const TORRENT_FEED_ID = -1

export class TorrentLocked extends Error {}

// "Nybyggerne.S11E01.DANiSH.1080p.WEB.H264-EGEN" → "Nybyggerne S11E01 DANiSH 1080p WEB H264-EGEN".
// Et punktum bliver kun stående i korte tal som DDP5.1 og v1.16 — ikke i "2026.1080p".
// Serveren gemmer det rå navn.
export function torrentTitle(name: string): string {
  return name
    .replace(/\.(mkv|mp4|avi)$/i, '')
    .replace(/[._]/g, (m, i: number, str: string) =>
      m === '.' && /\d/.test(str[i - 1] || '') && /^\d{1,3}(?!\d)/.test(str.slice(i + 1)) ? '.' : ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
}

// Bytter PIN-koden til et token, der gemmes på enheden. Kaster med serverens egen besked
// ("Forkert kode", "For mange forkerte forsøg …").
export async function unlockTorrents(pin: string): Promise<string> {
  try {
    const { data } = await apiPost({ pin }, { action: 'torrent.unlock' })
    return s(data.token)
  } catch (e) {
    const msg = axios.isAxiosError(e) ? s(e.response?.data?.error) : ''
    throw new Error(msg || 'Kunne ikke nå serveren')
  }
}

// De 50 nyeste færdige torrents med hørt/set-tilstand, og hvor mange stjerner Torrent har
// (1-3, gemt som priority 0-2 ligesom favoritterne). 401 (token skiftet) → TorrentLocked.
export async function listTorrents(deviceId: string, token: string): Promise<{ items: EpisodeRow[]; stars: number }> {
  try {
    const { data } = await limited(() =>
      client.get('', { params: { action: 'torrents.list', deviceId }, headers: { 'X-Torrent-Token': token } }),
    )
    const stars = 1 + Math.min(2, Math.max(0, n(data.priority)))
    const items = (data.items || []).map((r: RawRecord) => ({
      feedId: TORRENT_FEED_ID,
      episodeId: n(r.episode_id),
      title: torrentTitle(s(r.name)),
      publishedAt: n(r.completed_at),
      durationSec: 0,
      playedAt: (r.played_at as string | null) ?? null,
      positionSec: 0,
      kind: 'torrent' as const,
      sizeBytes: n(r.size_bytes),
    }))
    return { items, stars }
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.status === 401) throw new TorrentLocked()
    throw e
  }
}

// Torrents' stjerner (1-3). Bag samme token som listen, så heller ikke dét kan ses udefra.
export async function saveTorrentStars(deviceId: string, token: string, stars: number): Promise<void> {
  try {
    await limited(() =>
      client.post('', { deviceId, priority: stars - 1 }, { params: { action: 'torrent.setPriority' }, headers: { 'X-Torrent-Token': token } }),
    )
  } catch (e) {
    if (axios.isAxiosError(e) && e.response?.status === 401) throw new TorrentLocked()
    throw e
  }
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

// Bulk: markér mange afsnit hørt/uhørt på én gang. Frontenden bruger den ikke lige nu —
// "✓ ryd herunder" er fjernet 2026-08-23 — men endpointet står ved lige på serveren.
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
