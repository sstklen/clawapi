// L0 Manager 測試
// 驗證：快取 TTL、VPS 拉取、限額追蹤、Key 選取優先順序

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { L0Manager } from '../manager';
import type { VPSClientLike } from '../manager';
import type { L0Key, L0KeysResponse } from '@clawapi/protocol';

// ===== Mock 工廠 =====

/** 建立 Mock L0Key */
function createL0Key(
  id: string,
  serviceId: string,
  status: L0Key['status'] = 'active'
): L0Key {
  return {
    id,
    service_id: serviceId,
    key_encrypted: `enc_${id}`,
    encryption_method: 'aes-256-gcm',
    encryption_key_id: 'key-001',
    status,
    daily_quota_per_device: 100,
    total_daily_quota: 10000,
    total_daily_used: 500,
    donated_by: null,
    updated_at: new Date().toISOString(),
  };
}

/** 建立 Mock VPS 回應 */
function createVPSResponse(keys: L0Key[], limits?: Record<string, { limit: number; used: number; reset_at: string }>): L0KeysResponse {
  return {
    schema_version: 1,
    keys,
    l0_encryption_key: 'mock_enc_key',
    device_daily_limits: limits ?? {},
    cache_ttl: 21600,
    server_time: new Date().toISOString(),
  };
}

/** 建立正常運作的 Mock VPS 客戶端 */
function createMockVPS(response: L0KeysResponse | null = null): VPSClientLike {
  return {
    getL0Keys: mock(async () => response),
    getIsOffline: mock(() => false),
  };
}

/** 建立離線狀態的 Mock VPS 客戶端 */
function createOfflineVPS(): VPSClientLike {
  return {
    getL0Keys: mock(async () => null),
    getIsOffline: mock(() => true),
  };
}

// ===== 快取 TTL 測試（驗收標準 #7）=====

describe('L0Manager 快取 TTL', () => {
  it('快取未過期（TTL 未到）→ isCacheExpired() 應回傳 false', () => {
    const vps = createMockVPS();
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);  // 6 小時

    // 手動設定快取（模擬剛拉取完）
    manager._setCache([], Date.now());

    expect(manager.isCacheExpired()).toBe(false);
  });

  it('快取已過期（TTL 超過）→ isCacheExpired() 應回傳 true', () => {
    const vps = createMockVPS();
    const manager = new L0Manager(vps, 1000);  // 1 秒 TTL（測試用短 TTL）

    // 設定 2 秒前的快取時間（已過期）
    const twoSecondsAgo = Date.now() - 2000;
    manager._setCache([], twoSecondsAgo);

    expect(manager.isCacheExpired()).toBe(true);
  });

  it('從未拉取（lastFetchedAt=0）→ isCacheExpired() 應回傳 true', () => {
    const vps = createMockVPS();
    const manager = new L0Manager(vps);

    // 預設 lastFetchedAt = 0
    expect(manager.isCacheExpired()).toBe(true);
  });

  it('refresh() 成功後應更新 lastFetchedAt', async () => {
    const keys = [createL0Key('k1', 'openai')];
    const response = createVPSResponse(keys);
    const vps = createMockVPS(response);
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    expect(manager.getLastFetchedAt()).toBe(0);  // 尚未拉取

    await manager.refresh();

    expect(manager.getLastFetchedAt()).toBeGreaterThan(0);
    expect(manager.isCacheExpired()).toBe(false);
  });

  it('快取 TTL 為 6 小時（L0_CACHE_TTL_MS = 21600000）', () => {
    // 使用預設 TTL
    const vps = createMockVPS();
    const manager = new L0Manager(vps);

    // 設定 5 小時前的快取
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    manager._setCache([], fiveHoursAgo);

    // 5 小時前 < 6 小時 TTL，應未過期
    expect(manager.isCacheExpired()).toBe(false);

    // 設定 7 小時前的快取
    const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
    manager._setCache([], sevenHoursAgo);

    // 7 小時前 > 6 小時 TTL，應已過期
    expect(manager.isCacheExpired()).toBe(true);
  });
});

// ===== VPS 拉取測試 =====

