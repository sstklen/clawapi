// MCP Server 測試
// 測試 MCP 協議正確性、12 個 tools 註冊、tool 呼叫分派

import { describe, it, expect, beforeEach } from 'bun:test';
import { McpServer, createMcpServer, type McpServerDeps, type JsonRpcRequest } from '../server';
import type { Router, RouteResult } from '../../core/router';
import type { KeyPool, KeyListItem } from '../../core/key-pool';
import type { AdapterConfig } from '../../adapters/loader';
import type { EngineStatusDeps } from '../tools/status';

// ===== Mock 工廠 =====

/** 建立 mock Router */
function createMockRouter(overrides?: Partial<Router>): Router {
  return {
    routeRequest: async () => ({
      success: true,
      layer: 'L2' as const,
      serviceId: 'mock-service',
      modelName: 'mock-model',
      data: { choices: [{ message: { content: 'Mock 回應' } }] },
      latency_ms: 100,
    }),
    updateCollectiveIntel: () => {},
    ...overrides,
  } as Router;
}

/** 建立 mock KeyPool */
function createMockKeyPool(overrides?: Partial<KeyPool>): KeyPool {
  return {
    listKeys: async () => [] as KeyListItem[],
    addKey: async () => 1,
    removeKey: async () => {},
    selectKey: async () => null,
    selectKeyWithFallback: async () => null,
    reportSuccess: async () => {},
    reportRateLimit: async () => {},
    reportAuthError: async () => {},
    reportError: async () => {},
    dailyReset: async () => {},
    getServiceIds: () => [],
    ...overrides,
  } as KeyPool;
}

/** 建立 mock AdapterConfig */
function createMockAdapters(): Map<string, AdapterConfig> {
  const adapters = new Map<string, AdapterConfig>();
  adapters.set('groq', {
    schema_version: 1,
    adapter: {
      id: 'groq',
      name: 'Groq',
      version: '1.0.0',
      category: 'llm',
      requires_key: true,
      free_tier: true,
    },
    auth: { type: 'bearer' },
    base_url: 'https://api.groq.com',
    endpoints: {},
  } as AdapterConfig);
  return adapters;
}

/** 建立 mock EngineStatusDeps */
function createMockStatusDeps(): EngineStatusDeps {
  return {
    keyPool: createMockKeyPool(),
    startedAt: new Date(Date.now() - 60_000), // 1 分鐘前
    adapterCount: 1,
    config: { port: 4141, host: '127.0.0.1' },
  };
}

/** 建立完整的 mock deps */
function createMockDeps(overrides?: Partial<McpServerDeps>): McpServerDeps {
  return {
    router: createMockRouter(),
    keyPool: createMockKeyPool(),
    adapters: createMockAdapters(),
    statusDeps: createMockStatusDeps(),
    ...overrides,
  };
}

// ===== 測試套件 =====

describe('MCP Server — 初始化與協議', () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMcpServer(createMockDeps());
  });

  it('應成功建立 MCP Server', () => {
    expect(server).toBeDefined();
    expect(server.isInitialized()).toBe(false);
  });

  it('應正確處理 initialize 請求', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    };

    const response = await server.handleRequest(request);

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();

    const result = response.result as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2024-11-05');
    expect(result['capabilities']).toBeDefined();
    expect((result['serverInfo'] as Record<string, unknown>)['name']).toBe('clawapi');
    expect(server.isInitialized()).toBe(true);
  });

  it('應正確處理 initialized 通知', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialized',
    };

    const response = await server.handleRequest(request);
    expect(response.error).toBeUndefined();
  });

  it('應正確處理 ping', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'ping',
    };

    const response = await server.handleRequest(request);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({});
  });

  it('應對未知方法回傳 -32601', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 4,
      method: 'unknown/method',
    };

    const response = await server.handleRequest(request);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601);
  });
});

