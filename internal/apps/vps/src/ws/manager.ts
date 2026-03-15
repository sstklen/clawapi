// WebSocket 管理器（主模組）
// 負責所有 WebSocket 連線的生命週期管理：認證、訂閱、訊息處理、保活、離線佇列、限流
// 依據 SPEC-C §5 實作，不依賴 Hono WS 輔助，使用 Bun 原生 WebSocket 支援

import {
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WS_OFFLINE_QUEUE_MAX,
  WS_RATE_LIMITS,
  WS_RATE_LIMIT_DISCONNECT_THRESHOLD,
  WS_RATE_LIMIT_BAN_MS,
  ErrorCode,
} from '@clawapi/protocol';
import { timingSafeEqual } from 'node:crypto';
import type { WSServerMessage } from '@clawapi/protocol';
import type { VPSDatabase } from '../storage/database';
import type {
  WSConnectionInfo,
  WSRateLimitType,
  WSRateLimitEntry,
  SubscribePayload,
  SubscribableChannel,
  SystemChannel,
} from './types';
import {
  parseSubscribeRequest,
  subscribeToChannels,
  unsubscribeFromChatChannels,
  validateChatMessage,
  buildServerMessage,
  broadcastToChannel,
  buildPresenceMessage,
  getChatChannelOnlineCount,
  getConnectionChatChannels,
  ALLOWED_SYSTEM_CHANNELS,
} from './channels';
import type { ChatChannel } from './types';

// 每個 IP 最多允許的 WebSocket 連線數
const MAX_WS_PER_IP = 20;

// 產生唯一 ID
function generateId(): string {
  return crypto.randomUUID();
}

// ===== WebSocketManager 類別 =====

export class WebSocketManager {
  // 所有活躍連線（device_id → 連線資訊）
  private connections: Map<string, WSConnectionInfo> = new Map();

  // IP 連線計數（ip → 連線數）
  private ipConnectionCount: Map<string, number> = new Map();

  // 資料庫引用（用於驗證 token）
  private db: VPSDatabase;

  constructor(db: VPSDatabase) {
    this.db = db;
  }

  // ===== 連線管理 =====

  // 驗證 WebSocket 升級請求
  // 回傳：{ ok: true, deviceId, region, version } 或 { ok: false, status, errorCode }
  async validateUpgrade(
    deviceId: string | null,
    token: string | null,
    version: string | null,
    clientIp: string,
  ): Promise<
    | { ok: true; deviceId: string; region: string; version: string }
    | { ok: false; status: number; errorCode: ErrorCode }
  > {
    // 驗證必要參數
    if (!deviceId || !token || !version) {
      return { ok: false, status: 401, errorCode: ErrorCode.WS_AUTH_FAILED };
    }

    // 查詢裝置
    const device = this.db.getDevice(deviceId);
    if (!device) {
      return { ok: false, status: 401, errorCode: ErrorCode.WS_AUTH_FAILED };
    }

    // 驗證 token（防 timing attack）
    const tokenMatch = (() => {
      try {
        if (device.device_token.length !== token!.length) return false;
        return timingSafeEqual(Buffer.from(device.device_token), Buffer.from(token!));
      } catch { return false; }
    })();
    if (!tokenMatch) {
      return { ok: false, status: 401, errorCode: ErrorCode.WS_AUTH_FAILED };
    }

    // 驗證 token 未過期
    if (new Date(device.token_expires_at) < new Date()) {
      return { ok: false, status: 401, errorCode: ErrorCode.WS_AUTH_FAILED };
    }

    // 檢查裝置是否被暫停
    if (device.status === 'suspended') {
      return { ok: false, status: 401, errorCode: ErrorCode.WS_AUTH_FAILED };
    }

    // 檢查此裝置是否已被封禁（rate limit ban）
    const existingConn = this.connections.get(deviceId);
    if (existingConn?.rateLimitBannedUntil && Date.now() < existingConn.rateLimitBannedUntil) {
      return { ok: false, status: 429, errorCode: ErrorCode.WS_CHAT_RATE_LIMITED };
    }

    // 檢查 IP 連線數限制（重連同一 device 不計入新連線）
    const isReconnect = this.connections.has(deviceId);
    if (!isReconnect) {
      const currentIpCount = this.ipConnectionCount.get(clientIp) ?? 0;
      if (currentIpCount >= MAX_WS_PER_IP) {
        return { ok: false, status: 429, errorCode: ErrorCode.WS_AUTH_FAILED };
      }
    }

    return {
      ok: true,
      deviceId,
      region: device.region ?? 'unknown',
      version,
    };
  }

