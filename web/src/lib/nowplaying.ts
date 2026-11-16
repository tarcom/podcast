// Det afsnit, der står i afspilleren, så det overlever at siden genindlæses.
//
// HVORFOR: afspilleren lå kun i Reacts hukommelse. En ny udgave af app'en (service workeren
// genindlæser siden), Android der dræber WebView'ens proces, eller bare at app'en åbnes forfra,
// tømte den — og så var afsnittet væk fra både app'en og notifikationen. Nu står det der igen,
// på pause og på den plads man slap, klar til at trykke afspil.
import type { EpisodeRow } from '../types'

const KEY = 'podcast_nowplaying'

export type NowPlaying = {
  ep: EpisodeRow
  pos: number // sekunder
  dur: number // sekunder (0 = ukendt)
  at: number // Date.now(), da positionen blev gemt — sammenlignes med serverens updated_at
}

export function saveNowPlaying(ep: EpisodeRow, pos: number, dur: number): void {
  try {
    // Beskrivelsen kan fylde 60 KB og hentes igen ved behov.
    const slim: EpisodeRow = { ...ep, description: undefined }
    const np: NowPlaying = { ep: slim, pos: Math.max(0, Math.floor(pos)), dur: Math.floor(dur || 0), at: Date.now() }
    localStorage.setItem(KEY, JSON.stringify(np))
  } catch {
    /* ignore */
  }
}

export function readNowPlaying(): NowPlaying | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const np = JSON.parse(raw) as NowPlaying
    return np && np.ep && np.ep.audioUrl ? np : null
  } catch {
    return null
  }
}

export function clearNowPlaying(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
