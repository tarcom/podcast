import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // base-aware: app lives at /podcast/, so the SW is at /podcast/sw.js
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {
      // Service worker is optional.
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
