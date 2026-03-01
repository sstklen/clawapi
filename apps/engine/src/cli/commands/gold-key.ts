// gold-key 命令群組 — 金鑰匙管理
// 子命令：set, show, remove

import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, password, confirm, select } from '../utils/prompt';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function goldKeyCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'set':
      return goldKeySet(args);
    case 'show':
      return goldKeyShow(args);
    case 'remove':
      return goldKeyRemove(args);
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

// ===== gold-key set =====

async function goldKeySet(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.gold_key.set_title'));
  print(t('cmd.gold_key.set_desc'));
  blank();

  // 選擇服務
  const service = await select(t('cmd.gold_key.select_service'), [
    { label: 'OpenAI', value: 'openai', description: t('cmd.gold_key.rec_gpt4o') },
    { label: 'Anthropic', value: 'anthropic', description: t('cmd.gold_key.rec_opus') },
    { label: 'Google AI', value: 'google', description: 'Gemini Pro' },
    { label: t('cmd.keys.other_label'), value: 'other' },
  ]);

  const finalService = service === 'other'
    ? await ask(t('common.enter_service_id'))
    : service;

  // 輸入 Key
  const keyValue = await password(t('cmd.gold_key.paste_key'));
  if (!keyValue) {
    error(t('common.api_key_empty'));
    process.exit(1);
  }

  // 選擇預設模型
  const model = await ask(t('cmd.gold_key.default_model_prompt'));

  // 設定 reserve_percent
  const reserveStr = await ask(t('cmd.gold_key.reserve_pct_prompt'), '5');
  const reservePercent = parseInt(reserveStr, 10) || 5;

  output(
    () => {
      blank();
      success(t('cmd.gold_key.set_done'));
      print(t('cmd.gold_key.service_label', { service: finalService }));
      print(t('cmd.gold_key.key_label', { key: maskKey(keyValue) }));
      if (model) print(t('cmd.gold_key.model_label', { model }));
      print(t('cmd.gold_key.reserve_label', { pct: reservePercent }));
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

// ===== gold-key show =====

async function goldKeyShow(_args: ParsedArgs): Promise<void> {
  // 模擬顯示（實際從 config 讀取）
  const goldKey = {
    configured: true,
    service_id: 'openai',
    key_masked: 'sk-...AbCd',
    default_model: 'gpt-4o',
    reserve_percent: 5,
  };

  output(
    () => {
      blank();
      if (goldKey.configured) {
        info(t('cmd.gold_key.show_title'));
        print(t('cmd.gold_key.service_label', { service: goldKey.service_id }));
        print(t('cmd.gold_key.key_label', { key: goldKey.key_masked }));
        print(t('cmd.gold_key.model_label', { model: goldKey.default_model ?? t('cmd.gold_key.model_auto') }));
        print(t('cmd.gold_key.reserve_label', { pct: goldKey.reserve_percent }));
      } else {
        warn(t('cmd.gold_key.not_configured'));
        print(`  ${t('cmd.gold_key.use_set_cmd', { cmd: color.cyan('clawapi gold-key set') })}`);
      }
      blank();
    },
    goldKey
  );
}

// ===== gold-key remove =====

async function goldKeyRemove(_args: ParsedArgs): Promise<void> {
  const confirmed = await confirm(t('cmd.gold_key.confirm_remove'));
  if (!confirmed) {
    info(t('common.cancelled'));
    return;
  }

  output(
    () => success(t('cmd.gold_key.removed')),
    { status: 'removed' }
  );
}

// ===== 工具 =====

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export default goldKeyCommand;
