// SSE 即時事件流
// 提供 Dashboard 即時更新所需的 Server-Sent Events 端點
//
// 端點：
//   GET /api/events  SSE 連線（持久連線，即時推送事件）
//
// 事件類型：
//   key_status_change   Key 狀態變更
//   request_completed   API 請求完成
//   aid_event           互助事件
//   l0_update           L0 額度變化
//   notification        系統通知

import { Hono } from 'hono';
import type { Context } from 'hono';

// ===== 型別定義 =====

/** 事件類型聯集 */
export type EventType =
  | 'key_status_change'
  | 'request_completed'
  | 'aid_event'
  | 'l0_update'
  | 'notification';

/** Key 狀態變更事件 */
export interface KeyStatusChangeEvent {
  key_id: number;
  old_status: 'active' | 'rate_limited' | 'dead';
  new_status: 'active' | 'rate_limited' | 'dead';
  service_id?: string;
}

/** 請求完成事件 */
export interface RequestCompletedEvent {
  model: string;
  service_id?: string;
  layer: string;
  latency_ms: number;
  success: boolean;
  tokens?: number;
}

/** 互助事件 */
export interface AidEvent {
  aid_id: string;
  direction: 'given' | 'received';
  service_id: string;
  status: 'started' | 'fulfilled' | 'rejected' | 'timeout';
}

/** L0 更新事件 */
export interface L0UpdateEvent {
  service_id: string;
  used: number;
  limit: number;
  remaining: number;
}

/** 系統通知事件 */
export interface NotificationEvent {
  level: 'info' | 'warn' | 'error';
  title: string;
  message: string;
}

/** 統一的事件容器 */
export interface ClawAPIEvent {
  type: EventType;
  data:
    | KeyStatusChangeEvent
    | RequestCompletedEvent
    | AidEvent
    | L0UpdateEvent
    | NotificationEvent;
  timestamp: string;
  /** 事件唯一 ID（用於 Last-Event-ID 斷線重連） */
  id?: string;
}

/** SSE 客戶端連線 */
interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: number;
  /** 客戶端最後收到的 Event-ID（用於斷線重連） */
  lastEventId: string;
}

// ===== EventBus 主類別 =====

/**
 * EventBus — SSE 事件發佈/訂閱中心
 *
 * 功能：
 * 1. 管理多個 SSE 客戶端連線
 * 2. 廣播事件到所有連線的客戶端
 * 3. 定時心跳（每 30 秒）保持連線活躍
 * 4. 事件歷史緩衝（最近 100 筆，支援斷線重連補送）
 * 5. 斷線清理（controller 關閉時移除）
 */
export class EventBus {
  /** 連線中的客戶端 Map（key = clientId） */
  private clients: Map<string, SSEClient> = new Map();

  /** 客戶端計數器 */
  private clientCounter = 0;

  /** 事件 ID 計數器 */
  private eventIdCounter = 0;

  /** 心跳計時器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** 事件歷史緩衝（最近 100 筆，用於斷線重連補送） */
  private eventHistory: Array<{ id: string; raw: string }> = [];
  private readonly MAX_HISTORY = 100;

  constructor() {
    // 啟動心跳
    this.startHeartbeat();
  }

  // ===== 公開方法 =====

