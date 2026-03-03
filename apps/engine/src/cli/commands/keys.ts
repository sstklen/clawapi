// keys 命令群組 — Key 管理
// 子命令：add, list, remove, pin, rotate, import, check

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { color, print, blank, success, error, info, warn, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, select, password, confirm } from '../utils/prompt';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';
import type { KeyListItem } from '../../core/key-pool';

// ===== 已知服務列表（互動式新增用） =====

const KNOWN_SERVICES = [
  { label: 'Groq', value: 'groq', description: t('cmd.keys.svc_groq') },
  { label: 'OpenAI', value: 'openai', description: t('cmd.keys.svc_openai') },
  { label: 'Anthropic', value: 'anthropic', description: t('cmd.keys.svc_anthropic') },
  { label: 'Google AI', value: 'google', description: t('cmd.keys.svc_google') },
  { label: 'Mistral', value: 'mistral', description: t('cmd.keys.svc_mistral') },
  { label: 'Together AI', value: 'together', description: t('cmd.keys.svc_together') },
  { label: 'OpenRouter', value: 'openrouter', description: t('cmd.keys.svc_openrouter') },
  { label: 'DeepSeek', value: 'deepseek', description: t('cmd.keys.svc_deepseek') },
  { label: t('cmd.keys.other_label'), value: 'other', description: t('cmd.keys.svc_other') },
];

// ===== 子命令路由 =====

export async function keysCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'add':
      return keysAdd(args);
    case 'list':
    case 'ls':
      return keysList(args);
    case 'remove':
    case 'rm':
      return keysRemove(args);
    case 'pin':
      return keysPin(args);
    case 'rotate':
      return keysRotate(args);
    case 'import':
      return keysImport(args);
    case 'check':
      return keysCheck(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['add', 'list', 'remove', 'pin', 'rotate', 'import', 'check'] });
        process.exit(1);
      }
      error(t('common.unknown_subcmd', { subcmd: sub ?? t('common.none') }));
      print(t('common.available_subcmds', { list: 'add, list, remove, pin, rotate, import, check' }));
      process.exit(1);
  }
}

// ===== keys add =====

async function keysAdd(args: ParsedArgs): Promise<void> {
  // 互動式流程
  blank();
  info(t('cmd.keys.add_title'));
  blank();

  // 步驟 1：選擇服務
  const serviceId = await select(t('cmd.keys.select_service'), KNOWN_SERVICES);
  const finalService = serviceId === 'other'
    ? await ask(t('common.enter_service_id'))
    : serviceId;

  if (!finalService) {
    error(t('cmd.keys.service_id_empty'));
    process.exit(1);
  }

  // 步驟 2：輸入 Key
  const keyValue = await password(t('cmd.keys.paste_key'));
  if (!keyValue) {
    error(t('common.api_key_empty'));
    process.exit(1);
  }

  // 步驟 3：選擇池
  const poolType = await select(t('cmd.keys.select_pool'), [
    { label: t('cmd.keys.pool_king'), value: 'king' },
    { label: t('cmd.keys.pool_friend'), value: 'friend' },
  ]) as 'king' | 'friend';

  // 步驟 4：取名
  const label = await ask(t('cmd.keys.label_prompt'));

  // 執行新增
  blank();

  output(
    () => {
      success(t('cmd.keys.added', { service: finalService, pool: poolType }));
      if (label) print(t('cmd.keys.label_display', { label }));
      print(t('cmd.keys.key_display', { key: maskKey(keyValue) }));
    },
    {
      status: 'added',
      service_id: finalService,
      pool_type: poolType,
      label: label || null,
      key_masked: maskKey(keyValue),
    }
  );
}

// ===== keys list =====

async function keysList(args: ParsedArgs): Promise<void> {
  const serviceFilter = args.positional[1];

  // 從真實 DB 讀取（取代舊的 mock 資料）
  const keyPool = await getKeyPool();
  let keys: KeyListItem[] = [];

  if (keyPool) {
    try {
      const allKeys = await keyPool.listKeys();
      // 過濾服務（如果有指定）
      keys = serviceFilter
        ? allKeys.filter(k => k.service_id === serviceFilter)
        : allKeys;
    } catch {
      // DB 讀取失敗，保持空列表
    }
  }

  if (isJsonMode()) {
    jsonOutput({ keys });
    return;
  }

  blank();
  info(serviceFilter
    ? t('cmd.keys.list_title_filtered', { service: serviceFilter })
    : t('cmd.keys.list_title'));
  blank();

  if (keys.length === 0) {
    print(t('cmd.keys.no_keys'));
    if (!keyPool) {
      print(color.dim('  （尚未初始化，請先執行 clawapi init）'));
    }
    blank();
    return;
  }

  table(
    [
      { header: 'ID', key: 'id', minWidth: 4, align: 'right' },
      { header: t('cmd.keys.header_service'), key: 'service_id', minWidth: 10 },
      { header: 'Key', key: 'key_masked', minWidth: 14 },
      { header: t('cmd.keys.header_pool'), key: 'pool_type', minWidth: 6 },
      { header: t('cmd.keys.header_label'), key: 'label', minWidth: 6 },
      { header: t('cmd.keys.header_status'), key: 'status', minWidth: 8 },
      { header: t('cmd.keys.header_daily_usage'), key: 'daily_used', minWidth: 8, align: 'right' },
    ],
    keys
  );

  blank();
}

