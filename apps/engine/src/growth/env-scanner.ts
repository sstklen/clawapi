import type { KeyPool } from '../core/key-pool';
import { ENV_KEY_MAP, type EnvScanResult, type FoundKey, type OllamaDetection } from './types';

/**
 * 遮罩 API Key：顯示前 4 + 後 4
 * 長度不足 12 時完全遮罩
 */
export function maskKey(key: string): string {
  if (key.length < 12) {
    return '****';
  }
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/**
 * 掃描環境變數中的 API Key
 */
export function scanEnvVars(): FoundKey[] {
  const found: FoundKey[] = [];

  for (const item of ENV_KEY_MAP) {
    const value = process.env[item.env_var];
    if (!value || value.trim() === '') {
      continue;
    }

    found.push({
      service_id: item.service_id,
      env_var: item.env_var,
      key_preview: maskKey(value),
      key_value: value,
      already_managed: false,
    });
  }

  return found;
}

/**
 * 偵測本機 Ollama 是否可用
 */
export async function detectOllama(url: string = 'http://localhost:11434'): Promise<OllamaDetection> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const res = await fetch(new URL('/api/tags', url), {
      method: 'GET',
      signal: controller.signal,
    });

    if (!res.ok) {
      return { detected: false, models: [], url };
    }

    const data = await res.json() as { models?: Array<{ name?: string }> };
    const models = Array.isArray(data.models)
      ? data.models.map(m => m.name).filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [];

    return {
      detected: true,
      models,
      url,
    };
  } catch {
    return { detected: false, models: [], url };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 執行完整掃描：環境 Key + Ollama + 是否已納管
 */
export async function fullScan(keyPool: KeyPool): Promise<EnvScanResult> {
  const foundKeys = scanEnvVars();
  const managedKeys = await keyPool.listKeys();
  const managedSet = new Set(managedKeys.map(k => `${k.service_id}:${k.key_masked}`));

  const marked = foundKeys.map(key => ({
    ...key,
    already_managed: managedSet.has(`${key.service_id}:${key.key_preview}`),
  }));

  const ollama = await detectOllama();

  return {
    found_keys: marked,
    ollama,
  };
}

