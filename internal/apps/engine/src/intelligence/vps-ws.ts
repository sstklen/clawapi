// VPS WebSocket 客戶端
// 負責與 VPS 的 WebSocket 雙向通訊，支援自動重連（指數退避）

import {
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
} from '@clawapi/protocol';

import type { AidResponsePayload } from '@clawapi/protocol';

// ===== 型別定義 =====

/** 訊息處理器函式 */
export type MessageHandler = (payload: unknown) => void;

/** 所有事件 handler 的映射 */
type HandlerMap = {
  routing_update: MessageHandler[];
  notification: MessageHandler[];
  chat_message: MessageHandler[];
  aid_request: MessageHandler[];
  aid_matched: MessageHandler[];
  aid_result: MessageHandler[];
  aid_data: MessageHandler[];
};

/** VPSWebSocketClient 建構設定 */
export interface VPSWebSocketClientConfig {
  wsUrl: string;
  clientVersion: string;
}

/** 連線狀態 */
type ConnectionState = 'disconnected' | 'connecting' | 'connected';

// ===== 主要客戶端類別 =====

/**
 * VPSWebSocketClient：WebSocket 客戶端
 *
 * 功能：
 * - 自動帶認證參數（device_id, token, version）
 * - 連線後自動訂閱 routing, notifications 頻道
 * - 支援指數退避重連（1s → 2s → ... → 300s）
 * - 超過 360 次嘗試（約 1 小時），固定每 5 分鐘重連
 */
