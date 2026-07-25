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

## Repo
`git@github.com:tarcom/podcast.git` (branch `main`). Byg videre på det eksisterende — det blev
rebygget fra en tidligere React/Podcast-Index-prototype 2026-07.
