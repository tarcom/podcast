// To ting der skal virke uden dækning, og som hentede lydfiler alene ikke løser:
//
// 1) APP'EN SKAL KUNNE ÅBNE. Service workeren har altid kunnet servere selve skallen, men alt
//    indhold kom fra api/index.php, som er dødt offline — så man fik en tom app. Derfor gemmer
//    vi køen og favoritterne som et øjebliksbillede og tegner det med det samme; netværkssvaret
//    overskriver det bagefter når der er hul igennem.
// 2) LYTNINGEN MÅ IKKE GÅ TABT. state.set fejler offline, og hørt/position ligger kun på
//    serveren. Uden en udbakke ville to uger uden dækning betyde at alt dukker op som uhørt
//    igen, og at man mister sin plads midt i et afsnit. Skrivningerne lægges derfor i kø og
//    sendes når forbindelsen er tilbage.
import { apiUrl, setState } from './api'

// ---------- øjebliksbillede ----------
const SNAP_PREFIX = 'podcast_snap_'

export function saveSnapshot(key: string, data: unknown): void {
  try {
    localStorage.setItem(SNAP_PREFIX + key, JSON.stringify(data))
  } catch {
    // fuldt localStorage er ikke værd at vælte app'en over
  }
}

export function readSnapshot<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(SNAP_PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

// ---------- udbakke ----------
const OUTBOX_KEY = 'podcast_state_outbox'

export type StateWrite = {
  episodeId: number
  feedId: number
  played?: boolean
  positionSec?: number
  durationSec?: number
}

function readOutbox(): Record<string, StateWrite> {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '{}') as Record<string, StateWrite>
  } catch {
    return {}
  }
}
function writeOutbox(box: Record<string, StateWrite>): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(box))
  } catch {
    /* ignore */
  }
}

// Én post pr. afsnit: nyeste værdi pr. felt vinder. Uden sammenlægningen ville et afsnit man
// lytter til i timevis lægge en ny post hvert 8. sekund.
function remember(w: StateWrite): void {
  const box = readOutbox()
  box[String(w.episodeId)] = { ...box[String(w.episodeId)], ...w }
  writeOutbox(box)
}

export function outboxSize(): number {
  return Object.keys(readOutbox()).length
}

// Gem lytte-tilstand: prøv nettet, og læg den i udbakken hvis det fejler.
export async function saveStateResilient(deviceId: string, w: StateWrite): Promise<void> {
  if (!navigator.onLine) {
    remember(w)
    return
  }
  try {
    await setState(deviceId, w)
  } catch {
    remember(w)
  }
}

// Sidste udkald: app'en er ved at blive lukket eller kasseret af Android. En almindelig POST
// når ikke af sted der (axios' XHR aflyses med siden), men `sendBeacon` overlader afsendelsen
// til browseren, som gør den færdig bagefter. Lykkes selv dét ikke, ryger skrivningen i
// udbakken og sendes næste gang app'en åbnes.
export function beaconState(deviceId: string, w: StateWrite): void {
  try {
    const blob = new Blob([JSON.stringify({ deviceId, ...w })], { type: 'application/json' })
    if (navigator.sendBeacon(apiUrl('state.set'), blob)) return
  } catch {
    // sendBeacon findes ikke, eller kvoten er brugt
  }
  remember(w)
}

// Tøm udbakken. Returnerer hvor mange der kom af sted. Stopper ved første fejl, så vi ikke
// hamrer løs på en server der er nede — resten bliver liggende til næste forsøg.
export async function flushOutbox(deviceId: string): Promise<number> {
  if (!navigator.onLine) return 0
  const box = readOutbox()
  const ids = Object.keys(box)
  if (!ids.length) return 0
  let sent = 0
  for (const id of ids) {
    try {
      await setState(deviceId, box[id])
      delete box[id]
      sent++
    } catch {
      break
    }
  }
  writeOutbox(box)
  return sent
}
