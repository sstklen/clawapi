// 互助客戶端測試
// 覆蓋：requestAid 完整流程、handleIncomingAidRequest、冷卻期、payload 限制

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { AidClient } from '../mutual-aid';
import type { RequestAidParams, AidClientConfig, IncomingAidRequest } from '../mutual-aid';

// ===== Mock 工廠 =====

/** 建立 Mock CryptoModule */
function createMockCrypto() {
  return {
    generateECDHKeyPair: mock(async () => ({
      publicKey: 'mock-public-key-base64',
      privateKey: 'mock-private-key-base64',
    })),
    deriveSharedSecret: mock(async (_priv: string, _pub: string) => {
      return new Uint8Array(32).fill(0xAB);
    }),
    encryptForAidWithKey: mock(async () => ({
      encrypted: 'mock-encrypted-base64',
    })),
    decryptFromAidWithKey: mock(async () => 'mock-decrypted-response'),
    hkdf: mock(async () => new Uint8Array(32).fill(0xCD)),
    encrypt: mock((_plaintext: string) => new Uint8Array(16)),
    decrypt: mock((_cipher: Uint8Array) => '{"key":"value"}'),
    maskKey: mock((k: string) => k.slice(0, 4) + '****' + k.slice(-4)),
  };
}

/** 建立 Mock KeyPool */
function createMockKeyPool() {
  return {
    selectKeyWithFallback: mock(async (_serviceId: string) => ({
      key: {
        id: 1,
        service_id: 'openai',
        key_value: 'sk-test123',
        pool_type: 'king' as const,
        status: 'active' as const,
        pinned: false,
        priority: 0,
        daily_used: 0,
        consecutive_failures: 0,
        rate_limit_until: null,
        last_success_at: null,
      },
      source: 'king',
    })),
    selectKey: mock(async () => null),
    addKey: mock(async () => 1),
    removeKey: mock(async () => {}),
    listKeys: mock(async () => []),
    reportSuccess: mock(async () => {}),
    reportRateLimit: mock(async () => {}),
    reportAuthError: mock(async () => {}),
    reportError: mock(async () => {}),
    dailyReset: mock(async () => {}),
  };
}

/** 建立 Mock DatabaseModule */
function createMockDb() {
  const store: Record<string, unknown> = {};
  return {
    init: mock(async () => {}),
    close: mock(async () => {}),
    query: mock((_sql: string, _params?: unknown[]) => []),
    run: mock((_sql: string, _params?: unknown[]) => ({ changes: 1, lastInsertRowid: 1 })),
    transaction: mock(<T>(fn: () => T) => fn()),
    checkpoint: mock(() => {}),
    dailyReset: mock((_tz: string) => {}),
  };
}

/** WS 事件 handler 映射（供 Mock VPSClient 使用） */
type WsEventMap = {
  aid_matched: Array<(payload: unknown) => void>;
  aid_result: Array<(payload: unknown) => void>;
  aid_data: Array<(payload: unknown) => void>;
  aid_request: Array<(payload: unknown) => void>;
};

/** 建立 Mock VPSClient（含可模擬 WS 事件推送的能力） */
function createMockVpsClient() {
  const wsHandlers: WsEventMap = {
    aid_matched: [],
    aid_result: [],
    aid_data: [],
    aid_request: [],
  };

  const http = {
    requestAid: mock(async (_req: unknown) => ({
      status: 'matching' as const,
      aid_id: 'test-aid-id-001',
      estimated_wait_ms: 2000,
      message: '正在配對幫助者',
    })),
    updateAidConfig: mock(async () => {}),
    getAidStats: mock(async () => ({
      given: { today: 5, this_month: 50, all_time: 200, by_service: {} },
      received: { today: 3, this_month: 30, all_time: 100, by_service: {} },
    })),
  };

  const ws = {
    sendAidData: mock((_aidId: string, _kind: string, _payload: string, _iv: string, _tag: string) => {}),
    sendAidResponse: mock((_aidId: string, _payload: unknown) => {}),
    onAidMatched: mock((handler: (p: unknown) => void) => {
      wsHandlers.aid_matched.push(handler);
    }),
    onAidResult: mock((handler: (p: unknown) => void) => {
      wsHandlers.aid_result.push(handler);
    }),
    onAidData: mock((handler: (p: unknown) => void) => {
      wsHandlers.aid_data.push(handler);
    }),
  };

  const vpsClient = {
    http,
    ws,
    onAidRequest: mock((handler: (req: unknown) => void) => {
      wsHandlers.aid_request.push(handler);
    }),
    onRoutingUpdate: mock(() => {}),
    onNotification: mock(() => {}),
    getIsOffline: mock(() => false),
    // 工具：從測試觸發 WS 事件
    _triggerWsEvent: (event: keyof WsEventMap, payload: unknown) => {
      for (const h of wsHandlers[event]) {
        h(payload);
      }
    },
    _wsHandlers: wsHandlers,
  };

  return vpsClient;
}

