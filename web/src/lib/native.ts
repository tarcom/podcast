// Android-app'en (projektet podcast-android): siden kører i en WebView med en bro,
// `window.AndroidHost`, og app'en sætter «AllDKPodcastsAndroid/<version>» sidst i user agent'en.
//
// Udgaverne, siden kender til:
//   1.x  (UA «/1.0»)  den første WebView-app. Pause = notifikationen forsvinder efter et minut.
//   3.x               holder afspilleren i forgrunden under pause (24 timer), genopretter siden
//                     hvis Android dræber den, signalerer forgrund/baggrund, broen til Stuen.
type AndroidHost = {
  luk?: () => void
  version?: () => string
  tvKald?: (id: string, metode: string, sti: string, krop: string) => void
}

export const host: AndroidHost | undefined =
  typeof window !== 'undefined' ? (window as unknown as { AndroidHost?: AndroidHost }).AndroidHost : undefined

const UA_MATCH = typeof navigator !== 'undefined' ? /\bAllDKPodcastsAndroid\/(\d+)/.exec(navigator.userAgent) : null
export const inAndroidApp = !!UA_MATCH
/** Hovedversionen af Android-app'en, eller null i en almindelig browser. */
export const appVersion: number | null = UA_MATCH ? Number(UA_MATCH[1]) : null

/** Seneste APK. Hæves, når en ny er lagt op — så beder siden ældre app'er om at opdatere. */
export const LATEST_APK = 3
export const APK_URL = 'https://aogj.com/podcast/app/alldkpodcasts.apk'
export const appOutdated = inAndroidApp && (appVersion ?? 0) < LATEST_APK

/** Sig til app'en, at afspilleren er lukket, så notifikationen forsvinder (findes fra 3.0). */
export function nativeClosePlayer(): void {
  try {
    host?.luk?.()
  } catch {
    /* ældre app uden luk() — notifikationen forsvinder så, når Android rydder op */
  }
}
