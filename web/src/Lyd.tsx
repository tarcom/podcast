// Lyd (2026-11-17): Sonos i huset og radioen på Denon'en i stuen — det samme som Allans genveje
// på BOOK6 (sonos-tray: ▶/⏸, −, + og radioikonet), som fane i app'en. Sonos går gennem
// sonos_helper på HTPC (grupper, favoritter og playlister), radioen er HEOS på Denon'en; begge
// gennem tv-helper, så det også virker i Android-app'en. Virker kun hjemme.
//
// Siden henter tilstanden hvert 3. sekund, mens fanen er åben (hvert sekund, mens den venter på,
// at et tryk slår igennem — Denon'en er op til 20 s om at tænde og starte en strøm).
import { useCallback, useEffect, useRef, useState } from 'react'
import { IkonForrige, IkonHoejttaler, IkonNaeste, IkonPause, IkonPlay, IkonRadio, IkonStop } from './ikoner'
import {
  lydStatus,
  radioKommando,
  sonosCover,
  sonosKommando,
  TvUnreachable,
  type LydStatus,
  type SonosGruppe,
} from './lib/tv'

// sonos_helper kender rummene ved ASCII-navne
const RUM: Record<string, string> = { Kokken: 'Køkken', Sove: 'Soveværelse' }
const rumNavn = (r: string) => RUM[r] || r

// DR's strømme hedder bare A05H.mp3 hos Sonos, når der ikke er en titel
const DR: Record<string, string> = {
  A03H: 'DR P1', A04H: 'DR P2', A05H: 'DR P3', A10H: 'DR P4 Nordjylland', A25H: 'DR P5', A22H: 'DR P8 Jazz',
}
function pyntTitel(t?: string): string {
  const s = (t || '').trim()
  const m = /\b(A\d\dH)\.mp3/.exec(s)
  if (m) return DR[m[1]] || 'DR radio'
  if (!s || /^x-|^https?:/.test(s)) return 'Intet valgt'
  return s
}
const spiller = (g: SonosGruppe) => g.state === 'PLAYING' || g.state === 'TRANSITIONING'
function tilstandTekst(state: string): string {
  if (state === 'PLAYING') return 'spiller'
  if (state === 'PAUSED_PLAYBACK') return 'pause'
  if (state === 'TRANSITIONING') return 'starter …'
  return 'stoppet'
}

// Et tryk, der venter på at slå igennem: knappen viser et hjul, og der spørges hvert sekund.
type Venter = { noegle: string; opfyldt: (s: LydStatus) => boolean; siden: number }

