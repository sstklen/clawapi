// claw-key 命令群組 — Claw Key 管理
// 子命令：set, show, remove

import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, password, confirm, select } from '../utils/prompt';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function clawKeyCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'set':
      return clawKeySet(args);
    case 'show':
      return clawKeyShow(args);
    case 'remove':
      return clawKeyRemove(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['set', 'show', 'remove'] });
        process.exit(1);
      }
      error(t('common.unknown_subcmd', { subcmd: sub ?? t('common.none') }));
      print(t('common.available_subcmds', { list: 'set, show, remove' }));
      process.exit(1);
  }
}

// ===== claw-key set =====

async function clawKeySet(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.claw_key.set_title'));
  print(t('cmd.claw_key.set_desc'));
  blank();

  // 選擇服務
  const service = await select(t('cmd.claw_key.select_service'), [
    { label: 'OpenAI', value: 'openai', description: t('cmd.claw_key.rec_gpt4o') },
    { label: 'Anthropic', value: 'anthropic', description: t('cmd.claw_key.rec_opus') },
    { label: 'Google AI', value: 'google', description: 'Gemini Pro' },
    { label: t('cmd.keys.other_label'), value: 'other' },
  ]);

  const finalService = service === 'other'
    ? await ask(t('common.enter_service_id'))
    : service;

  // 輸入 Key
  const keyValue = await password(t('cmd.claw_key.paste_key'));
  if (!keyValue) {
    error(t('common.api_key_empty'));
    process.exit(1);
  }

  // 選擇預設模型
  const model = await ask(t('cmd.claw_key.default_model_prompt'));

  // 設定 reserve_percent
  const reserveStr = await ask(t('cmd.claw_key.reserve_pct_prompt'), '5');
  const reservePercent = parseInt(reserveStr, 10) || 5;

  output(
    () => {
      blank();
      success(t('cmd.claw_key.set_done'));
      print(t('cmd.claw_key.service_label', { service: finalService }));
      print(t('cmd.claw_key.key_label', { key: maskKey(keyValue) }));
      if (model) print(t('cmd.claw_key.model_label', { model }));
      print(t('cmd.claw_key.reserve_label', { pct: reservePercent }));
    },
    {
      status: 'set',
      service_id: finalService,
      key_masked: maskKey(keyValue),
      default_model: model || null,
      reserve_percent: reservePercent,
    }
  );
}

// ===== claw-key show =====

async function clawKeyShow(_args: ParsedArgs): Promise<void> {
  // 模擬顯示（實際從 config 讀取）
  const clawKey = {
    configured: true,
    service_id: 'openai',
    key_masked: 'sk-...AbCd',
    default_model: 'gpt-4o',
    reserve_percent: 5,
  };

  output(
    () => {
      blank();
      if (clawKey.configured) {
        info(t('cmd.claw_key.show_title'));
        print(t('cmd.claw_key.service_label', { service: clawKey.service_id }));
        print(t('cmd.claw_key.key_label', { key: clawKey.key_masked }));
        print(t('cmd.claw_key.model_label', { model: clawKey.default_model ?? t('cmd.claw_key.model_auto') }));
        print(t('cmd.claw_key.reserve_label', { pct: clawKey.reserve_percent }));
      } else {
        warn(t('cmd.claw_key.not_configured'));
        print(`  ${t('cmd.claw_key.use_set_cmd', { cmd: color.cyan('clawapi claw-key set') })}`);
      }
      blank();
    },
    clawKey
  );
}

// ===== claw-key remove =====

async function clawKeyRemove(_args: ParsedArgs): Promise<void> {
  const confirmed = await confirm(t('cmd.claw_key.confirm_remove'));
  if (!confirmed) {
    info(t('common.cancelled'));
    return;
  }

  output(
    () => success(t('cmd.claw_key.removed')),
    { status: 'removed' }
  );
}

// ===== 工具 =====

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export default clawKeyCommand;
