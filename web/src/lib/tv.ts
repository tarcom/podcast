// Stuen: fjernbetjeningen til tv'et (LG + Kodi + Denon) — tjenesten tv-helper på HTPC, projektet
// `tv`. Den samme tjeneste ligger bag aogj.com/tv; her er den en fane i podcast-app'en.
//
// TO VEJE TIL HTPC:
// - I Chrome henter siden direkte fra http://192.168.1.85:8097. Det kræver, at Chrome har givet
//   aogj.com lov til "enheder på dit lokale netværk" (samme tilladelse som aogj.com/tv), og det
//   virker kun hjemme.
// - I Android-app'en må WebView'en ikke kalde http fra en https-side, og den kan ikke spørge om
//   lov. Der går kaldet gennem app'en: AndroidHost.tvKald → Kotlin laver kaldet → svaret kommer
//   tilbage i window.__dkPodTvSvar.
import { host } from './native'

export const TV_BASE = 'http://192.168.1.85:8097'

export type TvPost = {
  sti: string
  navn: string
  mappe: boolean
  antal?: number
  tid: number
  str?: number
  strm?: boolean
  afspil?: string | null
  titel: string
  opl?: string | null
  set?: number | null
  kilde?: string
}

export type TvMeta = { episodeId?: number; feedId?: number; durationSec?: number }

export type TvSpiller = {
  titel: string
  sti: string | null
  fil?: string | null
  type?: string | null
  tid: number
  laengde: number
  pause: boolean
  undertekst: string | null
  antal_undertekster: number
  lydspor: string | null
  antal_lydspor: number
  podcast?: TvMeta | null
}

/** Podcasten fra appen, der spiller et andet sted end telefonen (Kodi på tv'et eller en højttaler). */
export type TvFjern = {
  maal: string // "stuen" eller højttalerens Cast-id
  navn: string
  titel: string | null
  podcast: TvMeta | null
  spiller: boolean
  pause: boolean
  tid: number
  laengde: number
  slut: boolean
  lydstyrke?: number | null // højttaler 0-100, Denon'en 0-98
}

export type TvStatus = {
  tv: { taendt: boolean; app: string | null; skaerm?: boolean }
  kodi: { koerer: boolean; spiller: TvSpiller | null } | null
  denon: { taendt: boolean; indgang: string | null; lydstyrke: number | null; mute: boolean } | null
  job: { trin: string | null; fejl: string | null; sti: string | null; tid: number; url?: string | null; titel?: string | null; maal?: string | null }
  fjern?: TvFjern | null // fra tv-helper 2026-11-17
}

/** Et sted, en podcast kan spilles: tv'et i stuen eller en Google Home-højttaler. */
export type TvMaal = { id: string; navn: string; type: 'tv' | 'cast'; model?: string; gruppe?: boolean }

/** En video på HTPC's disk (torrent eller DR TV-afsnit), klar til tv'et eller telefonen. */
export type TvVideo = { sti: string; titel: string; url?: string; type?: string; str?: number }
export type TvFund = TvVideo & {
  fundet: boolean
  mappe?: boolean
  antal?: number
  afspil?: string | null // den ene video i mappen, ellers null (sæsonpakke: se filer)
  filer?: TvVideo[]
}

/** HTPC kunne ikke nås — typisk fordi man ikke er hjemme. */
export class TvUnreachable extends Error {}

type Ventende = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
const ventende = new Map<string, Ventende>()
let naesteId = 0

if (typeof window !== 'undefined') {
  ;(window as unknown as { __dkPodTvSvar?: (id: string, status: number, tekst: string) => void }).__dkPodTvSvar = (
    id,
    status,
    tekst,
  ) => {
    const v = ventende.get(id)
    if (!v) return
    ventende.delete(id)
    window.clearTimeout(v.timer)
    if (status === 0) v.reject(new TvUnreachable(tekst || 'ingen forbindelse'))
    else if (status >= 400) v.reject(new Error(tekst || `HTTP ${status}`))
    else {
      try {
        v.resolve(JSON.parse(tekst))
      } catch {
        v.reject(new Error('ugyldigt svar fra HTPC'))
      }
    }
  }
}

