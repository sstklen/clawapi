// WebSocket Manager 單元測試
// 測試內部邏輯（不測實際 WS 升級），使用 mock WebSocket 物件
// 測試場景：認證、訂閱、聊天、離線佇列、IP 限制、同裝置重連、關閉流程、rate limit

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { VPSDatabase } from '../../storage/database';
import { WebSocketManager } from '../manager';
import type { WSConnectionInfo } from '../types';
import { ErrorCode } from '@clawapi/protocol';

// ===== Mock WebSocket =====

// 簡易 Mock WebSocket（追蹤傳送的訊息和關閉呼叫）
class MockWebSocket {
  sentMessages: string[] = [];
  closed = false;
  closeCode: number | null = null;
  closeReason: string | null = null;

  send(data: string): void {
    if (this.closed) throw new Error('WebSocket 已關閉');
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? '';
  }

  // 取得最後一條傳送訊息（已解析 JSON）
  lastMessage(): Record<string, unknown> | null {
    if (this.sentMessages.length === 0) return null;
    return JSON.parse(this.sentMessages[this.sentMessages.length - 1]);
  }

  // 取得所有訊息（已解析 JSON）
  allMessages(): Record<string, unknown>[] {
    return this.sentMessages.map((m) => JSON.parse(m));
  }

  // 清除訊息記錄
  clearMessages(): void {
    this.sentMessages = [];
  }
}

// ===== 測試輔助 =====

// 測試用裝置資料
const DEVICE_A = {
  device_id: 'clw_ws_test01',
  device_fingerprint: 'fp_ws_test01',
  device_token: 'tok_ws_valid_aaa',
  token_expires_at: '2099-12-31T00:00:00Z',
  client_version: '0.1.0',
  os: 'darwin',
  arch: 'arm64',
};

const DEVICE_B = {
  device_id: 'clw_ws_test02',
  device_fingerprint: 'fp_ws_test02',
  device_token: 'tok_ws_valid_bbb',
  token_expires_at: '2099-12-31T00:00:00Z',
  client_version: '0.1.0',
  os: 'linux',
  arch: 'x64',
};

