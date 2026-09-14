<?php

declare(strict_types=1);

/**
 * Tørkørsel af skiftet til drpodcast.nu — mod en engangsdatabase, ikke mod aogj.com.
 *
 * Basen seedes med en TRO KOPI af produktionens cache (hentet med hent_produktion.py: de rigtige
 * episode_id'er, titler, datoer, lyd-URL'er og varigheder for Allans seks DR-favoritter). Så
 * køres den nye kode, og til sidst simuleres `dr.ingest`'s egen oprydning, som den hourly
 * scrape_dr.py udfører bagefter.
 *
 * Det der skal bevises:
 *   1. Ingen afspillelige afsnit mister sit episode_id — id'et bærer hørt-tilstand og position.
 *   2. Antallet af afspillelige afsnit stiger (det er hele formålet).
 *   3. Link-out-rækkerne forsvinder igen, så der ikke står dubletter tilbage.
 *
 * Kør (kræver en tom MariaDB-base og php-cli — begge findes på HTPC):
 *   python3 test/hent_produktion.py          # henter produktionens cache til /tmp/produktion.json
 *   php test/toerkoersel_drpodcast.php
 */

require __DIR__ . '/../api/rssfeed.php';
require __DIR__ . '/../api/charts.php';
require __DIR__ . '/../api/drpodcast.php';

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

$prod = json_decode((string) file_get_contents('/tmp/produktion.json'), true);
if (!is_array($prod)) {
    exit("kunne ikke læse /tmp/produktion.json — kør hent_produktion.py først\n");
}

/** Tæl rækker i en feed: [i alt, afspillelige, link-out]. */
function tael(PDO $pdo, int $feedId): array
{
    $q = $pdo->prepare(
        'SELECT COUNT(*) AS n,
                SUM(audio_url IS NOT NULL AND audio_url <> "") AS lyd
         FROM podcast_episodes WHERE feed_id = :f'
    );
    $q->execute(['f' => $feedId]);
    $r = $q->fetch();
    return [(int) $r['n'], (int) $r['lyd'], (int) $r['n'] - (int) $r['lyd']];
}

$fejl = 0;

