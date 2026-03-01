// Config 解析器模組
// 負責讀取、合併、驗證 ClawAPI 引擎設定
// 優先順序：CLI 參數 > config.yaml > 環境變數 > 預設值

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { CLAWAPI_VERSION } from '@clawapi/protocol';

// ===== 型別定義 =====

export interface ClawConfig {
  server: {
    port: number;
    host: string;
    auto_port: boolean;
  };
  routing: {
    default_strategy: 'fast' | 'smart' | 'cheap';
    failover_enabled: boolean;
    max_retries_per_key: number;
    timeout: {
      l1: number;
      l2: number;
      l3: number;
      l4_step: number;
      l4_total: number;
    };
  };
  gold_key: {
    reserve_percent: number;
    default_model: string | null;
    prompt: { l3: string | null; l4: string | null };
  };
  telemetry: {
    enabled: boolean;
    upload_interval_ms: number;
    max_pending_days: number;
  };
  l0: {
    enabled: boolean;
    ollama_auto_detect: boolean;
    ollama_url: string;
  };
  aid: {
    enabled: boolean;
    allowed_services: string[] | null;
    daily_limit: number;
    blackout_hours: number[];
  };
  vps: {
    enabled: boolean;
    base_url: string;
    websocket_url: string;
  };
  ui: {
    theme: 'light' | 'dark' | 'system';
    locale: 'zh-TW' | 'en' | 'ja';
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    retention_days: number;
  };
  backup: {
    auto_interval_hours: number | null;
  };
  notifications: {
    key_dead: boolean;
    quota_low: boolean;
    key_expiring: boolean;
    service_degraded: boolean;
  };
  advanced: {
    db_path: string | null;
    adapter_dirs: (string | null)[];
    max_keys_per_service: number;
    user_agent: string;
  };
}

/** loadConfig 接受的選項（對應 CLI 參數）*/
export interface LoadConfigOptions {
  /** 指定設定檔路徑，預設 ~/.clawapi/config.yaml */
  configPath?: string;
  /** CLI 覆蓋值（深度合併到最終設定） */
  overrides?: DeepPartial<ClawConfig>;
}

/** 遞迴 Partial 輔助型別 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ===== 預設值 =====

/**
 * 回傳所有欄位的預設值
 */
export function getDefaultConfig(): ClawConfig {
  return {
    server: {
      port: 4141,
      host: '127.0.0.1',
      auto_port: true,
    },
    routing: {
      default_strategy: 'smart',
      failover_enabled: true,
      max_retries_per_key: 1,
      timeout: {
        l1: 30000,
        l2: 30000,
        l3: 60000,
        l4_step: 60000,
        l4_total: 300000,
      },
    },
    gold_key: {
      reserve_percent: 5,
      default_model: null,
      prompt: { l3: null, l4: null },
    },
    telemetry: {
      enabled: true,
      upload_interval_ms: 3600000,
      max_pending_days: 30,
    },
    l0: {
      enabled: true,
      ollama_auto_detect: true,
      ollama_url: 'http://localhost:11434',
    },
    aid: {
      enabled: false,
      allowed_services: null,
      daily_limit: 50,
      blackout_hours: [],
    },
    vps: {
      enabled: true,
      base_url: 'https://api.clawapi.com',
      websocket_url: 'wss://api.clawapi.com/v1/ws',
    },
    ui: {
      theme: 'system',
      locale: 'zh-TW',
    },
    logging: {
      level: 'info',
      retention_days: 30,
    },
    backup: {
      auto_interval_hours: null,
    },
    notifications: {
      key_dead: true,
      quota_low: true,
      key_expiring: true,
      service_degraded: true,
    },
    advanced: {
      db_path: null,
      adapter_dirs: [null],
      max_keys_per_service: 5,
      user_agent: `ClawAPI/${CLAWAPI_VERSION}`,
    },
  };
}

// ===== 深度合併 =====

/**
 * 深度合併兩個物件
 * 後者（overrides）的值會覆蓋前者（base）的值
 * 若兩者都是純物件，則遞迴合併
 */
function deepMerge<T extends object>(base: T, overrides: DeepPartial<T>): T {
  const result = { ...base } as T;

  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const overrideVal = overrides[key];
    if (overrideVal === undefined) continue;

    const baseVal = base[key];

    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      // 兩者都是純物件 → 遞迴合併
      result[key] = deepMerge(
        baseVal as object,
        overrideVal as DeepPartial<object>
      ) as T[keyof T];
    } else {
      // 其他情況直接覆蓋
      result[key] = overrideVal as T[keyof T];
    }
  }

  return result;
}

// ===== 環境變數映射 =====

/**
 * 從環境變數讀取設定並回傳 partial config
 * 支援的環境變數（CLAWAPI_ 前綴）：
 * - CLAWAPI_PORT → server.port
 * - CLAWAPI_HOST → server.host
 * - CLAWAPI_LOG_LEVEL → logging.level
 * - CLAWAPI_LOCALE → ui.locale
 */
function readEnvConfig(): DeepPartial<ClawConfig> {
  const partial: DeepPartial<ClawConfig> = {};

  const port = process.env['CLAWAPI_PORT'];
  if (port !== undefined) {
    const parsed = parseInt(port, 10);
    if (!isNaN(parsed)) {
      partial.server = { ...(partial.server ?? {}), port: parsed };
    }
  }

  const host = process.env['CLAWAPI_HOST'];
  if (host !== undefined) {
    partial.server = { ...(partial.server ?? {}), host };
  }

  const logLevel = process.env['CLAWAPI_LOG_LEVEL'];
  if (logLevel !== undefined) {
    partial.logging = {
      ...(partial.logging ?? {}),
      level: logLevel as ClawConfig['logging']['level'],
    };
  }

  const locale = process.env['CLAWAPI_LOCALE'];
  if (locale !== undefined) {
    partial.ui = {
      ...(partial.ui ?? {}),
      locale: locale as ClawConfig['ui']['locale'],
    };
  }

  return partial;
}

