# CLAUDE.md — All DK Podcasts (tidl. NordPod)

**Visningsnavn er nu "All DK Podcasts"** (h1/manifest/title omdøbt 2026-07-27). Interne navne
(cache `nordpod-vN`, repo `podcast`, denne fil) er uændrede for ikke at bryde ting.

Reklame-light podcast-app, kun til Allan (ingen login endnu). **Live på https://aogj.com/podcast/**
(one.com, PHP + delt `aogj_com`-MySQL). Se `README.md` for fuld arkitektur — her kun de ting der
er lette at snuble over.

## Stak
- Frontend: **React + TS + Vite 8 + PWA**, deployet under `base=/podcast/`.
- Backend: tynde PHP-endpoints i `api/` der proxyer **Podcast Index** (åbent API) + MySQL.
- Data: 3 tabeller præfikset `podcast_` i den delte `aogj_com`-DB (favoritter / episode-cache /
  pr-device hørt-tilstand). Kun-favoritter-model; hørt = grå + driver "næste uhørte" i Kø-fanen.

## Gotchas
- **Vite 8 kræver Node 20+.** Migreringen til den nye HTPC (2026-08-04) tog **hverken node eller
  nvm med** — maskinen havde slet ingen node, så `deploy.sh web` kunne ikke bygge. Rettet
  2026-08-10: **`nodejs` 22.22 + `npm` fra Ubuntu 26.04's apt** (`sudo apt install nodejs npm`).
  Ingen nvm længere, ingen `nvm use`. Det medbragte `node_modules` (installeret under node 20)
  virkede uændret under node 22 — rolldowns binding er N-API og skulle ikke geninstalleres.
- **`api/config.php`** (Podcast Index-nøgler + MySQL-creds) er **gitignored** og ligger KUN på
  serveren. `deploy.sh api` uploader den bevidst med. Samme MySQL som resten af aogj.com:
  host `aogj.com.mysql`, bruger/db `aogj_com`.
- **Ingen cron.** Refresh sker "ved åbning" — men **ikke længere inline i kø-svaret**: frontenden
  henter cachen først og kalder `episodes.refresh` bagefter (se afsnittet om kø-load nedenfor).
  Bevidst uden cron — one.com/simply-cron er ikke en forudsætning.
- **PWA-stier er hardcodet til `/podcast/`** i `web/public/sw.js` + `manifest.webmanifest` (de
  path-rewrites IKKE af Vite). Cache-navn bumpes ved shell-ændringer (nu **`nordpod-v8`**).
  Lyd-cachen **`nordpod-audio-v1`** er en anden cache og skal blive stående — se afsnittet om
  offline-download.
- **Installerbarhed (fixet 2026-07-27):** `web/index.html` manglede `<link rel="manifest">` (Vite
  injicerer det IKKE selv — intet PWA-plugin), så Chrome tilbød kun "Opret genvej", ikke "Installér".
  Nu tilføjet (+ `theme-color` + `apple-touch-icon`) som **root-relative** stier (`/manifest.webmanifest`)
  så Vite prefixer `/podcast/`. **Cache-fælde:** SW cachede den gamle index.html cache-first → en
  ren shell-ændring slår ikke igennem uden cache-bump; derfor er HTML + manifest nu **netværk-først**
  i sw.js (øvrige hashede assets cache-first). one.com serverer `.webmanifest` uden Content-Type —
  Chrome installerer alligevel (MIME blokerer ikke, kun DevTools-warning).
- **Podimo/DR:** kun offentlige feeds (dem Podcast Index kender). Eksklusivt Podimo-indhold er
  bevidst fravalgt (kræver grå selvhostet converter). Afsnit uden lydfil → "åbn hos udbyder"-link.
- Deploy = FTP only (`.ftp-credentials`, delt med de andre aogj.com-projekter). Kør
  `?action=migrate` én gang efter første deploy for at oprette tabeller.

## Nyere tilføjelser (2026-07-26)
- **Kø grupperet pr. dag** (`groupByDay`/`dayLabel` i App.tsx): "I dag"/"I går"/ugedag (<7 dage)/
  fuld dato. Køen viser **kun uhørte**. Cover-**billede** som thumbnail (klik = afspil) i stedet for
  play-symbol (`.ep-thumb`). **"✓ ryd herunder"** pr. dag = markér den dag + alt ældre som hørt via
  nyt backend-endpoint **`state.setMany`** (bulk). Hørt-toggle beholdt (fjerner fra kø da køen kun er
  uhørte).
- **"Læs mere"-modaler:** afsnit-modal (fuld `description`/show notes + billede + dato/tid/varighed +
  Afspil/Markér) og podcast-modal udvidet med cover/forfatter/kategorier/beskrivelse. Beskrivelser
  renderes med `dangerouslySetInnerHTML` (RSS-HTML; personlig app, lav risiko). Podcast-info hentes
  via `getPodcast` (action=`podcast`); `normalizePodcast` læser nu også `description`+`categories`.
- **Media Session API** (App.tsx useEffect på `current`): metadata (titel/podcast/artwork) +
  play/pause/seek±/next på låseskærm/notifikation → ordentlig **baggrundslytning** på Android.
- **Installerbar:** manglede før — havde kun ét SVG-ikon. Nu **PNG 192/512 + maskable-512**
  (`web/public/icon-*.png`, genereret fra `icon.svg` med headless-Chrome-render) i manifest;
  SW-cache bumpet **v2→v3** + PNG'er i APP_SHELL. (Android Chrome vil have PNG for install-prompt.)
- **PWA-verifikation:** app'en er single-user via `localStorage['podcast_device_id']`. En frisk
  browser har ingen favoritter → tom kø. For at teste kø-UI: seed en throwaway-device via API
  (`favorites.add` med feeds fra `search`), sæt localStorage i Selenium, reload. Husk at fjerne
  test-favoritterne bagefter (`favorites.remove`).

## Afspiller: progress bar + spol-knapper (2026-07-28)
- **Player-footeren** (`App.tsx` `<footer className="player">`) er nu **to rækker** (CSS: `.player`
  er `flex-direction: column`): øverst en **progress bar** (`.player-bar`: `mm:ss` · trækbar
  `<input type=range class=pseek>` · total `t:mm:ss`), nederst **kontrol-rækken**
  (`.player-controls`): **↺10 (spol 10 sek. tilbage)**, ▶/❚❚, **↻30 (spol 30 sek. frem)**, titel.
  Spol-knapperne er til hurtigt at hoppe over reklamer.
