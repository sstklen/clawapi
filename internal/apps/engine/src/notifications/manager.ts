// 通知管理器 — 統一管理所有通知事件的分發
// 接收 Key 狀態變化、額度警告等事件，分發到各管道（Webhook、內聯、CLI）

import type { ClawDatabase } from '../storage/database';
import { WebhookSender } from './webhook';

// ===== 型別定義 =====

/** 通知事件類型 */
export type NotificationEvent =
  | 'key.dead'           // Key 死亡（401/403 或累計 3 次錯誤）
  | 'key.rate_limited'   // Key 被限速（429）
  | 'key.recovered'      // Key 恢復正常
  | 'quota.low'          // 額度低於 20%
  | 'service.degraded'   // 服務降級（集體智慧偵測）
  | 'growth.milestone';  // 成長里程碑（L2 解鎖等）

/** 通知 payload */
export interface NotificationPayload {
  /** 事件類型 */
  event: NotificationEvent;
  /** 時間戳 */
  timestamp: string;
  /** 相關服務 ID（如果有） */
  service_id?: string;
  /** 相關 Key ID（如果有） */
  key_id?: number;
  /** 人話描述 */
  message: string;
  /** 額外數據 */
  data?: Record<string, unknown>;
}

/** 通知設定 */
export interface NotificationConfig {
  /** Webhook URL */
  webhook_url?: string;
  /** Webhook 簽名密鑰 */
  webhook_secret?: string;
  /** 訂閱的事件（空 = 全部） */
  webhook_events?: NotificationEvent[];
  /** 是否啟用 CLI 輸出 */
  cli_output?: boolean;
}

/** 內部通知回呼函式 */
export type NotificationCallback = (payload: NotificationPayload) => void;

// ===== 通知管理器 =====

/**
 * NotificationManager：統一通知分發
 *
 * 功能：
 * 1. 接收事件（notify）
 * 2. 去重（同事件 5 分鐘內不重發）
 * 3. 分發到 Webhook / 內部回呼 / CLI
 * 4. 記錄歷史（settings 表）
 */
