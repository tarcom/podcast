import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

if ('serviceWorker' in navigator) {
  // En installeret PWA lukkes sjældent helt ned, så den kan blive hængende på gammelt JS:
  // SW'en aktiverer nok (skipWaiting+claim), men siden genindlæses aldrig. Derfor:
  // 1) tjek aktivt efter en ny SW ved opstart og hver gang app'en kommer i forgrunden,
  // 2) genindlæs ÉN gang når en ny SW tager over.
  let reloading = false
  // Var der allerede en SW? Hvis ikke, er det bare førstegangs-registreringen der
  // tager over — den skal IKKE udløse et reload.
  const hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return
    reloading = true
    window.location.reload()
  })

  window.addEventListener('load', () => {
    // base-aware: app lives at /podcast/, so the SW is at /podcast/sw.js
    navigator.serviceWorker
      .register(import.meta.env.BASE_URL + 'sw.js')
      .then((reg) => {
        reg.update().catch(() => {})
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {})
        })
      })
      .catch(() => {
        // Service worker is optional.
      })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
