import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addFavorite,
  addPodimoShow,
  discover,
  episodeDescription,
  feedEpisodes,
  getCharts,
  getPodcast,
  listFavorites,
  newestEpisodes,
  refreshFeeds,
  removeFavorite,
  resolveUrl,
  search,
  setStateMany,
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
import type { ChartEpisode, ChartShow } from './lib/api'
import type { EpisodeRow, Favorite, Podcast } from './types'

type Tab = 'explore' | 'favorites' | 'queue' | 'downloads'
type DlState = 'idle' | 'queued' | 'busy' | 'done' | 'error'
type LangMode = 'da-first' | 'da-only' | 'all'

const isDanish = (lang?: string) => (lang || '').toLowerCase().startsWith('da')

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
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

// "i gang med": mere end 30 sek. inde, men ikke stort set færdig. Bruges både af
// Fortsætter-sektionen og af fremdriftsbjælken, så de aldrig kan komme ud af trit.
function isInProgress(pos: number, total: number, heard: boolean): boolean {
  return !heard && total > 0 && pos > 30 && pos < total * 0.99
}
// klokke-format til progress-bar: mm:ss eller t:mm:ss
function fmtClock(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  sec = Math.floor(sec)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`
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
]
// TV-afsnit kendes på link-URL'en (dr.dk/drtv/...) — de har aldrig lyd i appen.
function isTvEpisode(ep: EpisodeRow): boolean {
  return (ep.linkUrl || '').includes('/drtv/')
}
function sourceOf(ep: EpisodeRow): string {
  if (isTvEpisode(ep)) return 'DR TV'
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
// så en fulgt DR TV-serie også er mærket i Favoritter.
function favoriteAsPodcast(f: Favorite): Podcast {
  return {
    id: f.feedId,
    title: f.title,
    image: f.image,
    author: f.author,
    language: f.language,
    feedUrl: f.feedUrl,
    kind: f.addedVia === 'drtv' || (f.feedUrl || '').includes('/drtv/') ? 'tv' : undefined,
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

export default function App() {
  const deviceId = useMemo(getDeviceId, [])
  const [tab, setTab] = useState<Tab>('queue')

  // data — startværdien er sidste øjebliksbillede, så app'en har indhold med det samme og
  // også kan åbnes helt uden dækning. Netværkssvaret overskriver det når det kommer.
  const [favorites, setFavorites] = useState<Favorite[]>(() => readSnapshot<Favorite[]>('favorites') || [])
  const favIds = useMemo(() => new Set(favorites.map((f) => f.feedId)), [favorites])
  const [queue, setQueue] = useState<EpisodeRow[]>(() => readSnapshot<EpisodeRow[]>('queue') || [])
  const [loadingQueue, setLoadingQueue] = useState(false)
  // Har vi hentet køen mindst én gang? Uden det viste vi "Alt er hørt 🎉" i det sekund hvor
  // favoritterne var kommet hjem, men afsnittene ikke var — en tom kø betyder ikke "hørt".
  const [queueLoaded, setQueueLoaded] = useState(() => !!readSnapshot<EpisodeRow[]>('queue'))
  // Serveren henter forældede feeds' RSS i baggrunden; det er dét spinneren over listen viser.
  const [checkingFeeds, setCheckingFeeds] = useState(false)

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
  const cancelBulk = useRef(false)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [pending, setPending] = useState(0) // lytning der venter på at blive sendt til serveren

  // player
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [current, setCurrent] = useState<EpisodeRow | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playErrorId, setPlayErrorId] = useState(0) // afsnit hvis lyd ikke kunne afspilles
  const [curTime, setCurTime] = useState(0) // sekunder afspillet (til progress bar)
  const [dur, setDur] = useState(0) // total varighed i sekunder
  const [seeking, setSeeking] = useState(false) // brugeren trækker i slideren
  const lastSaved = useRef(0)

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
      if (res.changed) setQueue(await newestEpisodes(deviceId))
    } catch {
      // feed-tjek er best-effort — cachen står allerede på skærmen
    } finally {
      setCheckingFeeds(false)
    }
  }, [deviceId])

  useEffect(() => {
    loadFavorites()
    loadQueue().then(refreshFromFeeds)
    // popularitet er pynt — fejler den, skal resten af app'en være upåvirket
    getCharts()
      .then((c) => {
        setChartShows(c.shows)
        setChartEpisodes(c.episodes)
      })
      .catch(() => {})
  }, [loadFavorites, loadQueue, refreshFromFeeds])

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
    const goOnline = () => { setOnline(true); flush() }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    flush()
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [deviceId, canDownload, refreshDownloads, loadQueue])

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
      await addFavorite(deviceId, p, p.kind === 'tv' ? 'drtv' : 'url')
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

  // ---------- favorite toggle ----------
  const toggleFavorite = useCallback(
    async (p: Podcast) => {
      if (favIds.has(p.id)) {
        await removeFavorite(deviceId, p.id)
      } else {
        // 'drtv' gør at favoritten kan mærkes som TV bagefter; selve opdateringen af afsnit
        // hænger på feed-URL'en, ikke på dette felt.
        await addFavorite(deviceId, p, p.kind === 'tv' ? 'drtv' : 'search')
      }
      await loadFavorites()
      await loadQueue()
      // Nyfulgt podcast har ingen cachede afsnit endnu — hent dem i baggrunden.
      refreshFromFeeds()
    },
    [favIds, deviceId, loadFavorites, loadQueue, refreshFromFeeds],
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
  const showEpisode = useCallback(
    (ep: EpisodeRow) => {
      setOpenEpisode(ep)
      if (ep.description) return
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
    [],
  )

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
    setPlayErrorId(0)
    setCurrent(ep)
    setPlaying(true)
    setCurTime(ep.positionSec || 0)
    setDur(ep.durationSec || 0)
    // resume position applied in the audio onLoadedMetadata handler below
    window.setTimeout(() => {
      const el = audioRef.current
      if (el) {
        el.src = ep.audioUrl!
        el.currentTime = ep.positionSec || 0
        el.play().catch(() => setPlaying(false))
      }
    }, 0)
  }, [online, dlIds])

  const markHeard = useCallback(
    async (ep: EpisodeRow, heard: boolean) => {
      await persistState({ episodeId: ep.episodeId, feedId: ep.feedId, played: heard })
      const patch = (list: EpisodeRow[]) =>
        list.map((e) => (e.episodeId === ep.episodeId ? { ...e, playedAt: heard ? new Date().toISOString() : null } : e))
      setQueue(patch)
      setDetailEpisodes(patch)
    },
    [persistState],
  )

  // "ryd alt herunder": markér dette afsnit + alle ældre (i køen) som hørt
  const clearBelow = useCallback(
    async (fromPublishedAt: number) => {
      const targets = queue.filter((e) => !e.playedAt && e.publishedAt <= fromPublishedAt)
      if (!targets.length) return
      const ids = new Set(targets.map((e) => e.episodeId))
      setQueue((list) => list.map((e) => (ids.has(e.episodeId) ? { ...e, playedAt: new Date().toISOString() } : e)))
      try {
        await setStateMany(deviceId, targets.map((e) => ({ episodeId: e.episodeId, feedId: e.feedId })), true)
      } catch {
        // offline: læg dem enkeltvis i udbakken i stedet for at tabe oprydningen
        for (const e of targets) await persistState({ episodeId: e.episodeId, feedId: e.feedId, played: true })
      }
    },
    [queue, deviceId, persistState],
  )

  // Slut på et afsnit = stop. Ingen auto-videre (fravalgt 2026-08-22): app'en skal aldrig selv
  // begynde på det næste afsnit — man vælger selv hvad der skal spilles.
  const onEnded = useCallback(async () => {
    if (!current) return
    // Stop lyden helt: uden det ville elementet spille videre hvis `ended` kom uden at
    // afspilningen faktisk var slut, mens afspilleren i bunden allerede var ryddet.
    audioRef.current?.pause()
    stopKeepAlive() // afsnittet er slut — der er ikke noget at holde i live
    await persistState({ episodeId: current.episodeId, feedId: current.feedId, played: true })
    setQueue((list) => list.map((e) => (e.episodeId === current.episodeId ? { ...e, playedAt: new Date().toISOString() } : e)))
    setPlaying(false)
    setCurrent(null)
  }, [current, persistState])

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current
    if (!el || !current) return
    if (!seeking) setCurTime(el.currentTime)
    if (el.duration && isFinite(el.duration)) setDur(el.duration)
    const now = Date.now()
    if (now - lastSaved.current > 8000) {
      lastSaved.current = now
      const secs = Math.floor(el.currentTime)
      persistState({
        episodeId: current.episodeId,
        feedId: current.feedId,
        positionSec: secs,
        durationSec: Math.floor(el.duration || current.durationSec),
      }).catch(() => {})
      // hold listens fremdriftsbjælke opdateret, også når afsnittet ikke længere er "current"
      const patch = (list: EpisodeRow[]) =>
        list.map((e) => (e.episodeId === current.episodeId ? { ...e, positionSec: secs } : e))
      setQueue(patch)
      setDetailEpisodes(patch)
    }
  }, [current, persistState, seeking])

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      el.play().then(() => setPlaying(true)).catch(() => {})
    } else {
      el.pause()
      setPlaying(false)
    }
  }, [])

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

  // Gem lytte-positionen NU i stedet for om op til 8 sekunder. Bruges når man pauser og når
  // app'en ryger i baggrunden: Android kan kassere siden uden varsel, og så var de sidste
  // sekunder tabt. `viaBeacon` bruges på pagehide, hvor en almindelig POST ikke når af sted.
  const savePositionNow = useCallback(
    (viaBeacon = false) => {
      const el = audioRef.current
      if (!el || !current) return
      lastSaved.current = Date.now()
      const w = {
        episodeId: current.episodeId,
        feedId: current.feedId,
        positionSec: Math.floor(el.currentTime),
        durationSec: Math.floor(el.duration || current.durationSec),
      }
      if (viaBeacon) beaconState(deviceId, w)
      else persistState(w).catch(() => {})
    },
    [current, deviceId, persistState],
  )

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') savePositionNow() }
    const onUnload = () => savePositionNow(true)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onUnload)
    }
  }, [savePositionNow])

  // spol: negativ = tilbage, positiv = frem (sekunder)
  const skip = useCallback((delta: number) => {
    const el = audioRef.current
    if (!el) return
    const target = Math.min(el.duration || Infinity, Math.max(0, el.currentTime + delta))
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
  // kan springe til næste afsnit fra bilen — men auto-videre kører stadig af sig selv når et
  // afsnit er slut, så det er kun det manuelle spring der forsvinder.
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
    ms.setActionHandler('play', () => audioRef.current?.play().then(() => setPlaying(true)).catch(() => {}))
    ms.setActionHandler('pause', () => { audioRef.current?.pause(); setPlaying(false) })
    // hold-nede-knapper i nogle biler/headsets
    ms.setActionHandler('seekbackward', () => skip(-10))
    ms.setActionHandler('seekforward', () => skip(30))
    // enkelt-tryk på frem/tilbage (Tesla-skærmen, rattet, headset)
    ms.setActionHandler('previoustrack', () => skip(-10))
    ms.setActionHandler('nexttrack', () => skip(30))
    try { ms.setActionHandler('seekto', (d) => { const el = audioRef.current; if (el && d.seekTime != null) { el.currentTime = d.seekTime; setCurTime(d.seekTime); syncPositionState() } }) } catch { /* ikke understøttet */ }
    return () => {
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack', 'previoustrack'] as const) {
        try { ms.setActionHandler(a, null) } catch { /* ignore */ }
      }
    }
  }, [current, skip, syncPositionState])

  // Systemet skal vide om vi spiller eller er pauset — ellers viser bilen/låseskærmen det
  // forkerte symbol, og under keep-alive (lydløs lyd) ville den tro der stadig afspilles.
  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  }, [playing])

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

  const unheardCount = queue.filter((e) => !e.playedAt).length

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
            starred={favIds.has(p.id)}
            chartRank={rankForPodcast(p.title)}
            onStar={() => toggleFavorite(p)}
            onOpen={() => openDetail(p)}
          />
        ))}
      </div>
    </div>
  )

  // ---------- render ----------
  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="kicker">Alle dine danske podcasts ét sted</p>
          <h1>All DK Podcasts</h1>
        </div>
        <div className="hero-stat">
          <span>{favorites.length} favoritter</span>
          <span>{unheardCount} uhørte</span>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>
          Kø {unheardCount > 0 && <em>{unheardCount}</em>}
        </button>
        <button className={tab === 'favorites' ? 'on' : ''} onClick={() => setTab('favorites')}>
          Favoritter
        </button>
        {canDownload && (
          <button className={tab === 'downloads' ? 'on' : ''} onClick={() => setTab('downloads')}>
            Hentet {downloads.length > 0 && <em>{downloads.length}</em>}
          </button>
        )}
        <button className={tab === 'explore' ? 'on' : ''} onClick={openExplore}>
          Udforsk
        </button>
      </nav>

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
              placeholder="…eller indsæt RSS-, Podimo- eller DR TV-URL"
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
          {favorites.length === 0 && <p className="muted">Ingen favoritter endnu — find nogle under Udforsk og tryk på stjernen.</p>}
          <div className="grid">
            {favorites.map((f) => (
              <PodcastCard
                key={f.feedId}
                podcast={favoriteAsPodcast(f)}
                starred
                chartRank={rankForPodcast(f.title)}
                onStar={() => toggleFavorite(favoriteAsPodcast(f))}
                onOpen={() => openDetail(f)}
              />
            ))}
          </div>
        </section>
      )}

      {tab === 'queue' && (
        <section className="panel">
          <div className="panel-head">
            <h2>Nyeste afsnit</h2>
            <button className="ghost" onClick={() => loadQueue().then(refreshFromFeeds)} disabled={loadingQueue || checkingFeeds}>
              {loadingQueue || checkingFeeds ? 'Opdaterer…' : 'Opdatér'}
            </button>
          </div>

          {canDownload && (
            <div className="bulkbar">
              <span className="bulk-text">⬇ Hent uhørte afsnit, så de kan afspilles uden dækning</span>
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
                      Hent {n}
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}

          {/* Spinner OVER listen: cachen er allerede tegnet, det her er kun feed-tjekket. */}
          {checkingFeeds && (
            <p className="feedcheck">
              <span className="spinner" aria-hidden="true" /> Søger efter nye afsnit…
            </p>
          )}

          {!queueLoaded && <p className="muted">Henter køen…</p>}
          {queueLoaded && favorites.length === 0 && <p className="muted">Følg nogle podcasts, så samler vi de nyeste afsnit her.</p>}
          {queueLoaded && favorites.length > 0 && unheardCount === 0 && !checkingFeeds && <p className="muted">Alt er hørt 🎉</p>}

          {/* Hele kronologien vises — også de HØRTE afsnit (2026-08-21). De forsvandt før ud af
              listen, så man mistede overblikket over hvad man havde lyttet til; nu bliver de
              liggende på deres plads og er tonet ned med et "✓ Hørt"-mærkat (`.episode.heard`).
              Afsnit man er midt i markeres på samme måde med `.episode.continuing`. */}
          {groupByDay(queue).map((g) => (
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
                {/* Knappen giver kun mening hvis der ER noget uhørt på dagen eller ældre */}
                {queue.some((e) => !e.playedAt && e.publishedAt <= g.episodes[g.episodes.length - 1].publishedAt) && (
                  <button
                    className="clear-below"
                    onClick={() => { if (confirm(`Markér "${g.label}" og alt ældre som hørt?`)) clearBelow(g.episodes[g.episodes.length - 1].publishedAt) }}
                    title="Markér denne dag og alt ældre som hørt"
                  >
                    ✓ ryd herunder
                  </button>
                )}
              </div>
              <ul className="episodes">
                {g.episodes.map((ep) => (
                  <EpisodeItem
                    key={ep.episodeId}
                    ep={ep}
                    isCurrent={current?.episodeId === ep.episodeId}
                    liveTime={current?.episodeId === ep.episodeId ? curTime : undefined}
                    chartRank={rankForEpisode(ep.title)}
                    canDownload={canDownload}
                    downloaded={dlIds.has(ep.episodeId)}
                    dl={dlState[ep.episodeId] || 'idle'}
                    offline={!online}
                    onPlay={() => playEpisode(ep)}
                    onToggleHeard={() => markHeard(ep, !ep.playedAt)}
                    onInfo={() => showEpisode(ep)}
                    onDownload={() => startDownload(ep)}
                    onRemoveDownload={() => dropDownload(ep)}
                  />
                ))}
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
              {downloads.map((d) => (
                <EpisodeItem
                  key={d.ep.episodeId}
                  ep={d.ep}
                  isCurrent={current?.episodeId === d.ep.episodeId}
                  liveTime={current?.episodeId === d.ep.episodeId ? curTime : undefined}
                  chartRank={rankForEpisode(d.ep.title)}
                  canDownload={canDownload}
                  downloaded
                  dl={dlState[d.ep.episodeId] || 'idle'}
                  offline={!online}
                  onPlay={() => playEpisode(d.ep)}
                  onToggleHeard={() => markHeard(d.ep, !d.ep.playedAt)}
                  onInfo={() => showEpisode(d.ep)}
                  onDownload={() => startDownload(d.ep)}
                  onRemoveDownload={() => dropDownload(d.ep)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {openPodcast && (
        <div className="modal" onClick={() => setOpenPodcast(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setOpenPodcast(null)}>
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
                {detailEpisodes.map((ep) => (
                  <EpisodeItem
                    key={ep.episodeId}
                    ep={ep}
                    isCurrent={current?.episodeId === ep.episodeId}
                    liveTime={current?.episodeId === ep.episodeId ? curTime : undefined}
                    chartRank={rankForEpisode(ep.title)}
                    canDownload={canDownload}
                    downloaded={dlIds.has(ep.episodeId)}
                    dl={dlState[ep.episodeId] || 'idle'}
                    offline={!online}
                    onPlay={() => playEpisode(ep)}
                    onToggleHeard={() => markHeard(ep, !ep.playedAt)}
                    onInfo={() => showEpisode(ep)}
                    onDownload={() => startDownload(ep)}
                    onRemoveDownload={() => dropDownload(ep)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {openEpisode && (
        <div className="modal" onClick={() => setOpenEpisode(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setOpenEpisode(null)}>✕</button>
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
                <button className="ghost" onClick={() => { markHeard(openEpisode, !openEpisode.playedAt); setOpenEpisode({ ...openEpisode, playedAt: openEpisode.playedAt ? null : new Date().toISOString() }) }}>
                  {openEpisode.playedAt ? '↺ Markér uhørt' : '✓ Markér hørt'}
                </button>
              </div>
            ) : (
              <div className="linkout">
                <p className="linkout-msg">
                  {playErrorId === openEpisode.episodeId
                    ? <>⚠️ Afsnittet kunne ikke afspilles i appen (ligger måske kun hos <strong>{sourceOf(openEpisode) || 'udbyderen'}</strong>). Prøv at åbne det direkte:</>
                    : isTvEpisode(openEpisode)
                      ? <>📺 Dette er et <strong>TV-program</strong> og kan ikke afspilles i appen. Se det hos DR TV:</>
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
                  {openEpisode.playedAt ? '↺ Markér uhørt' : '✓ Markér som hørt'}
                </button>
              </div>
            )}
            {openEpisode.description ? (
              <div className="show-desc" dangerouslySetInnerHTML={{ __html: openEpisode.description }} />
            ) : descBusy ? (
              <p className="muted">Henter beskrivelse…</p>
            ) : (
              <p className="muted">Ingen beskrivelse.</p>
            )}
          </div>
        </div>
      )}

      <footer className="player">
        <audio
          ref={audioRef}
          onEnded={onEnded}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => {
            setPlaying(true)
            stopKeepAlive() // der spiller rigtig lyd nu — stilheden har gjort sit
            syncPositionState()
          }}
          onPause={() => {
            setPlaying(false)
            const el = audioRef.current
            // Slutningen af et afsnit er også en "pause" — der er intet at holde i live der.
            if (el && current && !el.ended) {
              savePositionNow() // siden kan blive kasseret; gem positionen med det samme
              startKeepAlive() // hold afspilleren i notifikationsskuffen i 10 min.
            }
            syncPositionState()
          }}
          onError={() => {
            // lyd kunne ikke afspilles (fx DR app-only/geo) → vis link-out-pop-up
            if (current && current.audioUrl) {
              setPlayErrorId(current.episodeId)
              setPlaying(false)
              setOpenEpisode(current)
            }
          }}
          onLoadedMetadata={() => {
            const el = audioRef.current
            if (el && current && current.positionSec && el.currentTime < 1) el.currentTime = current.positionSec
            if (el && el.duration && isFinite(el.duration)) setDur(el.duration)
            syncPositionState()
          }}
        />
        {current ? (
          <>
            <div className="player-bar">
              <span className="ptime">{fmtClock(curTime)}</span>
              <input
                className="pseek"
                type="range"
                min={0}
                max={dur || current.durationSec || 0}
                step={1}
                value={Math.min(curTime, dur || current.durationSec || 0)}
                onChange={(e) => onSeekInput(Number(e.target.value))}
                onMouseUp={(e) => onSeekCommit(Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => onSeekCommit(Number((e.target as HTMLInputElement).value))}
                aria-label="Søg i afsnittet"
              />
              <span className="ptime">{fmtClock(dur || current.durationSec || 0)}</span>
            </div>
            <div className="player-controls">
              <button className="skip-btn" onClick={() => skip(-10)} title="Spol 10 sek. tilbage" aria-label="Spol 10 sekunder tilbage">
                <span className="skip-ico">↺</span><span className="skip-num">10</span>
              </button>
              <button className="play-toggle" onClick={togglePlay}>
                {playing ? '❚❚' : '▶'}
              </button>
              <button className="skip-btn" onClick={() => skip(30)} title="Spol 30 sek. frem" aria-label="Spol 30 sekunder frem">
                <span className="skip-ico">↻</span><span className="skip-num">30</span>
              </button>
              <div className="now">
                <strong>{current.title}</strong>
                <span>{current.podcastTitle}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="now empty">Vælg en episode</div>
        )}
      </footer>
    </div>
  )
}

function PodcastCard({
  podcast,
  starred,
  chartRank,
  onStar,
  onOpen,
}: {
  podcast: Podcast
  starred: boolean
  chartRank?: number // placering på Apples top-50 i Danmark
  onStar: () => void
  onOpen: () => void
}) {
  return (
    <div className="card">
      <button className="card-main" onClick={onOpen}>
        {podcast.image ? <img src={podcast.image} alt="" loading="lazy" /> : <div className="noimg" />}
        <div className="card-text">
          <strong>{podcast.title}</strong>
          <span>{podcast.author}</span>
          <span className="card-tags">
            {podcast.kind === 'tv' && (
              <em className="tv" title="TV-program fra DR — kan ikke afspilles i appen, men afsnittene kommer i køen med link til DR TV">
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
      <button className={`star ${starred ? 'on' : ''}`} onClick={onStar} title={starred ? 'Fjern favorit' : 'Tilføj favorit'}>
        {starred ? '★' : '☆'}
      </button>
    </div>
  )
}

function EpisodeItem({
  ep,
  isCurrent,
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
  isCurrent: boolean
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
  const source = sourceOf(ep)
  const tv = isTvEpisode(ep)
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
  // som blokeres i installerede PWA'er på Android)
  const activate = () => { if (playable) onPlay(); else onInfo() }
  // uden dækning og uden at være hentet kan afsnittet ikke spille — vis det frem for at lade
  // brugeren trykke forgæves
  const unreachable = offline && playable && !downloaded
  const busy = dl === 'busy' || dl === 'queued'
  return (
    <li className={`episode ${heard ? 'heard' : ''} ${isCurrent ? 'current' : ''} ${started ? 'continuing' : ''} ${unreachable ? 'unreachable' : ''}`}>
      <button
        className={`ep-thumb ${playable ? '' : 'link'}`}
        onClick={activate}
        title={playable ? 'Afspil' : `Kan ikke afspilles i appen — tryk for at åbne hos ${source || 'udbyder'}`}
      >
        {art ? <img src={art} alt="" loading="lazy" /> : <span className="ep-noimg" />}
        <span className="ep-badge">{playable ? '▶' : '↗'}</span>
      </button>
      <button className="ep-text" onClick={onInfo} title="Læs mere">
        <strong>{ep.title}</strong>
        <span className="ep-meta">
          {heard && <em className="heard-chip" title="Du har hørt dette afsnit — tryk ✓ for at markere det uhørt igen">✓ Hørt</em>}
          {started && <em className="cont-chip" title="Du er i gang med dette afsnit">▶ Fortsætter</em>}
          {chartRank && (
            <em className="hot" title={`Nr. ${chartRank} på Apples trending-afsnit i Danmark lige nu`}>
              🔥 #{chartRank} i DK
            </em>
          )}
          {source && <em className={`src ${srcClass}`}>{tv ? '📺 ' : ''}{source}</em>}
          {ep.podcastTitle ? ep.podcastTitle + ' · ' : ''}
          {fmtDate(ep.publishedAt)}
          {ep.durationSec ? ' · ' + fmtDur(ep.durationSec) : ''}
          {!playable && (tv ? ' · ses hos DR TV' : ' · kun hos udbyder')}
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
      <button className={`heard-toggle ${heard ? 'on' : ''}`} onClick={onToggleHeard} title={heard ? 'Markér som uhørt' : 'Markér som hørt'}>
        ✓
      </button>
    </li>
  )
}
