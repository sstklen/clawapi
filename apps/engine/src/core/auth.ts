// Auth 模組 — 引擎端本機認證
// 負責 auth.token 管理、請求驗證、Sub-Key 驗證

import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { MiddlewareHandler } from 'hono';
import { ErrorCode } from '@clawapi/protocol';
import type { ClawDatabase } from '../storage/database';

// ===== 常數 =====

/** auth.token 前綴 */
const TOKEN_PREFIX = 'clw_t';
/** auth.token 格式：clw_t + 64 hex chars = 69 字元 */
const TOKEN_HEX_LENGTH = 64;
/** Sub-Key 前綴 */
const SUBKEY_PREFIX = 'sk_live_';
/** auth.token 檔案名稱 */
const TOKEN_FILENAME = 'auth.token';

// ===== 型別定義 =====

/** 請求驗證結果 */
export interface AuthResult {
  valid: boolean;
  type?: 'master' | 'subkey';
  token?: string;
  error?: string;
}

/** Sub-Key 驗證結果 */
export interface SubKeyValidation {
  valid: boolean;
  subKeyId?: number;
  permissions?: {
    allowed_services: string[] | null;
    allowed_models: string[] | null;
    daily_limit: number | null;
    daily_remaining: number | null;
    rate_limit_per_hour: number | null;
    rate_remaining: number | null;
    expires_at: string | null;
  };
  error?: string;
}

/** DB 查詢回傳的 Sub-Key 資料列 */
interface SubKeyRow {
  id: number;
  token: string;
  is_active: number;
  expires_at: string | null;
  daily_limit: number | null;
  daily_used: number;
  allowed_services: string | null;
  allowed_models: string | null;
  rate_limit_per_hour: number | null;
  rate_used_this_hour: number;
  rate_hour_start: string | null;
}

// ===== EngineAuth 主類別 =====

export class EngineAuth {
  /** 記憶體中的 auth token */
  private authToken: string | null = null;
  /** auth.token 檔案路徑 */
  private tokenPath: string;
  /** 資料庫實例（Sub-Key 查詢用） */
  private db: ClawDatabase;

  /**
   * @param db - ClawDatabase 實例（用於 Sub-Key 查詢）
   * @param dataDir - 資料目錄路徑（預設 ~/.clawapi）
   */
  constructor(db: ClawDatabase, dataDir?: string) {
    this.db = db;
    const baseDir = dataDir ?? join(homedir(), '.clawapi');
    this.tokenPath = join(baseDir, TOKEN_FILENAME);
  }

  // ===== Token 管理 =====

  /**
   * 初始化 auth.token
   * 檔案存在 → 讀取並驗證格式
   * 不存在 → 產生新 token，寫入檔案（權限 0600）
   *
   * @param dataDir - 可選的資料目錄路徑（會更新 tokenPath）
   */
  async initToken(dataDir?: string): Promise<void> {
    // 若有額外傳入路徑，更新 tokenPath
    if (dataDir) {
      this.tokenPath = join(dataDir, TOKEN_FILENAME);
    }

    // 確保目錄存在
    const dir = join(this.tokenPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(this.tokenPath)) {
      // 讀取現有 token
      const content = readFileSync(this.tokenPath, 'utf8').trim();
      if (!this.isValidTokenFormat(content)) {
        throw new Error(`auth.token 格式錯誤：期望 ${TOKEN_PREFIX} 開頭加 ${TOKEN_HEX_LENGTH} hex 字元`);
      }
      this.authToken = content;
    } else {
      // 首次啟動：產生新 token
      const token = this.generateNewToken();
      writeFileSync(this.tokenPath, token, { mode: 0o600 });
      // 確保權限正確（某些系統可能需要明確設定）
      try {
        chmodSync(this.tokenPath, 0o600);
      } catch {
        // 非 POSIX 系統忽略
      }
      this.authToken = token;
    }
  }

  /**
   * 取得記憶體中的 auth token
   * 未初始化時拋出錯誤
   */
  getToken(): string {
    if (this.authToken === null) {
      throw new Error('Auth token 尚未初始化，請先呼叫 initToken()');
    }
    return this.authToken;
  }