  /**
   * 建立新的 SSE 連線，回傳 ReadableStream
   * @param lastEventId 客戶端最後收到的 Event-ID（斷線重連用）
   */
  createConnection(lastEventId?: string): {
    stream: ReadableStream<Uint8Array>;
    clientId: string;
  } {
    const clientId = `client_${++this.clientCounter}`;

    let resolveController: (controller: ReadableStreamDefaultController<Uint8Array>) => void;
    const controllerPromise = new Promise<ReadableStreamDefaultController<Uint8Array>>(resolve => {
      resolveController = resolve;
    });

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        // 建立客戶端記錄
        const client: SSEClient = {
          id: clientId,
          controller,
          connectedAt: Date.now(),
          lastEventId: lastEventId ?? '',
        };
        this.clients.set(clientId, client);
        resolveController(controller);

        // 發送初始連線確認
        this.sendToClient(client, {
          type: 'notification',
          data: {
            level: 'info',
            title: '已連線',
            message: `SSE 連線建立（客戶端 ${clientId}）`,
          },
          timestamp: new Date().toISOString(),
        });

        // 若有 lastEventId，補送中斷期間的事件
        if (lastEventId) {
          this.replayMissedEvents(client, lastEventId);
        }
      },
      cancel: () => {
        // 客戶端斷線
        this.clients.delete(clientId);
      },
    });

    // 確保 controllerPromise 不會 hang（Stream start 是同步的，但保留 await 以防萬一）
    void controllerPromise;

    return { stream, clientId };
  }

  /**
   * 廣播事件到所有連線的客戶端
   * @param event 要廣播的事件
   */
  broadcast(event: Omit<ClawAPIEvent, 'id'>): void {
    const eventId = `evt_${++this.eventIdCounter}`;
    const fullEvent: ClawAPIEvent = { ...event, id: eventId };

    // 格式化成 SSE 文字
    const raw = formatSSEEvent(fullEvent);

    // 存入歷史緩衝
    this.eventHistory.push({ id: eventId, raw });
    if (this.eventHistory.length > this.MAX_HISTORY) {
      this.eventHistory.shift();
    }

    // 廣播給所有客戶端
    const deadClients: string[] = [];

    for (const [id, client] of this.clients) {
      try {
        client.controller.enqueue(new TextEncoder().encode(raw));
        client.lastEventId = eventId;
      } catch {
        // 發送失敗 → 客戶端已斷線，稍後清理
        deadClients.push(id);
      }
    }

    // 清理已斷線的客戶端
    for (const id of deadClients) {
      this.clients.delete(id);
    }
  }

  /**
   * 取得目前連線中的客戶端數量
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * 停止 EventBus，清除心跳計時器
   */
  stop(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // 關閉所有客戶端連線
    for (const client of this.clients.values()) {
      try {
        client.controller.close();
      } catch {
        // 忽略已關閉的連線
      }
    }
    this.clients.clear();
  }

  // ===== 私有方法 =====

  /**
   * 啟動心跳（每 30 秒傳送一次 comment 行）
   * SSE comment 格式：`: heartbeat\n\n`
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, 30_000);
  }

  /**
   * 發送心跳到所有客戶端
   */
  private sendHeartbeat(): void {
    const heartbeat = ': heartbeat\n\n';
    const encoded = new TextEncoder().encode(heartbeat);
    const deadClients: string[] = [];

    for (const [id, client] of this.clients) {
      try {
        client.controller.enqueue(encoded);
      } catch {
        deadClients.push(id);
      }
    }

    for (const id of deadClients) {
      this.clients.delete(id);
    }
  }

  /**
   * 傳送事件到指定客戶端
   */
  private sendToClient(client: SSEClient, event: ClawAPIEvent): void {
    const raw = formatSSEEvent(event);
    try {
      client.controller.enqueue(new TextEncoder().encode(raw));
    } catch {
      // 客戶端已斷線，不處理
    }
  }

  /**
   * 補送斷線期間錯過的事件（從 lastEventId 之後開始）
   */
  private replayMissedEvents(client: SSEClient, lastEventId: string): void {
    // 找到 lastEventId 在歷史中的位置
    const idx = this.eventHistory.findIndex(e => e.id === lastEventId);

    if (idx === -1) {
      // 找不到（太舊了），不補送
      return;
    }

    // 補送 lastEventId 之後的事件
    const missed = this.eventHistory.slice(idx + 1);
    for (const event of missed) {
      try {
        client.controller.enqueue(new TextEncoder().encode(event.raw));
      } catch {
        // 發送失敗，忽略
        break;
      }
    }
  }
}

// ===== 格式化函式 =====

/**
 * 將事件格式化為標準 SSE 文字
 *
 * 格式：
 * ```
 * id: evt_1
 * event: request_completed
 * data: {"model":"groq/llama3","latency_ms":200,"success":true}
 *
 * ```
 */
function formatSSEEvent(event: ClawAPIEvent): string {
  const lines: string[] = [];

  if (event.id) {
    lines.push(`id: ${event.id}`);
  }

  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event.data)}`);
  lines.push('');
  lines.push('');

  return lines.join('\n');
}

// ===== 全域 EventBus 單例 =====

/** 全域 EventBus 單例 */
let _eventBus: EventBus | null = null;

/**
 * 取得全域 EventBus（單例）
 */
export function getEventBus(): EventBus {
  if (!_eventBus) {
    _eventBus = new EventBus();
  }
  return _eventBus;
}

/**
 * 替換全域 EventBus（測試用）
 */
export function setEventBus(bus: EventBus): void {
  _eventBus = bus;
}

// ===== 主路由工廠 =====

/**
 * 建立 SSE 事件流路由器
 *
 * @param eventBus EventBus 實例（選填，預設使用全域單例）
 * @returns Hono 路由實例
 */
export function createEventsRouter(eventBus?: EventBus): Hono {
  const bus = eventBus ?? getEventBus();
  const app = new Hono();

  // =========================================================
  // GET /api/events — SSE 連線
  // =========================================================
  app.get('/events', (c: Context) => {
    // 讀取 Last-Event-ID（斷線重連時客戶端帶上來）
    const lastEventId = c.req.header('Last-Event-ID') ?? c.req.query('last_event_id');

    // 建立 SSE 連線
    const { stream } = bus.createConnection(lastEventId);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  return app;
}

export default createEventsRouter;
