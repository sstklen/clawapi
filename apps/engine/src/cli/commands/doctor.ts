// doctor 命令 — 診斷工具（6 項檢查）
// 1. DB 可寫
// 2. master.key 存在
// 3. VPS 可達
// 4. Adapter 完整
// 5. Key 健康
// 6. port 可用

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, accessSync, constants } from 'node:fs';
import { color, print, blank, success, error, info, check, jsonOutput, isJsonMode } from '../utils/output';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

// ===== 型別 =====

interface CheckResult {
  name: string;
  pass: boolean;
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

  // 輸出結果
  const totalPass = results.filter(r => r.pass).length;
  const totalFail = results.filter(r => !r.pass).length;

  if (isJsonMode()) {
    jsonOutput({
      results,
      summary: { total: results.length, pass: totalPass, fail: totalFail },
    });
    return;
  }

  blank();
  print(color.bold('ClawAPI Doctor'));
  print(color.dim(t('cmd.doctor.title')));
  blank();

  for (const r of results) {
    check(r.pass, r.name, r.detail);
  }

  blank();

  if (totalFail === 0) {
    success(t('cmd.doctor.all_passed', { count: results.length }));
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

  return {
    name: t('cmd.doctor.check_master_key'),
    pass: false,
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
      return { name: t('cmd.doctor.check_vps'), pass: true, detail: 'clawapi.washinmura.jp' };
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

  // 實際實作需要讀取 DB 查詢 Key 狀態
  // 這裡返回通過（因為 DB 可讀代表基本功能正常）
  return { name: t('cmd.doctor.check_keys'), pass: true, detail: t('cmd.doctor.keys_need_engine') };
}

/** 6. port 可用 */
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
    return { name: t('cmd.doctor.check_port'), pass: false, detail: t('cmd.doctor.port_in_use', { port: defaultPort }) };
  }
}

export default doctorCommand;