  /**
   * 重置 auth token
   * 產生新 token → 覆寫檔案 → 更新記憶體
   * 用於 clawapi token reset 指令
   */
  async resetToken(): Promise<string> {
    // 確保目錄存在
    const dir = join(this.tokenPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const newToken = this.generateNewToken();
    writeFileSync(this.tokenPath, newToken, { mode: 0o600 });
    try {
      chmodSync(this.tokenPath, 0o600);
    } catch {
      // 非 POSIX 系統忽略
    }
    this.authToken = newToken;
    return newToken;
  }

  // ===== 請求驗證 =====

  /**
   * 驗證 HTTP Authorization header
   *
   * 驗證順序：
   * 1. 無 header → AUTH_MISSING
   * 2. 不以 'Bearer ' 開頭 → AUTH_INVALID_FORMAT
   * 3. token 以 'sk_live_' 開頭 → subkey 類型
   * 4. token 等於 auth.token → master 類型
   * 5. 其他 → AUTH_INVALID_TOKEN
   */
  validateRequest(authHeader: string | undefined): AuthResult {
    // 1. 無 Authorization header
    if (!authHeader) {
      return { valid: false, error: 'AUTH_MISSING' };
    }

    // 2. 格式必須是 Bearer xxx
    if (!authHeader.startsWith('Bearer ')) {
      return { valid: false, error: 'AUTH_INVALID_FORMAT' };
    }

    const token = authHeader.slice('Bearer '.length);

    // 3. Sub-Key（以 sk_live_ 開頭）
    if (token.startsWith(SUBKEY_PREFIX)) {
      return { valid: true, type: 'subkey', token };
    }

    // 4. Master token 比對（使用 timingSafeEqual 防止 timing attack）
    if (this.authToken !== null && this.safeCompare(token, this.authToken)) {
      return { valid: true, type: 'master' };
    }

    // 5. 其他無效 token
    return { valid: false, error: 'AUTH_INVALID_TOKEN' };
  }

  // ===== Sub-Key 驗證 =====

  /**
   * 本機驗證 Sub-Key
   * 從 DB 查詢 sub_keys 表，依序驗證各項條件
   *
   * @param token - Sub-Key token 字串
   * @param serviceId - 目標服務 ID（可選）
   * @param model - 目標模型 ID（可選）
   */
  async validateSubKey(
    token: string,
    serviceId?: string,
    model?: string
  ): Promise<SubKeyValidation> {
    // 1. 從 DB 查詢 sub_keys 表
    const rows = this.db.query<SubKeyRow>(
      'SELECT * FROM sub_keys WHERE token = ?',
      [token]
    );

    // 2. 不存在
    if (rows.length === 0) {
      return { valid: false, error: ErrorCode.SUBKEY_INVALID };
    }

    const sk = rows[0];

    // 3. is_active = 0 → 停用
    if (sk.is_active === 0) {
      return { valid: false, error: ErrorCode.SUBKEY_INVALID };
    }

    // 4. 過期檢查
    if (sk.expires_at !== null) {
      const expiry = new Date(sk.expires_at);
      if (expiry < new Date()) {
        return { valid: false, error: ErrorCode.SUBKEY_INVALID };
      }
    }

    // 5. 每日用量上限
    if (sk.daily_limit !== null && sk.daily_used >= sk.daily_limit) {
      return { valid: false, error: 'daily_limit_exceeded' };
    }

    // 6. 每小時速率限制
    if (sk.rate_limit_per_hour !== null) {
      // 檢查 rate_hour_start 是否在目前這個小時內
      const currentHourStart = this.getCurrentHourStart();
      const rateHourStart = sk.rate_hour_start ? new Date(sk.rate_hour_start) : null;
      const isCurrentHour =
        rateHourStart !== null &&
        rateHourStart >= currentHourStart;

      // 若在同一小時內且已達上限
      if (isCurrentHour && sk.rate_used_this_hour >= sk.rate_limit_per_hour) {
        return { valid: false, error: 'rate_limit_exceeded' };
      }
    }

    // 7. allowed_services 檢查
    if (sk.allowed_services !== null && serviceId !== undefined) {
      const allowedList = this.parseJsonArray(sk.allowed_services);
      if (allowedList !== null && !allowedList.includes(serviceId)) {
        return { valid: false, error: 'service_not_allowed' };
      }
    }

    // 8. allowed_models 檢查
    if (sk.allowed_models !== null && model !== undefined) {
      const allowedList = this.parseJsonArray(sk.allowed_models);
      if (allowedList !== null && !allowedList.includes(model)) {
        return { valid: false, error: 'model_not_allowed' };
      }
    }

    // 9. 全部通過
    const allowedServices = sk.allowed_services ? this.parseJsonArray(sk.allowed_services) : null;
    const allowedModels = sk.allowed_models ? this.parseJsonArray(sk.allowed_models) : null;

    const dailyRemaining =
      sk.daily_limit !== null ? Math.max(0, sk.daily_limit - sk.daily_used) : null;

    // 計算速率剩餘次數
    let rateRemaining: number | null = null;
    if (sk.rate_limit_per_hour !== null) {
      const currentHourStart = this.getCurrentHourStart();
      const rateHourStart = sk.rate_hour_start ? new Date(sk.rate_hour_start) : null;
      const isCurrentHour = rateHourStart !== null && rateHourStart >= currentHourStart;
      const usedThisHour = isCurrentHour ? sk.rate_used_this_hour : 0;
      rateRemaining = Math.max(0, sk.rate_limit_per_hour - usedThisHour);
    }

    return {
      valid: true,
      subKeyId: sk.id,
      permissions: {
        allowed_services: allowedServices,
        allowed_models: allowedModels,
        daily_limit: sk.daily_limit,
        daily_remaining: dailyRemaining,
        rate_limit_per_hour: sk.rate_limit_per_hour,
        rate_remaining: rateRemaining,
        expires_at: sk.expires_at,
      },
    };
  }

  /**
   * 記錄 Sub-Key 用量
   * - daily_used += 1
   * - rate_used_this_hour += 1
   * - last_used_at = now
   * - 若 rate_hour_start 是上個小時 → 重置 rate_used_this_hour = 1, rate_hour_start = now
   *
   * @param subKeyId - Sub-Key 的 DB primary key
   */
  async recordSubKeyUsage(subKeyId: number): Promise<void> {
    // 先查詢目前的 rate_hour_start
    const rows = this.db.query<{ rate_hour_start: string | null }>(
      'SELECT rate_hour_start FROM sub_keys WHERE id = ?',
      [subKeyId]
    );

    if (rows.length === 0) return;

    const currentHourStart = this.getCurrentHourStart();
    const rateHourStart = rows[0].rate_hour_start ? new Date(rows[0].rate_hour_start) : null;
    const isCurrentHour = rateHourStart !== null && rateHourStart >= currentHourStart;
    const now = new Date().toISOString();

    try {
      if (isCurrentHour) {
        // 同一小時內：直接累加
        this.db.run(
          `UPDATE sub_keys
           SET daily_used = daily_used + 1,
               rate_used_this_hour = rate_used_this_hour + 1,
               last_used_at = ?
           WHERE id = ?`,
          [now, subKeyId]
        );
      } else {
        // 跨小時：重置速率計數器
        this.db.run(
          `UPDATE sub_keys
           SET daily_used = daily_used + 1,
               rate_used_this_hour = 1,
               rate_hour_start = ?,
               last_used_at = ?
           WHERE id = ?`,
          [now, now, subKeyId]
        );
      }
    } catch (err) {
      console.error(`[Auth] Sub-Key 用量記錄失敗（id=${subKeyId}）:`, err);
    }
  }

  // ===== 私有輔助方法 =====

  /** 產生新的 auth token（clw_t + 64 hex chars） */
  private generateNewToken(): string {
    const hex = randomBytes(32).toString('hex'); // 32 bytes = 64 hex chars
    return `${TOKEN_PREFIX}${hex}`;
  }

  /** 驗證 token 格式是否正確（clw_t + 64 hex chars） */
  private isValidTokenFormat(token: string): boolean {
    if (!token.startsWith(TOKEN_PREFIX)) return false;
    const hexPart = token.slice(TOKEN_PREFIX.length);
    if (hexPart.length !== TOKEN_HEX_LENGTH) return false;
    return /^[0-9a-f]+$/i.test(hexPart);
  }

  /** 使用 HMAC + timingSafeEqual 進行常數時間比較，防止 timing attack（含長度洩漏防護） */
  private safeCompare(a: string, b: string): boolean {
    try {
      // HMAC 輸出固定 32 bytes，消除長度差異造成的 timing leak
      const key = randomBytes(32);
      const hmacA = createHmac('sha256', key).update(a).digest();
      const hmacB = createHmac('sha256', key).update(b).digest();
      return timingSafeEqual(hmacA, hmacB);
    } catch {
      return false;
    }
  }

  /** 取得目前整點時間（用於速率限制比較） */
  private getCurrentHourStart(): Date {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return now;
  }

  /** 解析 JSON 陣列字串，失敗回傳 null */
  private parseJsonArray(value: string): string[] | null {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as string[];
      return null;
    } catch {
      return null;
    }
  }
}

