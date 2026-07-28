import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addFavorite,
  addPodimoShow,
  discover,
  feedEpisodes,
  getCharts,
  getPodcast,
  listFavorites,
  newestEpisodes,
  removeFavorite,
  resolveUrl,
  search,
  setState as saveState,
  setStateMany,
} from './lib/api'
import { getDeviceId } from './lib/device'
import type { ChartEpisode, ChartShow } from './lib/api'
import type { EpisodeRow, Favorite, Podcast } from './types'

type Tab = 'explore' | 'favorites' | 'queue'
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
function sourceOf(ep: EpisodeRow): string {
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

  // data
  const [favorites, setFavorites] = useState<Favorite[]>([])
  const favIds = useMemo(() => new Set(favorites.map((f) => f.feedId)), [favorites])
  const [queue, setQueue] = useState<EpisodeRow[]>([])
  const [loadingQueue, setLoadingQueue] = useState(false)

  // explore
  const [query, setQuery] = useState('')
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

  // popularitet (Apples danske hitlister)
  const [chartShows, setChartShows] = useState<ChartShow[]>([])
  const [chartEpisodes, setChartEpisodes] = useState<ChartEpisode[]>([])

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
  const loadFavorites = useCallback(async () => {
    setFavorites(await listFavorites(deviceId))
  }, [deviceId])

  const loadQueue = useCallback(async () => {
    setLoadingQueue(true)
    try {
      setQueue(await newestEpisodes(deviceId))
    } finally {
      setLoadingQueue(false)
    }
  }, [deviceId])

  useEffect(() => {
    loadFavorites()
    loadQueue()
    discover('da', 60).then(setResults).catch(() => {})
    // popularitet er pynt — fejler den, skal resten af app'en være upåvirket
    getCharts()
      .then((c) => {
        setChartShows(c.shows)
        setChartEpisodes(c.episodes)
      })
      .catch(() => {})
  }, [loadFavorites, loadQueue])

  // ---------- explore ----------
  const runSearch = useCallback(async () => {
    const q = query.trim()
    setExploreErr('')
    setExploreBusy(true)
    try {
      const res = q ? await search(q, 80) : await discover('da', 60)
      setResults(res)
    } catch {
      setExploreErr('Søgning fejlede. Prøv igen om lidt.')
    } finally {
      setExploreBusy(false)
    }
  }, [query])

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
      await addFavorite(deviceId, p, 'url')
      setUrlInput('')
      await loadFavorites()
      await loadQueue()
      setResults((prev) => [p, ...prev.filter((x) => x.id !== p.id)])
    } catch {
      setExploreErr('Kunne ikke tilføje feed via URL.')
    } finally {
      setExploreBusy(false)
    }
  }, [urlInput, deviceId, loadFavorites, loadQueue])

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
        await addFavorite(deviceId, p, 'search')
      }
      await loadFavorites()
      await loadQueue()
    },
    [favIds, deviceId, loadFavorites, loadQueue],
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

  // ---------- playback ----------
  const playEpisode = useCallback((ep: EpisodeRow) => {
    if (!ep.audioUrl) return
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
  }, [])

  const markHeard = useCallback(
    async (ep: EpisodeRow, heard: boolean) => {
      await saveState(deviceId, { episodeId: ep.episodeId, feedId: ep.feedId, played: heard })
      const patch = (list: EpisodeRow[]) =>
        list.map((e) => (e.episodeId === ep.episodeId ? { ...e, playedAt: heard ? new Date().toISOString() : null } : e))
      setQueue(patch)
      setDetailEpisodes(patch)
    },
    [deviceId],
  )

  // "ryd alt herunder": markér dette afsnit + alle ældre (i køen) som hørt
  const clearBelow = useCallback(
    async (fromPublishedAt: number) => {
      const targets = queue.filter((e) => !e.playedAt && e.publishedAt <= fromPublishedAt)
      if (!targets.length) return
      const ids = new Set(targets.map((e) => e.episodeId))
      setQueue((list) => list.map((e) => (ids.has(e.episodeId) ? { ...e, playedAt: new Date().toISOString() } : e)))
      await setStateMany(deviceId, targets.map((e) => ({ episodeId: e.episodeId, feedId: e.feedId })), true).catch(() => {})
    },
    [queue, deviceId],
  )

  const onEnded = useCallback(async () => {
    if (!current) return
    await saveState(deviceId, { episodeId: current.episodeId, feedId: current.feedId, played: true })
    setQueue((list) => list.map((e) => (e.episodeId === current.episodeId ? { ...e, playedAt: new Date().toISOString() } : e)))
    // auto-continue: next newest unheard, playable episode in the queue
    const next = queue.find((e) => !e.playedAt && e.audioUrl && e.episodeId !== current.episodeId)
    if (next) playEpisode(next)
    else {
      setPlaying(false)
      setCurrent(null)
    }
  }, [current, deviceId, queue, playEpisode])

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current
    if (!el || !current) return
    if (!seeking) setCurTime(el.currentTime)
    if (el.duration && isFinite(el.duration)) setDur(el.duration)
    const now = Date.now()
    if (now - lastSaved.current > 8000) {
      lastSaved.current = now
      const secs = Math.floor(el.currentTime)
      saveState(deviceId, {
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
  }, [current, deviceId, seeking])

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

  // spol: negativ = tilbage, positiv = frem (sekunder)
  const skip = useCallback((delta: number) => {
    const el = audioRef.current
    if (!el) return
    const target = Math.min(el.duration || Infinity, Math.max(0, el.currentTime + delta))
    el.currentTime = target
    setCurTime(target)
  }, [])

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
  }, [])

  // Media Session: metadata + betjening på låseskærm/notifikation (baggrund)
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
    ms.setActionHandler('seekbackward', () => { if (audioRef.current) { const t = Math.max(0, audioRef.current.currentTime - 10); audioRef.current.currentTime = t; setCurTime(t) } })
    ms.setActionHandler('seekforward', () => { if (audioRef.current) { const t = audioRef.current.currentTime + 30; audioRef.current.currentTime = t; setCurTime(t) } })
    try { ms.setActionHandler('seekto', (d) => { const el = audioRef.current; if (el && d.seekTime != null) { el.currentTime = d.seekTime; setCurTime(d.seekTime) } }) } catch { /* ikke understøttet */ }
    ms.setActionHandler('nexttrack', () => onEnded())
    return () => {
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack'] as const) {
        try { ms.setActionHandler(a, null) } catch { /* ignore */ }
      }
    }
  }, [current, onEnded])

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

  // "Fortsætter": afsnit man er midt i, senest lyttede først.
  const continuing = queue
    .filter((e) => isInProgress(e.positionSec || 0, e.durationSec || 0, !!e.playedAt))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))

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
        <button className={tab === 'explore' ? 'on' : ''} onClick={() => setTab('explore')}>
          Udforsk
        </button>
      </nav>

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
              placeholder="…eller indsæt RSS-URL eller Podimo show-URL"
            />
            <button onClick={addByUrl} disabled={exploreBusy}>
              Tilføj
            </button>
          </div>
          {exploreErr && <p className="error">{exploreErr}</p>}

          {chartShows.length > 0 && (
            <div className="charts">
              <div className="charts-head">
                <h3>🇩🇰 Mest populære i Danmark lige nu</h3>
                <span className="muted">Apples top 50 · opdateres dagligt</span>
              </div>
              <ol className="chartlist">
                {chartShows.map((s2) => (
                  <li key={s2.itunesId || s2.rank}>
                    <button
                      className="chart-item"
                      onClick={() => {
                        // slå op i Podcast Index på titlen, så den kan åbnes/følges som alle andre
                        setQuery(s2.name)
                        setTab('explore')
                        setExploreBusy(true)
                        search(s2.name, 20)
                          .then(setResults)
                          .catch(() => setExploreErr('Kunne ikke slå podcasten op.'))
                          .finally(() => setExploreBusy(false))
                      }}
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
            </div>
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
        </section>
      )}

      {tab === 'favorites' && (
        <section className="panel">
          {favorites.length === 0 && <p className="muted">Ingen favoritter endnu — find nogle under Udforsk og tryk på stjernen.</p>}
          <div className="grid">
            {favorites.map((f) => (
              <PodcastCard
                key={f.feedId}
                podcast={{ id: f.feedId, title: f.title, image: f.image, author: f.author, language: f.language }}
                starred
                chartRank={rankForPodcast(f.title)}
                onStar={() => toggleFavorite({ id: f.feedId, title: f.title, image: f.image, author: f.author, language: f.language })}
                onOpen={() => openDetail(f)}
              />
            ))}
          </div>
        </section>
      )}

      {tab === 'queue' && (
        <section className="panel">
          <div className="panel-head">
            <h2>Nyeste uhørte</h2>
            <button className="ghost" onClick={loadQueue} disabled={loadingQueue}>
              {loadingQueue ? 'Opdaterer…' : 'Opdatér'}
            </button>
          </div>
          {favorites.length === 0 && <p className="muted">Følg nogle podcasts, så samler vi de nyeste afsnit her.</p>}
          {favorites.length > 0 && unheardCount === 0 && <p className="muted">Alt er hørt 🎉</p>}

          {continuing.length > 0 && (
            <div className="daygroup continuing">
              <div className="day-head">
                <h3>▶ Fortsætter</h3>
              </div>
              <ul className="episodes">
                {continuing.map((ep) => (
                  <EpisodeItem
                    key={ep.episodeId}
                    ep={ep}
                    isCurrent={current?.episodeId === ep.episodeId}
                    liveTime={current?.episodeId === ep.episodeId ? curTime : undefined}
                    chartRank={rankForEpisode(ep.title)}
                    onPlay={() => playEpisode(ep)}
                    onToggleHeard={() => markHeard(ep, !ep.playedAt)}
                    onInfo={() => setOpenEpisode(ep)}
                  />
                ))}
              </ul>
            </div>
          )}

          {groupByDay(queue.filter((e) => !e.playedAt && !isInProgress(e.positionSec || 0, e.durationSec || 0, false))).map((g) => (
            <div className="daygroup" key={g.key}>
              <div className="day-head">
                <h3>{g.label}</h3>
                <button
                  className="clear-below"
                  onClick={() => { if (confirm(`Markér "${g.label}" og alt ældre som hørt?`)) clearBelow(g.episodes[g.episodes.length - 1].publishedAt) }}
                  title="Markér denne dag og alt ældre som hørt"
                >
                  ✓ ryd herunder
                </button>
              </div>
              <ul className="episodes">
                {g.episodes.map((ep) => (
                  <EpisodeItem
                    key={ep.episodeId}
                    ep={ep}
                    isCurrent={current?.episodeId === ep.episodeId}
                    liveTime={current?.episodeId === ep.episodeId ? curTime : undefined}
                    chartRank={rankForEpisode(ep.title)}
                    onPlay={() => playEpisode(ep)}
                    onToggleHeard={() => markHeard(ep, !ep.playedAt)}
                    onInfo={() => setOpenEpisode(ep)}
                  />
                ))}
              </ul>
            </div>
          ))}
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
                    onPlay={() => playEpisode(ep)}
                    onToggleHeard={() => markHeard(ep, !ep.playedAt)}
                    onInfo={() => setOpenEpisode(ep)}
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
            {openEpisode.description
              ? <div className="show-desc" dangerouslySetInnerHTML={{ __html: openEpisode.description }} />
              : <p className="muted">Ingen beskrivelse.</p>}
          </div>
        </div>
      )}

      <footer className="player">
        <audio
          ref={audioRef}
          onEnded={onEnded}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
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
  onPlay,
  onToggleHeard,
  onInfo,
}: {
  ep: EpisodeRow
  isCurrent: boolean
  liveTime?: number // sekunder for det afsnit der spiller lige nu (så bjælken bevæger sig)
  chartRank?: number // placering på Apples danske trending-afsnit-liste
  onPlay: () => void
  onToggleHeard: () => void
  onInfo: () => void
}) {
  const heard = !!ep.playedAt
  const art = ep.image || ep.podcastImage
  const playable = !!ep.audioUrl
  const source = sourceOf(ep)
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
  return (
    <li className={`episode ${heard ? 'heard' : ''} ${isCurrent ? 'current' : ''}`}>
      <button
        className={`ep-thumb ${playable ? '' : 'link'}`}
        onClick={activate}
        title={playable ? 'Afspil' : 'Kan ikke afspilles i appen — tryk for at åbne hos udbyder'}
      >
        {art ? <img src={art} alt="" loading="lazy" /> : <span className="ep-noimg" />}
        <span className="ep-badge">{playable ? '▶' : '↗'}</span>
      </button>
      <button className="ep-text" onClick={onInfo} title="Læs mere">
        <strong>{ep.title}</strong>
        <span className="ep-meta">
          {chartRank && (
            <em className="hot" title={`Nr. ${chartRank} på Apples trending-afsnit i Danmark lige nu`}>
              🔥 #{chartRank} i DK
            </em>
          )}
          {source && <em className={`src src-${source.toLowerCase()}`}>{source}</em>}
          {ep.podcastTitle ? ep.podcastTitle + ' · ' : ''}
          {fmtDate(ep.publishedAt)}
          {ep.durationSec ? ' · ' + fmtDur(ep.durationSec) : ''}
          {!playable && ' · kun hos udbyder'}
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
      <button className={`heard-toggle ${heard ? 'on' : ''}`} onClick={onToggleHeard} title={heard ? 'Markér som uhørt' : 'Markér som hørt'}>
        ✓
      </button>
    </li>
  )
}