- **State:** `curTime`/`dur`/`seeking` i App. `onTimeUpdate` sætter `curTime` (ikke mens man
  trækker) + `dur`; `onLoadedMetadata` sætter `dur`; `playEpisode` initialiserer fra
  `positionSec`/`durationSec`. `skip(delta)` clamper til [0, duration]. Slideren opdaterer visning
  på `onChange` og sætter `audio.currentTime` først på `onMouseUp`/`onTouchEnd` (`onSeekInput`/
  `onSeekCommit`) så scrub ikke spammer seeks. `fmtClock()` formaterer sekunder → mm:ss/t:mm:ss.
- **Media Session** (låseskærm) opdateret til samme 10/30 sek + en `seekto`-handler (træk på
  notifikationens tidslinje). **SW-cache bumpet `nordpod-v4`→`v5`** (shell-ændring). Deploy: `web`.
- **PWA hang på gammelt JS (fixet s.d. i `main.tsx`):** brugeren så ikke de nye knapper efter deploy.
  Årsag: en **installeret PWA lukkes sjældent helt ned** — SW'en aktiverede godt nok den nye version
  (`skipWaiting`+`claim`), men **siden genindlæses aldrig**, så det gamle bundle blev hængende.
  Fix: `main.tsx` kalder nu `reg.update()` ved opstart **og** hver gang app'en kommer i forgrunden
  (`visibilitychange`), og genindlæser **én gang** på `controllerchange` (gardet med `hadController`
  så den allerførste registrering ikke trigger et reload). **Fremover slår deploys altså igennem af
  sig selv** ved næste gang app'en åbnes — cache-bump alene er ikke nok.
- **Verifikationstrick:** `device_id` er fast `allan-main`, så man kan indlæse den **live** side i
  Selenium (`scraper/.venv`) og se Allans rigtige kø — klik `.ep-thumb:not(.link)` for at afspille,
  og aflæs/klik `footer.player`. Brugt til at bevise at spol-knapperne virkede (+30/−10 på
  `audio.currentTime`) mens brugerens egen enhed viste gammelt UI.

## Fremdrift pr. afsnit i køen (2026-07-28)
- Hvert afsnit man er **i gang med** viser en tynd fremdriftsbjælke + "**X min tilbage**"
  (`EpisodeItem`: `.ep-progress`/`.ep-progress-fill`/`.ep-left`). Vises kun når `pos > 30 sek` og
  `pos < 99%` af varigheden, og ikke når afsnittet er hørt — ellers ville hver række støje.
- **Bevidst IKKE en trækbar slider pr. række:** i en scrollende liste rammer man den ved et uheld
  og flytter afspilningen. Fremdrift = visning i listen; seek sker i afspilleren nederst.
- **Live-opdatering:** `liveTime`-prop sendes kun til det afsnit der er `current` (så bjælken
  bevæger sig uden at re-rendere hele listen). `onTimeUpdate` patcher desuden `queue`/`detailEpisodes`
  med `positionSec` i samme 8-sek.-throttle som backend-gemningen, så bjælken forbliver korrekt
  når afsnittet ikke længere er `current`. Data fandtes i forvejen (`st.position_sec` joines i
  `podcast_newest_episodes`), så **ingen backend-ændring** var nødvendig.
- **NB ved test:** Selenium-tests mod live-siden skriver i Allans **rigtige** lytte-position
  (`allan-main`). Afspil helst et afsnit han er færdig med, eller nulstil bagefter via `state.set`.
  **Og omvendt:** hvis en position ændrer sig "af sig selv" under fejlsøgning, er det sandsynligvis
  Allan der lytter på telefonen samtidig — tjek ved at sample `position_sec` to gange med ~45 sek.
  mellemrum; vokser den i realtid, er det ægte lytning, ikke en efterladt testbrowser.

## "Fortsætter"-sektion (2026-07-28)
- Øverst i Kø-fanen vises **▶ Fortsætter** med de afsnit man er midt i (`.daygroup.continuing`,
  lys grøn boks). De **fjernes fra dag-grupperne** så de ikke optræder to gange.
- Fælles kriterie `isInProgress(pos, total, heard)` (>30 sek. inde, <99% færdig, ikke hørt) bruges
  af **både** sektionen og fremdriftsbjælken, så de aldrig kommer ud af trit.
- Sorteret **senest lyttet først** via `st.updated_at`. Kolonnen fandtes allerede i skemaet men blev
  ikke selekteret — nu med i `podcast_newest_episodes`/`podcast_feed_episodes` → `updatedAt` på
  `EpisodeRow`.
- **Migrations-faldgrube (vigtig):** `CREATE TABLE IF NOT EXISTS` tilføjer **ikke** nye kolonner til
  en tabel der allerede findes, så en kolonne tilføjet senere i skemaet mangler måske i den live DB.
  `?action=migrate` har derfor nu en **idempotent ALTER-liste** (`$alters`) der try/catch'er hver
  kolonne og returnerer `columnsAdded`. Kør den efter skemaændringer. (Her returnerede den `[]` =
  `updated_at` fandtes allerede.)

## RSS er nu PRIMÆR kilde for ALLE feeds (2026-07-29)
**Problem:** "Store Penge" havde et nyt afsnit (28/7) i Castbox, men ikke i app'en. **Årsag: ikke en
bug i app'en — Podcast Index sakker bagud.** PI er en *crawler*; `/episodes/byfeedid` for feedet
returnerede stadig 23/7 som nyeste, mens feedets eget RSS havde 28/7-afsnittet. En sammenligning af
alle 19 rigtige favoritter (cache vs. RSS) viste **3 feeds bagud**: Store Penge (5 dage),
**Børsen investor** og **Sådan investerer jeg** (7 dage). Resten var ajour — så det er sporadisk
crawl-lag, ikke systematisk nedbrud.
**Fix:** DR-allowlisten (`PODCAST_DIRECT_RSS_HOSTS`) er droppet. `podcast_feed_prefers_rss()`
returnerer nu true for **ethvert http(s) `feed_url`** → alle feeds læses direkte fra RSS, og
**Podcast Index bruges kun som fallback** hvis RSS-hentningen fejler (og til søgning/opdagelse,
som før). Sammen med den eksisterende DR-erfaring er reglen nu: *PI finder podcasts, RSS leverer
afsnit.*
- **`RSS_MAX_EPISODES = 60`** (ny) — kun de nyeste 60 importeres, samme dybde som PI leverede.
  **Vigtigt hvorfor:** feedene har 300-400 afsnit (Investeringspodcasten 427, Store Penge 312);
  tog vi dem alle, ville **køen** (som viser *uhørte*) blive oversvømmet af flere hundrede gamle
  afsnit. `rss_fetch_episodes()` sorterer derfor nyeste-først **før** den skærer (feeds kan ikke
  antages sorteret).
