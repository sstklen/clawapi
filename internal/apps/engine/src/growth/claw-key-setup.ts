import type { SubKeyManager, SubKey } from '../sharing/sub-key';
import type { KeyPool } from '../core/key-pool';
import type { ClawKeySetupResult } from './types';

/**
 * 取得既有 Claw Key（若存在）
 * 相容舊版 Gold Key label
 */
export async function getExistingClawKey(subKeyManager: SubKeyManager): Promise<SubKey | null> {
  const subKeys = await subKeyManager.list();
  return subKeys.find(k => k.label.includes('Claw Key') || k.label.includes('Gold Key')) ?? null;
}

/**
 * 自動建立或取得 Claw Key
 */
export async function setupAutoClawKey(
  subKeyManager: SubKeyManager,
  keyPool: KeyPool
): Promise<ClawKeySetupResult> {
  let subKey = await getExistingClawKey(subKeyManager);
  let isNew = false;

  if (!subKey) {
    subKey = await subKeyManager.issue({
      label: 'Claw Key（自動產生）',
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
