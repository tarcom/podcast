# NordPod

Reklame-light podcast app med dansk-furst prioritet, bygget til one.com med PHP + MySQL backend og React + Vite frontend.

## Arkitektur

- Frontend: React + TypeScript + Vite + PWA (manifest + service worker)
- Backend: PHP API proxy mod Podcast Index
- Data: MySQL til favoritter, abonnementer, afspilningsko og afspilningsposition
- Login: ikke aktiveret endnu (enhedsbaseret id i browseren)

## Struktur

- web/: frontend app
- api/: PHP API
- database/schema.sql: MySQL tabeller

## 1) Lokal udvikling

### Frontend

1. Gå til web mappen:

	cd web

2. Installer pakker:

	npm install

3. Kopier env-fil:

	cp .env.example .env

4. Start udviklingsserver:

	npm run dev

### Backend

1. Kopier konfigurationsfil:

	cp api/config.example.php api/config.php

2. Udfyld api/config.php med:

	- Podcast Index api_key
	- Podcast Index api_secret
	- MySQL host, database, bruger, kodeord

3. Opret tabeller i MySQL ved at køre database/schema.sql i one.com phpMyAdmin.

## 2) API endpoints

Alle routes rammes via api/index.php?action=<action>

- health
- discover
- search
- podcast
- episodes
- favorites.list
- favorites.add
- favorites.remove
- subscriptions.list
- subscriptions.add
- subscriptions.remove
- queue.list
- queue.add
- queue.remove
- progress.get
- progress.set

## 3) One.com deployment

Da one.com her er PHP + MySQL + FTP uden SSH:

1. Build frontend lokalt:

	cd web
	npm run build

2. Upload indholdet af web/dist til webroden på one.com via FTP.

3. Upload api mappen til samme webrod, fx /api/index.php.

4. Læg api/config.php op med rigtige nøgler og database credentials.

5. Kør database/schema.sql i one.com phpMyAdmin.

6. Verificer at frontend kalder korrekt API-sti:

	VITE_API_BASE=/api/index.php

## 4) Seed af dansk indhold

Appen henter automatisk trending podcasts med lang=da i discover flow. Det giver dansk-furst forside fra dag 1.

## 5) Sikkerhed

- API nøgler maa aldrig ligge i frontend.
- Roter nøgler hvis de har vaeret delt offentligt.
- Beskyt api/config.php via serverregler hvis muligt pa one.com.

## 6) Næste trin

- Brugerlogin (email eller social)
- Multi-device synk
- Notifikationer for nye episoder
- Android packaging via TWA eller React Native senere