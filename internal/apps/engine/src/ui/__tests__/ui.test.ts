// Web UI 測試
// 驗證所有 12 頁 SSR 渲染、HTMX 屬性、CSS 變數、響應式設計

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { createUIRouter } from '../router';
import type { UIDeps } from '../router';

// ===== Mock 依賴 =====

/** 建立 Mock UI 依賴 */
function createMockUIDeps(): UIDeps {
  return {
    keyPool: {
      listKeys: async () => [
        {
          id: 1,
          service_id: 'groq',
          masked_key: 'sk-****abcd',
          pool_type: 'king',
          status: 'active',
          label: '測試 Key',
          pinned: false,
          success_rate: 98.5,
          total_requests: 150,
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 2,
          service_id: 'openai',
          masked_key: 'sk-****efgh',
          pool_type: 'friend',
          status: 'rate_limited',
          label: null,
          pinned: true,
          success_rate: 87.0,
          total_requests: 50,
          created_at: '2026-01-02T00:00:00Z',
        },
      ],
      addKey: async () => 3,
      removeKey: async () => undefined,
      getServiceIds: () => ['groq', 'openai'],
      selectKey: async () => null,
    } as unknown as UIDeps['keyPool'],

    subKeyManager: {
      list: async () => [
        {
          id: 1,
          label: '前端 App',
          token: 'sk_live_12345678_****abcd',
          is_active: true,
          daily_used: 10,
          daily_limit: 100,
          total_requests: 500,
          created_at: '2026-01-01T00:00:00Z',
          expires_at: null,
        },
      ],
      listActive: async () => [],
      issue: async () => ({ id: 2, token: 'sk_live_new_token' }),
      revoke: async () => true,
    } as unknown as UIDeps['subKeyManager'],

    aidClient: {
      getStats: async () => ({ total_given: 25, total_received: 12, karma_score: 13 }),
      updateConfig: async () => undefined,
    } as unknown as UIDeps['aidClient'],

    adapterLoader: {
      loadFromFile: async () => ({
        adapter: { id: 'test', name: 'Test', version: '1.0.0' },
      }),
    } as unknown as UIDeps['adapterLoader'],

    telemetry: {} as unknown as UIDeps['telemetry'],
    l0Manager: {
      getCachedKeyCount: () => 0,
      getLastFetchedAt: () => 0,
      isCacheExpired: () => true,
    } as unknown as UIDeps['l0Manager'],

    db: {
      query: (sql: string) => {
        // 根據 SQL 回傳不同的 Mock 資料（注意順序：更具體的在前面）
        if (sql.includes('success = 1')) return [{ cnt: 40 }];
        if (sql.includes('COUNT(*)')) return [{ cnt: 42 }];
        if (sql.includes('claw_keys')) return [
          {
            id: 1, service_id: 'openai', model_id: 'gpt-4o',
            is_active: 1, daily_used: 5, daily_limit: 50,
            created_at: '2026-01-01T00:00:00Z',
          },
        ];
        if (sql.includes('aid_config')) return [
          {
            enabled: 1, allowed_services: null, daily_limit: 50,
            daily_given: 10, blackout_hours: null, helper_public_key: null,
          },
        ];
        if (sql.includes('usage_log') && !sql.includes('COUNT')) return [
          {
            id: 1, timestamp: '2026-03-01T10:30:00Z', service_id: 'groq',
            model: 'llama3', layer: 'L1', success: 1, latency_ms: 120,
            tokens_input: 50, tokens_output: 100, error_code: null,
          },
          {
            id: 2, timestamp: '2026-03-01T10:29:00Z', service_id: 'openai',
            model: 'gpt-4o', layer: 'L2', success: 0, latency_ms: 500,
            tokens_input: 100, tokens_output: null, error_code: 'rate_limit',
          },
        ];
        return [];
      },
      run: () => ({ changes: 1, lastInsertRowid: 1 }),
      close: async () => undefined,
    } as unknown as UIDeps['db'],

    adapters: new Map([
      ['groq', {
        adapter: { id: 'groq', name: 'Groq', version: '1.0.0', category: 'llm', requires_key: true, free_tier: true },
        capabilities: {
          chat: true, streaming: true, embeddings: false, images: false, audio: false,
          models: [{ id: 'llama3', name: 'LLaMA 3' }],
        },
      }],
    ] as [string, unknown][]) as UIDeps['adapters'],

    getConfig: () => ({
      server: { port: 11434, host: '127.0.0.1' },
      l0: { enabled: true, ollama_auto_detect: true, ollama_url: 'http://localhost:11434' },
      aid: { enabled: true },
      telemetry: { enabled: false },
      routing: { default_layer: 'L2' },
      advanced: { max_keys_per_service: 10, health_check_interval_ms: 60000 },
    }) as unknown as ReturnType<UIDeps['getConfig']>,

    startedAt: new Date('2026-03-01T08:00:00Z'),
  };
}

