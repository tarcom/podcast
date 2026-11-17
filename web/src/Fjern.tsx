// "Afspil på …" (2026-11-17): vælgeren, hvor et afsnit skal spilles — telefonen, tv'et i stuen
// eller en Google Home-højttaler — og styringen af det, når det spiller et andet sted end på
// telefonen. Tv'et og højttalerne styres af tv-helper på HTPC (projektet `tv`), så det virker
// kun hjemme. Kun visning: tilstanden ligger i App.tsx.
import { useEffect, useState } from 'react'
import { IkonCast, IkonFrem, IkonHoejttaler, IkonLuk, IkonNed, IkonPause, IkonPlay, IkonStop, IkonTelefon, IkonTilbage, IkonTv } from './ikoner'
import { fmtClock } from './lib/format'
import type { TvFjern, TvMaal } from './lib/tv'

export function MaalVaelger({
  titel,
  maal,
  henter,
  onTelefon,
  onVaelg,
  onLuk,
}: {
  titel: string
  maal: TvMaal[]
  henter: boolean
  onTelefon: () => void
  onVaelg: (m: TvMaal) => void
  onLuk: () => void
}) {
  return (
    <div className="maal-bag" onClick={onLuk}>
      <div className="maal" role="dialog" aria-label="Afspil på" onClick={(e) => e.stopPropagation()}>
        <div className="maal-top">
          <div>
            <h3>Afspil på …</h3>
            <p>{titel}</p>
          </div>
          <button className="ark-ikon" onClick={onLuk} aria-label="Luk">
            <IkonLuk size={20} />
          </button>
        </div>
        <ul className="maal-liste">
          <li>
            <button onClick={onTelefon}>
              <IkonTelefon size={22} />
              <span>
                <b>Telefonen</b>
                <small>her på enheden</small>
              </span>
            </button>
          </li>
          {maal.map((m) => (
            <li key={m.id}>
              <button onClick={() => onVaelg(m)}>
                {m.type === 'tv' ? <IkonTv size={22} /> : <IkonHoejttaler size={22} />}
                <span>
                  <b>{m.navn}</b>
                  <small>{m.type === 'tv' ? 'Kodi på tv’et · tænder af sig selv' : m.gruppe ? 'Google Cast-gruppe' : m.model || 'Google Cast'}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {henter && <p className="maal-note">Leder efter højttalere …</p>}
        <p className="maal-note">Tv’et og højttalerne nås kun hjemme på wifi’en.</p>
      </div>
    </div>
  )
}

/** Tiden lige nu: statussen er hentet for et øjeblik siden, og den tikker videre, mens det spiller. */
function useLiveTid(status: TvFjern | null, statusAt: number): number {
  const [nu, setNu] = useState(() => Date.now())
  const koerer = !!status?.spiller && !status.pause
  useEffect(() => {
    if (!koerer) return
    const iv = window.setInterval(() => setNu(Date.now()), 1000)
    return () => window.clearInterval(iv)
  }, [koerer])
  if (!status) return 0
  const ekstra = koerer ? Math.max(0, (nu - statusAt) / 1000) : 0
  return Math.min(status.laengde || Infinity, status.tid + ekstra)
}

export function FjernTid({ status, statusAt }: { status: TvFjern | null; statusAt: number }) {
  return <>{fmtClock(useLiveTid(status, statusAt))}</>
}

export function FjernSpiller({
  titel,
  billede,
  navn,
  tv,
  status,
  statusAt,
  trin,
  onKontrol,
  onTelefon,
  onStuen,
  onLuk,
}: {
  titel: string
  billede?: string
  navn: string
  tv: boolean // tv'et i stuen (ellers en højttaler)
  status: TvFjern | null
  statusAt: number
  trin: string | null // "Tænder tv'et" osv., mens det starter
  onKontrol: (handling: string, ekstra?: Record<string, unknown>) => void
  onTelefon: () => void
  onStuen: () => void
  onLuk: () => void
}) {
  const tid = useLiveTid(status, statusAt)
  const total = status?.laengde || 0
  const [traek, setTraek] = useState<number | null>(null) // mens man trækker i linjen
  const vist = traek ?? tid
  const spiller = !!status?.spiller
  const slip = (v: number) => {
    setTraek(null)
    if (total > 0) onKontrol('spol_til', { procent: (v / total) * 100 })
  }
  const lyd = status?.lydstyrke
  return (
    <div className="ark-bag" onClick={onLuk}>
      <div className="ark fjern" role="dialog" aria-label={`Spiller på ${navn}`} onClick={(e) => e.stopPropagation()}>
        <div className="ark-top">
          <button className="ark-ikon" onClick={onLuk} aria-label="Luk visningen">
            <IkonNed size={26} />
          </button>
          <span className="ark-kilde">
            {tv ? <IkonTv size={14} /> : <IkonCast size={14} />} {navn}
          </span>
          <span className="ark-ikon tom" />
        </div>

        <div className="ark-billede">{billede ? <img src={billede} alt="" /> : <div className="ark-noimg" />}</div>

        <div className="ark-titel">
          <h2>{titel}</h2>
          <p>{spiller ? (status?.pause ? 'På pause' : `Spiller på ${navn}`) : trin ? `${trin} …` : 'Spiller ikke lige nu'}</p>
        </div>

        <div className="ark-bar">
          <input
            className="pseek"
            type="range"
            min={0}
            max={total || 0}
            step={1}
            value={Math.min(vist, total || 0)}
            disabled={!spiller || !total}
            onChange={(e) => setTraek(Number(e.target.value))}
            onMouseUp={(e) => slip(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => slip(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => slip(Number((e.target as HTMLInputElement).value))}
            aria-label="Spol i afsnittet"
          />
          <div className="ark-tider">
            <span>{fmtClock(vist)}</span>
            <span>{total ? '−' + fmtClock(Math.max(0, total - vist)) : ''}</span>
          </div>
        </div>

        <div className="ark-knapper">
          <button className="ark-skip" onClick={() => onKontrol('spol', { sek: -10 })} disabled={!spiller} aria-label="Spol 10 sekunder tilbage">
            <IkonTilbage size={38} />
          </button>
          <button
            className="ark-play"
            onClick={() => onKontrol(status?.pause ? 'play' : 'pause')}
            disabled={!spiller}
            aria-label={status?.pause ? 'Spil' : 'Pause'}
          >
            {status?.pause || !spiller ? <IkonPlay size={34} /> : <IkonPause size={34} />}
          </button>
          <button className="ark-skip" onClick={() => onKontrol('spol', { sek: 30 })} disabled={!spiller} aria-label="Spol 30 sekunder frem">
            <IkonFrem size={38} />
          </button>
        </div>

        <div className="fjern-lyd" aria-label="Lydstyrke">
          <button className="pille" onClick={() => onKontrol('lyd_ned')} aria-label="Skru ned">−</button>
          <span>
            <IkonHoejttaler size={16} /> {lyd == null ? 'Lydstyrke' : tv ? `Forstærker ${String(lyd).replace('.', ',')}` : `${lyd} %`}
          </span>
          <button className="pille" onClick={() => onKontrol('lyd_op')} aria-label="Skru op">+</button>
        </div>

        <div className="ark-ekstra">
          <button className="pille on" onClick={onTelefon} title="Stop dér, og spil videre her på telefonen fra samme sted">
            <IkonTelefon size={15} /> Fortsæt på telefonen
          </button>
          <button className="pille" onClick={() => onKontrol('stop')} title="Stop afspilningen dér">
            <IkonStop size={13} /> Stop
          </button>
          {tv && (
            <button className="pille" onClick={onStuen} title="Fjernbetjeningen til tv'et (undertekster, sluk …)">
              <IkonTv size={15} /> Stuen
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