foreach ($prod as $show) {
    $feedId = (int) $show['feed_id'];
    $titel = (string) $show['title'];

    // --- Seed: produktionens cache, række for række ---------------------
    $pdo->prepare('DELETE FROM podcast_episodes WHERE feed_id = :f')->execute(['f' => $feedId]);
    $ins = $pdo->prepare(
        'INSERT INTO podcast_episodes (feed_id, episode_id, title, description, published_at,
                                       audio_url, link_url, image, duration_sec)
         VALUES (:f, :e, :t, "", :p, :a, :l, NULL, :d)'
    );
    // Kun RIGTIGE afsnit. Smagsprøverne (<= 2 min) SKAL forsvinde — de bliver erstattet af
    // de fulde afsnit, og at de mister deres id er formålet, ikke en fejl.
    $foerAfspillelige = [];   // episode_id => titel, kun rigtige afsnit med lyd
    foreach ($show['episodes'] as $e) {
        $audio = trim((string) ($e['audio_url'] ?? ''));
        $ins->execute([
            'f' => $feedId, 'e' => (int) $e['episode_id'],
            't' => mb_substr((string) $e['title'], 0, 512),
            'p' => (int) $e['published_at'],
            'a' => $audio !== '' ? $audio : null,
            'l' => trim((string) ($e['link_url'] ?? '')) ?: null,
            'd' => (int) $e['duration_sec'],
        ]);
        $varighed = (int) $e['duration_sec'];
        if ($audio !== '' && ($varighed === 0 || $varighed > RSS_TEASER_MAX_SEC)) {
            $foerAfspillelige[(int) $e['episode_id']] = (string) $e['title'];
        }
    }
    [$n0, $lyd0, $link0] = tael($pdo, $feedId);

    // --- Kør den nye vej ------------------------------------------------
    $res = drpodcast_refresh($pdo, $feedId, (string) $show['feed_url'], $titel);
    if ($res === null) {
        printf("%-28s  SPEJLET KUNNE IKKE BRUGES — falder tilbage til DR's eget feed\n", $titel);
        $fejl++;
        continue;
    }
    [$n1, $lyd1, $link1] = tael($pdo, $feedId);

    // --- Simulér dr.ingest's oprydning (hourly scrape_dr.py) -------------
    $dage = [];
    $q = $pdo->prepare('SELECT published_at FROM podcast_episodes
                        WHERE feed_id = :f AND audio_url IS NOT NULL AND audio_url <> ""');
    $q->execute(['f' => $feedId]);
    foreach ($q->fetchAll() as $r) {
        $dage[gmdate('Y-m-d', (int) $r['published_at'])] = true;
    }
    $del = $pdo->prepare('DELETE FROM podcast_episodes WHERE feed_id = :f AND episode_id = :e');
    $q = $pdo->prepare('SELECT episode_id, published_at FROM podcast_episodes
                        WHERE feed_id = :f AND (audio_url IS NULL OR audio_url = "")');
    $q->execute(['f' => $feedId]);
    $ryddet = 0;
    foreach ($q->fetchAll() as $r) {
        if (isset($dage[gmdate('Y-m-d', (int) $r['published_at'])])) {
            $del->execute(['f' => $feedId, 'e' => (int) $r['episode_id']]);
            $ryddet++;
        }
    }
    [$n2, $lyd2, $link2] = tael($pdo, $feedId);

    // --- Krav 1: intet AFSPILLELIGT afsnit må miste sit id ---------------
    $q = $pdo->prepare('SELECT episode_id FROM podcast_episodes WHERE feed_id = :f');
    $q->execute(['f' => $feedId]);
    $tilbage = array_flip(array_map('intval', array_column($q->fetchAll(), 'episode_id')));
    $mistede = [];
    foreach ($foerAfspillelige as $id => $t) {
        if (!isset($tilbage[$id])) {
            $mistede[$id] = $t;
        }
    }

    printf("\n== %s (feed %d)\n", $titel, $feedId);
    printf("   før:            %4d rækker  (%d afspillelige, %d link-out)\n", $n0, $lyd0, $link0);
    printf("   efter spejlet:  %4d rækker  (%d afspillelige, %d link-out)   genbrugt %d id'er, %d nye, %d teasere fjernet\n",
           $n1, $lyd1, $link1, (int) $res['reused'], (int) $res['inserted'], (int) $res['removedTeasers']);
    printf("   efter oprydning:%4d rækker  (%d afspillelige, %d link-out)   %d link-out ryddet\n",
           $n2, $lyd2, $link2, $ryddet);
    printf("   AFSPILLELIGE:   %d -> %d  (%+d)\n", $lyd0, $lyd2, $lyd2 - $lyd0);

    if ($mistede) {
        printf("   FEJL: %d afspillelige afsnit mistede sit episode_id:\n", count($mistede));
        foreach (array_slice($mistede, 0, 5, true) as $id => $t) {
            printf("         %d  %s\n", $id, mb_substr($t, 0, 60));
        }
        $fejl++;
    } else {
        printf("   ok: alle %d afspillelige afsnit beholdt sit episode_id\n", count($foerAfspillelige));
    }
    if ($lyd2 < $lyd0) {
        printf("   FEJL: færre afspillelige afsnit end før\n");
        $fejl++;
    }
    if ($link2 > $link0) {
        printf("   FEJL: flere link-out-rækker end før — der står dubletter tilbage\n");
        $fejl++;
    }
}

echo "\n";
if ($fejl) {
    printf("%d problem(er). Skiftet er ikke sikkert endnu.\n", $fejl);
    exit(1);
}
echo "Alle seks shows: ingen mistet hørt-tilstand, flere afspillelige afsnit, ingen dubletter tilbage.\n";
