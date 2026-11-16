// Androids tilbage-knap i app'en: MainActivity spørger `window.__dkPodTilbage()`, før den lægger
// app'en i baggrunden. Det øverste, der er åbent (afspilleren i fuld størrelse, en pop-up, en
// mappe i Stuen), lukkes først. Hver del registrerer sin egen lukker, mens den er åben; den
// senest registrerede vinder.
const stack: (() => boolean)[] = []

export function pushBack(fn: () => boolean): () => void {
  stack.push(fn)
  return () => {
    const i = stack.lastIndexOf(fn)
    if (i >= 0) stack.splice(i, 1)
  }
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __dkPodTilbage?: () => boolean }).__dkPodTilbage = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      try {
        if (stack[i]()) return true
      } catch {
        /* en lukker der fejler, må ikke spærre tilbage-knappen */
      }
    }
    return false
  }
}
