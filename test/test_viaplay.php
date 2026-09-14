<?php

declare(strict_types=1);

/**
 * Test af Viaplay-integrationen — mod en engangsbase, ikke mod aogj.com.
 *
 * Kør: php test/test_viaplay.php
 */

require __DIR__ . '/../api/rssfeed.php';
require __DIR__ . '/../api/charts.php';
require __DIR__ . '/../api/viaplay.php';

$fejl = 0;
function kraev(bool $ok, string $besked): void
{
    global $fejl;
    if ($ok) {
        echo "  ok: $besked\n";
    } else {
        echo "  FEJL: $besked\n";
        $fejl++;
    }
}

echo "1) URL-genkendelse — serie, sæson og afsnit skal give SAMME serie-sti\n";
$forventet = '/serier/robinson-ekspeditionen';
foreach ([
    'https://viaplay.dk/serier/robinson-ekspeditionen',
    'https://viaplay.dk/serier/robinson-ekspeditionen/saeson-27',
    'https://viaplay.dk/serier/robinson-ekspeditionen/saeson-27/afsnit-4',
    'https://www.viaplay.dk/serier/robinson-ekspeditionen/saeson-27/afsnit-4',
    'https://content.viaplay.dk/pc-dk/serier/robinson-ekspeditionen/saeson-27/afsnit-1',
] as $u) {
    kraev(viaplay_path_from_url($u) === $forventet, "$u -> $forventet");
}
kraev(viaplay_path_from_url('https://www.dr.dk/drtv/serie/deadline_7111') === null,
      'en DR TV-URL genkendes IKKE som Viaplay');
kraev(viaplay_path_from_url('https://api.dr.dk/podcasts/v1/feeds/genstart.xml') === null,
      'et RSS-feed genkendes IKKE som Viaplay');
kraev(viaplay_path_from_url('https://viaplay.dk/film/noget-2020') === null,
      'en film genkendes IKKE som en serie');

echo "\n2) Feed-id'et er negativt, stabilt og kolliderer ikke med DR TV\n";
$id = viaplay_feed_id($forventet);
kraev($id < 0, "id er negativt ($id) og kan ikke kollidere med Podcast Index");
kraev($id === viaplay_feed_id($forventet), 'samme sti giver samme id');
require_once __DIR__ . '/../api/drtv.php';
kraev($id !== drtv_feed_id($forventet), 'samme sti hos DR TV giver et ANDET id');

echo "\n3) Søgning\n";
$hits = viaplay_search('robinson ekspeditionen');
kraev(count($hits) >= 1, sprintf('"robinson ekspeditionen" gav %d serie(r)', count($hits)));
if ($hits) {
    $f = $hits[0];
    printf("     -> %s | %s | %s\n", $f['title'], $f['url'], mb_substr($f['description'], 0, 50));
    kraev($f['kind'] === 'tv', 'mærket som TV');
    kraev(str_starts_with((string) $f['url'], 'https://viaplay.dk/serier/'), 'peger på viaplay.dk');
    kraev(trim((string) $f['image']) !== '', 'har et billede');
    kraev(trim((string) $f['description']) !== '', 'har en beskrivelse');
}
$stoej = viaplay_search('robinson');
$titler = array_map(static fn(array $f): string => $f['title'], $stoej);
kraev(!in_array('Dexter', $titler, true) && !in_array('Loud House, The', $titler, true),
      'det løse søgeresultat er filtreret fra (' . (implode(', ', $titler) ?: 'intet') . ')');

echo "\n4) Tilføj via URL\n";
$serie = viaplay_series_by_path($forventet);
kraev($serie !== null, 'serien kan slås op på sin sti');
if ($serie && $hits) {
    kraev($serie['id'] === $hits[0]['id'],
          'URL og søgning giver SAMME feed-id (ellers ville serien kunne følges to gange)');
}

echo "\n5) Afsnit hentes ind som link-out\n";
$pdo = new PDO('mysql:host=127.0.0.1;dbname=podcast_toer;charset=utf8mb4', 'podtest', 'podtest', [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);
$pdo->exec('DROP TABLE IF EXISTS podcast_episodes');
$pdo->exec(
    'CREATE TABLE podcast_episodes (
        feed_id BIGINT NOT NULL, episode_id BIGINT NOT NULL,
        title VARCHAR(512) NOT NULL, description MEDIUMTEXT NULL,
        published_at BIGINT NOT NULL DEFAULT 0, audio_url TEXT NULL, link_url TEXT NULL,
        image TEXT NULL, duration_sec INT NOT NULL DEFAULT 0,
        PRIMARY KEY (feed_id, episode_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
);

$res = viaplay_refresh_feed($pdo, $id, VIAPLAY_WEB . $forventet);
kraev($res !== null, 'Viaplay svarede');
if ($res === null) {
    exit(1);
}
printf("     %d afsnit hentet (%d nye)\n", (int) $res['total'], (int) $res['inserted']);

$q = $pdo->prepare('SELECT * FROM podcast_episodes WHERE feed_id = :f ORDER BY published_at DESC');
$q->execute(['f' => $id]);
$rows = $q->fetchAll();
kraev(count($rows) >= 4, sprintf('mindst fire afsnit i basen (%d)', count($rows)));
foreach ($rows as $r) {
    printf("     %s  %-34s %5d min  %s\n",
           gmdate('Y-m-d H:i', (int) $r['published_at']),
           mb_substr((string) $r['title'], 0, 34),
           (int) round(((int) $r['duration_sec']) / 60),
           (string) $r['link_url']);
}
kraev(!array_filter($rows, static fn(array $r): bool => trim((string) ($r['audio_url'] ?? '')) !== ''),
      'INTET afsnit har audio_url — de er link-out, ikke afspillelige');
kraev(!array_filter($rows, static fn(array $r): bool => trim((string) ($r['link_url'] ?? '')) === ''),
      'alle afsnit har et link at åbne');
kraev(!array_filter($rows, static fn(array $r): bool => (int) $r['published_at'] > time()),
      'ingen kommende afsnit er sluppet med ind');
kraev(!array_filter($rows, static fn(array $r): bool => (int) $r['duration_sec'] <= 0),
      'alle afsnit har en varighed');
kraev(!array_filter($rows, static fn(array $r): bool => !str_contains((string) $r['link_url'], '/robinson-ekspeditionen/')),
      'ingen afsnit fra "Lignende serier" er sluppet med ind');

echo "\n6) Kørsel nummer to må ikke give nye id'er (hørt-tilstand)\n";
$res2 = viaplay_refresh_feed($pdo, $id, VIAPLAY_WEB . $forventet);
kraev($res2 !== null && (int) $res2['inserted'] === 0,
      sprintf('anden kørsel gav %d nye afsnit', (int) ($res2['inserted'] ?? -1)));
$q->execute(['f' => $id]);
kraev(count($q->fetchAll()) === count($rows), 'samme antal rækker som før');

echo "\n";
if ($fejl) {
    printf("%d fejl.\n", $fejl);
    exit(1);
}
echo "Alle kontroller bestået.\n";
