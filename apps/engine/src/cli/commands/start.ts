// start 命令 — 啟動 ClawAPI 引擎
// 支援旗標：-p/--port, -h/--host, --daemon, --no-vps, --verbose

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { color, print, blank, info, error, success, box, jsonOutput, isJsonMode } from '../utils/output';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

// ===== 型別定義 =====

interface StartOptions {
  port?: number;
  host?: string;
  daemon?: boolean;
  noVps?: boolean;
  verbose?: boolean;
}

// ===== PID 檔案管理 =====

/** PID 檔案路徑 */
function pidPath(): string {
  return join(homedir(), '.clawapi', 'engine.pid');
}

/** 寫入 PID 檔案 */
export function writePid(pid: number): void {
  const dir = join(homedir(), '.clawapi');
  if (!existsSync(dir)) {
    const { mkdirSync } = require('node:fs');
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(pidPath(), String(pid), 'utf8');
}

/** 讀取 PID 檔案 */
export function readPid(): number | null {
  const path = pidPath();
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8').trim();
  const pid = parseInt(content, 10);
  return isNaN(pid) ? null : pid;
}

/** 檢查 PID 是否活著 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 刪除 PID 檔案 */
export function removePid(): void {
  const path = pidPath();
  if (existsSync(path)) {
    const { unlinkSync } = require('node:fs');
    unlinkSync(path);
  }
}

// ===== 解析旗標 =====

function parseStartOptions(args: ParsedArgs): StartOptions {
  const options: StartOptions = {};

  // -p / --port
  const portVal = args.flags['p'] ?? args.flags['port'];
  if (portVal !== undefined) {
    const parsed = parseInt(String(portVal), 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
      options.port = parsed;
    } else {
      throw new Error(t('cmd.start.port_invalid', { value: String(portVal) }));
    }
  }

  // -h / --host
  const hostVal = args.flags['h'] ?? args.flags['host'];
  if (hostVal !== undefined) {
    options.host = String(hostVal);
  }

  // --daemon
  if (args.flags['daemon'] !== undefined) {
    options.daemon = true;
  }

  // --no-vps
  if (args.flags['no-vps'] !== undefined) {
    options.noVps = true;
  }

  // --verbose
  if (args.flags['verbose'] !== undefined) {
    options.verbose = true;
  }

  return options;
}

// ===== 啟動流程 =====

export async function startCommand(args: ParsedArgs): Promise<void> {
  const options = parseStartOptions(args);

  // 檢查是否已在運行
  const existingPid = readPid();
  if (existingPid !== null && isPidAlive(existingPid)) {
    if (isJsonMode()) {
      jsonOutput({ error: 'already_running', pid: existingPid });
      process.exit(1);
    }
    error(t('cmd.start.already_running', { pid: String(existingPid) }));
    info(t('cmd.start.use_stop'));
    process.exit(1);
  }

  // daemon 模式
  if (options.daemon) {
    await startDaemon(options);
    return;
  }

  // 前台啟動
  await startForeground(options);
}

/** 前台啟動流程 — 真正初始化所有組件並啟動 HTTP Server */
async function startForeground(options: StartOptions): Promise<void> {
  const configDir = join(homedir(), '.clawapi');
  const port = options.port ?? 4141;
  const host = options.host ?? '127.0.0.1';

  if (isJsonMode()) {
    jsonOutput({
      status: 'starting',
      port,
      host,
      version: CLAWAPI_VERSION,
      pid: process.pid,
      vps: !options.noVps,
    });
  }

  // 顯示啟動橫幅
  if (!isJsonMode()) {
    blank();
    box([
      `ClawAPI Engine v${CLAWAPI_VERSION}`,
      t('cmd.start.starting'),
    ], 'ClawAPI');
    blank();
  }

  // 呼叫真正的引擎啟動流程（初始化所有組件 + 啟動 Bun.serve）
  // 路徑：cli/commands/start.ts → ../../index.ts（引擎入口）
  const engineModule = await import('../../index');
  const start = engineModule.start;
  const stop = engineModule.stop;

  try {
    if (!isJsonMode()) {
      print(`${color.cyan('[1/3]')} ${t('cmd.start.init_components')}`);
    }

    const server = await start({
      port,
      host,
      dataDir: configDir,
      noVps: options.noVps,
      verbose: options.verbose,
    });

    // 寫入 PID
    writePid(process.pid);

    if (!isJsonMode()) {
      print(`${color.cyan('[2/3]')} ${t('cmd.start.http_started')}`);
      print(`${color.cyan('[3/3]')} ${t('cmd.start.engine_ready')}`);
      blank();
      success(t('cmd.start.complete'));
      print(`  ${t('cmd.start.address')}${color.bold(`http://${host}:${port}`)}`);
      print(`  ${t('cmd.start.pid')}${process.pid}`);
      print(`  ${t('cmd.start.mode')}${options.noVps ? t('cmd.start.offline') : t('cmd.start.online')}`);
      blank();
      print(t('cmd.start.ctrl_c'));
      blank();
    }

    if (isJsonMode()) {
      jsonOutput({
        status: 'running',
        port,
        host,
        pid: process.pid,
        vps: !options.noVps,
      });
    }

    // 註冊優雅關機
    const shutdown = async () => {
      if (!isJsonMode()) {
        blank();
        print(color.yellow(t('cmd.start.shutdown_signal')));
      }
      await stop();
      removePid();
      if (!isJsonMode()) {
        success(t('cmd.start.shutdown_complete'));
      }
      process.exit(0);
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

  } catch (err) {
    removePid();
    if (isJsonMode()) {
      jsonOutput({ status: 'error', error: String(err) });
    } else {
      error(t('cmd.start.failed', { error: String(err) }));
    }
    process.exit(1);
  }
}

/** Daemon 模式啟動 */
async function startDaemon(options: StartOptions): Promise<void> {
  const { spawn } = await import('node:child_process');
  const args: string[] = ['start'];
  if (options.port) args.push('--port', String(options.port));
  if (options.host) args.push('--host', options.host);
  if (options.noVps) args.push('--no-vps');
  if (options.verbose) args.push('--verbose');

  const child = spawn(process.execPath, [process.argv[1]!, ...args], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  if (isJsonMode()) {
    jsonOutput({ status: 'daemon_started', pid: child.pid });
    return;
  }

  success(t('cmd.start.daemon_started', { pid: String(child.pid) }));
  info(t('cmd.start.use_status'));
}

export default startCommand;
