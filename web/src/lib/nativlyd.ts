// Android-app'en spiller selv lyden (fra 3.3, 2026-11-24), og siden er skærmen.
//
// HVORFOR: siden kører i WebView'ens egen proces, og under et opkald 24/11 lå den og sov. Da
// opkaldet var slut, kom lyden først igen, da app'en blev åbnet. Nu spiller app'en lyden med
// Androids egen afspiller (podcast-android/Lyd.kt, ExoPlayer) i den proces, som forgrundsservicen
// holder i live. Den klarer opkald (pause og videre bagefter), bilens og notifikationens knapper,
// høretelefoner, der falder fra, og huller i dækningen, også når siden sover.
//
// HVORDAN: resten af web-app'en er uændret. Den taler stadig med et <audio>-element, men i app'en
// efterligner dette modul elementet: src, play(), pause(), currentTime, paused, duration,
// readyState, networkState, error, buffered og playbackRate sendes til app'en
// (AndroidHost.lyd(json)), og app'ens tilstand kommer tilbage (window.__dkPodLyd(json)) som de
// hændelser, elementet selv ville sende (play, playing, pause, waiting, timeupdate, error, ended …).
// I en browser, og med en ældre app, sker der intet her.
//
// HENTEDE AFSNIT (offline) ligger i service workerens cache, som app'en ikke kan læse. Dem spiller
// siden selv som før (modus 'web'), og app'en viser dem i notifikationen gennem sit spejl.
import { host } from './native'
import { logg } from './logg'

type Fejl = { kode: number; navn: string; besked: string }
type Tilstand = {
  url: string
  nativ: boolean
  pos: number // sek.
  dur: number // sek., -1 = ukendt
  buf: number // sek. hentet foran
  vil: boolean // playWhenReady
  spiller: boolean
  undertrykt: boolean // fx under et opkald: står stille og fortsætter selv bagefter
  rate: number
  klar: boolean // har været klar til at spille (så er en senere fejl forbindelsen)
  t: number // Date.now() hos app'en, da tilstanden blev lavet
  seq: number
  tilstand: 'tom' | 'henter' | 'klar' | 'slut' | 'fejl'
  fejl?: Fejl
}

type Host = { lyd?: (json: string) => void; lydTilstand?: () => string }
const H = host as unknown as Host | undefined
const LYD_CACHE = 'nordpod-audio-v1'

/** Spiller app'en selv lyden (Android-app'en fra 3.3)? */
export const nativLydMuligt = !!H?.lyd

/** Spiller elementet lige nu gennem app'en? (Så er sidens egen vagt over lyden overflødig.) */
export function erNativ(el: HTMLAudioElement | null | undefined): boolean {
  return !!el && (el as unknown as { __dkPodModus?: string }).__dkPodModus === 'nativ'
}

let seq = 0
function send(o: Record<string, unknown>): number {
  seq++
  try {
    H?.lyd?.(JSON.stringify({ ...o, seq }))
  } catch {
    /* app'en svarer ikke — siden ser det på tilstanden */
  }
  return seq
}

// Afsnittet, der spilles: til notifikationen og til at app'en kan gemme positionen selv
let afsnit: Record<string, unknown> | null = null

/** Siden fortæller, hvilket afsnit der spilles (titel, podcast, billede, id'er til state.set). */
export function nativAfsnit(a: {
  episodeId: number
  feedId: number
  deviceId: string
  durationSec?: number
  titel: string
  podcast?: string
  billede?: string
}): void {
  if (!nativLydMuligt) return
  afsnit = { ...a }
  send({ cmd: 'afsnit', ...a })
}

/** Sove-timeren kører i app'en, så den holder, selvom siden sover. `null` slår den fra. */
export function nativSove(til: number | null): void {
  if (nativLydMuligt) send({ cmd: 'sove', til: til || 0 })
}

async function erHentet(url: string): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false
    const c = await caches.open(LYD_CACHE)
    return !!(await c.match(url, { ignoreVary: true }))
  } catch {
    return false
  }
}

