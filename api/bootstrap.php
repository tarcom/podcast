<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$configPath = __DIR__ . '/config.php';
if (!file_exists($configPath)) {
    http_response_code(500);
    echo json_encode([
        'status' => false,
        'error' => 'Missing api/config.php. Copy api/config.example.php to api/config.php and fill credentials.',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$config = require $configPath;

function json_response(array $data, int $statusCode = 200): never
{
    http_response_code($statusCode);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }

    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function required_string(array $source, string $key): string
{
    $value = $source[$key] ?? null;
    if (!is_string($value) || trim($value) === '') {
        json_response(['status' => false, 'error' => "Missing field: {$key}"], 422);
    }

    return trim($value);
}

function required_int(array $source, string $key): int
{
    $value = $source[$key] ?? null;
    if (!is_numeric($value)) {
        json_response(['status' => false, 'error' => "Missing numeric field: {$key}"], 422);
    }

    return (int) $value;
}
