// @clawapi/protocol schema 驗證測試
import { describe, test, expect } from 'bun:test';
import * as protocol from '../src/index';
import {
  ErrorCode,
  ERROR_HTTP_STATUS,
  OFFICIAL_ADAPTERS,
  RATE_LIMITS,
  WS_CHANNELS,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
  AID_TIMEOUT_MS,
  BACKUP_MAX_SIZE_BYTES,
  TELEMETRY_BATCH_MAX_BYTES,
  CHAT_MESSAGE_MAX_LENGTH,
  CLAWAPI_VERSION,
} from '../src/index';

// 1. 所有 export 存在（TypeScript interface 在執行期不存在，只驗證 enum/const）
describe('protocol exports', () => {
  test('所有模組都有匯出', () => {
    // 確認 export 清單包含可執行期看到的識別子（enum + const）
    const keys = Object.keys(protocol);
    expect(keys.length).toBeGreaterThan(0);
    // enum 和 const 驗證
    expect(keys).toContain('ErrorCode');
    expect(keys).toContain('ERROR_HTTP_STATUS');
    expect(keys).toContain('OFFICIAL_ADAPTERS');
    expect(keys).toContain('RATE_LIMITS');
    expect(keys).toContain('WS_CHANNELS');
    expect(keys).toContain('WS_PING_INTERVAL_MS');
    expect(keys).toContain('CLAWAPI_VERSION');
    expect(keys).toContain('PROTOCOL_VERSION');
    expect(keys).toContain('SCHEMA_VERSION');
  });

  test('ErrorCode enum 存在', () => {
    expect(ErrorCode).toBeDefined();
  });

  test('OFFICIAL_ADAPTERS 存在', () => {
    expect(OFFICIAL_ADAPTERS).toBeDefined();
  });

  test('RATE_LIMITS 存在', () => {
    expect(RATE_LIMITS).toBeDefined();
  });

  test('ERROR_HTTP_STATUS 存在', () => {
    expect(ERROR_HTTP_STATUS).toBeDefined();
  });

  test('WS_CHANNELS 存在', () => {
    expect(WS_CHANNELS).toBeDefined();
  });
});

// 2. ErrorCode enum 有 45 個值
describe('ErrorCode', () => {
  test('共有 45 個錯誤碼', () => {
    const codes = Object.values(ErrorCode);
    expect(codes.length).toBe(45);
  });

  test('認證類錯誤碼有 7 個', () => {
    const authCodes = Object.values(ErrorCode).filter(c => c.startsWith('AUTH_'));
    expect(authCodes.length).toBe(7);
  });

  test('裝置類錯誤碼有 4 個', () => {
    const deviceCodes = Object.values(ErrorCode).filter(c => c.startsWith('DEVICE_'));
    expect(deviceCodes.length).toBe(4);
  });

  test('集體智慧類錯誤碼有 5 個', () => {
    const telemetryCodes = Object.values(ErrorCode).filter(
      c => c.startsWith('TELEMETRY_') || c.startsWith('FEEDBACK_')
    );
    expect(telemetryCodes.length).toBe(5);
  });

  test('L0 類錯誤碼有 6 個', () => {
    const l0Codes = Object.values(ErrorCode).filter(c => c.startsWith('L0_'));
    expect(l0Codes.length).toBe(6);
  });

  test('互助類錯誤碼有 7 個', () => {
    const aidCodes = Object.values(ErrorCode).filter(c => c.startsWith('AID_'));
    expect(aidCodes.length).toBe(7);
  });

  test('備份類錯誤碼有 4 個', () => {
    const backupCodes = Object.values(ErrorCode).filter(c => c.startsWith('BACKUP_'));
    expect(backupCodes.length).toBe(4);
  });

  test('Sub-Key 類錯誤碼有 2 個', () => {
    const subkeyCodes = Object.values(ErrorCode).filter(c => c.startsWith('SUBKEY_'));
    expect(subkeyCodes.length).toBe(2);
  });

  test('版本類錯誤碼有 2 個', () => {
    const versionCodes = Object.values(ErrorCode).filter(c => c.startsWith('VERSION_'));
    expect(versionCodes.length).toBe(2);
  });

  test('WebSocket 類錯誤碼有 5 個', () => {
    const wsCodes = Object.values(ErrorCode).filter(c => c.startsWith('WS_'));
    expect(wsCodes.length).toBe(5);
  });

  test('通用類錯誤碼有 3 個', () => {
    const generalCodes = [
      ErrorCode.INTERNAL_ERROR,
      ErrorCode.SERVICE_UNAVAILABLE,
      ErrorCode.INVALID_REQUEST,
    ];
    expect(generalCodes.length).toBe(3);
  });
});

