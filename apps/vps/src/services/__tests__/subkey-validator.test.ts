// SubKeyValidator 服務層單元測試
// 測試：快取命中、發行者離線、WS 問詢流程、超時、結果快取
// 使用 mock DB 和 mock wsManager，不測試實際 WebSocket 連線

import { describe, it, expect, beforeEach } from 'bun:test';
import { SubKeyValidator } from '../subkey-validator';
import type { SubKeyResultPayload } from '../subkey-validator';
import { ErrorCode } from '@clawapi/protocol';
import type { VPSDatabase } from '../../storage/database';
import type { WebSocketManager } from '../../ws/manager';

// ===== Mock DB 建構器 =====

function createMockDb(options: {
  deviceId?: string;     // 模擬存在的裝置（device_id）
  deviceStatus?: string; // 裝置狀態（預設 'active'）
} = {}) {
  const {
    deviceId = 'clw_abcd1234xxxxxxxxxxxxxxxxxxxxxxxx',
    deviceStatus = 'active',
  } = options;

  // 模擬 devices 表（只存一筆）
  const devices: Map<string, { device_id: string; status: string }> = new Map();
  if (deviceId) {
    devices.set(deviceId, { device_id: deviceId, status: deviceStatus });
  }

  return {
    _getDevices() { return devices; },
    _addDevice(id: string, status = 'active') {
      devices.set(id, { device_id: id, status });
    },
    _clearDevices() { devices.clear(); },

    query<T>(sql: string, params?: unknown[]): T[] {
      const s = sql.trim().toLowerCase();

      // 查詢 devices 表（LIKE device_id 前綴）
      if (s.includes('from devices') && s.includes('like') && params?.[0]) {
        const prefix = (params[0] as string).replace('%', '');
        const results: { device_id: string }[] = [];

        for (const [did, dev] of devices.entries()) {
          // 比對 device_id 去掉 clw_ 後的前 8 字元
          const hashPart = did.slice(4, 12); // 'clw_' = 4 chars
          if (hashPart === prefix && dev.status === 'active') {
            results.push({ device_id: did });
            break; // LIMIT 1
          }
        }
        return results as unknown as T[];
      }

      return [] as T[];
    },

    run(_sql: string, _params?: unknown[]) {
      return { changes: 0, lastInsertRowid: 0 };
    },

    getDevice(_deviceId: string) { return null; },
    getDeviceByToken(_token: string) { return null; },
    updateDeviceLastSeen(_deviceId: string): void { },
    transaction<T>(fn: () => T): T { return fn(); },
    checkpoint(): void { },
  } as unknown as VPSDatabase;
}

// ===== Mock WebSocketManager 建構器 =====

function createMockWsManager(options: {
  onlineDevices?: string[];  // 在線的裝置 ID 列表
} = {}) {
  const { onlineDevices = [] } = options;

  const onlineSet = new Set(onlineDevices);

  // 記錄 sendToDevice 呼叫
  const sendCalls: Array<{ deviceId: string; message: unknown }> = [];

  // 記錄 broadcastToChannel 呼叫
  const broadcastCalls: Array<{ channel: string; payload: unknown }> = [];

  return {
    _getSendCalls() { return sendCalls; },
    _getBroadcastCalls() { return broadcastCalls; },
    _setOnline(deviceId: string, online: boolean) {
      if (online) onlineSet.add(deviceId);
      else onlineSet.delete(deviceId);
    },
    _getLastSend() { return sendCalls[sendCalls.length - 1] ?? null; },

    getConnection(deviceId: string): unknown {
      return onlineSet.has(deviceId) ? { deviceId } : undefined;
    },

    sendToDevice(deviceId: string, message: unknown): boolean {
      if (!onlineSet.has(deviceId)) return false;
      sendCalls.push({ deviceId, message });
      return true;
    },

    broadcastToChannel(channel: string, payload: unknown): void {
      broadcastCalls.push({ channel, payload });
    },

    getOnlineCount(): number {
      return onlineSet.size;
    },
  } as unknown as WebSocketManager;
}

// ===== 測試用常數 =====

// 有效的 Sub-Key 格式：sk_live_{8 hex}_{random}
// device_id_hash = device_id 去掉 'clw_' 後的前 8 字元 = 'abcd1234'
const VALID_DEVICE_ID = 'clw_abcd1234xxxxxxxxxxxxxxxxxxxxxxxx';
const VALID_SUB_KEY = 'sk_live_abcd1234_randomsuffix123';
const SERVICE_ID = 'openai';

// ===== SubKeyValidator 測試 =====

