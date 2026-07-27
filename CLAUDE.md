# CLAUDE.md — NordPod (podcast)

Reklame-light podcast-app, kun til Allan (ingen login endnu). **Live på https://aogj.com/podcast/**
(one.com, PHP + delt `aogj_com`-MySQL). Se `README.md` for fuld arkitektur — her kun de ting der
er lette at snuble over.

## Stak
- Frontend: **React + TS + Vite 8 + PWA**, deployet under `base=/podcast/`.
- Backend: tynde PHP-endpoints i `api/` der proxyer **Podcast Index** (åbent API) + MySQL.
- Data: 3 tabeller præfikset `podcast_` i den delte `aogj_com`-DB (favoritter / episode-cache /
  pr-device hørt-tilstand). Kun-favoritter-model; hørt = grå + driver "næste uhørte" i Kø-fanen.

## Gotchas
- **Vite 8 kræver Node 20+.** HTPC'ens system-node er 18. Byg med `nvm use 20` (nvm er installeret
  i `~/.nvm`). `node_modules` skal installeres under node 20 (rolldown har en native binding pr.
  version) — ellers "Cannot find module rolldown-binding".
- **`api/config.php`** (Podcast Index-nøgler + MySQL-creds) er **gitignored** og ligger KUN på
  serveren. `deploy.sh api` uploader den bevidst med. Samme MySQL som resten af aogj.com:
  host `aogj.com.mysql`, bruger/db `aogj_com`.
- **Ingen cron.** Refresh sker "ved åbning" (backenden henter forældede favoritters afsnit inline
  når køen loades). Bevidst — one.com/simply-cron er ikke en forudsætning.
- **PWA-stier er hardcodet til `/podcast/`** i `web/public/sw.js` + `manifest.webmanifest` (de
  path-rewrites IKKE af Vite). Cache hedder `nordpod-v2`; bump ved shell-ændringer.
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

## Podimo (undersøgt 2026-07-26 — IKKE bygget endnu)
Bruger vil have Podimo-shows (fx "Casper ringer til Frank") i køen. Podimo er paywalled → Podcast
Index kender dem ikke. **Fund:** direkte HTTP giver **403** (bot-beskyttelse/Cloudflare Turnstile);
**Selenium (rigtig browser) kommer forbi**, MEN **udlogget viser show-siden ingen afsnitsliste** —
kun "Kun på Podimo/Prøv gratis". Så afsnit + datoer kræver **Allans Podimo-login** (som FB-flowet).
Lyden er DRM-låst → kan ikke afspilles i app'en; realistisk plan = **link-out** ("åbn hos Podimo",
som DR/paywall-afsnit allerede gør) så man kun får besked om nye afsnit. Afventer bruger-beslutning
(kræver login + er en selvstændig integration: "tilføj Podimo-show via URL" + Selenium-scraper +
gemme som `link_url`-afsnit uden `audio_url`).

## Recommendations (ønsket, ikke bygget)
Bruger vil have forslag baseret på favoritter. Kan gøres via Podcast Index-kategorier på favoritter
→ top-podcasts i samme kategori minus ejede. Afventer at kende brugerens faktiske favoritter (kan
ikke ses uden hans `device_id`; MySQL-creds er kun i server-`config.php`).

## Repo
`git@github.com:tarcom/podcast.git` (branch `main`). Byg videre på det eksisterende — det blev
rebygget fra en tidligere React/Podcast-Index-prototype 2026-07.
