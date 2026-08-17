// Offline-download af afsnit. Bytes ligger i Cache API; service workeren serverer dem, så
// `<audio src=afsnittets rigtige URL>` virker uændret uden dækning (se public/sw.js).
//
// HVORFOR mode:'no-cors' OG IKKE en læsbar Blob (målt i rigtig Chrome mod aogj.com 2026-08-17):
// kun 3 af de 7 lyd-CDN'er i Allans kø sender CORS på det hop hvor bytes leveres — api.dr.dk,
// traffic.omny.fm og api.spreaker.com. media.pod.space, www.buzzsprout.com og BEGGE
// simplecastaudio-værter fejler med "TypeError: Failed to fetch". En CORS-baseret download ville
// altså stille og roligt udelade en tredjedel af køen.
// Et opaque svar kan derimod hentes fra ALLE værter, lægges i Cache API og afspilles gennem
// service workeren — inkl. korrekt varighed og spoling (verificeret: 65-min afsnit fra
// media.pod.space, spolet til 63:57, landede rigtigt og spillede videre).
// Den læsbare Blob-vej blev afprøvet og FRAVALGT: et Response man selv bygger i JS er ikke
// byte-range-dueligt, så `audio.seekable` blev [0,0] og spoling var umulig. Procentvis
// fremdrift er derfor ikke mulig — vi viser en spinner pr. afsnit og "N af M" ved bulk.
import type { EpisodeRow } from '../types'

export const AUDIO_CACHE = 'nordpod-audio-v1'
const INDEX_KEY = 'podcast_downloads'

export type DownloadMeta = {
  ep: EpisodeRow // hele rækken, så Hentet-fanen kan tegnes helt uden netværk
  url: string // audioUrl = nøglen i Cache API
  addedAt: number // unix ms
  bytesEst: number // SKØN. Se sizeNote() — den målte størrelse er ubrugelig pr. afsnit.
}

type Index = Record<string, DownloadMeta>

export function downloadsSupported(): boolean {
  return typeof caches !== 'undefined' && 'serviceWorker' in navigator
}

// ---------- indeks (localStorage) ----------
function readIndex(): Index {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || '{}') as Index
  } catch {
    return {}
  }
}
function writeIndex(ix: Index): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(ix))
  } catch {
    // fuldt localStorage må ikke vælte app'en — lyden ligger i Cache API uanset hvad
  }
}

// Beskrivelser er RSS-HTML og kan være mange kilobytes; indekset skal blive i localStorage,
// så vi kapper dem. Resten af rækken er små felter.
function slim(ep: EpisodeRow): EpisodeRow {
  return { ...ep, description: (ep.description || '').slice(0, 4000) }
}

export function listDownloads(): DownloadMeta[] {
  return Object.values(readIndex()).sort((a, b) => b.addedAt - a.addedAt)
}

// ---------- plads ----------
export type StorageInfo = { usage: number; quota: number }
export async function storageInfo(): Promise<StorageInfo | null> {
  if (!navigator.storage?.estimate) return null
  const est = await navigator.storage.estimate()
  return { usage: est.usage || 0, quota: est.quota || 0 }
}

