// Adapter 路由處理器
// GET /v1/adapters/official — 官方 Adapter 清單
// GET /v1/adapters/updates — Adapter 更新資訊

import { Hono } from 'hono';
import type { AuthVariables } from '../middleware/auth';

// Adapter 資訊型別
interface AdapterInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  service_ids: string[];          // 此 adapter 支援的服務
  status: 'stable' | 'beta' | 'deprecated';
  author: string;
  repository_url: string;
  install_url: string;
  updated_at: string;
}

// Adapter 更新資訊型別
interface AdapterUpdateInfo {
  adapter_id: string;
  current_version: string;
  latest_version: string;
  update_available: boolean;
  update_notes: string;
  download_url: string;
  published_at: string;
}

// 官方 Adapter 靜態清單（日後可改為從 DB 或 Registry 讀取）
const OFFICIAL_ADAPTERS: AdapterInfo[] = [
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    description: '相容 OpenAI API 格式的通用 Adapter，支援 groq、deepseek、sambanova 等',
    version: '1.0.0',
    service_ids: ['openai', 'groq', 'deepseek', 'sambanova', 'cerebras', 'qwen', 'openrouter'],
    status: 'stable',
    author: 'ClawAPI Team',
    repository_url: 'https://github.com/clawapi/adapters/tree/main/openai-compatible',
    install_url: 'https://registry.clawapi.dev/adapters/openai-compatible@1.0.0',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    description: 'Google Gemini API 原生 Adapter',
    version: '1.0.0',
    service_ids: ['gemini'],
    status: 'stable',
    author: 'ClawAPI Team',
    repository_url: 'https://github.com/clawapi/adapters/tree/main/google-gemini',
    install_url: 'https://registry.clawapi.dev/adapters/google-gemini@1.0.0',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Anthropic Claude API 原生 Adapter',
    version: '1.0.0',
    service_ids: ['anthropic'],
    status: 'stable',
    author: 'ClawAPI Team',
    repository_url: 'https://github.com/clawapi/adapters/tree/main/anthropic',
    install_url: 'https://registry.clawapi.dev/adapters/anthropic@1.0.0',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Brave Search API Adapter，提供網路搜尋能力',
    version: '1.0.0',
    service_ids: ['brave-search'],
    status: 'stable',
    author: 'ClawAPI Team',
    repository_url: 'https://github.com/clawapi/adapters/tree/main/brave-search',
    install_url: 'https://registry.clawapi.dev/adapters/brave-search@1.0.0',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'translation',
    name: 'Translation',
    description: '翻譯服務 Adapter，支援 DeepL 等翻譯 API',
    version: '0.9.0',
    service_ids: ['deepl'],
    status: 'beta',
    author: 'ClawAPI Team',
    repository_url: 'https://github.com/clawapi/adapters/tree/main/translation',
    install_url: 'https://registry.clawapi.dev/adapters/translation@0.9.0',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

// 建立 Adapter 路由
export function createAdaptersRouter(): Hono<{ Variables: AuthVariables }> {
  const router = new Hono<{ Variables: AuthVariables }>();

  // ─────────────────────────────────────────────────────────────────
  // GET /v1/adapters/official
  // 取得官方 Adapter 清單
  // Query: ?service_id=xxx（可選過濾）、?status=stable|beta|deprecated（可選）
  // ─────────────────────────────────────────────────────────────────
  router.get('/official', (c) => {
    const serviceIdFilter = c.req.query('service_id');
    const statusFilter = c.req.query('status');

    let adapters = [...OFFICIAL_ADAPTERS];

    // 依 service_id 過濾
    if (serviceIdFilter) {
      adapters = adapters.filter((a) => a.service_ids.includes(serviceIdFilter));
    }

    // 依 status 過濾
    if (statusFilter && ['stable', 'beta', 'deprecated'].includes(statusFilter)) {
      adapters = adapters.filter((a) => a.status === statusFilter);
    }

    return c.json({
      adapters,
      total: adapters.length,
      server_time: new Date().toISOString(),
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /v1/adapters/updates
  // 取得 Adapter 更新資訊
  // Query: ?adapter_ids=id1,id2（可選，逗號分隔；若不提供則回所有已知 adapter）
  // ─────────────────────────────────────────────────────────────────
  router.get('/updates', (c) => {
    const adapterIdsParam = c.req.query('adapter_ids');

    // 解析要查詢的 adapter ID 清單
    let targetIds: string[] = OFFICIAL_ADAPTERS.map((a) => a.id);
    if (adapterIdsParam) {
      targetIds = adapterIdsParam.split(',').map((id) => id.trim()).filter(Boolean);
    }

    // 為每個請求的 adapter 產生更新資訊
    const updates: AdapterUpdateInfo[] = [];
    for (const adapterId of targetIds) {
      const adapter = OFFICIAL_ADAPTERS.find((a) => a.id === adapterId);
      if (!adapter) continue;

      // 目前版本即為最新版本（靜態資料，日後從 Registry 取得）
      updates.push({
        adapter_id: adapter.id,
        current_version: adapter.version,
        latest_version: adapter.version,
        update_available: false,
        update_notes: '已是最新版本',
        download_url: adapter.install_url,
        published_at: adapter.updated_at,
      });
    }

    return c.json({
      updates,
      checked_at: new Date().toISOString(),
    });
  });

  return router;
}
