// 頻道管理模組
// 負責聊天頻道（chat:general, chat:help）的訂閱、廣播、加入/離開通知
// 系統頻道（routing, notifications）所有連線自動訂閱，不需要手動管理

import {
  WS_CHANNELS,
  WS_RATE_LIMITS,
  CHAT_MESSAGE_MAX_LENGTH,
  ErrorCode,
} from '@clawapi/protocol';
import type { WSServerMessage } from '@clawapi/protocol';
import type {
  WSConnectionInfo,
  ChatChannel,
  SystemChannel,
  SubscribableChannel,
  ChatMessagePayload,
  ChatPresencePayload,
} from './types';

// 允許訂閱的系統頻道
export const ALLOWED_SYSTEM_CHANNELS: SystemChannel[] = ['routing', 'notifications'];

// 允許訂閱的聊天頻道名稱（不含 chat: 前綴）
export const ALLOWED_CHAT_CHANNEL_NAMES = ['general', 'help'] as const;
export type ChatChannelName = typeof ALLOWED_CHAT_CHANNEL_NAMES[number];

// 聊天頻道名稱 → 完整識別符的轉換
export function toChatChannel(name: ChatChannelName): ChatChannel {
  return `chat:${name}` as ChatChannel;
}

// 聊天訊息頻率限制（每 5 秒最多 1 則）
export const CHAT_RATE_LIMIT = WS_RATE_LIMITS.chat;

// ===== 頻道訂閱邏輯 =====

// 解析 subscribe 請求中的頻道列表
// 回傳：{ valid: 驗證通過的系統頻道[], chatChannels: 驗證通過的聊天頻道[] }
export function parseSubscribeRequest(
  channels?: string[],
  chatChannels?: string[],
): { systemChannels: SystemChannel[]; chatChannels: ChatChannel[] } {
  const systemChannels: SystemChannel[] = [];
  const parsedChatChannels: ChatChannel[] = [];

  // 驗證並過濾系統頻道（只允許 routing, notifications）
  if (channels && Array.isArray(channels)) {
    for (const ch of channels) {
      if (ALLOWED_SYSTEM_CHANNELS.includes(ch as SystemChannel)) {
        systemChannels.push(ch as SystemChannel);
      }
    }
  }

  // 驗證並過濾聊天頻道（只允許 general, help）
  if (chatChannels && Array.isArray(chatChannels)) {
    for (const name of chatChannels) {
      if (ALLOWED_CHAT_CHANNEL_NAMES.includes(name as ChatChannelName)) {
        parsedChatChannels.push(toChatChannel(name as ChatChannelName));
      }
    }
  }

  return { systemChannels, chatChannels: parsedChatChannels };
}

// 將頻道加入連線的訂閱集合
// 回傳：實際加入的頻道列表（包含系統頻道和聊天頻道）
export function subscribeToChannels(
  conn: WSConnectionInfo,
  systemChannels: SystemChannel[],
  chatChannels: ChatChannel[],
): SubscribableChannel[] {
  const subscribed: SubscribableChannel[] = [];

  // 訂閱系統頻道
  for (const ch of systemChannels) {
    conn.subscriptions.add(ch);
    subscribed.push(ch);
  }

  // 訂閱聊天頻道
  for (const ch of chatChannels) {
    conn.subscriptions.add(ch);
    subscribed.push(ch);
  }

  return subscribed;
}

// 從連線移除聊天頻道訂閱
export function unsubscribeFromChatChannels(
  conn: WSConnectionInfo,
  chatChannels: ChatChannel[],
): void {
  for (const ch of chatChannels) {
    conn.subscriptions.delete(ch);
  }
}

// ===== 訊息驗證 =====

// 驗證聊天訊息格式與長度
// 回傳：null = 通過，ErrorCode = 拒絕原因
export function validateChatMessage(
  payload: unknown,
): { valid: boolean; errorCode?: ErrorCode; text?: string; channel?: string } {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errorCode: ErrorCode.WS_INVALID_MESSAGE_FORMAT };
  }

  const msg = payload as ChatMessagePayload;

  // 確認頻道有效
  if (!msg.channel || !ALLOWED_CHAT_CHANNEL_NAMES.includes(msg.channel as ChatChannelName)) {
    return { valid: false, errorCode: ErrorCode.WS_SUBSCRIBE_INVALID };
  }

  // 確認文字存在
  if (!msg.text || typeof msg.text !== 'string') {
    return { valid: false, errorCode: ErrorCode.WS_INVALID_MESSAGE_FORMAT };
  }

  // 確認長度限制（CHAT_MESSAGE_MAX_LENGTH = 500 字元）
  if (msg.text.length > CHAT_MESSAGE_MAX_LENGTH) {
    return { valid: false, errorCode: ErrorCode.WS_CHAT_MESSAGE_TOO_LONG };
  }

  return { valid: true, text: msg.text, channel: msg.channel };
}

// ===== 頻道廣播工具 =====

// 建立伺服器端訊息（自動帶 server_time）
export function buildServerMessage(
  type: string,
  channel: string,
  payload: unknown,
  id?: string,
): WSServerMessage {
  return {
    type,
    channel,
    id: id ?? crypto.randomUUID(),
    payload,
    server_time: new Date().toISOString(),
  };
}

// 向指定頻道的所有訂閱者廣播（排除特定 deviceId）
// 回傳：成功傳送的連線數
export function broadcastToChannel(
  connections: Map<string, WSConnectionInfo>,
  channel: SubscribableChannel,
  message: WSServerMessage,
  excludeDeviceId?: string,
): number {
  let count = 0;
  const data = JSON.stringify(message);

  for (const [deviceId, conn] of connections.entries()) {
    if (excludeDeviceId && deviceId === excludeDeviceId) continue;
    if (!conn.subscriptions.has(channel)) continue;

    try {
      conn.socket.send(data);
      count++;
    } catch {
      // 傳送失敗（連線可能已斷開），忽略錯誤
    }
  }

  return count;
}

// 建立聊天室加入/離開通知訊息
export function buildPresenceMessage(
  channel: ChatChannel,
  deviceId: string,
  onlineCount: number,
  event: 'join' | 'leave',
): WSServerMessage {
  const payload: ChatPresencePayload = {
    channel: channel.replace('chat:', ''),
    device_id: deviceId,
    online_count: onlineCount,
    event,
  };

  return buildServerMessage('chat_presence', channel, payload);
}

// 計算特定聊天頻道的線上人數
export function getChatChannelOnlineCount(
  connections: Map<string, WSConnectionInfo>,
  channel: ChatChannel,
): number {
  let count = 0;
  for (const conn of connections.values()) {
    if (conn.subscriptions.has(channel)) count++;
  }
  return count;
}

// 取得連線所有訂閱的聊天頻道
export function getConnectionChatChannels(conn: WSConnectionInfo): ChatChannel[] {
  const chatChannels: ChatChannel[] = [];
  for (const ch of conn.subscriptions) {
    if (ch.startsWith('chat:')) {
      chatChannels.push(ch as ChatChannel);
    }
  }
  return chatChannels;
}

// 重新 export 協議常數
export { WS_CHANNELS, CHAT_MESSAGE_MAX_LENGTH };
