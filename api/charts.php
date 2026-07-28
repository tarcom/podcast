<?php

declare(strict_types=1);

/**
 * Popularitet via Apples danske hitlister (RSS Marketing Tools).
 *
 * Hvorfor Apple: ægte downloadtal er private hos hosting-udbyderen og findes INTET
 * offentligt sted. Podcast Index har heller ingen popularitetsfelter (`priority` er
 * crawl-prioritet, ikke popularitet). Apples lister er gratis, kræver ingen nøgle og
 * er danske — derfor det bedste tilgængelige signal.
 *
 * To lister:
 *   - "Top Shows"        (50 podcasts)  -> rang pr. podcast
 *   - "Trending Episodes" (25 afsnit)   -> rang pr. afsnit
 *
 * Begge caches i DB (Apple opdaterer ~dagligt, så vi henter højst hver 6. time).
 */

const CHART_TTL_SECONDS = 21600; // 6 timer
const CHART_SHOWS_URL = 'https://rss.marketingtools.apple.com/api/v2/dk/podcasts/top/50/podcasts.json';
const CHART_EPISODES_URL = 'https://rss.marketingtools.apple.com/api/v2/dk/podcasts/top/25/podcast-episodes.json';

/**
 * Normalisér en titel så Apples skrivemåde kan matches mod vores feed-titler.
 * Fjerner emoji/tegnsætning, folder accenter og trimmer whitespace.
 */
function chart_norm(string $s): string
{
    $s = mb_strtolower(trim($s), 'UTF-8');
    // æøå -> ae/oe/aa er IKKE ønsket (begge sider er danske); fjern blot tegn der støjer
    $s = preg_replace('~[\x{1F000}-\x{1FFFF}\x{2600}-\x{27BF}\x{FE0F}]~u', '', $s) ?? $s;
    $s = preg_replace('~[^\p{L}\p{N}\s]+~u', ' ', $s) ?? $s;
    $s = preg_replace('~\s+~u', ' ', $s) ?? $s;
    return trim($s);
}

function chart_fetch_json(string $url): ?array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTPHEADER => ['User-Agent: AllDKPodcasts/1.0 (+https://aogj.com/podcast)'],
    ]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false || $code !== 200) {
        return null;
    }
    $d = json_decode((string) $raw, true);
    return is_array($d) ? $d : null;
}

/** Hent friske lister fra Apple og pak dem til vores eget format. */
function chart_build(): array
{
    $out = ['shows' => [], 'episodes' => [], 'updatedAt' => gmdate('c')];

    $shows = chart_fetch_json(CHART_SHOWS_URL);
    foreach ($shows['feed']['results'] ?? [] as $i => $r) {
        $out['shows'][] = [
            'rank' => $i + 1,
            'name' => (string) ($r['name'] ?? ''),
            'artist' => (string) ($r['artistName'] ?? ''),
            'itunesId' => (string) ($r['id'] ?? ''),
            'artwork' => (string) ($r['artworkUrl100'] ?? ''),
            'url' => (string) ($r['url'] ?? ''),
            'norm' => chart_norm((string) ($r['name'] ?? '')),
        ];
    }

    $eps = chart_fetch_json(CHART_EPISODES_URL);
    foreach ($eps['feed']['results'] ?? [] as $i => $r) {
        $out['episodes'][] = [
            'rank' => $i + 1,
            'name' => (string) ($r['name'] ?? ''),
            'artist' => (string) ($r['artistName'] ?? ''),
            'artwork' => (string) ($r['artworkUrl100'] ?? ''),
            'norm' => chart_norm((string) ($r['name'] ?? '')),
        ];
    }

    return $out;
}

/**
 * Cachet udgave. Returnerer altid noget brugbart: hvis Apple er nede og cachen er
 * forældet, serveres den gamle cache hellere end ingenting.
 */
function chart_get(PDO $pdo, bool $force = false): array
{
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS podcast_chart_cache (
            kind VARCHAR(32) NOT NULL PRIMARY KEY,
            payload MEDIUMTEXT NOT NULL,
            fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );

    $row = null;
    $stmt = $pdo->prepare(
        'SELECT payload, UNIX_TIMESTAMP(fetched_at) AS ts FROM podcast_chart_cache WHERE kind = :k'
    );
    $stmt->execute(['k' => 'dk']);
    $row = $stmt->fetch();

    $age = $row ? (time() - (int) $row['ts']) : PHP_INT_MAX;
    if (!$force && $row && $age < CHART_TTL_SECONDS) {
        $cached = json_decode((string) $row['payload'], true);
        if (is_array($cached)) {
            $cached['cached'] = true;
            $cached['ageSec'] = $age;
            return $cached;
        }
    }

    $fresh = chart_build();
    if (!$fresh['shows'] && !$fresh['episodes']) {
        // Apple svarede ikke — behold den gamle cache frem for at vise ingenting
        if ($row) {
            $cached = json_decode((string) $row['payload'], true);
            if (is_array($cached)) {
                $cached['cached'] = true;
                $cached['stale'] = true;
                $cached['ageSec'] = $age;
                return $cached;
            }
        }
        return ['shows' => [], 'episodes' => [], 'error' => 'chart source unavailable'];
    }

    $ins = $pdo->prepare(
        'INSERT INTO podcast_chart_cache (kind, payload) VALUES (:k, :p)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = CURRENT_TIMESTAMP'
    );
    $ins->execute(['k' => 'dk', 'p' => json_encode($fresh, JSON_UNESCAPED_UNICODE)]);

    $fresh['cached'] = false;
    $fresh['ageSec'] = 0;
    return $fresh;
}
