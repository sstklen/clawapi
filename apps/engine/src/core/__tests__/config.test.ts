// Config 解析器測試
// 測試 getDefaultConfig、loadConfig、驗證、深度合併等功能
// 使用臨時目錄，不污染真實的 ~/.clawapi/

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDefaultConfig, loadConfig } from '../config';

// ===== 測試用臨時目錄 =====

let tempDir: string;

beforeEach(() => {
  // 每個測試前建立唯一的臨時目錄
  tempDir = join(tmpdir(), `clawapi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  // 清理臨時目錄
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失敗
  }
});

// ===== 輔助函式 =====

/** 在臨時目錄寫入 YAML 設定檔 */
function writeYaml(content: string): string {
  const path = join(tempDir, 'config.yaml');
  writeFileSync(path, content, 'utf8');
  return path;
}

// ===== 測試案例 =====

describe('getDefaultConfig()', () => {
  it('應回傳完整的預設設定物件，包含所有 12 個區塊', () => {
    const config = getDefaultConfig();

    // 驗證 12 個區塊都存在
    expect(config.server).toBeDefined();
    expect(config.routing).toBeDefined();
    expect(config.claw_key).toBeDefined();
    expect(config.telemetry).toBeDefined();
    expect(config.l0).toBeDefined();
    expect(config.aid).toBeDefined();
    expect(config.vps).toBeDefined();
    expect(config.ui).toBeDefined();
    expect(config.logging).toBeDefined();
    expect(config.backup).toBeDefined();
    expect(config.notifications).toBeDefined();
    expect(config.advanced).toBeDefined();
  });

  it('server 區塊預設值應正確', () => {
    const config = getDefaultConfig();
    expect(config.server.port).toBe(4141);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.auto_port).toBe(true);
  });

  it('routing 區塊預設值應正確', () => {
    const config = getDefaultConfig();
    expect(config.routing.default_strategy).toBe('smart');
    expect(config.routing.failover_enabled).toBe(true);
    expect(config.routing.max_retries_per_key).toBe(1);
    expect(config.routing.timeout.l1).toBe(30000);
    expect(config.routing.timeout.l2).toBe(30000);
    expect(config.routing.timeout.l3).toBe(60000);
    expect(config.routing.timeout.l4_step).toBe(60000);
    expect(config.routing.timeout.l4_total).toBe(300000);
  });

  it('aid.enabled 預設應為 false', () => {
    const config = getDefaultConfig();
    expect(config.aid.enabled).toBe(false);
    expect(config.aid.daily_limit).toBe(50);
    expect(config.aid.blackout_hours).toEqual([]);
    expect(config.aid.allowed_services).toBeNull();
  });

  it('backup.auto_interval_hours 預設應為 null', () => {
    const config = getDefaultConfig();
    expect(config.backup.auto_interval_hours).toBeNull();
  });
});

describe('loadConfig() — 無 YAML 檔案', () => {
  it('不存在的設定檔路徑 → 使用全部預設值', async () => {
    const config = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
    });

    expect(config.server.port).toBe(4141);
    expect(config.routing.default_strategy).toBe('smart');
    expect(config.ui.locale).toBe('zh-TW');
  });
});

describe('loadConfig() — YAML 合併', () => {
  it('有 YAML 設定檔時應正確合併', async () => {
    const yamlPath = writeYaml(`
server:
  port: 8080
logging:
  level: debug
`);

    const config = await loadConfig({ configPath: yamlPath });

    // YAML 覆蓋的值
    expect(config.server.port).toBe(8080);
    expect(config.logging.level).toBe('debug');

    // 其他值保留預設
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.routing.default_strategy).toBe('smart');
  });

  it('YAML 只設定部分欄位，其餘應保留預設值', async () => {
    const yamlPath = writeYaml(`
ui:
  locale: en
`);

    const config = await loadConfig({ configPath: yamlPath });

    expect(config.ui.locale).toBe('en');
    // 其餘 ui 欄位保留預設
    expect(config.ui.theme).toBe('system');
    // routing 完全不受影響
    expect(config.routing.timeout.l1).toBe(30000);
  });
});

describe('loadConfig() — CLI overrides 優先順序', () => {
  it('CLI overrides 應覆蓋 YAML 設定值', async () => {
    const yamlPath = writeYaml(`
server:
  port: 8080
  host: '0.0.0.0'
`);

    const config = await loadConfig({
      configPath: yamlPath,
      overrides: {
        server: { port: 9000 },
      },
    });

    // CLI 覆蓋 YAML
    expect(config.server.port).toBe(9000);
    // YAML 值保留（CLI 沒有覆蓋 host）
    expect(config.server.host).toBe('0.0.0.0');
  });

  it('CLI > YAML > env > default 的完整優先順序', async () => {
    const yamlPath = writeYaml(`
server:
  port: 5050
`);

    // CLI 給 6060 → 應贏過 yaml 的 5050
    const config = await loadConfig({
      configPath: yamlPath,
      overrides: {
        server: { port: 6060 },
      },
    });

    expect(config.server.port).toBe(6060);
  });
});

describe('loadConfig() — 環境變數映射', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // 還原環境變數
    for (const key of ['CLAWAPI_PORT', 'CLAWAPI_HOST', 'CLAWAPI_LOG_LEVEL', 'CLAWAPI_LOCALE']) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('CLAWAPI_PORT=5000 → server.port 應為 5000', async () => {
    process.env['CLAWAPI_PORT'] = '5000';

    const config = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
    });

    expect(config.server.port).toBe(5000);
  });

  it('CLAWAPI_HOST → server.host', async () => {
    process.env['CLAWAPI_HOST'] = '0.0.0.0';

    const config = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
    });

    expect(config.server.host).toBe('0.0.0.0');
  });

  it('CLAWAPI_LOG_LEVEL → logging.level', async () => {
    process.env['CLAWAPI_LOG_LEVEL'] = 'debug';

    const config = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
    });

    expect(config.logging.level).toBe('debug');
  });

  it('CLAWAPI_LOCALE → ui.locale', async () => {
    process.env['CLAWAPI_LOCALE'] = 'en';

    const config = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
    });

    expect(config.ui.locale).toBe('en');
  });

  it('CLI overrides 應覆蓋環境變數', async () => {
    process.env['CLAWAPI_PORT'] = '5000';

    const config = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
      overrides: { server: { port: 7777 } },
    });

    // CLI 7777 > env 5000
    expect(config.server.port).toBe(7777);
  });
});

describe('loadConfig() — 驗證', () => {
  it('port=-1 → 應拋出錯誤', async () => {
    const yamlPath = writeYaml(`
server:
  port: -1
`);

    await expect(loadConfig({ configPath: yamlPath })).rejects.toThrow('server.port');
  });

  it('port=0 → 應拋出錯誤', async () => {
    await expect(
      loadConfig({
        configPath: join(tempDir, 'nonexistent.yaml'),
        overrides: { server: { port: 0 } },
      })
    ).rejects.toThrow('server.port');
  });

  it('port=65536 → 應拋出錯誤', async () => {
    await expect(
      loadConfig({
        configPath: join(tempDir, 'nonexistent.yaml'),
        overrides: { server: { port: 65536 } },
      })
    ).rejects.toThrow('server.port');
  });

  it("strategy='invalid' → 應拋出錯誤，並說明期望值", async () => {
    const yamlPath = writeYaml(`
routing:
  default_strategy: invalid
`);

    await expect(loadConfig({ configPath: yamlPath })).rejects.toThrow(
      'routing.default_strategy'
    );
  });

  it('port=1 和 port=65535 是合法邊界值', async () => {
    const config1 = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
      overrides: { server: { port: 1 } },
    });
    expect(config1.server.port).toBe(1);

    const config2 = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
      overrides: { server: { port: 65535 } },
    });
    expect(config2.server.port).toBe(65535);
  });
});

describe('深度合併行為', () => {
  it('只改 routing.timeout.l1 不應影響其他 timeout 值', async () => {
    const yamlPath = writeYaml(`
routing:
  timeout:
    l1: 99999
`);

    const config = await loadConfig({ configPath: yamlPath });

    // 只有 l1 被改變
    expect(config.routing.timeout.l1).toBe(99999);
    // 其餘保留預設
    expect(config.routing.timeout.l2).toBe(30000);
    expect(config.routing.timeout.l3).toBe(60000);
    expect(config.routing.timeout.l4_step).toBe(60000);
    expect(config.routing.timeout.l4_total).toBe(300000);
  });

  it('改 routing.timeout.l1 不應影響 routing 其他欄位', async () => {
    const yamlPath = writeYaml(`
routing:
  timeout:
    l1: 5000
`);

    const config = await loadConfig({ configPath: yamlPath });

    expect(config.routing.default_strategy).toBe('smart');
    expect(config.routing.failover_enabled).toBe(true);
    expect(config.routing.max_retries_per_key).toBe(1);
  });

  it('CLI overrides 深度合併：只覆蓋指定欄位', async () => {
    const config = await loadConfig({
      configPath: join(tempDir, 'nonexistent.yaml'),
      overrides: {
        notifications: {
          key_dead: false,
        },
      },
    });

    // 只有 key_dead 被改
    expect(config.notifications.key_dead).toBe(false);
    // 其餘保留預設
    expect(config.notifications.quota_low).toBe(true);
    expect(config.notifications.key_expiring).toBe(true);
    expect(config.notifications.service_degraded).toBe(true);
  });
});
