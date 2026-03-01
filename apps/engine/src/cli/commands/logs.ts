// logs 命令 — 查看最近日誌
// 支援旗標：--service, --export csv

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { color, print, blank, error, info, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

// ===== 型別 =====

interface LogEntry {
  ts: string;
  level: string;
  msg: string;
  service?: string;
  [key: string]: unknown;
}

// ===== 主命令 =====

export async function logsCommand(args: ParsedArgs): Promise<void> {
  const serviceFilter = args.flags['service'] as string | undefined;
  const exportFormat = args.flags['export'] as string | undefined;
  const limitStr = args.flags['n'] as string | undefined;
  const limit = limitStr ? parseInt(String(limitStr), 10) : 50;

  // 讀取日誌檔
  const logPath = join(homedir(), '.clawapi', 'logs', 'clawapi.log');

  if (!existsSync(logPath)) {
    output(
      () => {
        blank();
        info(t('cmd.logs.not_found'));
        print(`  ${t('cmd.config.expected_path')}${logPath}`);
        blank();
      },
      { entries: [], message: t('cmd.logs.not_found') }
    );
    return;
  }

  // 讀取並解析（JSONL 格式）
  let entries: LogEntry[] = [];
  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    entries = lines.map(line => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        return { ts: '', level: 'unknown', msg: line };
      }
    });
  } catch (err) {
    error(t('cmd.logs.read_failed', { error: String(err) }));
    process.exit(1);
  }

  // 過濾
  if (serviceFilter) {
    entries = entries.filter(e => e.service === serviceFilter);
  }

  // 取最後 N 筆
  entries = entries.slice(-limit);

  // CSV 匯出
  if (exportFormat === 'csv') {
    const csvHeader = 'timestamp,level,message,service';
    const csvRows = entries.map(e =>
      `"${e.ts}","${e.level}","${e.msg.replace(/"/g, '""')}","${e.service ?? ''}"`
    );
    console.log([csvHeader, ...csvRows].join('\n'));
    return;
  }

  // JSON 輸出
  if (isJsonMode()) {
    jsonOutput({ entries, total: entries.length });
    return;
  }

  // 文字輸出
  blank();
  info(t('cmd.logs.recent', { count: entries.length }) + (serviceFilter ? ` (${serviceFilter})` : ''));
  blank();

  if (entries.length === 0) {
    print(`  ${t('cmd.logs.no_records')}`);
    blank();
    return;
  }

  for (const entry of entries) {
    const levelColor = getLevelColor(entry.level);
    const ts = entry.ts ? color.dim(entry.ts.slice(11, 19)) : '';
    print(`  ${ts} ${levelColor(entry.level.toUpperCase().padEnd(5))} ${entry.msg}`);
  }

  blank();
}

// ===== 工具 =====

function getLevelColor(level: string): (text: string) => string {
  switch (level) {
    case 'error': return color.red;
    case 'warn': return color.yellow;
    case 'info': return color.cyan;
    case 'debug': return color.gray;
    default: return color.white;
  }
}

export default logsCommand;