- **Teaser-prune er nu vindue-begrænset:** kun cachede afsnit **nyere end det ældste importerede**
  kan slettes. Ellers ville `$max`-afkortningen få gamle afsnit til at ligne "fjernet fra feedet".
- **episode_id bevares nu via `audio_url` først, titel+dato som fallback.** Hørt-tilstand hænger på
  `episode_id`, så id-churn = alt Allan har hørt dukker op igen som uhørt. `audio_url` er den
  stabile nøgle (PI gemte præcis feedets enclosure-URL). **Titel+dato-fallbacken er ikke pynt:**
  **art19**-feeds (`Casper 3080 Tikøb`, `Casper ringer til Frank`) hænger et per-kald-token på
  lyd-URL'en (`?rss_browser=BAhJIg` vs. `BAhJIh`), så audio-match giver 0 der — titel+dato reddede
  alle 10 afsnit.
- **Verificeret med en tør-kørsel FØR deploy** (hent RSS + app-cache for hver favorit og simulér
  matchningen): forudsagde 8 nye afsnit og **0 id-churn**. Live-resultatet blev **7 inserted /
  846 reused / 0 mistede id'er**. Gør det samme igen ved fremtidige ændringer i id-matchningen.
- **`feed_url` backfilles** (`podcast_backfill_feed_url`): nogle gamle favoritter blev gemt uden
  (fx `Genstart`), og uden den kan RSS ikke læses. Hentes fra PI's `/podcasts/byfeedid` én gang og
  gemmes på favoritten.
- **Podimo-favoritter springes eksplicit over** i `podcast_refresh_feed` (deres `feed_url` er en
  HTML-showside, ikke et RSS — de fyldes af HTPC-scraperen). Før virkede det ved et tilfælde fordi
  allowlisten kun matchede DR.
- **Ydelse målt:** alle 19 feeds hentet+parset på **3,8 s** i alt (max 8 pr. request → ~1,5 s).
  Ingen grund til at ændre `PODCAST_STALE_SECONDS` (30 min).
- **Tør-kørsel-faldgrube (Python):** `email.utils.parsedate_to_datetime` behandler RFC-2822-`-0000`
  som *naiv* tid, så `.timestamp()` fortolker den i lokal tid → alle art19-datoer var 2 timer
  forkerte og "matchede ikke". PHP's `strtotime` gør det rigtigt. Sæt `tzinfo=utc` når du
  simulerer serverens datoer i Python.

## DR: læs RSS DIREKTE, ikke via Podcast Index (2026-07-28)
**Problem:** "Ubegribeligt" viste 60 poster i app'en som alle var **smagsprøver på 33-40 sek**
(også de to uden "TEASER:" i titlen). Årsag: app'en henter afsnit fra **Podcast Index**, og PI's
afsnitsdata for feedet var teasere fra 2025-26 — mens **DR's eget RSS samtidig indeholdt 78 rigtige,
fulde 57-min-afsnit** (2022-2024). PI's feed-metadata sagde endda `episodeCount: 78`, så det var
kun PI's *afsnitsliste* der var gal.
**Fix:** `api/rssfeed.php` + `PODCAST_DIRECT_RSS_HOSTS` (`api.dr.dk`, `dr.dk`) i `podcast_store.php`:
for DR-feeds parses RSS'et selv (`rss_fetch_episodes`), og PI bruges kun som fallback hvis RSS
fejler. Ny action **`feed.refreshRss&id=<feedId>`** tvinger en genindlæsning.
- **Kritisk detalje — bevar `episode_id`:** hørt-tilstand og lytteposition hænger på `episode_id`.
  Nye id'er ville nulstille alt. `rss_refresh_feed` slår derfor eksisterende afsnit op på
  **titel+published_at** og genbruger id'et; ellers `rss_stable_id()` = `crc32(guid) & 0x7FFFFFFF`
  (deterministisk). Verificeret: 2. kørsel gav `reused:78, inserted:0`.
- **Teaser-oprydning er bevidst konservativ:** der slettes kun cachede afsnit der **både** mangler i
  RSS'et **og** er **≤120 sek** (`RSS_TEASER_MAX_SEC`). Så ægte gamle afsnit, som et kort RSS ikke
  når tilbage til, slettes aldrig.
- **Resultat:** Ubegribeligt 78 ind / 60 teasere ud · Brinkmanns briks 237 ind / **41 teasere ud** ·
  Sara & Monopolet 254 ind. Lyd verificeret (`audio/mpeg`, 82 MB, HTTP 200 efter 302-redirect).
- **DR's 2026-sæson er IKKE i noget RSS** — kun i DR Lyd. Se næste afsnit.

## DR Lyd: 2026-sæsonen (undersøgt 2026-07-28)
DR lægger kun en **40-sek teaser** i det offentlige feed; det fulde afsnit (57 min) ligger i DR Lyd.
Fx teaser "Nanoteknologi" (40 s, 25/6-2026) ↔ rigtigt afsnit "Nanoteknologi" (**57 min**, samme dato).
- **Afsnitsdata kan hentes uden login:** show-siden (`https://www.dr.dk/lyd/special-radio/
  ubegribeligt-3455554599000`) har `__NEXT_DATA__` → `props.pageProps.episodesGroups[].items` med
  `productionNumber`, `slug`, `durationMilliseconds`, `hasAudioAssets`, `presentationUrl`,
  `learnId` (25 afsnit i 2026-gruppen).
- **Lyd-URL kunne IKKE skaffes:** `api.dr.dk/radio/v4/...` giver **401** (kræver `x-apikey`),
  nøglen er **ikke** i browser-bundlen (DR kalder serverside), ingen mp3/m3u8 i sidens HTML
  (kun live-radio-streams), og et afspilnings-klik i headless gav ingen asset-URL. **`login.dr.dk`
  indlæses på siden** → peger på krav om DR-konto. Derfor er 2026-sæsonen realistisk **link-out**,
  som Podimo — ikke afspilning i app'en. (DR's egen show-beskrivelse siger da også "Hør alle afsnit
  i DR Lyd".)
- **BYGGET: `scraper/scrape_dr.py`** (+ `run_dr.sh`, cron **`17 * * * *`**, log `scrape_dr.log`).
  **Kræver INGEN browser** — modsat Podimo-scraperen: `__NEXT_DATA__` ligger i server-HTML'en, så
  ren `requests` er nok. Flow: favoritter → behold `dr.dk`-feeds → DR Lyd-sidens URL fra Podcast
  Index' `link`-felt (`?action=podcast`) → parse `episodesGroups[].items` (kun `hasAudioAssets`) →
  POST `?action=dr.ingest`.