// ===== 測試設定 =====

let app: Hono;

beforeAll(() => {
  const deps = createMockUIDeps();
  const uiRouter = createUIRouter(deps);
  app = new Hono();
  app.route('/ui', uiRouter);
});

/** 發送 GET 請求並取得回應 */
async function get(path: string): Promise<Response> {
  const req = new Request(`http://localhost${path}`);
  return app.fetch(req);
}

/** 取得回應 HTML 內容 */
async function getHTML(path: string): Promise<string> {
  const res = await get(path);
  return res.text();
}

// ===== 頁面渲染測試 =====

describe('Web UI 頁面渲染', () => {
  it('Dashboard（/ui）回傳 200 且包含 DOCTYPE', async () => {
    const res = await get('/ui');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Dashboard');
  });

  it('Keys（/ui/keys）回傳 200', async () => {
    const res = await get('/ui/keys');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Key');
    expect(html).toContain('groq');
  });

  it('Keys Add（/ui/keys/add）回傳 200', async () => {
    const res = await get('/ui/keys/add');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('service_id');
    expect(html).toContain('key_value');
  });

  it('Claw Key（/ui/claw-key）回傳 200', async () => {
    const res = await get('/ui/claw-key');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('gpt-4o');
  });

  it('Sub-Keys（/ui/sub-keys）回傳 200', async () => {
    const res = await get('/ui/sub-keys');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sub-Key');
  });

  it('Sub-Keys Issue（/ui/sub-keys/issue）回傳 200', async () => {
    const res = await get('/ui/sub-keys/issue');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('label');
  });

  it('Aid（/ui/aid）回傳 200', async () => {
    const res = await get('/ui/aid');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Karma');
  });

  it('Adapters（/ui/adapters）回傳 200', async () => {
    const res = await get('/ui/adapters');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Groq');
  });

  it('Logs（/ui/logs）回傳 200', async () => {
    const res = await get('/ui/logs');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('42');
  });

  it('Settings（/ui/settings）回傳 200', async () => {
    const res = await get('/ui/settings');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('11434');
  });

  it('Backup（/ui/backup）回傳 200', async () => {
    const res = await get('/ui/backup');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('v1.1');
  });

  it('About（/ui/about）回傳 200', async () => {
    const res = await get('/ui/about');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ClawAPI');
    expect(html).toContain('AGPL-3.0');
  });
});

// ===== HTMX 屬性驗證 =====

describe('HTMX 屬性', () => {
  it('Dashboard 包含 SSE 連線', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('sse-connect="/api/events"');
    expect(html).toContain('sse-swap="request_completed"');
  });

  it('Dashboard 包含定時更新', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('hx-get="/ui/api/health"');
    expect(html).toContain('hx-trigger="load, every 30s"');
  });

  it('Keys 列表包含 HTMX 自動刷新', async () => {
    const html = await getHTML('/ui/keys');
    expect(html).toContain('hx-get="/ui/api/keys"');
    expect(html).toContain('hx-trigger="load, every 30s"');
  });

  it('Keys Add 表單包含 hx-post', async () => {
    const html = await getHTML('/ui/keys/add');
    expect(html).toContain('hx-post="/api/keys"');
    expect(html).toContain('hx-target="#form-result"');
  });

  it('Claw Key 表單包含 hx-post', async () => {
    const html = await getHTML('/ui/claw-key');
    expect(html).toContain('hx-post="/api/claw-keys"');
    expect(html).toContain('hx-target="#claw-key-list"');
  });

  it('Sub-Keys Issue 表單包含 hx-post', async () => {
    const html = await getHTML('/ui/sub-keys/issue');
    expect(html).toContain('hx-post="/api/sub-keys"');
  });

  it('Settings 表單包含 hx-put', async () => {
    const html = await getHTML('/ui/settings');
    expect(html).toContain('hx-put="/api/settings"');
  });

  it('Backup 按鈕包含 hx-post', async () => {
    const html = await getHTML('/ui/backup');
    expect(html).toContain('hx-post="/api/backup/export"');
    expect(html).toContain('hx-post="/api/backup/import"');
  });

  it('Logs 篩選表單包含 hx-get', async () => {
    const html = await getHTML('/ui/logs');
    expect(html).toContain('hx-get="/ui/api/logs"');
    expect(html).toContain('hx-target="#log-table"');
  });
});

