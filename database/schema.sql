-- NordPod schema (2026-07 rebuild). Runs in the shared one.com `aogj_com` DB, so every
-- table is prefixed `podcast_` to avoid colliding with the other projects that share it.
-- Idempotent: safe to run repeatedly. Also created on demand via api/index.php?action=migrate.
--
-- Design (single-user for now, but device_id is carried everywhere so real accounts can be
-- added later without a schema change — a login would just map to a stable device_id/user_id).
-- "Favorites only": the old favorites/subscriptions split is gone. A favorite = a podcast you
-- follow. Episodes are cached globally per feed (they're the same for everyone); the per-device
-- played/position state is what makes an episode "grey" and drives the newest-unheard queue.

CREATE TABLE IF NOT EXISTS podcast_favorites (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id    VARCHAR(80)  NOT NULL,
  feed_id      BIGINT       NOT NULL COMMENT 'Podcast Index feed id',
  title        VARCHAR(255) NOT NULL,
  image        TEXT NULL,
  author       VARCHAR(255) NULL,
  language     VARCHAR(80)  NULL,
  feed_url     TEXT NULL,
  added_via    VARCHAR(16)  NOT NULL DEFAULT 'search' COMMENT 'search | url',
  last_fetched DATETIME NULL COMMENT 'when episodes for this feed were last refreshed',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_fav_device_feed (device_id, feed_id),
  KEY idx_fav_device_created (device_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS podcast_episodes (
  feed_id      BIGINT NOT NULL,
  episode_id   BIGINT NOT NULL COMMENT 'Podcast Index episode id',
  title        VARCHAR(512) NOT NULL,
  description  TEXT NULL,
  published_at INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'unix seconds',
  audio_url    TEXT NULL COMMENT 'enclosure; NULL/empty = not playable in-app (link out, e.g. DR/Podimo)',
  link_url     TEXT NULL COMMENT 'episode/show web page to open at the provider',
  image        TEXT NULL,
  duration_sec INT UNSIGNED NOT NULL DEFAULT 0,
  fetched_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (feed_id, episode_id),
  KEY idx_ep_published (published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS podcast_episode_state (
  device_id    VARCHAR(80) NOT NULL,
  episode_id   BIGINT      NOT NULL,
  feed_id      BIGINT      NOT NULL,
  played_at    DATETIME NULL COMMENT 'set when heard (auto on finish, or manual for link-out) — NULL = unheard',
  position_sec INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'resume position',
  duration_sec INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, episode_id),
  KEY idx_state_device_played (device_id, played_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
