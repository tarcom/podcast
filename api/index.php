<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/db.php';
require __DIR__ . '/podcastindex.php';

$action = $_GET['action'] ?? 'health';
$method = strtoupper($_SERVER['REQUEST_METHOD']);
$body = read_json_body();

try {
    switch ($action) {
        case 'health':
            json_response(['status' => true, 'message' => 'ok']);

        case 'discover':
            $max = isset($_GET['max']) ? max(1, min(100, (int) $_GET['max'])) : 60;
            $lang = isset($_GET['lang']) ? trim((string) $_GET['lang']) : 'da';
            $response = podcastindex_request($config, '/podcasts/trending', [
                'max' => $max,
                'lang' => $lang,
            ]);
            json_response($response, isset($response['status']) && !$response['status'] ? 502 : 200);

        case 'search':
            $query = trim((string) ($_GET['q'] ?? ''));
            if ($query === '') {
                json_response(['status' => false, 'error' => 'q is required'], 422);
            }
            $max = isset($_GET['max']) ? max(1, min(100, (int) $_GET['max'])) : 60;
            $response = podcastindex_request($config, '/search/byterm', [
                'q' => $query,
                'max' => $max,
                'clean' => true,
                'fulltext' => false,
            ]);
            json_response($response, isset($response['status']) && !$response['status'] ? 502 : 200);

        case 'podcast':
            $feedId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
            if ($feedId <= 0) {
                json_response(['status' => false, 'error' => 'id is required'], 422);
            }
            $response = podcastindex_request($config, '/podcasts/byfeedid', ['id' => $feedId]);
            json_response($response, isset($response['status']) && !$response['status'] ? 502 : 200);

        case 'episodes':
            $feedId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
            if ($feedId <= 0) {
                json_response(['status' => false, 'error' => 'id is required'], 422);
            }
            $max = isset($_GET['max']) ? max(1, min(100, (int) $_GET['max'])) : 50;
            $response = podcastindex_request($config, '/episodes/byfeedid', [
                'id' => $feedId,
                'max' => $max,
            ]);
            json_response($response, isset($response['status']) && !$response['status'] ? 502 : 200);

        case 'favorites.list':
            $deviceId = trim((string) ($_GET['deviceId'] ?? ''));
            if ($deviceId === '') {
                json_response(['status' => false, 'error' => 'deviceId is required'], 422);
            }
            $pdo = db($config);
            $stmt = $pdo->prepare('SELECT feed_id, title, image, feed_url, author, language, created_at FROM favorites WHERE device_id = :deviceId ORDER BY created_at DESC');
            $stmt->execute(['deviceId' => $deviceId]);
            json_response(['status' => true, 'items' => $stmt->fetchAll()]);

        case 'favorites.add':
            if ($method !== 'POST') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $feedId = required_int($body, 'feedId');
            $title = required_string($body, 'title');
            $image = trim((string) ($body['image'] ?? ''));
            $feedUrl = trim((string) ($body['feedUrl'] ?? ''));
            $author = trim((string) ($body['author'] ?? ''));
            $language = trim((string) ($body['language'] ?? ''));
            $pdo = db($config);
            $stmt = $pdo->prepare('INSERT INTO favorites (device_id, feed_id, title, image, feed_url, author, language) VALUES (:deviceId, :feedId, :title, :image, :feedUrl, :author, :language) ON DUPLICATE KEY UPDATE title = VALUES(title), image = VALUES(image), feed_url = VALUES(feed_url), author = VALUES(author), language = VALUES(language)');
            $stmt->execute([
                'deviceId' => $deviceId,
                'feedId' => $feedId,
                'title' => $title,
                'image' => $image,
                'feedUrl' => $feedUrl,
                'author' => $author,
                'language' => $language,
            ]);
            json_response(['status' => true]);

        case 'favorites.remove':
            if ($method !== 'DELETE') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $feedId = required_int($body, 'feedId');
            $pdo = db($config);
            $stmt = $pdo->prepare('DELETE FROM favorites WHERE device_id = :deviceId AND feed_id = :feedId');
            $stmt->execute(['deviceId' => $deviceId, 'feedId' => $feedId]);
            json_response(['status' => true]);

        case 'subscriptions.list':
            $deviceId = trim((string) ($_GET['deviceId'] ?? ''));
            if ($deviceId === '') {
                json_response(['status' => false, 'error' => 'deviceId is required'], 422);
            }
            $pdo = db($config);
            $stmt = $pdo->prepare('SELECT feed_id, title, image, feed_url, author, language, created_at FROM subscriptions WHERE device_id = :deviceId ORDER BY created_at DESC');
            $stmt->execute(['deviceId' => $deviceId]);
            json_response(['status' => true, 'items' => $stmt->fetchAll()]);

        case 'subscriptions.add':
            if ($method !== 'POST') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $feedId = required_int($body, 'feedId');
            $title = required_string($body, 'title');
            $image = trim((string) ($body['image'] ?? ''));
            $feedUrl = trim((string) ($body['feedUrl'] ?? ''));
            $author = trim((string) ($body['author'] ?? ''));
            $language = trim((string) ($body['language'] ?? ''));
            $pdo = db($config);
            $stmt = $pdo->prepare('INSERT INTO subscriptions (device_id, feed_id, title, image, feed_url, author, language) VALUES (:deviceId, :feedId, :title, :image, :feedUrl, :author, :language) ON DUPLICATE KEY UPDATE title = VALUES(title), image = VALUES(image), feed_url = VALUES(feed_url), author = VALUES(author), language = VALUES(language)');
            $stmt->execute([
                'deviceId' => $deviceId,
                'feedId' => $feedId,
                'title' => $title,
                'image' => $image,
                'feedUrl' => $feedUrl,
                'author' => $author,
                'language' => $language,
            ]);
            json_response(['status' => true]);

        case 'subscriptions.remove':
            if ($method !== 'DELETE') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $feedId = required_int($body, 'feedId');
            $pdo = db($config);
            $stmt = $pdo->prepare('DELETE FROM subscriptions WHERE device_id = :deviceId AND feed_id = :feedId');
            $stmt->execute(['deviceId' => $deviceId, 'feedId' => $feedId]);
            json_response(['status' => true]);

        case 'progress.get':
            $deviceId = trim((string) ($_GET['deviceId'] ?? ''));
            if ($deviceId === '') {
                json_response(['status' => false, 'error' => 'deviceId is required'], 422);
            }
            $pdo = db($config);
            $stmt = $pdo->prepare('SELECT episode_id, feed_id, title, audio_url, position_sec, duration_sec, updated_at FROM playback_progress WHERE device_id = :deviceId ORDER BY updated_at DESC LIMIT 1');
            $stmt->execute(['deviceId' => $deviceId]);
            $item = $stmt->fetch();
            json_response(['status' => true, 'item' => $item ?: null]);

        case 'progress.set':
            if ($method !== 'POST') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $episodeId = required_int($body, 'episodeId');
            $feedId = required_int($body, 'feedId');
            $title = required_string($body, 'title');
            $audioUrl = required_string($body, 'audioUrl');
            $position = max(0, (int) ($body['positionSec'] ?? 0));
            $duration = max(0, (int) ($body['durationSec'] ?? 0));
            $pdo = db($config);
            $stmt = $pdo->prepare('INSERT INTO playback_progress (device_id, episode_id, feed_id, title, audio_url, position_sec, duration_sec) VALUES (:deviceId, :episodeId, :feedId, :title, :audioUrl, :positionSec, :durationSec) ON DUPLICATE KEY UPDATE feed_id = VALUES(feed_id), title = VALUES(title), audio_url = VALUES(audio_url), position_sec = VALUES(position_sec), duration_sec = VALUES(duration_sec), updated_at = CURRENT_TIMESTAMP');
            $stmt->execute([
                'deviceId' => $deviceId,
                'episodeId' => $episodeId,
                'feedId' => $feedId,
                'title' => $title,
                'audioUrl' => $audioUrl,
                'positionSec' => $position,
                'durationSec' => $duration,
            ]);
            json_response(['status' => true]);

        case 'queue.list':
            $deviceId = trim((string) ($_GET['deviceId'] ?? ''));
            if ($deviceId === '') {
                json_response(['status' => false, 'error' => 'deviceId is required'], 422);
            }
            $pdo = db($config);
            $stmt = $pdo->prepare('SELECT id, episode_id, feed_id, title, podcast_title, audio_url, image, published_at, duration_sec, sort_order FROM playback_queue WHERE device_id = :deviceId ORDER BY sort_order ASC, id ASC');
            $stmt->execute(['deviceId' => $deviceId]);
            json_response(['status' => true, 'items' => $stmt->fetchAll()]);

        case 'queue.add':
            if ($method !== 'POST') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $episodeId = required_int($body, 'episodeId');
            $feedId = required_int($body, 'feedId');
            $title = required_string($body, 'title');
            $podcastTitle = trim((string) ($body['podcastTitle'] ?? ''));
            $audioUrl = required_string($body, 'audioUrl');
            $image = trim((string) ($body['image'] ?? ''));
            $publishedAt = trim((string) ($body['publishedAt'] ?? ''));
            $duration = max(0, (int) ($body['durationSec'] ?? 0));
            $pdo = db($config);
            $next = $pdo->prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM playback_queue WHERE device_id = :deviceId');
            $next->execute(['deviceId' => $deviceId]);
            $nextOrder = (int) ($next->fetch()['next_order'] ?? 1);
            $stmt = $pdo->prepare('INSERT INTO playback_queue (device_id, episode_id, feed_id, title, podcast_title, audio_url, image, published_at, duration_sec, sort_order) VALUES (:deviceId, :episodeId, :feedId, :title, :podcastTitle, :audioUrl, :image, :publishedAt, :durationSec, :sortOrder) ON DUPLICATE KEY UPDATE title = VALUES(title), podcast_title = VALUES(podcast_title), audio_url = VALUES(audio_url), image = VALUES(image), published_at = VALUES(published_at), duration_sec = VALUES(duration_sec)');
            $stmt->execute([
                'deviceId' => $deviceId,
                'episodeId' => $episodeId,
                'feedId' => $feedId,
                'title' => $title,
                'podcastTitle' => $podcastTitle,
                'audioUrl' => $audioUrl,
                'image' => $image,
                'publishedAt' => $publishedAt,
                'durationSec' => $duration,
                'sortOrder' => $nextOrder,
            ]);
            json_response(['status' => true]);

        case 'queue.remove':
            if ($method !== 'DELETE') {
                json_response(['status' => false, 'error' => 'Method not allowed'], 405);
            }
            $deviceId = required_string($body, 'deviceId');
            $episodeId = required_int($body, 'episodeId');
            $pdo = db($config);
            $stmt = $pdo->prepare('DELETE FROM playback_queue WHERE device_id = :deviceId AND episode_id = :episodeId');
            $stmt->execute(['deviceId' => $deviceId, 'episodeId' => $episodeId]);
            json_response(['status' => true]);

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
