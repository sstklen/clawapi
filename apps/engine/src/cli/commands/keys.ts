// keys 命令群組 — Key 管理
// 子命令：add, list, remove, pin, rotate, import, check

import { color, print, blank, success, error, info, warn, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, select, password, confirm } from '../utils/prompt';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

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

  // 模擬資料（實際實作會從 KeyPool 取）
  const mockKeys = [
    {
      id: 1,
      service_id: 'groq',
      key_masked: 'gsk_...Xm4Q',
      pool_type: 'king',
      label: '主要',
      status: 'active',
      daily_used: 12,
      pinned: false,
    },
  ];

  if (isJsonMode()) {
    jsonOutput({ keys: mockKeys });
    return;
  }

  blank();
  info(serviceFilter
    ? t('cmd.keys.list_title_filtered', { service: serviceFilter })
    : t('cmd.keys.list_title'));
  blank();

  if (mockKeys.length === 0) {
    print(t('cmd.keys.no_keys'));
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
    mockKeys
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

  // 模擬檢查結果
  const results = [
    { service_id: 'groq', key_masked: 'gsk_...Xm4Q', status: 'active', latency_ms: 120 },
  ];

  output(
    () => {
      for (const r of results) {
        const statusIcon = r.status === 'active'
          ? color.green('OK')
          : color.red('FAIL');
        print(`  ${statusIcon}  ${r.service_id}  ${r.key_masked}  ${r.latency_ms}ms`);
      }
      blank();
      success(t('cmd.keys.check_done', { count: results.length }));
    },
    { keys: results }
  );
}

// ===== 工具 =====

/** 遮罩 Key 值 */
function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export default keysCommand;
