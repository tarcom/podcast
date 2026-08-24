// Holder afspilleren i notifikationsskuffen i live et stykke tid efter man har pauset.
//
// HVORFOR: en installeret PWA har ingen foreground service, som en rigtig app (Castbox) har.
// Pauser man, er siden bare en baggrundsfane for Android: Chrome fryser den efter et par
// minutter, og mangler telefonen hukommelse bliver den kasseret — så forsvinder afspilleren fra
// skuffen, og man kan ikke trykke play igen. Der findes ingen web-API der kan bede om at blive
// skånet.
//
// MODTRÆKKET: afspil LYDLØS lyd mens der er pauset. Så regner Android app'en for "afspiller
// lyd", lader processen være, og notifikationen bliver stående.
//
// PRISEN, og derfor grænsen: keep-alive holder lydfokus (starter man Spotify, tager den fokus
// og vores stilhed stopper) og koster en smule batteri — og i en bil holder den
// Bluetooth-lydkanalen åben. Den slukker derfor af sig selv efter LIMIT_MS.
//
// TO GRÆNSER, fordi prisen er vidt forskellig de to steder:
//
// I Teslas browser er det hverken et batteri- eller et Bluetooth-spørgsmål — bilen ER lydkilden.
// Til gengæld er det dér, keep-alive betyder mest: Tesla lukker browseren når man forlader den,
// og den er langsom at hente siden frem igen. Holder app'en lyd i gang, bliver browseren liggende
// i baggrunden, og både denne fane og et evt. andet vindue overlever. Derfor to timer der — nok
// til en hel etape mellem to stop.
//
// På telefonen står de ti minutter. Der ER prisen reel: lydfokus og en åben Bluetooth-kanal
// koster batteri, og man pauser typisk fordi man er færdig for nu.
//
// Teslas browser identificerer sig med «Tesla/<version>» sidst i sin user agent, fx
// «… Safari/537.36 Tesla/2021.36.5.5-c6d521764ab9». Holder Tesla en dag op med det, falder vi
// tilbage til de ti minutter — det er den ufarlige vej at fejle på.
const I_TESLA = typeof navigator !== 'undefined' && /\bTesla\//.test(navigator.userAgent)
const LIMIT_MS = I_TESLA ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000

// VIGTIGT: lyden må hverken være `muted` eller have `volume = 0`. En dæmpet lydstrøm tæller
// ikke som "afspiller lyd", og så holder trickget ingenting i live. Filen er tavs i stedet.
function silentWavUrl(seconds = 1): string {
  const rate = 8000 // 8-bit mono @ 8 kHz — 8 KB pr. sekund er rigeligt til stilhed
  const samples = rate * seconds
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const ascii = (off: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(off + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true) // fmt-chunkens længde
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true) // bytes pr. sekund
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits pr. sample
  ascii(36, 'data')
  view.setUint32(40, samples, true)
  bytes.fill(128, 44) // 8-bit PCM: 128 = nul-udsving = stilhed
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return 'data:audio/wav;base64,' + btoa(bin)
}

let el: HTMLAudioElement | null = null
let timer = 0

/** Start (eller forlæng) keep-alive. Kaldes når afspilningen sættes på pause. */
export function startKeepAlive(): void {
  if (!el) {
    el = new Audio(silentWavUrl())
    el.loop = true
    el.preload = 'auto'
  }
  window.clearTimeout(timer)
  // Fejler kun hvis siden aldrig har haft en brugerhandling — og så har man heller ikke
  // afspillet noget, så der er intet at holde i live.
  el.play().catch(() => {})
  timer = window.setTimeout(stopKeepAlive, LIMIT_MS)
}

/** Stop keep-alive — når der afspilles rigtig lyd igen, eller når tiden er gået. */
export function stopKeepAlive(): void {
  window.clearTimeout(timer)
  timer = 0
  el?.pause()
}
