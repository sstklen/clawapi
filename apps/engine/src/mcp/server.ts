// MCP Server 主入口
// 使用 JSON-RPC over stdio 實作 MCP 協議
// 在引擎啟動時可作為 MCP Server 模式啟動（clawapi mcp）
//
// MCP 設定範例：
// {
//   "mcpServers": {
//     "clawapi": {
//       "command": "clawapi",
//       "args": ["mcp"],
//       "env": {}
//     }
//   }
// }

import { getEngineVersion } from '../version';
import type { Router } from '../core/router';
import type { KeyPool } from '../core/key-pool';
import type { AdapterConfig } from '../adapters/loader';

// 引入所有 tool 定義
import { llmToolSchema, executeLlmTool, type LlmToolInput } from './tools/llm';
import { searchToolSchema, executeSearchTool, type SearchToolInput } from './tools/search';
import { translateToolSchema, executeTranslateTool, type TranslateToolInput } from './tools/translate';
import { askToolSchema, executeAskTool, type AskToolInput } from './tools/ask';
import { taskToolSchema, executeTaskTool, type TaskToolInput } from './tools/task';
import { embeddingsToolSchema, executeEmbeddingsTool, type EmbeddingsToolInput } from './tools/embeddings';
import { imageGenerateToolSchema, executeImageGenerateTool, type ImageGenerateToolInput } from './tools/image';
import { audioTranscribeToolSchema, executeAudioTranscribeTool, type AudioTranscribeToolInput } from './tools/audio';
import { keysListToolSchema, keysAddToolSchema, executeKeysListTool, executeKeysAddTool, type KeysListToolInput, type KeysAddToolInput } from './tools/keys';
import { statusToolSchema, executeStatusTool, type EngineStatusDeps } from './tools/status';
import { adaptersToolSchema, executeAdaptersTool } from './tools/adapters';
import { setupWizardToolSchema, executeSetupWizardTool, type SetupWizardToolInput } from './tools/setup-wizard';
import { growthGuideToolSchema, executeGrowthGuideTool, type GrowthGuideToolInput } from './tools/growth-guide';
import type { GrowthEngine } from '../growth/engine';
import type { SubKeyManager } from '../sharing/sub-key';
import type { CostEngine } from '../growth/cost-engine';

// ===== 型別定義（JSON-RPC 2.0 + MCP） =====

/** JSON-RPC 2.0 請求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 回應 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** MCP Tool 定義 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP Server 依賴注入 */
export interface McpServerDeps {
  router: Router;
  keyPool: KeyPool;
  adapters: Map<string, AdapterConfig>;
  statusDeps: EngineStatusDeps;
  /** 成長引擎（可選，向後相容） */
  growthEngine?: GrowthEngine;
  /** Sub-Key 管理器（可選，Claw Key 用） */
  subKeyManager?: SubKeyManager;
  /** 成本引擎（可選，成本分析用） */
  costEngine?: CostEngine;
  /** 資料庫（可選，接力棒系統用） */
  db?: import('../storage/database').ClawDatabase;
}

// ===== MCP 指令（告訴 AI 該怎麼用 ClawAPI） =====

/**
 * MCP Instructions — 啟動時注入到 AI 的行為指南
 *
 * 這段文字會在 MCP initialize 時傳給 AI，
 * 讓它知道 ClawAPI 是什麼、該做什麼、怎麼主動引導用戶。
 * 不寫這個，AI 就只會被動等指令。
 */
const MCP_INSTRUCTIONS = `你已連接到 ClawAPI — 一個 AI API Key 管理器和智慧路由器。

## 你的角色
你是用戶的 ClawAPI 助手。主動幫助用戶設定和使用 ClawAPI，不要被動等指令。

## 首次設定（最重要！）
當用戶第一次提到 ClawAPI、說「設定」「啟動」「開始」「set up」「get started」，
或你發現 Key 池是空的時，**立刻執行**：

  setup_wizard(action="auto")

這會自動：掃描環境找 API Key → 驗證 → 匯入 → 產生萬用 Claw Key。
不要問用戶「要不要設定」，直接做。這是一鍵全自動的體驗。

## 日常使用
- 用戶問「狀態」「怎麼樣了」→ status
- 用戶問「還能加什麼」「推薦」「下一步」→ growth_guide(view="recommend")
- 用戶遇到限速或額度問題 → growth_guide(view="pool")
- 用戶想了解使用情況 → growth_guide(view="intel")
- 用戶想加 Key → keys_add(service, key)
- 用戶想搜尋 → search(query)
- 用戶想翻譯 → translate(text, target_lang)
- 用戶想用 AI → llm(prompt)

## 溝通風格
- 用繁體中文回答（除非用戶用其他語言）
- 簡潔有力，不囉嗦
- 主動推薦下一步，不要只回答問題就結束
`;

// ===== MCP Server 類別 =====

/**
 * ClawAPI MCP Server
 *
 * 實作 MCP 協議（JSON-RPC 2.0 over stdio）
 * 支援 12 個 tools：8 核心 + 4 管理
 *
 * 生命週期：
 * 1. initialize → 回傳 server info
 * 2. tools/list → 回傳所有 tool 定義
 * 3. tools/call → 執行指定 tool
 */
export class McpServer {
  private initialized = false;
  private tools: McpTool[];
  private buffer = '';

  constructor(private deps: McpServerDeps) {
    // 註冊所有 14 個 tools（12 核心 + 2 成長引導）
    this.tools = [
      llmToolSchema,
      searchToolSchema,
      translateToolSchema,
      askToolSchema,
      taskToolSchema,
      embeddingsToolSchema,
      imageGenerateToolSchema,
      audioTranscribeToolSchema,
      keysListToolSchema,
      keysAddToolSchema,
      statusToolSchema,
      adaptersToolSchema,
      setupWizardToolSchema,
      growthGuideToolSchema,
    ];
  }

