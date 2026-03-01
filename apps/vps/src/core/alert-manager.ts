// 告警管理器
// 負責 VPS 所有告警的去重、發送、歷史記錄
// 主要通知管道：Telegram；Discord 預留介面

import type { VPSDatabase } from '../storage/database';

// ===== 型別定義 =====

// 告警嚴重度
export type AlertSeverity = 'info' | 'warning' | 'critical';

// 告警輸入
export interface AlertInput {
  severity: AlertSeverity;
  category: string;       // 分類鍵（用於去重）
  message: string;        // 告警主訊息
  suggestion?: string;    // 可選的建議動作
}

// 完整告警記錄（含 ID 和時間戳）
export interface Alert extends AlertInput {
  id: string;
  sentAt: number;         // Unix timestamp（毫秒）
}

// 告警發送結果
export interface AlertResult {
  sent: boolean;          // true = 已發送，false = 去重跳過
  reason?: string;        // 若未發送，說明原因
}

// Telegram 設定
export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

// ===== 常數 =====

// 去重窗口：1 小時（毫秒）
const DEDUP_WINDOW_MS = 60 * 60 * 1000;

// 嚴重度表情符號（Telegram 格式化用）
const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

// ===== AlertManager 主類別 =====

export class AlertManager {
  private db: VPSDatabase;
  private telegramConfig: TelegramConfig | null;

  // 去重快取：Map<alertKey, lastSentAt（毫秒）>
  // alertKey = `${severity}:${category}`
  private recentAlerts: Map<string, number> = new Map();

  private readonly DEDUP_WINDOW = DEDUP_WINDOW_MS;

  constructor(
    db: VPSDatabase,
    telegramConfig?: TelegramConfig,
  ) {
    this.db = db;
    this.telegramConfig = telegramConfig ?? null;
  }

  // ===== 主要 API =====

  // 發送告警
  // 返回：true = 已發送，false = 去重跳過
  async sendAlert(alert: AlertInput): Promise<boolean> {
    const key = this.buildKey(alert.severity, alert.category);

    // 去重檢查
    if (this.isDuplicate(key)) {
      return false;
    }

    // 記錄發送時間（發送前先記，避免重複）
    this.recentAlerts.set(key, Date.now());

    // 格式化訊息
    const formattedMessage = this.formatMessage(alert);

    // 嘗試發送 Telegram
    if (this.telegramConfig) {
      try {
        await this.sendTelegram(formattedMessage);
      } catch (err) {
        console.error('[AlertManager] Telegram 發送失敗:', err);
        // 發送失敗不阻止寫入 DB
      }
    }

    // 寫入 alert_history 表
    try {
      await this.saveToDb(alert);
    } catch (err) {
      console.error('[AlertManager] 告警寫入 DB 失敗:', err);
    }

    return true;
  }

  // 批量發送（自動去重）
  async sendAlerts(alerts: AlertInput[]): Promise<AlertResult[]> {
    const results: AlertResult[] = [];
    for (const alert of alerts) {
      const sent = await this.sendAlert(alert);
      results.push({
        sent,
        reason: sent ? undefined : '去重跳過（1 小時內已發送相同告警）',
      });
    }
    return results;
  }

  // 清除去重快取（測試用 / 手動重置）
  clearDedupeCache(): void {
    this.recentAlerts.clear();
  }

  // 清除過期快取（定期呼叫，避免記憶體洩漏）
  cleanExpiredCache(): void {
    const now = Date.now();
    const cutoff = now - this.DEDUP_WINDOW;
    for (const [key, sentAt] of this.recentAlerts.entries()) {
      if (sentAt < cutoff) {
        this.recentAlerts.delete(key);
      }
    }
  }

  // 查詢告警歷史（最近 N 筆）
  getHistory(limit = 50): AlertHistoryRow[] {
    return this.db.query<AlertHistoryRow>(
      `SELECT * FROM alert_history ORDER BY sent_at DESC LIMIT ?`,
      [limit],
    );
  }

  // 測試用：取得去重快取大小
  _getCacheSize(): number {
    return this.recentAlerts.size;
  }

  // 測試用：直接注入快取條目
  _injectCache(severity: AlertSeverity, category: string, sentAt: number): void {
    const key = this.buildKey(severity, category);
    this.recentAlerts.set(key, sentAt);
  }

  // ===== 私有方法 =====

  // 構建去重鍵
  private buildKey(severity: AlertSeverity, category: string): string {
    return `${severity}:${category}`;
  }

  // 檢查是否為重複告警（1 小時內已發送相同類型）
  private isDuplicate(key: string): boolean {
    const lastSentAt = this.recentAlerts.get(key);
    if (lastSentAt === undefined) return false;
    return Date.now() - lastSentAt < this.DEDUP_WINDOW;
  }

  // 格式化告警訊息（Telegram Markdown 格式）
  private formatMessage(alert: AlertInput): string {
    const emoji = SEVERITY_EMOJI[alert.severity];
    const severityLabel = alert.severity.toUpperCase();
    const timestamp = new Date().toISOString();

    let msg = `${emoji} *[ClawAPI VPS] ${severityLabel}*\n`;
    msg += `📁 分類：\`${alert.category}\`\n`;
    msg += `📋 訊息：${alert.message}\n`;

    if (alert.suggestion) {
      msg += `💡 建議：${alert.suggestion}\n`;
    }

    msg += `🕐 時間：${timestamp}`;

    return msg;
  }

  // 發送 Telegram 通知（使用 Bot API）
  private async sendTelegram(message: string): Promise<void> {
    if (!this.telegramConfig) return;

    const { botToken, chatId } = this.telegramConfig;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API 錯誤 ${response.status}: ${body}`);
    }
  }

  // 預留 Discord 通知管道（日後實作）
  private async sendDiscord(_message: string): Promise<void> {
    // TODO: 實作 Discord webhook 通知
    // const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    // if (!webhookUrl) return;
    // await fetch(webhookUrl, { method: 'POST', ... });
  }

  // 寫入告警歷史到 DB
  private async saveToDb(alert: AlertInput): Promise<void> {
    const channel = this.telegramConfig ? 'telegram' : 'none';
    this.db.run(
      `INSERT INTO alert_history (severity, channel, message, sent_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [
        alert.severity,
        channel,
        alert.suggestion
          ? `[${alert.category}] ${alert.message} | 建議：${alert.suggestion}`
          : `[${alert.category}] ${alert.message}`,
      ],
    );
  }
}

// DB 告警歷史記錄格式
export interface AlertHistoryRow {
  id: number;
  severity: string;
  channel: string;
  message: string;
  sent_at: string;
}

// ===== 全域單例 =====

let _alertManager: AlertManager | null = null;

export function initAlertManager(
  db: VPSDatabase,
  telegramConfig?: TelegramConfig,
): AlertManager {
  _alertManager = new AlertManager(db, telegramConfig);
  return _alertManager;
}

export function getAlertManager(): AlertManager | null {
  return _alertManager;
}
