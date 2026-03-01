// adapters 命令群組 — Adapter 管理
// 子命令：list, install, remove, update

import { color, print, blank, success, error, info, warn, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, confirm } from '../utils/prompt';
import { t } from '../utils/i18n';
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
      error(t('common.unknown_subcmd', { subcmd: sub ?? '(無)' }));
      print(t('common.available_subcmds', { list: 'list, install, remove, update' }));
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
      info(t('cmd.adapters.list_title'));
      blank();

      table(
        [
          { header: 'ID', key: 'id', minWidth: 12 },
          { header: t('cmd.adapters.col_name'), key: 'name', minWidth: 12 },
          { header: t('cmd.adapters.col_version'), key: 'version', minWidth: 8 },
          { header: t('cmd.adapters.col_type'), key: 'type', minWidth: 10 },
          { header: t('cmd.adapters.col_status'), key: 'status', minWidth: 8 },
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
    error(t('cmd.adapters.specify_url'));
    process.exit(1);
  }

  blank();
  info(t('cmd.adapters.installing', { url }));

  // 驗證 URL 格式
  try {
    new URL(url);
  } catch {
    error(t('cmd.adapters.invalid_url'));
    process.exit(1);
  }

  // 安全確認
  warn(t('cmd.adapters.community_warning'));
  const confirmed = await confirm(t('cmd.adapters.install_confirm'));
  if (!confirmed) {
    info(t('common.cancelled'));
    return;
  }

  output(
    () => {
      blank();
      success(t('cmd.adapters.installed'));
      print(`  ${t('cmd.adapters.source_label')}：${url}`);
      info(t('cmd.adapters.restart_required'));
    },
    { status: 'installed', url }
  );
}

// ===== adapters remove =====

async function adaptersRemove(args: ParsedArgs): Promise<void> {
  const id = args.positional[1];
  if (!id) {
    error(t('cmd.adapters.specify_id'));
    process.exit(1);
  }

  // 禁止刪除內建 adapter
  const builtIn = ['openai', 'anthropic', 'groq', 'google', 'mistral', 'ollama'];
  if (builtIn.includes(id)) {
    error(t('cmd.adapters.cannot_remove_builtin', { id }));
    process.exit(1);
  }

  const confirmed = await confirm(t('cmd.adapters.remove_confirm', { id }));
  if (!confirmed) {
    info(t('common.cancelled'));
    return;
  }

  output(
    () => success(t('cmd.adapters.removed', { id })),
    { status: 'removed', id }
  );
}

// ===== adapters update =====

async function adaptersUpdate(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.adapters.checking_updates'));

  // 模擬更新檢查
  const updates = [
    { id: 'openai', current: '1.0.0', latest: '1.1.0' },
  ];

  output(
    () => {
      blank();
      if (updates.length === 0) {
        success(t('cmd.adapters.all_up_to_date'));
      } else {
        for (const u of updates) {
          print(`  ${u.id}: ${u.current} -> ${color.green(u.latest)}`);
        }
        blank();
        info(t('cmd.adapters.update_hint'));
      }
      blank();
    },
    { updates }
  );
}

export default adaptersCommand;
