// CLI 輸出工具
// 提供色彩、表格、JSON 格式輸出，支援 --plain 與 --json 模式
// 色彩使用 ANSI escape codes，不依賴外部套件

// ===== ANSI 色彩常數 =====

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';

// ===== 全域狀態 =====

/** 是否為純文字模式（無色彩） */
let _plain = false;
/** 是否為 JSON 輸出模式 */
let _json = false;

// ===== 初始化 =====

/** 設定輸出模式 */
export function setOutputMode(options: { plain?: boolean; json?: boolean }): void {
  if (options.plain !== undefined) _plain = options.plain;
  if (options.json !== undefined) _json = options.json;
}

/** 取得目前輸出模式 */
export function getOutputMode(): { plain: boolean; json: boolean } {
  return { plain: _plain, json: _json };
}

/** 是否為 JSON 模式 */
export function isJsonMode(): boolean {
  return _json;
}

/** 是否為 plain 模式 */
export function isPlainMode(): boolean {
  return _plain;
}

// ===== 色彩工具 =====

/** 套用 ANSI 色彩，plain 模式直接回傳原文 */
function colorize(text: string, code: string): string {
  if (_plain || _json) return text;
  return `${code}${text}${RESET}`;
}

export const color = {
  red: (text: string) => colorize(text, RED),
  green: (text: string) => colorize(text, GREEN),
  yellow: (text: string) => colorize(text, YELLOW),
  blue: (text: string) => colorize(text, BLUE),
  magenta: (text: string) => colorize(text, MAGENTA),
  cyan: (text: string) => colorize(text, CYAN),
  white: (text: string) => colorize(text, WHITE),
  gray: (text: string) => colorize(text, GRAY),
  bold: (text: string) => colorize(text, BOLD),
  dim: (text: string) => colorize(text, DIM),
  boldGreen: (text: string) => colorize(text, `${BOLD}${GREEN}`),
  boldRed: (text: string) => colorize(text, `${BOLD}${RED}`),
  boldYellow: (text: string) => colorize(text, `${BOLD}${YELLOW}`),
  boldCyan: (text: string) => colorize(text, `${BOLD}${CYAN}`),
  boldBlue: (text: string) => colorize(text, `${BOLD}${BLUE}`),
};

// ===== 輸出函式 =====

/** 印出一般訊息 */
export function print(message: string): void {
  if (_json) return;
  console.log(message);
}

/** 印出成功訊息 */
export function success(message: string): void {
  if (_json) return;
  console.log(`${color.boldGreen('V')} ${message}`);
}

/** 印出警告訊息 */
export function warn(message: string): void {
  if (_json) return;
  console.log(`${color.boldYellow('!')} ${message}`);
}

/** 印出錯誤訊息 */
export function error(message: string): void {
  if (_json) return;
  console.error(`${color.boldRed('X')} ${message}`);
}

/** 印出資訊訊息 */
export function info(message: string): void {
  if (_json) return;
  console.log(`${color.boldCyan('i')} ${message}`);
}

/** 印出空行 */
export function blank(): void {
  if (_json) return;
  console.log('');
}

// ===== JSON 輸出 =====

/** JSON 模式輸出，非 JSON 模式靜默 */
export function jsonOutput(data: unknown): void {
  if (!_json) return;
  console.log(JSON.stringify(data, null, 2));
}

/** 通用輸出：JSON 模式輸出 data，否則印出文字 */
export function output(textFn: () => void, data: unknown): void {
  if (_json) {
    jsonOutput(data);
  } else {
    textFn();
  }
}

// ===== 表格輸出 =====

/** 表格欄位定義 */
export interface TableColumn {
  /** 表頭文字 */
  header: string;
  /** 資料取值 key */
  key: string;
  /** 最小寬度 */
  minWidth?: number;
  /** 對齊方式 */
  align?: 'left' | 'right' | 'center';
}

