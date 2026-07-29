<?php

declare(strict_types=1);

/**
 * Direkte RSS-læsning — den primære kilde til afsnit (Podcast Index er fallback).
 *
 * Første anledning (2026-07-28): DR's "Ubegribeligt" lå i app'en som 60 smagsprøver på
 * 33-40 sek, fordi Podcast Index havde teasere cachet for feedet. DR's eget RSS indeholdt
 * samtidig 78 rigtige, fulde afsnit.
 * Anden anledning (2026-07-29): "Store Penge" (+ Børsen investor, Sådan investerer jeg) manglede
 * afsnit i op til 7 dage. Årsag: Podcast Index er en **crawler** og kan sakke bagud — feedets eget
 * RSS havde afsnittene hele tiden. Derfor læses RSS'et nu direkte for ALLE feeds der har et
 * `feed_url`; PI bruges kun hvis RSS-hentningen fejler.
 *
 * Tre ting er vigtige her:
 *  1) **Bevar eksisterende episode_id.** Hørt-tilstand og lytteposition hænger på
 *     `episode_id`. Ville vi bare finde på nye id'er, mistede Allan alt det.
 *     Derfor genbruges id'et fra et allerede gemt afsnit — først matchet på `audio_url`
 *     (den mest stabile nøgle), ellers på titel+dato.
 *  2) **Slet kun teasere.** Når et feed genindlæses fra RSS, ryddes kun de cachede
 *     afsnit der (a) ikke findes i RSS'et OG (b) er under 2 min. Så forsvinder
 *     smagsprøverne, mens ægte gamle afsnit (som RSS'et måske ikke rækker tilbage til)
 *     aldrig slettes.
 *  3) **Kun de nyeste N afsnit importeres** (`$max`, default = samme 60 som PI leverede).
 *     Et RSS kan have 300-400 afsnit; tog vi dem alle, ville køen (som viser uhørte) blive
 *     oversvømmet af flere hundrede gamle afsnit — og hver refresh blive unødigt tung.
 */

const RSS_TEASER_MAX_SEC = 120; // kortere end dette + ikke i feedet = smagsprøve
const RSS_MAX_EPISODES = 60;    // samme dybde som Podcast Index leverede — se punkt 3 ovenfor

/** "PT1H2M3S" / "1:02:03" / "3600" -> sekunder */
function rss_duration_to_sec(string $v): int
{
    $v = trim($v);
    if ($v === '') {
        return 0;
    }
    if (preg_match('~^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$~i', $v, $m)) {
        return ((int) ($m[1] ?? 0)) * 3600 + ((int) ($m[2] ?? 0)) * 60 + (int) ($m[3] ?? 0);
    }
    if (str_contains($v, ':')) {
        $p = array_reverse(array_map('intval', explode(':', $v)));
        return (int) (($p[0] ?? 0) + ($p[1] ?? 0) * 60 + ($p[2] ?? 0) * 3600);
    }
    return max(0, (int) $v);
}

/** Stabilt positivt 31-bit id ud fra en guid/URL — samme guid giver altid samme id. */
function rss_stable_id(string $key): int
{
    return (int) (crc32($key) & 0x7FFFFFFF);
}

/**
 * Hent og parse et RSS-feed til en liste af afsnit, nyeste først.
 * `$max` > 0 begrænser til de nyeste N. Returnerer null ved fejl.
 */
function rss_fetch_episodes(string $feedUrl, int $max = 0): ?array
{
    $ch = curl_init($feedUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 25,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTPHEADER => ['User-Agent: AllDKPodcasts/1.0 (+https://aogj.com/podcast)'],
    ]);
    $raw = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false || $code !== 200 || $raw === '') {
        return null;
    }

    $prev = libxml_use_internal_errors(true);
    $xml = simplexml_load_string((string) $raw, 'SimpleXMLElement', LIBXML_NOCDATA | LIBXML_NONET);
    libxml_use_internal_errors($prev);
    if ($xml === false || !isset($xml->channel)) {
        return null;
    }

    $out = [];
    foreach ($xml->channel->item as $item) {
        $itunes = $item->children('http://www.itunes.com/dtds/podcast-1.0.dtd');

        $enclosure = '';
        if (isset($item->enclosure)) {
            $enclosure = trim((string) $item->enclosure->attributes()->url);
        }
        $guid = trim((string) ($item->guid ?? ''));
        $link = trim((string) ($item->link ?? ''));
        $title = trim((string) ($item->title ?? ''));
        if ($title === '' && $enclosure === '') {
            continue;
        }

        $pub = 0;
        if (isset($item->pubDate)) {
            $t = strtotime((string) $item->pubDate);
            $pub = $t !== false ? $t : 0;
        }

        $image = '';
        if (isset($itunes->image)) {
            $image = trim((string) $itunes->image->attributes()->href);
        }

        $out[] = [
            'guid' => $guid !== '' ? $guid : ($enclosure !== '' ? $enclosure : $title),
            'title' => $title !== '' ? $title : 'Ukendt episode',
            'description' => trim((string) ($item->description ?? ($itunes->summary ?? ''))),
            'published_at' => $pub,
            'audio_url' => $enclosure !== '' ? $enclosure : null,
            'link_url' => $link !== '' ? $link : null,
            'image' => $image !== '' ? $image : null,
            'duration_sec' => rss_duration_to_sec((string) ($itunes->duration ?? '')),
        ];
    }

    // Nyeste først — de fleste feeds er allerede sorteret, men vi kan ikke regne med det,
    // og $max skal skære de ÆLDSTE væk, ikke bare halen af filen.
    usort($out, static fn (array $a, array $b): int => $b['published_at'] <=> $a['published_at']);
    if ($max > 0 && count($out) > $max) {
        $out = array_slice($out, 0, $max);
    }

    return $out;
}

