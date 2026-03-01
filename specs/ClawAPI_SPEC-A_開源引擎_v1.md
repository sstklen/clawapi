# ClawAPI SPEC-A：開源引擎規格書 v1.1

> **龍蝦本機引擎的完整技術規格**
> 本文件定義了安裝在龍蝦電腦上的開源引擎的所有模組、介面、資料結構和行為。
> 最後更新：2026-03-01
> 狀態：草案 v1.1，待 tkman 確認
> 依據：計畫書 v4.0（170 項決策）+ SPEC-C 通訊協議 v1.0

---

## 目錄

1. [模組架構圖](#1-模組架構圖)
2. [內部資料結構](#2-內部資料結構)
3. [DB Schema](#3-db-schema)
4. [五層路由引擎](#4-五層路由引擎)
5. [Key 池管理](#5-key-池管理)
6. [模組公開 API](#6-模組公開-api)
7. [API 端點完整清單](#7-api-端點完整清單)
8. [CLI 命令完整規格](#8-cli-命令完整規格)
9. [MCP Server 規格](#9-mcp-server-規格)
10. [設定檔 config.yaml 完整 schema](#10-設定檔-configyaml-完整-schema)
11. [Adapter YAML Schema v1](#11-adapter-yaml-schema-v1)
12. [安全模型](#12-安全模型)
13. [L0 免費層](#13-l0-免費層)
14. [互助客戶端邏輯](#14-互助客戶端邏輯)
15. [Sub-Key 系統](#15-sub-key-系統)
16. [Web UI 架構](#16-web-ui-架構)
17. [錯誤碼完整清單](#17-錯誤碼完整清單)
18. [VPS 通訊模組](#18-vps-通訊模組)
19. [測試計畫](#19-測試計畫)
20. [效能預算](#20-效能預算)
21. [OpenClaw 相容性](#21-openclaw-相容性)

---

## 1. 模組架構圖

### 1.1 模組總覽

```
┌─────────────────────────────────────────────────────────────────┐
│                        ClawAPI 本機引擎                          │
│                                                                  │
│  ┌──────────────────── 入口層 ────────────────────────────────┐ │
│  │                                                            │ │
│  │  ┌─────────┐  ┌───────────────┐  ┌──────────┐            │ │
│  │  │   CLI   │  │  HTTP Server  │  │   MCP    │            │ │
│  │  │ (指令列) │  │   (Hono)     │  │  Server  │            │ │
│  │  └────┬────┘  └──────┬────────┘  └────┬─────┘            │ │
│  │       │              │                │                    │ │
│  └───────┼──────────────┼────────────────┼────────────────────┘ │
│          │              │                │                       │
│  ┌───────┴──────────────┴────────────────┴────────────────────┐ │
│  │                      認證中介層 (Auth)                      │ │
│  │           auth.token 驗證 + Sub-Key 驗證                   │ │
│  └──────────────────────┬─────────────────────────────────────┘ │
│                         │                                        │
│  ┌──────────────────────┴─────────────────────────────────────┐ │
│  │                     路由引擎 (Router)                       │ │
│  │          L0 → L1 → L2 → L3 → L4 層級判斷                  │ │
│  └──┬────────┬────────┬────────┬────────┬─────────────────────┘ │
│     │        │        │        │        │                        │
│  ┌──┴──┐ ┌──┴──┐ ┌──┴──┐ ┌──┴──┐ ┌──┴──┐                     │
│  │ L0  │ │ L1  │ │ L2  │ │ L3  │ │ L4  │                     │
│  │免費層│ │直轉 │ │路由 │ │管家 │ │任務 │                     │
│  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘                     │
│     │        │        │        │        │                        │
│  ┌──┴────────┴────────┴────────┴────────┴─────────────────────┐ │
│  │                    Key 池管理 (KeyPool)                     │ │
│  │        龍蝦王池 → 親友分身池 → L0 公共池 → 互助池            │ │
│  └──────────────────────┬─────────────────────────────────────┘ │
│                         │                                        │
│  ┌──────────────────────┴─────────────────────────────────────┐ │
│  │                   Adapter 執行器 (Adapter)                  │ │
│  │            YAML 載入 → 請求建構 → 上游呼叫 → 回應解析        │ │
│  └──────────────────────┬─────────────────────────────────────┘ │
│                         │                                        │
│  ┌─────────────────── 基礎設施層 ─────────────────────────────┐ │
│  │                                                            │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │ │
│  │  │  Crypto  │  │    DB    │  │  Logger  │  │Scheduler │  │ │
│  │  │  加密模組 │  │  SQLite  │  │  日誌    │  │ 排程器   │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │ │
│  │                                                            │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │ │
│  │  │VPSClient │  │Telemetry │  │ AidClient│  │ SubKey   │  │ │
│  │  │VPS 通訊  │  │統計收集  │  │互助客戶端│  │Sub-Key   │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │ │
│  │                                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────────── UI 層 ────────────────────────────────┐  │
│  │  ┌────────────────────────────────────┐                    │  │
│  │  │         Web UI (Hono SSR + HTMX)   │                    │  │
│  │  │  Dashboard / Keys / SubKeys / Aid  │                    │  │
│  │  │  Adapters / Logs / Settings / Chat │                    │  │
│  │  └────────────────────────────────────┘                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 1.2 模組依賴圖

```
CLI ─────────┐
HTTP Server ─┤──→ Auth ──→ Router ──→ KeyPool ──→ Adapter ──→ [上游 API]
MCP Server ──┘              │                        │
                            ├──→ L0 Manager          │
                            ├──→ L3 Concierge ───────┤
                            └──→ L4 TaskEngine ──────┘
                                     │
KeyPool ──→ Crypto ──→ DB           │
SubKey ──→ Auth                      │
AidClient ──→ VPSClient ──→ Crypto  │
Telemetry ──→ VPSClient             │
L0 Manager ──→ VPSClient ──→ DB    │
Scheduler ──→ [Telemetry, L0, VPSClient, DB]
Logger ──→ [所有模組都依賴 Logger]
Web UI ──→ [所有業務模組]
```

### 1.3 模組職責一覽

| 模組 | 檔案路徑 | 職責 |
|------|---------|------|
| **Core** | `src/index.ts`, `src/server.ts` | 應用啟動、生命週期管理、優雅關機 |
| **Auth** | `src/core/auth.ts` | auth.token 管理、Sub-Key 驗證、請求來源檢查 |
| **Router** | `src/core/router.ts` | L0-L4 層級判斷、路由策略選擇 |
| **KeyPool** | `src/core/key-pool.ts` | Key CRUD、池優先級、健康偵測、Round-Robin |
| **Crypto** | `src/core/encryption.ts` | AES-256-GCM 加解密、master.key、ECDH P-256 |
| **Adapter** | `src/adapters/loader.ts`, `executor.ts` | YAML 載入、安全掃描、請求建構、回應解析 |
| **L0** | `src/l0/` | 公共 Key 管理、內建 API、每日限額 |
| **L1** | `src/layers/l1-proxy.ts` | 指定服務直轉 |
| **L2** | `src/layers/l2-gateway.ts` | 智慧路由 + Failover |
| **L3** | `src/layers/l3-concierge.ts` | 金鑰匙意圖解讀、工具選擇 |
| **L4** | `src/layers/l4-task.ts` | 多步驟任務規劃、智慧並行、斷點續作 |
| **SubKey** | `src/sharing/sub-key.ts` | Sub-Key 發行、驗證、撤銷、用量追蹤 |
| **AidClient** | `src/sharing/mutual-aid.ts` | 互助請求發起、ECDH 加密、結果處理 |
| **Telemetry** | `src/intelligence/telemetry.ts` | 統計收集、MessagePack 批次上報 |
| **VPSClient** | `src/intelligence/vps-client.ts` | HTTPS + WebSocket 通訊 |
| **DB** | `src/storage/database.ts` | SQLite WAL 操作、遷移 |
| **Scheduler** | `src/core/scheduler.ts` | 背景任務排程（健康檢查、上報、WAL checkpoint） |
| **Logger** | `src/core/logger.ts` | 結構化 JSON 行日誌、敏感資料遮罩 |
| **WebUI** | `src/ui/` | Hono SSR + HTMX 頁面 |
| **API** | `src/api/` | OpenAI 相容端點 + 簡化端點 |
| **MCP** | `src/mcp/` | MCP Server + 12 個 tools |
| **CLI** | `cli/` | 命令列工具 |
| **Backup** | `src/storage/backup.ts` | 匯出/匯入/雲端備份 |
| **i18n** | `src/core/i18n.ts` | 多語系（zh-TW/en/ja） |

---

## 2. 內部資料結構

> 所有 TypeScript 型別定義。SPEC-C 附錄 B 的 `@clawapi/protocol` 共享型別直接引用，此處不重複。

### 2.1 核心型別

```typescript
// ===== 應用設定 =====

interface ClawAPIConfig {
  server: {
    port: number;                    // 預設 4141，被佔用自動跳號（#109）
    host: string;                    // 預設 '127.0.0.1'
    auto_port: boolean;              // 預設 true
  };
  routing: {
    default_strategy: RoutingStrategy;  // 'fast' | 'smart' | 'cheap'
    failover_enabled: boolean;          // 預設 true
    max_retries_per_key: number;        // 預設 1（#67）
    timeout: LayerTimeouts;
  };
  telemetry: {
    enabled: boolean;                // 預設 true，龍蝦可關閉（#106）
    upload_interval_ms: number;      // 預設 3600000（1 小時）
    max_pending_days: number;        // 預設 30
  };
  l0: {
    enabled: boolean;                // 預設 true
    ollama_auto_detect: boolean;     // 預設 true（#43）
  };
  aid: {
    enabled: boolean;                // 預設 false（自願開啟 #159）
    allowed_services: string[] | null; // null = 全部
    daily_limit: number;             // 預設 50
    blackout_hours: number[];        // 預設 []
  };
  gold_key: {
    reserve_percent: number;         // 預設 5（金鑰匙預留 5% 防腦死 #B3）
    default_model: string | null;    // 預設推薦用 'groq/llama-3.3-70b'
  };
  ui: {
    theme: 'light' | 'dark' | 'system';  // #98
    locale: 'zh-TW' | 'en' | 'ja';       // #51
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    retention_days: number;          // 預設 30（#102）
  };
  backup: {
    auto_backup_interval_hours: number | null;  // null = 不自動備份
  };
}

// <!-- v1.4 修訂：以下為 SPEC-A 本地擴展版本，實作時請從 @clawapi/protocol 匯入基礎型別 -->
// <!-- 本地版本可包含額外的客戶端專用欄位 -->
type RoutingStrategy = 'fast' | 'smart' | 'cheap';

interface LayerTimeouts {
  l1: number;    // 預設 30000 ms（#149）
  l2: number;    // 預設 30000 ms
  l3: number;    // 預設 60000 ms
  l4_step: number;   // 預設 60000 ms
  l4_total: number;  // 預設 300000 ms（5 分鐘）
}
```

### 2.2 Key 池型別

```typescript
// ===== Key 池 =====

type PoolType = 'king' | 'friend';  // 龍蝦王池 / 親友分身池
type KeyStatus = 'active' | 'rate_limited' | 'dead';

interface StoredKey {
  id: number;
  service_id: string;              // 'groq', 'openai', 'brave-search' ...
  key_encrypted: Uint8Array;       // AES-256-GCM 加密後的 Key
  pool_type: PoolType;
  label: string | null;            // '媽媽的 Groq Key'
  status: KeyStatus;
  priority: number;                // 同池內優先順序（0=自動，正數=釘選）
  daily_used: number;
  monthly_used: number;
  estimated_quota: number | null;  // 估算的月額度上限
  last_success_at: string | null;  // ISO 8601
  last_error: string | null;       // 最後錯誤碼
  consecutive_failures: number;    // 連續失敗次數（3 次 → dead）
  rate_limit_until: string | null; // 限速冷卻到什麼時候
  created_at: string;
  updated_at: string;
}

interface DecryptedKey {
  id: number;
  service_id: string;
  key_value: string;               // 明文 Key（僅在記憶體中短暫存在）
  pool_type: PoolType;
  status: KeyStatus;
  pinned: boolean;                 // 是否釘選（#78）<!-- v1.4 修訂 -->
}

interface KeySelectionResult {
  key: DecryptedKey;
  source: 'king_pool' | 'friend_pool' | 'l0_pool' | 'aid_pool';
  reason: string;                  // 為什麼選這把
}

// ===== 金鑰匙 =====

interface GoldKey {
  id: number;
  service_id: string;
  key_encrypted: Uint8Array;
  model_id: string;                // 'llama-3.3-70b'
  is_active: boolean;
  daily_used: number;
  daily_limit: number | null;      // 龍蝦可設每日金鑰匙上限（#B9）
  created_at: string;
}
```

### 2.3 路由型別

```typescript
// ===== 路由引擎 =====

type LayerType = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

interface RouteRequest {
  // 來自 OpenAI 相容 API
  model: string;                   // 'groq/llama-3.3-70b' | 'auto' | 'ask' | 'task'
  messages: ChatMessage[];
  stream: boolean;
  // ClawAPI 擴充
  strategy?: RoutingStrategy;      // 覆寫全域策略（#69）
  preferred_service?: string;      // 偏好的服務
  no_fallback?: boolean;           // 寧可失敗也不換模型（#68）
  max_gold_key_tokens?: number;    // 單次金鑰匙上限
  // Sub-Key 資訊（Auth 層注入）
  sub_key_id?: number;
  sub_key_quota_remaining?: number;
}

interface RouteResult {
  layer: LayerType;
  service_id: string;
  model: string;
  response: APIResponse;
  key_source: 'king_pool' | 'friend_pool' | 'l0_pool' | 'aid_pool';
  latency_ms: number;
  retry_count: number;
  // 消耗透明度（#27）
  usage: UsageReport;
  // Failover 資訊（#68）
  original_model?: string;         // 如果發生了模型切換
  fallback_reason?: string;
}

interface UsageReport {
  services_used: Array<{
    service_id: string;
    model: string;
    tokens_input: number;
    tokens_output: number;
    cost_estimate_usd: number | null;
  }>;
  gold_key_tokens: number;         // 金鑰匙消耗（L3/L4）
  total_latency_ms: number;
  layer: LayerType;
}

// ===== 路由建議（集體智慧）=====
// 引用 @clawapi/protocol 的 RoutingRecommendation 型別

interface LocalRoutingIntel {
  recommendations: import('@clawapi/protocol').RoutingRecommendation[];
  fetched_at: string;
  valid_until: string;
  is_stale: boolean;               // 超過 valid_until 但離線可用
}
```

### 2.4 Adapter 型別

```typescript
// ===== Adapter =====

interface AdapterDefinition {
  schema_version: number;          // 1
  adapter: {
    id: string;                    // 'groq', 'brave-search'
    name: string;                  // 'Groq'
    version: string;               // '1.0.0'
    author: string;
    category: AdapterCategory;
    description: string;
    is_official: boolean;
  };
  auth: AdapterAuth;
  endpoints: Record<string, AdapterEndpoint>;
  health_check: AdapterHealthCheck | null;
  rate_limits: AdapterRateLimits;
  fallback_for: string[];          // 可作為哪些服務的備援
  capabilities: AdapterCapabilities;
}

type AdapterCategory = 'llm' | 'search' | 'translation' | 'image' | 'audio' | 'embedding' | 'other';

interface AdapterAuth {
  type: 'none' | 'bearer' | 'header' | 'query_param' | 'oauth2';
  header_name?: string;            // auth.type='header' 時用
  query_param_name?: string;       // auth.type='query_param' 時用
}

interface AdapterEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;                     // 支持模板變數 {{ model }}, {{ query }}
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body_template?: string;          // JSON 模板
  response: {
    type: 'json' | 'sse' | 'text';
    result_path?: string;          // JSONPath 取結果
    map?: Record<string, string>;  // 欄位映射
    stream_format?: 'openai_sse' | 'anthropic_sse' | 'google_stream' | 'raw_sse';
  };
}

interface AdapterCapabilities {
  chat: boolean;
  streaming: boolean;
  embeddings: boolean;
  images: boolean;
  audio: boolean;
  multimodal_input: boolean;       // 支援圖片/影片輸入（#62）
  tool_use: boolean;               // 支援 function calling（#61）
  models: string[];                // 支援的模型清單
}

interface AdapterRateLimits {
  requests_per_minute: number | null;
  requests_per_day: number | null;
  tokens_per_minute: number | null;
  tokens_per_day: number | null;
}

interface AdapterHealthCheck {
  url: string;
  expected_status: number;
  timeout_ms: number;              // 預設 5000
}
```

### 2.5 Sub-Key 型別

```typescript
// ===== Sub-Key =====

interface SubKey {
  id: number;
  token: string;                   // 'sk_live_xxxxxxxx'（隨機 UUID）
  label: string;                   // '小明'
  daily_limit: number | null;      // null = 無上限
  daily_used: number;
  allowed_services: string[] | null; // null = 全部（#81）
  allowed_models: string[] | null;   // null = 全部（#81）
  rate_limit_per_hour: number | null; // null = 無上限（#73）
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;       // null = 不過期
}

interface SubKeyValidation {
  valid: boolean;
  sub_key: SubKey | null;
  rejection_reason?: string;       // 'EXPIRED' | 'REVOKED' | 'DAILY_LIMIT' | 'SERVICE_NOT_ALLOWED'
}
```

### 2.6 互助型別

```typescript
// ===== 互助 =====

// <!-- v1.4 修訂：以下為 SPEC-A 本地擴展版本，實作時請從 @clawapi/protocol 匯入基礎型別 -->
// <!-- 本地版本可包含額外的客戶端專用欄位 -->
interface AidConfig {
  enabled: boolean;
  allowed_services: string[] | null;
  daily_limit: number;
  daily_given: number;
  blackout_hours: number[];
  helper_public_key: string | null;  // ECDH P-256 公鑰（Base64）
}

// <!-- v1.2 修訂：移除 payload_encrypted/payload_key_encrypted，雙公鑰方案下 VPS 不需要 payload -->
// <!-- v1.4 修訂：以下為 SPEC-A 本地擴展版本，實作時請從 @clawapi/protocol 匯入基礎型別 -->
// <!-- 本地版本可包含額外的客戶端專用欄位 -->
// 發送給 VPS 的互助請求（VPS 只看 service_id 做配對，不碰任何密文）
interface AidRequest {
  aid_id: string;
  service_id: string;
  request_type: string;            // 'chat_completion' 等
  requester_public_key: string;    // Base64 ECDH P-256 公鑰（求助者的公鑰）
  max_latency_ms: number;
  context: {
    retry_count: number;
    original_error: string;
  };
}

// <!-- v1.2 修訂：移除舊欄位，改用雙公鑰 ECDH 方案 -->
// 收到 VPS 推送的互助配對通知（我是幫助者）
// 幫助者 A 收到後，用 ECDH(A 私鑰, requester_public_key) 算出共享金鑰
interface IncomingAidRequest {
  aid_id: string;
  service_id: string;
  request_type: string;            // 'chat_completion' 等
  requester_public_key: string;    // Base64 ECDH P-256 公鑰（求助者 B 的公鑰）
  timeout_ms: number;
}

interface AidRecord {
  id: number;
  timestamp: string;
  direction: 'given' | 'received';
  service_id: string;
  success: boolean;
  latency_ms: number;
}
```

### 2.7 L0 型別

```typescript
// ===== L0 免費層 =====

interface L0PublicKey {
  id: string;                      // 'l0k_001'
  service_id: string;
  key_encrypted: string | null;    // Base64，null = 不需要 Key
  encryption_method: string | null;
  encryption_key_id: string | null;
  status: 'active' | 'degraded' | 'dead';
  daily_quota_per_device: number | null;
  total_daily_quota: number | null;
  total_daily_used: number | null;
  donated_by: string | null;
  updated_at: string;
}

interface L0DeviceLimit {
  service_id: string;
  limit: number;
  used: number;
  reset_at: string;                // ISO 8601
}

interface L0Cache {
  keys: L0PublicKey[];
  l0_encryption_key: string | null; // Base64
  device_daily_limits: Record<string, L0DeviceLimit>;
  fetched_at: string;
  cache_ttl: number;               // 秒
}
```

### 2.8 通用型別

```typescript
// ===== 通用 =====

// <!-- v1.4 修訂：此 ChatMessage 為 OpenAI 相容 API 的訊息格式，
//    與 SPEC-C 附錄 B 的 ChatRoomMessage（聊天室訊息）不同。
//    ChatMessage = API 請求/回應中的對話訊息（role/content 格式）
//    ChatRoomMessage = 龍蝦聊天室的即時通訊訊息（sender/text 格式）
//    兩者用途不同，不共用型別。-->
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ContentPart {
  type: 'text' | 'image_url' | 'audio';
  text?: string;
  image_url?: { url: string; detail?: string };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface APIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  // <!-- v1.2 修訂：統一前綴為 x_clawapi（慣例擴展欄位前綴）-->
  // ClawAPI 擴充欄位
  x_clawapi: {
    requested_model: string;       // 龍蝦要求的 model（#66）
    actual_model: string;          // 實際使用的 model（#66）
    layer: LayerType;
    service_id: string;
    key_source: string;
    latency_ms: number;
    gold_key_tokens?: number;
    warnings?: string[];           // 切換通知等（#68）
  };
}

interface Choice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

// ===== 裝置身份 =====

interface DeviceIdentity {
  device_id: string;               // 'clw_xxxx'
  device_fingerprint: string;      // 硬體指紋 SHA-256 前 16 字元
  created_at: string;
}

// ===== ECDH 金鑰對 =====

interface ECDHKeyPair {
  public_key: string;              // Base64 uncompressed P-256
  private_key: string;             // Base64（加密儲存）
  created_at: string;
  expires_at: string;              // 30 天後（自動輪換）
}

// ===== 錯誤 =====

interface ClawAPIError {
  code: string;                    // 'ENGINE_UPSTREAM_429_RATE_LIMITED'
  message: string;                 // 人類可讀
  suggestion: string | null;       // 建議修復指令
  tried: TriedRecord[];            // 已嘗試的紀錄（#115）
  details?: Record<string, unknown>;
}

interface TriedRecord {
  service_id: string;
  key_id: number;                  // 遮罩後只顯示 label
  outcome: 'success' | 'rate_limited' | 'error' | 'timeout';
  latency_ms: number;
  error_code?: string;
}
```

---

## 3. DB Schema

> SQLite WAL 模式。所有時間欄位為 ISO 8601 字串。

### 3.1 完整 SQL

```sql
-- ============================================
-- ClawAPI 本機資料庫 Schema v1
-- 檔案位置：~/.clawapi/data.db
-- ============================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ===== Schema 版本管理 =====

CREATE TABLE schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT
);

INSERT INTO schema_version (version, description)
VALUES (1, '初始 schema');

-- ===== 裝置身份 =====

CREATE TABLE device (
  device_id TEXT PRIMARY KEY,                       -- 'clw_xxxx'
  device_fingerprint TEXT NOT NULL,                  -- 硬體指紋
  device_token TEXT,                                 -- VPS 認證 token（dtoken_xxxx）
  device_token_expires_at TEXT,                      -- Token 到期時間
  vps_public_key TEXT,                               -- VPS ECDH 公鑰（Base64）
  vps_public_key_id TEXT,                            -- 'vps_key_v1'
  assigned_region TEXT,                              -- 'asia' | 'europe' | 'americas' | 'other'
  google_id TEXT,                                    -- Google 帳號 ID（可選）
  google_email_masked TEXT,                          -- 'use***@gmail.com'
  nickname TEXT,                                     -- 顯示暱稱
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== ECDH 金鑰對 =====

CREATE TABLE device_keypair (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_key TEXT NOT NULL,                          -- Base64
  private_key_encrypted BLOB NOT NULL,               -- AES-256-GCM 加密
  is_current INTEGER NOT NULL DEFAULT 1,             -- 當前使用中
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL                            -- 30 天後
);

CREATE INDEX idx_keypair_current ON device_keypair(is_current) WHERE is_current = 1;

-- ===== API Key 池 =====

CREATE TABLE keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  key_encrypted BLOB NOT NULL,                       -- AES-256-GCM 加密
  pool_type TEXT NOT NULL CHECK (pool_type IN ('king', 'friend')),
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rate_limited', 'dead')),
  priority INTEGER NOT NULL DEFAULT 0,               -- 0=自動, 正數=釘選優先
  pinned INTEGER NOT NULL DEFAULT 0,                 -- 1=釘選永遠優先（#78）
  daily_used INTEGER NOT NULL DEFAULT 0,
  monthly_used INTEGER NOT NULL DEFAULT 0,
  estimated_quota INTEGER,                           -- 估算月額度上限
  consecutive_failures INTEGER NOT NULL DEFAULT 0,   -- 連續失敗次數
  rate_limit_until TEXT,                             -- 限速冷卻到期時間
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_keys_service ON keys(service_id, status);
CREATE INDEX idx_keys_pool ON keys(pool_type, service_id);

-- 每服務最多 5 把 Key 的約束（#26）用應用層檢查，不用 DB trigger
-- 原因：trigger 的錯誤訊息對龍蝦不友善

-- ===== 金鑰匙 =====

CREATE TABLE gold_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  key_encrypted BLOB NOT NULL,
  model_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  daily_used INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER,                               -- 龍蝦可設每日上限
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 金鑰匙不能跟 Key 池用相同 Key（#39），應用層檢查

-- ===== Sub-Key =====

CREATE TABLE sub_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,                        -- 'sk_live_xxxxxxxx'
  label TEXT,
  daily_limit INTEGER,
  daily_used INTEGER NOT NULL DEFAULT 0,
  allowed_services TEXT,                             -- JSON: ["groq","brave"] 或 null
  allowed_models TEXT,                               -- JSON: ["llama-3.3-70b"] 或 null
  rate_limit_per_hour INTEGER,                       -- 每小時上限
  rate_used_this_hour INTEGER NOT NULL DEFAULT 0,
  rate_hour_start TEXT,                              -- 當前小時開始時間
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,                                   -- null = 不過期
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX idx_subkeys_token ON sub_keys(token) WHERE is_active = 1;

-- ===== 使用紀錄 =====

CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  service_id TEXT NOT NULL,
  model TEXT,
  layer TEXT NOT NULL CHECK (layer IN ('L0','L1','L2','L3','L4')),
  key_id INTEGER,                                    -- REFERENCES keys(id)
  sub_key_id INTEGER,                                -- 如果是 Sub-Key 觸發的
  pool_source TEXT,                                  -- 'king_pool' | 'friend_pool' | 'l0_pool' | 'aid_pool'
  success INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  error_code TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  routing_strategy TEXT,                             -- 'fast' | 'smart' | 'cheap'
  retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_usage_timestamp ON usage_log(timestamp);
CREATE INDEX idx_usage_service ON usage_log(service_id, timestamp);
CREATE INDEX idx_usage_subkey ON usage_log(sub_key_id) WHERE sub_key_id IS NOT NULL;

-- ===== L0 公共 Key 快取 =====

CREATE TABLE l0_keys (
  id TEXT PRIMARY KEY,                               -- 'l0k_001'
  service_id TEXT NOT NULL,
  key_encrypted TEXT,                                -- Base64（null = 不需 Key）
  encryption_method TEXT,
  encryption_key_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'degraded', 'dead')),
  daily_quota_per_device INTEGER,
  total_daily_quota INTEGER,
  total_daily_used INTEGER,
  donated_by TEXT,
  updated_at TEXT NOT NULL
);

-- ===== L0 個人用量 =====

CREATE TABLE l0_device_usage (
  service_id TEXT NOT NULL,
  date TEXT NOT NULL,                                -- '2026-03-01'
  used_count INTEGER NOT NULL DEFAULT 0,
  limit_count INTEGER NOT NULL,
  PRIMARY KEY (service_id, date)
);

-- ===== 路由建議快取 =====

CREATE TABLE routing_intel (
  service_id TEXT NOT NULL,
  region TEXT NOT NULL,                              -- 'asia' | 'europe' | 'americas' | 'other'
  status TEXT NOT NULL,                              -- 'preferred' | 'degraded' | 'avoid'
  confidence REAL NOT NULL,
  success_rate REAL,
  avg_latency_ms INTEGER,
  p95_latency_ms INTEGER,
  sample_size INTEGER,
  note TEXT,
  updated_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  PRIMARY KEY (service_id, region)
);

-- ===== 互助設定 =====

CREATE TABLE aid_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),             -- 單列設定
  enabled INTEGER NOT NULL DEFAULT 0,
  allowed_services TEXT,                             -- JSON array 或 null
  daily_limit INTEGER NOT NULL DEFAULT 50,
  daily_given INTEGER NOT NULL DEFAULT 0,
  blackout_hours TEXT,                               -- JSON array: [0,1,2,3,4,5]
  helper_public_key TEXT,                            -- ECDH P-256 公鑰（Base64）
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO aid_config (id, enabled) VALUES (1, 0);

-- ===== 互助記錄 =====

CREATE TABLE aid_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aid_id TEXT NOT NULL,                              -- 'aid_xxxx'
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  direction TEXT NOT NULL CHECK (direction IN ('given', 'received')),
  service_id TEXT NOT NULL,
  success INTEGER NOT NULL,
  latency_ms INTEGER
);

CREATE INDEX idx_aid_log_direction ON aid_log(direction, timestamp);
CREATE INDEX idx_aid_log_aid_id ON aid_log(aid_id);  -- <!-- v1.2 修訂：補上 aid_id 索引，用於依 aid_id 查詢互助記錄 -->

-- ===== 統計上報佇列 =====

CREATE TABLE telemetry_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT UNIQUE NOT NULL,
  payload BLOB NOT NULL,                             -- MessagePack 編碼
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_retry_at TEXT
);

CREATE INDEX idx_telemetry_queue_created ON telemetry_queue(created_at);

-- ===== L0 用量上報佇列 =====

CREATE TABLE l0_usage_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,                             -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== 設定 KV 儲存 =====

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== 每日重置觸發器 =====
-- 以下重置在應用層由 Scheduler 執行，不用 DB trigger：
-- 1. keys.daily_used → 0（每日 00:00 本地時區 #83）
-- 2. sub_keys.daily_used → 0
-- 3. gold_keys.daily_used → 0
-- 4. aid_config.daily_given → 0
-- 5. l0_device_usage → 新日期新行
```

### 3.2 遷移策略（#119）

```typescript
// DB 啟動時檢查版本，逐版遷移
interface Migration {
  version: number;
  description: string;
  up: string;    // SQL 語句
}

const migrations: Migration[] = [
  // v1 → v2 範例（未來用）
  // {
  //   version: 2,
  //   description: '新增 XXX 欄位',
  //   up: 'ALTER TABLE xxx ADD COLUMN yyy TEXT;'
  // }
];

// 遷移邏輯：
// 1. 讀取 schema_version 表最新版本號
// 2. 找出所有 version > 當前版本的 migration
// 3. 在 transaction 內逐一執行
// 4. 插入新版本記錄到 schema_version
// 5. 失敗則 rollback，拒絕啟動
```

---

## 4. 五層路由引擎

### 4.1 層級判斷邏輯

```typescript
// 路由引擎入口
function routeRequest(req: RouteRequest): Promise<RouteResult> {
  // Step 1：解析 model 欄位，判斷層級
  const layer = determineLayer(req.model, req.messages);

  switch (layer) {
    case 'L0': return l0Handler.handle(req);
    case 'L1': return l1Handler.handle(req);
    case 'L2': return l2Handler.handle(req);
    case 'L3': return l3Handler.handle(req);
    case 'L4': return l4Handler.handle(req);
  }
}

function determineLayer(model: string, messages: ChatMessage[]): LayerType {
  // <!-- v1.4 修訂：移除 L0 層的描述。L0 不是獨立的路由層，
  //    而是 Key 池的 fallback 層，見 §5.1 池優先級說明。
  //    determineLayer 只處理 L1-L4，L0 由 KeyPool.selectKey() 內部降級觸發。-->
  // model 格式：'service/model' → L1（指定服務直轉）
  // model = 'auto' → L2（智慧路由）
  // model = 'ask' → L3（AI 管家）
  // model = 'task' → L4（任務引擎）

  if (model.includes('/')) return 'L1';
  if (model === 'auto') return 'L2';
  if (model === 'ask') return 'L3';
  if (model === 'task') return 'L4';

  // 識別已知模型名 → L2（如 'llama-3.3-70b' → 找哪個服務有這個模型）
  if (isKnownModel(model)) return 'L2';

  // 預設 → L2
  return 'L2';
}
```

### 4.2 L0 免費層

<!-- v1.4 修訂：釐清 L0 定位 -->
```
定位：L0 不是獨立的路由層，而是 Key 池的 fallback 層。
      當 L2 路由選 Key 時，如果龍蝦王池和親友池都無可用 Key，
      KeyPool.selectKey() 會自動降級到 L0 公共池。
      龍蝦完全沒有自己的 Key 時：路由引擎走 L2 → KeyPool 選 Key
      → 發現沒有個人 Key → 降級到 L0 池。

觸發方式：由 KeyPool.selectKey() 內部降級觸發（見 §5.1），
          不由 determineLayer() 判斷。

處理流程：
  1. 檢查請求類型（chat / search / ...）
  2. 找對應的 L0 資源：
     a. 內建免費 API（DuckDuckGo, Ollama）→ 不需 Key，直接呼叫
     b. L0 公共 Key（從 VPS 下發）→ 檢查個人每日限額
  3. 限額到了 → 回傳友善提示「加自己的 Key 可以無限使用」
  4. 呼叫上游 → 成功回傳 / 失敗嘗試下一個 L0 資源

Key 選取順序：
  1. 本機 Ollama（如果偵測到且請求是 LLM）
  2. DuckDuckGo（如果請求是搜尋）
  3. L0 公共 Groq Key（如果請求是 LLM）
  4. 其他公共 Key（如有）
```

### 4.3 L1 直轉

```
觸發條件：model = 'service_id/model_name'（如 'groq/llama-3.3-70b'）

處理流程：
  1. 解析 service_id 和 model_name
  2. 從 Key 池選該服務的 Key（龍蝦王池 → 親友池 → L0 → 互助）
  3. 載入對應 Adapter
  4. 建構請求 → 直接呼叫上游
  5. 不做 Failover（龍蝦指定了就照做）
  6. 失敗 → 同服務換下一把 Key 重試（#67 每把 Key 試一次）
  7. 同服務全掛 → 回傳錯誤（因為龍蝦指定了服務，不自動換）

例外：如果 no_fallback = false（預設），可以嘗試同服務不同 Key
     如果 no_fallback = true，一把 Key 失敗就直接報錯
```

### 4.4 L2 智慧路由

```
觸發條件：model = 'auto' 或已知模型名

處理流程：
  1. 根據請求類型（chat/search/translate/embed/image/audio）找所有可用服務
  2. 根據路由策略排序：

     fast（快）：
       → 按 p95_latency_ms 升序排列
       → 集體智慧建議 status='preferred' 的排前面

     smart（聰明，預設）：
       → 綜合分數 = success_rate * 0.4 + (1 - normalized_latency) * 0.3
                    + quota_remaining_ratio * 0.2 + collective_boost * 0.1
       → collective_boost = 集體智慧 confidence * (preferred=1, degraded=0.5, avoid=0)

       <!-- v1.4 修訂：邊界條件定義 -->
       邊界條件：
       → normalized_latency = min(p95_latency_ms, 30000) / 30000
         （超過 30 秒視為最慢，歸一化到 0-1）
       → quota_remaining_ratio = estimated_quota 為 null 時預設 0.5
         （不知道額度時假設用了一半）
       → collective_boost:
         - confidence * 1.0（preferred）/ 0.5（degraded）/ 0（avoid）
         - 離線無集體智慧數據時 = 0（不加分不減分）
       → 所有變數確保在 [0, 1] 範圍內（超出範圍 clamp 到 0 或 1）

     cheap（省）：
       → 免費服務排前面（T0）
       → 同為免費的按額度剩餘排序
       → 付費服務放最後

  3. 龍蝦釘選的 Key 永遠排在最前面（#78）
  4. 跳過 status = 'dead' 的 Key
  5. 跳過 status = 'rate_limited' 且冷卻未到期的 Key
  6. 按排好的順序逐一嘗試：
     a. 選 Key → 載入 Adapter → 建構請求 → 呼叫上游
     b. 成功 → 回傳
     c. 429 → 標記限速（指數退避 #148：1s, 2s, 4s, 8s, max 300s）→ 下一個
     d. 401/403 → 標記死亡 → 下一個
     e. 超時/網路錯誤 → consecutive_failures++ → 3 次就標記死亡 → 下一個
  7. 全掛 → 友善錯誤 + tried 記錄 + 建議（#28）

Failover 跨服務邏輯（#62）：
  → 多模態請求（含圖片/影片）→ 只 failover 到支援 multimodal_input 的服務
  → tool_use 請求 → 只 failover 到支援 tool_use 的服務
  → 格式自動轉換（#61）：OpenAI tool_use → Anthropic tool_use 格式轉換

模型切換通知（#68）：
  → 如果 failover 換了模型 → response.x_clawapi.warnings 加入：  <!-- v1.2 修訂：統一 x_clawapi 前綴 -->
    「ℹ️ 已切換到 Groq/llama-3.3-70b（原本的 Claude 目前限速中）」
  → 如果 no_fallback = true → 不跨服務，直接報錯
```

### 4.5 L3 AI 管家

```
觸發條件：model = 'ask'
前提：龍蝦有設定金鑰匙（#12, #39）

處理流程：
  1. 檢查金鑰匙是否可用
     → 沒設金鑰匙 → 回傳錯誤 + 建議：'clawapi gold-key set'
     → 金鑰匙今日額度用完 → 降級到 L2（#B3 預留 5%）

  2. 用金鑰匙 LLM 解讀龍蝦意圖
     System Prompt（內建，可覆寫 #120）：

     """
     你是 ClawAPI AI 管家。分析用戶的請求，決定需要呼叫哪些工具。

     可用工具：
     {{available_tools}}  ← 根據龍蝦安裝的 Adapter 動態注入

     回傳格式（JSON）：
     {
       "understanding": "用戶想要...",
       "steps": [
         {"tool": "brave-search", "params": {"query": "..."}},
         {"tool": "deepl", "params": {"text": "...", "target": "zh-TW"}}
       ]
     }

     規則：
     - 如果聽不懂，回傳 {"clarification": "你是要搜尋還是要翻譯？"}（#70）
     - 步驟之間如果有依賴關係，用 depends_on 標注
     """

  3. 解析金鑰匙回應 → 取得步驟清單
  4. 如果需要澄清 → 回傳問題給龍蝦（#70）
  5. 依序執行步驟（有依賴按順序，無依賴可並行）
     → 每步用 L2 路由引擎呼叫（享受 Failover）
  6. 整合所有結果 → 用金鑰匙 LLM 產生最終回答
  7. 附帶完整消耗報告：
     → 金鑰匙消耗：XX tokens
     → 各步驟消耗：搜尋 x1, 翻譯 x1
     → 思考過程完全透明（#145）
```

### 4.6 L4 任務引擎

```
觸發條件：model = 'task'
前提：龍蝦有設定金鑰匙

處理流程：
  1. 金鑰匙檢查（同 L3）

  2. 用金鑰匙 LLM 規劃任務
     System Prompt：

     """
     你是 ClawAPI 任務規劃引擎。把用戶的大任務拆解成可執行步驟。

     可用工具：{{available_tools}}

     回傳格式（JSON）：
     {
       "plan": {
         "goal": "用戶的目標",
         "estimated_calls": 10,
         "estimated_gold_key_tokens": 800,
         "steps": [
           {
             "id": "step_1",
             "tool": "brave-search",
             "params": {"query": "..."},
             "depends_on": [],
             "retry_on_fail": true
           },
           {
             "id": "step_2",
             "tool": "brave-search",
             "params": {"query": "..."},
             "depends_on": [],           ← step_1 和 step_2 可同時跑（#138）
             "retry_on_fail": true
           },
           {
             "id": "step_3",
             "tool": "llm_analysis",
             "params": {"input": "{{step_1.result}} + {{step_2.result}}"},
             "depends_on": ["step_1", "step_2"],  ← 等前兩步完成
             "retry_on_fail": false
           }
         ]
       }
     }
     """

  3. 成本預估 → 顯示給龍蝦（#B9）：
     「預估需要 10 次 API 呼叫 + 800 tokens 金鑰匙消耗，要繼續嗎？」
     → 如果是 streaming → 直接開始（進度透過 SSE 即時推送）
     → 如果龍蝦設了 max_gold_key_tokens → 超過就暫停

  4. 智慧並行執行（#138）：
     → 分析 depends_on 依賴圖
     → 無依賴的步驟同時啟動（Promise.all）
     → 有依賴的等前置步驟完成

  5. 每步執行：
     → 用 L2 路由引擎呼叫
     → 失敗 → retry_on_fail = true → 最多重試 3 次（#71）
     → 3 次都失敗 → 標記步驟失敗，繼續執行其他步驟

  6. 收集所有結果 → 用金鑰匙 LLM 整合：
     → 成功步驟的結果整合成完整報告
     → 失敗步驟標註「此部分未能取得」
     → 回傳部分結果 + 失敗步驟的說明（#71）

  7. 附帶完整消耗報告（同 L3，但更詳細）

  8. 斷點存檔（#133）：
     → L4 執行到一半如果系統關機
     → 已完成的步驟結果存入 DB
     → 下次啟動時讀取斷點 → 從未完成的步驟繼續
     → 斷點資料保留 24 小時，過期自動清除

金鑰匙保護（#B3）：
  → 金鑰匙使用量即時追蹤
  → 剩餘額度 < 5% → L3/L4 自動降級到 L2
  → 降級時回傳 warning：「金鑰匙額度即將用完，已降級到 L2 智慧路由」
```

---

## 5. Key 池管理

### 5.1 池優先級

<!-- v1.4 修訂：強化 L0 作為 Key 池 fallback 層的描述 -->
```
選 Key 的順序（每次 API 呼叫時，由 selectKey() 內部依序降級）：

  1. 龍蝦王池（pool_type = 'king'）
     → 龍蝦自己的 Key，最高優先
     → 如果有 pinned = 1 的 Key → 永遠排最前面（#78）
     → 其餘按路由策略排序

  2. 親友分身池（pool_type = 'friend'）
     → 別人給龍蝦的 Key
     → 龍蝦王池該服務全掛才用親友池

  3. L0 公共池（fallback 層，非獨立路由層）
     → 從 VPS 動態下發的公共 Key
     → 親友池也掛了才用 L0
     → 受每人每日限額控制
     → 離線時用快取（最多到快取到期）
     → 注意：L0 不由 determineLayer() 判斷，而是 selectKey()
       在龍蝦王池和親友池都無可用 Key 時自動降級觸發

  4. 互助池
     → L0 也掛/額度完才觸發互助
     → 走 VPS 中繼（需網路）
     → 非同步：POST → 202 → WebSocket 等結果
```

### 5.2 Key CRUD

```typescript
interface KeyPoolManager {
  // === 新增 Key ===
  addKey(params: {
    service_id: string;
    key_value: string;              // 明文，加密後存入
    pool_type: PoolType;
    label?: string;
  }): Promise<{
    key_id: number;
    validation: KeyValidationResult;
  }>;
  // 流程：
  // 1. 檢查同服務 Key 數量 < 5（#26）
  // 2. 檢查是否跟金鑰匙重複（#39）
  // 3. AES-256-GCM 加密 Key
  // 4. 存入 DB
  // 5. 即時驗證有效性（#74 打一次輕量請求）
  // 6. 回傳驗證結果

  // === 刪除 Key ===
  removeKey(key_id: number): Promise<void>;

  // === 列出 Key ===
  listKeys(service_id?: string): Promise<KeyListItem[]>;
  // 回傳時 Key 值遮罩：'gsk_****7890'（#150）

  // === 更新 Key 狀態 ===
  updateKeyStatus(key_id: number, status: KeyStatus): Promise<void>;

  // === 釘選 Key ===
  pinKey(key_id: number, pinned: boolean): Promise<void>;

  // === 輪換 Key ===
  rotateKey(key_id: number, new_key_value: string): Promise<void>;
  // 同時更新所有相關映射（#B10）

  // === 選 Key（路由引擎呼叫）===
  selectKey(params: {
    service_id: string;
    strategy: RoutingStrategy;
    exclude_key_ids?: number[];     // 排除已嘗試過的
  }): Promise<KeySelectionResult | null>;
  // 回傳 null = 該服務沒有可用 Key
}

interface KeyListItem {
  id: number;
  service_id: string;
  key_masked: string;              // 'gsk_****7890'
  pool_type: PoolType;
  label: string | null;
  status: KeyStatus;
  pinned: boolean;
  daily_used: number;
  estimated_quota: number | null;
  quota_percent: number | null;    // 已用百分比（額度顯示 #141）
  last_success_at: string | null;
}

interface KeyValidationResult {
  valid: boolean;
  service_confirmed: string | null;  // 確認是什麼服務的 Key
  error?: string;                    // 驗證失敗原因
}
```

### 5.3 健康偵測

```
三態偵測（被動式，每次呼叫時偵測 #11）：

  呼叫成功 → status = 'active', consecutive_failures = 0

  收到 429 → status = 'rate_limited'
    → rate_limit_until = 現在 + 退避時間
    → 退避時間：指數退避（#148）
      第 1 次 429：等 1 秒
      第 2 次 429：等 2 秒
      第 3 次 429：等 4 秒
      第 4 次 429：等 8 秒
      ...
      最長等 300 秒（5 分鐘）
    → 冷卻到期後恢復 'active'

  收到 401/403 → status = 'dead'
    → 保留但標記「☠️ 已失效」（#77）
    → 通知龍蝦：附供應商官網連結（#57）

  收到其他錯誤 / 超時 → consecutive_failures++
    → consecutive_failures >= 3 → status = 'dead'
    → consecutive_failures < 3 → 保持原狀態

Key 過期提醒（#75）：
  → Adapter 如果有定義 Key 過期日期的規則 → 偵測到快過期（3 天內）→ 通知龍蝦
```

### 5.4 Round-Robin 選 Key（#72）

```typescript
// 同服務多把 Key 的輪流策略
// 目的：分散限速風險

class RoundRobinSelector {
  // 內部維護每個 service_id 的 lastIndex
  private lastIndex: Map<string, number> = new Map();

  select(keys: DecryptedKey[], strategy: RoutingStrategy): DecryptedKey | null {  // <!-- v1.4 修訂：回傳可為 null（無可用 Key 時）-->
    // 先過濾：跳過 dead + 冷卻中的 rate_limited
    const available = keys.filter(k =>
      k.status === 'active' ||
      (k.status === 'rate_limited' && isCooldownExpired(k))
    );

    if (available.length === 0) return null;

    // pinned 的排最前面
    const pinned = available.filter(k => k.pinned);
    if (pinned.length > 0) return pinned[0];

    // Round-Robin
    const idx = (this.lastIndex.get(keys[0].service_id) ?? -1) + 1;
    const selected = available[idx % available.length];
    this.lastIndex.set(keys[0].service_id, idx);

    return selected;
  }
}
```

---

## 6. 模組公開 API

### 6.1 Crypto 模組

```typescript
interface CryptoModule {
  // === Master Key 管理 ===
  initMasterKey(): Promise<void>;
  // 首次啟動 → 產生隨機 32 bytes → 存入 ~/.clawapi/master.key
  // 後續啟動 → 讀取 master.key

  getMasterKey(): Uint8Array;
  // 從記憶體取（不重複讀檔）

  // === AES-256-GCM 加解密 ===
  encrypt(plaintext: string): Uint8Array;
  // 用 master.key 加密，回傳 [IV(12) + AuthTag(16) + CipherText]

  decrypt(ciphertext: Uint8Array): string;
  // 用 master.key 解密

  // === ECDH P-256 金鑰對 ===
  generateECDHKeyPair(): Promise<ECDHKeyPair>;
  // 產生 P-256 金鑰對，私鑰用 master.key 加密存入 DB

  getCurrentKeyPair(): Promise<ECDHKeyPair>;
  // 取得當前金鑰對（is_current = 1）
  // 如果過期（> 30 天）→ 自動產生新的，舊的保留 7 天

  deriveSharedSecret(
    myPrivateKey: string,
    theirPublicKey: string
  ): Promise<Uint8Array>;
  // ECDH 導出共享密鑰 → 用於互助加密

  // <!-- v1.2 修訂：改用雙公鑰 ECDH 直接導出 AES 金鑰，不再需要額外的對稱金鑰包裝 -->
  // <!-- v1.4 修訂：加入 aid_id 參數，對齊 SPEC-C 的 HKDF salt=aid_id -->
  // === 互助加密 ===
  encryptForAid(
    data: string,
    recipientPublicKey: string,
    aid_id: string                   // 互助請求 ID，作為 HKDF salt 確保每次會話金鑰不同
  ): Promise<{
    encrypted: string;               // Base64（AES-256-GCM 密文 + IV + AuthTag）
  }>;
  // 流程：
  // 1. ECDH(myPrivateKey, recipientPublicKey) → sharedSecret
  // 2. HKDF(sharedSecret, salt=aid_id, info="clawapi-aid-v1") → aesKey（32 bytes）
  // 3. AES-256-GCM(aesKey, randomIV) 加密 data
  // 4. 回傳 Base64(IV + ciphertext + authTag)

  decryptFromAid(
    encryptedData: string,
    senderPublicKey: string,
    aid_id: string                   // 互助請求 ID，作為 HKDF salt（與加密端相同）
  ): Promise<string>;
  // 流程：
  // 1. ECDH(myPrivateKey, senderPublicKey) → sharedSecret（與加密端相同）
  // 2. HKDF(sharedSecret, salt=aid_id, info="clawapi-aid-v1") → aesKey
  // 3. 從 encryptedData 拆出 IV + ciphertext + authTag
  // 4. AES-256-GCM 解密 → 回傳明文

  // === 備份加密 ===
  encryptForBackup(data: string, password: string): Uint8Array;
  // PBKDF2(password, salt, 100K iterations) → AES-256-GCM

  decryptFromBackup(encrypted: Uint8Array, password: string): string;

  // === Key 遮罩（#150）===
  maskKey(keyValue: string): string;
  // 'gsk_1234567890abcdef' → 'gsk_****cdef'
  // 顯示前 4 + 後 4
}
```

### 6.2 Auth 模組

```typescript
interface AuthModule {
  // === auth.token 管理 ===
  initToken(): Promise<void>;
  // 首次啟動 → 產生隨機 token → 存入 ~/.clawapi/auth.token
  // 後續啟動 → 讀取

  getToken(): string;

  resetToken(): Promise<string>;
  // clawapi token reset（#116）

  // === 請求驗證 ===
  validateRequest(req: Request): AuthResult;
  // 1. 取出 Authorization: Bearer xxx
  // 2. 比對 auth.token
  // 3. 如果是 Sub-Key token（sk_live_xxx）→ 走 Sub-Key 驗證
  // 4. 可選：檢查 User-Agent/PID（#91）

  // === Sub-Key 驗證 ===
  validateSubKey(token: string): SubKeyValidation;
}

interface AuthResult {
  authenticated: boolean;
  auth_type: 'master' | 'sub_key';
  sub_key?: SubKey;
  error?: string;
}
```

### 6.3 DB 模組

```typescript
interface DatabaseModule {
  init(): Promise<void>;
  // 開啟 DB（WAL 模式）→ 檢查版本 → 自動遷移

  close(): Promise<void>;
  // WAL checkpoint → 關閉連線

  // === 通用操作 ===
  query<T>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  transaction<T>(fn: () => T): T;

  // === WAL 維護 ===
  checkpoint(): void;
  // 定期由 Scheduler 呼叫（每 15 分鐘 #112）

  // === 每日重置 ===
  dailyReset(timezone: string): void;
  // 重置所有每日計數器
}
```

<!-- v1.1 修訂 -->
#### 3.3 SQLite 併發控制

```typescript
/**
 * 寫入緩衝區
 * 非關鍵寫入（用量記錄、遙測數據等）先進 buffer，定期批次 flush。
 * 關鍵寫入（Key 新增/刪除、設定變更）直接寫入不走 buffer。
 */
interface WriteBuffer {
  /** 待寫入的操作佇列 */
  queue: WriteOperation[];
  /** buffer 滿了強制 flush */
  maxSize: 100;
  /** 每 5 秒 flush 一次 */
  flushInterval: 5000;

  /** 批次寫入（包在單一 transaction 內） */
  flush(): Promise<void>;
}

interface WriteOperation {
  /** SQL 語句 */
  sql: string;
  /** 綁定參數 */
  params: unknown[];
  /** 寫入類型：critical 直接寫，buffered 走 buffer */
  priority: 'critical' | 'buffered';
}

/**
 * SQLITE_BUSY 重試策略
 * 當 SQLite 回傳 BUSY（其他連線持有鎖），用指數退避重試。
 */
const BUSY_RETRY = {
  maxRetries: 3,
  baseDelay: 50,    // ms
  maxDelay: 500,    // ms
  strategy: 'exponential' as const,  // 50ms → 100ms → 200ms
};

/**
 * 寫入分類規則：
 *   關鍵寫入（直接寫入）：
 *     → Key 新增/刪除/狀態變更
 *     → 設定變更（config.yaml 對應的 DB 更新）
 *     → Sub-Key 發行/撤銷
 *     → 金鑰匙設定/移除
 *
 *   非關鍵寫入（走 WriteBuffer）：
 *     → usage_log 寫入
 *     → telemetry_queue 新增
 *     → l0_usage_queue 新增
 *     → aid_log 寫入
 *     → 每日計數器更新（daily_used 等）
 */
```

### 6.4 Scheduler 模組

```typescript
interface SchedulerModule {
  start(): void;
  stop(): void;

  // 排程任務清單（#112）
  // ┌────────────────────────┬────────────┬──────────────────────┐
  // │ 任務                   │ 頻率       │ 做什麼               │
  // ├────────────────────────┼────────────┼──────────────────────┤
  // │ health_check           │ 每 5 分鐘   │ 檢查 VPS 連線狀態    │
  // │ telemetry_upload       │ 每 1 小時   │ 批次上報匿名統計      │
  // │ wal_checkpoint         │ 每 15 分鐘  │ SQLite WAL checkpoint│
  // │ l0_refresh             │ 每 6 小時   │ 從 VPS 更新 L0 Key   │
  // │ version_check          │ 每 24 小時  │ 檢查新版本           │
  // │ adapter_update         │ 每次啟動    │ 檢查 Adapter 更新    │
  // │ daily_reset            │ 每日 00:00  │ 重置每日計數器       │
  // │ log_cleanup            │ 每日 03:00  │ 清理 > 30 天的日誌   │
  // │ keypair_rotation       │ 每日 04:00  │ 檢查 ECDH 金鑰到期   │
  // │ telemetry_queue_cleanup│ 每日 05:00  │ 清理 > 30 天的待上報  │
  // │ key_expiry_check       │ 每小時      │ 檢查 Key 到期提醒     │
  // └────────────────────────┴────────────┴──────────────────────┘
}
```

<!-- v1.1 修訂 -->
#### Key 到期檢查排程（#75）

```
新增排程任務：key_expiry_check
  頻率：每小時
  邏輯：掃描所有 Key 的 expires_at 欄位
    → 到期前 7 天：通知（info 級別）
    → 到期前 3 天：警告（warning 級別，#75）
    → 已到期：自動停用（status → 'dead'），通知（error 級別）
  通知管道：
    → Web UI 通知列（Dashboard 頂部橫幅）
    → CLI 啟動時顯示
    → 系統通知（如果作業系統支援且龍蝦啟用）
  注意：
    → 只檢查有 expires_at 的 Key（null = 不過期）
    → 同一把 Key 的同級別通知每天最多 1 次（不洗版）
    → Sub-Key 的 expires_at 也一起檢查
```

### 6.5 Logger 模組

```typescript
interface LoggerModule {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;

  // 自動遮罩敏感資料（#150）
  // → Key 值只顯示前 4 + 後 4
  // → 請求/回應內容不記錄
  // → auth.token 不記錄

  // 輸出格式（#118）：
  // 檔案：JSON Lines（~/.clawapi/logs/clawapi.log）
  // {"ts":"2026-03-01T12:00:00Z","level":"info","msg":"請求成功","service":"groq","latency":180}
  //
  // CLI 顯示：格式化人類可讀版
  // 12:00:00 ✅ groq/llama-3.3-70b 180ms
}
```

<!-- v1.1 修訂 -->
### 6.6 i18n 多語系模組（#117）

```typescript
/**
 * 多語系模組
 * 支援 zh-TW（預設）、en、ja 三種語言。
 * 翻譯檔為 JSON 格式，放在 locales/ 目錄。
 */
interface I18nModule {
  /** 翻譯檔目錄 */
  localesDir: './locales/';  // locales/zh-TW.json, locales/en.json, locales/ja.json

  /**
   * 語言偵測優先順序：
   * 1. config.yaml 的 ui.locale 設定
   * 2. CLI --lang 參數
   * 3. 系統語言（process.env.LANG）
   * 4. 預設 'en'
   */
  detectOrder: ['config', 'cli_flag', 'system_locale', 'default_en'];

  /** 取得翻譯字串，支援參數插值 */
  t(key: string, params?: Record<string, string>): string;

  /** 切換語言（即時生效） */
  setLocale(locale: 'zh-TW' | 'en' | 'ja'): void;

  /** 取得當前語言 */
  getLocale(): string;
}

// 翻譯檔結構範例（zh-TW.json）：
// {
//   "key.added": "已新增 Key：{provider}",
//   "key.expired": "Key {name} 將在 {days} 天後到期",
//   "key.dead": "Key {name} 已失效",
//   "routing.switch": "已切換至 {provider}（原因：{reason}）",
//   "aid.requesting": "正在請求互助...",
//   "aid.received": "收到互助 Key，有效期 {minutes} 分鐘",
//   "l0.limit_reached": "今天的免費 {service} 額度用完了",
//   "startup.ready": "準備就緒！",
//   "shutdown.draining": "正在等待進行中的請求完成..."
// }
```

---

## 7. API 端點完整清單

### 7.1 OpenAI 相容 API（#18, #65, #125）

> 所有端點遵循 OpenAI API 格式，讓龍蝦的工具無縫接入。
> Base URL: `http://localhost:{PORT}/v1/`

```
POST   /v1/chat/completions       聊天完成（核心端點，含 SSE streaming）
GET    /v1/models                  列出可用模型
POST   /v1/embeddings              向量嵌入（#65）
POST   /v1/images/generations      圖片生成（#65）
POST   /v1/audio/transcriptions    語音轉文字（#65，multipart/form-data）
POST   /v1/audio/speech            語音合成（#65，回傳 binary audio stream）  <!-- v1.1 修訂 -->
POST   /v1/audio/translations      語音翻譯
POST   /v1/files                   檔案上傳（供其他端點引用）
GET    /v1/files                   列出檔案
GET    /v1/files/{file_id}         取得檔案資訊
DELETE /v1/files/{file_id}         刪除檔案
```

### 7.2 ClawAPI 簡化 API（#18）

```
POST   /api/llm                    簡化版 LLM 呼叫
POST   /api/search                 簡化版搜尋
POST   /api/translate              簡化版翻譯
POST   /api/ask                    L3 AI 管家入口
POST   /api/task                   L4 任務引擎入口
```

### 7.3 管理 API

```
GET    /api/status                 引擎狀態（在線模型、Key 數量、成功率）
GET    /api/keys                   列出 Key（遮罩版）
POST   /api/keys                   新增 Key
DELETE /api/keys/{id}              刪除 Key
PUT    /api/keys/{id}/pin          釘選/取消釘選
PUT    /api/keys/{id}/rotate       輪換 Key

GET    /api/gold-keys              列出金鑰匙
POST   /api/gold-keys              設定金鑰匙
DELETE /api/gold-keys/{id}         移除金鑰匙

GET    /api/sub-keys               列出 Sub-Key
POST   /api/sub-keys               發行 Sub-Key
DELETE /api/sub-keys/{id}          撤銷 Sub-Key
GET    /api/sub-keys/{id}/usage    Sub-Key 用量

GET    /api/aid/config             互助設定
PUT    /api/aid/config             更新互助設定
GET    /api/aid/stats              互助統計

GET    /api/adapters               列出 Adapter
POST   /api/adapters/install       安裝社群 Adapter
DELETE /api/adapters/{id}          移除 Adapter

GET    /api/logs                   查詢使用紀錄（#96 搜尋+篩選）
GET    /api/logs/export            匯出 CSV

GET    /api/l0/status              L0 狀態（可用服務、今日剩餘額度）

POST   /api/backup/export          匯出加密備份
POST   /api/backup/import          匯入備份
POST   /api/backup/cloud/upload    雲端備份上傳（v1.1+）
POST   /api/backup/cloud/download  雲端備份下載（v1.1+）

GET    /api/settings               取得設定
PUT    /api/settings               更新設定

GET    /api/telemetry/pending      查看待上報內容（#42 匿名保護）
PUT    /api/telemetry/enabled      開關統計上報
```

### 7.4 SSE 端點

```
GET    /api/events                 SSE 即時事件流（Dashboard 用 #94）
                                   → 新請求、Key 狀態變化、通知
```

### 7.5 `/v1/chat/completions` 詳細規格

```typescript
// ───── Request ─────
// Headers:
//   Authorization: Bearer {auth.token 或 sk_live_xxx}
//   Content-Type: application/json

// <!-- v1.2 修訂：補上 Tool 型別定義（OpenAI Function Calling 相容格式）-->
interface Tool {
  type: 'function';
  function: {
    name: string;                    // 函式名稱
    description?: string;            // 函式描述
    parameters?: Record<string, unknown>;  // JSON Schema 格式的參數定義
  };
}

interface ChatCompletionRequest {
  model: string;
  // 格式：
  //   'groq/llama-3.3-70b'  → L1 直轉指定服務
  //   'llama-3.3-70b'       → L2 自動找有這模型的服務
  //   'auto'                → L2 完全自動
  //   'ask'                 → L3 AI 管家
  //   'task'                → L4 任務引擎

  messages: ChatMessage[];
  stream?: boolean;                  // 預設 false
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: Tool[];
  tool_choice?: string | object;

  // ClawAPI 擴充（以 x_ 前綴避免衝突）
  x_strategy?: RoutingStrategy;      // 覆寫路由策略
  x_no_fallback?: boolean;           // 不換模型
  x_max_gold_tokens?: number;        // 金鑰匙上限
  x_preferred_service?: string;      // 偏好服務
}

// ───── Response 200（非 streaming）─────
interface ChatCompletionResponse {
  id: string;                        // 'chatcmpl-xxxx'
  object: 'chat.completion';
  created: number;
  model: string;                     // 實際使用的 model
  choices: [{
    index: 0;
    message: ChatMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length';
  }];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  // ClawAPI 擴充
  x_clawapi: {
    requested_model: string;
    actual_model: string;
    service_id: string;             // <!-- v1.4 修訂：統一為 service_id（原 actual_service）-->
    layer: LayerType;
    key_source: string;
    latency_ms: number;
    gold_key_tokens?: number;
    retry_count: number;
    warnings?: string[];
  };
}

// ───── Response 200（streaming SSE #64）─────
// Content-Type: text/event-stream
//
// data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1709136000,"model":"llama-3.3-70b","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
//
// data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1709136000,"model":"llama-3.3-70b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"x_clawapi":{...}}
//
// data: [DONE]

// ───── Response 4xx/5xx ─────
interface ErrorResponse {
  error: {
    code: string;                    // ClawAPI 錯誤碼
    message: string;
    suggestion?: string;
    tried?: TriedRecord[];           // 已嘗試的 Key/服務（#28）
  };
}
```

<!-- v1.1 修訂 -->
### 7.6 `POST /v1/embeddings` 詳細規格（#65）

> OpenAI 相容向量嵌入端點。走五層路由引擎，Adapter 需定義 embeddings endpoint。

```typescript
// ───── Request ─────
// Headers:
//   Authorization: Bearer {auth.token 或 sk_live_xxx}
//   Content-Type: application/json

/**
 * 向量嵌入請求
 * 將文字轉換為向量表示，用於語意搜尋、分類等場景。
 */
interface EmbeddingRequest {
  /** 模型名稱（如 'openai/text-embedding-3-small' 或 'auto'） */
  model: string;
  /** 要嵌入的文字（字串或字串陣列） */
  input: string | string[];
  /** 回傳格式：'float' 或 'base64'，預設 'float' */
  encoding_format?: 'float' | 'base64';
}

// ───── Response 200 ─────

interface EmbeddingResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    /** 向量資料（float 陣列或 base64 字串，取決於 encoding_format） */
    embedding: number[] | string;
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
  // ClawAPI 擴充
  x_clawapi: {
    service_id: string;             // <!-- v1.4 修訂：統一為 service_id（原 actual_service）-->
    layer: LayerType;
    key_source: string;
    latency_ms: number;
  };
}

// 路由邏輯：
//   → model = 'service/model' → L1 直轉
//   → model = 'auto' 或已知 embedding 模型 → L2 路由
//   → Adapter 的 capabilities.embeddings 必須為 true
//   → 不支援 L3/L4（embeddings 不需要 AI 管家）
//
// Adapter 對映：
//   → Adapter YAML 的 endpoints.embeddings 定義
//   → 如果 Adapter 沒定義 embeddings endpoint → ENGINE_ROUTE_NO_ADAPTER
//
// 錯誤處理：
//   → 模型不支援 embedding → ENGINE_ROUTE_MODEL_NOT_FOUND
//   → Key 全掛 → ENGINE_KEY_ALL_EXHAUSTED（同 chat/completions 流程）
```

### 7.7 `POST /v1/images/generations` 詳細規格（#65）

> OpenAI 相容圖片生成端點。走五層路由引擎，Adapter 需定義 images endpoint。

```typescript
// ───── Request ─────
// Headers:
//   Authorization: Bearer {auth.token 或 sk_live_xxx}
//   Content-Type: application/json

/**
 * 圖片生成請求
 * 根據文字描述產生圖片。
 */
interface ImageGenerationRequest {
  /** 模型名稱（如 'openai/dall-e-3' 或 'auto'） */
  model: string;
  /** 圖片描述文字 */
  prompt: string;
  /** 生成數量，預設 1 */
  n?: number;
  /** 圖片尺寸（如 '1024x1024', '1792x1024'） */
  size?: string;
  /** 品質：'standard' 或 'hd' */
  quality?: 'standard' | 'hd';
  /** 回傳格式：'url' 或 'b64_json'，預設 'url' */
  response_format?: 'url' | 'b64_json';
}

// ───── Response 200 ─────

interface ImageGenerationResponse {
  created: number;
  data: Array<{
    /** 圖片 URL（response_format='url' 時） */
    url?: string;
    /** Base64 編碼的圖片（response_format='b64_json' 時） */
    b64_json?: string;
    /** 模型修改後的 prompt（部分模型會自動優化） */
    revised_prompt?: string;
  }>;
  // ClawAPI 擴充
  x_clawapi: {
    service_id: string;             // <!-- v1.4 修訂：統一為 service_id（原 actual_service）-->
    actual_model: string;
    layer: LayerType;
    key_source: string;
    latency_ms: number;
  };
}

// 路由邏輯：
//   → model = 'service/model' → L1 直轉
//   → model = 'auto' 或已知 image 模型 → L2 路由
//   → Adapter 的 capabilities.images 必須為 true
//   → Failover 時只選 capabilities.images = true 的服務
//
// Adapter 對映：
//   → Adapter YAML 的 endpoints.images 定義
//   → 如果 Adapter 沒定義 images endpoint → ENGINE_ROUTE_NO_ADAPTER
//
// 錯誤處理：
//   → 不支援的尺寸/數量 → ENGINE_UPSTREAM_400_BAD_REQUEST
//   → Key 全掛 → ENGINE_KEY_ALL_EXHAUSTED
```

### 7.8 `POST /v1/audio/transcriptions` 詳細規格（#65）

> OpenAI 相容語音轉文字端點。注意：Request 為 multipart/form-data 格式。

```typescript
// ───── Request ─────
// Headers:
//   Authorization: Bearer {auth.token 或 sk_live_xxx}
//   Content-Type: multipart/form-data

/**
 * 語音轉文字請求
 * 將音檔轉換為文字。支援 mp3, mp4, mpeg, mpga, m4a, wav, webm 格式。
 * 注意：file 為音檔二進位上傳，使用 multipart/form-data 編碼。
 */
interface AudioTranscriptionRequest {
  /** 音檔（multipart file upload） */
  file: File;
  /** 模型名稱（如 'openai/whisper-1' 或 'auto'） */
  model: string;
  /** 音檔語言（ISO-639-1 代碼，如 'zh', 'en', 'ja'） */
  language?: string;
  /** 提示文字（幫助模型理解上下文） */
  prompt?: string;
  /** 回傳格式 */
  response_format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
  /** 溫度參數 */
  temperature?: number;
}

// ───── Response 200（json 格式）─────

interface AudioTranscriptionResponse {
  text: string;
}

// ───── Response 200（verbose_json 格式）─────

interface AudioTranscriptionVerboseResponse {
  task: 'transcribe';
  language: string;
  duration: number;
  text: string;
  segments: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
  // ClawAPI 擴充
  x_clawapi: {
    service_id: string;             // <!-- v1.4 修訂：統一為 service_id（原 actual_service）-->
    layer: LayerType;
    key_source: string;
    latency_ms: number;
  };
}

// 路由邏輯：
//   → model = 'service/model' → L1 直轉
//   → model = 'auto' 或已知 audio 模型 → L2 路由
//   → Adapter 的 capabilities.audio 必須為 true
//
// Adapter 對映：
//   → Adapter YAML 的 endpoints.transcriptions 定義
//   → multipart/form-data 需要特殊處理：
//     引擎收到 multipart → 解析 → 重新組裝為 Adapter 指定格式 → 轉發上游
//
// 錯誤處理：
//   → 檔案太大（> 25MB）→ ENGINE_FILE_TOO_LARGE
//   → 不支援的格式 → ENGINE_UNSUPPORTED_FORMAT
//   → Key 全掛 → ENGINE_KEY_ALL_EXHAUSTED
```

### 7.9 `POST /v1/audio/speech` 詳細規格（#65）

> OpenAI 相容語音合成端點。注意：回傳為 binary audio stream，不是 JSON。

```typescript
// ───── Request ─────
// Headers:
//   Authorization: Bearer {auth.token 或 sk_live_xxx}
//   Content-Type: application/json

/**
 * 語音合成請求（TTS）
 * 將文字轉換為語音音檔。回傳為二進位音訊串流。
 */
interface AudioSpeechRequest {
  /** 模型名稱（如 'openai/tts-1' 或 'auto'） */
  model: string;
  /** 要轉換的文字（上限 4096 字元） */
  input: string;
  /** 語音名稱（如 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'） */
  voice: string;
  /** 音訊格式：'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'，預設 'mp3' */
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  /** 語速倍率：0.25 ~ 4.0，預設 1.0 */
  speed?: number;
}

// ───── Response 200 ─────
// Headers:
//   Content-Type: audio/{format}（如 audio/mpeg）
//   Transfer-Encoding: chunked
//   X-ClawAPI-Service: openai
//   X-ClawAPI-Latency: 1200
//
// Body: binary audio stream（音訊二進位資料）
//
// 注意：回傳不是 JSON！是音檔串流。
// ClawAPI 擴充資訊透過 Response Headers 傳遞：
//   → X-ClawAPI-Service: 實際使用的服務
//   → X-ClawAPI-Model: 實際使用的模型
//   → X-ClawAPI-Layer: 路由層級
//   → X-ClawAPI-Latency: 延遲（ms）

// 路由邏輯：
//   → model = 'service/model' → L1 直轉
//   → model = 'auto' 或已知 TTS 模型 → L2 路由
//   → Adapter 的 capabilities.audio 必須為 true
//
// Adapter 對映：
//   → Adapter YAML 的 endpoints.speech 定義
//   → 回應 type 為 'binary'（新增 response type）
//   → 引擎直接 pipe 上游串流給客戶端（不 buffer 整個音檔）
//
// 錯誤處理：
//   → 文字太長（> 4096 字元）→ ENGINE_INPUT_TOO_LONG
//   → 不支援的語音 → ENGINE_UPSTREAM_400_BAD_REQUEST
//   → Key 全掛 → ENGINE_KEY_ALL_EXHAUSTED
```

---

## 8. CLI 命令完整規格

> 所有命令用 emoji + 顏色輸出（#147），可用 `--plain` 關閉。
> 全域旗標：`--plain`（無色彩）、`--json`（JSON 輸出）、`--locale zh-TW|en|ja`

### 8.1 命令總覽

```
clawapi start              啟動引擎
clawapi stop               停止引擎
clawapi status             查看引擎狀態

clawapi keys add           新增 Key
clawapi keys list          列出 Key
clawapi keys remove <id>   刪除 Key
clawapi keys pin <id>      釘選 Key
clawapi keys rotate <id>   輪換 Key
clawapi keys import        批量匯入（#76）
clawapi keys check         手動檢查所有 Key 健康度

clawapi gold-key set       設定金鑰匙
clawapi gold-key show      查看金鑰匙
clawapi gold-key remove    移除金鑰匙

clawapi sub-keys issue     發行 Sub-Key
clawapi sub-keys list      列出 Sub-Key
clawapi sub-keys revoke <id>  撤銷 Sub-Key
clawapi sub-keys usage <id>   查看用量

clawapi aid config         設定互助
clawapi aid stats          查看互助統計
clawapi aid donate         捐 Key 給 L0

clawapi adapters list      列出 Adapter
clawapi adapters install <url>  安裝社群 Adapter
clawapi adapters remove <id>    移除 Adapter
clawapi adapters update    手動更新

clawapi telemetry show     查看待上報內容
clawapi telemetry toggle   開/關統計上報

clawapi backup export      匯出加密備份
clawapi backup import      匯入備份

clawapi token show         顯示 auth.token
clawapi token reset        重置 auth.token

clawapi logs               查看最近紀錄
clawapi logs --service groq  按服務篩選
clawapi logs --export csv    匯出 CSV

clawapi config show        查看設定
clawapi config set <key> <value>  修改設定

clawapi migrate            執行 DB 遷移

clawapi device reset       重置裝置（重新註冊 VPS）

clawapi version            查看版本
clawapi update             更新到最新版（#140）

clawapi setup              首次安裝互動式引導（#128）
clawapi doctor             診斷工具（檢查環境、網路、Key 健康）
```

### 8.2 `clawapi start` 詳細規格

```
用法：clawapi start [options]

選項：
  -p, --port <number>       指定 port（預設 4141）
  -h, --host <string>       指定 host（預設 127.0.0.1）
  --daemon                  背景執行
  --no-vps                  不連 VPS（純離線模式）
  --verbose                 顯示詳細日誌

啟動流程：
  1. 🔧 載入設定（~/.clawapi/config.yaml）
  2. 🔑 初始化 Master Key
  3. 💾 開啟 DB + 自動遷移
  4. 🔒 初始化 auth.token
  5. 📡 連接 VPS（如果 enabled）
     → 註冊裝置（首次）/ 刷新 token（到期時）
     → 建立 WebSocket
     → 拉取 L0 Key + 路由建議
  6. 🔍 偵測本機環境
     → Ollama 是否在跑
     → 已安裝的 Adapter
  7. 🌐 啟動 HTTP Server
  8. 🚀 顯示啟動資訊

輸出範例：
  🦞 ClawAPI v1.0.0
  ──────────────────────────────
  🌐 http://localhost:4141
  🔑 auth.token: clw_t****abcd
  ──────────────────────────────
  📦 Key 池：5 把 Key（3 🟢 1 🟡 1 🔴）
  🏆 金鑰匙：Groq/llama-3.3-70b ✅
  🆓 L0：DuckDuckGo ✅ | Ollama ✅ | Groq 公共 ✅
  🤝 互助：已開啟（Groq, Brave）
  📡 VPS：已連線 | 42 隻龍蝦在線
  ──────────────────────────────
  ✅ 準備就緒！

優雅關機（#103, #133）：
  → 收到 SIGTERM/SIGINT
  → 停止接受新請求
  → 等待進行中請求完成（最多 30 秒）
  → L4 任務存檔斷點
  → WAL checkpoint
  → 關閉 WebSocket
  → 關閉 DB
  → 退出
```

<!-- v1.1 修訂 -->
#### 引擎生命週期管理（#133）

```typescript
/**
 * 優雅關機流程
 * 確保所有進行中的工作都能安全結束，不遺失數據。
 * 總超時上限 30 秒，超過強制退出。
 */
async function gracefulShutdown(signal: string): Promise<void> {
  log.info(`收到 ${signal}，開始優雅關機...`);

  // 1. 停止接受新請求（回 503）
  server.close();

  // 2. 等待進行中的請求完成（最多 30 秒）
  await drainRequests({ timeout: 30_000 });

  // 3. 保存 L4 任務斷點
  await l4TaskManager.saveCheckpoints();

  // 4. flush 寫入緩衝區（見 §3.3 WriteBuffer）
  await writeBuffer.flush();

  // 5. 斷開 WebSocket
  await wsClient.disconnect();

  // 6. 關閉 DB（含 WAL checkpoint）
  db.close();

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

### 8.3 `clawapi keys add` 詳細規格

```
用法：clawapi keys add [options]

選項：
  -s, --service <id>        服務 ID（互動時可選）
  -k, --key <value>         Key 值（不建議，會進 shell history）
  --pool <king|friend>      池類型（預設 king）
  --label <string>          標籤

互動流程（不帶選項時）：
  ? 選擇服務：
    ❯ Groq
      Gemini
      OpenAI
      Brave Search
      ... (15 個官方 Adapter)

  ? 貼上 API Key：
    ▸ ••••••••••••（隱藏輸入）

  ? 選擇池子：
    ❯ 🐙 龍蝦王池（我自己的 Key）
      👨‍👩‍👧 親友分身池（別人給的 Key）

  ? 幫 Key 取個名字（可跳過）：
    ▸ 媽媽的 Groq Key

  ⏳ 驗證 Key 有效性...
  ✅ Key 有效！已加入龍蝦王池
     服務：Groq
     狀態：🟢 正常
     標籤：媽媽的 Groq Key
```

---

## 9. MCP Server 規格

> MCP Server 在引擎啟動時一起啟動，龍蝦在工具裡設定即可使用（#21）。
> 使用 `@modelcontextprotocol/sdk`

### 9.1 MCP 設定範例

```json
// Claude Code 的 .claude/claude_desktop_config.json
{
  "mcpServers": {
    "clawapi": {
      "command": "clawapi",
      "args": ["mcp"],
      "env": {}
    }
  }
}
```

### 9.2 Tools 清單（#126：8 核心 + 4 管理）

```typescript
// ===== 核心 Tools =====

const tools = [
  {
    name: 'llm',
    description: '呼叫 LLM（自動選最佳服務，支援 failover）',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要問的問題' },
        model: { type: 'string', description: '指定模型（可選，預設 auto）' },
        strategy: { type: 'string', enum: ['fast', 'smart', 'cheap'] },
        system: { type: 'string', description: 'System prompt（可選）' },
        max_tokens: { type: 'number' },
        temperature: { type: 'number' },
      },
      required: ['prompt'],
    },
    // 回傳：LLM 回應 + 消耗資訊
  },
  {
    name: 'search',
    description: '搜尋網路（自動選最佳搜尋引擎）',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜尋關鍵字' },
        count: { type: 'number', description: '結果數量（預設 5）' },
        service: { type: 'string', description: '指定搜尋引擎（可選）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'translate',
    description: '翻譯文字（自動選最佳翻譯服務）',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要翻譯的文字' },
        target_lang: { type: 'string', description: '目標語言代碼' },
        source_lang: { type: 'string', description: '來源語言（可選，自動偵測）' },
      },
      required: ['text', 'target_lang'],
    },
  },
  {
    name: 'ask',
    description: 'AI 管家（L3）— 描述你要做什麼，管家幫你搞定',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '你的需求（自然語言）' },
      },
      required: ['question'],
    },
  },
  {
    name: 'task',
    description: '任務引擎（L4）— 丟一個大任務，自動拆解並執行',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任務描述' },
        max_steps: { type: 'number', description: '最多幾步（預設 10）' },
        max_gold_tokens: { type: 'number', description: '金鑰匙上限' },
      },
      required: ['task'],
    },
  },

  // ===== 新增核心 Tools（#65 全部都做）=====
  // <!-- v1.1 修訂 -->

  {
    name: 'embeddings',
    description: '向量嵌入 — 將文字轉為向量',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要嵌入的文字' },
        model: { type: 'string', description: '指定模型（可選，預設 auto）' },
      },
      required: ['text'],
    },
    // 內部呼叫 POST /v1/embeddings
  },
  {
    name: 'image_generate',
    description: '圖片生成 — 根據描述產生圖片',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '圖片描述' },
        model: { type: 'string', description: '指定模型（可選，預設 auto）' },
        size: { type: 'string', description: '圖片尺寸（如 1024x1024）' },
      },
      required: ['prompt'],
    },
    // 內部呼叫 POST /v1/images/generations
  },
  {
    name: 'audio_transcribe',
    description: '語音轉文字 — 將音檔轉為文字',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '音檔路徑' },
        model: { type: 'string', description: '指定模型（可選，預設 auto）' },
        language: { type: 'string', description: '音檔語言代碼（如 zh, en, ja）' },
      },
      required: ['file_path'],
    },
    // 讀取檔案 → multipart/form-data → POST /v1/audio/transcriptions
  },

  // ===== 管理 Tools =====

  {
    name: 'keys_list',
    description: '列出你的 API Key 池狀態',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'keys_add',
    description: '新增 API Key 到池子',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string' },
        key: { type: 'string' },
        pool: { type: 'string', enum: ['king', 'friend'] },
        label: { type: 'string' },
      },
      required: ['service', 'key'],
    },
  },
  {
    name: 'status',
    description: '查看 ClawAPI 引擎狀態',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'adapters',
    description: '列出已安裝的 Adapter',
    inputSchema: { type: 'object', properties: {} },
  },
];
```

---

## 10. 設定檔 config.yaml 完整 Schema

> 檔案位置：`~/.clawapi/config.yaml`
> 優先順序：CLI 參數 > config.yaml > 環境變數（#110）

```yaml
# ClawAPI 設定檔 v1
# 所有設定都有合理預設值，不改也能用

