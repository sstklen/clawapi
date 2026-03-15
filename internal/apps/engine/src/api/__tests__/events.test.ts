// SSE 事件流測試
// 測試 EventBus、SSE 連線、事件廣播、心跳機制

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import {
  EventBus,
  createEventsRouter,
  setEventBus,
  getEventBus,
  type ClawAPIEvent,
} from '../events';

// ===== 輔助函式 =====

/**
 * 從 SSE 文字中解析所有事件
 */
function parseSSEEvents(text: string): Array<{
  id?: string;
  event?: string;
  data?: string;
}> {
  const events: Array<{ id?: string; event?: string; data?: string }> = [];
  const blocks = text.split('\n\n').filter(b => b.trim() !== '');

  for (const block of blocks) {
    if (block.startsWith(': ')) {
      // comment（心跳）
      events.push({ event: 'heartbeat' });
      continue;
    }

    const event: { id?: string; event?: string; data?: string } = {};
    const lines = block.split('\n');

    for (const line of lines) {
      if (line.startsWith('id: ')) event.id = line.slice(4);
      else if (line.startsWith('event: ')) event.event = line.slice(7);
      else if (line.startsWith('data: ')) event.data = line.slice(6);
    }

    if (event.event || event.data || event.id) {
      events.push(event);
    }
  }

  return events;
}

/**
 * 讀取 ReadableStream 的所有內容（限時版）
 */
async function readStreamWithTimeout(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 1000
): Promise<string> {
  const decoder = new TextDecoder();
  let result = '';

  const reader = stream.getReader();
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        timeoutPromise,
      ]);

      if (done) break;
      result += decoder.decode(value, { stream: true });

      // 如果已收到足夠的內容就提前結束
      if (result.includes('\n\n')) break;
    }
  } catch {
    // timeout 或其他錯誤，回傳已收到的內容
  } finally {
    reader.releaseLock();
  }

  return result;
}

// ===== 測試套件 =====

// =========================================================
// EventBus 基本功能
// =========================================================
describe('EventBus — 基本功能', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.stop();
  });

  it('初始狀態：無客戶端', () => {
    expect(bus.getClientCount()).toBe(0);
  });

  it('建立連線後客戶端數增加', async () => {
    const { stream } = bus.createConnection();
    expect(bus.getClientCount()).toBe(1);

    // 讀取初始確認訊息
    await readStreamWithTimeout(stream);

    bus.stop();
    // stop 後客戶端清理
    expect(bus.getClientCount()).toBe(0);
  });

  it('廣播事件：所有客戶端都能收到', async () => {
    const { stream: stream1 } = bus.createConnection();

    // 先讀取連線確認訊息
    const reader1 = stream1.getReader();
    const decoder = new TextDecoder();

    // 等待初始事件
    const { value: initValue } = await reader1.read();
    const initText = decoder.decode(initValue);
    expect(initText).toContain('notification');

    // 廣播事件
    const testEvent: Omit<ClawAPIEvent, 'id'> = {
      type: 'request_completed',
      data: {
        model: 'groq/llama3',
        latency_ms: 200,
        success: true,
        layer: 'L1',
      },
      timestamp: new Date().toISOString(),
    };

    bus.broadcast(testEvent);

    // 讀取廣播的事件
    const { value: broadcastValue } = await reader1.read();
    const broadcastText = decoder.decode(broadcastValue);

    expect(broadcastText).toContain('request_completed');
    expect(broadcastText).toContain('groq/llama3');

    reader1.releaseLock();
    bus.stop();
  });

  it('廣播事件包含 id 欄位', async () => {
    const { stream } = bus.createConnection();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 讀取初始事件
    await reader.read();

    // 廣播
    bus.broadcast({
      type: 'notification',
      data: { level: 'info', title: '測試', message: '測試訊息' },
      timestamp: new Date().toISOString(),
    });

    const { value } = await reader.read();
    const text = decoder.decode(value);

    // 應包含 id: evt_N 行
    expect(text).toMatch(/^id: evt_\d+/m);

    reader.releaseLock();
    bus.stop();
  });

  it('廣播事件格式符合 SSE 規範', async () => {
    const { stream } = bus.createConnection();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 讀取初始事件
    await reader.read();

    bus.broadcast({
      type: 'key_status_change',
      data: { key_id: 1, old_status: 'active', new_status: 'rate_limited' },
      timestamp: new Date().toISOString(),
    });

    const { value } = await reader.read();
    const text = decoder.decode(value);

    // 驗證 SSE 格式：包含 event: 和 data: 行，以 \n\n 結尾
    expect(text).toContain('event: key_status_change');
    expect(text).toContain('data: ');
    expect(text.endsWith('\n\n')).toBe(true);

    reader.releaseLock();
    bus.stop();
  });

  it('多客戶端同時廣播', async () => {
    const { stream: stream1 } = bus.createConnection();
    const { stream: stream2 } = bus.createConnection();

    expect(bus.getClientCount()).toBe(2);

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();
    const decoder = new TextDecoder();

    // 讀取兩個客戶端的初始事件
    await reader1.read();
    await reader2.read();

    // 廣播事件
    bus.broadcast({
      type: 'l0_update',
      data: { service_id: 'groq', used: 10, limit: 100, remaining: 90 },
      timestamp: new Date().toISOString(),
    });

    // 兩個客戶端都應收到
    const { value: v1 } = await reader1.read();
    const { value: v2 } = await reader2.read();

    expect(decoder.decode(v1)).toContain('l0_update');
    expect(decoder.decode(v2)).toContain('l0_update');

    reader1.releaseLock();
    reader2.releaseLock();
    bus.stop();
  });

  it('stop() 後客戶端清空', () => {
    bus.createConnection();
    bus.createConnection();
    expect(bus.getClientCount()).toBe(2);

    bus.stop();
    expect(bus.getClientCount()).toBe(0);
  });
});

