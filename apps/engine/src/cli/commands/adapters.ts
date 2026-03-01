// adapters 命令群組 — Adapter 管理
// 子命令：list, install, remove, update

import { color, print, blank, success, error, info, warn, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, confirm } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function adaptersCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'list':
    case 'ls':
      return adaptersList(args);
    case 'install':
      return adaptersInstall(args);
    case 'remove':
    case 'rm':
      return adaptersRemove(args);
    case 'update':
      return adaptersUpdate(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['list', 'install', 'remove', 'update'] });
        process.exit(1);
      }
      error(`未知的子命令：${sub ?? '(無)'}`);
      print('可用的子命令：list, install, remove, update');
      process.exit(1);
  }
}

// ===== adapters list =====

async function adaptersList(_args: ParsedArgs): Promise<void> {
  // 模擬 adapter 列表
  const adapters = [
    { id: 'openai', name: 'OpenAI', version: '1.0.0', type: 'built-in', status: 'active' },
    { id: 'anthropic', name: 'Anthropic', version: '1.0.0', type: 'built-in', status: 'active' },
    { id: 'groq', name: 'Groq', version: '1.0.0', type: 'built-in', status: 'active' },
    { id: 'google', name: 'Google AI', version: '1.0.0', type: 'built-in', status: 'active' },
    { id: 'mistral', name: 'Mistral', version: '1.0.0', type: 'built-in', status: 'active' },
    { id: 'ollama', name: 'Ollama', version: '1.0.0', type: 'built-in', status: 'active' },
  ];

  output(
    () => {
      blank();
      info('Adapter 列表');
      blank();

      table(
        [
          { header: 'ID', key: 'id', minWidth: 12 },
          { header: '名稱', key: 'name', minWidth: 12 },
          { header: '版本', key: 'version', minWidth: 8 },
          { header: '類型', key: 'type', minWidth: 10 },
          { header: '狀態', key: 'status', minWidth: 8 },
        ],
        adapters
      );
      blank();
    },
    { adapters }
  );
}

// ===== adapters install =====

async function adaptersInstall(args: ParsedArgs): Promise<void> {
  const url = args.positional[1];
  if (!url) {
    error('請指定 Adapter 來源 URL。用法：clawapi adapters install <url>');
    process.exit(1);
  }

  blank();
  info(`正在安裝 Adapter：${url}`);

  // 驗證 URL 格式
  try {
    new URL(url);
  } catch {
    error('無效的 URL 格式');
    process.exit(1);
  }

  // 安全確認
  warn('社群 Adapter 未經 ClawAPI 官方審核');
  const confirmed = await confirm('確定要安裝？');
  if (!confirmed) {
    info('已取消');
    return;
  }

  output(
    () => {
      blank();
      success(`Adapter 已安裝`);
      print(`  來源：${url}`);
      info('重啟引擎後生效');
    },
    { status: 'installed', url }
  );
}

// ===== adapters remove =====

async function adaptersRemove(args: ParsedArgs): Promise<void> {
  const id = args.positional[1];
  if (!id) {
    error('請指定 Adapter ID。用法：clawapi adapters remove <id>');
    process.exit(1);
  }

  // 禁止刪除內建 adapter
  const builtIn = ['openai', 'anthropic', 'groq', 'google', 'mistral', 'ollama'];
  if (builtIn.includes(id)) {
    error(`無法移除內建 Adapter：${id}`);
    process.exit(1);
  }

  const confirmed = await confirm(`確定要移除 Adapter「${id}」？`);
  if (!confirmed) {
    info('已取消');
    return;
  }

  output(
    () => success(`Adapter「${id}」已移除`),
    { status: 'removed', id }
  );
}

// ===== adapters update =====

async function adaptersUpdate(_args: ParsedArgs): Promise<void> {
  blank();
  info('檢查 Adapter 更新...');

  // 模擬更新檢查
  const updates = [
    { id: 'openai', current: '1.0.0', latest: '1.1.0' },
  ];

  output(
    () => {
      blank();
      if (updates.length === 0) {
        success('所有 Adapter 都是最新版本');
      } else {
        for (const u of updates) {
          print(`  ${u.id}: ${u.current} -> ${color.green(u.latest)}`);
        }
        blank();
        info('使用 clawapi adapters install <url> 更新指定 Adapter');
      }
      blank();
    },
    { updates }
  );
}

export default adaptersCommand;
