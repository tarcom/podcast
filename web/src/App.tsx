import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  addFavorite,
  addPodimoShow,
  discover,
  episodeDescription,
  feedEpisodes,
  getCharts,
  getPodcast,
  listFavorites,
  listTorrents,
  newestEpisodes,
  refreshFeeds,
  removeFavorite,
  resolveUrl,
  saveTorrentStars,
  search,
  setFavoritePriority,
  stateGet,
  TORRENT_FEED_ID,
  TorrentLocked,
  unlockTorrents,
} from './lib/api'
import { getDeviceId } from './lib/device'
import { startKeepAlive, stopKeepAlive } from './lib/keepalive'
import {
  downloadEpisode,
  downloadsSupported,
  fmtBytes,
  listDownloads,
  reconcileDownloads,
  removeAllDownloads,
  removeDownload,
  storageInfo,
  type DownloadMeta,
  type StorageInfo,
} from './lib/downloads'
import {
  beaconState,
  flushOutbox,
  outboxSize,
  readSnapshot,
  saveSnapshot,
  saveStateResilient,
  type StateWrite,
} from './lib/offline'
import { pushBack } from './lib/back'
import { aabnVideoIApp, APK_URL, appOutdated, host, inAndroidApp, kanOpdatereSelv, LATEST_APK, nativeClosePlayer } from './lib/native'
import { clearNowPlaying, readNowPlaying, saveNowPlaying } from './lib/nowplaying'
import { loadPref, savePref } from './lib/prefs'
import { logg } from './lib/logg'
import { erNativ, installerNativLyd, nativAfsnit, nativSove } from './lib/nativlyd'
import {
  jobIGang,
  tvAfspil,
  tvAfspilUrl,
  tvFind,
  tvFjern,
  tvMaal,
  tvStatus,
  TvUnreachable,
  type TvFjern,
  type TvFund,
  type TvMaal,
  type TvStatus,
  type TvVideo,
} from './lib/tv'
import { BUILD_ID, deployedBuild } from './lib/version'
import type { ChartEpisode, ChartShow } from './lib/api'
import type { EpisodeRow, Favorite, Podcast } from './types'
import { FuldSpiller, MiniSpiller } from './Spiller'
import { FjernSpiller, FjernTid, MaalVaelger } from './Fjern'
import { fmtClock } from './lib/format'
import Stuen from './Stuen'
import Lyd from './Lyd'
import {
  IkonCast,
  IkonHentet,
  IkonHoejttaler,
  IkonKoe,
  IkonOpdater,
  IkonPause,
  IkonPlay,
  IkonStjerne,
  IkonTelefon,
  IkonTv,
  IkonUdforsk,
} from './ikoner'

type Tab = 'explore' | 'favorites' | 'queue' | 'downloads' | 'stuen' | 'lyd'
type DlState = 'idle' | 'queued' | 'busy' | 'done' | 'error'
type LangMode = 'da-first' | 'da-only' | 'all'
type Reach = 'ukendt' | 'ok' | 'ude'

// En podcast sendt til tv'et i stuen eller en Google Home-højttaler (maal = højttalerens id;
// mangler den, er det tv'et — sådan så de ud før 2026-11-17). Så længe den spiller dér, gemmes
// positionen på afsnittet her (hvert 15. sek., mens app'en er fremme), så "Fortsætter" og
// telefonen følger med.
type TvSession = {
  episodeId: number
  feedId: number
  url: string
  title: string
  durationSec: number
  startedAt: number
  maal?: string
  maalNavn?: string
  image?: string
}
const STUEN: TvMaal = { id: 'stuen', navn: "Tv'et i stuen", type: 'tv' }

// DR's nummer på et DR TV-afsnit (…/drtv/episode/deadline_633509) — det samme, som
// podcast/scraper/drtv_hent.py gemmer det hentede afsnit under.
function drtvNummer(ep: EpisodeRow): string | null {
  const m = /\/drtv\/episode\/[^?#]*_(\d+)/.exec(ep.linkUrl || '')
  return m ? m[1] : null
}
async function sha1Hex(tekst: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(tekst))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const isDanish = (lang?: string) => (lang || '').toLowerCase().startsWith('da')

// Afspilningshastigheder i den rækkefølge, knappen går igennem dem. Huskes pr. enhed.
const RATES = [1, 1.2, 1.5, 1.75, 2, 0.8]
// Sove-timeren: hvert tryk tager næste trin; efter det sidste er den slået fra.
const SLEEP_STEPS = [15, 30, 45, 60, 90]

// Afsnittet fra sidste gang (eller fra før en genindlæsning), læst én gang ved opstart.
const RESTORED = readNowPlaying()

// ---------- når forbindelsen til lyden går tabt (rettet 2026-11-24) ----------
// Et <audio>, der har mistet forbindelsen til lyden, kommer ALDRIG selv i gang igen. Efter en fejl
// (ingen dækning i over ca. 30 sek., eller en CDN-adresse, der er udløbet under en lang pause;
// libsyns holder ca. 2 timer) står det stille, uanset hvor mange gange man trykker afspil. Afprøvet
// i Chrome 24/11: play() og pause + play() flyttede det ikke et sekund, en ny indlæsning af kilden
// spillede med det samme. I bilen så det ud, som om app'en var gået i stå, og kun "Luk" i
// notifikationen hjalp. Derfor hentes lyden forfra fra afsnittets egen adresse (så hentes
// omdirigeringen til CDN'et også på ny), og der fortsættes, hvor den slap: se `genindlaes`.
function lydDoed(el: HTMLAudioElement): boolean {
  return !!el.error || el.networkState === HTMLMediaElement.NETWORK_NO_SOURCE
}
// Venter lyden stadig på data, siden den gik i stå (`waiting` uden `playing` bagefter;
// `ventetFra` er tidspunktet)? Så kan forbindelsen hænge uden at give en fejl. I emulatoren skete
// det i flytilstand (24/11): ingen fejl, og nettet kom tilbage uden at lyden gjorde det.
function haenger(el: HTMLAudioElement, ventetFra: number): boolean {
  return ventetFra > 0 && el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
}
// Lydens tilstand til loggen (lib/logg.ts), kort: afsnit, position, readyState, networkState,
// fejlkode og hvor mange sekunder der er hentet foran.
function lydInfo(el: HTMLAudioElement | null, ep: EpisodeRow | null): Record<string, unknown> {
  if (!el) return { ep: ep?.episodeId }
  const d: Record<string, unknown> = { ep: ep?.episodeId, pos: Math.round(el.currentTime), rs: el.readyState, ns: el.networkState }
  if (el.error) d.err = el.error.code
  try {
    const b = el.buffered
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= el.currentTime + 0.5 && b.end(i) >= el.currentTime) {
        d.buf = Math.round(b.end(i) - el.currentTime)
        break
      }
    }
  } catch {
    /* ignore */
  }
  return d
}
const vaertAf = (url?: string) => {
  try {
    return url ? new URL(url).host : undefined
  } catch {
    return undefined
  }
}
if (RESTORED) logg('genskabt', { ep: RESTORED.ep.episodeId, pos: RESTORED.pos, titel: RESTORED.ep.title })
// Faldt lyden ud, mens man lyttede: prøv igen efter 1, 2, 4, 8, 15 og 30 sek., derefter hvert 45.,
// og med det samme, når nettet er tilbage. Tæt i starten: når dækningen kommer igen, kan nettet
// være et stykke tid om at virke (i emulatoren op mod en halv minut efter flytilstand).
const FORSOEG_MS = [1000, 2000, 4000, 8000, 15_000, 30_000, 45_000]
// Så længe prøver app'en selv, regnet fra da lyden faldt ud. Derefter står afsnittet på pause, så
// det ikke pludselig begynder at spille længe efter (man kan være steget ud af bilen).
const OPGIV_MS = 10 * 60_000
// Står lyden stille og venter på data så længe, mens den skulle spille, hentes den forfra. En
// forbindelse, der hænger efter et hul i dækningen, giver ingen fejl. Den står bare, og i
// emulatoren hang også den første nye hentning efter flytilstand (24/11).
const STAAR_STILLE_MS = 15_000
// Efter en så lang pause er forbindelsen lukket, og CDN-adressen kan være udløbet: hent forfra.
const LANG_PAUSE_MS = 30 * 60_000

function fmtDate(unix: number): string {
  if (!unix) return ''
  return new Date(unix * 1000).toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' })
}
function fmtDur(sec: number): string {
  if (!sec) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h > 0 ? `${h} t ${m} min` : `${m} min`
}
// Normalisér en titel til hitliste-matchning. SKAL matche chart_norm() i api/charts.php,
// ellers rammer vi aldrig et match (Apple skriver fx emoji og tegnsætning anderledes).
function chartNorm(sx: string): string {
  return sx
    .toLowerCase()
    .trim()
    .replace(/(?:[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]|\u{FE0F})/gu, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

// "i gang med": mere end 30 sek. inde, men ikke stort set færdig. Bruges både af
// Fortsætter-markeringen og af fremdriftsbjælken, så de aldrig kan komme ud af trit.
function isInProgress(pos: number, total: number, heard: boolean): boolean {
  return !heard && total > 0 && pos > 30 && pos < total * 0.99
}
function fmtTime(unix: number): string {
  if (!unix) return ''
  return new Date(unix * 1000).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })
}

// midnat-baseret "dagsnøgle" så vi kan gruppere afsnit pr. dag
const WEEKDAYS = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag']
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
function dayLabel(unix: number): string {
  if (!unix) return 'Uden dato'
  const d = new Date(unix * 1000)
  const today = startOfDay(new Date())
  const day = startOfDay(d)
  const diffDays = Math.round((today - day) / 86400000)
  if (diffDays <= 0) return 'I dag'
  if (diffDays === 1) return 'I går'
  if (diffDays < 7) return WEEKDAYS[d.getDay()]
  return d.toLocaleDateString('da-DK', { day: '2-digit', month: 'long', year: 'numeric' })
}

// Hvor kommer afsnittet fra (platform) — til mærkat + link-out-forklaring.
const SOURCE_NAMES: [string, string][] = [
  ['podimo', 'Podimo'], ['dr.dk', 'DR'], ['drlyd', 'DR'], ['dr-massive', 'DR'],
  ['acast', 'Acast'], ['megaphone', 'Megaphone'], ['spreaker', 'Spreaker'],
  ['libsyn', 'Libsyn'], ['buzzsprout', 'Buzzsprout'], ['simplecast', 'Simplecast'],
  ['podbean', 'Podbean'], ['spotify', 'Spotify'], ['anchor', 'Spotify'], ['omny', 'Omny'],
  ['viaplay', 'Viaplay'],
]
// TV-afsnit kendes på link-URL'en — de har aldrig lyd i appen. DR TV siden 2026-08-22,
// Viaplay/TV3 siden 2026-09-14 (Robinson Ekspeditionen sendes der, ikke på DR).
const VIAPLAY_URL = /(?:^|\/\/|\.)viaplay\.(?:dk|com)\//
function isTvEpisode(ep: EpisodeRow): boolean {
  const u = ep.linkUrl || ''
  return u.includes('/drtv/') || VIAPLAY_URL.test(u)
}
function sourceOf(ep: EpisodeRow): string {
  // Kun DR's egen: Viaplay falder igennem til SOURCE_NAMES nedenfor og bliver til "Viaplay".
  if ((ep.linkUrl || '').includes('/drtv/')) return 'DR TV'
  const u = ep.linkUrl || ep.audioUrl || ''
  try {
    const h = new URL(u).hostname.replace(/^www\./, '')
    for (const [needle, name] of SOURCE_NAMES) if (h.includes(needle)) return name
    const sld = h.split('.').slice(-2, -1)[0] || h
    return sld.charAt(0).toUpperCase() + sld.slice(1)
  } catch {
    return ''
  }
}

// En favorit tegnes med samme kort som et søgeresultat. `addedVia` bærer TV-mærkatet videre,
// så en fulgt TV-serie også er mærket i Favoritter. Feed-URL'en er fallback, fordi serier
// tilføjet før 2026-09-14 blev gemt med added_via = 'drtv' uanset udbyder.
function favoriteAsPodcast(f: Favorite): Podcast {
  return {
    id: f.feedId,
    title: f.title,
    image: f.image,
    author: f.author,
    language: f.language,
    feedUrl: f.feedUrl,
    kind:
      f.addedVia === 'drtv' ||
      f.addedVia === 'viaplay' ||
      (f.feedUrl || '').includes('/drtv/') ||
      VIAPLAY_URL.test((f.feedUrl || '') + '/')
        ? 'tv'
        : undefined,
  }
}

// Hvilken udbyder en TV-serie skal gemmes som. Selve opdateringen af afsnit hænger på
// feed-URL'en i backenden, ikke på dette felt — det er kun til mærkatet i Favoritter.
function tvVia(p: Podcast): 'drtv' | 'viaplay' {
  return VIAPLAY_URL.test((p.feedUrl || '') + '/') ? 'viaplay' : 'drtv'
}

// Kø-kategorierne. TV kendes på favoritten eller link-URL'en, torrents på `kind`; resten er podcasts.
type Category = 'podcast' | 'tv' | 'torrent'
const CATEGORIES: { key: Category; label: string; title: string }[] = [
  { key: 'podcast', label: '🎙 Podcast', title: 'podcasts' },
  { key: 'tv', label: '📺 TV', title: 'TV-programmer (DR TV og Viaplay)' },
  { key: 'torrent', label: '🧲 Torrent', title: 'torrents hentet på HTPC' }, // ikke ⬇ — det er offline-hentning
]
const isStars = (v: unknown) => Array.isArray(v) && v.every((x) => x === 1 || x === 2 || x === 3)
const isCats = (v: unknown) => Array.isArray(v) && v.every((x) => x === 'podcast' || x === 'tv' || x === 'torrent')

