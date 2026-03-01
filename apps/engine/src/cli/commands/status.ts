// status 命令 — 查看引擎狀態

import { readPid, isPidAlive } from './start';
import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { color, print, blank, box, jsonOutput, isJsonMode } from '../utils/output';
import type { ParsedArgs } from '../index';

export async function statusCommand(_args: ParsedArgs): Promise<void> {
  const pid = readPid();
  const running = pid !== null && isPidAlive(pid);

  if (isJsonMode()) {
    jsonOutput({
      running,
      pid: running ? pid : null,
      version: CLAWAPI_VERSION,
    });
    return;
  }

  blank();

  if (running) {
    box([
      `狀態：${color.boldGreen('運行中')}`,
      `PID：${pid}`,
      `版本：${CLAWAPI_VERSION}`,
    ], 'ClawAPI 引擎狀態');
  } else {
    box([
      `狀態：${color.boldRed('已停止')}`,
      `版本：${CLAWAPI_VERSION}`,
    ], 'ClawAPI 引擎狀態');
    blank();
    print(`使用 ${color.cyan('clawapi start')} 啟動引擎`);
  }

  blank();
}

export default statusCommand;
