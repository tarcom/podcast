<?php

declare(strict_types=1);

// Episode caching + queries. "Lazy refresh on open": opening the app refreshes any favorite
// feed that has gone stale. Since 2026-10-02 HTPC's cron (scraper/tick.py) ALSO refreshes every
// feed every 10 min, so the cache is usually fresh before the app opens — but the app must keep
// working without it, so the on-open refresh stays.

const PODCAST_STALE_SECONDS = 1800;   // refresh a favorite's episodes if older than 30 min
const PODCAST_MAX_REFRESH_PER_CALL = 8; // bound latency: refresh at most N stale feeds per request

/**
 * Refresh episodes for the given feed from Podcast Index into podcast_episodes, then stamp
 * last_fetched on the favorite row. Best-effort: a feed that errors is left with its old cache.
 */
/**
 * RSS er den PRIMÆRE kilde til afsnit; Podcast Index er fallback.
 *
 * Baggrund: PI er en crawler, og den kan både have FORKERTE afsnit (DR's "Ubegribeligt" lå som
 * 60 smagsprøver på 33-40 sek, mens DR's eget feed havde 78 fulde afsnit — 2026-07-28) og være
 * FOR LANGSOM (2026-07-29: "Store Penge" manglede afsnittet fra 28/7, "Børsen investor" og
 * "Sådan investerer jeg" var 7 dage bagud — feedenes eget RSS havde dem hele tiden).
 * Vi læser derfor feedet selv når vi kender dets `feed_url`, og bruger kun PI hvis det fejler.
 */
function podcast_feed_prefers_rss(?string $feedUrl): bool
{
    if (!$feedUrl) {
        return false;
    }
    $scheme = strtolower((string) parse_url($feedUrl, PHP_URL_SCHEME));
    $host = (string) parse_url($feedUrl, PHP_URL_HOST);
    return $host !== '' && in_array($scheme, ['http', 'https'], true);
}

/**
 * Nogle favoritter blev gemt uden feed_url (frontenden sendte den ikke med dengang), og uden
 * den kan vi ikke læse RSS. Hent den fra Podcast Index én gang og gem den på favoritten.
 */
function podcast_backfill_feed_url(array $config, PDO $pdo, string $deviceId, int $feedId): string
{
    $response = podcastindex_request($config, '/podcasts/byfeedid', ['id' => $feedId]);
    $url = trim((string) ($response['feed']['url'] ?? ''));
    if ($url === '') {
        return '';
    }
    $pdo->prepare('UPDATE podcast_favorites SET feed_url = :url WHERE device_id = :dev AND feed_id = :feed')
        ->execute(['url' => $url, 'dev' => $deviceId, 'feed' => $feedId]);
    return $url;
}

/**
 * @return int Antal NYE afsnit lagt i cachen (0 = intet ændret). Bruges af `episodes.refresh`
 *             til at fortælle frontenden om det overhovedet kan betale sig at hente køen igen.
 */
