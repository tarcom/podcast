# NordPod

Reklame-light podcast-app med dansk-først prioritet. Kun én bruger (dig) — ingen login endnu,
men `device_id` bæres gennem hele modellen, så rigtige brugere kan tilføjes senere uden
skemaændring.

Live: **https://aogj.com/podcast/** (one.com, PHP + delt MySQL). React + Vite frontend, PHP-proxy
mod Podcast Index.

## Kernefunktioner

- **Kun favoritter** (stjernemarkér en podcast). Ikke det gamle favorit/abonnement-skel.
- **Kø-fane** = de nyeste *uhørte* afsnit på tværs af alle favoritter, nyeste først. Afspilleren
  kører videre til næste uhørte når et afsnit er færdigt.
- **Hørt-tilstand**: hørte afsnit bliver grå. Sættes automatisk når et afsnit spilles færdigt, og
  kan sættes/fjernes manuelt (nødvendigt for link-ud-afsnit vi ikke selv afspiller).
- **Sprogfilter** på søgeresultater (Dansk først / Kun dansk / Alle) + dansk-først discover.
- **Tilføj via RSS-URL** — escape hatch til feeds Podcast Index ikke finder via søgning.
- **DR / Podimo m.fl.:** offentlige feeds afspilles/vises normalt. Afsnit uden afspillelig lydfil
  (paywall/app-only) får et "åbn hos udbyder"-link i stedet for en afspil-knap.

## Arkitektur

- **Frontend:** React + TypeScript + Vite + PWA. Bygges under `base=/podcast/`.
- **Backend:** tynde PHP-endpoints (`api/index.php?action=…`) der proxyer Podcast Index og læser/
  skriver MySQL. Ingen framework.
- **Data (delt `aogj_com`-DB, tabeller præfikset `podcast_`):**
  - `podcast_favorites` — hvilke feeds du følger (+ `last_fetched` der styrer refresh)
  - `podcast_episodes` — cache af afsnit pr. feed (globalt; muliggør "hvad er nyt" + sortering)
  - `podcast_episode_state` — pr-device hørt/afspilningsposition (grå-markering + genoptag)
- **Ingen cron nødvendig.** "Opdatér ved åbning": når du henter køen, refresher backenden de
  favoritter hvis afsnit er ældre end 30 min (kappet til 8 pr. kald). Da det kun er dig med få
  favoritter er det billigt. (one.com har planlagte opgaver hvis vi senere vil holde cachen varm.)

## API-endpoints (`api/index.php?action=…`)

`health` · `migrate` (opret tabeller, idempotent) · `discover` · `search` · `podcast` ·
`resolveUrl` (RSS-URL → feed) · `favorites.list/add/remove` · `episodes.feed` (ét show) ·
`episodes.newest` (kø: nyeste uhørte på tværs af favoritter) · `state.set` (hørt + position).

## Udvikling

```bash
# Frontend (kræver Node 20+ — brug nvm; system-node på HTPC er 18)
cd web && npm install && npm run dev
# Backend lokalt
cp api/config.example.php api/config.php   # udfyld Podcast Index-nøgler + MySQL
php -S localhost:8000 -t .
```

## Deploy (one.com, kun FTP)

`./deploy.sh api` uploader `api/*.php` (inkl. `config.php` — den skal med, den er gitignored og
ligger kun på serveren). `./deploy.sh web` bygger og uploader `web/dist/`. Creds i
`.ftp-credentials` (gitignored, delt med de andre aogj.com-projekter). Kør
`…/api/index.php?action=migrate` én gang efter første deploy for at oprette tabellerne.

## Ikke bygget endnu

- Rigtig brugerhåndtering (login → stabil `device_id`/`user_id`)
- Podimo-eksklusivt indhold (kræver den grå selvhostede converter — bevidst fravalgt; kun
  offentlige Podimo-shows dækkes automatisk via Podcast Index)
- Notifikationer for nye afsnit