# ===== 伺服器 =====
server:
  port: 4141                    # 預設 4141，被佔用自動跳號（#109）
  host: "127.0.0.1"            # 只允許本機連線
  auto_port: true              # 被佔用時自動找下一個 port

# ===== 路由引擎 =====
routing:
  default_strategy: "smart"    # 'fast' | 'smart' | 'cheap'（#69）
  failover_enabled: true       # 失敗自動切換
  max_retries_per_key: 1       # 每把 Key 試幾次（#67）
  timeout:
    l1: 30000                  # L1/L2 超時 30 秒（#149）
    l2: 30000
    l3: 60000                  # L3 超時 60 秒
    l4_step: 60000             # L4 單步 60 秒
    l4_total: 300000           # L4 整體 5 分鐘

# ===== 金鑰匙 =====
gold_key:
  reserve_percent: 5           # 保留 5% 額度防腦死（#B3）
  default_model: null          # 預設推薦在 UI 顯示
  prompt:                      # 可覆寫 L3/L4 的 system prompt（#120）
    l3: null                   # null = 用內建預設
    l4: null

# ===== 集體智慧 =====
telemetry:
  enabled: true                # 開關統計上報（#106）
  upload_interval_ms: 3600000  # 每 1 小時上報
  max_pending_days: 30         # 離線堆積上限（#87）

