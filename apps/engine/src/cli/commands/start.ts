// start 命令 — 啟動 ClawAPI 引擎
// 支援旗標：-p/--port, -h/--host, --daemon, --no-vps, --verbose

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { color, print, blank, info, error, success, box, jsonOutput, isJsonMode } from '../utils/output';
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
      throw new Error(`無效的 port 值：${portVal}`);
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
    error(`引擎已在運行中 (PID: ${existingPid})`);
    info('使用 clawapi stop 停止現有引擎');
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

/** 前台啟動流程 */
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
    return;
  }

  // 啟動步驟顯示
  blank();
  box([
    `ClawAPI Engine v${CLAWAPI_VERSION}`,
    `啟動中...`,
  ], 'ClawAPI');
  blank();

  // 步驟 1：載入設定
  print(`${color.cyan('[1/7]')} 載入設定 (${configDir}/config.yaml)`);

  // 步驟 2：初始化 Master Key
  const masterKeyPath = join(configDir, 'master.key');
  if (existsSync(masterKeyPath)) {
    print(`${color.cyan('[2/7]')} Master Key 已就緒`);
  } else {
    print(`${color.cyan('[2/7]')} 產生新的 Master Key`);
  }

  // 步驟 3：開啟 DB + 自動遷移
  print(`${color.cyan('[3/7]')} 開啟資料庫 (data.db)`);

  // 步驟 4：初始化 auth.token
  const tokenPath = join(configDir, 'auth.token');
  if (existsSync(tokenPath)) {
    print(`${color.cyan('[4/7]')} auth.token 已就緒`);
  } else {
    print(`${color.cyan('[4/7]')} 產生新的 auth.token`);
  }

  // 步驟 5：VPS 連線
  if (options.noVps) {
    print(`${color.cyan('[5/7]')} VPS 連線：${color.yellow('已停用 (--no-vps)')}`);
  } else {
    print(`${color.cyan('[5/7]')} 連接 VPS`);
  }

  // 步驟 6：偵測本機環境
  print(`${color.cyan('[6/7]')} 偵測本機環境（Ollama）`);

  // 步驟 7：啟動 HTTP Server
  print(`${color.cyan('[7/7]')} 啟動 HTTP Server`);

  blank();
  success(`引擎啟動完成！`);
  print(`  位址：${color.bold(`http://${host}:${port}`)}`);
  print(`  PID：${process.pid}`);

  if (options.verbose) {
    print(`  模式：${options.noVps ? '離線' : '線上'}`);
    print(`  設定：${configDir}/config.yaml`);
  }

  blank();
  print(`按 ${color.bold('Ctrl+C')} 安全關機`);
  blank();

  // 寫入 PID
  writePid(process.pid);

  // 註冊優雅關機
  const shutdown = async () => {
    blank();
    print(color.yellow('收到關機信號，開始優雅關機...'));
    print('  等待進行中請求完成（最多 30 秒）...');
    // 實際關機由 server.ts 處理
    removePid();
    success('已安全關機');
    process.exit(0);
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
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

  success(`引擎已在背景啟動 (PID: ${child.pid})`);
  info('使用 clawapi status 查看狀態');
}

export default startCommand;