// ===== 驗證 =====

/**
 * 驗證最終設定值的合法性
 * 不合法時拋出包含欄位名稱、實際值、期望值的錯誤
 */
function validateConfig(config: ClawConfig): void {
  // 驗證 server.port
  const port = config.server.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `設定驗證失敗：server.port 的值 ${port} 不合法，應為 1-65535 的整數`
    );
  }

  // 驗證 routing.default_strategy
  const validStrategies = ['fast', 'smart', 'cheap'] as const;
  if (!validStrategies.includes(config.routing.default_strategy as typeof validStrategies[number])) {
    throw new Error(
      `設定驗證失敗：routing.default_strategy 的值 "${config.routing.default_strategy}" 不合法，應為 'fast' | 'smart' | 'cheap'`
    );
  }

  // 驗證所有 timeout 值 > 0
  const timeouts: [string, number][] = [
    ['routing.timeout.l1', config.routing.timeout.l1],
    ['routing.timeout.l2', config.routing.timeout.l2],
    ['routing.timeout.l3', config.routing.timeout.l3],
    ['routing.timeout.l4_step', config.routing.timeout.l4_step],
    ['routing.timeout.l4_total', config.routing.timeout.l4_total],
  ];
  for (const [field, val] of timeouts) {
    if (typeof val !== 'number' || val <= 0) {
      throw new Error(
        `設定驗證失敗：${field} 的值 ${val} 不合法，應為大於 0 的數字`
      );
    }
  }

  // 驗證 ui.locale
  const validLocales = ['zh-TW', 'en', 'ja'] as const;
  if (!validLocales.includes(config.ui.locale as typeof validLocales[number])) {
    throw new Error(
      `設定驗證失敗：ui.locale 的值 "${config.ui.locale}" 不合法，應為 'zh-TW' | 'en' | 'ja'`
    );
  }

  // 驗證 ui.theme
  const validThemes = ['light', 'dark', 'system'] as const;
  if (!validThemes.includes(config.ui.theme as typeof validThemes[number])) {
    throw new Error(
      `設定驗證失敗：ui.theme 的值 "${config.ui.theme}" 不合法，應為 'light' | 'dark' | 'system'`
    );
  }

  // 驗證 logging.level
  const validLevels = ['debug', 'info', 'warn', 'error'] as const;
  if (!validLevels.includes(config.logging.level as typeof validLevels[number])) {
    throw new Error(
      `設定驗證失敗：logging.level 的值 "${config.logging.level}" 不合法，應為 'debug' | 'info' | 'warn' | 'error'`
    );
  }
}

// ===== auto_port 機制 =====

/**
 * 檢測指定 port 是否可用
 * 用 Bun.listen 嘗試綁定，成功後立刻關閉
 * @returns true 表示可用，false 表示被占用
 */
async function isPortAvailable(port: number, host: string): Promise<boolean> {
  try {
    const server = Bun.listen({
      hostname: host,
      port,
      socket: {
        data() {},
      },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * 尋找可用 port
 * 若指定 port 被占用，自動嘗試 port+1 到 port+10
 * 超過 10 次仍無法取得 → 拋出錯誤
 */
export async function findAvailablePort(
  startPort: number,
  host: string
): Promise<number> {
  const maxAttempts = 10;

  for (let i = 0; i <= maxAttempts; i++) {
    const candidate = startPort + i;
    if (candidate > 65535) {
      throw new Error(
        `auto_port：嘗試 ${maxAttempts + 1} 個 port 後仍無法取得可用 port（起點：${startPort}）`
      );
    }

    const available = await isPortAvailable(candidate, host);
    if (available) {
      return candidate;
    }
  }

  throw new Error(
    `auto_port：嘗試 ${maxAttempts + 1} 個 port 後仍無法取得可用 port（起點：${startPort}）`
  );
}

// ===== 主函式 =====

/**
 * 載入並合併設定
 *
 * 優先順序（高到低）：
 * 1. options.overrides（CLI 參數）
 * 2. config.yaml
 * 3. 環境變數（CLAWAPI_*）
 * 4. getDefaultConfig() 預設值
 *
 * @param options 選用設定
 * @returns 合併且驗證過的完整 ClawConfig
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ClawConfig> {
  const { configPath, overrides } = options;

  // 第 1 層：預設值
  let config: ClawConfig = getDefaultConfig();

  // 第 2 層：環境變數
  const envConfig = readEnvConfig();
  config = deepMerge(config, envConfig);

  // 第 3 層：config.yaml
  const yamlPath = configPath ?? join(homedir(), '.clawapi', 'config.yaml');
  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf8');
      const parsed = yaml.load(raw) as DeepPartial<ClawConfig> | null;
      if (parsed && typeof parsed === 'object') {
        config = deepMerge(config, parsed);
      }
    } catch (err) {
      throw new Error(`無法解析設定檔 ${yamlPath}：${(err as Error).message}`);
    }
  }

  // 第 4 層：CLI overrides
  if (overrides) {
    config = deepMerge(config, overrides);
  }

  // 驗證
  validateConfig(config);

  return config;
}