/**
 * Genindlæs ét feeds afsnit fra dets RSS.
 * Returnerer ['inserted'=>n,'reused'=>n,'removedTeasers'=>n] eller null hvis feedet ikke kunne hentes.
 */
function rss_refresh_feed(PDO $pdo, int $feedId, string $feedUrl, bool $pruneTeasers = true, int $max = RSS_MAX_EPISODES): ?array
{
    $eps = rss_fetch_episodes($feedUrl, $max);
    if ($eps === null || !$eps) {
        return null;
    }

    // Eksisterende afsnit -> episode_id, så id'er (og dermed hørt-tilstand) bevares.
    // audio_url er den stabile nøgle: PI gemte præcis feedets enclosure-URL, så et feed der
    // skifter fra PI til RSS genkender alt. Titel+dato er fallback for feeds hvor lyd-URL'en
    // indeholder et per-kald-token (fx art19's `?rss_browser=`).
    $byAudio = [];
    $byTitleDate = [];
    $q = $pdo->prepare('SELECT episode_id, title, published_at, duration_sec, audio_url FROM podcast_episodes WHERE feed_id = :f');
    $q->execute(['f' => $feedId]);
    $rows = $q->fetchAll();
    foreach ($rows as $r) {
        $audio = trim((string) ($r['audio_url'] ?? ''));
        if ($audio !== '') {
            $byAudio[$audio] = (int) $r['episode_id'];
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

    $seen = [];
    $inserted = 0;
    $reused = 0;
    $oldestKept = PHP_INT_MAX;
    foreach ($eps as $e) {
        $audio = trim((string) ($e['audio_url'] ?? ''));
        $key = mb_strtolower(trim((string) $e['title'])) . '|' . (int) $e['published_at'];
        if ($audio !== '' && isset($byAudio[$audio])) {
            $epId = $byAudio[$audio];
            $reused++;
        } elseif (isset($byTitleDate[$key])) {
            $epId = $byTitleDate[$key];
            $reused++;
        } else {
            $epId = rss_stable_id((string) $e['guid']);
            $inserted++;
        }
        $seen[$epId] = true;
        $oldestKept = min($oldestKept, (int) $e['published_at']);
        $upsert->execute([
            'feed' => $feedId,
            'ep' => $epId,
            'title' => mb_substr((string) $e['title'], 0, 512),
            'descr' => (string) $e['description'],
            'pub' => (int) $e['published_at'],
            'audio' => $e['audio_url'],
            'link' => $e['link_url'],
            'image' => $e['image'],
            'dur' => (int) $e['duration_sec'],
        ]);
    }

    // Ryd smagsprøver: kun det der IKKE er i feedet og er kortere end 2 min.
    // Og kun inden for det vindue vi rent faktisk har læst ($max skærer halen af feedet væk,
    // så alt ældre end det ældste importerede afsnit er "ukendt", ikke "fjernet fra feedet").
    $removed = 0;
    if ($pruneTeasers) {
        foreach ($rows as $r) {
            $epId = (int) $r['episode_id'];
            if (isset($seen[$epId]) || (int) $r['published_at'] < $oldestKept) {
                continue;
            }
            if ((int) $r['duration_sec'] > 0 && (int) $r['duration_sec'] <= RSS_TEASER_MAX_SEC) {
                $del = $pdo->prepare('DELETE FROM podcast_episodes WHERE feed_id = :f AND episode_id = :e');
                $del->execute(['f' => $feedId, 'e' => $epId]);
                $removed++;
            }
        }
    }

    return ['inserted' => $inserted, 'reused' => $reused, 'removedTeasers' => $removed, 'feedItems' => count($eps)];
}