# ===== L0 免費層 =====
l0:
  enabled: true
  ollama_auto_detect: true     # 自動偵測 Ollama（#43）
  ollama_url: "http://localhost:11434"

# ===== 互助 =====
aid:
  enabled: false               # 預設關閉，自願開啟（#159）
  allowed_services: null       # null = 全部
  daily_limit: 50              # 每天最多被用幾次
  blackout_hours: []           # 不要打擾的時段

# ===== VPS 連線 =====
vps:
  enabled: true
  base_url: "https://api.clawapi.com"
  websocket_url: "wss://api.clawapi.com/v1/ws"

# ===== UI =====
ui:
  theme: "system"              # 'light' | 'dark' | 'system'（#98）
  locale: "zh-TW"              # 'zh-TW' | 'en' | 'ja'（#51）

# ===== 日誌 =====
logging:
  level: "info"                # 'debug' | 'info' | 'warn' | 'error'
  retention_days: 30           # 日誌保留天數（#102）

# ===== 備份 =====
backup:
  auto_interval_hours: null    # null = 不自動備份

# ===== 通知 =====
notifications:
  key_dead: true               # Key 死亡通知（#142）
  quota_low: true              # 額度低於 20% 通知
  key_expiring: true           # Key 到期前 3 天（#75）
  service_degraded: true       # 服務降級通知