/** Gør elementet til en fjernbetjening af app'ens afspiller. Kaldes én gang, når <audio> findes. */
export function installerNativLyd(el: HTMLAudioElement): void {
  if (!nativLydMuligt || (el as unknown as { __dkPodNativ?: boolean }).__dkPodNativ) return
  ;(el as unknown as { __dkPodNativ: boolean }).__dkPodNativ = true
  const P = HTMLMediaElement.prototype
  const E = Element.prototype
  const proto = (navn: string) => Object.getOwnPropertyDescriptor(P, navn)!
  const egen = el as unknown as { __dkPodModus?: string }

  let modus: 'ingen' | 'nativ' | 'web' = 'ingen'
  let kilde = ''
  let paused = true
  let startPos = 0
  let seekTil: number | null = null
  let rate = 1
  let standardRate = 1
  let preload = 'auto'
  let metaSendt = false
  let kildeSendt = false
  let foerste = true // første kilde efter indlæsning: spiller app'en den allerede, overtages den
  let venterSeq = 0 // ældre tilstande end denne kommando ændrer ikke pause/afspil
  let t: Tilstand | null = null
  let afgoer: Promise<void> | null = null
  let ventende: { ja: () => void; nej: (e: unknown) => void }[] = []

  // Løbenumrene fortsætter fra app'ens: siden kan være indlæst igen, mens app'en spillede videre
  seq = Math.max(seq, laesTilstand()?.seq ?? 0)

  const fyr = (navn: string) => el.dispatchEvent(new Event(navn))
  const opfyld = () => {
    const v = ventende
    ventende = []
    v.forEach((p) => p.ja())
  }
  const afvis = (navn: string, besked: string) => {
    const v = ventende
    ventende = []
    v.forEach((p) => p.nej(new DOMException(besked, navn)))
  }
  const aktuel = () => (t && t.url === kilde ? t : null)
  const web = () => modus === 'web'

  function absolut(v: string): string {
    try {
      return new URL(v, location.href).href
    } catch {
      return v
    }
  }

  function sendKilde() {
    kildeSendt = true
    venterSeq = send({ cmd: 'kilde', url: kilde, pos: startPos, rate, afsnit })
    startPos = 0
  }

  function saetKilde(v: string) {
    const url = absolut(String(v))
    afvis('AbortError', 'The play() request was interrupted by a new load request.')
    if (web()) {
      E.removeAttribute.call(el, 'src')
      P.load.call(el)
    }
    kilde = url
    modus = 'ingen'
    egen.__dkPodModus = undefined
    paused = true
    seekTil = null
    metaSendt = false
    kildeSendt = false
    startPos = 0
    fyr('loadstart')
    const denne = url
    afgoer = (async () => {
      const hentet = await erHentet(denne)
      if (kilde !== denne) return
      afgoer = null
      if (hentet) {
        // Offline-afsnit: siden spiller det selv som før, og app'en spejler det
        modus = 'web'
        egen.__dkPodModus = 'web'
        send({ cmd: 'web' })
        logg('lyd:modus', { modus: 'web' })
        E.setAttribute.call(el, 'src', denne)
        proto('preload').set!.call(el, preload)
        proto('defaultPlaybackRate').set!.call(el, standardRate)
        proto('playbackRate').set!.call(el, rate)
        if (startPos > 0) proto('currentTime').set!.call(el, startPos)
        if (!paused) P.play.call(el).then(opfyld, (e) => afvis('AbortError', String(e)))
        return
      }
      modus = 'nativ'
      egen.__dkPodModus = 'nativ'
      // Spiller app'en allerede afsnittet (siden er indlæst igen, mens lyden kørte): overtag det
      const nu = laesTilstand()
      if (foerste && nu && nu.url === denne && nu.nativ && nu.tilstand !== 'tom') {
        foerste = false
        kildeSendt = true
        logg('lyd:modus', { modus: 'nativ', overtaget: 1, pos: Math.round(nu.pos) })
        startPos = 0
        modtag(nu, true)
        if (!paused) send({ cmd: 'spil' })
        return
      }
      foerste = false
      logg('lyd:modus', { modus: 'nativ' })
      sendKilde()
      if (!paused) venterSeq = send({ cmd: 'spil' })
    })()
  }

  function ryd() {
    afvis('AbortError', 'The play() request was interrupted by a new load request.')
    if (web()) E.removeAttribute.call(el, 'src')
    else if (kilde) send({ cmd: 'stop' })
    kilde = ''
    modus = 'ingen'
    egen.__dkPodModus = undefined
    paused = true
    seekTil = null
    startPos = 0
    t = null
    afgoer = null
    kildeSendt = false
    metaSendt = false
    fyr('emptied')
  }

  function laesTilstand(): Tilstand | null {
    try {
      const raw = H?.lydTilstand?.()
      const o = raw ? (JSON.parse(raw) as Tilstand) : null
      return o && typeof o.pos === 'number' ? o : null
    } catch {
      return null
    }
  }

  // ---------- app'ens tilstand → elementets hændelser ----------
  function modtag(n: Tilstand, overtag = false) {
    if (modus !== 'nativ' || !kilde || n.url !== kilde) return
    const f = aktuel()
    t = n
    const gammel = n.seq < venterSeq && !overtag // fra før sidens seneste kommando
    if (seekTil !== null && Math.abs(n.pos - seekTil) < 2) {
      seekTil = null
      fyr('seeked')
    }
    if (!metaSendt && n.dur > 0) {
      metaSendt = true
      fyr('durationchange')
      fyr('loadedmetadata')
    }
    const spilSide = n.vil && !n.undertrykt && n.tilstand !== 'slut' && n.tilstand !== 'fejl'
    if (!gammel && spilSide && paused) {
      paused = false
      fyr('play')
    }
    if (n.spiller && (!f || !f.spiller || overtag)) {
      fyr('playing')
      opfyld()
    }
    if (!gammel && spilSide && n.tilstand === 'henter' && (!f || f.tilstand !== 'henter' || f.spiller)) fyr('waiting')
    if (n.tilstand === 'fejl' && (!f || f.tilstand !== 'fejl')) {
      afvis('NotSupportedError', n.fejl ? `${n.fejl.navn}: ${n.fejl.besked}` : 'fejl')
      fyr('error')
    }
    if (n.tilstand === 'slut' && (!f || f.tilstand !== 'slut')) {
      paused = true
      fyr('timeupdate')
      fyr('pause')
      fyr('ended')
      return
    }
    if (!gammel && !spilSide && !paused) {
      paused = true
      fyr('pause')
    }
    if (n.spiller || (f && Math.abs(f.pos - n.pos) > 1)) fyr('timeupdate')
    if (f && f.rate !== n.rate) fyr('ratechange')
  }
  ;(window as unknown as { __dkPodLyd?: (n: Tilstand) => void }).__dkPodLyd = (n) => {
    try {
      modtag(n)
    } catch {
      /* ignore */
    }
  }

  // ---------- elementets egenskaber og metoder ----------
  const def = (navn: string, get: () => unknown, set?: (v: never) => void) =>
    Object.defineProperty(el, navn, { configurable: true, get, set })
  const getP = (navn: string) => proto(navn).get!.call(el)
  const setP = (navn: string, v: unknown) => proto(navn).set!.call(el, v)

  def('src', () => (web() ? getP('src') : kilde), (v: string) => saetKilde(v))
  el.getAttribute = function (navn: string) {
    if (navn === 'src' && !web()) return kilde || null
    return E.getAttribute.call(this, navn)
  }
  el.hasAttribute = function (navn: string) {
    if (navn === 'src' && !web()) return !!kilde
    return E.hasAttribute.call(this, navn)
  }
  el.setAttribute = function (navn: string, v: string) {
    if (navn === 'src') return saetKilde(v)
    return E.setAttribute.call(this, navn, v)
  }
  el.removeAttribute = function (navn: string) {
    if (navn === 'src') return ryd()
    return E.removeAttribute.call(this, navn)
  }
  el.load = function () {
    if (web()) return P.load.call(el)
  }
  el.play = function () {
    if (web()) return P.play.call(el)
    if (!kilde) return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
    const p = new Promise<void>((ja, nej) => ventende.push({ ja, nej }))
    if (paused) {
      paused = false
      fyr('play')
    }
    if (afgoer) return p // spilles, når det er afgjort, hvem der spiller (se saetKilde)
    if (!kildeSendt) sendKilde()
    venterSeq = send({ cmd: 'spil' })
    const nu = aktuel()
    if (nu && nu.spiller) opfyld()
    return p
  }
  el.pause = function () {
    if (web()) return P.pause.call(el)
    afvis('AbortError', 'The play() request was interrupted by a call to pause().')
    if (!paused) {
      paused = true
      if (kildeSendt) venterSeq = send({ cmd: 'pause' })
      fyr('pause')
    }
  }
  def(
    'currentTime',
    () => {
      if (web()) return getP('currentTime')
      if (seekTil !== null) return seekTil
      const n = aktuel()
      if (!n || !kildeSendt) return startPos
      let pos = n.pos + (n.spiller ? ((Date.now() - n.t) / 1000) * n.rate : 0)
      if (n.dur > 0) pos = Math.min(pos, n.dur)
      return Math.max(0, pos)
    },
    (v: number) => {
      if (web()) return setP('currentTime', v)
      const pos = Math.max(0, Number(v) || 0)
      if (!kilde || !kildeSendt) {
        startPos = pos
        return
      }
      seekTil = pos
      venterSeq = send({ cmd: 'spol', pos })
      fyr('seeking')
    },
  )
  def('paused', () => (web() ? getP('paused') : paused))
  def('ended', () => (web() ? getP('ended') : aktuel()?.tilstand === 'slut'))
  def('seeking', () => (web() ? getP('seeking') : seekTil !== null))
  def('duration', () => {
    if (web()) return getP('duration')
    const n = aktuel()
    return n && n.dur > 0 ? n.dur : NaN
  })
  def('readyState', () => {
    if (web()) return getP('readyState')
    const n = aktuel()
    if (!kilde || !n || !kildeSendt) return 0
    switch (n.tilstand) {
      case 'klar':
      case 'slut':
        return 4
      case 'henter':
        return n.dur > 0 ? 2 : 0
      case 'fejl':
        return n.klar ? 1 : 0
      default:
        return 0
    }
  })
  def('networkState', () => {
    if (web()) return getP('networkState')
    const n = aktuel()
    if (!kilde) return 0
    if (n?.tilstand === 'fejl' && !n.klar) return 3
    if (!n || n.tilstand === 'henter') return 2
    return 1
  })
  def('error', () => {
    if (web()) return getP('error')
    const n = aktuel()
    return n?.tilstand === 'fejl' && n.fejl ? { code: n.fejl.kode, message: `${n.fejl.navn}: ${n.fejl.besked}` } : null
  })
  def('buffered', () => {
    if (web()) return getP('buffered')
    const n = aktuel()
    const pos = (el as unknown as { currentTime: number }).currentTime
    const har = !!n && n.dur > 0
    return {
      length: har ? 1 : 0,
      start: () => pos,
      end: () => pos + (n ? n.buf : 0),
    }
  })
  def(
    'playbackRate',
    () => (web() ? getP('playbackRate') : rate),
    (v: number) => {
      if (web()) return setP('playbackRate', v)
      const ny = Number(v) || 1
      if (ny === rate) return
      rate = ny
      if (kildeSendt) send({ cmd: 'rate', rate })
      fyr('ratechange')
    },
  )
  def(
    'defaultPlaybackRate',
    () => (web() ? getP('defaultPlaybackRate') : standardRate),
    (v: number) => {
      standardRate = Number(v) || 1
      if (web()) setP('defaultPlaybackRate', v)
    },
  )
  def(
    'preload',
    () => (web() ? getP('preload') : preload),
    (v: string) => {
      preload = String(v)
      if (web()) setP('preload', v)
    },
  )
  logg('lyd:nativ', { app: 'kan' })
}