  // 登記新連線（升級成功後呼叫）
  registerConnection(
    deviceId: string,
    region: string,
    version: string,
    socket: WebSocket,
    clientIp: string,
  ): void {
    // 如果同一 device 有舊連線，先關閉舊連線
    const oldConn = this.connections.get(deviceId);
    if (oldConn) {
      this._cleanupConnectionResources(deviceId, oldConn);
      try {
        oldConn.socket.close(1000, '新連線取代舊連線');
      } catch {
        // 忽略關閉錯誤
      }
      // 舊連線已替換，不計入新 IP 連線數
    } else {
      // 新連線：更新 IP 連線計數
      const currentCount = this.ipConnectionCount.get(clientIp) ?? 0;
      this.ipConnectionCount.set(clientIp, currentCount + 1);
    }

    // 建立連線資訊
    const connInfo: WSConnectionInfo = {
      deviceId,
      region,
      version,
      socket,
      subscriptions: new Set<SubscribableChannel>(),
      pingInterval: null,
      pongTimeout: null,
      offlineQueue: [],
      rateLimits: new Map<WSRateLimitType, WSRateLimitEntry>(),
      rateLimitViolations: 0,
      rateLimitBannedUntil: null,
      connectedAt: Date.now(),
      lastPingSentAt: null,
    };

    // 系統頻道（routing, notifications）自動訂閱
    for (const ch of ALLOWED_SYSTEM_CHANNELS) {
      connInfo.subscriptions.add(ch as SystemChannel);
    }

    this.connections.set(deviceId, connInfo);

    // 補發離線訊息佇列
    this._flushOfflineQueue(deviceId, connInfo);

    // 啟動 Ping 保活計時器
    this._startPingLoop(deviceId, connInfo);
  }

  // 處理收到的訊息
  handleMessage(deviceId: string, data: string | Buffer): void {
    const conn = this.connections.get(deviceId);
    if (!conn) return;

    // 解析 JSON
    let msg: { type?: string; channel?: string; id?: string; payload?: unknown };
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      this.sendError(deviceId, ErrorCode.WS_INVALID_MESSAGE_FORMAT);
      return;
    }

    if (!msg.type || typeof msg.type !== 'string') {
      this.sendError(deviceId, ErrorCode.WS_INVALID_MESSAGE_FORMAT);
      return;
    }