# ===== 進階 =====
advanced:
  db_path: null                # null = ~/.clawapi/data.db
  adapter_dirs:                # Adapter 搜尋路徑
    - null                     # null = ~/.clawapi/adapters/
  max_keys_per_service: 5      # 每服務 Key 上限（#26）
  user_agent: "ClawAPI/{version}"  # User-Agent（#93）
```

---

## 11. Adapter YAML Schema v1

> Adapter 是宣告式 YAML，不能執行程式碼。引擎負責載入、驗證、執行。

### 11.1 完整 Schema

```yaml
# ===== Adapter Schema v1 完整定義 =====
schema_version: 1                   # 必填。Schema 版本

adapter:
  id: string                        # 必填。唯一 ID（如 'groq', 'brave-search'）
  name: string                      # 必填。顯示名稱
  version: string                   # 必填。SemVer
  author: string                    # 必填。作者
  category: enum                    # 必填。llm|search|translation|image|audio|embedding|other
  description: string               # 必填。一句話描述
  homepage: string                  # 選填。官網 URL
  requires_key: boolean             # 必填。是否需要 API Key
  free_tier: boolean                # 選填。有免費額度嗎

auth:
  type: enum                        # 必填。none|bearer|header|query_param
  header_name: string               # auth.type=header 時必填
  query_param_name: string          # auth.type=query_param 時必填
  key_url: string                   # 選填。去哪裡申請 Key（#57 導航用）

