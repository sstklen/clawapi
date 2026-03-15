// Logger 模組
// JSON Lines 格式輸出到 ~/.clawapi/logs/clawapi.log
// 自動遮罩敏感欄位（key_encrypted、device_token、auth_token、master_key 等）

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ===== 型別定義 =====

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export interface LoggerModule {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ===== 敏感欄位遮罩規則 =====

/**
 * 需要遮罩的欄位名稱（完整比對或子字串比對）
 * 匹配到的欄位值替換為 '[REDACTED]'
 */
const SENSITIVE_FIELD_PATTERNS = [
  /key_encrypted/i,
  /device_token/i,
  /auth_token/i,
  /master_key/i,
  /private_key/i,
  /password/i,
  /secret/i,
  /authorization/i,
];

/**
 * 遞迴遮罩物件中的敏感欄位
 */
function maskSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_FIELD_PATTERNS.some(pattern => pattern.test(key));
    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = maskSensitiveFields(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ===== Logger 類別 =====

export class Logger implements LoggerModule {
  private logPath: string;
  private logDirEnsured = false;

  constructor(dataDir?: string) {
    const baseDir = dataDir ?? join(homedir(), '.clawapi');
    this.logPath = join(baseDir, 'logs', 'clawapi.log');
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.writeLog('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.writeLog('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.writeLog('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.writeLog('error', msg, data);
  }

  // ===== 私有方法 =====

  private ensureLogDir(): void {
    if (this.logDirEnsured) return;
    const logDir = join(this.logPath, '..');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.logDirEnsured = true;
  }

  private writeLog(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>
  ): void {
    this.ensureLogDir();

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(data ? maskSensitiveFields(data) : {}),
    };

    const line = JSON.stringify(entry) + '\n';

    // 寫入檔案
    try {
      appendFileSync(this.logPath, line, 'utf8');
    } catch {
      // 檔案寫入失敗不影響主程式運作，降級到 console
      console.error('[Logger] 無法寫入日誌檔案:', this.logPath);
    }

    // 同時輸出到 console（開發用）
    const consoleFn =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'debug'
            ? console.debug
            : console.log;

    consoleFn(`[${entry.ts}] [${level.toUpperCase()}] ${msg}`, data ? maskSensitiveFields(data) : '');
  }
}

// ===== 模組導出 =====

/** 全域單例 */
let _instance: Logger | null = null;

export function getLogger(dataDir?: string): Logger {
  if (!_instance) {
    _instance = new Logger(dataDir);
  }
  return _instance;
}

export function createLogger(dataDir?: string): Logger {
  return new Logger(dataDir);
}

export default getLogger;
