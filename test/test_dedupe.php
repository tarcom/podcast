<?php

declare(strict_types=1);

/**
 * Test af podcast_dedupe_episodes() — mod engangsbasen podcast_toer på HTPC, ikke mod aogj.com.
 * Se CLAUDE.md (afsnittet om drpodcast.nu) for hvordan basen oprettes.
 *
 * Kør: php test/test_dedupe.php
 *
 * Dubletterne opstod, når et feeds RSS fejlede, og Podcast Index-fallbacken indsatte afsnittene
 * igen under PI's egne id'er. Testen lægger det samme mønster ind og kræver, at der kun er ét
 * afsnit tilbage pr. lyd-URL, at intet hørt-mærke eller nogen lytteposition går tabt, og at
 * afsnit med samme lyd men forskellig titel IKKE smeltes sammen.
 */

// Kun funktionerne; podcast_dedupe_episodes() bruger ikke andet end PDO.
require __DIR__ . '/../api/podcast_store.php';

$fejl = 0;
function kraev(bool $ok, string $besked): void
{
    global $fejl;
    echo ($ok ? '  ok: ' : '  FEJL: ') . $besked . "\n";
    if (!$ok) {
        $fejl++;
    }
}

$pdo = new PDO('mysql:host=127.0.0.1;dbname=podcast_toer;charset=utf8mb4', 'podtest', 'podtest', [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);
// Kommentarer og COMMENT-tekster i schema.sql indeholder semikoloner — fjern kommentarlinjerne
// og del kun på semikoloner sidst på en linje.
$schema = (string) preg_replace('/^\s*--.*$/m', '', (string) file_get_contents(__DIR__ . '/../database/schema.sql'));
foreach (array_filter(array_map('trim', preg_split('/;\s*$/m', $schema))) as $sql) {
    if (stripos($sql, 'CREATE TABLE') !== false) {
        $pdo->exec($sql);
    }
}

$FEED = 990001;
$pdo->exec("DELETE FROM podcast_episodes WHERE feed_id = $FEED");
$pdo->exec("DELETE FROM podcast_episode_state WHERE feed_id = $FEED");

$ep = $pdo->prepare('INSERT INTO podcast_episodes (feed_id, episode_id, title, published_at, audio_url, duration_sec)
                     VALUES (:f, :e, :t, :p, :a, 1800)');
$st = $pdo->prepare('INSERT INTO podcast_episode_state (device_id, episode_id, feed_id, played_at, position_sec, duration_sec, updated_at)
                     VALUES (:d, :e, :f, :pl, :pos, 1800, FROM_UNIXTIME(:u))');
$nu = time();

// A: RSS-id (lille) med position, PI-kopi (stor) uden tilstand -> RSS beholdes med positionen
$ep->execute(['f' => $FEED, 'e' => 101, 't' => 'Afsnit A', 'p' => 1000, 'a' => 'https://x.test/a.mp3']);
$ep->execute(['f' => $FEED, 'e' => 63000000101, 't' => 'Afsnit A', 'p' => 1000, 'a' => 'https://x.test/a.mp3']);
$st->execute(['d' => 'allan-main', 'e' => 101, 'f' => $FEED, 'pl' => null, 'pos' => 1533, 'u' => $nu - 100]);

// B: begge hørt (sådan som Allan markerede "Anthropic på børsen" to gange) -> ét, stadig hørt
$ep->execute(['f' => $FEED, 'e' => 102, 't' => 'Afsnit B', 'p' => 2000, 'a' => 'https://x.test/b.mp3']);
$ep->execute(['f' => $FEED, 'e' => 63000000102, 't' => 'Afsnit B', 'p' => 2000, 'a' => 'https://x.test/b.mp3']);
$st->execute(['d' => 'allan-main', 'e' => 102, 'f' => $FEED, 'pl' => '2026-11-16 12:06:35', 'pos' => 0, 'u' => $nu - 50]);
$st->execute(['d' => 'allan-main', 'e' => 63000000102, 'f' => $FEED, 'pl' => '2026-11-16 12:06:23', 'pos' => 0, 'u' => $nu - 60]);

// C: kun PI-kopien har tilstand (nyest) -> den beholdes
$ep->execute(['f' => $FEED, 'e' => 103, 't' => 'Afsnit C', 'p' => 3000, 'a' => 'https://x.test/c.mp3']);
$ep->execute(['f' => $FEED, 'e' => 63000000103, 't' => 'Afsnit C', 'p' => 3000, 'a' => 'https://x.test/c.mp3']);
$st->execute(['d' => 'allan-main', 'e' => 63000000103, 'f' => $FEED, 'pl' => null, 'pos' => 600, 'u' => $nu - 10]);

// D: hørt på den ene, nyere position på den anden -> hørt OG nyeste position, på ét id
$ep->execute(['f' => $FEED, 'e' => 104, 't' => 'Afsnit D', 'p' => 4000, 'a' => 'https://x.test/d.mp3']);
$ep->execute(['f' => $FEED, 'e' => 63000000104, 't' => 'Afsnit D', 'p' => 4000, 'a' => 'https://x.test/d.mp3']);
$st->execute(['d' => 'allan-main', 'e' => 104, 'f' => $FEED, 'pl' => '2026-11-01 10:00:00', 'pos' => 100, 'u' => $nu - 5000]);
$st->execute(['d' => 'allan-main', 'e' => 63000000104, 'f' => $FEED, 'pl' => null, 'pos' => 900, 'u' => $nu - 20]);

// E: samme lyd, FORSKELLIG titel (genudsendelse) -> rør ikke
$ep->execute(['f' => $FEED, 'e' => 105, 't' => 'Afsnit E', 'p' => 5000, 'a' => 'https://x.test/e.mp3']);
$ep->execute(['f' => $FEED, 'e' => 106, 't' => 'Afsnit E (genudsendelse)', 'p' => 6000, 'a' => 'https://x.test/e.mp3']);

$res = podcast_dedupe_episodes($pdo);
echo json_encode($res) . "\n";
kraev($res['removed'] === 4, "fjernede 4 dubletter (fik {$res['removed']})");

$rows = $pdo->query("SELECT episode_id, title FROM podcast_episodes WHERE feed_id = $FEED ORDER BY title")->fetchAll();
$byTitle = [];
foreach ($rows as $r) {
    $byTitle[$r['title']][] = (int) $r['episode_id'];
}
foreach (['Afsnit A', 'Afsnit B', 'Afsnit C', 'Afsnit D'] as $t) {
    kraev(count($byTitle[$t] ?? []) === 1, "$t står én gang");
}
kraev(count($byTitle['Afsnit E'] ?? []) === 1 && count($byTitle['Afsnit E (genudsendelse)'] ?? []) === 1,
      'samme lyd med forskellig titel er IKKE smeltet sammen');

$state = function (string $titel) use ($pdo, $FEED, $byTitle): ?array {
    $id = $byTitle[$titel][0];
    $q = $pdo->prepare('SELECT played_at, position_sec FROM podcast_episode_state WHERE device_id = "allan-main" AND feed_id = :f AND episode_id = :e');
    $q->execute(['f' => $FEED, 'e' => $id]);
    return $q->fetch() ?: null;
};
kraev($byTitle['Afsnit A'][0] === 101, 'A: RSS-id\'et (med tilstand) er beholdt');
kraev(($state('Afsnit A')['position_sec'] ?? 0) == 1533, 'A: positionen er bevaret');
kraev(($state('Afsnit B')['played_at'] ?? null) !== null, 'B: stadig hørt');
kraev($byTitle['Afsnit C'][0] === 63000000103 && ($state('Afsnit C')['position_sec'] ?? 0) == 600,
      'C: kopien med den nyeste tilstand er beholdt med sin position');
$d = $state('Afsnit D');
kraev($d !== null && $d['played_at'] !== null && (int) $d['position_sec'] === 900, 'D: hørt OG den nyeste position');
$tilbage = (int) $pdo->query("SELECT COUNT(*) FROM podcast_episode_state WHERE feed_id = $FEED")->fetchColumn();
kraev($tilbage === 4, "ingen forældreløse tilstande (4 rækker, fik $tilbage)");

$igen = podcast_dedupe_episodes($pdo);
kraev($igen['removed'] === 0, 'anden kørsel ændrer intet');

$pdo->exec("DELETE FROM podcast_episodes WHERE feed_id = $FEED");
$pdo->exec("DELETE FROM podcast_episode_state WHERE feed_id = $FEED");
echo $fejl ? "\n$fejl FEJL\n" : "\nAlt ok\n";
exit($fejl ? 1 : 0);
