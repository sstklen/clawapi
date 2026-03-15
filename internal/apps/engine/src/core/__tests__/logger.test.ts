// logger.test.ts — Logger 模組測試

import { describe, it, expect, beforeEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { Logger } from '../logger';

// ===== 輔助函式 =====

function createLogger(): { logger: Logger; tmpDir: string; logPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-logger-test-'));
  const logger = new Logger(tmpDir);
  const logPath = join(tmpDir, 'logs', 'clawapi.log');
  return { logger, tmpDir, logPath };
}

function readLogLines(logPath: string): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理錯誤
  }
}

// ===== 測試套件 =====

describe('Logger — 基本輸出', () => {
  it('info 應寫入 JSON Lines 到日誌檔', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('測試訊息');
      const lines = readLogLines(logPath);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const entry = lines[lines.length - 1];
      expect(entry.level).toBe('info');
      expect(entry.msg).toBe('測試訊息');
      expect(typeof entry.ts).toBe('string');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('debug 應輸出 debug 等級', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.debug('除錯訊息', { component: 'database' });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.level).toBe('debug');
      expect(last.msg).toBe('除錯訊息');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('warn 應輸出 warn 等級', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.warn('警告訊息');
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.level).toBe('warn');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('error 應輸出 error 等級', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.error('錯誤訊息', { code: 'DB_ERROR' });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.level).toBe('error');
      expect(last.msg).toBe('錯誤訊息');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('時間戳應為 ISO 8601 格式', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('時間戳測試');
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(typeof last.ts).toBe('string');
      // ISO 8601 格式驗證
      const ts = last.ts as string;
      expect(new Date(ts).toISOString()).toBe(ts);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('應自動建立 logs 目錄', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('建立目錄測試');
      expect(existsSync(logPath)).toBe(true);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('附加 data 參數應合併到日誌 entry', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('帶資料的訊息', { service: 'groq', latency: 180 });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.service).toBe('groq');
      expect(last.latency).toBe(180);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe('Logger — 敏感資料遮罩', () => {
  it('key_encrypted 欄位應被遮罩為 [REDACTED]', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('key 操作', { key_encrypted: 'SECRET_KEY_VALUE_12345' });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.key_encrypted).toBe('[REDACTED]');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('device_token 欄位應被遮罩', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('裝置認證', { device_token: 'dtoken_abcdef1234' });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.device_token).toBe('[REDACTED]');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('auth_token 欄位應被遮罩', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.warn('認證', { auth_token: 'bearer_token_xyz' });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.auth_token).toBe('[REDACTED]');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('master_key 欄位應被遮罩', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.debug('master key info', { master_key: 'hex_encoded_key_32bytes' });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.master_key).toBe('[REDACTED]');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('private_key 欄位應被遮罩', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.debug('keypair', { private_key: 'pkcs8_private_key_base64' });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.private_key).toBe('[REDACTED]');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('非敏感欄位不應被遮罩', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('一般資訊', {
        service: 'groq',
        latency_ms: 200,
        success: true,
      });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      expect(last.service).toBe('groq');
      expect(last.latency_ms).toBe(200);
      expect(last.success).toBe(true);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('巢狀物件中的敏感欄位也應被遮罩', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('巢狀測試', {
        auth: {
          auth_token: 'Bearer secret_token',
          user_id: 'user123',
        },
      });
      const lines = readLogLines(logPath);
      const last = lines[lines.length - 1];
      const auth = last.auth as Record<string, unknown>;
      expect(auth.auth_token).toBe('[REDACTED]');
      expect(auth.user_id).toBe('user123');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('多筆日誌應依序寫入同一檔案', () => {
    const { logger, tmpDir, logPath } = createLogger();
    try {
      logger.info('第一筆');
      logger.info('第二筆');
      logger.info('第三筆');
      const lines = readLogLines(logPath);
      expect(lines.length).toBe(3);
      expect(lines[0].msg).toBe('第一筆');
      expect(lines[1].msg).toBe('第二筆');
      expect(lines[2].msg).toBe('第三筆');
    } finally {
      cleanupDir(tmpDir);
    }
  });
});
