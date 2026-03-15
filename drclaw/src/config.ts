/**
 * Dr. Claw — 環境變數配置
 * 取代 washin-api 的 config-manager（簡化版）
 */

/** 取得環境變數，附預設值 */
export function getEnv(key: string, fallback: string = ''): string {
  return process.env[key] || fallback;
}

/** 取得數字環境變數 */
export function getEnvNum(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

/** 取得布林環境變數 */
export function getEnvBool(key: string, fallback: boolean): boolean {
  const val = process.env[key]?.toLowerCase();
  if (!val) return fallback;
  return val === 'true' || val === '1' || val === 'yes';
}

/**
 * 功能開關（簡化版）
 * washin-api 用 SQLite 動態配置，Dr. Claw 獨立後改用環境變數
 * FEATURE_DEBUG_AI=true 啟用 debug_ai
 */
export function isFeatureEnabled(name: string): boolean {
  // 環境變數格式：FEATURE_XXX_YYY=true
  const envKey = `FEATURE_${name.toUpperCase().replace(/\./g, '_')}`;
  return getEnvBool(envKey, true); // 預設啟用
}
