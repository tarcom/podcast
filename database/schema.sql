CREATE TABLE IF NOT EXISTS favorites (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(80) NOT NULL,
  feed_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  image TEXT NULL,
  feed_url TEXT NULL,
  author VARCHAR(255) NULL,
  language VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_favorites_device_feed (device_id, feed_id),
  KEY idx_favorites_device_created (device_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(80) NOT NULL,
  feed_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  image TEXT NULL,
  feed_url TEXT NULL,
  author VARCHAR(255) NULL,
  language VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_subscriptions_device_feed (device_id, feed_id),
  KEY idx_subscriptions_device_created (device_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playback_progress (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(80) NOT NULL,
  episode_id BIGINT NOT NULL,
  feed_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  audio_url TEXT NOT NULL,
  position_sec INT UNSIGNED NOT NULL DEFAULT 0,
  duration_sec INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_progress_device_episode (device_id, episode_id),
  KEY idx_progress_device_updated (device_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playback_queue (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(80) NOT NULL,
  episode_id BIGINT NOT NULL,
  feed_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  podcast_title VARCHAR(255) NULL,
  audio_url TEXT NOT NULL,
  image TEXT NULL,
  published_at VARCHAR(80) NULL,
  duration_sec INT UNSIGNED NOT NULL DEFAULT 0,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_queue_device_episode (device_id, episode_id),
  KEY idx_queue_device_order (device_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