export default function Lyd({ aktiv }: { aktiv: boolean }) {
  const [st, setSt] = useState<LydStatus | null>(null)
  const [naas, setNaas] = useState<'ukendt' | 'ok' | 'ude'>('ukendt')
  const [venter, setVenter] = useState<Venter | null>(null)
  const venterRef = useRef<Venter | null>(null)
  const [besked, setBesked] = useState('')
  // Lydstyrken vises med det samme ved et tryk. Når kaldene er sendt, og der er hentet en ny
  // tilstand, er det serverens tal igen (`ryd`).
  const [lyd, setLyd] = useState<Record<string, number>>({})
  const lydRef = useRef<Record<string, number>>({})
  const undervejs = useRef<Record<string, number>>({})
  const ryd = useRef(new Set<string>())
  const [cover, setCover] = useState<Record<string, string | null>>({})
  const coverHentet = useRef(new Set<string>())
  const timer = useRef(0)

  const hent = useCallback(async () => {
    let s: LydStatus
    try {
      s = await lydStatus()
    } catch (e) {
      if (e instanceof TvUnreachable) setNaas('ude')
      return
    }
    setSt(s)
    setNaas('ok')
    if (ryd.current.size) {
      const vaek = new Set(ryd.current)
      ryd.current.clear()
      setLyd((l) => {
        const ny = Object.fromEntries(Object.entries(l).filter(([k]) => !vaek.has(k)))
        lydRef.current = ny
        return ny
      })
    }
    const v = venterRef.current
    if (v && (v.opfyldt(s) || Date.now() - v.siden > 25_000)) {
      venterRef.current = null
      setVenter(null)
    }
    // coveret til hver gruppe, når titlen skifter
    for (const g of s.sonos.groups || []) {
      const noegle = `${g.coord}|${g.title_utf8 || g.title}`
      if (coverHentet.current.has(noegle)) continue
      coverHentet.current.add(noegle)
      sonosCover(g.coord)
        .then((r) => setCover((c) => ({ ...c, [noegle]: r.data })))
        .catch(() => {})
    }
  }, [])

  // Én kæde af opslag: koer() henter og planlægger det næste; et tryk (igen) rykker det frem.
  // Er et opslag allerede undervejs, planlægger det selv det næste.
  const aktivRef = useRef(aktiv)
  const skjult = useRef(false) // app'en/fanen ligger i baggrunden: ingen opslag
  const igang = useRef(false)
  const koerRef = useRef<() => void>(() => {})
  const koer = useCallback(async () => {
    window.clearTimeout(timer.current)
    if (igang.current) return
    igang.current = true
    try {
      await hent()
    } finally {
      igang.current = false
    }
    if (aktivRef.current && !skjult.current) timer.current = window.setTimeout(() => koerRef.current(), venterRef.current ? 1000 : 3000)
  }, [hent])
  useEffect(() => {
    koerRef.current = koer
  }, [koer])
  useEffect(() => {
    aktivRef.current = aktiv
    if (aktiv) timer.current = window.setTimeout(() => koerRef.current(), 0)
    return () => window.clearTimeout(timer.current)
  }, [aktiv])

  const igen = useCallback((ms = 300) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => koerRef.current(), ms)
  }, [])

  // I baggrunden spørges der ikke. Android-app'ens WebView melder ikke altid visibilitychange,
  // så dens egne signaler (dkpod:baggrund/forgrund fra MainActivity) tæller også.
  useEffect(() => {
    const vis = () => {
      skjult.current = document.visibilityState !== 'visible'
      if (!skjult.current) igen(0)
    }
    const bag = () => {
      skjult.current = true
    }
    const frem = () => {
      skjult.current = false
      igen(0)
    }
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('dkpod:baggrund', bag)
    window.addEventListener('dkpod:forgrund', frem)
    return () => {
      document.removeEventListener('visibilitychange', vis)
      window.removeEventListener('dkpod:baggrund', bag)
      window.removeEventListener('dkpod:forgrund', frem)
    }
  }, [igen])

  const vent = useCallback((v: Omit<Venter, 'siden'> | null) => {
    const ny = v ? { ...v, siden: Date.now() } : null
    venterRef.current = ny
    setVenter(ny)
  }, [])

  const fejl = useCallback((e: unknown) => {
    setBesked(e instanceof TvUnreachable ? "Lyd kan kun styres hjemme på wifi'en" : `Det gik ikke: ${e instanceof Error ? e.message : ''}`)
    window.setTimeout(() => setBesked(''), 5000)
  }, [])

  // Lydstyrke: vis det nye tal med det samme, send kaldet, og lad serveren tage over bagefter
  const skru = useCallback(
    async (noegle: string, fra: number, delta: number, maks: number, send: () => Promise<unknown>) => {
      const nu = lydRef.current[noegle] ?? fra
      const ny = Math.max(0, Math.min(maks, nu + delta))
      lydRef.current = { ...lydRef.current, [noegle]: ny }
      setLyd(lydRef.current)
      undervejs.current[noegle] = (undervejs.current[noegle] || 0) + 1
      try {
        await send()
      } catch (e) {
        fejl(e)
      }
      undervejs.current[noegle] -= 1
      if (!undervejs.current[noegle]) {
        ryd.current.add(noegle)
        igen(400)
      }
    },
    [fejl, igen],
  )

  // ---------- Sonos ----------
  const sonos = useCallback(
    async (kommando: string, felter: Record<string, string | number>, v?: Omit<Venter, 'siden'>) => {
      if (v) vent(v)
      try {
        await sonosKommando(kommando, felter)
      } catch (e) {
        vent(null)
        fejl(e)
      }
      igen()
    },
    [vent, fejl, igen],
  )
  const sonosPlay = useCallback(
    (g: SonosGruppe) => {
      const spil = !spiller(g)
      sonos('transport', { rooms: g.coord, do: spil ? 'play' : 'pause' }, {
        noegle: 'sonos:' + g.coord,
        opfyldt: (s) => {
          const ny = s.sonos.groups?.find((x) => x.coord === g.coord)
          return !ny || spiller(ny) === spil
        },
      })
    },
    [sonos],
  )
  // even: alle rum i gruppen på samme lydstyrke ± skridtet, som genvejstasterne på BOOK6
  const sonosSkru = useCallback(
    (g: SonosGruppe, delta: number) =>
      skru('sonos:' + g.coord, Number(g.volume) || 0, delta, 100, () => sonosKommando('vol', { rooms: g.members.join(','), even: delta })),
    [skru],
  )

  // ---------- radioen ----------
  const radio = useCallback(
    async (handling: 'spil' | 'stop', kanal?: string) => {
      vent({
        noegle: 'radio',
        opfyldt: (s) => !s.radio.travl && (!!s.radio.fejl || !!s.radio.spiller === (handling === 'spil')),
      })
      try {
        await radioKommando(handling, kanal)
      } catch (e) {
        vent(null)
        fejl(e)
      }
      igen(800)
    },
    [vent, fejl, igen],
  )
  const radioSkru = useCallback(
    (fra: number, delta: number) => skru('radio', fra, delta, 69, () => radioKommando(delta > 0 ? 'lyd_op' : 'lyd_ned')),
    [skru],
  )

  if (!aktiv) return null

  const s = st?.sonos
  const r = st?.radio
  const grupper = (s?.groups || []).filter((g) => g.members.some((m) => s?.online?.[m] !== false))
  grupper.sort((a, b) => Number(spiller(b)) - Number(spiller(a)) || Number(b.coord === s?.active.coord) - Number(a.coord === s?.active.coord))
  const aktivGruppe = grupper.find((g) => g.coord === s?.active.coord) || grupper[0]
  const aktiveRum = aktivGruppe ? [aktivGruppe.coord, ...aktivGruppe.members.filter((x) => x !== aktivGruppe.coord)] : []
  const radioLyd = lyd.radio ?? r?.lydstyrke ?? null

  return (
    <section className="panel lyd">
      <div className="panel-head">
        <div>
          <h2>Lyd</h2>
          <p className="panel-sub">Sonos i huset og radioen i stuen</p>
        </div>
      </div>

      {naas === 'ude' && <p className="banner warn">📶 Lyd kan kun styres hjemme på wifi'en.</p>}
      {!st && naas !== 'ude' && <p className="muted">Henter fra HTPC …</p>}
      {besked && <p className="lyd-besked">{besked}</p>}

      {s && (
        <>
          <h3 className="lyd-hoved">
            <IkonHoejttaler size={18} /> Sonos
          </h3>
          {s.fejl ? (
            <p className="muted">Sonos svarer ikke lige nu.</p>
          ) : (
            <>
              {grupper.map((g) => {
                const noegle = 'sonos:' + g.coord
                const c = cover[`${g.coord}|${g.title_utf8 || g.title}`]
                const v = lyd[noegle] ?? (g.volume === '' ? null : Number(g.volume))
                const travl = venter?.noegle === noegle
                return (
                  <div key={g.coord} className={`lyd-kort ${spiller(g) ? 'spiller' : ''}`}>
                    <div className="lyd-top">
                      {c ? <img src={c} alt="" /> : <span className="lyd-noimg"><IkonHoejttaler size={26} /></span>}
                      <div className="lyd-tekst">
                        <b>{pyntTitel(g.title_utf8 || g.title)}</b>
                        <span>
                          {g.members.map(rumNavn).join(' · ')} · {tilstandTekst(g.state)}
                        </span>
                      </div>
                    </div>
                    <div className="lyd-knapper">
                      <button className="lyd-lille" onClick={() => sonos('transport', { rooms: g.coord, do: 'previous' })} aria-label="Forrige">
                        <IkonForrige size={20} />
                      </button>
                      <button className="lyd-skru" onClick={() => sonosSkru(g, -2)} aria-label="Skru ned">−</button>
                      <button className="lyd-play" onClick={() => sonosPlay(g)} disabled={travl} aria-label={spiller(g) ? 'Pause' : 'Spil'}>
                        {travl ? <span className="spinner" aria-hidden="true" /> : spiller(g) ? <IkonPause size={28} /> : <IkonPlay size={28} />}
                      </button>
                      <button className="lyd-skru" onClick={() => sonosSkru(g, 2)} aria-label="Skru op">+</button>
                      <button className="lyd-lille" onClick={() => sonos('transport', { rooms: g.coord, do: 'next' })} aria-label="Næste">
                        <IkonNaeste size={20} />
                      </button>
                    </div>
                    <div className="lyd-niveau">Lydstyrke <b>{v ?? '–'}</b></div>
                  </div>
                )
              })}

              {aktivGruppe && (
                <>
                  <p className="lyd-label">Rum{grupper.length > 1 ? ` i gruppen med ${rumNavn(aktivGruppe.coord)}` : ''}</p>
                  <div className="lyd-chips">
                    {Object.keys(s.online || {}).map((rum) => {
                      const med = aktiveRum.includes(rum)
                      const online = s.online[rum]
                      return (
                        <button
                          key={rum}
                          className={`qchip ${med ? 'on' : ''}`}
                          disabled={!online || (med && aktiveRum.length === 1)}
                          title={!online ? 'Slukket eller ikke på nettet' : med ? 'Tag rummet ud af gruppen' : 'Spil også her'}
                          onClick={() =>
                            med ? sonos('ungroup', { rooms: rum }) : sonos('group', { rooms: [...aktiveRum, rum].join(',') })
                          }
                        >
                          {med ? '✓ ' : ''}
                          {rumNavn(rum)}
                          {!online ? ' (slukket)' : ''}
                        </button>
                      )
                    })}
                  </div>
                  <p className="lyd-label">Favoritter og playlister</p>
                  <div className="lyd-chips">
                    {(s.favorites || []).map((f) => (
                      <button
                        key={f}
                        className={`qchip ${spiller(aktivGruppe) && pyntTitel(aktivGruppe.title_utf8 || aktivGruppe.title) === f ? 'on' : ''}`}
                        onClick={() =>
                          sonos('play', { rooms: aktiveRum.join(','), name: f }, {
                            noegle: 'sonos:' + aktivGruppe.coord,
                            opfyldt: (ny) => !!ny.sonos.groups?.some((x) => x.coord === aktivGruppe.coord && spiller(x)),
                          })
                        }
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {r && (
        <>
          <h3 className="lyd-hoved">
            <IkonRadio size={18} /> Radio i stuen
          </h3>
          <div className={`lyd-kort radio ${r.spiller ? 'spiller' : ''}`}>
            <div className="lyd-top">
              <span className="lyd-noimg radio"><IkonRadio size={26} /></span>
              <div className="lyd-tekst">
                <b>{r.spiller ? r.station || r.kanal : r.spiller === undefined ? "Kan ikke nå Denon'en" : 'Radioen er slukket'}</b>
                <span>
                  Denon'en i stuen ·{' '}
                  {venter?.noegle === 'radio' ? 'et øjeblik …' : r.tv ? "tv'et bruger forstærkeren" : r.spiller ? 'spiller' : `▶ spiller ${r.kanal}`}
                </span>
              </div>
            </div>
            <div className="lyd-knapper">
              <button className="lyd-skru" onClick={() => radioSkru(r.lydstyrke ?? 0, -1)} aria-label="Skru ned">−</button>
              <button
                className="lyd-play"
                onClick={() => (r.spiller ? radio('stop') : radio('spil', r.kanal))}
                disabled={venter?.noegle === 'radio'}
                aria-label={r.spiller ? 'Stop radioen' : 'Spil radio'}
              >
                {venter?.noegle === 'radio' ? <span className="spinner" aria-hidden="true" /> : r.spiller ? <IkonStop size={24} /> : <IkonPlay size={28} />}
              </button>
              <button className="lyd-skru" onClick={() => radioSkru(r.lydstyrke ?? 0, 1)} aria-label="Skru op">+</button>
            </div>
            <div className="lyd-niveau">
              Lydstyrke <b>{radioLyd == null ? '–' : radioLyd.toLocaleString('da-DK')}</b>
            </div>
            <div className="lyd-chips">
              {(r.kanaler || []).map((k) => (
                <button
                  key={k}
                  className={`qchip ${(r.spiller ? r.station : r.kanal) === k ? 'on' : ''}`}
                  onClick={() => radio('spil', k)}
                  disabled={venter?.noegle === 'radio'}
                >
                  {k}
                </button>
              ))}
            </div>
            {r.fejl && <p className="lyd-fejl">{r.spiller === undefined ? r.fejl : `Sidst gik det galt: ${r.fejl}`}</p>}
          </div>
        </>
      )}
    </section>
  )
}