base_url: string                    # 必填。API 基礎 URL

endpoints:
  # 每個端點的定義
  <endpoint_name>:
    method: enum                    # 必填。GET|POST|PUT|DELETE
    path: string                    # 必填。路徑（相對 base_url）
    headers: map<string, string>    # 選填。額外 headers
    params: map<string, string>     # 選填。query parameters（支持模板 {{ }})
    body_template: string           # 選填。JSON body 模板（支持模板）
    content_type: string            # 選填。預設 application/json
    response:
      type: enum                    # 必填。json|sse|text
      result_path: string           # 選填。JSONPath 取結果
      map: map<string, string>      # 選填。欄位映射
      stream_format: enum           # type=sse 時必填。openai_sse|anthropic_sse|google_stream|raw_sse

capabilities:
  chat: boolean                     # 支援聊天
  streaming: boolean                # 支援 SSE 串流
  embeddings: boolean               # 支援向量嵌入
  images: boolean                   # 支援圖片生成
  audio: boolean                    # 支援語音
  multimodal_input: boolean         # 支援多模態輸入（圖片/影片）
  tool_use: boolean                 # 支援 function calling
  models:                           # 支援的模型清單
    - id: string                    # 模型 ID
      name: string                  # 顯示名稱
      context_window: number        # 上下文大小（tokens）

rate_limits:
  requests_per_minute: number       # 選填。全域 RPM
  requests_per_day: number          # 選填。每 Key 每日限額
  tokens_per_minute: number         # 選填。TPM（如適用）
  tokens_per_day: number            # 選填
  cooldown_on_429: number           # 選填。收到 429 後冷卻秒數（預設 60）  <!-- v1.1 修訂 -->

health_check:                       # 選填
  path: string                      # 健康檢查路徑
  expected_status: number           # 預期狀態碼
  timeout_ms: number                # 超時

fallback_for:                       # 選填。可作為哪些服務的備援
  - string

quota_detection:                    # 選填。額度偵測規則（#79）
  type: enum                        # header|response_field|api_call
  remaining_header: string          # type=header 時
  remaining_field: string           # type=response_field 時
  quota_api_path: string            # type=api_call 時
```

### 11.2 官方 Adapter 範例：Groq

```yaml
schema_version: 1

adapter:
  id: groq
  name: Groq
  version: 1.0.0
  author: clawapi-official
  category: llm
  description: Groq 超快推理 API — Llama 3.3, Mixtral, Gemma
  homepage: https://console.groq.com
  requires_key: true
  free_tier: true

auth:
  type: bearer
  key_url: https://console.groq.com/keys

base_url: https://api.groq.com/openai/v1

endpoints:
  chat:
    method: POST
    path: /chat/completions
    body_template: |
      {
        "model": "{{ model }}",
        "messages": {{ messages }},
        "temperature": {{ temperature | default: 0.7 }},
        "max_tokens": {{ max_tokens | default: 4096 }},
        "stream": {{ stream | default: false }}
      }
    response:
      type: json
      stream_format: openai_sse

  models:
    method: GET
    path: /models
    response:
      type: json
      result_path: data

capabilities:
  chat: true
  streaming: true
  embeddings: false
  images: false
  audio: false
  multimodal_input: false
  tool_use: true
  models:
    - id: llama-3.3-70b-versatile
      name: Llama 3.3 70B
      context_window: 131072
    - id: llama-3.1-8b-instant
      name: Llama 3.1 8B
      context_window: 131072
    - id: mixtral-8x7b-32768
      name: Mixtral 8x7B
      context_window: 32768
    - id: gemma2-9b-it
      name: Gemma 2 9B
      context_window: 8192

rate_limits:
  requests_per_minute: 30
  tokens_per_day: 500000
  cooldown_on_429: 60            # 收到 429 後冷卻 60 秒  <!-- v1.1 修訂 -->

health_check:
  path: /models
  expected_status: 200
  timeout_ms: 5000

fallback_for:
  - openai
  - anthropic

quota_detection:
  type: header
  remaining_header: x-ratelimit-remaining-tokens
```

### 11.3 三層安全掃描（#134, #90）

```
安裝 Adapter 時自動執行三層掃描：

第一層：URL 白名單
  → 所有 base_url 和 endpoint url 必須是已知 API 域名
  → 白名單（內建 + VPS 動態更新）：
    api.groq.com, api.openai.com, api.anthropic.com,
    generativelanguage.googleapis.com, api.brave.com,
    api.tavily.com, api.serper.dev, api.deepl.com,
    api.duckduckgo.com, api.cerebras.ai, ...
  → 未知 URL → 標記「⚠️ 未知 URL」，需龍蝦手動批准

第二層：模板變數檢查
  → 允許的模板變數：{{ model }}, {{ messages }}, {{ query }}, {{ text }},
    {{ temperature }}, {{ max_tokens }}, {{ stream }}, {{ target }}, {{ source }}
  → 禁止的模板變數：{{ key }}, {{ env.* }}, {{ process.* }}, {{ require.* }}
  → 包含禁止變數 → 拒絕安裝