- **`dr.ingest`** gemmer dem som link-out (`audio_url` NULL, `link_url` = `presentationUrl`) på det
  **eksisterende** DR-feed, så de står sammen med RSS-afsnittene. `episode_id = rss_stable_id(
  productionNumber)` (deterministisk, kolliderer ikke med PI's meget større id'er).
- **Dublet-reglen er DATO, ikke titel (vigtig lære):** første forsøg matchede på titel og fandt
  **nul** dubletter — DR Lyd og RSS navngiver afsnit forskelligt (fx "Sara & Monopolet 27. juni" vs.
  dagens tema), så der blev lavet 24 + 16 overflødige link-outs for Sara/Brinkmann, hvis RSS
  **allerede er aktuelt**. Nu springes et afsnit over hvis der findes et **afspilleligt** afsnit
  samme **udgivelsesdag**, og endpointet **rydder selv op** i tidligere link-outs der nu er dækket
  (`prunedRedundant`). Efter fix: Ubegribeligt 78 afspillelige + 25 link-out (2026), Sara 194+6,
  Brinkmann 191+9 — **0 overflødige**.
- **Kun indeværende år:** serie-siden leverer kun det aktuelle års gruppe udfyldt (øvrige år loades
  først ved klik), hvilket er rigeligt til "hvad er nyt".