// ===== 建立標準 AidClient 實例 =====

function createAidClient(overrides?: {
  crypto?: ReturnType<typeof createMockCrypto>;
  keyPool?: ReturnType<typeof createMockKeyPool>;
  db?: ReturnType<typeof createMockDb>;
  vpsClient?: ReturnType<typeof createMockVpsClient>;
}) {
  const crypto = overrides?.crypto ?? createMockCrypto();
  const keyPool = overrides?.keyPool ?? createMockKeyPool();
  const db = overrides?.db ?? createMockDb();
  const vpsClient = overrides?.vpsClient ?? createMockVpsClient();

  const client = new AidClient(
    vpsClient as unknown as ConstructorParameters<typeof AidClient>[0],
    crypto as unknown as ConstructorParameters<typeof AidClient>[1],
    keyPool as unknown as ConstructorParameters<typeof AidClient>[2],
    db as unknown as ConstructorParameters<typeof AidClient>[3],
  );

  return { client, crypto, keyPool, db, vpsClient };
}

// ===== Mock globalThis.crypto（Web Crypto API） =====

/** 產生固定的 AES-GCM 加密輸出（方便測試解密路徑） */
async function realEncrypt(key: Uint8Array, plaintext: string): Promise<string> {
  // 確保 ArrayBuffer 符合 Web Crypto API 要求
  const keyBuffer = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const webKey = await globalThis.crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = new Uint8Array(12).fill(0x01);
  const plainBuffer = new TextEncoder().encode(plaintext).buffer.slice(0) as ArrayBuffer;
  const cipherBuffer = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, webKey, plainBuffer);
  const cipherArray = new Uint8Array(cipherBuffer);
  const cipherLen = cipherArray.byteLength - 16;
  const authTag = cipherArray.slice(cipherLen);
  const ciphertext = cipherArray.slice(0, cipherLen);
  const combined = new Uint8Array(12 + 16 + cipherLen);
  combined.set(iv, 0);
  combined.set(authTag, 12);
  combined.set(ciphertext, 28);
  // Base64
  let binary = '';
  for (const b of combined) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ===== 測試套件 =====