第三層：可執行指令檢查
  → 掃描整個 YAML 內容
  → 禁止的 pattern：exec(, eval(, import(, require(, child_process,
    __proto__, constructor, <script, javascript:
  → 包含禁止 pattern → 拒絕安裝

掃描結果標記：
  ✅ 三層全過 → 可安裝
  ⚠️ URL 未知 → 需龍蝦確認
  ❌ 有安全問題 → 拒絕安裝
```

---

## 12. 安全模型

### 12.1 Key 加密（AES-256-GCM）

```
Master Key 管理：
  產生：首次啟動時，crypto.getRandomValues(32 bytes)
  存放：~/.clawapi/master.key（檔案權限 0600）
  用途：加解密所有 Key + ECDH 私鑰
  備份：不上傳 VPS，不進雲端備份（備份用另一把鑰匙）

加密流程：
  plaintext_key = "gsk_1234567890abcdef"
  iv = crypto.getRandomValues(12 bytes)
  {ciphertext, authTag} = AES-256-GCM.encrypt(
    key = master_key,
    iv = iv,
    plaintext = utf8_encode(plaintext_key)
  )
  stored = concat(iv, authTag, ciphertext)
  → 存入 DB keys.key_encrypted 欄位

解密流程：
  stored = 從 DB 讀取
  iv = stored[0:12]
  authTag = stored[12:28]
  ciphertext = stored[28:]
  plaintext = AES-256-GCM.decrypt(
    key = master_key,
    iv = iv,
    ciphertext = ciphertext,
    authTag = authTag
  )
  → 明文 Key 僅在記憶體中短暫存在，用完即丟
```

### 12.2 auth.token 機制（#91, #116）

```
產生：首次啟動時，crypto.getRandomValues(32 bytes) → hex 編碼
存放：~/.clawapi/auth.token
生命週期：永久不變，除非手動 clawapi token reset
格式：clw_t{64 hex chars}

驗證流程：
  1. 取出 Authorization: Bearer xxx
  2. 如果 token 以 'sk_live_' 開頭 → Sub-Key 驗證
  3. 否則比對 auth.token
  4. 可選強化（#91）：
     → 檢查 User-Agent 包含已知程式名（claude-code, cursor, ...）
     → 非已知程式 → 仍允許但記警告日誌
```

### 12.3 ECDH P-256 金鑰對

```
用途：互助加密的基礎
算法：ECDH P-256（比 RSA 更小更快）
公鑰大小：65 bytes（uncompressed）

金鑰對管理：
  產生時機：首次啟動 + 每 30 天自動輪換
  私鑰儲存：用 master.key 加密後存入 device_keypair 表
  公鑰分享：
    → 開啟互助時上傳到 VPS（PUT /v1/aid/config helper_public_key）
    → 發起互助請求時帶上（POST /v1/aid/request requester_public_key）
  輪換：
    → 新金鑰對設 is_current = 1
    → 舊的保留 7 天（is_current = 0）以完成進行中的互助
    → 7 天後自動刪除舊金鑰對
```

### 12.4 備份加密（#92）

```
雙層加密：

  第一層（本機匯出）：
    salt = crypto.getRandomValues(16 bytes)
    derived_key = PBKDF2(
      password = 龍蝦設的備份密碼,
      salt = salt,
      iterations = 100000,
      hash = SHA-256,
      key_length = 32 bytes
    )
    encrypted = AES-256-GCM(
      key = derived_key,
      plaintext = JSON.stringify({ keys, config, sub_keys, gold_keys })
    )
    output = { salt, iv, authTag, ciphertext, version: 1 }

  第二層（雲端備份 v1.1+）：
    → Google 帳號綁定確保只有同帳號能下載
    → 備份密碼 = 龍蝦自己記，忘了就廢了（設計如此）
```

### 12.5 Adapter 沙箱

```
Adapter 的安全邊界：

  ✅ Adapter 可以做的：
    → 宣告端點 URL（必須在白名單內）
    → 宣告認證方式（引擎注入 Key，Adapter 碰不到 Key 值）
    → 宣告回應映射（JSONPath）
    → 宣告 rate limit 規則
    → 宣告模型清單

  ❌ Adapter 不能做的：
    → 執行任何程式碼
    → 存取檔案系統
    → 存取環境變數
    → 存取其他服務的 Key
    → 發送網路請求到白名單以外的 URL
    → 使用 {{ key }} 或 {{ env.* }} 模板變數
```

<!-- v1.1 修訂 -->
### 12.6 TLS 驗證要求

```
與 VPS 通訊的 TLS 安全策略：
  → 必須驗證 TLS 證書（拒絕自簽證書）
  → 只接受 TLS 1.3（不接受 TLS 1.2 以下）
  → 預留 Certificate Pinning 介面（v1.1+ 啟用）
    → 介面：CertificatePinStore.addPin(host, sha256Fingerprint)
    → MVP 階段不啟用，但程式碼結構預留

注意：
  → 開發模式（--dev 旗標）可臨時關閉證書驗證（方便本機測試）
  → 生產模式強制驗證，不可關閉
```

### 12.7 VPS 不可達時的退避協議

```
目標：龍蝦不因 VPS 不可達而功能異常（鐵律 3）

收到 VPS 503 回應時的退避策略：
  → 指數退避重試：1s → 2s → 4s → 8s → 16s → 32s → 最多 60s
  → 連續 5 次 503 → 降級為離線模式：
    → 停止主動請求 VPS
    → 每 5 分鐘嘗試一次 GET /v1/telemetry/quota 探測 VPS 狀態
    → 探測成功 → 恢復正常模式
  → 離線模式下的行為：
    → L1/L2/L3/L4 完全正常（Key 在本機）
    → 路由建議用快取
    → 統計數據本機堆積
    → 互助功能暫停
    → L0 公共 Key 用快取（直到快取到期）

降級通知（CLI + Web UI）：
  「VPS 暫時無法連線，已切換為離線模式。所有 Key 功能正常運作。」
```

<!-- v1.1 修訂 -->
### 12.8 備份檔格式定義（#146）

```
檔名格式：clawapi-backup-{ISO8601_timestamp}.zip.enc
加密方式：AES-256-GCM
  → 金鑰導出：PBKDF2(password, salt, 100000 iterations, SHA-256) → 32 bytes

ZIP 內部結構：
├── manifest.json        // 版本、建立時間、引擎版本
│   {
│     "backup_version": 1,
│     "created_at": "2026-03-01T12:00:00Z",
│     "engine_version": "1.0.0",
│     "file_count": 5
│   }
├── keys.enc.json        // 加密的 Key 資料（master.key 加密）
│                        // 匯入時需要原始 master.key 或新密碼重新加密
├── config.yaml          // 設定檔（脫敏版，不含 auth.token）
├── adapters/            // 自訂 Adapter YAML（社群安裝的）
│   └── *.yaml
├── usage-stats.json     // 用量統計摘要（不含原始 usage_log）
└── sub-keys.json        // Sub-Key 資料（如有）

注意：
  → master.key 不進備份（備份用龍蝦自己的密碼加密）
  → auth.token 不進備份（匯入後重新產生）
  → 大型 usage_log 不進備份（只含摘要統計）
```

---

## 13. L0 免費層

### 13.1 L0 資源清單

```
MVP 內建（#157）：

  1. DuckDuckGo（搜尋）
     → 不需 Key，直接呼叫 https://api.duckduckgo.com/
     → 無每日限額（但有 rate limit 30/min）
     → 離線不可用

  2. Ollama（本機 LLM）
     → 不需 Key，呼叫 http://localhost:11434
     → 啟動時自動偵測是否在跑（#43）
     → 無限額度（本機資源）
     → 完全離線可用

  3. Groq 公共 Key
     → tkman 捐贈的 Key，從 VPS 動態下發
     → 每人每日限額（VPS 控制）
     → 離線時用快取（直到快取到期）
```

### 13.2 L0 客戶端邏輯

```typescript
interface L0Manager {
  // === 初始化 ===
  init(): Promise<void>;
  // 1. 從 DB 讀取 L0 Key 快取
  // 2. 偵測 Ollama 是否在跑
  // 3. 如果快取過期 + VPS 可連 → 拉新的 L0 Key

  // === 從 VPS 更新 ===
  refreshFromVPS(since?: string): Promise<void>;
  // GET /v1/l0/keys?since=xxx
  // 200 → 更新本機快取（l0_keys 表 + l0_device_usage 表）
  // 304 → 不更新

  // === 選 L0 Key ===
  selectL0Key(service_id: string): Promise<L0PublicKey | null>;
  // 1. 檢查今日個人額度是否用完
  // 2. 檢查 Key status 是否 active
  // 3. 回傳可用的 L0 Key（解密後）

  // === 用量記錄 ===
  recordUsage(service_id: string, count: number): Promise<void>;
  // 1. 更新 l0_device_usage 表
  // 2. 加入 l0_usage_queue 待上報

  // === 用量上報 ===
  reportUsage(): Promise<void>;
  // POST /v1/l0/usage
  // 批次上報待上報的用量

  // === Ollama 偵測 ===
  detectOllama(): Promise<{
    available: boolean;
    models: string[];              // 已安裝的模型
    url: string;
  }>;
  // GET http://localhost:11434/api/tags

  // === 捐 Key ===
  donateKey(params: {
    service_id: string;
    key_value: string;
    display_name?: string;
    anonymous?: boolean;
  }): Promise<{ accepted: boolean; l0_key_id: string }>;
  // 1. 用 VPS 公鑰加密 Key
  // 2. POST /v1/l0/donate

  // === L0 與 L1 自動升級（#155）===
  shouldUseL0(service_id: string): boolean;
  // 如果龍蝦自己有該服務的 active Key → false（用自己的）
  // 否則 → true（用 L0）
}
```

### 13.3 L0 Key 解密流程

```
VPS 下發的 L0 Key 是加密的（防止明文到處飄）：

  1. VPS 回應：
     {
       keys: [{ key_encrypted: "base64...", encryption_key_id: "l0master_v1" }],
       l0_encryption_key: "base64_解密_master_key..."
     }

  2. 客戶端：
     l0_master = base64_decode(response.l0_encryption_key)
     for each key in keys:
       if key.key_encrypted:
         decrypted = AES-256-GCM.decrypt(l0_master, key.key_encrypted)
         → 存入 l0_keys 表（仍然加密，用本機 master.key 重新加密）
         → 用的時候才解密到記憶體

  注意：L0 Key 是公共資源，這層加密是防止明文日誌/傳輸洩漏，不是防龍蝦
```

<!-- v1.1 修訂 -->
### 13.4 首次啟動 Key 偵測器（#113）

```typescript
/**
 * Key 自動偵測器
 * 首次啟動時掃描龍蝦系統上已有的 API Key，
 * 自動匯入 ClawAPI Key 池（經龍蝦確認）。
 */
interface KeyDetector {
  /**
   * 掃描的環境變數清單
   * 涵蓋主流 AI 服務的標準環境變數名稱
   */
  envVars: [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'GROQ_API_KEY',
    'MISTRAL_API_KEY',
    'DEEPSEEK_API_KEY',
    'COHERE_API_KEY',
    'TOGETHER_API_KEY'
  ];

  /**
   * 掃描的設定檔路徑
   * 常見 AI 工具存放 credentials 的位置
   */
  configPaths: [
    '~/.openai/credentials',
    '~/.config/anthropic/credentials'
  ];

  /**
   * 執行偵測掃描
   * 掃描環境變數和設定檔，回傳找到的 Key 清單
   */
  scan(): Promise<DetectedKey[]>;

  /**
   * 互動式確認匯入
   * CLI 模式：逐一詢問龍蝦是否匯入
   * Web UI 模式：顯示確認清單
   */
  confirm(keys: DetectedKey[]): Promise<ImportedKey[]>;
}

/** 偵測到的 Key */
interface DetectedKey {
  /** 服務提供者 */
  provider: string;        // 'openai' | 'anthropic' | 'groq' | ...
  /** 來源位置 */
  source: string;          // 'env:OPENAI_API_KEY' | 'file:~/.openai/credentials'
  /** Key 遮罩顯示（只露前綴 + 後 3 碼） */
  keyPrefix: string;       // 'sk-...abc'
  /** 快速驗證結果（打一次 GET /models） */
  isValid: boolean;
}

/** 匯入結果 */
interface ImportedKey {
  provider: string;
  key_id: number;          // 新增到 Key 池後的 ID
  pool_type: 'king';       // 自動偵測的 Key 預設進龍蝦王池
}

// 偵測流程：
//   1. clawapi setup 或首次 clawapi start 時觸發
//   2. 掃描 envVars → 掃描 configPaths
//   3. 找到的 Key 用 GET /models（或等效輕量請求）快速驗證
//   4. 顯示結果給龍蝦：
//      發現以下 API Key：
//      ┌──────────┬──────────────────────┬──────────┐
//      │ 服務     │ 來源                 │ 狀態     │
//      ├──────────┼──────────────────────┼──────────┤
//      │ OpenAI   │ env:OPENAI_API_KEY   │ ✅ 有效  │
//      │ Groq     │ env:GROQ_API_KEY     │ ✅ 有效  │
//      │ Anthropic│ file:~/.config/...   │ ❌ 已過期│
//      └──────────┴──────────────────────┴──────────┘
//   5. 龍蝦確認後匯入到 Key 池
//   6. 無效的 Key 不匯入，但建議龍蝦去重新申請
```

---

## 14. 互助客戶端邏輯

### 14.1 互助觸發條件

```
龍蝦 B 的某服務全掛了：
  1. 龍蝦王池該服務 → 全部 dead 或 rate_limited
  2. 親友分身池該服務 → 全部 dead 或 rate_limited
  3. L0 公共池該服務 → dead 或額度用完
  → 才觸發互助請求

順序很重要（#Key 池順序）：
  龍蝦王池 → 親友分身池 → L0 公共池 → 互助池
  L0 在互助前面！因為 L0 離線可用，互助需要網路
```

<!-- v1.2 修訂：補齊 ECDH 公鑰預登記機制 -->
### 14.1.1 ECDH 公鑰預登記

```
互助功能的前置條件：龍蝦必須先向 VPS 預登記自己的 ECDH 公鑰。

=== 預登記流程 ===

1. 龍蝦啟用互助功能（PUT /v1/aid/config { enabled: true }）
   → 引擎自動檢查本機是否有 ECDH 金鑰對
   → 沒有 → 自動產生新的 ECDH P-256 金鑰對
   → 將公鑰（helper_public_key）附在同一個 PUT 請求中上傳到 VPS

2. VPS 儲存該龍蝦的 helper_public_key
   → 用於在互助配對成功時，附在 aid_matched 推送中給求助者
   → VPS 不儲存私鑰（私鑰永遠只在龍蝦本機，用 master.key 加密存 DB）

3. 金鑰輪換時（每 30 天）自動重新上傳新公鑰
   → PUT /v1/aid/config { helper_public_key: <新公鑰> }

=== 發起互助請求時 ===

4. 龍蝦 B 發起 POST /v1/aid/request
   → 帶上自己的 requester_public_key（B 的 ECDH 公鑰）
   → VPS 配對到幫助者 A 後：
     → 推送 aid_matched 給 A：包含 requester_public_key（B 的公鑰）
     → 推送 aid_matched 給 B：包含 helper_public_key（A 的公鑰，從預登記取得）

5. 雙方各自用 ECDH 算出相同的共享金鑰
   → A：ECDH(A_private, B_public) → sharedKey
   → B：ECDH(B_private, A_public) → sharedKey（數學上相同）
   → 用 sharedKey 加解密互助資料

=== API 介面對應 ===

PUT /v1/aid/config 請求 body 包含：
  {
    "enabled": true,
    "allowed_services": ["groq", "openai"],
    "daily_limit": 50,
    "helper_public_key": "Base64 ECDH P-256 公鑰"  // 預登記公鑰
  }

POST /v1/aid/request 請求 body 包含：
  {
    "service_id": "groq",
    "request_type": "chat_completion",
    "requester_public_key": "Base64 ECDH P-256 公鑰"  // 求助者公鑰
  }

WebSocket aid_matched 推送給幫助者：
  {
    "type": "aid_matched",
    "aid_id": "aid_xxxx",
    "service_id": "groq",
    "request_type": "chat_completion",
    "requester_public_key": "Base64..."  // 求助者的公鑰
  }

WebSocket aid_matched 推送給求助者：
  {
    "type": "aid_matched",
    "aid_id": "aid_xxxx",
    "helper_public_key": "Base64..."     // 幫助者的公鑰（從預登記取得）
  }
```

### 14.2 互助請求流程（非同步）

```typescript
interface AidClient {
  // === 發起互助請求 ===
  requestAid(params: {
    service_id: string;
    request_type: string;          // 'chat_completion' 等
    payload: string;               // 原始請求 body（JSON）
    max_latency_ms: number;        // 預設 30000
    original_error: string;        // 觸發原因
  }): Promise<AidRequestResult>;
  // <!-- v1.2 修訂：更新為雙公鑰 ECDH 預登記方案 -->
  // 流程：
  // 1. 帶上 B 的 ECDH 公鑰（requester_public_key）
  // 2. POST /v1/aid/request → VPS 只看 service_id 做配對 → 拿到 202 + aid_id
  // 3. 保留 payload 在本地記憶體等待配對結果
  // 4. 等 WebSocket 推送 aid_matched（含 helper_public_key = A 的預登記公鑰）
  // 5. ECDH(B_private, helper_public_key) → sharedKey
  // 6. 用 sharedKey 加密 payload → 透過 WebSocket 發送給 A
  // 7. 等 WebSocket 推送 aid_result（含 A 加密的回應）
  //    → fulfilled：用同一個 sharedKey 解密回應
  //    → timeout：回傳超時錯誤
  //    → error：回傳錯誤

  // <!-- v1.2 修訂：更新為雙公鑰 ECDH 方案流程 -->
  // === 處理收到的互助配對通知（我是幫助者）===
  handleIncomingAidRequest(request: IncomingAidRequest): Promise<void>;
  // 流程：
  // 1. 檢查：互助是否開啟？該服務是否允許？今日額度？blackout 時段？
  // 2. 收到 WebSocket `aid_matched` 推送（包含 requester_public_key）
  // 3. ECDH(my_private_key, requester_public_key) → sharedKey
  // 4. 用我的 Key 池執行 API 呼叫（走 L2 路由，request_type 決定端點）
  // 5. encryptForAid(response, requester_public_key) → 用 sharedKey 加密 API 回應
  // 6. 透過 WebSocket 回傳 aid_response（含 encrypted + my_public_key）
  //    → VPS 原封不動轉發給求助者 B

  // === 設定 ===
  updateConfig(config: Partial<AidConfig>): Promise<void>;
  // PUT /v1/aid/config

  // === 統計 ===
  getStats(): Promise<AidStats>;
  // GET /v1/aid/stats
}

interface AidRequestResult {
  status: 'fulfilled' | 'timeout' | 'no_helper' | 'error';
  response?: string;               // 解密後的回應
  latency_ms?: number;
  error?: string;
}
```

### 14.3 互助加密端對端流程（雙公鑰預登記方案）

<!-- v1.2 修訂：升級為雙公鑰 ECDH 預登記方案，VPS 全程不碰任何金鑰和密文 -->

```
互助加密流程（配合 SPEC-C + 預登記方案）：

前置：A 開啟互助時已預登記 helper_public_key 到 VPS（§14.1.1）

1. 求助者 B 發 POST /v1/aid/request（含 B 的 requester_public_key）
2. VPS 回 202 + aid_id
3. VPS 配對幫助者 A：
   → 推送 aid_matched 給 A（含 B 的 requester_public_key）
   → 推送 aid_matched 給 B（含 A 的 helper_public_key，從預登記取得）
4. 雙方各自算 ECDH 共享金鑰（數學上相同）
5. B 用 sharedKey 加密 payload → 透過 WS 發送給 A
6. A 用 sharedKey 解密 payload → 執行 API 呼叫 → 加密回應 → WS 回傳
7. B 用 sharedKey 解密回應 → 拿到結果

VPS 全程不碰任何金鑰和密文，只做配對和轉發。
```

```
龍蝦 A（幫助者）                                         （前置）
      │
      │── PUT /v1/aid/config ──→ VPS 儲存 A 的 helper_public_key
      │   { helper_public_key }
      │

龍蝦 B（求助者）               VPS（配對 + 轉發）         龍蝦 A（幫助者）
      │                          │                          │
      │  1. 帶上 B 的 ECDH 公鑰  │                          │
      │                          │                          │
      │──── POST /v1/aid/req ───→│                          │
      │     requester_public_key │  2. 只看 service_id      │
      │     (B 的公鑰)           │     做配對               │
      │                          │     不碰金鑰             │
      │←─── 202 aid_id ─────────│                          │
      │                          │                          │
      │                          │── WS aid_matched ───────→│
      │                          │   requester_public_key    │
      │                          │   (B 的公鑰)             │
      │                          │                          │
      │←── WS aid_matched ──────│                          │
      │    helper_public_key     │                          │
      │    (A 的公鑰，預登記)     │                          │
      │                          │                          │
      │  3. B: ECDH(B私鑰,A公鑰) │                          │  3. A: ECDH(A私鑰,B公鑰)
      │     → sharedKey          │                          │     → sharedKey（相同）
      │                          │                          │
      │  4. 用 sharedKey 加密     │                          │
      │     原始 payload          │                          │
      │                          │                          │
      │──── WS encrypted_payload（ECDH 共享金鑰加密）────→│  <!-- v1.3 修訂：payload_encrypted → encrypted_payload，符合 v1.2 雙公鑰方案 -->
      │                          │  （VPS 原封不動轉發）      │
      │                          │                          │  5. 用 sharedKey 解密 payload
      │                          │                          │  6. 執行 API 呼叫
      │                          │                          │  7. 用 sharedKey 加密回應
      │                          │                          │
      │                          │←── WS aid_response ──────│
      │                          │    response_encrypted     │
      │                          │                          │
      │  VPS 原封不動轉發         │                          │
      │←── WS aid_result ───────│                          │
      │    response_encrypted    │                          │
      │                          │                          │
      │  8. 用 sharedKey 解密回應 │                          │
      │  ✅ 拿到結果              │                          │

VPS 全程只做配對和轉發：
  ✅ 知道：B 需要 Groq 幫助，A 有閒置 Groq
  ❌ 不知道：payload 內容、回應內容、任何金鑰
  ❌ 不碰：不解密、不重新加密、不保留任何密文

比較舊方案（VPS 中轉金鑰）：
  舊：B → VPS 解密 K → VPS 用 A 公鑰重新加密 K → A
  新：雙方預先交換公鑰 → ECDH 導出同一個共享金鑰 → VPS 完全退出金鑰流程
```

---

## 15. Sub-Key 系統

### 15.1 Sub-Key 生命週期

```typescript
interface SubKeyManager {
  // === 發行 ===
  issue(params: {
    label: string;
    daily_limit?: number;          // null = 無上限
    allowed_services?: string[];   // null = 全部（#81）
    allowed_models?: string[];     // null = 全部（#81）
    rate_limit_per_hour?: number;  // null = 無上限（#73）
    expires_at?: string;           // null = 不過期
  }): Promise<SubKey>;
  // 1. 產生隨機 token：'sk_live_' + crypto.randomUUID()
  // 2. 存入 sub_keys 表
  // 3. 回傳完整 Sub-Key 資訊

  // === 驗證（每次 API 呼叫時）===
  validate(token: string, service_id: string, model?: string): SubKeyValidation;
  // 1. 查 sub_keys 表
  // 2. 檢查 is_active
  // 3. 檢查 expires_at
  // 4. 檢查 daily_used < daily_limit
  // 5. 檢查 rate_used_this_hour < rate_limit_per_hour
  // 6. 檢查 service_id 在 allowed_services 內
  // 7. 檢查 model 在 allowed_models 內

  // === 撤銷 ===
  revoke(sub_key_id: number): Promise<void>;
  // is_active = 0
  // 進行中的請求會完成，新請求被拒絕

  // === 列表 ===
  list(): Promise<SubKey[]>;

  // === 用量追蹤（#80）===
  recordUsage(sub_key_id: number, service_id: string, tokens: number): Promise<void>;
  // Sub-Key 朋友用的量計入龍蝦的總額度追蹤

  // === VPS 驗證中繼（#129）===
  handleVPSValidation(sub_key_token: string, service_id: string): Promise<{
    valid: boolean;
    permissions?: object;
  }>;
  // 收到 VPS 透過 WebSocket 的驗證請求 → 回傳結果
}
```

### 15.2 Sub-Key 連線模式（#129）

```
模式 1：直連（同網路）
  Sub-Key 朋友知道龍蝦的 IP
  → 直接打 http://龍蝦IP:4141/v1/chat/completions
  → Authorization: Bearer sk_live_xxxx

模式 2：Tailscale（不同網路但都裝了 Tailscale）
  → 透過 Tailscale 私有網路直連

模式 3：VPS 驗證中繼（不同網路）
  Sub-Key 朋友 → POST /v1/subkeys/validate → VPS
  VPS → WebSocket 問龍蝦「這把 Sub-Key 是不是你的？」
  龍蝦 → 回傳驗證結果
  VPS → 快取 5 分鐘 → 回傳給朋友

  注意：VPS 只做「驗證」中繼，API 請求本身不走 VPS
  朋友需要能連到龍蝦的 ClawAPI 才能用（直連或 Tailscale）
```

---

## 16. Web UI 架構

### 16.1 技術選型（#123）

```
架構：Hono SSR + HTMX
  → SSR：伺服器端渲染 HTML
  → HTMX：局部更新（無需完整 SPA 框架）
  → SSE：即時推送（Dashboard 用）
  → 零前端打包、零 React/Vue

為什麼不用 React/Vue？
  → ClawAPI 是本機工具，不是 SaaS
  → 頁面簡單，不需要複雜狀態管理
  → HTMX 足夠處理局部更新
  → 省掉前端打包步驟 = 更快啟動
```

### 16.2 頁面結構

```
/                           → Dashboard（首頁）
/keys                       → Key 管理
/keys/add                   → 新增 Key
/gold-key                   → 金鑰匙設定
/sub-keys                   → Sub-Key 管理
/sub-keys/issue             → 發行 Sub-Key
/aid                        → 互助設定 + 記錄
/adapters                   → Adapter 瀏覽 + 安裝
/logs                       → 使用紀錄
/settings                   → 設定
/chat                       → 聊天室（VPS 中繼 #121）
/backup                     → 備份管理
/setup                      → 首次引導精靈（#128）
```

### 16.3 Dashboard 設計（#131）

```
┌──────────────────────────────────────────────────────────┐
│  🦞 ClawAPI Dashboard                    🌙 [繁中 ▾]     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────┐│
│  │ 🔑 Key 池   │ │ 📊 今日用量 │ │ ✅ 成功率   │ │ 🧠 智慧 ││
│  │ 5 把        │ │ 237 次     │ │ 96.2%      │ │ 42 龍蝦 ││
│  │ 3🟢 1🟡 1🔴 │ │ ↑12%       │ │ ↑0.3%      │ │ 在線    ││
│  └────────────┘ └────────────┘ └────────────┘ └────────┘│
│                                                          │
│  ┌────────────────── 即時請求流（SSE）──────────────────┐  │
│  │ 12:05:30 ✅ groq/llama-3.3-70b     180ms  L2 smart  │  │
│  │ 12:05:28 ✅ brave-search            320ms  L2 smart  │  │
│  │ 12:05:25 ⚠️ openai/gpt-4o → groq   2100ms L2 fast   │  │
│  │ 12:05:20 ✅ duckduckgo (L0)         450ms  L0 free   │  │
│  │ 12:05:15 🤖 L3 管家 → search+llm    3200ms L3 ask    │  │
│  │ ...                                                   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────── 服務健康度（集體智慧）──────────┐                │
│  │ Groq      🟢 97% ████████████████░░ 180ms│                │
│  │ Gemini    🟢 95% ███████████████░░░ 220ms│                │
│  │ OpenAI    🟡 82% ██████████░░░░░░░ 450ms│                │
│  │ Anthropic ⚠️ 60% ██████░░░░░░░░░░ 3.5s  │                │
│  └──────────────────────────────────────────┘                │
│                                                              │
│  ⚠️ Anthropic API 近 30 分鐘錯誤率飆升到 40%                  │
│                                                              │
│  導覽：[Keys] [金鑰匙] [Sub-Keys] [互助] [Adapter] [日誌] [設定]│
└──────────────────────────────────────────────────────────────┘
```

### 16.4 HTMX 互動模式

```html
<!-- 局部更新範例：Key 列表 -->
<div id="key-list" hx-get="/api/keys" hx-trigger="load, every 30s">
  <!-- 伺服器回傳 HTML 片段，直接替換 -->
</div>

<!-- 新增 Key 表單 -->
<form hx-post="/api/keys" hx-target="#key-list" hx-swap="outerHTML">
  <select name="service_id">...</select>
  <input type="password" name="key_value" />
  <button type="submit">新增</button>
</form>

<!-- SSE 即時請求流 -->
<div hx-ext="sse" sse-connect="/api/events">
  <div sse-swap="request" hx-swap="afterbegin">
    <!-- 每筆新請求即時插入 -->
  </div>
</div>

<!-- 額度進度條 -->
<div class="quota-bar">
  <div class="quota-fill" style="width: {{ percent }}%; background: {{ color }};">
    {{ used }}/{{ total }} ({{ percent }}%)
  </div>
</div>
<!-- 顏色（#141）：> 50% 綠色, 20-50% 黃色, < 20% 紅色 -->
```

### 16.5 響應式設計（#52）

```
斷點：
  → 桌面（> 1024px）：完整 Dashboard
  → 平板（768-1024px）：卡片縮小，導覽折疊
  → 手機（< 768px）：單欄佈局，底部導覽

手機優先功能：
  → Key 池狀態（快速檢查 Key 是否正常）
  → 額度剩餘（紅色就知道要加 Key 了）
  → 通知（Key 死亡、服務降級）
```

### 16.6 深淺主題（#98）

```css
/* CSS 變數系統 */
:root {
  --bg: #ffffff;
  --text: #1a1a1a;
  --card: #f5f5f5;
  --accent: #e74c3c;   /* 龍蝦紅 🦞 */
  --success: #2ecc71;
  --warning: #f39c12;
  --danger: #e74c3c;
}

[data-theme="dark"] {
  --bg: #1a1a2e;
  --text: #e0e0e0;
  --card: #16213e;
  --accent: #ff6b6b;
}

@media (prefers-color-scheme: dark) {
  [data-theme="system"] { /* 同 dark */ }
}
```

---

## 17. 錯誤碼完整清單

<!-- v1.1 修訂：錯誤碼對齊 SPEC-C -->
> 格式：`[來源]_[原因]`（SCREAMING_SNAKE_CASE）（#115）
>
> **重要規則：**
> - 與 VPS 通訊相關的錯誤碼以 **SPEC-C 為準**（唯一權威來源），此處引用不重複定義。
> - 本機引擎專有的錯誤碼以 **`ENGINE_`** 前綴開頭，和 SPEC-C 清楚區分。
> - 凡是 SPEC-C 已定義的錯誤碼（如 `AUTH_INVALID_TOKEN`），SPEC-A 使用完全相同的名稱。

### 17.1 本機引擎錯誤（ENGINE_ 前綴）

```
引擎認證錯誤
──────────────────────────────────────────────────
ENGINE_AUTH_TOKEN_MISSING     Authorization header 缺失
ENGINE_AUTH_SUBKEY_INVALID    Sub-Key 無效或已撤銷
ENGINE_AUTH_SUBKEY_EXPIRED    Sub-Key 已過期
ENGINE_AUTH_SUBKEY_DAILY_LIMIT  Sub-Key 今日額度用完
ENGINE_AUTH_SUBKEY_RATE_LIMIT   Sub-Key 每小時頻率限制
ENGINE_AUTH_SUBKEY_SERVICE_DENIED  Sub-Key 不允許使用此服務
ENGINE_AUTH_SUBKEY_MODEL_DENIED   Sub-Key 不允許使用此模型

Key 池錯誤
──────────────────────────────────────────────────
ENGINE_KEY_NOT_FOUND          找不到該 Key
ENGINE_KEY_SERVICE_LIMIT      該服務已達 5 把上限（#26）
ENGINE_KEY_DUPLICATE_GOLD     此 Key 已被用作金鑰匙，不能重複（#39）
ENGINE_KEY_VALIDATION_FAILED  Key 驗證失敗（無效或已過期）
ENGINE_KEY_ALL_EXHAUSTED      該服務所有 Key 都不可用
  → suggestion: "所有 {service} Key 都掛了。{n} 把限速、{m} 把死亡。建議加新 Key 或等 {time}"

路由錯誤
──────────────────────────────────────────────────
ENGINE_ROUTE_NO_SERVICE       找不到可處理此請求的服務
ENGINE_ROUTE_NO_ADAPTER       該服務缺少 Adapter
ENGINE_ROUTE_LAYER_UNAVAILABLE  該層級不可用（如 L3 沒有金鑰匙）
ENGINE_ROUTE_MODEL_NOT_FOUND  找不到指定模型
ENGINE_ROUTE_MULTIMODAL_UNSUPPORTED  所有可用服務都不支援多模態（#62）
ENGINE_ROUTE_TOOL_USE_UNSUPPORTED    所有可用服務都不支援 tool use（#61）

金鑰匙錯誤
──────────────────────────────────────────────────
ENGINE_GOLD_KEY_NOT_SET       未設定金鑰匙（L3/L4 不可用）
  → suggestion: "clawapi gold-key set"
ENGINE_GOLD_KEY_EXHAUSTED     金鑰匙今日額度用完
ENGINE_GOLD_KEY_DEGRADED      金鑰匙額度不足，已降級到 L2（#B3）
ENGINE_GOLD_KEY_PARSE_ERROR   金鑰匙 LLM 回傳格式異常
ENGINE_GOLD_KEY_CLARIFICATION  L3 需要龍蝦澄清（#70）

L0 本機錯誤
──────────────────────────────────────────────────
ENGINE_L0_DAILY_LIMIT         L0 今日免費額度用完
  → suggestion: "加自己的 Key 可以無限使用：clawapi keys add"
ENGINE_L0_KEY_UNAVAILABLE     L0 該服務無可用 Key
ENGINE_L0_OLLAMA_NOT_FOUND    偵測不到 Ollama

L4 錯誤
──────────────────────────────────────────────────
ENGINE_L4_PLAN_FAILED         任務規劃失敗
ENGINE_L4_STEP_FAILED         步驟 {step_id} 執行失敗（已重試 {n} 次）
ENGINE_L4_TIMEOUT             任務超時（超過 {l4_total}ms）
ENGINE_L4_COST_LIMIT          金鑰匙消耗超過上限

互助本機錯誤
──────────────────────────────────────────────────
ENGINE_AID_VPS_UNREACHABLE    無法連線 VPS（互助需要網路）
ENGINE_AID_DECRYPT_FAILED     互助回應解密失敗

Adapter 錯誤
──────────────────────────────────────────────────
ENGINE_ADAPTER_NOT_FOUND      找不到 Adapter
ENGINE_ADAPTER_LOAD_FAILED    Adapter YAML 載入失敗
ENGINE_ADAPTER_SECURITY_REJECTED  Adapter 安全掃描未通過
ENGINE_ADAPTER_URL_UNKNOWN    Adapter URL 不在白名單

上游 API 錯誤（帶原始狀態碼）
──────────────────────────────────────────────────
ENGINE_UPSTREAM_400_BAD_REQUEST   上游 API 拒絕請求（參數錯誤）
ENGINE_UPSTREAM_401_UNAUTHORIZED  Key 已失效（#57）
  → suggestion: "Key 已失效，前往 {provider_url} 重新申請"
ENGINE_UPSTREAM_403_FORBIDDEN     Key 被封或權限不足
ENGINE_UPSTREAM_429_RATE_LIMITED  上游 API 限速
ENGINE_UPSTREAM_500_SERVER_ERROR  上游 API 內部錯誤
ENGINE_UPSTREAM_502_BAD_GATEWAY   上游 API 閘道錯誤
ENGINE_UPSTREAM_503_UNAVAILABLE   上游 API 暫時不可用
ENGINE_UPSTREAM_TIMEOUT           上游 API 超時

系統錯誤
──────────────────────────────────────────────────
ENGINE_DB_ERROR               資料庫操作失敗
ENGINE_CRYPTO_ERROR           加解密失敗
ENGINE_CONFIG_ERROR           設定檔載入失敗
ENGINE_STARTUP_FAILED         引擎啟動失敗
ENGINE_NETWORK_ERROR          網路連線錯誤
ENGINE_FILE_TOO_LARGE         上傳檔案太大（audio transcriptions）
ENGINE_UNSUPPORTED_FORMAT     不支援的檔案格式
ENGINE_INPUT_TOO_LONG         輸入文字超過長度限制（audio speech）
```

### 17.2 引用 SPEC-C 的通訊錯誤碼

> 以下錯誤碼由 SPEC-C 統一定義，本機引擎原封使用，不加 ENGINE_ 前綴。
> 完整清單和語義以 SPEC-C §6.2 為準。

```
認證（SPEC-C）
──────────────────────────────────────────────────
AUTH_MISSING_HEADERS          缺少 X-Device-Id 或 X-Device-Token
AUTH_INVALID_TOKEN            Token 無效
AUTH_TOKEN_EXPIRED            Token 已過期
AUTH_DEVICE_NOT_FOUND         device_id 未註冊

互助（SPEC-C）
──────────────────────────────────────────────────
AID_NOT_ENABLED               互助未開啟
AID_NO_HELPER                 找不到可幫忙的龍蝦
AID_RATE_LIMITED              互助請求太頻繁
AID_DAILY_LIMIT_REACHED       今天的互助額度已用完
AID_REQUEST_TIMEOUT           互助請求超時
AID_PAYLOAD_TOO_LARGE         互助 payload 太大
AID_COOLDOWN                  互助冷卻中

L0（SPEC-C）
──────────────────────────────────────────────────
L0_DAILY_LIMIT_REACHED        今日免費額度已用完
L0_KEY_NOT_FOUND              L0 Key 不存在或已過期
L0_SERVICE_UNAVAILABLE        L0 該服務目前無可用 Key

Sub-Key（SPEC-C）
──────────────────────────────────────────────────
SUBKEY_INVALID                Sub-Key 無效或已被撤銷
SUBKEY_ISSUER_OFFLINE         Sub-Key 發行者離線

通用（SPEC-C）
──────────────────────────────────────────────────
INTERNAL_ERROR                VPS 內部錯誤
SERVICE_UNAVAILABLE           VPS 暫時無法服務
INVALID_REQUEST               請求格式有誤
```

### 17.3 錯誤回傳格式

<!-- v1.3 修訂：code fence 從 typescript 改為 json，內容為純 JSON 格式 -->
```json
// 所有錯誤都包含 tried 記錄（#28 回傳原因 + 建議）
{
  "error": {
    "code": "ENGINE_KEY_ALL_EXHAUSTED",
    "message": "所有 Groq Key 都掛了",
    "suggestion": "2 把限速中（預計 3 分鐘後恢復）、1 把已失效。建議加新 Key：clawapi keys add",
    "tried": [
      { "service_id": "groq", "key_id": 1, "outcome": "rate_limited", "latency_ms": 50 },
      { "service_id": "groq", "key_id": 2, "outcome": "rate_limited", "latency_ms": 45 },
      { "service_id": "groq", "key_id": 3, "outcome": "error", "error_code": "ENGINE_UPSTREAM_401_UNAUTHORIZED" }
    ]
  }
}
```

---

## 18. VPS 通訊模組

> 實作 SPEC-C 客戶端那一邊的所有邏輯。

### 18.1 模組介面

```typescript
// <!-- v1.4 修訂：以下型別從 @clawapi/protocol 匯入，見 SPEC-C 附錄 B -->
import type {
  TelemetryFeedback as RoutingFeedback,      // 路由回饋（SPEC-C: TelemetryFeedback）
  TelemetryBatch,                             // 遙測批次
  L0KeysResponse,                             // L0 Key 列表回應
  L0UsageEntry,                               // L0 用量條目
  L0DonateRequest as DonateKeyParams,         // L0 捐贈參數（SPEC-C: L0DonateRequest）
  AidCreateRequest as AidRequestParams,       // 互助請求參數（SPEC-C: AidCreateRequest）
  AidCreateResponse as AidRequestResponse,    // 互助請求回應（SPEC-C: AidCreateResponse）
  AdapterUpdatesResponse,                     // Adapter 更新回應
  AdapterListResponse,                        // Adapter 列表回應
  Notification,                               // 系統通知
  ChatRoomMessage as ChatMessageEvent,        // 聊天室訊息事件（SPEC-C: ChatRoomMessage）
  AidResponsePayload,                         // 互助回應載荷
  RoutingUpdate,                              // 路由更新推送
  AidStats,                                   // 互助統計
  VersionCheckResponse,                       // 版本檢查回應
  DeviceRegistrationResponse,                 // 裝置註冊回應
} from '@clawapi/protocol';

interface VPSClient {
  // === 生命週期 ===
  connect(): Promise<void>;
  // 1. 裝置註冊（首次）或 Token 刷新（到期）
  // 2. 建立 WebSocket 連線
  // 3. 訂閱頻道（routing, notifications, chat:general, chat:help）

  disconnect(): Promise<void>;

  isConnected(): boolean;

  // === HTTPS 客戶端 ===
  registerDevice(): Promise<DeviceRegistrationResponse>;
  // POST /v1/devices/register

  refreshToken(): Promise<void>;
  // POST /v1/devices/refresh

  resetDevice(): Promise<void>;
  // POST /v1/devices/reset

  uploadTelemetry(batch: TelemetryBatch): Promise<void>;
  // POST /v1/telemetry/batch（MessagePack 編碼）

  submitFeedback(feedback: RoutingFeedback): Promise<void>;
  // POST /v1/telemetry/feedback

  getL0Keys(since?: string): Promise<L0KeysResponse>;
  // GET /v1/l0/keys

  reportL0Usage(entries: L0UsageEntry[]): Promise<void>;
  // POST /v1/l0/usage

  donateL0Key(params: DonateKeyParams): Promise<void>;
  // POST /v1/l0/donate

  requestAid(params: AidRequestParams): Promise<AidRequestResponse>;
  // POST /v1/aid/request

  updateAidConfig(config: AidConfig): Promise<void>;
  // PUT /v1/aid/config

  getAidStats(): Promise<AidStats>;
  // GET /v1/aid/stats

  /** 取得互助配置（SPEC-C §4.6） */  // <!-- v1.1 修訂 -->
  getAidConfig(): Promise<AidConfig>;
  // GET /v1/aid/config

  checkVersion(): Promise<VersionCheckResponse>;
  // GET /v1/version/check

  checkAdapterUpdates(installed: string[]): Promise<AdapterUpdatesResponse>;
  // GET /v1/adapters/updates

  getOfficialAdapters(): Promise<AdapterListResponse>;
  // GET /v1/adapters/official

  // v1.1+
  uploadBackup(data: Uint8Array, checksum: string): Promise<void>;
  downloadBackup(): Promise<Uint8Array>;
  deleteBackup(): Promise<void>;
  bindGoogle(idToken: string, nickname?: string): Promise<void>;

  // === WebSocket 客戶端 ===
  onRoutingUpdate(handler: (update: RoutingUpdate) => void): void;
  onNotification(handler: (notif: Notification) => void): void;
  onChatMessage(handler: (msg: ChatMessageEvent) => void): void;
  onAidRequest(handler: (req: IncomingAidRequest) => void): void;

  sendChatMessage(channel: string, text: string): void;
  sendAidResponse(aidId: string, response: AidResponsePayload): void;

  // === 連線管理 ===
  // 斷線重連：指數退避 1s, 2s, 4s, 8s, 16s, 32s, 60s（max）
  // 連續 1 小時連不上 → 每 5 分鐘重連
  // 連續 24 小時連不上 → 每 30 分鐘重連
  // 重連成功 → 重新訂閱所有頻道
}
```

<!-- v1.1 修訂 -->
#### WebSocket 重連恢復流程

```
WS 重連成功後的恢復邏輯：

  1. 重新訂閱所有頻道
     → routing, notifications, chat:general, chat:help
     → 和初次連線相同的 subscribe 訊息

  2. 拉取最新路由建議
     → GET /v1/telemetry/quota → 附帶最新路由建議
     → 覆蓋本地快取的 routing_intel
     → 確保重連後的路由策略基於最新數據

  3. 離線積壓數據排程上傳
     → 如果有離線期間堆積的遙測數據
     → 排程分批上傳（見 §18.5 OfflineUploader）
     → 不在重連瞬間一次全灌（避免 VPS 過載）

  4. 路由建議恢復
     → 路由建議每小時更新，主動拉即可
     → 不會遺失（VPS 推送時如果龍蝦離線，重連後主動拉）

  5. 互助請求恢復
     → 斷線期間如果有互助請求超時，VPS 會自動處理
     → 龍蝦 B（求助者）：VPS 推送 aid_result(status=timeout)
     → 龍蝦 A（幫助者）：未回應的請求 VPS 自動超時釋放
     → 重連後不需要補發，VPS 已善後
```

### 18.2 認證 Headers

```typescript
// 所有 HTTPS 請求帶的 Headers（SPEC-C §2.2）
function getAuthHeaders(): Record<string, string> {
  return {
    'X-Device-Id': deviceId,        // clw_xxxx
    'X-Device-Token': deviceToken,  // dtoken_xxxx
    'X-Client-Version': VERSION,    // '1.0.0'
    'Content-Type': 'application/json',
  };
}

// WebSocket 連線帶認證
// wss://api.clawapi.com/v1/ws?device_id=clw_xxxx&token=dtoken_xxxx&version=1.0.0
```

### 18.3 離線數據堆積

```
VPS 連不上時的行為：

  統計上報：
    → 存入 telemetry_queue 表
    → 最多堆 30 天（超過自動丟棄）
    → VPS 恢復後按時間順序批次上傳
    → 上傳成功後從本機刪除

  L0 用量：
    → 存入 l0_usage_queue 表
    → VPS 恢復後批次上報
    → 離線期間用本機快取的 device_daily_limits 自行限額

  路由建議：
    → 用快取的 routing_intel（最多到 valid_until）
    → 超過 valid_until → is_stale = true，仍可用但降低 confidence

  HTTPS 請求重試策略（SPEC-C §9.2）：
    → 重試 3 次（間隔 1s, 2s, 4s）
    → 全失敗 → 每 15 分鐘背景重試
    → 連續 24 小時失敗 → 每小時重試
    → 連續 7 天失敗 → 每天重試
```

<!-- v1.1 修訂 -->
### 18.5 離線數據分批上傳

```typescript
/**
 * 離線積壓分批上傳器
 * 避免超過 SPEC-C 定義的 500KB 批次限制和 Rate Limit。
 * VPS 恢復後有序上傳，不會瞬間灌爆。
 */
interface OfflineUploader {
  /** 每批最多 500 條記錄 */
  maxBatchSize: 500;
  /** 每批最多 400KB（留 100KB 安全餘量，SPEC-C 限制 500KB） */
  maxBatchBytes: 400_000;
  /** 批次之間間隔 5 秒 */
  batchInterval: 5_000;

  // Rate Limit 考量：
  //   POST /v1/telemetry/batch 限 2 次/小時（SPEC-C §7.1）
  //   所以每小時最多上傳 2 批 = 1000 條
  //   30 天離線積壓約 ~3000 條（每天 ~100 條）
  //   → 需要約 3 小時分批上傳完成

  /**
   * 上傳積壓的遙測數據
   * 按時間順序分批上傳，遵守 Rate Limit。
   */
  uploadBacklog(records: TelemetryRecord[]): Promise<void>;
  // 實作邏輯：
  //   const batches = splitIntoBatches(records, this.maxBatchSize, this.maxBatchBytes);
  //   for (const batch of batches) {
  //     await rateLimiter.waitForSlot('telemetry_batch');
  //     await vpsClient.uploadTelemetry(batch);
  //     await sleep(this.batchInterval);
  //     // 上傳成功 → 從本機 telemetry_queue 刪除
  //     await db.deleteTelemetryBatch(batch.batch_id);
  //   }
}

// 分批策略：
//   1. 從 telemetry_queue 按 created_at 排序讀取
//   2. 累加到 maxBatchSize 或 maxBatchBytes 為止
//   3. 打包為一批 → POST /v1/telemetry/batch
//   4. 成功 → 從 queue 刪除 → 下一批
//   5. 429 → 等待 retry_after 再繼續
//   6. 其他錯誤 → retry_count++ → 超過 3 次放棄這批
```

### 18.4 路由回饋（#86）

```typescript
// 龍蝦對路由推薦的主動回饋
interface RoutingFeedbackManager {
  submitFeedback(params: {
    recommendation_id: string;     // 對應 routing_update 的 id
    service_id: string;
    feedback: 'positive' | 'negative';
    reason?: 'high_latency' | 'errors' | 'quality' | 'other';
    comment?: string;              // 最多 200 字元
  }): Promise<void>;
  // POST /v1/telemetry/feedback

  // UI 暴露方式：
  // Dashboard 服務健康度旁邊的 👍👎 按鈕
  // CLI: clawapi feedback --service groq --negative --reason high_latency
}
```

---

## 19. 測試計畫

### 19.1 測試策略（#122）

```
目標覆蓋率：80%
框架：bun:test（Bun 原生）
Mock：自訂 mock adapter（不打真實 API）

測試層級：
  單元測試（60%）：
    → Crypto 模組（加解密 round-trip）
    → Key 池管理（選 Key 邏輯、健康偵測、Round-Robin）
    → 路由引擎（L1-L4 判斷、Failover 鏈、策略排序）
    → Sub-Key 驗證（各種邊界：過期、額度、服務限制）
    → Adapter 載入（YAML 解析、安全掃描三層）
    → 錯誤碼產生
    → 設定載入（優先順序）
    → 日誌遮罩（Key 值遮罩）

  整合測試（30%）：
    → 完整請求流程（HTTP 請求 → 路由 → Key 選取 → Mock 上游 → 回應）
    → SSE Streaming 端對端
    → Sub-Key 完整流程（發行 → 使用 → 撤銷）
    → L3 AI 管家（Mock 金鑰匙 LLM 回應）
    → L4 任務引擎（Mock 多步驟）
    → VPS 通訊（Mock VPS 回應）
    → 互助加密端對端（ECDH + AES-256-GCM round-trip）
    → DB 遷移（v1 → v2 → ...）

  端對端測試（10%）：
    → 啟動引擎 → 打 API → 收到回應
    → CLI 命令（clawapi keys add → list → remove）
    → Web UI 基本流程（Playwright，Phase 5 才加）
```

### 19.2 Mock 策略

```typescript
// Mock Adapter：模擬上游 API 回應
const mockGroqAdapter = {
  chat: (req) => ({
    status: 200,
    body: {
      id: 'chatcmpl-mock',
      choices: [{ message: { content: 'Mock response' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  }),
  // 模擬 429
  chat_rate_limited: (req) => ({
    status: 429,
    headers: { 'retry-after': '60' },
  }),
  // 模擬 401
  chat_unauthorized: (req) => ({
    status: 401,
    body: { error: 'Invalid API key' },
  }),
};

// Mock VPS：模擬 VPS 回應 <!-- v1.3 修訂：移除不合法的 ... 佔位符，改為註釋 -->
const mockVPS = {
  register: () => ({ device_token: 'dtoken_mock', /* ...其他欄位... */ }),
  l0_keys: () => ({ keys: [/* ...金鑰陣列... */], /* ...其他欄位... */ }),
  telemetry: () => ({ accepted: true }),
};
```

### 19.3 關鍵測試案例

```
Key 池測試：
  ✅ 同服務 5 把 Key 上限
  ✅ 金鑰匙不能跟 Key 池重複
  ✅ dead Key 被跳過
  ✅ rate_limited Key 冷卻後恢復
  ✅ 連續 3 次失敗標記 dead
  ✅ 釘選 Key 優先
  ✅ Round-Robin 分散

路由測試：
  ✅ model='groq/llama-3.3-70b' → L1
  ✅ model='auto' → L2
  ✅ model='ask' → L3（有金鑰匙）
  ✅ model='ask' → 錯誤（沒金鑰匙）
  ✅ Failover: Key1 429 → Key2 成功
  ✅ Failover: 跨服務（有 adapter 支援）
  ✅ no_fallback=true → 不跨服務
  ✅ 多模態請求只 failover 到支援的服務

安全測試：
  ✅ 無 auth.token → 401
  ✅ 無效 auth.token → 401
  ✅ Sub-Key 過期 → 401
  ✅ Adapter URL 不在白名單 → 拒絕安裝
  ✅ Adapter 含 {{ key }} → 拒絕安裝
  ✅ Key 加密 → 解密 round-trip
  ✅ ECDH 加密 → 解密 round-trip
```

---

## 20. 效能預算

### 20.1 目標值

```
記憶體使用（#100）：
  → 空閒：< 50MB
  → 正常負載（10 QPS）：100-150MB
  → 高負載（100 QPS）：< 256MB

啟動時間（#101）：
  → 冷啟動（首次）：< 3 秒
  → 熱啟動（有快取）：< 1 秒

請求延遲（引擎自身增加的延遲）：
  → L1 直轉：< 5ms（幾乎零開銷）
  → L2 路由（Key 選取 + 建構請求）：< 10ms
  → L3 管家（含金鑰匙 LLM 呼叫）：取決於金鑰匙 LLM 延遲
  → L4 任務（含多步驟）：取決於步驟數和 LLM 延遲

DB 操作：
  → 讀取（SELECT）：< 1ms
  → 寫入（INSERT/UPDATE）：< 5ms（WAL 模式）
  → 批次寫入（用量記錄）：非同步，不影響請求延遲

SSE Streaming：
  → 首 token 延遲（TTFT）：引擎增加 < 5ms
  → token 間延遲：引擎增加 < 1ms
```

### 20.2 最佳化策略

```
1. Key 池快取：
   → 啟動時載入所有 Key 到記憶體（只有 metadata，不含明文 Key）
   → Key 選取在記憶體完成，不查 DB

2. Adapter 快取：
   → 啟動時解析所有 YAML，快取為 JS 物件
   → 請求時直接使用快取的物件

3. 路由建議快取：
   → routing_intel 存在記憶體
   → WebSocket 更新時即時替換

4. 非同步日誌：
   → 用量記錄先存記憶體 buffer
   → 每 1 秒批次寫入 DB
   → 不阻塞請求處理

5. WAL 優化：
   → busy_timeout = 5000ms
   → 每 15 分鐘 checkpoint
   → 定期 VACUUM（每天一次）
```

---

## 21. OpenClaw 相容性

### 21.1 戰略定位

```
ClawAPI 可以作為 OpenClaw 的「超級 Key 管理器」。

用戶在 OpenClaw 設定：
  Settings → Custom Provider
  → Base URL: http://localhost:4141/v1
  → API Key: {auth.token}

之後 OpenClaw 的所有 LLM 請求都走 ClawAPI：
  → 享受 Key 池輪替
  → 享受智慧 Failover
  → 享受集體智慧路由建議
  → 享受互助功能
  → OpenClaw 完全不用改任何東西
```

### 21.2 OpenAI 相容 API 嚴格要求

```
必須 100% 相容的端點（OpenClaw 會用到的）：

  POST /v1/chat/completions
    → 支援所有 OpenAI 參數：model, messages, temperature, top_p,
      max_tokens, stream, tools, tool_choice, response_format
    → SSE streaming 格式完全相容 OpenAI
    → 回傳結構完全相容（id, object, created, model, choices, usage）

  GET /v1/models
    → 回傳所有可用模型（跨所有服務合併）
    → 格式：{ data: [{ id, object, created, owned_by }] }

SSE Streaming 嚴格要求（#64）：
  → Content-Type: text/event-stream
  → 每行格式：data: {json}\n\n
  → 最後一行：data: [DONE]\n\n
  → delta 格式跟 OpenAI 一致
  → finish_reason 在最後一個 chunk
```

### 21.3 OpenClaw 遷移工具（#58, #132）

```
clawapi migrate-from-openclaw

流程：
  1. 掃描常見位置找 OpenClaw 設定：
     → ~/.config/openclaw/
     → 環境變數 OPENAI_API_KEY, ANTHROPIC_API_KEY, ...
     → .env 檔案

  2. 列出找到的 Key 和設定：
     發現以下 Key：
     ┌────────────┬──────────────────────┐
     │ 服務       │ Key（遮罩）           │
     ├────────────┼──────────────────────┤
     │ OpenAI     │ sk-****abcd          │
     │ Anthropic  │ sk-ant-****efgh      │
     │ Groq       │ gsk_****ijkl         │
     └────────────┴──────────────────────┘

  3. 龍蝦確認：
     ? 要匯入這些 Key 到 ClawAPI 嗎？(Y/n)

  4. 匯入：
     → 加密存入 Key 池
     → 即時驗證
     → 顯示結果

  5. 設定引導：
     ? 要設定 OpenClaw 使用 ClawAPI 嗎？
     → 自動產生 OpenClaw 設定片段，龍蝦貼上就好
```

---

## 附錄 A：MVP 官方 Adapter 清單（#41）

```
免費服務（7 個）：
  1. groq          — Groq 免費推理（Llama, Mixtral, Gemma）
  2. gemini        — Google Gemini（免費額度）
  3. cerebras      — Cerebras 免費推理
  4. sambanova     — SambaNova 免費推理
  5. qwen          — 通義千問免費 API
  6. ollama        — Ollama 本機 LLM
  7. duckduckgo    — DuckDuckGo 免費搜尋

付費服務（8 個）：
  8. openai        — OpenAI (GPT-4o, GPT-4o-mini)
  9. anthropic     — Anthropic (Claude)
  10. deepseek     — DeepSeek (便宜 LLM)
  11. brave-search — Brave Search API
  12. tavily       — Tavily Search API
  13. serper       — Serper Google Search API
  14. openrouter   — OpenRouter (多 LLM 聚合)
  15. deepl        — DeepL 翻譯 API
```

## 附錄 B：資料夾結構完整版

```
~/.clawapi/
├── data.db                 # SQLite 加密資料庫
├── data.db-wal             # WAL 檔案（自動產生）
├── data.db-shm             # Shared memory（自動產生）
├── master.key              # AES-256 主密鑰（0600 權限）
├── auth.token              # 本機 proxy 認證 token
├── config.yaml             # 使用者設定
├── adapters/
│   ├── official/           # 內建官方 Adapter（15 個）
│   │   ├── groq.yaml
│   │   ├── gemini.yaml
│   │   ├── openai.yaml
│   │   ├── anthropic.yaml
│   │   ├── deepseek.yaml
│   │   ├── cerebras.yaml
│   │   ├── sambanova.yaml
│   │   ├── qwen.yaml
│   │   ├── ollama.yaml
│   │   ├── duckduckgo.yaml
│   │   ├── brave-search.yaml
│   │   ├── tavily.yaml
│   │   ├── serper.yaml
│   │   ├── openrouter.yaml
│   │   └── deepl.yaml
│   └── community/          # 社群安裝的 Adapter
├── backups/                # 匯出的加密備份
├── logs/                   # 日誌（JSON Lines）
│   └── clawapi.log         # 主日誌（30 天自動清理）
└── cache/
    ├── routing-intel.json  # 路由建議快取
    └── l0-keys.json        # L0 公共 Key 快取
```

---

*SPEC-A 開源引擎規格書 v1.1 — 完*
*依據：計畫書 v4.0（170 項決策）+ SPEC-C 通訊協議 v1.0*
*v1.1 修訂：R-01/R-02/R-03/R-05/R-06/Y-01/Y-02/Y-03/Y-04/Y-11/G-01/G-02/G-03/O-02/O-06*
*下一步：SPEC-B VPS 服務規格書*
