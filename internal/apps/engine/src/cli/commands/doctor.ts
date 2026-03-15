// doctor 命令 — 診斷工具（6+2 項檢查）
// 1. DB 可寫
// 2. master.key 存在
// 3. VPS 可達
// 4. Adapter 完整
// 5. Key 健康
// 6. port 可用
// 7. config.yaml 存在
// 8. MCP 可用（--mcp 旗標時才跑，需要 ~15 秒）

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, accessSync, constants } from 'node:fs';
import { color, print, blank, success, error, info, warn, check, jsonOutput, isJsonMode } from '../utils/output';
import { t } from '../utils/i18n';
import { getEngineVersion } from '../utils/version';
import type { ParsedArgs } from '../index';

// ===== 型別 =====

interface CheckResult {
  name: string;
  pass: boolean;
  warn?: boolean;  // 警告狀態：pass=true 但需要注意（黃色 WARN）
  detail: string;
}

// ===== 主命令 =====

export async function doctorCommand(args: ParsedArgs): Promise<void> {
  const results: CheckResult[] = [];

  const configDir = join(homedir(), '.clawapi');

  // 1. DB 可寫
  results.push(await checkDbWritable(configDir));

  // 2. master.key 存在
  results.push(checkMasterKey(configDir));

  // 3. VPS 可達
  results.push(await checkVpsReachable());

  // 4. Adapter 完整
  results.push(checkAdapters());

  // 5. Key 健康
  results.push(checkKeyHealth(configDir));

  // 6. port 可用
  results.push(await checkPortAvailable());

  // 7. config.yaml 存在
  results.push(checkConfigFile(configDir));

  // 8. MCP 可用（只在 --mcp 旗標時檢查）
  if (args.flags['mcp'] === true) {
    results.push(await checkMcpReady());
  }

  // 輸出結果
  const totalWarn = results.filter(r => r.warn).length;
  const totalPass = results.filter(r => r.pass && !r.warn).length;
  const totalFail = results.filter(r => !r.pass).length;

  if (isJsonMode()) {
    jsonOutput({
      results,
      summary: { total: results.length, pass: totalPass, warn: totalWarn, fail: totalFail },
    });
    return;
  }

  blank();
  print(color.bold(`🦞 ClawAPI v${getEngineVersion()} — ${t('cmd.doctor.title')}`));
  blank();

  for (const r of results) {
    check(r.pass, r.name, r.detail, r.warn);
  }

  blank();

  if (totalFail === 0 && totalWarn === 0) {
    success(t('cmd.doctor.all_passed', { count: results.length }));
  } else if (totalFail === 0) {
    // 有警告但沒有失敗 → 整體通過，但提示注意
    warn(`${totalPass} passed, ${totalWarn} warning(s)`);
  } else {
    error(t('cmd.doctor.some_failed', { fail: totalFail, pass: totalPass }));
  }

  blank();
}

// ===== 個別檢查 =====

/** 1. DB 可寫 */
async function checkDbWritable(configDir: string): Promise<CheckResult> {
  const dbPath = join(configDir, 'data.db');

  if (!existsSync(configDir)) {
    return { name: t('cmd.doctor.check_db'), pass: false, detail: t('cmd.doctor.dir_not_found', { path: configDir }) };
  }

  if (existsSync(dbPath)) {
    try {
      accessSync(dbPath, constants.R_OK | constants.W_OK);
      return { name: t('cmd.doctor.check_db'), pass: true, detail: dbPath };
    } catch {
      return { name: t('cmd.doctor.check_db'), pass: false, detail: t('cmd.doctor.no_rw_permission') };
    }
  }

  // DB 不存在但目錄可寫也算通過（首次啟動會自動建立）
  try {
    accessSync(configDir, constants.W_OK);
    return { name: t('cmd.doctor.check_db'), pass: true, detail: t('cmd.doctor.db_not_created') };
  } catch {
    return { name: t('cmd.doctor.check_db'), pass: false, detail: t('cmd.doctor.no_write_permission') };
  }
}

/** 2. master.key 存在 */
function checkMasterKey(configDir: string): CheckResult {
  const keyPath = join(configDir, 'master.key');

  if (existsSync(keyPath)) {
    return { name: t('cmd.doctor.check_master_key'), pass: true, detail: keyPath };
  }

  // 首次安裝還沒啟動過，master.key 尚未產生是正常的
  // 用 WARN 而非 FAIL，避免嚇到新使用者
  return {
    name: t('cmd.doctor.check_master_key'),
    pass: true,
    warn: true,
    detail: t('cmd.doctor.master_key_not_created'),
  };
}

/** 3. VPS 可達 */
async function checkVpsReachable(): Promise<CheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch('https://clawapi.washinmura.jp/health', {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      // 顯示 VPS 用途，讓用戶知道這個連線做什麼
      return { name: t('cmd.doctor.check_vps'), pass: true, detail: t('cmd.doctor.vps_ok') };
    }
    return { name: t('cmd.doctor.check_vps'), pass: false, detail: `HTTP ${response.status}` };
  } catch (err) {
    return { name: t('cmd.doctor.check_vps'), pass: false, detail: t('cmd.doctor.vps_unreachable') };
  }
}