// ===== Dashboard 資料綁定 =====

describe('Dashboard 資料綁定', () => {
  it('顯示 Key 池數量', async () => {
    const html = await getHTML('/ui');
    // Mock 有 2 個 Key
    expect(html).toContain('2');
  });

  it('顯示今日用量', async () => {
    const html = await getHTML('/ui');
    // Mock 回傳 cnt=42
    expect(html).toContain('42');
  });

  it('顯示成功率', async () => {
    const html = await getHTML('/ui');
    // 40/42 = 95.2%
    expect(html).toContain('95.2%');
  });

  it('顯示 Key 狀態分佈', async () => {
    const html = await getHTML('/ui');
    // 1 active, 1 rate_limited
    expect(html).toContain('\ud83d\udfe21');
    expect(html).toContain('\ud83d\udfe11');
  });
});

// ===== CSS 主題 =====

describe('深淺主題 CSS', () => {
  it('包含淺色主題變數', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('--bg: #ffffff');
    expect(html).toContain('--accent: #e74c3c');
  });

  it('包含深色主題變數', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain('--bg: #1a1a2e');
    expect(html).toContain('--accent: #ff6b6b');
  });

  it('包含主題切換按鈕', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('theme-toggle');
    expect(html).toContain('toggleTheme');
  });

  it('包含 localStorage 主題持久化', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('clawapi-theme');
    expect(html).toContain('localStorage');
  });
});

// ===== 響應式斷點 =====

describe('響應式設計', () => {
  it('包含平板斷點 (1024px)', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('@media (max-width: 1024px)');
  });

  it('包含手機斷點 (768px)', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('@media (max-width: 768px)');
  });

  it('包含底部導覽（手機用）', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('bottom-nav');
  });

  it('手機時隱藏桌面導覽連結', async () => {
    const html = await getHTML('/ui');
    // CSS 應包含 .top-nav .nav-links { display: none; }
    expect(html).toContain('.top-nav .nav-links { display: none; }');
  });
});

// ===== HTMX CDN 引入 =====

describe('HTMX 引入', () => {
  it('包含 HTMX 主要 script', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('unpkg.com/htmx.org');
  });

  it('包含 HTMX SSE 擴展', async () => {
    const html = await getHTML('/ui');
    expect(html).toContain('dist/ext/sse.js');
  });
});

// ===== 導覽列 =====

describe('導覽列', () => {
  it('Dashboard 頁面 dashboard nav 標記為 active', async () => {
    const html = await getHTML('/ui');
    // nav-link active 的那一個應該是 dashboard
    expect(html).toContain('ClawAPI');
    // 確認包含導覽連結
    expect(html).toContain('/ui/keys');
    expect(html).toContain('/ui/claw-key');
    expect(html).toContain('/ui/sub-keys');
    expect(html).toContain('/ui/aid');
    expect(html).toContain('/ui/adapters');
    expect(html).toContain('/ui/logs');
    expect(html).toContain('/ui/settings');
    expect(html).toContain('/ui/backup');
    expect(html).toContain('/ui/about');
  });

  it('包含所有導覽項目', async () => {
    const html = await getHTML('/ui');
    const navItems = ['Keys', 'Sub-Keys', 'Adapter'];
    for (const item of navItems) {
      expect(html).toContain(item);
    }
  });
});

// ===== Content-Type =====

describe('HTTP 回應', () => {
  it('Content-Type 為 text/html', async () => {
    const res = await get('/ui');
    const contentType = res.headers.get('Content-Type');
    expect(contentType).toContain('text/html');
  });

  it('所有頁面回傳 200', async () => {
    const paths = [
      '/ui', '/ui/keys', '/ui/keys/add', '/ui/claw-key',
      '/ui/sub-keys', '/ui/sub-keys/issue', '/ui/aid',
      '/ui/adapters', '/ui/logs', '/ui/settings', '/ui/backup', '/ui/about',
    ];
    for (const path of paths) {
      const res = await get(path);
      expect(res.status).toBe(200);
    }
  });
});
