// Er der kommet en ny udgave af siden, siden denne blev indlæst?
//
// Service workeren opdaterer sig selv, men kun når sw.js ændrer sig, og den genindlæser kun en
// side, der skifter controller. En side, der aldrig lukkes — en installeret PWA, og især
// Android-app'en, hvor siden lever så længe processen gør — kunne derfor køre på gammel kode i
// dagevis efter et deploy. Hvert byg har et id; version.json på serveren siger hvilket der er
// lagt op, og App.tsx genindlæser, når de er forskellige og det ikke afbryder noget.
export const BUILD_ID: string = __BUILD_ID__

export async function deployedBuild(): Promise<string | null> {
  try {
    // ?t= så hverken browserens cache eller en ældre service worker kan svare i stedet
    const r = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) return null
    const j = (await r.json()) as { build?: unknown }
    return typeof j.build === 'string' ? j.build : null
  } catch {
    return null
  }
}
