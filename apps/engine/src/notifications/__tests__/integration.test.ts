// KeyPool ↔ NotificationManager 整合測試
// 驗證 Key 狀態變化自動觸發通知
import { describe, expect, test } from 'bun:test';
import { NotificationManager, type NotificationPayload } from '../manager';
import { KeyPool } from '../../core/key-pool';

// ===== Mock 依賴 =====

/** 建立最小 mock DB，支援 keys 表基本操作 */
function createTestDb() {
  const keys = new Map<number, {
    id: number; service_id: string; status: string;
    consecutive_failures: number; key_blob: string;
  }>();
  const settings = new Map<string, string>();
  let nextId = 1;

  return {
    query: (sql: string, params?: unknown[]) => {
      // keys 表查詢
      if (sql.includes('FROM keys') && sql.includes('WHERE id')) {
        const id = params?.[0] as number;
        const key = keys.get(id);
        if (!key) return [];
        return [key];
      }
      if (sql.includes('FROM keys') && sql.includes('WHERE service_id')) {
        const serviceId = params?.[0] as string;
        return [...keys.values()].filter(k => k.service_id === serviceId);
      }
      if (sql.includes('COUNT(*)')) {
        const serviceId = params?.[0] as string;
        const cnt = [...keys.values()].filter(k => k.service_id === serviceId).length;
        return [{ cnt }];
      }
      // settings 表查詢
      if (sql.includes('notification_config')) {
        const val = settings.get('notification_config');
        return val ? [{ value: val }] : [];
      }
      return [];
    },
    run: (sql: string, params?: unknown[]) => {
      // INSERT key
      if (sql.includes('INSERT INTO keys')) {
        const id = nextId++;
        const serviceId = params?.[0] as string;
        keys.set(id, {
          id, service_id: serviceId, status: 'active',
          consecutive_failures: 0, key_blob: params?.[1] as string,
        });
        return { lastInsertRowid: id } as any;
      }
      // UPDATE keys
      if (sql.includes('UPDATE keys')) {
        const id = params?.[params.length - 1] as number;
        const key = keys.get(id);
        if (!key) return;
        if (sql.includes("status = 'active'")) {
          key.status = 'active';
          key.consecutive_failures = 0;
        }
        if (sql.includes("status = 'rate_limited'")) {
          key.status = 'rate_limited';
          key.consecutive_failures += 1;
        }
        if (sql.includes("status = 'dead'")) {
          key.status = 'dead';
        }
        if (sql.includes('consecutive_failures = consecutive_failures + 1') && !sql.includes('status')) {
          key.consecutive_failures += 1;
        }
      }
      // settings 表寫入
      if (sql.includes('INSERT OR REPLACE INTO settings')) {
        const k = params?.[0] as string ?? 'unknown';
        const v = params?.[1] as string ?? '';
        settings.set(k, v);
      }
    },
    exec: () => {},
    // 暴露內部讓測試可以預置 key
    _insertTestKey: (serviceId: string) => {
      const id = nextId++;
      keys.set(id, {
        id, service_id: serviceId, status: 'active',
        consecutive_failures: 0, key_blob: 'encrypted',
      });
      return id;
    },
    _setKeyStatus: (id: number, status: string) => {
      const key = keys.get(id);
      if (key) key.status = status;
    },
  } as any;
}

/** 建立 mock CryptoModule */
function createMockCrypto() {
  return {
    encrypt: (v: string) => `enc:${v}`,
    decrypt: (v: string) => v.replace('enc:', ''),
    maskKey: (v: string) => v.slice(0, 4) + '****',
  } as any;
}

// ===== 整合測試 =====

describe('KeyPool ↔ NotificationManager 整合', () => {
  test('reportAuthError 應觸發 key.dead 通知', async () => {
    const db = createTestDb();
    const keyId = db._insertTestKey('openai');
    const keyPool = new KeyPool(db, createMockCrypto());
    const notifier = new NotificationManager(db, { cli_output: false });
    keyPool.setNotificationManager(notifier);

    const received: NotificationPayload[] = [];
    notifier.onNotification((p) => received.push(p));

    await keyPool.reportAuthError(keyId);

    // 等一下非同步通知
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe('key.dead');
    expect(received[0]!.service_id).toBe('openai');
    expect(received[0]!.key_id).toBe(keyId);
    expect(received[0]!.message).toContain('認證失敗');
  });

  test('reportRateLimit 應觸發 key.rate_limited 通知', async () => {
    const db = createTestDb();
    const keyId = db._insertTestKey('groq');
    const keyPool = new KeyPool(db, createMockCrypto());
    const notifier = new NotificationManager(db, { cli_output: false });
    keyPool.setNotificationManager(notifier);

    const received: NotificationPayload[] = [];
    notifier.onNotification((p) => received.push(p));

    await keyPool.reportRateLimit(keyId);
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe('key.rate_limited');
    expect(received[0]!.service_id).toBe('groq');
    expect(received[0]!.message).toContain('被限速');
  });

  test('reportError 累計 3 次應觸發 key.dead 通知', async () => {
    const db = createTestDb();
    const keyId = db._insertTestKey('anthropic');
    const keyPool = new KeyPool(db, createMockCrypto());
    const notifier = new NotificationManager(db, { cli_output: false });
    keyPool.setNotificationManager(notifier);

    const received: NotificationPayload[] = [];
    notifier.onNotification((p) => received.push(p));

    // 前 2 次不觸發
    await keyPool.reportError(keyId);
    await keyPool.reportError(keyId);
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(0);

    // 第 3 次觸發
    await keyPool.reportError(keyId);
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe('key.dead');
    expect(received[0]!.message).toContain('累計');
  });

  test('reportSuccess 從 rate_limited 恢復應觸發 key.recovered', async () => {
    const db = createTestDb();
    const keyId = db._insertTestKey('deepseek');
    db._setKeyStatus(keyId, 'rate_limited');
    const keyPool = new KeyPool(db, createMockCrypto());
    const notifier = new NotificationManager(db, { cli_output: false });
    keyPool.setNotificationManager(notifier);

    const received: NotificationPayload[] = [];
    notifier.onNotification((p) => received.push(p));

    await keyPool.reportSuccess(keyId);
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe('key.recovered');
    expect(received[0]!.service_id).toBe('deepseek');
    expect(received[0]!.message).toContain('恢復正常');
  });

  test('reportSuccess 已 active 的 Key 不觸發通知', async () => {
    const db = createTestDb();
    const keyId = db._insertTestKey('gemini');
    // 狀態本來就是 active
    const keyPool = new KeyPool(db, createMockCrypto());
    const notifier = new NotificationManager(db, { cli_output: false });
    keyPool.setNotificationManager(notifier);

    const received: NotificationPayload[] = [];
    notifier.onNotification((p) => received.push(p));

    await keyPool.reportSuccess(keyId);
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(0); // active → active 不通知
  });

  test('無 NotificationManager 時不會報錯', async () => {
    const db = createTestDb();
    const keyId = db._insertTestKey('openai');
    const keyPool = new KeyPool(db, createMockCrypto());
    // 不注入 notifier

    // 所有 report 都不應 throw
    await keyPool.reportSuccess(keyId);
    await keyPool.reportRateLimit(keyId);
    await keyPool.reportAuthError(keyId);
    await keyPool.reportError(keyId);
    // 通過 = 不會因為沒有 notifier 而爆掉
  });
});
