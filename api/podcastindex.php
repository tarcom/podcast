<?php

declare(strict_types=1);

function podcastindex_request(array $config, string $endpoint, array $query = []): array
{
    $api = $config['podcastindex'];
    $timestamp = (string) time();
    $authorization = sha1($api['api_key'] . $api['api_secret'] . $timestamp);

    $url = rtrim($api['base_url'], '/') . '/' . ltrim($endpoint, '/');
    if ($query !== []) {
        $url .= '?' . http_build_query($query);
    }

    $headers = [
        'User-Agent: ' . $api['user_agent'],
        'X-Auth-Key: ' . $api['api_key'],
        'X-Auth-Date: ' . $timestamp,
        'Authorization: ' . $authorization,
    ];

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 25,
    ]);

    $raw = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        return ['status' => false, 'error' => 'Network error: ' . $error];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return ['status' => false, 'error' => 'Podcast Index returned invalid JSON', 'httpCode' => $httpCode];
    }

    return $decoded;
}