// ===== Hono Middleware =====

/** 不需認證的路徑清單 */
const PUBLIC_PATHS = new Set(['/health', '/v1/health']);

/**
 * engineAuth — Hono Middleware
 * 驗證請求的 Authorization header
 * 跳過路徑：/health, /v1/health
 *
 * 成功時：
 * - Master token → c.set('authType', 'master')
 * - Sub-Key → c.set('subkey', SubKeyValidation)
 * 失敗時：回傳 401 JSON 錯誤
 *
 * @param auth - EngineAuth 實例
 */
export function engineAuth(auth: EngineAuth): MiddlewareHandler {
  return async (c, next) => {
    // 跳過公開路徑（不需認證）
    if (PUBLIC_PATHS.has(c.req.path)) {
      return next();
    }

    const authHeader = c.req.header('Authorization');
    const result = auth.validateRequest(authHeader);

    // 驗證失敗
    if (!result.valid) {
      return c.json(
        {
          error: mapAuthError(result.error),
          message: getAuthErrorMessage(result.error),
        },
        401
      );
    }

    if (result.type === 'master') {
      // Master token：設定 authType
      c.set('authType', 'master');
    } else if (result.type === 'subkey' && result.token) {
      // Sub-Key：進行本機驗證
      const subKeyValidation = await auth.validateSubKey(result.token);

      if (!subKeyValidation.valid) {
        return c.json(
          {
            error: mapSubKeyError(subKeyValidation.error),
            message: getSubKeyErrorMessage(subKeyValidation.error),
          },
          401
        );
      }

      c.set('subkey', subKeyValidation);
    }

    return next();
  };
}

