// 通知管理器測試
import { describe, expect, test } from 'bun:test';
import { NotificationManager, type NotificationPayload } from '../manager';

// ===== Mock DB =====

function createMockDb() {
  const store = new Map<string, string>();
  return {
    query: (sql: string, _params?: unknown[]) => {
      if (sql.includes('notification_config')) {
        const val = store.get('notification_config');
        return val ? [{ value: val }] : [];
      }
      return [];
    },
    run: (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT OR REPLACE INTO settings')) {
        const key = params?.[0] as string ?? 'unknown';
        const val = params?.[1] as string ?? '';
        store.set(key.replace('last_notification_', 'notif_'), val);
      }
    },
    exec: () => {},
  } as any;
}

// ===== 測試 =====

describe('NotificationManager', () => {
  test('應正確初始化（無設定）', () => {
    const manager = new NotificationManager(createMockDb());
    const config = manager.getConfig();
    expect(config.cli_output).toBe(true);
    expect(config.webhook_url).toBeUndefined();
    manager.dispose();
  });

  test('應觸發內部回呼', async () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });
    const received: NotificationPayload[] = [];

    manager.onNotification((p) => received.push(p));

    await manager.notify('key.dead', {
      service_id: 'openai',
      key_id: 1,
      message: 'OpenAI Key 已死亡',
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe('key.dead');
    expect(received[0]!.service_id).toBe('openai');
    expect(received[0]!.message).toBe('OpenAI Key 已死亡');
    manager.dispose();
  });

  test('應去重相同事件（5 分鐘內）', async () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });
    const received: NotificationPayload[] = [];
    manager.onNotification((p) => received.push(p));

    // 第一次
    await manager.notify('key.rate_limited', {
      service_id: 'groq',
      message: 'Groq 被限速',
    });

    // 第二次（應被去重）
    await manager.notify('key.rate_limited', {
      service_id: 'groq',
      message: 'Groq 被限速（重複）',
    });

    expect(received).toHaveLength(1); // 只收到 1 次
    manager.dispose();
  });

  test('不同服務的相同事件不去重', async () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });
    const received: NotificationPayload[] = [];
    manager.onNotification((p) => received.push(p));

    await manager.notify('key.dead', {
      service_id: 'openai',
      message: 'OpenAI Key 死了',
    });

    await manager.notify('key.dead', {
      service_id: 'anthropic',
      message: 'Anthropic Key 死了',
    });

    expect(received).toHaveLength(2); // 不同服務，不去重
    manager.dispose();
  });

  test('應正確更新設定', () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });

    manager.updateConfig({
      webhook_url: 'https://example.com/webhook',
      webhook_secret: 'my-secret',
      webhook_events: ['key.dead', 'key.rate_limited'],
    });

    const config = manager.getConfig();
    expect(config.webhook_url).toBe('https://example.com/webhook');
    // [MEDIUM-2 修復] getConfig 應遮罩 webhook_secret
    expect(config.webhook_secret).toBe('********');
    expect(config.webhook_events).toHaveLength(2);

    // getRawConfig 不遮罩
    const raw = manager.getRawConfig();
    expect(raw.webhook_secret).toBe('my-secret');
    manager.dispose();
  });

  test('清理過期去重快取', async () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });
    const received: NotificationPayload[] = [];
    manager.onNotification((p) => received.push(p));

    await manager.notify('key.dead', {
      service_id: 'test',
      message: '測試',
    });

    // 清理（因為剛發的不會過期，所以不影響）
    manager.cleanDedup();
    expect(received).toHaveLength(1);
    manager.dispose();
  });

  test('多個回呼都應被觸發', async () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });
    let count1 = 0;
    let count2 = 0;

    manager.onNotification(() => count1++);
    manager.onNotification(() => count2++);

    await manager.notify('growth.milestone', {
      message: 'L2 已解鎖！',
    });

    expect(count1).toBe(1);
    expect(count2).toBe(1);
    manager.dispose();
  });

  test('payload 應包含完整資訊', async () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });
    let captured: NotificationPayload | null = null;
    manager.onNotification((p) => { captured = p; });

    await manager.notify('service.degraded', {
      service_id: 'openai',
      message: 'OpenAI 服務降級',
      data: { success_rate: 0.72 },
    });

    expect(captured).not.toBeNull();
    expect(captured!.event).toBe('service.degraded');
    expect(captured!.timestamp).toBeDefined();
    expect(captured!.data?.success_rate).toBe(0.72);
    manager.dispose();
  });

  // [HIGH-2 修復] 測試 unsubscribe
  test('onNotification 應回傳 unsubscribe 函式', async () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });
    let count = 0;

    const unsub = manager.onNotification(() => count++);

    await manager.notify('key.dead', { message: '第一次' });
    expect(count).toBe(1);

    // 取消訂閱
    unsub();

    await manager.notify('key.recovered', { message: '第二次' });
    expect(count).toBe(1); // 不再收到
    manager.dispose();
  });

  // dispose 測試
  test('dispose 後不再清理 dedup', () => {
    const manager = new NotificationManager(createMockDb(), { cli_output: false });
    manager.dispose();
    // 不 throw 就好
    manager.cleanDedup();
  });
});