  // ===== 公開方法 =====

  /**
   * 啟動 MCP Server（stdio 模式）
   * 監聽 stdin，寫入 stdout
   */
  async start(): Promise<void> {
    // 監聽 stdin 輸入
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    process.stdin.on('end', () => {
      process.exit(0);
    });

    // 避免 stdout 出錯時崩潰
    process.stdout.on('error', () => {
      process.exit(1);
    });
  }

  /**
   * 處理單一 JSON-RPC 請求
   * 公開方法以便測試
   */
  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;

    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(id);

        case 'initialized':
          // 通知類型，不需回傳
          return { jsonrpc: '2.0', id, result: {} };

        case 'tools/list':
          return this.handleToolsList(id);

        case 'tools/call':
          return await this.handleToolsCall(id, request.params);

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `未知方法：${request.method}`,
            },
          };
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `內部錯誤：${(err as Error).message}`,
        },
      };
    }
  }

  // ===== 方法處理器 =====

  /**
   * 處理 initialize 請求
   * 回傳 server info + instructions（告訴 AI 該做什麼）
   */
  private handleInitialize(id: string | number | null): JsonRpcResponse {
    this.initialized = true;

    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'clawapi',
          version: getEngineVersion(),
        },
        instructions: MCP_INSTRUCTIONS,
      },
    };
  }

  /**
   * 處理 tools/list 請求
   */
  private handleToolsList(id: string | number | null): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: this.tools,
      },
    };
  }

  /**
   * 處理 tools/call 請求
   */
  private async handleToolsCall(
    id: string | number | null,
    params?: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const toolName = params?.['name'] as string | undefined;
    const toolArgs = (params?.['arguments'] ?? {}) as Record<string, unknown>;

    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: '缺少 tool 名稱',
        },
      };
    }

    try {
      const result = await this.executeTool(toolName, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result,
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{
            type: 'text',
            text: `Tool 執行失敗：${(err as Error).message}`,
          }],
          isError: true,
        },
      };
    }
  }

  // ===== Tool 分派 =====

  /**
   * 根據 tool 名稱分派到對應的執行函式
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    switch (name) {
      case 'llm':
        return executeLlmTool(args as unknown as LlmToolInput, this.deps.router);

      case 'search':
        return executeSearchTool(args as unknown as SearchToolInput, this.deps.router);

      case 'translate':
        return executeTranslateTool(args as unknown as TranslateToolInput, this.deps.router);

      case 'ask':
        return executeAskTool(args as unknown as AskToolInput, this.deps.router);

      case 'task':
        return executeTaskTool(args as unknown as TaskToolInput, this.deps.router);

      case 'embeddings':
        return executeEmbeddingsTool(args as unknown as EmbeddingsToolInput, this.deps.router);

      case 'image_generate':
        return executeImageGenerateTool(args as unknown as ImageGenerateToolInput, this.deps.router);

      case 'audio_transcribe':
        return executeAudioTranscribeTool(args as unknown as AudioTranscribeToolInput, this.deps.router);

      case 'keys_list':
        return executeKeysListTool(args as unknown as KeysListToolInput, this.deps.keyPool);

      case 'keys_add':
        return executeKeysAddTool(
          args as unknown as KeysAddToolInput,
          this.deps.keyPool,
          this.deps.growthEngine && this.deps.db
            ? { db: this.deps.db, growthEngine: this.deps.growthEngine }
            : undefined
        );

      case 'status':
        return executeStatusTool({}, this.deps.statusDeps);

      case 'adapters':
        return executeAdaptersTool({}, this.deps.adapters);

      case 'setup_wizard':
        return executeSetupWizardTool(args as unknown as SetupWizardToolInput, {
          keyPool: this.deps.keyPool,
          adapters: this.deps.adapters,
          subKeyManager: this.deps.subKeyManager,
          db: this.deps.db,
          growthEngine: this.deps.growthEngine,
        });

      case 'growth_guide':
        return executeGrowthGuideTool(
          args as unknown as GrowthGuideToolInput,
          this.deps.growthEngine,
          this.deps.costEngine,
          this.deps.keyPool
        );

      default:
        throw new Error(`未知的 tool：${name}`);
    }
  }

  // ===== stdio 通訊 =====

  /**
   * 處理 stdin buffer，解析並執行完整的 JSON-RPC 訊息
   * MCP 使用換行符分隔的 JSON 訊息
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // 最後一行可能不完整，保留
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request = JSON.parse(trimmed) as JsonRpcRequest;
        this.handleRequest(request).then(response => {
          // 通知類型（id 為 undefined）不需回傳
          if (request.id !== undefined) {
            this.sendResponse(response);
          }
        }).catch(err => {
          this.sendResponse({
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: {
              code: -32603,
              message: `處理請求時發生錯誤：${(err as Error).message}`,
            },
          });
        });
      } catch {
        // JSON 解析錯誤
        this.sendResponse({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: '無效的 JSON',
          },
        });
      }
    }
  }

  /**
   * 寫入 JSON-RPC 回應到 stdout
   */
  private sendResponse(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    process.stdout.write(json + '\n');
  }

  // ===== 輔助方法 =====

  /** 取得已註冊的 tools 清單（測試用） */
  getTools(): McpTool[] {
    return [...this.tools];
  }

  /** 是否已初始化（測試用） */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// ===== 工廠函式 =====

/**
 * 建立 MCP Server 實例
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  return new McpServer(deps);
}