/** 印出表格 */
export function table(columns: TableColumn[], rows: Record<string, unknown>[]): void {
  if (_json) return;

  // 計算每欄寬度
  const widths = columns.map(col => {
    const headerLen = col.header.length;
    const minW = col.minWidth ?? 0;
    const maxDataLen = rows.reduce((max, row) => {
      const val = String(row[col.key] ?? '');
      return Math.max(max, val.length);
    }, 0);
    return Math.max(headerLen, minW, maxDataLen);
  });

  // 印出表頭
  const headerLine = columns
    .map((col, i) => padCell(col.header, widths[i]!, col.align ?? 'left'))
    .join('  ');
  print(color.bold(headerLine));

  // 分隔線
  const separator = widths.map(w => '-'.repeat(w)).join('  ');
  print(color.dim(separator));

  // 印出資料列
  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const val = String(row[col.key] ?? '');
        return padCell(val, widths[i]!, col.align ?? 'left');
      })
      .join('  ');
    print(line);
  }
}

/** 補齊到指定寬度 */
function padCell(text: string, width: number, align: 'left' | 'right' | 'center'): string {
  const len = text.length;
  if (len >= width) return text;
  const diff = width - len;

  switch (align) {
    case 'right':
      return ' '.repeat(diff) + text;
    case 'center': {
      const left = Math.floor(diff / 2);
      const right = diff - left;
      return ' '.repeat(left) + text + ' '.repeat(right);
    }
    default:
      return text + ' '.repeat(diff);
  }
}

// ===== 進度顯示 =====

/** 印出步驟（帶編號） */
export function step(current: number, total: number, message: string): void {
  if (_json) return;
  print(`${color.cyan(`[${current}/${total}]`)} ${message}`);
}

/** 印出檢查結果（支援 PASS / WARN / FAIL 三種狀態） */
export function check(pass: boolean, label: string, detail?: string, isWarn?: boolean): void {
  if (_json) return;
  let icon: string;
  if (isWarn) {
    icon = color.yellow('WARN');
  } else {
    icon = pass ? color.green('PASS') : color.red('FAIL');
  }
  const suffix = detail ? ` ${color.dim(`(${detail})`)}` : '';
  print(`  ${icon}  ${label}${suffix}`);
}

// ===== 框線顯示 =====

/** 印出 box 框線訊息 */
export function box(lines: string[], title?: string): void {
  if (_json) return;

  // 找出最寬的行
  const maxLen = Math.max(
    ...(title ? [title.length + 4] : []),
    ...lines.map(l => l.length)
  );
  const width = maxLen + 4; // 左右各 2 字元邊距

  const top = title
    ? `╔══ ${title} ${'═'.repeat(Math.max(0, width - title.length - 6))}╗`
    : `╔${'═'.repeat(width - 2)}╗`;
  const bottom = `╚${'═'.repeat(width - 2)}╝`;

  print(color.cyan(top));
  for (const line of lines) {
    const padded = line + ' '.repeat(Math.max(0, width - line.length - 4));
    print(`${color.cyan('║')} ${padded} ${color.cyan('║')}`);
  }
  print(color.cyan(bottom));
}

// ===== Spinner（簡易版） =====

/** 建立一個簡易 spinner（用於非 JSON 模式） */
export function spinner(message: string): { stop: (finalMessage?: string) => void } {
  if (_json || _plain) {
    // 非互動模式直接印出
    print(message);
    return {
      stop: (finalMessage?: string) => {
        if (finalMessage) print(finalMessage);
      },
    };
  }

  const frames = ['|', '/', '-', '\\'];
  let frameIndex = 0;

  const interval = setInterval(() => {
    process.stdout.write(`\r${color.cyan(frames[frameIndex % frames.length]!)} ${message}`);
    frameIndex++;
  }, 100);

  return {
    stop: (finalMessage?: string) => {
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(message.length + 4) + '\r');
      if (finalMessage) print(finalMessage);
    },
  };
}

// ===== 匯出常數（供測試用） =====

export { RESET, BOLD, RED, GREEN, YELLOW, BLUE, CYAN, GRAY, DIM, MAGENTA, WHITE };
