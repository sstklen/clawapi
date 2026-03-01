// CLI 測試
// 涵蓋：參數解析、輸出工具、命令路由、setup 模擬、doctor 模擬

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { parseArgs, type ParsedArgs } from '../index';
import {
  setOutputMode,
  getOutputMode,
  isJsonMode,
  isPlainMode,
  color,
  RESET,
  BOLD,
  RED,
  GREEN,
  YELLOW,
  CYAN,
} from '../utils/output';

// ===== 參數解析測試 =====

describe('parseArgs', () => {
  test('解析空參數', () => {
    const result = parseArgs(['bun', 'cli.ts']);
    expect(result.command).toBe('');
    expect(result.positional).toEqual([]);
    expect(result.flags).toEqual({});
  });

  test('解析單一命令', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start']);
    expect(result.command).toBe('start');
    expect(result.positional).toEqual([]);
  });

  test('解析命令 + 子命令', () => {
    const result = parseArgs(['bun', 'cli.ts', 'keys', 'add']);
    expect(result.command).toBe('keys');
    expect(result.positional).toEqual(['add']);
  });

  test('解析命令 + 子命令 + 位置參數', () => {
    const result = parseArgs(['bun', 'cli.ts', 'keys', 'remove', '42']);
    expect(result.command).toBe('keys');
    expect(result.positional).toEqual(['remove', '42']);
  });

  test('解析長旗標（布林）', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start', '--daemon', '--verbose']);
    expect(result.command).toBe('start');
    expect(result.flags['daemon']).toBe(true);
    expect(result.flags['verbose']).toBe(true);
  });

  test('解析長旗標（帶值 = 號）', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start', '--port=8080']);
    expect(result.flags['port']).toBe('8080');
  });

  test('解析長旗標（帶值空格）', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start', '--port', '8080']);
    expect(result.flags['port']).toBe('8080');
  });

  test('解析短旗標 -p', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start', '-p', '3000']);
    expect(result.flags['p']).toBe('3000');
  });

  test('解析 --no-vps', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start', '--no-vps']);
    expect(result.flags['no-vps']).toBe(true);
  });

  test('解析全域旗標 --plain', () => {
    const result = parseArgs(['bun', 'cli.ts', 'status', '--plain']);
    expect(result.flags['plain']).toBe(true);
  });

  test('解析全域旗標 --json', () => {
    const result = parseArgs(['bun', 'cli.ts', 'status', '--json']);
    expect(result.flags['json']).toBe(true);
  });

  test('解析 --locale', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start', '--locale', 'en']);
    expect(result.flags['locale']).toBe('en');
  });

  test('解析 -- 後的位置參數', () => {
    const result = parseArgs(['bun', 'cli.ts', 'keys', '--', 'extra1', 'extra2']);
    expect(result.positional).toEqual(['extra1', 'extra2']);
  });

  test('解析複雜組合', () => {
    const result = parseArgs([
      'bun', 'cli.ts', 'start',
      '-p', '9090',
      '--host', '0.0.0.0',
      '--daemon',
      '--no-vps',
      '--verbose',
      '--json',
    ]);
    expect(result.command).toBe('start');
    expect(result.flags['p']).toBe('9090');
    expect(result.flags['host']).toBe('0.0.0.0');
    expect(result.flags['daemon']).toBe(true);
    expect(result.flags['no-vps']).toBe(true);
    expect(result.flags['verbose']).toBe(true);
    expect(result.flags['json']).toBe(true);
  });

  test('解析 config set 命令', () => {
    const result = parseArgs(['bun', 'cli.ts', 'config', 'set', 'server.port', '8080']);
    expect(result.command).toBe('config');
    expect(result.positional).toEqual(['set', 'server.port', '8080']);
  });

  test('解析 sub-keys 命令', () => {
    const result = parseArgs(['bun', 'cli.ts', 'sub-keys', 'revoke', '5']);
    expect(result.command).toBe('sub-keys');
    expect(result.positional).toEqual(['revoke', '5']);
  });

  test('解析 device reset 命令', () => {
    const result = parseArgs(['bun', 'cli.ts', 'device', 'reset']);
    expect(result.command).toBe('device');
    expect(result.positional).toEqual(['reset']);
  });

  test('解析 logs 命令帶旗標', () => {
    const result = parseArgs(['bun', 'cli.ts', 'logs', '--service', 'groq', '--export', 'csv']);
    expect(result.command).toBe('logs');
    expect(result.flags['service']).toBe('groq');
    expect(result.flags['export']).toBe('csv');
  });

  test('解析短旗標 = 號', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start', '-p=4000']);
    expect(result.flags['p']).toBe('4000');
  });
});

