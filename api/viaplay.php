<?php

declare(strict_types=1);

/**
 * Viaplay / TV3 — TV-serier som LINK-OUT. Samme mønster som drtv.php.
 *
 * HVORFOR: Robinson Ekspeditionen kører på TV3/Viaplay, ikke på DR, så DR TV-søgningen finder
 * den aldrig. Allan vil have den i køen sammen med Debatten og Deadline. Video kan ikke afspilles
 * i appen (Viaplay har både abonnement og DRM), så afsnittene gemmes uden `audio_url` og med
 * `link_url` til viaplay.dk — præcis som DR TV og Podimo. Frontendens eksisterende
 * link-out-visning (↗ + pop-up) tager sig af resten.
 *
 * SÅDAN SER API'ET UD (undersøgt 2026-09-14). Ingen login, ingen nøgle, ingen session-parameter:
 *   - `https://content.viaplay.dk/pc-dk/search?query=…`      — søgning
 *   - `https://content.viaplay.dk/pc-dk/serier/<slug>`       — serie-siden
 * Begge svarer 200 anonymt. Produkterne bærer ganske vist et `notice` med
 * "User must login to view content" — det gælder AFSPILNING. Titler, datoer, resuméer,
 * varigheder og billeder er offentlige, og det er alt hvad en link-out skal bruge.
 *
 * FÆLDER:
 *   - **Kun den aktuelle sæson er fyldt ud.** Serie-siden har én `season-list`-blok pr. sæson,
 *     men kun den nyeste har `_embedded.viaplay:products`; de øvrige er tomme, til man beder om
 *     dem med `?seasonNumber=N&partial=1&blockId=…`. Det er "hvad er nyt", præcis som DR TV —
 *     ingen paginering, ingen gamle sæsoner.
 *   - **Kommende afsnit ligger i `viaplay:upcomingProducts`**, ikke i `viaplay:products`, og har
 *     `content.duration` = null. De springes over på datoen som hos DR TV, men bemærk at de ligger
 *     i et ANDET felt — læser man kun `viaplay:products`, får man dem aldrig, og det er fint.
 *   - **Datoen ligger i `system.availability.start`** (UTC ISO). Der er intet `broadcastDate`.
 *     Robinsons afsnit 4 blev tilgængeligt 2026-09-13T22:00Z = mandag kl. 00:00 dansk tid.
 *   - **`content.synopsis` er en STRENG på serien og på afsnittene**, ikke et objekt; feltet
 *     `content.synopsis.brief` findes i skemaet, men er null her. Begge former håndteres.
 *   - **Søgningen er upræcis.** "robinson" gav Dexter, Loud House og I Spy blandt hittene.
 *     Derfor filtreres der på, at seriens titel faktisk indeholder søgeordene — ellers ville
 *     TV-træfferne, som lægges ØVERST i Udforsk, larme mere end de hjælper.
 *   - **Web-URL'en er `viaplay.dk`, ikke `content.viaplay.dk`.** `publicPath` er stien uden
 *     `/serier/`-præfikset (`robinson-ekspeditionen/saeson-27/afsnit-1`). Verificeret HTTP 200.
 */

const VIAPLAY_API = 'https://content.viaplay.dk/pc-dk';
const VIAPLAY_WEB = 'https://viaplay.dk';
const VIAPLAY_MAX_EPISODES = 40;

function viaplay_get(string $path, array $params = []): ?array
{
    $url = VIAPLAY_API . $path . ($params ? '?' . http_build_query($params) : '');
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: AllDKPodcasts/1.0 (+https://aogj.com/podcast)'],
    ]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false || $code !== 200) {
        return null;
    }
    $data = json_decode((string) $raw, true);
    return is_array($data) ? $data : null;
}

/**
 * Feed-id for en Viaplay-serie. Negativt ligesom Podimos og DR TV's, så det aldrig kolliderer
 * med Podcast Index' (altid positive) id'er. Præfikset `viaplay:` gør desuden, at en serie med
 * samme slug som en DR TV-serie får et andet id.
 */
function viaplay_feed_id(string $showPath): int
{
    return -((int) (crc32('viaplay:' . $showPath) & 0x7FFFFFFF));
}

/** `https://viaplay.dk/serier/robinson-ekspeditionen/saeson-27/afsnit-4` -> `/serier/robinson-ekspeditionen`. */
function viaplay_path_from_url(string $url): ?string
{
    $host = strtolower((string) parse_url($url, PHP_URL_HOST));
    if (!preg_match('~(^|\.)viaplay\.(dk|com)$~', $host)) {
        return null;
    }
    // Både den rigtige web-URL og content-API'ets (som har /pc-dk/ foran).
    if (!preg_match('~/serier/([^/?#]+)~i', (string) parse_url($url, PHP_URL_PATH), $m)) {
        return null;
    }
    // Serie-stien er den stabile nøgle — ikke sæsonen og ikke afsnittet.
    return '/serier/' . $m[1];
}

