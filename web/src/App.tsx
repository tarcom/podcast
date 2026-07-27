import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addFavorite,
  addPodimoShow,
  discover,
  feedEpisodes,
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

  // player
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [current, setCurrent] = useState<EpisodeRow | null>(null)
  const [playing, setPlaying] = useState(false)
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
    setCurrent(ep)
    setPlaying(true)
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
    const now = Date.now()
    if (now - lastSaved.current > 8000) {
      lastSaved.current = now
      saveState(deviceId, {
        episodeId: current.episodeId,
        feedId: current.feedId,
        positionSec: Math.floor(el.currentTime),
        durationSec: Math.floor(el.duration || current.durationSec),
      }).catch(() => {})
    }
  }, [current, deviceId])

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
    ms.setActionHandler('seekbackward', () => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 15) })
    ms.setActionHandler('seekforward', () => { if (audioRef.current) audioRef.current.currentTime += 30 })
    ms.setActionHandler('nexttrack', () => onEnded())
    return () => {
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'nexttrack'] as const) {
        try { ms.setActionHandler(a, null) } catch { /* ignore */ }
      }
    }
  }, [current, onEnded])

  const unheardCount = queue.filter((e) => !e.playedAt).length

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

          <div className="grid">
            {orderedResults.map((p) => (
              <PodcastCard
                key={p.id}
                podcast={p}
                starred={favIds.has(p.id)}
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
          {groupByDay(queue.filter((e) => !e.playedAt)).map((g) => (
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
            <div className="ep-actions">
              {openEpisode.audioUrl ? (
                <button className="primary" onClick={() => { playEpisode(openEpisode); setOpenEpisode(null) }}>▶ Afspil</button>
              ) : openEpisode.linkUrl ? (
                <a className="primary" href={openEpisode.linkUrl} target="_blank" rel="noopener">↗ Åbn hos udbyder</a>
              ) : null}
              <button className="ghost" onClick={() => { markHeard(openEpisode, !openEpisode.playedAt); setOpenEpisode({ ...openEpisode, playedAt: openEpisode.playedAt ? null : new Date().toISOString() }) }}>
                {openEpisode.playedAt ? '↺ Markér uhørt' : '✓ Markér hørt'}
              </button>
            </div>
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
          onLoadedMetadata={() => {
            const el = audioRef.current
            if (el && current && current.positionSec && el.currentTime < 1) el.currentTime = current.positionSec
          }}
        />
        {current ? (
          <>
            <button className="play-toggle" onClick={togglePlay}>
              {playing ? '❚❚' : '▶'}
            </button>
            <div className="now">
              <strong>{current.title}</strong>
              <span>{current.podcastTitle}</span>
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
  onStar,
  onOpen,
}: {
  podcast: Podcast
  starred: boolean
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
          {isDanish(podcast.language) && <em className="da">Dansk</em>}
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
  onPlay,
  onToggleHeard,
  onInfo,
}: {
  ep: EpisodeRow
  isCurrent: boolean
  onPlay: () => void
  onToggleHeard: () => void
  onInfo: () => void
}) {
  const heard = !!ep.playedAt
  const art = ep.image || ep.podcastImage
  const playable = !!ep.audioUrl
  const activate = () => { if (playable) onPlay(); else if (ep.linkUrl) window.open(ep.linkUrl, '_blank', 'noopener') }
  return (
    <li className={`episode ${heard ? 'heard' : ''} ${isCurrent ? 'current' : ''}`}>
      <button
        className={`ep-thumb ${playable ? '' : (ep.linkUrl ? 'link' : 'disabled')}`}
        onClick={activate}
        title={playable ? 'Afspil' : ep.linkUrl ? 'Åbn hos udbyder' : 'Ingen lydfil'}
      >
        {art ? <img src={art} alt="" loading="lazy" /> : <span className="ep-noimg" />}
        <span className="ep-badge">{playable ? '▶' : ep.linkUrl ? '↗' : '–'}</span>
      </button>
      <button className="ep-text" onClick={onInfo} title="Læs mere">
        <strong>{ep.title}</strong>
        <span>
          {ep.podcastTitle ? ep.podcastTitle + ' · ' : ''}
          {fmtDate(ep.publishedAt)}
          {ep.durationSec ? ' · ' + fmtDur(ep.durationSec) : ''}
          {!ep.audioUrl && ' · kun hos udbyder'}
        </span>
      </button>
      <button className={`heard-toggle ${heard ? 'on' : ''}`} onClick={onToggleHeard} title={heard ? 'Markér som uhørt' : 'Markér som hørt'}>
        ✓
      </button>
    </li>
  )
}