function podcast_refresh_feed(array $config, PDO $pdo, string $deviceId, int $feedId, int $max = 60): int
{
    // Always stamp last_fetched, even on an empty/failed result, so we don't hammer a dead feed
    // on every single load — it just waits for the next stale window.
    $stamp = $pdo->prepare('UPDATE podcast_favorites SET last_fetched = NOW() WHERE device_id = :dev AND feed_id = :feed');
    $stamp->execute(['dev' => $deviceId, 'feed' => $feedId]);

    // Læs feedet selv. Lykkes det, er vi færdige — ellers falder vi tilbage til PI.
    $urlQ = $pdo->prepare('SELECT feed_url, added_via, title FROM podcast_favorites WHERE device_id = :dev AND feed_id = :feed');
    $urlQ->execute(['dev' => $deviceId, 'feed' => $feedId]);
    $fav = $urlQ->fetch() ?: [];
    // Podimo-shows fyldes af HTPC-scraperen (podimo.ingest) — deres feed_url er en HTML-showside,
    // ikke et RSS, og PI kender dem slet ikke. Rør dem ikke.
    if (($fav['added_via'] ?? '') === 'podimo') {
        return 0;
    }
    $feedUrl = trim((string) ($fav['feed_url'] ?? ''));
    // DR TV-serier hentes fra dr-massive-API'et og gemmes som link-out (se drtv.php). Betingelsen
    // hænger på URL'en, ikke på `added_via`, så en serie tilføjet med "indsæt URL" (added_via =
    // 'url') opfører sig som en der er fulgt fra søgningen.
    if (drtv_path_from_url($feedUrl) !== null) {
        $res = drtv_refresh_feed($pdo, $feedId, $feedUrl);
        return $res === null ? 0 : (int) $res['inserted'];
    }
    // Viaplay/TV3 på samme måde (se viaplay.php). Betingelsen hænger også her på URL'en, ikke
    // på `added_via`, så en serie tilføjet med "indsæt URL" opfører sig som en fulgt fra søgningen.
    if (viaplay_path_from_url($feedUrl) !== null) {
        $res = viaplay_refresh_feed($pdo, $feedId, $feedUrl);
        return $res === null ? 0 : (int) $res['inserted'];
    }
    if ($feedUrl === '') {
        $feedUrl = podcast_backfill_feed_url($config, $pdo, $deviceId, $feedId);
    }
    // DR's eget RSS er skåret ned til 40-sek. smagsprøver for de nyeste sæsoner — det fulde
    // afsnit ligger kun i DR Lyd, og lyd-URL'en kunne ikke skaffes derfra (se drpodcast.php).
    // drpodcast.nu genudgiver feedet med de rigtige afsnit, og lyden kommer stadig fra DR selv.
    // Spejlet er en privat tjeneste og kan forsvinde, så `feed_url` på favoritten skiftes ALDRIG:
    // fejler spejlet, falder vi igennem til DR's eget feed nedenfor, præcis som før.
    if (drpodcast_is_dr_feed($feedUrl)) {
        $res = drpodcast_refresh($pdo, $feedId, $feedUrl, (string) ($fav['title'] ?? ''), $max);
        if ($res !== null) {
            return (int) ($res['inserted'] ?? 0) + (int) ($res['removedTeasers'] ?? 0);
        }
    }

    if (podcast_feed_prefers_rss($feedUrl)) {
        $res = rss_refresh_feed($pdo, $feedId, $feedUrl, true, $max);
        if ($res !== null) {
            return (int) ($res['inserted'] ?? 0) + (int) ($res['removedTeasers'] ?? 0);
        }
    }

    $response = podcastindex_request($config, '/episodes/byfeedid', ['id' => $feedId, 'max' => $max]);
    $items = is_array($response['items'] ?? null) ? $response['items'] : null;

    if ($items === null) {
        return 0;
    }

    // Afsnit, cachen allerede kender (typisk fra RSS), beholder deres id. Før indsatte denne
    // fallback ALT igen under Podcast Index' egne id'er, hver gang et feeds RSS en sjælden gang
    // fejlede — så stod afsnittet to gange i køen, og hørte man det ene, var det andet stadig
    // uhørt (Store Penge, Investeringspodcasten, All-In og Børsen investor; ryddet op 2026-11-16
    // med podcast_dedupe_episodes() nedenfor). Samme nøgler som rss_refresh_feed().
    $kendte = $pdo->prepare('SELECT episode_id, title, published_at, audio_url FROM podcast_episodes WHERE feed_id = :f');
    $kendte->execute(['f' => $feedId]);
    $byAudio = [];
    $byTitleDate = [];
    foreach ($kendte->fetchAll() as $r) {
        $a = trim((string) ($r['audio_url'] ?? ''));
        if ($a !== '') {
            $byAudio[$a] = (int) $r['episode_id'];
        }
        $byTitleDate[mb_strtolower(trim((string) $r['title'])) . '|' . (int) $r['published_at']] = (int) $r['episode_id'];
    }

    $upsert = $pdo->prepare(
        'INSERT INTO podcast_episodes
            (feed_id, episode_id, title, description, published_at, audio_url, link_url, image, duration_sec)
         VALUES (:feed, :ep, :title, :descr, :pub, :audio, :link, :image, :dur)
         ON DUPLICATE KEY UPDATE
            title = VALUES(title), description = VALUES(description), published_at = VALUES(published_at),
            audio_url = VALUES(audio_url), link_url = VALUES(link_url), image = VALUES(image),
            duration_sec = VALUES(duration_sec)'
    );

    $inserted = 0;
    foreach ($items as $ep) {
        if (!is_array($ep) || !isset($ep['id'])) {
            continue;
        }
        $audio = trim((string) ($ep['enclosureUrl'] ?? ''));
        $key = mb_strtolower(trim((string) ($ep['title'] ?? ''))) . '|' . (int) ($ep['datePublished'] ?? 0);
        $epId = ($audio !== '' && isset($byAudio[$audio])) ? $byAudio[$audio] : ($byTitleDate[$key] ?? (int) $ep['id']);
        $upsert->execute([
            'feed'  => $feedId,
            'ep'    => $epId,
            'title' => mb_substr((string) ($ep['title'] ?? 'Ukendt episode'), 0, 512),
            'descr' => fit_text((string) ($ep['description'] ?? '')),
            'pub'   => (int) ($ep['datePublished'] ?? 0),
            'audio' => $audio !== '' ? $audio : null,
            'link'  => trim((string) ($ep['link'] ?? '')) ?: null,
            'image' => trim((string) ($ep['image'] ?? '')) ?: null,
            'dur'   => max(0, (int) ($ep['duration'] ?? 0)),
        ]);
        // ON DUPLICATE KEY UPDATE: rowCount() er 1 ved INSERT, 2 ved UPDATE, 0 hvis uændret.
        if ($upsert->rowCount() === 1) {
            $inserted++;
        }
    }

    return $inserted;
}

