<?php

declare(strict_types=1);

/**
 * drpodcast.nu — DR's podcasts som de var, før DR trak dem ud af RSS.
 *
 * HVORFOR: DR lægger kun en 40-sek. smagsprøve af de nyeste sæsoner i sit offentlige feed; det
 * fulde afsnit ligger i DR Lyd. Lyd-URL'en kunne ikke skaffes derfra (undersøgt 2026-07-28:
 * `api.dr.dk/radio/v4/...` giver 401 og kræver en `x-apikey`, som DR kalder serverside og aldrig
 * sender til browseren), så 2026-sæsonerne har siden ligget som link-out via `scrape_dr.py`.
 *
 * drpodcast.nu genudgiver DR's feeds med de rigtige afsnit. Sitet hoster IKKE lyd selv —
 * enclosure-URL'erne peger på DR's egen `api.dr.dk/radio/v1/assetlinks/...`, som svarer 302 til
 * DR's Akamai-CDN. Vi henter altså stadig lyden fra DR; spejlet leverer kun den henvisning, DR
 * har fjernet fra sit eget feed.
 *
 * MÅLT 2026-09-14 (skiftet blev besluttet på disse tal):
 *   - Lyden er ægte: HTTP 206, `audio/mpeg`, 192 kbit/s, range-requests virker.
 *   - `api.dr.dk` sender `access-control-allow-origin: *`, og den er i forvejen én af kun tre
 *     værter i køen der tillader en læsbar fetch — så offline-download virker også.
 *   - "Nanoteknologi" (det afsnit der i juli kun fandtes som 40-sek. teaser) ligger der i 57:23.
 *   - Dækning mod DR's eget feed: Ubegribeligt 80 → 196, Sara & Monopolet 256 → 423,
 *     Brinkmanns briks 239 → 357, Hjerteflimmer 110 → 220, Genstart 893 → 1492.
 *
 * FALDGRUBE — GENSTART ER FORSKUDT: DR forsinker udgivelsen i sit eget RSS. Samme afsnit står
 * med datoer der ligger 3-4 døgn senere end på spejlet (målt: 801 af 887 fælles titler afveg,
 * typisk 72-96 timer). Titel+dato-nøglen i `rss_refresh_feed` matcher derfor ikke for Genstart,
 * og uden titel-fallbacken dér ville hele showets hørt-tilstand blive nulstillet ved skiftet.
 *
 * SIKKERHEDSNET: spejlet er en privat tjeneste, der genudgiver noget DR bevidst har trukket
 * tilbage. Den kan forsvinde. Derfor skiftes `feed_url` på favoritten ALDRIG — spejlet vælges
 * først ved hentning, og fejler det, læses DR's eget feed som hidtil. App'en kan altså ikke
 * blive dårligere end den var, uanset hvad der sker med drpodcast.nu.
 */

const DRPODCAST_BASE = 'https://drpodcast.nu';
// Forsiden er 170 KB HTML med 677 shows. Den ændrer sig sjældent — et døgn er rigeligt.
const DRPODCAST_INDEX_TTL = 86400;

/** Er dette DR's eget podcast-RSS? DR TV går sin egen vej (se drtv.php). */
function drpodcast_is_dr_feed(string $url): bool
{
    $host = strtolower((string) parse_url($url, PHP_URL_HOST));
    if (!in_array($host, ['api.dr.dk', 'www.dr.dk', 'dr.dk'], true)) {
        return false;
    }
    return stripos($url, '/drtv') === false;
}

/** `https://api.dr.dk/podcasts/v1/feeds/ubegribeligt.xml?format=podcast` -> `ubegribeligt`. */
function drpodcast_dr_slug(string $url): string
{
    $path = (string) parse_url($url, PHP_URL_PATH);
    if (!preg_match('~/([^/]+)\.xml$~', $path, $m)) {
        return '';
    }
    return strtolower($m[1]);
}

function drpodcast_feed_url(string $slug): string
{
    return DRPODCAST_BASE . '/' . rawurlencode($slug) . '/feed.xml';
}

