<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/db.php';
require __DIR__ . '/podcastindex.php';
require __DIR__ . '/podcast_store.php';

$action = $_GET['action'] ?? 'health';
$method = strtoupper($_SERVER['REQUEST_METHOD']);
$body = read_json_body();

$deviceFromGet = static function (): string {
    $d = trim((string) ($_GET['deviceId'] ?? ''));
    if ($d === '') {
        json_response(['status' => false, 'error' => 'deviceId is required'], 422);
    }
    return $d;
};

try {
    switch ($action) {
        case 'health':
            json_response(['status' => true, 'message' => 'ok']);

        // --- Idempotent schema creation (safe to call anytime) ---
        case 'migrate':
            $pdo = db($config);
            $pdo->exec(
                'CREATE TABLE IF NOT EXISTS podcast_favorites (
                    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    device_id VARCHAR(80) NOT NULL, feed_id BIGINT NOT NULL,
                    title VARCHAR(255) NOT NULL, image TEXT NULL, author VARCHAR(255) NULL,
                    language VARCHAR(80) NULL, feed_url TEXT NULL,
                    added_via VARCHAR(16) NOT NULL DEFAULT "search", last_fetched DATETIME NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uniq_fav_device_feed (device_id, feed_id),
                    KEY idx_fav_device_created (device_id, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
            );
            $pdo->exec(
                'CREATE TABLE IF NOT EXISTS podcast_episodes (
                    feed_id BIGINT NOT NULL, episode_id BIGINT NOT NULL,
                    title VARCHAR(512) NOT NULL, description TEXT NULL,
                    published_at INT UNSIGNED NOT NULL DEFAULT 0, audio_url TEXT NULL, link_url TEXT NULL,
                    image TEXT NULL, duration_sec INT UNSIGNED NOT NULL DEFAULT 0,
                    fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (feed_id, episode_id), KEY idx_ep_published (published_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
            );
            $pdo->exec(
                'CREATE TABLE IF NOT EXISTS podcast_episode_state (
                    device_id VARCHAR(80) NOT NULL, episode_id BIGINT NOT NULL, feed_id BIGINT NOT NULL,
                    played_at DATETIME NULL, position_sec INT UNSIGNED NOT NULL DEFAULT 0,
                    duration_sec INT UNSIGNED NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (device_id, episode_id), KEY idx_state_device_played (device_id, played_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
            );
            json_response(['status' => true, 'message' => 'migrated']);

        // Flet alle enheders data ind i ét fast single-user-id (indtil login).
        // Idempotent. Kald ?action=mergeDevices&confirm=yes én gang.
        case 'mergeDevices':
            if (($_GET['confirm'] ?? '') !== 'yes') {
                json_response(['status' => false, 'error' => 'add &confirm=yes'], 400);
            }
            $target = 'allan-main';
            $pdo = db($config);
            // UPDATE IGNORE flytter rækker; kollisioner (samme feed/episode findes
            // allerede under target) springes over og fjernes derefter.
            $pdo->exec("UPDATE IGNORE podcast_favorites SET device_id = '$target' WHERE device_id <> '$target'");
            $pdo->exec("DELETE FROM podcast_favorites WHERE device_id <> '$target'");
            $pdo->exec("UPDATE IGNORE podcast_episode_state SET device_id = '$target' WHERE device_id <> '$target'");
            $pdo->exec("DELETE FROM podcast_episode_state WHERE device_id <> '$target'");
            $favs = (int) $pdo->query("SELECT COUNT(*) FROM podcast_favorites WHERE device_id = '$target'")->fetchColumn();
            $states = (int) $pdo->query("SELECT COUNT(*) FROM podcast_episode_state WHERE device_id = '$target'")->fetchColumn();
            json_response(['status' => true, 'target' => $target, 'favorites' => $favs, 'states' => $states]);

        // --- Podcast Index proxy (discovery) ---
        case 'discover':
            $max = isset($_GET['max']) ? max(1, min(100, (int) $_GET['max'])) : 60;
            $lang = isset($_GET['lang']) ? trim((string) $_GET['lang']) : 'da';
            $response = podcastindex_request($config, '/podcasts/trending', ['max' => $max, 'lang' => $lang]);
            json_response($response, isset($response['status']) && !$response['status'] ? 502 : 200);

        case 'search':
            $query = trim((string) ($_GET['q'] ?? ''));
            if ($query === '') {
                json_response(['status' => false, 'error' => 'q is required'], 422);
            }
            $max = isset($_GET['max']) ? max(1, min(100, (int) $_GET['max'])) : 60;
            $response = podcastindex_request($config, '/search/byterm', [
                'q' => $query, 'max' => $max, 'clean' => true, 'fulltext' => false,
            ]);
            json_response($response, isset($response['status']) && !$response['status'] ? 502 : 200);

        case 'podcast':
            $feedId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
            if ($feedId <= 0) {
                json_response(['status' => false, 'error' => 'id is required'], 422);
            }
            $response = podcastindex_request($config, '/podcasts/byfeedid', ['id' => $feedId]);
            json_response($response, isset($response['status']) && !$response['status'] ? 502 : 200);

        // Resolve an arbitrary RSS URL to a Podcast Index feed (the "add by URL" escape hatch).
        case 'resolveUrl':
            $url = trim((string) ($_GET['url'] ?? ''));
            if ($url === '') {
                json_response(['status' => false, 'error' => 'url is required'], 422);
            }
            $response = podcastindex_request($config, '/podcasts/byfeedurl', ['url' => $url]);
            json_response($response, isset($response['status']) && !$response['status'] ? 502 : 200);

        // --- Favorites (the only follow concept) ---
        case 'favorites.list':
            $deviceId = $deviceFromGet();
            $pdo = db($config);
            $stmt = $pdo->prepare('SELECT feed_id, title, image, author, language, feed_url, added_via, created_at
                                   FROM podcast_favorites WHERE device_id = :dev ORDER BY title ASC');
            $stmt->execute(['dev' => $deviceId]);
            json_response(['status' => true, 'items' => $stmt->fetchAll()]);

        case 'favorites.add':
            if ($method !== 'POST') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $feedId = required_int($body, 'feedId');
            $title = required_string($body, 'title');
            $addedVia = (($body['addedVia'] ?? '') === 'url') ? 'url' : 'search';
            $pdo = db($config);
            $stmt = $pdo->prepare(
                'INSERT INTO podcast_favorites (device_id, feed_id, title, image, author, language, feed_url, added_via)
                 VALUES (:dev, :feed, :title, :image, :author, :language, :feedUrl, :addedVia)
                 ON DUPLICATE KEY UPDATE title = VALUES(title), image = VALUES(image), author = VALUES(author),
                    language = VALUES(language), feed_url = VALUES(feed_url)'
            );
            $stmt->execute([
                'dev' => $deviceId, 'feed' => $feedId, 'title' => $title,
                'image' => trim((string) ($body['image'] ?? '')),
                'author' => trim((string) ($body['author'] ?? '')),
                'language' => trim((string) ($body['language'] ?? '')),
                'feedUrl' => trim((string) ($body['feedUrl'] ?? '')),
                'addedVia' => $addedVia,
            ]);
            podcast_refresh_feed($config, $pdo, $deviceId, $feedId);
            json_response(['status' => true]);

        case 'favorites.remove':
            if ($method !== 'DELETE') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $feedId = required_int($body, 'feedId');
            $pdo = db($config);
            $pdo->prepare('DELETE FROM podcast_favorites WHERE device_id = :dev AND feed_id = :feed')
                ->execute(['dev' => $deviceId, 'feed' => $feedId]);
            json_response(['status' => true]);

        // --- Episodes ---
        case 'episodes.feed':
            $deviceId = $deviceFromGet();
            $feedId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
            if ($feedId <= 0) {
                json_response(['status' => false, 'error' => 'id is required'], 422);
            }
            $pdo = db($config);
            json_response(['status' => true, 'items' => podcast_feed_episodes($config, $pdo, $deviceId, $feedId)]);

        case 'episodes.newest':
            $deviceId = $deviceFromGet();
            $pdo = db($config);
            podcast_refresh_stale_favorites($config, $pdo, $deviceId);
            json_response(['status' => true, 'items' => podcast_newest_episodes($pdo, $deviceId)]);

        // --- Played / position state ---
        case 'state.set':
            if ($method !== 'POST') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $episodeId = required_int($body, 'episodeId');
            $feedId = required_int($body, 'feedId');
            $position = max(0, (int) ($body['positionSec'] ?? 0));
            $duration = max(0, (int) ($body['durationSec'] ?? 0));
            // played: true => stamp NOW(), false => clear, absent => leave unchanged
            $hasPlayed = array_key_exists('played', $body);
            $playedInsert = $hasPlayed ? ($body['played'] ? 'NOW()' : 'NULL') : 'NULL';
            $playedUpdate = $hasPlayed ? ($body['played'] ? 'NOW()' : 'NULL') : 'played_at';
            $pdo = db($config);
            $stmt = $pdo->prepare(
                "INSERT INTO podcast_episode_state (device_id, episode_id, feed_id, position_sec, duration_sec, played_at)
                 VALUES (:dev, :ep, :feed, :pos, :dur, $playedInsert)
                 ON DUPLICATE KEY UPDATE position_sec = VALUES(position_sec), duration_sec = VALUES(duration_sec),
                    played_at = $playedUpdate"
            );
            $stmt->execute([
                'dev' => $deviceId, 'ep' => $episodeId, 'feed' => $feedId,
                'pos' => $position, 'dur' => $duration,
            ]);
            json_response(['status' => true]);

        // Bulk hørt/uhørt (til "ryd alt herunder" i køen).
        case 'state.setMany':
            if ($method !== 'POST') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $episodes = is_array($body['episodes'] ?? null) ? $body['episodes'] : [];
            $played = !empty($body['played']);
            $playedVal = $played ? 'NOW()' : 'NULL';
            $pdo = db($config);
            $stmt = $pdo->prepare(
                "INSERT INTO podcast_episode_state (device_id, episode_id, feed_id, position_sec, duration_sec, played_at)
                 VALUES (:dev, :ep, :feed, 0, 0, $playedVal)
                 ON DUPLICATE KEY UPDATE played_at = $playedVal"
            );
            $count = 0;
            foreach ($episodes as $e) {
                if (!is_array($e) || !isset($e['episodeId'], $e['feedId'])) {
                    continue;
                }
                $stmt->execute(['dev' => $deviceId, 'ep' => (int) $e['episodeId'], 'feed' => (int) $e['feedId']]);
                $count++;
            }
            json_response(['status' => true, 'updated' => $count]);

        default:
            json_response(['status' => false, 'error' => 'Unknown action'], 404);
    }
} catch (Throwable $exception) {
    json_response([
        'status' => false,
        'error' => 'Server error',
        'details' => $exception->getMessage(),
    ], 500);
}