describe('L0Manager VPS 拉取', () => {
  it('refresh() 應呼叫 VPS.getL0Keys()，並將 Key 存入快取', async () => {
    const keys = [
      createL0Key('k1', 'groq'),
      createL0Key('k2', 'openai'),
    ];
    const response = createVPSResponse(keys);
    const vps = createMockVPS(response);
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    expect(manager.getCachedKeyCount()).toBe(2);
    expect(vps.getL0Keys).toHaveBeenCalledTimes(1);
  });

  it('VPS 回傳 null（離線）→ 不覆蓋舊快取', async () => {
    const oldKeys = [createL0Key('old-k1', 'groq')];
    const vps = createMockVPS(null);  // 回傳 null
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    // 預先設定舊快取
    manager._setCache(oldKeys, Date.now() - 1000);

    await manager.refresh();

    // 舊快取應保留
    expect(manager.getCachedKeyCount()).toBe(1);
  });

  it('VPS 離線時（getIsOffline()=true）→ refresh() 不呼叫 getL0Keys()', async () => {
    const vps = createOfflineVPS();
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    expect(vps.getL0Keys).not.toHaveBeenCalled();
  });

  it('refresh() 拋出例外 → 不崩潰，保留舊快取', async () => {
    const oldKeys = [createL0Key('preserved', 'groq')];
    const vps: VPSClientLike = {
      getL0Keys: mock(async () => { throw new Error('網路錯誤'); }),
      getIsOffline: mock(() => false),
    };
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);
    manager._setCache(oldKeys, Date.now() - 1000);

    // 不應 throw
    await expect(manager.refresh()).resolves.toBeUndefined();

    // 舊快取保留
    expect(manager.getCachedKeyCount()).toBe(1);
  });
});

// ===== 每日限額測試（驗收標準 #8）=====

describe('L0Manager 每日限額', () => {
  it('限額未到 → 可正常選取 Key（驗收標準 #8）', async () => {
    const keys = [createL0Key('pub-k1', 'openai')];
    const limits = {
      openai: { limit: 100, used: 50, reset_at: new Date(Date.now() + 86400000).toISOString() },
    };
    const vps = createMockVPS(createVPSResponse(keys, limits));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    const result = manager.selectKey('openai');
    expect(result.key).not.toBeNull();
    expect(result.source).toBe('l0_public');
  });

  it('限額已滿（used >= limit）→ 回傳 null，source=none，附帶友善提示（驗收標準 #8）', async () => {
    const keys = [createL0Key('pub-k1', 'openai')];
    const limits = {
      openai: { limit: 100, used: 100, reset_at: new Date(Date.now() + 3600000).toISOString() },
    };
    const vps = createMockVPS(createVPSResponse(keys, limits));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    const result = manager.selectKey('openai');

    expect(result.key).toBeNull();
    expect(result.source).toBe('none');
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain('openai');
  });

  it('recordUsage() 應增加本機計數', async () => {
    const keys = [createL0Key('pub-k1', 'openai')];
    const limits = {
      openai: { limit: 100, used: 50, reset_at: new Date(Date.now() + 86400000).toISOString() },
    };
    const vps = createMockVPS(createVPSResponse(keys, limits));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    const before = manager.getDailyLimit('openai');
    expect(before?.used).toBe(50);

    manager.recordUsage('openai');

    const after = manager.getDailyLimit('openai');
    expect(after?.used).toBe(51);
  });

  it('連續 recordUsage 到上限 → 選 Key 應回傳限額已滿', async () => {
    const keys = [createL0Key('pub-k1', 'svc')];
    const limits = {
      svc: { limit: 2, used: 1, reset_at: new Date(Date.now() + 86400000).toISOString() },
    };
    const vps = createMockVPS(createVPSResponse(keys, limits));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    // 用完最後一次
    manager.recordUsage('svc');

    // used = 2, limit = 2 → 超額
    const result = manager.selectKey('svc');
    expect(result.key).toBeNull();
    expect(result.reason).toContain('2/2');
  });
});

// ===== Key 選取優先順序測試 =====

