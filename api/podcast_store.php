<?php

declare(strict_types=1);

// Episode caching + queries. Keeps the "lazy refresh on open" model: no cron needed
// (the host has none guaranteed) — opening the app refreshes any favorite feed that has gone
// stale, so "what's new" stays current without a background job. Single-user, few favorites,
// so refreshing inline on load is cheap.

const PODCAST_STALE_SECONDS = 1800;   // refresh a favorite's episodes if older than 30 min
const PODCAST_MAX_REFRESH_PER_CALL = 8; // bound latency: refresh at most N stale feeds per request

/**
 * Refresh episodes for the given feed from Podcast Index into podcast_episodes, then stamp
 * last_fetched on the favorite row. Best-effort: a feed that errors is left with its old cache.
 */
/**
 * Feeds hvor vi læser RSS'et DIREKTE i stedet for at stole på Podcast Index' afsnitsdata.
 * DR blev tilføjet fordi PI havde 60 smagsprøver (33-40 sek) cachet for "Ubegribeligt",
 * mens DR's eget feed indeholdt 78 rigtige, fulde afsnit. Matches mod feed_url'ens host.
 */
const PODCAST_DIRECT_RSS_HOSTS = ['api.dr.dk', 'www.dr.dk', 'dr.dk'];

function podcast_feed_prefers_rss(?string $feedUrl): bool
{
    if (!$feedUrl) {
        return false;
    }
    $host = strtolower((string) parse_url($feedUrl, PHP_URL_HOST));
    return $host !== '' && in_array($host, PODCAST_DIRECT_RSS_HOSTS, true);
}

function podcast_refresh_feed(array $config, PDO $pdo, string $deviceId, int $feedId, int $max = 60): void
{
    // Always stamp last_fetched, even on an empty/failed result, so we don't hammer a dead feed
    // on every single load — it just waits for the next stale window.
    $stamp = $pdo->prepare('UPDATE podcast_favorites SET last_fetched = NOW() WHERE device_id = :dev AND feed_id = :feed');
    $stamp->execute(['dev' => $deviceId, 'feed' => $feedId]);

    // DR m.fl.: læs feedet selv. Lykkes det, er vi færdige — ellers falder vi tilbage til PI.
    $urlQ = $pdo->prepare('SELECT feed_url FROM podcast_favorites WHERE device_id = :dev AND feed_id = :feed');
    $urlQ->execute(['dev' => $deviceId, 'feed' => $feedId]);
    $feedUrl = (string) ($urlQ->fetchColumn() ?: '');
    if (podcast_feed_prefers_rss($feedUrl) && rss_refresh_feed($pdo, $feedId, $feedUrl) !== null) {
        return;
    }

    $response = podcastindex_request($config, '/episodes/byfeedid', ['id' => $feedId, 'max' => $max]);
    $items = is_array($response['items'] ?? null) ? $response['items'] : null;

    if ($items === null) {
        return;
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

    foreach ($items as $ep) {
        if (!is_array($ep) || !isset($ep['id'])) {
            continue;
        }
        $audio = trim((string) ($ep['enclosureUrl'] ?? ''));
        $upsert->execute([
            'feed'  => $feedId,
            'ep'    => (int) $ep['id'],
            'title' => mb_substr((string) ($ep['title'] ?? 'Ukendt episode'), 0, 512),
            'descr' => (string) ($ep['description'] ?? ''),
            'pub'   => (int) ($ep['datePublished'] ?? 0),
            'audio' => $audio !== '' ? $audio : null,
            'link'  => trim((string) ($ep['link'] ?? '')) ?: null,
            'image' => trim((string) ($ep['image'] ?? '')) ?: null,
            'dur'   => max(0, (int) ($ep['duration'] ?? 0)),
        ]);
    }
}

/**
 * Refresh any of the device's favorites whose episodes are stale (or never fetched), capped so
 * a first load with many favorites doesn't block — the rest refresh on the following loads.
 */
function podcast_refresh_stale_favorites(array $config, PDO $pdo, string $deviceId): void
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
    $stmt->bindValue('stale', PODCAST_STALE_SECONDS, PDO::PARAM_INT);
    $stmt->execute();
    $feedIds = $stmt->fetchAll(PDO::FETCH_COLUMN);

    foreach ($feedIds as $feedId) {
        podcast_refresh_feed($config, $pdo, $deviceId, (int) $feedId);
    }
}

/** Episodes across all of the device's favorites, newest first, with per-device played/position state. */
function podcast_newest_episodes(PDO $pdo, string $deviceId, int $limit = 200): array
{
    $stmt = $pdo->prepare(
        'SELECT e.feed_id, e.episode_id, e.title, e.description, e.published_at, e.audio_url,
                e.link_url, e.image, e.duration_sec,
                f.title AS podcast_title, f.image AS podcast_image,
                st.played_at, st.position_sec, st.updated_at
         FROM podcast_episodes e
         JOIN podcast_favorites f ON f.feed_id = e.feed_id AND f.device_id = :dev
         LEFT JOIN podcast_episode_state st ON st.device_id = :dev AND st.episode_id = e.episode_id
         ORDER BY e.published_at DESC
         LIMIT ' . (int) $limit
    );
    $stmt->bindValue('dev', $deviceId);
    $stmt->execute();
    return $stmt->fetchAll();
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