function viaApp<T>(metode: string, sti: string, krop: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = `tv${++naesteId}`
    const timer = window.setTimeout(() => {
      ventende.delete(id)
      reject(new TvUnreachable('timeout'))
    }, timeoutMs)
    ventende.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    host!.tvKald!(id, metode, sti, krop === undefined ? '' : JSON.stringify(krop))
  })
}

async function viaFetch<T>(metode: string, sti: string, krop: unknown, timeoutMs: number): Promise<T> {
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), timeoutMs)
  let r: Response
  try {
    r = await fetch(TV_BASE + sti, {
      method: metode,
      cache: 'no-store',
      headers: krop === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: krop === undefined ? undefined : JSON.stringify(krop),
      signal: ctl.signal,
    })
  } catch {
    throw new TvUnreachable('ingen forbindelse')
  } finally {
    window.clearTimeout(timer)
  }
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  return (await r.json()) as T
}

function kald<T>(metode: 'GET' | 'POST', sti: string, krop?: unknown, timeoutMs = 9000): Promise<T> {
  return host?.tvKald ? viaApp<T>(metode, sti, krop, timeoutMs) : viaFetch<T>(metode, sti, krop, timeoutMs)
}

export const tvListe = (mappe = '') =>
  kald<{ poster: TvPost[]; scannet: number }>('GET', `/api/liste?mappe=${encodeURIComponent(mappe)}`, undefined, 20000)
export const tvStatus = () => kald<TvStatus>('GET', '/api/status')
export const tvAfspil = (sti: string) => kald<{ ok: boolean }>('POST', '/api/afspil', { sti })
/** En podcast på tv'et (maal "stuen") eller en højttaler: afspilles fra `start` sekunder. */
export const tvAfspilUrl = (
  url: string,
  titel: string,
  start: number,
  meta: TvMeta,
  maal = 'stuen',
  ekstra: { billede?: string; udgiver?: string } = {},
) => kald<{ ok: boolean }>('POST', '/api/afspil', { url, titel, start: Math.floor(start), meta, maal, ...ekstra })
/** Hvor en podcast kan spilles ud over telefonen. */
export const tvMaal = () => kald<{ maal: TvMaal[] }>('GET', '/api/maal', undefined, 6000)
/** Pause, spol og stop på det, appen har sendt et andet sted hen. */
export const tvFjern = (handling: string, ekstra: Record<string, unknown> = {}) =>
  kald<{ ok: boolean }>('POST', '/api/fjern', { handling, ...ekstra })
/** En torrent (navnet fra qBittorrent) eller et DR TV-afsnit (DR's nummer) på disken. */
export const tvFind = (q: { navn?: string; drtv?: string }) =>
  kald<TvFund>(
    'GET',
    '/api/find?' + (q.drtv ? `drtv=${encodeURIComponent(q.drtv)}` : `navn=${encodeURIComponent(q.navn || '')}`),
    undefined,
    20000,
  )
export const tvTaend = () => kald<{ ok: boolean }>('POST', '/api/taend', {})
export const tvKontrol = (handling: string, ekstra: Record<string, unknown> = {}) =>
  kald<{ ok: boolean }>('POST', '/api/kontrol', { handling, ...ekstra })

/** Et job (tænd, afspil) er i gang på HTPC, hvis trinnet er nyt og ikke et sluttrin. */
export function jobIGang(s: TvStatus | null): boolean {
  const j = s?.job
  return !!j?.trin && !['Afspiller', 'Klar', 'Fejl'].includes(j.trin) && Date.now() / 1000 - j.tid < 120
}

// ---------- formatering (samme som aogj.com/tv) ----------
export function tvDato(sek: number): string {
  const d = new Date(sek * 1000)
  const nu = new Date()
  const dage = Math.round((new Date(nu.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5)
  const kl = d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })
  if (dage === 0) return 'i dag ' + kl
  if (dage === 1) return 'i går ' + kl
  const opt: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  if (d.getFullYear() !== nu.getFullYear()) opt.year = 'numeric'
  return d.toLocaleDateString('da-DK', opt)
}

export function tvStr(b?: number): string {
  if (!b) return ''
  return b >= 1e9 ? (b / 1e9).toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' GB' : Math.round(b / 1e6) + ' MB'
}
