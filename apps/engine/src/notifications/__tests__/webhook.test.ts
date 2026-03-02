// Webhook 發送器測試 — SSRF 防護 + HMAC 簽名
import { describe, expect, test } from 'bun:test';
import { WebhookSender } from '../webhook';

describe('WebhookSender', () => {
  const sender = new WebhookSender();

  // ===== SSRF 防護測試 =====

  describe('SSRF 防護', () => {
    const payload = {
      event: 'key.dead' as const,
      timestamp: '2026-03-02T00:00:00Z',
      message: '測試',
    };

    test('應阻擋 localhost', async () => {
      await expect(sender.send('http://localhost:8080/hook', payload))
        .rejects.toThrow('內網地址');
    });

    test('應阻擋 127.0.0.1', async () => {
      await expect(sender.send('http://127.0.0.1/hook', payload))
        .rejects.toThrow('內網地址');
    });

    test('應阻擋 169.254.169.254（雲 metadata）', async () => {
      await expect(sender.send('http://169.254.169.254/latest', payload))
        .rejects.toThrow('內網地址');
    });

    test('應阻擋 10.x 私有 IP', async () => {
      await expect(sender.send('http://10.0.0.1/hook', payload))
        .rejects.toThrow('私有網路');
    });

    test('應阻擋 192.168.x 私有 IP', async () => {
      await expect(sender.send('http://192.168.1.1/hook', payload))
        .rejects.toThrow('私有網路');
    });

    test('應阻擋 .internal 域名', async () => {
      await expect(sender.send('http://api.internal/hook', payload))
        .rejects.toThrow('私有網路');
    });

    test('應阻擋無效 URL', async () => {
      await expect(sender.send('not-a-url', payload))
        .rejects.toThrow('無效的 Webhook URL');
    });

    test('應阻擋 ftp 協議', async () => {
      await expect(sender.send('ftp://example.com/file', payload))
        .rejects.toThrow('協議不支援');
    });
  });

  // ===== HMAC-SHA256 簽名測試 =====

  describe('HMAC-SHA256 簽名', () => {
    test('應產生 64 字元 hex 字串', async () => {
      const signature = await sender.sign('hello', 'secret');
      expect(signature).toHaveLength(64); // SHA-256 = 32 bytes = 64 hex chars
      expect(/^[0-9a-f]+$/.test(signature)).toBe(true);
    });

    test('相同輸入應產生相同簽名', async () => {
      const sig1 = await sender.sign('test-payload', 'my-secret');
      const sig2 = await sender.sign('test-payload', 'my-secret');
      expect(sig1).toBe(sig2);
    });

    test('不同 secret 應產生不同簽名', async () => {
      const sig1 = await sender.sign('same-payload', 'secret-1');
      const sig2 = await sender.sign('same-payload', 'secret-2');
      expect(sig1).not.toBe(sig2);
    });

    test('不同 payload 應產生不同簽名', async () => {
      const sig1 = await sender.sign('payload-1', 'same-secret');
      const sig2 = await sender.sign('payload-2', 'same-secret');
      expect(sig1).not.toBe(sig2);
    });

    test('簽名內容應包含時間戳（防重放）', async () => {
      // 驗證 timestamp.body 格式產生不同的簽名
      const body = '{"event":"key.dead"}';
      const sig1 = await sender.sign(`2026-03-01T00:00:00Z.${body}`, 'secret');
      const sig2 = await sender.sign(`2026-03-02T00:00:00Z.${body}`, 'secret');
      expect(sig1).not.toBe(sig2); // 不同時間戳 = 不同簽名
    });
  });
});