// ===== 輸出模式測試 =====

describe('output module', () => {
  beforeEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('預設模式：非 plain、非 json', () => {
    expect(isPlainMode()).toBe(false);
    expect(isJsonMode()).toBe(false);
  });

  test('設定 plain 模式', () => {
    setOutputMode({ plain: true });
    expect(isPlainMode()).toBe(true);
    expect(isJsonMode()).toBe(false);
  });

  test('設定 json 模式', () => {
    setOutputMode({ json: true });
    expect(isPlainMode()).toBe(false);
    expect(isJsonMode()).toBe(true);
  });

  test('同時設定 plain + json', () => {
    setOutputMode({ plain: true, json: true });
    expect(isPlainMode()).toBe(true);
    expect(isJsonMode()).toBe(true);
  });

  test('getOutputMode 回傳正確狀態', () => {
    setOutputMode({ plain: true, json: false });
    const mode = getOutputMode();
    expect(mode.plain).toBe(true);
    expect(mode.json).toBe(false);
  });
});

// ===== 色彩工具測試 =====

describe('color utilities', () => {
  beforeEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('一般模式：套用 ANSI 色碼', () => {
    const result = color.red('test');
    expect(result).toContain('\x1b[31m');
    expect(result).toContain('test');
    expect(result).toContain(RESET);
  });

  test('一般模式：green', () => {
    const result = color.green('ok');
    expect(result).toContain('\x1b[32m');
    expect(result).toContain('ok');
  });

  test('一般模式：bold', () => {
    const result = color.bold('title');
    expect(result).toContain(BOLD);
    expect(result).toContain('title');
  });

  test('一般模式：boldGreen', () => {
    const result = color.boldGreen('pass');
    expect(result).toContain(BOLD);
    expect(result).toContain(GREEN);
    expect(result).toContain('pass');
  });

  test('plain 模式：不套用 ANSI 色碼', () => {
    setOutputMode({ plain: true });
    const result = color.red('test');
    expect(result).toBe('test');
    expect(result).not.toContain('\x1b[');
  });

  test('json 模式：不套用 ANSI 色碼', () => {
    setOutputMode({ json: true });
    const result = color.green('ok');
    expect(result).toBe('ok');
    expect(result).not.toContain('\x1b[');
  });

  test('所有色彩函式在 plain 模式下回傳原文', () => {
    setOutputMode({ plain: true });
    expect(color.red('r')).toBe('r');
    expect(color.green('g')).toBe('g');
    expect(color.yellow('y')).toBe('y');
    expect(color.blue('b')).toBe('b');
    expect(color.magenta('m')).toBe('m');
    expect(color.cyan('c')).toBe('c');
    expect(color.white('w')).toBe('w');
    expect(color.gray('g')).toBe('g');
    expect(color.bold('b')).toBe('b');
    expect(color.dim('d')).toBe('d');
    expect(color.boldGreen('bg')).toBe('bg');
    expect(color.boldRed('br')).toBe('br');
    expect(color.boldYellow('by')).toBe('by');
    expect(color.boldCyan('bc')).toBe('bc');
    expect(color.boldBlue('bb')).toBe('bb');
  });
});

// ===== JSON 輸出測試 =====