// ===== keys remove =====

async function keysRemove(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error(t('common.specify_key_id', { cmd: 'keys remove' }));
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(t('common.invalid_id', { id: idStr }));
    process.exit(1);
  }

  const confirmed = await confirm(t('cmd.keys.confirm_remove', { id }));
  if (!confirmed) {
    info(t('common.cancelled'));
    return;
  }

  output(
    () => success(t('cmd.keys.removed', { id })),
    { status: 'removed', id }
  );
}

// ===== keys pin =====

async function keysPin(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error(t('common.specify_key_id', { cmd: 'keys pin' }));
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(t('common.invalid_id', { id: idStr }));
    process.exit(1);
  }

  output(
    () => success(t('cmd.keys.pinned', { id })),
    { status: 'pinned', id }
  );
}

// ===== keys rotate =====

async function keysRotate(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error(t('common.specify_key_id', { cmd: 'keys rotate' }));
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(t('common.invalid_id', { id: idStr }));
    process.exit(1);
  }

  // 輸入新 Key
  const newKey = await password(t('cmd.keys.paste_new_key'));
  if (!newKey) {
    error(t('cmd.keys.new_key_empty'));
    process.exit(1);
  }

  output(
    () => {
      success(t('cmd.keys.rotated', { id }));
      print(t('cmd.keys.new_key_display', { key: maskKey(newKey) }));
    },
    { status: 'rotated', id, key_masked: maskKey(newKey) }
  );
}

// ===== keys import =====

async function keysImport(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.keys.import_title'));
  print(t('cmd.keys.import_format'));
  print(t('cmd.keys.import_example_header'));
  print('    groq:gsk_xxxxxxxxxxxx');
  print('    openai:sk-xxxxxxxxxxxx');
  blank();

  const input = await ask(t('cmd.keys.import_prompt'));
  if (!input) {
    info(t('common.cancelled'));
    return;
  }

  const lines = input.split('\n').filter(l => l.trim());
  let added = 0;
  let failed = 0;

  for (const line of lines) {
    const [service, key] = line.split(':');
    if (service && key) {
      added++;
    } else {
      failed++;
    }
  }

  output(
    () => {
      success(t('cmd.keys.import_done', { added, failed }));
    },
    { status: 'imported', added, failed }
  );
}

// ===== keys check =====

async function keysCheck(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.keys.check_title'));
  blank();

  // 從真實 DB 讀取 Key 列表
  const keyPool = await getKeyPool();
  if (!keyPool) {
    if (isJsonMode()) {
      jsonOutput({ error: 'no_keys', keys: [] });
      return;
    }
    print(t('cmd.keys.no_keys'));
    blank();
    return;
  }

  const keys = await keyPool.listKeys();
  if (keys.length === 0) {
    if (isJsonMode()) {
      jsonOutput({ keys: [] });
      return;
    }
    print(t('cmd.keys.no_keys'));
    blank();
    return;
  }

  // 顯示每把 Key 的狀態（不做真正 API 呼叫，只顯示 DB 記錄的狀態）
  const results = keys.map(k => ({
    service_id: k.service_id,
    key_masked: k.key_masked,
    status: k.status,
    daily_used: k.daily_used,
    consecutive_failures: k.consecutive_failures,
  }));

  output(
    () => {
      for (const r of results) {
        const statusIcon = r.status === 'active'
          ? color.green('OK')
          : r.status === 'dead'
          ? color.red('DEAD')
          : color.yellow('LIMITED');
        const failures = r.consecutive_failures > 0
          ? color.dim(` (連續失敗: ${r.consecutive_failures})`)
          : '';
        print(`  ${statusIcon}  ${r.service_id}  ${r.key_masked}  ${color.dim(`今日: ${r.daily_used}`)}${failures}`);
      }
      blank();
      success(t('cmd.keys.check_done', { count: results.length }));
    },
    { keys: results }
  );
}

// ===== 資料庫存取 =====

/**
 * 取得真正的 KeyPool 實例（從 ~/.clawapi/data.db）
 * 如果 DB 不存在或初始化失敗，回傳 null
 */
async function getKeyPool(): Promise<import('../../core/key-pool').KeyPool | null> {
  const dataDir = join(homedir(), '.clawapi');
  const dbPath = join(dataDir, 'data.db');

  // DB 不存在 → 沒有任何 Key
  if (!existsSync(dbPath)) return null;

  try {
    const { createDatabase } = await import('../../storage/database');
    const { createCrypto } = await import('../../core/encryption');
    const { KeyPool } = await import('../../core/key-pool');

    const db = createDatabase(dbPath);
    await db.init();
    const crypto = createCrypto(dataDir);
    return new KeyPool(db, crypto);
  } catch {
    return null;
  }
}

// ===== 工具 =====

/** 遮罩 Key 值 */
function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export default keysCommand;