/** Viaplays billed-URL'er beder om 960x540. Skru dem ned — de bruges som 52 px thumbnails. */
function viaplay_image(?array $images, int $w = 500, int $h = 500): string
{
    foreach (['boxart', 'landscape', 'coverart23', 'hero169'] as $key) {
        $img = $images[$key] ?? null;
        if (!is_array($img)) {
            continue;
        }
        $url = trim((string) ($img['url'] ?? ''));
        if ($url === '') {
            // Nogle billeder har kun en skabelon: `...jpg{?width,height}`.
            $tpl = trim((string) ($img['template'] ?? ''));
            if ($tpl === '') {
                continue;
            }
            return preg_replace('~\{\?width,height\}$~', '?width=' . $w . '&height=' . $h, $tpl) ?? $tpl;
        }
        $url = preg_replace('~([?&])width=\d+~i', '${1}width=' . $w, $url) ?? $url;
        $url = preg_replace('~([?&])height=\d+~i', '${1}height=' . $h, $url) ?? $url;
        return $url;
    }
    return '';
}

/** `content.synopsis` er en streng her, men skemaet har også `synopsis.brief`. Tag hvad der er. */
function viaplay_synopsis(array $content): string
{
    $s = $content['synopsis'] ?? null;
    if (is_string($s)) {
        return trim($s);
    }
    if (is_array($s)) {
        foreach (['brief', 'long', 'short'] as $k) {
            if (is_string($s[$k] ?? null) && trim($s[$k]) !== '') {
                return trim($s[$k]);
            }
        }
    }
    return '';
}

/** Viaplay-produkt (serie) -> samme form som Podcast Index' feed-objekter. */
function viaplay_feed_object(array $item): ?array
{
    $publicPath = trim((string) ($item['publicPath'] ?? ''));
    if ($publicPath === '') {
        return null;
    }
    $content = is_array($item['content'] ?? null) ? $item['content'] : [];
    $showPath = '/serier/' . $publicPath;
    $web = VIAPLAY_WEB . $showPath;
    $titel = trim((string) ($content['title'] ?? ''));
    if ($titel === '') {
        $titel = trim((string) (($content['series'] ?? [])['title'] ?? 'Viaplay'));
    }
    return [
        'id' => viaplay_feed_id($showPath),
        'title' => $titel,
        'image' => viaplay_image($content['images'] ?? null),
        'author' => 'Viaplay',
        'language' => 'da',
        'url' => $web,  // normalizePodcast() læser `url` som feed-URL …
        'link' => $web, // … og `link` som hjemmesiden
        'description' => viaplay_synopsis($content),
        'kind' => 'tv', // frontenden sætter TV-mærkatet ud fra denne
    ];
}

/** Alle produkter i et svar, uanset hvilken blok de ligger i. */
function viaplay_products(array $data): array
{
    $out = [];
    foreach (($data['_embedded']['viaplay:blocks'] ?? []) as $block) {
        if (!is_array($block)) {
            continue;
        }
        foreach (['viaplay:products', 'viaplay:upcomingProducts'] as $key) {
            foreach (($block['_embedded'][$key] ?? []) as $p) {
                if (is_array($p)) {
                    $out[] = $p;
                }
            }
        }
    }
    return $out;
}

/**
 * Søg efter TV-serier hos Viaplay. Fejler Viaplay, returneres en tom liste — søgningen må ikke
 * vælte af det.
 *
 * Viaplays søgning er løs i koblingen (den svarede Dexter og Loud House på "robinson"), og
 * TV-træffere lægges ØVERST i Udforsk. Derfor kræves det, at hvert søgeord faktisk står i
 * seriens titel; ellers er et TV-hit mere støj end hjælp.
 */
function viaplay_search(string $term, int $max = 4): array
{
    $data = viaplay_get('/search', ['query' => $term]);
    if ($data === null) {
        return [];
    }
    $ord = array_filter(explode(' ', chart_norm($term)), static fn(string $o): bool => $o !== '');
    if (!$ord) {
        return [];
    }

    $out = [];
    $set = [];
    foreach (viaplay_products($data) as $p) {
        if (($p['type'] ?? '') !== 'series') {
            continue;
        }
        $feed = viaplay_feed_object($p);
        if ($feed === null || isset($set[$feed['id']])) {
            continue;
        }
        $titel = chart_norm((string) $feed['title']);
        foreach ($ord as $o) {
            if (!str_contains($titel, $o)) {
                continue 2;
            }
        }
        $set[$feed['id']] = true;
        $out[] = $feed;
        if (count($out) >= $max) {
            break;
        }
    }
    return $out;
}