/** 將本模組的 auth 錯誤碼轉換為 ErrorCode */
function mapAuthError(error: string | undefined): string {
  switch (error) {
    case 'AUTH_MISSING':
      return ErrorCode.AUTH_MISSING_HEADERS;
    case 'AUTH_INVALID_FORMAT':
    case 'AUTH_INVALID_TOKEN':
      return ErrorCode.AUTH_INVALID_TOKEN;
    default:
      return ErrorCode.AUTH_INVALID_TOKEN;
  }
}

/** 取得 auth 錯誤訊息（繁體中文） */
function getAuthErrorMessage(error: string | undefined): string {
  switch (error) {
    case 'AUTH_MISSING':
      return '缺少 Authorization header';
    case 'AUTH_INVALID_FORMAT':
      return 'Authorization header 格式錯誤，請使用 Bearer token 格式';
    case 'AUTH_INVALID_TOKEN':
      return '無效的 token';
    default:
      return '認證失敗';
  }
}

/** 將 Sub-Key 錯誤碼轉換為 ErrorCode */
function mapSubKeyError(error: string | undefined): string {
  switch (error) {
    case ErrorCode.SUBKEY_INVALID:
      return ErrorCode.SUBKEY_INVALID;
    case 'daily_limit_exceeded':
      return ErrorCode.SUBKEY_INVALID;
    case 'rate_limit_exceeded':
      return ErrorCode.SUBKEY_INVALID;
    case 'service_not_allowed':
      return ErrorCode.SUBKEY_INVALID;
    case 'model_not_allowed':
      return ErrorCode.SUBKEY_INVALID;
    default:
      return ErrorCode.AUTH_INVALID_TOKEN;
  }
}

/** 取得 Sub-Key 錯誤訊息（繁體中文） */
function getSubKeyErrorMessage(error: string | undefined): string {
  switch (error) {
    case ErrorCode.SUBKEY_INVALID:
      return 'Sub-Key 無效或已停用';
    case 'daily_limit_exceeded':
      return '已達每日使用上限';
    case 'rate_limit_exceeded':
      return '已達每小時速率限制';
    case 'service_not_allowed':
      return '此 Sub-Key 不允許使用該服務';
    case 'model_not_allowed':
      return '此 Sub-Key 不允許使用該模型';
    default:
      return 'Sub-Key 驗證失敗';
  }
}

// ===== 模組導出 =====

export default EngineAuth;
