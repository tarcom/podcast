import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addFavorite,
  discover,
  feedEpisodes,
  listFavorites,
  newestEpisodes,
  removeFavorite,
  resolveUrl,
  search,
  setState as saveState,
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
  const [detailEpisodes, setDetailEpisodes] = useState<EpisodeRow[]>([])
  const [detailBusy, setDetailBusy] = useState(false)

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
      setDetailBusy(true)
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

  const unheardCount = queue.filter((e) => !e.playedAt).length

  // ---------- render ----------
  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="kicker">Podcast uden reklame-overload</p>
          <h1>NordPod</h1>
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
              placeholder="…eller tilføj en podcast via RSS-URL"
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
          <ul className="episodes">
            {queue.map((ep) => (
              <EpisodeItem
                key={ep.episodeId}
                ep={ep}
                isCurrent={current?.episodeId === ep.episodeId}
                onPlay={() => playEpisode(ep)}
                onToggleHeard={() => markHeard(ep, !ep.playedAt)}
              />
            ))}
          </ul>
        </section>
      )}

      {openPodcast && (
        <div className="modal" onClick={() => setOpenPodcast(null)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setOpenPodcast(null)}>
              ✕
            </button>
            <h2>{'title' in openPodcast ? openPodcast.title : ''}</h2>
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
                  />
                ))}
              </ul>
            )}
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
}: {
  ep: EpisodeRow
  isCurrent: boolean
  onPlay: () => void
  onToggleHeard: () => void
}) {
  const heard = !!ep.playedAt
  return (
    <li className={`episode ${heard ? 'heard' : ''} ${isCurrent ? 'current' : ''}`}>
      {ep.audioUrl ? (
        <button className="ep-play" onClick={onPlay} title="Afspil">
          ▶
        </button>
      ) : ep.linkUrl ? (
        <a className="ep-play link" href={ep.linkUrl} target="_blank" rel="noopener" title="Åbn hos udbyder">
          ↗
        </a>
      ) : (
        <span className="ep-play disabled">–</span>
      )}
      <div className="ep-text">
        <strong>{ep.title}</strong>
        <span>
          {ep.podcastTitle ? ep.podcastTitle + ' · ' : ''}
          {fmtDate(ep.publishedAt)}
          {ep.durationSec ? ' · ' + fmtDur(ep.durationSec) : ''}
          {!ep.audioUrl && ' · kun hos udbyder'}
        </span>
      </div>
      <button className={`heard-toggle ${heard ? 'on' : ''}`} onClick={onToggleHeard} title={heard ? 'Markér som uhørt' : 'Markér som hørt'}>
        ✓
      </button>
    </li>
  )
}
