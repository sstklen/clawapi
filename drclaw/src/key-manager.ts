/**
 * Dr. Claw — API Key 管理（簡化版）
 * 取代 washin-api 的 key-store（只保留 Dr. Claw 需要的 3 個函式）
 *
 * washin-api 的 key-store 是完整的 Key Pool（AES-256-GCM、多供應商輪轉、權重分配）
 * Dr. Claw 獨立後只需要讀環境變數，不需要那套複雜系統
 */

import { createLogger } from './logger';

const log = createLogger('KeyManager');

/** 已知的 service → env 映射 */
const SERVICE_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  voyageai: 'VOYAGE_API_KEY',
};

/**
 * 取得 API Key（優先讀 env）
 * 向後相容 washin-api 的 getKeyOrEnv(serviceId, envName) 介面
 */
export function getKeyOrEnv(serviceId: string, envName: string): string | null {
  // 直接讀環境變數
  const val = process.env[envName] || process.env[SERVICE_ENV_MAP[serviceId] || ''] || null;
  if (!val) {
    log.warn(`缺少 ${envName} 環境變數（serviceId: ${serviceId}）`);
    return null;
  }
  // 佔位符防護
  if (val.startsWith('sk-placeholder') || val === 'your-key-here') {
    log.warn(`${envName} 是佔位符，已忽略`);
    return null;
  }
  return val;
}

/**
 * 回報 Key 使用結果
 * washin-api 會更新 failCount/status/權重，Dr. Claw 獨立後只記 log
 */
export function reportKeyResult(serviceId: string, key: string, success: boolean, errorType?: string): void {
  if (!success) {
    log.warn(`Key 使用失敗 [${serviceId}] error: ${errorType || 'unknown'}`);
  }
}
