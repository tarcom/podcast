// Stuen: fjernbetjeningen til tv'et i stuen, som fane i app'en (før kun aogj.com/tv). Samme
// tjeneste (tv-helper på HTPC), samme liste — alt på 5TB-disken, nyeste øverst — og samme
// adfærd: et tryk tænder tv'et, Denon'en og Kodi og afspiller filen, hvor man slap.
//
// Status hentes af App.tsx (den bruges også til at følge en podcast, der er sendt til tv'et);
// listen hentes her, når fanen er åben, og igen hvert minut.
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  IkonFrem,
  IkonMappe,
  IkonPause,
  IkonPil,
  IkonPlay,
  IkonSpolLangt,
  IkonStop,
  IkonStroem,
  IkonTerning,
  IkonTilbage,
  IkonVenstre,
} from './ikoner'
import { pushBack } from './lib/back'
import { inAndroidApp } from './lib/native'
import { jobIGang, tvAfspil, tvDato, tvKontrol, tvListe, tvStr, tvTaend, type TvPost, type TvStatus } from './lib/tv'
import { fmtClock } from './lib/format'

type Props = {
  aktiv: boolean
  status: TvStatus | null
  naas: 'ukendt' | 'ok' | 'ude'
  mappe: string
  setMappe: (m: string) => void
  pollSnart: (ms?: number) => void
}

