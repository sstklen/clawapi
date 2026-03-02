// VPS 客戶端 — 統一門面（Facade）
// 整合 HTTP 客戶端、WebSocket 客戶端、離線模式狀態機
// 對外提供統一的 VPS 通訊介面

import {
  OFFLINE_THRESHOLD_503_COUNT,
  OFFLINE_PROBE_INTERVAL_MS,
  OFFLINE_QUEUE_MAX_DAYS,
} from '@clawapi/protocol';

import type {
  TelemetryBatch,
  L0KeysResponse,
  L0UsageEntry,
} from '@clawapi/protocol';

import { VPSHttpClient, ServiceUnavailableError } from './vps-http';
import { VPSWebSocketClient, type MessageHandler } from './vps-ws';
import type { DatabaseModule } from '../storage/database';

// ===== 型別定義 =====

/** VPSClient 建構設定 */
export interface VPSClientConfig {
  baseUrl: string;
  wsUrl: string;
  clientVersion: string;
}

/** 裝置資料（從 DB 讀出） */
interface DeviceRow {
  device_id: string;
  device_token: string | null;
  device_token_expires_at: string | null;
  device_fingerprint: string;
}

/** 遙測佇列資料列 */
interface TelemetryQueueRow {
  id: number;
  batch_id: string;
  payload: Uint8Array;
  created_at: string;
}

/** L0 用量佇列資料列 */
interface L0UsageQueueRow {
  id: number;
  payload: string;
  created_at: string;
}

// ===== 主要客戶端類別 =====

/**
 * VPSClient：統一門面
 *
 * 整合 HTTP 和 WebSocket 客戶端，提供：
 * 1. 生命週期管理（connect / disconnect）
 * 2. 離線模式狀態機（連續 5 次 503 → 離線 → 探測恢復）
 * 3. 離線佇列管理（telemetry + L0 用量）
 * 4. 事件代理（onRoutingUpdate, onNotification, onAidRequest）
 */
export class VPSClient {
  private http: VPSHttpClient;
  private ws: VPSWebSocketClient;
  private db: DatabaseModule;

