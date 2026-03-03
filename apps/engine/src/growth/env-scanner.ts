import type { KeyPool } from '../core/key-pool';
import { ENV_KEY_MAP, type EnvScanResult, type FoundKey, type OllamaDetection } from './types';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

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
 * 解析 .env 檔案內容，回傳 key=value 對照表
 * 支援：KEY=value、KEY="value"、KEY='value'、空行、# 註解
 * 忽略：被註解掉的行（# KEY=value）
 */
function parseEnvFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // 跳過空行和註解
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // 去除引號（"value" 或 'value'）
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && value) {
      result.set(key, value);
    }
  }
  return result;
}

/**
 * 掃描常見 .env 檔案位置，回傳環境變數合集
 *
 * 掃描範圍：~/.env、~/Desktop 下專案/.env、~/Projects 下專案/.env、~/.clawapi/.env
 * 安全：只讀取已知的 API Key 名稱，不回傳其他敏感資料
 */
function scanDotEnvFiles(): Map<string, string> {
  const allVars = new Map<string, string>();
  const home = homedir();

  // 已知的 API Key 名稱集合（只提取這些，不洩漏其他變數）
  const knownKeyNames = new Set(ENV_KEY_MAP.map(item => item.env_var));

  // 要掃描的 .env 檔案路徑
  const envPaths: string[] = [
    join(home, '.env'),
    join(home, '.clawapi', '.env'),
  ];

  // 掃描常見專案目錄下的 .env 檔案（只看第一層子目錄）
  const projectDirs = [
    join(home, 'Desktop'),
    join(home, 'Projects'),
    join(home, 'projects'),
    join(home, 'dev'),
    join(home, 'Developer'),
  ];

  for (const dir of projectDirs) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          envPaths.push(join(dir, entry.name, '.env'));
          envPaths.push(join(dir, entry.name, '.env.local'));
        }
      }
    } catch {
      // 目錄不可讀就跳過
    }
  }

  // 讀取並合併所有 .env 檔案
  for (const envPath of envPaths) {
    try {
      if (!existsSync(envPath)) continue;
      const content = readFileSync(envPath, 'utf8');
      const vars = parseEnvFile(content);

      // 只提取已知的 API Key，不碰其他敏感變數
      for (const [key, value] of vars) {
        if (knownKeyNames.has(key) && !allVars.has(key)) {
          allVars.set(key, value);
        }
      }
    } catch {
      // 檔案不可讀就跳過
    }
  }

  return allVars;
}

/** scanEnvVars 選項 */
export interface ScanEnvOptions {
  /** 是否掃描 .env 檔案（預設 true） */
  scanDotEnv?: boolean;
}

/**
 * 掃描環境中的 API Key
 * 來源：process.env（環境變數）+ .env 檔案
 * 去重：同一個 service_id 只保留第一個找到的
 * 優先順序：process.env 優先於 .env 檔案
 */
export function scanEnvVars(options?: ScanEnvOptions): FoundKey[] {
  const found: FoundKey[] = [];
  const seen = new Set<string>(); // 以 service_id 去重

  // 先掃 .env 檔案，收集所有已知的 API Key
  // 可用 CLAWAPI_SKIP_DOTENV=1 或 options.scanDotEnv=false 關閉
  const scanDotEnv = options?.scanDotEnv !== false && !process.env.CLAWAPI_SKIP_DOTENV;
  const dotEnvVars = scanDotEnv ? scanDotEnvFiles() : new Map<string, string>();

  for (const item of ENV_KEY_MAP) {
    // process.env 優先，沒有的話才用 .env 檔案的值
    const value = process.env[item.env_var] || dotEnvVars.get(item.env_var);
    if (!value || value.trim() === '') {
      continue;
    }

    // 同一個 service_id 只計一次（如 GOOGLE_API_KEY 和 GEMINI_API_KEY 都是 gemini）
    if (seen.has(item.service_id)) {
      continue;
    }
    seen.add(item.service_id);

    // 標記來源（process.env 或 .env 檔案）
    const fromDotEnv = !process.env[item.env_var] && dotEnvVars.has(item.env_var);

    found.push({
      service_id: item.service_id,
      env_var: fromDotEnv ? `${item.env_var} (.env)` : item.env_var,
      key_preview: maskKey(value),
      key_value: value,
      already_managed: false,
      display_name: item.display_name,
      category: item.category,
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