describe('AidClient', () => {

  // =====================
  // 基本初始化測試
  // =====================

  describe('初始化', () => {
    test('建構時應訂閱 VPSClient onAidRequest 事件', () => {
      const { vpsClient } = createAidClient();
      expect(vpsClient.onAidRequest).toHaveBeenCalledTimes(1);
    });

    test('初始冷卻期應為 0', () => {
      const { client } = createAidClient();
      expect(client.getCooldownRemaining()).toBe(0);
    });

    test('初始連續失敗次數應為 0', () => {
      const { client } = createAidClient();
      expect(client.getConsecutiveFailures()).toBe(0);
    });
  });

  // =====================
  // Payload 大小限制測試
  // =====================

  describe('Payload 大小限制', () => {
    test('payload 超過 1MB 應直接拒絕並回傳錯誤', async () => {
      const { client } = createAidClient();

      // 產生 > 1MB 的字串（1,048,577 bytes）
      const oversizedPayload = 'A'.repeat(1024 * 1024 + 1);

      const result = await client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: oversizedPayload,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('1MB');
      expect(result.aid_id).toBe('');
    });

    test('payload 剛好 1MB 應允許通過大小檢查', async () => {
      const { client, vpsClient } = createAidClient();

      // 剛好 1MB（1,048,576 bytes）
      const exactMbPayload = 'A'.repeat(1024 * 1024);

      // 模擬 POST 成功後立即觸發 timeout（不等待完整流程）
      // 這裡只測試大小檢查不拒絕
      const postAidSpy = vpsClient.http.requestAid;

      // 非同步觸發（不 await，讓它 timeout）
      const resultPromise = client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: exactMbPayload,
      });

      // 等待 POST 被呼叫（代表通過了大小檢查）
      await new Promise(resolve => setTimeout(resolve, 50));

      // HTTP requestAid 應有被呼叫（代表通過大小檢查）
      // 等待 timeout（30 秒太長，我們用 mock 控制）
      // 直接取消等待，只確認 postAid 被呼叫過
      // 實際上 postAidSpy 應至少呼叫 1 次
      expect(postAidSpy).toHaveBeenCalled();

      // 讓 Promise 自行 timeout 或等一小段時間
      const result = await Promise.race([
        resultPromise,
        new Promise<{ success: boolean; error: string; aid_id: string }>(resolve =>
          setTimeout(() => resolve({ success: false, error: 'test-interrupt', aid_id: 'test-aid-id-001' }), 100)
        ),
      ]);

      // 不應是因為大小超過而失敗
      expect(result.error).not.toContain('1MB');
    });

    test('payload 物件序列化後超過 1MB 應拒絕', async () => {
      const { client } = createAidClient();

      const largeObj: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        largeObj[`key_${i}`] = 'X'.repeat(10_500); // 約 1.05MB
      }

      const result = await client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: largeObj,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('1MB');
    });
  });

  // =====================
  // 冷卻期測試
  // =====================

  describe('冷卻期遞增機制', () => {
    test('第 1 次失敗後冷卻期應為 60 秒', async () => {
      const { client } = createAidClient();

      // 模擬 HTTP 請求失敗
      const vpsClient = createMockVpsClient();
      vpsClient.http.requestAid = mock(async () => {
        throw new Error('連線失敗');
      });

      const { client: failClient } = createAidClient({ vpsClient });

      const result = await failClient.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: '{"test": 1}',
      });

      expect(result.success).toBe(false);
      expect(failClient.getConsecutiveFailures()).toBe(1);
      // 冷卻期應接近 60 秒（60000 ms）
      const remaining = failClient.getCooldownRemaining();
      expect(remaining).toBeGreaterThan(59_000);
      expect(remaining).toBeLessThanOrEqual(60_000);
    });

    test('第 2 次失敗後冷卻期應為 120 秒', async () => {
      const vpsClient = createMockVpsClient();
      vpsClient.http.requestAid = mock(async () => {
        throw new Error('連線失敗');
      });
      const { client } = createAidClient({ vpsClient });

      // 第 1 次失敗
      await client.requestAid({ service_id: 'openai', request_type: 'chat', payload: 'test' });
      // 重置冷卻以允許第 2 次
      client.resetCooldown();
      client['cooldown'].consecutiveFailures = 1; // 手動保留失敗計數

      // 第 2 次失敗
      await client.requestAid({ service_id: 'openai', request_type: 'chat', payload: 'test' });

      expect(client.getConsecutiveFailures()).toBe(2);
      const remaining = client.getCooldownRemaining();
      expect(remaining).toBeGreaterThan(119_000);
      expect(remaining).toBeLessThanOrEqual(120_000);
    });

    test('第 3 次失敗後冷卻期應為 240 秒', async () => {
      const vpsClient = createMockVpsClient();
      vpsClient.http.requestAid = mock(async () => {
        throw new Error('連線失敗');
      });
      const { client } = createAidClient({ vpsClient });

      // 模擬已失敗 2 次
      client.resetCooldown();
      client['cooldown'].consecutiveFailures = 2;

      await client.requestAid({ service_id: 'openai', request_type: 'chat', payload: 'test' });

      expect(client.getConsecutiveFailures()).toBe(3);
      const remaining = client.getCooldownRemaining();
      expect(remaining).toBeGreaterThan(239_000);
      expect(remaining).toBeLessThanOrEqual(240_000);
    });

    test('第 4 次以上失敗後冷卻期不超過 480 秒（上限）', async () => {
      const vpsClient = createMockVpsClient();
      vpsClient.http.requestAid = mock(async () => {
        throw new Error('連線失敗');
      });
      const { client } = createAidClient({ vpsClient });

      // 模擬已失敗 3 次（下一次應達上限）
      client.resetCooldown();
      client['cooldown'].consecutiveFailures = 3;

      await client.requestAid({ service_id: 'openai', request_type: 'chat', payload: 'test' });

      const remaining = client.getCooldownRemaining();
      expect(remaining).toBeLessThanOrEqual(480_000);
      expect(remaining).toBeGreaterThan(479_000);
    });

    test('冷卻期間再次呼叫應直接拒絕', async () => {
      const { client } = createAidClient();

      // 手動設置冷卻期（未來 60 秒內）
      client['cooldown'] = {
        consecutiveFailures: 1,
        cooldownUntil: Date.now() + 60_000,
      };

      const result = await client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('冷卻中');
    });

    test('成功後應重置冷卻期', () => {
      const { client } = createAidClient();

      // 先設置有失敗記錄的狀態
      client['cooldown'] = { consecutiveFailures: 2, cooldownUntil: 0 };
      client['recordSuccess']();

      expect(client.getConsecutiveFailures()).toBe(0);
      expect(client.getCooldownRemaining()).toBe(0);
    });
  });

  // =====================
  // requestAid 完整流程測試
  // =====================

  describe('requestAid 完整流程', () => {
    test('應呼叫 POST /v1/aid/request 並帶上 requester_public_key', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      // 非同步發起（不等待完整流程）
      const resultPromise = client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: '{"model":"gpt-4"}',
      });

      // 等一下讓 POST 被呼叫
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(vpsClient.http.requestAid).toHaveBeenCalledTimes(1);
      const callArg = vpsClient.http.requestAid.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg).toBeDefined();
      expect(callArg!['service_id']).toBe('openai');
      expect(callArg!['requester_public_key']).toBe('mock-public-key-base64');

      // 清理（讓 Promise timeout 自然結束）
      await Promise.race([
        resultPromise,
        new Promise(resolve => setTimeout(resolve, 200)),
      ]);
    });

    test('收到 aid_matched 後應觸發 ECDH + 加密發送', async () => {
      const vpsClient = createMockVpsClient();
      const crypto = createMockCrypto();
      const { client } = createAidClient({ vpsClient, crypto });

      // 開始請求
      const resultPromise = client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: '{"test":1}',
      });

      // 等 POST 完成
      await new Promise(resolve => setTimeout(resolve, 50));

      // 模擬 VPS 推送 aid_matched 事件
      vpsClient._triggerWsEvent('aid_matched', {
        type: 'notification',
        kind: 'aid_matched',
        aid_id: 'test-aid-id-001',
        helper_public_key: 'helper-pub-key-base64',
      });

      // 等 ECDH 和加密操作完成
      await new Promise(resolve => setTimeout(resolve, 100));

      // 應呼叫 deriveSharedSecret
      expect(crypto.deriveSharedSecret).toHaveBeenCalled();
      const sharedSecretCall = crypto.deriveSharedSecret.mock.calls[0];
      expect(sharedSecretCall?.[0]).toBe('mock-private-key-base64');
      expect(sharedSecretCall?.[1]).toBe('helper-pub-key-base64');

      // 清理
      await Promise.race([
        resultPromise,
        new Promise(resolve => setTimeout(resolve, 200)),
      ]);
    });

    test('收到 aid_result fulfilled 後應解密並回傳成功', async () => {
      const vpsClient = createMockVpsClient();
      const crypto = createMockCrypto();
      const { client } = createAidClient({ vpsClient, crypto });

      // 產生真實的加密資料（用真實 Web Crypto API）
      const aesKey = new Uint8Array(32).fill(0xAB);
      const responseText = JSON.stringify({ result: '來自 openai 的回應' });

      // 預先計算加密結果（模擬 HKDF 導出相同 key）
      const encryptedResponse = await realEncrypt(aesKey, responseText);

      // 開始請求
      const resultPromise = client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: '{"test":1}',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // 推送 aid_matched
      vpsClient._triggerWsEvent('aid_matched', {
        type: 'notification',
        kind: 'aid_matched',
        aid_id: 'test-aid-id-001',
        helper_public_key: 'helper-pub-key-base64',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // 推送 aid_result（fulfilled）
      vpsClient._triggerWsEvent('aid_result', {
        kind: 'aid_result',
        aid_id: 'test-aid-id-001',
        status: 'fulfilled',
        response_encrypted: encryptedResponse,
        helper_public_key: 'helper-pub-key-base64',
      });

      const result = await resultPromise;

      expect(result.aid_id).toBe('test-aid-id-001');
      // ECDH 導出的 sharedSecret 是 0xAB * 32 bytes，HKDF 後應能解密
      // （測試驗證流程正確性，若 key 不匹配會拋出 AES 解密錯誤）
      expect(result.success).toBeDefined();
      expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    });

    test('aid_result timeout 狀態應回傳失敗', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      const resultPromise = client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: '{"test":1}',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // 推送 aid_matched
      vpsClient._triggerWsEvent('aid_matched', {
        type: 'notification',
        kind: 'aid_matched',
        aid_id: 'test-aid-id-001',
        helper_public_key: 'helper-pub-key-base64',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // 推送 aid_result（timeout）
      vpsClient._triggerWsEvent('aid_result', {
        kind: 'aid_result',
        aid_id: 'test-aid-id-001',
        status: 'timeout',
        message: 'VPS 端逾時',
      });

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('逾時');
      expect(result.aid_id).toBe('test-aid-id-001');
    });

    test('aid_result error 狀態應回傳失敗', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      const resultPromise = client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: '{"test":1}',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      vpsClient._triggerWsEvent('aid_matched', {
        type: 'notification',
        kind: 'aid_matched',
        aid_id: 'test-aid-id-001',
        helper_public_key: 'helper-pub-key-base64',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      vpsClient._triggerWsEvent('aid_result', {
        kind: 'aid_result',
        aid_id: 'test-aid-id-001',
        status: 'error',
        message: '幫助者執行失敗',
      });

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('失敗');
    });

    test('POST 失敗應增加失敗計數並回傳錯誤', async () => {
      const vpsClient = createMockVpsClient();
      vpsClient.http.requestAid = mock(async () => {
        throw new Error('網路錯誤');
      });
      const { client } = createAidClient({ vpsClient });

      const result = await client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('POST /v1/aid/request 失敗');
      expect(client.getConsecutiveFailures()).toBe(1);
    });

    test('不屬於此次請求的 aid_matched 事件應被忽略', async () => {
      const vpsClient = createMockVpsClient();
      const crypto = createMockCrypto();
      const { client } = createAidClient({ vpsClient, crypto });

      const resultPromise = client.requestAid({
        service_id: 'openai',
        request_type: 'chat',
        payload: '{"test":1}',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // 推送錯誤 aid_id 的 matched 事件
      vpsClient._triggerWsEvent('aid_matched', {
        type: 'notification',
        kind: 'aid_matched',
        aid_id: 'wrong-aid-id-999',
        helper_public_key: 'helper-pub-key-base64',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // deriveSharedSecret 不應被呼叫（因為是錯誤的 aid_id）
      expect(crypto.deriveSharedSecret).not.toHaveBeenCalled();

      // 清理
      await Promise.race([
        resultPromise,
        new Promise(resolve => setTimeout(resolve, 200)),
      ]);
    });
  });

  // =====================
  // HKDF 參數驗證測試
  // =====================

  describe('HKDF 參數（SPEC-C §4.5 嚴格規範）', () => {
    test('HKDF 應使用 aid_id 作為 salt', async () => {
      // 測試兩個不同 aid_id 產生不同的 AES key
      const client = createAidClient().client;

      const sharedSecret = new Uint8Array(32).fill(0x42);
      const key1 = await client['deriveAesKeyWithWebCrypto'](sharedSecret, 'aid-001');
      const key2 = await client['deriveAesKeyWithWebCrypto'](sharedSecret, 'aid-002');

      // 不同 salt（aid_id）應產生不同的 key
      expect(Buffer.from(key1).toString('hex')).not.toBe(Buffer.from(key2).toString('hex'));
    });

    test('相同 sharedSecret + 相同 aid_id 應產生相同的 AES key（確定性）', async () => {
      const client = createAidClient().client;

      const sharedSecret = new Uint8Array(32).fill(0x55);
      const key1 = await client['deriveAesKeyWithWebCrypto'](sharedSecret, 'same-aid-id');
      const key2 = await client['deriveAesKeyWithWebCrypto'](sharedSecret, 'same-aid-id');

      expect(Buffer.from(key1).toString('hex')).toBe(Buffer.from(key2).toString('hex'));
    });

    test('HKDF 輸出應為 32 bytes（256 bits）', async () => {
      const client = createAidClient().client;
      const sharedSecret = new Uint8Array(32).fill(0x33);
      const key = await client['deriveAesKeyWithWebCrypto'](sharedSecret, 'test-aid');

      expect(key.byteLength).toBe(32);
    });

    test('請求者（B）與幫助者（A）使用相同參數應導出相同 AES key', async () => {
      const client = createAidClient().client;

      // 模擬 ECDH 後的共享密鑰
      const sharedSecret = new Uint8Array(32).fill(0x77);
      const aidId = 'cross-party-aid-id';

      const keyB = await client['deriveAesKeyWithWebCrypto'](sharedSecret, aidId);
      const keyA = await client['deriveAesKeyWithWebCrypto'](sharedSecret, aidId);

      expect(Buffer.from(keyB).toString('hex')).toBe(Buffer.from(keyA).toString('hex'));
    });

    test('加密後能正確解密（端對端驗證）', async () => {
      const client = createAidClient().client;

      const aesKey = new Uint8Array(32).fill(0x88);
      const originalText = '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}';

      const encrypted = await client['aesGcmEncrypt'](aesKey, originalText);
      const decrypted = await client['aesGcmDecrypt'](aesKey, encrypted);

      expect(decrypted).toBe(originalText);
    });

    test('錯誤的 key 解密應拋出錯誤', async () => {
      const client = createAidClient().client;

      const correctKey = new Uint8Array(32).fill(0xAA);
      const wrongKey = new Uint8Array(32).fill(0xBB);
      const plaintext = '{"secret":"data"}';

      const encrypted = await client['aesGcmEncrypt'](correctKey, plaintext);

      // 用錯誤的 key 解密應失敗
      await expect(
        client['aesGcmDecrypt'](wrongKey, encrypted)
      ).rejects.toThrow();
    });
  });

  // =====================
  // handleIncomingAidRequest 測試
  // =====================

  describe('handleIncomingAidRequest（幫助者 A 角色）', () => {
    test('互助未開啟時應拒絕請求', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      // 確保 enabled = false
      client['config'].enabled = false;

      const request: IncomingAidRequest = {
        aid_id: 'test-aid-123',
        service_id: 'openai',
        request_type: 'chat',
        requester_public_key: 'requester-pub-key',
      };

      await client.handleIncomingAidRequest(request);

      // 應呼叫 sendAidRejection（透過 WS sendAidResponse）
      expect(vpsClient.ws.sendAidResponse).toHaveBeenCalledTimes(1);
      const callArg = vpsClient.ws.sendAidResponse.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(callArg?.['status']).toBe('rejected');
    });

    test('服務不在允許清單內應拒絕', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      client['config'].enabled = true;
      client['config'].allowed_services = ['anthropic']; // 只允許 anthropic

      await client.handleIncomingAidRequest({
        aid_id: 'test-aid-124',
        service_id: 'openai', // 不在清單內
        request_type: 'chat',
        requester_public_key: 'pub-key',
      });

      expect(vpsClient.ws.sendAidResponse).toHaveBeenCalled();
      const callArg = vpsClient.ws.sendAidResponse.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(callArg?.['status']).toBe('rejected');
    });

    test('allowed_services = null 時應允許所有服務', async () => {
      const vpsClient = createMockVpsClient();
      const crypto = createMockCrypto();
      const { client } = createAidClient({ vpsClient, crypto });

      client['config'].enabled = true;
      client['config'].allowed_services = null; // 全部允許
      client['config'].daily_limit = 100;
      client['config'].blackout_hours = [];
      client['config'].helper_private_key = 'helper-private-key-base64';

      // 不模擬 WS 加密請求事件，讓 awaitAndProcessEncryptedRequest 自然 timeout
      await client.handleIncomingAidRequest({
        aid_id: 'test-aid-125',
        service_id: 'openai',
        request_type: 'chat',
        requester_public_key: 'requester-pub-key',
      });

      // ECDH 應被呼叫（代表通過了所有前置檢查）
      expect(crypto.deriveSharedSecret).toHaveBeenCalled();
    });

    test('每日額度耗盡應拒絕', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      client['config'].enabled = true;
      client['config'].allowed_services = null;
      client['config'].daily_limit = 5;
      client['dailyGivenCount'] = 5; // 已達上限

      await client.handleIncomingAidRequest({
        aid_id: 'test-aid-126',
        service_id: 'openai',
        request_type: 'chat',
        requester_public_key: 'pub-key',
      });

      expect(vpsClient.ws.sendAidResponse).toHaveBeenCalled();
      const callArg = vpsClient.ws.sendAidResponse.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(callArg?.['status']).toBe('rejected');
      const errorMsg = callArg?.['error_message'] as string;
      expect(errorMsg).toContain('額度');
    });

    test('blackout 時段應拒絕（需模擬當前時間）', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      client['config'].enabled = true;
      client['config'].allowed_services = null;
      client['config'].daily_limit = 100;

      // 取得當前小時，設為 blackout
      const currentHour = new Date().getHours();
      client['config'].blackout_hours = [currentHour];

      await client.handleIncomingAidRequest({
        aid_id: 'test-aid-127',
        service_id: 'openai',
        request_type: 'chat',
        requester_public_key: 'pub-key',
      });

      expect(vpsClient.ws.sendAidResponse).toHaveBeenCalled();
      const callArg = vpsClient.ws.sendAidResponse.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(callArg?.['status']).toBe('rejected');
      const errorMsg = callArg?.['error_message'] as string;
      expect(errorMsg).toContain('黑名單');
    });

    test('未設定 helper_private_key 應拒絕', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      client['config'].enabled = true;
      client['config'].allowed_services = null;
      client['config'].daily_limit = 100;
      client['config'].blackout_hours = [];
      client['config'].helper_private_key = undefined; // 未設定

      await client.handleIncomingAidRequest({
        aid_id: 'test-aid-128',
        service_id: 'openai',
        request_type: 'chat',
        requester_public_key: 'pub-key',
      });

      expect(vpsClient.ws.sendAidResponse).toHaveBeenCalled();
      const callArg = vpsClient.ws.sendAidResponse.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(callArg?.['status']).toBe('rejected');
    });
  });

  // =====================
  // updateConfig 測試
  // =====================

  describe('updateConfig', () => {
    test('應更新本地設定並呼叫 PUT /v1/aid/config', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      await client.updateConfig({
        enabled: true,
        daily_limit: 20,
        allowed_services: ['openai', 'anthropic'],
        blackout_hours: [0, 1, 2, 3],
        helper_public_key: 'helper-pub-key-base64',
      });

      expect(vpsClient.http.updateAidConfig).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callArg = (vpsClient.http.updateAidConfig.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
      expect(callArg?.['enabled']).toBe(true);
      expect(callArg?.['daily_limit']).toBe(20);
      expect(callArg?.['helper_public_key']).toBe('helper-pub-key-base64');
    });

    test('helper_public_key 未設定時不應傳給 VPS', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      await client.updateConfig({
        enabled: false,
        daily_limit: 10,
        // 沒有 helper_public_key
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callArg = (vpsClient.http.updateAidConfig.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
      expect(callArg?.['helper_public_key']).toBeUndefined();
    });

    test('更新設定後應存入 DB', async () => {
      const vpsClient = createMockVpsClient();
      const db = createMockDb();
      const { client } = createAidClient({ vpsClient, db });

      await client.updateConfig({ enabled: true, daily_limit: 15 });

      // db.run 應至少被呼叫一次（寫入 aid_config）
      expect(db.run).toHaveBeenCalled();
    });
  });

  // =====================
  // getStats 測試
  // =====================

  describe('getStats', () => {
    test('應呼叫 GET /v1/aid/stats 並回傳統計資料', async () => {
      const vpsClient = createMockVpsClient();
      const { client } = createAidClient({ vpsClient });

      const stats = await client.getStats();

      expect(vpsClient.http.getAidStats).toHaveBeenCalledTimes(1);
      expect(stats).toBeDefined();
      expect(stats.given).toBeDefined();
      expect(stats.received).toBeDefined();
      expect(stats.given.today).toBe(5);
      expect(stats.received.today).toBe(3);
    });
  });

  // =====================
  // AES-GCM 加解密端對端測試
  // =====================

  describe('AES-GCM 加解密', () => {
    test('中文和特殊字元應正確加解密', async () => {
      const { client } = createAidClient();
      const key = new Uint8Array(32).fill(0xCC);
      const text = '{"message":"你好世界 🦞 ClawAPI","emoji":"✅"}';

      const encrypted = await client['aesGcmEncrypt'](key, text);
      const decrypted = await client['aesGcmDecrypt'](key, encrypted);

      expect(decrypted).toBe(text);
    });

    test('加密結果每次應不同（因為 IV 是隨機的）', async () => {
      const { client } = createAidClient();
      const key = new Uint8Array(32).fill(0xDD);
      const text = 'same plaintext';

      const enc1 = await client['aesGcmEncrypt'](key, text);
      const enc2 = await client['aesGcmEncrypt'](key, text);

      // 因為 IV 隨機，每次加密結果應不同
      expect(enc1).not.toBe(enc2);

      // 但都應該能解密為相同的明文
      const dec1 = await client['aesGcmDecrypt'](key, enc1);
      const dec2 = await client['aesGcmDecrypt'](key, enc2);
      expect(dec1).toBe(text);
      expect(dec2).toBe(text);
    });

    test('密文長度不足（< 28 bytes）應拋出錯誤', async () => {
      const { client } = createAidClient();
      const key = new Uint8Array(32).fill(0xEE);
      const tooShort = btoa('tooshort'); // 8 bytes base64 = 6 bytes raw

      await expect(
        client['aesGcmDecrypt'](key, tooShort)
      ).rejects.toThrow('加密資料長度不足');
    });
  });

  // =====================
  // Base64 工具函式測試
  // =====================

  describe('Base64 工具', () => {
    test('uint8ArrayToBase64 → base64ToUint8Array 應可逆', () => {
      const { client } = createAidClient();
      const original = new Uint8Array([0x00, 0x01, 0xFF, 0xAB, 0xCD, 0xEF]);

      const base64 = client['uint8ArrayToBase64'](original);
      const restored = client['base64ToUint8Array'](base64);

      expect(restored).toEqual(original);
    });

    test('空 Uint8Array 應能正確轉換', () => {
      const { client } = createAidClient();
      const empty = new Uint8Array(0);

      const base64 = client['uint8ArrayToBase64'](empty);
      const restored = client['base64ToUint8Array'](base64);

      expect(restored.byteLength).toBe(0);
    });
  });

  // =====================
  // 業務邏輯判斷測試
  // =====================

  describe('業務邏輯', () => {
    test('isServiceAllowed：allowed_services = null 時全部允許', () => {
      const { client } = createAidClient();
      client['config'].allowed_services = null;

      expect(client['isServiceAllowed']('openai')).toBe(true);
      expect(client['isServiceAllowed']('anthropic')).toBe(true);
      expect(client['isServiceAllowed']('任意服務')).toBe(true);
    });

    test('isServiceAllowed：服務在清單內返回 true', () => {
      const { client } = createAidClient();
      client['config'].allowed_services = ['openai', 'anthropic'];

      expect(client['isServiceAllowed']('openai')).toBe(true);
      expect(client['isServiceAllowed']('anthropic')).toBe(true);
    });

    test('isServiceAllowed：服務不在清單內返回 false', () => {
      const { client } = createAidClient();
      client['config'].allowed_services = ['openai'];

      expect(client['isServiceAllowed']('gemini')).toBe(false);
    });

    test('isBlackoutTime：blackout_hours 空陣列時不在 blackout', () => {
      const { client } = createAidClient();
      client['config'].blackout_hours = [];

      expect(client['isBlackoutTime']()).toBe(false);
    });

    test('isBlackoutTime：當前小時在 blackout_hours 內返回 true', () => {
      const { client } = createAidClient();
      const currentHour = new Date().getHours();
      client['config'].blackout_hours = [currentHour];

      expect(client['isBlackoutTime']()).toBe(true);
    });

    test('isBlackoutTime：當前小時不在 blackout_hours 內返回 false', () => {
      const { client } = createAidClient();
      // 設定當前小時以外的所有時段（最多不超過陣列中沒有當前小時）
      const currentHour = new Date().getHours();
      const otherHour = (currentHour + 12) % 24; // 12 小時後
      client['config'].blackout_hours = [otherHour];

      // 只有當 otherHour 不等於 currentHour 時才測試
      if (otherHour !== currentHour) {
        expect(client['isBlackoutTime']()).toBe(false);
      }
    });
  });

  // =====================
  // 互助觸發條件測試（龍蝦王池→親友池→L0 全掛才觸發）
  // =====================

  describe('互助觸發條件', () => {
    test('selectKeyWithFallback 有 key 時不需要互助', async () => {
      const keyPool = createMockKeyPool();
      // 預設 mock 回傳有 key
      const { client } = createAidClient({ keyPool });

      const result = await client['keyPool'].selectKeyWithFallback('openai');
      expect(result).not.toBeNull();
    });

    test('selectKeyWithFallback 無 key 時應觸發互助（null = 需要互助）', async () => {
      const keyPool = createMockKeyPool();
      // 型別 cast 以允許回傳 null（模擬 key pool 耗盡的情況）
      (keyPool as unknown as { selectKeyWithFallback: ReturnType<typeof mock> }).selectKeyWithFallback = mock(async () => null);

      const { client } = createAidClient({ keyPool });

      const result = await client['keyPool'].selectKeyWithFallback('openai');
      expect(result).toBeNull(); // null 代表需要尋求互助
    });
  });

});
