import type { SubKeyManager, SubKey } from '../sharing/sub-key';
import type { KeyPool } from '../core/key-pool';
import type { GoldKeySetupResult } from './types';

/**
 * 取得既有 Gold Key（若存在）
 */
export async function getExistingGoldKey(subKeyManager: SubKeyManager): Promise<SubKey | null> {
  const subKeys = await subKeyManager.list();
  return subKeys.find(k => k.label.includes('Gold Key')) ?? null;
}

/**
 * 自動建立或取得 Gold Key
 */
export async function setupAutoGoldKey(
  subKeyManager: SubKeyManager,
  keyPool: KeyPool
): Promise<GoldKeySetupResult> {
  let subKey = await getExistingGoldKey(subKeyManager);
  let isNew = false;

  if (!subKey) {
    subKey = await subKeyManager.issue({
      label: 'Gold Key（自動產生）',
      daily_limit: null,
      allowed_services: null,
      allowed_models: null,
      rate_limit_per_hour: null,
    });
    isNew = true;
  }

  const keys = await keyPool.listKeys();
  const servicesIncluded = Array.from(new Set(keys.map(k => k.service_id)));

  return {
    token: subKey.token,
    services_included: servicesIncluded,
    usage_example: `base_url=http://localhost:4141/v1  api_key=${subKey.token}`,
    is_new: isNew,
  };
}

