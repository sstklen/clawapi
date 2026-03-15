// 聊天室中繼服務
// 負責聊天訊息的驗證、限流、廣播，以及線上人數管理
// 依據 SPEC-C §5 實作，透過 wsManager 公開 API 操作 WebSocket 層

import {
  ErrorCode,
  CHAT_MESSAGE_MAX_LENGTH,
} from '@clawapi/protocol';
import type { WebSocketManager } from '../ws/manager';

// ===== 內部型別定義 =====

// 聊天訊息輸入（來自客戶端）
export interface ChatMessageInput {
  channel: string;          // 頻道名稱（不含 chat: 前綴），例如 'general'
  text: string;             // 訊息內容
  nickname?: string;        // 暱稱（可選）
  reply_to?: string | null; // 回覆目標訊息 ID（可選）
}

// 聊天訊息廣播結果
export interface ChatRelayResult {
  ok: true;
  messageId: string;
  channel: string;
  serverTime: string;
}

// 廣播錯誤結果
export interface ChatRelayError {
  ok: false;
  errorCode: ErrorCode;
}

// 到場通知類型
export type PresenceType = 'join' | 'leave';

// ===== ChatRateLimiter 內部類別 =====
// 管理兩層限流：5 秒冷卻（單條）+ 每分鐘最多 10 則（防自動化）

export class ChatRateLimiter {
  // 每個裝置最後發訊時間（毫秒），用於 5 秒冷卻
  private lastMessageTime: Map<string, number> = new Map();

  // 每個裝置的滑動視窗計數（每分鐘 10 則）
  // 格式：{ windowStart: ms, count: number }
  private messageCountWindow: Map<string, { windowStart: number; count: number }> = new Map();

  // 5 秒冷卻時間（毫秒）
  private readonly COOLDOWN_MS = 5_000;

  // 每分鐘最多 10 則
  private readonly MAX_PER_MINUTE = 10;

  // 分鐘視窗（毫秒）
  private readonly WINDOW_MS = 60_000;

  // 檢查裝置是否通過限流
  // 回傳：null = 允許，ErrorCode = 拒絕原因
  check(deviceId: string): ErrorCode | null {
    const now = Date.now();

    // ===== 第一層：5 秒冷卻 =====
    const lastTime = this.lastMessageTime.get(deviceId);
    if (lastTime !== undefined && now - lastTime < this.COOLDOWN_MS) {
      return ErrorCode.WS_CHAT_RATE_LIMITED;
    }

    // ===== 第二層：每分鐘 10 則 =====
    const windowEntry = this.messageCountWindow.get(deviceId);
    if (windowEntry) {
      if (now - windowEntry.windowStart < this.WINDOW_MS) {
        // 在同一視窗內
        if (windowEntry.count >= this.MAX_PER_MINUTE) {
          return ErrorCode.WS_CHAT_RATE_LIMITED;
        }
        // 計數加一
        windowEntry.count++;
      } else {
        // 視窗已過期，重置
        this.messageCountWindow.set(deviceId, { windowStart: now, count: 1 });
      }
    } else {
      // 新裝置，建立視窗
      this.messageCountWindow.set(deviceId, { windowStart: now, count: 1 });
    }

    // 更新最後發訊時間
    this.lastMessageTime.set(deviceId, now);
    return null;
  }

  // 清除指定裝置的限流狀態（測試用）
  clear(deviceId: string): void {
    this.lastMessageTime.delete(deviceId);
    this.messageCountWindow.delete(deviceId);
  }

  // 清除所有限流狀態（測試用）
  clearAll(): void {
    this.lastMessageTime.clear();
    this.messageCountWindow.clear();
  }
}

// ===== ChatRelay 主類別 =====

export class ChatRelay {
  private wsManager: WebSocketManager;
  private rateLimiter: ChatRateLimiter;

  // 裝置最後活動時間（用於 getOnlineCount 的 15 分鐘活動判定）
  private lastActivityTime: Map<string, number> = new Map();

  // 活動判定視窗（15 分鐘）
  private readonly ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

