<?php

declare(strict_types=1);

// Log over afspilningen fra web-appen og Android-app'en (2026-11-24).
//
// HVORFOR: i bilen stod afspilleren stille, og da vi ville se, hvad der var sket, rakte
// telefonens egen log kun en time tilbage. Nu noterer siden (web/src/lib/logg.ts) og fra 3.2 også
// Android-app'en, hvad der sker: afspil og pause og hvor de kom fra, fejl, ventetid på data,
// genindlæsninger, net, forgrund og baggrund. Hændelserne samles på enheden og sendes i bundter,
// også efter et hul i dækningen, og gemmes her i LOGG_DAGE. Læses med scraper/podcastlog.py.
//
// Skrivning er åben som resten af API'et (én bruger, intet login). Læsning kræver ingest-nøglen
// (header X-Log-Key): loggen viser, hvornår der lyttes, og dermed hvor man er.

const LOGG_DAGE = 365;
const LOGG_MAX_PR_KALD = 500;
const LOGG_MAX_BYTES = 4000;

function logg_tables(PDO $pdo): void
{
    // ts er enhedens ur i millisekunder; received_at er serverens (UTC), så et forkert ur på
    // enheden og hændelser, der har ventet på net, kan ses. eid er enhedens eget id: et bundt,
    // der sendes igen (svaret nåede ikke frem), bliver ikke gemt to gange.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS podcast_log (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            device_id VARCHAR(80) NOT NULL,
            eid VARCHAR(48) NOT NULL,
            ts BIGINT NOT NULL,
            type VARCHAR(40) NOT NULL,
            data TEXT NULL,
            build VARCHAR(32) NULL,
            app VARCHAR(24) NULL,
            received_at DATETIME NOT NULL,
            UNIQUE KEY uniq_log_eid (device_id, eid),
            KEY idx_log_device_ts (device_id, ts),
            KEY idx_log_type_ts (type, ts)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
}

function logg_add(array $config, array $body): never
{
    $deviceId = substr(required_string($body, 'deviceId'), 0, 80);
    $events = $body['events'] ?? null;
    if (!is_array($events)) {
        json_response(['status' => false, 'error' => 'events skal være en liste'], 422);
    }
    $events = array_slice($events, 0, LOGG_MAX_PR_KALD);
    $build = substr((string) ($body['build'] ?? ''), 0, 32);
    $app = substr((string) ($body['app'] ?? ''), 0, 24);
    $now = gmdate('Y-m-d H:i:s');
    $pdo = db($config);
    $stmt = $pdo->prepare(
        'INSERT IGNORE INTO podcast_log (device_id, eid, ts, type, data, build, app, received_at)
         VALUES (:dev, :eid, :ts, :type, :data, :build, :app, :now)'
    );
    $saved = 0;
    foreach ($events as $e) {
        if (!is_array($e)) {
            continue;
        }
        $eid = substr((string) ($e['id'] ?? ''), 0, 48);
        $type = (string) ($e['type'] ?? '');
        $ts = (int) ($e['t'] ?? 0);
        if ($eid === '' || $ts <= 0 || !preg_match('/^[a-z0-9:_.-]{1,40}$/i', $type)) {
            continue;
        }
        unset($e['id'], $e['type'], $e['t']);
        $data = $e ? json_encode($e, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;
        if (is_string($data) && strlen($data) > LOGG_MAX_BYTES) {
            $data = json_encode(['afkortet' => mb_strcut($data, 0, LOGG_MAX_BYTES - 64, 'UTF-8')], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }
        $stmt->execute([
            'dev' => $deviceId, 'eid' => $eid, 'ts' => $ts, 'type' => $type,
            'data' => $data === false ? null : $data, 'build' => $build, 'app' => $app, 'now' => $now,
        ]);
        $saved += $stmt->rowCount();
    }
    // Ryd op en gang imellem: hændelser ældre end LOGG_DAGE.
    if (random_int(1, 50) === 1) {
        $graense = (time() - LOGG_DAGE * 86400) * 1000;
        $pdo->prepare('DELETE FROM podcast_log WHERE ts < :g LIMIT 5000')->execute(['g' => $graense]);
    }
    json_response(['status' => true, 'received' => count($events), 'saved' => $saved]);
}

function logg_list(array $config): never
{
    $t = torrent_config($config);
    $key = (string) ($_SERVER['HTTP_X_LOG_KEY'] ?? '');
    if ($key === '' || !hash_equals((string) $t['ingest_key'], $key)) {
        json_response(['status' => false, 'error' => 'Forkert nøgle'], 403);
    }
    $deviceId = trim((string) ($_GET['deviceId'] ?? 'allan-main'));
    $fra = (int) ($_GET['fra'] ?? 0); // ms
    $til = (int) ($_GET['til'] ?? 0); // ms
    $type = trim((string) ($_GET['type'] ?? ''));
    $limit = max(1, min(50000, (int) ($_GET['limit'] ?? 10000)));
    $sql = 'SELECT eid, ts, type, data, build, app, received_at FROM podcast_log WHERE device_id = :dev';
    $params = ['dev' => $deviceId];
    if ($fra > 0) {
        $sql .= ' AND ts >= :fra';
        $params['fra'] = $fra;
    }
    if ($til > 0) {
        $sql .= ' AND ts < :til';
        $params['til'] = $til;
    }
    if ($type !== '') {
        $sql .= ' AND type LIKE :type';
        $params['type'] = $type . '%';
    }
    $sql .= ' ORDER BY ts ASC, id ASC LIMIT ' . $limit;
    $pdo = db($config);
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $items = [];
    foreach ($stmt->fetchAll() as $r) {
        $data = $r['data'] !== null ? json_decode((string) $r['data'], true) : null;
        $items[] = [
            'id' => $r['eid'], 't' => (int) $r['ts'], 'type' => $r['type'],
            'data' => is_array($data) ? $data : null, 'build' => $r['build'], 'app' => $r['app'],
            'modtaget' => $r['received_at'],
        ];
    }
    json_response(['status' => true, 'items' => $items]);
}
