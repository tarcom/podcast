// Log over afspilningen (2026-11-24), så vi bagefter kan se, hvad der gik galt, og hvordan
// app'en bruges.
//
// HVORFOR: i bilen stod afspilleren stille, og da vi ville se efter, rakte telefonens egen log kun
// en time tilbage. Her noteres afspil og pause (og hvor de kom fra), lydens hændelser, fejl,
// genindlæsninger, net, forgrund og baggrund i en kø på enheden. Køen sendes til serveren i bundter
// (api/logg.php, gemmes et år), også når nettet først er tilbage efter et hul i dækningen. Læses med
// scraper/podcastlog.py på HTPC.
//
// Android-app'en (fra 3.2) har sin egen kø over det, kun den ser (PLAY fra bilen eller
// notifikationen, sidens proces lukket, app'en swipet væk, hvorfor processen døde). Den hentes
// herind med AndroidHost.loggHent() og sendes med resten.
//
// Hold hændelserne små og få: ingen timeupdate og ingen beskrivelser. Loggen må aldrig vælte
// afspilningen, så alt herinde er pakket ind i try/catch.
import { apiUrl, sendLog } from './api'
import { getDeviceId } from './device'
import { appVersionTekst, host } from './native'
import { BUILD_ID } from './version'

const KEY = 'podcast_logg'
const MAX = 2000 // hændelser, der venter på at blive sendt; de ældste ryger først
const BUNDT = 200
const SEND_EFTER_MS = 20_000

type Haendelse = { id: string; t: number; type: string } & Record<string, unknown>

const SESS = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
let nr = 0
let koe: Haendelse[] = laes()
let timer = 0
let sender = false
let sidsteNet: string | undefined
let appBaggrund = false

function laes(): Haendelse[] {
  try {
    const k = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown
    return Array.isArray(k) ? (k as Haendelse[]) : []
  } catch {
    return []
  }
}

function gem(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(koe))
  } catch {
    // Fuld (localStorage deles med resten af app'en): smid den ældste halvdel og prøv igen
    koe = koe.slice(-Math.floor(MAX / 2))
    try {
      localStorage.setItem(KEY, JSON.stringify(koe))
    } catch {
      /* så må loggen undvære */
    }
  }
}

/** Nettets type, som Android og Chrome oplyser den ("wifi", "cellular", ellers "4g" o.l.). */
function nettype(): string | undefined {
  const c = (navigator as unknown as { connection?: { type?: string; effectiveType?: string } }).connection
  return c ? c.type || c.effectiveType : undefined
}

function kort(v: unknown): unknown {
  return typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v
}

/** Notér en hændelse. `data` holdes lille: tal og korte tekster. */
export function logg(type: string, data: Record<string, unknown> = {}): void {
  try {
    const h: Haendelse = { id: `${SESS}.${nr++}`, t: Date.now(), type }
    for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null && v !== '') h[k] = kort(v)
    if (!navigator.onLine) h.off = 1
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') h.skjult = 1
    if (appBaggrund) h.bg = 1
    const n = nettype()
    if (n !== sidsteNet) {
      h.net = n || 'ukendt'
      sidsteNet = n
    }
    koe.push(h)
    if (koe.length > MAX) koe = koe.slice(-MAX)
    gem()
    planlaeg(SEND_EFTER_MS)
  } catch {
    /* loggen må aldrig vælte noget */
  }
}

function planlaeg(ms: number): void {
  if (timer) return
  timer = window.setTimeout(() => {
    timer = 0
    void send()
  }, ms)
}

/** Android-app'ens egne hændelser (fra 3.2) ind i køen. */
function hentNative(): void {
  try {
    const raw = host?.loggHent?.()
    if (!raw) return
    const liste = JSON.parse(raw) as unknown
    if (!Array.isArray(liste) || !liste.length) return
    for (const e of liste as Haendelse[]) if (e && e.id && e.t && e.type) koe.push(e)
    koe.sort((a, b) => a.t - b.t)
    if (koe.length > MAX) koe = koe.slice(-MAX)
    gem()
  } catch {
    /* ældre app eller et ugyldigt svar */
  }
}

/** Send det, der ligger i køen (op til BUNDT ad gangen). Fejler det, prøves der igen senere. */
export async function send(): Promise<void> {
  if (sender || !navigator.onLine) return
  hentNative()
  if (!koe.length) return
  sender = true
  try {
    const bundt = koe.slice(0, BUNDT)
    await sendLog({ deviceId: getDeviceId(), build: BUILD_ID, app: appVersionTekst, events: bundt })
    const sendt = new Set(bundt.map((h) => h.id))
    koe = koe.filter((h) => !sendt.has(h.id))
    gem()
    if (koe.length) planlaeg(1000)
  } catch {
    planlaeg(60_000)
  } finally {
    sender = false
  }
}

// Siden skjules eller lukkes: send med sendBeacon, som browseren gør færdig bagefter. Hændelserne
// bliver i køen og sendes igen næste gang; serveren gemmer hver hændelse én gang (id'et).
function beacon(): void {
  try {
    if (!navigator.onLine || !navigator.sendBeacon) return
    hentNative()
    if (!koe.length) return
    const body = { deviceId: getDeviceId(), build: BUILD_ID, app: appVersionTekst, events: koe.slice(0, 100) }
    navigator.sendBeacon(apiUrl('log.add'), new Blob([JSON.stringify(body)], { type: 'application/json' }))
  } catch {
    /* ignore */
  }
}

// Sidens eget liv: forgrund og baggrund (Android-app'ens signaler, visibilitychange er ikke til at
// stole på dér), net og lukning. Registreres én gang, når modulet indlæses.
if (typeof window !== 'undefined') {
  try {
    const nav = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type
    const forrige = koe.length ? koe[koe.length - 1].t : 0
    logg('start', {
      app: appVersionTekst,
      build: BUILD_ID,
      nav,
      kasseret: (document as unknown as { wasDiscarded?: boolean }).wasDiscarded ? 1 : undefined,
      sw: navigator.serviceWorker?.controller ? 1 : 0,
      venter: koe.length || undefined, // hændelser, der ikke nåede af sted sidst
      sidenMin: forrige ? Math.round((Date.now() - forrige) / 60000) : undefined,
    })
    window.addEventListener('online', () => {
      logg('online')
      void send()
    })
    window.addEventListener('offline', () => logg('offline'))
    document.addEventListener('visibilitychange', () => {
      logg(document.visibilityState === 'visible' ? 'synlig' : 'skjult')
      if (document.visibilityState === 'hidden') beacon()
    })
    window.addEventListener('dkpod:forgrund', () => {
      appBaggrund = false
      logg('forgrund')
      hentNative()
      void send()
    })
    window.addEventListener('dkpod:baggrund', () => {
      logg('baggrund')
      appBaggrund = true
      beacon()
    })
    window.addEventListener('pagehide', () => {
      logg('lukket')
      beacon()
    })
    // Android-app'en (3.2) siger til, når den har skrevet noget i sin egen log
    window.addEventListener('dkpod:logg', () => {
      hentNative()
      planlaeg(SEND_EFTER_MS)
    })
    // Testene kan sende med det samme i stedet for at vente SEND_EFTER_MS.
    ;(window as unknown as { __dkPodLogSend?: () => Promise<void> }).__dkPodLogSend = send
    window.setTimeout(() => void send(), 3000)
  } catch {
    /* ignore */
  }
}