// 插入測試裝置到 DB
function insertDevice(db: VPSDatabase, device: typeof DEVICE_A): void {
  db.run(
    `INSERT INTO devices
      (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      device.device_id,
      device.device_fingerprint,
      device.device_token,
      device.token_expires_at,
      device.client_version,
      device.os,
      device.arch,
    ],
  );
}

// 建立 Manager + 模擬登記連線的輔助函式
function registerMockConnection(
  manager: WebSocketManager,
  device: typeof DEVICE_A,
  ip: string,
  socket?: MockWebSocket,
): MockWebSocket {
  const ws = socket ?? new MockWebSocket();
  manager.registerConnection(
    device.device_id,
    'asia',
    device.client_version,
    ws as unknown as WebSocket,
    ip,
  );
  return ws;
}

// ===== 測試 Suite =====

describe('WebSocketManager', () => {
  let db: VPSDatabase;
  let manager: WebSocketManager;

  beforeEach(async () => {
    db = new VPSDatabase(':memory:');
    await db.init();
    insertDevice(db, DEVICE_A);
    insertDevice(db, DEVICE_B);
    manager = new WebSocketManager(db);
  });

  afterEach(async () => {
    manager.clearAllConnections();
    await db.close();
  });

  // ===== 場景 1：連線認證 — 缺少參數 =====

  describe('場景 1：連線認證', () => {
    test('缺少 device_id → WS_AUTH_FAILED', async () => {
      const result = await manager.validateUpgrade(null, 'some_token', '0.1.0', '127.0.0.1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe(ErrorCode.WS_AUTH_FAILED);
        expect(result.status).toBe(401);
      }
    });

    test('缺少 token → WS_AUTH_FAILED', async () => {
      const result = await manager.validateUpgrade(DEVICE_A.device_id, null, '0.1.0', '127.0.0.1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe(ErrorCode.WS_AUTH_FAILED);
      }
    });

    test('缺少 version → WS_AUTH_FAILED', async () => {
      const result = await manager.validateUpgrade(DEVICE_A.device_id, DEVICE_A.device_token, null, '127.0.0.1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe(ErrorCode.WS_AUTH_FAILED);
      }
    });

    // ===== 場景 2：invalid token =====

    test('invalid token → WS_AUTH_FAILED', async () => {
      const result = await manager.validateUpgrade(
        DEVICE_A.device_id,
        'tok_wrong_token',
        '0.1.0',
        '127.0.0.1',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe(ErrorCode.WS_AUTH_FAILED);
        expect(result.status).toBe(401);
      }
    });

    test('device 不存在 → WS_AUTH_FAILED', async () => {
      const result = await manager.validateUpgrade(
        'clw_not_exist',
        'tok_anything',
        '0.1.0',
        '127.0.0.1',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe(ErrorCode.WS_AUTH_FAILED);
      }
    });

    test('合法認證 → ok: true，帶 deviceId 和 region', async () => {
      const result = await manager.validateUpgrade(
        DEVICE_A.device_id,
        DEVICE_A.device_token,
        '0.1.0',
        '127.0.0.1',
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.deviceId).toBe(DEVICE_A.device_id);
        expect(result.version).toBe('0.1.0');
      }
    });
  });

  // ===== 場景 3：subscribe → subscribe_ack =====

  describe('場景 3：subscribe_ack 回傳正確頻道', () => {
    test('訂閱 routing + notifications → subscribe_ack 包含這兩個頻道', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      ws.clearMessages();  // 清除登記時自動傳的訊息

      manager.handleMessage(
        DEVICE_A.device_id,
        JSON.stringify({
          type: 'subscribe',
          id: 'sub_001',
          payload: {
            channels: ['routing', 'notifications'],
          },
        }),
      );

      const ack = ws.lastMessage();
      expect(ack).not.toBeNull();
      expect(ack!.type).toBe('subscribe_ack');
      const payload = ack!.payload as { subscribed: string[]; online_count: number };
      expect(payload.subscribed).toContain('routing');
      expect(payload.subscribed).toContain('notifications');
      expect(typeof payload.online_count).toBe('number');
    });

    test('訂閱聊天頻道 general → subscribe_ack 包含 chat:general', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      ws.clearMessages();

      manager.handleMessage(
        DEVICE_A.device_id,
        JSON.stringify({
          type: 'subscribe',
          id: 'sub_002',
          payload: {
            chat_channels: ['general'],
          },
        }),
      );

      const ack = ws.lastMessage();
      expect(ack!.type).toBe('subscribe_ack');
      const payload = ack!.payload as { subscribed: string[] };
      expect(payload.subscribed).toContain('chat:general');
    });

    test('訂閱無效頻道 → subscribe_ack subscribed 為空', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      ws.clearMessages();

      manager.handleMessage(
        DEVICE_A.device_id,
        JSON.stringify({
          type: 'subscribe',
          id: 'sub_003',
          payload: {
            channels: ['invalid_channel'],
          },
        }),
      );

      const ack = ws.lastMessage();
      expect(ack!.type).toBe('subscribe_ack');
      const payload = ack!.payload as { subscribed: string[] };
      expect(payload.subscribed).toHaveLength(0);
    });
  });

  // ===== 場景 4：聊天訊息廣播（排除發送者）=====

  describe('場景 4：聊天訊息廣播', () => {
    test('A 傳聊天訊息 → B 收到，A 也收到（廣播給所有人）', () => {
      const wsA = registerMockConnection(manager, DEVICE_A, '10.0.0.1');
      const wsB = registerMockConnection(manager, DEVICE_B, '10.0.0.2');

      // A 和 B 都訂閱 chat:general
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'subscribe', payload: { chat_channels: ['general'] },
      }));
      manager.handleMessage(DEVICE_B.device_id, JSON.stringify({
        type: 'subscribe', payload: { chat_channels: ['general'] },
      }));

      wsA.clearMessages();
      wsB.clearMessages();

      // A 發送聊天訊息
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'chat_message',
        payload: { channel: 'general', text: '大家好' },
      }));

      // B 應該收到聊天訊息
      const bMessages = wsB.allMessages().filter((m) => m.type === 'chat_message');
      expect(bMessages.length).toBeGreaterThanOrEqual(1);
      expect((bMessages[0].payload as { text: string }).text).toBe('大家好');

      // A 自己也收到（廣播給所有訂閱者）
      const aMessages = wsA.allMessages().filter((m) => m.type === 'chat_message');
      expect(aMessages.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===== 場景 5：聊天字數限制 =====

  describe('場景 5：聊天字數限制', () => {
    test('超過 500 字 → 回傳錯誤，不廣播', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');

      // 先訂閱 chat:general
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'subscribe', payload: { chat_channels: ['general'] },
      }));
      ws.clearMessages();

      // 發送超長訊息（501 字元）
      const longText = 'A'.repeat(501);
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'chat_message',
        payload: { channel: 'general', text: longText },
      }));

      // 應收到錯誤，不應有 chat_message 廣播
      const msgs = ws.allMessages();
      const errors = msgs.filter((m) => m.type === 'error');
      const chats = msgs.filter((m) => m.type === 'chat_message');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(chats.length).toBe(0);

      // 錯誤碼應為 WS_CHAT_MESSAGE_TOO_LONG
      const errPayload = errors[0].payload as { error: string };
      expect(errPayload.error).toBe(ErrorCode.WS_CHAT_MESSAGE_TOO_LONG);
    });

    test('500 字（剛好上限）→ 允許', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'subscribe', payload: { chat_channels: ['general'] },
      }));
      ws.clearMessages();

      const exactText = 'A'.repeat(500);
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'chat_message',
        payload: { channel: 'general', text: exactText },
      }));

      const msgs = ws.allMessages();
      const errors = msgs.filter((m) => m.type === 'error');
      const chats = msgs.filter((m) => m.type === 'chat_message');
      expect(errors.length).toBe(0);
      expect(chats.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===== 場景 6：離線佇列 =====

  describe('場景 6：離線佇列', () => {
    test('可以存入訊息到離線佇列', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      const conn = manager.getConnection(DEVICE_A.device_id);
      expect(conn).not.toBeNull();

      // 直接操作 offlineQueue（模擬連線斷開後的佇列）
      const fakeMsg = {
        type: 'notification',
        channel: 'notifications',
        id: 'notif_001',
        payload: { kind: 'test' },
        server_time: new Date().toISOString(),
      };

      manager.queueOfflineMessage(DEVICE_A.device_id, fakeMsg);
      expect(conn!.offlineQueue).toHaveLength(1);
    });

    test('離線佇列上限 20 條（超過則刪最舊的）', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      const conn = manager.getConnection(DEVICE_A.device_id);

      // 塞入 25 條
      for (let i = 0; i < 25; i++) {
        manager.queueOfflineMessage(DEVICE_A.device_id, {
          type: 'notification',
          channel: 'notifications',
          id: `notif_${i.toString().padStart(3, '0')}`,
          payload: { index: i },
          server_time: new Date().toISOString(),
        });
      }

      // 佇列不超過 20
      expect(conn!.offlineQueue.length).toBeLessThanOrEqual(20);
      // 最舊的（index 0-4）應被移除，最新的（index 24）應存在
      const lastItem = conn!.offlineQueue[conn!.offlineQueue.length - 1];
      expect((lastItem.payload as { index: number }).index).toBe(24);
    });
  });

  // ===== 場景 7：IP 連線限制 =====

  describe('場景 7：IP 連線限制（超過 20 → 拒絕）', () => {
    test('同 IP 超過 20 個不同 device 連線 → validateUpgrade 回傳 429', async () => {
      // 建立 21 個假裝置資料並登記連線
      for (let i = 0; i < 20; i++) {
        const fakeDeviceId = `clw_ip_test_${i.toString().padStart(3, '0')}`;
        const fakeToken = `tok_ip_test_${i}`;

        // 直接插入 DB
        db.run(
          `INSERT INTO devices
            (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [fakeDeviceId, `fp_ip_${i}`, fakeToken, '2099-12-31T00:00:00Z', '0.1.0', 'linux', 'x64'],
        );

        const mockWs = new MockWebSocket();
        manager.registerConnection(fakeDeviceId, 'asia', '0.1.0', mockWs as unknown as WebSocket, '192.168.1.100');
      }

      // 第 21 個（不同 device）應被拒絕
      db.run(
        `INSERT INTO devices
          (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['clw_ip_extra', 'fp_extra', 'tok_ip_extra', '2099-12-31T00:00:00Z', '0.1.0', 'linux', 'x64'],
      );

      const result = await manager.validateUpgrade('clw_ip_extra', 'tok_ip_extra', '0.1.0', '192.168.1.100');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(429);
      }
    });
  });

  // ===== 場景 8：同 device 重連 → 舊連線關閉 =====

  describe('場景 8：同 device 重連', () => {
    test('新連線取代舊連線，舊 socket 被關閉', () => {
      const oldWs = registerMockConnection(manager, DEVICE_A, '127.0.0.1');

      // 確認舊連線存在
      expect(manager.getConnection(DEVICE_A.device_id)).not.toBeUndefined();

      // 新連線登記（同 device_id）
      const newWs = new MockWebSocket();
      manager.registerConnection(
        DEVICE_A.device_id,
        'asia',
        '0.1.0',
        newWs as unknown as WebSocket,
        '127.0.0.1',
      );

      // 舊 socket 應被關閉
      expect(oldWs.closed).toBe(true);

      // 新連線應取代舊連線
      const currentConn = manager.getConnection(DEVICE_A.device_id);
      expect(currentConn?.socket).toBe(newWs as unknown as WebSocket);
    });

    test('重連不增加 IP 連線計數', async () => {
      // 第一次連線
      registerMockConnection(manager, DEVICE_A, '10.0.1.1');

      // 重連同一 device（IP 相同）
      const newWs = new MockWebSocket();
      manager.registerConnection(DEVICE_A.device_id, 'asia', '0.1.0', newWs as unknown as WebSocket, '10.0.1.1');

      // 重連後再驗證另一個 device 應該能通過（IP 計數沒增加）
      const result = await manager.validateUpgrade(DEVICE_B.device_id, DEVICE_B.device_token, '0.1.0', '10.0.1.1');
      expect(result.ok).toBe(true);
    });
  });

  // ===== 場景 9：關閉流程清理所有狀態 =====

  describe('場景 9：關閉流程', () => {
    test('handleClose 後 connections Map 不再包含該 device', () => {
      registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      expect(manager.getConnection(DEVICE_A.device_id)).not.toBeUndefined();

      manager.handleClose(DEVICE_A.device_id, '127.0.0.1');

      expect(manager.getConnection(DEVICE_A.device_id)).toBeUndefined();
    });

    test('handleClose 後 getOnlineCount 減少', () => {
      registerMockConnection(manager, DEVICE_A, '10.0.2.1');
      registerMockConnection(manager, DEVICE_B, '10.0.2.2');
      expect(manager.getOnlineCount()).toBe(2);

      manager.handleClose(DEVICE_A.device_id, '10.0.2.1');
      expect(manager.getOnlineCount()).toBe(1);
    });

    test('handleClose 廣播 chat_presence leave 通知', () => {
      const wsA = registerMockConnection(manager, DEVICE_A, '10.0.3.1');
      const wsB = registerMockConnection(manager, DEVICE_B, '10.0.3.2');

      // A 訂閱 chat:general
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'subscribe', payload: { chat_channels: ['general'] },
      }));

      // B 也訂閱 chat:general
      manager.handleMessage(DEVICE_B.device_id, JSON.stringify({
        type: 'subscribe', payload: { chat_channels: ['general'] },
      }));

      wsB.clearMessages();

      // A 關閉連線
      manager.handleClose(DEVICE_A.device_id, '10.0.3.1');

      // B 應收到 chat_presence 離開通知
      const bMessages = wsB.allMessages();
      const presenceMessages = bMessages.filter((m) => m.type === 'chat_presence');
      expect(presenceMessages.length).toBeGreaterThanOrEqual(1);
      const leaveMsg = presenceMessages.find((m) => (m.payload as { event: string }).event === 'leave');
      expect(leaveMsg).not.toBeUndefined();
    });
  });

  // ===== 場景 10：rate limit 計數 =====

  describe('場景 10：Rate Limit 計數', () => {
    test('聊天頻率超限（每 5 秒 1 則）→ 第二則收到錯誤', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');

      // 訂閱 chat:general
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'subscribe', payload: { chat_channels: ['general'] },
      }));
      ws.clearMessages();

      // 第一則（應通過）
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'chat_message',
        payload: { channel: 'general', text: '第一則' },
      }));

      // 第二則（應超限）
      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'chat_message',
        payload: { channel: 'general', text: '第二則（超限）' },
      }));

      const msgs = ws.allMessages();
      const errors = msgs.filter((m) => m.type === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const errPayload = errors[0].payload as { error: string };
      expect(errPayload.error).toBe(ErrorCode.WS_CHAT_RATE_LIMITED);
    });

    test('無效訊息格式 → WS_INVALID_MESSAGE_FORMAT', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      ws.clearMessages();

      // 傳送無效 JSON
      manager.handleMessage(DEVICE_A.device_id, 'not valid json');

      const msgs = ws.allMessages();
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      const errMsg = msgs[0];
      expect(errMsg.type).toBe('error');
      const payload = errMsg.payload as { error: string };
      expect(payload.error).toBe(ErrorCode.WS_INVALID_MESSAGE_FORMAT);
    });

    test('未知訊息 type → WS_INVALID_MESSAGE_FORMAT', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      ws.clearMessages();

      manager.handleMessage(DEVICE_A.device_id, JSON.stringify({
        type: 'unknown_type',
        payload: {},
      }));

      const msgs = ws.allMessages();
      const errors = msgs.filter((m) => m.type === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===== 輔助方法測試 =====

  describe('輔助方法', () => {
    test('getOnlineCount 回傳正確連線數', () => {
      expect(manager.getOnlineCount()).toBe(0);
      registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      expect(manager.getOnlineCount()).toBe(1);
      registerMockConnection(manager, DEVICE_B, '127.0.0.2');
      expect(manager.getOnlineCount()).toBe(2);
    });

    test('getConnectionsByRegion 回傳指定 region 的連線', () => {
      registerMockConnection(manager, DEVICE_A, '127.0.0.1');

      const asiaConns = manager.getConnectionsByRegion('asia');
      expect(asiaConns.length).toBe(1);
      expect(asiaConns[0].deviceId).toBe(DEVICE_A.device_id);

      const euroConns = manager.getConnectionsByRegion('europe');
      expect(euroConns.length).toBe(0);
    });

    test('sendToDevice 傳送訊息給指定裝置', () => {
      const ws = registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      ws.clearMessages();

      const sent = manager.sendToDevice(DEVICE_A.device_id, {
        type: 'test',
        channel: 'system',
        id: 'test_001',
        payload: { hello: 'world' },
        server_time: new Date().toISOString(),
      });

      expect(sent).toBe(true);
      expect(ws.sentMessages.length).toBe(1);
    });

    test('sendToDevice 對不存在的 device 回傳 false', () => {
      const sent = manager.sendToDevice('clw_not_exist', {
        type: 'test',
        channel: 'system',
        id: 'test_002',
        payload: {},
        server_time: new Date().toISOString(),
      });
      expect(sent).toBe(false);
    });

    test('登記連線後自動訂閱系統頻道', () => {
      registerMockConnection(manager, DEVICE_A, '127.0.0.1');
      const conn = manager.getConnection(DEVICE_A.device_id);

      expect(conn?.subscriptions.has('routing')).toBe(true);
      expect(conn?.subscriptions.has('notifications')).toBe(true);
    });
  });
});
