<?php

declare(strict_types=1);

/**
 * DR TV (dr-massive) — TV-programmer som LINK-OUT.
 *
 * Hvorfor: Allan vil have "Debatten" og "Deadline" i køen sammen med podcastene. DRTV-video kan
 * ikke afspilles i appen (egen afspiller + DRM), så afsnittene gemmes uden `audio_url` og med
 * `link_url` til dr.dk — præcis samme mønster som Podimo og DR Lyds 2026-sæson. Frontendens
 * eksisterende link-out-visning (↗) tager sig af resten.
 *
 * SÅDAN BLEV API'ET FUNDET (2026-08-22, sniffet med Selenium på dr.dk/drtv). To endpoints er nok,
 * og INGEN af dem kræver login:
 *   - `/api/v2/search`  — kræver en vilkårlig **sessionId** (UUID). Uden den: 400 med
 *     "One of the following parameters is required: sessionId, userId".
 *   - `/api/page?path=/serie/<slug>_<id>` — svarer med den AKTUELLE sæson i `item.episodes.items`.
 *
 * FÆLDER der kostede tid:
 *   - `sub` skal være **Anonymous2**. `sub=Anonymous` giver 401 på alt.
 *   - Værten er **prod95-cdn.dr-massive.com** (fra sidens egen `env.CLIENT_SERVICE_CDN_URL`).
 *     Den ældre `production-cdn.dr-massive.com` svarer 401 uanset parametre.
 *   - Afsnittene har hverken `broadcastDate` eller `releaseDate` — datoen ligger i
 *     `customFields.AvailableFrom` (UTC ISO). Uden den ville alt lande i "Uden dato" i køen.
 */

const DRTV_API = 'https://prod95-cdn.dr-massive.com/api';
const DRTV_WEB = 'https://www.dr.dk/drtv';
const DRTV_MAX_EPISODES = 40;
// Vilkårlig, men fast: API'et kræver blot at parameteren er der.
const DRTV_SESSION_ID = '7f1c0b6e-9d2a-4c53-b8f1-0a5d6e3c42aa';
const DRTV_COMMON = [
    'device' => 'web_browser',
    'ff' => 'idp,ldp,rpt',
    'lang' => 'da',
    'segments' => 'drtv,optedout',
    'sub' => 'Anonymous2',
];

