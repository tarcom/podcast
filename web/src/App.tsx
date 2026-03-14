import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addSubscription,
  discover,
  episodesByFeed,
  getProgress,
  listSubscriptions,
  removeSubscription,
  search,
  setProgress,
} from './lib/api'
import { getDeviceId } from './lib/device'
import type { Episode, Podcast, ProgressItem } from './types'

type Tab = 'discover' | 'subscriptions' | 'queue'
type EpisodeProgress = { position: number; duration: number }

const DEVICE_ID = getDeviceId()
const DISMISSED_QUEUE_KEY = 'nordpod_dismissed_queue_episode_ids'
const LOCAL_PROGRESS_KEY = 'nordpod_progress_map'

function normalizeLanguage(value?: string): string {
  return (value || '').toLowerCase()
}

function isDanish(podcast: Podcast): boolean {
  const language = normalizeLanguage(podcast.language)
  return language.includes('danish') || language === 'da' || language.startsWith('da-')
}

function sortDanishFirst(items: Podcast[]): Podcast[] {
  return [...items].sort((a, b) => {
    const scoreA = isDanish(a) ? 1 : 0
    const scoreB = isDanish(b) ? 1 : 0
    if (scoreA !== scoreB) {
      return scoreB - scoreA
    }
    return a.title.localeCompare(b.title, 'da')
  })
}

function formatDuration(seconds = 0): string {
  if (!seconds || Number.isNaN(seconds)) {
    return 'Ukendt laengde'
  }
  const hour = Math.floor(seconds / 3600)
  const minute = Math.floor((seconds % 3600) / 60)
  if (hour > 0) {
    return `${hour} t ${minute} min`
  }
  return `${minute} min`
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9aeiouy\u00e6\u00f8\u00e5]/g, '')
}

function readDismissedIds(): Set<number> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_QUEUE_KEY)
    if (!raw) {
      return new Set<number>()
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return new Set<number>()
    }
    return new Set(parsed.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))
  } catch {
    return new Set<number>()
  }
}

