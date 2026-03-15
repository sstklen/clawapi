// 互動式輸入工具
// 提供 CLI 互動式問答所需的 prompt 函式
// 使用 Bun 原生 readline 機制

import * as readline from 'node:readline';
import { color, print, blank } from './output';
import { t } from './i18n';

// ===== 型別定義 =====

/** 選項型別（供 select 使用） */
export interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

// ===== readline 介面 =====

/** 建立 readline 介面 */
function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// ===== 基礎 prompt =====

/**
 * 詢問使用者輸入一行文字
 * @param question 問題文字
 * @param defaultValue 預設值（Enter 直接採用）
 */
export async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createRL();
  const defaultHint = defaultValue ? ` ${color.dim(`(${defaultValue})`)}` : '';

  return new Promise<string>((resolve) => {
    rl.question(`${color.cyan('?')} ${question}${defaultHint}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || '');
    });
  });
}

/**
 * 詢問密碼型輸入（不回顯）
 * @param question 問題文字
 */
export async function password(question: string): Promise<string> {
  const rl = createRL();

  // 關閉回顯
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
  }

  return new Promise<string>((resolve) => {
    let input = '';

    process.stdout.write(`${color.cyan('?')} ${question}: `);

    const onData = (char: Buffer) => {
      const c = char.toString();

      if (c === '\n' || c === '\r') {
        // Enter → 結束
        process.stdout.write('\n');
        if (process.stdin.isTTY) {
          process.stdin.setRawMode?.(false);
        }
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve(input);
      } else if (c === '\x7f' || c === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (c === '\x03') {
        // Ctrl+C
        process.stdout.write('\n');
        if (process.stdin.isTTY) {
          process.stdin.setRawMode?.(false);
        }
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve('');
      } else {
        input += c;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

// ===== 確認 =====

/**
 * 是否確認（y/n）
 * @param question 問題文字
 * @param defaultYes 預設為 yes？
 */
export async function confirm(question: string, defaultYes: boolean = false): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(`${question} (${hint})`);
  if (answer === '') return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

// ===== 選單 =====

/**
 * 選擇一個選項
 * @param question 問題文字
 * @param options 選項列表
 */
export async function select(question: string, options: SelectOption[]): Promise<string> {
  print(`${color.cyan('?')} ${question}`);
  blank();

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const idx = color.cyan(`  ${i + 1}.`);
    const desc = opt.description ? ` ${color.dim(`- ${opt.description}`)}` : '';
    print(`${idx} ${opt.label}${desc}`);
  }

  blank();

  while (true) {
    const answer = await ask(t('prompt.enter_number'));
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= options.length) {
      return options[num - 1]!.value;
    }
    print(color.red(`  ${t('prompt.invalid_range', { max: options.length })}`));
  }
}

// ===== 多選 =====

/**
 * 選擇多個選項（用逗號分隔）
 * @param question 問題文字
 * @param options 選項列表
 */
export async function multiSelect(question: string, options: SelectOption[]): Promise<string[]> {
  print(`${color.cyan('?')} ${question}`);
  blank();

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const idx = color.cyan(`  ${i + 1}.`);
    const desc = opt.description ? ` ${color.dim(`- ${opt.description}`)}` : '';
    print(`${idx} ${opt.label}${desc}`);
  }

  blank();

  const answer = await ask(t('prompt.enter_numbers'));
  const nums = answer.split(',').map(s => parseInt(s.trim(), 10));
  const selected: string[] = [];

  for (const num of nums) {
    if (num >= 1 && num <= options.length) {
      selected.push(options[num - 1]!.value);
    }
  }

  return selected;
}

export default { ask, password, confirm, select, multiSelect };
