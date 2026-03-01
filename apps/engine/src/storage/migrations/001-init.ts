// Migration 001：初始 Schema
// 建立所有 15 張資料表

export interface Migration {
  version: number;
  description: string;
  up: string;    // 建立 SQL
  down: string;  // 回退 SQL（測試用）
}

export const migration001: Migration = {
  version: 1,
  description: '初始 schema — 建立 15 張資料表',

  up: `
    -- ===== Schema 版本管理 =====
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      description TEXT
    );

    -- ===== 裝置身份 =====
    CREATE TABLE IF NOT EXISTS device (
      device_id                TEXT PRIMARY KEY,
      device_fingerprint       TEXT NOT NULL,
      device_token             TEXT,
      device_token_expires_at  TEXT,
      vps_public_key           TEXT,
      vps_public_key_id        TEXT,
      assigned_region          TEXT,
      google_id                TEXT,
      google_email_masked      TEXT,
      nickname                 TEXT,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ===== ECDH 金鑰對 =====
    CREATE TABLE IF NOT EXISTS device_keypair (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      public_key            TEXT    NOT NULL,
      private_key_encrypted BLOB    NOT NULL,
      is_current            INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at            TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_keypair_current
      ON device_keypair(is_current) WHERE is_current = 1;

    -- ===== API Key 池 =====
    CREATE TABLE IF NOT EXISTS keys (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id           TEXT    NOT NULL,
      key_encrypted        BLOB    NOT NULL,
      pool_type            TEXT    NOT NULL CHECK (pool_type IN ('king', 'friend')),
      label                TEXT,
      status               TEXT    NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'rate_limited', 'dead')),
      priority             INTEGER NOT NULL DEFAULT 0,
      pinned               INTEGER NOT NULL DEFAULT 0,
      daily_used           INTEGER NOT NULL DEFAULT 0,
      monthly_used         INTEGER NOT NULL DEFAULT 0,
      estimated_quota      INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      rate_limit_until     TEXT,
      last_success_at      TEXT,
      last_error           TEXT,
      created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_keys_service ON keys(service_id, status);
    CREATE INDEX IF NOT EXISTS idx_keys_pool    ON keys(pool_type, service_id);

    -- ===== 金鑰匙 =====
    CREATE TABLE IF NOT EXISTS gold_keys (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id    TEXT    NOT NULL,
      key_encrypted BLOB    NOT NULL,
      model_id      TEXT    NOT NULL,
      is_active     INTEGER NOT NULL DEFAULT 1,
      daily_used    INTEGER NOT NULL DEFAULT 0,
      daily_limit   INTEGER,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ===== Sub-Key =====
    CREATE TABLE IF NOT EXISTS sub_keys (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      token               TEXT    UNIQUE NOT NULL,
      label               TEXT,
      daily_limit         INTEGER,
      daily_used          INTEGER NOT NULL DEFAULT 0,
      allowed_services    TEXT,
      allowed_models      TEXT,
      rate_limit_per_hour INTEGER,
      rate_used_this_hour INTEGER NOT NULL DEFAULT 0,
      rate_hour_start     TEXT,
      is_active           INTEGER NOT NULL DEFAULT 1,
      expires_at          TEXT,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      last_used_at        TEXT,
      total_requests      INTEGER NOT NULL DEFAULT 0,
      total_tokens        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_subkeys_token
      ON sub_keys(token) WHERE is_active = 1;

    -- ===== 使用紀錄 =====
    CREATE TABLE IF NOT EXISTS usage_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        TEXT    NOT NULL DEFAULT (datetime('now')),
      service_id       TEXT    NOT NULL,
      model            TEXT,
      layer            TEXT    NOT NULL CHECK (layer IN ('L0','L1','L2','L3','L4')),
      key_id           INTEGER,
      sub_key_id       INTEGER,
      pool_source      TEXT,
      success          INTEGER NOT NULL,
      latency_ms       INTEGER NOT NULL,
      error_code       TEXT,
      tokens_input     INTEGER,
      tokens_output    INTEGER,
      routing_strategy TEXT,
      retry_count      INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_service   ON usage_log(service_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_subkey    ON usage_log(sub_key_id)
      WHERE sub_key_id IS NOT NULL;

    -- ===== L0 公共 Key 快取 =====
    CREATE TABLE IF NOT EXISTS l0_keys (
      id                    TEXT PRIMARY KEY,
      service_id            TEXT NOT NULL,
      key_encrypted         TEXT,
      encryption_method     TEXT,
      encryption_key_id     TEXT,
      status                TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'degraded', 'dead')),
      daily_quota_per_device INTEGER,
      total_daily_quota     INTEGER,
      total_daily_used      INTEGER,
      donated_by            TEXT,
      updated_at            TEXT NOT NULL
    );

    -- ===== L0 個人用量 =====
    CREATE TABLE IF NOT EXISTS l0_device_usage (
      service_id  TEXT    NOT NULL,
      date        TEXT    NOT NULL,
      used_count  INTEGER NOT NULL DEFAULT 0,
      limit_count INTEGER NOT NULL,
      PRIMARY KEY (service_id, date)
    );

    -- ===== 路由建議快取 =====
    CREATE TABLE IF NOT EXISTS routing_intel (
      service_id     TEXT NOT NULL,
      region         TEXT NOT NULL,
      status         TEXT NOT NULL,
      confidence     REAL NOT NULL,
      success_rate   REAL,
      avg_latency_ms INTEGER,
      p95_latency_ms INTEGER,
      sample_size    INTEGER,
      note           TEXT,
      updated_at     TEXT NOT NULL,
      valid_until    TEXT NOT NULL,
      PRIMARY KEY (service_id, region)
    );

    -- ===== 互助設定 =====
    CREATE TABLE IF NOT EXISTS aid_config (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      enabled            INTEGER NOT NULL DEFAULT 0,
      allowed_services   TEXT,
      daily_limit        INTEGER NOT NULL DEFAULT 50,
      daily_given        INTEGER NOT NULL DEFAULT 0,
      blackout_hours     TEXT,
      helper_public_key  TEXT,
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO aid_config (id, enabled) VALUES (1, 0);

    -- ===== 互助記錄 =====
    CREATE TABLE IF NOT EXISTS aid_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      aid_id     TEXT    NOT NULL,
      timestamp  TEXT    NOT NULL DEFAULT (datetime('now')),
      direction  TEXT    NOT NULL CHECK (direction IN ('given', 'received')),
      service_id TEXT    NOT NULL,
      success    INTEGER NOT NULL,
      latency_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_aid_log_direction
      ON aid_log(direction, timestamp);
    CREATE INDEX IF NOT EXISTS idx_aid_log_aid_id
      ON aid_log(aid_id);

    -- ===== 統計上報佇列 =====
    CREATE TABLE IF NOT EXISTS telemetry_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id    TEXT    UNIQUE NOT NULL,
      payload     BLOB    NOT NULL,
      period_from TEXT    NOT NULL,
      period_to   TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_queue_created
      ON telemetry_queue(created_at);

    -- ===== L0 用量上報佇列 =====
    CREATE TABLE IF NOT EXISTS l0_usage_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      payload    TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ===== 設定 KV 儲存 =====
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,

  down: `
    -- 依照外鍵相依性，反序刪除
    DROP TABLE IF EXISTS settings;
    DROP TABLE IF EXISTS l0_usage_queue;
    DROP TABLE IF EXISTS telemetry_queue;
    DROP TABLE IF EXISTS aid_log;
    DROP TABLE IF EXISTS aid_config;
    DROP TABLE IF EXISTS routing_intel;
    DROP TABLE IF EXISTS l0_device_usage;
    DROP TABLE IF EXISTS l0_keys;
    DROP TABLE IF EXISTS usage_log;
    DROP TABLE IF EXISTS sub_keys;
    DROP TABLE IF EXISTS gold_keys;
    DROP TABLE IF EXISTS keys;
    DROP TABLE IF EXISTS device_keypair;
    DROP TABLE IF EXISTS device;
    DROP TABLE IF EXISTS schema_version;
  `,
};

export default migration001;