function readProgressMap(): Record<number, EpisodeProgress> {
  try {
    const raw = window.localStorage.getItem(LOCAL_PROGRESS_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, EpisodeProgress>
    const out: Record<number, EpisodeProgress> = {}
    Object.keys(parsed || {}).forEach((key) => {
      const id = Number(key)
      if (Number.isFinite(id) && id > 0) {
        const item = parsed[key]
        out[id] = {
          position: Math.max(0, Number(item?.position || 0)),
          duration: Math.max(0, Number(item?.duration || 0)),
        }
      }
    })
    return out
  } catch {
    return {}
  }
}

function App() {
  const [tab, setTab] = useState<Tab>('discover')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [languageFilter, setLanguageFilter] = useState<'all' | 'da'>('da')
  const [podcasts, setPodcasts] = useState<Podcast[]>([])
  const [subscriptions, setSubscriptions] = useState<Podcast[]>([])
  const [selectedSubscription, setSelectedSubscription] = useState<Podcast | null>(null)
  const [selectedSubscriptionEpisodes, setSelectedSubscriptionEpisodes] = useState<Episode[]>([])
  const [selectedEpisodesLoading, setSelectedEpisodesLoading] = useState(false)
  const [subscriptionEpisodes, setSubscriptionEpisodes] = useState<Episode[]>([])
  const [subscriptionEpisodesLoading, setSubscriptionEpisodesLoading] = useState(false)
  const [currentEpisode, setCurrentEpisode] = useState<Episode | null>(null)
  const [resumeItem, setResumeItem] = useState<ProgressItem | null>(null)
  const [playQueue, setPlayQueue] = useState<Episode[]>([])
  const [playQueueIndex, setPlayQueueIndex] = useState(-1)
  const [dismissedEpisodeIds, setDismissedEpisodeIds] = useState<Set<number>>(() => readDismissedIds())
  const [progressByEpisode, setProgressByEpisode] = useState<Record<number, EpisodeProgress>>(() =>
    readProgressMap(),
  )
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lastSavedSecondRef = useRef(0)

  const subscriptionIds = useMemo(
    () => new Set(subscriptions.map((item) => item.id)),
    [subscriptions],
  )

  const filteredPodcasts = useMemo(() => {
    if (languageFilter === 'all') {
      return podcasts
    }
    return podcasts.filter((podcast) => isDanish(podcast))
  }, [languageFilter, podcasts])

  const currentPodcast = useMemo(() => {
    if (!currentEpisode) {
      return null
    }
    return (
      subscriptions.find((item) => item.id === currentEpisode.feedId) ||
      podcasts.find((item) => item.id === currentEpisode.feedId) ||
      selectedSubscription || {
        id: currentEpisode.feedId,
        title: currentEpisode.feedTitle || 'Ukendt podcast',
        image: currentEpisode.image,
      }
    )
  }, [currentEpisode, subscriptions, podcasts, selectedSubscription])

  const queueEpisodes = useMemo(() => {
    return subscriptionEpisodes.filter((episode) => {
      if (dismissedEpisodeIds.has(episode.id)) {
        return false
      }
      const p = progressByEpisode[episode.id]
      if (!p || p.duration <= 0) {
        return true
      }
      return p.position < p.duration - 15
    })
  }, [subscriptionEpisodes, dismissedEpisodeIds, progressByEpisode])

  const upNextEpisode = useMemo(() => {
    if (playQueueIndex < 0 || playQueueIndex + 1 >= playQueue.length) {
      return null
    }
    return playQueue[playQueueIndex + 1]
  }, [playQueue, playQueueIndex])

  const recommendations = useMemo(() => {
    if (subscriptions.length === 0) {
      return []
    }

    const subscribedIds = new Set(subscriptions.map((item) => item.id))
    const keywordScores = new Map<string, number>()

    for (const sub of subscriptions) {
      const text = `${sub.title || ''} ${sub.author || ''}`
      const tokens = text
        .split(/\s+/)
        .map(normalizeToken)
        .filter((token) => token.length >= 4)
      for (const token of tokens) {
        keywordScores.set(token, (keywordScores.get(token) || 0) + 1)
      }
    }

    const scored = podcasts
      .filter((candidate) => !subscribedIds.has(candidate.id))
      .map((candidate) => {
        const candidateText = `${candidate.title || ''} ${candidate.author || ''}`.toLowerCase()
        let score = isDanish(candidate) ? 3 : 0

        for (const [token, tokenScore] of keywordScores.entries()) {
          if (candidateText.includes(token)) {
            score += tokenScore
          }
        }

        return { candidate, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)

    return scored.slice(0, 8).map((entry) => entry.candidate)
  }, [podcasts, subscriptions])

  async function loadInitialData() {
    setError('')
    try {
      const [subscriptionsItems, progress] = await Promise.all([
        listSubscriptions(DEVICE_ID),
        getProgress(DEVICE_ID),
      ])
      setSubscriptions(subscriptionsItems)
      setResumeItem(progress)
    } catch (reason) {
      setError('Kunne ikke hente data. Tjek api/config.php og databaseforbindelse.')
      console.error(reason)
    }
  }

  async function loadSubscriptionEpisodes(subs: Podcast[]) {
    if (subs.length === 0) {
      setSubscriptionEpisodes([])
      return
    }
    setSubscriptionEpisodesLoading(true)
    try {
      const results = await Promise.all(
        subs.map((sub) =>
          episodesByFeed(sub.id, 12)
            .then((eps) =>
              eps.map((ep) => ({
                ...ep,
                feedTitle: ep.feedTitle || sub.title,
                image: ep.image || sub.image,
              })),
            )
            .catch(() => [] as Episode[]),
        ),
      )

      const all = results
        .flat()
        .sort((a, b) => (b.datePublished || 0) - (a.datePublished || 0))
      setSubscriptionEpisodes(all.slice(0, 120))
    } finally {
      setSubscriptionEpisodesLoading(false)
    }
  }

  async function loadEpisodesForSubscription(podcast: Podcast) {
    setSelectedSubscription(podcast)
    setSelectedEpisodesLoading(true)
    setError('')
    try {
      const items = await episodesByFeed(podcast.id, 80)
      setSelectedSubscriptionEpisodes(items)
    } catch (reason) {
      setError('Kunne ikke hente episoder for podcasten.')
      console.error(reason)
    } finally {
      setSelectedEpisodesLoading(false)
    }
  }

  function markEpisodeDismissed(episodeId: number) {
    setDismissedEpisodeIds((prev) => {
      const next = new Set(prev)
      next.add(episodeId)
      return next
    })
  }

  function startPlayback(episode: Episode, queueSource?: Episode[]) {
    if (!episode.enclosureUrl) {
      setError('Denne episode har ingen lydfil.')
      return
    }

    const source =
      queueSource && queueSource.length > 0
        ? queueSource
        : queueEpisodes.length > 0
          ? queueEpisodes
          : [episode]

    const idx = source.findIndex((item) => item.id === episode.id)
    setPlayQueue(source)
    setPlayQueueIndex(idx >= 0 ? idx : 0)
    setCurrentEpisode(episode)

    requestAnimationFrame(() => {
      audioRef.current?.play().catch(() => {
        // Browser can block autoplay.
      })
    })
  }

  function playNextInQueue() {
    if (!currentEpisode) {
      return
    }

    const currentProgress = progressByEpisode[currentEpisode.id]
    if (currentProgress?.duration && currentProgress.position >= currentProgress.duration - 15) {
      markEpisodeDismissed(currentEpisode.id)
    }

    if (!upNextEpisode) {
      return
    }
    startPlayback(upNextEpisode, playQueue)
  }

  async function playLatest(podcast: Podcast) {
    try {
      const items = await episodesByFeed(podcast.id, 1)
      if (items[0]) {
        startPlayback(items[0], items)
      } else {
        setError('Ingen episoder fundet for denne podcast.')
      }
    } catch (reason) {
      setError('Kunne ikke hente seneste episode.')
      console.error(reason)
    }
  }

  async function feelLucky() {
    const pool = filteredPodcasts.length > 0 ? filteredPodcasts : podcasts
    if (pool.length === 0) {
      setError('Ingen podcasts at vaelge imellem.')
      return
    }
    const random = pool[Math.floor(Math.random() * pool.length)]
    await playLatest(random)
  }

  async function openPodcastFromPlayer() {
    if (!currentPodcast) {
      return
    }
    setTab('subscriptions')
    await loadEpisodesForSubscription(currentPodcast)
  }

  async function openPodcastFromRecommendation(podcast: Podcast) {
    setTab('subscriptions')
    await loadEpisodesForSubscription(podcast)
  }

  async function ensureSubscribed(podcast: Podcast) {
    if (subscriptionIds.has(podcast.id)) {
      return
    }
    await toggleSubscription(podcast)
  }

  async function openPodcastFromQueueEpisode(episode: Episode) {
    const podcastFromSubs = subscriptions.find((item) => item.id === episode.feedId)
    const podcastFromDiscover = podcasts.find((item) => item.id === episode.feedId)
    const podcast: Podcast =
      podcastFromSubs ||
      podcastFromDiscover || {
        id: episode.feedId,
        title: episode.feedTitle || 'Ukendt podcast',
        image: episode.image,
      }

    setTab('subscriptions')
    await loadEpisodesForSubscription(podcast)
  }

  async function toggleSubscription(podcast: Podcast) {
    try {
      const exists = subscriptionIds.has(podcast.id)
      if (exists) {
        await removeSubscription(DEVICE_ID, podcast.id)
        setSubscriptions((prev) => prev.filter((item) => item.id !== podcast.id))
        if (selectedSubscription?.id === podcast.id) {
          setSelectedSubscription(null)
          setSelectedSubscriptionEpisodes([])
        }
        return
      }
      await addSubscription(DEVICE_ID, podcast)
      setSubscriptions((prev) => [podcast, ...prev])
    } catch (reason) {
      setError('Kunne ikke opdatere abonnement. Proev igen.')
      console.error(reason)
    }
  }

  useEffect(() => {
    void loadInitialData()
  }, [])

  useEffect(() => {
    window.localStorage.setItem(DISMISSED_QUEUE_KEY, JSON.stringify(Array.from(dismissedEpisodeIds)))
  }, [dismissedEpisodeIds])

  useEffect(() => {
    window.localStorage.setItem(LOCAL_PROGRESS_KEY, JSON.stringify(progressByEpisode))
  }, [progressByEpisode])

  useEffect(() => {
    const handle = window.setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const items = query.trim()
          ? await search(query.trim())
          : await discover(languageFilter === 'da' ? 'da' : '')
        setPodcasts(sortDanishFirst(items))
      } catch (reason) {
        setError('Soegning fejlede. Proev igen om lidt.')
        console.error(reason)
      } finally {
        setLoading(false)
      }
    }, 280)

    return () => window.clearTimeout(handle)
  }, [query, languageFilter])

  useEffect(() => {
    void loadSubscriptionEpisodes(subscriptions)

    if (subscriptions.length === 0) {
      setSelectedSubscription(null)
      setSelectedSubscriptionEpisodes([])
      return
    }

    const active = selectedSubscription
      ? subscriptions.find((item) => item.id === selectedSubscription.id)
      : null
    const next = active || subscriptions[0]

    if (!selectedSubscription || selectedSubscription.id !== next.id) {
      void loadEpisodesForSubscription(next)
    }
  }, [subscriptions, selectedSubscription])

  useEffect(() => {
    if (!resumeItem || currentEpisode) {
      return
    }

    setCurrentEpisode({
      id: resumeItem.episode_id,
      feedId: resumeItem.feed_id,
      title: resumeItem.title,
      enclosureUrl: resumeItem.audio_url,
      duration: resumeItem.duration_sec,
    })

    setProgressByEpisode((prev) => ({
      ...prev,
      [resumeItem.episode_id]: {
        position: resumeItem.position_sec,
        duration: resumeItem.duration_sec,
      },
    }))
  }, [resumeItem, currentEpisode])

  useEffect(() => {
    if (!currentEpisode || !audioRef.current || !resumeItem) {
      return
    }
    if (resumeItem.episode_id !== currentEpisode.id || resumeItem.position_sec <= 0) {
      return
    }

    const audio = audioRef.current
    const applyResume = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= resumeItem.position_sec) {
        return
      }
      audio.currentTime = resumeItem.position_sec
      lastSavedSecondRef.current = resumeItem.position_sec
    }

    audio.addEventListener('loadedmetadata', applyResume)
    return () => audio.removeEventListener('loadedmetadata', applyResume)
  }, [currentEpisode, resumeItem])

  async function persistCurrentProgress() {
    if (!currentEpisode || !audioRef.current || !currentEpisode.enclosureUrl) {
      return
    }

    const second = Math.floor(audioRef.current.currentTime)
    const duration = Math.floor(audioRef.current.duration || currentEpisode.duration || 0)
    if (second <= 0 || Math.abs(second - lastSavedSecondRef.current) < 5) {
      return
    }

    lastSavedSecondRef.current = second

    setProgressByEpisode((prev) => ({
      ...prev,
      [currentEpisode.id]: {
        position: second,
        duration,
      },
    }))

    try {
      await setProgress(DEVICE_ID, {
        episodeId: currentEpisode.id,
        feedId: currentEpisode.feedId,
        title: currentEpisode.title,
        audioUrl: currentEpisode.enclosureUrl,
        positionSec: second,
        durationSec: duration,
      })
    } catch {
      // Best effort persistence.
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="kicker">Podcast uden reklame-overload</p>
          <h1>NordPod</h1>
          <p className="lead">
            Live-soegning, abonnementsliste med episoder til hoejre og seneste episoder
            fra alle abonnementer.
          </p>
        </div>
        <div className="status-panel">
          <p>Enhed: {DEVICE_ID}</p>
          <p>Abonnementer: {subscriptions.length}</p>
          <p>I seneste episoder: {queueEpisodes.length}</p>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'discover' ? 'active' : ''} onClick={() => setTab('discover')}>
          Udforsk
        </button>
        <button
          className={tab === 'subscriptions' ? 'active' : ''}
          onClick={() => setTab('subscriptions')}
        >
          Abonnementer
        </button>
        <button className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>
          Seneste episoder
        </button>
      </nav>

      {tab === 'discover' && (
        <section className="panel">
          <div className="search-row">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Soeg podcast eller vaert"
            />
            <select
              value={languageFilter}
              onChange={(event) => setLanguageFilter(event.target.value as 'all' | 'da')}
            >
              <option value="da">Dansk foerst</option>
              <option value="all">Alle sprog</option>
            </select>
            <button type="button" className="lucky" onClick={() => void feelLucky()}>
              Held &amp; lykke
            </button>
          </div>

          {loading && <p>Henter podcasts...</p>}
          {error && <p className="error-box">{error}</p>}

          {subscriptions.length > 0 && recommendations.length > 0 && (
            <>
              <h2>Forslag baseret paa dine abonnementer</h2>
              <div className="list-view recommendations">
                {recommendations.map((podcast) => (
                  <div
                    key={podcast.id}
                    className="list-row clickable-row"
                    onClick={() => void openPodcastFromRecommendation(podcast)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        void openPodcastFromRecommendation(podcast)
                      }
                    }}
                  >
                    <img src={podcast.image || '/icon.svg'} alt={podcast.title} />
                    <div>
                      <h3>{podcast.title}</h3>
                      <p>{podcast.author || 'Ukendt vaert'}</p>
                    </div>
                    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                      <button className="ghost" onClick={() => void ensureSubscribed(podcast)}>
                        {subscriptionIds.has(podcast.id) ? 'Abonneret' : 'Abonner'}
                      </button>
                      <button onClick={() => void playLatest(podcast)}>Afspil seneste</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="podcast-grid">
            {filteredPodcasts.map((podcast) => (
              <article key={podcast.id} className="podcast-card">
                <img src={podcast.image || '/icon.svg'} alt={podcast.title} loading="lazy" />
                <div className="card-content">
                  <p className="small-label">{podcast.language || 'ukendt sprog'}</p>
                  <h3>{podcast.title}</h3>
                  <p>{podcast.author || 'Ukendt vaert'}</p>
                </div>
                <div className="card-actions">
                  <button onClick={() => void playLatest(podcast)}>Afspil seneste</button>
                  <button className="ghost" onClick={() => void toggleSubscription(podcast)}>
                    {subscriptionIds.has(podcast.id) ? 'Abonneret' : 'Abonner'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === 'subscriptions' && (
        <section className="panel subscriptions-layout">
          <div className="subs-left">
            <h2>Dine abonnementer</h2>
            {subscriptions.length === 0 && <p>Ingen abonnementer endnu.</p>}
            <div className="list-view">
              {subscriptions.map((podcast) => (
                <div
                  key={podcast.id}
                  className={`list-row ${selectedSubscription?.id === podcast.id ? 'selected' : ''}`}
                >
                  <img src={podcast.image || '/icon.svg'} alt={podcast.title} />
                  <div>
                    <h3>{podcast.title}</h3>
                    <p>{podcast.author || 'Ukendt vaert'}</p>
                  </div>
                  <div className="row-actions">
                    <button className="ghost" onClick={() => void loadEpisodesForSubscription(podcast)}>
                      Episoder
                    </button>
                    <button className="danger" onClick={() => void toggleSubscription(podcast)}>
                      Fjern
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="subs-right">
            <h2>
              {selectedSubscription
                ? `Episoder: ${selectedSubscription.title}`
                : 'Vaelg et abonnement'}
            </h2>
            {selectedEpisodesLoading && <p>Henter episoder...</p>}
            {!selectedEpisodesLoading && selectedSubscriptionEpisodes.length === 0 && selectedSubscription && (
              <p>Ingen episoder fundet.</p>
            )}
            <div className="list-view">
              {selectedSubscriptionEpisodes.map((episode) => (
                <article key={episode.id} className="episode-card">
                  <div>
                    <h3>{episode.title}</h3>
                    <p>
                      {episode.datePublishedPretty || 'Dato ukendt'} · {formatDuration(episode.duration)}
                    </p>
                  </div>
                  <div className="card-actions inline">
                    <button onClick={() => startPlayback(episode, selectedSubscriptionEpisodes)}>
                      Afspil
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {tab === 'queue' && (
        <section className="panel">
          <div className="section-header">
            <h2>Nyeste episoder fra alle abonnementer</h2>
            {subscriptions.length > 0 && (
              <button className="ghost" onClick={() => void loadSubscriptionEpisodes(subscriptions)}>
                Opdater
              </button>
            )}
          </div>

          {subscriptions.length === 0 ? (
            <p>Abonner paa podcasts i Udforsk for at opbygge dine seneste episoder.</p>
          ) : subscriptionEpisodesLoading ? (
            <p>Henter nyeste episoder...</p>
          ) : queueEpisodes.length === 0 ? (
            <p>Ingen nye episoder lige nu. Du er opdateret paa alle abonnementer.</p>
          ) : (
            <div className="list-view">
              {queueEpisodes.map((episode) => {
                const p = progressByEpisode[episode.id]
                const duration = p?.duration || episode.duration || 0
                const position = Math.min(p?.position || 0, duration || Number.MAX_SAFE_INTEGER)
                const pct = duration > 0 ? Math.round((position / duration) * 100) : 0

                return (
                  <article
                    key={episode.id}
                    className="queue-row clickable-row"
                    onClick={() => void openPodcastFromQueueEpisode(episode)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        void openPodcastFromQueueEpisode(episode)
                      }
                    }}
                  >
                    <img src={episode.image || '/icon.svg'} alt={episode.title} loading="lazy" />
                    <div className="queue-info">
                      <p className="small-label">{episode.feedTitle || 'Ukendt podcast'}</p>
                      <h3>{episode.title}</h3>
                      <p>
                        {episode.datePublishedPretty || 'Dato ukendt'} · {formatDuration(episode.duration)}
                      </p>
                      {position > 0 && duration > 0 && (
                        <div className="progress-wrap" aria-label="Lytteprogression">
                          <div className="progress-bar">
                            <span style={{ width: `${pct}%` }} />
                          </div>
                          <p>{pct}% lyttet</p>
                        </div>
                      )}
                    </div>
                    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                      <button onClick={() => startPlayback(episode, queueEpisodes)}>Afspil</button>
                      <button className="danger" onClick={() => markEpisodeDismissed(episode.id)}>
                        Fjern
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      )}

      <footer className="player-bar">
        <div>
          <p className="small-label">Nu afspilles</p>
          <h3>{currentEpisode?.title || 'Vaelg en episode'}</h3>
          {currentPodcast && (
            <button className="player-podcast-link" onClick={() => void openPodcastFromPlayer()}>
              {currentPodcast.title}
            </button>
          )}
          {upNextEpisode && <p className="player-next">Naeste: {upNextEpisode.title}</p>}
        </div>
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={currentEpisode?.enclosureUrl || undefined}
          onTimeUpdate={() => void persistCurrentProgress()}
          onEnded={playNextInQueue}
        />
      </footer>
    </div>
  )
}

export default App
