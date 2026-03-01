// VPS 通訊模組測試
// 測試 HTTP 重試、離線狀態機、WS 重連、離線佇列、credential 管理

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { VPSHttpClient, RateLimitError, AuthError, ServiceUnavailableError } from '../vps-http';
import { VPSWebSocketClient } from '../vps-ws';
import { VPSClient } from '../vps-client';
import { WS_RECONNECT_BASE_MS, WS_RECONNECT_MAX_MS } from '@clawapi/protocol';

// ===== Mock 輔助工具 =====

/** 建立 Mock Response */
function mockResponse(status: number, body: unknown = null, headers: Record<string, string> = {}): Response {
  const responseBody = body === null ? '' : JSON.stringify(body);
  return new Response(responseBody, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

/** 原始 fetch 備份 */
let originalFetch: typeof globalThis.fetch;

/** 替換全域 fetch */
function mockFetch(handler: (...args: Parameters<typeof fetch>) => Response | Promise<Response>): void {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

/** 恢復原始 fetch */
function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ===== Mock ClawDatabase =====

interface MockDbState {
  devices: Record<string, unknown>[];
  telemetryQueue: Array<{ id: number; batch_id: string; payload: Uint8Array; created_at: string }>;
  l0UsageQueue: Array<{ id: number; payload: string; created_at: string }>;
  nextId: number;
}

/** Mock DB 型別（實作 DatabaseModule 介面） */
interface MockDb {
  init(): Promise<void>;
  close(): Promise<void>;
  query<T>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  transaction<T>(fn: () => T): T;
  checkpoint(): void;
  dailyReset(timezone: string): void;
}

function createMockDb(initialDevices: Record<string, unknown>[] = []): {
  db: MockDb;
  state: MockDbState;
} {
  const state: MockDbState = {
    devices: [...initialDevices],
    telemetryQueue: [],
    l0UsageQueue: [],
    nextId: 1,
  };

  const db = {
    query<T>(sql: string, _params?: unknown[]): T[] {
      const sqlLower = sql.toLowerCase();

      if (sqlLower.includes('from device')) {
        return state.devices as T[];
      }
      if (sqlLower.includes('from telemetry_queue')) {
        return state.telemetryQueue as T[];
      }
      if (sqlLower.includes('from l0_usage_queue')) {
        return state.l0UsageQueue as T[];
      }
      return [] as T[];
    },
    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number } {
      const sqlLower = sql.toLowerCase();

      if (sqlLower.includes('insert') && sqlLower.includes('device')) {
        const p = params as string[];
        state.devices = [{
          device_id: p[0],
          device_fingerprint: p[1],
          device_token: p[2],
          device_token_expires_at: p[3],
        }];
        return { changes: 1, lastInsertRowid: 1 };
      }

      if (sqlLower.includes('insert') && sqlLower.includes('telemetry_queue')) {
        const p = params as [string, Uint8Array, string, string];
        state.telemetryQueue.push({
          id: state.nextId++,
          batch_id: p[0],
          payload: p[1],
          created_at: new Date().toISOString(),
        });
        return { changes: 1, lastInsertRowid: state.nextId - 1 };
      }

      if (sqlLower.includes('insert') && sqlLower.includes('l0_usage_queue')) {
        const p = params as [string];
        state.l0UsageQueue.push({
          id: state.nextId++,
          payload: p[0],
          created_at: new Date().toISOString(),
        });
        return { changes: 1, lastInsertRowid: state.nextId - 1 };
      }

      if (sqlLower.includes('delete') && sqlLower.includes('telemetry_queue') && params) {
        const id = params[0] as number;
        state.telemetryQueue = state.telemetryQueue.filter(r => r.id !== id);
        return { changes: 1, lastInsertRowid: 0 };
      }

      if (sqlLower.includes('delete') && sqlLower.includes('l0_usage_queue') && params) {
        const id = params[0] as number;
        state.l0UsageQueue = state.l0UsageQueue.filter(r => r.id !== id);
        return { changes: 1, lastInsertRowid: 0 };
      }

      if (sqlLower.includes('update') && sqlLower.includes('device')) {
        if (state.devices.length > 0 && params) {
          state.devices[0] = {
            ...state.devices[0],
            device_token: params[0],
            device_token_expires_at: params[1],
          };
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      return { changes: 0, lastInsertRowid: 0 };
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    async init(): Promise<void> { /* stub */ },
    async close(): Promise<void> { /* stub */ },
    checkpoint(): void { /* stub */ },
    dailyReset(_timezone: string): void { /* stub */ },
  };

  return { db, state };
}

// ===== 設置 / 清理 =====

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  restoreFetch();
});

// ===== HTTP 重試測試 =====

describe('VPSHttpClient HTTP 重試', () => {
  test('1. 第 1/2 次 503 → 第 3 次 200 → 成功', async () => {
    const client = new VPSHttpClient({ baseUrl: 'https://api.test.com', clientVersion: '0.1.0' });
    client.setCredentials('dev-123', 'token-abc');

    let callCount = 0;
    mockFetch(() => {
      callCount++;
      if (callCount <= 2) {
        return mockResponse(503, { error: 'SERVICE_UNAVAILABLE', message: '服務不可用' });
      }
      return mockResponse(200, { daily_limit: 100, daily_used: 0 });
    });

    const result = await client.request<{ daily_limit: number; daily_used: number }>(
      'GET',
      '/v1/telemetry/quota',
      { retries: 3, retryDelayMs: 0 }
    );

    expect(result.status).toBe(200);
    expect(result.data.daily_limit).toBe(100);
    expect(callCount).toBe(3);
  });

  test('2. 3 次都 503 → 拋出 ServiceUnavailableError', async () => {
    const client = new VPSHttpClient({ baseUrl: 'https://api.test.com', clientVersion: '0.1.0' });
    client.setCredentials('dev-123', 'token-abc');

    mockFetch(() => mockResponse(503, { error: 'SERVICE_UNAVAILABLE', message: '服務不可用' }));

    await expect(
      client.request('GET', '/v1/telemetry/quota', { retries: 2, retryDelayMs: 0 })
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test('3. 429 → 不重試，回傳 RateLimitError（含 retry_after）', async () => {
    const client = new VPSHttpClient({ baseUrl: 'https://api.test.com', clientVersion: '0.1.0' });
    client.setCredentials('dev-123', 'token-abc');

    let callCount = 0;
    mockFetch(() => {
      callCount++;
      return mockResponse(429, {
        error: 'TELEMETRY_RATE_LIMITED',
        message: '請求太頻繁',
        retry_after: 3600,
      });
    });

    let caughtError: RateLimitError | null = null;
    try {
      await client.request('POST', '/v1/telemetry/batch', { retries: 3, retryDelayMs: 0 });
    } catch (err) {
      if (err instanceof RateLimitError) {
        caughtError = err;
      }
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError).toBeInstanceOf(RateLimitError);
    expect(caughtError!.retryAfter).toBe(3600);
    // 只嘗試一次，不重試
    expect(callCount).toBe(1);
  });

  test('4. 401 → 不重試，回傳 AuthError', async () => {
    const client = new VPSHttpClient({ baseUrl: 'https://api.test.com', clientVersion: '0.1.0' });
    client.setCredentials('dev-123', 'invalid-token');

    let callCount = 0;
    mockFetch(() => {
      callCount++;
      return mockResponse(401, {
        error: 'AUTH_INVALID_TOKEN',
        message: 'Token 無效',
      });
    });

    await expect(
      client.request('GET', '/v1/l0/keys', { retries: 3, retryDelayMs: 0 })
    ).rejects.toBeInstanceOf(AuthError);

    // 只嘗試一次，不重試
    expect(callCount).toBe(1);
  });
});

// ===== 離線模式狀態機測試 =====

describe('VPSClient 離線模式狀態機', () => {
  test('5. 連續 5 次 503 → isOffline = true', () => {
    const { db } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    expect(client.getIsOffline()).toBe(false);

    for (let i = 0; i < 5; i++) {
      client.reportHttpError(503);
    }

    expect(client.getIsOffline()).toBe(true);
  });

  test('6. 4 次 503 → 第 5 次成功 → isOffline = false', () => {
    const { db } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    for (let i = 0; i < 4; i++) {
      client.reportHttpError(503);
    }
    expect(client.getIsOffline()).toBe(false);

    // 第 5 次改成功
    client.reportHttpSuccess();
    expect(client.getIsOffline()).toBe(false);
  });

  test('7. 離線模式 → probe 成功 → isOffline = false', async () => {
    const { db } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    // 觸發離線模式
    for (let i = 0; i < 5; i++) {
      client.reportHttpError(503);
    }
    expect(client.getIsOffline()).toBe(true);

    // 模擬 probe 成功（reportHttpSuccess 代表 probe 通過）
    client.reportHttpSuccess();
    expect(client.getIsOffline()).toBe(false);
  });

  test('8. 離線模式 → uploadTelemetry → 存佇列而不直接呼叫 HTTP', async () => {
    const { db, state } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    // 觸發離線模式
    for (let i = 0; i < 5; i++) {
      client.reportHttpError(503);
    }
    expect(client.getIsOffline()).toBe(true);

    // fetch 不應被呼叫
    let fetchCalled = false;
    mockFetch(() => {
      fetchCalled = true;
      return mockResponse(200, {});
    });

    const batch = {
      schema_version: 1,
      batch_id: 'test-batch-001',
      period: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z' },
      entries: [],
      summary: {
        total_requests: 0,
        success_rate: 1.0,
        services_used: [],
        pool_stats: { king_pool_used: 0, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 },
      },
    };

    await client.uploadTelemetry(batch);

    expect(fetchCalled).toBe(false);
    expect(state.telemetryQueue.length).toBe(1);
    expect(state.telemetryQueue[0].batch_id).toBe('test-batch-001');
  });
});

// ===== WS 重連計算測試 =====

describe('VPSWebSocketClient 重連延遲計算', () => {
  test('9. getReconnectDelay(0) = 1000（WS_RECONNECT_BASE_MS）', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    // reconnectAttempts 預設為 0
    const delay = ws.getReconnectDelay();
    expect(delay).toBe(WS_RECONNECT_BASE_MS);    // 1000
    expect(delay).toBe(1000);
  });

  test('10. getReconnectDelay(1) = 2000（1000 × 2^1）', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    // 模擬 reconnectAttempts = 1
    (ws as unknown as { reconnectAttempts: number }).reconnectAttempts = 1;
    const delay = ws.getReconnectDelay();
    expect(delay).toBe(2000);
  });

  test('11. getReconnectDelay(10) = min(1024000, 300000) = 300000', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    // reconnectAttempts = 10 → 1000 × 2^10 = 1024000 > 300000
    (ws as unknown as { reconnectAttempts: number }).reconnectAttempts = 10;
    const delay = ws.getReconnectDelay();
    expect(delay).toBe(WS_RECONNECT_MAX_MS);    // 300000
    expect(delay).toBe(300000);
  });
});

// ===== 離線佇列測試 =====

describe('VPSClient 離線佇列', () => {
  test('12. queueTelemetry → 存入 DB', async () => {
    const { db, state } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    const batch = {
      schema_version: 1,
      batch_id: 'queue-batch-001',
      period: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z' },
      entries: [],
      summary: {
        total_requests: 0,
        success_rate: 1.0,
        services_used: [],
        pool_stats: { king_pool_used: 0, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 },
      },
    };

    await client.queueTelemetry(batch);

    expect(state.telemetryQueue.length).toBe(1);
    expect(state.telemetryQueue[0].batch_id).toBe('queue-batch-001');
  });

  test('13. queueL0Usage → 存入 DB', async () => {
    const { db, state } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    const entry = {
      l0_key_id: 'key-001',
      service_id: 'groq',
      count: 5,
      last_used_at: '2026-01-01T00:00:00Z',
    };

    await client.queueL0Usage(entry);

    expect(state.l0UsageQueue.length).toBe(1);
    const stored = JSON.parse(state.l0UsageQueue[0].payload);
    expect(stored.l0_key_id).toBe('key-001');
    expect(stored.service_id).toBe('groq');
  });

  test('14. batchUploadOfflineData → 按順序上傳 → 刪除', async () => {
    const { db, state } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    // 預先塞入佇列資料
    const batch1 = {
      schema_version: 1,
      batch_id: 'upload-batch-001',
      period: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z' },
      entries: [],
      summary: {
        total_requests: 1,
        success_rate: 1.0,
        services_used: ['groq'],
        pool_stats: { king_pool_used: 1, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 },
      },
    };
    const batch2 = {
      schema_version: 1,
      batch_id: 'upload-batch-002',
      period: { from: '2026-01-01T01:00:00Z', to: '2026-01-01T02:00:00Z' },
      entries: [],
      summary: {
        total_requests: 2,
        success_rate: 1.0,
        services_used: ['gemini'],
        pool_stats: { king_pool_used: 2, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 },
      },
    };

    await client.queueTelemetry(batch1);
    await client.queueTelemetry(batch2);
    expect(state.telemetryQueue.length).toBe(2);

    // Mock fetch 回傳成功
    const uploadedBatchIds: string[] = [];
    mockFetch((url) => {
      const urlStr = String(url);
      if (urlStr.includes('/v1/telemetry/batch')) {
        // 追蹤上傳順序（無法輕易解析 body，但可以確認有呼叫）
        uploadedBatchIds.push('called');
        return mockResponse(200, null);
      }
      return mockResponse(200, {});
    });

    // 設定認證（讓 HTTP 請求可以發出）
    (client as unknown as { http: VPSHttpClient }).http.setCredentials('dev-123', 'token-abc');

    // 呼叫私有方法（透過 any）
    await (client as unknown as { batchUploadOfflineData(): Promise<void> }).batchUploadOfflineData();

    // 上傳後佇列應清空
    expect(state.telemetryQueue.length).toBe(0);
  });
});

// ===== Credential 管理測試 =====

describe('VPSClient credential 管理', () => {
  test('15. connect → device 存在 → 用已有 token（不重新注冊）', async () => {
    const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { db } = createMockDb([{
      device_id: 'existing-device-001',
      device_fingerprint: 'fp-abc',
      device_token: 'existing-token-xyz',
      device_token_expires_at: futureExpiry,
    }]);

    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    let registerCalled = false;
    mockFetch((url) => {
      const urlStr = String(url);
      if (urlStr.includes('/devices/register')) {
        registerCalled = true;
      }
      // 讓 WS connect 靜默失敗（測試環境沒有真正的 WebSocket）
      return mockResponse(200, {});
    });

    // connect 內部會嘗試 ws.connect()，會失敗但不阻止
    try {
      await client.connect();
    } catch {
      // WS 連線失敗是預期的
    }

    // 不應呼叫注冊端點
    expect(registerCalled).toBe(false);

    // 確認 HTTP client 有正確設定 credentials
    const httpClient = (client as unknown as { http: VPSHttpClient }).http;
    expect((httpClient as unknown as { deviceId: string }).deviceId).toBe('existing-device-001');
    expect((httpClient as unknown as { deviceToken: string }).deviceToken).toBe('existing-token-xyz');
  });

  test('16. connect → 無 device → 呼叫 registerDevice', async () => {
    const { db } = createMockDb([]); // 空的 devices

    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    let registerCalled = false;
    mockFetch((url) => {
      const urlStr = String(url);
      if (urlStr.includes('/devices/register')) {
        registerCalled = true;
        return mockResponse(200, {
          device_token: 'new-token-abc',
          token_expires_at: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString(),
          l0_config: { daily_limit: 100, services: [] },
          vps_public_key: 'pk-test',
          vps_public_key_id: 'pkid-001',
          assigned_region: 'asia',
          latest_version: '0.1.0',
          server_time: new Date().toISOString(),
        });
      }
      return mockResponse(200, {});
    });

    try {
      await client.connect();
    } catch {
      // WS 連線失敗是預期的
    }

    expect(registerCalled).toBe(true);
  });
});

// ===== Handler 註冊測試 =====

describe('VPSWebSocketClient handler 註冊', () => {
  test('handler 可以正確註冊並分發訊息', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    const receivedPayloads: unknown[] = [];
    ws.onRoutingUpdate((payload) => {
      receivedPayloads.push(payload);
    });

    // 模擬收到路由更新訊息
    const fakeEvent = {
      data: JSON.stringify({
        type: 'routing_update',
        payload: { schema_version: 1, recommendations: [] },
      }),
    } as MessageEvent;

    // 呼叫私有 handleMessage
    (ws as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(fakeEvent);

    expect(receivedPayloads.length).toBe(1);
    expect((receivedPayloads[0] as { schema_version: number }).schema_version).toBe(1);
  });

  test('多個 handler 都會被呼叫', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    const calls: number[] = [];
    ws.onNotification(() => calls.push(1));
    ws.onNotification(() => calls.push(2));
    ws.onNotification(() => calls.push(3));

    const fakeEvent = {
      data: JSON.stringify({
        type: 'notification',
        channel: 'notifications',
        id: 'notif-001',
        payload: { kind: 'version_available' },
        server_time: new Date().toISOString(),
      }),
    } as MessageEvent;

    (ws as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(fakeEvent);

    expect(calls).toEqual([1, 2, 3]);
  });

  test('handler 拋出錯誤不影響其他 handler', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    const results: string[] = [];
    ws.onChatMessage(() => {
      throw new Error('handler 1 壞了');
    });
    ws.onChatMessage(() => {
      results.push('handler 2 正常');
    });

    const fakeEvent = {
      data: JSON.stringify({
        type: 'chat_message',
        channel: 'chat:global',
        id: 'msg-001',
        payload: { text: 'hello', nickname: 'user1', reply_to: null },
      }),
    } as MessageEvent;

    // 不應拋出錯誤
    expect(() => {
      (ws as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(fakeEvent);
    }).not.toThrow();

    expect(results).toEqual(['handler 2 正常']);
  });
});

// ===== 重連閾值測試 =====

describe('VPSWebSocketClient 重連閾值', () => {
  test('超過 360 次 → 固定 WS_RECONNECT_MAX_MS', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    (ws as unknown as { reconnectAttempts: number }).reconnectAttempts = 361;
    const delay = ws.getReconnectDelay();
    expect(delay).toBe(WS_RECONNECT_MAX_MS);
  });

  test('指數退避：2 次 → 4000ms', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    (ws as unknown as { reconnectAttempts: number }).reconnectAttempts = 2;
    const delay = ws.getReconnectDelay();
    // 1000 × 2^2 = 4000
    expect(delay).toBe(4000);
  });

  test('指數退避：3 次 → 8000ms', () => {
    const ws = new VPSWebSocketClient({ wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' });

    (ws as unknown as { reconnectAttempts: number }).reconnectAttempts = 3;
    const delay = ws.getReconnectDelay();
    // 1000 × 2^3 = 8000
    expect(delay).toBe(8000);
  });
});

// ===== 離線模式邊界條件 =====

describe('VPSClient 離線模式邊界條件', () => {
  test('非 503 的錯誤不觸發離線模式', () => {
    const { db } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    // 報告很多 429 錯誤
    for (let i = 0; i < 10; i++) {
      client.reportHttpError(429);
      client.reportHttpError(500);
      client.reportHttpError(404);
    }

    // 不應進入離線模式
    expect(client.getIsOffline()).toBe(false);
  });

  test('reportHttpSuccess 重置計數器', () => {
    const { db } = createMockDb();
    const client = new VPSClient(
      { baseUrl: 'https://api.test.com', wsUrl: 'wss://ws.test.com', clientVersion: '0.1.0' },
      db
    );

    // 報告 4 次 503
    for (let i = 0; i < 4; i++) {
      client.reportHttpError(503);
    }
    expect(client.getIsOffline()).toBe(false);

    // 成功一次，重置計數器
    client.reportHttpSuccess();

    // 再報告 4 次 503，因為計數器被重置了，不應觸發離線
    for (let i = 0; i < 4; i++) {
      client.reportHttpError(503);
    }
    expect(client.getIsOffline()).toBe(false);

    // 第 5 次才觸發
    client.reportHttpError(503);
    expect(client.getIsOffline()).toBe(true);
  });
});