describe('JSON output', () => {
  let consoleOutput: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    consoleOutput = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    setOutputMode({ plain: false, json: false });
  });

  test('json 模式輸出合法 JSON', () => {
    setOutputMode({ json: true });
    const { jsonOutput } = require('../utils/output');
    jsonOutput({ status: 'ok', count: 42 });

    expect(consoleOutput.length).toBe(1);
    const parsed = JSON.parse(consoleOutput[0]!);
    expect(parsed.status).toBe('ok');
    expect(parsed.count).toBe(42);
  });

  test('json 模式輸出可被 JSON.parse 解析', () => {
    setOutputMode({ json: true });
    const { jsonOutput } = require('../utils/output');
    const data = {
      keys: [
        { id: 1, service: 'groq', status: 'active' },
        { id: 2, service: 'openai', status: 'dead' },
      ],
      total: 2,
    };
    jsonOutput(data);

    const parsed = JSON.parse(consoleOutput[0]!);
    expect(parsed.keys).toHaveLength(2);
    expect(parsed.keys[0].service).toBe('groq');
  });

  test('非 json 模式不輸出 jsonOutput', () => {
    setOutputMode({ json: false });
    const { jsonOutput } = require('../utils/output');
    jsonOutput({ data: 'test' });
    expect(consoleOutput.length).toBe(0);
  });

  test('json 模式的 print 不輸出', () => {
    setOutputMode({ json: true });
    const { print } = require('../utils/output');
    print('should not appear');
    expect(consoleOutput.length).toBe(0);
  });

  test('json 模式的 success/error/info/warn 不輸出', () => {
    setOutputMode({ json: true });
    const { success, error: errorFn, info, warn } = require('../utils/output');
    success('s');
    errorFn('e');
    info('i');
    warn('w');
    // error 使用 console.error，不是 console.log
    // success/info/warn 使用 console.log
    expect(consoleOutput.length).toBe(0);
  });
});

// ===== 命令路由測試 =====

describe('command routing', () => {
  test('version 命令不拋錯', async () => {
    const { versionCommand } = await import('../commands/misc');
    const args: ParsedArgs = { command: 'version', positional: [], flags: {} };

    // 捕獲輸出
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await versionCommand(args);

    console.log = origLog;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some(l => l.includes('ClawAPI'))).toBe(true);
  });

  test('version --json 輸出合法 JSON', async () => {
    setOutputMode({ json: true });
    const { versionCommand } = await import('../commands/misc');
    const args: ParsedArgs = { command: 'version', positional: [], flags: { json: true } };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await versionCommand(args);

    console.log = origLog;
    setOutputMode({ json: false });

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.version).toBeDefined();
    expect(parsed.runtime).toBeDefined();
    expect(parsed.platform).toBeDefined();
  });
});

// ===== status 命令測試 =====