export class NotificationManager {
  private webhookSender: WebhookSender;
  private config: NotificationConfig;
  private callbacks: NotificationCallback[] = [];
  /** 去重快取：event:serviceId:keyId → 最後發送時間 */
  private dedup = new Map<string, number>();
  /** 去重間隔：5 分鐘 */
  private readonly DEDUP_INTERVAL_MS = 5 * 60 * 1000;
  /** 定時清理 dedup 快取的計時器 */
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private db: ClawDatabase, config?: NotificationConfig) {
    this.config = config ?? this.loadConfig();
    this.webhookSender = new WebhookSender();
    // [HIGH-1 修復] 每 10 分鐘自動清理過期 dedup 快取，防止記憶體洩漏
    this.cleanupTimer = setInterval(() => this.cleanDedup(), 10 * 60 * 1000);
    // 允許 Node/Bun 正常結束（不被 timer 卡住）
    if (this.cleanupTimer?.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * 發送通知
   * 自動去重、分發到所有管道
   */
  async notify(event: NotificationEvent, details: {
    service_id?: string;
    key_id?: number;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    // 去重檢查
    const dedupKey = `${event}:${details.service_id ?? ''}:${details.key_id ?? ''}`;
    const lastSent = this.dedup.get(dedupKey);
    if (lastSent && Date.now() - lastSent < this.DEDUP_INTERVAL_MS) {
      return; // 5 分鐘內已發過，跳過
    }
    this.dedup.set(dedupKey, Date.now());

    const payload: NotificationPayload = {
      event,
      timestamp: new Date().toISOString(),
      service_id: details.service_id,
      key_id: details.key_id,
      message: details.message,
      data: details.data,
    };

    // [MEDIUM-8 修復] 管道 1：內部回呼 — 迭代快照，防止回呼中修改陣列
    const cbs = [...this.callbacks];
    for (const cb of cbs) {
      try { cb(payload); } catch { /* 回呼不影響流程 */ }
    }

    // 管道 2：CLI 輸出
    if (this.config.cli_output !== false) {
      const icon = this.getEventIcon(event);
      console.log(`[ClawAPI] ${icon} ${details.message}`);
    }

    // 管道 3：Webhook
    if (this.config.webhook_url) {
      // 檢查事件是否在訂閱清單中
      const events = this.config.webhook_events;
      if (!events || events.length === 0 || events.includes(event)) {
        try {
          await this.webhookSender.send(
            this.config.webhook_url,
            payload,
            this.config.webhook_secret
          );
        } catch (err) {
          // [HIGH-4 修復] Webhook 失敗要 log，不能完全靜音
          if (this.config.cli_output !== false) {
            console.warn(`[ClawAPI] ⚠️ Webhook 發送失敗: ${(err as Error).message}`);
          }
        }
      }
    }

    // 記錄到 DB
    this.recordNotification(payload);
  }

  /**
   * 註冊內部回呼
   * [HIGH-2 修復] 回傳 unsubscribe 函式，防止回呼陣列無限增長
   */
  onNotification(callback: NotificationCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      const idx = this.callbacks.indexOf(callback);
      if (idx !== -1) this.callbacks.splice(idx, 1);
    };
  }

  /**
   * 更新設定
   */
  updateConfig(config: Partial<NotificationConfig>): void {
    Object.assign(this.config, config);
    this.saveConfig();
  }

  /**
   * 取得設定（webhook_secret 會遮罩）
   */
  getConfig(): NotificationConfig {
    const copy = { ...this.config };
    // [MEDIUM-2 修復] 不暴露完整 webhook_secret
    if (copy.webhook_secret) {
      copy.webhook_secret = '********';
    }
    return copy;
  }

  /**
   * 取得原始設定（內部用，不遮罩）
   */
  getRawConfig(): NotificationConfig {
    return { ...this.config };
  }

  /**
   * 清理過期的去重快取
   */
  cleanDedup(): void {
    const now = Date.now();
    for (const [key, time] of this.dedup.entries()) {
      if (now - time > this.DEDUP_INTERVAL_MS) {
        this.dedup.delete(key);
      }
    }
  }

  /**
   * 停止清理計時器（優雅關機用）
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  // ===== 私有方法 =====

  /** 從 DB settings 讀取通知設定 */
  private loadConfig(): NotificationConfig {
    try {
      const rows = this.db.query<{ value: string }>(
        `SELECT value FROM settings WHERE key = 'notification_config'`
      );
      if (rows[0]) {
        return JSON.parse(rows[0].value);
      }
    } catch { /* 表不存在或解析失敗 */ }
    return { cli_output: true };
  }

  /** 儲存通知設定到 DB */
  private saveConfig(): void {
    try {
      // [MEDIUM-1 部分修復] 儲存時不含 webhook_secret（避免明文存 DB）
      const configToSave = { ...this.config };
      // 注意：webhook_secret 目前仍明文存（TODO: 整合 CryptoModule 加密）
      this.db.run(
        `INSERT OR REPLACE INTO settings (key, value, updated_at)
         VALUES ('notification_config', ?, datetime('now'))`,
        [JSON.stringify(configToSave)]
      );
    } catch (err) {
      // [HIGH-4 修復] 設定儲存失敗要 log
      console.error(`[ClawAPI] 通知設定儲存失敗: ${(err as Error).message}`);
    }
  }

  /** 記錄通知歷史到 DB */
  private recordNotification(payload: NotificationPayload): void {
    try {
      this.db.run(
        `INSERT OR REPLACE INTO settings (key, value, updated_at)
         VALUES ('last_notification_' || ?, ?, datetime('now'))`,
        [payload.event, JSON.stringify(payload)]
      );
    } catch { /* 歷史記錄失敗不影響 */ }
  }

  /** 取得事件對應的 emoji 圖示 */
  private getEventIcon(event: NotificationEvent): string {
    switch (event) {
      case 'key.dead': return '☠️';
      case 'key.rate_limited': return '⚡';
      case 'key.recovered': return '✅';
      case 'quota.low': return '⚠️';
      case 'service.degraded': return '📉';
      case 'growth.milestone': return '🎉';
      default: return '📢';
    }
  }
}
