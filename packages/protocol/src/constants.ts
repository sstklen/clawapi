// 共享常數（SPEC-C §3 + §7）

// === Base URLs ===
export const BASE_URL_PRODUCTION = 'https://api.clawapi.com/v1';
export const BASE_URL_DEVELOPMENT = 'https://dev.clawapi.com/v1';

// === 版本 ===
export const PROTOCOL_VERSION = '1.0';
export const SCHEMA_VERSION = 1;

// === WebSocket ===
export const WS_PING_INTERVAL_MS = 30_000;   // ping 每 30 秒
export const WS_PONG_TIMEOUT_MS = 10_000;     // pong 超時 10 秒
export const WS_RECONNECT_BASE_MS = 1_000;    // 重連基底 1 秒
export const WS_RECONNECT_MAX_MS = 300_000;   // 重連上限 5 分鐘
export const WS_RATE_LIMIT_DISCONNECT_THRESHOLD = 10;  // 連續超限 10 次斷線
export const WS_RATE_LIMIT_BAN_MS = 300_000;  // 禁止重連 5 分鐘
export const WS_OFFLINE_QUEUE_MAX = 20;       // 離線訊息佇列最多 20 條

// === WS 頻道 ===
export const WS_CHANNELS = ['routing', 'chat', 'notifications'] as const;
export type WSChannel = typeof WS_CHANNELS[number];

// === Rate Limits（SPEC-C §7.1）===
export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'POST /v1/devices/register':      { limit: 5,  windowSeconds: 3600 },
  'POST /v1/devices/refresh':       { limit: 10, windowSeconds: 3600 },
  'POST /v1/devices/reset':         { limit: 3,  windowSeconds: 86400 },
  'POST /v1/auth/google':           { limit: 10, windowSeconds: 3600 },
  'POST /v1/telemetry/batch':       { limit: 2,  windowSeconds: 3600 },
  'POST /v1/telemetry/feedback':    { limit: 20, windowSeconds: 3600 },
  'GET /v1/telemetry/quota':        { limit: 30, windowSeconds: 3600 },
  'GET /v1/l0/keys':                { limit: 10, windowSeconds: 3600 },
  'POST /v1/l0/usage':              { limit: 60, windowSeconds: 3600 },
  'POST /v1/l0/donate':             { limit: 5,  windowSeconds: 86400 },
  'POST /v1/aid/request':           { limit: 30, windowSeconds: 3600 },
  'PUT /v1/aid/config':             { limit: 10, windowSeconds: 3600 },
  'GET /v1/aid/config':             { limit: 30, windowSeconds: 3600 },
  'GET /v1/aid/stats':              { limit: 30, windowSeconds: 3600 },
  'GET /v1/version/check':          { limit: 5,  windowSeconds: 3600 },
  'GET /v1/adapters/updates':       { limit: 5,  windowSeconds: 3600 },
  'GET /v1/adapters/official':      { limit: 10, windowSeconds: 3600 },
  'PUT /v1/backup':                 { limit: 5,  windowSeconds: 86400 },
  'GET /v1/backup':                 { limit: 10, windowSeconds: 86400 },
  'DELETE /v1/backup':              { limit: 3,  windowSeconds: 86400 },
  'POST /v1/subkeys/validate':      { limit: 60, windowSeconds: 3600 },
};

// === WS Rate Limits（SPEC-C §7.3）===
export const WS_RATE_LIMITS = {
  chat: { limit: 1, windowSeconds: 5 },
  aid_response: { limit: 5, windowSeconds: 10 },
  other: { limit: 10, windowSeconds: 1 },
} as const;

// === 互助常數 ===
export const AID_COOLDOWN_BASE_MS = 60_000;       // 冷卻基底 60 秒
export const AID_COOLDOWN_MAX_MS = 240_000;        // 冷卻上限 240 秒
export const AID_TIMEOUT_MS = 30_000;              // 互助超時 30 秒
export const AID_PAYLOAD_MAX_BYTES = 1_048_576;    // 1MB
export const AID_DAILY_LIMIT_DEFAULT = 30;         // 每日互助上限

// === L0 常數 ===
export const L0_CACHE_TTL_MS = 21_600_000;         // 6 小時
export const L0_DONATE_MAX_PER_DAY = 5;

// === 裝置常數 ===
export const DEVICE_TOKEN_EXPIRY_DAYS = 120;
export const DEVICE_TOKEN_REFRESH_DAYS_BEFORE = 7;  // 到期前 7 天自動刷新
export const DEVICE_MAX_PER_IP = 5;                 // 同 IP 最多 5 個 device

// === 備份常數 ===
export const BACKUP_MAX_SIZE_BYTES = 52_428_800;   // 50MB

// === 遙測常數 ===
export const TELEMETRY_BATCH_MAX_BYTES = 512_000;  // 500KB
export const TELEMETRY_UPLOAD_INTERVAL_MS = 3_600_000;  // 1 小時
export const TELEMETRY_UPLOAD_JITTER_MS = 300_000;      // 隨機 0-5 分鐘

// === 聊天常數 ===
export const CHAT_MESSAGE_MAX_LENGTH = 500;

// === 信譽常數 ===
export const REPUTATION_NEW_WEIGHT = 0.3;    // 新龍蝦（3 天內）
export const REPUTATION_MAX_WEIGHT = 1.5;    // 老龍蝦

// === 離線模式 ===
export const OFFLINE_THRESHOLD_503_COUNT = 5;     // 連續 5 次 503 → 離線
export const OFFLINE_PROBE_INTERVAL_MS = 300_000; // 5 分鐘探測
export const OFFLINE_QUEUE_MAX_DAYS = 30;          // 佇列最多 30 天

// === 版本 ===
export const CLAWAPI_VERSION = '0.1.9';