describe('MCP Server — tools/list', () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMcpServer(createMockDeps());
  });

  it('應列出全部 12 個 tools', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    };

    const response = await server.handleRequest(request);
    expect(response.error).toBeUndefined();

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(12);

    // 驗證所有 tool 名稱
    const names = result.tools.map(t => t.name);
    expect(names).toContain('llm');
    expect(names).toContain('search');
    expect(names).toContain('translate');
    expect(names).toContain('ask');
    expect(names).toContain('task');
    expect(names).toContain('embeddings');
    expect(names).toContain('image_generate');
    expect(names).toContain('audio_transcribe');
    expect(names).toContain('keys_list');
    expect(names).toContain('keys_add');
    expect(names).toContain('status');
    expect(names).toContain('adapters');
  });

  it('每個 tool 應有正確的 inputSchema', async () => {
    const tools = server.getTools();

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('llm tool 的 required 應包含 prompt', () => {
    const tools = server.getTools();
    const llm = tools.find(t => t.name === 'llm');
    expect(llm).toBeDefined();
    expect(llm!.inputSchema.required).toContain('prompt');
  });

  it('search tool 的 required 應包含 query', () => {
    const tools = server.getTools();
    const search = tools.find(t => t.name === 'search');
    expect(search).toBeDefined();
    expect(search!.inputSchema.required).toContain('query');
  });

  it('translate tool 的 required 應包含 text 和 target_lang', () => {
    const tools = server.getTools();
    const translate = tools.find(t => t.name === 'translate');
    expect(translate).toBeDefined();
    expect(translate!.inputSchema.required).toContain('text');
    expect(translate!.inputSchema.required).toContain('target_lang');
  });

  it('keys_add tool 的 required 應包含 service 和 key', () => {
    const tools = server.getTools();
    const keysAdd = tools.find(t => t.name === 'keys_add');
    expect(keysAdd).toBeDefined();
    expect(keysAdd!.inputSchema.required).toContain('service');
    expect(keysAdd!.inputSchema.required).toContain('key');
  });
});