// Tokenet fra torrent.unlock. Gemmes for sig (ikke som øjebliksbillede), så det overlever at
// snapshots ryddes, og så det er ét sted at slette, hvis enheden skal "glemme" koden.
const TORRENT_TOKEN_KEY = 'podcast_torrent_token'
function readTorrentToken(): string {
  try {
    return localStorage.getItem(TORRENT_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}
function saveTorrentToken(token: string): void {
  try {
    if (token) localStorage.setItem(TORRENT_TOKEN_KEY, token)
    else localStorage.removeItem(TORRENT_TOKEN_KEY)
  } catch {
    /* privat vindue o.l. — så skal koden tastes igen næste gang */
  }
}

type DayGroup = { key: number; label: string; episodes: EpisodeRow[] }
function groupByDay(eps: EpisodeRow[]): DayGroup[] {
  const groups: DayGroup[] = []
  let cur: DayGroup | null = null
  for (const ep of eps) {
    const key = ep.publishedAt ? startOfDay(new Date(ep.publishedAt * 1000)) : 0
    if (!cur || cur.key !== key) {
      cur = { key, label: dayLabel(ep.publishedAt), episodes: [] }
      groups.push(cur)
    }
    cur.episodes.push(ep)
  }
  return groups
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

export default function App() {
  const deviceId = useMemo(() => getDeviceId(), [])
  const [tab, setTab] = useState<Tab>('queue')
  // Kø-filter: stjerner (★/★★/★★★) og kategorier (🎙 Podcast/📺 TV/🧲 Torrent). Inden for hver
  // gruppe kan flere være tændt på én gang. HUSKES PR. ENHED (fra 2026-11-16, Allans ønske):
  // telefonen står typisk på ★★ + ★★★ + Podcast, pc'en på noget andet. At en kø åbner filtreret,
  // ses på de tændte mærkater øverst og på "Viser N af M".
  const [starFilter, setStarFilter] = useState<number[]>(() => loadPref<number[]>('starFilter', [], isStars))
  const [catFilter, setCatFilter] = useState<Category[]>(() =>
    loadPref<Category[]>('catFilter', [], isCats).filter((c) => c !== 'torrent' || !!readTorrentToken()),
  )
  useEffect(() => savePref('starFilter', starFilter), [starFilter])
  useEffect(() => savePref('catFilter', catFilter), [catFilter])

  // Torrents fra HTPC: kun på enheder hvor PIN-koden er tastet (tokenet gemmes her og sendes
  // som header). Uden token hentes de slet ikke — se api/torrents.php.
  const [torrentToken, setTorrentToken] = useState(readTorrentToken)
  const torrentTokenRef = useRef(torrentToken)
  const [torrents, setTorrents] = useState<EpisodeRow[]>(() =>
    (torrentToken && readSnapshot<EpisodeRow[]>('torrents')) || [],
  )
  // Torrent har stjerner som en podcast (1-3, gemt på serveren bag samme token), men er et fast
  // kort i Favoritter uden Slet — den kan ikke fjernes, kun skjules med filteret i køen.
  const [torrentStars, setTorrentStars] = useState(() => readSnapshot<number>('torrentStars') || 1)
  const [pinOpen, setPinOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [pinErr, setPinErr] = useState('')
  const [pinBusy, setPinBusy] = useState(false)

  // data — startværdien er sidste øjebliksbillede, så app'en har indhold med det samme og
  // også kan åbnes helt uden dækning. Netværkssvaret overskriver det når det kommer.
  const [favorites, setFavorites] = useState<Favorite[]>(() => readSnapshot<Favorite[]>('favorites') || [])
  // Stjerner pr. fulgt podcast: 1-3, gemt som priority 0-2 (de gamle superfavoritter har
  // priority 1 og er altså ★★). Podcasts med 2-3 stjerner må ikke drukne i køen: de flytter sig
  // IKKE i listen — kronologien er hele pointen med køen — men markeres på selve rækken.
  const starsById = useMemo(
    () => new Map(favorites.map((f) => [f.feedId, 1 + Math.min(2, Math.max(0, f.priority || 0))])),
    [favorites],
  )
  // 0 = ikke fulgt, ellers 1-3 stjerner.
  const starLevel = useCallback((feedId: number) => starsById.get(feedId) || 0, [starsById])
  // favorites.add der stadig er undervejs, pr. feed — se setStars.
  const pendingAdds = useRef(new Map<number, Promise<void>>())
  // Fulgte TV-serier (DR TV/Viaplay) — til 📺 TV-filteret i køen.
  const tvIds = useMemo(
    () => new Set(favorites.filter((f) => favoriteAsPodcast(f).kind === 'tv').map((f) => f.feedId)),
    [favorites],
  )
  const [queue, setQueue] = useState<EpisodeRow[]>(() => readSnapshot<EpisodeRow[]>('queue') || [])
  const [loadingQueue, setLoadingQueue] = useState(false)
  // Har vi hentet køen mindst én gang? Uden det viste vi "Alt er hørt 🎉" i det sekund hvor
  // favoritterne var kommet hjem, men afsnittene ikke var — en tom kø betyder ikke "hørt".
  const [queueLoaded, setQueueLoaded] = useState(() => !!readSnapshot<EpisodeRow[]>('queue'))
  // Serveren henter forældede feeds' RSS i baggrunden; det er dét spinneren over listen viser.
  const [checkingFeeds, setCheckingFeeds] = useState(false)
  // Hvornår køen sidst kom hjem fra serveren (ms) — vises som "Opdateret kl. …".
  const [lastRefresh, setLastRefresh] = useState(0)

  // explore
  const [query, setQuery] = useState('')
  // Hvad `results` er et svar PÅ: '' = Udforsk-listen (discover), ellers søgeordet. Styrer
  // rækkefølgen i Udforsk: har man søgt, skal træfferne stå ØVERST — top-50-listen skubbede dem
  // før langt ned på siden, så man ikke kunne se hvad man havde søgt efter.
  const [searchedFor, setSearchedFor] = useState('')
  const [langMode, setLangMode] = useState<LangMode>('da-first')
  const [results, setResults] = useState<Podcast[]>([])
  const [exploreBusy, setExploreBusy] = useState(false)
  const [exploreErr, setExploreErr] = useState('')
  const [urlInput, setUrlInput] = useState('')

  // podcast detail (episodes of one podcast)
  const [openPodcast, setOpenPodcast] = useState<Podcast | Favorite | null>(null)
  const [openPodcastInfo, setOpenPodcastInfo] = useState<Podcast | null>(null) // fuld info (beskrivelse)
  const [detailEpisodes, setDetailEpisodes] = useState<EpisodeRow[]>([])
  const [detailBusy, setDetailBusy] = useState(false)

  // episode detail ("læs mere")
  const [openEpisode, setOpenEpisode] = useState<EpisodeRow | null>(null)
  const [descBusy, setDescBusy] = useState(false) // henter beskrivelsen (hørte afsnit får den ikke med i køen)

  // popularitet (Apples danske hitlister)
  const [chartShows, setChartShows] = useState<ChartShow[]>([])
  const [chartEpisodes, setChartEpisodes] = useState<ChartEpisode[]>([])

  // offline / downloads
  const canDownload = useMemo(() => downloadsSupported(), [])
  const [downloads, setDownloads] = useState<DownloadMeta[]>(listDownloads)
  const dlIds = useMemo(() => new Set(downloads.map((d) => d.ep.episodeId)), [downloads])
  const [dlState, setDlState] = useState<Record<number, DlState>>({})
  const [dlError, setDlError] = useState('')
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null)
  const bulkRef = useRef(false)
  const cancelBulk = useRef(false)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [pending, setPending] = useState(0) // lytning der venter på at blive sendt til serveren

  // ny udgave af siden (version.json) og korte beskeder nederst
  const [newVersion, setNewVersion] = useState(false)
  const newVersionRef = useRef(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef(0)
  const showToast = useCallback((msg: string) => {
    window.clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = window.setTimeout(() => setToast(''), 4000)
  }, [])

  // player — afsnittet fra sidste gang står klar på pause (lib/nowplaying.ts)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // I Android-app'en (fra 3.3) spiller app'en selv lyden, og <audio> bliver en fjernbetjening af
  // den (lib/nativlyd.ts). Resten af afspilleren her er den samme i app'en og i en browser.
  const audioRefCb = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el
    if (el) installerNativLyd(el)
  }, [])
  const [current, setCurrent] = useState<EpisodeRow | null>(() =>
    RESTORED ? { ...RESTORED.ep, positionSec: RESTORED.pos } : null,
  )
  const currentRef = useRef<EpisodeRow | null>(current)
  const [playing, setPlaying] = useState(false)
  const [playErrorId, setPlayErrorId] = useState(0) // afsnit hvis lyd ikke kunne afspilles
  const [curTime, setCurTime] = useState(() => RESTORED?.pos || 0) // sekunder afspillet (til progress bar)
  const [dur, setDur] = useState(() => RESTORED?.dur || RESTORED?.ep.durationSec || 0) // total varighed i sekunder
  const [seeking, setSeeking] = useState(false) // brugeren trækker i slideren
  const [sheetOpen, setSheetOpen] = useState(false) // afspilleren i fuld størrelse
  const [rate, setRate] = useState(() => loadPref<number>('rate', 1, (v) => typeof v === 'number' && v >= 0.5 && v <= 3))
  const rateRef = useRef(rate)
  const [sleepUntil, setSleepUntil] = useState<number | null>(null) // sove-timer (ms), null = fra
  const [sleepLeft, setSleepLeft] = useState(0) // hele minutter tilbage, til visningen
  const lastSaved = useRef(0)
  // Hvornår DENNE enhed sidst skrev positionen på det aktuelle afsnit (ms). Er serverens
  // updated_at nyere, har en anden enhed eller tv'et lyttet videre — så fortsætter vi dér.
  const localAt = useRef(RESTORED?.at || 0)
  const lastSync = useRef(0)
  const wantPlay = useRef(false) // brugeren har bedt om lyd (en fejl før det er ikke værd at vise)
  const closing = useRef(false)
  // Når forbindelsen til lyden går tabt (se lydDoed øverst i filen):
  const lydVirkede = useRef(0) // afsnittet, hvis lyd har spillet (eller er indlæst) i denne omgang: så er en senere fejl forbindelsen, ikke afsnittet
  const sidstePos = useRef(0) // sidste sted, lyden nåede (sek.)
  const pauseFra = useRef(0) // Date.now(), da der sidst blev pauset (0 = ikke på pause)
  const fejlFra = useRef(0) // Date.now(), da lyden faldt ud (0 = den er ikke faldet ud)
  const ventetFra = useRef(0) // Date.now(), da lyden begyndte at vente på data (0 = den venter ikke). En forbindelse kan hænge uden fejl.
  const forsoeg = useRef(0) // forsøg i træk, siden lyden faldt ud
  const forsoegTimer = useRef(0)

  useEffect(() => {
    currentRef.current = current
  }, [current])
  useEffect(() => {
    rateRef.current = rate
    savePref('rate', rate)
    const el = audioRef.current
    if (el) {
      el.defaultPlaybackRate = rate
      el.playbackRate = rate
    }
  }, [rate])

  // Stuen (tv'et): status hentes her, fordi den også bruges til at følge en podcast på tv'et.
  const [stuenMappe, setStuenMappe] = useState('')
  const [tvStat, setTvStat] = useState<TvStatus | null>(null)
  const [tvReach, setTvReach] = useState<Reach>('ukendt')
  const [tvSession, setTvSession] = useState<TvSession | null>(() =>
    loadPref<TvSession | null>('tvSession', null, (v) => !!v && typeof v === 'object'),
  )
  const tvSessionRef = useRef(tvSession)
  const [tvStatAt, setTvStatAt] = useState(0) // hvornår tvStat blev hentet (tiden tikker videre)
  // "Afspil på …": afsnittet, der skal vælges et sted til, og stederne fra tv-helper
  const [maalFor, setMaalFor] = useState<EpisodeRow | null>(null)
  const [maalListe, setMaalListe] = useState<TvMaal[]>([STUEN])
  const [maalHenter, setMaalHenter] = useState(false)
  const maalHentet = useRef(0)
  const [fjernOpen, setFjernOpen] = useState(false) // styringen af det, der spiller et andet sted
  const fjernOpenRef = useRef(false)
  const tabRef = useRef(tab)
  useEffect(() => {
    tabRef.current = tab
  }, [tab])
  useEffect(() => {
    tvSessionRef.current = tvSession
    savePref('tvSession', tvSession)
  }, [tvSession])

  // ---------- loaders ----------
  // Begge gemmer et øjebliksbillede: uden det er app'en tom uden dækning, for alt indhold
  // kommer fra api/index.php. Fejler kaldet, beholder vi det vi allerede viser.
  const loadFavorites = useCallback(async () => {
    try {
      const items = await listFavorites(deviceId)
      setFavorites(items)
      saveSnapshot('favorites', items)
    } catch {
      // offline — øjebliksbilledet står allerede på skærmen
    }
  }, [deviceId])

  const loadQueue = useCallback(async () => {
    setLoadingQueue(true)
    try {
      const items = await newestEpisodes(deviceId)
      setQueue(items)
      setQueueLoaded(true)
      setLastRefresh(Date.now())
      saveSnapshot('queue', items)
    } catch {
      // offline — behold øjebliksbilledet; queueLoaded er allerede sat hvis vi har et
    } finally {
      setLoadingQueue(false)
    }
  }, [deviceId])

  // To-trins-load: (1) cachen tegnes med det samme, (2) serveren tjekker feeds online bagefter og
  // vi henter kun køen igen hvis der faktisk kom nye afsnit. Før lå (2) inde i (1), så HELE
  // indholdet ventede 1-3 sek. på RSS-hentninger der som regel ikke gav noget nyt.
  const refreshFromFeeds = useCallback(async () => {
    setCheckingFeeds(true)
    try {
      const res = await refreshFeeds(deviceId)
      if (res.changed) {
        const items = await newestEpisodes(deviceId)
        setQueue(items)
        setLastRefresh(Date.now())
        saveSnapshot('queue', items)
      }
    } catch {
      // feed-tjek er best-effort — cachen står allerede på skærmen
    } finally {
      setCheckingFeeds(false)
    }
  }, [deviceId])

  // Torrents hentes ved siden af køen og flettes ind i den (fullQueue). Bliver tokenet afvist
  // (ny secret på serveren), glemmes det, og Torrent-mærkatet beder om koden igen.
  const forgetTorrents = useCallback(() => {
    torrentTokenRef.current = ''
    saveTorrentToken('')
    setTorrentToken('')
    setTorrents([])
    setCatFilter((cs) => cs.filter((c) => c !== 'torrent'))
    saveSnapshot('torrents', [])
  }, [])

  const loadTorrents = useCallback(async () => {
    const token = torrentTokenRef.current
    if (!token) return
    try {
      const { items, stars } = await listTorrents(deviceId, token)
      setTorrents(items)
      saveSnapshot('torrents', items)
      setTorrentStars(stars)
      saveSnapshot('torrentStars', stars)
    } catch (e) {
      if (e instanceof TorrentLocked) forgetTorrents()
      // ellers offline — øjebliksbilledet står allerede på skærmen
    }
  }, [deviceId, forgetTorrents])

  // Som setStars for en podcast: vises med det samme. Fejler kaldet, henter vi serverens tal igen.
  const changeTorrentStars = useCallback(
    async (stars: number) => {
      const token = torrentTokenRef.current
      if (!token || stars === torrentStars) return
      setTorrentStars(stars)
      try {
        await saveTorrentStars(deviceId, token, stars)
        saveSnapshot('torrentStars', stars)
      } catch (e) {
        if (e instanceof TorrentLocked) forgetTorrents()
        else await loadTorrents()
      }
    },
    [deviceId, torrentStars, forgetTorrents, loadTorrents],
  )

  const submitPin = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setPinBusy(true)
      setPinErr('')
      try {
        const token = await unlockTorrents(pin)
        torrentTokenRef.current = token
        saveTorrentToken(token)
        setTorrentToken(token)
        setPin('')
        setPinOpen(false)
        setCatFilter(['torrent']) // man trykkede på Torrent — vis dem
        await loadTorrents()
      } catch (err) {
        setPinErr(err instanceof Error ? err.message : 'Kunne ikke låse op')
      } finally {
        setPinBusy(false)
      }
    },
    [pin, loadTorrents],
  )

  const refreshDownloads = useCallback(async () => {
    setDownloads(listDownloads())
    setStorage(await storageInfo())
  }, [])

  // Al hørt-/positions-skrivning går herigennem: lykkes den ikke, lægger den sig i udbakken
  // i stedet for at forsvinde. Ellers ville en uge uden dækning nulstille alt man har hørt.
  const persistState = useCallback(
    async (w: StateWrite) => {
      await saveStateResilient(deviceId, w)
      setPending(outboxSize())
    },
    [deviceId],
  )

  // ---------- afspilleren: gem, genskab, synkronisér ----------
  // Gem lytte-positionen NU i stedet for om op til 8 sekunder. Bruges når man pauser og når
  // app'en ryger i baggrunden: Android kan kassere siden uden varsel, og så var de sidste
  // sekunder tabt. `viaBeacon` bruges på pagehide, hvor en almindelig POST ikke når af sted.
  const savePositionNow = useCallback(
    (viaBeacon = false) => {
      const el = audioRef.current
      const ep = currentRef.current
      if (!el || !ep || closing.current) return
      // Er lyden ikke indlæst endnu (genskabt afsnit), er dens currentTime 0 — brug den gemte.
      const pos = el.readyState > 0 ? el.currentTime : ep.positionSec || 0
      const durSec = el.duration && isFinite(el.duration) ? el.duration : ep.durationSec
      lastSaved.current = Date.now()
      localAt.current = Date.now()
      saveNowPlaying(ep, pos, durSec)
      const w = {
        episodeId: ep.episodeId,
        feedId: ep.feedId,
        positionSec: Math.floor(pos),
        durationSec: Math.floor(durSec || 0),
      }
      if (viaBeacon) beaconState(deviceId, w)
      else persistState(w).catch(() => {})
    },
    [deviceId, persistState],
  )

  // Luk afspilleren: ✕ i den store afspiller, "Luk" i notifikationen (via Android-app'en), og
  // `save = false`, når afsnittet er hørt færdigt et andet sted. Fjerner den også fra
  // notifikationen og låseskærmen.
  const closePlayer = useCallback(
    (save = true) => {
      const el = audioRef.current
      logg('luk', { ...lydInfo(el, currentRef.current), gem: save ? 1 : 0 })
      if (save) savePositionNow()
      closing.current = true
      wantPlay.current = false
      window.clearTimeout(forsoegTimer.current)
      lydVirkede.current = 0
      fejlFra.current = 0
      ventetFra.current = 0
      pauseFra.current = 0
      stopKeepAlive()
      if (el) {
        el.pause()
        el.removeAttribute('src')
        el.load()
      }
      closing.current = false
      setPlaying(false)
      setCurrent(null)
      setSheetOpen(false)
      setSleepUntil(null)
      setSleepLeft(0)
      clearNowPlaying()
      nativeClosePlayer()
      // Lydelementet sender en sidste hændelse, mens det tømmes, og app-broen (3.0.0) tog den for
      // et afsnit og viste notifikationen igen — med titlen "All DK Podcasts". Derfor en gang til,
      // når hændelserne har lagt sig, hvis der ikke er startet noget nyt imens.
      window.setTimeout(() => {
        if (!currentRef.current) nativeClosePlayer()
      }, 600)
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = null
          navigator.mediaSession.playbackState = 'none'
        } catch {
          /* ignore */
        }
      }
    },
    [savePositionNow],
  )
  const closePlayerRef = useRef(closePlayer)
  useEffect(() => {
    closePlayerRef.current = closePlayer
    // Notifikationens "Luk" i Android-app'en kalder denne (via broen i podcast-android).
    ;(window as unknown as { __dkPodLuk?: () => void }).__dkPodLuk = () => closePlayer()
  }, [closePlayer])

  // Har en anden enhed (eller tv'et) lyttet videre på det afsnit, der står på pause her, siden vi
  // sidst skrev? Så fortsætter vi dér — og er det hørt færdigt, lukkes afspilleren. Uden det
  // ville et tryk på afspil her skrive den gamle position oven i den nye.
  // `justResumed`: kaldt lige efter et tryk på afspil (se resume) — så må den spole, selvom der
  // spilles, men den lukker ikke afspilleren midt i lyden.
  const syncFromServer = useCallback(async (justResumed = false) => {
    const ep = currentRef.current
    const el = audioRef.current
    if (!ep || !el || !navigator.onLine) return
    lastSync.current = Date.now()
    let st
    try {
      st = await stateGet(deviceId, ep.episodeId)
    } catch {
      return
    }
    if (!st || currentRef.current?.episodeId !== ep.episodeId || (!el.paused && !justResumed)) return
    if (st.updated * 1000 <= localAt.current + 5000) return // vores egen er den nyeste
    localAt.current = st.updated * 1000
    if (st.playedAt) {
      if (justResumed) return
      closePlayerRef.current(false)
      const patch = (list: EpisodeRow[]) => list.map((e) => (e.episodeId === ep.episodeId ? { ...e, playedAt: st.playedAt } : e))
      setQueue(patch)
      showToast(`“${ep.title}” er hørt færdig på en anden enhed`)
      return
    }
    const here = el.readyState > 0 ? el.currentTime : ep.positionSec || 0
    if (Math.abs(st.positionSec - here) < 5) return
    logg('synk', { ep: ep.episodeId, fra: Math.round(here), til: st.positionSec })
    // Også før lyden er indlæst: så bliver det startpositionen (fx mens den hentes forfra).
    el.currentTime = st.positionSec
    setCurTime(st.positionSec)
    setCurrent((c) => (c && c.episodeId === ep.episodeId ? { ...c, positionSec: st.positionSec } : c))
    saveNowPlaying({ ...ep, positionSec: st.positionSec }, st.positionSec, st.durationSec || ep.durationSec)
    showToast(`Fortsætter fra ${fmtClock(st.positionSec)}, hvor du slap på en anden enhed`)
  }, [deviceId, showToast])

  // Hent lyden forfra fra afsnittets egen adresse, og fortsæt, hvor den slap. Bruges, når
  // forbindelsen til lyden er tabt (se lydDoed øverst): det døde element kan ikke startes igen.
  // Positionen sættes, før lyden er indlæst, og gælder så som startposition.
  const genindlaes = useCallback((spil: boolean, hvorfor: string) => {
    const el = audioRef.current
    const ep = currentRef.current
    if (!el || !ep?.audioUrl) return
    window.clearTimeout(forsoegTimer.current)
    const pos = el.currentTime > 0 ? el.currentTime : sidstePos.current || ep.positionSec || 0
    logg('genindlaes', { ...lydInfo(el, ep), hvorfor, forsoeg: forsoeg.current || undefined, host: vaertAf(ep.audioUrl) })
    ventetFra.current = 0
    el.src = ep.audioUrl
    el.currentTime = pos
    el.defaultPlaybackRate = rateRef.current
    el.playbackRate = rateRef.current
    // Indtil lyden er indlæst, er afsnittets positionSec den, der gemmes (savePositionNow).
    setCurrent((c) => (c && c.episodeId === ep.episodeId ? { ...c, positionSec: Math.floor(pos) } : c))
    if (spil) el.play().catch(() => { /* onError tager sig af det */ })
  }, [])

  // Lyden faldt ud, mens man lyttede: prøv igen om lidt, eller straks (vagten, nettet er tilbage).
  // Har den været væk i over OPGIV_MS, gives der op: afsnittet står på pause, og et tryk på afspil
  // prøver forfra.
  const proevIgen = useCallback(
    (straks: boolean, hvorfor: string) => {
      window.clearTimeout(forsoegTimer.current)
      if (!wantPlay.current || !currentRef.current) return
      if (fejlFra.current && Date.now() - fejlFra.current > OPGIV_MS) {
        logg('opgivet', { ...lydInfo(audioRef.current, currentRef.current), min: Math.round((Date.now() - fejlFra.current) / 60000), forsoeg: forsoeg.current })
        wantPlay.current = false
        fejlFra.current = 0
        audioRef.current?.pause()
        setPlaying(false)
        showToast('Lyden kunne ikke hentes. Tryk afspil for at prøve igen.')
        return
      }
      if (!navigator.onLine) return // `online` prøver igen
      const ms = straks ? 0 : FORSOEG_MS[Math.min(forsoeg.current, FORSOEG_MS.length - 1)]
      forsoeg.current++
      forsoegTimer.current = window.setTimeout(() => {
        if (wantPlay.current && currentRef.current) genindlaes(true, hvorfor)
      }, ms)
    },
    [genindlaes, showToast],
  )

  // Genoptag: spil MED DET SAMME, og spørg så serveren, om der er lyttet videre et andet sted —
  // er der, spoles der dertil bagefter. Før ventede afspilningen på svaret, og i en side der har
  // ligget skjult i over 5 min. udskyder Chromium timere med op til et minut, så PLAY fra
  // notifikationen eller bilen kunne tage lang tid (fundet i emulatoren 16/11).
  // `kilde` står i loggen: 'ui' (knapperne), 'ms' (Media Session: notifikation, låseskærm, bil),
  // 'koe' (et tryk på afsnittet i køen), 'tv' (Fortsæt på telefonen).
  const resume = useCallback(async (kilde: string = 'ui') => {
    const el = audioRef.current
    const ep = currentRef.current
    if (!el || !ep?.audioUrl) return
    wantPlay.current = true
    forsoeg.current = 0
    fejlFra.current = 0
    const sync = navigator.onLine && Date.now() - lastSync.current > 60_000
    const doed = lydDoed(el)
    const haengt = haenger(el, ventetFra.current)
    const pauseMs = pauseFra.current > 0 ? Date.now() - pauseFra.current : 0
    logg('afspil', { kilde, ...lydInfo(el, ep), pauseMin: pauseMs ? Math.round(pauseMs / 60000) : undefined })
    if (!el.getAttribute('src')) {
      el.src = ep.audioUrl
      el.currentTime = ep.positionSec || 0
    } else if (doed || haengt || (navigator.onLine && pauseMs > LANG_PAUSE_MS && !erNativ(el))) {
      // Forbindelsen til lyden er tabt eller hænger (så ville play() bare stå stille), eller der
      // er pauset så længe, at forbindelsen er lukket, og CDN-adressen kan være udløbet: forfra.
      genindlaes(false, doed ? 'doed' : haengt ? 'haenger' : 'lang-pause')
    }
    el.defaultPlaybackRate = rateRef.current
    el.playbackRate = rateRef.current
    try {
      await el.play()
      setPlaying(true)
    } catch {
      /* fx ingen dækning — onError tager sig af det */
    }
    if (sync) syncFromServer(true)
  }, [syncFromServer, genindlaes])

  // Genskab afsnittet fra sidste gang: lyden indlæses (kun metadata), positionen sættes i
  // onLoadedMetadata, og der spilles ikke, før man trykker. I Android-app'en står det så også
  // i notifikationen med det samme.
  useEffect(() => {
    const el = audioRef.current
    if (!RESTORED || !el || el.getAttribute('src')) return
    el.preload = 'metadata'
    el.defaultPlaybackRate = rateRef.current
    const ep = RESTORED.ep
    nativAfsnit({
      episodeId: ep.episodeId, feedId: ep.feedId, deviceId, durationSec: ep.durationSec,
      titel: ep.title, podcast: ep.podcastTitle, billede: ep.image || ep.podcastImage,
    })
    el.src = ep.audioUrl!
    syncFromServer()
  }, [syncFromServer, deviceId])

  // ---------- ny udgave af siden ----------
  const checkVersion = useCallback(async () => {
    const b = await deployedBuild()
    if (b && b !== BUILD_ID && !newVersionRef.current) {
      newVersionRef.current = true
      setNewVersion(true)
    }
  }, [])

  // Genindlæs, når det ikke afbryder noget: kun hvis der er en ny udgave, intet spiller og ingen
  // hentning er i gang. Afsnittet i afspilleren står der igen bagefter (nowplaying).
  const reloadIfIdle = useCallback(() => {
    if (!newVersionRef.current || bulkRef.current) return false
    const el = audioRef.current
    if (el && !el.paused) return false
    savePositionNow()
    logg('ny-udgave')
    window.location.reload()
    return true
  }, [savePositionNow])

  // ---------- Stuen: status fra tv'et ----------
  const tvTimer = useRef(0)
  const nativeHidden = useRef(false) // Android-app'en har meldt "baggrund"
  const lastTvPos = useRef<{ pos: number; dur: number } | null>(null)
  const lastTvSave = useRef(0)
  const pollTvRef = useRef<() => void>(() => {})

  const markHeard = useCallback(
    async (ep: EpisodeRow, heard: boolean) => {
      await persistState({ episodeId: ep.episodeId, feedId: ep.feedId, played: heard })
      const patch = (list: EpisodeRow[]) =>
        list.map((e) => (e.episodeId === ep.episodeId ? { ...e, playedAt: heard ? new Date().toISOString() : null } : e))
      setQueue(patch)
      setDetailEpisodes(patch)
      setTorrents(patch)
    },
    [persistState],
  )

  // En podcast, der er sendt til tv'et eller en højttaler: gem positionen, mens den spiller dér,
  // og markér den hørt, når den er spillet færdig. Kører kun, mens app'en er fremme (det er dér,
  // den poller). `fjern` (tv-helper fra 2026-11-17) dækker begge; `kodi.spiller` er den gamle vej.
  const followTvSession = useCallback(
    (st: TvStatus) => {
      const sess = tvSessionRef.current
      if (!sess) return
      const fj = st.fjern
      const vores = !!fj && fj.podcast?.episodeId === sess.episodeId
      const sp =
        fj !== undefined
          ? fj && vores && fj.spiller
            ? { tid: fj.tid, laengde: fj.laengde }
            : null
          : st.kodi?.spiller?.podcast?.episodeId === sess.episodeId
            ? st.kodi.spiller
            : null
      const ep = { episodeId: sess.episodeId, feedId: sess.feedId } as EpisodeRow
      if (fj && vores && fj.slut) {
        // højttaleren har spillet afsnittet færdigt
        markHeard(ep, true).catch(() => {})
        lastTvPos.current = null
        setTvSession(null)
        return
      }
      if (sp) {
        const durSec = sp.laengde || sess.durationSec
        lastTvPos.current = { pos: sp.tid, dur: durSec }
        if (Date.now() - lastTvSave.current > 15_000 && sp.tid > 0) {
          lastTvSave.current = Date.now()
          persistState({ episodeId: sess.episodeId, feedId: sess.feedId, positionSec: Math.floor(sp.tid), durationSec: Math.floor(durSec) }).catch(() => {})
          const patch = (list: EpisodeRow[]) =>
            list.map((e) => (e.episodeId === sess.episodeId ? { ...e, positionSec: Math.floor(sp.tid) } : e))
          setQueue(patch)
        }
        return
      }
      // Spiller ikke (længere): færdig, stoppet eller afløst af noget andet på tv'et.
      if (jobIGang(st) || Date.now() - sess.startedAt < 90_000) return
      const last = lastTvPos.current
      if (last && last.dur > 0 && last.pos >= last.dur * 0.97) markHeard(ep, true).catch(() => {})
      else if (last && last.pos > 0)
        persistState({ episodeId: sess.episodeId, feedId: sess.feedId, positionSec: Math.floor(last.pos), durationSec: Math.floor(last.dur) }).catch(() => {})
      lastTvPos.current = null
      setTvSession(null)
    },
    [persistState, markHeard],
  )

  const pollTv = useCallback(async () => {
    window.clearTimeout(tvTimer.current)
    let st: TvStatus | null = null
    try {
      st = await tvStatus()
      setTvStat(st)
      setTvStatAt(Date.now())
      setTvReach('ok')
      followTvSession(st)
    } catch (e) {
      if (e instanceof TvUnreachable) {
        setTvReach('ude')
        setTvStat(null)
      }
    }
    if (!visible() || nativeHidden.current) return
    // Stuen viser tv'et live; styringen af en højttaler/tv'et (fjernOpen) og et job, der er i gang
    // (tænder tv'et …), vises tæt på live; ellers følges et afsnit dér hvert 15. sek.
    const ms =
      tabRef.current === 'stuen'
        ? jobIGang(st) ? 1000 : 2500
        : fjernOpenRef.current || jobIGang(st) ? 2000 : tvSessionRef.current ? 15_000 : 0
    if (ms) tvTimer.current = window.setTimeout(() => pollTvRef.current(), ms)
  }, [followTvSession])
  useEffect(() => {
    pollTvRef.current = pollTv
  }, [pollTv])
  const pollTvSoon = useCallback((ms = 150) => {
    window.clearTimeout(tvTimer.current)
    tvTimer.current = window.setTimeout(() => pollTvRef.current(), ms)
  }, [])
  useEffect(() => {
    fjernOpenRef.current = fjernOpen
    if (fjernOpen) pollTvSoon(0)
  }, [fjernOpen, pollTvSoon])

  // ---------- opdatering: når app'en kommer frem, og jævnligt mens den er fremme ----------
  // En installeret PWA lukkes sjældent helt, og i Android-app'en lever siden så længe processen
  // gør (nu op til et døgn under en pause). `visibilitychange` alene var ikke nok: i app'en kom den
  // ikke altid, og så viste køen det, den viste i går. Nu tæller også `focus`, `pageshow`,
  // app'ens eget signal (dkpod:forgrund) og et tjek hvert 5. minut, mens app'en er fremme.
  const lastLoad = useRef(0)
  const refreshAll = useCallback(
    (force = false) => {
      if (!force && Date.now() - lastLoad.current < 60_000) return
      lastLoad.current = Date.now()
      loadFavorites()
      loadQueue().then(() => {
        refreshFromFeeds()
        loadTorrents()
      })
      checkVersion()
      const el = audioRef.current
      if (currentRef.current && el && el.paused) syncFromServer()
      if (tabRef.current === 'stuen' || tvSessionRef.current || loadPref('stuenBrugt', false)) pollTvSoon(50)
    },
    [loadFavorites, loadQueue, refreshFromFeeds, loadTorrents, checkVersion, syncFromServer, pollTvSoon],
  )

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        refreshAll()
      } else {
        savePositionNow()
        reloadIfIdle()
      }
    }
    const onFocus = () => refreshAll()
    const onForgrund = () => {
      nativeHidden.current = false
      refreshAll()
    }
    const onBaggrund = () => {
      nativeHidden.current = true
      savePositionNow()
      reloadIfIdle()
    }
    const onVisSpiller = () => {
      if (currentRef.current) setSheetOpen(true)
    }
    const onUnload = () => savePositionNow(true)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    window.addEventListener('pageshow', onFocus)
    window.addEventListener('dkpod:forgrund', onForgrund)
    window.addEventListener('dkpod:baggrund', onBaggrund)
    window.addEventListener('dkpod:vis-spiller', onVisSpiller)
    window.addEventListener('pagehide', onUnload)
    const iv = window.setInterval(() => {
      if (visible() && !nativeHidden.current) refreshAll()
    }, 5 * 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pageshow', onFocus)
      window.removeEventListener('dkpod:forgrund', onForgrund)
      window.removeEventListener('dkpod:baggrund', onBaggrund)
      window.removeEventListener('dkpod:vis-spiller', onVisSpiller)
      window.removeEventListener('pagehide', onUnload)
      window.clearInterval(iv)
    }
  }, [refreshAll, savePositionNow, reloadIfIdle])

  // Første indlæsning. I en timeout, så effekten ikke selv sætter state (react-hooks).
  useEffect(() => {
    const t = window.setTimeout(() => {
      lastLoad.current = Date.now()
      loadFavorites()
      loadQueue().then(() => {
        refreshFromFeeds()
        loadTorrents()
      })
      checkVersion()
      if (loadPref('stuenBrugt', false) || tvSessionRef.current) pollTvSoon(400)
      // popularitet er pynt — fejler den, skal resten af app'en være upåvirket
      getCharts()
        .then((c) => {
          setChartShows(c.shows)
          setChartEpisodes(c.episodes)
        })
        .catch(() => {})
    }, 0)
    return () => window.clearTimeout(t)
  }, [loadFavorites, loadQueue, refreshFromFeeds, loadTorrents, checkVersion, pollTvSoon])

  // Offline-husholdning: ryd op i hentede afsnit browseren har smidt ud, hold øje med
  // forbindelsen, og send lytning der ligger i udbakken så snart der er hul igennem igen.
  useEffect(() => {
    if (canDownload) reconcileDownloads().then(refreshDownloads).catch(() => {})
    const flush = () =>
      flushOutbox(deviceId)
        .then((sent) => {
          setPending(outboxSize())
          // serveren har nu vores lytning — hent køen igen så hørt-markeringerne står rigtigt
          if (sent > 0) loadQueue()
        })
        .catch(() => setPending(outboxSize()))
    const goOnline = () => {
      setOnline(true)
      flush()
      refreshAll(true)
      // Faldt lyden ud (eller hænger den), mens der ikke var net, fortsætter den nu.
      const el = audioRef.current
      if (wantPlay.current && el && el.getAttribute('src') && (lydDoed(el) || haenger(el, ventetFra.current))) proevIgen(true, 'online')
    }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    flush()
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [deviceId, canDownload, refreshDownloads, loadQueue, refreshAll, proevIgen])

  // Udforsk-listen hentes først når fanen åbnes (fra klik-handleren, ikke en effect — den koster
  // ~0,7 sek. hos Podcast Index, og startfanen er Kø, så på start kappedes den før om
  // forbindelsen med det indhold man faktisk kigger på).
  const openExplore = useCallback(() => {
    setTab('explore')
    if (results.length > 0) return
    setExploreBusy(true)
    discover('da', 60)
      .then(setResults)
      .catch(() => {})
      .finally(() => setExploreBusy(false))
  }, [results.length])

  const openStuen = useCallback(() => {
    tabRef.current = 'stuen'
    setTab('stuen')
    savePref('stuenBrugt', true)
    pollTvSoon(0)
  }, [pollTvSoon])

  const selectTab = useCallback(
    (t: Tab) => {
      if (t === 'explore') openExplore()
      else if (t === 'stuen') openStuen()
      else setTab(t)
      window.scrollTo(0, 0)
    },
    [openExplore, openStuen],
  )

  // ---------- explore ----------
  // Ét sted at søge fra, så alle indgange (søgefeltet, hitliste-klik, "ryd") sætter `searchedFor`
  // og dermed også flytter træfferne op øverst i fanen.
  const runSearchFor = useCallback(async (raw: string) => {
    const q = raw.trim()
    setQuery(raw)
    setExploreErr('')
    setExploreBusy(true)
    try {
      const res = q ? await search(q, 80) : await discover('da', 60)
      setResults(res)
      setSearchedFor(q)
    } catch {
      setExploreErr('Søgning fejlede. Prøv igen om lidt.')
    } finally {
      setExploreBusy(false)
    }
  }, [])

  const runSearch = useCallback(() => runSearchFor(query), [runSearchFor, query])
  const clearSearch = useCallback(() => runSearchFor(''), [runSearchFor])

  const addByUrl = useCallback(async () => {
    const url = urlInput.trim()
    if (!url) return
    setExploreErr('')
    setExploreBusy(true)
    try {
      // Podimo-show? (paywall) → egen vej; afsnit hentes af scraperen bagefter
      if (/podimo\.com\/[a-z]{2}\/shows\//i.test(url)) {
        const title = await addPodimoShow(deviceId, url)
        if (!title) {
          setExploreErr('Kunne ikke tilføje Podimo-show. Tjek at det er en show-URL.')
          return
        }
        setUrlInput('')
        await loadFavorites()
        setExploreErr(`✓ Tilføjet “${title}” — afsnit dukker op i køen inden for ~30 min (link til Podimo; kan ikke afspilles i app'en).`)
        return
      }
      const p = await resolveUrl(url)
      if (!p) {
        setExploreErr('Ingen podcast fundet på den URL (Podcast Index kender den ikke).')
        return
      }
      await addFavorite(deviceId, p, p.kind === 'tv' ? tvVia(p) : 'url')
      setUrlInput('')
      await loadFavorites()
      // Et nyt feed har ingen cache endnu, så køen skal have fat i RSS'et for at vise noget.
      await loadQueue()
      refreshFromFeeds()
      setResults((prev) => [p, ...prev.filter((x) => x.id !== p.id)])
    } catch {
      setExploreErr('Kunne ikke tilføje feed via URL.')
    } finally {
      setExploreBusy(false)
    }
  }, [urlInput, deviceId, loadFavorites, loadQueue, refreshFromFeeds])

  const orderedResults = useMemo(() => {
    let r = results
    if (langMode === 'da-only') r = r.filter((p) => isDanish(p.language))
    else if (langMode === 'da-first')
      r = [...r].sort((a, b) => Number(isDanish(b.language)) - Number(isDanish(a.language)))
    return r
  }, [results, langMode])

  // ---------- stjerner og slet ----------
  // Tre stjerneknapper: tryk på nr. 1, 2 eller 3 sætter præcis det antal, så en podcast kan gå
  // fra ★★★ til ★ uden at forsvinde. Indtil 2026-10-02 var stjernen én knap der kørte rundt
  // (☆ → ★ → ★★ → fjernet), og ét tryk for meget slettede podcasten. At slette er nu sin egen
  // knap på kortet (PodcastCard), og den kræver to tryk.
  const setStars = useCallback(
    async (p: Podcast, stars: number) => {
      const level = starLevel(p.id)
      if (level === stars) return
      const priority = stars - 1
      if (level > 0) {
        // Kun markeringen ændrer sig: vis den med det samme, og hent hverken kø eller feeds.
        setFavorites((fs) => fs.map((f) => (f.feedId === p.id ? { ...f, priority } : f)))
        try {
          // Trykker man videre fra ★ til ★★★ mens favorites.add stadig kører, skal rækken
          // findes på serveren før den kan opdateres — ellers rammer UPDATE'en ingenting.
          await pendingAdds.current.get(p.id)
          await setFavoritePriority(deviceId, p.id, priority)
        } finally {
          await loadFavorites()
        }
        return
      }
      // 'drtv'/'viaplay' gør at favoritten kan mærkes som TV bagefter; selve opdateringen
      // af afsnit hænger på feed-URL'en, ikke på dette felt.
      const via = p.kind === 'tv' ? tvVia(p) : 'search'
      // favorites.add henter feedet på serveren (1-3 sek.) — stjernerne tændes med det samme.
      setFavorites((fs) => [
        ...fs,
        { feedId: p.id, title: p.title, image: p.image, author: p.author, language: p.language, feedUrl: p.feedUrl, addedVia: via, priority },
      ])
      const adding = (async () => {
        await addFavorite(deviceId, p, via)
        if (priority > 0) await setFavoritePriority(deviceId, p.id, priority)
      })()
      pendingAdds.current.set(p.id, adding.catch(() => {}))
      try {
        await adding
      } finally {
        pendingAdds.current.delete(p.id)
        await loadFavorites()
      }
      await loadQueue()
      // Nyfulgt podcast har ingen cachede afsnit endnu — hent dem i baggrunden.
      refreshFromFeeds()
    },
    [starLevel, deviceId, loadFavorites, loadQueue, refreshFromFeeds],
  )

  const deleteFavorite = useCallback(
    async (p: Podcast) => {
      setFavorites((fs) => fs.filter((f) => f.feedId !== p.id))
      try {
        await removeFavorite(deviceId, p.id)
      } finally {
        await loadFavorites()
      }
      await loadQueue()
    },
    [deviceId, loadFavorites, loadQueue],
  )

  // ---------- podcast detail ----------
  const openDetail = useCallback(
    async (p: Podcast | Favorite) => {
      const feedId = 'id' in p ? p.id : p.feedId
      setOpenPodcast(p)
      setOpenPodcastInfo(('description' in p && p.description) ? (p as Podcast) : null)
      setDetailBusy(true)
      // fuld podcast-info (beskrivelse) i baggrunden
      getPodcast(feedId).then((full) => { if (full) setOpenPodcastInfo(full) }).catch(() => {})
      try {
        setDetailEpisodes(await feedEpisodes(deviceId, feedId))
      } finally {
        setDetailBusy(false)
      }
    },
    [deviceId],
  )

  // ---------- episode detail ("læs mere") ----------
  // Hørte afsnit kommer uden `description` fra køen (den fylder ~halvdelen af payloaden), så
  // teksten hentes her når pop-up'en faktisk åbnes — og patches ind i listerne, så den kun
  // hentes én gang pr. afsnit.
  // ---------- video fra HTPC: torrents og DR TV-afsnit, på tv'et eller telefonen ----------
  // DR TV-programmerne, der følges, henter HTPC også som video (podcast/scraper/drtv_hent.py),
  // så de kan ses på tv'et og telefonen ligesom en torrent. tv-helper finder filen på disken.
  // Det virker kun hjemme; ude er der kun DR TV's eget link (og for en torrent ingenting).
  const [video, setVideo] = useState<{ id: number; tilstand: 'henter' | 'fundet' | 'ikke' | 'ude'; fund?: TvFund } | null>(null)
  const findVideo = useCallback(async (ep: EpisodeRow) => {
    const drtv = drtvNummer(ep)
    if (ep.kind !== 'torrent' && !drtv) return
    if (!navigator.onLine) {
      setVideo({ id: ep.episodeId, tilstand: 'ude' })
      return
    }
    setVideo({ id: ep.episodeId, tilstand: 'henter' })
    try {
      const fund = await tvFind(drtv ? { drtv } : { navn: ep.rawName || '' })
      setVideo({ id: ep.episodeId, tilstand: fund.fundet ? 'fundet' : 'ikke', fund })
      setTvReach('ok')
    } catch (e) {
      setVideo({ id: ep.episodeId, tilstand: e instanceof TvUnreachable ? 'ude' : 'ikke' })
      if (e instanceof TvUnreachable) setTvReach('ude')
    }
  }, [])

  const showEpisode = useCallback(
    (ep: EpisodeRow) => {
      setOpenEpisode(ep)
      setVideo(null)
      if (ep.kind === 'torrent' || drtvNummer(ep)) findVideo(ep)
      if (ep.description || ep.kind === 'torrent') return
      setDescBusy(true)
      episodeDescription(ep.feedId, ep.episodeId)
        .then((desc) => {
          if (!desc) return
          setOpenEpisode((cur) => (cur && cur.episodeId === ep.episodeId ? { ...cur, description: desc } : cur))
          const patch = (list: EpisodeRow[]) =>
            list.map((e) => (e.episodeId === ep.episodeId ? { ...e, description: desc } : e))
          setQueue(patch)
          setDetailEpisodes(patch)
        })
        .catch(() => {
          // offline eller fejl — pop-up'en viser bare "Ingen beskrivelse."
        })
        .finally(() => setDescBusy(false))
    },
    [findVideo],
  )

  // Androids tilbage-knap lukker det øverste først (se lib/back.ts)
  useEffect(() => {
    if (!sheetOpen) return
    return pushBack(() => {
      setSheetOpen(false)
      return true
    })
  }, [sheetOpen])
  useEffect(() => {
    if (!openPodcast) return
    return pushBack(() => {
      setOpenPodcast(null)
      return true
    })
  }, [openPodcast])
  useEffect(() => {
    if (!maalFor) return
    return pushBack(() => {
      setMaalFor(null)
      return true
    })
  }, [maalFor])
  useEffect(() => {
    if (!fjernOpen) return
    return pushBack(() => {
      setFjernOpen(false)
      return true
    })
  }, [fjernOpen])
  useEffect(() => {
    if (!openEpisode) return
    return pushBack(() => {
      setOpenEpisode(null)
      return true
    })
  }, [openEpisode])

  // ---------- offline-download ----------
  // Returnerer null ved succes, ellers fejlteksten. `silent` bruges af bulk-hentningen, som
  // samler fejlene til ét resumé til sidst — ellers ville hvert nyt afsnit viske den
  // foregåendes fejl ud, og man ville aldrig opdage hvad der IKKE kom med på turen.
  const startDownload = useCallback(
    async (ep: EpisodeRow, silent = false): Promise<string | null> => {
      if (!silent) setDlError('')
      setDlState((s) => ({ ...s, [ep.episodeId]: 'busy' }))
      try {
        await downloadEpisode(ep)
        setDlState((s) => ({ ...s, [ep.episodeId]: 'done' }))
        await refreshDownloads()
        return null
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'ukendt fejl'
        setDlState((s) => ({ ...s, [ep.episodeId]: 'error' }))
        if (!silent) setDlError(`Kunne ikke hente “${ep.title}”: ${msg}`)
        return msg
      }
    },
    [refreshDownloads],
  )

  const dropDownload = useCallback(
    async (ep: EpisodeRow) => {
      await removeDownload(ep.episodeId)
      setDlState((s) => {
        const next = { ...s }
        delete next[ep.episodeId]
        return next
      })
      await refreshDownloads()
    },
    [refreshDownloads],
  )

  // Bulk-hentning før en tur: ét afsnit ad gangen. Parallelt ville både mætte forbindelsen og
  // gøre det umuligt at se hvor langt man er nået — og hver fil fylder 27-60 MB.
  const downloadNext = useCallback(
    async (count: number) => {
      const targets = queue.filter((e) => !e.playedAt && e.audioUrl && !dlIds.has(e.episodeId)).slice(0, count)
      if (!targets.length) return
      cancelBulk.current = false
      bulkRef.current = true
      setDlError('')
      setDlState((s) => {
        const next = { ...s }
        for (const t of targets) next[t.episodeId] = 'queued'
        return next
      })
      setBulk({ done: 0, total: targets.length })
      const failed: string[] = []
      for (let i = 0; i < targets.length; i++) {
        if (cancelBulk.current) break
        if (await startDownload(targets[i], true)) failed.push(targets[i].title)
        setBulk({ done: i + 1, total: targets.length })
      }
      if (failed.length) {
        setDlError(
          failed.length === 1
            ? `Kunne ikke hente “${failed[0]}” — udbyderen afviste hentningen. Resten kom med.`
            : `${failed.length} afsnit kunne ikke hentes: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ' m.fl.' : ''}. Resten kom med.`,
        )
      }
      // det der ikke nåede med, skal ikke blive stående som "i kø"
      setDlState((s) => {
        const next = { ...s }
        for (const t of targets) if (next[t.episodeId] === 'queued') delete next[t.episodeId]
        return next
      })
      setBulk(null)
      bulkRef.current = false
    },
    [queue, dlIds, startDownload],
  )

  const clearAllDownloads = useCallback(async () => {
    if (!confirm('Slet alle hentede afsnit? De kan hentes igen når du har forbindelse.')) return
    await removeAllDownloads()
    setDlState({})
    await refreshDownloads()
  }, [refreshDownloads])

  // ---------- playback ----------
  const playEpisode = useCallback((ep: EpisodeRow) => {
    if (!ep.audioUrl) return
    // Uden dækning kan kun hentede afsnit spille — sig det, i stedet for at lade
    // <audio> fejle med en kryptisk fejl et halvt sekund senere.
    if (!online && !dlIds.has(ep.episodeId)) {
      setDlError(`“${ep.title}” er ikke hentet, og du er offline. Hentede afsnit ligger under Hentet.`)
      return
    }
    // Er det afsnittet, der allerede står i afspilleren, er det bare en genoptagelse.
    if (currentRef.current?.episodeId === ep.episodeId && audioRef.current?.getAttribute('src')) {
      resume('koe')
      return
    }
    // Skiftes der afsnit midt i et andet, gemmes det gamles plads først.
    if (currentRef.current && currentRef.current.episodeId !== ep.episodeId) savePositionNow()
    logg('afsnit', {
      ep: ep.episodeId, feed: ep.feedId, titel: ep.title, podcast: ep.podcastTitle,
      pos: ep.positionSec || 0, dur: ep.durationSec, host: vaertAf(ep.audioUrl), hentet: dlIds.has(ep.episodeId) ? 1 : 0,
    })
    setPlayErrorId(0)
    window.clearTimeout(forsoegTimer.current)
    lydVirkede.current = 0
    fejlFra.current = 0
    ventetFra.current = 0
    forsoeg.current = 0
    pauseFra.current = 0
    sidstePos.current = ep.positionSec || 0
    setCurrent(ep)
    currentRef.current = ep
    setPlaying(true)
    setCurTime(ep.positionSec || 0)
    setDur(ep.durationSec || 0)
    wantPlay.current = true
    localAt.current = Date.now()
    lastSync.current = Date.now() // køen er lige hentet — positionen derfra er frisk nok
    saveNowPlaying(ep, ep.positionSec || 0, ep.durationSec)
    // resume position applied in the audio onLoadedMetadata handler below
    window.setTimeout(() => {
      const el = audioRef.current
      if (el) {
        nativAfsnit({
          episodeId: ep.episodeId, feedId: ep.feedId, deviceId, durationSec: ep.durationSec,
          titel: ep.title, podcast: ep.podcastTitle, billede: ep.image || ep.podcastImage,
        })
        el.src = ep.audioUrl!
        el.defaultPlaybackRate = rateRef.current
        el.playbackRate = rateRef.current
        el.currentTime = ep.positionSec || 0
        el.play().catch(() => setPlaying(false))
      }
    }, 0)
  }, [online, dlIds, resume, savePositionNow, deviceId])

  // NB: "✓ ryd herunder" (bulk-markér en dag + alt ældre som hørt) er fjernet 2026-08-23.
  // Køen er bevidst en lang liste man plukker fra — ikke en indbakke der skal tømmes — så
  // knappen løste et problem der ikke fandtes. Backendens `state.setMany` står stadig.

  // Slut på et afsnit = stop. Ingen auto-videre (fravalgt 2026-08-22): app'en skal aldrig selv
  // begynde på det næste afsnit — man vælger selv hvad der skal spilles. Afspilleren lukkes, så
  // et færdigt afsnit heller ikke bliver hængende i notifikationen.
  const onEnded = useCallback(async () => {
    const ep = currentRef.current
    if (!ep) return
    // Stop lyden helt: uden det ville elementet spille videre hvis `ended` kom uden at
    // afspilningen faktisk var slut, mens afspilleren i bunden allerede var ryddet.
    audioRef.current?.pause()
    stopKeepAlive() // afsnittet er slut — der er ikke noget at holde i live
    closePlayer(false)
    await persistState({ episodeId: ep.episodeId, feedId: ep.feedId, played: true })
    setQueue((list) => list.map((e) => (e.episodeId === ep.episodeId ? { ...e, playedAt: new Date().toISOString() } : e)))
  }, [persistState, closePlayer])

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current
    const ep = currentRef.current
    if (!el || !ep || !el.getAttribute('src')) return
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && el.currentTime > 0) sidstePos.current = el.currentTime
    if (!seeking) setCurTime(el.currentTime)
    if (el.duration && isFinite(el.duration)) setDur(el.duration)
    const now = Date.now()
    if (now - lastSaved.current > 8000 && !el.paused) {
      lastSaved.current = now
      localAt.current = now
      const secs = Math.floor(el.currentTime)
      const durSec = Math.floor(el.duration || ep.durationSec)
      saveNowPlaying(ep, secs, durSec)
      persistState({ episodeId: ep.episodeId, feedId: ep.feedId, positionSec: secs, durationSec: durSec }).catch(() => {})
      // hold listens fremdriftsbjælke opdateret, også når afsnittet ikke længere er "current"
      const patch = (list: EpisodeRow[]) =>
        list.map((e) => (e.episodeId === ep.episodeId ? { ...e, positionSec: secs } : e))
      setQueue(patch)
      setDetailEpisodes(patch)
    }
  }, [persistState, seeking])

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused || lydDoed(el)) {
      resume('ui')
    } else {
      logg('pause', { kilde: 'ui', ...lydInfo(el, currentRef.current) })
      wantPlay.current = false
      el.pause()
      setPlaying(false)
    }
  }, [resume])

  // Tidslinjen på låseskærmen og i bilen. Uden setPositionState viser Tesla-skærmen hverken
  // forløbet tid eller varighed — kun titlen. Kaldes ved spring/start/pause, ikke ved hvert
  // timeupdate (fire gange i sekundet er der ingen grund til at fodre systemet).
  const syncPositionState = useCallback(() => {
    const el = audioRef.current
    if (!el || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
    const duration = el.duration
    if (!duration || !isFinite(duration)) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: el.playbackRate || 1,
        position: Math.max(0, Math.min(el.currentTime, duration)),
      })
    } catch {
      // nogle browsere afviser værdier de ikke kan lide — det må ikke vælte afspilningen
    }
  }, [])

  // spol: negativ = tilbage, positiv = frem (sekunder)
  const skip = useCallback((delta: number) => {
    const el = audioRef.current
    if (!el) return
    const base = el.readyState > 0 ? el.currentTime : currentRef.current?.positionSec || 0
    const target = Math.min(el.duration || Infinity, Math.max(0, base + delta))
    logg('spol', { ep: currentRef.current?.episodeId, delta, til: Math.round(target) })
    el.currentTime = target
    setCurTime(target)
    syncPositionState()
  }, [syncPositionState])

  // slider: opdatér visning mens der trækkes, sæt lyden når man slipper
  const onSeekInput = useCallback((v: number) => {
    setSeeking(true)
    setCurTime(v)
  }, [])
  const onSeekCommit = useCallback((v: number) => {
    const el = audioRef.current
    logg('spol', { ep: currentRef.current?.episodeId, fra: el ? Math.round(el.currentTime) : undefined, til: Math.round(v), kilde: 'slider' })
    if (el) el.currentTime = v
    setCurTime(v)
    setSeeking(false)
    syncPositionState()
  }, [syncPositionState])

  // Media Session: metadata + betjening på låseskærm, i notifikationen og på bilens skærm.
  //
  // BILEN (2026-08-22): Tesla — og biler generelt — sender kun ét sæt kommandoer over Bluetooth
  // (AVRCP). Ratets/skærmens frem/tilbage er "næste/forrige nummer" (`nexttrack`/`previoustrack`);
  // der findes ikke en "spol 30 sek."-kommando at binde til. Derfor ER de to knapper spol her:
  // **næste = +30 sek., forrige = −10 sek.**, præcis som ↻30/↺10 i appen. Prisen er at man ikke
  // kan springe til næste afsnit fra bilen.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (current) {
      const art = current.image || current.podcastImage
      ms.metadata = new MediaMetadata({
        title: current.title,
        artist: current.podcastTitle || 'All DK Podcasts',
        album: 'All DK Podcasts',
        artwork: art ? [96, 192, 512].map((sz) => ({ src: art, sizes: `${sz}x${sz}`, type: 'image/jpeg' })) : [],
      })
    }
    ms.setActionHandler('play', () => { resume('ms') })
    ms.setActionHandler('pause', () => {
      logg('pause', { kilde: 'ms', ...lydInfo(audioRef.current, currentRef.current) })
      wantPlay.current = false
      audioRef.current?.pause()
      setPlaying(false)
    })
    // hold-nede-knapper i nogle biler/headsets
    ms.setActionHandler('seekbackward', () => skip(-10))
    ms.setActionHandler('seekforward', () => skip(30))
    // enkelt-tryk på frem/tilbage (Tesla-skærmen, rattet, headset)
    ms.setActionHandler('previoustrack', () => skip(-10))
    ms.setActionHandler('nexttrack', () => skip(30))
    try { ms.setActionHandler('seekto', (d) => { const el = audioRef.current; if (el && d.seekTime != null) { logg('spol', { ep: currentRef.current?.episodeId, til: Math.round(d.seekTime), kilde: 'ms' }); el.currentTime = d.seekTime; setCurTime(d.seekTime); syncPositionState() } }) } catch { /* ikke understøttet */ }
    return () => {
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack', 'previoustrack'] as const) {
        try { ms.setActionHandler(a, null) } catch { /* ignore */ }
      }
    }
  }, [current, skip, syncPositionState, resume])

  // Systemet skal vide om vi spiller eller er pauset — ellers viser bilen/låseskærmen det
  // forkerte symbol, og under keep-alive (lydløs lyd) ville den tro der stadig afspilles.
  useEffect(() => {
    if ('mediaSession' in navigator && current) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  }, [playing, current])

  // ---------- hastighed og sove-timer ----------
  const cycleRate = useCallback(() => {
    setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length] ?? 1)
  }, [])

  const cycleSleep = useCallback(() => {
    const left = sleepUntil ? (sleepUntil - Date.now()) / 60000 : 0
    const next = SLEEP_STEPS.find((m) => m > left + 0.5)
    if (!next) {
      setSleepUntil(null)
      setSleepLeft(0)
      showToast('Sove-timeren er slået fra')
      return
    }
    setSleepUntil(Date.now() + next * 60000)
    setSleepLeft(next)
    showToast(`Pauser om ${next} minutter`)
  }, [sleepUntil, showToast])

  // Sove-timeren tjekkes hvert 5. sekund (og på timeupdate nedenfor). Mens der spilles lyd,
  // drosler hverken Chrome eller WebView'en timere ned, så den holder også med skærmen slukket.
  useEffect(() => {
    if (!sleepUntil) return
    const tick = () => {
      const left = sleepUntil - Date.now()
      if (left <= 0) {
        logg('sove', lydInfo(audioRef.current, currentRef.current))
        wantPlay.current = false
        audioRef.current?.pause()
        setPlaying(false)
        setSleepUntil(null)
        setSleepLeft(0)
        return
      }
      setSleepLeft(Math.ceil(left / 60000))
    }
    const iv = window.setInterval(tick, 5000)
    return () => window.clearInterval(iv)
  }, [sleepUntil])
  // I app'en (3.3) holder app'en også øje med sove-timeren: siden kan sove, mens lyden spiller
  useEffect(() => {
    nativSove(sleepUntil)
  }, [sleepUntil])

  // Vagten: skal lyden spille, men står den stille og venter på data i over STAAR_STILLE_MS, hentes
  // den forfra. En forbindelse, der hænger efter et hul i dækningen, giver ingen fejl, så den ville
  // ellers kunne stå sådan i minutter. Den skriver også "lyt" i loggen hvert 5. minut, mens der
  // spilles, så lyttetiden kan regnes ud, selv hvis siden bliver lukket midt i.
  useEffect(() => {
    if (!playing) return
    let sidst = -1
    let siden = 0
    let tik = 0
    const iv = window.setInterval(() => {
      const el = audioRef.current
      if (++tik % 60 === 0 && el && !el.paused) logg('lyt', { ...lydInfo(el, currentRef.current), rate: el.playbackRate })
      // I app'en (3.3) prøver app'ens afspiller selv igen i op til 10 min., så vagten er overflødig
      const venter =
        !!el && !erNativ(el) && !el.paused && !el.ended && wantPlay.current && navigator.onLine &&
        el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && el.currentTime === sidst
      sidst = el ? el.currentTime : -1
      if (!venter) {
        siden = 0
        return
      }
      if (!siden) siden = Date.now()
      else if (Date.now() - siden >= STAAR_STILLE_MS) {
        if (!fejlFra.current) fejlFra.current = siden
        siden = 0
        proevIgen(true, 'vagt')
      }
    }, 5000)
    return () => window.clearInterval(iv)
  }, [playing, proevIgen])

  // ---------- Afspil på …: tv'et i stuen eller en Google Home-højttaler ----------
  // En podcast spilles fra hvor man er nu, og app'en følger med (TvSession). Den lokale afspiller
  // pauses først. Tv'et får lyden gennem HTPC (Kodi hang på DR's adresser); en højttaler henter
  // den selv hos udbyderen.
  const playRemote = useCallback(
    async (ep: EpisodeRow, maal: TvMaal) => {
      if (!ep.audioUrl) return
      const el = audioRef.current
      let start = ep.positionSec || 0
      logg('fjern', { ep: ep.episodeId, maal: maal.id })
      if (currentRef.current?.episodeId === ep.episodeId && el) {
        start = el.readyState > 0 ? el.currentTime : start
        if (!el.paused) {
          wantPlay.current = false
          el.pause()
          setPlaying(false)
        }
        savePositionNow()
      }
      const title = ep.podcastTitle ? `${ep.podcastTitle}: ${ep.title}` : ep.title
      const billede = [ep.image, ep.podcastImage].find((u) => !!u && u.startsWith('https://'))
      try {
        await tvAfspilUrl(
          ep.audioUrl,
          maal.type === 'tv' ? title : ep.title,
          start,
          { episodeId: ep.episodeId, feedId: ep.feedId, durationSec: ep.durationSec },
          maal.id,
          { billede, udgiver: ep.podcastTitle },
        )
      } catch (e) {
        showToast(
          e instanceof TvUnreachable
            ? "Det kan kun nås hjemme på wifi'en"
            : `${maal.navn} svarede ikke: ${e instanceof Error ? e.message : ''}`,
        )
        return
      }
      lastTvPos.current = null
      lastTvSave.current = 0
      setTvSession({
        episodeId: ep.episodeId,
        feedId: ep.feedId,
        url: ep.audioUrl,
        title,
        durationSec: ep.durationSec,
        startedAt: Date.now(),
        maal: maal.id,
        maalNavn: maal.navn,
        image: billede,
      })
      setSheetOpen(false)
      setOpenEpisode(null)
      setMaalFor(null)
      pollTvSoon(400)
      showToast(maal.type === 'tv' ? "Sendt til tv'et — det tænder af sig selv" : `Spiller på ${maal.navn}`)
    },
    [savePositionNow, showToast, pollTvSoon],
  )

  // Vælg hvor: stederne hentes fra tv-helper, når vælgeren åbnes (højst hvert halve minut).
  const openMaal = useCallback((ep: EpisodeRow) => {
    setMaalFor(ep)
    if (Date.now() - maalHentet.current < 30_000) return
    setMaalHenter(true)
    tvMaal()
      .then((r) => {
        maalHentet.current = Date.now()
        setMaalListe(r.maal.length ? r.maal : [STUEN])
        setTvReach('ok')
      })
      .catch((e) => {
        if (e instanceof TvUnreachable) setTvReach('ude')
      })
      .finally(() => setMaalHenter(false))
  }, [])

  // En video fra disken på tv'et: Kodi spiller den, og Stuen åbnes med fjernbetjeningen.
  const playVideoOnTv = useCallback(
    async (v: TvVideo) => {
      try {
        await tvAfspil(v.sti)
      } catch (e) {
        showToast(
          e instanceof TvUnreachable
            ? "Tv'et kan kun nås hjemme på wifi'en"
            : `Kunne ikke starte afspilningen${e instanceof Error && e.message ? ': ' + e.message : ''}`,
        )
        return
      }
      setOpenEpisode(null)
      showToast("Sendt til tv'et — det tænder af sig selv")
      openStuen()
    },
    [showToast, openStuen],
  )

  // Og på telefonen: i app'en (3.1) åbner den telefonens egen afspiller (Kodi, VLC …) med
  // adressen på HTPC; i en browser er det et rigtigt link (window.open blokeres i en PWA).
  const phoneVideo = (v: TvVideo, cls: string, kort = false) =>
    !v.url ? null : host?.aabnVideo ? (
      <button
        className={cls}
        onClick={() => {
          if (!aabnVideoIApp(v.url!, v.titel, v.type || 'video/*')) showToast('Kunne ikke åbne en afspiller')
        }}
      >
        <IkonTelefon size={kort ? 16 : 18} /> {kort ? 'Telefon' : 'Afspil på telefonen'}
      </button>
    ) : (
      <a className={cls} href={v.url} target="_blank" rel="noopener">
        <IkonTelefon size={kort ? 16 : 18} /> {kort ? (inAndroidApp ? 'Telefon' : 'Her') : inAndroidApp ? 'Afspil på telefonen' : 'Afspil her'}
      </a>
    )

  // ---------- hitlister ----------
  // Hitliste-opslag: normaliseret titel -> placering. Apple giver ingen fælles id'er
  // på afsnits-listen (kun navn + vært), så titel er det eneste vi kan matche på.
  const showRankByName = useMemo(() => {
    const m = new Map<string, number>()
    for (const s2 of chartShows) m.set(s2.norm, s2.rank)
    return m
  }, [chartShows])
  const showRankByItunes = useMemo(() => {
    const m = new Map<string, number>()
    for (const s2 of chartShows) if (s2.itunesId) m.set(s2.itunesId, s2.rank)
    return m
  }, [chartShows])
  const episodeRankByName = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of chartEpisodes) m.set(e.norm, e.rank)
    return m
  }, [chartEpisodes])

  const rankForPodcast = useCallback(
    (title?: string, itunesId?: string) =>
      (itunesId ? showRankByItunes.get(itunesId) : undefined) ??
      (title ? showRankByName.get(chartNorm(title)) : undefined),
    [showRankByItunes, showRankByName],
  )
  const rankForEpisode = useCallback(
    (title?: string) => (title ? episodeRankByName.get(chartNorm(title)) : undefined),
    [episodeRankByName],
  )

  // Køen + torrents i én kronologi. Torrents er højst 50 og kommer fra deres eget kald.
  // Et DR TV-afsnit, som HTPC også har hentet som video, kom to gange: som afsnit fra favoritten
  // og som "torrent" fra tick.py (hash = sha1('drtv:' + DR's nummer)). Kun afsnittet vises; dets
  // pop-up spiller videoen på tv'et eller telefonen.
  const [drHashes, setDrHashes] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const numre = [...new Set(queue.map(drtvNummer).filter((x): x is string => !!x))]
    if (!numre.length || !window.crypto?.subtle) return
    let stop = false
    Promise.all(numre.map((n) => sha1Hex('drtv:' + n)))
      .then((h) => {
        if (!stop) setDrHashes(new Set(h))
      })
      .catch(() => {})
    return () => {
      stop = true
    }
  }, [queue])
  const fullQueue = useMemo(() => {
    const t = torrents.filter((x) => !x.hash || !drHashes.has(x.hash))
    return t.length ? [...queue, ...t].sort((a, b) => b.publishedAt - a.publishedAt) : queue
  }, [queue, torrents, drHashes])
  const fullQueueRef = useRef<EpisodeRow[]>(fullQueue)
  useEffect(() => {
    fullQueueRef.current = fullQueue
  }, [fullQueue])

  // Det, appen har sendt til tv'et eller en højttaler, som det stod ved seneste status.
  const fjernNu: TvFjern | null = useMemo(() => {
    if (!tvSession || !tvStat) return null
    const f = tvStat.fjern
    if (f && f.podcast?.episodeId === tvSession.episodeId) return f
    const sp = tvStat.kodi?.spiller // tv-helper fra før 2026-11-17 havde kun den
    if (f === undefined && sp?.podcast?.episodeId === tvSession.episodeId)
      return { maal: 'stuen', navn: "Tv'et i stuen", titel: sp.titel, podcast: sp.podcast, spiller: true, pause: sp.pause, tid: sp.tid, laengde: sp.laengde, slut: false }
    return null
  }, [tvSession, tvStat])
  // (tiden måles fra statussens hentetidspunkt, ikke Date.now() — render skal være ren)
  const fjernStarter = !!tvSession && !fjernNu?.spiller && jobIGang(tvStat) && tvStatAt - tvSession.startedAt < 120_000

  const fjernKontrol = useCallback(
    async (handling: string, ekstra: Record<string, unknown> = {}) => {
      try {
        await tvFjern(handling, ekstra)
      } catch (e) {
        showToast(e instanceof TvUnreachable ? "Det kan kun styres hjemme på wifi'en" : 'Det svarede ikke')
      }
      pollTvSoon(400)
    },
    [showToast, pollTvSoon],
  )

  // "Fortsæt på telefonen": stop det dér, og spil videre her fra samme sted.
  const takeBack = useCallback(async () => {
    const sess = tvSessionRef.current
    if (!sess) return
    const pos = Math.floor(fjernNu?.tid ?? lastTvPos.current?.pos ?? 0)
    try {
      await tvFjern('stop')
    } catch {
      /* ude af huset eller allerede stoppet — vi spiller videre her alligevel */
    }
    setTvSession(null)
    lastTvPos.current = null
    setFjernOpen(false)
    const ep =
      fullQueueRef.current.find((e) => e.episodeId === sess.episodeId) ||
      ({ feedId: sess.feedId, episodeId: sess.episodeId, title: sess.title, audioUrl: sess.url, durationSec: sess.durationSec, positionSec: pos, image: sess.image } as EpisodeRow)
    if (pos > 0) persistState({ episodeId: ep.episodeId, feedId: ep.feedId, positionSec: pos, durationSec: ep.durationSec || sess.durationSec }).catch(() => {})
    const el = audioRef.current
    if (currentRef.current?.episodeId === ep.episodeId && el?.getAttribute('src')) {
      el.currentTime = pos
      setCurTime(pos)
      resume('tv')
    } else {
      playEpisode({ ...ep, positionSec: pos })
    }
  }, [fjernNu, persistState, resume, playEpisode])

  // Et tryk på en notifikation om et nyt afsnit (Android-app'en fra 3.1): app'en husker afsnittet,
  // og siden tager det, når køen har det — også når app'en blev startet af trykket.
  const ventende = useRef<{ id: number; afspil: boolean; tid: number } | null>(null)
  const tagVentende = useCallback(() => {
    try {
      const raw = host?.ventendeAfsnit?.()
      if (raw) {
        const d = JSON.parse(raw) as { id?: unknown; afspil?: unknown }
        if (Number(d.id)) ventende.current = { id: Number(d.id), afspil: !!d.afspil, tid: Date.now() }
      }
    } catch {
      /* ældre app eller et ugyldigt svar */
    }
    const v = ventende.current
    if (!v) return false
    if (Date.now() - v.tid > 120_000) {
      ventende.current = null
      return false
    }
    const ep = fullQueueRef.current.find((e) => e.episodeId === v.id)
    if (!ep) return true // ikke i køen endnu — prøv igen, når den er hentet
    ventende.current = null
    setTab('queue')
    if (v.afspil && ep.audioUrl) playEpisode(ep)
    else showEpisode(ep)
    return false
  }, [playEpisode, showEpisode])
  useEffect(() => {
    const paa = () => {
      if (tagVentende()) refreshAll(true)
    }
    window.addEventListener('dkpod:afsnit', paa)
    return () => window.removeEventListener('dkpod:afsnit', paa)
  }, [tagVentende, refreshAll])
  useEffect(() => {
    if (queueLoaded) tagVentende()
  }, [fullQueue, queueLoaded, tagVentende])
  const unheardCount = fullQueue.filter((e) => !e.playedAt).length
  // Filteret skærer kun i det der VISES; tælleren i toppen og badget på fanen bliver ved med at
  // gælde hele køen, så et tændt filter ikke ser ud som om afsnittene er forsvundet.
  // Inden for hver gruppe er det "en af disse" (★★ + ★★★ = alt med mindst to; Podcast + TV =
  // alt undtagen torrents), og grupperne skal begge passe. Torrents tæller med Torrent-kortets
  // stjerner (de har ét fælles antal, ikke ét pr. torrent).
  const starsOf = useCallback(
    (e: EpisodeRow) => (e.kind === 'torrent' ? torrentStars : starLevel(e.feedId)),
    [torrentStars, starLevel],
  )
  const filterOn = starFilter.length > 0 || catFilter.length > 0
  const categoryOf = useCallback(
    (e: EpisodeRow): Category =>
      e.kind === 'torrent' ? 'torrent' : tvIds.has(e.feedId) || isTvEpisode(e) ? 'tv' : 'podcast',
    [tvIds],
  )
  const shownQueue = useMemo(
    () =>
      filterOn
        ? fullQueue.filter(
            (e) =>
              (starFilter.length === 0 || starFilter.includes(Math.max(1, starsOf(e)))) &&
              (catFilter.length === 0 || catFilter.includes(categoryOf(e))),
          )
        : fullQueue,
    [fullQueue, filterOn, starFilter, catFilter, starsOf, categoryOf],
  )
  const shownUnheard = filterOn ? shownQueue.filter((e) => !e.playedAt).length : unheardCount
  const toggleStarFilter = (n: number) =>
    setStarFilter((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n].sort()))
  const askPin = () => {
    setTab('queue')
    setPinOpen(true)
    setPinErr('')
  }
  const toggleCat = (c: Category) => {
    if (c === 'torrent' && !torrentToken) {
      setPinOpen((v) => !v)
      setPinErr('')
      return
    }
    setCatFilter((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))
  }

  // Er stuen til at nå (eller har vi ikke spurgt endnu)? Så vises "På tv'et"-knapperne.
  const tvUsable = online && tvReach !== 'ude'
  const tvKnapForPodcast = tvUsable && (tvReach === 'ok' || loadPref('stuenBrugt', false))

  // ---------- Udforsk-blokke ----------
  // Bygges her, fordi rækkefølgen skifter: uden søgning står hitlisten øverst (den er
  // "forsiden" af Udforsk), men så snart man har søgt, skal træfferne være det første man ser.
  const chartList = (
    <ol className="chartlist">
      {chartShows.map((s2) => (
        <li key={s2.itunesId || s2.rank}>
          <button
            className="chart-item"
            // slå op i Podcast Index på titlen, så den kan åbnes/følges som alle andre
            onClick={() => { setTab('explore'); runSearchFor(s2.name) }}
            title={`Nr. ${s2.rank} i Danmark — tryk for at finde den`}
          >
            <span className="chart-rank">{s2.rank}</span>
            {s2.artwork ? <img src={s2.artwork} alt="" loading="lazy" /> : <span className="noimg" />}
            <span className="chart-text">
              <strong>{s2.name}</strong>
              <span>{s2.artist}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  )

  const chartsOpen = chartShows.length > 0 && (
    <div className="charts">
      <div className="charts-head">
        <h3>🇩🇰 Mest populære i Danmark lige nu</h3>
        <span className="muted">Apples top 50 · opdateres dagligt</span>
      </div>
      {chartList}
    </div>
  )

  // Under en søgning er hitlisten ikke det man leder efter — den foldes sammen, så den ikke
  // fylder 50 rækker under resultaterne, men stadig kan åbnes.
  const chartsFolded = chartShows.length > 0 && (
    <details className="charts charts-fold">
      <summary>🇩🇰 Mest populære i Danmark lige nu <span className="muted">· Apples top 50</span></summary>
      {chartList}
    </details>
  )

  const searchResults = (
    <div className="results">
      {searchedFor && (
        <div className="results-head">
          <h3>
            {exploreBusy
              ? 'Søger…'
              : `${orderedResults.length} ${orderedResults.length === 1 ? 'træffer' : 'træffere'} for “${searchedFor}”`}
          </h3>
          <button className="ghost" onClick={clearSearch} disabled={exploreBusy}>✕ Ryd søgning</button>
        </div>
      )}
      {searchedFor && !exploreBusy && orderedResults.length === 0 && (
        <p className="muted">
          Ingen podcasts matchede “{searchedFor}”
          {langMode === 'da-only' ? ' på dansk — prøv “Alle sprog” i menuen ved søgefeltet.' : '.'}
        </p>
      )}
      <div className="grid">
        {orderedResults.map((p) => (
          <PodcastCard
            key={p.id}
            podcast={p}
            level={starLevel(p.id)}
            chartRank={rankForPodcast(p.title)}
            onStars={(n) => setStars(p, n)}
            onDelete={() => deleteFavorite(p)}
            onOpen={() => openDetail(p)}
          />
        ))}
      </div>
    </div>
  )

  const episodeItem = (ep: EpisodeRow, stars: number, downloaded: boolean) => (
    <EpisodeItem
      key={ep.episodeId}
      ep={ep}
      stars={stars}
      isCurrent={current?.episodeId === ep.episodeId}
      isPlaying={playing && current?.episodeId === ep.episodeId}
      liveTime={current?.episodeId === ep.episodeId ? curTime : undefined}
      chartRank={rankForEpisode(ep.title)}
      canDownload={canDownload}
      downloaded={downloaded}
      dl={dlState[ep.episodeId] || 'idle'}
      offline={!online}
      onPlay={() => playEpisode(ep)}
      onToggleHeard={() => markHeard(ep, !ep.playedAt)}
      onInfo={() => showEpisode(ep)}
      onDownload={() => startDownload(ep)}
      onRemoveDownload={() => dropDownload(ep)}
    />
  )

  const tabsDef: { key: Tab; label: string; icon: ReactNode; badge?: number }[] = [
    { key: 'queue', label: 'Kø', icon: <IkonKoe />, badge: unheardCount },
    { key: 'favorites', label: 'Favoritter', icon: <IkonStjerne /> },
    ...(canDownload ? [{ key: 'downloads' as Tab, label: 'Hentet', icon: <IkonHentet />, badge: downloads.length }] : []),
    { key: 'explore', label: 'Udforsk', icon: <IkonUdforsk /> },
    { key: 'stuen', label: 'Stuen', icon: <IkonTv /> },
    // Sonos og radioen i stuen — Allans genveje fra BOOK6 (sonos-tray), 2026-11-17
    { key: 'lyd', label: 'Lyd', icon: <IkonHoejttaler /> },
  ]

  // Opslaget på HTPC for netop det afsnit, pop-up'en viser (video: torrent eller DR TV)
  const videoNu = video && openEpisode && video.id === openEpisode.episodeId ? video : null

  // ---------- render ----------
  return (
    <div className={`app ${current ? 'med-spiller' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <p className="kicker">Alle dine danske podcasts ét sted</p>
          <h1>All DK Podcasts</h1>
        </div>
        <div className="top-stats">
          <span className="stat"><b>{unheardCount}</b> uhørte</span>
          <span className="stat"><b>{favorites.length}</b> favoritter</span>
        </div>
      </header>

      <nav className="tabs" aria-label="Faner">
        {tabsDef.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => selectTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}>
            <span className="tab-ikon">{t.icon}</span>
            <span className="tab-tekst">{t.label}</span>
            {!!t.badge && <em>{t.badge > 999 ? '999+' : t.badge}</em>}
          </button>
        ))}
      </nav>

      {appOutdated && (
        <p className="banner update">
          📲{' '}
          <span>
            <strong>Ny udgave af app'en ({LATEST_APK}):</strong> video fra HTPC på telefonen, besked om nye afsnit med ★★★, og
            fremover siger den selv til, når der er en ny.
          </span>
          {kanOpdatereSelv ? (
            <button className="banner-btn" onClick={() => host?.opdater?.()}>Opdatér</button>
          ) : (
            <a className="banner-btn" href={APK_URL} target="_blank" rel="noopener">Hent den</a>
          )}
          {!kanOpdatereSelv && <span className="banner-note">Sker der intet, så åbn aogj.com/podcast/app/alldkpodcasts.apk i Chrome.</span>}
        </p>
      )}
      {newVersion && (
        <p className="banner fresh">
          ✨ <span>Der er en ny udgave af siden.</span>
          <button className="banner-btn" onClick={() => { savePositionNow(); window.location.reload() }}>Genindlæs</button>
        </p>
      )}
      {!online && (
        <p className="offline-banner">
          ✈️ <strong>Offline</strong> — du kan afspille de {downloads.length} hentede afsnit.
          {pending > 0 && ` Lytning på ${pending} afsnit sendes til serveren når du får forbindelse igen.`}
        </p>
      )}
      {online && pending > 0 && <p className="offline-banner sync">↻ Sender lytning på {pending} afsnit…</p>}
      {dlError && (
        <p className="error dl-error">
          {dlError}
          <button className="ghost" onClick={() => setDlError('')}>Luk</button>
        </p>
      )}

      {tab === 'explore' && (
        <section className="panel">
          <div className="searchbar">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder="Søg podcast eller vært"
              enterKeyHint="search"
            />
            <select value={langMode} onChange={(e) => setLangMode(e.target.value as LangMode)}>
              <option value="da-first">Dansk først</option>
              <option value="da-only">Kun dansk</option>
              <option value="all">Alle sprog</option>
            </select>
            <button className="primary" onClick={runSearch} disabled={exploreBusy}>
              {exploreBusy ? '…' : 'Søg'}
            </button>
          </div>
          <div className="urlbar">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addByUrl()}
              placeholder="…eller indsæt RSS-, Podimo-, DR TV- eller Viaplay-URL"
            />
            <button onClick={addByUrl} disabled={exploreBusy}>
              Tilføj
            </button>
          </div>
          {exploreErr && <p className="error">{exploreErr}</p>}

          {/* Rækkefølgen afhænger af om man har søgt: har man, står træfferne ØVERST og
              hitlisten foldes sammen nedenunder. Før lå top-50-listen altid først, så et
              søgeresultat landede langt nede på siden — man kunne ikke se hvad man fandt. */}
          {searchedFor ? (
            <>
              {searchResults}
              {chartsFolded}
            </>
          ) : (
            <>
              {chartsOpen}
              {searchResults}
            </>
          )}
        </section>
      )}

      {tab === 'favorites' && (
        <section className="panel">
          {favorites.length === 0 && <p className="muted">Ingen favoritter endnu — find nogle under Udforsk og giv dem en, to eller tre stjerner.</p>}
          <div className="grid">
            {favorites.map((f) => (
              <PodcastCard
                key={f.feedId}
                podcast={favoriteAsPodcast(f)}
                level={starLevel(f.feedId)}
                chartRank={rankForPodcast(f.title)}
                onStars={(n) => setStars(favoriteAsPodcast(f), n)}
                onDelete={() => deleteFavorite(favoriteAsPodcast(f))}
                onOpen={() => openDetail(f)}
              />
            ))}
            {/* Torrent: fast kort ALLERNEDERST (2026-11-17, før øverst og kun med koden). Stjerner
                som en podcast — de gælder alle torrents i køen og dermed filteret — men intet Slet;
                den kan ikke fjernes. Uden koden er kortet låst, og et tryk beder om koden. */}
            <PodcastCard
              podcast={{
                id: TORRENT_FEED_ID,
                title: 'Torrent',
                author: torrentToken ? 'Alt hvad HTPC har hentet' : '🔒 Låst — tryk for at taste koden',
              }}
              icon="🧲"
              fixed
              level={torrentToken ? torrentStars : 0}
              onStars={torrentToken ? changeTorrentStars : askPin}
              onDelete={() => {}}
              onOpen={
                torrentToken
                  ? () => {
                      setStarFilter([])
                      setCatFilter(['torrent'])
                      setTab('queue')
                    }
                  : askPin
              }
            />
          </div>
        </section>
      )}

      {tab === 'queue' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Nyeste afsnit</h2>
              <p className="panel-sub">
                {filterOn ? `Viser ${shownQueue.length} af ${fullQueue.length} · ${shownUnheard} uhørte` : `${unheardCount} uhørte`}
                {lastRefresh > 0 && ` · opdateret kl. ${fmtTime(lastRefresh / 1000)}`}
              </p>
            </div>
            <div className="head-actions">
              <button
                className={`ghost refresh ${loadingQueue || checkingFeeds ? 'busy' : ''}`}
                onClick={() => refreshAll(true)}
                disabled={loadingQueue || checkingFeeds}
                title="Hent nye afsnit nu"
              >
                <IkonOpdater /> {loadingQueue || checkingFeeds ? 'Opdaterer…' : 'Opdatér'}
              </button>
            </div>
          </div>

          {/* Filter: ★/★★/★★★ og 🎙 Podcast/📺 TV/🧲 Torrent. Symbolerne ER mærkaterne — de samme
              som på rækkerne og kortene. Inden for hver gruppe kan flere tændes sammen (★★ + ★★★
              = alt med mindst to; Podcast + TV = alt undtagen torrents). Torrent beder om
              PIN-koden første gang på en enhed. Valget huskes på enheden. */}
          {favorites.length > 0 && (
            <div className="qfilter" role="group" aria-label="Filtrér køen">
              {[1, 2, 3].map((n) => {
                const on = starFilter.includes(n)
                const label = n === 1 ? '1 stjerne' : `${n} stjerner`
                return (
                  <button
                    key={n}
                    className={`qchip stars ${on ? 'on' : ''}`}
                    onClick={() => toggleStarFilter(n)}
                    title={on ? `Skjul podcasts med ${label} igen` : `Vis afsnit fra podcasts med ${label}`}
                    aria-pressed={on}
                    aria-label={label}
                  >
                    {'★'.repeat(n)}
                  </button>
                )
              })}
              <span className="qsep" aria-hidden="true" />
              {CATEGORIES.map((c) => {
                const on = catFilter.includes(c.key)
                const locked = c.key === 'torrent' && !torrentToken
                return (
                  <button
                    key={c.key}
                    className={`qchip cat-${c.key} ${on ? 'on' : ''}`}
                    onClick={() => toggleCat(c.key)}
                    title={locked ? 'Kræver koden — tryk for at låse op' : on ? `Skjul ${c.title} igen` : `Vis ${c.title}`}
                    aria-pressed={on}
                  >
                    {c.label}
                    {locked && ' 🔒'}
                  </button>
                )
              })}
              {filterOn && (
                <button className="qchip clear" onClick={() => { setStarFilter([]); setCatFilter([]) }}>
                  Vis alle
                </button>
              )}
            </div>
          )}
          {pinOpen && (
            <form className="pinbox" onSubmit={submitPin}>
              <label htmlFor="torrent-pin">🔒 Torrents vises kun med koden</label>
              <input
                id="torrent-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={12}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                autoFocus
              />
              <button className="primary" type="submit" disabled={pinBusy || !pin}>
                {pinBusy ? '…' : 'Lås op'}
              </button>
              <button className="ghost" type="button" onClick={() => { setPinOpen(false); setPin(''); setPinErr('') }}>
                Annullér
              </button>
              {pinErr && <p className="error">{pinErr}</p>}
            </form>
          )}

          {/* Spinner OVER listen: cachen er allerede tegnet, det her er kun feed-tjekket. */}
          {checkingFeeds && (
            <p className="feedcheck">
              <span className="spinner" aria-hidden="true" /> Søger efter nye afsnit…
            </p>
          )}

          {!queueLoaded && <p className="muted">Henter køen…</p>}
          {queueLoaded && favorites.length === 0 && <p className="muted">Følg nogle podcasts, så samler vi de nyeste afsnit her.</p>}
          {queueLoaded && favorites.length > 0 && !filterOn && unheardCount === 0 && !checkingFeeds && <p className="muted">Alt er hørt 🎉</p>}
          {queueLoaded && filterOn && shownQueue.length === 0 && (
            <p className="muted">Ingen afsnit i køen passer til filteret lige nu — tryk “Vis alle” for at se hele køen.</p>
          )}

          {/* Hele kronologien vises — også de HØRTE afsnit (2026-08-21). De forsvandt før ud af
              listen, så man mistede overblikket over hvad man havde lyttet til; nu bliver de
              liggende på deres plads og er tonet ned med et "✓ Hørt"-mærkat (`.episode.heard`).
              Afsnit man er midt i markeres på samme måde med `.episode.continuing`, og afsnit fra
              en podcast med ★★ eller ★★★ med `.episode.super` + stjernerne. Ingen af dem flytter
              sig i listen — det eneste der kan ændre hvad der står her, er filteret øverst. */}
          {groupByDay(shownQueue).map((g) => (
            <div className="daygroup" key={g.key}>
              <div className="day-head">
                <h3>
                  {g.label}
                  {g.episodes.some((e) => e.playedAt) && (
                    <span className="day-count">
                      {g.episodes.filter((e) => !e.playedAt).length} af {g.episodes.length} uhørte
                    </span>
                  )}
                </h3>
              </div>
              <ul className="episodes">
                {g.episodes.map((ep) => episodeItem(ep, starsOf(ep), dlIds.has(ep.episodeId)))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {tab === 'downloads' && (
        <section className="panel">
          <div className="panel-head">
            <h2>Hentet til offline</h2>
            {downloads.length > 0 && (
              <button className="ghost" onClick={clearAllDownloads}>Slet alle</button>
            )}
          </div>

          {/* Bulk-hentningen lå øverst i køen indtil 2026-11-17 — den bruges sjældent, så her. */}
          {canDownload && (
            <div className="bulkbar">
              <span className="bulk-text">⬇ Hent de næste uhørte</span>
              {bulk ? (
                <span className="bulk-actions">
                  <span className="bulk-progress">
                    <span className="spinner" aria-hidden="true" /> Henter {Math.min(bulk.done + 1, bulk.total)} af {bulk.total}…
                  </span>
                  <button className="ghost" onClick={() => { cancelBulk.current = true }}>Stop</button>
                </span>
              ) : (
                <span className="bulk-actions">
                  {[5, 10, 20].map((n) => (
                    <button key={n} className="ghost" disabled={!online} onClick={() => downloadNext(n)}>
                      {n}
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}


          {storage && (
            <div className="storage">
              <div className="storage-track">
                <span className="storage-fill" style={{ width: `${Math.min(100, (storage.usage / (storage.quota || 1)) * 100)}%` }} />
              </div>
              <p className="muted storage-text">
                {fmtBytes(storage.usage)} brugt · {fmtBytes(Math.max(0, storage.quota - storage.usage))} ledigt til app'en
              </p>
            </div>
          )}

          {downloads.length === 0 ? (
            <p className="muted">
              Ingen hentede afsnit endnu. Tryk ⬇ på et afsnit i køen — eller brug “Hent 5/10/20”
              øverst i Kø-fanen inden du kører et sted hen uden dækning.
            </p>
          ) : (
            <ul className="episodes">
              {downloads.map((d) => episodeItem(d.ep, starLevel(d.ep.feedId), true))}
            </ul>
          )}
        </section>
      )}

      {tab === 'stuen' && (
        <Stuen
          aktiv={tab === 'stuen'}
          status={tvStat}
          naas={tvReach}
          mappe={stuenMappe}
          setMappe={setStuenMappe}
          pollSnart={pollTvSoon}
        />
      )}

      {tab === 'lyd' && <Lyd aktiv />}

      {openPodcast && (
        <div className="modal" onClick={() => setOpenPodcast(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setOpenPodcast(null)} aria-label="Luk">
              ✕
            </button>
            <div className="show-head">
              {(openPodcastInfo?.image || ('image' in openPodcast && openPodcast.image)) && (
                <img className="show-cover" src={openPodcastInfo?.image || ('image' in openPodcast ? openPodcast.image : '')} alt="" />
              )}
              <div>
                <h2>{'title' in openPodcast ? openPodcast.title : ''}</h2>
                {openPodcastInfo?.author && <p className="show-author">{openPodcastInfo.author}</p>}
                {openPodcastInfo?.categories && openPodcastInfo.categories.length > 0 && (
                  <p className="show-cats">{openPodcastInfo.categories.slice(0, 4).join(' · ')}</p>
                )}
              </div>
            </div>
            {openPodcastInfo?.description && (
              <div className="show-desc" dangerouslySetInnerHTML={{ __html: openPodcastInfo.description }} />
            )}
            {openPodcastInfo?.url && (
              <a className="show-link" href={openPodcastInfo.url} target="_blank" rel="noopener">Podcastens hjemmeside ↗</a>
            )}
            <h3 className="section-label">Afsnit</h3>
            {detailBusy ? (
              <p className="muted">Henter afsnit…</p>
            ) : (
              <ul className="episodes">
                {detailEpisodes.map((ep) => episodeItem(ep, starLevel(ep.feedId), dlIds.has(ep.episodeId)))}
              </ul>
            )}
          </div>
        </div>
      )}

      {openEpisode && (
        <div className="modal" onClick={() => setOpenEpisode(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setOpenEpisode(null)} aria-label="Luk">✕</button>
            <div className="show-head">
              {(openEpisode.image || openEpisode.podcastImage) && (
                <img className="show-cover" src={openEpisode.image || openEpisode.podcastImage} alt="" />
              )}
              <div>
                <h2>{openEpisode.title}</h2>
                <p className="show-author">
                  {openEpisode.podcastTitle ? openEpisode.podcastTitle + ' · ' : ''}
                  {fmtDate(openEpisode.publishedAt)}{openEpisode.publishedAt ? ' kl. ' + fmtTime(openEpisode.publishedAt) : ''}
                  {openEpisode.durationSec ? ' · ' + fmtDur(openEpisode.durationSec) : ''}
                </p>
              </div>
            </div>
            {openEpisode.audioUrl && playErrorId !== openEpisode.episodeId ? (
              <div className="ep-actions">
                <button className="primary" onClick={() => { playEpisode(openEpisode); setOpenEpisode(null) }}>▶ Afspil</button>
                {tvKnapForPodcast && (
                  <button className="ghost tv" onClick={() => openMaal(openEpisode)} title="Spil afsnittet på tv'et eller en højttaler">
                    <IkonCast size={16} /> Afspil på …
                  </button>
                )}
                <button className="ghost" onClick={() => { markHeard(openEpisode, !openEpisode.playedAt); setOpenEpisode({ ...openEpisode, playedAt: openEpisode.playedAt ? null : new Date().toISOString() }) }}>
                  {openEpisode.playedAt ? '↺ Markér uhørt' : '✓ Markér hørt'}
                </button>
              </div>
            ) : openEpisode.kind === 'torrent' || (drtvNummer(openEpisode) && playErrorId !== openEpisode.episodeId) ? (
              // Video fra HTPC: torrents og de DR TV-afsnit, HTPC har hentet. Samme valg for begge.
              <div className="linkout video">
                <p className="linkout-msg">
                  {openEpisode.kind === 'torrent' ? (
                    <>🧲 Hentet på HTPC{openEpisode.sizeBytes ? ` (${fmtBytes(openEpisode.sizeBytes)})` : ''}. </>
                  ) : (
                    <>📺 Et <strong>TV-program</strong> fra DR. </>
                  )}
                  {videoNu?.tilstand === 'henter' && 'Leder efter den på HTPC …'}
                  {videoNu?.tilstand === 'ude' &&
                    (openEpisode.kind === 'torrent' ? "Den kan kun ses hjemme på wifi'en." : "HTPC's kopi kan kun ses hjemme på wifi'en — ellers hos DR TV:")}
                  {videoNu?.tilstand === 'ikke' &&
                    (openEpisode.kind === 'torrent'
                      ? 'Den ligger ikke på disken længere — den kan være ryddet væk.'
                      : 'HTPC har ikke hentet den (endnu), så den kan kun ses hos DR TV:')}
                  {videoNu?.tilstand === 'fundet' && (videoNu.fund?.filer ? 'Vælg afsnittet:' : "Se den på tv'et eller her.")}
                </p>
                {videoNu?.tilstand === 'fundet' && videoNu.fund && (
                  videoNu.fund.filer ? (
                    <ul className="video-filer">
                      {videoNu.fund.filer.map((v) => (
                        <li key={v.sti}>
                          <span className="video-navn">{v.titel}</span>
                          <button className="ghost tv" onClick={() => playVideoOnTv(v)} title="Afspil på tv'et i stuen">
                            <IkonTv size={16} /> Tv
                          </button>
                          {phoneVideo(v, 'ghost', true)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="video-valg">
                      {/* Videofilen, ikke mappen: fund.sti er torrentens mappe (17/11 sendte den mappen,
                          og tv'et svarede "ukendt fil") */}
                      <button className="linkout-btn" onClick={() => playVideoOnTv({ ...videoNu.fund!, sti: videoNu.fund!.afspil || videoNu.fund!.sti })}>
                        <IkonTv size={18} /> Afspil på tv'et
                      </button>
                      {phoneVideo(videoNu.fund, 'linkout-btn alt')}
                    </div>
                  )
                )}
                {openEpisode.linkUrl && (
                  <a className="linkout-btn dr" href={openEpisode.linkUrl} target="_blank" rel="noopener noreferrer">
                    ↗ Åbn i {sourceOf(openEpisode) || 'DR TV'}
                  </a>
                )}
                <button
                  className="ghost"
                  onClick={() => {
                    markHeard(openEpisode, !openEpisode.playedAt)
                    setOpenEpisode({ ...openEpisode, playedAt: openEpisode.playedAt ? null : new Date().toISOString() })
                  }}
                >
                  {openEpisode.playedAt ? '↺ Markér som ikke set' : '✓ Markér som set'}
                </button>
              </div>
            ) : (
              <div className="linkout">
                <p className="linkout-msg">
                  {openEpisode.kind === 'torrent'
                    ? <>🧲 Hentet med qBittorrent på HTPC{openEpisode.sizeBytes ? ` (${fmtBytes(openEpisode.sizeBytes)})` : ''} og ligger i <strong>/5TB_DISK/Torrents</strong>.</>
                    : playErrorId === openEpisode.episodeId
                    ? <>⚠️ Afsnittet kunne ikke afspilles i appen (ligger måske kun hos <strong>{sourceOf(openEpisode) || 'udbyderen'}</strong>). Prøv at åbne det direkte:</>
                    : isTvEpisode(openEpisode)
                      ? <>📺 Dette er et <strong>TV-program</strong> og kan ikke afspilles i appen. Se det hos {sourceOf(openEpisode) || 'udbyderen'}:</>
                      : <>🔒 Dette afsnit kan ikke afspilles inde i appen — det ligger bag <strong>{sourceOf(openEpisode) || 'udbyderen'}</strong>. Åbn det direkte hos udbyderen:</>}
                </p>
                {openEpisode.linkUrl ? (
                  <a className="linkout-btn" href={openEpisode.linkUrl} target="_blank" rel="noopener noreferrer">
                    ↗ Åbn hos {sourceOf(openEpisode) || 'udbyder'}
                  </a>
                ) : (
                  <p className="muted">Der er desværre ikke noget offentligt link til dette afsnit.</p>
                )}
                <button className="ghost" onClick={() => { markHeard(openEpisode, !openEpisode.playedAt); setOpenEpisode({ ...openEpisode, playedAt: openEpisode.playedAt ? null : new Date().toISOString() }) }}>
                  {openEpisode.kind === 'torrent'
                    ? openEpisode.playedAt ? '↺ Markér som ikke set' : '✓ Markér som set'
                    : openEpisode.playedAt ? '↺ Markér uhørt' : '✓ Markér som hørt'}
                </button>
              </div>
            )}
            {openEpisode.kind === 'torrent' ? null : openEpisode.description ? (
              <div className="show-desc" dangerouslySetInnerHTML={{ __html: openEpisode.description }} />
            ) : descBusy ? (
              <p className="muted">Henter beskrivelse…</p>
            ) : (
              <p className="muted">Ingen beskrivelse.</p>
            )}
          </div>
        </div>
      )}

      {/* Faste elementer nederst: en podcast på tv'et, afspilleren og korte beskeder. */}
      <div className="bund">
        {toast && <div className="toast" role="status">{toast}</div>}
        {/* En podcast på tv'et eller en højttaler: tryk for at styre den (pause, spol, lydstyrke,
            fortsæt på telefonen). I Stuen står tv'ets egen fjernbetjening i forvejen. */}
        {tvSession && (fjernNu?.spiller || fjernStarter) && !(tab === 'stuen' && (tvSession.maal || 'stuen') === 'stuen') && (
          <div className="fjernbjaelke">
            <button className="fjern-aabn" onClick={() => setFjernOpen(true)} title="Styr det, der spiller">
              {(tvSession.maal || 'stuen') === 'stuen' ? <IkonTv size={17} /> : <IkonCast size={17} />}
              <span className="fjern-tekst">
                <small>{fjernNu?.spiller ? `På ${tvSession.maalNavn || "tv'et"}` : `${tvStat?.job?.trin || 'Starter'} …`}</small>
                <b>{tvSession.title}</b>
              </span>
              {fjernNu?.spiller && (
                <span className="fjern-tid">
                  <FjernTid status={fjernNu} statusAt={tvStatAt} />
                </span>
              )}
            </button>
            {fjernNu?.spiller && (
              <button
                className="fjern-knap"
                onClick={() => fjernKontrol(fjernNu.pause ? 'play' : 'pause')}
                aria-label={fjernNu.pause ? 'Spil' : 'Pause'}
              >
                {fjernNu.pause ? <IkonPlay size={20} /> : <IkonPause size={20} />}
              </button>
            )}
          </div>
        )}
        {current && (
          <MiniSpiller
            ep={current}
            playing={playing}
            curTime={curTime}
            dur={dur}
            onToggle={togglePlay}
            onSkip={skip}
            onOpen={() => setSheetOpen(true)}
            sleepLeft={sleepLeft}
            rate={rate}
          />
        )}
      </div>

      {current && sheetOpen && (
        <FuldSpiller
          ep={current}
          playing={playing}
          curTime={curTime}
          dur={dur}
          onToggle={togglePlay}
          onSkip={skip}
          onSeekInput={onSeekInput}
          onSeekCommit={onSeekCommit}
          onCollapse={() => setSheetOpen(false)}
          onClosePlayer={() => closePlayer()}
          rate={rate}
          onRate={cycleRate}
          sleepLeft={sleepLeft}
          onSleep={cycleSleep}
          onCast={tvKnapForPodcast ? () => openMaal({ ...current, positionSec: curTime }) : undefined}
          onInfo={() => { setSheetOpen(false); showEpisode(current) }}
          meta={[current.podcastTitle, fmtDate(current.publishedAt), current.durationSec ? fmtDur(current.durationSec) : '']
            .filter(Boolean)
            .join(' · ')}
        />
      )}

      {maalFor && (
        <MaalVaelger
          titel={maalFor.title}
          maal={maalListe}
          henter={maalHenter}
          onTelefon={() => {
            const ep = maalFor
            setMaalFor(null)
            if (currentRef.current?.episodeId !== ep.episodeId) playEpisode(ep)
          }}
          onVaelg={(m) => playRemote(maalFor, m)}
          onLuk={() => setMaalFor(null)}
        />
      )}

      {fjernOpen && tvSession && (
        <FjernSpiller
          titel={tvSession.title}
          billede={tvSession.image}
          navn={tvSession.maalNavn || "Tv'et i stuen"}
          tv={(tvSession.maal || 'stuen') === 'stuen'}
          status={fjernNu}
          statusAt={tvStatAt}
          trin={fjernStarter ? tvStat?.job?.trin || 'Starter' : null}
          onKontrol={fjernKontrol}
          onTelefon={takeBack}
          onStuen={() => {
            setFjernOpen(false)
            openStuen()
          }}
          onLuk={() => setFjernOpen(false)}
        />
      )}

      <audio
        ref={audioRefCb}
        onEnded={() => {
          logg('lyd:slut', lydInfo(audioRef.current, currentRef.current))
          onEnded()
        }}
        onTimeUpdate={() => {
          onTimeUpdate()
          if (sleepUntil && Date.now() >= sleepUntil) {
            logg('sove', lydInfo(audioRef.current, currentRef.current))
            wantPlay.current = false
            audioRef.current?.pause()
            setSleepUntil(null)
            setSleepLeft(0)
          }
        }}
        onPlay={() => {
          logg('lyd:play', lydInfo(audioRef.current, currentRef.current))
          setPlaying(true)
          pauseFra.current = 0
          stopKeepAlive() // der spiller rigtig lyd nu — stilheden har gjort sit
          syncPositionState()
        }}
        onPlaying={() => {
          logg('lyd:spiller', {
            ...lydInfo(audioRef.current, currentRef.current),
            ventetMs: ventetFra.current ? Date.now() - ventetFra.current : undefined,
            forsoeg: forsoeg.current || undefined,
          })
          // Lyden spiller (igen): falder den ud senere, er det forbindelsen, ikke afsnittet.
          lydVirkede.current = currentRef.current?.episodeId || 0
          window.clearTimeout(forsoegTimer.current)
          forsoeg.current = 0
          fejlFra.current = 0
          ventetFra.current = 0
        }}
        onWaiting={() => {
          logg('lyd:venter', lydInfo(audioRef.current, currentRef.current))
          if (!ventetFra.current) ventetFra.current = Date.now()
        }}
        onStalled={() => logg('lyd:stalled', lydInfo(audioRef.current, currentRef.current))}
        onPause={() => {
          logg('lyd:pause', lydInfo(audioRef.current, currentRef.current))
          setPlaying(false)
          const el = audioRef.current
          // Slutningen af et afsnit er også en "pause" — der er intet at holde i live der.
          // Det samme gælder, når afspilleren lukkes (src fjernes).
          if (el && currentRef.current && !el.ended && !closing.current && el.getAttribute('src')) {
            pauseFra.current = Date.now()
            savePositionNow() // siden kan blive kasseret; gem positionen med det samme
            startKeepAlive() // hold afspilleren i notifikationsskuffen i 10 min. (ikke i Android-app'en)
          }
          syncPositionState()
        }}
        onError={() => {
          const el = audioRef.current
          const ep = currentRef.current
          if (!el || !ep?.audioUrl || closing.current || !el.getAttribute('src')) return
          const forbindelsen = lydVirkede.current === ep.episodeId || !navigator.onLine
          logg('lyd:fejl', {
            ...lydInfo(el, ep), besked: el.error?.message, host: vaertAf(ep.audioUrl),
            kurs: forbindelsen ? (wantPlay.current ? 'proev-igen' : 'paa-pause') : wantPlay.current ? 'kan-ikke' : 'stille',
          })
          // Har afsnittet spillet i denne omgang, eller er der intet net, er det forbindelsen, der er
          // gået tabt (dårlig dækning i bilen, en udløbet CDN-adresse), ikke afsnittet, der ikke kan
          // afspilles. Så hentes lyden forfra, når der er net igen (se lydDoed øverst i filen).
          if (forbindelsen) {
            if (!el.paused) el.pause() // ellers viser bilen og låseskærmen "spiller", mens den står stille
            if (!wantPlay.current) return // på pause: et tryk på afspil henter den forfra (resume)
            if (!fejlFra.current) fejlFra.current = Date.now()
            proevIgen(false, 'fejl')
            return
          }
          // lyd kunne ikke afspilles (fx DR app-only/geo) → vis link-out-pop-up. Kun hvis man
          // faktisk har bedt om lyd: et genskabt afsnit uden dækning skal ikke larme ved opstart.
          if (wantPlay.current) {
            setPlayErrorId(ep.episodeId)
            setPlaying(false)
            setOpenEpisode(ep)
          }
        }}
        onLoadedMetadata={() => {
          const el = audioRef.current
          const ep = currentRef.current
          if (ep) lydVirkede.current = ep.episodeId
          logg('lyd:metadata', { ...lydInfo(el, ep), dur: el && isFinite(el.duration) ? Math.round(el.duration) : undefined })
          if (el && ep && ep.positionSec && el.currentTime < 1) el.currentTime = ep.positionSec
          if (el && el.duration && isFinite(el.duration)) setDur(el.duration)
          syncPositionState()
        }}
      />
    </div>
  )
}

function PodcastCard({
  podcast,
  level,
  chartRank,
  icon,
  fixed,
  onStars,
  onDelete,
  onOpen,
}: {
  podcast: Podcast
  level: number // 0 = ikke fulgt, ellers 1-3 stjerner
  chartRank?: number // placering på Apples top-50 i Danmark
  icon?: string // i stedet for et billede (Torrent-kortet)
  fixed?: boolean // kan ikke fjernes: ingen Slet/Følg under stjernerne (Torrent-kortet)
  onStars: (n: number) => void
  onDelete: () => void
  onOpen: () => void
}) {
  // Slet kræver to tryk: første tryk gør knappen rød ("Slet?"), andet sletter. Svarer man ikke
  // inden 4 sek., falder den tilbage. Ikke window.confirm — den er ikke til at regne med i
  // Android-app'ens WebView.
  const [confirmDel, setConfirmDel] = useState(false)
  const delTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(delTimer.current), [])
  const del = () => {
    window.clearTimeout(delTimer.current)
    if (confirmDel) {
      setConfirmDel(false)
      onDelete()
      return
    }
    setConfirmDel(true)
    delTimer.current = window.setTimeout(() => setConfirmDel(false), 4000)
  }
  return (
    <div className={`card ${fixed ? 'fast' : ''}`}>
      <button className="card-main" onClick={onOpen}>
        {podcast.image ? (
          <img src={podcast.image} alt="" loading="lazy" />
        ) : (
          <div className={`noimg ${icon ? 'icon' : ''}`}>{icon}</div>
        )}
        <div className="card-text">
          <strong>{podcast.title}</strong>
          <span>{podcast.author}</span>
          <span className="card-tags">
            {podcast.kind === 'tv' && (
              <em className="tv" title="TV-program — kan ikke afspilles i appen, men afsnittene kommer i køen med link til udbyderen">
                📺 TV
              </em>
            )}
            {chartRank && (
              <em className="rank" title={`Nr. ${chartRank} på Apples top-50 i Danmark`}>
                #{chartRank} i DK
              </em>
            )}
            {isDanish(podcast.language) && <em className="da">Dansk</em>}
          </span>
        </div>
      </button>
      {/* Tre stjerner: tryk på den stjerne man vil op eller ned til. Et tryk følger podcasten,
          hvis man ikke gør det i forvejen — og fjerner den aldrig; det gør Slet nedenunder. */}
      <div className={`rate lvl-${level}`}>
        <div className="rate-stars" role="group" aria-label="Stjerner">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              className={`rate-star ${n <= level ? 'on' : ''}`}
              onClick={() => onStars(n)}
              aria-pressed={n === level}
              aria-label={n === 1 ? '1 stjerne' : `${n} stjerner`}
              title={
                level === 0
                  ? `Følg med ${n === 1 ? '1 stjerne' : `${n} stjerner`}`
                  : n === level
                    ? `${n === 1 ? '1 stjerne' : `${n} stjerner`} nu`
                    : `Skift til ${n === 1 ? '1 stjerne' : `${n} stjerner`}`
              }
            >
              {n <= level ? '★' : '☆'}
            </button>
          ))}
        </div>
        {fixed ? null : level > 0 ? (
          <button
            className={`rate-act del ${confirmDel ? 'confirm' : ''}`}
            onClick={del}
            title={confirmDel ? 'Tryk igen for at slette podcasten fra dine favoritter' : 'Slet podcasten fra dine favoritter'}
          >
            {confirmDel ? 'Slet?' : 'Slet'}
          </button>
        ) : (
          <button className="rate-act follow" onClick={() => onStars(1)} title="Følg med 1 stjerne">
            + Følg
          </button>
        )}
      </div>
    </div>
  )
}

function EpisodeItem({
  ep,
  stars,
  isCurrent,
  isPlaying,
  liveTime,
  chartRank,
  canDownload,
  downloaded,
  dl,
  offline,
  onPlay,
  onToggleHeard,
  onInfo,
  onDownload,
  onRemoveDownload,
}: {
  ep: EpisodeRow
  stars: number // podcastens stjerner (0 = ikke fulgt, ellers 1-3)
  isCurrent: boolean
  isPlaying: boolean
  liveTime?: number // sekunder for det afsnit der spiller lige nu (så bjælken bevæger sig)
  chartRank?: number // placering på Apples danske trending-afsnit-liste
  canDownload: boolean // browseren har Cache API + service worker
  downloaded: boolean
  dl: DlState
  offline: boolean
  onPlay: () => void
  onToggleHeard: () => void
  onInfo: () => void
  onDownload: () => void
  onRemoveDownload: () => void
}) {
  const heard = !!ep.playedAt
  const art = ep.image || ep.podcastImage
  const playable = !!ep.audioUrl
  // Torrents har hverken lyd eller link — de ligger på HTPC's disk og spilles på tv'et eller
  // telefonen. Udbyderen (Omny, Simplecast …) vises kun, når den betyder noget: når afsnittet
  // ikke kan spilles her og skal ses eller høres hos den (DR TV, Viaplay, Podimo).
  const torrent = ep.kind === 'torrent'
  const tv = isTvEpisode(ep)
  const source = torrent ? 'Torrent' : sourceOf(ep)
  const showSource = !torrent && !playable && !!source
  // "DR TV" -> src-dr-tv (mellemrum i en className ville blive til to klasser)
  const srcClass = 'src-' + source.toLowerCase().replace(/\s+/g, '-')
  // fremdrift: brug live-tiden for det aktuelle afsnit, ellers den gemte position
  const pos = isCurrent && liveTime != null ? liveTime : ep.positionSec || 0
  const total = ep.durationSec || 0
  // vis kun når man reelt er i gang (>30 sek. inde og ikke stort set færdig)
  const started = isInProgress(pos, total, heard)
  const pct = started ? Math.min(100, (pos / total) * 100) : 0
  const leftMin = Math.max(1, Math.round((total - pos) / 60))
  // ikke-afspillelig (Podimo/DR app-only) → åbn forklarings-pop-up (IKKE window.open,
  // som blokeres i installerede PWA'er på Android). Torrents → pop-up med "Afspil på tv'et".
  const activate = () => { if (playable) onPlay(); else onInfo() }
  // uden dækning og uden at være hentet kan afsnittet ikke spille — vis det frem for at love for meget
  const unreachable = offline && playable && !downloaded
  const busy = dl === 'busy' || dl === 'queued'
  // Markeringen (★★/★★★) gælder kun uhørte afsnit: pointen er "her er der kommet noget nyt du
  // ikke vil misse", og et hørt afsnit er allerede fanget. Én stjerne er en almindelig favorit.
  const superNew = stars >= 2 && !heard
  return (
    <li className={`episode ${heard ? 'heard' : ''} ${isCurrent ? 'current' : ''} ${started ? 'continuing' : ''} ${superNew ? `super s${stars}` : ''} ${unreachable ? 'unreachable' : ''}`}>
      <button
        className={`ep-thumb ${playable ? '' : 'link'} ${torrent || tv ? 'torrent' : ''}`}
        onClick={activate}
        title={
          playable
            ? 'Afspil'
            : torrent || tv
              ? "Video — tryk for at se den på tv'et eller telefonen"
              : `Kan ikke afspilles i appen — tryk for at åbne hos ${source || 'udbyder'}`
        }
      >
        {art ? <img src={art} alt="" loading="lazy" /> : <span className={`ep-noimg ${torrent ? 'torrent' : ''}`}>{torrent ? '🧲' : ''}</span>}
        <span className={`ep-badge ${isCurrent && isPlaying ? 'live' : ''}`}>
          {torrent || tv ? '📺' : !playable ? '↗' : isCurrent && isPlaying ? <span className="eq" aria-label="Spiller"><i /><i /><i /></span> : '▶'}
        </span>
      </button>
      <button className="ep-text" onClick={onInfo} title="Læs mere">
        {/* Hvilken podcast det er, står for sig selv øverst (2026-11-17): billedet på et afsnit er
            ofte ikke podcastens, så det var svært at se, hvad det var. */}
        <span className="ep-pod">{torrent ? '🧲 Torrent' : ep.podcastTitle || source}</span>
        <strong>{ep.title}</strong>
        {/* Mærkaterne brydes aldrig midt i ("#11 i DK", "DR TV", "Fortsætter" stod før på to linjer). */}
        <span className="ep-meta">
          {superNew && <em className="sup-chip" title={`Nyt afsnit fra en podcast med ${stars} stjerner`}>{'★'.repeat(stars)}</em>}
          {heard && (
            <em className="heard-chip" title="Markeret — tryk ✓ for at fjerne markeringen igen">
              {torrent || tv ? '✓ Set' : '✓ Hørt'}
            </em>
          )}
          {started && <em className="cont-chip" title="Du er i gang med dette afsnit">▶ Fortsætter</em>}
          {chartRank && (
            <em className="hot" title={`Nr. ${chartRank} på Apples trending-afsnit i Danmark lige nu`}>
              🔥 #{chartRank} i DK
            </em>
          )}
          {showSource && <em className={`src ${srcClass}`}>{tv ? '📺 ' : ''}{source}</em>}
          <span className="ep-when">
            {fmtDate(ep.publishedAt)}
            {ep.durationSec ? ' · ' + fmtDur(ep.durationSec) : ''}
            {torrent ? (ep.sizeBytes ? ' · ' + fmtBytes(ep.sizeBytes) : '') + ' · på HTPC' : !playable && !tv ? ' · kun hos udbyder' : ''}
          </span>
        </span>
        {started && (
          <span className="ep-progress" title={`${fmtClock(pos)} af ${fmtClock(total)}`}>
            <span className="ep-progress-track">
              <span className="ep-progress-fill" style={{ width: `${pct}%` }} />
            </span>
            <em className="ep-left">{leftMin} min tilbage</em>
          </span>
        )}
      </button>
      {canDownload && playable && (
        <button
          className={`dl-btn ${downloaded ? 'on' : ''} ${dl === 'error' ? 'err' : ''}`}
          onClick={downloaded ? onRemoveDownload : onDownload}
          disabled={busy}
          title={
            downloaded
              ? 'Hentet — kan afspilles uden dækning. Tryk for at slette den igen.'
              : dl === 'error'
                ? 'Hentning mislykkedes — tryk for at prøve igen'
                : 'Hent afsnittet så det kan afspilles uden dækning'
          }
          aria-label={downloaded ? 'Slet hentet afsnit' : 'Hent afsnit til offline'}
        >
          {dl === 'busy' ? <span className="spinner" aria-hidden="true" /> : dl === 'queued' ? '⋯' : dl === 'error' ? '↻' : '⬇'}
        </button>
      )}
      <button
        className={`heard-toggle ${heard ? 'on' : ''}`}
        onClick={onToggleHeard}
        title={torrent ? (heard ? 'Markér som ikke set' : 'Markér som set') : heard ? 'Markér som uhørt' : 'Markér som hørt'}
        aria-label={heard ? 'Markér som uhørt' : 'Markér som hørt'}
      >
        ✓
      </button>
    </li>
  )
}
