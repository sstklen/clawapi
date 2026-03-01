# ClawAPI SPEC-C：通訊協議規格書 v1.0

> **龍蝦本機引擎 ↔ VPS 服務之間的合約**
> 這份文件定義了開源引擎（SPEC-A）和 VPS 服務（SPEC-B）之間所有通訊介面。
> 最後更新：2026-03-01（v1.4 修訂）
> 狀態：草案，待 tkman 確認

---

## 目錄

1. [設計原則](#1-設計原則)
2. [認證與身份](#2-認證與身份)
3. [VPS 端點總覽](#3-vps-端點總覽)
4. [HTTPS API 詳細規格](#4-https-api-詳細規格)
   - 4.1 [裝置註冊](#41-裝置註冊)
   - 4.2 [集體智慧上報](#42-集體智慧上報)
   - 4.3 [L0 公共 Key 下發](#43-l0-公共-key-下發)
   - 4.4 [L0 用量回報](#44-l0-用量回報)
   - 4.5 [互助請求](#45-互助請求)
   - 4.6 [互助配置同步](#46-互助配置同步)
   - 4.7 [版本檢查](#47-版本檢查)
   - 4.8 [Adapter 更新檢查](#48-adapter-更新檢查)
   - 4.9 [雲端備份](#49-雲端備份v11)
   - 4.10 [Sub-Key VPS 驗證中繼](#410-sub-key-vps-驗證中繼129)
5. [WebSocket 詳細規格](#5-websocket-詳細規格)
   - 5.1 [連線管理](#51-連線管理)
   - 5.2 [路由建議推送](#52-路由建議推送)
   - 5.3 [聊天室](#53-聊天室)
   - 5.4 [即時通知](#54-即時通知)
6. [錯誤處理](#6-錯誤處理)
7. [Rate Limit](#7-rate-limit)
8. [安全模型](#8-安全模型)
9. [離線行為](#9-離線行為)
10. [版本演進策略](#10-版本演進策略)

---

## 1. 設計原則

### 1.1 三條鐵律

```
鐵律 1：Key 永遠不過 VPS
  → 龍蝦的 API Key 只存在本機，永遠直連上游 API
  → VPS 不知道龍蝦有哪些 Key、Key 的值是什麼
  → 唯一例外：L0 公共 Key（本來就是平台資產）

鐵律 2：VPS 看不到 API 內容
  → VPS 只知道「誰用了什麼服務、成功還是失敗」
  → 不知道「問了什麼、回答了什麼」
  → 互助中繼時 VPS 轉發加密 payload，不解密

鐵律 3：龍蝦離線照常工作
  → VPS 掛了，L1/L2/L3/L4 全部正常（只是沒有集體智慧加持）
  → 待上報的數據本機堆 30 天，VPS 恢復後自動補傳
  → L0 公共 Key 有本機快取，VPS 掛了也能撐一段時間
```

### 1.2 通訊架構圖

```
┌─────────────────────────────────────────────────────────┐
│                     龍蝦本機引擎                          │
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────┐    │
│  │ 統計收集器  │  │ L0 管理器  │  │ 互助客戶端       │    │
│  └─────┬──────┘  └─────┬──────┘  └────────┬────────┘    │
│        │               │                  │              │
│  ┌─────┴───────────────┴──────────────────┴──────┐      │
│  │              VPS 通訊模組                       │      │
│  │  ┌──────────────────────────────────────────┐ │      │
│  │  │  HTTPS Client  │  WebSocket Client       │ │      │
│  │  └──────────────────────────────────────────┘ │      │
│  └─────────────────────┬─────────────────────────┘      │
│                        │                                 │
└────────────────────────┼─────────────────────────────────┘
                         │
              ╔══════════╪══════════╗
              ║  TLS 1.3 (HTTPS)   ║
              ║  + WSS (WebSocket) ║
              ╚══════════╪══════════╝
                         │
┌────────────────────────┼─────────────────────────────────┐
│                        │                                  │
│  ┌─────────────────────┴─────────────────────────┐       │
│  │              API Gateway (Hono)                │       │
│  │  ┌──────────────────────────────────────────┐ │       │
│  │  │  Rate Limiter  │  Auth Middleware        │ │       │
│  │  └──────────────────────────────────────────┘ │       │
│  └─────┬───────────────┬──────────────────┬──────┘       │
│        │               │                  │               │
│  ┌─────┴──────┐  ┌─────┴──────┐  ┌───────┴─────────┐    │
│  │ 集體智慧    │  │ L0 管理    │  │ 互助配對引擎     │    │
│  │ 分析引擎    │  │ 下發器     │  │ + 中繼          │    │
│  └────────────┘  └────────────┘  └─────────────────┘    │
│                                                          │
│                     VPS 服務                              │
└──────────────────────────────────────────────────────────┘
```

### 1.3 協議選擇

| 用途 | 協議 | 原因 |
|------|------|------|
| 一般 API 請求 | HTTPS (TLS 1.3) | 安全、可靠、防火牆友好 |
| 即時推送 | WSS (WebSocket over TLS) | 路由建議、聊天室需要即時推送 |
| 統計上報 payload | MessagePack | 比 JSON 省 30-40% 流量，龍蝦可能在手機熱點 |
| 其他所有 payload | JSON | 人類可讀、debug 友好 |

---

## 2. 認證與身份

### 2.1 裝置身份（device_id）

```
產生時機：首次安裝 ClawAPI 時自動產生
格式：     clw_{32 字元隨機 hex}
範例：     clw_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
存放位置： ~/.clawapi/data.db → devices 表
永久性：   永久不變（除非龍蝦手動重置）
```

#### device_id 產生邏輯

```typescript
// SPEC-A 引擎端實作
interface DeviceIdentity {
  device_id: string;        // clw_xxxx（主要識別碼）
  device_fingerprint: string; // 硬體指紋（輔助防濫用）
  created_at: string;        // ISO 8601
}

// 硬體指紋組成（取 SHA-256 前 16 字元）：
// - OS 類型 + 版本
// - CPU 型號
// - 總記憶體大小
// - 主硬碟序號（如果可取得）
// → 不是唯一識別，是輔助防濫用的「差不多夠用」的指紋
```

### 2.2 認證 Token

```
每次 VPS 請求必須帶的 Header：

  X-Device-Id:    clw_a1b2c3d4...
  X-Device-Token: dtoken_xxxxxxxxxxxxxxxx
  X-Client-Version: 1.0.0
  Content-Type:   application/json（或 application/msgpack）
```

#### Token 取得流程

```
首次安裝 → POST /v1/devices/register → 拿到 device_token
之後每次請求帶 X-Device-Id + X-Device-Token
Token 過期 → 401 → 自動 POST /v1/devices/refresh → 拿新 token
```

### 2.3 可選 Google 登入（v1.1+）

```
用途：解鎖雲端備份 + 跨裝置同步 + 暱稱
流程：OAuth2 → 取得 Google ID token → POST /v1/auth/google → 綁定到 device_id
不登入也能用：所有 MVP 功能都不需要 Google 登入
```

---

## 3. VPS 端點總覽

### 3.1 Base URL

```
生產環境：  https://api.clawapi.com/v1/
開發環境：  https://dev.clawapi.com/v1/
```

### 3.2 完整端點清單

```
HTTPS 端點（REST API）
─────────────────────────────────────────────────────────────

POST   /v1/devices/register          裝置註冊（首次安裝）
POST   /v1/devices/refresh           Token 刷新
POST   /v1/devices/reset             裝置重置（重新註冊用）

POST   /v1/auth/google               Google 帳號綁定（v1.1+）

POST   /v1/telemetry/batch           集體智慧批次上報
POST   /v1/telemetry/feedback        路由推薦回饋（👍👎）
GET    /v1/telemetry/quota           查詢上報配額
GET    /v1/telemetry/route-suggestions  取得最新路由建議（重連/離線恢復用）<!-- v1.2 修訂 -->

GET    /v1/l0/keys                   L0 公共 Key 下發
POST   /v1/l0/usage                  L0 用量回報
POST   /v1/l0/donate                 捐 Key 給 L0 公共池

POST   /v1/aid/request               互助請求（龍蝦 B 發起）
POST   /v1/aid/relay                 互助中繼（VPS → 龍蝦 A，內部用）
PUT    /v1/aid/config                互助設定更新
GET    /v1/aid/config                互助設定查詢
GET    /v1/aid/stats                 互助統計（我幫了多少/被幫了多少）

GET    /v1/version/check             版本檢查
GET    /v1/adapters/updates          Adapter 更新清單
GET    /v1/adapters/official         官方 Adapter 清單

PUT    /v1/backup                    雲端備份上傳（v1.1+）
GET    /v1/backup                    雲端備份下載（v1.1+）
DELETE /v1/backup                    雲端備份刪除（v1.1+）

POST   /v1/subkeys/validate          Sub-Key 驗證中繼（#129）

WebSocket 端點
─────────────────────────────────────────────────────────────

WSS    /v1/ws                        主 WebSocket 連線（多工）
                                     → 頻道：routing（路由建議推送）
                                     → 頻道：chat（聊天室）
                                     → 頻道：notifications（系統通知）
                                     → 訊息類型：aid_data（互助加密數據，客戶端↔VPS 原封轉發）<!-- v1.4 修訂 -->
```

### 3.3 為什麼用單一 WebSocket 連線

```
方案 A：每個功能一條 WebSocket ← 浪費連線數
方案 B：一條 WebSocket + 頻道多工 ← 選這個 ✅

原因：
- 龍蝦可能在弱網路環境，一條連線省資源
- 伺服器端用頻道多工，管理簡單
- 如果某個頻道不需要，客戶端不訂閱就好
```

---

## 4. HTTPS API 詳細規格

### 4.1 裝置註冊

```
POST /v1/devices/register

用途：龍蝦首次安裝 ClawAPI 時，向 VPS 註冊拿 token

───── Request ─────
{
  "device_id": "clw_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  "device_fingerprint": "fp_8a7b6c5d4e3f2a1b",
  "client_version": "1.0.0",
  "os": "darwin",           // "darwin" | "linux" | "win32"
  "arch": "arm64",          // "arm64" | "x64"
  "locale": "zh-TW",        // 偏好語言
  "timezone": "Asia/Tokyo",  // IANA 時區（用於每日額度重置，#83）
  "region": "asia"           // "asia" | "europe" | "americas" | "other"（自動偵測或手動，#88）
}

───── Response 200 ─────
{
  "device_token": "dtoken_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "token_expires_at": "2026-06-28T00:00:00Z",  // 120 天後
  "l0_config": {            // 順便下發 L0 設定，省一次請求
    "daily_limit": 20,
    "services": ["groq", "duckduckgo"]
  },
  "vps_public_key": "base64_VPS的ECDH_P256公鑰...",    // VPS↔龍蝦安全通訊用（如加密備份、L0 Key 下發）<!-- v1.2 修訂 -->
  "vps_public_key_id": "vps_key_v1",                    // 版本化
  "assigned_region": "asia",   // VPS 根據 IP/timezone 判定的地區（#88）
  "latest_version": "1.0.0",
  "server_time": "2026-02-28T12:00:00Z"
}

───── Response 409 ─────（device_id 已存在）
{
  "error": "DEVICE_ALREADY_REGISTERED",
  "message": "此裝置已註冊。如需重新註冊請先 POST /v1/devices/reset",
  "suggestion": "clawapi device reset"
}
```

#### 裝置重置

```
POST /v1/devices/reset

用途：龍蝦需要重新註冊時（裝置故障、本機 DB 損壞等）

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx（需要舊 token 證明身份）

───── Response 200 ─────
{
  "reset": true,
  "message": "裝置已重置，請重新 POST /v1/devices/register"
}

───── Response 403 ─────（device_id 和 token 不匹配）
{
  "error": "DEVICE_TOKEN_MISMATCH",
  "message": "裝置身份驗證失敗，無法重置",
  "suggestion": "請聯繫支援"
}

注意：重置後，舊 token 立即失效。
VPS 保留該 device_id 的歷史統計（匿名數據不刪）。
重新 register 後會拿到新的 token。
```

#### Token 刷新

```
POST /v1/devices/refresh

用途：Token 過期或即將過期時刷新

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx（即使過期也要帶，用來驗證身份）

───── Response 200 ─────
{
  "device_token": "dtoken_yyyyyyyyyyyyyyyyyyyy",   // 新 token
  "token_expires_at": "2026-10-28T00:00:00Z"
}

───── Response 403 ─────（device_id 和 token 不匹配）
{
  "error": "DEVICE_TOKEN_MISMATCH",
  "message": "裝置身份驗證失敗",
  "suggestion": "clawapi device reset"
}
```

### 4.1.1 Google 帳號綁定（v1.1+）

```
POST /v1/auth/google

用途：綁定 Google 帳號到 device_id，解鎖雲端備份 + 暱稱

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx

Body:
{
  "google_id_token": "eyJhbGciOiJS...",   // Google OAuth2 取得的 ID Token
  "requested_nickname": "龍蝦小明"          // 可選，設定暱稱
}

───── Response 200 ─────
{
  "bound": true,
  "google_email": "user@gmail.com",        // 只顯示前 3 字元 + ***
  "nickname": "龍蝦小明",
  "features_unlocked": ["backup", "nickname", "cross_device_sync"]
}

───── Response 409 ─────（此 Google 帳號已綁定其他 device_id）
{
  "error": "AUTH_GOOGLE_ALREADY_BOUND",
  "message": "此 Google 帳號已綁定到其他裝置",
  "suggestion": "如需轉移，請先在舊裝置解綁"
}

───── Response 400 ─────
{
  "error": "AUTH_GOOGLE_TOKEN_INVALID",
  "message": "Google token 無效或已過期",
  "suggestion": "請重新進行 Google 登入"
}
```

### 4.2 集體智慧上報

```
POST /v1/telemetry/batch

用途：龍蝦定期上報匿名使用統計，餵給集體智慧引擎

頻率：每 1 小時批次上報（加隨機延遲 0-5 分鐘）
格式：MessagePack（省流量）
大小上限：500KB / 次

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx
  Content-Type: application/msgpack

Body（MessagePack 編碼，以下為 JSON 表示）:
{
  "schema_version": 1,
  "batch_id": "batch_uuid_xxxx",      // 去重用
  "period": {
    "from": "2026-02-28T10:00:00Z",
    "to": "2026-02-28T11:00:00Z"
  },
  "entries": [
    {
      "service_id": "groq",
      "model": "llama-3.3-70b",
      "tier": "L2",                     // 哪一層處理的
      "outcome": "success",             // "success" | "rate_limited" | "error" | "timeout"
      "latency_ms": 1200,
      "token_usage": {                  // 可選，有就報
        "input": 500,
        "output": 200
      },
      "routing_strategy": "smart",      // "fast" | "smart" | "cheap"
      "retry_count": 0,                 // 重試了幾次
      "time_bucket": "morning"          // "morning" | "afternoon" | "evening"（不記精確時間）
                                       // 劃分規則（以龍蝦本地時區為準）：<!-- v1.4 修訂 -->
                                       //   morning: 06:00-11:59 / afternoon: 12:00-17:59 / evening: 18:00-05:59（隔天）
    }
  ],
  "summary": {
    "total_requests": 47,
    "success_rate": 0.94,
    "services_used": ["groq", "brave-search"],
    "pool_stats": {
      "king_pool_used": 40,             // 龍蝦王池用了幾次
      "friend_pool_used": 5,            // 親友池用了幾次
      "l0_pool_used": 2,                // L0 公共池用了幾次
      "aid_used": 0                     // 互助用了幾次
    }
  }
}

───── Response 200 ─────
{
  "accepted": true,
  "batch_id": "batch_uuid_xxxx",
  "next_upload_after": "2026-02-28T12:03:27Z"  // 下次上報時間（含隨機延遲）
}

───── Response 429 ─────（上報太頻繁）
{
  "error": "TELEMETRY_RATE_LIMITED",
  "retry_after": 3600,
  "message": "上報頻率過高，請等 1 小時"
}
```

#### 匿名化規則（鐵律 2 的實作）

```
上報的數據 ✅ 包含：
  - 哪個服務（groq/brave/gemini...）
  - 成功還是失敗
  - 延遲（毫秒）
  - 使用了哪個 token 量級（不是精確值）
  - 時段（早/午/晚，不是精確時間）
  - 路由策略（fast/smart/cheap）

上報的數據 ❌ 不包含：
  - API Key 的任何部分
  - 請求的內容（prompt）
  - 回應的內容（response）
  - 精確時間戳（只有 time_bucket）
  - IP 位址（VPS 看得到但不存）
  - 具體用了哪把 Key（只報池子級別）

使用少於 10 人的服務 → 統計合併到「其他」類別（#86）
```

#### 路由推薦回饋（#86）

```
POST /v1/telemetry/feedback

用途：龍蝦對路由推薦的主動回饋（「👎 這個推薦不好用」）

頻率：即時發送（用戶點擊時）

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx

Body:
{
  "recommendation_id": "rt_20260228_12",    // 對應 routing_update 的 id
  "service_id": "openai",
  "feedback": "negative",                    // "positive" | "negative"
  "reason": "high_latency",                  // 可選。"high_latency" | "errors" | "quality" | "other"
  "comment": null                            // 可選，自由文字（最多 200 字元）
}

───── Response 200 ─────
{
  "accepted": true,
  "message": "感謝你的回饋 🦞"
}

───── Response 429 ─────
{
  "error": "FEEDBACK_RATE_LIMITED",
  "message": "回饋太頻繁，請稍後再試",
  "retry_after": 60
}
```

#### 上報配額查詢

```
GET /v1/telemetry/quota

用途：查詢此裝置的上報配額（還能上報幾次、下次什麼時候可以上報）

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx

───── Response 200 ─────
{
  "batch_uploads": {
    "limit_per_hour": 2,
    "used_this_hour": 1,
    "next_allowed_at": "2026-02-28T13:03:27Z"
  },
  "feedback": {
    "limit_per_hour": 20,
    "used_this_hour": 3
  },
  "pending_batches": 0,                     // 本機堆積了幾批待上報
  "server_time": "2026-02-28T12:30:00Z"
}
```

### 4.3 L0 公共 Key 下發

```
GET /v1/l0/keys

用途：龍蝦從 VPS 拿公共 Key，用於 L0 免費層

頻率：
  - 啟動時拉一次
  - 之後每 6 小時檢查一次
  - 收到 WebSocket 通知「L0 Key 更新」時立即拉

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx

Query Parameters:
  since=2026-02-28T06:00:00Z    // 上次拿到的時間，VPS 只回差異

───── Response 200 ─────
{
  "schema_version": 1,
  "keys": [
    {
      "id": "l0k_001",
      "service_id": "groq",
      "key_encrypted": "base64_加密後的_key_值...",
      "encryption_method": "aes-256-gcm",
      "encryption_key_id": "l0master_v1",      // 用哪把鑰匙加密的
      "status": "active",                       // "active" | "degraded" | "dead"
      "daily_quota_per_device": 20,             // 每台裝置每天可用次數
      "total_daily_quota": 10000,               // 全體共用的每日總額度
      "total_daily_used": 3500,                 // 全體今天已用（大概數字）
      "donated_by": "匿名好心龍蝦",             // 捐贈者暱稱（可選）
      "updated_at": "2026-02-28T10:00:00Z"
    },
    {
      "id": "l0k_builtin_ddg",
      "service_id": "duckduckgo",
      "key_encrypted": null,                    // 不需要 Key 的服務
      "encryption_method": null,
      "encryption_key_id": null,
      "status": "active",
      "daily_quota_per_device": null,            // 無限制
      "total_daily_quota": null,
      "total_daily_used": null,
      "donated_by": null,
      "updated_at": "2026-02-28T00:00:00Z"
    }
  ],
  "l0_encryption_key": "base64_L0_解密_master_key...",  // 用來解密上面的 key_encrypted
  "device_daily_limits": {
    "groq": { "limit": 20, "used": 5, "reset_at": "2026-03-01T00:00:00Z" }
  },
  "cache_ttl": 21600,     // 建議快取 6 小時（秒）
  "server_time": "2026-02-28T12:00:00Z"
}

───── Response 304 ─────（since 之後沒有更新）
（空 body，用快取就好）
```

#### L0 Key 加密流程

```
為什麼 L0 Key 要加密傳輸？
  → 防止中間人攔截（雖然有 TLS，多一層保險）
  → 防止本機日誌不小心露出明文 Key
  → 龍蝦拿到後解密存入 l0-keys.json 快取

加密方式：
  VPS 端：AES-256-GCM(key=l0_master_key, plaintext=api_key_value)
  龍蝦端：用同一次 response 裡的 l0_encryption_key 解密
  l0_encryption_key 本身通過 TLS 傳輸保護

注意：這不是跟龍蝦個人 Key 一樣的高安全等級。
L0 Key 是「公共資源」，加密是防止明文到處飄，不是防龍蝦自己看到。
```

### 4.3.1 L0 捐 Key（#156）

<!-- v1.4 修訂 -->
> ⚠️ **安全說明：** L0 捐贈流程中，VPS 必須解密 API Key 以驗證有效性。
> 這是鐵律 1「Key 永遠不過 VPS」的唯一設計例外。
> 龍蝦點擊「捐贈」時即同意此 Key 交由 VPS 管理。

```
POST /v1/l0/donate

用途：龍蝦把多餘的 Key 捐給 L0 公共池

前提：龍蝦自願捐贈，捐出後 VPS 全權管理該 Key

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx

Body:<!-- v1.3 修訂：RSA-OAEP-256 → ECIES（ECDH P-256 + AES-256-GCM），與 SPEC-B v1.2 同步 -->
{
  "service_id": "gemini",
  "encrypted_key": "base64_AES-256-GCM加密的API_Key...",          // 用 ECDH 導出金鑰加密的 API Key
  "ephemeral_public_key": "base64_龍蝦臨時ECDH_P256公鑰...",      // 龍蝦為此次捐贈產生的臨時公鑰
  "iv": "base64_AES-GCM初始化向量...",                             // 12 bytes
  "tag": "base64_AES-GCM認證標籤...",                              // 16 bytes
  "display_name": "熱心龍蝦捐的 Gemini Key",    // 可選
  "anonymous": false                              // 可選，預設 false（true = 不顯示捐贈者暱稱）
}

───── Response 200 ─────
{
  "accepted": true,
  "l0_key_id": "l0k_003",
  "message": "感謝你的捐贈 🦞",
  "validation": {
    "key_valid": true,
    "service_confirmed": "gemini",
    "estimated_daily_quota": 1500
  }
}

───── Response 400 ─────
{
  "error": "L0_DONATE_INVALID_KEY",
  "message": "捐贈的 Key 無效或已封",
  "suggestion": "請確認 Key 是否還能使用"
}

───── Response 409 ─────<!-- v1.3 修訂 -->
{
  "error": "L0_DONATE_DUPLICATE",
  "message": "此 Key 已在公共池中",
  "suggestion": "此 Key 已經被捐贈過了，不需要重複捐贈"
}

───── Response 429 ─────
{
  "error": "L0_DONATE_RATE_LIMITED",
  "message": "捐贈太頻繁，每 24 小時最多 5 次",
  "retry_after": 86400
}

注意：
  - VPS 收到後會立即驗證 Key 有效性（打一次輕量請求）
  - 無效 Key 直接拒絕，不存入公共池
  - 捐贈者的 device_id 會記錄（不公開），用於異常偵測
  - 捐贈的 Key 如果被封了，VPS 自動替換，不通知捐贈者
```

### 4.4 L0 用量回報

```
POST /v1/l0/usage

用途：龍蝦回報 L0 用量，讓 VPS 追蹤全局額度

頻率：每次使用 L0 後即時回報（或批次，最遲 5 分鐘內）

───── Request ─────
{
  "entries": [
    {
      "l0_key_id": "l0k_001",
      "service_id": "groq",
      "count": 3,                    // 自上次回報後用了幾次
      "last_used_at": "2026-02-28T11:30:00Z"
    }
  ]
}

───── Response 200 ─────
{
  "accepted": true,
  "device_daily_limits": {
    "groq": { "limit": 20, "used": 8, "reset_at": "2026-03-01T00:00:00Z" }
  }
}

───── Response 429 ─────（今日額度已用完）
{
  "error": "L0_DAILY_LIMIT_REACHED",
  "service_id": "groq",
  "used": 20,
  "limit": 20,
  "reset_at": "2026-03-01T00:00:00Z",
  "message": "今天的免費 Groq 額度用完了",
  "suggestion": "加自己的 Groq Key 可以無限使用：clawapi keys add"
}
```

### 4.5 互助請求（非同步）

```
POST /v1/aid/request

用途：龍蝦 B 的某服務 Key 全掛了，向 VPS 請求互助

⚠️ 非同步設計：VPS 收到後回 202 Accepted，結果透過 WebSocket 推送。
   因為 VPS 要找幫助者 → 轉發 → 等回應，可能 5-30 秒，不能同步阻塞。

⚠️ 互助加密 payload 大小上限：1MB（超過回 AID_PAYLOAD_TOO_LARGE 錯誤）<!-- v1.4 修訂 -->

觸發條件（引擎端邏輯）：
  1. 龍蝦王池該服務全掛（限速/死亡）
  2. 親友分身池該服務也全掛
  3. L0 公共 Key 也掛了或額度用完
  → 才觸發互助請求

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx

Body:
{
  "service_id": "groq",
  "request_type": "chat_completion",    // 需要什麼類型的 API 呼叫
  "requester_public_key": "base64_龍蝦B的ECDH_P256公鑰...",  // 雙公鑰方案：A 用此公鑰做 ECDH 導出共享金鑰 <!-- v1.1 修訂 -->
  "max_latency_ms": 30000,             // 最多等幾毫秒
  "context": {
    "retry_count": 0,                   // 這是第幾次互助嘗試
    "original_error": "UPSTREAM_429_RATE_LIMITED"
  }
}

───── Response 202 ─────（已接受，正在配對中）
{
  "status": "matching",
  "aid_id": "aid_xxxx",                  // 追蹤用 ID
  "estimated_wait_ms": 15000,            // 預估等待時間
  "message": "正在幫你找有閒置額度的龍蝦..."
}
→ 結果透過 WebSocket notifications 頻道推送（見 5.4 aid_result）

───── Response 503 ─────（找不到可以幫忙的龍蝦，立即回覆）
{
  "status": "no_helper_available",
  "error": "AID_NO_HELPER",
  "message": "目前沒有龍蝦有閒置的 Groq 額度",
  "suggestion": "可以稍後再試，或加自己的 Key",
  "retry_after": 300                     // 建議 5 分鐘後再試
}

───── Response 429 ─────（互助請求太頻繁）
{
  "error": "AID_RATE_LIMITED",
  "message": "互助請求太頻繁，請稍後再試",
  "cooldown_seconds": 60,
  "daily_aid_remaining": 3
}
```

#### 公鑰交換機制（互助加密基礎）— 雙公鑰方案 <!-- v1.1 修訂 -->

```
互助的端對端加密只需要兩方的公鑰（VPS 不參與金鑰操作）：

  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ 龍蝦 B   │     │   VPS    │     │ 龍蝦 A   │
  │ (求助者) │     │ (純轉發) │     │ (幫助者) │
  └────┬─────┘     └────┬─────┘     └────┬─────┘
       │                │                │
       │  requester_    │                │
       │  public_key ──→│──→ B 的公鑰 ──→│
       │                │                │
       │                │  helper_       │
       │←── A 的公鑰 ←──│←── public_key ─│
       │                │                │

兩把公鑰：
  1. 龍蝦 B 公鑰：在 aid/request 裡帶上（requester_public_key）
  2. 龍蝦 A 公鑰：在 aid_response 裡帶上（helper_public_key）

⚠️ VPS 公鑰仍在裝置註冊時下發，用於 L0 Key 加密傳輸等場景，
   但不再用於互助金鑰交換（v1.1 升級）。

公鑰格式：ECDH P-256（比 RSA 更小更快，適合頻繁交換）
  - 產生：引擎啟動時自動產生 ECDH 金鑰對
  - 存放：~/.clawapi/data.db → device_keypair 表
  - 公鑰大小：約 65 bytes（uncompressed）
  - 每 30 天自動輪換（舊的保留 7 天以完成進行中的互助）

ECDH 共享金鑰導出流程：
  1. A 收到 B 的 requester_public_key
  2. A 用 ECDH(A_private, B_public) → 導出 shared_secret
  3. 金鑰導出（v1.4 精確定義）：<!-- v1.4 修訂 -->
     HKDF-SHA256(
       ikm    = ECDH_shared_secret,
       salt   = UTF-8(aid_id),            // 每次互助不同，防重放
       info   = UTF-8("clawapi-aid-v1"),
       length = 32
     ) → AES-256 金鑰 K
  4. B 收到 A 的 helper_public_key 後做相同運算得到同一個 K
  → K 從未在網路上傳輸，VPS 無法得知
```

#### 互助中繼加密流程（鐵律 2 的實作）— 預登記方案 <!-- v1.3 修訂：從雙公鑰方案升級為預登記方案 -->

```
VPS 在互助中繼時的角色 = 郵差，不拆信
⚠️ v1.3 升級：「預登記方案」— A 的公鑰在 PUT /v1/aid/config 時預先上傳
   VPS 配對成功後推 aid_matched 給雙方，同時交換公鑰

流程：
1. 龍蝦 B 發起 POST /v1/aid/request
   → 帶上 requester_public_key（B 的 ECDH P-256 公鑰）
   → VPS 回 202（含 aid_id）

2. VPS 配對到幫助者 A（A 的 helper_public_key 已在 aid/config 預登記）
   → 推送 aid_matched 給 A（含 B 的 requester_public_key）
   → 同時推送 aid_matched 給 B（含 A 的 helper_public_key）
   → 雙方同時拿到對方公鑰，可各自用 ECDH + HKDF-SHA256 導出共享金鑰 K（參數見 §4.5 公鑰交換機制）<!-- v1.4 修訂 -->

3. 龍蝦 B 收到 aid_matched 後：
   a. 用 A 的 helper_public_key + 自己的私鑰做 ECDH → 導出共享金鑰 K
   b. 用 K（AES-256-GCM）加密 payload → 透過 WS 發送給 VPS

4. VPS 原封轉發加密 payload 給 A

5. 龍蝦 A 收到後：
   a. 用 B 的 requester_public_key + 自己的私鑰做 ECDH → 導出同一個共享金鑰 K
   b. 用 K 解密 payload → 執行 API 呼叫
   c. 用 K 加密回應 → 透過 WS 回傳 aid_response 給 VPS

6. VPS 原封轉發 aid_result 給 B
   → VPS 全程不碰密文和金鑰

7. 龍蝦 B 用 K 解密 → 拿到明文回應

關鍵安全特性：
  - VPS 全程只做配對和轉發，連對稱金鑰 K 都不碰
  - K 由 B 和 A 各自獨立用 ECDH 導出（不在網路上傳輸）
  - 每次互助都是新的 ECDH 交換 → 前向保密（Forward Secrecy）
  - 預登記方案讓 B 不用等 A 回應公鑰，配對即可開始加密通訊

⚠️ 信任假設（v1.4 補充）：<!-- v1.4 修訂 -->
  雙公鑰方案基於 honest-but-curious 模型——
  假設 VPS 忠實轉發公鑰，不會主動替換。
  如需防範惡意 VPS，需引入公鑰指紋驗證（Safety Number），
  列入 v2.0 路線圖。

VPS 全程只知道：「B 需要 Groq 幫助，A 有閒置 Groq」
VPS 不知道：請求和回應的內容、對稱金鑰 K
```

#### 互助中繼內部 API（VPS → 龍蝦 A）

```
POST /v1/aid/relay

用途：VPS 把互助請求轉發給龍蝦 A（打到 A 的本機引擎）
注意：這個 API 是打到龍蝦 A 的本機，不是 VPS

但是！龍蝦 A 的本機不對外開放。所以：<!-- v1.3 修訂：預登記方案流程 -->
  → VPS 配對成功後，推 aid_matched 給 A 和 B（含對方公鑰）
  → B 用 ECDH 導出金鑰加密 payload，透過 WS 發給 VPS
  → VPS 原封轉發給 A
  → A 解密、執行 API 呼叫、加密回應，透過 WS 回傳給 VPS
  → VPS 原封轉發 aid_result 給 B

（詳見 5.4 WebSocket 即時通知 → aid_matched / aid_request 訊息類型）
```

### 4.6 互助配置同步

```
PUT /v1/aid/config

用途：龍蝦更新自己的互助設定

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx

Body:
{
  "enabled": true,
  "allowed_services": ["groq", "brave-search"],  // null = 全部
  "daily_limit": 50,
  "blackout_hours": [0, 1, 2, 3, 4, 5],           // 凌晨不要打擾（可選）
  "helper_public_key": "base64_龍蝦A的ECDH公鑰..."  // 預登記 ECDH P-256 公鑰，開啟互助時必填<!-- v1.3 修訂：預登記方案，VPS 配對成功後直接從此取得 A 的公鑰推給 B -->
}

───── Response 200 ─────
{
  "updated": true,
  "config": {
    "enabled": true,
    "allowed_services": ["groq", "brave-search"],
    "daily_limit": 50,
    "daily_given": 12,                              // 今天已經幫了幾次
    "blackout_hours": [0, 1, 2, 3, 4, 5]
  }
}
```

```
GET /v1/aid/stats

用途：查詢互助統計

───── Response 200 ─────
{
  "given": {
    "today": 12,
    "this_month": 156,
    "all_time": 892,
    "by_service": {
      "groq": 680,
      "brave-search": 212
    }
  },
  "received": {
    "today": 0,
    "this_month": 23,
    "all_time": 89,
    "by_service": {
      "groq": 67,
      "openai": 22
    }
  }
}
```

### 4.7 版本檢查

```
GET /v1/version/check

用途：檢查是否有新版本

頻率：啟動時一次 + 每 24 小時一次

───── Request ─────
Query Parameters:
  current=1.0.0
  os=darwin
  arch=arm64

───── Response 200 ─────（有新版）
{
  "latest_version": "1.1.0",
  "current_version": "1.0.0",
  "update_available": true,
  "is_critical": false,              // true = 安全更新，強烈建議
  "release_notes": "## v1.1.0\n- 新增雲端備份\n- 修復 L2 路由 bug",
  "download_urls": {
    "npm": "npm install -g clawapi@1.1.0",
    "brew": "brew upgrade clawapi",
    "binary": {
      "darwin-arm64": "https://github.com/clawapi/clawapi/releases/download/v1.1.0/clawapi-darwin-arm64",
      "darwin-x64": "https://github.com/clawapi/clawapi/releases/download/v1.1.0/clawapi-darwin-x64",
      "linux-x64": "https://github.com/clawapi/clawapi/releases/download/v1.1.0/clawapi-linux-x64",
      "win32-x64": "https://github.com/clawapi/clawapi/releases/download/v1.1.0/clawapi-win32-x64.exe"
    },
    "docker": "ghcr.io/clawapi/clawapi:1.1.0"
  },
  "min_supported_version": "1.0.0"     // 低於這個版本 VPS API 不再支援
}

───── Response 200 ─────（已是最新）
{
  "latest_version": "1.0.0",
  "current_version": "1.0.0",
  "update_available": false
}
```

### 4.8 Adapter 更新檢查

```
GET /v1/adapters/updates

用途：檢查已安裝的 Adapter 是否有更新

頻率：每次 clawapi start 時 + 每 12 小時

───── Request ─────
Query Parameters:
  installed=groq@1.0.0,brave-search@1.0.0,gemini@1.2.0

───── Response 200 ─────
{
  "updates": [
    {
      "adapter_id": "gemini",
      "current_version": "1.2.0",
      "latest_version": "1.3.0",
      "is_official": true,
      "changelog": "- 支援 Gemini 2.5 Flash\n- 修復 streaming 問題",
      "download_url": "https://raw.githubusercontent.com/clawapi/adapters/main/official/gemini.yaml",
      "auto_update": true               // 官方 Adapter 自動更新
    }
  ],
  "new_official_adapters": [             // 新增的官方 Adapter（還沒裝的）
    {
      "adapter_id": "perplexity",
      "version": "1.0.0",
      "description": "Perplexity AI 搜尋 API",
      "download_url": "https://raw.githubusercontent.com/clawapi/adapters/main/official/perplexity.yaml"
    }
  ]
}
```

```
GET /v1/adapters/official

用途：列出所有官方 Adapter（給 UI 用）

───── Response 200 ─────
{
  "adapters": [
    {
      "id": "groq",
      "name": "Groq",
      "version": "1.0.0",
      "description": "Groq 超快推理 API",
      "category": "llm",
      "requires_key": true,
      "free_tier": true,
      "download_url": "https://..."
    }
  ],
  "last_updated": "2026-02-28T10:00:00Z"
}
```

### 4.9 雲端備份（v1.1+）

```
PUT /v1/backup

用途：上傳加密備份檔

需要：Google 登入

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx
  X-Google-Token: google_id_token_xxxx
  Content-Type: application/octet-stream
  X-Backup-Version: 1
  X-Backup-Checksum: sha256_xxxx

Body: 加密的備份檔（二進位）

加密層：
  第一層：用戶的備份密碼 → PBKDF2(100K iterations) → AES-256-GCM
  第二層：Google token 綁定 → 確保只有同一帳號能下載

大小上限：50MB

───── Response 200 ─────
{
  "uploaded": true,
  "backup_size": 12345,
  "server_checksum": "sha256_xxxx",       // 跟客戶端比對確認完整
  "stored_at": "2026-02-28T12:00:00Z"
}

───── Response 413 ─────
{
  "error": "BACKUP_TOO_LARGE",
  "max_size": 52428800,                    // 50MB
  "your_size": 60000000
}
```

```
GET /v1/backup

用途：下載加密備份檔

需要：Google 登入

───── Response 200 ─────
Headers:
  Content-Type: application/octet-stream
  X-Backup-Version: 1
  X-Backup-Checksum: sha256_xxxx
  X-Backup-Stored-At: 2026-02-28T12:00:00Z

Body: 加密的備份檔（二進位）

───── Response 404 ─────
{
  "error": "BACKUP_NOT_FOUND",
  "message": "此帳號沒有備份檔"
}
```

```
DELETE /v1/backup

用途：刪除雲端備份檔

需要：Google 登入

───── Request ─────
Headers:
  X-Device-Id: clw_xxxx
  X-Device-Token: dtoken_xxxx
  X-Google-Token: google_id_token_xxxx

───── Response 200 ─────
{
  "deleted": true,
  "message": "雲端備份已刪除"
}

───── Response 404 ─────
{
  "error": "BACKUP_NOT_FOUND",
  "message": "此帳號沒有備份檔可刪除"
}
```

### 4.10 Sub-Key VPS 驗證中繼（#129）

```
POST /v1/subkeys/validate

用途：第三方應用（拿 Sub-Key 的人）透過 VPS 驗證 Sub-Key 是否有效
場景：龍蝦發行 Sub-Key 給朋友/應用，對方需要驗證 Sub-Key 是否合法

⚠️ 這是外部呼叫 VPS 的端點（不需要 X-Device-Id）
   VPS 透過 WebSocket 向發行者（龍蝦）確認 Sub-Key 狀態

───── Request ─────
Headers:
  Content-Type: application/json

Body:
{
  "sub_key": "sk_live_xxxxxxxxxxxxxxxx",
  "service_id": "groq"                    // 要用哪個服務
}

───── Response 200 ─────（有效）
{
  "valid": true,
  "service_id": "groq",
  "permissions": {
    "models": ["llama-3.3-70b"],           // 允許的模型（null = 全部）
    "rate_limit": 100,                      // 每小時上限
    "rate_remaining": 87,                   // 本小時剩餘
    "expires_at": "2026-06-01T00:00:00Z"   // null = 不過期
  }
}

───── Response 403 ─────（無效或過期）
{
  "error": "SUBKEY_INVALID",
  "message": "此 Sub-Key 無效或已被撤銷",
  "suggestion": "請向發行者確認"
}

───── Response 503 ─────（發行者離線，無法驗證）
{
  "error": "SUBKEY_ISSUER_OFFLINE",
  "message": "Sub-Key 發行者目前離線，無法驗證",
  "suggestion": "稍後再試"
}

注意：
  - VPS 不持有 Sub-Key 清單，只做中繼驗證
  - VPS 透過 WebSocket 問發行者「這把 Sub-Key 是不是你的？」
  - 發行者離線時無法驗證（Sub-Key 是本機功能）
  - 快取策略：驗證結果快取 5 分鐘（避免每次都問發行者）
```

---

## 5. WebSocket 詳細規格

### 5.1 連線管理

```
連線 URL：wss://api.clawapi.com/v1/ws

連線時帶認證：
  wss://api.clawapi.com/v1/ws?device_id=clw_xxxx&token=dtoken_xxxx&version=1.0.0

連線建立後，立即發送訂閱訊息：
```

#### 訊息格式（所有 WebSocket 訊息統一格式）

```typescript
// 客戶端 → VPS
interface ClientMessage {
  type: string;           // 訊息類型
  channel: string;        // 頻道名稱
  id: string;             // 訊息 ID（去重 + 確認用）
  payload: unknown;       // 訊息內容
}

// VPS → 客戶端
interface ServerMessage {
  type: string;           // 訊息類型
  channel: string;        // 頻道名稱
  id: string;             // 訊息 ID
  payload: unknown;       // 訊息內容
  server_time: string;    // 伺服器時間
}
```

#### 連線生命週期

```
連線建立 → 發送 subscribe 訊息 → 持續接收推送
                                  ↕ 發送聊天訊息
                                  ↕ 接收互助請求
         ← 每 30 秒 ping/pong 保活
         ← 斷線重連（見 9.2 WebSocket 斷線重連策略）<!-- v1.1 修訂 -->
```

#### 訂閱

```json
// 客戶端發送（連線後立即）
{
  "type": "subscribe",
  "channel": "*",
  "id": "sub_001",
  "payload": {
    "channels": ["routing", "notifications"],   // 要訂閱的頻道
    "chat_channels": ["general", "help"]         // 聊天室頻道（可選）
  }
}

// VPS 回應
{
  "type": "subscribe_ack",
  "channel": "system",
  "id": "sub_001",
  "payload": {
    "subscribed": ["routing", "notifications", "chat:general", "chat:help"],
    "online_count": 42                            // 目前線上龍蝦數
  },
  "server_time": "2026-02-28T12:00:00Z"
}
```

### 5.2 路由建議推送

```
頻道：routing

VPS 每小時分析一次集體智慧數據，產生路由建議後推送給所有線上龍蝦。
也會在特殊事件時即時推送（比如某服務大規模故障）。
```

```json
// VPS → 客戶端
{
  "type": "routing_update",
  "channel": "routing",
  "id": "rt_20260228_12",
  "payload": {
    "schema_version": 1,
    "generated_at": "2026-02-28T12:00:00Z",
    "valid_until": "2026-02-28T13:00:00Z",
    "recommendations": [
      {
        "service_id": "groq",
        "region": "asia",                    // 此建議適用的地區（#88）
        "status": "preferred",              // "preferred" | "degraded" | "avoid"
        "confidence": 0.95,                  // 0-1，數據量越大越高
        "metrics": {
          "success_rate": 0.98,
          "avg_latency_ms": 800,
          "p95_latency_ms": 2500,
          "sample_size": 1200                // 多少龍蝦的數據
        },
        "note": null                         // 人類可讀的備註（少用）
      },
      {
        "service_id": "openai",
        "region": "asia",
        "status": "degraded",
        "confidence": 0.87,
        "metrics": {
          "success_rate": 0.72,
          "avg_latency_ms": 3500,
          "p95_latency_ms": 15000,
          "sample_size": 800
        },
        "note": "OpenAI 目前回應較慢，建議優先用其他服務"
      }
    ],
    "alerts": [                               // 即時警報（少見）
      {
        "severity": "warning",               // "info" | "warning" | "critical"
        "service_id": "anthropic",
        "message": "Anthropic API 近 30 分鐘錯誤率飆升到 40%",
        "started_at": "2026-02-28T11:30:00Z"
      }
    ]
  },
  "server_time": "2026-02-28T12:00:00Z"
}
```

#### 客戶端收到後的行為

```
1. 存入 ~/.clawapi/cache/routing-intel.json
2. 路由引擎的 smart 策略讀取這份建議
3. 龍蝦的 Web UI Dashboard 顯示服務健康狀態
4. 如果有 alerts → 在 Dashboard 和 CLI 顯示警告
```

### 5.3 聊天室

```
頻道：chat:{channel_name}

預設頻道：general、help
未來可擴充：按語言（zh-TW、en、ja）、按主題
```

```json
// 客戶端 → VPS（發訊息）
{
  "type": "chat_message",
  "channel": "chat:general",
  "id": "msg_uuid_xxxx",
  "payload": {
    "text": "大家好，請問 Groq 現在是不是限速了？",
    "nickname": "龍蝦小明",           // 可選，沒設就顯示「匿名龍蝦」
    "reply_to": null                   // 回覆某則訊息（可選）
  }
}

// VPS → 所有訂閱該頻道的客戶端
{
  "type": "chat_message",
  "channel": "chat:general",
  "id": "msg_uuid_xxxx",
  "payload": {
    "text": "大家好，請問 Groq 現在是不是限速了？",
    "nickname": "龍蝦小明",
    "sender_device_id": null,          // 匿名！不暴露 device_id
    "reply_to": null
  },
  "server_time": "2026-02-28T12:05:30Z"
}

// VPS → 客戶端（系統訊息）
{
  "type": "chat_system",
  "channel": "chat:general",
  "id": "sys_uuid_xxxx",
  "payload": {
    "text": "有新龍蝦加入了聊天室 🦞",
    "online_count": 43
  },
  "server_time": "2026-02-28T12:05:35Z"
}
```

#### 聊天室規則

```
- 不存歷史訊息：只能看到上線後的訊息
- 訊息長度上限：500 字元
- 發送頻率上限：每 5 秒最多 1 則（防洗版）
- 暱稱來源：Google 登入的名字 或 手動設定 或「匿名龍蝦」
- VPS 的角色：只做中繼，不審查、不存檔
```

### 5.4 即時通知

```
頻道：notifications

VPS 推送各種系統通知給龍蝦。
```

#### 通知類型

```json
// L0 Key 有更新（觸發客戶端重新 GET /v1/l0/keys）
{
  "type": "notification",
  "channel": "notifications",
  "id": "notif_001",
  "payload": {
    "kind": "l0_keys_updated",
    "message": "L0 公共 Key 已更新",
    "action": "refresh_l0_keys"        // 客戶端收到後自動拉 /v1/l0/keys
  },
  "server_time": "2026-02-28T12:00:00Z"
}

// 新版本可用
{
  "type": "notification",
  "channel": "notifications",
  "id": "notif_002",
  "payload": {
    "kind": "version_available",
    "message": "ClawAPI v1.1.0 已發布",
    "version": "1.1.0",
    "is_critical": false,
    "action": "check_version"
  },
  "server_time": "2026-02-28T15:00:00Z"
}

// 互助請求（VPS 推送給龍蝦 A，請他幫忙）<!-- v1.1 修訂：雙公鑰方案 -->
{
  "type": "notification",
  "channel": "notifications",
  "id": "aid_req_001",
  "payload": {
    "kind": "aid_request",
    "aid_id": "aid_xxxx",
    "service_id": "groq",
    "request_type": "chat_completion",
    "requester_public_key": "base64_龍蝦B的ECDH_P256公鑰...",  // A 用此公鑰做 ECDH 導出共享金鑰
    "timeout_ms": 30000,
    "action": "process_aid_request"
  },
  "server_time": "2026-02-28T12:10:00Z"
}

// 互助配對成功通知（VPS 配對後同時推送給 A 和 B）<!-- v1.3 修訂 -->
// ⚠️ v1.3 升級：「預登記」方案 — B 發起 aid/request 後，VPS 配對成功再推 aid_matched 給雙方
//   原本的 aid_request 通知仍保留向下相容，但新版引擎應優先處理 aid_matched

// 推送給幫助者 A：
{
  "type": "notification",
  "channel": "notifications",
  "id": "aid_match_001a",
  "payload": {
    "kind": "aid_matched",
    "aid_id": "aid_xxxx",
    "service_id": "openai",
    "request_type": "chat",
    "requester_public_key": "base64_龍蝦B的ECDH_P256公鑰...",  // 請求者 B 的 ECDH 公鑰
    "action": "process_aid_matched"
  },
  "server_time": "2026-02-28T12:10:05Z"
}

// 推送給請求者 B：
{
  "type": "notification",
  "channel": "notifications",
  "id": "aid_match_001b",
  "payload": {
    "kind": "aid_matched",
    "aid_id": "aid_xxxx",
    "helper_public_key": "base64_龍蝦A的ECDH_P256公鑰...",    // 幫助者 A 的 ECDH 公鑰（從預登記取得）
    "action": "process_aid_matched"
  },
  "server_time": "2026-02-28T12:10:05Z"
}

// 龍蝦 A 回傳互助結果 <!-- v1.1 修訂：雙公鑰方案 -->
// （客戶端 → VPS）
{
  "type": "aid_response",
  "channel": "notifications",
  "id": "aid_resp_001",
  "payload": {
    "aid_id": "aid_xxxx",
    "status": "fulfilled",             // "fulfilled" | "rejected" | "error"
    "response_encrypted": "base64_用ECDH導出金鑰加密的回應...",
    "encryption_method": "aes-256-gcm",
    "helper_public_key": "base64_龍蝦A的ECDH_P256公鑰...",  // B 用此公鑰做 ECDH 解密
    "latency_ms": 2500
  }
}

// 互助結果推送（VPS → 龍蝦 B，非同步回調）<!-- v1.1 修訂：雙公鑰方案 -->
// 對應 POST /v1/aid/request 返回 202 後的結果
{
  "type": "notification",
  "channel": "notifications",
  "id": "aid_result_001",
  "payload": {
    "kind": "aid_result",
    "aid_id": "aid_xxxx",
    "status": "fulfilled",               // "fulfilled" | "timeout" | "error"
    "response_encrypted": "base64_用ECDH導出金鑰加密的回應...",
    "encryption_method": "aes-256-gcm",
    "helper_public_key": "base64_龍蝦A的ECDH_P256公鑰...",   // B 用此 + 自己私鑰做 ECDH 解密
    "aid_record": {
      "service_id": "groq",
      "latency_ms": 2500,
      "helper_device_id": null           // 永遠匿名
    },
    "action": "process_aid_result"
  },
  "server_time": "2026-02-28T12:10:15Z"
}

// 互助超時推送（VPS → 龍蝦 B，沒人回應）
{
  "type": "notification",
  "channel": "notifications",
  "id": "aid_result_002",
  "payload": {
    "kind": "aid_result",
    "aid_id": "aid_yyyy",
    "status": "timeout",
    "message": "沒有龍蝦回應互助請求",
    "suggestion": "可以稍後再試，或加自己的 Key",
    "action": "display_aid_timeout"
  },
  "server_time": "2026-02-28T12:10:30Z"
}

// Adapter 有更新
{
  "type": "notification",
  "channel": "notifications",
  "id": "notif_003",
  "payload": {
    "kind": "adapter_updated",
    "adapter_id": "gemini",
    "old_version": "1.2.0",
    "new_version": "1.3.0",
    "is_official": true,
    "action": "update_adapter",
    "auto_applied": true               // 官方 Adapter 已自動更新
  },
  "server_time": "2026-02-28T16:00:00Z"
}

// 服務異常告警（來自集體智慧分析）
{
  "type": "notification",
  "channel": "notifications",
  "id": "notif_004",
  "payload": {
    "kind": "service_alert",
    "severity": "warning",
    "service_id": "anthropic",
    "message": "Anthropic API 近 30 分鐘錯誤率從 2% 飆到 40%",
    "action": "display_alert"
  },
  "server_time": "2026-02-28T12:30:00Z"
}
```

#### 互助加密數據交換（aid_data）<!-- v1.4 修訂 -->

```
頻道：notifications

互助配對成功（aid_matched）後，B 和 A 之間交換加密 payload 的訊息格式。
VPS 只做原封轉發，不解密任何內容。

⚠️ payload 大小上限：1MB（超過回 AID_PAYLOAD_TOO_LARGE 錯誤）
```

```typescript
// === 互助加密數據交換（v1.4 新增） ===

// B → VPS → A：求助者發送加密的 API 請求
interface AidEncryptedRequest {
  type: 'aid_data';
  kind: 'encrypted_request';
  aid_id: string;
  encrypted_payload: string;  // base64, AES-256-GCM 加密的完整 API 請求 body
  iv: string;                 // base64, AES-GCM 初始化向量
  tag: string;                // base64, AES-GCM 認證標籤
}

// A → VPS → B：幫助者回傳加密的 API 回應
interface AidEncryptedResponse {
  type: 'aid_data';
  kind: 'encrypted_response';
  aid_id: string;
  encrypted_payload: string;  // base64, AES-256-GCM 加密的完整 API 回應 body
  iv: string;
  tag: string;
  helper_public_key: string;  // A 的公鑰（B 用來做 ECDH 解密）
}
```

```json
// B → VPS → A 範例：
{
  "type": "aid_data",
  "channel": "notifications",
  "id": "aid_data_001",
  "payload": {
    "kind": "encrypted_request",
    "aid_id": "aid_xxxx",
    "encrypted_payload": "base64_AES-256-GCM加密的API請求body...",
    "iv": "base64_12bytes初始化向量...",
    "tag": "base64_16bytes認證標籤..."
  }
}

// A → VPS → B 範例：
{
  "type": "aid_data",
  "channel": "notifications",
  "id": "aid_data_002",
  "payload": {
    "kind": "encrypted_response",
    "aid_id": "aid_xxxx",
    "encrypted_payload": "base64_AES-256-GCM加密的API回應body...",
    "iv": "base64_12bytes初始化向量...",
    "tag": "base64_16bytes認證標籤...",
    "helper_public_key": "base64_龍蝦A的ECDH_P256公鑰..."
  }
}
```

---

## 6. 錯誤處理

### 6.1 統一錯誤格式

```json
{
  "error": "ERROR_CODE",                    // 機器讀的錯誤碼
  "message": "人類可讀的說明",               // 給 CLI/UI 顯示
  "suggestion": "clawapi xxx",              // 建議的修復指令（可選）
  "retry_after": 3600,                      // 幾秒後可以重試（可選）
  "details": {}                              // 額外資訊（可選）
}
```

### 6.2 錯誤碼清單

<!-- v1.1 修訂 -->
> **重要：此清單為 SPEC-C 合約級錯誤碼，是唯一權威來源。**
> SPEC-A（開源引擎）和 SPEC-B（VPS 服務）各自的內部錯誤碼不得與本清單重疊。
> 若 SPEC-A/B 需要新增面向通訊層的錯誤碼，必須先提交到 SPEC-C 統一註冊。

```
認證相關
────────────────────────────────────────
AUTH_MISSING_HEADERS          缺少 X-Device-Id 或 X-Device-Token
AUTH_INVALID_TOKEN            Token 無效
AUTH_TOKEN_EXPIRED            Token 已過期，請 POST /v1/devices/refresh
AUTH_DEVICE_NOT_FOUND         device_id 未註冊
AUTH_GOOGLE_REQUIRED          此功能需要 Google 登入（v1.1+）
AUTH_GOOGLE_TOKEN_INVALID     Google token 無效或已過期
AUTH_GOOGLE_ALREADY_BOUND     此 Google 帳號已綁定其他裝置

裝置相關
────────────────────────────────────────
DEVICE_ALREADY_REGISTERED     此裝置已註冊
DEVICE_FINGERPRINT_MISMATCH   硬體指紋與註冊時不符（可能是偽造 device_id）
DEVICE_SUSPENDED              此裝置因異常行為被暫停（防濫用）
DEVICE_TOKEN_MISMATCH         device_id 和 token 不匹配

集體智慧相關
────────────────────────────────────────
TELEMETRY_RATE_LIMITED        上報太頻繁
TELEMETRY_BATCH_TOO_LARGE     批次太大（> 500KB）
TELEMETRY_INVALID_SCHEMA      schema_version 不支援
TELEMETRY_DUPLICATE_BATCH     batch_id 重複（已收過）
FEEDBACK_RATE_LIMITED          路由回饋太頻繁

L0 相關
────────────────────────────────────────
L0_DAILY_LIMIT_REACHED        今日免費額度已用完
L0_KEY_NOT_FOUND              L0 Key 不存在或已過期
L0_SERVICE_UNAVAILABLE        L0 該服務目前無可用 Key
L0_DONATE_INVALID_KEY         捐贈的 Key 無效或已封
L0_DONATE_DUPLICATE           此 Key 已在公共池中（409）<!-- v1.3 修訂 -->
L0_DONATE_RATE_LIMITED        捐贈太頻繁（每 24 小時最多 5 次）

互助相關
────────────────────────────────────────
AID_NOT_ENABLED               你沒有開啟互助
AID_NO_HELPER                 沒有可用的幫助者
AID_RATE_LIMITED               互助請求太頻繁
AID_DAILY_LIMIT_REACHED       今天的互助額度已用完（幫助者端）
AID_REQUEST_TIMEOUT           互助請求超時（沒人回應）
AID_PAYLOAD_TOO_LARGE         互助 payload 太大
AID_COOLDOWN                  互助冷卻中（防刷單）

備份相關（v1.1+）
────────────────────────────────────────
BACKUP_TOO_LARGE              備份檔太大（> 50MB）
BACKUP_NOT_FOUND              此帳號沒有備份
BACKUP_CHECKSUM_MISMATCH      備份檔校驗失敗
BACKUP_QUOTA_EXCEEDED         備份配額超過限制

Sub-Key 相關（#129）
────────────────────────────────────────
SUBKEY_INVALID                Sub-Key 無效或已被撤銷
SUBKEY_ISSUER_OFFLINE         Sub-Key 發行者離線，無法驗證

版本相關
────────────────────────────────────────
VERSION_TOO_OLD               客戶端版本太舊，VPS 不再支援（details 須含 minimum_version + download_url）<!-- v1.1 修訂 -->
VERSION_CHECK_FAILED          版本檢查失敗

WebSocket 相關
────────────────────────────────────────
WS_AUTH_FAILED                WebSocket 認證失敗
WS_SUBSCRIBE_INVALID          訂閱的頻道不存在
WS_CHAT_RATE_LIMITED          聊天訊息太頻繁
WS_CHAT_MESSAGE_TOO_LONG      聊天訊息太長（> 500 字元）
WS_INVALID_MESSAGE_FORMAT     訊息格式不正確

通用
────────────────────────────────────────
INTERNAL_ERROR                VPS 內部錯誤
SERVICE_UNAVAILABLE           VPS 暫時無法服務
INVALID_REQUEST               請求格式有誤
```

### 6.3 HTTP 狀態碼對應

```
200  成功
202  已接受，處理中（AID 非同步配對）
304  沒有更新（用快取）
400  請求格式錯誤（INVALID_REQUEST）
401  未認證（AUTH_* 錯誤）
403  禁止（DEVICE_SUSPENDED、SUBKEY_INVALID、AUTH_*_MISMATCH）
404  找不到資源（BACKUP_NOT_FOUND 等）
409  衝突（DEVICE_ALREADY_REGISTERED、AUTH_GOOGLE_ALREADY_BOUND、TELEMETRY_DUPLICATE_BATCH）
413  太大（BACKUP_TOO_LARGE、TELEMETRY_BATCH_TOO_LARGE）
429  太頻繁（*_RATE_LIMITED、*_DAILY_LIMIT_REACHED）
500  VPS 內部錯誤（INTERNAL_ERROR）
503  VPS 暫時不可用（SERVICE_UNAVAILABLE、AID_NO_HELPER、SUBKEY_ISSUER_OFFLINE）
```

---

## 7. Rate Limit

### 7.1 每個端點的限制

```
端點                              限制                      窗口
─────────────────────────────────────────────────────────────────
POST /v1/devices/register         5 次                      1 小時
POST /v1/devices/refresh          10 次                     1 小時
POST /v1/devices/reset            3 次                      24 小時
POST /v1/auth/google              10 次                     1 小時
POST /v1/telemetry/batch          2 次                      1 小時
POST /v1/telemetry/feedback       20 次                     1 小時
GET  /v1/telemetry/quota          30 次                     1 小時
GET  /v1/l0/keys                  10 次                     1 小時
POST /v1/l0/usage                 60 次                     1 小時
POST /v1/l0/donate                5 次                      24 小時
POST /v1/aid/request              30 次                     1 小時
PUT  /v1/aid/config               10 次                     1 小時
GET  /v1/aid/config               30 次                     1 小時
GET  /v1/aid/stats                30 次                     1 小時
GET  /v1/version/check            5 次                      1 小時
GET  /v1/adapters/updates         5 次                      1 小時
GET  /v1/adapters/official        10 次                     1 小時
PUT  /v1/backup                   5 次                      24 小時
GET  /v1/backup                   10 次                     24 小時
DELETE /v1/backup                 3 次                      24 小時
POST /v1/subkeys/validate         60 次                     1 小時
```

<!-- v1.4 修訂 -->
> 補充限制：同一 IP 最多註冊 5 個 device_id（防止大量偽造裝置繞過限額）

### 7.2 Rate Limit Headers

```
每個回應都帶：
  X-RateLimit-Limit: 10          // 窗口內的上限
  X-RateLimit-Remaining: 7       // 窗口內剩餘
  X-RateLimit-Reset: 1709136000  // 窗口重置的 Unix timestamp
```

### 7.3 WebSocket Rate Limit

```
聊天訊息：每 5 秒最多 1 則
互助回應：每 10 秒最多 5 則
其他訊息：每 1 秒最多 10 則
超過限制 → VPS 發送 WS_RATE_LIMITED 錯誤 → 不斷線
連續超限 10 次 → 強制斷線 + 5 分鐘禁止重連 <!-- v1.1 修訂：精確化超限閾值 -->
```

---

## 8. 安全模型

### 8.1 傳輸安全

```
所有通訊：TLS 1.3（不接受 TLS 1.2 以下）
WebSocket：必須走 WSS（不接受 WS）
證書固定（Certificate Pinning）：v1.1+ 考慮，MVP 先不做
```

### 8.2 認證安全

```
device_token 特性：
  - 長度：64 字元隨機 hex
  - 有效期：120 天（自動刷新）
  - 一個 device_id 同時只有一個有效 token
  - Token 刷新時舊 token 立即失效

防偽造 device_id：
  - 註冊時記錄 device_fingerprint
  - 如果同一個 device_id 從不同指紋的裝置連線 → 標記異常
  - 異常次數太多 → 暫停該 device_id（需要手動重置）
```

### 8.3 互助安全 <!-- v1.1 修訂：雙公鑰方案 -->

```
防中間人攻擊（雙公鑰方案）：
  - 互助回應端對端加密（鐵律 2）
  - VPS 只做配對和轉發，不解密內容，連對稱金鑰 K 都不碰
  - 共享金鑰 K 由 A 和 B 各自用 ECDH 獨立導出（不在網路上傳輸）
  - 每次互助都是新的 ECDH 交換 → 前向保密（Forward Secrecy）
  - 舊方案（VPS 中轉對稱金鑰）已廢棄，VPS 不再參與任何金鑰操作

防刷單（#B23）：
  - 龍蝦的 Key 必須「真的全掛」才能觸發互助
    → VPS 交叉驗證：集體智慧數據顯示該服務確實有問題？
    → 龍蝦近期的 Key 健康歷史是否合理？
  - 互助觸發前有冷卻期（60 秒）
  - 單一龍蝦每天互助請求上限：30 次
  - 同一服務連續互助請求：每次冷卻期加倍（60s, 120s, 240s...）

防濫用互助幫忙：
  - 幫助者的 daily_limit 到了就不再被配對
  - blackout_hours 期間不配對
  - 如果幫助者的龍蝦離線（WebSocket 斷了）→ 不配對
```

### 8.4 L0 安全

```
防假 device_id 蹭免費（#B21）：
  - device_id 綁 device_fingerprint
  - 同一 IP 大量不同 device_id → 標記異常
  - 異常 device_id 的 L0 額度降到 0

L0 Key 保護（#B22）：
  - Key 不寫死在程式碼（客戶端 repo 裡不會有任何 Key 值）
  - Key 從 VPS 動態下發，加密傳輸
  - 客戶端日誌自動遮罩 Key（只顯示前 4 + 後 4）
  - Key 壞了 VPS 即時替換，客戶端自動拿新的
```

### 8.5 數據安全

```
VPS 儲存的數據：
  ✅ device_id + device_fingerprint（辨識裝置）
  ✅ 匿名統計數據（集體智慧用）
  ✅ 互助記錄（誰幫了幾次，不記錄內容）
  ✅ 互助設定（開關、服務、上限）
  ✅ 加密備份檔（v1.1+，VPS 無法解密）
  ✅ 聊天訊息（不存歷史，只轉發）

  ❌ 龍蝦的 API Key
  ❌ API 請求/回應內容
  ❌ 龍蝦的本機設定（config.yaml）
  ❌ 龍蝦的 Sub-Key
  ❌ 精確使用時間（只有 time_bucket）
  ❌ IP 位址（看到但不存）

VPS 日誌保留：
  - 存取日誌：7 天（只有 device_id + endpoint + status code）
  - 錯誤日誌：30 天
  - 集體智慧原始數據：永久（匿名的）
  - 互助記錄：永久（匿名的）
```

---

## 9. 離線行為

### 9.1 VPS 連不上時

```
功能                          離線行為
────────────────────────────────────────────────────────────────
L1/L2/L3/L4 路由              ✅ 完全正常（Key 在本機，直連上游 API）
路由建議（smart 策略）         ⚡ 用快取的 routing-intel.json（最多 30 天）
L0 公共 Key                   ⚡ 用快取的 l0-keys.json（最多到快取到期）
                               → 快取到期後降級為 stale 模式：繼續使用但在 API 回應中標記 x_clawapi.l0_stale: true<!-- v1.4 修訂 -->
互助                          ❌ 不可用（需要 VPS 配對）
聊天室                        ❌ 不可用（需要 VPS 中繼）
集體智慧上報                   📦 本機堆積，VPS 恢復後自動補傳（最多 30 天）
版本檢查                      ❌ 跳過
Adapter 更新                  ❌ 跳過（用現有版本）
```

### 9.2 重連策略

```
HTTPS 請求失敗：
  → 重試 3 次（間隔 1s, 2s, 4s）
  → 全部失敗 → 本機堆積 → 每 15 分鐘背景重試一次
  → 連續 24 小時失敗 → 降低為每小時重試一次
  → 連續 7 天失敗 → 降低為每天重試一次

WebSocket 斷線重連策略（建議值）：  <!-- v1.1 修訂 -->
  → 初始重連：指數退避 1s → 2s → 4s → 8s → 16s → 32s → 60s（上限）
  → 1 小時後仍未連上：降為每 5 分鐘一次
  → 24 小時後仍未連上：降為每 30 分鐘一次
  → 重連成功後：
    1. 重新訂閱所有頻道
    2. GET /v1/telemetry/route-suggestions 拉最新路由建議 <!-- v1.2 修訂：修正端點引用 -->
    3. 如有離線積壓數據，排程上傳
```

### 9.3 數據堆積處理

```
待上報的統計數據：
  → 存在 ~/.clawapi/data.db → telemetry_queue 表
  → 最多堆 30 天的數據
  → 超過 30 天的自動丟棄（數據太舊沒有分析價值）
  → VPS 恢復後按時間順序批次上傳
  → 上傳成功後從本機刪除

待上報的 L0 用量：
  → 存在 ~/.clawapi/data.db → l0_usage_queue 表
  → VPS 恢復後批次上報
  → 離線期間本機自行限制 L0 額度（用 device_daily_limits 的本機快取）

背景佇列重試策略（建議值，客戶端可自行調整）：  <!-- v1.1 修訂 -->
  → 0-24 小時：每 15 分鐘重試一次
  → 24 小時-7 天：每小時重試一次
  → 7-30 天：每天重試一次
  → 超過 30 天：丟棄
```

---

## 10. 版本演進策略

### 10.1 API 版本管理

```
當前版本：/v1/
版本策略：新版出來時，舊版繼續運作 6 個月（#111）

v1 → v2 升級流程：
  1. 發布 v2 API
  2. 客戶端更新開始用 /v2/
  3. /v1/ 繼續運作 6 個月
  4. 6 個月後 /v1/ 回傳 301 → /v2/
  5. 再 3 個月後 /v1/ 完全關閉
```

### 10.2 Schema 版本

```
每個 payload 都有 schema_version 欄位：
  - VPS 支援所有 schema_version ≥ 1
  - 新版 schema 向後相容（只加欄位，不改不刪）
  - 不相容變更 → schema_version 加 1 → 舊版仍然支援
```

### 10.3 WebSocket 版本

```
連線時帶 version 參數：
  wss://api.clawapi.com/v1/ws?version=1.0.0

VPS 根據版本決定推送哪些訊息類型：
  - 舊客戶端不會收到新版才加的訊息類型
  - 新訊息類型只推送給支援該類型的客戶端
```

### 10.4 向後相容承諾

```
保證向後相容的：
  ✅ 現有 API 端點不會消失（至少 6 個月前警告）
  ✅ 現有回應欄位不會被刪除或改型別
  ✅ 現有錯誤碼不會被重新定義
  ✅ rate limit 不會變更嚴格（只會放寬）

可能變更的（會提前通知）：
  ⚠️ 新增回應欄位（客戶端應該忽略不認識的欄位）
  ⚠️ 新增 WebSocket 訊息類型（客戶端應該忽略不認識的類型）
  ⚠️ 新增 API 端點
  ⚠️ 放寬 rate limit

向後相容規則（強制）：  <!-- v1.1 修訂 -->
  1. 新欄位必須是 optional（不能是 required）
  2. 客戶端收到未知欄位必須忽略（不報錯）
  3. 伺服器端收到未知欄位必須忽略（不報錯）
  4. 客戶端呼叫不存在的端點（404）時靜默降級，不報錯給用戶
  5. VERSION_TOO_OLD 回應須包含 minimum_version + download_url
```

---

## 附錄 A：完整通訊時序圖

### A.1 首次安裝

```
龍蝦本機                              VPS
   │                                   │
   │──── POST /v1/devices/register ───→│  ① 註冊
   │←─── 200 {device_token, l0_config} │
   │                                   │
   │──── GET /v1/l0/keys ────────────→│  ② 拿 L0 Key
   │←─── 200 {keys, limits} ──────────│
   │                                   │
   │──── GET /v1/version/check ──────→│  ③ 版本檢查
   │←─── 200 {no update} ─────────────│
   │                                   │
   │──── GET /v1/adapters/official ──→│  ④ 官方 Adapter 清單
   │←─── 200 {adapters} ──────────────│
   │                                   │
   │──── WSS /v1/ws ─────────────────→│  ⑤ 建立 WebSocket
   │←─── subscribe_ack ───────────────│
   │                                   │
   │      （龍蝦開始使用 L0 免費功能）    │
   │                                   │
```

### A.2 正常使用（每小時）

```
龍蝦本機                              VPS
   │                                   │
   │──── POST /v1/telemetry/batch ───→│  ① 上報統計
   │←─── 200 {accepted} ──────────────│
   │                                   │
   │──── POST /v1/l0/usage ──────────→│  ② 回報 L0 用量
   │←─── 200 {limits} ────────────────│
   │                                   │
   │              （WebSocket 持續連線）  │
   │←─── routing_update ──────────────│  ③ VPS 推送路由建議
   │                                   │
```

### A.3 互助流程（非同步）— 雙公鑰方案 <!-- v1.1 修訂 -->

```
龍蝦 B                      VPS                      龍蝦 A
   │                         │                         │
   │ Groq Key 全掛了          │                         │  <!-- v1.3 修訂：預登記方案，aid_matched 雙推送 -->
   │                         │                         │
   │── POST /v1/aid/request →│                         │  ① B 請求互助（帶 B 的公鑰）
   │←── 202 {matching} ──────│                         │  ② VPS 回 202，開始配對
   │                         │                         │
   │                         │── 查詢互助池 ──────────→│
   │                         │   找到 A 有閒置 Groq    │
   │                         │  （A 的公鑰已在預登記     │
   │                         │   PUT /v1/aid/config    │
   │                         │   時上傳）                │
   │                         │                         │
   │←── WS: aid_matched ─────│                         │  ③ VPS 配對成功，推 aid_matched 給 B（含 A 的公鑰）
   │                         │── WS: aid_matched ────→│  ③ 同時推 aid_matched 給 A（含 B 的公鑰）
   │                         │                         │
   │  （B 用 ECDH 導出共享     │                         │  （A 用 ECDH 導出共享
   │   金鑰 K，加密 payload   │                         │   金鑰 K，準備接收）
   │   透過 WS 發送給 VPS）    │                         │
   │                         │                         │
   │── WS: aid_payload ─────→│── WS: aid_payload ───→│  ④ B 發送加密 payload，VPS 原封轉發給 A
   │                         │                         │
   │                         │   （A 用 K 解密 payload  │
   │                         │    執行 API 呼叫，        │
   │                         │    用 K 加密回應）         │
   │                         │                         │
   │                         │←── WS: aid_response ───│  ⑤ A 回傳加密結果
   │                         │                         │
   │←── WS: aid_result ──────│                         │  ⑥ VPS 原封轉發給 B（VPS 不碰金鑰）
   │                         │                         │
   │  （B 用 K 解密回應）       │                         │
   │                         │                         │
   │                         │── 記錄：A 互助+1 ───────│  ⑦ 更新記錄
   │                         │── 記錄：B 被幫+1 ───────│
   │                         │                         │

超時流程（30 秒內沒有龍蝦 A 回應）：
   │                         │                         │
   │←── WS: aid_result ──────│                         │  超時
   │   {status: "timeout"}   │                         │
   │                         │                         │
```

---

## 附錄 B：TypeScript 型別定義

> 這些型別同時用在 SPEC-A（客戶端）和 SPEC-B（VPS），確保兩邊講同一個語言。
> 放在共享 package `@clawapi/protocol` 裡。

```typescript
// ============================================================
// 共享型別（@clawapi/protocol）
// ============================================================

// ───── 基礎 ─────

export type ServiceId = string;  // 'groq' | 'openai' | 'anthropic' | 'brave-search' | ...
export type Tier = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type RoutingStrategy = 'fast' | 'smart' | 'cheap';
export type Outcome = 'success' | 'rate_limited' | 'error' | 'timeout';
export type ServiceStatus = 'preferred' | 'degraded' | 'avoid';
export type TimeBucket = 'morning' | 'afternoon' | 'evening';
export type AidDirection = 'given' | 'received';
export type Region = 'asia' | 'europe' | 'americas' | 'other';
export type NotificationKind =
  | 'l0_keys_updated'
  | 'version_available'
  | 'aid_request'
  | 'aid_matched'        // v1.3：互助配對成功通知（預登記方案）
  | 'aid_result'
  | 'adapter_updated'
  | 'service_alert';

// ───── 認證 ─────

export interface DeviceRegistration {
  device_id: string;
  device_fingerprint: string;
  client_version: string;
  os: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  locale: string;
  timezone: string;           // IANA 時區（#83，每日額度重置用）
  region: Region;             // 地區（#88，路由建議分區）
}

export interface DeviceRegistrationResponse {
  device_token: string;
  token_expires_at: string;  // ISO 8601
  l0_config: L0Config;
  vps_public_key: string;            // ECDH P-256 公鑰（VPS↔龍蝦安全通訊用，如加密備份、L0 Key 下發）<!-- v1.2 修訂 -->
  vps_public_key_id: string;         // 版本化（如 "vps_key_v1"）
  assigned_region: Region;           // VPS 判定的地區
  latest_version: string;
  server_time: string;
}

export interface DeviceResetResponse {
  reset: boolean;
  message: string;
}

export interface AuthHeaders {
  'X-Device-Id': string;
  'X-Device-Token': string;
  'X-Client-Version': string;
}

// ───── Google 認證（v1.1+）─────

export interface GoogleAuthRequest {
  google_id_token: string;
  requested_nickname?: string;
}

export interface GoogleAuthResponse {
  bound: boolean;
  google_email: string;          // 遮罩版（前 3 字元 + ***）
  nickname: string;
  features_unlocked: string[];   // ['backup', 'nickname', 'cross_device_sync']
}

// ───── 集體智慧 ─────

export interface TelemetryBatch {
  schema_version: number;
  batch_id: string;
  period: { from: string; to: string };
  entries: TelemetryEntry[];
  summary: TelemetrySummary;
}

export interface TelemetryEntry {
  service_id: ServiceId;
  model?: string;
  tier: Tier;
  outcome: Outcome;
  latency_ms: number;
  token_usage?: { input: number; output: number };
  routing_strategy: RoutingStrategy;
  retry_count: number;
  time_bucket: TimeBucket;
  // time_bucket 劃分規則（以龍蝦本地時區為準）：<!-- v1.4 修訂 -->
  //   morning:   06:00 - 11:59
  //   afternoon: 12:00 - 17:59
  //   evening:   18:00 - 05:59（隔天）
}

export interface TelemetrySummary {
  total_requests: number;
  success_rate: number;
  services_used: ServiceId[];
  pool_stats: {
    king_pool_used: number;
    friend_pool_used: number;
    l0_pool_used: number;
    aid_used: number;
  };
}

export interface TelemetryFeedback {
  recommendation_id: string;
  service_id: ServiceId;
  feedback: 'positive' | 'negative';
  reason?: 'high_latency' | 'errors' | 'quality' | 'other';
  comment?: string;                // 最多 200 字元
}

export interface TelemetryQuota {
  batch_uploads: {
    limit_per_hour: number;
    used_this_hour: number;
    next_allowed_at: string;
  };
  feedback: {
    limit_per_hour: number;
    used_this_hour: number;
  };
  pending_batches: number;
  server_time: string;
}

// ───── L0 ─────

export interface L0Config {
  daily_limit: number;
  services: ServiceId[];
}

export interface L0Key {
  id: string;
  service_id: ServiceId;
  key_encrypted: string | null;  // null = 不需要 Key
  encryption_method: 'aes-256-gcm' | null;
  encryption_key_id: string | null;
  status: 'active' | 'degraded' | 'dead';
  daily_quota_per_device: number | null;  // null = 無限
  total_daily_quota: number | null;
  total_daily_used: number | null;
  donated_by: string | null;
  updated_at: string;
}

export interface L0KeysResponse {
  schema_version: number;
  keys: L0Key[];
  l0_encryption_key: string;
  device_daily_limits: Record<ServiceId, {
    limit: number;
    used: number;
    reset_at: string;
  }>;
  cache_ttl: number;
  server_time: string;
}

// <!-- v1.3 修訂：RSA-OAEP-256 → ECIES（ECDH P-256 + AES-256-GCM），與 SPEC-B v1.2 同步 -->
export interface L0DonateRequest {
  service_id: ServiceId;
  encrypted_key: string;           // AES-256-GCM 加密的 API Key（base64）
  ephemeral_public_key: string;    // 龍蝦的臨時 ECDH P-256 公鑰（base64）
  iv: string;                      // AES-GCM 初始化向量（base64）
  tag: string;                     // AES-GCM 認證標籤（base64）
  display_name?: string;
  anonymous?: boolean;             // v1.2：改為可選，預設 false
}

export interface L0DonateResponse {
  accepted: boolean;
  l0_key_id: string;
  message: string;
  validation: {
    key_valid: boolean;
    service_confirmed: ServiceId;
    estimated_daily_quota: number;
  };
}

// ───── 互助 ─────

// <!-- v1.1 修訂：雙公鑰方案，移除 payload_encrypted / payload_key_encrypted -->
export interface AidRequest {
  service_id: ServiceId;
  request_type: string;
  requester_public_key: string;    // ECDH P-256 公鑰（A 用此做 ECDH 導出共享金鑰）
  max_latency_ms: number;
  context: {
    retry_count: number;
    original_error: string;
  };
}

// 非同步回應：POST /v1/aid/request 返回 202
export interface AidAccepted {
  status: 'matching';
  aid_id: string;
  estimated_wait_ms: number;
  message: string;
}

// 結果透過 WebSocket 推送（見 AidResultNotification）<!-- v1.1 修訂：雙公鑰方案 -->
export interface AidResultNotification {
  kind: 'aid_result';
  aid_id: string;
  status: 'fulfilled' | 'timeout' | 'error';
  response_encrypted?: string;             // status=fulfilled 時有（ECDH 導出金鑰加密）
  encryption_method?: 'aes-256-gcm';
  helper_public_key?: string;              // A 的 ECDH P-256 公鑰（B 用此做 ECDH 解密）
  aid_record?: {
    service_id: ServiceId;
    latency_ms: number;
    helper_device_id: null;  // 永遠是 null（匿名）
  };
  message?: string;                        // status=timeout/error 時有
  suggestion?: string;
}

// <!-- v1.3 修訂：新增互助配對成功通知（預登記方案） -->
export interface AidMatchedNotification {
  type: 'notification';
  kind: 'aid_matched';
  aid_id: string;
  service_id?: ServiceId;        // 只有推給 A 時有
  request_type?: string;         // 只有推給 A 時有
  requester_public_key?: string; // 推給 A 時包含（B 的 ECDH P-256 公鑰）
  helper_public_key?: string;    // 推給 B 時包含（A 的 ECDH P-256 公鑰，從預登記取得）
}

// <!-- v1.4 修訂：互助加密數據交換訊息 -->
// B → VPS → A：求助者發送加密的 API 請求
export interface AidEncryptedRequest {
  type: 'aid_data';
  kind: 'encrypted_request';
  aid_id: string;
  encrypted_payload: string;  // base64, AES-256-GCM 加密的完整 API 請求 body
  iv: string;                 // base64, AES-GCM 初始化向量
  tag: string;                // base64, AES-GCM 認證標籤
}

// A → VPS → B：幫助者回傳加密的 API 回應
export interface AidEncryptedResponse {
  type: 'aid_data';
  kind: 'encrypted_response';
  aid_id: string;
  encrypted_payload: string;  // base64, AES-256-GCM 加密的完整 API 回應 body
  iv: string;
  tag: string;
  helper_public_key: string;  // A 的公鑰（B 用來做 ECDH 解密）
}

export interface AidConfig {
  enabled: boolean;
  allowed_services: ServiceId[] | null;  // null = 全部
  daily_limit: number;
  daily_given: number;
  blackout_hours?: number[];
  helper_public_key?: string;            // ECDH P-256 公鑰（開啟互助時必填）
}

export interface AidStats {
  given: AidStatBlock;
  received: AidStatBlock;
}

export interface AidStatBlock { // <!-- v1.2 修訂：補上 export -->
  today: number;
  this_month: number;
  all_time: number;
  by_service: Record<ServiceId, number>;
}

// ───── WebSocket ─────

// <!-- v1.1 修訂：補上 SubscribeAck 型別定義 -->
export interface SubscribeAckPayload {
  subscribed: string[];            // 已訂閱的頻道清單
  online_count?: number;           // 目前線上龍蝦數
}

export interface WSClientMessage {
  type: string;
  channel: string;
  id: string;
  payload: unknown;
}

export interface WSServerMessage {
  type: string;
  channel: string;
  id: string;
  payload: unknown;
  server_time: string;
}

export interface RoutingRecommendation {
  service_id: ServiceId;
  region: Region;              // 此建議適用的地區（#88）
  status: ServiceStatus;
  confidence: number;
  metrics: {
    success_rate: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    sample_size: number;
  };
  note: string | null;
}

export interface RoutingUpdate {
  schema_version: number;
  generated_at: string;
  valid_until: string;
  recommendations: RoutingRecommendation[];
  alerts: ServiceAlert[];
}

export interface ServiceAlert {
  severity: 'info' | 'warning' | 'critical';
  service_id: ServiceId;
  message: string;
  started_at: string;
}

// <!-- v1.4 修訂：從 ChatMessage 改名為 ChatRoomMessage，避免與 SPEC-A 的 ChatMessage（OpenAI 格式）重名 -->
export interface ChatRoomMessage {
  text: string;
  nickname: string;
  reply_to: string | null;
}

// ───── 版本 ─────

export interface VersionCheckResponse {
  latest_version: string;
  current_version: string;
  update_available: boolean;
  is_critical?: boolean;
  release_notes?: string;
  download_urls?: {
    npm: string;
    brew: string;
    binary: Record<string, string>;
    docker: string;
  };
  min_supported_version?: string;
}

// ───── 錯誤 ─────

export interface APIError {
  error: string;        // 錯誤碼（如 AUTH_INVALID_TOKEN）
  message: string;      // 人類可讀
  suggestion?: string;  // 修復建議
  retry_after?: number; // 秒
  details?: unknown;    // 額外資訊
}

// ───── Sub-Key（#129）─────

export interface SubKeyValidateRequest {
  sub_key: string;           // sk_live_xxx
  service_id: ServiceId;
}

export interface SubKeyValidateResponse {
  valid: boolean;
  service_id: ServiceId;
  permissions: {
    models: string[] | null;    // null = 全部
    rate_limit: number;          // 每小時上限
    rate_remaining: number;      // 本小時剩餘
    expires_at: string | null;   // null = 不過期
  };
}

// ───── 備份（v1.1+）─────

export interface BackupUploadHeaders {
  'X-Backup-Version': string;
  'X-Backup-Checksum': string;   // SHA-256
  'X-Google-Token': string;
}

export interface BackupUploadResponse {
  uploaded: boolean;
  backup_size: number;
  server_checksum: string;
  stored_at: string;
}

export interface BackupDownloadHeaders {
  'X-Backup-Version': string;
  'X-Backup-Checksum': string;
  'X-Backup-Stored-At': string;
}

export interface BackupDeleteResponse {
  deleted: boolean;
  message: string;
}

// ───── VPSClient 相容型別（v1.4 修訂） ─────<!-- v1.4 修訂 -->
// SPEC-A 的 VPSClient interface 引用的型別，確保名稱一致

// POST /v1/telemetry/feedback 的 request body（= TelemetryFeedback）
export type RoutingFeedback = TelemetryFeedback;

// POST /v1/l0/usage 的 entries 元素
export interface L0UsageEntry {
  l0_key_id: string;
  service_id: ServiceId;
  count: number;                    // 自上次回報後用了幾次
  last_used_at: string;             // ISO 8601
}

// POST /v1/l0/donate 的 request body（= L0DonateRequest）
export type DonateKeyParams = L0DonateRequest;

// POST /v1/aid/request 的 request body（= AidRequest）
export type AidRequestParams = AidRequest;

// POST /v1/aid/request 的 202 response（= AidAccepted）
export type AidRequestResponse = AidAccepted;

// GET /v1/adapters/updates 的 response
export interface AdapterUpdatesResponse {
  updates: Array<{
    adapter_id: string;
    current_version: string;
    latest_version: string;
    is_official: boolean;
    changelog: string;
    download_url: string;
    auto_update: boolean;
  }>;
  new_official_adapters: Array<{
    adapter_id: string;
    version: string;
    description: string;
    download_url: string;
  }>;
}

// GET /v1/adapters/official 的 response
export interface AdapterListResponse {
  adapters: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    category: string;
    requires_key: boolean;
    free_tier: boolean;
    download_url: string;
  }>;
  last_updated: string;
}

// WebSocket notification 的通用格式
export interface Notification {
  type: 'notification';
  channel: 'notifications';
  id: string;
  payload: {
    kind: NotificationKind;
    message?: string;
    action?: string;
    [key: string]: unknown;       // 各 kind 有不同的額外欄位
  };
  server_time: string;
}

// WebSocket chat message 事件（客戶端 → VPS 和 VPS → 客戶端）
export interface ChatMessageEvent {
  type: 'chat_message';
  channel: string;                 // "chat:{channel_name}"
  id: string;
  payload: ChatRoomMessage;        // 見 ChatRoomMessage 型別
  server_time?: string;            // 只有 VPS → 客戶端時有
}

// 幫助者回傳的互助回應 payload（A → VPS 的 aid_response 完整格式）
export interface AidResponsePayload {
  aid_id: string;
  status: 'fulfilled' | 'rejected' | 'error';
  response_encrypted?: string;     // status=fulfilled 時有（ECDH 導出金鑰加密）
  encryption_method?: 'aes-256-gcm';
  helper_public_key?: string;      // A 的 ECDH P-256 公鑰（B 用此做 ECDH 解密）
  latency_ms?: number;
  error_message?: string;          // status=error 時有
}
```

---

## 附錄 C：開源 vs 閉源邊界

> 這份通訊協議就是「合約」。開源包和閉源 VPS 各自實作自己那一邊。

```
┌────────────────────┬────────────────────────────────────────┐
│                    │  實作方                                 │
│  通訊介面          ├──────────────┬─────────────────────────┤
│                    │  客戶端（開源） │  VPS（閉源）            │
├────────────────────┼──────────────┼─────────────────────────┤
│ 裝置註冊           │ 發送請求     │ 處理註冊、發 token       │
│ 集體智慧上報        │ 收集 + 發送  │ 接收 + 分析 + 產生建議   │
│ 路由建議推送        │ 接收 + 應用  │ 產生 + 推送              │
│ L0 Key 下發        │ 接收 + 快取  │ 管理 + 下發 + 監控額度   │
│ L0 用量回報        │ 計算 + 發送  │ 接收 + 聚合 + 調整額度   │
│ 互助請求           │ 發起/執行    │ 配對 + 中繼 + 記錄       │
│ 互助設定           │ UI + 發送    │ 儲存 + 查詢             │
│ 版本檢查           │ 請求 + 顯示  │ 提供版本資訊             │
│ Adapter 更新       │ 請求 + 安裝  │ 提供更新清單             │
│ 雲端備份           │ 加密 + 上傳  │ 儲存 + 下發             │
│ Sub-Key 驗證       │ 發行 + 管理  │ 中繼驗證 + 快取         │
│ 路由回饋           │ 收集 + 發送  │ 接收 + 影響下次建議     │
│ 聊天室             │ 發送 + 顯示  │ 中繼 + 管理頻道         │
│ WebSocket 管理     │ 連線 + 重連  │ 認證 + 推送 + 保活       │
├────────────────────┼──────────────┼─────────────────────────┤
│ 共享型別包         │ @clawapi/protocol（開源，npm 發布）      │
├────────────────────┼──────────────┴─────────────────────────┤
│ 護城河             │ VPS 的集體智慧分析引擎 + 累積的數據       │
│                    │ 有人 fork 開源包可以自架 VPS，            │
│                    │ 但沒有數據 = 沒有集體智慧的價值           │
└────────────────────┴────────────────────────────────────────┘
```

### 如果有人 fork 了開源包

```
他可以：
  ✅ 自架 VPS 實作 SPEC-C 的所有介面
  ✅ 讓他自己的龍蝦社群用
  ✅ 這是 AGPL 允許的

他做不到：
  ❌ 拿到 tkman VPS 的集體智慧數據（護城河）
  ❌ 拿到 L0 公共 Key（那是 tkman 和社群捐的）
  ❌ 接入 tkman 的互助網絡（不同 VPS 的龍蝦互不相通）

所以護城河 = 數據 + 網絡效應 + 公共資源池
```

---

> **這份 SPEC-C 是 ClawAPI 最重要的合約文件。**
> 開源引擎（SPEC-A）和 VPS 服務（SPEC-B）各自實作自己那一邊。
> 只要雙方都遵守這份合約，整個系統就能運作。
>
> — 老大，2026-02-28（v1.0）
> — v1.1 修訂：2026-03-01（R-03 錯誤碼統一、R-04/O-02 雙公鑰方案、Y-05~Y-08 精確化）
> — v1.4 修訂：2026-03-01（紅隊 A 類修復：aid_data 訊息格式、HKDF 精確參數、time_bucket 定義、VPSClient 型別補齊、ChatMessage 重名修正、安全標注）