describe('MCP Server — tools/call 核心 Tools', () => {
  it('應成功呼叫 llm tool', async () => {
    const server = createMcpServer(createMockDeps());

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'llm',
        arguments: { prompt: '你好' },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toBe('Mock 回應');
  });

  it('llm tool 失敗時應回傳錯誤訊息', async () => {
    const router = createMockRouter({
      routeRequest: async () => ({
        success: false,
        layer: 'L2' as const,
        error: '沒有可用的 Key',
        latency_ms: 0,
      }),
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'llm',
        arguments: { prompt: '你好' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('沒有可用的 Key');
  });

  it('應成功呼叫 search tool', async () => {
    const router = createMockRouter({
      routeRequest: async () => ({
        success: true,
        layer: 'L2' as const,
        data: {
          results: [
            { title: '搜尋結果 1', url: 'https://example.com', snippet: '這是摘要' },
          ],
        },
        latency_ms: 200,
      }),
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: { query: 'ClawAPI' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('搜尋結果 1');
    expect(result.content[0]!.text).toContain('https://example.com');
  });

  it('應成功呼叫 translate tool', async () => {
    const router = createMockRouter({
      routeRequest: async () => ({
        success: true,
        layer: 'L2' as const,
        data: { translated_text: 'Hello World' },
        latency_ms: 150,
      }),
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'translate',
        arguments: { text: '你好世界', target_lang: 'en' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toBe('Hello World');
  });

  it('應成功呼叫 ask tool（L3）', async () => {
    const router = createMockRouter({
      routeRequest: async () => ({
        success: true,
        layer: 'L3' as const,
        data: '台北今天 28 度，建議帶傘。',
        latency_ms: 500,
      }),
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ask',
        arguments: { question: '台北今天天氣如何？' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('28 度');
  });

  it('應成功呼叫 task tool（L4）', async () => {
    const router = createMockRouter({
      routeRequest: async () => ({
        success: true,
        layer: 'L4' as const,
        data: '任務已完成：已翻譯 3 篇文章並整理摘要。',
        latency_ms: 2000,
      }),
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'task',
        arguments: { task: '翻譯 3 篇文章並整理摘要', max_steps: 5 },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('任務已完成');
  });

  it('應成功呼叫 embeddings tool', async () => {
    const router = createMockRouter({
      routeRequest: async () => ({
        success: true,
        layer: 'L2' as const,
        data: {
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] }],
        },
        latency_ms: 50,
      }),
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'embeddings',
        arguments: { text: '你好世界' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('維度 6');
  });

  it('應成功呼叫 image_generate tool', async () => {
    const router = createMockRouter({
      routeRequest: async () => ({
        success: true,
        layer: 'L2' as const,
        data: { data: [{ url: 'https://images.example.com/generated.png' }] },
        latency_ms: 3000,
      }),
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'image_generate',
        arguments: { prompt: '一隻可愛的龍蝦', size: '1024x1024' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('https://images.example.com/generated.png');
  });

  it('應成功呼叫 audio_transcribe tool', async () => {
    const router = createMockRouter({
      routeRequest: async () => ({
        success: true,
        layer: 'L2' as const,
        data: { text: '你好，這是一段語音轉文字的測試。' },
        latency_ms: 1000,
      }),
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'audio_transcribe',
        arguments: { file_path: '/tmp/test.mp3', language: 'zh' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('語音轉文字的測試');
  });
});

describe('MCP Server — tools/call 管理 Tools', () => {
  it('keys_list 空池應回傳提示', async () => {
    const server = createMcpServer(createMockDeps());

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'keys_list', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('Key 池為空');
  });

  it('keys_list 有 Key 時應列出狀態', async () => {
    const keyPool = createMockKeyPool({
      listKeys: async () => [
        {
          id: 1,
          service_id: 'groq',
          key_masked: 'gsk_****abcd',
          pool_type: 'king',
          label: '測試用',
          status: 'active',
          priority: 0,
          pinned: false,
          daily_used: 5,
          consecutive_failures: 0,
          rate_limit_until: null,
          last_success_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        } as KeyListItem,
      ],
    });
    const server = createMcpServer(createMockDeps({ keyPool }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'keys_list', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('groq');
    expect(result.content[0]!.text).toContain('gsk_****abcd');
    expect(result.content[0]!.text).toContain('測試用');
  });

  it('keys_add 應成功新增 Key', async () => {
    const keyPool = createMockKeyPool({
      addKey: async () => 42,
    });
    const server = createMcpServer(createMockDeps({ keyPool }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'keys_add',
        arguments: { service: 'groq', key: 'gsk_test12345' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('ID: 42');
    expect(result.content[0]!.text).toContain('groq');
  });

  it('keys_add 失敗時應回傳錯誤訊息', async () => {
    const keyPool = createMockKeyPool({
      addKey: async () => { throw new Error('已達 Key 數量上限（5）'); },
    });
    const server = createMcpServer(createMockDeps({ keyPool }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'keys_add',
        arguments: { service: 'groq', key: 'gsk_test12345' },
      },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('數量上限');
  });

  it('status tool 應回傳引擎狀態', async () => {
    const server = createMcpServer(createMockDeps());

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('ClawAPI 引擎狀態');
    expect(result.content[0]!.text).toContain('127.0.0.1:4141');
  });

  it('adapters tool 應列出已安裝 Adapter', async () => {
    const server = createMcpServer(createMockDeps());

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'adapters', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('Groq');
    expect(result.content[0]!.text).toContain('1 個');
  });

  it('adapters tool 空列表應回傳提示', async () => {
    const server = createMcpServer(createMockDeps({
      adapters: new Map(),
    }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'adapters', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('尚未安裝');
  });
});

describe('MCP Server — 錯誤處理', () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMcpServer(createMockDeps());
  });

  it('缺少 tool 名稱時應回傳 -32602', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {},
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
    expect(response.error!.message).toContain('tool 名稱');
  });

  it('呼叫不存在的 tool 應回傳錯誤', async () => {
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('未知的 tool');
  });

  it('tool 執行拋出異常應被捕獲', async () => {
    const router = createMockRouter({
      routeRequest: async () => { throw new Error('Router 內部錯誤'); },
    });
    const server = createMcpServer(createMockDeps({ router }));

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'llm',
        arguments: { prompt: '測試' },
      },
    });

    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Router 內部錯誤');
  });
});

describe('MCP Server — executeTool 直接呼叫', () => {
  it('應能直接執行 llm tool', async () => {
    const server = createMcpServer(createMockDeps());
    const result = await server.executeTool('llm', { prompt: '測試' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toBe('Mock 回應');
  });

  it('應能直接執行 status tool', async () => {
    const server = createMcpServer(createMockDeps());
    const result = await server.executeTool('status', {});
    expect(result.content[0]!.text).toContain('ClawAPI');
  });

  it('呼叫未知 tool 應拋出錯誤', async () => {
    const server = createMcpServer(createMockDeps());
    await expect(server.executeTool('fake_tool', {})).rejects.toThrow('未知的 tool');
  });
});