/**
 * slug => titel for alle shows på drpodcast.nu, cachet et døgn i `podcast_chart_cache`
 * (samme generiske nøgle/payload-tabel som hitlisterne — ingen ny tabel, ingen migrering).
 *
 * Tom liste = sitet svarede ikke. Kalderen falder så tilbage til DR's eget feed.
 */
function drpodcast_index(PDO $pdo, bool $force = false): array
{
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS podcast_chart_cache (
            kind VARCHAR(32) NOT NULL PRIMARY KEY,
            payload MEDIUMTEXT NOT NULL,
            fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );

    $stmt = $pdo->prepare(
        'SELECT payload, UNIX_TIMESTAMP(fetched_at) AS ts FROM podcast_chart_cache WHERE kind = :k'
    );
    $stmt->execute(['k' => 'drpodcast']);
    $row = $stmt->fetch() ?: null;
    $age = $row ? (time() - (int) $row['ts']) : PHP_INT_MAX;

    if (!$force && $row && $age < DRPODCAST_INDEX_TTL) {
        $cached = json_decode((string) $row['payload'], true);
        if (is_array($cached) && $cached) {
            return $cached;
        }
    }

    $fresh = drpodcast_fetch_index();
    if (!$fresh) {
        // Sitet er nede. Hellere en gammel liste end ingen — slugs ændrer sig ikke.
        if ($row) {
            $cached = json_decode((string) $row['payload'], true);
            if (is_array($cached)) {
                return $cached;
            }
        }
        return [];
    }

    $ins = $pdo->prepare(
        'INSERT INTO podcast_chart_cache (kind, payload) VALUES (:k, :p)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = CURRENT_TIMESTAMP'
    );
    $ins->execute(['k' => 'drpodcast', 'p' => json_encode($fresh, JSON_UNESCAPED_UNICODE)]);
    return $fresh;
}

/** Forsiden er én tabel med `data-slug`/`data-title` pr. række. Ingen JSON-API at hente det fra. */
function drpodcast_fetch_index(): array
{
    $ch = curl_init(DRPODCAST_BASE . '/');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => ['User-Agent: AllDKPodcasts/1.0 (+https://aogj.com/podcast)'],
    ]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false || $code !== 200) {
        return [];
    }

    if (!preg_match_all('~data-slug="([^"]+)"\s+data-title="([^"]*)"~', (string) $raw, $m, PREG_SET_ORDER)) {
        return [];
    }
    $out = [];
    foreach ($m as $hit) {
        // Titlerne står HTML-escapede ("Sara &amp; Monopolet - podcast").
        $out[$hit[1]] = html_entity_decode($hit[2], ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }
    return $out;
}

/**
 * Find showets slug på spejlet. Null hvis det ikke findes der.
 *
 * DR's eget filnavn er som regel slug'en (`ubegribeligt.xml` -> `ubegribeligt`), men ikke altid:
 * Sara & Monopolet hedder `mads-monopolet-podcast.xml` hos DR og `sara-og-monopolet` på spejlet.
 * Derfor titel-matchet bagefter — begge sider viser DR's egen titel, så `chart_norm()` rammer.
 */
function drpodcast_slug_for(PDO $pdo, string $feedUrl, string $title = ''): ?string
{
    $index = drpodcast_index($pdo);
    if (!$index) {
        return null;
    }

    $slug = drpodcast_dr_slug($feedUrl);
    if ($slug !== '' && isset($index[$slug])) {
        return $slug;
    }

    $want = chart_norm($title);
    if ($want === '') {
        return null;
    }
    foreach ($index as $s => $t) {
        if (chart_norm($t) === $want) {
            return $s;
        }
    }
    return null;
}

/**
 * Genindlæs et DR-feed fra spejlet.
 *
 * Returnerer `rss_refresh_feed`'s resultat, eller null hvis showet ikke findes på spejlet eller
 * feedet ikke kunne hentes. Null betyder altså "brug DR's eget feed" — kalderen falder tilbage.
 */
function drpodcast_refresh(PDO $pdo, int $feedId, string $feedUrl, string $title, int $max = RSS_MAX_EPISODES): ?array
{
    $slug = drpodcast_slug_for($pdo, $feedUrl, $title);
    if ($slug === null) {
        return null;
    }
    return rss_refresh_feed($pdo, $feedId, drpodcast_feed_url($slug), true, $max);
}
