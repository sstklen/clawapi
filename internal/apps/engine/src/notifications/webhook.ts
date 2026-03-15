// Webhook 發送器 — HTTP POST + HMAC-SHA256 簽名 + 重試
// 把通知事件發送到用戶設定的 URL

import type { NotificationPayload } from './manager';

// ===== 型別定義 =====

/** Webhook 發送結果 */
export interface WebhookResult {
  success: boolean;
  status_code?: number;
  error?: string;
  attempts: number;
}

// ===== 常數 =====

/** 最大重試次數 */
const MAX_RETRIES = 3;
/** 請求超時（ms） */
const TIMEOUT_MS = 10_000;
/** 重試間隔基數（ms），指數退避 */
const RETRY_BASE_MS = 1000;

/** [HIGH-3 修復] 禁止的內網主機名 — 防 SSRF */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '::1',
  '169.254.169.254', // AWS/GCP metadata
]);

// ===== Webhook 發送器 =====

/**
 * WebhookSender：HTTP Webhook 發送器
 *
 * 功能：
 * 1. POST JSON payload 到指定 URL
 * 2. HMAC-SHA256 簽名（如果有 secret）— 含時間戳防重放
 * 3. 指數退避重試（最多 3 次）
 * 4. 10 秒超時
 * 5. SSRF 防護（阻擋內網地址）
 */
export class WebhookSender {
  /**
   * 發送 Webhook
   *
   * @param url 目標 URL
   * @param payload 通知資料
   * @param secret HMAC 簽名密鑰（可選）
   */
  async send(
    url: string,
    payload: NotificationPayload,
    secret?: string
  ): Promise<WebhookResult> {
    // [HIGH-3 修復] SSRF 防護 — 驗證 URL
    this.validateUrl(url);

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ClawAPI-Webhook/1.0',
      'X-ClawAPI-Event': payload.event,
      'X-ClawAPI-Timestamp': payload.timestamp,
    };

    // 加上 HMAC 簽名
    if (secret) {
      // [MEDIUM-5 修復] 簽名內容包含時間戳，防止重放攻擊
      // 格式：timestamp.body（接收方應驗證時間戳在 5 分鐘內）
      const signedContent = `${payload.timestamp}.${body}`;
      const signature = await this.sign(signedContent, secret);
      headers['X-ClawAPI-Signature'] = `sha256=${signature}`;
    }

    // 重試邏輯
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          return { success: true, status_code: response.status, attempts: attempt };
        }

        // 4xx 不重試（用戶端錯誤）
        if (response.status >= 400 && response.status < 500) {
          return {
            success: false,
            status_code: response.status,
            error: `HTTP ${response.status}`,
            attempts: attempt,
          };
        }

        // 5xx 重試
        lastError = `HTTP ${response.status}`;
      } catch (err) {
        lastError = (err as Error).message;
      }

      // 指數退避等待（最後一次不等）
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    return {
      success: false,
      error: lastError ?? 'Unknown error',
      attempts: MAX_RETRIES,
    };
  }

  /**
   * HMAC-SHA256 簽名
   */
  async sign(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(payload)
    );
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * [HIGH-3 修復] URL 驗證 — 防止 SSRF 攻擊
   * 阻擋內網地址、私有 IP、雲 metadata 端點
   */
  private validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`無效的 Webhook URL: ${url}`);
    }

    // 只允許 http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Webhook URL 協議不支援: ${parsed.protocol}`);
    }

    const hostname = parsed.hostname;

    // 阻擋已知的內網主機名
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new Error(`Webhook URL 不能指向內網地址: ${hostname}`);
    }

    // 阻擋私有 IP 段
    if (
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('172.17.') ||
      hostname.startsWith('172.18.') ||
      hostname.startsWith('172.19.') ||
      hostname.startsWith('172.2') ||
      hostname.startsWith('172.30.') ||
      hostname.startsWith('172.31.') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      throw new Error(`Webhook URL 不能指向私有網路: ${hostname}`);
    }
  }
}