// Uden persist() må Android smide hentede afsnit væk når pladsen bliver trang — præcis dét man
// ikke opdager før man står uden dækning. Installerede PWA'er får som regel ja uden at spørge.
export async function ensurePersisted(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

// ---------- selve hentningen ----------
async function ensureController(): Promise<void> {
  if (navigator.serviceWorker.controller) return
  await navigator.serviceWorker.ready
  for (let i = 0; i < 20 && !navigator.serviceWorker.controller; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!navigator.serviceWorker.controller) {
    throw new Error('Offline-motoren er ikke klar endnu. Genindlæs siden og prøv igen.')
  }
}

// Bevis at det hentede rent faktisk er lyd der kan afspilles.
// Nødvendigt fordi et opaque svar ALTID har status 0: får vi et 403 eller en fejlside fra
// CDN'et, ser hentningen vellykket ud, og man opdager det først uden dækning. Størrelsen kan
// ikke bruges til at afsløre det — Chrome polstrer opaque svar tilfældigt (samme fejlside målte
// 2, 7,2, 9,9 og 13,7 MB i fire forsøg).
function probePlayable(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const a = new Audio()
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      a.removeAttribute('src')
      a.load()
      fn()
    }
    const timer = window.setTimeout(
      () => finish(() => reject(new Error('Tidsudløb ved kontrol af den hentede fil'))),
      30000,
    )
    a.preload = 'metadata'
    a.addEventListener('loadedmetadata', () => finish(() => resolve(a.duration || 0)))
    a.addEventListener('error', () =>
      finish(() => reject(new Error('Udbyderen afviste hentningen — afsnittet kan ikke gemmes'))),
    )
    a.src = url
    a.load()
  })
}

async function cacheQuietly(cache: Cache, url: string): Promise<void> {
  try {
    await cache.put(url, await fetch(url, { mode: 'no-cors' }))
  } catch {
    // fx cover-billede — pynt, ikke en fejl der skal stoppe en download
  }
}

export async function downloadEpisode(ep: EpisodeRow): Promise<DownloadMeta> {
  if (!ep.audioUrl) throw new Error('Afsnittet har ingen lydfil (kun link til udbyderen)')
  await ensureController()
  await ensurePersisted()
  const url = ep.audioUrl
  const cache = await caches.open(AUDIO_CACHE)

  await cache.put(url, await fetch(url, { mode: 'no-cors' }))

  let duration = 0
  try {
    duration = await probePlayable(url)
  } catch (err) {
    await cache.delete(url) // ikke lade en ubrugelig fil optage plads og se hentet ud
    throw err
  }

  // Cover med, så Hentet-listen ser rigtig ud uden netværk.
  const art = ep.image || ep.podcastImage
  if (art) await cacheQuietly(cache, art)

  const secs = duration || ep.durationSec || 0
  const meta: DownloadMeta = { ep: slim(ep), url, addedAt: Date.now(), bytesEst: Math.round((secs / 60) * 1_000_000) }
  const ix = readIndex()
  ix[String(ep.episodeId)] = meta
  writeIndex(ix)
  return meta
}

export async function removeDownload(episodeId: number): Promise<void> {
  const ix = readIndex()
  const meta = ix[String(episodeId)]
  if (!meta) return
  delete ix[String(episodeId)]
  writeIndex(ix)
  try {
    const cache = await caches.open(AUDIO_CACHE)
    await cache.delete(meta.url)
  } catch {
    // indekset er ryddet uanset hvad; en forældreløs cache-post ryddes af reconcile()
  }
}

export async function removeAllDownloads(): Promise<void> {
  writeIndex({})
  try {
    await caches.delete(AUDIO_CACHE)
  } catch {
    /* ignore */
  }
}

// Browseren kan have smidt filer ud (typisk hvis persist() blev afvist). Ryd indekset for
// afsnit hvis bytes er væk, så listen ikke lover noget der ikke er der.
export async function reconcileDownloads(): Promise<number> {
  if (!downloadsSupported()) return 0
  const ix = readIndex()
  const entries = Object.entries(ix)
  if (!entries.length) return 0
  let dropped = 0
  try {
    const cache = await caches.open(AUDIO_CACHE)
    for (const [id, meta] of entries) {
      if (!(await cache.match(meta.url))) {
        delete ix[id]
        dropped++
      }
    }
  } catch {
    return 0
  }
  if (dropped) writeIndex(ix)
  return dropped
}

export function fmtBytes(bytes: number): string {
  if (!bytes) return '0 MB'
  const gb = bytes / 1_073_741_824
  if (gb >= 1) return `${gb.toFixed(1).replace('.', ',')} GB`
  return `${Math.round(bytes / 1_048_576)} MB`
}