describe('status command', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('status --json 輸出含 running 和 version', async () => {
    setOutputMode({ json: true });
    const { statusCommand } = await import('../commands/status');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await statusCommand({ command: 'status', positional: [], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(typeof parsed.running).toBe('boolean');
    expect(parsed.version).toBeDefined();
  });

  test('status 文字輸出包含狀態', async () => {
    setOutputMode({ plain: true });
    const { statusCommand } = await import('../commands/status');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await statusCommand({ command: 'status', positional: [], flags: {} });

    console.log = origLog;

    // 應該有輸出
    expect(logs.length).toBeGreaterThan(0);
  });
});

// ===== start 命令輔助測試 =====

describe('start command helpers', () => {
  test('writePid / readPid 寫入和讀取 PID', async () => {
    const { writePid, readPid, removePid } = await import('../commands/start');

    writePid(12345);
    const pid = readPid();
    expect(pid).toBe(12345);

    // 清理
    removePid();
    expect(readPid()).toBeNull();
  });

  test('isPidAlive 偵測目前 process', async () => {
    const { isPidAlive } = await import('../commands/start');
    // 目前 process 應該活著
    expect(isPidAlive(process.pid)).toBe(true);
    // 不存在的 PID
    expect(isPidAlive(999999)).toBe(false);
  });
});

// ===== doctor 命令測試 =====

describe('doctor command', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('doctor --json 輸出包含 results 和 summary', async () => {
    setOutputMode({ json: true });
    const { doctorCommand } = await import('../commands/doctor');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await doctorCommand({ command: 'doctor', positional: [], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.results).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBe(6);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.total).toBe(6);
  });

  test('doctor 結果每項都有 name, pass, detail', async () => {
    setOutputMode({ json: true });
    const { doctorCommand } = await import('../commands/doctor');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await doctorCommand({ command: 'doctor', positional: [], flags: {} });

    console.log = origLog;

    const parsed = JSON.parse(logs[0]!);
    for (const result of parsed.results) {
      expect(typeof result.name).toBe('string');
      expect(typeof result.pass).toBe('boolean');
      expect(typeof result.detail).toBe('string');
    }
  });

  test('doctor 6 項檢查名稱正確', async () => {
    setOutputMode({ json: true });
    const { doctorCommand } = await import('../commands/doctor');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await doctorCommand({ command: 'doctor', positional: [], flags: {} });

    console.log = origLog;

    const parsed = JSON.parse(logs[0]!);
    const names = parsed.results.map((r: { name: string }) => r.name);
    expect(names).toContain('DB 可寫');
    expect(names).toContain('master.key 存在');
    expect(names).toContain('VPS 可達');
    expect(names).toContain('Adapter 完整');
    expect(names).toContain('Key 健康');
    expect(names).toContain('port 可用');
  });

  test('doctor 文字模式有輸出', async () => {
    setOutputMode({ plain: true });
    const { doctorCommand } = await import('../commands/doctor');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await doctorCommand({ command: 'doctor', positional: [], flags: {} });

    console.log = origLog;

    // 應該有多行輸出
    expect(logs.length).toBeGreaterThan(5);
    // 應該有 PASS 或 FAIL
    expect(logs.some(l => l.includes('PASS') || l.includes('FAIL'))).toBe(true);
  });
});

// ===== 表格輸出測試 =====

describe('table output', () => {
  let consoleOutput: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    consoleOutput = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
    };
    setOutputMode({ plain: true, json: false });
  });

  afterEach(() => {
    console.log = originalLog;
    setOutputMode({ plain: false, json: false });
  });

  test('table 輸出表頭和資料', () => {
    const { table } = require('../utils/output');
    table(
      [
        { header: 'ID', key: 'id', minWidth: 4 },
        { header: 'Name', key: 'name', minWidth: 8 },
      ],
      [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]
    );

    // 表頭 + 分隔線 + 2 行資料
    expect(consoleOutput.length).toBe(4);
    expect(consoleOutput[0]).toContain('ID');
    expect(consoleOutput[0]).toContain('Name');
    expect(consoleOutput[2]).toContain('Alice');
    expect(consoleOutput[3]).toContain('Bob');
  });

  test('table json 模式不輸出', () => {
    setOutputMode({ json: true });
    const { table } = require('../utils/output');
    table(
      [{ header: 'ID', key: 'id' }],
      [{ id: 1 }]
    );
    expect(consoleOutput.length).toBe(0);
  });
});

// ===== check 輸出測試 =====

describe('check output', () => {
  let consoleOutput: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    consoleOutput = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
    };
    setOutputMode({ plain: true, json: false });
  });

  afterEach(() => {
    console.log = originalLog;
    setOutputMode({ plain: false, json: false });
  });

  test('check pass 顯示 PASS', () => {
    const { check } = require('../utils/output');
    check(true, 'DB 可寫', 'data.db');

    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0]).toContain('PASS');
    expect(consoleOutput[0]).toContain('DB 可寫');
  });

  test('check fail 顯示 FAIL', () => {
    const { check } = require('../utils/output');
    check(false, 'port 可用', 'port 4141 被占用');

    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0]).toContain('FAIL');
    expect(consoleOutput[0]).toContain('port 可用');
  });
});