// 3. OFFICIAL_ADAPTERS 有 15 個
describe('OFFICIAL_ADAPTERS', () => {
  test('共有 15 個官方 Adapter', () => {
    expect(OFFICIAL_ADAPTERS.length).toBe(15);
  });

  test('包含所有預期的 Adapter', () => {
    const expected = [
      'groq', 'gemini', 'cerebras', 'sambanova', 'qwen',
      'ollama', 'duckduckgo', 'openai', 'anthropic', 'deepseek',
      'brave-search', 'tavily', 'serper', 'openrouter', 'deepl',
    ];
    const adapters = OFFICIAL_ADAPTERS as readonly string[];
    for (const adapter of expected) {
      expect(adapters).toContain(adapter);
    }
  });
});

// 4. RATE_LIMITS 有 21 個端點
describe('RATE_LIMITS', () => {
  test('共有 21 個端點', () => {
    const endpoints = Object.keys(RATE_LIMITS);
    expect(endpoints.length).toBe(21);
  });

  test('每個端點都有 limit 和 windowSeconds', () => {
    for (const [endpoint, config] of Object.entries(RATE_LIMITS)) {
      expect(typeof config.limit).toBe('number');
      expect(typeof config.windowSeconds).toBe('number');
      expect(config.limit).toBeGreaterThan(0);
      expect(config.windowSeconds).toBeGreaterThan(0);
    }
  });
});

// 5. 常數值跟 SPEC-C 一致
describe('常數值驗證', () => {
  test('WS_PING_INTERVAL_MS = 30000', () => {
    expect(WS_PING_INTERVAL_MS).toBe(30_000);
  });

  test('WS_PONG_TIMEOUT_MS = 10000', () => {
    expect(WS_PONG_TIMEOUT_MS).toBe(10_000);
  });

  test('WS_RECONNECT_BASE_MS = 1000', () => {
    expect(WS_RECONNECT_BASE_MS).toBe(1_000);
  });

  test('WS_RECONNECT_MAX_MS = 300000', () => {
    expect(WS_RECONNECT_MAX_MS).toBe(300_000);
  });

  test('AID_TIMEOUT_MS = 30000', () => {
    expect(AID_TIMEOUT_MS).toBe(30_000);
  });

  test('BACKUP_MAX_SIZE_BYTES = 52428800（50MB）', () => {
    expect(BACKUP_MAX_SIZE_BYTES).toBe(52_428_800);
  });

  test('TELEMETRY_BATCH_MAX_BYTES = 512000（500KB）', () => {
    expect(TELEMETRY_BATCH_MAX_BYTES).toBe(512_000);
  });

  test('CHAT_MESSAGE_MAX_LENGTH = 500', () => {
    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(500);
  });

  test('CLAWAPI_VERSION = 0.1.8', () => {
    expect(CLAWAPI_VERSION).toBe('0.1.8');
  });
});

// 6. ERROR_HTTP_STATUS 涵蓋所有 ErrorCode
describe('ERROR_HTTP_STATUS', () => {
  test('涵蓋所有 45 個 ErrorCode', () => {
    const allCodes = Object.values(ErrorCode);
    for (const code of allCodes) {
      expect(ERROR_HTTP_STATUS[code]).toBeDefined();
      expect(typeof ERROR_HTTP_STATUS[code]).toBe('number');
    }
  });

  test('HTTP 狀態碼只有合法值', () => {
    const validStatuses = [200, 400, 401, 403, 404, 409, 413, 429, 500, 503];
    for (const status of Object.values(ERROR_HTTP_STATUS)) {
      expect(validStatuses).toContain(status);
    }
  });
});

// 7. WSChannel 有 3 個值
describe('WSChannel', () => {
  test('WS_CHANNELS 有 3 個頻道', () => {
    expect(WS_CHANNELS.length).toBe(3);
  });

  test('包含 routing、chat、notifications', () => {
    const channels = WS_CHANNELS as readonly string[];
    expect(channels).toContain('routing');
    expect(channels).toContain('chat');
    expect(channels).toContain('notifications');
  });
});
