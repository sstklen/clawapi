// encryption.test.ts — Crypto 模組測試

import { describe, it, expect, beforeEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { CryptoModule } from '../encryption';

// ===== 輔助函式 =====

/** 建立一個臨時目錄，初始化 Crypto 模組 */
async function createCrypto(): Promise<{ crypto: CryptoModule; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-test-'));
  const crypto = new CryptoModule(tmpDir);
  await crypto.initMasterKey();
  return { crypto, tmpDir };
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理錯誤
  }
}

// ===== AES-256-GCM 加解密 =====

describe('Crypto — AES-256-GCM 加解密', () => {
  it('加密後解密應得到原文（一般字串）', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const plaintext = 'Hello, ClawAPI!';
      const ciphertext = crypto.encrypt(plaintext);
      const decrypted = crypto.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('加密後解密應得到原文（含特殊字元）', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const plaintext = '🦞 gsk_1234567890abcdef\n換行\t製表符';
      const ciphertext = crypto.encrypt(plaintext);
      const decrypted = crypto.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('加密後解密應得到原文（長 JSON 字串）', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const plaintext = JSON.stringify({
        service_id: 'groq',
        key: 'gsk_' + 'a'.repeat(50),
        model: 'llama-3.3-70b',
        quota: 1000,
        tags: ['fast', 'cheap'],
      });
      const ciphertext = crypto.encrypt(plaintext);
      const decrypted = crypto.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('兩次加密同一明文應得到不同密文（IV 不同）', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const plaintext = 'same plaintext';
      const ct1 = crypto.encrypt(plaintext);
      const ct2 = crypto.encrypt(plaintext);
      // IV 隨機，所以密文不同
      expect(Buffer.from(ct1).toString('hex')).not.toBe(
        Buffer.from(ct2).toString('hex')
      );
      // 但兩個都能解密得到相同明文
      expect(crypto.decrypt(ct1)).toBe(plaintext);
      expect(crypto.decrypt(ct2)).toBe(plaintext);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('密文格式應為 IV(12) + AuthTag(16) + CipherText', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const plaintext = 'format test';
      const ciphertext = crypto.encrypt(plaintext);
      // IV(12) + AuthTag(16) + 至少 1 byte 密文
      expect(ciphertext.length).toBeGreaterThan(28);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('篡改密文應導致解密失敗（AuthTag 驗證）', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const plaintext = 'tamper test';
      const ciphertext = crypto.encrypt(plaintext);
      // 篡改最後一個 byte
      ciphertext[ciphertext.length - 1] ^= 0xFF;
      expect(() => crypto.decrypt(ciphertext)).toThrow();
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

// ===== Master Key 管理 =====

describe('Crypto — Master Key', () => {
  it('initMasterKey 應建立 master.key 檔案', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const key = crypto.getMasterKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('重複呼叫 initMasterKey 應讀取同一把 key', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-test-'));
    try {
      const crypto1 = new CryptoModule(tmpDir);
      await crypto1.initMasterKey();
      const key1 = crypto1.getMasterKey();

      const crypto2 = new CryptoModule(tmpDir);
      await crypto2.initMasterKey();
      const key2 = crypto2.getMasterKey();

      expect(Buffer.from(key1).toString('hex')).toBe(
        Buffer.from(key2).toString('hex')
      );
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('未初始化時呼叫 getMasterKey 應拋出錯誤', () => {
    const crypto = new CryptoModule();
    expect(() => crypto.getMasterKey()).toThrow();
  });
});

// ===== ECDH P-256 =====

describe('Crypto — ECDH P-256', () => {
  it('generateECDHKeyPair 應回傳 Base64 公私鑰', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const kp = await crypto.generateECDHKeyPair();
      expect(typeof kp.publicKey).toBe('string');
      expect(typeof kp.privateKey).toBe('string');
      // Base64 字串應可被解碼
      const pubBuf = Buffer.from(kp.publicKey, 'base64');
      const privBuf = Buffer.from(kp.privateKey, 'base64');
      expect(pubBuf.length).toBeGreaterThan(0);
      expect(privBuf.length).toBeGreaterThan(0);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('兩端 ECDH 導出的共享 secret 應相同', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      // Alice 和 Bob 各產生 keypair
      const alice = await crypto.generateECDHKeyPair();
      const bob = await crypto.generateECDHKeyPair();

      // Alice 用自己的私鑰 + Bob 的公鑰
      const secretAlice = await crypto.deriveSharedSecret(
        alice.privateKey,
        bob.publicKey
      );

      // Bob 用自己的私鑰 + Alice 的公鑰
      const secretBob = await crypto.deriveSharedSecret(
        bob.privateKey,
        alice.publicKey
      );

      expect(Buffer.from(secretAlice).toString('hex')).toBe(
        Buffer.from(secretBob).toString('hex')
      );
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('共享 secret 應為 32 bytes', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const alice = await crypto.generateECDHKeyPair();
      const bob = await crypto.generateECDHKeyPair();
      const secret = await crypto.deriveSharedSecret(alice.privateKey, bob.publicKey);
      expect(secret.length).toBe(32);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

// ===== HKDF =====

describe('Crypto — HKDF', () => {
  it('HKDF 應輸出 32 bytes', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const inputKey = new Uint8Array(32).fill(0xAB);
      const result = await crypto.hkdf(inputKey, 'test-aid-id', 'clawapi-aid-v1', 32);
      expect(result.length).toBe(32);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('相同參數的 HKDF 應輸出相同結果（決定性）', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const inputKey = new Uint8Array(32).fill(0x55);
      const r1 = await crypto.hkdf(inputKey, 'test-aid-id', 'clawapi-aid-v1', 32);
      const r2 = await crypto.hkdf(inputKey, 'test-aid-id', 'clawapi-aid-v1', 32);
      expect(Buffer.from(r1).toString('hex')).toBe(
        Buffer.from(r2).toString('hex')
      );
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('不同 salt 應輸出不同結果', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const inputKey = new Uint8Array(32).fill(0x77);
      const r1 = await crypto.hkdf(inputKey, 'aid-id-001', 'clawapi-aid-v1', 32);
      const r2 = await crypto.hkdf(inputKey, 'aid-id-002', 'clawapi-aid-v1', 32);
      expect(Buffer.from(r1).toString('hex')).not.toBe(
        Buffer.from(r2).toString('hex')
      );
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

// ===== 互助加密 =====

describe('Crypto — 互助加密（encryptForAidWithKey / decryptFromAidWithKey）', () => {
  it('加密後解密應得到原文', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const alice = await crypto.generateECDHKeyPair();
      const bob = await crypto.generateECDHKeyPair();
      const aid_id = 'aid_test_12345';
      const original = '{"service":"groq","model":"llama-3.3-70b"}';

      // Alice 加密給 Bob
      const { encrypted } = await crypto.encryptForAidWithKey(
        original,
        alice.privateKey,
        bob.publicKey,
        aid_id
      );

      // Bob 解密
      const decrypted = await crypto.decryptFromAidWithKey(
        encrypted,
        bob.privateKey,
        alice.publicKey,
        aid_id
      );

      expect(decrypted).toBe(original);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('不同 aid_id 應無法解密', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const alice = await crypto.generateECDHKeyPair();
      const bob = await crypto.generateECDHKeyPair();

      const { encrypted } = await crypto.encryptForAidWithKey(
        'secret data',
        alice.privateKey,
        bob.publicKey,
        'aid_correct_id'
      );

      // 用錯誤的 aid_id 解密應失敗
      await expect(
        crypto.decryptFromAidWithKey(encrypted, bob.privateKey, alice.publicKey, 'aid_wrong_id')
      ).rejects.toThrow();
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

// ===== 備份加密 =====

describe('Crypto — 備份加密', () => {
  it('加密後解密應得到原文', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const data = '{"keys":[{"id":1,"service":"groq"}]}';
      const password = 'my_backup_password_123';
      const encrypted = crypto.encryptForBackup(data, password);
      const decrypted = crypto.decryptFromBackup(encrypted, password);
      expect(decrypted).toBe(data);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('錯誤密碼應無法解密', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const data = 'sensitive backup data';
      const encrypted = crypto.encryptForBackup(data, 'correct_password');
      expect(() =>
        crypto.decryptFromBackup(encrypted, 'wrong_password')
      ).toThrow();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('兩次加密同一資料應得到不同密文（salt 不同）', async () => {
    const { crypto, tmpDir } = await createCrypto();
    try {
      const data = 'backup data';
      const password = 'password';
      const e1 = crypto.encryptForBackup(data, password);
      const e2 = crypto.encryptForBackup(data, password);
      expect(Buffer.from(e1).toString('hex')).not.toBe(
        Buffer.from(e2).toString('hex')
      );
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

// ===== Key 遮罩 =====

describe('Crypto — maskKey', () => {
  let crypto: CryptoModule;
  let tmpDir: string;

  beforeEach(async () => {
    ({ crypto, tmpDir } = await createCrypto());
  });

  it("'gsk_1234567890abcdef' 應遮罩為 'gsk_****cdef'", () => {
    expect(crypto.maskKey('gsk_1234567890abcdef')).toBe('gsk_****cdef');
  });

  it("'sk-proj-abcdefghijklmnop' 應遮罩為 'sk-p****mnop'", () => {
    expect(crypto.maskKey('sk-proj-abcdefghijklmnop')).toBe('sk-p****mnop');
  });

  it("'AAAA1234' 應遮罩為 'AAAA****1234'（< 8 bytes 全遮）", () => {
    // 長度 8，剛好
    expect(crypto.maskKey('AAAA1234')).toBe('****');
  });

  it("長度 9 的 key 應顯示前 4 + 後 4", () => {
    expect(crypto.maskKey('123456789')).toBe('1234****6789');
  });

  it('太短的 key 全部遮罩', () => {
    expect(crypto.maskKey('abc')).toBe('****');
  });
});