// ===== step 輸出測試 =====

describe('step output', () => {
  let consoleOutput: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    consoleOutput = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
    };
    setOutputMode({ plain: true, json: false });
  });

  afterEach(() => {
    console.log = originalLog;
    setOutputMode({ plain: false, json: false });
  });

  test('step 顯示步驟編號和訊息', () => {
    const { step } = require('../utils/output');
    step(3, 5, '正在處理');

    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0]).toContain('[3/5]');
    expect(consoleOutput[0]).toContain('正在處理');
  });
});

// ===== config 命令測試 =====

describe('config command', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('config set 缺少參數時退出', async () => {
    const { configCommand } = await import('../commands/config');

    let exitCode: number | undefined;
    const mockExit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code as number;
      throw new Error('EXIT');
    }) as any);

    const logs: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => logs.push(a.join(' '));
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    let threwExit = false;
    try {
      await configCommand({ command: 'config', positional: ['set'], flags: {} });
    } catch (e: any) {
      if (e.message === 'EXIT') threwExit = true;
    }

    console.error = origError;
    console.log = origLog;
    mockExit.mockRestore();

    expect(threwExit).toBe(true);
    expect(exitCode).toBe(1);
  });
});

// ===== adapters 命令測試 =====

describe('adapters command', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('adapters list --json 輸出 adapters 陣列', async () => {
    setOutputMode({ json: true });
    const { adaptersCommand } = await import('../commands/adapters');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await adaptersCommand({ command: 'adapters', positional: ['list'], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(Array.isArray(parsed.adapters)).toBe(true);
    expect(parsed.adapters.length).toBeGreaterThan(0);
    expect(parsed.adapters[0].id).toBeDefined();
  });
});

// ===== telemetry 命令測試 =====

describe('telemetry command', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('telemetry show --json 輸出遙測資料', async () => {
    setOutputMode({ json: true });
    const { telemetryCommand } = await import('../commands/telemetry');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await telemetryCommand({ command: 'telemetry', positional: ['show'], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(typeof parsed.enabled).toBe('boolean');
    expect(typeof parsed.pending_events).toBe('number');
  });
});

// ===== misc 命令測試 =====

describe('misc commands', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('migrate --json 輸出遷移列表', async () => {
    setOutputMode({ json: true });
    const { migrateCommand } = await import('../commands/misc');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await migrateCommand({ command: 'migrate', positional: [], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.migrations).toBeDefined();
    expect(Array.isArray(parsed.migrations)).toBe(true);
  });
});

// ===== 命令存在性測試 =====

describe('all commands exist and can be imported', () => {
  const commandModules = [
    ['start', '../commands/start', 'startCommand'],
    ['stop', '../commands/stop', 'stopCommand'],
    ['status', '../commands/status', 'statusCommand'],
    ['keys', '../commands/keys', 'keysCommand'],
    ['gold-key', '../commands/gold-key', 'goldKeyCommand'],
    ['sub-keys', '../commands/sub-keys', 'subKeysCommand'],
    ['aid', '../commands/aid', 'aidCommand'],
    ['adapters', '../commands/adapters', 'adaptersCommand'],
    ['telemetry', '../commands/telemetry', 'telemetryCommand'],
    ['backup', '../commands/backup', 'backupCommand'],
    ['logs', '../commands/logs', 'logsCommand'],
    ['config', '../commands/config', 'configCommand'],
    ['setup', '../commands/setup', 'setupCommand'],
    ['doctor', '../commands/doctor', 'doctorCommand'],
  ] as const;

  for (const [name, path, exportName] of commandModules) {
    test(`${name} 命令模組可匯入`, async () => {
      const mod = await import(path);
      expect(typeof mod[exportName]).toBe('function');
    });
  }

  test('misc 命令模組含 version, migrate, deviceReset', async () => {
    const mod = await import('../commands/misc');
    expect(typeof mod.versionCommand).toBe('function');
    expect(typeof mod.migrateCommand).toBe('function');
    expect(typeof mod.deviceResetCommand).toBe('function');
  });
});

// ===== setup 命令邊界測試 =====

describe('setup command', () => {
  test('setup --json 回傳錯誤', async () => {
    setOutputMode({ json: true });
    const { setupCommand } = await import('../commands/setup');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    const mockExit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    try {
      await setupCommand({ command: 'setup', positional: [], flags: {} });
    } catch {
      // 預期 exit
    }

    console.log = origLog;
    setOutputMode({ json: false });
    mockExit.mockRestore();

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.error).toBe('not_supported');
  });
});

// ===== --plain 確認無色碼 =====

describe('--plain no ANSI codes', () => {
  let consoleOutput: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    consoleOutput = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
    };
    setOutputMode({ plain: true, json: false });
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    setOutputMode({ plain: false, json: false });
  });

  test('success 輸出不含 ANSI escape', () => {
    const { success } = require('../utils/output');
    success('test message');
    for (const line of consoleOutput) {
      expect(line).not.toContain('\x1b[');
    }
  });

  test('error 輸出不含 ANSI escape', () => {
    const { error: errorFn } = require('../utils/output');
    errorFn('test error');
    for (const line of consoleOutput) {
      expect(line).not.toContain('\x1b[');
    }
  });

  test('info 輸出不含 ANSI escape', () => {
    const { info } = require('../utils/output');
    info('test info');
    for (const line of consoleOutput) {
      expect(line).not.toContain('\x1b[');
    }
  });

  test('warn 輸出不含 ANSI escape', () => {
    const { warn } = require('../utils/output');
    warn('test warn');
    for (const line of consoleOutput) {
      expect(line).not.toContain('\x1b[');
    }
  });
});