export class VPSWebSocketClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private deviceId: string = '';
  private deviceToken: string = '';
  private clientVersion: string;

  /** 所有事件 handlers */
  private handlers: HandlerMap = {
    routing_update: [],
    notification: [],
    chat_message: [],
    aid_request: [],
    aid_matched: [],
    aid_result: [],
    aid_data: [],
  };

  /** 重連嘗試次數 */
  private reconnectAttempts: number = 0;
  /** 重連計時器 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否是主動斷線（主動斷線不重連） */
  private isManualDisconnect: boolean = false;

  /** 連線狀態 */
  private connectionState: ConnectionState = 'disconnected';

  constructor(config: VPSWebSocketClientConfig) {
    this.wsUrl = config.wsUrl;
    this.clientVersion = config.clientVersion;
  }

  /**
   * 設定裝置認證憑證
   */
  setCredentials(deviceId: string, deviceToken: string): void {
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
  }

  // ===== 連線管理 =====

  /**
   * 建立 WebSocket 連線
   * URL 格式：wsUrl?device_id=xxx&token=xxx&version=xxx
   * 連線成功後自動訂閱 routing + notifications 頻道
   */
  async connect(): Promise<void> {
    // 如果已經連線中或連線完成，直接回傳
    if (this.connectionState !== 'disconnected') {
      return;
    }

    this.isManualDisconnect = false;
    this.connectionState = 'connecting';

    const url = this.buildUrl();

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        this.connectionState = 'disconnected';
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const onOpen = () => {
        this.connectionState = 'connected';
        this.reconnectAttempts = 0;

        // 連線後自動訂閱
        this.subscribe(['routing', 'notifications']);

        resolve();
      };

      const onError = (event: Event) => {
        this.connectionState = 'disconnected';
        reject(new Error(`WebSocket 連線失敗：${String(event)}`));
      };

      const onClose = () => {
        this.connectionState = 'disconnected';
        this.ws = null;

        // 非主動斷線才重連
        if (!this.isManualDisconnect) {
          this.scheduleReconnect();
        }
      };

      const onMessage = (event: MessageEvent) => {
        this.handleMessage(event);
      };

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);
      this.ws.addEventListener('close', onClose);
      this.ws.addEventListener('message', onMessage);
    });
  }

  /**
   * 主動斷線
   * 設定 isManualDisconnect = true，關閉 WebSocket
   */
  disconnect(): void {
    this.isManualDisconnect = true;

    // 取消待執行的重連計時器
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connectionState = 'disconnected';
  }

  /**
   * 是否已連線
   */
  isConnected(): boolean {
    return this.connectionState === 'connected' && this.ws !== null;
  }

  // ===== 訂閱 =====

  /**
   * 發送訂閱請求
   * @param channels 要訂閱的系統頻道（如 routing, notifications）
   * @param chatChannels 要訂閱的聊天室頻道（如 chat:global）
   */
  private subscribe(channels: string[], chatChannels?: string[]): void {
    if (!this.isConnected()) return;

    const message = {
      type: 'subscribe',
      id: this.generateId(),
      payload: {
        channels,
        chat_channels: chatChannels ?? [],
      },
    };

    this.ws!.send(JSON.stringify(message));
  }

  // ===== 發送訊息 =====

  /**
   * 發送聊天室訊息
   * @param channel 聊天頻道（如 chat:global）
   * @param text 訊息內容
   * @param nickname 暱稱（可選）
   */
  sendChatMessage(channel: string, text: string, nickname?: string): void {
    if (!this.isConnected()) return;

    const message = {
      type: 'chat_message',
      channel,
      id: this.generateId(),
      payload: {
        text,
        nickname: nickname ?? null,
        reply_to: null,
      },
    };

    this.ws!.send(JSON.stringify(message));
  }

  /**
   * 發送互助回應
   * @param aidId 互助 ID
   * @param payload 回應資料
   */
  sendAidResponse(aidId: string, payload: AidResponsePayload): void {
    if (!this.isConnected()) return;

    const message = {
      type: 'aid_response',
      id: this.generateId(),
      // AidResponsePayload 本身已包含 aid_id，直接使用
      payload,
    };

    this.ws!.send(JSON.stringify(message));
  }

  /**
   * 發送加密的互助資料
   * @param aidId 互助 ID
   * @param kind 資料類型（encrypted_request / encrypted_response）
   * @param encryptedPayload 加密後的資料（base64）
   * @param iv 初始向量（base64）
   * @param tag 認證標籤（base64）
   */
  sendAidData(
    aidId: string,
    kind: string,
    encryptedPayload: string,
    iv: string,
    tag: string
  ): void {
    if (!this.isConnected()) return;

    const message = {
      type: 'aid_data',
      id: this.generateId(),
      payload: {
        aid_id: aidId,
        kind,
        encrypted_payload: encryptedPayload,
        iv,
        tag,
      },
    };

    this.ws!.send(JSON.stringify(message));
  }

  // ===== 事件訂閱 =====

  /**
   * 訂閱路由更新事件
   */
  onRoutingUpdate(handler: MessageHandler): void {
    this.handlers.routing_update.push(handler);
  }

  /**
   * 訂閱系統通知事件
   */
  onNotification(handler: MessageHandler): void {
    this.handlers.notification.push(handler);
  }

  /**
   * 訂閱聊天室訊息事件
   */
  onChatMessage(handler: MessageHandler): void {
    this.handlers.chat_message.push(handler);
  }

  /**
   * 訂閱互助請求事件（有人需要幫助）
   */
  onAidRequest(handler: MessageHandler): void {
    this.handlers.aid_request.push(handler);
  }

  /**
   * 訂閱互助配對成功事件
   */
  onAidMatched(handler: MessageHandler): void {
    this.handlers.aid_matched.push(handler);
  }

  /**
   * 訂閱互助結果事件
   */
  onAidResult(handler: MessageHandler): void {
    this.handlers.aid_result.push(handler);
  }

  // ===== 重連（指數退避）=====

  /**
   * 排程下一次重連嘗試
   * 非主動斷線才會觸發
   */
  private scheduleReconnect(): void {
    if (this.isManualDisconnect) return;

    // 取消已有的計時器
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const delay = this.getReconnectDelay();

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connectionState = 'disconnected';

      try {
        await this.connect();
      } catch {
        // connect 失敗時，onClose 或 onError 會再次呼叫 scheduleReconnect
      }
    }, delay);
  }

  /**
   * 計算重連延遲（指數退避）
   *
   * 公式：min(WS_RECONNECT_BASE_MS × 2^attempts, WS_RECONNECT_MAX_MS)
   * 超過 360 次（約 1 小時）→ 固定 WS_RECONNECT_MAX_MS（5 分鐘）
   */
  getReconnectDelay(): number {
    // 超過 360 次嘗試（約 1 小時的嘗試）→ 固定每 5 分鐘
    if (this.reconnectAttempts > 360) {
      return WS_RECONNECT_MAX_MS;
    }

    const delay = WS_RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts);
    return Math.min(delay, WS_RECONNECT_MAX_MS);
  }

  // ===== 訊息處理 =====

  /**
   * 處理收到的 WebSocket 訊息
   * 依 type 分發到對應的 handler
   */
  private handleMessage(event: MessageEvent): void {
    let msg: Record<string, unknown>;

    try {
      msg = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch {
      // 無法解析的訊息忽略
      return;
    }

    const type = msg.type as string;
    const channel = msg.channel as string | undefined;
    const payload = msg.payload;

    switch (type) {
      case 'routing_update':
        this.dispatch('routing_update', payload);
        break;

      case 'notification':
        this.dispatch('notification', msg);
        break;

      case 'chat_message':
        this.dispatch('chat_message', msg);
        break;

      case 'aid_request':
        this.dispatch('aid_request', payload);
        break;

      case 'aid_matched':
        this.dispatch('aid_matched', msg);
        break;

      case 'aid_result':
        this.dispatch('aid_result', payload ?? msg);
        break;

      case 'aid_data':
        this.dispatch('aid_data', payload ?? msg);
        break;

      default:
        // 未知訊息型別，依 channel 分發
        if (channel?.startsWith('routing')) {
          this.dispatch('routing_update', payload);
        } else if (channel === 'notifications') {
          this.dispatch('notification', msg);
        }
        break;
    }
  }

  /**
   * 分發訊息到所有已註冊的 handlers
   */
  private dispatch(event: keyof HandlerMap, payload: unknown): void {
    const list = this.handlers[event];
    for (const handler of list) {
      try {
        handler(payload);
      } catch {
        // handler 拋出錯誤不影響其他 handler
      }
    }
  }

  // ===== 私有輔助方法 =====

  /** 組合 WebSocket URL（帶認證參數） */
  private buildUrl(): string {
    const params = new URLSearchParams({
      device_id: this.deviceId,
      token: this.deviceToken,
      version: this.clientVersion,
    });
    return `${this.wsUrl}?${params.toString()}`;
  }

  /** 產生隨機訊息 ID */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