## Sonos-afspilning (undersøgt 2026-07-28 — IKKE bygget, bruger sagde "ikke nu")
Spørgsmål: kan app'en streame til Sonos? **Ja, men aldrig direkte fra browseren.** Tre uafhængige
blokeringer: (1) **Sonos understøtter ikke Google Cast**, så Chromes cast-knap finder dem aldrig;
(2) **AirPlay 2** findes på Move 2 + Amp, men kun fra Apple-enheder — Allan er på Pixel;
(3) app'en kører **HTTPS** og Sonos styres over **HTTP på en lokal IP** → browseren blokerer det som
mixed content, og Sonos sender heller ingen CORS-headere. Gælder også på eget WiFi.
**Det der gør det muligt:** Sonos afspiller fint en almindelig **HTTPS-lyd-URL**, og afsnittenes
`audio_url` er præcis det (verificeret: DR-lyd = `audio/mpeg`, 82 MB, HTTP 200).
**Skitseret løsning** (samme mønster som deal-radar/Podimo — *HTPC er motoren, aogj.com er
postkassen*): app → POST "afspil <audio_url> i <rum>" til aogj.com → HTPC poller hvert par sekunder
→ SOAP `SetAVTransportURI` + `Play` mod `http://<sonos-ip>:1400/MediaRenderer/AVTransport/Control`
(se det eksisterende `sonos_random_track` shell_command i HA's `configuration.yaml` som SOAP-skabelon).
Virker også uden for hjemmet. Forsinkelse = polling-intervallet.
**Forbehold:** Podimo- og DR-link-out-afsnit har **ingen `audio_url`** og kan derfor ikke sendes til
Sonos. Højttaler-IP'er er DHCP → find dem ved at scanne TCP 1400 (se workspace-`CLAUDE.md`).

## Popularitet / hitlister (2026-07-28)
**Konklusion på "kan vi vise downloadtal?": NEJ til ægte downloadtal.** De er private hos
hosting-udbyderen (Podtrac/Acast/Libsyn m.fl.) og udstilles intet offentligt sted. Undersøgt og
afvist: **Podcast Index har INGEN popularitetsfelter** (feed-objektet har kun `priority` =
crawl-prioritet, ikke popularitet — verificeret på et rigtigt feed). **Spotify** har *ingen*
`popularity` på episode-objektet og kræver bruger-OAuth → droppet.
**Valgt løsning: Apples danske hitlister** — gratis, ingen API-nøgle, dansk:
- `https://rss.marketingtools.apple.com/api/v2/dk/podcasts/top/50/podcasts.json` → **top 50 podcasts**
  (max er 50; `top/100` og `/200` fejler). Felter: `name`, `artistName`, `id` (= iTunes-id), `artworkUrl100`.
- `.../top/25/podcast-episodes.json` → **"Trending Episodes"**, 25 afsnit. **NB:** listen har
  **hverken `collectionId` eller `collectionName`** (kun `name` + `artistName`), så afsnit kan
  **kun matches på titel**.
- **Backend `api/charts.php`** + action **`charts`** (`?force=1` forbigår cache). Cacher i tabellen
  `podcast_chart_cache` i **6 timer** (Apple opdaterer ~dagligt). Falder tilbage til **stale cache**
  hvis Apple er nede — hellere gamle tal end ingen.
- **Matchning:** `chart_norm()` (PHP) og `chartNorm()` (App.tsx) **skal holdes identiske** —
  lowercase, fjern emoji + tegnsætning, kollaps whitespace. Serveren sender en færdig `norm`-nøgle.
  Podcasts matches på iTunes-id hvis kendt, ellers normaliseret titel (vi gemmer p.t. ikke
  `itunes_id` på favoritter — titel-match er nok i praksis).
- **UI:** 🔥 `#N i DK`-chip (`.hot`) på afsnit i køen; `#N i DK`-chip (`.rank`) på podcast-kort
  (Favoritter + Udforsk); og **"🇩🇰 Mest populære i Danmark lige nu"** — hele top-50-listen i
  **Udforsk** (klik = søg podcasten frem i Podcast Index så den kan følges). Hitlisten er bevidst
  **fejl-tolerant**: slår `getCharts()` fejl, vises intet, og resten af app'en er upåvirket.
- **Realistisk dækning:** kun 3 af Allans 22 favoritter lå i top-50, og 3 afsnit i køen var trending.
  Det er forventet — det er et *highlight*, ikke et tal på alt. Der findes ingen gratis kilde til
  et popularitetstal for **enhver** podcast (Listen Notes' "Listen Score" kræver betalt API-nøgle).

## Castbox-feature-vurdering (2026-07-28)
Allan bruger til dagligt **Castbox**; vi gennemgik dens features. **Besluttet/bygget:** spol ±10/30,
fremdrift i kø, Fortsætter-sektion, **offline download** (se eget afsnit nedenfor).
**Endnu ikke besluttet:** afspilningshastighed, sleep timer, auto-spring-intro pr. podcast,
volume boost. **Vurderet uegnet:** in-audio-søgning (kræver transskribering), CarPlay/Watch/Alexa/
FM-radio (kan ikke i en PWA). Cross-device sync **har** vi allerede (fast `allan-main`).

## Offline-download (BYGGET 2026-08-17)
Bygget til en køretur til Nordkapp uden mobildækning hele vejen. `web/src/lib/downloads.ts` +
`web/src/lib/offline.ts` + ny **Hentet**-fane. Ingen backend-ændring — deploy kun `web`.

**Lyden hentes med `fetch(url, {mode:'no-cors'})` og lægges i Cache API; service workeren
serverer den, så `<audio src=afsnittets rigtige URL>` virker uændret uden dækning.**
Tre målinger afgjorde designet — gentag dem før du laver om på det:
- **CORS findes stort set ikke på lyd-CDN'erne.** Målt i rigtig Chrome fra `aogj.com`-origin
  (2026-08-17): kun **3 af 7** værter i Allans kø tillader en læsbar fetch — `api.dr.dk`,
  `traffic.omny.fm`, `api.spreaker.com`. `media.pod.space`, `www.buzzsprout.com` og **begge**
  `simplecastaudio`-værter fejler med "TypeError: Failed to fetch". Den gamle note om at 5 af 6
  sendte CORS var **forkert** (den så kun på første hop; ACAO mangler på det hop hvor bytes
  leveres, bl.a. fordi CloudFront cacher svaret uden `Vary: Origin`). **Kan ikke ses med curl.**
- **Den læsbare Blob-vej blev afprøvet og FRAVALGT.** Man kan godt hente en Blob fra de tre
  CORS-værter og få procentvis fremdrift, men et `Response` man selv bygger i JS er ikke
  byte-range-dueligt: `audio.seekable` blev **[0,0]** og spoling var umulig. Derfor ingen
  download-procent — kun spinner pr. afsnit og "N af M" ved bulk.
- **Opaque virker derimod perfekt, på alle værter.** Verificeret ende-til-ende: varighed korrekt,
  `seekable` = hele filen, spoling til slutningen lander rigtigt og afspilningen kører videre —
  også med netværket slået fra. Chrome er **spolbar ca. 250 ms** efter start (den skal læse filen
  ind fra cachen først); mål på `seekable`, ikke på et fast `setTimeout`, hvis du tester det.

Faldgruber der er håndteret, og som du ikke må rulle tilbage:
- **`AUDIO_CACHE` ('nordpod-audio-v1') skal stå i `KEEP` i sw.js' activate-handler.** Den slettede
  før alt der ikke var det aktuelle `CACHE_NAME` — dvs. næste deploy ville have slettet alle
  hentede afsnit, værst tænkeligt midt på turen.
- **Hver download verificeres ved at afspille metadata før den tælles med.** Et opaque svar har
  **altid status 0**, så et 403 fra CDN'et ligner en vellykket hentning indtil man står uden
  dækning. Størrelsen kan ikke afsløre det: Chrome polstrer opaque svar tilfældigt — **samme
  fejlside målte 2, 7,2, 9,9 og 13,7 MB i fire forsøg**. Fejler kontrollen, slettes filen igen og
  afsnittet markeres ikke som hentet. Af samme grund vises **skønnet** størrelse pr. afsnit
  (≈1 MB/min), mens totalen kommer fra `navigator.storage.estimate()`.
- **App'en skal kunne ÅBNE offline, ikke bare afspille.** Alt indhold kom fra `api/index.php`, som
  er dødt uden net. Køen og favoritterne gemmes derfor som øjebliksbillede i localStorage og
  bruges som startværdi (lazy `useState`, ikke en effect — `react-hooks/set-state-in-effect`).
- **Lytning må ikke gå tabt.** `state.set` fejler offline, og hørt/position ligger kun på serveren,
  så to uger uden dækning ville nulstille alt. Alle skrivninger går gennem `saveStateResilient()`,
  som lægger dem i en udbakke (én post pr. afsnit, nyeste felt vinder) og sender dem på
  `online`-hændelsen. Derefter genhentes køen, så hørte afsnit forsvinder.
- (Auto-videre havde en offline-regel om kun at hoppe til hentede afsnit. Den er væk sammen med
  auto-videre selv, 2026-08-22 — app'en stopper nu altid efter et afsnit.)
- `navigator.storage.persist()` kaldes ved første download; uden den må Android smide filerne væk.

**Sådan testes det uden at deploye** (service workers kræver HTTPS *eller* localhost):
byg `web/dist`, og server det på `http://localhost:8572/podcast/` med en lille Python-proxy der
videresender `/podcast/api/*` til `https://aogj.com/podcast/api/index.php`. Så kører app'en med
rigtig SW + Cache API mod de rigtige data. Offline simuleres med **både** CDP
`Network.emulateNetworkConditions {offline:true}` **og** en override af `navigator.onLine` —
CDP alene ændrer ikke `navigator.onLine`, og app'en træffer beslutninger på den.
**NB:** `device_id` er hardkodet til `allan-main` (`lib/device.ts`), så en test kan ikke få sin
egen bruger — undgå at klikke hørt-knapper, eller ryd udbakken før forbindelsen kommer tilbage.

**`www.buzzsprout.com` afviser HTPC** (Cloudflare, 403) — dens afsnit kan hverken hentes eller
streames derfra, heller ikke i en rigtig browser. Det er **ikke** en fejl i app'en; på Allans
telefon virker de. Brug den som testtilfælde for fejlhåndteringen.

## Podimo-integration (BYGGET 2026-07-27)
Podimo er paywalled → Podcast Index kender dem ikke, og lyden er DRM-låst (kan ikke afspilles
in-app). Men **offentlige shows viser afsnitslisten uden login** (ikke alle — nogle er helt
eksklusive). Løsning = **link-out** (besked om nye afsnit + "↗ åbn hos Podimo").
- **one.com kan IKKE scrape Podimo** (JS + Cloudflare Turnstile). Derfor en **HTPC-scraper**:
  `scraper/scrape_podimo.py` (egen venv `scraper/.venv`, Selenium+requests), **cron hvert 30. min**
  (`scraper/run.sh` → `scrape.log`). Den henter `favorites.list?deviceId=allan-main`, filtrerer
  `added_via=='podimo'`, renderer hver show-side headless og POSTer afsnit til `podimo.ingest`.
- **Udtræk (robust):** Podimo indlejrer per-afsnit **`<script id="episodeSeo<uuid>" type=ld+json>`
  PodcastEpisode**-blokke → `name`/`datePublished`/`description`/`duration`(ISO PT#S)/`url`. Show-
  titel fra **`<h1>`** (ren; og:title har tagline + "| Eksklusivt på Podimo"), billede fra
  `og:image`, afsnits-artwork fra DOM-kortenes `img`. Kun de nyeste ~15 har ld+json (nok til "nyt").
- **Backend:** `podimo.add` (frontend: indsæt Podimo show-URL i "tilføj via URL"-boksen — App.tsx
  `addByUrl` router på `podimo.com/../shows/`) og `podimo.ingest` (scraper). **Syntetisk
  `feed_id = -crc32(slug)`** (negativ → kolliderer ikke med Podcast Index' positive id'er),
  **`episode_id = crc32(uuid)`** (episode_id-kolonnen er BIGINT, kan ikke rumme Podimos UUID).
  `audio_url` NULL + `link_url` = Podimo-episode-URL → frontendens eksisterende link-out-visning
  (`↗`). **Regex-delimiter:** brug `~...~` ikke `#...#` (mønstret har `#` i `[^/?#]`).
  On-open PI-refresh (`podcast_store.php`) springer `added_via='podimo'` over.
- Seedet+verificeret: Her Går Det Godt + Casper ringer til Frank (15 afsnit hver, link-out i køen).
  **Note:** Podimo-afsnit uden `audio_url` kan ikke afspilles — kun link-out.

## Link-out UX + kilde-mærkater (2026-07-27)
- **Kilde-mærkat** pr. afsnit (App.tsx `sourceOf`): udledt af lyd-/link-domænet (Podimo/DR/Acast/
  Omny/Megaphone/…). Vist som farvet chip (`.src`, Podimo lilla, DR blå).
- **VIGTIG Android-faldgrube:** i en **installeret PWA (standalone) på Android blokeres
  `window.open(url,'_blank')`** — derfor "skete der ikke noget" når man trykkede afspil på et
  Podimo/DR-afsnit uden in-app-lyd. Fix: tryk på et ikke-afspilleligt afsnit åbner nu en **pop-up
  (afsnit-modalen)** med en **ægte `<a href target=_blank>`-knap** ("↗ Åbn hos <udbyder>") — ægte
  ankre virker i standalone, JS-`window.open` gør ikke. Brug ALDRIG `window.open` til eksterne links.
- **Robusthed:** hvis et afsnit *har* `audio_url` men afspilningen fejler (`<audio> onError`, fx DR
  geo/app-only), sættes `playErrorId` og samme link-out-pop-up vises (i stedet for tavshed).

## Podimo (oprindelig undersøgelse 2026-07-26)
Bruger vil have Podimo-shows (fx "Casper ringer til Frank") i køen. Podimo er paywalled → Podcast
Index kender dem ikke. **Fund:** direkte HTTP giver **403** (bot-beskyttelse/Cloudflare Turnstile);
**Selenium (rigtig browser) kommer forbi**, MEN **udlogget viser show-siden ingen afsnitsliste** —
kun "Kun på Podimo/Prøv gratis". Så afsnit + datoer kræver **Allans Podimo-login** (som FB-flowet).
Lyden er DRM-låst → kan ikke afspilles i app'en; realistisk plan = **link-out** ("åbn hos Podimo",
som DR/paywall-afsnit allerede gør) så man kun får besked om nye afsnit. Afventer bruger-beslutning
(kræver login + er en selvstændig integration: "tilføj Podimo-show via URL" + Selenium-scraper +
gemme som `link_url`-afsnit uden `audio_url`).

## one.com serverer kun 2 samtidige PHP-kald (2026-08-10) — VIGTIGST
Det var **den egentlige** kilde til det ~1 sekund brugeren så. Målt i browseren mod den live side:

| samtidige kald | resultat |
|---|---|
| 1 | 13 ms |
| 2 | 17 ms |
| 3 | én af dem **1030 ms** |
| 4 | to af dem **~1015 ms** |

Hosten parkerer altså kald nr. 3+ i **præcis ét sekund**. Ventetiden ligger i TTFB, ikke i
connect/TLS, og forbindelsen er genbrugt — det er serverside. App'en fyrede før fire kald af på
mount (`favorites.list` + `episodes.newest` + `discover` + `charts`), så **ét tilfældigt af dem**
betalte sekundet; ramte det køen, stod siden tom imens.
- **Fix: `MAX_INFLIGHT = 2` i `web/src/lib/api.ts`.** Alle kald går gennem `apiGet`/`apiPost`/
  `apiDelete`, som er kø-styret af `limited()`. Det gælder derfor også modaler (`getPodcast` +
  `feedEpisodes` samtidig) — ikke kun opstarten.
- **FÆLDE ved fejlsøgning: det kan IKKE ses med curl.** Tre samtidige `curl` svarer alle på 40-80 ms,
  fordi hver får sin egen TCP-forbindelse. Grænsen viser sig kun fra en rigtig browser. Brug
  `performance.getEntriesByType('resource')` i Selenium og se på `responseStart - requestStart`.
- Gælder efter alt at dømme **hele aogj.com** (delt hosting), altså også `todo`, `fryser`,
  `superbits`, `bio`, `temp_sensors`. Hold antallet af parallelle API-kald på 2.

## Kø-load: cache først, feed-tjek bagefter (2026-08-10)
**Problem:** ved åbning viste køen "Alt er hørt 🎉" i ca. 1 sek., og derefter kom alt indholdet.
**Årsag — ikke databasen:** `episodes.newest` kaldte `podcast_refresh_stale_favorites()` **før**
den svarede, dvs. den hentede op til 8 forældede feeds' RSS over nettet (målt **0,15-0,38 sek. pr.
feed** med `feed.refreshRss` → 1-3 sek. i alt) inden den sendte den cache den allerede havde
liggende. Imens var `favorites.list` (~0,1 sek.) forlængst hjemme, så `favorites.length > 0 &&
unheardCount === 0` var sandt → tom-tilstanden blev tegnet. Selve SQL'en er ~80 ms.
**Fix, tre dele:**
- **Split af endpointet.** `episodes.newest` er nu **ren cache-læsning** (rører aldrig nettet).
  Refresh'en har fået sit eget `episodes.refresh`, som frontenden kalder **efter** at køen er
  tegnet. Det returnerer `feeds`/`inserted`/`changed`, og køen genhentes **kun** hvis `changed` —
  som regel er der intet nyt, og så koster baggrundstjekket ingen ekstra payload.
  `podcast_refresh_feed()` returnerer derfor nu et antal i stedet for `void`.
- **Tom-tilstanden må ikke gætte.** Ny `queueLoaded`-state: en tom kø betyder kun "alt er hørt"
  når vi rent faktisk **har** hentet den. Under load vises "Henter køen…", og over listen en
  spinner (`.feedcheck`) mens `episodes.refresh` arbejder — cachen står bag den imens.
- **Payload skåret ned.** Køen hentede alle 200 nyeste rækker med alt indhold: målt **132 af 200
  rækker hørte = 201 KB af 298 KB** (`description` alene er 49 %). Selve bortfiltreringen af hørte
  rækker er rullet tilbage 2026-08-21 — køen viser dem igen, se afsnittet nedenfor — men
  beskrivelsen udelades stadig for hørte afsnit.
  **FÆLDE fra dengang, hvis du genindfører en ydre forespørgsel:** den **skal** have sin
  egen `ORDER BY`. MariaDB bruger kun den indre `ORDER BY` til at afgøre hvilke rækker `LIMIT`
  beholder — rækkefølgen *ud af* en afledt tabel er udefineret. Køen kom blandet ud (9 brud på 65
  rækker), hvilket viste sig som **gentagne dag-overskrifter** ("Onsdag" efter "03. August").
  Tjek altid sorteringen efter et skema-/forespørgselsindgreb, ikke bare antallet af rækker.
- **`discover` udskudt:** Udforsk-listen (~0,7 sek. hos Podcast Index) hentes nu først når fanen
  åbnes, fra klik-handleren (ikke en effect — `react-hooks/set-state-in-effect` afviser det).
  Før kørte den på mount og var et af de fire kald der ramte 2-kalds-loftet ovenfor.
- **Målt resultat (Selenium mod live siden, kold browser):** afsnit på skærmen efter **~130 ms**
  mod **1143 ms** før. "Alt er hørt" blinker ikke længere forbi. SW-cache bumpet til `nordpod-v7`.

## "Fortsætter" ligger nu i kronologien (2026-08-10)
Sektionen øverst er **fjernet**. Afsnit man er i gang med bliver liggende i deres normale
dag-gruppe (det er kronologien der er pointen), og markeres i stedet på **selve rækken**:
`.episode.continuing` = samme lysegrønne flade som den gamle boks + en terracotta-kant, plus en
"▶ Fortsætter"-chip i meta-linjen. Fremdriftsbjælken og "X min tilbage" var der allerede og styres
af samme `isInProgress()`. Dag-grupperne filtrerer ikke længere in-progress-afsnit fra.
NB: "✓ ryd herunder" tog allerede in-progress-afsnit med (den filtrerer på `playedAt`, ikke på
visningen), så adfærden er uændret der.

## Køen viser nu også HØRTE afsnit (2026-08-21)
Hørte afsnit forsvandt før ud af køen. Nu bliver de liggende på deres **kronologiske plads** og
markeres i stedet: `.episode.heard` (tonet ned, gråtonet cover, dæmpet titel) + et grønt
**"✓ Hørt"**-mærkat i meta-linjen. Dag-overskriften viser "**X af Y uhørte**" på dage hvor noget er
hørt, og "✓ ryd herunder" skjules på dage hvor der ikke er noget uhørt tilbage (hverken den dag
eller ældre). `groupByDay(queue)` får hele køen — ikke `queue.filter(!playedAt)` som før.
- **`$unheardOnly` er væk fra `podcast_newest_episodes()`**; vinduet er igen "de 200 nyeste afsnit".
- **Men payload-lærdommen holder:** `description` sendes **kun for uhørte** rækker
  (`CASE WHEN st.played_at IS NULL THEN e.description ELSE NULL END`). Målt live efter deploy:
  200 rækker = **278 KB** mod 212 KB for de 118 uhørte alene — uden det trick ~360 KB.
- **"Læs mere" på et hørt afsnit henter teksten ved behov:** nyt endpoint **`episode.get`**
  (`&feedId=&id=` → `podcast_episode()`, PK-opslag), frontend `episodeDescription()` +
  `showEpisode()` i App.tsx. Svaret patches ind i `queue`/`detailEpisodes`, så det kun hentes én
  gang pr. afsnit; imens står der "Henter beskrivelse…". Offline fejler kaldet stille, og pop-up'en
  viser "Ingen beskrivelse."
- Alt andet regner stadig på `!playedAt`: uhørt-tælleren, fane-badget, bulk-hentning og
  "ryd herunder" — adfærden der er uændret.
- Verificeret i rigtig Chrome mod den live side: 200 rækker, 82 hørte spredt **mellem** de uhørte,
  82 "Hørt"-mærkater, og beskrivelsen hentet efter klik på et hørt afsnit.

## Udforsk: søgetræffere ØVERST (2026-08-21)
Hitlisten (Apples top 50) lå altid før resultat-gitteret, så et søgeresultat landede ~3.100 px nede
på en telefon — man kunne ikke se hvad man havde fundet. Nu styrer **`searchedFor`** (hvad
`results` er et svar *på*; `''` = discover-listen) rækkefølgen:
- **Har man søgt:** træfferne står lige under søgefeltet med overskriften "N træffere for “…”" +
  **✕ Ryd søgning**, og hitlisten foldes sammen nedenunder (`<details class="charts charts-fold">`).
  Målt efter deploy: første kort på **y=380**, hitlisten på y=742, sidehøjde 943 px mod ~3.100 før.
- **Uden søgning:** som før — hitlisten øverst, discover-gitteret under.
- Alle indgange går gennem **`runSearchFor()`** (søgeknap/Enter, klik på hitlisten, "ryd"), så
  `searchedFor` aldrig kan komme ud af trit med `results`. Tom søgning = discover igen.
- Tomt resultat siger det nu ("Ingen podcasts matchede …") og foreslår "Alle sprog" hvis
  sprogfiltret står på **Kun dansk** — ellers ligner et bortfiltreret resultat en fejl.

## Bil og baggrund: Media Session udvidet (2026-08-22)
To klager: (1) afspilleren forsvinder fra notifikationsskuffen få minutter efter man pauser,
mens Castbox bliver stående i timevis; (2) i Teslaen kan man kun pause/afspille, ikke spole.

- **Bilens frem/tilbage er nu spol: `nexttrack` = +30 sek., `previoustrack` = −10 sek.**
  Biler sender kun AVRCP-kommandoer over Bluetooth, og **der findes ingen "spol 30 sek."-kommando**
  — rattet/skærmen sender "næste/forrige nummer". Derfor er de to knapper bundet til `skip()`
  ligesom ↻30/↺10 i appen. **Konsekvens:** man kan ikke længere springe til næste afsnit fra
  bilen. Vil man have springet tilbage, er det `nexttrack` → et "spil næste"-kald igen. `seekforward`/`seekbackward` (hold nede) peger på de samme ±30/−10.
- **`setPositionState()`** kaldes ved start/pause/spol/metadata (`syncPositionState()`), så bilens
  og låseskærmens tidslinje viser forløbet tid og varighed. `playbackState` sættes nu eksplicit —
  ellers ville keep-alive nedenfor få systemet til at tro der stadig afspilles.
- **Keep-alive: `web/src/lib/keepalive.ts`.** En PWA har ingen foreground service, så en pauset
  app er bare en baggrundsfane: Chrome fryser den, og Android kasserer den ved hukommelsespres.
  Modtrækket er at afspille **lydløs lyd** mens der er pauset — så regner Android app'en for
  "afspiller lyd" og lader den være. To ting må ikke ændres:
  - Lyden må **ikke** være `muted` eller have `volume = 0` — en dæmpet strøm tæller ikke som
    afspilning, og så holder trickget ingenting i live. WAV'en er tavs i stedet (8-bit PCM,
    værdien 128 = nul-udsving), bygget i kode så der ikke skal caches en ekstra fil.
  - Den **stopper af sig selv efter 10 minutter** (`LIMIT_MS`). Keep-alive holder lydfokus og
    holder Bluetooth-lydkanalen åben i bilen, så den må ikke køre i det uendelige.
  Starter i `<audio onPause>` (kun når et afsnit er i gang og ikke er slut — afsnittets slutning
  er også en "pause"), stopper i `onPlay`. Verificeret i Chrome: den genererede WAV afspilles og
  looper, og `playbackState` skifter korrekt playing/paused.
- **Positionen gemmes nu med det samme** ved pause og når app'en ryger i baggrunden
  (`savePositionNow()` på `visibilitychange`/`pagehide`), ikke kun hvert 8. sekund. På `pagehide`
  bruges **`navigator.sendBeacon`** (`beaconState()` i offline.ts) — en axios-POST aflyses sammen
  med siden når Android dræber den. Fejler beacon'en, ryger skrivningen i udbakken.
- **Kan ikke testes herfra:** selve bilens knapper kræver en Bluetooth-enhed. Headless Chrome kan
  hverken sende AVRCP-kommandoer eller vise notifikationsskuffen — det skal afprøves på telefonen.
- **Telefonside (ikke kode):** Chrome skal stå til **Ubegrænset** batteriforbrug
  (Indstillinger → Apps → Chrome → Batteri), ellers dræber Android baggrundsprocessen uanset hvad
  app'en gør. Androids "medie-genoptagelse" (den chip der bliver liggende efter en app er lukket)
  kræver en `MediaBrowserService` og kan **ikke** lade sig gøre fra web.

## Ingen auto-videre: app'en stopper efter hvert afsnit (2026-08-22)
Bruger-beslutning: **app'en må aldrig selv starte det næste afsnit.** `onEnded` markerer afsnittet
hørt, pauser lyden, stopper keep-alive og rydder afspilleren — den leder ikke længere efter "næste
uhørte". Rul det ikke tilbage uden at spørge.

## DR TV som link-out (2026-08-22)
Debatten og Deadline (og alt andet i DRTV) kan nu følges som en podcast. Video kan **ikke**
afspilles i appen — afsnittene gemmes uden `audio_url` med `link_url` til dr.dk, så frontendens
eksisterende link-out-visning (↗ + pop-up) bruges uændret. `api/drtv.php` er hele integrationen.

- **API'et (sniffet i browseren, ingen login nødvendig):** vært **`prod95-cdn.dr-massive.com`**
  (fra DRTV-sidens egen `env.CLIENT_SERVICE_CDN_URL`). To endpoints er nok:
  `/api/v2/search?term=…` og `/api/page?path=/serie/<slug>_<id>`.
  **Tre fælder:** `sub` skal være **`Anonymous2`** (`Anonymous` giver 401); søgningen kræver en
  vilkårlig **`sessionId`** (UUID), ellers 400; og den gamle vært `production-cdn.dr-massive.com`
  svarer 401 på alt. Svaret er gzip'et — husk `CURLOPT_ENCODING => ''`.
- **Datoen ligger i `customFields.AvailableFrom`** (UTC ISO). Afsnittene har hverken
  `broadcastDate` eller `releaseDate`, så uden det felt ville alt lande i "Uden dato" i køen.
  Afsnit med en dato i fremtiden springes over.
- **Serie-siden svarer med den AKTUELLE sæson** i `item.episodes.items` (Debatten 19, Deadline 16).
  Det er "hvad er nyt", præcis som DR Lyd-integrationen — ingen paginering, ingen gamle sæsoner.
- **Id'er:** `feed_id = -crc32('drtv:' + show-sti)` (negativ som Podimos, kolliderer aldrig med
  Podcast Index' positive id'er) og `episode_id = rss_stable_id('drtv:' + DRTV's numeriske id)`
  (deterministisk → hørt-tilstand overlever en genindlæsning). Show-stien (`/serie/deadline_7111`)
  er nøglen, **ikke** sæson-stien, så søgning og "tilføj via URL" giver samme feed.
