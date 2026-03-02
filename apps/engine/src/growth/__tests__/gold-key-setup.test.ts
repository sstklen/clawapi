import { describe, it, expect } from 'bun:test';
import { getExistingGoldKey, setupAutoGoldKey } from '../gold-key-setup';
import type { SubKeyManager, SubKey } from '../../sharing/sub-key';
import type { KeyPool } from '../../core/key-pool';

function makeSubKey(partial: Partial<SubKey> = {}): SubKey {
  return {
    id: 1,
    label: '一般 Key',
    token: 'sk_live_12345678_00000000-0000-0000-0000-000000000000',
    is_active: true,
    daily_limit: null,
    daily_used: 0,
    allowed_services: null,
    allowed_models: null,
    rate_limit_per_hour: null,
    rate_used_this_hour: 0,
    expires_at: null,
    created_at: new Date().toISOString(),
    last_used_at: null,
    total_requests: 0,
    total_tokens: 0,
    ...partial,
  };
}

describe('gold-key-setup', () => {
  it('已有 Gold Key 時應直接回用既有 token', async () => {
    const existing = makeSubKey({
      label: 'Gold Key（手動建立）',
      token: 'sk_live_exist',
    });

    const subKeyManager = {
      list: async () => [existing],
      issue: async () => {
        throw new Error('should not issue');
      },
    } as unknown as SubKeyManager;

    const keyPool = {
      listKeys: async () => [
        { service_id: 'openai' },
        { service_id: 'groq' },
      ],
    } as unknown as KeyPool;

    const found = await getExistingGoldKey(subKeyManager);
    expect(found?.token).toBe('sk_live_exist');

    const result = await setupAutoGoldKey(subKeyManager, keyPool);
    expect(result.token).toBe('sk_live_exist');
    expect(result.is_new).toBe(false);
    expect(result.services_included).toEqual(['openai', 'groq']);
  });

  it('沒有 Gold Key 時應自動新建', async () => {
    const created = makeSubKey({
      id: 2,
      label: 'Gold Key（自動產生）',
      token: 'sk_live_new',
    });

    const subKeyManager = {
      list: async () => [makeSubKey()],
      issue: async () => created,
    } as unknown as SubKeyManager;

    const keyPool = {
      listKeys: async () => [
        { service_id: 'openai' },
        { service_id: 'openai' },
        { service_id: 'deepl' },
      ],
    } as unknown as KeyPool;

    const result = await setupAutoGoldKey(subKeyManager, keyPool);
    expect(result.token).toBe('sk_live_new');
    expect(result.is_new).toBe(true);
    expect(result.services_included).toEqual(['openai', 'deepl']);
    expect(result.usage_example).toContain('api_key=sk_live_new');
  });

  it('keyPool 為空時 services_included 應為空陣列', async () => {
    const created = makeSubKey({
      label: 'Gold Key（自動產生）',
      token: 'sk_live_empty',
    });

    const subKeyManager = {
      list: async () => [],
      issue: async () => created,
    } as unknown as SubKeyManager;

    const keyPool = {
      listKeys: async () => [],
    } as unknown as KeyPool;

    const result = await setupAutoGoldKey(subKeyManager, keyPool);
    expect(result.services_included).toEqual([]);
  });
});

