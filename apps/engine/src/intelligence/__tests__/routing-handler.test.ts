// 路由更新處理器測試
// 測試 VPS 下發的 routing_intel 寫入邏輯

import { describe, it, expect } from 'bun:test';
import { handleRoutingUpdate, loadCollectiveIntelFromDB, type RoutingUpdateItem } from '../routing-handler';
import type { ClawDatabase } from '../../storage/database';

// ===== Mock DB =====

interface InsertedRow {
  sql: string;
  params: unknown[];
}

function createMockDb() {
  const inserts: InsertedRow[] = [];
  return {
    db: {
      run: (sql: string, params?: unknown[]) => {
        inserts.push({ sql, params: params ?? [] });
      },
    } as unknown as ClawDatabase,
    inserts,
  };
}

function createFailingDb(): ClawDatabase {
  return {
    run: () => { throw new Error('DB 寫入失敗'); },
  } as unknown as ClawDatabase;
}

// ===== 測試 =====

describe('handleRoutingUpdate', () => {
  it('應正確寫入單一有效更新', () => {
    const { db, inserts } = createMockDb();

    const update: RoutingUpdateItem = {
      service_id: 'openai',
      region: 'us-west',
      status: 'preferred',
      confidence: 0.95,
      success_rate: 0.99,
      avg_latency_ms: 300,
      p95_latency_ms: 600,
      sample_size: 1000,
      note: '穩定',
    };

    const count = handleRoutingUpdate(db, update);
    expect(count).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain('INSERT OR REPLACE INTO routing_intel');
    expect(inserts[0]!.params[0]).toBe('openai');
    expect(inserts[0]!.params[1]).toBe('us-west');
    expect(inserts[0]!.params[2]).toBe('preferred');
    expect(inserts[0]!.params[3]).toBe(0.95);
    expect(inserts[0]!.params[8]).toBe('穩定');
  });

  it('應正確處理陣列更新', () => {
    const { db, inserts } = createMockDb();

    const updates: RoutingUpdateItem[] = [
      { service_id: 'openai', region: 'us-west', status: 'preferred' },
      { service_id: 'groq', region: 'us-east', status: 'preferred' },
      { service_id: 'gemini', region: 'asia', status: 'degraded' },
    ];

    const count = handleRoutingUpdate(db, updates);
    expect(count).toBe(3);
    expect(inserts).toHaveLength(3);
    expect(inserts[0]!.params[0]).toBe('openai');
    expect(inserts[1]!.params[0]).toBe('groq');
    expect(inserts[2]!.params[0]).toBe('gemini');
  });

  it('應跳過缺少必填欄位的項目', () => {
    const { db, inserts } = createMockDb();

    const updates = [
      { service_id: 'openai', region: 'us-west', status: 'preferred' }, // ✅
      { service_id: 'groq' }, // ❌ 缺 region 和 status
      { region: 'us-east', status: 'preferred' }, // ❌ 缺 service_id
      { service_id: 'gemini', region: 'asia' }, // ❌ 缺 status
      { service_id: 'anthropic', region: 'eu', status: 'preferred' }, // ✅
    ];

    const count = handleRoutingUpdate(db, updates);
    expect(count).toBe(2);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.params[0]).toBe('openai');
    expect(inserts[1]!.params[0]).toBe('anthropic');
  });

  it('應正確套用預設值', () => {
    const { db, inserts } = createMockDb();

    const update: RoutingUpdateItem = {
      service_id: 'openai',
      region: 'us-west',
      status: 'preferred',
      // 不提供 confidence, success_rate 等
    };

    handleRoutingUpdate(db, update);
    expect(inserts).toHaveLength(1);

    const params = inserts[0]!.params;
    expect(params[3]).toBe(0.5); // confidence 預設 0.5
    expect(params[4]).toBeNull(); // success_rate 預設 null
    expect(params[5]).toBeNull(); // avg_latency_ms 預設 null
    expect(params[6]).toBeNull(); // p95_latency_ms 預設 null
    expect(params[7]).toBeNull(); // sample_size 預設 null
    expect(params[8]).toBeNull(); // note 預設 null
    expect(params[9]).toBeTruthy(); // valid_until 應有預設值
  });

  it('空陣列應回傳 0', () => {
    const { db } = createMockDb();
    const count = handleRoutingUpdate(db, []);
    expect(count).toBe(0);
  });

  it('null/undefined 項目應被跳過', () => {
    const { db, inserts } = createMockDb();
    const count = handleRoutingUpdate(db, [null, undefined, {}]);
    expect(count).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('DB 寫入失敗時應拋出錯誤', () => {
    const db = createFailingDb();
    const update = { service_id: 'openai', region: 'us', status: 'preferred' };

    expect(() => handleRoutingUpdate(db, update)).toThrow('DB 寫入失敗');
  });

  it('不合法的 status 應被 clamp 為 unknown（安全防護）', () => {
    const { db, inserts } = createMockDb();

    handleRoutingUpdate(db, {
      service_id: 'openai',
      region: 'us',
      status: 'healthy', // 不在白名單：preferred/degraded/avoid/unknown
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[2]).toBe('unknown'); // 被 clamp 為 unknown
  });

  it('數值應被 clamp 到安全範圍（安全防護）', () => {
    const { db, inserts } = createMockDb();

    handleRoutingUpdate(db, {
      service_id: 'openai',
      region: 'us',
      status: 'preferred',
      confidence: 999,       // 超過 1，應被 clamp 為 1
      success_rate: -0.5,    // 低於 0，應被 clamp 為 0
      p95_latency_ms: 999999, // 超過 300000，應被 clamp 為 300000
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[3]).toBe(1);       // confidence clamp 到 1
    expect(inserts[0]!.params[4]).toBe(0);       // success_rate clamp 到 0
    expect(inserts[0]!.params[6]).toBe(300000);  // p95_latency_ms clamp 到 300000
  });

  it('valid_until 有提供時應使用提供的值', () => {
    const { db, inserts } = createMockDb();
    const customExpiry = '2026-12-31T23:59:59Z';

    handleRoutingUpdate(db, {
      service_id: 'openai',
      region: 'us',
      status: 'preferred',
      valid_until: customExpiry,
    });

    expect(inserts[0]!.params[9]).toBe(customExpiry);
  });
});

// ===== loadCollectiveIntelFromDB 測試 =====

/** 建立支援 query 的 mock DB（回傳預設的 routing_intel 資料） */
function createQueryableMockDb(rows: Array<{
  service_id: string;
  status: string;
  confidence: number;
  success_rate: number | null;
  p95_latency_ms: number | null;
}>): ClawDatabase {
  return {
    query: () => rows,
    run: () => {},
  } as unknown as ClawDatabase;
}

describe('loadCollectiveIntelFromDB（爽點四：路由智慧回灌）', () => {
  it('有資料時應正確轉換為 CollectiveIntel 格式', () => {
    const db = createQueryableMockDb([
      { service_id: 'openai', status: 'preferred', confidence: 0.95, success_rate: 0.99, p95_latency_ms: 600 },
      { service_id: 'groq', status: 'preferred', confidence: 0.9, success_rate: 0.97, p95_latency_ms: 200 },
    ]);

    const intel = loadCollectiveIntelFromDB(db);
    expect(intel).not.toBeNull();
    expect(intel).toHaveProperty('openai');
    expect(intel).toHaveProperty('groq');

    const openai = intel!['openai'] as Record<string, unknown>;
    expect(openai['success_rate']).toBe(0.99);
    expect(openai['p95_latency_ms']).toBe(600);
    expect(openai['confidence']).toBe(0.95);
    expect(openai['status']).toBe('preferred');
  });

  it('同 service_id 多筆時只取第一筆（最新的）', () => {
    const db = createQueryableMockDb([
      // 第一筆（最新的，因為 ORDER BY updated_at DESC）
      { service_id: 'openai', status: 'preferred', confidence: 0.95, success_rate: 0.99, p95_latency_ms: 600 },
      // 第二筆（較舊的，同 service_id）
      { service_id: 'openai', status: 'degraded', confidence: 0.5, success_rate: 0.7, p95_latency_ms: 2000 },
    ]);

    const intel = loadCollectiveIntelFromDB(db);
    expect(intel).not.toBeNull();

    const openai = intel!['openai'] as Record<string, unknown>;
    // 應該用第一筆（最新的）
    expect(openai['status']).toBe('preferred');
    expect(openai['confidence']).toBe(0.95);
  });

  it('空資料時應回傳 null', () => {
    const db = createQueryableMockDb([]);
    const intel = loadCollectiveIntelFromDB(db);
    expect(intel).toBeNull();
  });

  it('null 欄位應套用預設值', () => {
    const db = createQueryableMockDb([
      { service_id: 'openai', status: 'preferred', confidence: 0.8, success_rate: null, p95_latency_ms: null },
    ]);

    const intel = loadCollectiveIntelFromDB(db);
    expect(intel).not.toBeNull();

    const openai = intel!['openai'] as Record<string, unknown>;
    expect(openai['success_rate']).toBe(0.5); // null → 預設 0.5
    expect(openai['p95_latency_ms']).toBe(5000); // null → 預設 5000
  });
});