describe('L0Manager Key 選取優先順序', () => {
  it('Ollama 存在時應優先選取（source=ollama）', async () => {
    const keys = [
      createL0Key('ollama-k', 'ollama'),
      createL0Key('openai-k', 'openai'),
    ];
    const vps = createMockVPS(createVPSResponse(keys));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    // 不指定 serviceId，應選 Ollama
    const result = manager.selectKey();
    expect(result.source).toBe('ollama');
  });

  it('無 Ollama、有 DuckDuckGo → 應選 DuckDuckGo（source=duckduckgo）', async () => {
    const keys = [
      createL0Key('ddg-k', 'duckduckgo'),
      createL0Key('openai-k', 'openai'),
    ];
    const vps = createMockVPS(createVPSResponse(keys));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    const result = manager.selectKey();
    expect(result.source).toBe('duckduckgo');
  });

  it('無本機服務 → 應從 L0 公共 Key 選（source=l0_public）', async () => {
    const keys = [createL0Key('pub-k1', 'openai')];
    const vps = createMockVPS(createVPSResponse(keys));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    const result = manager.selectKey();
    expect(result.source).toBe('l0_public');
    expect(result.key?.id).toBe('pub-k1');
  });

  it('指定 serviceId，只從該服務選取', async () => {
    const keys = [
      createL0Key('groq-k', 'groq'),
      createL0Key('openai-k', 'openai'),
    ];
    const vps = createMockVPS(createVPSResponse(keys));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    const result = manager.selectKey('groq');
    expect(result.key?.service_id).toBe('groq');
  });

  it('dead 狀態的 Key 不應被選中', async () => {
    const keys = [
      createL0Key('dead-k', 'openai', 'dead'),  // dead
      createL0Key('ok-k', 'groq', 'active'),     // active
    ];
    const vps = createMockVPS(createVPSResponse(keys));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    // 選 openai 時，dead key 不應被選中
    const result = manager.selectKey('openai');
    expect(result.key).toBeNull();
    expect(result.source).toBe('none');
  });

  it('active 優先於 degraded', async () => {
    const keys = [
      createL0Key('deg-k', 'groq', 'degraded'),
      createL0Key('ok-k', 'groq', 'active'),
    ];
    const vps = createMockVPS(createVPSResponse(keys));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    const result = manager.selectKey('groq');
    expect(result.key?.id).toBe('ok-k');  // active 的先選
  });
});

// ===== 無快取時的處理 =====

describe('L0Manager 無快取狀態', () => {
  it('快取為空且無本機服務 → selectKey 回傳 source=none', () => {
    const vps = createMockVPS();
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    const result = manager.selectKey();
    expect(result.key).toBeNull();
    expect(result.source).toBe('none');
    expect(result.reason).toBeTruthy();
  });

  it('selectKey 指定不存在的服務 → 回傳 source=none', async () => {
    const keys = [createL0Key('pub-k1', 'groq')];
    const vps = createMockVPS(createVPSResponse(keys));
    const manager = new L0Manager(vps, 6 * 60 * 60 * 1000);

    await manager.refresh();

    const result = manager.selectKey('nonexistent-service');
    expect(result.key).toBeNull();
    expect(result.source).toBe('none');
  });
});

// ===== 生命週期測試 =====

describe('L0Manager 生命週期', () => {
  it('start() 應立即呼叫一次 refresh()（getL0Keys 被呼叫）', async () => {
    const response = createVPSResponse([]);
    const vps = createMockVPS(response);
    const manager = new L0Manager(vps, 10 * 60 * 1000);  // 10 分鐘 TTL

    await manager.start();
    manager.stop();  // 立即停止，避免計時器繼續跑

    expect(vps.getL0Keys).toHaveBeenCalledTimes(1);
  });

  it('stop() 後計時器應停止（不再呼叫 getL0Keys）', async () => {
    const response = createVPSResponse([]);
    const vps = createMockVPS(response);
    // 使用極短 TTL，但 stop() 應馬上停止計時器
    const manager = new L0Manager(vps, 50);  // 50ms TTL

    await manager.start();
    manager.stop();

    const callCount = (vps.getL0Keys as ReturnType<typeof mock>).mock.calls.length;

    // 等 100ms 後，call count 不應增加（計時器已停）
    await new Promise(resolve => setTimeout(resolve, 100));

    expect((vps.getL0Keys as ReturnType<typeof mock>).mock.calls.length).toBe(callCount);
  });
});
