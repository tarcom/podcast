// Tids- og hastighedsformat, der bruges flere steder (afspilleren, køen, Stuen).

/** Klokke-format til tidslinjer: m:ss eller t:mm:ss. */
export function fmtClock(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  sec = Math.floor(sec)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`
}

/** Afspilningshastighed: 1×, 1,5×, 0,8× … */
export function fmtRate(r: number): string {
  return `${r.toLocaleString('da-DK', { maximumFractionDigits: 2 })}×`
}