/** Slå en serie op ud fra dens Viaplay-sti (til "tilføj via URL"). */
function viaplay_series_by_path(string $path): ?array
{
    $data = viaplay_get($path);
    if ($data === null) {
        return null;
    }
    // Serie-siden lægger showets egne data i en `article`-blok.
    foreach (($data['_embedded']['viaplay:blocks'] ?? []) as $block) {
        $art = $block['_embedded']['viaplay:article'] ?? null;
        if (is_array($art)) {
            return viaplay_feed_object($art);
        }
    }
    return null;
}

/**
 * Hent en Viaplay-series afsnit ind i cachen som link-out (ingen `audio_url`).
 * Returnerer ['inserted'=>n, 'total'=>m] eller null hvis Viaplay ikke svarede.
 */
function viaplay_refresh_feed(PDO $pdo, int $feedId, string $seriesUrl, int $max = VIAPLAY_MAX_EPISODES): ?array
{
    $path = viaplay_path_from_url($seriesUrl);
    if ($path === null) {
        return null;
    }
    $data = viaplay_get($path);
    if ($data === null) {
        return null;
    }

    $now = time();
    $rows = [];
    foreach (viaplay_products($data) as $e) {
        if (($e['type'] ?? '') !== 'episode') {
            continue;
        }
        $publicPath = trim((string) ($e['publicPath'] ?? ''));
        $guid = trim((string) (($e['system'] ?? [])['guid'] ?? ''));
        if ($publicPath === '' || $guid === '') {
            continue;
        }
        // Kun afsnit fra DENNE serie — "Lignende serier"-blokken har også produkter.
        if (!str_starts_with('/serier/' . $publicPath, $path . '/')) {
            continue;
        }
        $start = trim((string) ((($e['system'] ?? [])['availability'] ?? [])['start'] ?? ''));
        $pub = $start !== '' ? (int) strtotime($start) : 0;
        // Kommende afsnit ville lægge sig øverst i køen som "nyt" uden at kunne ses endnu.
        if ($pub === 0 || $pub > $now) {
            continue;
        }
        $content = is_array($e['content'] ?? null) ? $e['content'] : [];
        $serie = is_array($content['series'] ?? null) ? $content['series'] : [];
        $titel = trim((string) ($serie['episodeTitle'] ?? ''));
        if ($titel === '') {
            $titel = trim((string) ($content['title'] ?? 'Viaplay'));
        }
        $rows[] = [
            // Deterministisk: samme Viaplay-guid giver altid samme episode_id, så hørt-tilstand
            // overlever en genindlæsning (samme regel som drtv.php og rss_stable_id).
            'ep' => rss_stable_id('viaplay:' . $guid),
            'title' => mb_substr($titel, 0, 512),
            'descr' => viaplay_synopsis($content),
            'pub' => $pub,
            'link' => VIAPLAY_WEB . '/serier/' . $publicPath,
            'image' => viaplay_image($content['images'] ?? null),
            'dur' => (int) round(((int) (($content['duration'] ?? [])['milliseconds'] ?? 0)) / 1000),
        ];
    }
    usort($rows, static fn(array $a, array $b): int => $b['pub'] <=> $a['pub']);
    $rows = array_slice($rows, 0, $max);

    $known = [];
    $q = $pdo->prepare('SELECT episode_id FROM podcast_episodes WHERE feed_id = :f');
    $q->execute(['f' => $feedId]);
    foreach ($q->fetchAll() as $r) {
        $known[(int) $r['episode_id']] = true;
    }

    $upsert = $pdo->prepare(
        'INSERT INTO podcast_episodes
            (feed_id, episode_id, title, description, published_at, audio_url, link_url, image, duration_sec)
         VALUES (:feed, :ep, :title, :descr, :pub, NULL, :link, :image, :dur)
         ON DUPLICATE KEY UPDATE
            title = VALUES(title), description = VALUES(description), published_at = VALUES(published_at),
            link_url = VALUES(link_url), image = VALUES(image), duration_sec = VALUES(duration_sec)'
    );

    $inserted = 0;
    foreach ($rows as $r) {
        if (!isset($known[$r['ep']])) {
            $inserted++;
        }
        $upsert->execute([
            'feed' => $feedId, 'ep' => $r['ep'], 'title' => $r['title'], 'descr' => $r['descr'],
            'pub' => $r['pub'], 'link' => $r['link'], 'image' => $r['image'], 'dur' => $r['dur'],
        ]);
    }

    return ['inserted' => $inserted, 'total' => count($rows)];
}
