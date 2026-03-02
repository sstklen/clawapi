// 路由更新處理器測試
// 測試 VPS 下發的 routing_intel 寫入邏輯

import { describe, it, expect } from 'bun:test';
import { handleRoutingUpdate, type RoutingUpdateItem } from '../routing-handler';
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
      status: 'healthy',
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
    expect(inserts[0]!.params[2]).toBe('healthy');
    expect(inserts[0]!.params[3]).toBe(0.95);
    expect(inserts[0]!.params[8]).toBe('穩定');
  });

  it('應正確處理陣列更新', () => {
    const { db, inserts } = createMockDb();

    const updates: RoutingUpdateItem[] = [
      { service_id: 'openai', region: 'us-west', status: 'healthy' },
      { service_id: 'groq', region: 'us-east', status: 'healthy' },
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
      { service_id: 'openai', region: 'us-west', status: 'healthy' }, // ✅
      { service_id: 'groq' }, // ❌ 缺 region 和 status
      { region: 'us-east', status: 'healthy' }, // ❌ 缺 service_id
      { service_id: 'gemini', region: 'asia' }, // ❌ 缺 status
      { service_id: 'anthropic', region: 'eu', status: 'healthy' }, // ✅
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
      status: 'healthy',
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
    const update = { service_id: 'openai', region: 'us', status: 'healthy' };

    expect(() => handleRoutingUpdate(db, update)).toThrow('DB 寫入失敗');
  });

  it('valid_until 有提供時應使用提供的值', () => {
    const { db, inserts } = createMockDb();
    const customExpiry = '2026-12-31T23:59:59Z';

    handleRoutingUpdate(db, {
      service_id: 'openai',
      region: 'us',
      status: 'healthy',
      valid_until: customExpiry,
    });

    expect(inserts[0]!.params[9]).toBe(customExpiry);
  });
});
