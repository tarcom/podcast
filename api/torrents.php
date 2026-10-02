<?php

declare(strict_types=1);

// Torrents hentet af qBittorrent på HTPC (2026-10-02). Vises i køen som deres egen kategori,
// men KUN på enheder der har tastet PIN-koden: resten af API'et er åbent (device-id'et står i
// det offentlige JavaScript), og listen over hvad der er hentet med torrent må ikke ligge frit
// på aogj.com. Derfor deres egen tabel — rækkerne kan ikke slippe med i episodes.newest eller
// episodes.feed — og kun `torrents.list` med et gyldigt token læser dem.
//
//   torrent.unlock  POST {pin}                         -> {token}  (5 forkerte = 1 min pause for alle)
//   torrents.list   GET  deviceId + X-Torrent-Token    -> de 50 nyeste, med hørt/set-tilstand
//   torrent.ingest  POST {key, torrents:[...]}         <- HTPC-cron'en (scraper/tick.py)
//
// config.php: 'torrent' => ['pin_hash' => password_hash(PIN), 'secret' => …, 'ingest_key' => …].
// Ny PIN: ny pin_hash. Log alle enheder ud: ny secret (tokenet er en HMAC over den).

const TORRENT_FEED_ID = -1;          // syntetisk feed-id i køen; samme tal som i App.tsx
const TORRENT_MAX_FAILS = 5;
const TORRENT_LOCK_SECONDS = 60;
const TORRENT_LIST_LIMIT = 50;

function torrent_config(array $config): array
{
    $t = $config['torrent'] ?? null;
    if (!is_array($t) || empty($t['pin_hash']) || empty($t['secret']) || empty($t['ingest_key'])) {
        json_response(['status' => false, 'error' => 'Torrents er ikke sat op i config.php'], 503);
    }
    return $t;
}

function torrent_token(array $t): string
{
    return hash_hmac('sha256', 'torrent-v1', (string) $t['secret']);
}

function torrent_token_ok(array $t): bool
{
    $given = (string) ($_SERVER['HTTP_X_TORRENT_TOKEN'] ?? '');
    return $given !== '' && hash_equals(torrent_token($t), $given);
}

function torrent_tables(PDO $pdo): void
{
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS podcast_torrents (
            hash VARCHAR(64) NOT NULL PRIMARY KEY,
            episode_id BIGINT NOT NULL,
            name VARCHAR(512) NOT NULL,
            size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
            completed_at INT UNSIGNED NOT NULL,
            KEY idx_torrent_completed (completed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    // Én række: fejlede PIN-forsøg tælles fælles, ikke pr. klient — en firecifret kode skal
    // ikke kunne prøves igennem fra mange adresser på én gang.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS podcast_pin_lock (
            id TINYINT NOT NULL PRIMARY KEY,
            fails INT NOT NULL DEFAULT 0,
            locked_until INT UNSIGNED NOT NULL DEFAULT 0
        ) ENGINE=InnoDB'
    );
}

function torrent_unlock(array $config, array $body): never
{
    $t = torrent_config($config);
    $pin = trim((string) ($body['pin'] ?? ''));
    $pdo = db($config);
    $pdo->exec('INSERT IGNORE INTO podcast_pin_lock (id, fails, locked_until) VALUES (1, 0, 0)');
    $row = $pdo->query('SELECT fails, locked_until FROM podcast_pin_lock WHERE id = 1')->fetch();
    $now = time();
    if ((int) $row['locked_until'] > $now) {
        json_response([
            'status' => false,
            'error' => 'For mange forkerte forsøg — prøv igen om lidt',
            'retryAfter' => (int) $row['locked_until'] - $now,
        ], 429);
    }
    if ($pin !== '' && password_verify($pin, (string) $t['pin_hash'])) {
        $pdo->exec('UPDATE podcast_pin_lock SET fails = 0, locked_until = 0 WHERE id = 1');
        json_response(['status' => true, 'token' => torrent_token($t)]);
    }
    $fails = (int) $row['fails'] + 1;
    if ($fails >= TORRENT_MAX_FAILS) {
        $pdo->prepare('UPDATE podcast_pin_lock SET fails = 0, locked_until = :until WHERE id = 1')
            ->execute(['until' => $now + TORRENT_LOCK_SECONDS]);
    } else {
        $pdo->prepare('UPDATE podcast_pin_lock SET fails = :f WHERE id = 1')->execute(['f' => $fails]);
    }
    sleep(1);
    json_response(['status' => false, 'error' => 'Forkert kode', 'triesLeft' => max(0, TORRENT_MAX_FAILS - $fails)], 403);
}

function torrent_list(array $config, string $deviceId): never
{
    $t = torrent_config($config);
    if (!torrent_token_ok($t)) {
        json_response(['status' => false, 'error' => 'Kræver koden'], 401);
    }
    $pdo = db($config);
    $stmt = $pdo->prepare(
        'SELECT t.episode_id, t.name, t.size_bytes, t.completed_at, s.played_at
         FROM podcast_torrents t
         LEFT JOIN podcast_episode_state s ON s.device_id = :dev AND s.episode_id = t.episode_id
         ORDER BY t.completed_at DESC
         LIMIT ' . (int) TORRENT_LIST_LIMIT
    );
    $stmt->execute(['dev' => $deviceId]);
    json_response(['status' => true, 'feedId' => TORRENT_FEED_ID, 'items' => $stmt->fetchAll()]);
}

function torrent_ingest(array $config, array $body): never
{
    $t = torrent_config($config);
    if (!hash_equals((string) $t['ingest_key'], (string) ($body['key'] ?? ''))) {
        json_response(['status' => false, 'error' => 'Forkert nøgle'], 403);
    }
    $pdo = db($config);
    torrent_tables($pdo);
    $ins = $pdo->prepare(
        'INSERT INTO podcast_torrents (hash, episode_id, name, size_bytes, completed_at)
         VALUES (:hash, :ep, :name, :size, :done)
         ON DUPLICATE KEY UPDATE name = VALUES(name), size_bytes = VALUES(size_bytes),
            completed_at = VALUES(completed_at)'
    );
    $added = [];
    foreach (($body['torrents'] ?? []) as $x) {
        $hash = strtolower(trim((string) ($x['hash'] ?? '')));
        $done = (int) ($x['completedAt'] ?? 0);
        if (!preg_match('/^[0-9a-f]{40,64}$/', $hash) || $done <= 0) {
            continue;
        }
        $name = mb_substr(trim((string) ($x['name'] ?? '')), 0, 512);
        $ins->execute([
            'hash' => $hash,
            // Samme id-rum som podcast-afsnit, så ✓ (set) gemmes i podcast_episode_state.
            'ep'   => rss_stable_id('torrent:' . $hash),
            'name' => $name !== '' ? $name : $hash,
            'size' => max(0, (int) ($x['size'] ?? 0)),
            'done' => $done,
        ]);
        // rowCount: 1 = ny række, 2 = opdateret, 0 = uændret
        if ($ins->rowCount() === 1) {
            $added[] = $name;
        }
    }
    json_response(['status' => true, 'added' => $added]);
}
