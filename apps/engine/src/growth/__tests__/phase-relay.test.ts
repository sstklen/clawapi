// 四爽接力棒系統（Phase Transition Relay）單元測試
// 測試階段轉換偵測、teaser 訊息、banner 格式化

import { describe, it, expect } from 'bun:test';
import {
  checkTransition,
  getTeaser,
  formatTransitionBanner,
  type TransitionResult,
} from '../phase-relay';
import type { ClawDatabase } from '../../storage/database';
import type { KeyPool } from '../../core/key-pool';
import type { GrowthPhase } from '../types';

// ===== Mock 工具 =====

/** 建立假的 settings 資料存儲 */
function createMockDb(initialPhase?: string) {
  const store = new Map<string, string>();
  if (initialPhase) {
    store.set('growth_last_phase', initialPhase);
  }

  return {
    query: <T>(sql: string): T[] => {
      if (sql.includes('growth_last_phase') && sql.includes('SELECT')) {
        const val = store.get('growth_last_phase');
        if (val) return [{ value: val }] as T[];
        return [];
      }
      return [];
    },
    run: (sql: string, params?: unknown[]) => {
      if (sql.includes('growth_last_phase') && params?.[0]) {
        store.set('growth_last_phase', params[0] as string);
      }
    },
    _store: store,
  } as unknown as ClawDatabase & { _store: Map<string, string> };
}

/** 建立假的 KeyPool */
function createMockKeyPool(services: string[]): KeyPool {
  const keys = services.map((s, i) => ({
    id: i + 1,
    service_id: s,
    key_masked: 'sk-****test',
    pool_type: 'king' as const,
    label: null,
    status: 'active' as const,
    priority: 0,
    pinned: false,
    daily_used: 0,
    consecutive_failures: 0,
    rate_limit_until: null,
    last_success_at: null,
    created_at: new Date().toISOString(),
  }));

  return {
    listKeys: async () => keys,
  } as unknown as KeyPool;
}

// ===== checkTransition 測試 =====

describe('checkTransition', () => {
  it('第一次呼叫（無歷史紀錄）應初始化並回傳 null', () => {
    const db = createMockDb();
    const result = checkTransition(db, 'onboarding');
    expect(result).toBeNull();
    // 但應該已存入 settings
    expect(db._store.get('growth_last_phase')).toBe('onboarding');
  });

  it('階段未變化應回傳 null', () => {
    const db = createMockDb('awakening');
    const result = checkTransition(db, 'awakening');
    expect(result).toBeNull();
  });

  it('onboarding → awakening 應觸發轉換', () => {
    const db = createMockDb('onboarding');
    const result = checkTransition(db, 'awakening');
    expect(result).not.toBeNull();
    expect(result!.from).toBe('onboarding');
    expect(result!.to).toBe('awakening');
    // i18n 未初始化時走 key fallback，但 celebration 和 hint 不應為空
    expect(result!.celebration).toBeTruthy();
    expect(result!.next_hint).toBeTruthy();
    // 應該更新了存儲
    expect(db._store.get('growth_last_phase')).toBe('awakening');
  });

  it('awakening → scaling 應觸發轉換', () => {
    const db = createMockDb('awakening');
    const result = checkTransition(db, 'scaling');
    expect(result).not.toBeNull();
    expect(result!.from).toBe('awakening');
    expect(result!.to).toBe('scaling');
  });

  it('scaling → mastery 應觸發轉換', () => {
    const db = createMockDb('scaling');
    const result = checkTransition(db, 'mastery');
    expect(result).not.toBeNull();
    expect(result!.from).toBe('scaling');
    expect(result!.to).toBe('mastery');
  });

  it('跳級（onboarding → scaling）應觸發轉換並有慶祝訊息', () => {
    const db = createMockDb('onboarding');
    const result = checkTransition(db, 'scaling');
    expect(result).not.toBeNull();
    expect(result!.from).toBe('onboarding');
    expect(result!.to).toBe('scaling');
    // 跳級沒有專屬翻譯（group5.json 沒有 onboarding_scaling），
    // 應走 generic 分支，但不管哪個分支都要有非空慶祝訊息
    expect(result!.celebration.length).toBeGreaterThan(0);
    expect(result!.next_hint.length).toBeGreaterThan(0);
  });

  it('連續呼叫兩次：第一次升級，第二次不再觸發', () => {
    const db = createMockDb('onboarding');
    const first = checkTransition(db, 'awakening');
    expect(first).not.toBeNull();
    // 第二次相同階段不應再觸發
    const second = checkTransition(db, 'awakening');
    expect(second).toBeNull();
  });

  it('降級不應觸發慶祝（回傳 null）但應更新存儲', () => {
    const db = createMockDb('scaling');
    const result = checkTransition(db, 'awakening');
    expect(result).toBeNull();
    // 但應該更新了存儲
    expect(db._store.get('growth_last_phase')).toBe('awakening');
  });

  it('DB 值不合法應重新初始化並回傳 null', () => {
    // 模擬手動改壞 DB 值
    const db = createMockDb('garbage_value' as any);
    const result = checkTransition(db, 'awakening');
    expect(result).toBeNull();
    // 應該重新初始化為當前階段
    expect(db._store.get('growth_last_phase')).toBe('awakening');
  });

  it('DB 值為空字串應重新初始化', () => {
    const db = createMockDb('' as any);
    const result = checkTransition(db, 'scaling');
    expect(result).toBeNull();
    expect(db._store.get('growth_last_phase')).toBe('scaling');
  });

  it('db 壞掉不應爆炸', () => {
    const db = {
      query: () => { throw new Error('DB 壞了'); },
      run: () => { throw new Error('DB 壞了'); },
    } as unknown as ClawDatabase;
    // 讀取失敗 = 沒有歷史 = 初始化 = null（寫入也會靜默失敗）
    const result = checkTransition(db, 'awakening');
    expect(result).toBeNull();
  });
});