function drtv_get(string $path, array $params): ?array
{
    $url = DRTV_API . $path . '?' . http_build_query(array_merge(DRTV_COMMON, $params));
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_ENCODING => '', // DR svarer gzip'et
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
 * Feed-id for en DR TV-serie. Negativt ligesom Podimos, så det aldrig kolliderer med Podcast
 * Index' (altid positive) id'er. Skal udregnes af **show-stien** (`/serie/deadline_7111`), så en
 * serie tilføjet via søgning og via URL får samme id.
 */
function drtv_feed_id(string $showPath): int
{
    return -((int) (crc32('drtv:' . $showPath) & 0x7FFFFFFF));
}

/** DR's billed-URL'er beder om 3000 px. Skru dem ned — de bruges som 52 px thumbnails. */
function drtv_image(?array $images, int $w = 500, int $h = 500): string
{
    foreach (['tile', 'poster', 'wallpaper'] as $key) {
        $url = trim((string) ($images[$key] ?? ''));
        if ($url === '') {
            continue;
        }
        $url = preg_replace('~([?&])Width=\d+~i', '${1}Width=' . $w, $url) ?? $url;
        $url = preg_replace('~([?&])Height=\d+~i', '${1}Height=' . $h, $url) ?? $url;
        return $url;
    }
    return '';
}

/** DRTV-item (show/season) -> samme form som Podcast Index' feed-objekter, så frontenden ikke skal skelne. */
function drtv_feed_object(array $item, ?string $showPath = null): ?array
{
    $path = trim((string) ($showPath ?? $item['path'] ?? ''));
    if ($path === '') {
        return null;
    }
    $web = DRTV_WEB . $path;
    $channel = trim((string) (($item['customFields'] ?? [])['BrandingChannelDisplayName'] ?? ''));
    return [
        'id' => drtv_feed_id($path),
        'title' => (string) ($item['title'] ?? 'DR TV'),
        'image' => drtv_image($item['images'] ?? null),
        'author' => $channel !== '' ? 'DR TV · ' . $channel : 'DR TV',
        'language' => 'da',
        'url' => $web,  // normalizePodcast() læser `url` som feed-URL …
        'link' => $web, // … og `link` som hjemmesiden
        'description' => (string) ($item['description'] ?? $item['shortDescription'] ?? ''),
        'kind' => 'tv', // frontenden sætter TV-mærkatet ud fra denne
    ];
}

/** Søg efter TV-serier. Fejler DR, returneres en tom liste — søgningen må ikke vælte af det. */
function drtv_search(string $term, int $max = 6): array
{
    $data = drtv_get('/v2/search', ['term' => $term, 'group' => 'true', 'sessionId' => DRTV_SESSION_ID]);
    $items = $data['series']['items'] ?? null;
    if (!is_array($items)) {
        return [];
    }
    $out = [];
    foreach ($items as $it) {
        if (!is_array($it) || ($it['type'] ?? '') !== 'show') {
            continue;
        }
        $feed = drtv_feed_object($it);
        if ($feed) {
            $out[] = $feed;
        }
        if (count($out) >= $max) {
            break;
        }
    }
    return $out;
}

/** `https://www.dr.dk/drtv/serie/deadline_7111` -> `/serie/deadline_7111`. Null hvis det ikke er DRTV. */
function drtv_path_from_url(string $url): ?string
{
    if (!preg_match('~dr\.dk/drtv(/(?:serie|saeson|season|episode)/[^/?#]+)~i', $url, $m)) {
        return null;
    }
    return $m[1];
}

/** Slå en serie op ud fra dens DRTV-sti (til "tilføj via URL"). */
function drtv_series_by_path(string $path): ?array
{
    $data = drtv_get('/page', ['path' => $path, 'item_detail_expand' => 'all', 'max_list_prefetch' => 1]);
    $item = $data['item'] ?? null;
    if (!is_array($item)) {
        return null;
    }
    // Serie-siden svarer med den aktuelle SÆSON; show-stien er den stabile nøgle.
    $showPath = trim((string) (($item['show'] ?? [])['path'] ?? ''));
    if ($showPath === '') {
        $showPath = str_starts_with($path, '/serie/') ? $path : (string) ($item['path'] ?? $path);
    }
    return drtv_feed_object($item, $showPath);
}

/** Afsnittene på en serie-side: den aktuelle sæson, ellers hvad der ligger i sidens lister. */
function drtv_episode_items(array $data): array
{
    $eps = $data['item']['episodes']['items'] ?? null;
    if (is_array($eps) && $eps) {
        return $eps;
    }
    $out = [];
    foreach (($data['entries'] ?? []) as $entry) {
        foreach ((($entry['list'] ?? [])['items'] ?? []) as $it) {
            if (is_array($it) && ($it['type'] ?? '') === 'episode') {
                $out[] = $it;
            }
        }
    }
    return $out;
}

/**
 * Hent en DR TV-series afsnit ind i cachen som link-out (ingen `audio_url`).
 * Returnerer ['inserted'=>n, 'total'=>m] eller null hvis DR ikke svarede.
 */
function drtv_refresh_feed(PDO $pdo, int $feedId, string $seriesUrl, int $max = DRTV_MAX_EPISODES): ?array
{
    $path = drtv_path_from_url($seriesUrl);
    if ($path === null) {
        return null;
    }
    $data = drtv_get('/page', ['path' => $path, 'item_detail_expand' => 'all', 'max_list_prefetch' => 3]);
    if ($data === null) {
        return null;
    }
    $items = drtv_episode_items($data);
    if (!$items) {
        return ['inserted' => 0, 'total' => 0];
    }

    $now = time();
    $rows = [];
    foreach ($items as $e) {
        $epPath = trim((string) ($e['path'] ?? ''));
        $drId = (int) ($e['id'] ?? 0);
        if ($epPath === '' || $drId === 0) {
            continue;
        }
        $from = trim((string) (($e['customFields'] ?? [])['AvailableFrom'] ?? ''));
        $pub = $from !== '' ? (int) strtotime($from) : 0;
        // Kommende afsnit ville lægge sig øverst i køen som "nyt" uden at kunne ses endnu.
        if ($pub > $now) {
            continue;
        }
        $rows[] = [
            // Deterministisk: samme DRTV-id giver altid samme episode_id, så hørt-tilstand
            // overlever en genindlæsning (samme regel som rss_stable_id for RSS-afsnit).
            'ep' => rss_stable_id('drtv:' . $drId),
            'title' => mb_substr((string) ($e['title'] ?? 'DR TV'), 0, 512),
            'descr' => (string) ($e['shortDescription'] ?? $e['description'] ?? ''),
            'pub' => $pub,
            'link' => DRTV_WEB . $epPath,
            'image' => drtv_image($e['images'] ?? null),
            'dur' => (int) ($e['duration'] ?? 0),
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
            'feed' => $feedId,
            'ep' => $r['ep'],
            'title' => $r['title'],
            'descr' => $r['descr'],
            'pub' => $r['pub'],
            'link' => $r['link'],
            'image' => $r['image'],
            'dur' => $r['dur'],
        ]);
    }

    return ['inserted' => $inserted, 'total' => count($rows)];
}