// ===== keys 命令子命令路由測試 =====

describe('keys subcommand routing', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('keys list --json 輸出 keys 陣列', async () => {
    setOutputMode({ json: true });
    const { keysCommand } = await import('../commands/keys');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await keysCommand({ command: 'keys', positional: ['list'], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.keys).toBeDefined();
    expect(Array.isArray(parsed.keys)).toBe(true);
  });

  test('keys 未知子命令時退出', async () => {
    setOutputMode({ json: true });
    const { keysCommand } = await import('../commands/keys');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    const mockExit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    try {
      await keysCommand({ command: 'keys', positional: ['invalid'], flags: {} });
    } catch {
      // 預期
    }

    console.log = origLog;
    setOutputMode({ json: false });
    mockExit.mockRestore();

    const parsed = JSON.parse(logs[0]!);
    expect(parsed.error).toBe('unknown_subcommand');
  });
});

// ===== gold-key 命令測試 =====

describe('gold-key subcommand routing', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('gold-key show --json 有輸出', async () => {
    setOutputMode({ json: true });
    const { goldKeyCommand } = await import('../commands/gold-key');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await goldKeyCommand({ command: 'gold-key', positional: ['show'], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(typeof parsed.configured).toBe('boolean');
  });
});

// ===== sub-keys 命令測試 =====

describe('sub-keys subcommand routing', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('sub-keys list --json 輸出 sub_keys', async () => {
    setOutputMode({ json: true });
    const { subKeysCommand } = await import('../commands/sub-keys');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await subKeysCommand({ command: 'sub-keys', positional: ['list'], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.sub_keys).toBeDefined();
  });
});

// ===== aid 命令測試 =====

describe('aid subcommand routing', () => {
  afterEach(() => {
    setOutputMode({ plain: false, json: false });
  });

  test('aid stats --json 輸出統計', async () => {
    setOutputMode({ json: true });
    const { aidCommand } = await import('../commands/aid');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(' '));

    await aidCommand({ command: 'aid', positional: ['stats'], flags: {} });

    console.log = origLog;

    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!);
    expect(typeof parsed.enabled).toBe('boolean');
    expect(typeof parsed.daily_limit).toBe('number');
  });
});