  constructor(wsManager: WebSocketManager) {
    this.wsManager = wsManager;
    this.rateLimiter = new ChatRateLimiter();
  }

  // ===== 核心功能：處理聊天訊息 =====
  // 驗證 → 限流 → 廣播 → 回傳結果

  handleChatMessage(
    deviceId: string,
    message: ChatMessageInput,
  ): ChatRelayResult | ChatRelayError {
    // ===== 1. 驗證訊息長度 =====
    if (!message.text || typeof message.text !== 'string') {
      return { ok: false, errorCode: ErrorCode.WS_INVALID_MESSAGE_FORMAT };
    }

    if (message.text.length > CHAT_MESSAGE_MAX_LENGTH) {
      return { ok: false, errorCode: ErrorCode.WS_CHAT_MESSAGE_TOO_LONG };
    }

    // ===== 2. 限流檢查 =====
    const rateLimitError = this.rateLimiter.check(deviceId);
    if (rateLimitError !== null) {
      return { ok: false, errorCode: rateLimitError };
    }

    // ===== 3. 更新裝置活動時間 =====
    this.lastActivityTime.set(deviceId, Date.now());

    // ===== 4. 組裝頻道識別符 =====
    // 頻道格式：chat:{channelName}
    const channelName = message.channel;
    const fullChannel = `chat:${channelName}` as const;

    // ===== 5. 組裝伺服器訊息（匿名化）=====
    // 重要：sender_device_id 永遠為 null，保護發送者隱私
    const messageId = crypto.randomUUID();
    const serverTime = new Date().toISOString();

    const serverPayload = {
      text: message.text,
      nickname: message.nickname || '匿名龍蝦',
      sender_device_id: null as null,  // 匿名！永遠不揭露發送者身份
      reply_to: message.reply_to ?? null,
    };

    const serverMessage = {
      type: 'chat_message',
      channel: fullChannel,
      id: messageId,
      payload: serverPayload,
      server_time: serverTime,
    };

    // ===== 6. 廣播給所有訂閱者 =====
    // 透過 wsManager 的 broadcastToChannel 廣播
    this.wsManager.broadcastToChannel(
      fullChannel as Parameters<WebSocketManager['broadcastToChannel']>[0],
      serverMessage.payload,
    );

    return {
      ok: true,
      messageId,
      channel: fullChannel,
      serverTime,
    };
  }

  // ===== 線上人數計算 =====
  // 條件：WS 連線中（wsManager 有記錄）OR 15 分鐘內有活動
  getOnlineCount(): number {
    const now = Date.now();
    const wsOnlineCount = this.wsManager.getOnlineCount();

    // 計算近 15 分鐘有活動但可能已離線的裝置（去重）
    let recentActiveCount = 0;
    for (const [, lastTime] of this.lastActivityTime.entries()) {
      if (now - lastTime <= this.ACTIVITY_WINDOW_MS) {
        recentActiveCount++;
      }
    }

    // 取最大值（WS 線上數 vs 近期活躍數）
    return Math.max(wsOnlineCount, recentActiveCount);
  }

  // ===== 廣播到場通知 =====
  // 當裝置加入或離開頻道時廣播系統訊息
  broadcastPresenceChange(channel: string, type: PresenceType): void {
    const fullChannel = `chat:${channel}` as const;
    const onlineCount = this.wsManager.getOnlineCount();

    const presencePayload = {
      channel,
      event: type,
      online_count: onlineCount,
    };

    // 廣播到場通知
    this.wsManager.broadcastToChannel(
      fullChannel as Parameters<WebSocketManager['broadcastToChannel']>[0],
      presencePayload,
    );
  }

  // ===== 測試輔助方法 =====

  // 取得 rateLimiter（測試用）
  getRateLimiter(): ChatRateLimiter {
    return this.rateLimiter;
  }

  // 設定裝置最後活動時間（測試用）
  setLastActivity(deviceId: string, timeMs: number): void {
    this.lastActivityTime.set(deviceId, timeMs);
  }
}