/**
 * Dubletter: samme feed og samme lyd-URL (og titel) under flere episode_id'er. Opstod, når et feeds
 * RSS en sjælden gang fejlede, og Podcast Index-fallbacken i podcast_refresh_feed() indsatte
 * afsnittene igen under PI's egne id'er (rettet samme dag). Køen viste dem to gange, og hørte man
 * det ene, stod det andet stadig som uhørt — det lignede en app, der ikke var opdateret.
 *
 * Beholder det id, hvis lytte-tilstand er nyest, ellers det laveste (RSS' eget id; PI's id'er er
 * større). Tilstand på de andre id'er flyttes over pr. enhed: den nyeste position vinder, og er
 * afsnittet hørt på et af id'erne, er det hørt. Idempotent; kaldes af HTPC-cron'en (tick.py).
 *
 * @return array{groups:int, removed:int, movedState:int}
 */
function podcast_dedupe_episodes(PDO $pdo): array
{
    $groups = $pdo->query(
        "SELECT feed_id, GROUP_CONCAT(episode_id ORDER BY episode_id) AS ids
         FROM podcast_episodes
         WHERE audio_url IS NOT NULL AND audio_url <> ''
         GROUP BY feed_id, MD5(audio_url)
         HAVING COUNT(*) > 1 AND COUNT(DISTINCT LOWER(TRIM(title))) = 1"
    )->fetchAll();

    $removed = 0;
    $moved = 0;
    foreach ($groups as $g) {
        $feedId = (int) $g['feed_id'];
        $ids = array_map('intval', explode(',', (string) $g['ids']));
        $in = implode(',', $ids); // kun heltal — sikkert at sætte direkte ind
        $states = $pdo->query(
            "SELECT device_id, episode_id, played_at, position_sec, duration_sec, UNIX_TIMESTAMP(updated_at) AS upd
             FROM podcast_episode_state WHERE feed_id = $feedId AND episode_id IN ($in)"
        )->fetchAll();

        $keep = $ids[0];
        $nyeste = -1;
        foreach ($states as $s) {
            if ((int) $s['upd'] > $nyeste) {
                $nyeste = (int) $s['upd'];
                $keep = (int) $s['episode_id'];
            }
        }

        $byDev = [];
        foreach ($states as $s) {
            $byDev[(string) $s['device_id']][(int) $s['episode_id']] = $s;
        }
        foreach ($byDev as $dev => $rows) {
            $newest = null;
            $played = null;
            foreach ($rows as $r) {
                if ($newest === null || (int) $r['upd'] > (int) $newest['upd']) {
                    $newest = $r;
                }
                if ($r['played_at'] !== null && ($played === null || (string) $r['played_at'] > $played)) {
                    $played = (string) $r['played_at'];
                }
            }
            if (!isset($rows[$keep])) {
                $pdo->prepare('UPDATE podcast_episode_state SET episode_id = :keep WHERE device_id = :dev AND episode_id = :ep')
                    ->execute(['keep' => $keep, 'dev' => $dev, 'ep' => (int) $newest['episode_id']]);
                $moved++;
            } elseif ((int) $newest['episode_id'] !== $keep) {
                $pdo->prepare('UPDATE podcast_episode_state SET position_sec = :pos, duration_sec = :dur
                               WHERE device_id = :dev AND episode_id = :keep')
                    ->execute(['pos' => (int) $newest['position_sec'], 'dur' => (int) $newest['duration_sec'], 'dev' => $dev, 'keep' => $keep]);
                $moved++;
            }
            if ($played !== null) {
                $pdo->prepare('UPDATE podcast_episode_state SET played_at = :p WHERE device_id = :dev AND episode_id = :keep AND played_at IS NULL')
                    ->execute(['p' => $played, 'dev' => $dev, 'keep' => $keep]);
            }
        }

        $drop = array_values(array_diff($ids, [$keep]));
        if ($drop) {
            $d = implode(',', $drop);
            $pdo->exec("DELETE FROM podcast_episode_state WHERE feed_id = $feedId AND episode_id IN ($d)");
            $removed += (int) $pdo->exec("DELETE FROM podcast_episodes WHERE feed_id = $feedId AND episode_id IN ($d)");
        }
    }
    return ['groups' => count($groups), 'removed' => $removed, 'movedState' => $moved];
}

/**
 * Refresh any of the device's favorites whose episodes are stale (or never fetched), capped so
 * a first load with many favorites doesn't block — the rest refresh on the following loads.
 *
 * VIGTIGT (2026-08-10): dette kaldes IKKE længere fra `episodes.newest`. Hver stale favorit
 * koster en RSS-hentning over nettet (målt 0,15-0,38 sek. pr. feed), så med loftet på 8 feeds
 * ventede kø-svaret 1-3 sekunder på netværket FØR det sendte den cache vi allerede havde —
 * det var kilden til "Alt er hørt" der blinkede forbi, inden indholdet kom. Refresh'en har nu
 * sit eget endpoint (`episodes.refresh`), som frontenden kalder EFTER den har tegnet cachen.
 *
 * @return array{feeds:int,inserted:int} feeds = antal opdaterede feeds, inserted = nye afsnit.
 */
function podcast_refresh_stale_favorites(array $config, PDO $pdo, string $deviceId, int $staleSeconds = PODCAST_STALE_SECONDS): array
{
    $stmt = $pdo->prepare(
        'SELECT feed_id FROM podcast_favorites
         WHERE device_id = :dev
           AND added_via <> "podimo"
           AND (last_fetched IS NULL OR last_fetched < (NOW() - INTERVAL :stale SECOND))
         ORDER BY last_fetched IS NOT NULL, last_fetched ASC
         LIMIT ' . (int) PODCAST_MAX_REFRESH_PER_CALL
    );
    // note: LIMIT is inlined (int-cast) because MySQL prepared statements can't bind LIMIT params.
    $stmt->bindValue('dev', $deviceId);
    $stmt->bindValue('stale', $staleSeconds, PDO::PARAM_INT);
    $stmt->execute();
    $feedIds = $stmt->fetchAll(PDO::FETCH_COLUMN);

    $inserted = 0;
    foreach ($feedIds as $feedId) {
        $inserted += podcast_refresh_feed($config, $pdo, $deviceId, (int) $feedId);
    }

    return ['feeds' => count($feedIds), 'inserted' => $inserted];
}

/**
 * Episodes across all of the device's favorites, newest first, with per-device played/position state.
 *
 * Køen viser SIDEN 2026-08-21 også de HØRTE afsnit — de bliver liggende på deres kronologiske
 * plads og markeres som hørt i stedet for at forsvinde. Derfor er den gamle `$unheardOnly`-
 * filtrering væk igen.
 *
 * Men payload-lærdommen fra 2026-08-10 holder: `description` er ~49 % af svaret, og de hørte
 * rækker er flertallet (målt 82 af 200). Beskrivelsen sendes derfor **kun for uhørte** afsnit;
 * "læs mere" på et hørt afsnit henter den ved behov via `episode.get` (podcast_episode()).
 */
function podcast_newest_episodes(PDO $pdo, string $deviceId, int $limit = 200): array
{
    $sql =
        'SELECT e.feed_id, e.episode_id, e.title,
                CASE WHEN st.played_at IS NULL THEN e.description ELSE NULL END AS description,
                e.published_at, e.audio_url,
                e.link_url, e.image, e.duration_sec,
                f.title AS podcast_title, f.image AS podcast_image,
                st.played_at, st.position_sec, st.updated_at
         FROM podcast_episodes e
         JOIN podcast_favorites f ON f.feed_id = e.feed_id AND f.device_id = :dev
         LEFT JOIN podcast_episode_state st ON st.device_id = :dev AND st.episode_id = e.episode_id
         ORDER BY e.published_at DESC
         LIMIT ' . (int) $limit;

    $stmt = $pdo->prepare($sql);
    $stmt->bindValue('dev', $deviceId);
    $stmt->execute();
    return $stmt->fetchAll();
}

/**
 * Ét afsnits beskrivelse (PK-opslag på feed_id+episode_id).
 * Findes fordi køen udelader beskrivelsen på hørte afsnit, se ovenfor.
 */
function podcast_episode(PDO $pdo, int $feedId, int $episodeId): ?array
{
    $stmt = $pdo->prepare(
        'SELECT feed_id, episode_id, description FROM podcast_episodes
         WHERE feed_id = :feed AND episode_id = :ep LIMIT 1'
    );
    $stmt->bindValue('feed', $feedId, PDO::PARAM_INT);
    $stmt->bindValue('ep', $episodeId, PDO::PARAM_INT);
    $stmt->execute();
    $row = $stmt->fetch();
    return $row ?: null;
}

/** Episodes for a single feed, newest first, with state. Refreshes that feed if stale. */
function podcast_feed_episodes(array $config, PDO $pdo, string $deviceId, int $feedId): array
{
    $chk = $pdo->prepare(
        'SELECT (last_fetched IS NULL OR last_fetched < (NOW() - INTERVAL :stale SECOND)) AS stale
         FROM podcast_favorites WHERE device_id = :dev AND feed_id = :feed'
    );
    $chk->bindValue('stale', PODCAST_STALE_SECONDS, PDO::PARAM_INT);
    $chk->bindValue('dev', $deviceId);
    $chk->bindValue('feed', $feedId, PDO::PARAM_INT);
    $chk->execute();
    $row = $chk->fetch();

    // Favorited + stale → refresh. Not favorited → still fetch live (so you can preview a
    // podcast's episodes before starring it), but don't persist state joins.
    if ($row && (int) $row['stale'] === 1) {
        podcast_refresh_feed($config, $pdo, $deviceId, $feedId);
    }

    $stmt = $pdo->prepare(
        'SELECT e.feed_id, e.episode_id, e.title, e.description, e.published_at, e.audio_url,
                e.link_url, e.image, e.duration_sec,
                st.played_at, st.position_sec, st.updated_at
         FROM podcast_episodes e
         LEFT JOIN podcast_episode_state st ON st.device_id = :dev AND st.episode_id = e.episode_id
         WHERE e.feed_id = :feed
         ORDER BY e.published_at DESC
         LIMIT 200'
    );
    $stmt->bindValue('dev', $deviceId);
    $stmt->bindValue('feed', $feedId, PDO::PARAM_INT);
    $stmt->execute();
    return $stmt->fetchAll();
}
