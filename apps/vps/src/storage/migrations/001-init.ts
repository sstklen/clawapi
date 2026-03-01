// Migration 001：初始 Schema
// 建立所有 21 張資料表（VPS 端）

export interface Migration {
  version: number;
  description: string;
  up: string;    // 建立 SQL
  down: string;  // 回退 SQL（測試用）
}

export const migration001: Migration = {
  version: 1,
  description: '初始 schema — 建立 21 張資料表（VPS 服務）',

  up: `
    -- ===== 裝置管理 =====

    -- 龍蝦裝置表（含 timezone、region、vps_public_key 欄位）
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      device_fingerprint TEXT NOT NULL,
      device_token TEXT NOT NULL,
      token_expires_at TEXT NOT NULL,
      client_version TEXT NOT NULL,
      os TEXT NOT NULL,
      arch TEXT NOT NULL,
      locale TEXT DEFAULT 'en',
      timezone TEXT DEFAULT 'UTC',
      region TEXT DEFAULT 'other',
      assigned_region TEXT DEFAULT 'other',
      vps_public_key_id TEXT,
      reputation_weight REAL DEFAULT 1.0,
      reputation_tier TEXT DEFAULT 'new',
      anomaly_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      suspended_reason TEXT,
      google_id_hash TEXT,
      google_email_masked TEXT,
      nickname TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_devices_region ON devices(assigned_region);
    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
    CREATE INDEX IF NOT EXISTS idx_devices_google ON devices(google_id_hash);
    CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token ON devices(device_token);

    -- ===== 集體智慧數據 =====

    -- 原始遙測數據
    CREATE TABLE IF NOT EXISTS telemetry_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT UNIQUE NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(device_id),
      region TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      total_requests INTEGER,
      success_rate REAL,
      reputation_weight REAL DEFAULT 1.0,
      raw_data BLOB,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_device ON telemetry_batches(device_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_received ON telemetry_batches(received_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_region ON telemetry_batches(region);

    -- 遙測條目（從 batch 展開）
    CREATE TABLE IF NOT EXISTS telemetry_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL REFERENCES telemetry_batches(batch_id),
      device_id TEXT NOT NULL,
      region TEXT NOT NULL,
      service_id TEXT NOT NULL,
      model TEXT,
      tier TEXT,
      outcome TEXT NOT NULL,
      latency_ms INTEGER,
      token_input INTEGER,
      token_output INTEGER,
      routing_strategy TEXT,
      retry_count INTEGER DEFAULT 0,
      time_bucket TEXT,
      reputation_weight REAL DEFAULT 1.0,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_service ON telemetry_entries(service_id);
    CREATE INDEX IF NOT EXISTS idx_entries_region_service ON telemetry_entries(region, service_id);
    CREATE INDEX IF NOT EXISTS idx_entries_received ON telemetry_entries(received_at);
    CREATE INDEX IF NOT EXISTS idx_entries_outcome ON telemetry_entries(outcome);

    -- 路由建議（每小時分析結果）
    CREATE TABLE IF NOT EXISTS routing_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id TEXT UNIQUE NOT NULL,
      service_id TEXT NOT NULL,
      region TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      success_rate REAL,
      avg_latency_ms INTEGER,
      p95_latency_ms INTEGER,
      sample_size INTEGER,
      note TEXT,
      generated_at TEXT NOT NULL,
      valid_until TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recommendations_region ON routing_recommendations(region);
    CREATE INDEX IF NOT EXISTS idx_recommendations_generated ON routing_recommendations(generated_at);

    -- 服務警報
    CREATE TABLE IF NOT EXISTS service_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL,
      service_id TEXT,
      region TEXT DEFAULT 'global',
      message TEXT NOT NULL,
      started_at TEXT NOT NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ===== 回饋記錄 =====

    CREATE TABLE IF NOT EXISTS telemetry_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(device_id),
      recommendation_id TEXT,
      service_id TEXT NOT NULL,
      feedback TEXT NOT NULL,
      reason TEXT,
      comment TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_service ON telemetry_feedback(service_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON telemetry_feedback(created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_device ON telemetry_feedback(device_id);

    -- 回饋聚合（加速查詢）
    CREATE TABLE IF NOT EXISTS feedback_aggregation (
      service_id TEXT NOT NULL,
      region TEXT NOT NULL,
      period_hour TEXT NOT NULL,
      positive_count INTEGER DEFAULT 0,
      negative_count INTEGER DEFAULT 0,
      PRIMARY KEY (service_id, region, period_hour)
    );

    -- ===== L0 公共 Key 表 =====

    CREATE TABLE IF NOT EXISTS l0_keys (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      key_value_encrypted BLOB,
      key_hash TEXT,
      encryption_key_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      daily_quota INTEGER,
      daily_used INTEGER DEFAULT 0,
      daily_reset_at TEXT,
      donated_by_device_id TEXT,
      donated_by_display TEXT,
      is_anonymous_donation INTEGER DEFAULT 0,
      last_health_check TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_l0_service ON l0_keys(service_id);
    CREATE INDEX IF NOT EXISTS idx_l0_status ON l0_keys(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_l0_key_hash ON l0_keys(key_hash);

    -- L0 每裝置每日用量
    CREATE TABLE IF NOT EXISTS l0_device_usage (
      device_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      date TEXT NOT NULL,
      used_count INTEGER DEFAULT 0,
      daily_limit INTEGER NOT NULL,
      PRIMARY KEY (device_id, service_id, date)
    );

    -- ===== 互助記錄表 =====

    -- 互助設定
    CREATE TABLE IF NOT EXISTS aid_configs (
      device_id TEXT PRIMARY KEY REFERENCES devices(device_id),
      enabled INTEGER DEFAULT 0,
      allowed_services TEXT,
      daily_limit INTEGER DEFAULT 50,
      daily_given INTEGER DEFAULT 0,
      daily_reset_at TEXT,
      blackout_hours TEXT,
      helper_public_key TEXT,
      helper_public_key_updated_at TEXT,
      aid_success_rate REAL DEFAULT 0.5,
      avg_aid_latency_ms INTEGER DEFAULT 10000,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_aid_enabled ON aid_configs(enabled);

    -- 互助請求記錄
    CREATE TABLE IF NOT EXISTS aid_records (
      id TEXT PRIMARY KEY,
      requester_device_id TEXT NOT NULL,
      helper_device_id TEXT,
      service_id TEXT NOT NULL,
      request_type TEXT NOT NULL,
      requester_public_key TEXT,
      helper_public_key TEXT,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      timeout_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_aid_requester ON aid_records(requester_device_id);
    CREATE INDEX IF NOT EXISTS idx_aid_helper ON aid_records(helper_device_id);
    CREATE INDEX IF NOT EXISTS idx_aid_status ON aid_records(status);
    CREATE INDEX IF NOT EXISTS idx_aid_created ON aid_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_aid_records_device_service_time
      ON aid_records(requester_device_id, service_id, created_at);

    -- 互助統計（按裝置累計）
    CREATE TABLE IF NOT EXISTS aid_stats (
      device_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      service_id TEXT NOT NULL,
      total_count INTEGER DEFAULT 0,
      month_count INTEGER DEFAULT 0,
      month_key TEXT,
      PRIMARY KEY (device_id, direction, service_id)
    );

    -- 防刷單記錄
    CREATE TABLE IF NOT EXISTS aid_suspicious (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_suspicious_device ON aid_suspicious(device_id);

    -- ===== 備份元數據表 =====

    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id_hash TEXT NOT NULL,
      device_id TEXT NOT NULL,
      backup_version INTEGER NOT NULL DEFAULT 1,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      expires_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_backup_google ON backups(google_id_hash);
    CREATE INDEX IF NOT EXISTS idx_backup_expires ON backups(expires_at);

    -- ===== Sub-Key 驗證快取表 =====

    CREATE TABLE IF NOT EXISTS subkey_validation_cache (
      cache_key TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subkey_cache_expires ON subkey_validation_cache(expires_at);

    -- ===== 系統表 =====

    -- DB 版本管理
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT
    );

    -- VPS ECDH 金鑰記錄
    CREATE TABLE IF NOT EXISTS vps_key_history (
      key_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      retired_at TEXT,
      is_current INTEGER DEFAULT 1
    );

    -- 存取日誌（7 天保留）
    CREATE TABLE IF NOT EXISTS access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER,
      ip_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_access_created ON access_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_access_device ON access_log(device_id);

    -- 異常偵測記錄
    CREATE TABLE IF NOT EXISTS anomaly_detections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      anomaly_type TEXT NOT NULL,
      reasons TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_anomaly_device ON anomaly_detections(device_id);

    -- 告警歷史
    CREATE TABLE IF NOT EXISTS alert_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL,
      channel TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ===== 聚合統計表（冷啟動路由用）=====

    CREATE TABLE IF NOT EXISTS telemetry_aggregated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT,
      region TEXT NOT NULL,
      success_rate REAL NOT NULL,
      latency_p95 INTEGER NOT NULL,
      sample_count INTEGER NOT NULL,
      aggregated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_aggregated_at ON telemetry_aggregated(aggregated_at);
    CREATE INDEX IF NOT EXISTS idx_aggregated_provider ON telemetry_aggregated(provider, model, region);
  `,

  down: `
    -- 依照外鍵相依性，反序刪除
    DROP TABLE IF EXISTS telemetry_aggregated;
    DROP TABLE IF EXISTS alert_history;
    DROP TABLE IF EXISTS anomaly_detections;
    DROP TABLE IF EXISTS access_log;
    DROP TABLE IF EXISTS vps_key_history;
    DROP TABLE IF EXISTS schema_version;
    DROP TABLE IF EXISTS subkey_validation_cache;
    DROP TABLE IF EXISTS backups;
    DROP TABLE IF EXISTS aid_suspicious;
    DROP TABLE IF EXISTS aid_stats;
    DROP TABLE IF EXISTS aid_records;
    DROP TABLE IF EXISTS aid_configs;
    DROP TABLE IF EXISTS l0_device_usage;
    DROP TABLE IF EXISTS l0_keys;
    DROP TABLE IF EXISTS feedback_aggregation;
    DROP TABLE IF EXISTS telemetry_feedback;
    DROP TABLE IF EXISTS service_alerts;
    DROP TABLE IF EXISTS routing_recommendations;
    DROP TABLE IF EXISTS telemetry_entries;
    DROP TABLE IF EXISTS telemetry_batches;
    DROP TABLE IF EXISTS devices;
  `,
};

export default migration001;
