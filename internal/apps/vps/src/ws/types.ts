// WebSocket 相關型別定義
// VPS 端 WebSocket 管理器使用的所有型別（SPEC-C §5）

import type { WSClientMessage, WSServerMessage } from '@clawapi/protocol';

// 重新 export 協議共享型別，方便其他模組從此處統一引入
export type { WSClientMessage, WSServerMessage };

// 聊天頻道識別符（chat: 前綴 + 頻道名稱）
export type ChatChannel = 'chat:general' | 'chat:help';

// 系統頻道識別符
export type SystemChannel = 'routing' | 'notifications';

// 所有可訂閱的頻道
export type SubscribableChannel = SystemChannel | ChatChannel;

// Rate Limit 計數紀錄（用於 WS 層級限流）
export interface WSRateLimitEntry {
  count: number;
  windowStart: number;  // 窗口開始時間（ms）
}

// Rate Limit 類型分類
export type WSRateLimitType = 'chat' | 'aid_response' | 'other';

// WebSocket 連線資訊（每條連線一份）
export interface WSConnectionInfo {
  deviceId: string;
  region: string;
  version: string;
  socket: WebSocket;                         // Bun 原生 WebSocket 物件
  subscriptions: Set<SubscribableChannel>;  // 已訂閱的頻道集合
  pingInterval: ReturnType<typeof setInterval> | null;  // Ping 計時器
  pongTimeout: ReturnType<typeof setTimeout> | null;    // Pong 超時計時器
  offlineQueue: WSServerMessage[];           // 離線訊息佇列
  // Rate limit 計數器（各類型獨立計算）
  rateLimits: Map<WSRateLimitType, WSRateLimitEntry>;
  rateLimitViolations: number;               // 連續超限次數
  rateLimitBannedUntil: number | null;       // 封禁截止時間（ms），null 表示未封禁
  connectedAt: number;                       // 連線時間（ms）
  lastPingSentAt: number | null;             // 最後 ping 發送時間
}

// WebSocket 升級請求的查詢參數
export interface WSUpgradeParams {
  device_id: string;
  token: string;
  version: string;
}

// subscribe 訊息的 payload
export interface SubscribePayload {
  channels?: string[];       // 系統頻道：['routing', 'notifications']
  chat_channels?: string[];  // 聊天頻道：['general', 'help']
}

// subscribe_ack 訊息的 payload
export interface SubscribeAckPayload {
  subscribed: string[];
  online_count: number;
}

// chat_message 訊息的 payload
export interface ChatMessagePayload {
  channel: string;     // 'general' | 'help'
  text: string;
  nickname?: string;
  reply_to?: string | null;
}

// 頻道加入/離開通知的 payload
export interface ChatPresencePayload {
  channel: string;
  device_id: string;
  online_count: number;
  event: 'join' | 'leave';
}