/** 4. Adapter 完整 */
function checkAdapters(): CheckResult {
  // 檢查內建 adapter YAML 定義是否存在
  const requiredAdapters = ['openai', 'anthropic', 'groq', 'gemini', 'deepseek', 'ollama'];
  // Adapter YAML 檔案在 adapters/schemas/ 目錄
  // doctor.ts 在 cli/commands/ → 要往上兩層到 src/adapters/schemas/
  const schemaDir = join(import.meta.dir, '..', '..', 'adapters', 'schemas');

  if (!existsSync(schemaDir)) {
    return { name: t('cmd.doctor.check_adapters'), pass: false, detail: t('cmd.doctor.adapter_dir_missing', { path: schemaDir }) };
  }

  const missing: string[] = [];
  for (const name of requiredAdapters) {
    const yamlPath = join(schemaDir, `${name}.yaml`);
    if (!existsSync(yamlPath)) {
      missing.push(name);
    }
  }

  if (missing.length === 0) {
    return { name: t('cmd.doctor.check_adapters'), pass: true, detail: t('cmd.doctor.adapters_ready', { count: requiredAdapters.length }) };
  }

  return {
    name: t('cmd.doctor.check_adapters'),
    pass: false,
    detail: t('cmd.doctor.adapters_missing', { list: missing.join(', ') }),
  };
}

/** 5. Key 健康 */
function checkKeyHealth(configDir: string): CheckResult {
  const dbPath = join(configDir, 'data.db');

  if (!existsSync(dbPath)) {
    return { name: t('cmd.doctor.check_keys'), pass: true, detail: t('cmd.doctor.no_keys_yet') };
  }

  // 嘗試讀 DB 查詢 Key 數量（輕量檢查，不啟動引擎）
  try {
    const { Database } = require('bun:sqlite');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT COUNT(*) as cnt FROM keys WHERE status = ?').all('active') as Array<{ cnt: number }>;
    const count = rows[0]?.cnt ?? 0;
    db.close();

    if (count === 0) {
      return { name: t('cmd.doctor.check_keys'), pass: true, detail: t('cmd.doctor.no_keys_yet') };
    }
    return { name: t('cmd.doctor.check_keys'), pass: true, detail: t('cmd.doctor.keys_count', { count }) };
  } catch {
    // DB 讀不了就顯示需要引擎
    return { name: t('cmd.doctor.check_keys'), pass: true, detail: t('cmd.doctor.keys_need_engine') };
  }
}

/** 6. port 可用（獨立模式用，MCP 模式不需要） */
async function checkPortAvailable(): Promise<CheckResult> {
  const defaultPort = 4141;

  try {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: defaultPort,
      socket: {
        data() {},
      },
    });
    server.stop(true);
    return { name: t('cmd.doctor.check_port'), pass: true, detail: `port ${defaultPort}` };
  } catch {
    // port 佔用不是致命問題 — MCP 模式（主要用法）不需要 port
    // 只在 clawapi start（獨立 HTTP 模式）才需要
    return {
      name: t('cmd.doctor.check_port'),
      pass: true,
      warn: true,
      detail: t('cmd.doctor.port_in_use_warn', { port: defaultPort }),
    };
  }
}

/** 7. config.yaml 存在且可讀 */
function checkConfigFile(configDir: string): CheckResult {
  const configPath = join(configDir, 'config.yaml');
  const name = t('cmd.doctor.check_config');

  if (!existsSync(configDir)) {
    return {
      name,
      pass: false,
      detail: t('cmd.doctor.dir_not_found', { path: configDir }),
    };
  }

  if (!existsSync(configPath)) {
    return {
      name,
      pass: false,
      detail: t('cmd.doctor.config_not_created'),
    };
  }

  try {
    accessSync(configPath, constants.R_OK);
    return { name, pass: true, detail: configPath };
  } catch {
    return { name, pass: false, detail: t('cmd.doctor.no_rw_permission') };
  }
}

/** 8. MCP stdio 回應測試 */
async function checkMcpReady(): Promise<CheckResult> {
  try {
    // 找到 CLI 入口路徑（用來啟動 MCP 子程序測試）
    const cliPath = join(import.meta.dir, '..', 'index.ts');

    if (!existsSync(cliPath)) {
      return { name: 'MCP Server', pass: false, detail: 'CLI 入口不存在' };
    }

    // 啟動 MCP 子程序，送 initialize 請求，等回應
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'clawapi-doctor', version: getEngineVersion() },
      },
    }) + '\n';

    const proc = Bun.spawn(['bun', 'run', cliPath, 'mcp'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // 寫入 initialize 請求
    proc.stdin.write(initRequest);
    proc.stdin.end();

    // 等回應（最多 15 秒，因為引擎初始化需要時間）
    const timeout = setTimeout(() => proc.kill(), 15000);

    const output = await new Response(proc.stdout).text();
    clearTimeout(timeout);
    proc.kill();

    if (output.includes('"protocolVersion"')) {
      return { name: 'MCP Server', pass: true, detail: 'stdio 回應正常（JSON-RPC OK）' };
    }

    if (output.length === 0) {
      return { name: 'MCP Server', pass: false, detail: 'MCP 無回應（可能初始化失敗）' };
    }

    return { name: 'MCP Server', pass: false, detail: `意外回應：${output.slice(0, 100)}` };
  } catch (err) {
    return { name: 'MCP Server', pass: false, detail: `測試失敗：${(err as Error).message}` };
  }
}

export default doctorCommand;
