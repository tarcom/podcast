// Små SVG-ikoner, tegnet med currentColor, så de følger teksten i både lyst og mørkt tema.
// Ingen ikon-pakke: det er en håndfuld, og de skal ligge i bundtet, så app'en virker offline.
import type { ReactNode } from 'react'

type P = { size?: number; className?: string }

const svg = (size: number, className: string | undefined, children: ReactNode, fill = false) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? 'currentColor' : 'none'}
    stroke={fill ? 'none' : 'currentColor'}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const IkonKoe = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M4 6h11M4 12h11M4 18h7" />
    <path d="M18 14v6l4-3z" fill="currentColor" stroke="none" />
  </>)

export const IkonStjerne = ({ size = 22, className }: P) =>
  svg(size, className, <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />)

export const IkonHentet = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M12 4v11" />
    <path d="M7 10.5l5 5 5-5" />
    <path d="M5 20h14" />
  </>)

export const IkonUdforsk = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </>)

export const IkonTv = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <rect x="3" y="5" width="18" height="12" rx="2.5" />
    <path d="M8 21h8M12 17v4" />
  </>)

export const IkonPlay = ({ size = 22, className }: P) =>
  svg(size, className, <path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" />, true)

export const IkonPause = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <rect x="6" y="4.5" width="4.2" height="15" rx="1.2" />
    <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" />
  </>, true)

export const IkonTilbage = ({ size = 22, className, sek = 10 }: P & { sek?: number }) =>
  svg(size, className, <>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v4.6h4.6" />
    <text x="12.4" y="15.6" fill="currentColor" stroke="none" fontSize="7.5" fontWeight="800" textAnchor="middle" fontFamily="system-ui, sans-serif">{sek}</text>
  </>)

export const IkonFrem = ({ size = 22, className, sek = 30 }: P & { sek?: number }) =>
  svg(size, className, <>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M21 4v4.6h-4.6" />
    <text x="11.6" y="15.6" fill="currentColor" stroke="none" fontSize="7.5" fontWeight="800" textAnchor="middle" fontFamily="system-ui, sans-serif">{sek}</text>
  </>)

export const IkonLuk = ({ size = 22, className }: P) => svg(size, className, <path d="M6 6l12 12M18 6L6 18" />)

export const IkonNed = ({ size = 22, className }: P) => svg(size, className, <path d="M6 9l6 6 6-6" />)

export const IkonMaane = ({ size = 22, className }: P) =>
  svg(size, className, <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />)

export const IkonStroem = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M12 3v8" />
    <path d="M6.6 6.6a8 8 0 1 0 10.8 0" />
  </>)

export const IkonMappe = ({ size = 22, className }: P) =>
  svg(size, className, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />)

export const IkonTerning = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <circle cx="9" cy="9" r="1.3" fill="currentColor" />
    <circle cx="15" cy="15" r="1.3" fill="currentColor" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
  </>)

export const IkonStop = ({ size = 22, className }: P) => svg(size, className, <rect x="6" y="6" width="12" height="12" rx="2" />, true)

export const IkonSpolLangt = ({ size = 22, className }: P) =>
  svg(size, className, <path d="M11 6v12l-8.5-6L11 6zm9.5 0v12L12 12l8.5-6z" />, true)

export const IkonHoejttaler = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M16 9a4 4 0 0 1 0 6" />
  </>)

export const IkonPil = ({ size = 18, className }: P) => svg(size, className, <path d="M9 6l6 6-6 6" />)

export const IkonVenstre = ({ size = 18, className }: P) => svg(size, className, <path d="M15 18l-6-6 6-6" />)

export const IkonOpdater = ({ size = 18, className }: P) =>
  svg(size, className, <>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
    <path d="M20 20v-4h-4" />
  </>)

// "Afspil på …": skærm med bølger i hjørnet, som Cast-symbolet alle kender
export const IkonCast = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
    <path d="M3 12a8 8 0 0 1 8 8M3 16a4 4 0 0 1 4 4" />
    <path d="M3 20h.01" />
  </>)

export const IkonTelefon = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </>)

export const IkonRadio = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <rect x="3" y="8" width="18" height="12" rx="2.5" />
    <path d="M7 8l10-4.5" />
    <circle cx="15.5" cy="14" r="2.5" />
    <path d="M6.5 12.5h4M6.5 15.5h4" />
  </>)

export const IkonForrige = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M6 5v14" />
    <path d="M19 5.5v13L9 12z" fill="currentColor" stroke="none" />
  </>)

export const IkonNaeste = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M18 5v14" />
    <path d="M5 5.5v13L15 12z" fill="currentColor" stroke="none" />
  </>)

// Spaen: et kar med damp
export const IkonSpa = ({ size = 22, className }: P) =>
  svg(size, className, <>
    <path d="M3 13h18v3a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z" />
    <path d="M8 9.5c-1-1 1-2 0-3.5M12 9.5c-1-1 1-2 0-3.5M16 9.5c-1-1 1-2 0-3.5" />
  </>)