// ===== getTeaser 測試 =====

describe('getTeaser', () => {
  it('onboarding 應回傳非空 teaser', async () => {
    const keyPool = createMockKeyPool([]);
    const teaser = await getTeaser('onboarding', keyPool);
    expect(teaser.length).toBeGreaterThan(0);
  });

  it('awakening 有 1 個服務應回傳非空 teaser', async () => {
    const keyPool = createMockKeyPool(['openai']);
    const teaser = await getTeaser('awakening', keyPool);
    expect(teaser.length).toBeGreaterThan(0);
  });

  it('awakening 有 2 個服務應回傳非空 teaser', async () => {
    const keyPool = createMockKeyPool(['openai', 'anthropic']);
    const teaser = await getTeaser('awakening', keyPool);
    expect(teaser.length).toBeGreaterThan(0);
  });

  it('scaling 有 3 個服務應回傳非空 teaser', async () => {
    const keyPool = createMockKeyPool(['openai', 'anthropic', 'groq']);
    const teaser = await getTeaser('scaling', keyPool);
    expect(teaser.length).toBeGreaterThan(0);
  });

  it('scaling 有 4 個服務應回傳非空 teaser', async () => {
    const keyPool = createMockKeyPool(['openai', 'anthropic', 'groq', 'mistral']);
    const teaser = await getTeaser('scaling', keyPool);
    expect(teaser.length).toBeGreaterThan(0);
  });

  it('mastery 應回傳非空 teaser', async () => {
    const keyPool = createMockKeyPool(['a', 'b', 'c', 'd', 'e']);
    const teaser = await getTeaser('mastery', keyPool);
    expect(teaser.length).toBeGreaterThan(0);
  });

  it('不合法的 phase 應回傳空字串', async () => {
    const keyPool = createMockKeyPool([]);
    const teaser = await getTeaser('unknown_phase' as GrowthPhase, keyPool);
    expect(teaser).toBe('');
  });
});

// ===== formatTransitionBanner 測試 =====

describe('formatTransitionBanner', () => {
  it('應產出包含慶祝訊息和下一步的 banner', () => {
    const result: TransitionResult = {
      from: 'onboarding',
      to: 'awakening',
      celebration: '🎉 路由覺醒！',
      next_hint: 'growth_guide(view=recommend)',
    };
    const banner = formatTransitionBanner(result);
    expect(banner).toContain('═══');
    expect(banner).toContain('🎉 路由覺醒！');
    expect(banner).toContain('growth_guide');
  });

  it('banner 應有空行開頭（方便插入到回應尾巴）', () => {
    const result: TransitionResult = {
      from: 'awakening',
      to: 'scaling',
      celebration: '🚀 額度擴張！',
      next_hint: 'keys_add',
    };
    const banner = formatTransitionBanner(result);
    expect(banner.startsWith('\n')).toBe(true);
  });

  it('banner 應包含 next_hint 內容', () => {
    const result: TransitionResult = {
      from: 'scaling',
      to: 'mastery',
      celebration: '🧠 群體智慧！',
      next_hint: 'growth_guide(view=intel)',
    };
    const banner = formatTransitionBanner(result);
    // banner 中應包含下一步的提示
    expect(banner).toContain('growth_guide(view=intel)');
    // 以及慶祝訊息
    expect(banner).toContain('🧠 群體智慧！');
  });
});
