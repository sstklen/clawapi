# ClawAPI SPEC-B：VPS 服務規格書 v1.0

> **tkman 控制的閉源 VPS 服務 — ClawAPI 生態的「大腦」**
> 這份文件定義了跑在 tkman VPS 上的所有服務模組、演算法和部署架構。
> 最後更新：2026-03-01
> 狀態：草案，待 tkman 確認

---

## 目錄

1. [VPS 架構圖](#1-vps-架構圖)
2. [集體智慧分析引擎](#2-集體智慧分析引擎)
3. [L0 公共 Key 管理](#3-l0-公共-key-管理)
4. [互助配對引擎](#4-互助配對引擎)
5. [雲端備份服務（v1.1+）](#5-雲端備份服務v11)
6. [聊天室中繼](#6-聊天室中繼)
7. [Sub-Key VPS 驗證中繼](#7-sub-key-vps-驗證中繼)
8. [Claude Bot 八大功能](#8-claude-bot-八大功能)
9. [GitHub Actions 工作流](#9-github-actions-工作流)
10. [VPS DB Schema](#10-vps-db-schema)
11. [VPS API 實作](#11-vps-api-實作)
12. [VPS 監控 + 告警](#12-vps-監控--告警)
13. [VPS 代架服務架構（v1.1+）](#13-vps-代架服務架構v11)
14. [災難恢復 SOP](#14-災難恢復-sop)
15. [部署流程](#15-部署流程)
16. [安全加固](#16-安全加固)

---

## 1. VPS 架構圖

### 1.1 系統鳥瞰圖

```
┌──────────────────────────────────────────────────────────────────────┐
│                    tkman VPS（8GB RAM, 160GB SSD）                    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                       Docker Compose                           │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │                   Caddy（反向代理）                        │  │  │
│  │  │   api.clawapi.com → :3100                                │  │  │
│  │  │   TLS 自動管理 + HTTP/2                                   │  │  │
│  │  └──────────────────────┬───────────────────────────────────┘  │  │
│  │                         │                                      │  │
│  │  ┌──────────────────────┴───────────────────────────────────┐  │  │
│  │  │              ClawAPI VPS 服務（Bun + Hono）               │  │  │
│  │  │              Container: clawapi-vps, Port: 3100           │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │  │
│  │  │  │ API      │ │ WS       │ │ Rate     │ │ Auth      │  │  │  │
│  │  │  │ Gateway  │ │ Manager  │ │ Limiter  │ │ Middleware│  │  │  │
│  │  │  └────┬─────┘ └────┬─────┘ └──────────┘ └───────────┘  │  │  │
│  │  │       │            │                                     │  │  │
│  │  │  ┌────┴────────────┴──────────────────────────────────┐  │  │  │
│  │  │  │                  業務模組層                          │  │  │  │
│  │  │  │                                                    │  │  │  │
│  │  │  │  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │  │  │  │
│  │  │  │  │ 集體智慧  │  │ L0 Key   │  │ 互助配對引擎     │  │  │  │  │
│  │  │  │  │ 分析引擎  │  │ 管理器   │  │ + ECDH 中繼     │  │  │  │  │
│  │  │  │  └──────────┘  └──────────┘  └─────────────────┘  │  │  │  │
│  │  │  │                                                    │  │  │  │
│  │  │  │  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │  │  │  │
│  │  │  │  │ 聊天室   │  │ 備份     │  │ Sub-Key 驗證    │  │  │  │  │
│  │  │  │  │ 中繼器   │  │ 管理器   │  │ 中繼器          │  │  │  │  │
│  │  │  │  └──────────┘  └──────────┘  └─────────────────┘  │  │  │  │
│  │  │  │                                                    │  │  │  │
│  │  │  └────────────────────────────────────────────────────┘  │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌────────────────────────────────────────────────────┐  │  │  │
│  │  │  │               SQLite（WAL 模式）                    │  │  │  │
│  │  │  │               /data/clawapi-vps.db                  │  │  │  │
│  │  │  └────────────────────────────────────────────────────┘  │  │  │
│  │  │                                                          │  │  │
│  │  │  ┌────────────────────────────────────────────────────┐  │  │  │
│  │  │  │           排程器（Cron Jobs）                        │  │  │  │
│  │  │  │  • 每小時：集體智慧分析                               │  │  │  │
│  │  │  │  • 每 5 分鐘：Key 健康檢查                           │  │  │  │
│  │  │  │  • 每天：數據清理 + DB 備份                           │  │  │  │
│  │  │  │  • 每 15 分鐘：WAL checkpoint                       │  │  │  │
│  │  │  └────────────────────────────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 模組依賴圖

```
                    ┌──────────────┐
                    │  API Gateway │
                    │   (Hono)     │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
    ┌─────────┴──┐  ┌──────┴─────┐  ┌──┴──────────┐
    │ Auth       │  │ Rate       │  │ WS Manager  │
    │ Middleware │  │ Limiter    │  │             │
    └─────────┬──┘  └──────┬─────┘  └──┬──────────┘
              │            │            │
    ┌─────────┴────────────┴────────────┴──────────┐
    │              業務模組路由                       │
    └──┬────┬────┬────┬────┬────┬────┬──────────────┘
       │    │    │    │    │    │    │
       ▼    ▼    ▼    ▼    ▼    ▼    ▼
    集體  L0   互助  聊天  備份  Sub  裝置
    智慧  Key  配對  中繼  管理  Key  管理
    引擎  管理  引擎  器    器   驗證  器
       │    │    │    │    │    │    │
       └────┴────┴────┴────┴────┴────┘
                      │
               ┌──────┴──────┐
               │ SQLite DB   │
               │ (WAL mode)  │
               └─────────────┘
```

### 1.3 Docker Compose 結構

```yaml
# docker-compose.vps.yml
version: "3.8"

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - clawapi-vps
    networks:
      - clawapi-net

  clawapi-vps:
    build:
      context: .
      dockerfile: Dockerfile.vps
    restart: unless-stopped
    expose:
      - "3100"
    volumes:
      - vps_data:/data          # SQLite DB + 備份檔
      - vps_logs:/logs          # 日誌
      - vps_keys:/keys          # ECDH 金鑰對
    environment:
      - NODE_ENV=production
      - VPS_PORT=3100
      - DB_PATH=/data/clawapi-vps.db
      - LOG_PATH=/logs
      - KEYS_PATH=/keys
      - ECDH_KEY_PATH=/keys/ecdh
      - BACKUP_PATH=/data/backups
      - ADMIN_TOKEN=${ADMIN_TOKEN}          # tkman 管理用
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}  # 告警通知用
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
    healthcheck:  # <!-- v1.2 修訂：Alpine/Bun 映像沒有 curl，改用 bun 內建 fetch -->
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3100/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks:
      - clawapi-net

volumes:
  caddy_data:
  caddy_config:
  vps_data:
  vps_logs:
  vps_keys:

networks:
  clawapi-net:
    driver: bridge
```

### 1.4 技術棧

| 層級 | 選擇 | 原因 |
|------|------|------|
| Runtime | Bun | 原生 SQLite、快速啟動、TypeScript 原生 |
| Framework | Hono | 輕量、WebSocket 支持好、中介層好用 |
| DB | SQLite (WAL) | 8GB RAM 限制內最佳選擇，零外部依賴 |
| 反向代理 | Caddy | 自動 TLS、HTTP/2、設定簡單 |
| 容器 | Docker | 隔離 + 一鍵部署 |
| 告警 | Telegram Bot | tkman 最常用的通訊工具 |

### 1.5 記憶體預算（8GB 限制）

```
元件              預估用量      備註
──────────────────────────────────────────
Caddy             ~50MB       反向代理
ClawAPI VPS       ~200MB      主服務
SQLite            ~100MB      WAL + 快取
WebSocket 連線    ~500MB      預估 5K 同時連線（100KB/連線）
排程分析任務       ~200MB      每小時峰值
OS + Docker       ~500MB      基本開銷
──────────────────────────────────────────
總計              ~1.55GB     留約 6.5GB 餘裕
```

### 1.6 規模階梯 <!-- v1.1 修訂 Y-09 -->

> 隨龍蝦數量成長的升級路線圖。提前規劃，避免突然爆量時手忙腳亂。

| 龍蝦數量 | VPS 配置 | 資料庫 | 預估記憶體 | 行動 |
|----------|---------|--------|-----------|------|
| 0-500 | 8GB RAM, 160GB SSD | SQLite WAL | ~1.5GB | 現方案 |
| 500-2000 | 8GB RAM | SQLite WAL + 讀寫分離 | ~3GB | 監控記憶體，考慮升級 |
| 2000-5000 | 16GB RAM | SQLite WAL + 讀寫分離 | ~6GB | 升級 VPS |
| 5000+ | 32GB RAM | PostgreSQL | ~8GB+ | 遷移至 PostgreSQL |

**觸發升級的指標：**

| 指標 | 閾值 | 動作 |
|------|------|------|
| 記憶體使用 | > 75%（6GB） | Telegram 告警，評估升級 |
| WebSocket 連線 | > 2000 | 考慮升級 VPS 或做連線分流 |
| DB WAL 檔案 | > 500MB | 考慮遷移至 PostgreSQL |
| API 回應 p95 | > 200ms | 效能調查，可能需要升級或優化 |

```typescript
// 規模監控排程（每 15 分鐘）
async function checkScaleMetrics(): Promise<void> {
  const metrics = {
    memoryPercent: process.memoryUsage().heapUsed / (8 * 1024 * 1024 * 1024),
    wsConnections: wsManager.getOnlineCount(),
    walSize: await getFileSize(process.env.DB_PATH + '-wal'),
    p95Latency: await getRecentP95Latency(),
  };

  // 記憶體 > 75% → 告警
  if (metrics.memoryPercent > 0.75) {
    await alertManager.sendTkmanAlert({
      severity: 'warning',
      message: `記憶體使用 ${Math.round(metrics.memoryPercent * 100)}%，接近升級門檻`,
      suggestion: '考慮升級 VPS 到 16GB RAM'
    });
  }

  // WebSocket > 2000 → 告警
  if (metrics.wsConnections > 2000) {
    await alertManager.sendTkmanAlert({
      severity: 'warning',
      message: `WebSocket 連線數 ${metrics.wsConnections}，超過 2000`,
      suggestion: '考慮升級 VPS 或做連線分流'
    });
  }

  // WAL > 500MB → 告警
  if (metrics.walSize > 500 * 1024 * 1024) {
    await alertManager.sendTkmanAlert({
      severity: 'warning',
      message: `WAL 檔案 ${Math.round(metrics.walSize / 1024 / 1024)}MB，超過 500MB`,
      suggestion: '考慮遷移至 PostgreSQL'
    });
  }

  // p95 > 200ms → 告警
  if (metrics.p95Latency > 200) {
    await alertManager.sendTkmanAlert({
      severity: 'warning',
      message: `API 回應 p95 延遲 ${metrics.p95Latency}ms，超過 200ms`,
      suggestion: '需要效能調查'
    });
  }
}
```

---

## 2. 集體智慧分析引擎

> 護城河核心。每小時分析全體龍蝦的匿名統計數據，產生分地區的路由建議。

### 2.1 資料接收管線

```typescript
// 接收 POST /v1/telemetry/batch
interface TelemetryPipeline {
  // 步驟 1：解碼 MessagePack
  decode(body: Buffer): TelemetryBatch;

  // 步驟 2：去重（batch_id 檢查）
  deduplicate(batch: TelemetryBatch): boolean;  // true = 新的，false = 重複

  // 步驟 3：驗證
  validate(batch: TelemetryBatch): ValidationResult;

  // 步驟 4：信譽加權
  applyReputationWeight(
    batch: TelemetryBatch,
    deviceId: string
  ): WeightedBatch;

  // 步驟 5：寫入 DB
  persist(batch: WeightedBatch): void;
}
```

#### 去重邏輯

```typescript
// 用 batch_id 去重，快取最近 24 小時的 batch_id
const DEDUP_CACHE = new Map<string, number>();  // batch_id → 收到時間戳
const DEDUP_TTL = 24 * 60 * 60 * 1000;         // 24 小時

function isDuplicate(batchId: string): boolean {
  if (DEDUP_CACHE.has(batchId)) return true;
  DEDUP_CACHE.set(batchId, Date.now());
  return false;
}

// 每小時清理過期條目
function cleanDedup(): void {
  const now = Date.now();
  for (const [id, ts] of DEDUP_CACHE) {
    if (now - ts > DEDUP_TTL) DEDUP_CACHE.delete(id);
  }
}
```

#### 驗證規則

```typescript
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateBatch(batch: TelemetryBatch): ValidationResult {
  const errors: string[] = [];

  // 1. schema_version 必須 ≥ 1
  if (batch.schema_version < 1) {
    errors.push('schema_version 太舊');
  }

  // 2. entries 數量上限 1000 條
  if (batch.entries.length > 1000) {
    errors.push('entries 超過 1000 條上限');
  }

  // 3. period 不能超過 2 小時（防造假）
  const periodMs = new Date(batch.period.to).getTime()
    - new Date(batch.period.from).getTime();
  if (periodMs > 2 * 60 * 60 * 1000) {
    errors.push('period 跨度超過 2 小時');
  }

  // 4. period.to 不能在未來（容忍 5 分鐘時鐘差）
  if (new Date(batch.period.to).getTime() > Date.now() + 5 * 60 * 1000) {
    errors.push('period.to 在未來');
  }

  // 5. 每個 entry 的 latency_ms 必須在合理範圍（0-300000ms）
  for (const entry of batch.entries) {
    if (entry.latency_ms < 0 || entry.latency_ms > 300000) {
      errors.push(`latency_ms 不合理：${entry.latency_ms}`);
      break;  // 只報第一個錯
    }
  }

  // 6. service_id 必須是已知服務
  const knownServices = new Set([
    'groq', 'gemini', 'openai', 'anthropic', 'deepseek',
    'cerebras', 'sambanova', 'qwen', 'ollama',
    'brave-search', 'tavily', 'serper', 'duckduckgo',
    'deepl', 'openrouter'
  ]);
  for (const entry of batch.entries) {
    if (!knownServices.has(entry.service_id)) {
      errors.push(`未知 service_id：${entry.service_id}`);
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}
```

### 2.2 信譽加權系統

```typescript
// 龍蝦數據的可信度評分（#135）
interface ReputationScore {
  deviceId: string;
  weight: number;        // 0.0 ~ 2.0
  tier: 'new' | 'normal' | 'veteran';
  anomalyCount: number;  // 被標記異常的次數
}

// 信譽計算虛擬碼
function calculateReputation(deviceId: string): number {
  const device = db.getDevice(deviceId);
  const daysSinceRegister = daysBetween(device.created_at, now());
  const totalBatches = db.getTelemetryBatchCount(deviceId);
  const anomalyCount = db.getAnomalyCount(deviceId);

  // 基礎分
  let weight: number;

  // 新蝦（< 7 天 或 < 10 批上報）→ 0.3x
  if (daysSinceRegister < 7 || totalBatches < 10) {
    weight = 0.3;
  }
  // 老蝦（> 90 天 且 > 500 批上報）→ 1.5x
  else if (daysSinceRegister > 90 && totalBatches > 500) {
    weight = 1.5;
  }
  // 普通蝦 → 1.0x
  else {
    weight = 1.0;
  }

  // 異常懲罰：每次異常降 0.2，最低 0.1
  weight = Math.max(0.1, weight - anomalyCount * 0.2);

  return weight;
}
```

### 2.3 異常偵測演算法

```typescript
// 識別灌假數據的龍蝦（#B6, #135）
interface AnomalyDetector {
  // 每次收到 batch 後執行
  detect(batch: WeightedBatch, deviceId: string): AnomalyReport;
}

interface AnomalyReport {
  isAnomalous: boolean;
  reasons: string[];
  action: 'none' | 'downweight' | 'suspend';
}

function detectAnomaly(
  batch: WeightedBatch,
  deviceId: string,
  globalStats: GlobalStats
): AnomalyReport {
  const reasons: string[] = [];

  // 規則 1：與多數人矛盾
  // 如果此龍蝦報告某服務成功率 < 50%，但全體平均 > 90%
  // → 可能是假數據或該龍蝦的 Key 有問題
  for (const entry of batch.entries) {
    const global = globalStats.getServiceStats(entry.service_id);
    if (global && global.sampleSize > 50) {
      const deviceSuccessRate = batch.getSuccessRate(entry.service_id);
      if (deviceSuccessRate < 0.5 && global.successRate > 0.9) {
        reasons.push(
          `${entry.service_id} 成功率 ${deviceSuccessRate} 遠低於全體 ${global.successRate}`
        );
      }
    }
  }

  // 規則 2：延遲離群值
  // 如果此龍蝦報告的 p95 延遲 > 全體 p95 的 5 倍
  for (const entry of batch.entries) {
    const global = globalStats.getServiceStats(entry.service_id);
    if (global && global.sampleSize > 50) {
      if (entry.latency_ms > global.p95LatencyMs * 5) {
        reasons.push(
          `${entry.service_id} 延遲 ${entry.latency_ms}ms 遠高於全體 p95 ${global.p95LatencyMs}ms`
        );
      }
    }
  }

  // 規則 3：上報頻率異常
  // 同一 device_id 在 1 小時內上報 > 2 次（正常只有 1 次 + 重試 1 次）
  const recentBatches = db.getRecentBatchCount(deviceId, 1);  // 最近 1 小時
  if (recentBatches > 3) {
    reasons.push(`1 小時內上報 ${recentBatches} 次（正常 ≤ 2）`);
  }

  // 規則 4：數據量與使用時間不成比例
  // 剛註冊 1 天就上報 5000 條 entries
  const device = db.getDevice(deviceId);
  const daysSince = daysBetween(device.created_at, now());
  if (daysSince < 3 && batch.entries.length > 500) {
    reasons.push(
      `註冊 ${daysSince} 天就上報 ${batch.entries.length} 條（太密集）`
    );
  }

  // 決定處理動作
  let action: 'none' | 'downweight' | 'suspend' = 'none';
  if (reasons.length >= 3) {
    action = 'suspend';  // 暫停此裝置
  } else if (reasons.length >= 1) {
    action = 'downweight';  // 降低權重到 0.1x
  }

  return {
    isAnomalous: reasons.length > 0,
    reasons,
    action
  };
}
```

### 2.4 聚合分析演算法（每小時執行）

```typescript
// 每小時的分析任務
async function runHourlyAnalysis(): Promise<void> {
  const startTime = Date.now();
  console.log('[集體智慧] 開始每小時分析...');

  // 步驟 1：取得過去 1 小時的原始數據
  const rawData = db.getTelemetryEntries({
    from: new Date(Date.now() - 60 * 60 * 1000),
    to: new Date()
  });

  // 步驟 2：按地區分組（#88）<!-- v1.1 修訂 G-05 -->
  // 地區判定規則：
  // - 路由建議按 assigned_region（VPS 判定）為準
  // - region（龍蝦自報）僅做參考
  const regions = ['asia', 'europe', 'americas', 'other'] as const;
  const regionData = groupByRegion(rawData);  // 使用 assigned_region 分組

  // 步驟 3：對每個地區、每個服務計算指標
  const recommendations: Recommendation[] = [];

  for (const region of regions) {
    const data = regionData[region];
    if (!data || data.length === 0) continue;

    // 按 service_id 分組
    const byService = groupByService(data);

    for (const [serviceId, entries] of Object.entries(byService)) {
      // 過濾：使用者少於 10 人的服務合併到「其他」（#86, #B11）
      const uniqueDevices = new Set(entries.map(e => e.device_id));
      if (uniqueDevices.size < 10) continue;

      // 計算加權指標
      const metrics = calculateWeightedMetrics(entries);

      // 判定狀態
      const status = determineStatus(metrics);

      // 計算信心值（基於樣本數）
      const confidence = calculateConfidence(uniqueDevices.size);

      recommendations.push({
        service_id: serviceId,
        region,
        status,
        confidence,
        metrics: {
          success_rate: metrics.successRate,
          avg_latency_ms: metrics.avgLatencyMs,
          p95_latency_ms: metrics.p95LatencyMs,  // 統一用 p95（不是 p99）
          sample_size: uniqueDevices.size
        },
        note: generateNote(serviceId, status, metrics)
      });
    }
  }

  // 步驟 4：生成 alerts（即時警報）
  const alerts = detectServiceAlerts(rawData);

  // 步驟 5：存入 DB
  db.saveRoutingRecommendations(recommendations, alerts);

  // 步驟 6：透過 WebSocket 推送給所有線上龍蝦
  await wsManager.broadcastRoutingUpdate(recommendations, alerts);

  const elapsed = Date.now() - startTime;
  console.log(`[集體智慧] 分析完成，耗時 ${elapsed}ms，產生 ${recommendations.length} 條建議`);
}
```

#### 加權指標計算

```typescript
interface WeightedMetrics {
  successRate: number;     // 0-1
  avgLatencyMs: number;    // 毫秒
  p95LatencyMs: number;    // p95 延遲（不是 p99）
  errorRate: number;       // 0-1
  rateLimitRate: number;   // 0-1（被 429 的比率）
  timeoutRate: number;     // 0-1
}

function calculateWeightedMetrics(
  entries: TelemetryEntryWithWeight[]
): WeightedMetrics {
  let totalWeight = 0;
  let successWeight = 0;
  let latencySum = 0;
  let latencyWeightSum = 0;
  const latencies: number[] = [];
  let errorWeight = 0;
  let rateLimitWeight = 0;
  let timeoutWeight = 0;

  for (const entry of entries) {
    const w = entry.reputationWeight;
    totalWeight += w;

    // 成功率（加權）
    if (entry.outcome === 'success') {
      successWeight += w;
      // 延遲只算成功的
      latencySum += entry.latency_ms * w;
      latencyWeightSum += w;
      latencies.push(entry.latency_ms);
    } else if (entry.outcome === 'error') {
      errorWeight += w;
    } else if (entry.outcome === 'rate_limited') {
      rateLimitWeight += w;
    } else if (entry.outcome === 'timeout') {
      timeoutWeight += w;
    }
  }

  // p95 延遲計算
  latencies.sort((a, b) => a - b);
  const p95Index = Math.ceil(latencies.length * 0.95) - 1;
  const p95Latency = latencies[Math.max(0, p95Index)] || 0;

  return {
    successRate: totalWeight > 0 ? successWeight / totalWeight : 0,
    avgLatencyMs: latencyWeightSum > 0
      ? Math.round(latencySum / latencyWeightSum) : 0,
    p95LatencyMs: Math.round(p95Latency),
    errorRate: totalWeight > 0 ? errorWeight / totalWeight : 0,
    rateLimitRate: totalWeight > 0 ? rateLimitWeight / totalWeight : 0,
    timeoutRate: totalWeight > 0 ? timeoutWeight / totalWeight : 0,
  };
}
```

#### 狀態判定邏輯

```typescript
// 判定服務狀態：preferred / degraded / avoid
function determineStatus(
  metrics: WeightedMetrics
): 'preferred' | 'degraded' | 'avoid' {
  // avoid：成功率 < 60% 或 p95 延遲 > 30s 或 限速率 > 40%
  if (
    metrics.successRate < 0.6 ||
    metrics.p95LatencyMs > 30000 ||
    metrics.rateLimitRate > 0.4
  ) {
    return 'avoid';
  }

  // degraded：成功率 < 85% 或 p95 延遲 > 10s 或 限速率 > 15%
  if (
    metrics.successRate < 0.85 ||
    metrics.p95LatencyMs > 10000 ||
    metrics.rateLimitRate > 0.15
  ) {
    return 'degraded';
  }

  // preferred：其餘
  return 'preferred';
}
```

#### 信心值計算

```typescript
// 信心值基於龍蝦數量（樣本大小）
function calculateConfidence(sampleSize: number): number {
  // 10人 → 0.3, 50人 → 0.7, 100人 → 0.85, 500人 → 0.95, 1000人+ → 0.99
  if (sampleSize < 10) return 0.1;
  if (sampleSize < 30) return 0.3 + (sampleSize - 10) * 0.02;
  if (sampleSize < 100) return 0.7 + (sampleSize - 30) * 0.002;
  if (sampleSize < 500) return 0.85 + (sampleSize - 100) * 0.00025;
  return Math.min(0.99, 0.95 + (sampleSize - 500) * 0.0001);
}
```

### 2.5 路由回饋處理（#86）

```typescript
// 處理 POST /v1/telemetry/feedback
async function processFeedback(feedback: RoutingFeedback): Promise<void> {
  // 步驟 1：儲存回饋
  db.saveFeedback({
    device_id: feedback.deviceId,
    recommendation_id: feedback.recommendation_id,
    service_id: feedback.service_id,
    feedback: feedback.feedback,  // 'positive' | 'negative'
    reason: feedback.reason,
    comment: feedback.comment,
    created_at: new Date().toISOString()
  });

  // 步驟 2：累積回饋影響下次分析
  // negative 回饋：在下次分析時對該服務的分數施加懲罰
  if (feedback.feedback === 'negative') {
    // 儲存到 feedback_aggregation 表
    // 下次 runHourlyAnalysis() 時會讀取並影響建議
    db.incrementNegativeFeedback(
      feedback.service_id,
      feedback.deviceId
    );
  }

  // 步驟 3：如果短時間內收到大量 negative → 觸發即時警報
  const recentNegatives = db.getRecentNegativeFeedbackCount(
    feedback.service_id,
    30  // 最近 30 分鐘
  );
  if (recentNegatives > 10) {
    await alertManager.sendServiceAlert({
      severity: 'warning',
      service_id: feedback.service_id,
      message: `${feedback.service_id} 近 30 分鐘收到 ${recentNegatives} 則負面回饋`,
      started_at: new Date().toISOString()
    });
  }
}
```

#### 回饋如何影響下次建議

```typescript
// 在 runHourlyAnalysis() 中的額外步驟
function applyFeedbackAdjustment(
  recommendations: Recommendation[]
): Recommendation[] {
  for (const rec of recommendations) {
    // 取得此服務近 24 小時的回饋統計
    const feedbackStats = db.getFeedbackStats(
      rec.service_id,
      rec.region,
      24  // 小時
    );

    if (feedbackStats.total > 5) {
      // 負面比率
      const negativeRate = feedbackStats.negative / feedbackStats.total;

      // 如果負面回饋 > 30%，降級一檔
      if (negativeRate > 0.3 && rec.status === 'preferred') {
        rec.status = 'degraded';
        rec.note = `用戶回饋不佳（${Math.round(negativeRate * 100)}% 負面）`;
      }

      // 如果負面回饋 > 60%，降到 avoid
      if (negativeRate > 0.6 && rec.status !== 'avoid') {
        rec.status = 'avoid';
        rec.note = `大量用戶回饋負面（${Math.round(negativeRate * 100)}%）`;
      }
    }
  }
  return recommendations;
}
```

### 2.6 WebSocket 推送邏輯

```typescript
// 推送路由更新給所有線上龍蝦
async function broadcastRoutingUpdate(
  recommendations: Recommendation[],
  alerts: ServiceAlert[]
): Promise<void> {
  // 按地區分組推送（每隻龍蝦只收到自己地區的建議）
  const byRegion = groupRecommendationsByRegion(recommendations);

  for (const [region, regionRecs] of Object.entries(byRegion)) {
    const message: ServerMessage = {
      type: 'routing_update',
      channel: 'routing',
      id: `rt_${formatDate(now())}_${region}`,
      payload: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        valid_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        recommendations: regionRecs,
        alerts: alerts.filter(a =>
          a.region === region || a.region === 'global'
        )
      },
      server_time: new Date().toISOString()
    };

    // 找出該地區的線上龍蝦
    const connections = wsManager.getConnectionsByRegion(region);
    for (const conn of connections) {
      conn.send(JSON.stringify(message));
    }
  }

  console.log(
    `[WebSocket] 推送路由更新給 ${wsManager.getOnlineCount()} 隻龍蝦`
  );
}
```

### 2.7 冷啟動策略（#84）

```typescript
// 龍蝦不多時的預設推薦
const COLD_START_RECOMMENDATIONS: Record<string, Recommendation[]> = {
  asia: [
    {
      service_id: 'groq',
      region: 'asia',
      status: 'preferred',
      confidence: 0.1,  // 明確標示低信心
      metrics: {
        success_rate: 0.95,
        avg_latency_ms: 200,
        p95_latency_ms: 800,
        sample_size: 0  // 標註「基於預設，非數據」
      },
      note: '預設推薦（尚未收集足夠數據）'
    },
    // ... 其他服務
  ],
  // ... 其他地區
};

// 判斷是否處於冷啟動
function isColdStart(region: string): boolean {
  const activeDevices = db.getActiveDeviceCount(region, 24);  // 24 小時內
  return activeDevices < 10;
}
```

### 2.8 地區判定規則 <!-- v1.1 修訂 G-05 -->

> 路由建議的精準度取決於地區分組的正確性。以下定義 VPS 如何判定龍蝦的地區。

```
地區判定規則：
- 路由建議按 assigned_region（VPS 判定）為準
- region（龍蝦自報）僅做參考
- VPS 判定方式：
  1. 首選：龍蝦連線的 IP 地理定位（MaxMind GeoLite2 免費庫）
  2. 備選：龍蝦自報的 timezone 推算（Asia/Tokyo → asia）
  3. 兩者不一致時：以 IP 定位為準
```

```typescript
// 地區判定邏輯
async function assignRegion(
  deviceId: string,
  ipAddress: string,
  selfReportedTimezone: string
): Promise<string> {
  // 1. 首選：IP 地理定位
  const geoResult = await geoip.lookup(ipAddress);  // MaxMind GeoLite2
  let ipRegion: string | null = null;

  if (geoResult) {
    // 將國家碼對應到地區
    ipRegion = mapCountryToRegion(geoResult.country);
  }

  // 2. 備選：timezone 推算
  const tzRegion = mapTimezoneToRegion(selfReportedTimezone);
  // 例：'Asia/Tokyo' → 'asia'
  //     'Europe/London' → 'europe'
  //     'America/New_York' → 'americas'

  // 3. 決定最終地區
  let assignedRegion: string;

  if (ipRegion) {
    assignedRegion = ipRegion;  // IP 定位為準

    // 如果兩者不一致，記錄（用於日後分析）
    if (tzRegion && tzRegion !== ipRegion) {
      console.log(
        `[地區] ${deviceId}: IP 判定 ${ipRegion}，timezone 推算 ${tzRegion}，以 IP 為準`
      );
    }
  } else if (tzRegion) {
    assignedRegion = tzRegion;  // IP 無結果，用 timezone
  } else {
    assignedRegion = 'other';   // 都沒有，歸到 other
  }

  // 更新 DB
  db.updateDeviceRegion(deviceId, assignedRegion);

  return assignedRegion;
}

// 國家碼到地區的對應表
function mapCountryToRegion(country: string): string {
  const regionMap: Record<string, string[]> = {
    asia: ['JP', 'KR', 'CN', 'TW', 'HK', 'SG', 'TH', 'VN', 'ID', 'MY',
           'PH', 'IN', 'BD', 'PK', 'LK', 'NP', 'MM', 'KH', 'LA', 'MN'],
    europe: ['GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'NO', 'DK', 'FI',
             'CH', 'AT', 'BE', 'PT', 'PL', 'CZ', 'RO', 'HU', 'IE', 'GR',
             'UA', 'RU', 'TR'],
    americas: ['US', 'CA', 'MX', 'BR', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC'],
  };

  for (const [region, countries] of Object.entries(regionMap)) {
    if (countries.includes(country)) return region;
  }
  return 'other';
}

// Timezone 到地區的推算
function mapTimezoneToRegion(tz: string): string | null {
  if (!tz) return null;
  if (tz.startsWith('Asia/')) return 'asia';
  if (tz.startsWith('Europe/')) return 'europe';
  if (tz.startsWith('America/')) return 'americas';
  if (tz.startsWith('Pacific/')) return 'asia';  // 大洋洲歸到 asia
  if (tz.startsWith('Australia/')) return 'asia';
  if (tz.startsWith('Africa/')) return 'europe';  // 非洲歸到 europe（地理上較近）
  return null;
}
```

#### VPS 重啟後的冷啟動路由 <!-- v1.1 修訂 O-03 -->

> 上面的 2.7 節是「龍蝦人數不夠多」的冷啟動。
> 這裡是「VPS 重啟後記憶體清空」的冷啟動——從 DB 載入歷史聚合數據，立刻提供過渡性路由建議。

```typescript
// 冷啟動策略（VPS 重啟後立即可用）
async function coldStartRouting(): Promise<void> {
  // 1. 從 DB 載入最近 24 小時的聚合統計
  const recentStats = await db.query(`
    SELECT provider, model, region,
           AVG(success_rate) as avg_success_rate,
           AVG(latency_p95) as avg_latency_p95,
           COUNT(*) as sample_count
    FROM telemetry_aggregated
    WHERE aggregated_at > datetime('now', '-24 hours')
    GROUP BY provider, model, region
  `);

  // 2. 產生「過渡性」路由建議
  const coldStartSuggestions = recentStats.map(stat => ({
    ...stat,
    confidence: Math.min(stat.sample_count / 100, 0.7), // 最高 0.7（正常是 0.8-1.0）
    is_cold_start: true,
    generated_at: Date.now()
  }));

  // 3. 推送給已連線的龍蝦（標注低信心度）
  wsManager.broadcast('routing', {
    type: 'routing_update',
    payload: {
      suggestions: coldStartSuggestions,
      meta: { cold_start: true, message: '伺服器剛重啟，建議僅供參考' }
    }
  });

  // 4. 30 分鐘後如果有足夠新數據，切換為正常模式
  const startTime = Date.now();
  setTimeout(async () => {
    const freshReports = await countReportsSince(startTime);
    if (freshReports >= 50) {
      await runFullAnalysis();  // 切換為正常分析模式
    }
  }, 30 * 60 * 1000);
}

// 在 VPS 啟動時呼叫
async function onServerStart(): Promise<void> {
  // ... 其他初始化 ...

  // 立即執行冷啟動路由
  await coldStartRouting();
  console.log('[集體智慧] 冷啟動路由建議已就緒');
}
```

### 2.10 路由建議查詢端點 <!-- v1.3 新增：供 WS 重連後拉取最新路由建議 -->

> SPEC-C 定義了 `GET /v1/telemetry/route-suggestions`，用於龍蝦 WebSocket 重連後主動拉取最新路由建議，
> 確保斷線期間不會錯過路由更新。

```typescript
// GET /v1/telemetry/route-suggestions
// 回傳該裝置所在 region 的最新路由建議（用於 WS 重連恢復）
async function handleRouteSuggestions(c: Context): Promise<Response> {
  const deviceId = c.get('deviceId');
  const device = db.getDevice(deviceId);
  const region = device.assigned_region;

  // 從最新的每小時分析結果中取得該 region 的建議
  const suggestions = db.query(`
    SELECT service_id, status, confidence, success_rate,
           avg_latency_ms, p95_latency_ms, sample_size, note,
           generated_at, valid_until
    FROM routing_recommendations
    WHERE region = ?
      AND valid_until > datetime('now')
    ORDER BY generated_at DESC
  `, [region]);

  // 取得下次每小時更新時間
  const now = new Date();
  const nextUpdate = new Date(now);
  nextUpdate.setMinutes(0, 0, 0);
  nextUpdate.setHours(nextUpdate.getHours() + 1);

  return c.json({
    suggestions,
    region,
    generated_at: suggestions[0]?.generated_at ?? null,
    next_update_at: nextUpdate.toISOString()
  });
}
```

---

## 3. L0 公共 Key 管理

> VPS 端的 L0 公共 Key 完整管理系統。

### 3.1 Key 儲存與加密

```typescript
interface L0KeyRecord {
  id: string;                    // 'l0k_001'
  service_id: string;            // 'groq'
  key_value_encrypted: Buffer;   // AES-256-GCM 加密的原始 Key 值
  encryption_key_id: string;     // 用哪把 master key 加密的
  status: 'active' | 'degraded' | 'dead';
  daily_quota: number | null;    // 此 Key 的每日總額度（null = 無限）
  daily_used: number;            // 今天全體已用次數
  donated_by_device_id: string | null;  // 捐贈者（不公開）
  donated_by_display: string | null;    // 捐贈者顯示名稱
  is_anonymous_donation: boolean;        // 匿名捐贈
  last_health_check: string;     // 上次健康檢查時間
  created_at: string;
  updated_at: string;
}

// L0 Master Key 管理
// VPS 用這把 key 加密所有 L0 公共 Key
// 存在 /keys/l0-master.key，不進 DB
interface L0MasterKeyManager {
  // 啟動時載入
  loadMasterKey(): Buffer;

  // 加密 L0 Key（存入 DB 前）
  encryptL0Key(plainKey: string): { encrypted: Buffer; keyId: string };

  // 產生下發用的加密包（給龍蝦解密用）
  prepareForDownload(record: L0KeyRecord): {
    key_encrypted: string;       // base64
    encryption_method: 'aes-256-gcm';
    encryption_key_id: string;
    l0_encryption_key: string;   // base64，龍蝦用這把解密
  };
}
```

### 3.2 下發機制

```typescript
// GET /v1/l0/keys 的處理邏輯
async function handleL0KeysRequest(
  deviceId: string,
  since?: string  // 上次拿到的時間
): Promise<L0KeysResponse> {
  // 步驟 1：檢查快取（5 分鐘快取）
  const cacheKey = `l0_keys_${since || 'all'}`;
  const cached = l0Cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    // 只更新個人用量部分
    return {
      ...cached.data,
      device_daily_limits: getDeviceLimits(deviceId)
    };
  }

  // 步驟 2：查詢 DB
  let keys: L0KeyRecord[];
  if (since) {
    // 差異查詢：只回傳 since 之後更新的
    keys = db.getL0KeysUpdatedSince(since);
    if (keys.length === 0) {
      return null;  // 304 Not Modified
    }
  } else {
    keys = db.getAllActiveL0Keys();
  }

  // 步驟 3：準備加密下發包
  const downloadKeys = keys.map(k => l0MasterKey.prepareForDownload(k));

  // 步驟 4：計算每台裝置的每日限額
  const deviceLimits = getDeviceLimits(deviceId);

  const response: L0KeysResponse = {
    schema_version: 1,
    keys: downloadKeys,
    l0_encryption_key: l0MasterKey.getDownloadKey(),  // 龍蝦用這把解密
    device_daily_limits: deviceLimits,
    cache_ttl: 21600,  // 建議 6 小時快取
    server_time: new Date().toISOString()
  };

  // 步驟 5：更新快取
  l0Cache.set(cacheKey, { data: response, timestamp: Date.now() });

  return response;
}
```

### 3.3 額度分配演算法

```typescript
// 分配每個龍蝦的每日 L0 額度
function calculateDeviceDailyLimit(
  serviceId: string,
  totalActiveDevices: number
): number {
  const l0Key = db.getL0KeyByService(serviceId);
  if (!l0Key || !l0Key.daily_quota) return Infinity;

  // 基本公式：全體每日總額度 / 活躍裝置數 × 公平係數
  const fairShare = Math.floor(l0Key.daily_quota / totalActiveDevices);

  // 最低 5 次 / 天，最高 100 次 / 天
  return Math.max(5, Math.min(100, fairShare));

  // 範例：
  // Groq 公共 Key 每日限額 10000 次
  // 活躍龍蝦 200 隻
  // → 每隻 50 次/天
  //
  // 活躍龍蝦 5000 隻
  // → 每隻 5 次/天（最低保障）
}

// 每日額度重置（按龍蝦的時區，#83）
function getResetTime(deviceId: string): string {
  const device = db.getDevice(deviceId);
  const tz = device.timezone || 'UTC';
  // 計算該時區的下一個午夜
  return nextMidnight(tz).toISOString();
}
```

### 3.4 健康監控

```typescript
// 每 5 分鐘檢查 L0 公共 Key 健康度
async function checkL0KeyHealth(): Promise<void> {
  const keys = db.getAllActiveL0Keys();

  for (const key of keys) {
    // 跳過不需要 Key 的服務（DuckDuckGo、Ollama）
    if (!key.key_value_encrypted) continue;

    try {
      // 打一次輕量請求驗證 Key 是否還活著
      const result = await testKey(key);

      if (result.status === 'dead') {
        // Key 死了
        db.updateL0KeyStatus(key.id, 'dead');
        await alertManager.sendTkmanAlert({
          severity: 'critical',
          message: `🚨 L0 公共 Key 死亡: ${key.service_id} (${key.id})`,
          suggestion: '需要替換新的公共 Key'
        });
      } else if (result.status === 'rate_limited') {
        // Key 被限速
        db.updateL0KeyStatus(key.id, 'degraded');
      } else {
        db.updateL0KeyStatus(key.id, 'active');
      }

      db.updateL0KeyLastHealthCheck(key.id);
    } catch (err) {
      console.error(`L0 健康檢查失敗: ${key.id}`, err);
    }
  }

  // 檢查額度警戒線
  for (const key of keys) {
    if (key.daily_quota && key.daily_used > key.daily_quota * 0.8) {
      await alertManager.sendTkmanAlert({
        severity: 'warning',
        message: `⚠️ L0 ${key.service_id} 額度已用 ${Math.round(key.daily_used / key.daily_quota * 100)}%`,
        suggestion: '考慮增加公共 Key 或降低每人限額'
      });
    }
  }
}
```

### 3.5 捐贈 Key 處理流程

> **安全說明（L0 捐贈）** <!-- v1.4 修訂：B 類安全標注 -->
>
> - **傳輸加密**：所有捐贈 Key 透過 ECIES（ECDH P-256 + AES-256-GCM）加密傳輸，VPS 用一次性共享金鑰解密
> - **靜態加密**：解密後的 Key 立即用 L0 Master Key（AES-256-GCM）重新加密存入 DB，明文只在記憶體中短暫存在
> - **驗證保護**：接受前先打一次輕量請求驗證 Key 有效性，無效 Key 不入庫
> - **去重保護**：對 Key 做 hash 比對，防止同一 Key 重複捐贈
> - **Rate Limit**：每個 device_id 每天最多捐贈 5 次（見 11.3 Rate Limit 表）
> - **日誌規範**：日誌中 Key 值一律遮罩處理（見 16.3），只記錄 service_id 和 device_id

```typescript
// POST /v1/l0/donate 的完整處理邏輯 <!-- v1.2 修訂：加密方式改為 ECIES（ECDH P-256 + AES-256-GCM），不是 RSA -->
//
// 龍蝦端加密流程：
//   1. 龍蝦產生臨時 ECDH P-256 金鑰對（ephemeral key pair）
//   2. ECDH(ephemeral_private, vps_public) → shared_secret
//   3. HKDF-SHA256(ikm=shared_secret, salt=UTF-8("clawapi-l0-donate"), info=UTF-8("clawapi-l0-v1"), length=32) → AES-256 key  <!-- v1.4 修訂：精確 HKDF 參數 -->
//   4. AES-256-GCM 加密 API Key → encrypted_key + iv + tag
//   5. POST { encrypted_key, ephemeral_public_key, iv, tag }
//
// VPS 端解密流程：
//   1. ECDH(vps_private, ephemeral_public) → shared_secret
//   2. HKDF-SHA256(ikm=shared_secret, salt=UTF-8("clawapi-l0-donate"), info=UTF-8("clawapi-l0-v1"), length=32) → AES-256 key  <!-- v1.4 修訂 -->
//   3. AES-256-GCM 解密 → plain API Key

interface DonateKeyRequest {
  service_id: string;
  encrypted_key: string;           // base64，AES-256-GCM 加密的 API Key
  ephemeral_public_key: string;    // base64，龍蝦的臨時 ECDH 公鑰
  iv: string;                      // base64，AES-GCM 初始化向量
  tag: string;                     // base64，AES-GCM 認證標籤
  display_name?: string;
  anonymous?: boolean;
}

async function handleDonation(
  deviceId: string,
  body: DonateKeyRequest
): Promise<DonateKeyResponse> {
  // 步驟 1：用 ECIES 解密捐贈的 Key（ECDH + AES-256-GCM）
  const sharedSecret = await ecdhManager.deriveSharedSecret(body.ephemeral_public_key);
  // HKDF-SHA256(ikm=sharedSecret, salt="clawapi-l0-donate", info="clawapi-l0-v1", length=32) <!-- v1.4 修訂 -->
  const aesKey = await deriveAESKey(sharedSecret, 'clawapi-l0-donate', 'clawapi-l0-v1');
  const plainKey = await aesGcmDecrypt({
    ciphertext: Buffer.from(body.encrypted_key, 'base64'),
    iv: Buffer.from(body.iv, 'base64'),
    tag: Buffer.from(body.tag, 'base64'),
    key: aesKey
  });

  // 步驟 2：驗證 Key 有效性（打一次輕量請求）
  const validation = await validateApiKey(body.service_id, plainKey);
  if (!validation.valid) {
    return {
      accepted: false,
      error: 'L0_DONATE_INVALID_KEY',
      message: '捐贈的 Key 無效或已封'
    };
  }

  // 步驟 3：檢查是否已經有相同的 Key（去重）
  const existing = db.findL0KeyByHash(hashKey(plainKey));
  if (existing) {
    return {
      accepted: false,
      error: 'L0_DONATE_DUPLICATE',
      message: '此 Key 已在公共池中'
    };
  }

  // 步驟 4：用 L0 Master Key 加密後存入 DB
  const encrypted = l0MasterKey.encryptL0Key(plainKey);

  const newKey: L0KeyRecord = {
    id: `l0k_${generateId()}`,
    service_id: body.service_id,
    key_value_encrypted: encrypted.encrypted,
    encryption_key_id: encrypted.keyId,
    status: 'active',
    daily_quota: validation.estimatedDailyQuota,
    daily_used: 0,
    donated_by_device_id: deviceId,
    donated_by_display: body.display_name || null,
    is_anonymous_donation: body.anonymous ?? false,
    last_health_check: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.insertL0Key(newKey);

  // 步驟 5：通知所有龍蝦 L0 Key 有更新
  await wsManager.broadcastNotification({
    kind: 'l0_keys_updated',
    message: 'L0 公共 Key 已更新',
    action: 'refresh_l0_keys'
  });

  // 步驟 6：記錄感謝
  console.log(`[L0] 收到捐贈: ${body.service_id} from ${deviceId}`);

  return {
    accepted: true,
    l0_key_id: newKey.id,
    message: '感謝你的捐贈 🦞',
    validation: {
      key_valid: true,
      service_confirmed: body.service_id,
      estimated_daily_quota: validation.estimatedDailyQuota
    }
  };
}
```

---

## 4. 互助配對引擎

> 核心演算法：匿名配對 + ECDH 加密中繼 + 防刷單。

### 4.1 非同步配對流程

```
<!-- v1.3 修訂：aid_request → aid_matched 雙推送，與 SPEC-C / SPEC-A 統一 -->
龍蝦 B（求助者）           VPS                   龍蝦 A（幫助者）
     │                      │                        │
     │── POST /aid/request ─→│                        │
     │                      │ ① 接收+驗證             │
     │                      │ ② 找幫助者              │
     │←── 202 {matching} ───│                        │
     │                      │                        │
     │                      │ ③ 配對成功，雙推送        │
     │←─ WS: aid_matched ──│── WS: aid_matched ───→│
     │   (含 helper_pk)      │   (含 requester_pk)     │
     │                      │                        │
     │                      │                        │ ④ A 用雙公鑰 ECDH
     │                      │                        │ ⑤ 執行API呼叫
     │                      │                        │ ⑥ 加密回應
     │                      │←── WS: aid_response ──│
     │                      │                        │
     │←── WS: aid_result ──│ ⑦ 原封轉發（不碰密文）    │
     │                      │                        │
     │ ⑧ B 用雙公鑰解密     │ ⑨ 記錄互助              │
```

### 4.2 配對演算法

```typescript
// POST /v1/aid/request 的核心配對邏輯
async function matchHelper(
  request: AidRequest,
  requesterId: string
): Promise<MatchResult> {
  const serviceId = request.service_id;

  // 步驟 1：取得所有符合條件的幫助者
  const candidates = db.getAidHelperCandidates({
    service_id: serviceId,
    excludeDeviceId: requesterId,   // 不能自己幫自己
    filters: {
      enabled: true,                       // 互助開啟
      serviceAllowed: serviceId,           // 該服務有開放
      dailyLimitNotReached: true,          // 今日額度還有
      isOnline: true,                      // WebSocket 連線中
      notInBlackoutHours: true,            // 不在黑名單時段
      notSuspended: true,                  // 未被暫停
    }
  });

  if (candidates.length === 0) {
    return { status: 'no_helper', helpers: [] };
  }

  // 步驟 2：排序候選人（多因子排序）
  const scored = candidates.map(c => ({
    ...c,
    score: calculateHelperScore(c, serviceId)
  }));
  scored.sort((a, b) => b.score - a.score);

  // 步驟 3：選擇最佳幫助者
  // 只選 top 1（不做廣播，避免浪費多人的額度）
  const bestHelper = scored[0];

  return {
    status: 'matched',
    helpers: [bestHelper]
  };
}

// 幫助者評分
function calculateHelperScore(
  helper: AidHelperCandidate,
  serviceId: string
): number {
  let score = 0;

  // 因子 1：剩餘額度（越多越好）
  const remaining = helper.daily_limit - helper.daily_given;
  score += Math.min(remaining / 10, 5);  // 最多 +5 分

  // 因子 2：歷史互助成功率
  const successRate = helper.aid_success_rate || 0.5;
  score += successRate * 3;  // 最多 +3 分

  // 因子 3：平均回應延遲（越快越好）
  const avgLatency = helper.avg_aid_latency_ms || 10000;
  score += Math.max(0, 3 - avgLatency / 5000);  // 最多 +3 分

  // 因子 4：信譽分數
  score += helper.reputation_weight;  // 0.1 ~ 2.0

  return score;
}
```

### 4.3 ECDH P-256 金鑰管理 <!-- v1.1 修訂 O-02 -->

> **注意**：VPS 的 ECDH 金鑰對**不再用於互助中繼**。互助改為龍蝦之間直接做 ECDH（雙公鑰方案）。
> VPS 金鑰對仍保留用於：裝置認證、Sub-Key 驗證、L0 Key 下發加密等其他用途。

```typescript
// VPS 的 ECDH 金鑰對管理
// 用途：裝置認證、Sub-Key 驗證、L0 Key 加密（不再用於互助中繼）
interface ECDHKeyManager {
  // 啟動時載入或產生金鑰對
  initialize(): Promise<void>;

  // 取得當前 VPS 公鑰（下發給龍蝦）
  getPublicKey(): { key: string; id: string };

  // 用 VPS 私鑰 + 對方公鑰做 ECDH 交換
  deriveSharedSecret(peerPublicKey: string): Buffer;

  // 解密 payload_key（龍蝦用 VPS 公鑰加密的對稱金鑰）
  // 用途：L0 Key 捐贈解密、Sub-Key 驗證等（不再用於互助）
  decryptPayloadKey(
    encryptedKey: string,
    senderPublicKey: string
  ): Buffer;

  // 重新加密 payload_key（改用接收者的公鑰）
  // 用途：L0 Key 下發等（不再用於互助）
  reEncryptPayloadKey(
    payloadKey: Buffer,
    recipientPublicKey: string
  ): string;

  // 金鑰輪換（每 30 天）
  rotateKeys(): Promise<void>;
}

// 實作
class VPSECDHKeyManager implements ECDHKeyManager {
  private currentKeyPair: { privateKey: Buffer; publicKey: Buffer };
  private currentKeyId: string;
  private previousKeyPair: { privateKey: Buffer; publicKey: Buffer } | null;
  private previousKeyId: string | null;

  async initialize(): Promise<void> {
    const keyPath = process.env.ECDH_KEY_PATH || '/keys/ecdh';

    // 嘗試載入現有金鑰
    try {
      const stored = await Bun.file(`${keyPath}/current.json`).json();
      this.currentKeyPair = {
        privateKey: Buffer.from(stored.privateKey, 'base64'),
        publicKey: Buffer.from(stored.publicKey, 'base64')
      };
      this.currentKeyId = stored.keyId;
      console.log(`[ECDH] 載入金鑰: ${this.currentKeyId}`);
    } catch {
      // 首次啟動，產生新金鑰
      await this.generateNewKeyPair();
    }

    // 載入舊金鑰（如果有，保留 7 天以完成進行中的互助）
    try {
      const prev = await Bun.file(`${keyPath}/previous.json`).json();
      this.previousKeyPair = {
        privateKey: Buffer.from(prev.privateKey, 'base64'),
        publicKey: Buffer.from(prev.publicKey, 'base64')
      };
      this.previousKeyId = prev.keyId;
    } catch {
      this.previousKeyPair = null;
      this.previousKeyId = null;
    }
  }

  private async generateNewKeyPair(): Promise<void> {
    // 使用 Web Crypto API（Bun 原生支持）
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,  // extractable
      ['deriveKey', 'deriveBits']
    );

    const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);

    this.currentKeyPair = {
      privateKey: Buffer.from(privateKeyRaw),
      publicKey: Buffer.from(publicKeyRaw)
    };
    this.currentKeyId = `vps_key_v${Date.now()}`;

    // 持久化到檔案
    const keyPath = process.env.ECDH_KEY_PATH || '/keys/ecdh';
    await Bun.write(`${keyPath}/current.json`, JSON.stringify({
      privateKey: this.currentKeyPair.privateKey.toString('base64'),
      publicKey: this.currentKeyPair.publicKey.toString('base64'),
      keyId: this.currentKeyId,
      createdAt: new Date().toISOString()
    }));

    console.log(`[ECDH] 產生新金鑰: ${this.currentKeyId}`);
  }

  getPublicKey(): { key: string; id: string } {
    return {
      key: this.currentKeyPair.publicKey.toString('base64'),
      id: this.currentKeyId
    };
  }

  // ECDH 共享密鑰推導
  async deriveSharedSecret(peerPublicKeyB64: string): Promise<Buffer> {
    const peerPublicKey = await crypto.subtle.importKey(
      'raw',
      Buffer.from(peerPublicKeyB64, 'base64'),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      this.currentKeyPair.privateKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    );

    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPublicKey },
      privateKey,
      256
    );

    return Buffer.from(sharedBits);
  }

  // 解密 payload_key
  async decryptPayloadKey(
    encryptedKeyB64: string,
    senderPublicKeyB64: string
  ): Promise<Buffer> {
    const sharedSecret = await this.deriveSharedSecret(senderPublicKeyB64);
    // HKDF-SHA256(ikm=sharedSecret, salt=context-specific, info=context-specific, length=32) <!-- v1.4 修訂 -->
    const aesKey = await deriveAESKey(sharedSecret, salt, info);
    // AES-256-GCM 解密
    return aesGcmDecrypt(Buffer.from(encryptedKeyB64, 'base64'), aesKey);
  }

  // 重新加密 payload_key（給另一個龍蝦）
  async reEncryptPayloadKey(
    payloadKey: Buffer,
    recipientPublicKeyB64: string
  ): Promise<string> {
    const sharedSecret = await this.deriveSharedSecret(recipientPublicKeyB64);
    const aesKey = await deriveAESKey(sharedSecret, salt, info);  // <!-- v1.4 修訂 -->
    const encrypted = aesGcmEncrypt(payloadKey, aesKey);
    return encrypted.toString('base64');
  }

  // 每 30 天金鑰輪換
  async rotateKeys(): Promise<void> {
    const keyPath = process.env.ECDH_KEY_PATH || '/keys/ecdh';

    // 舊的 current → previous
    await Bun.write(`${keyPath}/previous.json`,
      await Bun.file(`${keyPath}/current.json`).text()
    );
    this.previousKeyPair = this.currentKeyPair;
    this.previousKeyId = this.currentKeyId;

    // 產生新的 current
    await this.generateNewKeyPair();

    console.log(`[ECDH] 金鑰輪換完成: ${this.previousKeyId} → ${this.currentKeyId}`);

    // 7 天後刪除 previous（排程）
    setTimeout(async () => {
      try {
        const fs = await import('fs');
        fs.unlinkSync(`${keyPath}/previous.json`);
        this.previousKeyPair = null;
        this.previousKeyId = null;
        console.log('[ECDH] 已刪除舊金鑰');
      } catch { /* 忽略 */ }
    }, 7 * 24 * 60 * 60 * 1000);
  }
}

// HKDF-SHA256 金鑰導出（統一實作） <!-- v1.4 修訂：與 SPEC-C §4.5 對齊 -->
// 所有用途共用此函式，透過 salt/info 區分上下文：
//   互助加密：salt=UTF-8(aid_id), info=UTF-8("clawapi-aid-v1")
//   L0 捐贈：salt=UTF-8("clawapi-l0-donate"), info=UTF-8("clawapi-l0-v1")
//   Sub-Key 驗證：salt=UTF-8("clawapi-subkey"), info=UTF-8("clawapi-subkey-v1")
async function deriveAESKey(
  sharedSecret: Buffer,
  salt: string,
  info: string
): Promise<Buffer> {
  const key = await crypto.subtle.importKey(
    'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      info: new TextEncoder().encode(info),
    },
    key,
    256  // length=32 bytes
  );
  return Buffer.from(derived);
}
```

### 4.4 VPS 中繼流程（雙公鑰方案） <!-- v1.1 修訂 O-02 -->

> **重要變更**：互助加密改為龍蝦之間直接用 ECDH 雙公鑰協商，VPS 不再參與密鑰交換。
> VPS 只負責配對和轉發，完全不碰加密 payload 和對稱金鑰。

```
<!-- v1.4 修訂：加入 aid_data 雙向轉發步驟，與 SPEC-C aid_data 訊息類型統一 -->
VPS 端互助中繼流程（雙公鑰 + 雙推送 + aid_data 轉發方案）：
1. 收到 POST /v1/aid/request（含求助者 B 的 ECDH 公鑰）
2. 回 202 + request_id
3. 配對幫助者 A（選擇邏輯不變）
4. 配對成功後，同時推送 aid_matched 給雙方：
   - 給幫助者 A：包含 requester_public_key（B 的公鑰）+ service_id + request_type
   - 給求助者 B：包含 helper_public_key（A 的公鑰）+ aid_id
   - 雙方各自用對方公鑰 + 自己私鑰做 ECDH 協商對稱金鑰
     HKDF-SHA256(ikm=shared_secret, salt=UTF-8(aid_id), info=UTF-8("clawapi-aid-v1"), length=32)
   - （不含任何密文，VPS 此時沒有任何敏感資料）
5. B 發送 aid_data（kind='encrypted_request'）→ VPS 原封轉發給 A  <!-- v1.4 新增 -->
   - VPS 只檢查 aid_id 有效性和 payload 大小（≤1MB），不解密
6. A 發送 aid_data（kind='encrypted_response'）→ VPS 原封轉發給 B  <!-- v1.4 新增 -->
   - VPS 原封轉發後，更新 aid_record 狀態為 completed
7. （向下相容）A 也可用舊的 aid_response 流程，VPS 轉發 aid_result 給 B

移除原有的 VPS ECDH 金鑰對管理於互助用途（不再需要）
但保留 VPS 金鑰對用於裝置認證和 Sub-Key 驗證等其他用途
```

```typescript
// 互助中繼完整流程（雙公鑰 + 雙推送方案） <!-- v1.3 修訂：aid_request → aid_matched 雙推送 -->
async function relayAidRequest(
  aidId: string,
  request: AidRequest,
  requesterId: string,
  helper: AidHelperCandidate
): Promise<void> {
  const startTime = Date.now();

  // 注意：VPS 不再做任何 ECDH 解密/重新加密
  // VPS 只是純粹的配對器 + 信差

  // 步驟 1：檢查幫助者是否在線
  const helperConn = wsManager.getConnection(helper.device_id);
  if (!helperConn) {
    // 幫助者剛好斷線
    await handleAidTimeout(aidId, requesterId, '幫助者離線');
    return;
  }

  // 步驟 2：配對成功，同時推送 aid_matched 給雙方
  const serverTime = new Date().toISOString();

  // 推送給幫助者 A（包含求助者 B 的公鑰）
  helperConn.send(JSON.stringify({
    type: 'notification',
    channel: 'notifications',
    id: `aid_matched_${aidId}`,
    payload: {
      kind: 'aid_matched',
      aid_id: aidId,
      role: 'helper',
      service_id: request.service_id,
      request_type: request.request_type,
      requester_public_key: request.requester_public_key,  // B 的公鑰，讓 A 做 ECDH
      timeout_ms: 30000,
      action: 'process_aid_matched'
    },
    server_time: serverTime
  }));

  // 推送給求助者 B（包含幫助者 A 的公鑰）
  const requesterConn = wsManager.getConnection(requesterId);
  if (requesterConn) {
    requesterConn.send(JSON.stringify({
      type: 'notification',
      channel: 'notifications',
      id: `aid_matched_${aidId}`,
      payload: {
        kind: 'aid_matched',
        aid_id: aidId,
        role: 'requester',
        helper_public_key: helper.public_key,  // A 的公鑰，讓 B 做 ECDH
        timeout_ms: 30000,
        action: 'process_aid_matched'
      },
      server_time: serverTime
    }));
  }

  // 步驟 3：更新配對狀態
  db.updateAidRecord(aidId, {
    status: 'matched',
    helper_device_id: helper.device_id,
    matched_at: serverTime
  });

  // 步驟 4：設定 30 秒超時計時器
  const timeout = setTimeout(async () => {
    const aidRecord = db.getAidRecord(aidId);
    if (aidRecord && aidRecord.status === 'matched') {
      await handleAidTimeout(aidId, requesterId, '幫助者未在 30 秒內回應');
    }
  }, 30000);

  // 儲存超時計時器 ID
  aidTimeouts.set(aidId, timeout);
}

// 處理幫助者的回應（雙公鑰方案）
async function handleAidResponse(
  response: AidResponsePayload
): Promise<void> {
  const aidId = response.aid_id;

  // 清除超時計時器
  const timeout = aidTimeouts.get(aidId);
  if (timeout) {
    clearTimeout(timeout);
    aidTimeouts.delete(aidId);
  }

  const aidRecord = db.getAidRecord(aidId);
  if (!aidRecord) return;  // 已超時或不存在

  if (response.status === 'fulfilled') {
    // VPS 原封不動轉發 — 不做任何解密或重新加密
    const requesterConn = wsManager.getConnection(aidRecord.requester_device_id);
    if (requesterConn) {
      requesterConn.send(JSON.stringify({
        type: 'notification',
        channel: 'notifications',
        id: `aid_result_${aidId}`,
        payload: {
          kind: 'aid_result',
          aid_id: aidId,
          status: 'fulfilled',
          helper_public_key: response.helper_public_key,  // A 的公鑰（B 用來做 ECDH）
          response_encrypted: response.response_encrypted,  // 原封轉發
          encryption_method: 'aes-256-gcm',
          aid_record: {
            service_id: aidRecord.service_id,
            latency_ms: response.latency_ms,
            helper_device_id: null  // 永遠匿名
          },
          action: 'process_aid_result'
        },
        server_time: new Date().toISOString()
      }));
    }

    // 更新互助記錄
    db.updateAidRecord(aidId, {
      status: 'fulfilled',
      latency_ms: response.latency_ms,
      completed_at: new Date().toISOString()
    });

    // 更新雙方統計
    db.incrementAidGiven(aidRecord.helper_device_id, aidRecord.service_id);
    db.incrementAidReceived(aidRecord.requester_device_id, aidRecord.service_id);
  } else {
    // 幫助者拒絕或出錯
    await handleAidTimeout(
      aidId,
      aidRecord.requester_device_id,
      `幫助者回應: ${response.status}`
    );
  }
}

// 互助超時處理
async function handleAidTimeout(
  aidId: string,
  requesterId: string,
  reason: string
): Promise<void> {
  db.updateAidRecord(aidId, {
    status: 'timeout',
    completed_at: new Date().toISOString(),
    timeout_reason: reason
  });

  const requesterConn = wsManager.getConnection(requesterId);
  if (requesterConn) {
    requesterConn.send(JSON.stringify({
      type: 'notification',
      channel: 'notifications',
      id: `aid_result_${aidId}`,
      payload: {
        kind: 'aid_result',
        aid_id: aidId,
        status: 'timeout',
        message: '沒有龍蝦回應互助請求',
        suggestion: '可以稍後再試，或加自己的 Key',
        action: 'display_aid_timeout'
      },
      server_time: new Date().toISOString()
    }));
  }
}

// 互助加密數據轉發（VPS 只做原封轉發，不解密） <!-- v1.4 修訂 -->
async function handleAidData(
  senderDeviceId: string,
  payload: { aid_id: string; kind: 'encrypted_request' | 'encrypted_response'; [key: string]: unknown }
): Promise<void> {
  const { aid_id, kind } = payload;
  const aidRecord = db.getAidRecord(aid_id);
  if (!aidRecord) {
    wsManager.sendError(senderDeviceId, 'AID_NOT_FOUND');
    return;
  }

  // payload 大小檢查（上限 1MB）
  const payloadSize = JSON.stringify(payload).length;
  if (payloadSize > 1_048_576) {
    wsManager.sendError(senderDeviceId, 'AID_PAYLOAD_TOO_LARGE');
    return;
  }

  if (kind === 'encrypted_request') {
    // B（求助者）→ A（幫助者）
    const helperWs = wsManager.getConnection(aidRecord.helper_device_id);
    if (!helperWs) {
      // 幫助者離線，互助超時處理
      wsManager.sendError(senderDeviceId, 'AID_HELPER_OFFLINE');
      return;
    }
    wsManager.send(helperWs, payload);  // 原封轉發，VPS 不解密
  } else if (kind === 'encrypted_response') {
    // A（幫助者）→ B（求助者）
    const requesterWs = wsManager.getConnection(aidRecord.requester_device_id);
    if (!requesterWs) {
      wsManager.sendError(senderDeviceId, 'AID_REQUESTER_OFFLINE');
      return;
    }
    wsManager.send(requesterWs, payload);  // 原封轉發，VPS 不解密

    // 互助完成，更新記錄
    db.updateAidRecord(aid_id, { status: 'completed', completed_at: new Date().toISOString() });
  }
}
```

### 4.5 防刷單機制（#B23）

```typescript
// 互助請求的多層防刷驗證
async function validateAidRequest(
  deviceId: string,
  request: AidRequest
): Promise<{ valid: boolean; error?: string }> {
  // 層 1：冷卻期檢查
  const lastAid = db.getLastAidRequest(deviceId, request.service_id);
  if (lastAid) {
    // 基礎冷卻期 60 秒
    const baseCooldown = 60 * 1000;
    // 連續請求加倍：60s → 120s → 240s → 480s（最大 5 分鐘）
    const consecutiveCount = db.getConsecutiveAidCount(deviceId, request.service_id);
    const cooldown = Math.min(
      baseCooldown * Math.pow(2, consecutiveCount),
      5 * 60 * 1000  // 最大 5 分鐘
    );

    const elapsed = Date.now() - new Date(lastAid.created_at).getTime();
    if (elapsed < cooldown) {
      return {
        valid: false,
        error: `AID_COOLDOWN: 還需等 ${Math.ceil((cooldown - elapsed) / 1000)} 秒`
      };
    }
  }

  // 層 2：每日上限（30 次/天）
  const todayCount = db.getDailyAidRequestCount(deviceId);
  if (todayCount >= 30) {
    return {
      valid: false,
      error: 'AID_DAILY_LIMIT_REACHED: 今天的互助請求已達上限 (30次)'
    };
  }

  // 層 3：集體智慧交叉驗證
  // 檢查該服務是否「真的有問題」
  const globalStats = db.getLatestServiceStats(request.service_id);
  if (globalStats && globalStats.successRate > 0.95) {
    // 全體成功率 > 95%，但這隻龍蝦說自己全掛了？
    // 可能是他自己的 Key 有問題，不是服務問題
    // → 不阻止，但記錄為可疑（降低信譽）
    db.recordSuspiciousAid(deviceId, request.service_id, {
      reason: 'service_healthy_but_user_claims_failure',
      global_success_rate: globalStats.successRate
    });
  }

  // 層 4：公鑰格式驗證 <!-- v1.3 修訂：payload_encrypted 已移除，改為驗證公鑰 -->
  if (!request.requester_public_key ||
      typeof request.requester_public_key !== 'string' ||
      request.requester_public_key.length > 256) {
    return {
      valid: false,
      error: 'AID_INVALID_PUBLIC_KEY: requester_public_key 格式不正確或超過長度限制'
    };
  }

  return { valid: true };
}
```

#### 進階防白嫖驗證 <!-- v1.1 修訂 Y-10 -->

> 在基礎防刷之上，增加更嚴格的互助請求驗證，防止「只借不還」的白嫖行為。

```typescript
// 互助請求驗證（防白嫖） <!-- v1.2 修訂：interface 不能有函式體和值賦值，改為常數 + 獨立函式 -->

// 防白嫖設定常數
const AID_VALIDATOR_CONFIG = {
  // 基礎門檻
  minAccountAge: 7 * 24 * 60 * 60 * 1000,  // 註冊 7 天以上
  minTelemetryReports: 24,                    // 至少上報過 24 次（≈ 1 天正常使用）

  // 每日限額（比基礎防刷更嚴格）
  maxDailyRequests: 10,         // 每日最多請求 10 次互助
  maxDailyReceived: 5,          // 每日最多「接受」5 次互助
} as const;

// 交叉驗證：檢查龍蝦是否真的需要互助
async function validateAidNeed(deviceId: string): Promise<boolean> {
  // 1. 檢查該龍蝦最近 1 小時的遙測：是否真的有大量失敗？
  const recentTelemetry = await getRecentTelemetry(deviceId, 1);
  const failRate = recentTelemetry.failCount / recentTelemetry.totalCount;
  if (failRate < 0.5) return false;  // 失敗率 < 50% 不算真的需要互助

  // 2. 交叉驗證：集體智慧是否顯示該服務確實有問題？
  const collectiveData = await getCollectiveStatus(recentTelemetry.provider);
  if (collectiveData.globalSuccessRate > 0.9) {
    // 全球成功率 > 90% 但這隻龍蝦說全掛 → 可疑
    await flagSuspicious(deviceId, 'aid_abuse_suspected');
    return false;
  }

  return true;
}

// 信譽機制
// 「只借不還」：接受互助次數 / 提供互助次數 > 5 → 降低優先級
// 「互惠龍蝦」：有提供互助的龍蝦優先獲得互助
```

```typescript
// 帳號資格驗證（在 validateAidRequest 之前呼叫）
async function checkAidEligibility(
  deviceId: string
): Promise<{ eligible: boolean; reason?: string }> {
  const device = db.getDevice(deviceId);
  const now = Date.now();

  // 門檻 1：帳號年齡 ≥ 7 天
  const accountAge = now - new Date(device.created_at).getTime();
  if (accountAge < 7 * 24 * 60 * 60 * 1000) {
    return {
      eligible: false,
      reason: 'AID_ACCOUNT_TOO_NEW: 帳號需註冊滿 7 天才能使用互助'
    };
  }

  // 門檻 2：至少上報過 24 次遙測
  const reportCount = db.getTelemetryBatchCount(deviceId);
  if (reportCount < 24) {
    return {
      eligible: false,
      reason: 'AID_INSUFFICIENT_TELEMETRY: 需先正常使用一段時間（至少 24 次遙測上報）'
    };
  }

  // 門檻 3：每日請求上限 10 次（比基礎防刷的 30 次更嚴格）
  const dailyRequests = db.getDailyAidRequestCount(deviceId);
  if (dailyRequests >= 10) {
    return {
      eligible: false,
      reason: 'AID_DAILY_REQUEST_LIMIT: 今天的互助請求已達上限（10 次）'
    };
  }

  // 門檻 4：每日「接受」互助上限 5 次
  const dailyReceived = db.getDailyAidReceivedCount(deviceId);
  if (dailyReceived >= 5) {
    return {
      eligible: false,
      reason: 'AID_DAILY_RECEIVED_LIMIT: 今天已接受 5 次互助，建議加自己的 Key'
    };
  }

  // 門檻 5：互惠比率檢查
  const aidStats = db.getAidStats(deviceId);
  const receivedTotal = aidStats.received || 0;
  const givenTotal = aidStats.given || 0;
  // 接受超過 10 次且比率 > 5 → 降低優先級（不阻止，但配對時排後面）
  if (receivedTotal > 10 && givenTotal > 0 && receivedTotal / givenTotal > 5) {
    db.setAidPriorityLow(deviceId);  // 標記低優先級
  }

  return { eligible: true };
}
```

### 4.6 匿名保護

```typescript
// 確保互助過程中雙方匿名（#163）
// VPS 在所有推送中移除身份資訊

// 推送給求助者的結果 → helper_device_id 永遠是 null
// 推送給幫助者的請求 → 不包含 requester_device_id
// 互助記錄表 → helper 和 requester 分開存，不關聯
// WebSocket 訊息 → 不包含任何可推斷身份的資訊

// VPS 內部記錄（只有 tkman 能看）：
// aid_records 表存完整映射，但不對外暴露
// 用途：防濫用分析 + 如果出事可以追溯
```

### 4.7 負載控制

```typescript
// 互助請求限流
const AID_RATE_LIMITS = {
  // 全域限制
  global: {
    maxConcurrent: 100,        // 同時處理最多 100 個互助
    maxPerMinute: 200,         // 每分鐘最多 200 個請求
  },
  // 單一龍蝦限制
  perDevice: {
    maxPerHour: 30,            // 每小時最多 30 次
    maxPerDay: 30,             // 每天最多 30 次（與上面一致）
    cooldownMs: 60000,         // 冷卻期 60 秒
  }
};

// 當前並行互助計數
let currentAidCount = 0;

function canAcceptAidRequest(): boolean {
  return currentAidCount < AID_RATE_LIMITS.global.maxConcurrent;
}
```

---

## 5. 雲端備份服務（v1.1+）

> MVP 不做，但先規劃好架構。

### 5.1 儲存架構

```typescript
interface BackupStorageConfig {
  // 初期用本機檔案系統
  type: 'local' | 's3';

  // 本機模式
  local?: {
    path: '/data/backups';     // Docker volume
    maxTotalSize: '10GB';      // 全部備份檔的上限
  };

  // S3 模式（規模大了再切換）
  s3?: {
    bucket: 'clawapi-backups';
    region: 'ap-northeast-1';
    prefix: 'v1/';
  };
}

// 備份檔存放路徑
// 本機：/data/backups/{google_user_id_hash}/backup.enc
// S3：s3://clawapi-backups/v1/{google_user_id_hash}/backup.enc

// 為什麼用 google_user_id_hash 而不是 device_id？
// → 跨裝置同步需要以 Google 帳號為基準
// → hash 是為了不存明文 Google ID
```

### 5.2 配額管理

```typescript
const BACKUP_QUOTAS = {
  maxSizePerUser: 50 * 1024 * 1024,   // 50MB / 每個帳號
  maxUploadsPerDay: 5,                  // 每天最多上傳 5 次
  maxDownloadsPerDay: 10,               // 每天最多下載 10 次
  maxDeletesPerDay: 3,                  // 每天最多刪除 3 次
  retentionDays: 365,                   // 保留 365 天（一年不動就刪）
};
```

### 5.3 Google 帳號綁定驗證

```typescript
// POST /v1/auth/google 的處理邏輯
async function handleGoogleAuth(
  deviceId: string,
  googleIdToken: string,
  nickname?: string
): Promise<GoogleAuthResponse> {
  // 步驟 1：驗證 Google ID Token
  const googleUser = await verifyGoogleIdToken(googleIdToken);
  if (!googleUser) {
    return { error: 'AUTH_GOOGLE_TOKEN_INVALID' };
  }

  // 步驟 2：檢查此 Google 帳號是否已綁定其他裝置
  const existing = db.getDeviceByGoogleId(googleUser.sub);
  if (existing && existing.device_id !== deviceId) {
    return { error: 'AUTH_GOOGLE_ALREADY_BOUND' };
  }

  // 步驟 3：綁定
  db.bindGoogleAccount(deviceId, {
    google_id_hash: hashSha256(googleUser.sub),
    google_email_masked: maskEmail(googleUser.email),
    nickname: nickname || googleUser.name,
    bound_at: new Date().toISOString()
  });

  return {
    bound: true,
    google_email: maskEmail(googleUser.email),
    nickname: nickname || googleUser.name,
    features_unlocked: ['backup', 'nickname', 'cross_device_sync']
  };
}

// Email 遮罩：user@gmail.com → use***@gmail.com
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const masked = local.substring(0, 3) + '***';
  return `${masked}@${domain}`;
}
```

---

## 6. 聊天室中繼

> WebSocket 多工設計，VPS 只做中繼不存歷史。

### 6.1 頻道管理

```typescript
interface ChatChannelManager {
  // 預設頻道（硬編碼）
  defaultChannels: ['general', 'help'];

  // 未來可動態新增
  // 按語言：'zh-TW', 'en', 'ja'
  // 按主題：'adapter-dev', 'api-status'
}

// 頻道狀態
interface ChannelState {
  name: string;
  subscribers: Set<string>;  // device_id 集合
  messageCount: number;       // 本次啟動以來的訊息數（不存 DB）
  lastMessageAt: string;
}

// 儲存在記憶體，不持久化
const channels = new Map<string, ChannelState>();

// 初始化預設頻道
function initChannels(): void {
  for (const name of ['general', 'help']) {
    channels.set(name, {
      name,
      subscribers: new Set(),
      messageCount: 0,
      lastMessageAt: new Date().toISOString()
    });
  }
}
```

### 6.2 訊息轉發邏輯

```typescript
// 處理客戶端發來的聊天訊息
async function handleChatMessage(
  deviceId: string,
  message: ClientChatMessage
): Promise<void> {
  const channelName = message.channel.replace('chat:', '');
  const channel = channels.get(channelName);
  if (!channel) return;  // 頻道不存在

  // 驗證 1：訊息長度 ≤ 500 字元
  if (message.payload.text.length > 500) {
    sendError(deviceId, 'WS_CHAT_MESSAGE_TOO_LONG');
    return;
  }

  // 驗證 2：發送頻率限制（每 5 秒最多 1 則）
  if (!chatRateLimiter.check(deviceId)) {
    sendError(deviceId, 'WS_CHAT_RATE_LIMITED');
    return;
  }

  // 驗證 3：簡單的內容過濾
  // MVP 不做複雜的內容審查，只過濾明顯的惡意內容
  if (containsMaliciousContent(message.payload.text)) {
    sendError(deviceId, 'WS_CHAT_CONTENT_REJECTED');
    return;
  }

  // 組裝伺服器端訊息
  const serverMessage: ServerMessage = {
    type: 'chat_message',
    channel: `chat:${channelName}`,
    id: message.id,
    payload: {
      text: message.payload.text,
      nickname: message.payload.nickname || '匿名龍蝦',
      sender_device_id: null,  // 匿名！不暴露 device_id
      reply_to: message.payload.reply_to
    },
    server_time: new Date().toISOString()
  };

  // 廣播給所有訂閱者
  for (const subscriberId of channel.subscribers) {
    const conn = wsManager.getConnection(subscriberId);
    if (conn) {
      conn.send(JSON.stringify(serverMessage));
    }
  }

  // 更新頻道狀態
  channel.messageCount++;
  channel.lastMessageAt = new Date().toISOString();
}
```

### 6.3 線上人數計算（#143）

```typescript
// 雙重判定：WebSocket 連線中 OR 15 分鐘內有活動
function getOnlineCount(): number {
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;

  let count = 0;
  for (const [deviceId, conn] of wsManager.connections) {
    // 條件 1：WebSocket 連線中
    if (conn.readyState === WebSocket.OPEN) {
      count++;
      continue;
    }
    // 條件 2：15 分鐘內有 HTTP 活動
    const lastActivity = db.getLastActivity(deviceId);
    if (lastActivity && now - new Date(lastActivity).getTime() < fifteenMinutes) {
      count++;
    }
  }

  return count;
}

// 系統訊息：有人加入/離開
function broadcastPresenceChange(
  channelName: string,
  type: 'join' | 'leave'
): void {
  const channel = channels.get(channelName);
  if (!channel) return;

  const systemMessage: ServerMessage = {
    type: 'chat_system',
    channel: `chat:${channelName}`,
    id: `sys_${generateId()}`,
    payload: {
      text: type === 'join'
        ? '有新龍蝦加入了聊天室 🦞'
        : '有龍蝦離開了聊天室',
      online_count: getOnlineCount()
    },
    server_time: new Date().toISOString()
  };

  for (const subscriberId of channel.subscribers) {
    const conn = wsManager.getConnection(subscriberId);
    if (conn) conn.send(JSON.stringify(systemMessage));
  }
}
```

### 6.4 防洗版

```typescript
// 聊天室 Rate Limiter
class ChatRateLimiter {
  private lastMessageTime = new Map<string, number>();
  private messageCountWindow = new Map<string, number[]>();

  // 每 5 秒最多 1 則
  check(deviceId: string): boolean {
    const now = Date.now();
    const last = this.lastMessageTime.get(deviceId) || 0;

    if (now - last < 5000) {
      return false;  // 太快
    }

    this.lastMessageTime.set(deviceId, now);

    // 額外：每分鐘最多 10 則（防自動化）
    const window = this.messageCountWindow.get(deviceId) || [];
    const filtered = window.filter(t => now - t < 60000);
    if (filtered.length >= 10) {
      return false;
    }
    filtered.push(now);
    this.messageCountWindow.set(deviceId, filtered);

    return true;
  }
}
```

---

## 7. Sub-Key VPS 驗證中繼（#129）

> VPS 透過 WebSocket 向發行者確認 Sub-Key 狀態。

### 7.1 驗證流程

```
第三方應用              VPS                   發行者（龍蝦）
     │                   │                        │
     │── POST subkeys/ ─→│                        │
     │   validate        │                        │
     │                   │ ① 查快取                │
     │                   │                        │
     │                   │ (快取命中 → 直接回)       │
     │←── 200 {valid} ──│                        │
     │                   │                        │
     │                   │ (快取未命中 ↓)            │
     │                   │── WS: subkey_validate ─→│
     │                   │                        │ ② 龍蝦查本機
     │                   │←── WS: subkey_result ──│
     │                   │                        │
     │                   │ ③ 快取結果 5 分鐘        │
     │←── 200 {valid} ──│                        │
```

### 7.2 處理邏輯

```typescript
// POST /v1/subkeys/validate 的處理邏輯
async function handleSubKeyValidation(
  body: SubKeyValidateRequest
): Promise<SubKeyValidateResponse> {
  const { sub_key, service_id } = body;

  // 步驟 1：查快取（5 分鐘有效）
  const cacheKey = `subkey_${hashSha256(sub_key)}_${service_id}`;
  const cached = subKeyCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    return cached.response;
  }

  // 步驟 2：從 Sub-Key 格式推斷發行者
  // Sub-Key 格式：sk_live_{device_id_hash}_{random}
  const issuerHash = extractIssuerHash(sub_key);
  const issuerDeviceId = db.getDeviceIdByHash(issuerHash);

  if (!issuerDeviceId) {
    return {
      error: 'SUBKEY_INVALID',
      message: '此 Sub-Key 無效或已被撤銷'
    };
  }

  // 步驟 3：檢查發行者是否在線
  const issuerConn = wsManager.getConnection(issuerDeviceId);
  if (!issuerConn) {
    return {
      error: 'SUBKEY_ISSUER_OFFLINE',
      message: 'Sub-Key 發行者目前離線，無法驗證',
      suggestion: '稍後再試'
    };
  }

  // 步驟 4：透過 WebSocket 問發行者
  const validationResult = await new Promise<SubKeyValidateResponse>(
    (resolve, reject) => {
      const requestId = `skv_${generateId()}`;

      // 設定 10 秒超時
      const timeout = setTimeout(() => {
        pendingValidations.delete(requestId);
        resolve({
          error: 'SUBKEY_ISSUER_OFFLINE',
          message: 'Sub-Key 發行者回應超時'
        });
      }, 10000);

      // 記錄待回應
      pendingValidations.set(requestId, { resolve, timeout });

      // 發送驗證請求給發行者
      issuerConn.send(JSON.stringify({
        type: 'notification',
        channel: 'notifications',
        id: requestId,
        payload: {
          kind: 'subkey_validate_request',
          sub_key_hash: hashSha256(sub_key),  // 不傳原文，傳 hash
          service_id,
          action: 'validate_subkey'
        },
        server_time: new Date().toISOString()
      }));
    }
  );

  // 步驟 5：快取結果（5 分鐘）
  subKeyCache.set(cacheKey, {
    response: validationResult,
    timestamp: Date.now()
  });

  return validationResult;
}
```

### 7.3 發行者離線時的處理

```typescript
// 發行者離線 → 直接回 503
// 不嘗試等待、不排隊
// 原因：Sub-Key 是本機功能，發行者離線就是無法驗證

// 快取策略緩解：
// - 成功的驗證結果快取 5 分鐘
// - 在快取期內即使發行者離線，已快取的 Sub-Key 仍然可用
// - 快取過期後才需要重新驗證
```

---

## 8. Claude Bot 八大功能 <!-- v1.1 修訂 O-04：六大 → 八大 -->

> 讓 tkman 幾乎不用管日常事務的自動管家。八大功能涵蓋 GitHub 管理、VPS 監控、安全掃描、FAQ、發版、異常告警、L0 額度告警、資源告警。

### 8.1 ① GitHub 管家

#### Issue 分診規則

```typescript
// Issue 自動分類演算法
function classifyIssue(issue: GitHubIssue): IssueClassification {
  const title = issue.title.toLowerCase();
  const body = (issue.body || '').toLowerCase();
  const combined = `${title} ${body}`;

  // 優先級判斷（按順序，第一個匹配就停）
  const rules: ClassificationRule[] = [
    {
      label: 'bug',
      keywords: ['bug', 'error', 'crash', 'fail', 'broken', 'not working',
                 '錯誤', '壞了', '失敗', '閃退', 'バグ', 'エラー'],
      priority: 'high',
      template: 'bug_template'
    },
    {
      label: 'security',
      keywords: ['security', 'vulnerability', 'xss', 'injection', 'leak',
                 '安全', '漏洞', '洩漏', 'セキュリティ'],
      priority: 'critical',
      template: 'security_template'
    },
    {
      label: 'adapter',
      keywords: ['adapter', 'yaml', 'plugin', '插件', 'アダプター',
                 'adapter-request'],
      priority: 'normal',
      template: 'adapter_template'
    },
    {
      label: 'feature',
      keywords: ['feature', 'request', 'enhancement', 'suggestion', 'add',
                 '功能', '建議', '新增', '機能追加', '提案'],
      priority: 'normal',
      template: 'feature_template'
    },
    {
      label: 'question',
      keywords: ['how', 'what', 'why', 'help', 'question', '?',
                 '怎麼', '如何', '為什麼', 'どうやって', 'なぜ'],
      priority: 'low',
      template: 'question_template'
    }
  ];

  for (const rule of rules) {
    if (rule.keywords.some(kw => combined.includes(kw))) {
      return {
        label: rule.label,
        priority: rule.priority,
        template: rule.template,
        confidence: 0.8
      };
    }
  }

  // 無法分類
  return {
    label: 'needs-triage',
    priority: 'normal',
    template: 'unknown_template',
    confidence: 0
  };
}
```

#### 自動回覆模板

```typescript
const ISSUE_REPLY_TEMPLATES = {
  bug_template: `
感謝回報 🦞

**排查步驟：**
1. 你用的 ClawAPI 版本是？（\`clawapi --version\`）
2. 用的作業系統是？（macOS / Linux / Windows）
3. 能貼一下錯誤訊息嗎？

**如果是 Key 相關問題：**
- 執行 \`clawapi keys health\` 看看 Key 狀態
- 執行 \`clawapi logs --last 10\` 看最近的日誌

我會盡快看這個問題。同時歡迎補充更多資訊！
`,

  question_template: `
你好 🦞

這是個好問題！讓我看看能不能幫到你：

**常見解答：**
- 📖 Quick Start: [文件連結]
- 🔑 Key 管理: [文件連結]
- 🤖 MCP 設定: [文件連結]

如果以上沒有解答你的問題，請補充更多細節，我會標記讓開發者來看。
`,

  feature_template: `
感謝建議 🦞

已記錄！我會加上 \`feature\` 標籤。

如果你有想法怎麼實作，歡迎提 PR！我們接受社群貢獻 ✅

相關文件：
- 貢獻指南: CONTRIBUTING.md
- Adapter 開發: docs/adapter-guide.md
`,

  adapter_template: `
收到 Adapter 相關問題 🦞

**如果是要求新增 Adapter：**
你可以自己寫一個！參考 [Adapter 開發指南](docs/adapter-guide.md)
寫好後提 PR，我會跑安全掃描 + 請維護者審核。

**如果是現有 Adapter 的 bug：**
請告訴我哪個 Adapter、什麼錯誤，我會排查。
`,

  security_template: `
⚠️ **安全問題已收到**

已標記為高優先級。請不要在 Issue 裡貼敏感資訊（Key、密碼等）。

如果是嚴重安全漏洞，建議：
📧 直接寄到 security@clawapi.com（尚未設定則通知 tkman）

我們會在 24 小時內回應。
`,

  unknown_template: `
收到你的問題 🦞

已標記等待分類。我會盡快看看這是什麼類型的問題。

如果你能補充以下資訊會更有幫助：
- ClawAPI 版本
- 作業系統
- 重現步驟
`
};
```

#### 48 小時無回應標記

```typescript
// 每 12 小時執行一次
async function checkStaleIssues(): Promise<void> {
  const issues = await github.listOpenIssues();
  const now = Date.now();

  for (const issue of issues) {
    // 如果已經有 'needs-human' 標籤，跳過
    if (issue.labels.includes('needs-human')) continue;

    // Bot 回覆後 48 小時無人回應
    const lastBotComment = await getLastBotComment(issue.number);
    if (lastBotComment) {
      const elapsed = now - new Date(lastBotComment.created_at).getTime();
      if (elapsed > 48 * 60 * 60 * 1000) {
        await github.addLabel(issue.number, 'needs-human');
        await github.addComment(issue.number,
          '⏰ 此 Issue 48 小時無回應，已標記需要人工處理。'
        );
      }
    }
  }
}
```

### 8.2 ② VPS 監控

```typescript
// 每 5 分鐘執行一次
async function vpsHealthCheck(): Promise<HealthReport> {
  const checks = await Promise.allSettled([
    // 1. 集體智慧引擎
    checkIntelligenceEngine(),
    // 2. WebSocket 服務
    checkWebSocketService(),
    // 3. L0 Key 服務
    checkL0Service(),
    // 4. 互助配對引擎
    checkAidEngine(),
    // 5. 聊天室中繼
    checkChatRelay(),
    // 6. DB 健康
    checkDatabase(),
    // 7. 磁碟空間
    checkDiskSpace(),
    // 8. 記憶體使用
    checkMemoryUsage()
  ]);

  const report: HealthReport = {
    timestamp: new Date().toISOString(),
    overall: 'healthy',
    checks: []
  };

  for (const [i, result] of checks.entries()) {
    const name = [
      'intelligence', 'websocket', 'l0', 'aid',
      'chat', 'database', 'disk', 'memory'
    ][i];

    if (result.status === 'rejected') {
      report.checks.push({
        name,
        status: 'critical',
        message: result.reason?.message || '檢查失敗'
      });
      report.overall = 'critical';
    } else {
      report.checks.push(result.value);
      if (result.value.status === 'critical') report.overall = 'critical';
      else if (result.value.status === 'warning' && report.overall !== 'critical') {
        report.overall = 'warning';
      }
    }
  }

  // 如果不健康，發告警
  if (report.overall !== 'healthy') {
    await alertManager.sendTkmanAlert({
      severity: report.overall === 'critical' ? 'critical' : 'warning',
      message: formatHealthReport(report),
      suggestion: '請檢查 VPS 狀態'
    });
  }

  return report;
}

// 告警規則
const ALERT_THRESHOLDS = {
  disk_usage_warning: 0.75,    // 磁碟用量 > 75% 告警
  disk_usage_critical: 0.90,   // 磁碟用量 > 90% 嚴重告警
  memory_usage_warning: 0.80,  // 記憶體 > 80%
  memory_usage_critical: 0.95, // 記憶體 > 95%
  ws_connections_warning: 4000, // WebSocket > 4000 連線
  db_size_warning: 5 * 1024 * 1024 * 1024,  // DB > 5GB
  intelligence_stale_hours: 2,  // 集體智慧 > 2 小時沒更新
};

// 通知管道
async function sendAlert(alert: Alert): Promise<void> {
  // Telegram 通知 tkman
  if (process.env.TELEGRAM_BOT_TOKEN) {
    await sendTelegramMessage(
      process.env.TELEGRAM_CHAT_ID!,
      `🚨 ClawAPI VPS 告警\n\n${alert.message}\n\n建議：${alert.suggestion}`
    );
  }

  // Discord 通知（未來）
  // if (process.env.DISCORD_WEBHOOK_URL) { ... }
}
```

### 8.3 ③ Adapter 審核

```typescript
// 三層安全掃描規則
async function scanAdapter(
  adapterYaml: string
): Promise<AdapterScanResult> {
  const parsed = yaml.parse(adapterYaml);
  const issues: ScanIssue[] = [];

  // 層 1：URL 白名單檢查
  const knownDomains = new Set([
    'api.groq.com', 'generativelanguage.googleapis.com',
    'api.openai.com', 'api.anthropic.com', 'api.deepseek.com',
    'api.search.brave.com', 'api.tavily.com', 'google.serper.dev',
    'api.duckduckgo.com', 'api-free.deepl.com', 'api.deepl.com',
    'api.cerebras.ai', 'api.sambanova.ai', 'openrouter.ai',
    'dashscope.aliyuncs.com'
  ]);

  for (const endpoint of Object.values(parsed.endpoints || {})) {
    const url = new URL(endpoint.url);
    if (!knownDomains.has(url.hostname)) {
      issues.push({
        layer: 1,
        severity: 'warning',
        message: `未知域名: ${url.hostname}`,
        suggestion: '需要龍蝦手動批准或加入白名單'
      });
    }
  }

  // 層 2：模板變數檢查
  const yamlStr = adapterYaml;

  // 禁止直接引用 Key
  if (/\{\{\s*key\s*\}\}/i.test(yamlStr)) {
    issues.push({
      layer: 2,
      severity: 'critical',
      message: '模板直接引用 Key（禁止）',
      suggestion: 'Adapter 不應直接使用 {{ key }}，認證由引擎注入'
    });
  }

  // 禁止存取環境變數
  if (/\{\{\s*env\./i.test(yamlStr)) {
    issues.push({
      layer: 2,
      severity: 'critical',
      message: '模板存取環境變數（禁止）',
      suggestion: '不允許 {{ env.* }} 模板變數'
    });
  }

  // 禁止存取檔案系統
  if (/\{\{\s*file\./i.test(yamlStr) || /\{\{\s*read\(/i.test(yamlStr)) {
    issues.push({
      layer: 2,
      severity: 'critical',
      message: '模板存取檔案系統（禁止）'
    });
  }

  // 層 3：可執行指令檢查
  const dangerousPatterns = [
    /\bexec\b/i, /\beval\b/i, /\bsystem\b/i,
    /\bchild_process\b/i, /\bspawn\b/i,
    /\brequire\b/i, /\bimport\b/i,
    /\b__proto__\b/i, /\bconstructor\b/i
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(yamlStr)) {
      issues.push({
        layer: 3,
        severity: 'critical',
        message: `偵測到危險模式: ${pattern.source}`,
        suggestion: 'Adapter YAML 不允許包含可執行程式碼'
      });
    }
  }

  // 判定結果
  const hasCritical = issues.some(i => i.severity === 'critical');
  return {
    passed: !hasCritical,
    issues,
    summary: hasCritical
      ? '❌ 安全掃描未通過（有嚴重問題）'
      : issues.length > 0
        ? '⚠️ 安全掃描通過（有警告）'
        : '✅ 安全掃描全部通過'
  };
}

// Bot 在 PR 留言的格式
function formatScanComment(result: AdapterScanResult): string {
  let comment = `## 🔍 Adapter 安全掃描結果\n\n`;
  comment += `${result.summary}\n\n`;

  if (result.issues.length > 0) {
    comment += `### 發現的問題\n\n`;
    for (const issue of result.issues) {
      const icon = issue.severity === 'critical' ? '🚨' : '⚠️';
      comment += `${icon} **[層 ${issue.layer}]** ${issue.message}\n`;
      if (issue.suggestion) {
        comment += `  → 建議：${issue.suggestion}\n`;
      }
      comment += '\n';
    }
  }

  if (result.passed) {
    comment += `\n✅ 安全掃描通過，等待維護者審核批准。`;
  } else {
    comment += `\n❌ 請修正以上嚴重問題後重新提交。`;
  }

  return comment;
}
```

### 8.4 ④ 龍蝦問題回答

```typescript
// FAQ 知識庫結構
interface FAQEntry {
  id: string;
  keywords: string[];      // 觸發關鍵字
  question: string;        // 標準問題
  answer: string;          // 回答（Markdown）
  category: 'setup' | 'keys' | 'routing' | 'mcp' | 'adapter' | 'l0' | 'aid' | 'subkey';
  links: string[];         // 相關文件連結
}

const FAQ_KNOWLEDGE_BASE: FAQEntry[] = [
  {
    id: 'faq_setup_start',
    keywords: ['install', 'setup', 'start', 'begin', '安裝', '開始', 'インストール'],
    question: '怎麼開始使用 ClawAPI？',
    answer: `
**5 分鐘 Quick Start：**

\`\`\`bash
# 安裝
npm install -g clawapi

# 啟動
clawapi start

# 打開管理介面
open http://localhost:4141
\`\`\`

安裝後會自動偵測你電腦上的 Ollama 和 DuckDuckGo，不用加任何 Key 就能開始體驗！

📖 完整文件：[Quick Start Guide](docs/quickstart.md)
`,
    category: 'setup',
    links: ['docs/quickstart.md']
  },
  {
    id: 'faq_l3_not_working',
    keywords: ['l3', 'concierge', 'ai管家', '管家', '金鑰匙', 'gold key'],
    question: 'L3 AI 管家不能用？',
    answer: `
L3 需要**金鑰匙**才能啟用。金鑰匙是一把專門給 L3/L4「大腦」用的 LLM Key。

**排查步驟：**
1. 有沒有設金鑰匙？\`clawapi gold-key show\`
2. 金鑰匙跟 Key 池裡的 Key **不能是同一把**
3. 推薦用便宜快速的 LLM：Groq Llama 或 Gemini Flash

📖 金鑰匙設定指南：[Gold Key Setup](docs/gold-key.md)
`,
    category: 'routing',
    links: ['docs/gold-key.md']
  },
  // ... 更多 FAQ
];

// 自動回答邏輯
async function tryAutoAnswer(issue: GitHubIssue): Promise<boolean> {
  const text = `${issue.title} ${issue.body}`.toLowerCase();

  // 搜尋 FAQ
  let bestMatch: FAQEntry | null = null;
  let bestScore = 0;

  for (const faq of FAQ_KNOWLEDGE_BASE) {
    let score = 0;
    for (const kw of faq.keywords) {
      if (text.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = faq;
    }
  }

  // 至少匹配 2 個關鍵字才自動回答
  if (bestMatch && bestScore >= 2) {
    await github.addComment(issue.number, bestMatch.answer);
    await github.addLabel(issue.number, 'auto-answered');
    return true;
  }

  return false;  // 無法自動回答，需要人工
}

// 什麼時候標記「需要人看」
// 1. 無法分類的 Issue
// 2. FAQ 沒有匹配的
// 3. 48 小時無回應的
// 4. 標記為 'security' 的
// 5. 包含 'production' 或 '生產' 的
```

### 8.5 ⑤ 版本發布 SOP

```typescript
// tkman 說「發版」→ Bot 跑全套流程
// 完整 SOP，每一步都有明確的判斷條件

interface ReleaseStep {
  name: string;
  action: () => Promise<StepResult>;
  rollbackAction?: () => Promise<void>;
  continueOnFail: boolean;
}

const RELEASE_STEPS: ReleaseStep[] = [
  {
    name: '① 跑完整測試套件',
    action: async () => {
      const result = await runCommand('bun test');
      if (result.exitCode !== 0) {
        return { success: false, message: `測試失敗:\n${result.stderr}` };
      }
      return { success: true, message: `所有測試通過 ✅` };
    },
    continueOnFail: false  // 測試失敗就停
  },
  {
    name: '② 覆蓋率檢查 > 80%',
    action: async () => {
      const coverage = await getCoverageReport();
      if (coverage.percentage < 80) {
        return {
          success: false,
          message: `覆蓋率 ${coverage.percentage}% < 80%`
        };
      }
      return { success: true, message: `覆蓋率 ${coverage.percentage}% ✅` };
    },
    continueOnFail: false
  },
  {
    name: '③ TypeScript 編譯檢查',
    action: async () => {
      const result = await runCommand('bun run tsc --noEmit');
      if (result.exitCode !== 0) {
        return { success: false, message: `型別檢查失敗:\n${result.stderr}` };
      }
      return { success: true };
    },
    continueOnFail: false
  },
  {
    name: '④ 打包四種安裝包',
    action: async () => {
      // npm publish
      await runCommand('npm publish');
      // Bun compile 四平台
      await runCommand('bun build --compile --target=bun-linux-x64 ./src/index.ts --outfile=dist/clawapi-linux-x64');
      await runCommand('bun build --compile --target=bun-darwin-arm64 ./src/index.ts --outfile=dist/clawapi-darwin-arm64');
      await runCommand('bun build --compile --target=bun-darwin-x64 ./src/index.ts --outfile=dist/clawapi-darwin-x64');
      await runCommand('bun build --compile --target=bun-windows-x64 ./src/index.ts --outfile=dist/clawapi-win32-x64.exe');
      // Docker image
      await runCommand('docker build -t ghcr.io/clawapi/clawapi:${VERSION} .');
      await runCommand('docker push ghcr.io/clawapi/clawapi:${VERSION}');
      return { success: true };
    },
    continueOnFail: false
  },
  {
    name: '⑤ 產生 Changelog',
    action: async () => {
      const changelog = await generateChangelog();
      return { success: true, message: changelog };
    },
    continueOnFail: true
  },
  {
    name: '⑥ 發布 GitHub Release',
    action: async () => {
      await createGitHubRelease();
      return { success: true };
    },
    continueOnFail: false
  },
  {
    name: '⑦ 通知社群',
    action: async () => {
      // Discord webhook
      // Telegram 頻道
      return { success: true };
    },
    continueOnFail: true
  }
];

// Changelog 自動生成（根據 PR 標籤）
async function generateChangelog(): Promise<string> {
  const prs = await github.getMergedPRsSinceLastTag();

  const sections: Record<string, string[]> = {
    '🚀 新功能': [],
    '🐛 修復': [],
    '📝 文件': [],
    '🔧 維護': []
  };

  for (const pr of prs) {
    const entry = `- ${pr.title} (#${pr.number})`;
    if (pr.labels.includes('feature')) sections['🚀 新功能'].push(entry);
    else if (pr.labels.includes('bug')) sections['🐛 修復'].push(entry);
    else if (pr.labels.includes('docs')) sections['📝 文件'].push(entry);
    else sections['🔧 維護'].push(entry);
  }

  let changelog = `## v${VERSION}\n\n`;
  for (const [section, items] of Object.entries(sections)) {
    if (items.length > 0) {
      changelog += `### ${section}\n${items.join('\n')}\n\n`;
    }
  }

  return changelog;
}
```

### 8.6 ⑥ 集體智慧異常告警

```typescript
// 什麼指標算異常
const ANOMALY_THRESHOLDS = {
  // 服務成功率突然下降
  success_rate_drop: {
    threshold: 0.15,          // 成功率下降 > 15%
    window_minutes: 30,       // 30 分鐘窗口
    min_sample_size: 50       // 至少 50 個樣本才判斷
  },

  // 延遲突然飆升
  latency_spike: {
    multiplier: 3,            // p95 延遲變成平時的 3 倍
    window_minutes: 30,
    min_sample_size: 50
  },

  // 大量假數據
  fake_data_burst: {
    anomalous_devices_percent: 0.1,  // 10% 的裝置數據異常
    window_minutes: 60
  },

  // 公共 Key 額度警戒
  l0_quota_warning: 0.80,    // 用量 > 80%
  l0_quota_critical: 0.95    // 用量 > 95%
};

// 告警通知內容
function formatAnomalyAlert(anomaly: DetectedAnomaly): string {
  switch (anomaly.type) {
    case 'success_rate_drop':
      return `📉 ${anomaly.serviceId} 成功率下降\n` +
        `前 30 分鐘: ${(anomaly.previous * 100).toFixed(1)}%\n` +
        `目前: ${(anomaly.current * 100).toFixed(1)}%\n` +
        `影響地區: ${anomaly.region}\n` +
        `樣本數: ${anomaly.sampleSize}`;

    case 'latency_spike':
      return `🐌 ${anomaly.serviceId} 延遲飆升\n` +
        `平時 p95: ${anomaly.previous}ms\n` +
        `目前 p95: ${anomaly.current}ms\n` +
        `影響地區: ${anomaly.region}`;

    case 'fake_data_burst':
      return `🚨 偵測到疑似假數據\n` +
        `${anomaly.deviceCount} 隻龍蝦的數據異常\n` +
        `已自動降低其信譽權重`;

    case 'l0_quota_warning':
      return `⚠️ L0 ${anomaly.serviceId} 額度已用 ${anomaly.usagePercent}%\n` +
        `建議補充公共 Key`;

    default:
      return `⚠️ 集體智慧異常: ${anomaly.type}`;
  }
}
```

### 8.7 ⑦ L0 Key 額度告警 <!-- v1.1 修訂 O-04 -->

> 當 L0 公共 Key 額度接近耗盡時，自動通知 tkman 並採取保護措施。

```typescript
// L0 Key 額度監控（每 5 分鐘隨 Key 健康檢查一起執行）

// 觸發條件與動作
const L0_QUOTA_ALERT_RULES = {
  // 警告：用量 > 80%
  warning: {
    threshold: 0.80,
    action: 'notify',  // 只通知
  },
  // 緊急：用量 > 95%
  critical: {
    threshold: 0.95,
    action: 'notify_and_throttle',  // 通知 + 自動降低配額
  },
  // Key 失效
  revoked: {
    action: 'remove_and_notify',  // 從 L0 池移除 + 緊急通知
  },
};

// 通知格式（Telegram）
function formatL0QuotaAlert(key: L0KeyRecord): string {
  const usagePercent = Math.round((key.daily_used / key.daily_quota!) * 100);
  const remaining = key.daily_quota! - key.daily_used;
  const estimatedDepletion = estimateDepletionTime(key);

  return [
    `⚠️ L0 Key 額度告警`,
    `Key: ${maskKeyId(key.id)}（${key.service_id}）`,
    `今日已用: ${usagePercent}% (${key.daily_used}/${key.daily_quota})`,
    `剩餘: ${remaining} 次`,
    `預計耗盡: ${estimatedDepletion}`,
    `建議: 補充新 Key 或降低配額`
  ].join('\n');
}

// 自動動作
async function handleL0QuotaCritical(key: L0KeyRecord): Promise<void> {
  // 額度 > 95%：自動將每龍蝦配額降為原來的 50%
  const currentDeviceLimit = await getCurrentDeviceLimit(key.service_id);
  const newLimit = Math.max(2, Math.floor(currentDeviceLimit * 0.5));
  await db.updateL0DeviceLimits(key.service_id, newLimit);

  await alertManager.sendTkmanAlert({
    severity: 'critical',
    message: formatL0QuotaAlert(key),
    suggestion: `已自動將每龍蝦配額從 ${currentDeviceLimit} 降到 ${newLimit}`
  });
}

async function handleL0KeyRevoked(key: L0KeyRecord): Promise<void> {
  // Key 失效：自動從 L0 池移除
  db.updateL0KeyStatus(key.id, 'dead');

  await alertManager.sendTkmanAlert({
    severity: 'critical',
    message: `🚨 L0 Key 失效: ${key.service_id} (${key.id})\n狀態: revoked/expired\n已自動從 L0 池移除`,
    suggestion: '需要補充新的公共 Key'
  });

  // 通知龍蝦 L0 Key 有變動
  await wsManager.broadcastNotification({
    kind: 'l0_keys_updated',
    message: 'L0 公共 Key 已更新',
    action: 'refresh_l0_keys'
  });
}
```

### 8.8 ⑧ VPS 資源告警 <!-- v1.1 修訂 O-04 -->

> 全面監控 VPS 資源使用，自動告警並在緊急時採取保護動作。

```typescript
// VPS 資源監控項目與閾值
const VPS_RESOURCE_THRESHOLDS = {
  memory: {
    warning: 0.75,     // > 75%
    critical: 0.90,    // > 90%
    autoAction: 'clear_cache',  // 清理快取
  },
  disk: {
    warning: 0.80,     // > 80%
    critical: 0.95,    // > 95%
    autoAction: 'clear_old_logs',  // 清理舊日誌/備份
  },
  cpu: {
    warning: { percent: 0.80, duration: 5 * 60 * 1000 },     // > 80% 持續 5 分鐘
    critical: { percent: 0.95, duration: 60 * 1000 },          // > 95% 持續 1 分鐘
    autoAction: 'throttle_new_connections',  // 限流新連線
  },
  ws_connections: {
    warning: 2000,
    critical: 4000,
    autoAction: 'notify_upgrade',  // 通知升級
  },
  db_wal: {
    warning: 200 * 1024 * 1024,   // > 200MB
    critical: 500 * 1024 * 1024,  // > 500MB
    autoAction: 'force_checkpoint',  // 強制 WAL checkpoint
  },
};
```

| 指標 | 警告閾值 | 嚴重閾值 | 自動動作 |
|------|---------|---------|---------|
| 記憶體使用 | > 75% | > 90% | 清理快取 |
| 磁碟使用 | > 80% | > 95% | 清理舊日誌/備份 |
| CPU 持續高 | > 80% 5分鐘 | > 95% 1分鐘 | 限流新連線 |
| WS 連線數 | > 2000 | > 4000 | 通知升級 |
| DB WAL 大小 | > 200MB | > 500MB | 強制 checkpoint |

```typescript
// VPS 資源告警通知格式（Telegram）
function formatResourceAlert(
  metric: string,
  level: 'warning' | 'critical',
  current: string,
  autoActionTaken?: string
): string {
  const icon = level === 'critical' ? '🔴' : '🟡';
  const lines = [
    `${icon} VPS 資源${level === 'critical' ? '嚴重' : ''}告警`,
  ];

  // 動態組裝各指標的詳細資訊
  lines.push(`${metric}: ${current}`);

  if (autoActionTaken) {
    lines.push(`自動動作: ${autoActionTaken}`);
  }

  return lines.join('\n');
}

// 範例嚴重告警格式：
// 「🔴 VPS 資源嚴重告警
//  記憶體使用: 92% (7.36GB / 8GB)
//  最大佔用: WebSocket 連線池 (2.1GB)
//  自動動作: 已清理路由建議快取 (-300MB)
//  建議: 考慮升級 VPS 或限制最大連線數」

// 資源監控排程（每 2 分鐘執行）
async function checkVPSResources(): Promise<void> {
  // 記憶體
  const memUsage = process.memoryUsage();
  const memPercent = memUsage.heapUsed / (8 * 1024 * 1024 * 1024);
  if (memPercent > VPS_RESOURCE_THRESHOLDS.memory.critical) {
    // 自動清理快取
    l0Cache.clear();
    subKeyCache.clear();
    const freed = '~200MB（快取已清理）';
    await alertManager.sendTkmanAlert({
      severity: 'critical',
      message: formatResourceAlert(
        '記憶體使用',
        'critical',
        `${Math.round(memPercent * 100)}% (${formatBytes(memUsage.heapUsed)} / 8GB)`,
        `已清理快取 ${freed}`
      ),
      suggestion: '考慮升級 VPS 或限制最大連線數'
    });
  }

  // DB WAL 大小
  const walSize = await getFileSize(process.env.DB_PATH + '-wal');
  if (walSize > VPS_RESOURCE_THRESHOLDS.db_wal.critical) {
    // 強制 WAL checkpoint
    db.query('PRAGMA wal_checkpoint(TRUNCATE)');
    await alertManager.sendTkmanAlert({
      severity: 'critical',
      message: formatResourceAlert(
        'DB WAL 大小',
        'critical',
        `${Math.round(walSize / 1024 / 1024)}MB`,
        '已強制 WAL checkpoint'
      ),
      suggestion: '考慮遷移至 PostgreSQL'
    });
  }

  // WS 連線數
  const wsCount = wsManager.getOnlineCount();
  if (wsCount > VPS_RESOURCE_THRESHOLDS.ws_connections.critical) {
    await alertManager.sendTkmanAlert({
      severity: 'critical',
      message: formatResourceAlert(
        'WebSocket 連線數',
        'critical',
        `${wsCount}`,
      ),
      suggestion: '需要升級 VPS 或做連線分流'
    });
  }
}
```

---

## 9. GitHub Actions 工作流

### 9.1 PR 測試工作流

```yaml
# .github/workflows/pr-test.yml
name: PR Test

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: 安裝依賴
        run: bun install --frozen-lockfile

      - name: TypeScript 型別檢查
        run: bun run tsc --noEmit

      - name: 執行測試
        run: bun test --coverage

      - name: 檢查覆蓋率 > 80%  # <!-- v1.2 修訂：用 $GITHUB_OUTPUT 傳遞 coverage 變數，不用舊語法 -->
        id: coverage
        run: |
          COVERAGE=$(bun test --coverage 2>&1 | grep -oP '\d+\.\d+%' | head -1 | tr -d '%')
          echo "coverage=${COVERAGE}" >> $GITHUB_OUTPUT
          if (( $(echo "$COVERAGE < 80" | bc -l) )); then
            echo "::error::覆蓋率 ${COVERAGE}% < 80%"
            exit 1
          fi
          echo "覆蓋率: ${COVERAGE}% ✅"

      - name: Lint 檢查
        run: bun run lint

      - name: 發布覆蓋率報告  # <!-- v1.2 修訂：從 steps.coverage.outputs.coverage 讀取，不是 process.env -->
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const coverage = '${{ steps.coverage.outputs.coverage }}' || 'N/A';
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## 📊 測試報告\n\n覆蓋率: ${coverage}%\n\n✅ 所有測試通過`
            });
```

### 9.2 Adapter 安全掃描工作流

```yaml
# .github/workflows/adapter-scan.yml
name: Adapter Security Scan

on:
  pull_request:
    branches: [main]
    paths:
      - 'adapters/**/*.yaml'
      - 'adapters/**/*.yml'

permissions:
  contents: read
  pull-requests: write

jobs:
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # <!-- v1.2 修訂：需要完整 git 歷史，否則 origin/main 不存在 -->

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: 安裝依賴
        run: bun install --frozen-lockfile

      - name: 找出變更的 Adapter 檔案  # <!-- v1.2 修訂：加上 fetch-depth: 0 確保 origin/main 存在 -->
        id: changed
        run: |
          FILES=$(git diff --name-only origin/main HEAD -- 'adapters/**/*.yaml' 'adapters/**/*.yml')
          echo "files=${FILES}" >> $GITHUB_OUTPUT
          echo "變更的 Adapter: ${FILES}"

      - name: 執行三層安全掃描
        run: |
          for FILE in ${{ steps.changed.outputs.files }}; do
            echo "掃描: ${FILE}"
            bun run scripts/scan-adapter.ts "${FILE}"
          done

      - name: 發布掃描結果
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = fs.readFileSync('/tmp/adapter-scan-report.md', 'utf8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: report
            });
```

### 9.3 自動發布工作流

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    strategy:
      matrix:
        include:
          - target: bun-linux-x64
            output: clawapi-linux-x64
          - target: bun-darwin-arm64
            output: clawapi-darwin-arm64
          - target: bun-darwin-x64
            output: clawapi-darwin-x64
          - target: bun-windows-x64
            output: clawapi-win32-x64.exe

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: 安裝依賴
        run: bun install --frozen-lockfile

      - name: 執行測試
        run: bun test

      - name: 編譯可執行檔
        run: |
          bun build --compile \
            --target=${{ matrix.target }} \
            ./src/index.ts \
            --outfile=dist/${{ matrix.output }}

      - name: 上傳產物
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.output }}
          path: dist/${{ matrix.output }}

  release:
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 取得完整 git 歷史（產生 changelog 用）

      - name: 下載所有編譯產物
        uses: actions/download-artifact@v4
        with:
          path: dist/

      - name: 產生 Changelog
        id: changelog
        run: |
          PREV_TAG=$(git describe --tags --abbrev=0 HEAD^)
          CHANGELOG=$(git log ${PREV_TAG}..HEAD --pretty=format:'- %s (%h)' --no-merges)
          echo "changelog<<EOF" >> $GITHUB_OUTPUT
          echo "$CHANGELOG" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: 建立 GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          body: |
            ## ClawAPI ${{ github.ref_name }}

            ${{ steps.changelog.outputs.changelog }}

            ### 安裝方式

            ```bash
            # npm
            npm install -g clawapi@${{ github.ref_name }}

            # brew
            brew upgrade clawapi

            # Docker
            docker pull ghcr.io/clawapi/clawapi:${{ github.ref_name }}

            # 可執行檔：下載下方附件
            ```
          files: |
            dist/clawapi-linux-x64/clawapi-linux-x64
            dist/clawapi-darwin-arm64/clawapi-darwin-arm64
            dist/clawapi-darwin-x64/clawapi-darwin-x64
            dist/clawapi-win32-x64.exe/clawapi-win32-x64.exe

  docker:
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: 登入 GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: 建立並推送 Docker Image
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: |
            ghcr.io/clawapi/clawapi:${{ github.ref_name }}
            ghcr.io/clawapi/clawapi:latest

  npm:
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: 發布到 npm
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 9.4 每日健康報告工作流

```yaml
# .github/workflows/daily-health.yml
name: Daily Health Report

on:
  schedule:
    - cron: '0 8 * * *'  # 每天 UTC 8:00（日本 17:00）
  workflow_dispatch:      # 手動觸發

permissions:
  issues: write

jobs:
  health:
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: 取得 VPS 健康狀態
        id: health
        run: |
          RESPONSE=$(curl -s -f \
            -H "Authorization: Bearer ${{ secrets.VPS_ADMIN_TOKEN }}" \
            "https://api.clawapi.com/admin/health-report" \
            || echo '{"error": "VPS 無法連線"}')
          echo "report<<EOF" >> $GITHUB_OUTPUT
          echo "$RESPONSE" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: 建立健康報告 Issue
        uses: actions/github-script@v7
        with:
          script: |
            const report = JSON.parse(process.env.REPORT || '{}');
            const date = new Date().toISOString().split('T')[0];

            const body = `## 📊 每日健康報告 — ${date}

            ### VPS 狀態
            - 整體健康: ${report.overall || '未知'}
            - 線上龍蝦: ${report.online_count || 0}
            - WebSocket 連線: ${report.ws_connections || 0}

            ### 集體智慧
            - 過去 24 小時收到: ${report.telemetry_batches_24h || 0} 批數據
            - 最後分析時間: ${report.last_analysis || '未知'}

            ### L0 公共 Key
            ${(report.l0_keys || []).map(k =>
              \`- \${k.service_id}: \${k.status} (用量 \${k.daily_used}/\${k.daily_quota})\`
            ).join('\\n') || '無數據'}

            ### 互助
            - 過去 24 小時: ${report.aid_requests_24h || 0} 次請求
            - 成功率: ${report.aid_success_rate_24h || 'N/A'}

            ### 磁碟 & 記憶體
            - 磁碟: ${report.disk_usage || 'N/A'}
            - 記憶體: ${report.memory_usage || 'N/A'}
            - DB 大小: ${report.db_size || 'N/A'}

            ---
            *自動生成，無需回覆。如有異常會另外告警。*`;

            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: \`📊 每日健康報告 \${date}\`,
              body,
              labels: ['health-report', 'automated']
            });
        env:
          REPORT: ${{ steps.health.outputs.report }}
```

### 9.5 Dependabot 配置

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "08:00"
      timezone: "Asia/Tokyo"
    open-pull-requests-limit: 5
    labels:
      - "dependencies"
      - "automated"
    reviewers:
      - "clawapi/maintainers"
    commit-message:
      prefix: "deps:"

  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    labels:
      - "dependencies"
      - "docker"
      - "automated"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    labels:
      - "dependencies"
      - "ci"
      - "automated"
```

---

## 10. VPS DB Schema

> 完整 SQL，含所有 index + constraint。延遲指標統一用 p95。

```sql
-- ============================================================
-- ClawAPI VPS 資料庫 Schema v1
-- SQLite (WAL mode)
-- 繁體中文註釋
-- ============================================================

-- 啟用 WAL 模式
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ============================================================
-- 1. 裝置管理
-- ============================================================

-- 龍蝦裝置表（含 timezone、region、vps_public_key 欄位）
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,                     -- 'clw_xxxx'
  device_fingerprint TEXT NOT NULL,               -- 硬體指紋
  device_token TEXT NOT NULL,                     -- 認證 token
  token_expires_at TEXT NOT NULL,                 -- token 過期時間
  client_version TEXT NOT NULL,                   -- 客戶端版本
  os TEXT NOT NULL,                               -- 'darwin' | 'linux' | 'win32'
  arch TEXT NOT NULL,                             -- 'arm64' | 'x64'
  locale TEXT DEFAULT 'en',                       -- 偏好語言
  timezone TEXT DEFAULT 'UTC',                    -- IANA 時區（每日額度重置用，#83）
  region TEXT DEFAULT 'other',                    -- 'asia' | 'europe' | 'americas' | 'other'（#88）
  assigned_region TEXT DEFAULT 'other',           -- VPS 判定的地區
  vps_public_key_id TEXT,                         -- 下發給龍蝦的 VPS 公鑰版本
  reputation_weight REAL DEFAULT 1.0,             -- 信譽權重（0.1-2.0）
  reputation_tier TEXT DEFAULT 'new',             -- 'new' | 'normal' | 'veteran'
  anomaly_count INTEGER DEFAULT 0,               -- 被標記異常的次數
  status TEXT DEFAULT 'active',                   -- 'active' | 'suspended'
  suspended_reason TEXT,                          -- 暫停原因
  google_id_hash TEXT,                            -- Google 帳號綁定（hash）
  google_email_masked TEXT,                       -- Email 遮罩顯示
  nickname TEXT,                                  -- 暱稱
  last_seen_at TEXT,                              -- 最後活動時間
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_devices_region ON devices(assigned_region);
CREATE INDEX idx_devices_status ON devices(status);
CREATE INDEX idx_devices_google ON devices(google_id_hash);
CREATE INDEX idx_devices_last_seen ON devices(last_seen_at);
CREATE UNIQUE INDEX idx_devices_token ON devices(device_token);

-- ============================================================
-- 2. 集體智慧數據（含 region 欄位）
-- ============================================================

-- 原始遙測數據
CREATE TABLE telemetry_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT UNIQUE NOT NULL,                  -- 去重用
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  region TEXT NOT NULL,                           -- 上報者的地區
  schema_version INTEGER NOT NULL DEFAULT 1,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  total_requests INTEGER,
  success_rate REAL,
  reputation_weight REAL DEFAULT 1.0,             -- 收到時的信譽加權
  raw_data BLOB,                                  -- MessagePack 原始數據
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_telemetry_device ON telemetry_batches(device_id);
CREATE INDEX idx_telemetry_received ON telemetry_batches(received_at);
CREATE INDEX idx_telemetry_region ON telemetry_batches(region);

-- 遙測條目（從 batch 展開）
CREATE TABLE telemetry_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES telemetry_batches(batch_id),
  device_id TEXT NOT NULL,
  region TEXT NOT NULL,
  service_id TEXT NOT NULL,
  model TEXT,
  tier TEXT,                                      -- 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
  outcome TEXT NOT NULL,                          -- 'success' | 'rate_limited' | 'error' | 'timeout'
  latency_ms INTEGER,
  token_input INTEGER,
  token_output INTEGER,
  routing_strategy TEXT,                          -- 'fast' | 'smart' | 'cheap'
  retry_count INTEGER DEFAULT 0,
  time_bucket TEXT,                               -- 'morning' | 'afternoon' | 'evening'
  reputation_weight REAL DEFAULT 1.0,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_entries_service ON telemetry_entries(service_id);
CREATE INDEX idx_entries_region_service ON telemetry_entries(region, service_id);
CREATE INDEX idx_entries_received ON telemetry_entries(received_at);
CREATE INDEX idx_entries_outcome ON telemetry_entries(outcome);

-- 路由建議（每小時分析結果）
CREATE TABLE routing_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recommendation_id TEXT UNIQUE NOT NULL,         -- 'rt_20260228_12_asia'
  service_id TEXT NOT NULL,
  region TEXT NOT NULL,                           -- 地區（#88）
  status TEXT NOT NULL,                           -- 'preferred' | 'degraded' | 'avoid'
  confidence REAL NOT NULL,                       -- 0-1
  success_rate REAL,
  avg_latency_ms INTEGER,
  p95_latency_ms INTEGER,                         -- 統一用 p95（不是 p99）
  sample_size INTEGER,
  note TEXT,
  generated_at TEXT NOT NULL,
  valid_until TEXT NOT NULL
);

CREATE INDEX idx_recommendations_region ON routing_recommendations(region);
CREATE INDEX idx_recommendations_generated ON routing_recommendations(generated_at);

-- 服務警報
CREATE TABLE service_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,                         -- 'info' | 'warning' | 'critical'
  service_id TEXT,
  region TEXT DEFAULT 'global',
  message TEXT NOT NULL,
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 3. 回饋記錄（telemetry feedback）
-- ============================================================

CREATE TABLE telemetry_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  recommendation_id TEXT,                         -- 對應哪條建議
  service_id TEXT NOT NULL,
  feedback TEXT NOT NULL,                         -- 'positive' | 'negative'
  reason TEXT,                                    -- 'high_latency' | 'errors' | 'quality' | 'other'
  comment TEXT,                                   -- 自由文字（最多 200 字元）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_feedback_service ON telemetry_feedback(service_id);
CREATE INDEX idx_feedback_created ON telemetry_feedback(created_at);
CREATE INDEX idx_feedback_device ON telemetry_feedback(device_id);

-- 回饋聚合（加速查詢）
CREATE TABLE feedback_aggregation (
  service_id TEXT NOT NULL,
  region TEXT NOT NULL,
  period_hour TEXT NOT NULL,                      -- '2026-02-28T12'
  positive_count INTEGER DEFAULT 0,
  negative_count INTEGER DEFAULT 0,
  PRIMARY KEY (service_id, region, period_hour)
);

-- ============================================================
-- 4. L0 公共 Key 表（含捐贈來源）
-- ============================================================

CREATE TABLE l0_keys (
  id TEXT PRIMARY KEY,                            -- 'l0k_001'
  service_id TEXT NOT NULL,
  key_value_encrypted BLOB,                       -- AES-256-GCM 加密（null = 不需 Key 的服務）
  key_hash TEXT,                                  -- 去重用（SHA-256 hash）
  encryption_key_id TEXT,                         -- 加密用的 master key 版本
  status TEXT NOT NULL DEFAULT 'active',          -- 'active' | 'degraded' | 'dead'
  daily_quota INTEGER,                            -- 全體每日總額度（null = 無限）
  daily_used INTEGER DEFAULT 0,                   -- 今天全體已用
  daily_reset_at TEXT,                            -- 下次重置時間（UTC）
  donated_by_device_id TEXT,                      -- 捐贈者 device_id（不公開）
  donated_by_display TEXT,                        -- 捐贈者顯示名稱
  is_anonymous_donation INTEGER DEFAULT 0,        -- 匿名捐贈
  last_health_check TEXT,                         -- 上次健康檢查
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_l0_service ON l0_keys(service_id);
CREATE INDEX idx_l0_status ON l0_keys(status);
CREATE UNIQUE INDEX idx_l0_key_hash ON l0_keys(key_hash);

-- L0 每裝置每日用量
CREATE TABLE l0_device_usage (
  device_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  date TEXT NOT NULL,                             -- '2026-02-28'
  used_count INTEGER DEFAULT 0,
  daily_limit INTEGER NOT NULL,                   -- 該裝置的每日限額
  PRIMARY KEY (device_id, service_id, date)
);

-- ============================================================
-- 5. 互助記錄表
-- ============================================================

-- 互助設定
CREATE TABLE aid_configs (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id),
  enabled INTEGER DEFAULT 0,
  allowed_services TEXT,                          -- JSON array
  daily_limit INTEGER DEFAULT 50,
  daily_given INTEGER DEFAULT 0,
  daily_reset_at TEXT,
  blackout_hours TEXT,                            -- JSON array: [0,1,2,3,4,5]
  helper_public_key TEXT,                         -- ECDH P-256 公鑰
  helper_public_key_updated_at TEXT,
  aid_success_rate REAL DEFAULT 0.5,              -- 歷史互助成功率
  avg_aid_latency_ms INTEGER DEFAULT 10000,       -- 平均互助回應延遲
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_aid_enabled ON aid_configs(enabled);

-- 互助請求記錄
CREATE TABLE aid_records (
  id TEXT PRIMARY KEY,                            -- 'aid_xxxx'
  requester_device_id TEXT NOT NULL,
  helper_device_id TEXT,
  service_id TEXT NOT NULL,
  request_type TEXT NOT NULL,                     -- 'chat_completion' 等
  requester_public_key TEXT,                      -- 求助者 ECDH 公鑰
  helper_public_key TEXT,                         -- 幫助者 ECDH 公鑰
  status TEXT NOT NULL,                           -- 'matching' | 'relaying' | 'fulfilled' | 'timeout' | 'error'
  latency_ms INTEGER,
  timeout_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX idx_aid_requester ON aid_records(requester_device_id);
CREATE INDEX idx_aid_helper ON aid_records(helper_device_id);
CREATE INDEX idx_aid_status ON aid_records(status);
CREATE INDEX idx_aid_created ON aid_records(created_at);
-- <!-- v1.2 修訂：加入複合索引，用於查詢某裝置對某服務的互助歷史（防刷單驗證用） -->
CREATE INDEX idx_aid_records_device_service_time ON aid_records(requester_device_id, service_id, created_at);

-- 互助統計（按裝置累計）
CREATE TABLE aid_stats (
  device_id TEXT NOT NULL,
  direction TEXT NOT NULL,                        -- 'given' | 'received'
  service_id TEXT NOT NULL,
  total_count INTEGER DEFAULT 0,
  month_count INTEGER DEFAULT 0,
  month_key TEXT,                                 -- '2026-02' 用於月度重置
  PRIMARY KEY (device_id, direction, service_id)
);

-- 防刷單記錄
CREATE TABLE aid_suspicious (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,                                   -- JSON 額外資訊
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_suspicious_device ON aid_suspicious(device_id);

-- ============================================================
-- 6. 備份元數據表
-- ============================================================

CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id_hash TEXT NOT NULL,                   -- Google 帳號 hash
  device_id TEXT NOT NULL,                        -- 上傳者 device_id
  backup_version INTEGER NOT NULL DEFAULT 1,
  file_path TEXT NOT NULL,                        -- 檔案路徑
  file_size INTEGER NOT NULL,                     -- 檔案大小（bytes）
  checksum TEXT NOT NULL,                         -- SHA-256 校驗碼
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  expires_at TEXT                                 -- 過期時間（365 天不動就刪）
);

CREATE UNIQUE INDEX idx_backup_google ON backups(google_id_hash);
CREATE INDEX idx_backup_expires ON backups(expires_at);

-- ============================================================
-- 7. Sub-Key 驗證快取表
-- ============================================================

CREATE TABLE subkey_validation_cache (
  cache_key TEXT PRIMARY KEY,                     -- hash(sub_key + service_id)
  result_json TEXT NOT NULL,                      -- 驗證結果 JSON
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL                        -- 5 分鐘後過期
);

CREATE INDEX idx_subkey_cache_expires ON subkey_validation_cache(expires_at);

-- ============================================================
-- 8. 系統表
-- ============================================================

-- DB 版本管理
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT
);

INSERT INTO schema_version (version, description)
VALUES (1, 'ClawAPI VPS Schema v1 — 初始版本');

-- VPS ECDH 金鑰記錄
CREATE TABLE vps_key_history (
  key_id TEXT PRIMARY KEY,                        -- 'vps_key_v1234567890'
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at TEXT,
  is_current INTEGER DEFAULT 1
);

-- 存取日誌（7 天保留）
CREATE TABLE access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER,
  ip_hash TEXT,                                   -- IP hash（不存明文）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_access_created ON access_log(created_at);
CREATE INDEX idx_access_device ON access_log(device_id);

-- 異常偵測記錄
CREATE TABLE anomaly_detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  reasons TEXT NOT NULL,                          -- JSON array
  action_taken TEXT NOT NULL,                     -- 'none' | 'downweight' | 'suspend'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_anomaly_device ON anomaly_detections(device_id);

-- 告警歷史
CREATE TABLE alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,
  channel TEXT NOT NULL,                          -- 'telegram' | 'discord' | 'github'
  message TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 9. 聚合統計表（冷啟動路由用）  <!-- v1.1 修訂 R-05/O-03 -->
-- ============================================================

CREATE TABLE telemetry_aggregated (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT,
  region TEXT NOT NULL,
  success_rate REAL NOT NULL,
  latency_p95 INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  aggregated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_aggregated_at ON telemetry_aggregated(aggregated_at);
CREATE INDEX idx_aggregated_provider ON telemetry_aggregated(provider, model, region);

-- ============================================================
-- 10. 定期清理排程（由應用層執行）
-- ============================================================

-- 以下為虛擬碼，非 SQL
-- 每天 UTC 3:00 執行：
-- 1. DELETE FROM access_log WHERE created_at < datetime('now', '-7 days');
-- 2. DELETE FROM subkey_validation_cache WHERE expires_at < datetime('now');
-- 3. DELETE FROM telemetry_entries WHERE received_at < datetime('now', '-90 days');
-- 4. UPDATE l0_keys SET daily_used = 0 WHERE daily_reset_at < datetime('now');
-- 5. DELETE FROM backups WHERE expires_at < datetime('now');
-- 6. 聚合 90 天前的 telemetry_batches → 刪除 raw_data 保留統計
```

### 10.1 SQLite 寫入佇列與 BUSY 重試 <!-- v1.1 修訂 R-05 -->

> VPS 端所有 DB 寫入必須透過 WriteQueue 串行化，避免 `SQLITE_BUSY` 錯誤。
> 搭配批次寫入優化，減少高頻小寫入的 I/O 壓力。

```typescript
// VPS 端所有 DB 寫入串行化（避免 SQLITE_BUSY）
class WriteQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  async enqueue(operation: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await operation();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const op = this.queue.shift()!;
    try {
      await op();
    } finally {
      this.processing = false;
      this.processNext();
    }
  }
}

// 配合批次寫入優化 <!-- v1.2 修訂：interface 不能有值賦值，改為正確型別簽名 -->
interface BatchWriter {
  telemetryBuffer: TelemetryRecord[];  // 遙測數據先 buffer
  maxBufferSize: number;               // 建議值：200
  flushInterval: number;               // 建議值：10_000（每 10 秒 flush）

  // 一個 transaction 批次寫入
  flush(): Promise<void>;
}
```

#### SQLITE_BUSY 重試策略

```typescript
// 當 WAL 模式下仍遇到 SQLITE_BUSY 時的重試邏輯
const BUSY_RETRY = {
  maxRetries: 3,
  delays: [50, 100, 200],  // 毫秒，逐次遞增
};

// 包裝所有寫入操作
async function withBusyRetry<T>(
  operation: () => Promise<T>
): Promise<T> {
  for (let i = 0; i <= BUSY_RETRY.maxRetries; i++) {
    try {
      return await operation();
    } catch (err: any) {
      // 判斷是否為 SQLITE_BUSY 錯誤
      if (err.code === 'SQLITE_BUSY' && i < BUSY_RETRY.maxRetries) {
        await sleep(BUSY_RETRY.delays[i]);
        continue;
      }
      throw err;
    }
  }
  throw new Error('SQLITE_BUSY: 重試次數已用盡');
}
```

---

## 11. VPS API 實作

> 實作 SPEC-C 伺服器端的所有邏輯。

### 11.1 應用進入點

```typescript
// src/vps/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();

// ── 全域 Middleware ──
app.use('*', cors());
app.use('*', logger());
app.use('/v1/*', rateLimiter());       // Rate Limit
app.use('/v1/*', deviceAuth());        // 裝置認證（除了 register 和 subkeys/validate）

// ── 裝置管理 ──
app.post('/v1/devices/register', handleDeviceRegister);
app.post('/v1/devices/refresh', handleDeviceRefresh);
app.post('/v1/devices/reset', handleDeviceReset);

// ── Google 認證 ──
app.post('/v1/auth/google', handleGoogleAuth);

// ── 集體智慧 ──
app.post('/v1/telemetry/batch', handleTelemetryBatch);
app.post('/v1/telemetry/feedback', handleTelemetryFeedback);
app.get('/v1/telemetry/quota', handleTelemetryQuota);
app.get('/v1/telemetry/route-suggestions', handleRouteSuggestions);  // <!-- v1.3 新增：WS 重連後拉取最新路由建議 -->

// ── L0 公共 Key ──
app.get('/v1/l0/keys', handleL0Keys);
app.post('/v1/l0/usage', handleL0Usage);
app.post('/v1/l0/donate', handleL0Donate);

// ── 互助 ──
app.post('/v1/aid/request', handleAidRequest);
app.put('/v1/aid/config', handleAidConfigUpdate);
app.get('/v1/aid/config', handleAidConfigGet);
app.get('/v1/aid/stats', handleAidStats);

// ── 版本 + Adapter ──
app.get('/v1/version/check', handleVersionCheck);
app.get('/v1/adapters/updates', handleAdapterUpdates);
app.get('/v1/adapters/official', handleAdapterList);

// ── 備份（v1.1+）──
app.put('/v1/backup', handleBackupUpload);
app.get('/v1/backup', handleBackupDownload);
app.delete('/v1/backup', handleBackupDelete);

// ── Sub-Key 驗證中繼 ──
app.post('/v1/subkeys/validate', handleSubKeyValidation);  // 不需要 deviceAuth <!-- v1.3 修訂：統一函式名稱 -->

// ── WebSocket ──
app.get('/v1/ws', handleWebSocketUpgrade);

// ── 管理端點（tkman 專用）──
app.get('/health', handleHealthCheck);
app.get('/admin/health-report', adminAuth(), handleAdminHealthReport);
app.get('/admin/stats', adminAuth(), handleAdminStats);
app.post('/admin/l0/add-key', adminAuth(), handleAdminAddL0Key);

// ── 健康檢查 ──
app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));

export default app;
```

### 11.2 認證 Middleware

```typescript
// 裝置認證中介層
function deviceAuth() {
  return async (c: Context, next: Next) => {
    // 跳過不需要認證的端點 <!-- v1.2 修訂：加入 /v1/ws，WebSocket 認證透過連線參數（token query param），不走 HTTP header -->
    const skipPaths = [
      '/v1/devices/register',
      '/v1/subkeys/validate',
      '/v1/ws',        // WebSocket 端點：認證透過 ?token= 參數，不是 HTTP header
      '/health'
    ];
    if (skipPaths.some(p => c.req.path.startsWith(p))) {
      return next();
    }

    const deviceId = c.req.header('X-Device-Id');
    const deviceToken = c.req.header('X-Device-Token');

    if (!deviceId || !deviceToken) {
      return c.json({
        error: 'AUTH_MISSING_HEADERS',
        message: '缺少 X-Device-Id 或 X-Device-Token',
        suggestion: '請先 POST /v1/devices/register'
      }, 401);
    }

    // 驗證 token
    const device = db.getDevice(deviceId);
    if (!device) {
      return c.json({
        error: 'AUTH_DEVICE_NOT_FOUND',
        message: '此裝置未註冊',
        suggestion: 'POST /v1/devices/register'
      }, 401);
    }

    if (device.device_token !== deviceToken) {
      return c.json({
        error: 'AUTH_INVALID_TOKEN',
        message: 'Token 無效'
      }, 401);
    }

    // 檢查 token 是否過期
    if (new Date(device.token_expires_at) < new Date()) {
      return c.json({
        error: 'AUTH_TOKEN_EXPIRED',
        message: 'Token 已過期',
        suggestion: 'POST /v1/devices/refresh'
      }, 401);
    }

    // 檢查裝置是否被暫停
    if (device.status === 'suspended') {
      return c.json({
        error: 'DEVICE_SUSPENDED',
        message: `此裝置因異常行為被暫停: ${device.suspended_reason}`,
        suggestion: '請聯繫支援'
      }, 403);
    }

    // 更新最後活動時間
    db.updateDeviceLastSeen(deviceId);

    // 設定 context
    c.set('deviceId', deviceId);
    c.set('device', device);

    return next();
  };
}
```

### 11.3 Rate Limit 中介層

```typescript
// 基於 SPEC-C 7.1 的完整 Rate Limit 表
const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  'POST:/v1/devices/register': { limit: 5, windowMs: 3600000 },
  'POST:/v1/devices/refresh': { limit: 10, windowMs: 3600000 },
  'POST:/v1/devices/reset': { limit: 3, windowMs: 86400000 },
  'POST:/v1/auth/google': { limit: 10, windowMs: 3600000 },
  'POST:/v1/telemetry/batch': { limit: 2, windowMs: 3600000 },
  'POST:/v1/telemetry/feedback': { limit: 20, windowMs: 3600000 },
  'GET:/v1/telemetry/quota': { limit: 30, windowMs: 3600000 },
  'GET:/v1/l0/keys': { limit: 10, windowMs: 3600000 },
  'POST:/v1/l0/usage': { limit: 60, windowMs: 3600000 },
  'POST:/v1/l0/donate': { limit: 5, windowMs: 86400000 },
  'POST:/v1/aid/request': { limit: 30, windowMs: 3600000 },
  'PUT:/v1/aid/config': { limit: 10, windowMs: 3600000 },
  'GET:/v1/aid/config': { limit: 30, windowMs: 3600000 },
  'GET:/v1/aid/stats': { limit: 30, windowMs: 3600000 },
  'GET:/v1/version/check': { limit: 5, windowMs: 3600000 },
  'GET:/v1/adapters/updates': { limit: 5, windowMs: 3600000 },
  'GET:/v1/adapters/official': { limit: 10, windowMs: 3600000 },
  'PUT:/v1/backup': { limit: 5, windowMs: 86400000 },
  'GET:/v1/backup': { limit: 10, windowMs: 86400000 },
  'DELETE:/v1/backup': { limit: 3, windowMs: 86400000 },
  'POST:/v1/subkeys/validate': { limit: 60, windowMs: 3600000 },
};

// IP 級別裝置註冊限制 <!-- v1.4 修訂：B 類安全標注 -->
// 同一 IP 最多允許註冊 5 個 device_id。超過時回傳 429 + RATE_LIMIT_EXCEEDED。
const IP_DEVICE_LIMIT = 5;
const ipDeviceCount = new Map<string, Set<string>>();  // ip → Set<device_id>

function checkIpDeviceLimit(ip: string, deviceId: string): boolean {
  const devices = ipDeviceCount.get(ip) || new Set();
  if (devices.has(deviceId)) return true;  // 已註冊的不算
  return devices.size < IP_DEVICE_LIMIT;
}

// 記憶體內 Rate Limit 計數（滑動窗口）
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function rateLimiter() {
  return async (c: Context, next: Next) => {
    const method = c.req.method;
    const path = c.req.path;
    const key = `${method}:${path}`;
    const config = RATE_LIMITS[key];

    if (!config) return next();  // 沒有配置 rate limit

    const deviceId = c.req.header('X-Device-Id') || c.req.raw.headers.get('cf-connecting-ip') || 'anonymous';
    const storeKey = `${deviceId}:${key}`;

    const now = Date.now();
    const entry = rateLimitStore.get(storeKey);

    if (!entry || now > entry.resetAt) {
      // 新窗口
      rateLimitStore.set(storeKey, {
        count: 1,
        resetAt: now + config.windowMs
      });
    } else if (entry.count >= config.limit) {
      // 超過限制
      c.header('X-RateLimit-Limit', config.limit.toString());
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', Math.floor(entry.resetAt / 1000).toString());

      return c.json({
        error: `${path.split('/').pop()?.toUpperCase()}_RATE_LIMITED`,
        message: '請求太頻繁',
        retry_after: Math.ceil((entry.resetAt - now) / 1000)
      }, 429);
    } else {
      entry.count++;
    }

    // 設定 Rate Limit Headers
    const remaining = config.limit - (rateLimitStore.get(storeKey)?.count || 0);
    c.header('X-RateLimit-Limit', config.limit.toString());
    c.header('X-RateLimit-Remaining', Math.max(0, remaining).toString());
    c.header('X-RateLimit-Reset',
      Math.floor((rateLimitStore.get(storeKey)?.resetAt || now) / 1000).toString()
    );

    return next();
  };
}
```

### 11.4 WebSocket 連線管理

```typescript
// WebSocket 管理器
class WebSocketManager {
  // device_id → WebSocket 連線
  connections = new Map<string, WebSocket>();
  // device_id → 訂閱的頻道
  subscriptions = new Map<string, Set<string>>();
  // device_id → 裝置資訊
  deviceInfo = new Map<string, { region: string; version: string }>();
  // ip → 活動連線數（用於 IP 級別限制） <!-- v1.4 修訂：B 類安全標注 -->
  ipConnectionCount = new Map<string, number>();

  // <!-- v1.4 修訂：WebSocket 連線限制 -->
  // 同一 device_id 最多 1 個活動 WebSocket 連線（新連線取代舊連線）。
  // 同一 IP 最多 20 個活動 WebSocket 連線。
  static readonly MAX_WS_PER_IP = 20;

  handleUpgrade(c: Context): Response {
    const deviceId = c.req.query('device_id');
    const token = c.req.query('token');
    const version = c.req.query('version') || '1.0.0';
    const clientIp = c.req.raw.headers.get('cf-connecting-ip')
      || c.req.raw.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || 'unknown';

    // 驗證
    if (!deviceId || !token) {
      return c.json({ error: 'WS_AUTH_FAILED' }, 401);
    }

    const device = db.getDevice(deviceId);
    if (!device || device.device_token !== token) {
      return c.json({ error: 'WS_AUTH_FAILED' }, 401);
    }

    // <!-- v1.4 修訂：IP 級別 WebSocket 連線限制 -->
    const currentIpConns = this.ipConnectionCount.get(clientIp) || 0;
    const isReconnect = this.connections.has(deviceId);  // 同 device 重連不算新增
    if (!isReconnect && currentIpConns >= WebSocketManager.MAX_WS_PER_IP) {
      return c.json({ error: 'WS_IP_CONNECTION_LIMIT', message: '同一 IP 連線數已達上限' }, 429);
    }

    // 升級到 WebSocket
    const { response, socket } = Bun.upgradeWebSocket(c.req.raw);

    socket.addEventListener('open', () => {
      // 關閉舊連線（如果有）
      const oldConn = this.connections.get(deviceId);
      if (oldConn) oldConn.close();

      this.connections.set(deviceId, socket);
      this.deviceInfo.set(deviceId, {
        region: device.assigned_region,
        version
      });

      // <!-- v1.4 修訂：日誌中不記錄 token，只記錄 device_id -->
      console.log(`[WS] ${deviceId} 已連線 (${this.connections.size} 總連線)`);
    });

    socket.addEventListener('message', (event) => {
      this.handleMessage(deviceId, event.data);
    });

    socket.addEventListener('close', () => {
      // <!-- v1.2 修訂：修正關閉順序 — 先讀聊天頻道再刪訂閱，否則 getSubscribedChatChannels 會讀不到 -->
      // ① 先讀取該連線的聊天頻道列表（訂閱還沒刪，才讀得到）
      const chatChannels = this.getSubscribedChatChannels(deviceId);

      // ② 從各頻道移除該連線
      for (const channelName of chatChannels) {
        const channel = channels.get(channelName);
        if (channel) {
          channel.subscribers.delete(deviceId);
        }
      }

      // ③ 通知聊天室（更新線上人數）
      for (const channelName of chatChannels) {
        broadcastPresenceChange(channelName, 'leave');
      }

      // ④ 刪除該連線的所有訂閱
      this.subscriptions.delete(deviceId);

      // ⑤ 清除連線和裝置資訊
      this.connections.delete(deviceId);
      this.deviceInfo.delete(deviceId);

      console.log(`[WS] ${deviceId} 已斷線 (${this.connections.size} 總連線)`);
    });

    // 設定 ping/pong 保活（每 30 秒）
    const pingInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    return response;
  }

  handleMessage(deviceId: string, data: string): void {
    try {
      const msg = JSON.parse(data) as ClientMessage;

      switch (msg.type) {
        case 'subscribe':
          this.handleSubscribe(deviceId, msg);
          break;
        case 'chat_message':
          handleChatMessage(deviceId, msg);
          break;
        case 'aid_response':
          handleAidResponse(msg.payload);
          break;
        case 'aid_data': // <!-- v1.4 修訂：互助加密數據轉發 -->
          handleAidData(deviceId, msg.payload);
          break;
        case 'subkey_validate_response':
          handleSubKeyValidateResponse(msg);
          break;
        case 'pong':
          // 保活回應，不做處理
          break;
        default:
          this.sendError(deviceId, 'WS_INVALID_MESSAGE_FORMAT');
      }
    } catch {
      this.sendError(deviceId, 'WS_INVALID_MESSAGE_FORMAT');
    }
  }

  handleSubscribe(deviceId: string, msg: ClientMessage): void {
    const channels = msg.payload.channels || [];
    const chatChannels = msg.payload.chat_channels || [];

    const subscribed: string[] = [];

    // 訂閱系統頻道
    for (const ch of channels) {
      if (['routing', 'notifications'].includes(ch)) {
        subscribed.push(ch);
      }
    }

    // 訂閱聊天室頻道
    for (const ch of chatChannels) {
      if (['general', 'help'].includes(ch)) {
        const fullName = `chat:${ch}`;
        subscribed.push(fullName);
        // 加入聊天室
        const channel = channels.get(ch);
        if (channel) {
          channel.subscribers.add(deviceId);
          broadcastPresenceChange(ch, 'join');
        }
      }
    }

    this.subscriptions.set(deviceId, new Set(subscribed));

    // 回應
    const conn = this.connections.get(deviceId);
    if (conn) {
      conn.send(JSON.stringify({
        type: 'subscribe_ack',
        channel: 'system',
        id: msg.id,
        payload: {
          subscribed,
          online_count: this.getOnlineCount()
        },
        server_time: new Date().toISOString()
      }));
    }
  }

  getConnection(deviceId: string): WebSocket | undefined {
    return this.connections.get(deviceId);
  }

  getConnectionsByRegion(region: string): WebSocket[] {
    const result: WebSocket[] = [];
    for (const [deviceId, info] of this.deviceInfo) {
      if (info.region === region) {
        const conn = this.connections.get(deviceId);
        if (conn && conn.readyState === WebSocket.OPEN) {
          result.push(conn);
        }
      }
    }
    return result;
  }

  getOnlineCount(): number {
    let count = 0;
    for (const [, conn] of this.connections) {
      if (conn.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }

  async broadcastNotification(payload: any): Promise<void> {
    const msg = JSON.stringify({
      type: 'notification',
      channel: 'notifications',
      id: `notif_${generateId()}`,
      payload,
      server_time: new Date().toISOString()
    });

    for (const [deviceId, subs] of this.subscriptions) {
      if (subs.has('notifications')) {
        const conn = this.connections.get(deviceId);
        if (conn && conn.readyState === WebSocket.OPEN) {
          conn.send(msg);
        }
      }
    }
  }

  sendError(deviceId: string, error: string): void {
    const conn = this.connections.get(deviceId);
    if (conn) {
      conn.send(JSON.stringify({
        type: 'error',
        channel: 'system',
        id: `err_${generateId()}`,
        payload: { error },
        server_time: new Date().toISOString()
      }));
    }
  }
}

const wsManager = new WebSocketManager();
```

### 11.5 WebSocket 訊息補發機制 <!-- v1.1 修訂 R-06 -->

> 龍蝦斷線期間收到的重要通知（互助請求、路由更新等），在重連後自動補發。
> 避免因網路不穩導致龍蝦錯過關鍵訊息。

```typescript
// 每個裝置維護未讀訊息佇列 <!-- v1.3 修訂：interface 不能有函式體，拆分為 interface + 獨立函式 -->
interface DeviceMessageQueue {
  deviceId: string;
  // 最多保留最近 20 條未讀通知
  pendingNotifications: Array<{
    message: WSMessage;
    createdAt: number;
    expiresAt: number;  // 最多保留 1 小時
  }>;
  // 重連後的補發（簽名，實作在下方）
  onReconnect(): Promise<void>;
}

// DeviceMessageQueue.onReconnect 的實作邏輯
async function handleQueueReconnect(queue: DeviceMessageQueue, conn: WebSocket): Promise<void> {
  // 1. 清除已過期的訊息
  const now = Date.now();
  queue.pendingNotifications = queue.pendingNotifications.filter(
    item => item.expiresAt > now
  );
  // 2. 補發未讀通知
  for (const item of queue.pendingNotifications) {
    conn.send(JSON.stringify(item.message));
  }
  // 3. 清空佇列
  queue.pendingNotifications = [];
}

// 互助配對特殊處理 <!-- v1.3 修訂：aid_request → aid_matched -->
// 龍蝦斷線時收到的 aid_matched：
// - 保留 30 秒（= 互助超時時間）
// - 龍蝦在 30 秒內重連 → 補發
// - 超過 30 秒 → 丟棄（VPS 已推送 timeout 給對方）
```

```typescript
// 離線訊息管理器
class OfflineMessageManager {
  // deviceId → 待補發訊息佇列
  private queues = new Map<string, DeviceMessageQueue>();

  // 最大佇列設定
  private readonly MAX_PENDING = 20;          // 每裝置最多 20 條
  private readonly DEFAULT_TTL = 60 * 60 * 1000;  // 預設 1 小時過期
  private readonly AID_TTL = 30 * 1000;            // 互助請求 30 秒過期

  // 裝置離線時，將訊息加入佇列
  enqueue(deviceId: string, message: WSMessage): void {
    if (!this.queues.has(deviceId)) {
      this.queues.set(deviceId, {
        deviceId,
        pendingNotifications: [],
        onReconnect: async () => {},  // 由 flush 實作
      });
    }

    const queue = this.queues.get(deviceId)!;
    const now = Date.now();

    // 判斷過期時間：互助配對通知用短 TTL <!-- v1.3 修訂：aid_request → aid_matched -->
    const isAidMatched = message.payload?.kind === 'aid_matched';
    const ttl = isAidMatched ? this.AID_TTL : this.DEFAULT_TTL;

    // 佇列滿了就丟最舊的
    if (queue.pendingNotifications.length >= this.MAX_PENDING) {
      queue.pendingNotifications.shift();
    }

    queue.pendingNotifications.push({
      message,
      createdAt: now,
      expiresAt: now + ttl,
    });
  }

  // 裝置重連時，補發所有未過期訊息
  async flush(deviceId: string, conn: WebSocket): Promise<number> {
    const queue = this.queues.get(deviceId);
    if (!queue) return 0;

    const now = Date.now();
    // 過濾掉已過期的
    const valid = queue.pendingNotifications.filter(
      item => item.expiresAt > now
    );

    let sent = 0;
    for (const item of valid) {
      try {
        conn.send(JSON.stringify(item.message));
        sent++;
      } catch {
        break;  // 連線又斷了，停止補發
      }
    }

    // 清空佇列
    this.queues.delete(deviceId);

    if (sent > 0) {
      console.log(`[WS] 補發 ${sent} 條訊息給 ${deviceId}`);
    }
    return sent;
  }

  // 定期清理（每 5 分鐘）
  cleanup(): void {
    const now = Date.now();
    for (const [deviceId, queue] of this.queues) {
      queue.pendingNotifications = queue.pendingNotifications.filter(
        item => item.expiresAt > now
      );
      if (queue.pendingNotifications.length === 0) {
        this.queues.delete(deviceId);
      }
    }
  }
}

const offlineMessages = new OfflineMessageManager();
```

---

## 12. VPS 監控 + 告警

### 12.1 健康檢查端點 <!-- v1.1 修訂 O-05 -->

```typescript
// 加強版健康檢查介面
interface EnhancedHealthCheck {
  // 現有
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  timestamp: string;
  db: 'ok' | 'error';
  ws_connections: number;

  // 新增 — O-05 加強
  disk_free_percent: number;           // 磁碟剩餘 %
  last_analysis_at: string | null;     // 最後一次集體智慧分析時間
  analysis_overdue: boolean;           // > 2 小時未分析 = true
  ecdh_key_age: number;               // ECDH 金鑰已使用天數
  ecdh_key_needs_rotation: boolean;   // > 25 天 = true（30 天前提醒）
  backup_dir_size: number;            // 備份目錄大小（MB）
  l0_keys_active: number;             // L0 活躍 Key 數量
  l0_keys_quota_percent: number;      // L0 Key 今日額度已用 %
}

// GET /health — 加強版健康檢查（不需認證）
app.get('/health', async (c) => {
  const checks: EnhancedHealthCheck = {
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    db: 'ok',
    ws_connections: wsManager.getOnlineCount(),

    // 新增檢查項
    disk_free_percent: 0,
    last_analysis_at: null,
    analysis_overdue: false,
    ecdh_key_age: 0,
    ecdh_key_needs_rotation: false,
    backup_dir_size: 0,
    l0_keys_active: 0,
    l0_keys_quota_percent: 0,
  };

  // 快速 DB 檢查
  try {
    db.query('SELECT 1');
  } catch {
    checks.db = 'error';
    checks.status = 'degraded';
  }

  // 磁碟剩餘 %
  try {
    const diskInfo = await getDiskUsage('/data');
    checks.disk_free_percent = Math.round(diskInfo.freePercent * 100) / 100;
    if (diskInfo.freePercent < 0.1) checks.status = 'degraded';  // 剩餘 < 10%
  } catch { /* 忽略 */ }

  // 最後一次集體智慧分析時間
  try {
    const lastAnalysis = db.getLastAnalysisTimestamp();
    checks.last_analysis_at = lastAnalysis;
    if (lastAnalysis) {
      const hoursSince = (Date.now() - new Date(lastAnalysis).getTime()) / (60 * 60 * 1000);
      checks.analysis_overdue = hoursSince > 2;  // > 2 小時未分析
      if (checks.analysis_overdue) checks.status = 'degraded';
    } else {
      checks.analysis_overdue = true;
    }
  } catch { /* 忽略 */ }

  // ECDH 金鑰年齡
  try {
    const keyInfo = ecdhManager.getPublicKey();
    const keyCreated = db.getVPSKeyCreatedAt(keyInfo.id);
    if (keyCreated) {
      checks.ecdh_key_age = Math.floor(
        (Date.now() - new Date(keyCreated).getTime()) / (24 * 60 * 60 * 1000)
      );
      checks.ecdh_key_needs_rotation = checks.ecdh_key_age > 25;  // 30 天前 5 天提醒
    }
  } catch { /* 忽略 */ }

  // 備份目錄大小
  try {
    checks.backup_dir_size = Math.round(
      await getDirectorySize(process.env.BACKUP_PATH || '/data/backups') / (1024 * 1024)
    );
  } catch { /* 忽略 */ }

  // L0 Key 狀態
  try {
    const l0Stats = db.getL0KeyStats();
    checks.l0_keys_active = l0Stats.filter(k => k.status === 'active').length;
    const totalQuota = l0Stats.reduce((sum, k) => sum + (k.daily_quota || 0), 0);
    const totalUsed = l0Stats.reduce((sum, k) => sum + k.daily_used, 0);
    checks.l0_keys_quota_percent = totalQuota > 0
      ? Math.round((totalUsed / totalQuota) * 100) : 0;
  } catch { /* 忽略 */ }

  return c.json(checks, checks.status === 'ok' ? 200 : 503);
});
```

### 12.2 指標收集

```typescript
// Prometheus 格式指標端點（tkman 專用）
app.get('/admin/metrics', adminAuth(), async (c) => {
  const metrics = [
    // WebSocket
    `clawapi_ws_connections ${wsManager.getOnlineCount()}`,
    `clawapi_ws_connections_total ${wsManager.totalConnectionsEver}`,

    // 集體智慧
    `clawapi_telemetry_batches_total ${db.getTelemetryBatchTotal()}`,
    `clawapi_telemetry_entries_total ${db.getTelemetryEntryTotal()}`,
    `clawapi_last_analysis_timestamp ${db.getLastAnalysisTimestamp()}`,

    // L0
    ...db.getL0KeyStats().map(k =>
      `clawapi_l0_daily_used{service="${k.service_id}"} ${k.daily_used}`
    ),

    // 互助
    `clawapi_aid_requests_total ${db.getAidRequestTotal()}`,
    `clawapi_aid_fulfilled_total ${db.getAidFulfilledTotal()}`,
    `clawapi_aid_timeout_total ${db.getAidTimeoutTotal()}`,

    // 系統
    `clawapi_memory_usage_bytes ${process.memoryUsage().heapUsed}`,
    `clawapi_uptime_seconds ${Math.floor(process.uptime())}`,

    // DB
    `clawapi_db_size_bytes ${await getFileSize(process.env.DB_PATH!)}`,

    // 龍蝦
    `clawapi_devices_total ${db.getDeviceTotal()}`,
    `clawapi_devices_active_24h ${db.getActiveDeviceCount('all', 24)}`,
  ];

  return c.text(metrics.join('\n'));
});
```

### 12.3 告警規則 + 通知管道

```typescript
// 告警管理器
class AlertManager {
  private lastAlerts = new Map<string, number>();  // 去重：同類告警 1 小時內不重發

  async sendTkmanAlert(alert: {
    severity: 'info' | 'warning' | 'critical';
    message: string;
    suggestion?: string;
  }): Promise<void> {
    // 去重
    const key = `${alert.severity}:${alert.message.substring(0, 50)}`;
    const lastSent = this.lastAlerts.get(key);
    if (lastSent && Date.now() - lastSent < 60 * 60 * 1000) {
      return;  // 1 小時內同類告警不重發
    }
    this.lastAlerts.set(key, Date.now());

    // 記錄到 DB
    db.saveAlert(alert);

    // Telegram 通知
    const icon = alert.severity === 'critical' ? '🚨'
      : alert.severity === 'warning' ? '⚠️' : 'ℹ️';

    const text = [
      `${icon} **ClawAPI VPS**`,
      '',
      alert.message,
      alert.suggestion ? `\n💡 建議：${alert.suggestion}` : ''
    ].join('\n');

    await this.sendTelegram(text);
  }

  private async sendTelegram(text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown'
        })
      });
    } catch (err) {
      console.error('[告警] Telegram 發送失敗:', err);
    }
  }
}

const alertManager = new AlertManager();
```

### 12.4 日誌策略

```typescript
const LOG_CONFIG = {
  // 存取日誌：7 天
  access: {
    retentionDays: 7,
    format: 'json',  // JSON Lines
    fields: ['timestamp', 'device_id', 'method', 'path', 'status', 'latency_ms']
    // 不記錄：IP 明文、請求/回應 body
  },

  // 錯誤日誌：30 天
  error: {
    retentionDays: 30,
    format: 'json',
    fields: ['timestamp', 'device_id', 'error_code', 'message', 'stack']
  },

  // 敏感資料遮罩
  masks: {
    device_token: (v: string) => v.substring(0, 8) + '****',
    key_value: (v: string) => v.substring(0, 4) + '****' + v.slice(-4),
    google_token: () => '****',
    ip: (v: string) => hashSha256(v).substring(0, 8),  // 只存 hash 前 8 碼
  }
};
```

---

## 13. VPS 代架服務架構（v1.1+）

> MVP 不做，先規劃好架構。

### 13.1 多租戶隔離

```typescript
// 方案選擇：Docker per tenant（獨立容器）
// 原因：
// 1. 最強隔離（每個龍蝦的 Key 在獨立容器裡）
// 2. 資源限制容易（cgroup）
// 3. 擴展性好（加新租戶 = 起新容器）

interface TenantConfig {
  tenant_id: string;            // 龍蝦 device_id
  container_name: string;       // 'clawapi-tenant-{id}'
  port: number;                 // 內部 port（4200 起跳）
  cpu_limit: string;            // '0.5'（半個核心）
  memory_limit: string;         // '256m'
  storage_limit: string;        // '1g'
  plan: 'basic' | 'advanced';
  sub_key_limit: number;        // basic: 5, advanced: 無限
  created_at: string;
  expires_at: string;           // 月費到期時間
}

// 動態啟動租戶容器
async function startTenantContainer(config: TenantConfig): Promise<void> {
  const cmd = `docker run -d \
    --name ${config.container_name} \
    --cpus ${config.cpu_limit} \
    --memory ${config.memory_limit} \
    --storage-opt size=${config.storage_limit} \
    -p 127.0.0.1:${config.port}:4141 \
    -v tenant_${config.tenant_id}:/root/.clawapi \
    -e NODE_ENV=production \
    -e CLAWAPI_PORT=4141 \
    --restart unless-stopped \
    ghcr.io/clawapi/clawapi:latest`;

  await exec(cmd);
}
```

### 13.2 收費計算

```typescript
const PRICING = {
  basic: {
    monthly_usd: 5,
    features: ['1 instance', '5 sub-keys', '7-day logs', '50MB backup'],
    resource: { cpu: '0.5', memory: '256m', storage: '1g' }
  },
  advanced: {
    monthly_usd: 10,
    features: ['1 instance', 'unlimited sub-keys', '30-day logs', '500MB backup'],
    resource: { cpu: '1.0', memory: '512m', storage: '5g' }
  }
};
```

### 13.3 管理 UI

```
代架管理頁面（tkman 專用）

┌────────────────────────────────────────────────┐
│  🏠 ClawAPI 代架管理                            │
│                                                │
│  租戶總數：12  |  活躍：10  |  過期：2           │
│                                                │
│  ┌──────┬────────┬──────┬──────┬────────────┐  │
│  │ ID   │ 方案   │ 狀態  │ 資源  │ 到期日     │  │
│  ├──────┼────────┼──────┼──────┼────────────┤  │
│  │ t001 │ 基本   │ 🟢   │ 0.3C │ 2026-04-01 │  │
│  │ t002 │ 進階   │ 🟢   │ 0.8C │ 2026-04-15 │  │
│  │ t003 │ 基本   │ 🔴   │ 0.0C │ 2026-02-28 │  │
│  └──────┴────────┴──────┴──────┴────────────┘  │
│                                                │
│  [新增租戶] [批量操作] [匯出報表]               │
│                                                │
└────────────────────────────────────────────────┘
```

---

## 14. 災難恢復 SOP

### 14.1 DB 備份策略

```bash
#!/bin/bash
# scripts/backup-db.sh — 每天 UTC 3:00 由 cron 執行

DB_PATH="/data/clawapi-vps.db"
BACKUP_DIR="/data/db-backups"
DATE=$(date +%Y-%m-%d)
WEEKDAY=$(date +%u)  # 1=週一 7=週日

# 每日備份
sqlite3 "$DB_PATH" ".backup '${BACKUP_DIR}/daily-${DATE}.db'"
echo "每日備份完成: daily-${DATE}.db"

# 每週備份（週一）
if [ "$WEEKDAY" = "1" ]; then
  cp "${BACKUP_DIR}/daily-${DATE}.db" "${BACKUP_DIR}/weekly-${DATE}.db"
  echo "每週備份完成: weekly-${DATE}.db"
fi

# 清理舊備份
# 保留 7 天日備 + 4 週週備
find "$BACKUP_DIR" -name 'daily-*.db' -mtime +7 -delete
find "$BACKUP_DIR" -name 'weekly-*.db' -mtime +28 -delete

# 上傳到 S3（可選，規模大了再啟用）
# aws s3 cp "${BACKUP_DIR}/daily-${DATE}.db" \
#   "s3://clawapi-backups/db/daily-${DATE}.db"

echo "備份清理完成"
```

### 14.2 VPS 掛了的恢復流程

```
完整恢復 SOP（預估 30 分鐘）
══════════════════════════════

前提：對龍蝦的影響 = 零
  → Key 在龍蝦自己電腦，API 直連上游
  → 只是集體智慧暫停、聊天室斷線、互助不可用
  → 龍蝦的離線快取可撐 30 天

步驟 1（5 分鐘）：開新 VPS
  → AWS / Vultr / 其他雲端
  → 最低配：8GB RAM, 80GB SSD
  → 安裝 Docker + Docker Compose

步驟 2（5 分鐘）：拉取程式碼
  → git clone https://github.com/clawapi/clawapi-vps.git
  → cp .env.production .env
  → 更新 .env 裡的環境變數

步驟 3（5 分鐘）：恢復 DB
  → 從 S3 或備份機下載最近的 DB 備份
  → 放到 /data/clawapi-vps.db
  → 或者：如果沒有備份，空 DB 也能跑（龍蝦重新註冊就好）

步驟 4（5 分鐘）：啟動服務
  → docker compose -f docker-compose.vps.yml up -d
  → 確認 /health 回應 200

步驟 5（5 分鐘）：更新 DNS
  → Cloudflare DNS：api.clawapi.com → 新 VPS IP
  → TTL 設 1 分鐘，5 分鐘內全球生效

步驟 6（5 分鐘）：驗證
  → curl https://api.clawapi.com/health
  → 檢查 WebSocket 連線
  → 確認龍蝦能自動重連

後續：
  → 龍蝦的引擎會自動重連（指數退避）
  → 堆積的數據會自動補傳
  → 集體智慧需要等 1-2 小時重新累積數據
```

### 14.3 資料遷移流程

```typescript
// 從 SQLite 遷移到 PostgreSQL（規模大了再做）
// 這只是預留的架構設計

interface MigrationPlan {
  phase1: 'SQLite (MVP)';           // 0-5K 龍蝦
  phase2: 'SQLite + 讀寫分離';     // 5K-10K 龍蝦
  phase3: 'PostgreSQL';             // 10K+ 龍蝦

  // 遷移時的零停機策略
  strategy: 'dual-write';
  // 1. 啟動新 PostgreSQL
  // 2. 同時寫入 SQLite + PostgreSQL
  // 3. 驗證數據一致性
  // 4. 切換讀取到 PostgreSQL
  // 5. 停止寫入 SQLite
}
```

---

## 15. 部署流程

### 15.1 Dockerfile

```dockerfile
# Dockerfile.vps <!-- v1.2 修訂：COPY 與 CMD 一致，直接跑 TypeScript（Bun 原生支持） -->
FROM oven/bun:latest

WORKDIR /app

# 安裝依賴
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# 複製原始碼（直接跑 TypeScript，不需要 build 步驟）
COPY . .

# 建立資料目錄
RUN mkdir -p /data /logs /keys/ecdh /data/backups /data/db-backups

# 非 root 執行
RUN adduser --disabled-password --gecos '' clawapi
RUN chown -R clawapi:clawapi /app /data /logs /keys
USER clawapi

ENV NODE_ENV=production
ENV VPS_PORT=3100

EXPOSE 3100

# <!-- v1.2 修訂：Alpine 沒有 curl，改用 bun 內建 fetch -->
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:3100/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/vps/index.ts"]
```

### 15.2 Caddy 設定

```
# Caddyfile <!-- v1.2 修訂：移除 Cloudflare DNS challenge，改用 HTTP challenge（caddy:2-alpine 原版不含 cloudflare 模組） -->
{
    email tkman@clawapi.com
    # 注意：不使用 acme_dns cloudflare，因為 caddy:2-alpine 原版映像不含此模組
    # VPS 有公網 IP，Caddy 會自動用 HTTP/HTTPS challenge 取得 Let's Encrypt 證書
}

api.clawapi.com {
    # 反向代理到 VPS 服務
    reverse_proxy clawapi-vps:3100

    # WebSocket 支援
    @websocket {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @websocket clawapi-vps:3100

    # 安全 headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }

    # 日誌
    log {
        output file /var/log/caddy/access.log
        format json
        level INFO
    }
}

# <!-- v1.3 修訂：移除 dev.clawapi.com site block，docker-compose 無 clawapi-vps-dev 服務 -->
# 開發環境暫不透過 Caddy 配置。未來需要時：
# 1. 在 docker-compose.yml 加入 clawapi-vps-dev 服務
# 2. 取消以下註解
# dev.clawapi.com {
#     reverse_proxy clawapi-vps-dev:3100
# }
```

### 15.3 環境變數清單

```bash
# .env.production

# ── 基本設定 ──
NODE_ENV=production
VPS_PORT=3100

# ── 資料庫 ──
DB_PATH=/data/clawapi-vps.db

# ── 日誌 ──
LOG_PATH=/logs
LOG_LEVEL=info

# ── 金鑰 ──
KEYS_PATH=/keys
ECDH_KEY_PATH=/keys/ecdh

# ── 備份 ──
BACKUP_PATH=/data/backups

# ── 管理 ──
ADMIN_TOKEN=<32字元隨機token>

# ── 告警 ──
TELEGRAM_BOT_TOKEN=<Telegram Bot Token>
TELEGRAM_CHAT_ID=<tkman 的 Chat ID>

# ── Google OAuth（v1.1+）──
GOOGLE_CLIENT_ID=<Google OAuth Client ID>

# ── Caddy ── <!-- v1.2 修訂：不再需要 CF_API_TOKEN，改用 HTTP challenge -->
# CF_API_TOKEN 已移除（caddy:2-alpine 不含 cloudflare 模組，改用 HTTP challenge）

# ── S3 備份（可選）──
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# S3_BUCKET=clawapi-backups
# S3_REGION=ap-northeast-1
```

### 15.4 部署檢查清單

```markdown
## 部署前檢查清單

### 環境
- [ ] VPS 至少 8GB RAM, 80GB SSD
- [ ] Docker + Docker Compose 已安裝
- [ ] .env.production 所有變數已填
- [ ] DNS 已指向正確 IP

### 安全
- [ ] ADMIN_TOKEN 是隨機產生的
- [ ] ECDH 金鑰對已生成或會自動生成
- [ ] Caddy TLS 設定正確
- [ ] 防火牆只開 80, 443

### 資料
- [ ] /data 目錄有足夠空間
- [ ] DB 備份排程已設定（cron）
- [ ] 日誌輪轉已設定

### 服務
- [ ] docker compose up -d 成功
- [ ] /health 端點回傳 200
- [ ] WebSocket 連線測試通過
- [ ] Telegram 告警測試通過

### 上線後
- [ ] 確認第一隻龍蝦能註冊
- [ ] 確認集體智慧能收到數據
- [ ] 確認路由建議能推送
- [ ] 監控 24 小時無異常
```

---

## 16. 安全加固

### 16.1 防 DDoS

```typescript
// 多層防護

// 層 1：Cloudflare（前端）
// → 免費方案即有基本 DDoS 防護
// → 設定 Rate Limiting 規則
// → 開啟 Under Attack Mode（手動，緊急時用）

// 層 2：Caddy（反向代理）
// → 連線數限制
// → 請求大小限制（50MB）
// → 慢速攻擊防護（超時設定）

// 層 3：應用層 Rate Limit（見 11.3）
// → 每個端點獨立限制
// → 按 device_id 計數
// → 滑動窗口算法
```

### 16.2 Rate Limit 完整實作

```typescript
// 見 11.3 節（已完整定義 SPEC-C 的所有 Rate Limit 規則）

// WebSocket Rate Limit
const WS_RATE_LIMITS = {
  chat_message: { interval: 5000, max: 1 },     // 每 5 秒最多 1 則
  aid_response: { interval: 10000, max: 5 },     // 每 10 秒最多 5 則
  aid_data: { interval: 5000, max: 2 },          // 每 5 秒最多 2 則 <!-- v1.4 修訂 -->
  other: { interval: 1000, max: 10 },            // 每 1 秒最多 10 則
};

// 持續超限 → 斷線 + 5 分鐘禁止重連
const WS_BAN_THRESHOLD = 10;  // 連續超限 10 次
const WS_BAN_DURATION = 5 * 60 * 1000;  // 5 分鐘

const wsBannedDevices = new Map<string, number>();  // device_id → 解禁時間
```

### 16.3 日誌敏感資料遮罩

```typescript
// 所有寫入日誌和 DB 前的遮罩處理
function maskSensitiveData(obj: any): any {
  if (typeof obj !== 'object' || !obj) return obj;

  const masked = { ...obj };

  // Key 值：只顯示前 4 + 後 4
  if (masked.key_value) {
    const k = masked.key_value;
    masked.key_value = k.length > 8
      ? `${k.substring(0, 4)}****${k.slice(-4)}` : '****';
  }

  // Token：只顯示前 8 碼
  if (masked.device_token) {
    masked.device_token = masked.device_token.substring(0, 8) + '****';
  }

  // auth.token（WebSocket 連線 query param 中的 token）：完全遮罩 <!-- v1.4 修訂：B 類安全標注 -->
  // 重要：WS 升級時的 token 參數絕不能記錄到日誌
  if (masked.token) {
    masked.token = '****';
  }

  // Google Token：完全遮罩
  if (masked.google_id_token) {
    masked.google_id_token = '****';
  }

  // IP：hash 處理
  if (masked.ip) {
    masked.ip = hashSha256(masked.ip).substring(0, 8);
  }

  // 遞迴處理嵌套物件
  for (const [key, value] of Object.entries(masked)) {
    if (typeof value === 'object' && value) {
      masked[key] = maskSensitiveData(value);
    }
  }

  return masked;
}
```

### 16.4 龍蝦數據隔離

```typescript
// 確保龍蝦之間的數據不互相洩漏

// 規則 1：API 回應只包含自己的數據
// → telemetry/quota 只回自己的配額
// → aid/stats 只回自己的統計
// → l0/keys 的 device_daily_limits 只回自己的

// 規則 2：聊天室不暴露 device_id
// → sender_device_id 永遠是 null
// → 只顯示暱稱或「匿名龍蝦」

// 規則 3：互助不暴露雙方身份
// → helper_device_id 永遠是 null
// → VPS 內部記錄但不對外暴露

// 規則 4：集體智慧數據匿名化
// → 少於 10 人的服務合併到「其他」
// → 時間只有 time_bucket（不精確）
// → 路由建議不包含任何個人數據

// 規則 5：Admin 端點需要 ADMIN_TOKEN
// → 只有 tkman 能看所有數據
// → Admin 操作記錄到 audit log
```

### 16.5 ECDH P-256 VPS 金鑰對管理 <!-- v1.1 修訂 O-02 -->

> **重要**：VPS 的 ECDH 金鑰對**不再用於互助加密中繼**。
> 互助改為龍蝦之間直接做 ECDH 雙公鑰協商，VPS 只負責配對和轉發，完全不碰密鑰。
> VPS 金鑰對仍保留用於裝置認證、Sub-Key 驗證、L0 Key 下發加密。

```typescript
// 見 4.3 節（已完整定義）
// 補充：安全最佳實踐

const ECDH_SECURITY_RULES = {
  // 1. 金鑰對存放
  storage: '/keys/ecdh/',              // Docker volume，不進 git
  permissions: '600',                   // 只有 clawapi 用戶可讀

  // 2. 輪換頻率
  rotation_days: 30,                    // 每 30 天輪換
  old_key_retention_days: 7,            // 舊金鑰保留 7 天

  // 3. 使用規則
  never_log_private_key: true,          // 私鑰永遠不出現在日誌
  zero_after_use: true,                 // 用完立即清零記憶體
  // 注意：互助不再需要 VPS 金鑰對參與（O-02 雙公鑰方案）
  // VPS 金鑰對只用於裝置認證、Sub-Key 驗證、L0 Key 加密

  // 4. 備份
  backup_private_key: false,            // 私鑰不備份（遺失就輪換新的）
  // 原因：備份私鑰增加被盜風險，而輪換新金鑰的成本很低
  // 龍蝦只需要等進行中的操作完成，然後拿到新公鑰

  // 5. 互助安全（O-02 變更）
  // 互助的加密完全由龍蝦之間的 ECDH 雙公鑰處理
  // VPS 只轉發公鑰和加密後的 payload，無法解密任何互助內容
  // 這比原方案更安全：即使 VPS 被入侵，也看不到互助的 API 內容
};
```

---

## 附錄 A：VPS 模組檔案結構

```
vps/
├── src/
│   ├── index.ts                  # 應用進入點
│   ├── server.ts                 # Hono HTTP Server + WS
│   │
│   ├── middleware/
│   │   ├── auth.ts               # 裝置認證中介層
│   │   ├── rate-limit.ts         # Rate Limit 中介層
│   │   ├── admin-auth.ts         # Admin 認證
│   │   └── logger.ts             # 結構化日誌中介層
│   │
│   ├── modules/
│   │   ├── device/               # 裝置管理
│   │   │   ├── register.ts
│   │   │   ├── refresh.ts
│   │   │   └── reset.ts
│   │   │
│   │   ├── intelligence/         # 集體智慧分析引擎
│   │   │   ├── receiver.ts       # 數據接收 + 去重 + 驗證
│   │   │   ├── analyzer.ts       # 每小時聚合分析
│   │   │   ├── reputation.ts     # 信譽加權系統
│   │   │   ├── anomaly.ts        # 異常偵測
│   │   │   └── feedback.ts       # 路由回饋處理
│   │   │
│   │   ├── l0/                   # L0 公共 Key 管理
│   │   │   ├── dispenser.ts      # Key 下發
│   │   │   ├── quota.ts          # 額度分配
│   │   │   ├── health.ts         # 健康監控
│   │   │   └── donation.ts       # 捐贈處理
│   │   │
│   │   ├── aid/                  # 互助配對引擎
│   │   │   ├── matcher.ts        # 配對演算法
│   │   │   ├── relay.ts          # VPS 中繼
│   │   │   ├── ecdh.ts           # ECDH 金鑰管理
│   │   │   ├── anti-abuse.ts     # 防刷單
│   │   │   └── stats.ts          # 互助統計
│   │   │
│   │   ├── chat/                 # 聊天室中繼
│   │   │   ├── channels.ts
│   │   │   ├── relay.ts
│   │   │   └── rate-limit.ts
│   │   │
│   │   ├── backup/               # 雲端備份（v1.1+）
│   │   │   ├── upload.ts
│   │   │   ├── download.ts
│   │   │   └── google-auth.ts
│   │   │
│   │   └── subkey/               # Sub-Key 驗證中繼
│   │       ├── validate.ts
│   │       └── cache.ts
│   │
│   ├── ws/                       # WebSocket 管理
│   │   ├── manager.ts            # 連線管理
│   │   ├── handler.ts            # 訊息處理
│   │   └── broadcast.ts          # 廣播邏輯
│   │
│   ├── scheduler/                # 排程任務
│   │   ├── hourly-analysis.ts    # 每小時集體智慧分析
│   │   ├── key-health-check.ts   # 每 5 分鐘 L0 Key 檢查
│   │   ├── data-cleanup.ts       # 每天數據清理
│   │   ├── db-backup.ts          # 每天 DB 備份
│   │   └── ecdh-rotation.ts      # 每 30 天金鑰輪換
│   │
│   ├── storage/
│   │   ├── db.ts                 # SQLite 操作封裝
│   │   ├── migration.ts          # Schema 遷移
│   │   └── backup-store.ts       # 備份檔存取
│   │
│   ├── alert/                    # 告警系統
│   │   ├── manager.ts
│   │   ├── telegram.ts
│   │   └── discord.ts
│   │
│   └── admin/                    # 管理端點
│       ├── health.ts
│       ├── metrics.ts
│       └── l0-manage.ts
│
├── bot/                          # Claude Bot
│   ├── github/
│   │   ├── triage.ts             # Issue 分診
│   │   ├── auto-reply.ts         # 自動回覆
│   │   ├── pr-review.ts          # PR 審查
│   │   └── stale-checker.ts      # 48 小時檢查
│   │
│   ├── adapter-scan.ts           # Adapter 安全掃描
│   ├── faq.ts                    # FAQ 知識庫
│   ├── release.ts                # 版本發布
│   └── anomaly-alert.ts          # 集體智慧異常告警
│
├── scripts/
│   ├── backup-db.sh              # DB 備份腳本
│   ├── scan-adapter.ts           # Adapter 掃描 CLI
│   └── migrate.ts                # DB 遷移
│
├── Dockerfile.vps
├── docker-compose.vps.yml
├── Caddyfile
└── .env.production.example
```

## 附錄 B：SPEC-C 共享型別引用

> 本規格書引用 `@clawapi/protocol` 共享型別包（定義在 SPEC-C 附錄 B）。
> 以下為 VPS 端需要實作的關鍵型別，不重複定義。

| 型別名稱 | 用途 | 定義位置 |
|----------|------|---------|
| `TelemetryBatch` | 遙測數據批次 | SPEC-C §4.2 |
| `TelemetryEntry` | 單條遙測條目 | SPEC-C §4.2 |
| `RoutingFeedback` | 路由回饋 | SPEC-C §4.2 |
| `L0KeysResponse` | L0 Key 下發回應 | SPEC-C §4.3 |
| `AidRequest` | 互助請求 | SPEC-C §4.5 |
| `AidResponse` | 互助回應 | SPEC-C §5.4 |
| `SubKeyValidateRequest` | Sub-Key 驗證請求 | SPEC-C §4.10 |
| `ClientMessage` | WS 客戶端訊息 | SPEC-C §5.1 |
| `ServerMessage` | WS 伺服器訊息 | SPEC-C §5.1 |
| `DeviceRegistrationRequest` | 裝置註冊請求 | SPEC-C §4.1 |
| `DeviceRegistrationResponse` | 裝置註冊回應 | SPEC-C §4.1 |

---

> 📝 **版本歷史**
>
> | 版本 | 日期 | 變更 |
> |------|------|------|
> | v1.0 | 2026-03-01 | 初版，涵蓋 16 章 + 2 附錄 |
> | v1.1 | 2026-03-01 | R-05 SQLite 寫入佇列 + BUSY 重試、R-06 WebSocket 訊息補發、Y-09 規模階梯、Y-10 互助防濫用加強、O-02 ECDH 雙公鑰方案（VPS 不再參與互助密鑰交換）、O-03 冷啟動路由建議、O-04 Claude Bot 新增第七八功能（L0 額度告警 + VPS 資源告警）、O-05 加強版健康檢查、G-05 地區判定權威規則 |
> | v1.2 | 2026-03-01 | Bug 修復 10 項：Dockerfile COPY/CMD 一致性、Caddy 移除 Cloudflare DNS challenge 改用 HTTP challenge、deviceAuth skipPaths 加入 /v1/ws、L0 Donate 加密改為 ECIES（ECDH P-256 + AES-256-GCM）、interface 語法修正（AidRequestValidator + BatchWriter）、WebSocket close 順序修正、GitHub Actions coverage 變數用 $GITHUB_OUTPUT、adapter-scan.yml 加 fetch-depth: 0、aid_records 加複合索引、Docker healthcheck 改用 bun fetch |
> | v1.3 | 2026-03-01 | SPEC-B 最終修復 5+1 項：移除 payload_encrypted 殘留改為公鑰格式驗證、DeviceMessageQueue interface 函式體拆分、handleSubKeyValidate 統一為 handleSubKeyValidation、新增 GET /v1/telemetry/route-suggestions 端點、Caddy dev.clawapi.com 註解化、互助配對改為 aid_matched 雙推送（與 SPEC-C / SPEC-A 統一） |