- **Opdatering kræver ingen scraper og ingen cron:** one.com kan selv nå dr-massive (verificeret
  live). `podcast_refresh_feed()` vælger DR TV-vejen ud fra **feed-URL'en** (`dr.dk/drtv`), ikke
  ud fra `added_via`, så en serie tilføjet via URL-boksen opfører sig som en fulgt fra søgningen.
- **Søgningen i Udforsk henter DR TV parallelt med Podcast Index** og lægger TV-træfferne
  **øverst** (få og præcise mod PI's snesevis). Fejler DR, vises kun podcastene.
- **Markering:** feed-objektet har `kind: 'tv'` → blåt **📺 TV**-mærkat på kortet (også i
  Favoritter, via `added_via='drtv'`), og hvert afsnit får et **📺 DR TV**-mærkat + "ses hos DR TV".
  Frontenden kender TV-afsnit på `link_url` (`/drtv/`), se `isTvEpisode()`.
- **`episodes.feed` accepterer nu negative feed-id'er** — før afviste den dem med 422, så hverken
  Podimo-shows eller TV-serier kunne åbnes fra Favoritter.
- **Bemærk sæson-hullet:** Debattens sæson sluttede 11. juni, så serien har ingen afsnit inden for
  køens vindue (de 200 nyeste) før den nye sæson går i gang. Afsnittene ligger der — de ses ved at
  åbne serien under Favoritter. Deadline sender dagligt og fylder derfor i køen med det samme.

## Recommendations (ønsket, ikke bygget)
Bruger vil have forslag baseret på favoritter. Kan gøres via Podcast Index-kategorier på favoritter
→ top-podcasts i samme kategori minus ejede. Afventer at kende brugerens faktiske favoritter (kan
ikke ses uden hans `device_id`; MySQL-creds er kun i server-`config.php`).

## Repo
`git@github.com:tarcom/podcast.git` (branch `main`). Byg videre på det eksisterende — det blev
rebygget fra en tidligere React/Podcast-Index-prototype 2026-07.