  // 離線模式狀態機
  private isOffline: boolean = false;
  private consecutive503Count: number = 0;
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: VPSClientConfig, db: DatabaseModule) {
    this.http = new VPSHttpClient({
      baseUrl: config.baseUrl,
      clientVersion: config.clientVersion,
    });
    this.ws = new VPSWebSocketClient({
      wsUrl: config.wsUrl,
      clientVersion: config.clientVersion,
    });
    this.db = db;
  }

  // ===== 生命週期 =====

  /**
   * 初始化並連線
   *
   * 流程：
   * 1. 讀取 DB device 表，取 device_id / device_token
   * 2. 如果沒有 device → registerDevice
   * 3. 如果 token 快過期（< 7 天）→ refreshToken
   * 4. setCredentials（HTTP + WS）
   * 5. ws.connect()
   */
  async connect(): Promise<void> {
    const device = this.loadDevice();

    let deviceId: string;
    let deviceToken: string;

    if (!device) {
      // 全新裝置，需要先取得 fingerprint 再注冊
      const newDeviceId = this.generateDeviceId();
      const fingerprint = this.generateFingerprint();

      const resp = await this.http.registerDevice({
        device_id: newDeviceId,
        device_fingerprint: fingerprint,
        client_version: this.http['clientVersion'] as string,
        os: process.platform,
        arch: process.arch as 'arm64' | 'x64',
      });

      // 存入 DB
      this.db.run(
        `INSERT OR REPLACE INTO device
          (device_id, device_fingerprint, device_token, device_token_expires_at,
           vps_public_key, vps_public_key_id, assigned_region, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          newDeviceId,
          fingerprint,
          resp.device_token,
          resp.token_expires_at,
          resp.vps_public_key,
          resp.vps_public_key_id,
          resp.assigned_region,
        ]
      );

      deviceId = newDeviceId;
      deviceToken = resp.device_token;
    } else {
      deviceId = device.device_id;
      deviceToken = device.device_token ?? '';

      // 檢查 token 是否快過期（< 7 天）
      if (this.isTokenExpiringSoon(device.device_token_expires_at)) {
        try {
          const refreshed = await this.http.refreshToken();
          // 更新 DB
          this.db.run(
            `UPDATE device SET device_token = ?, device_token_expires_at = ?, updated_at = datetime('now')`,
            [refreshed.device_token, refreshed.expires_at]
          );
          deviceToken = refreshed.device_token;
        } catch {
          // 刷新失敗不阻止連線，用舊 token 繼續
        }
      }
    }

    // 設定認證憑證
    this.http.setCredentials(deviceId, deviceToken);
    this.ws.setCredentials(deviceId, deviceToken);

    // 建立 WebSocket 連線（失敗不阻止 VPSClient 初始化）
    try {
      await this.ws.connect();
    } catch {
      // WS 連線失敗不影響 HTTP 功能，讓 WS 自行重連
    }
  }

  /**
   * 斷線並清理資源
   */
  async disconnect(): Promise<void> {
    this.ws.disconnect();
    this.stopProbing();
  }

  // ===== 離線模式狀態機 =====

  /**
   * 回報 HTTP 成功
   * 重置連續 503 計數器，切換回在線狀態
   */
  reportHttpSuccess(): void {
    this.consecutive503Count = 0;
    if (this.isOffline) {
      this.isOffline = false;
      this.stopProbing();
    }
  }

  /**
   * 回報 HTTP 錯誤
   * 503 計數達到閾值時切換到離線模式
   */
  reportHttpError(status: number): void {
    if (status === 503) {
      this.consecutive503Count++;

      if (this.consecutive503Count >= OFFLINE_THRESHOLD_503_COUNT && !this.isOffline) {
        this.isOffline = true;
        this.startProbing();
      }
    }
  }

  /**
   * 取得目前是否為離線模式
   */
  getIsOffline(): boolean {
    return this.isOffline;
  }

  /**
   * 開始探測（每 5 分鐘發送一次探測請求）
   * 探測成功 → 切換回在線狀態，上傳離線佇列資料
   */
  private startProbing(): void {
    // 避免重複啟動
    if (this.probeTimer !== null) return;

    this.probeTimer = setInterval(async () => {
      try {
        await this.http.getQuota();
        // 探測成功
        this.isOffline = false;
        this.consecutive503Count = 0;
        this.stopProbing();
        // 上傳離線期間累積的資料
        await this.batchUploadOfflineData();
      } catch {
        // 探測失敗，繼續等待
      }
    }, OFFLINE_PROBE_INTERVAL_MS);
  }

  /**
   * 停止探測計時器
   */
  private stopProbing(): void {
    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /**
   * 批次上傳離線期間累積的資料
   * 按時間順序：telemetry_queue → l0_usage_queue
   * 上傳成功後刪除對應資料
   */
  private async batchUploadOfflineData(): Promise<void> {
    // 上傳遙測佇列
    await this.flushTelemetryQueue();
    // 上傳 L0 用量佇列
    await this.flushL0UsageQueue();
  }

  /**
   * 清空遙測佇列（按時間順序上傳）
   */
  private async flushTelemetryQueue(): Promise<void> {
    const rows = this.db.query<TelemetryQueueRow>(
      `SELECT id, batch_id, payload, created_at
       FROM telemetry_queue
       ORDER BY created_at ASC`
    );

    for (const row of rows) {
      try {
        await this.http.uploadTelemetry(row.payload);
        this.db.run(`DELETE FROM telemetry_queue WHERE id = ?`, [row.id]);
      } catch {
        // 上傳失敗，保留在佇列中，下次再試
      }
    }
  }

  /**
   * 清空 L0 用量佇列（按時間順序上傳）
   */
  private async flushL0UsageQueue(): Promise<void> {
    const rows = this.db.query<L0UsageQueueRow>(
      `SELECT id, payload, created_at
       FROM l0_usage_queue
       ORDER BY created_at ASC`
    );

    // 收集所有 entries 批次上傳
    const idsToDelete: number[] = [];
    const entries: L0UsageEntry[] = [];

    for (const row of rows) {
      try {
        const entry = JSON.parse(row.payload) as L0UsageEntry;
        entries.push(entry);
        idsToDelete.push(row.id);
      } catch {
        // 損壞的資料直接刪除
        this.db.run(`DELETE FROM l0_usage_queue WHERE id = ?`, [row.id]);
      }
    }

    if (entries.length > 0) {
      try {
        await this.http.reportL0Usage(entries);
        // 成功後刪除已上傳的記錄
        for (const id of idsToDelete) {
          this.db.run(`DELETE FROM l0_usage_queue WHERE id = ?`, [id]);
        }
      } catch {
        // 批次上傳失敗，保留資料
      }
    }
  }

  // ===== 離線佇列管理 =====

  /**
   * 將遙測批次存入離線佇列
   * 超過 30 天的舊資料自動丟棄
   */
  async queueTelemetry(batch: TelemetryBatch): Promise<void> {
    // 先清理超過 30 天的舊資料
    this.db.run(
      `DELETE FROM telemetry_queue
       WHERE created_at < datetime('now', '-' || ? || ' days')`,
      [OFFLINE_QUEUE_MAX_DAYS]
    );

    // 將 TelemetryBatch 序列化為 JSON，再轉換為 Uint8Array
    const jsonStr = JSON.stringify(batch);
    const encoder = new TextEncoder();
    const payload = encoder.encode(jsonStr);

    // 存入佇列
    this.db.run(
      `INSERT OR IGNORE INTO telemetry_queue
        (batch_id, payload, period_from, period_to)
       VALUES (?, ?, ?, ?)`,
      [
        batch.batch_id,
        payload,
        batch.period.from,
        batch.period.to,
      ]
    );
  }

  /**
   * 將 L0 用量記錄存入離線佇列
   */
  async queueL0Usage(entry: L0UsageEntry): Promise<void> {
    this.db.run(
      `INSERT INTO l0_usage_queue (payload) VALUES (?)`,
      [JSON.stringify(entry)]
    );
  }

  // ===== 代理方法 =====

  /**
   * 上傳遙測資料
   * 在線 → 直接呼叫 HTTP
   * 離線 → 存入佇列
   */
  async uploadTelemetry(batch: TelemetryBatch): Promise<void> {
    if (this.isOffline) {
      await this.queueTelemetry(batch);
      return;
    }

    try {
      // 將 TelemetryBatch 序列化為 msgpack（此處用 JSON 作為簡化實作）
      const jsonStr = JSON.stringify(batch);
      const encoder = new TextEncoder();
      const payload = encoder.encode(jsonStr);

      await this.http.uploadTelemetry(payload);
      this.reportHttpSuccess();
    } catch (err) {
      if (err instanceof ServiceUnavailableError) {
        this.reportHttpError(503);
        // 服務不可用，改存佇列
        await this.queueTelemetry(batch);
      } else {
        throw err;
      }
    }
  }

  /**
   * 取得 L0 Keys
   * 在線 → 直接呼叫 HTTP
   * 離線 → 回傳 null（讓呼叫端使用快取）
   */
  async getL0Keys(since?: string): Promise<L0KeysResponse | null> {
    if (this.isOffline) {
      return null;
    }

    try {
      const result = await this.http.getL0Keys(since);
      this.reportHttpSuccess();
      return result;
    } catch (err) {
      if (err instanceof ServiceUnavailableError) {
        this.reportHttpError(503);
        return null;
      }
      throw err;
    }
  }

  // ===== 事件代理 =====

  /**
   * 訂閱路由更新事件
   */
  onRoutingUpdate(handler: (update: unknown) => void): void {
    this.ws.onRoutingUpdate(handler as MessageHandler);
  }

  /**
   * 訂閱系統通知事件
   */
  onNotification(handler: (notif: unknown) => void): void {
    this.ws.onNotification(handler as MessageHandler);
  }

  /**
   * 訂閱互助請求事件
   */
  onAidRequest(handler: (req: unknown) => void): void {
    this.ws.onAidRequest(handler as MessageHandler);
  }

  /**
   * 訂閱聊天室訊息事件
   */
  onChatMessage(handler: (msg: unknown) => void): void {
    this.ws.onChatMessage(handler as MessageHandler);
  }

  // ===== 私有輔助方法 =====

  /**
   * 從 DB 讀取裝置資料
   */
  private loadDevice(): DeviceRow | null {
    const rows = this.db.query<DeviceRow>(
      `SELECT device_id, device_token, device_token_expires_at, device_fingerprint
       FROM device LIMIT 1`
    );
    return rows[0] ?? null;
  }

  /**
   * 判斷 token 是否在 7 天內過期
   */
  private isTokenExpiringSoon(expiresAt: string | null): boolean {
    if (!expiresAt) return true;

    const expiry = new Date(expiresAt).getTime();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    return expiry - now < sevenDaysMs;
  }

  /**
   * 產生新的裝置 ID（UUID v4 格式）
   */
  private generateDeviceId(): string {
    return crypto.randomUUID();
  }

  /**
   * 產生裝置指紋（基於平台資訊的簡化版本）
   */
  private generateFingerprint(): string {
    const parts = [
      process.platform,
      process.arch,
      process.version,
    ];
    return Buffer.from(parts.join(':'), 'utf8').toString('base64');
  }
}