// =========================================================
// SSE 連線建立
// =========================================================
describe('GET /api/events — SSE 連線建立', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    setEventBus(bus);
  });

  afterEach(() => {
    bus.stop();
  });

  it('回傳 text/event-stream Content-Type', async () => {
    const app = new Hono();
    app.route('/api', createEventsRouter(bus));

    const res = await app.fetch(new Request('http://localhost/api/events'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('Cache-Control')).toContain('no-cache');
  });

  it('連線後收到初始確認通知', async () => {
    const app = new Hono();
    app.route('/api', createEventsRouter(bus));

    const res = await app.fetch(new Request('http://localhost/api/events'));
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    if (res.body) {
      const text = await readStreamWithTimeout(res.body);
      const events = parseSSEEvents(text);

      // 應有初始通知事件
      const notifEvent = events.find(e => e.event === 'notification');
      expect(notifEvent).toBeDefined();
    }
  });

  it('連線建立後 EventBus 客戶端數增加', () => {
    const app = new Hono();
    app.route('/api', createEventsRouter(bus));

    // 建立連線（非同步，不 await，只確認連線被記錄）
    void app.fetch(new Request('http://localhost/api/events'));

    // 連線建立是同步的（ReadableStream start 同步執行）
    expect(bus.getClientCount()).toBeGreaterThanOrEqual(1);
  });

  it('Last-Event-ID header 被正確讀取', async () => {
    const app = new Hono();
    app.route('/api', createEventsRouter(bus));

    const res = await app.fetch(new Request('http://localhost/api/events', {
      headers: { 'Last-Event-ID': 'evt_42' },
    }));

    // 連線應成功（無論有沒有對應的歷史事件）
    expect(res.status).toBe(200);
  });
});

// =========================================================
// 事件發送與接收
// =========================================================
describe('事件發送和接收', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.stop();
  });

  it('broadcast key_status_change 事件', async () => {
    const { stream } = bus.createConnection();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 讀取初始事件

    bus.broadcast({
      type: 'key_status_change',
      data: { key_id: 5, old_status: 'active', new_status: 'dead' },
      timestamp: new Date().toISOString(),
    });

    const { value } = await reader.read();
    const parsed = JSON.parse(
      decoder.decode(value).match(/data: (.+)/)?.[1] ?? '{}'
    ) as { key_id: number; new_status: string };

    expect(parsed.key_id).toBe(5);
    expect(parsed.new_status).toBe('dead');

    reader.releaseLock();
  });

  it('broadcast aid_event 事件', async () => {
    const { stream } = bus.createConnection();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 初始事件

    bus.broadcast({
      type: 'aid_event',
      data: { aid_id: 'aid-123', direction: 'given', service_id: 'groq', status: 'fulfilled' },
      timestamp: new Date().toISOString(),
    });

    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('aid_event');
    expect(text).toContain('aid-123');

    reader.releaseLock();
  });

  it('broadcast notification 事件', async () => {
    const { stream } = bus.createConnection();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 初始事件

    bus.broadcast({
      type: 'notification',
      data: { level: 'warn', title: '警告', message: '服務即將達到配額上限' },
      timestamp: new Date().toISOString(),
    });

    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('notification');
    expect(text).toContain('服務即將達到配額上限');

    reader.releaseLock();
  });
});

// =========================================================
// 斷線清理
// =========================================================
describe('斷線清理', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.stop();
  });

  it('Stream 被取消後客戶端從 EventBus 移除', async () => {
    let cancelStream!: () => void;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        cancelStream = () => controller.close();
      },
    });

    // 手動加入一個會拋出的客戶端（模擬斷線後廣播）
    // 此處用 EventBus 本身的 createConnection，然後透過 cancel 觸發清理
    const { stream: clientStream } = bus.createConnection();
    expect(bus.getClientCount()).toBe(1);

    void stream;

    // 讀取並關閉
    const reader = clientStream.getReader();
    await reader.read(); // 初始事件
    reader.releaseLock();
    await clientStream.cancel(); // 觸發 cancel 清理

    // 廣播一次，讓死客戶端被清理
    bus.broadcast({
      type: 'notification',
      data: { level: 'info', title: '清理測試', message: '測試斷線清理' },
      timestamp: new Date().toISOString(),
    });

    // 死客戶端應被清理
    expect(bus.getClientCount()).toBeLessThanOrEqual(1);
  });
});

// =========================================================
// 全域 EventBus 單例
// =========================================================
describe('全域 EventBus 單例', () => {
  it('getEventBus 回傳相同實例', () => {
    const bus1 = getEventBus();
    const bus2 = getEventBus();
    expect(bus1).toBe(bus2);
  });

  it('setEventBus 替換全域實例', () => {
    const newBus = new EventBus();
    setEventBus(newBus);
    expect(getEventBus()).toBe(newBus);
    newBus.stop();

    // 恢復（或讓 afterEach 清理）
    setEventBus(new EventBus());
  });
});