describe('SubKeyValidator', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let validator: SubKeyValidator;

  beforeEach(() => {
    db = createMockDb({ deviceId: VALID_DEVICE_ID });
    wsManager = createMockWsManager({ onlineDevices: [VALID_DEVICE_ID] });
    validator = new SubKeyValidator(db as unknown as VPSDatabase, wsManager as unknown as WebSocketManager);
  });

  // ===== 輔助函式：完成一次驗證（攔截並立即回應）=====
  // 透過替換 sendToDevice 來攔截 requestId，並在下一個 microtask 回應
  async function doValidateWithReply(
    v: SubKeyValidator,
    wm: ReturnType<typeof createMockWsManager>,
    token: string,
    serviceId: string,
    replyPayload: Omit<SubKeyResultPayload, 'request_id'> = { valid: true },
  ): Promise<SubKeyResultPayload & { valid: boolean }> {
    let capturedId = '';

    const originalSend = (wm as unknown as { sendToDevice: (deviceId: string, message: unknown) => boolean }).sendToDevice.bind(wm);
    (wm as unknown as { sendToDevice: (deviceId: string, message: unknown) => boolean }).sendToDevice = (deviceId: string, message: unknown) => {
      const msg = message as { id: string };
      capturedId = msg.id;
      const r = originalSend(deviceId, message);
      // 在下一個 microtask 回應，確保 pendingRequests 已登記
      queueMicrotask(() => {
        if (capturedId) {
          v.handleSubKeyResult(capturedId, {
            request_id: capturedId,
            ...replyPayload,
          });
        }
      });
      return r;
    };

    return v.validate(token, serviceId) as Promise<SubKeyResultPayload & { valid: boolean }>;
  }

  // ===== 驗收標準 4：快取命中（5 分鐘內不重複問）=====
  describe('快取行為', () => {
    it('快取命中時不應再次發送 WS 請求', async () => {
      // 第一次驗證（完整 WS 流程）
      const firstResult = await doValidateWithReply(validator, wsManager, VALID_SUB_KEY, SERVICE_ID, {
        valid: true,
        permissions: ['read'],
      });
      expect(firstResult.valid).toBe(true);

      // 記錄 sendToDevice 呼叫次數
      const mockWmTyped = wsManager as unknown as { _getSendCalls: () => unknown[] };
      const sendCountAfterFirst = mockWmTyped._getSendCalls().length;

      // 第二次驗證（應命中快取，不再發送 WS 請求）
      const secondResult = await validator.validate(VALID_SUB_KEY, SERVICE_ID);
      expect(secondResult.valid).toBe(true);

      // 快取命中：sendToDevice 次數不變
      const sendCountAfterSecond = mockWmTyped._getSendCalls().length;
      expect(sendCountAfterSecond).toBe(sendCountAfterFirst);
    });

    it('快取應在指定時間內有效（getCacheSize 確認）', async () => {
      // 清除快取
      validator.clearCache();
      expect(validator.getCacheSize()).toBe(0);

      // 完成一次驗證後快取應增加
      await doValidateWithReply(validator, wsManager, VALID_SUB_KEY, SERVICE_ID, { valid: true });
      expect(validator.getCacheSize()).toBe(1);
    });
  });

  // ===== 驗收標準 5：發行者離線 → 503 =====
  describe('發行者離線處理', () => {
    it('發行者不在線時應拋出 SUBKEY_ISSUER_OFFLINE', async () => {
      // 設定發行者離線
      (wsManager as unknown as { _setOnline: (id: string, online: boolean) => void })
        ._setOnline(VALID_DEVICE_ID, false);

      let caughtError: unknown = null;
      try {
        await validator.validate(VALID_SUB_KEY, SERVICE_ID);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      const error = caughtError as { errorCode: string };
      expect(error.errorCode).toBe(ErrorCode.SUBKEY_ISSUER_OFFLINE);
    });

    it('發行者離線時不應發送 WS 請求', async () => {
      (wsManager as unknown as { _setOnline: (id: string, online: boolean) => void })
        ._setOnline(VALID_DEVICE_ID, false);

      const sendCountBefore = (wsManager as unknown as { _getSendCalls: () => unknown[] })
        ._getSendCalls().length;

      try {
        await validator.validate(VALID_SUB_KEY, SERVICE_ID);
      } catch {
        // 預期失敗
      }

      const sendCountAfter = (wsManager as unknown as { _getSendCalls: () => unknown[] })
        ._getSendCalls().length;
      expect(sendCountAfter).toBe(sendCountBefore);
    });
  });

  // ===== Sub-Key 格式驗證 =====
  describe('Sub-Key 格式驗證', () => {
    it('無效格式的 token 應拋出 SUBKEY_INVALID', async () => {
      let caughtError: unknown = null;
      try {
        await validator.validate('invalid_token', SERVICE_ID);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      const error = caughtError as { errorCode: string };
      expect(error.errorCode).toBe(ErrorCode.SUBKEY_INVALID);
    });

    it('缺少 sk_live_ 前綴應拋出 SUBKEY_INVALID', async () => {
      let caughtError: unknown = null;
      try {
        await validator.validate('sk_test_abcd1234_xxx', SERVICE_ID);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      const error = caughtError as { errorCode: string };
      expect(error.errorCode).toBe(ErrorCode.SUBKEY_INVALID);
    });

    it('device_id_hash 非 8 hex 字元應拋出 SUBKEY_INVALID', async () => {
      let caughtError: unknown = null;
      try {
        await validator.validate('sk_live_TOOLONG9_random', SERVICE_ID);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      const error = caughtError as { errorCode: string };
      expect(error.errorCode).toBe(ErrorCode.SUBKEY_INVALID);
    });

    it('找不到對應裝置應拋出 SUBKEY_INVALID', async () => {
      // 清除所有裝置
      (db as unknown as { _clearDevices: () => void })._clearDevices();

      let caughtError: unknown = null;
      try {
        await validator.validate(VALID_SUB_KEY, SERVICE_ID);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      const error = caughtError as { errorCode: string };
      expect(error.errorCode).toBe(ErrorCode.SUBKEY_INVALID);
    });
  });

  // ===== WS 問詢流程 =====
  describe('WS 問詢', () => {
    it('應發送 subkey_validate 類型的 WS 請求給發行者，並回傳 permissions', async () => {
      // 攔截 sendToDevice，驗證訊息格式並記錄
      let sentMessageType = '';
      let sentPayload: unknown = null;

      const originalSend = (wsManager as unknown as { sendToDevice: (deviceId: string, message: unknown) => boolean }).sendToDevice.bind(wsManager);
      (wsManager as unknown as { sendToDevice: (deviceId: string, message: unknown) => boolean }).sendToDevice = (deviceId: string, message: unknown) => {
        const msg = message as { type: string; id: string; payload: unknown };
        sentMessageType = msg.type;
        sentPayload = msg.payload;
        const r = originalSend(deviceId, message);
        // 在下一個 microtask 回應
        queueMicrotask(() => {
          validator.handleSubKeyResult(msg.id, {
            request_id: msg.id,
            valid: true,
            permissions: ['read', 'write'],
          });
        });
        return r;
      };

      const result = await validator.validate(VALID_SUB_KEY, SERVICE_ID);

      // 驗證傳送的訊息格式
      expect(sentMessageType).toBe('subkey_validate');
      expect(sentPayload).toBeDefined();

      // 驗證結果
      expect(result.valid).toBe(true);
      expect(result.permissions).toEqual(['read', 'write']);
    });

    it('發行者回傳 valid: false 應正確傳遞', async () => {
      const result = await doValidateWithReply(validator, wsManager, VALID_SUB_KEY, SERVICE_ID, {
        valid: false,
      });
      expect(result.valid).toBe(false);
    });

    it('發行者帶 error 欄位時應回傳 valid: false', async () => {
      const result = await doValidateWithReply(validator, wsManager, VALID_SUB_KEY, SERVICE_ID, {
        valid: false,
        error: '此 Sub-Key 已被撤銷',
      });
      expect(result.valid).toBe(false);
    });

    it('handleSubKeyResult 傳入未知 requestId 應靜默忽略', () => {
      // 不應拋出錯誤
      expect(() => {
        validator.handleSubKeyResult('nonexistent_request_id', {
          request_id: 'nonexistent_request_id',
          valid: true,
        });
      }).not.toThrow();
    });
  });

  // ===== 超時處理 =====
  describe('超時', () => {
    it('10 秒後未收到回應應拋出 SUBKEY_ISSUER_OFFLINE', async () => {
      // 縮短超時時間（透過類型強制覆蓋）
      (validator as unknown as { VALIDATE_TIMEOUT_MS: number }).VALIDATE_TIMEOUT_MS = 50;

      let caughtError: unknown = null;
      try {
        // 發送請求但不回應（模擬超時）
        await validator.validate(VALID_SUB_KEY, SERVICE_ID);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      const error = caughtError as { errorCode: string };
      expect(error.errorCode).toBe(ErrorCode.SUBKEY_ISSUER_OFFLINE);
    }, 1000); // 給 1 秒讓超時計時器觸發
  });

  // ===== 快取清除 =====
  describe('快取清除', () => {
    it('clearCache 後快取應為空', () => {
      validator.clearCache();
      expect(validator.getCacheSize()).toBe(0);
    });

    it('invalidateCache 應移除指定 serviceId 的快取', async () => {
      // 建立一個快取條目
      await doValidateWithReply(validator, wsManager, VALID_SUB_KEY, SERVICE_ID, { valid: true });
      expect(validator.getCacheSize()).toBe(1);

      // 清除此 serviceId 的快取
      validator.invalidateCache(VALID_SUB_KEY, SERVICE_ID);
      expect(validator.getCacheSize()).toBe(0);
    });
  });
});
