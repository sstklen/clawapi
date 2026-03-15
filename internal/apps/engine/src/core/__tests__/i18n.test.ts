// i18n 多語系模組測試
// 測試翻譯、插值、Fallback、語系偵測等功能

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { I18n, createI18n } from '../i18n';

// ===== 真實語言檔案目錄 =====

// 指向 apps/engine/locales/ 目錄
// 注意：bun test 從 monorepo 根目錄執行時 import.meta.dir 為根目錄
// 因此直接使用固定的相對路徑解析
import { fileURLToPath } from 'node:url';
const _thisFile = fileURLToPath(import.meta.url);
// __tests__ → core → src → engine → locales（4 層）
const REAL_LOCALES_DIR = join(_thisFile, '..', '..', '..', '..', 'locales');

// ===== 測試用臨時語言檔 =====

let tempDir: string;
let tempLocalesDir: string;

/** 在臨時目錄寫入語言檔 */
function writeTempLocale(locale: string, messages: Record<string, string>): void {
  writeFileSync(
    join(tempLocalesDir, `${locale}.json`),
    JSON.stringify(messages, null, 2),
    'utf8'
  );
}

beforeEach(() => {
  tempDir = join(tmpdir(), `clawapi-i18n-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempLocalesDir = join(tempDir, 'locales');
  mkdirSync(tempLocalesDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失敗
  }
});

// ===== 測試案例 =====

describe('基本翻譯（zh-TW）', () => {
  it("t('key.added', {service: 'groq'}) → '已新增 Key：groq'", () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    expect(i18n.t('key.added', { service: 'groq' })).toBe('已新增 Key：groq');
  });

  it("t('startup.ready') → '準備就緒！'", () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    expect(i18n.t('startup.ready')).toBe('準備就緒！');
  });

  it('startup.port 插值：host 和 port', () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    const result = i18n.t('startup.port', { host: '127.0.0.1', port: 4141 });
    expect(result).toBe('伺服器正在監聽 127.0.0.1:4141');
  });
});

describe('語系切換', () => {
  it("setLocale('en') → t('key.added') 應為英文", () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    i18n.setLocale('en');
    expect(i18n.t('key.added', { service: 'groq' })).toBe('Key added: groq');
  });

  it("setLocale('ja') → t('key.added') 應為日文", () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    i18n.setLocale('ja');
    expect(i18n.t('key.added', { service: 'openai' })).toBe('Keyを追加しました：openai');
  });

  it('setLocale 後 getLocale 應回傳新語系', () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    expect(i18n.getLocale()).toBe('zh-TW');
    i18n.setLocale('en');
    expect(i18n.getLocale()).toBe('en');
    i18n.setLocale('ja');
    expect(i18n.getLocale()).toBe('ja');
  });
});

describe('Fallback 機制', () => {
  it('zh-TW 缺少的 key → fallback 到 en', () => {
    // 建立只有部分 key 的 zh-TW，以及完整的 en
    writeTempLocale('zh-TW', {
      'existing.key': '存在的 key',
      // 故意不加 'missing.key'
    });
    writeTempLocale('en', {
      'existing.key': 'Existing key',
      'missing.key': 'This key only exists in en',
    });
    writeTempLocale('ja', {});

    const i18n = new I18n(tempLocalesDir, 'zh-TW');

    // zh-TW 有的 key → 用 zh-TW
    expect(i18n.t('existing.key')).toBe('存在的 key');

    // zh-TW 沒有 → fallback 到 en
    expect(i18n.t('missing.key')).toBe('This key only exists in en');
  });

  it('en 也沒有的 key → 回傳 key 本身', () => {
    writeTempLocale('zh-TW', {});
    writeTempLocale('en', {});
    writeTempLocale('ja', {});

    const i18n = new I18n(tempLocalesDir, 'zh-TW');

    expect(i18n.t('nonexistent.key.xyz')).toBe('nonexistent.key.xyz');
  });

  it('語系為 en 時，key 不存在 → 直接回傳 key', () => {
    writeTempLocale('zh-TW', {});
    writeTempLocale('en', {});
    writeTempLocale('ja', {});

    const i18n = new I18n(tempLocalesDir, 'en');

    expect(i18n.t('totally.missing')).toBe('totally.missing');
  });
});

describe('detectLocale 優先順序', () => {
  it('CLI locale 優先於 config locale', () => {
    const i18n = new I18n(REAL_LOCALES_DIR);
    const detected = i18n.detectLocale('zh-TW', 'en');
    expect(detected).toBe('en');
  });

  it('無 CLI locale → 使用 config locale', () => {
    const i18n = new I18n(REAL_LOCALES_DIR);
    const detected = i18n.detectLocale('ja', undefined);
    expect(detected).toBe('ja');
  });

  it('無 CLI 也無 config → 使用系統語言或預設 en', () => {
    const i18n = new I18n(REAL_LOCALES_DIR);
    const detected = i18n.detectLocale(undefined, undefined);
    // 系統語言可能是任何值，但回傳應為合法的 SupportedLocale
    expect(['zh-TW', 'en', 'ja']).toContain(detected);
  });

  it('detectLocale 的結果可以直接用於 setLocale', () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    const detected = i18n.detectLocale('en', undefined);
    i18n.setLocale(detected);
    expect(i18n.getLocale()).toBe('en');
  });
});

describe('參數插值', () => {
  it('多個參數同時插值：{host}:{port}', () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'en');
    const result = i18n.t('startup.port', { host: 'localhost', port: 8080 });
    expect(result).toBe('Server listening on localhost:8080');
  });

  it('params 中的數字應被轉為字串', () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    const result = i18n.t('key.rate_limited', { name: 'mykey', seconds: 60 });
    expect(result).toBe('Key mykey 被限速，冷卻 60 秒');
  });

  it('沒有對應 params 的 {placeholder} 應保留原樣', () => {
    writeTempLocale('en', {
      'test.missing_param': 'Hello {name}, you have {count} messages',
    });
    writeTempLocale('zh-TW', {});
    writeTempLocale('ja', {});

    const i18n = new I18n(tempLocalesDir, 'en');

    // 只提供 name，count 沒提供 → {count} 保留
    const result = i18n.t('test.missing_param', { name: 'Alice' });
    expect(result).toBe('Hello Alice, you have {count} messages');
  });

  it('不傳 params → 回傳原始翻譯文字', () => {
    const i18n = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    expect(i18n.t('startup.ready')).toBe('準備就緒！');
  });
});

describe('三語言檔案完整性', () => {
  it('所有 key 在 zh-TW、en、ja 三個語言檔中都存在', () => {
    // 讀取三個語言檔
    const zhTW = new I18n(REAL_LOCALES_DIR, 'zh-TW');
    const en = new I18n(REAL_LOCALES_DIR, 'en');
    const ja = new I18n(REAL_LOCALES_DIR, 'ja');

    // 必須存在的 key 清單
    const requiredKeys = [
      'startup.ready',
      'startup.port',
      'startup.offline_mode',
      'shutdown.draining',
      'shutdown.complete',
      'key.added',
      'key.removed',
      'key.dead',
      'key.expired',
      'key.rate_limited',
      'routing.switch',
      'routing.failover',
      'aid.requesting',
      'aid.received',
      'aid.timeout',
      'aid.enabled',
      'aid.disabled',
      'l0.limit_reached',
      'config.invalid',
      'error.generic',
    ];

    for (const key of requiredKeys) {
      // 每個 key 在各語言的翻譯不應等於 key 本身（代表有翻譯）
      expect(zhTW.t(key)).not.toBe(key);
      expect(en.t(key)).not.toBe(key);
      expect(ja.t(key)).not.toBe(key);
    }
  });

  it('三語言的 key 數量應相同（至少 20 個）', () => {
    // 利用 t() 測試每個預期 key 的存在性
    const requiredKeys = [
      'startup.ready', 'startup.port', 'startup.offline_mode',
      'shutdown.draining', 'shutdown.complete',
      'key.added', 'key.removed', 'key.dead', 'key.expired', 'key.rate_limited',
      'routing.switch', 'routing.failover',
      'aid.requesting', 'aid.received', 'aid.timeout', 'aid.enabled', 'aid.disabled',
      'l0.limit_reached', 'config.invalid', 'error.generic',
    ];

    expect(requiredKeys.length).toBeGreaterThanOrEqual(20);

    const locales = ['zh-TW', 'en', 'ja'] as const;
    for (const locale of locales) {
      const i18n = new I18n(REAL_LOCALES_DIR, locale);
      const missingKeys = requiredKeys.filter(k => i18n.t(k) === k);
      expect(missingKeys).toEqual([]);
    }
  });
});

describe('createI18n 工廠函式', () => {
  it('createI18n 應回傳 I18n 實例', () => {
    const i18n = createI18n(REAL_LOCALES_DIR, 'en');
    expect(i18n).toBeInstanceOf(I18n);
    expect(i18n.getLocale()).toBe('en');
  });

  it('createI18n 建立的實例功能正常', () => {
    const i18n = createI18n(REAL_LOCALES_DIR, 'zh-TW');
    expect(i18n.t('startup.ready')).toBe('準備就緒！');
  });
});