    // 依訊息類型分發處理
    switch (msg.type) {
      case 'subscribe':
        this._handleSubscribe(deviceId, conn, msg.payload);
        break;

      case 'chat_message':
        this._handleChatMessage(deviceId, conn, msg.payload, msg.id);
        break;

      case 'aid_response':
        this._handleAidResponse(deviceId, conn, msg);
        break;

      case 'aid_data':
        this._handleRateLimitedMessage(deviceId, conn, 'aid_response', () => {
          // aid_data 轉發（目前僅做 rate limit 檢查，實際業務邏輯由路由層處理）
          this._broadcastToChannel('routing', buildServerMessage('aid_data', 'routing', msg.payload, msg.id));
        });
        break;

      case 'subkey_validate_response':
        // Sub-key 驗證回應：轉發給 routing 頻道
        this._broadcastToChannel('routing', buildServerMessage('subkey_validate_response', 'routing', msg.payload, msg.id));
        break;

      case 'pong':
        // 收到 pong：清除 pong 超時計時器
        this._handlePong(deviceId, conn);
        break;

      default:
        this.sendError(deviceId, ErrorCode.WS_INVALID_MESSAGE_FORMAT);
        break;
    }
  }

  // 處理連線關閉（順序重要！）
  handleClose(deviceId: string, clientIp: string): void {
    const conn = this.connections.get(deviceId);
    if (!conn) return;

    // 1. 讀取該連線的聊天頻道列表
    const chatChannels = getConnectionChatChannels(conn);

    // 2. 從各頻道移除該連線（先清訂閱，再廣播，確保計數正確）
    unsubscribeFromChatChannels(conn, chatChannels);

    // 3. 通知聊天室（更新線上人數）
    for (const channel of chatChannels) {
      const onlineCount = getChatChannelOnlineCount(this.connections, channel);
      const presenceMsg = buildPresenceMessage(channel, deviceId, onlineCount, 'leave');
      broadcastToChannel(this.connections, channel, presenceMsg);
    }

    // 4. 刪除該連線的所有訂閱
    conn.subscriptions.clear();

    // 5. 清除連線資源（ping timer、pong timeout）
    this._cleanupConnectionResources(deviceId, conn);

    // 6. 清除連線和裝置資訊
    this.connections.delete(deviceId);

    // 7. 更新 IP 連線計數
    const currentCount = this.ipConnectionCount.get(clientIp) ?? 0;
    if (currentCount <= 1) {
      this.ipConnectionCount.delete(clientIp);
    } else {
      this.ipConnectionCount.set(clientIp, currentCount - 1);
    }
  }

  // ===== 輔助方法 =====

  // 取得單一連線資訊
  getConnection(deviceId: string): WSConnectionInfo | undefined {
    return this.connections.get(deviceId);
  }

  // 取得指定 region 的所有連線
  getConnectionsByRegion(region: string): WSConnectionInfo[] {
    const result: WSConnectionInfo[] = [];
    for (const conn of this.connections.values()) {
      if (conn.region === region) result.push(conn);
    }
    return result;
  }

  // 取得目前所有連線數
  getOnlineCount(): number {
    return this.connections.size;
  }

  // 廣播訊息到頻道
  broadcastToChannel(channel: SubscribableChannel, payload: unknown): void {
    const msg = buildServerMessage(channel, channel, payload);
    broadcastToChannel(this.connections, channel, msg);
  }

  // 廣播通知給所有訂閱 notifications 的連線
  broadcastNotification(payload: unknown): void {
    const msg = buildServerMessage('notification', 'notifications', payload);
    broadcastToChannel(this.connections, 'notifications', msg);
  }

  // 傳送訊息給指定裝置
  sendToDevice(deviceId: string, message: WSServerMessage): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn) return false;

    try {
      conn.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  // 傳送錯誤訊息給指定裝置
  sendError(deviceId: string, errorCode: ErrorCode): void {
    const conn = this.connections.get(deviceId);
    if (!conn) return;

    const msg = buildServerMessage('error', 'system', { error: errorCode });
    try {
      conn.socket.send(JSON.stringify(msg));
    } catch {
      // 忽略傳送失敗
    }
  }

  // 將訊息加入離線佇列（供斷線期間的通知使用）
  queueOfflineMessage(deviceId: string, message: WSServerMessage): void {
    const conn = this.connections.get(deviceId);
    if (!conn) return;

    if (conn.offlineQueue.length >= WS_OFFLINE_QUEUE_MAX) {
      // 已滿：移除最舊的一條
      conn.offlineQueue.shift();
    }
    conn.offlineQueue.push(message);
  }

  // 測試用：清除所有連線（不觸發關閉流程）
  clearAllConnections(): void {
    for (const [, conn] of this.connections.entries()) {
      this._cleanupConnectionResources('', conn);
    }
    this.connections.clear();
    this.ipConnectionCount.clear();
  }

  // ===== 私有方法 =====

  // 處理 subscribe 訊息
  private _handleSubscribe(
    deviceId: string,
    conn: WSConnectionInfo,
    payload: unknown,
  ): void {
    const p = (payload ?? {}) as SubscribePayload;
    const { systemChannels, chatChannels } = parseSubscribeRequest(
      p.channels,
      p.chat_channels,
    );

    const subscribed = subscribeToChannels(conn, systemChannels, chatChannels);

    // 計算線上人數（加入聊天頻道後）
    let onlineCount = this.connections.size;
    if (chatChannels.length > 0) {
      onlineCount = getChatChannelOnlineCount(this.connections, chatChannels[0]);
    }

    // 傳送 subscribe_ack
    const ack = buildServerMessage('subscribe_ack', 'system', {
      subscribed: subscribed as string[],
      online_count: onlineCount,
    });
    try {
      conn.socket.send(JSON.stringify(ack));
    } catch {
      // 忽略傳送失敗
    }

    // 廣播聊天頻道加入通知
    for (const channel of chatChannels) {
      const count = getChatChannelOnlineCount(this.connections, channel);
      const presenceMsg = buildPresenceMessage(channel, deviceId, count, 'join');
      broadcastToChannel(this.connections, channel, presenceMsg, deviceId);
    }
  }

  // 處理聊天訊息
  private _handleChatMessage(
    deviceId: string,
    conn: WSConnectionInfo,
    payload: unknown,
    msgId?: string,
  ): void {
    // 先做 rate limit 檢查
    const withinLimit = this._checkRateLimit(conn, 'chat');
    if (!withinLimit) {
      this._handleRateLimitViolation(deviceId, conn);
      this.sendError(deviceId, ErrorCode.WS_CHAT_RATE_LIMITED);
      return;
    }

    // 驗證訊息內容
    const validation = validateChatMessage(payload);
    if (!validation.valid) {
      this.sendError(deviceId, validation.errorCode ?? ErrorCode.WS_INVALID_MESSAGE_FORMAT);
      return;
    }

    const channelName = validation.channel!;
    const chatChannel = `chat:${channelName}` as ChatChannel;

    // 確認此連線有訂閱該聊天頻道
    if (!conn.subscriptions.has(chatChannel)) {
      this.sendError(deviceId, ErrorCode.WS_SUBSCRIBE_INVALID);
      return;
    }

    // 取得 device 資訊（nickname 用）
    const device = this.db.getDevice(deviceId);

    // 廣播給同頻道所有連線（包含發送者）
    const chatMsg = buildServerMessage(
      'chat_message',
      chatChannel,
      {
        text: validation.text,
        nickname: device?.nickname ?? deviceId.slice(0, 8),
        reply_to: (payload as { reply_to?: string | null }).reply_to ?? null,
      },
      msgId,
    );
    broadcastToChannel(this.connections, chatChannel, chatMsg);
  }

  // 處理 aid_response（需要 rate limit 檢查）
  private _handleAidResponse(
    deviceId: string,
    conn: WSConnectionInfo,
    msg: { type?: string; channel?: string; id?: string; payload?: unknown },
  ): void {
    this._handleRateLimitedMessage(deviceId, conn, 'aid_response', () => {
      // 轉發給 routing 頻道
      const fwdMsg = buildServerMessage('aid_response', 'routing', msg.payload, msg.id);
      broadcastToChannel(this.connections, 'routing', fwdMsg);
    });
  }

  // 帶 rate limit 的通用訊息處理包裝
  private _handleRateLimitedMessage(
    deviceId: string,
    conn: WSConnectionInfo,
    limitType: WSRateLimitType,
    handler: () => void,
  ): void {
    const withinLimit = this._checkRateLimit(conn, limitType);
    if (!withinLimit) {
      this._handleRateLimitViolation(deviceId, conn);
      this.sendError(deviceId, ErrorCode.WS_INVALID_MESSAGE_FORMAT);
      return;
    }
    handler();
  }

  // 處理 pong 回應
  private _handlePong(deviceId: string, conn: WSConnectionInfo): void {
    // 清除 pong 超時計時器
    if (conn.pongTimeout) {
      clearTimeout(conn.pongTimeout);
      conn.pongTimeout = null;
    }
  }

  // 啟動 ping 保活循環
  private _startPingLoop(deviceId: string, conn: WSConnectionInfo): void {
    // 清除舊的計時器
    if (conn.pingInterval) {
      clearInterval(conn.pingInterval);
    }

    conn.pingInterval = setInterval(() => {
      const currentConn = this.connections.get(deviceId);
      if (!currentConn) return;

      // 傳送 ping
      const pingMsg = buildServerMessage('ping', 'system', {});
      try {
        currentConn.socket.send(JSON.stringify(pingMsg));
        currentConn.lastPingSentAt = Date.now();
      } catch {
        return;
      }

      // 設置 pong 超時：10 秒內沒收到 pong → 關閉連線
      if (currentConn.pongTimeout) {
        clearTimeout(currentConn.pongTimeout);
      }
      currentConn.pongTimeout = setTimeout(() => {
        const c = this.connections.get(deviceId);
        if (c) {
          try {
            c.socket.close(1001, 'Pong 超時');
          } catch {
            // 忽略
          }
        }
      }, WS_PONG_TIMEOUT_MS);
    }, WS_PING_INTERVAL_MS);
  }

  // 清除連線資源（ping 計時器、pong 計時器）
  private _cleanupConnectionResources(_deviceId: string, conn: WSConnectionInfo): void {
    if (conn.pingInterval) {
      clearInterval(conn.pingInterval);
      conn.pingInterval = null;
    }
    if (conn.pongTimeout) {
      clearTimeout(conn.pongTimeout);
      conn.pongTimeout = null;
    }
  }

  // 補發離線訊息佇列
  private _flushOfflineQueue(deviceId: string, conn: WSConnectionInfo): void {
    if (conn.offlineQueue.length === 0) return;

    const queue = [...conn.offlineQueue];
    conn.offlineQueue = [];

    for (const msg of queue) {
      try {
        conn.socket.send(JSON.stringify(msg));
      } catch {
        // 補發失敗：丟棄，不重新放回佇列
      }
    }
  }

  // 廣播到頻道（內部用，接受字串頻道名稱）
  private _broadcastToChannel(channel: string, message: WSServerMessage): void {
    broadcastToChannel(this.connections, channel as SubscribableChannel, message);
  }

  // ===== Rate Limit 相關 =====

  // 檢查是否在 rate limit 範圍內
  // 回傳：true = 允許，false = 超過限制
  private _checkRateLimit(conn: WSConnectionInfo, type: WSRateLimitType): boolean {
    // 如果被封禁，直接拒絕
    if (conn.rateLimitBannedUntil && Date.now() < conn.rateLimitBannedUntil) {
      return false;
    }

    const config = WS_RATE_LIMITS[type];
    const windowMs = config.windowSeconds * 1000;
    const now = Date.now();

    const entry = conn.rateLimits.get(type);

    if (!entry || now - entry.windowStart >= windowMs) {
      // 新窗口：重置計數
      conn.rateLimits.set(type, { count: 1, windowStart: now });
      // 重置違規計數（新窗口代表使用者行為已改善）
      conn.rateLimitViolations = 0;
      return true;
    }

    if (entry.count >= config.limit) {
      return false;
    }

    entry.count++;
    return true;
  }

  // 處理 rate limit 違規
  private _handleRateLimitViolation(deviceId: string, conn: WSConnectionInfo): void {
    conn.rateLimitViolations++;

    // 連續超限超過閾值 → 斷線 + 封禁
    if (conn.rateLimitViolations >= WS_RATE_LIMIT_DISCONNECT_THRESHOLD) {
      conn.rateLimitBannedUntil = Date.now() + WS_RATE_LIMIT_BAN_MS;
      try {
        conn.socket.close(1008, 'Rate limit 超限，封禁 5 分鐘');
      } catch {
        // 忽略關閉錯誤
      }
    }
  }
}

// ===== 全域單例 =====
// 由應用程式入口點初始化，此處僅宣告型別
let _manager: WebSocketManager | null = null;

export function initWebSocketManager(db: VPSDatabase): WebSocketManager {
  _manager = new WebSocketManager(db);
  return _manager;
}

export function getWebSocketManager(): WebSocketManager | null {
  return _manager;
}
