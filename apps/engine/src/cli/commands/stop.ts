// stop 命令 — 停止 ClawAPI 引擎

import { readPid, isPidAlive, removePid } from './start';
import { success, error, info, jsonOutput, isJsonMode } from '../utils/output';
import type { ParsedArgs } from '../index';

export async function stopCommand(_args: ParsedArgs): Promise<void> {
  const pid = readPid();

  // 沒有 PID 檔案
  if (pid === null) {
    if (isJsonMode()) {
      jsonOutput({ error: 'not_running', message: '引擎未在運行' });
      process.exit(1);
    }
    error('引擎未在運行（找不到 PID 檔案）');
    return;
  }

  // PID 不存活
  if (!isPidAlive(pid)) {
    removePid();
    if (isJsonMode()) {
      jsonOutput({ error: 'not_running', message: '引擎 process 已不存在，已清除 PID 檔案' });
      return;
    }
    info('引擎 process 已不存在，已清除 PID 檔案');
    return;
  }

  // 送出 SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (isJsonMode()) {
      jsonOutput({ error: 'kill_failed', message: String(err) });
      process.exit(1);
    }
    error(`無法停止引擎 (PID: ${pid}): ${err}`);
    return;
  }

  // 等待 process 結束（最多 5 秒）
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      removePid();
      if (isJsonMode()) {
        jsonOutput({ status: 'stopped', pid });
        return;
      }
      success(`引擎已停止 (PID: ${pid})`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // 超時 → 強制 SIGKILL
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 忽略
  }
  removePid();

  if (isJsonMode()) {
    jsonOutput({ status: 'killed', pid, message: '優雅關機超時，已強制終止' });
    return;
  }
  success(`引擎已強制終止 (PID: ${pid})`);
}

export default stopCommand;
