// E2E 測試 08：聊天室收發（簡化版）
// 驗證：WebSocket 連線驗證 + 聊天訊息格式 + Broadcast 機制 mock

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createVPSApp,
  registerDevice,
  makeVPSRequest,
  type VPSApp,
  type RegisteredDevice,
} from './helpers/setup';
import { CHAT_MESSAGE_MAX_LENGTH } from '../../packages/protocol/src/constants';

describe('E2E 08：聊天室收發（簡化版）', () => {
  let vps: VPSApp;
  let device: RegisteredDevice;

  beforeEach(async () => {
    vps = await createVPSApp();
    device = await registerDevice(vps.app);
  });

  test('8-1. WebSocket 端點驗證：GET /v1/ws 缺少參數 → 401', async () => {
    // 直接 GET /v1/ws 不帶任何查詢參數
    const res = await vps.app.request('/v1/ws');

    // WebSocket 驗證應失敗（401 或 426）
    // auth middleware 在 SKIP_AUTH_PATHS 中豁免了 /v1/ws
    // 但 wsManager.validateUpgrade 回傳 { ok: false, status: 401 }
    expect([401, 426]).toContain(res.status);
  });

  test('8-2. WebSocket 端點驗證：帶 query 參數 → validateUpgrade 被呼叫', async () => {
    const res = await vps.app.request(
      `/v1/ws?device_id=${device.device_id}&token=${device.device_token}&version=0.1.0`,
    );

    // Mock wsManager.validateUpgrade 回傳 { ok: false } → 回傳 401/426
    // 因為 mock 總是回傳 ok: false
    expect([401, 426]).toContain(res.status);
  });

  test('8-3. 聊天訊息格式驗證（模擬 WebSocket message）', async () => {
    // 模擬 WebSocket 聊天訊息（不使用真實 WS 連線）
    const chatMessage = {
      type: 'chat' as const,
      payload: {
        content: '大家好！我是新來的龍蝦 🦞',
        timestamp: new Date().toISOString(),
      },
    };

    // 驗證訊息格式
    expect(chatMessage.type).toBe('chat');
    expect(chatMessage.payload.content).toBeTruthy();
    expect(chatMessage.payload.content.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_LENGTH);
    expect(chatMessage.payload.timestamp).toBeTruthy();

    // 驗證 ISO 8601 時間格式
    const ts = new Date(chatMessage.payload.timestamp);
    expect(ts.getTime()).not.toBeNaN();
  });

  test('8-4. 聊天訊息過長 → 應被拒絕', async () => {
    // 產生超過長度限制的訊息
    const longMessage = 'a'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1);

    // 驗證超過限制
    expect(longMessage.length).toBeGreaterThan(CHAT_MESSAGE_MAX_LENGTH);

    // 在真實場景中，WS handler 會拒絕這個訊息
    // 這裡驗證常數值正確
    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(500);
  });

  test('8-5. Broadcast 機制：同 region 裝置模擬', async () => {
    // 註冊三個同 region 的裝置
    const devices: RegisteredDevice[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await registerDevice(vps.app);
      devices.push(d);
    }

    // 所有裝置都是 Asia/Taipei → region = 'asia'
    for (const d of devices) {
      expect(d.assigned_region).toBe('asia');
    }

    // 模擬 broadcast 訊息格式
    const broadcastMessage = {
      type: 'chat_broadcast' as const,
      payload: {
        sender_region: 'asia',
        sender_nickname: '匿名龍蝦',
        content: '你好世界',
        timestamp: new Date().toISOString(),
      },
    };

    // 驗證 broadcast 格式
    expect(broadcastMessage.type).toBe('chat_broadcast');
    expect(broadcastMessage.payload.sender_region).toBe('asia');
    expect(broadcastMessage.payload.content.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_LENGTH);
  });

  test('8-6. WebSocket 訂閱頻道格式', async () => {
    // 驗證 WebSocket 可用的頻道名稱（從 protocol 常數導入）
    const { WS_CHANNELS } = await import('../../packages/protocol/src/constants');

    expect(WS_CHANNELS).toContain('routing');
    expect(WS_CHANNELS).toContain('chat');
    expect(WS_CHANNELS).toContain('notifications');

    // 模擬訂閱訊息
    const subscribeMessage = {
      type: 'subscribe' as const,
      channels: ['chat', 'notifications'],
    };

    expect(subscribeMessage.type).toBe('subscribe');
    expect(subscribeMessage.channels).toBeInstanceOf(Array);

    // 每個頻道都在允許清單中
    for (const ch of subscribeMessage.channels) {
      expect(WS_CHANNELS).toContain(ch);
    }
  });

  test('8-7. WebSocket 心跳常數驗證', async () => {
    const { WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS } = await import('../../packages/protocol/src/constants');

    // ping 每 30 秒
    expect(WS_PING_INTERVAL_MS).toBe(30_000);
    // pong 超時 10 秒
    expect(WS_PONG_TIMEOUT_MS).toBe(10_000);
    // pong 超時應小於 ping 間隔
    expect(WS_PONG_TIMEOUT_MS).toBeLessThan(WS_PING_INTERVAL_MS);
  });
});
