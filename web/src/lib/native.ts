// Android-app'en (projektet podcast-android): siden kører i en WebView med en bro,
// `window.AndroidHost`, og app'en sætter «AllDKPodcastsAndroid/<version>» sidst i user agent'en.
//
// Udgaverne, siden kender til:
//   1.x  (UA «/1.0»)  den første WebView-app. Pause = notifikationen forsvinder efter et minut.
//   3.x               holder afspilleren i forgrunden under pause (24 timer), genopretter siden
//                     hvis Android dræber den, signalerer forgrund/baggrund, broen til Stuen.
//   3.1               video fra HTPC i telefonens egen afspiller (aabnVideo), notifikationer om
//                     nye afsnit med ★★★, og app'en ser selv efter en ny udgave (opdater).
//   3.2               sin egen log (loggHent, signalet dkpod:logg): kommandoer og deres afsender
//                     (bilen, notifikationen), sidens proces lukket, swipe, hvorfor processen døde.
type AndroidHost = {
  luk?: () => void
  version?: () => string
  tvKald?: (id: string, metode: string, sti: string, krop: string) => void
  aabnVideo?: (url: string, titel: string, type: string) => void
  opdater?: () => void
  /** Afsnittet fra en notifikation, der er trykket på: JSON {id, feedId, afspil} eller '' (tømmes). */
  ventendeAfsnit?: () => string
  /** Fra 3.2: app'ens egne loghændelser siden sidst, som JSON-liste (tømmes). Se lib/logg.ts. */
  loggHent?: () => string
}

export const host: AndroidHost | undefined =
  typeof window !== 'undefined' ? (window as unknown as { AndroidHost?: AndroidHost }).AndroidHost : undefined

const UA_MATCH =
  typeof navigator !== 'undefined' ? /\bAllDKPodcastsAndroid\/(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(navigator.userAgent) : null
export const inAndroidApp = !!UA_MATCH
/** Hovedversionen af Android-app'en, eller null i en almindelig browser. */
export const appVersion: number | null = UA_MATCH ? Number(UA_MATCH[1]) : null
/** Hele versionen som tekst ("3.1.0"), eller '' i en almindelig browser. Står i loggen. */
export const appVersionTekst = UA_MATCH ? [UA_MATCH[1], UA_MATCH[2] || '0', UA_MATCH[3] || '0'].join('.') : ''
/** Hele versionen som ét tal (3.1.0 -> 30100), så den kan sammenlignes. */
const appVersionNum = UA_MATCH ? Number(UA_MATCH[1]) * 10000 + Number(UA_MATCH[2] || 0) * 100 + Number(UA_MATCH[3] || 0) : 0

/** Seneste APK. Hæves, når en ny er lagt op — så beder siden ældre app'er om at opdatere.
 *  Fra 3.1 ser app'en også selv efter en ny udgave (app/version.json); det her er til de
 *  ældre, der ikke kan det. */
export const LATEST_APK = '3.1.0'
export const APK_URL = 'https://aogj.com/podcast/app/alldkpodcasts.apk'
const LATEST_NUM = LATEST_APK.split('.').reduce((a, x, i) => a + Number(x) * [10000, 100, 1][i], 0)
export const appOutdated = inAndroidApp && appVersionNum < LATEST_NUM
/** Kan app'en selv hente og installere en ny udgave (3.1 og frem)? */
export const kanOpdatereSelv = !!host?.opdater

/** Afspil en video i telefonens egen afspiller (Kodi, VLC …). Kun i app'en fra 3.1. */
export function aabnVideoIApp(url: string, titel: string, type: string): boolean {
  if (!host?.aabnVideo) return false
  try {
    host.aabnVideo(url, titel, type || 'video/*')
    return true
  } catch {
    return false
  }
}

/** Sig til app'en, at afspilleren er lukket, så notifikationen forsvinder (findes fra 3.0). */
export function nativeClosePlayer(): void {
  try {
    host?.luk?.()
  } catch {
    /* ældre app uden luk() — notifikationen forsvinder så, når Android rydder op */
  }
}
