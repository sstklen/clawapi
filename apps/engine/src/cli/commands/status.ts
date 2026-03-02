// status 命令 — 查看引擎狀態

import { readPid, isPidAlive } from './start';
import { getEngineVersion } from '../../version';
import { color, print, blank, box, jsonOutput, isJsonMode } from '../utils/output';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

export async function statusCommand(_args: ParsedArgs): Promise<void> {
  const pid = readPid();
  const running = pid !== null && isPidAlive(pid);

  if (isJsonMode()) {
    jsonOutput({
      running,
      pid: running ? pid : null,
      version: getEngineVersion(),
    });
    return;
  }

  blank();

  if (running) {
    box([
      `${t('cmd.status.label_status')}${color.boldGreen(t('cmd.status.running'))}`,
      `${t('cmd.status.label_pid')}${pid}`,
      `${t('cmd.status.label_version')}${getEngineVersion()}`,
    ], t('cmd.status.title'));
  } else {
    box([
      `${t('cmd.status.label_status')}${color.boldRed(t('cmd.status.stopped'))}`,
      `${t('cmd.status.label_version')}${getEngineVersion()}`,
    ], t('cmd.status.title'));
    blank();
    print(t('cmd.status.use_start'));
  }

  blank();
}

export default statusCommand;
