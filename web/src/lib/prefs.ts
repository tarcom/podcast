// Indstillinger, der hører til ENHEDEN — telefonen, pc'en, bilen — og ikke til brugeren: filtrene
// i køen, afspilningshastigheden m.m. På telefonen er det typisk ★★ + ★★★ + Podcast, på pc'en
// noget andet. Device-id'et er fælles for alle enheder (allan-main), så de kan ikke ligge på
// serveren; de ligger i localStorage, som er pr. browser (og pr. Android-app).
const PREFIX = 'podcast_pref_'

export function loadPref<T>(key: string, fallback: T, valid: (v: unknown) => boolean = () => true): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw == null) return fallback
    const v: unknown = JSON.parse(raw)
    return valid(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // privat vindue eller fuld kvote — så huskes det bare ikke
  }
}