export default function Stuen({ aktiv, status, naas, mappe, setMappe, pollSnart }: Props) {
  const [poster, setPoster] = useState<TvPost[]>([])
  const [listeMappe, setListeMappe] = useState<string | null>(null) // hvilken mappe `poster` er
  const [listeFejl, setListeFejl] = useState(false)
  const [soeg, setSoeg] = useState('')
  const [besked, setBesked] = useState('')
  const [sender, setSender] = useState(false)
  const [bekraeftSluk, setBekraeftSluk] = useState(false)

  const hent = useCallback(async (m: string) => {
    try {
      const d = await tvListe(m)
      setPoster(d.poster)
      setListeMappe(m)
      setListeFejl(false)
    } catch {
      setListeFejl(true)
    }
  }, [])

  // Listen: når fanen åbnes, når mappen skifter, og igen hvert minut mens fanen er åben.
  useEffect(() => {
    if (!aktiv) return
    const nu = window.setTimeout(() => hent(mappe), 0)
    const iv = window.setInterval(() => hent(mappe), 60_000)
    return () => {
      window.clearTimeout(nu)
      window.clearInterval(iv)
    }
  }, [aktiv, mappe, hent])

  const gaaOp = useCallback(() => {
    // Øverste niveau under Torrents/Series er den samlede liste
    const dele = mappe.split('/')
    setMappe(dele.length > 2 ? dele.slice(0, -1).join('/') : '')
    setSoeg('')
  }, [mappe, setMappe])

  // Androids tilbage-knap går én mappe op, før den lukker app'en
  useEffect(() => {
    if (!aktiv || !mappe) return
    return pushBack(() => {
      gaaOp()
      return true
    })
  }, [aktiv, mappe, gaaOp])

  const tv = status?.tv
  const sp = status?.kodi?.spiller || null
  const dn = status?.denon || null
  const igang = jobIGang(status)
  const jobFejl = status?.job.trin === 'Fejl' && !igang ? status.job.fejl : null

  const vaelg = async (p: TvPost) => {
    if (p.mappe && !p.afspil) {
      setMappe(p.sti)
      setSoeg('')
      window.scrollTo(0, 0)
      return
    }
    setBesked('')
    setSender(true)
    try {
      await tvAfspil(p.afspil || p.sti)
    } catch (e) {
      setBesked(`Kunne ikke starte: ${e instanceof Error ? e.message : 'ukendt fejl'}`)
    } finally {
      setSender(false)
      pollSnart(150)
    }
  }

  const kontrol = async (handling: string, ekstra: Record<string, unknown> = {}) => {
    try {
      await tvKontrol(handling, ekstra)
    } catch {
      /* intet at styre — status viser det */
    }
    pollSnart(300)
  }

  const stroem = async () => {
    if (!tv?.taendt) {
      setSender(true)
      try {
        await tvTaend()
      } catch {
        setBesked('HTPC svarer ikke.')
      } finally {
        setSender(false)
        pollSnart(150)
      }
      return
    }
    if (!bekraeftSluk) {
      setBekraeftSluk(true)
      window.setTimeout(() => setBekraeftSluk(false), 3000)
      return
    }
    setBekraeftSluk(false)
    await kontrol('sluk')
  }

  const spolTil = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const pct = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))
    kontrol('spol_til', { procent: pct })
  }

  const vist = useMemo(() => {
    const q = soeg.trim().toLowerCase()
    const liste = listeMappe === mappe ? poster : []
    return q ? liste.filter((p) => `${p.titel} ${p.navn}`.toLowerCase().includes(q)) : liste
  }, [poster, listeMappe, mappe, soeg])

  let tilstand: ReactNode
  if (naas === 'ude') tilstand = 'Ingen forbindelse til stuen'
  else if (!status) tilstand = 'Henter …'
  else if (!tv?.taendt) tilstand = "Tv'et er slukket"
  else if (sp) tilstand = <>{sp.pause ? 'Pause: ' : 'Spiller: '}<b>{sp.titel}</b></>
  else if (status.kodi) tilstand = 'Kodi er klar'
  else tilstand = "Tv'et er tændt"

  const spillerSti = sp?.sti || ''
  const lyd = sp?.type === 'audio'
  const pct = sp && sp.laengde ? Math.min(100, (sp.tid / sp.laengde) * 100) : 0

  return (
    <section className="panel stuen">
      <div className="stuen-top">
        <div className="stuen-hoved">
          <h2>Stuen</h2>
          <p className="stuen-tilstand">{tilstand}</p>
        </div>
        <button
          className={`stroem ${tv?.taendt ? 'paa' : ''} ${bekraeftSluk ? 'bekraeft' : ''}`}
          onClick={stroem}
          disabled={naas === 'ude' || sender}
          aria-label={tv?.taendt ? "Sluk tv'et" : "Tænd tv'et"}
          title={tv?.taendt ? "Sluk tv'et (to tryk)" : "Tænd tv'et, forstærkeren og Kodi"}
        >
          {bekraeftSluk ? 'Sluk?' : <IkonStroem size={22} />}
        </button>
      </div>

      {(naas === 'ude' || (listeFejl && !poster.length)) && (
        <p className="besked fejl">
          Stuen kan kun nås hjemme på wifi'en.
          {!inAndroidApp && (
            <>
              {' '}
              I Chrome skal siden have lov til <b>enheder på dit lokale netværk</b> (tryk på ikonet til venstre for
              adressen).
            </>
          )}
        </p>
      )}
      {(igang || sender) && (
        <p className="besked job">
          <span className="spinner" aria-hidden="true" /> {igang ? `${status?.job.trin} …` : "Sender til tv'et …"}
        </p>
      )}
      {(besked || jobFejl) && <p className="besked fejl">{besked || jobFejl}</p>}

      {sp && (
        <div className="tvkort">
          <div className="tvkort-titel">
            {lyd && <em className="tvkort-tag">Podcast</em>}
            {sp.titel}
          </div>
          <div className="tvkort-forloeb">
            <span>{fmtClock(sp.tid)}</span>
            <div className="tvbar" onClick={spolTil} role="slider" aria-label="Spol" aria-valuenow={Math.round(pct)}>
              <i>
                <b style={{ width: `${pct}%` }} />
              </i>
            </div>
            <span>{fmtClock(sp.laengde)}</span>
          </div>
          <div className="tvknapper">
            <button onClick={() => kontrol('spol', { sek: -600 })} aria-label="10 minutter tilbage">
              <IkonSpolLangt />
            </button>
            <button onClick={() => kontrol('spol', { sek: -30 })} aria-label="30 sekunder tilbage">
              <IkonTilbage sek={30} />
            </button>
            <button className="stor" onClick={() => kontrol('pause')} aria-label="Pause eller afspil">
              {sp.pause ? <IkonPlay /> : <IkonPause />}
            </button>
            <button onClick={() => kontrol('spol', { sek: 30 })} aria-label="30 sekunder frem">
              <IkonFrem sek={30} />
            </button>
            <button onClick={() => kontrol('stop')} aria-label="Stop">
              <IkonStop />
            </button>
          </div>
          <div className="tvlyd">
            {!lyd && (
              <>
                <button className="lille" onClick={() => kontrol('undertekst')} disabled={!sp.antal_undertekster}>
                  Tekst <b>{sp.antal_undertekster ? sp.undertekst || 'fra' : 'ingen'}</b>
                </button>
                <button className="lille" onClick={() => kontrol('lydspor')} disabled={sp.antal_lydspor < 2}>
                  Lyd <b>{sp.lydspor || '–'}</b>
                </button>
              </>
            )}
            <button onClick={() => kontrol('lyd_ned')} aria-label="Skru ned">
              −
            </button>
            <button className={`vol ${dn?.mute ? 'mute' : ''}`} onClick={() => kontrol('mute')} aria-label="Lyd til eller fra">
              <b>{dn ? (dn.taendt ? (dn.mute ? 'fra' : Math.round(dn.lydstyrke || 0)) : 'slukket') : '–'}</b>
              lyd
            </button>
            <button onClick={() => kontrol('lyd_op')} aria-label="Skru op">
              +
            </button>
          </div>
        </div>
      )}

      <div className="stuen-bib">
        <input
          className="stuen-soeg"
          type="search"
          placeholder={mappe ? 'Søg i mappen' : 'Søg i alt på disken'}
          value={soeg}
          onChange={(e) => setSoeg(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
        {mappe && (
          <div className="stuen-sti">
            <button className="stuen-op" onClick={gaaOp}>
              <IkonVenstre /> Tilbage
            </button>
            <span>{mappe.split('/').slice(-1)[0].replace(/[._]/g, ' ')}</span>
          </div>
        )}
        <ul className="stuen-liste">
          {vist.length === 0 && (
            <li className="tom">
              {listeMappe === mappe && poster.length ? 'Intet matcher søgningen.' : naas === 'ude' || listeFejl ? '' : 'Henter …'}
            </li>
          )}
          {vist.map((p) => {
            const mappeLink = p.mappe && !p.afspil
            const strm = p.navn.toLowerCase().endsWith('.strm')
            const spilles =
              !!spillerSti && (spillerSti === (p.afspil || p.sti) || (mappeLink && spillerSti.startsWith(p.sti + '/')))
            const meta: ReactNode[] = strm ? [] : [tvDato(p.tid)]
            if (mappeLink) meta.push(`${p.antal} filer`)
            else if (p.str && !strm) meta.push(tvStr(p.str))
            if (p.opl) meta.push(p.opl)
            if (p.kilde === 'Series') meta.push('Serier')
            if (p.set) meta.push(<span className="set" key="set">set {tvDato(p.set)}</span>)
            return (
              <li key={p.sti} className={spilles ? 'spiller' : ''}>
                <button onClick={() => vaelg(p)} disabled={naas === 'ude'}>
                  <span className="ikon">
                    {spilles ? <IkonPlay size={18} /> : strm ? <IkonTerning size={18} /> : mappeLink ? <IkonMappe size={18} /> : <IkonPlay size={18} />}
                  </span>
                  <span className="tekst">
                    <span className="titel" title={p.navn}>
                      {strm ? (mappe ? 'Tilfældigt afsnit' : 'Tilfældigt afsnit, alle serier') : p.titel}
                    </span>
                    <span className="meta">
                      {meta.map((m, i) => (
                        <span key={i}>
                          {i > 0 && ' · '}
                          {m}
                        </span>
                      ))}
                    </span>
                  </span>
                  {mappeLink && <IkonPil className="pil" />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
