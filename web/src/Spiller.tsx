// Afspilleren: den lille bjælke nederst (altid synlig, når der står et afsnit) og den store
// visning, der åbnes ved et tryk på bjælken — med stort cover, spoling, hastighed, sove-timer,
// "afspil på …" og "luk". Kun visning: al tilstand og al lyd ligger i App.tsx.
import { IkonCast, IkonFrem, IkonLuk, IkonMaane, IkonNed, IkonPause, IkonPlay, IkonTilbage } from './ikoner'
import { fmtClock, fmtRate } from './lib/format'
import type { EpisodeRow } from './types'

type Faelles = {
  ep: EpisodeRow
  playing: boolean
  curTime: number
  dur: number
  onToggle: () => void
  onSkip: (delta: number) => void
}

export function MiniSpiller({
  ep,
  playing,
  curTime,
  dur,
  onToggle,
  onSkip,
  onOpen,
  sleepLeft,
  rate,
}: Faelles & { onOpen: () => void; sleepLeft: number; rate: number }) {
  const total = dur || ep.durationSec || 0
  const pct = total > 0 ? Math.min(100, (curTime / total) * 100) : 0
  const art = ep.image || ep.podcastImage
  return (
    <div className="mini" role="region" aria-label="Afspiller">
      <div className="mini-fremdrift" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <button className="mini-aabn" onClick={onOpen} title="Åbn afspilleren">
        {art ? <img src={art} alt="" /> : <span className="mini-noimg" />}
        <span className="mini-tekst">
          <strong>{ep.title}</strong>
          <span>
            {ep.podcastTitle}
            {rate !== 1 && <em className="mini-tag">{fmtRate(rate)}</em>}
            {sleepLeft > 0 && (
              <em className="mini-tag">
                <IkonMaane size={11} /> {sleepLeft} min
              </em>
            )}
          </span>
        </span>
      </button>
      <button className="mini-knap bred" onClick={() => onSkip(-10)} aria-label="Spol 10 sekunder tilbage">
        <IkonTilbage size={24} />
      </button>
      <button className="mini-play" onClick={onToggle} aria-label={playing ? 'Pause' : 'Afspil'}>
        {playing ? <IkonPause size={22} /> : <IkonPlay size={22} />}
      </button>
      <button className="mini-knap" onClick={() => onSkip(30)} aria-label="Spol 30 sekunder frem">
        <IkonFrem size={24} />
      </button>
    </div>
  )
}

export function FuldSpiller({
  ep,
  playing,
  curTime,
  dur,
  onToggle,
  onSkip,
  onSeekInput,
  onSeekCommit,
  onCollapse,
  onClosePlayer,
  rate,
  onRate,
  sleepLeft,
  onSleep,
  onCast,
  onInfo,
  meta,
}: Faelles & {
  onSeekInput: (v: number) => void
  onSeekCommit: (v: number) => void
  onCollapse: () => void
  onClosePlayer: () => void
  rate: number
  onRate: () => void
  sleepLeft: number
  onSleep: () => void
  onCast?: () => void // "Afspil på …": tv'et eller en højttaler (kun hjemme)
  onInfo: () => void
  meta: string
}) {
  const total = dur || ep.durationSec || 0
  const art = ep.image || ep.podcastImage
  const left = Math.max(0, total - curTime)
  return (
    <div className="ark-bag" onClick={onCollapse}>
      <div className="ark" role="dialog" aria-label="Afspiller" onClick={(e) => e.stopPropagation()}>
        <div className="ark-top">
          <button className="ark-ikon" onClick={onCollapse} aria-label="Gør afspilleren lille igen">
            <IkonNed size={26} />
          </button>
          <span className="ark-kilde">Afspiller nu</span>
          <button className="ark-ikon" onClick={onClosePlayer} aria-label="Luk afspilleren" title="Luk afspilleren — fjerner den også fra notifikationen">
            <IkonLuk size={22} />
          </button>
        </div>

        <div className="ark-billede">{art ? <img src={art} alt="" /> : <div className="ark-noimg" />}</div>

        <div className="ark-titel">
          <h2>{ep.title}</h2>
          <p>{meta}</p>
        </div>

        <div className="ark-bar">
          <input
            className="pseek"
            type="range"
            min={0}
            max={total || 0}
            step={1}
            value={Math.min(curTime, total || 0)}
            onChange={(e) => onSeekInput(Number(e.target.value))}
            onMouseUp={(e) => onSeekCommit(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => onSeekCommit(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => onSeekCommit(Number((e.target as HTMLInputElement).value))}
            aria-label="Søg i afsnittet"
          />
          <div className="ark-tider">
            <span>{fmtClock(curTime)}</span>
            <span>−{fmtClock(left / (rate || 1))}</span>
          </div>
        </div>

        <div className="ark-knapper">
          <button className="ark-skip" onClick={() => onSkip(-10)} aria-label="Spol 10 sekunder tilbage">
            <IkonTilbage size={38} />
          </button>
          <button className="ark-play" onClick={onToggle} aria-label={playing ? 'Pause' : 'Afspil'}>
            {playing ? <IkonPause size={34} /> : <IkonPlay size={34} />}
          </button>
          <button className="ark-skip" onClick={() => onSkip(30)} aria-label="Spol 30 sekunder frem">
            <IkonFrem size={38} />
          </button>
        </div>

        <div className="ark-ekstra">
          <button className={`pille ${rate !== 1 ? 'on' : ''}`} onClick={onRate} title="Afspilningshastighed — huskes på denne enhed">
            {fmtRate(rate)}
          </button>
          <button className={`pille ${sleepLeft > 0 ? 'on' : ''}`} onClick={onSleep} title="Sove-timer: pauser af sig selv">
            <IkonMaane size={15} /> {sleepLeft > 0 ? `${sleepLeft} min` : 'Sov'}
          </button>
          {onCast && (
            <button className="pille" onClick={onCast} title="Spil afsnittet på tv'et eller en højttaler, fra hvor du er nu">
              <IkonCast size={15} /> Afspil på …
            </button>
          )}
          <button className="pille" onClick={onInfo}>
            Om afsnittet
          </button>
        </div>
      </div>
    </div>
  )
}
