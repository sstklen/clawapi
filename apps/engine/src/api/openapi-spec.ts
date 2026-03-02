// OpenAPI 3.1.0 規格檔（自動產生 JSON 供 Scalar UI 使用）
// 涵蓋 ClawAPI 引擎所有 50+ 端點

import { CLAWAPI_VERSION } from '@clawapi/protocol';

// ===== 共用元件 =====

/** 錯誤回應 schema */
const errorResponse = {
  type: 'object' as const,
  properties: {
    error: { type: 'string', description: '錯誤代碼' },
    message: { type: 'string', description: '人話錯誤描述' },
  },
  required: ['error', 'message'],
};

/** Bearer Token 認證 */
const bearerAuth = {
  type: 'http' as const,
  scheme: 'bearer',
  description: '使用 auth.token（主金鑰）或 sk_live_*（Sub-Key）進行認證',
};

/** 401 回應 */
const unauthorized = {
  description: '未認證 — Token 無效或未提供',
  content: { 'application/json': { schema: errorResponse } },
};

/** 403 回應 */
const forbidden = {
  description: '權限不足 — Sub-Key 無權存取此端點',
  content: { 'application/json': { schema: errorResponse } },
};

// ===== 產生 OpenAPI 規格 =====

export function generateOpenAPISpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'ClawAPI Engine',
      version: CLAWAPI_VERSION,
      description: `🦞 開源 AI API 鑰匙管理器 + 智慧路由器

ClawAPI 是一個本機運行的 AI API 閘道器，提供：
- **OpenAI 相容 API**：直接替換 OpenAI SDK 的 base_url 即可使用
- **智慧路由**：L1 直轉 → L2 跨服務 → L3 AI 助手 → L4 任務引擎
- **Key 池管理**：多把 Key 輪流用，壞了自動切換
- **額度池**：用量統計、成本估算、省錢建議

## 認證

所有 \`/v1/*\` 和 \`/api/*\` 端點需要 Bearer Token 認證：
\`\`\`
Authorization: Bearer {your-token}
\`\`\`

Token 類型：
- **主金鑰**（auth.token）：完整存取所有端點
- **Sub-Key**（sk_live_*）：受限存取，僅限指定服務/模型`,
      contact: {
        name: 'ClawAPI',
        url: 'https://github.com/nicholasgasior/clawapi',
      },
      license: {
        name: 'AGPL-3.0',
        url: 'https://www.gnu.org/licenses/agpl-3.0.html',
      },
    },
    servers: [
      {
        url: 'http://localhost:11434',
        description: '本機開發（預設 port）',
      },
    ],
    tags: [
      { name: 'Health', description: '健康檢查' },
      { name: 'Chat', description: 'OpenAI 相容聊天 API' },
      { name: 'Models', description: '模型管理' },
      { name: 'Embeddings', description: '向量嵌入' },
      { name: 'Images', description: '圖片生成' },
      { name: 'Audio', description: '語音處理' },
      { name: 'Files', description: '檔案管理' },
      { name: 'Simplified', description: 'ClawAPI 簡化 API' },
      { name: 'Keys', description: 'API Key 管理（限主金鑰）' },
      { name: 'Sub-Keys', description: 'Sub-Key 管理（限主金鑰）' },
      { name: 'Gold Keys', description: 'Gold Key 管理（限主金鑰）' },
      { name: 'System', description: '系統狀態與設定' },
      { name: 'Logs', description: '使用紀錄與分析' },
      { name: 'Aid', description: '互助網路（限主金鑰）' },
      { name: 'Events', description: '即時事件推送（SSE）' },
    ],
    components: {
      securitySchemes: {
        BearerAuth: bearerAuth,
      },
      schemas: {
        Error: errorResponse,
        // ChatCompletion 相關 schema
        ChatCompletionRequest: {
          type: 'object',
          required: ['model', 'messages'],
          properties: {
            model: { type: 'string', description: '模型名稱（auto = 智慧路由）', example: 'auto' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
                  content: { type: 'string' },
                },
              },
            },
            stream: { type: 'boolean', default: false, description: '是否啟用 SSE 串流' },
            temperature: { type: 'number', minimum: 0, maximum: 2, description: '隨機性（0=確定性，2=最隨機）' },
            max_tokens: { type: 'integer', minimum: 1, description: '最大生成 token 數' },
            top_p: { type: 'number', minimum: 0, maximum: 1 },
            tools: { type: 'array', items: { type: 'object' }, description: 'Function calling 工具定義' },
            tool_choice: { type: 'string', description: '工具選擇策略' },
            x_strategy: {
              type: 'string',
              enum: ['fastest', 'cheapest', 'quality', 'balanced'],
              description: 'ClawAPI 路由策略',
            },
          },
        },
        ChatCompletionResponse: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', const: 'chat.completion' },
            created: { type: 'integer' },
            model: { type: 'string' },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  message: {
                    type: 'object',
                    properties: {
                      role: { type: 'string' },
                      content: { type: 'string' },
                    },
                  },
                  finish_reason: { type: 'string' },
                },
              },
            },
            usage: {
              type: 'object',
              properties: {
                prompt_tokens: { type: 'integer' },
                completion_tokens: { type: 'integer' },
                total_tokens: { type: 'integer' },
              },
            },
            x_clawapi: {
              type: 'object',
              description: 'ClawAPI 擴充資訊',
              properties: {
                requested_model: { type: 'string' },
                actual_model: { type: 'string' },
                service_id: { type: 'string' },
                layer: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'] },
                latency_ms: { type: 'number' },
                key_source: { type: 'string' },
                retry_count: { type: 'integer' },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        // Model 相關
        Model: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '模型 ID' },
            object: { type: 'string', const: 'model' },
            created: { type: 'integer' },
            owned_by: { type: 'string' },
          },
        },
        // Key 相關
        KeyListItem: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            service_id: { type: 'string', example: 'openai' },
            key_masked: { type: 'string', example: 'sk-****abcd' },
            pool_type: { type: 'string', enum: ['king', 'friend'] },
            status: { type: 'string', enum: ['active', 'rate_limited', 'dead'] },
            pinned: { type: 'boolean' },
            daily_used: { type: 'integer' },
            consecutive_failures: { type: 'integer' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        CreateKeyRequest: {
          type: 'object',
          required: ['service_id', 'key_value'],
          properties: {
            service_id: { type: 'string', description: '服務 ID', example: 'openai' },
            key_value: { type: 'string', description: 'API Key 原文（存入後會加密）', example: 'sk-...' },
            pool_type: { type: 'string', enum: ['king', 'friend'], default: 'king' },
            label: { type: 'string', description: '標籤（可選）' },
          },
        },
        // Sub-Key 相關
        SubKey: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            token_preview: { type: 'string', example: 'sk_live_****abcd' },
            label: { type: 'string' },
            daily_limit: { type: 'integer', nullable: true },
            allowed_services: { type: 'array', items: { type: 'string' }, nullable: true },
            is_active: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        CreateSubKeyRequest: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '標籤' },
            daily_limit: { type: 'integer', nullable: true, description: '每日使用上限（null=無限）' },
            allowed_services: {
              type: 'array', items: { type: 'string' }, nullable: true,
              description: '允許的服務清單（null=全部）',
            },
            allowed_models: {
              type: 'array', items: { type: 'string' }, nullable: true,
              description: '允許的模型清單（null=全部）',
            },
          },
        },
        // 簡化 API 相關
        LlmRequest: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string', description: '提示文字' },
            model: { type: 'string', default: 'auto', description: '模型名稱' },
            options: {
              type: 'object',
              properties: {
                temperature: { type: 'number' },
                max_tokens: { type: 'integer' },
                top_p: { type: 'number' },
              },
            },
          },
        },
        LlmResponse: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            model: { type: 'string' },
            tokens: { type: 'integer' },
            latency_ms: { type: 'number' },
          },
        },
        // 系統狀態
        EngineStatus: {
          type: 'object',
          properties: {
            version: { type: 'string' },
            uptime_seconds: { type: 'number' },
            total_keys: { type: 'integer' },
            active_keys: { type: 'integer' },
            services: { type: 'array', items: { type: 'string' } },
            total_requests: { type: 'integer' },
            l0_enabled: { type: 'boolean' },
          },
        },
      },
    },
    security: [{ BearerAuth: [] }],
    paths: {
      // ========== Health ==========
      '/health': {
        get: {
          tags: ['Health'],
          summary: '健康檢查',
          description: '無需認證，用於負載均衡器健康探測',
          security: [],
          responses: {
            200: {
              description: '健康',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', const: 'ok' },
                      version: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/health': {
        get: {
          tags: ['Health'],
          summary: '健康檢查（OpenAI 相容路徑）',
          security: [],
          responses: {
            200: { description: '健康' },
          },
        },
      },

      // ========== Chat ==========
      '/v1/chat/completions': {
        post: {
          tags: ['Chat'],
          summary: '聊天補全（OpenAI 相容）',
          description: `建立聊天補全。支援串流（stream=true）和非串流模式。

使用 \`model: "auto"\` 啟用 ClawAPI 智慧路由（L2），自動選擇最適合的模型和服務。

**ClawAPI 擴充 Header：**
- \`X-ClawAPI-Service\`：使用的服務 ID
- \`X-ClawAPI-Model\`：實際使用的模型
- \`X-ClawAPI-Layer\`：路由層級（L1-L4）
- \`X-ClawAPI-Latency\`：端到端延遲（ms）`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
              },
            },
          },
          responses: {
            200: {
              description: '成功',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatCompletionResponse' },
                },
                'text/event-stream': {
                  schema: { type: 'string', description: 'SSE 串流（data: {...}\\n\\n 格式）' },
                },
              },
            },
            401: unauthorized,
            429: { description: '所有 Key 都被限速' },
            503: { description: '無可用的 Key 或服務' },
          },
        },
      },

      // ========== Models ==========
      '/v1/models': {
        get: {
          tags: ['Models'],
          summary: '列出可用模型',
          description: '回傳所有已載入 Adapter 的模型清單',
          responses: {
            200: {
              description: '成功',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      object: { type: 'string', const: 'list' },
                      data: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
                    },
                  },
                },
              },
            },
            401: unauthorized,
          },
        },
      },

      // ========== Embeddings ==========
      '/v1/embeddings': {
        post: {
          tags: ['Embeddings'],
          summary: '生成向量嵌入',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'input'],
                  properties: {
                    model: { type: 'string', example: 'text-embedding-3-small' },
                    input: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } },
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '成功' },
            401: unauthorized,
          },
        },
      },

      // ========== Images ==========
      '/v1/images/generations': {
        post: {
          tags: ['Images'],
          summary: '生成圖片',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['prompt'],
                  properties: {
                    model: { type: 'string', default: 'dall-e-3' },
                    prompt: { type: 'string' },
                    n: { type: 'integer', default: 1 },
                    size: { type: 'string', enum: ['256x256', '512x512', '1024x1024'], default: '1024x1024' },
                    response_format: { type: 'string', enum: ['url', 'b64_json'], default: 'url' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '成功' },
            401: unauthorized,
          },
        },
      },

      // ========== Audio ==========
      '/v1/audio/transcriptions': {
        post: {
          tags: ['Audio'],
          summary: '語音轉文字',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'model'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    model: { type: 'string', default: 'whisper-1' },
                    language: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '成功' },
            401: unauthorized,
          },
        },
      },
      '/v1/audio/speech': {
        post: {
          tags: ['Audio'],
          summary: '文字轉語音',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'input', 'voice'],
                  properties: {
                    model: { type: 'string', default: 'tts-1' },
                    input: { type: 'string' },
                    voice: { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
                    speed: { type: 'number', minimum: 0.25, maximum: 4.0, default: 1.0 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '音訊串流', content: { 'audio/mpeg': {} } },
            401: unauthorized,
          },
        },
      },

      // ========== Files ==========
      '/v1/files': {
        post: {
          tags: ['Files'],
          summary: '上傳檔案',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'purpose'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    purpose: { type: 'string', enum: ['fine-tune', 'assistants', 'batch'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized },
        },
        get: {
          tags: ['Files'],
          summary: '列出已上傳檔案',
          responses: { 200: { description: '成功' }, 401: unauthorized },
        },
      },
      '/v1/files/{file_id}': {
        get: {
          tags: ['Files'],
          summary: '取得檔案資訊',
          parameters: [{ name: 'file_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: '成功' }, 401: unauthorized },
        },
        delete: {
          tags: ['Files'],
          summary: '刪除檔案',
          parameters: [{ name: 'file_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: '成功' }, 401: unauthorized },
        },
      },

      // ========== 簡化 API ==========
      '/api/llm': {
        post: {
          tags: ['Simplified'],
          summary: '簡化 LLM 呼叫',
          description: '一行 prompt 就能呼叫 LLM，回傳純文字 + 用量統計',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LlmRequest' },
              },
            },
          },
          responses: {
            200: {
              description: '成功',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/LlmResponse' } },
              },
            },
            401: unauthorized,
          },
        },
      },
      '/api/search': {
        post: {
          tags: ['Simplified'],
          summary: '簡化搜尋',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query'],
                  properties: {
                    query: { type: 'string' },
                    engine: { type: 'string', default: 'auto' },
                    max_results: { type: 'integer', default: 5 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized },
        },
      },
      '/api/translate': {
        post: {
          tags: ['Simplified'],
          summary: '簡化翻譯',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['text', 'target'],
                  properties: {
                    text: { type: 'string' },
                    source: { type: 'string', description: '原文語言代碼' },
                    target: { type: 'string', description: '目標語言代碼', example: 'zh-TW' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized },
        },
      },
      '/api/ask': {
        post: {
          tags: ['Simplified'],
          summary: 'L3 AI 助手',
          description: '結合搜尋 + LLM 的一站式問答，自動決定是否需要搜尋',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['question'],
                  properties: {
                    question: { type: 'string' },
                    context: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized },
        },
      },
      '/api/task': {
        post: {
          tags: ['Simplified'],
          summary: 'L4 任務引擎',
          description: '提交複雜任務，引擎自動拆解為多步驟執行',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['task'],
                  properties: {
                    task: { type: 'string', description: '任務描述' },
                    steps: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized },
        },
      },

      // ========== Key 管理 ==========
      '/api/keys': {
        get: {
          tags: ['Keys'],
          summary: '列出所有 Key（遮罩）',
          description: 'Key 值會被遮罩（前 4 + 後 4 字元），不會暴露完整 Key',
          parameters: [
            { name: 'service_id', in: 'query', schema: { type: 'string' }, description: '篩選服務' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'rate_limited', 'dead'] } },
          ],
          responses: {
            200: {
              description: '成功',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/KeyListItem' } },
                },
              },
            },
            401: unauthorized,
            403: forbidden,
          },
        },
        post: {
          tags: ['Keys'],
          summary: '新增 Key',
          description: 'Key 值在存入前會用 AES-256-GCM 加密',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateKeyRequest' } },
            },
          },
          responses: {
            201: { description: '已建立' },
            400: { description: '參數錯誤或 Key 數量已達上限' },
            401: unauthorized,
            403: forbidden,
          },
        },
      },
      '/api/keys/{id}': {
        delete: {
          tags: ['Keys'],
          summary: '刪除 Key',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            200: { description: '已刪除' },
            401: unauthorized,
            403: forbidden,
            404: { description: 'Key 不存在' },
          },
        },
      },
      '/api/keys/{id}/pin': {
        put: {
          tags: ['Keys'],
          summary: '釘選/取消釘選 Key',
          description: '釘選的 Key 在路由選取時優先使用',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['pinned'],
                  properties: { pinned: { type: 'boolean' } },
                },
              },
            },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/keys/{id}/rotate': {
        put: {
          tags: ['Keys'],
          summary: '輪換 Key',
          description: '用新 Key 替換舊 Key，保留原有設定',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['new_key_value'],
                  properties: { new_key_value: { type: 'string' } },
                },
              },
            },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },

      // ========== Sub-Key 管理 ==========
      '/api/sub-keys': {
        get: {
          tags: ['Sub-Keys'],
          summary: '列出 Sub-Key',
          responses: {
            200: {
              description: '成功',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/SubKey' } },
                },
              },
            },
            401: unauthorized,
            403: forbidden,
          },
        },
        post: {
          tags: ['Sub-Keys'],
          summary: '發行 Sub-Key',
          description: '建立受限的 API Token，可指定服務/模型/日限額',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateSubKeyRequest' } },
            },
          },
          responses: {
            201: {
              description: '已建立（回傳完整 token，僅此一次）',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      token: { type: 'string', description: '完整 Sub-Key（僅顯示一次）' },
                      id: { type: 'integer' },
                    },
                  },
                },
              },
            },
            401: unauthorized,
            403: forbidden,
          },
        },
      },
      '/api/sub-keys/{id}': {
        delete: {
          tags: ['Sub-Keys'],
          summary: '撤銷 Sub-Key',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: '已撤銷' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/sub-keys/{id}/usage': {
        get: {
          tags: ['Sub-Keys'],
          summary: '查詢 Sub-Key 用量',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },

      // ========== Gold Key 管理 ==========
      '/api/gold-keys': {
        get: {
          tags: ['Gold Keys'],
          summary: '列出 Gold Key',
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
        post: {
          tags: ['Gold Keys'],
          summary: '設定 Gold Key',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['service_id'],
                  properties: {
                    service_id: { type: 'string' },
                    config: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: '已建立' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/gold-keys/{id}': {
        delete: {
          tags: ['Gold Keys'],
          summary: '移除 Gold Key',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: '已移除' }, 401: unauthorized, 403: forbidden },
        },
      },

      // ========== 系統 ==========
      '/api/status': {
        get: {
          tags: ['System'],
          summary: '引擎狀態',
          responses: {
            200: {
              description: '成功',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/EngineStatus' } },
              },
            },
            401: unauthorized,
          },
        },
      },
      '/api/adapters': {
        get: {
          tags: ['System'],
          summary: '列出已載入的 Adapter',
          description: '顯示所有支援的 AI 服務及其能力',
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/adapters/install': {
        post: {
          tags: ['System'],
          summary: '安裝社群 Adapter',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: { type: 'string', description: 'Adapter YAML 的 URL' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '安裝成功' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/adapters/{id}': {
        delete: {
          tags: ['System'],
          summary: '移除 Adapter',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: '已移除' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/settings': {
        get: {
          tags: ['System'],
          summary: '取得引擎設定',
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
        put: {
          tags: ['System'],
          summary: '更新引擎設定',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },

      // ========== 紀錄 ==========
      '/api/logs': {
        get: {
          tags: ['Logs'],
          summary: '查詢使用紀錄',
          parameters: [
            { name: 'service_id', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/logs/export': {
        get: {
          tags: ['Logs'],
          summary: '匯出使用紀錄（CSV）',
          responses: {
            200: { description: 'CSV 檔案', content: { 'text/csv': {} } },
            401: unauthorized,
            403: forbidden,
          },
        },
      },
      '/api/telemetry/pending': {
        get: {
          tags: ['Logs'],
          summary: '查看待上傳遙測資料',
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/telemetry/enabled': {
        put: {
          tags: ['Logs'],
          summary: '開關遙測',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['enabled'],
                  properties: { enabled: { type: 'boolean' } },
                },
              },
            },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },

      // ========== 互助 ==========
      '/api/aid/config': {
        get: {
          tags: ['Aid'],
          summary: '取得互助設定',
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
        put: {
          tags: ['Aid'],
          summary: '更新互助設定',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/aid/stats': {
        get: {
          tags: ['Aid'],
          summary: '互助統計',
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },

      // ========== 備份 ==========
      '/api/backup/export': {
        post: {
          tags: ['System'],
          summary: '匯出加密備份',
          description: '⚠️ 尚未實作（回傳 501）',
          responses: { 501: { description: '尚未實作' }, 401: unauthorized, 403: forbidden },
        },
      },
      '/api/backup/import': {
        post: {
          tags: ['System'],
          summary: '匯入備份',
          description: '⚠️ 尚未實作（回傳 501）',
          responses: { 501: { description: '尚未實作' }, 401: unauthorized, 403: forbidden },
        },
      },

      // ========== L0 ==========
      '/api/l0/status': {
        get: {
          tags: ['System'],
          summary: 'L0 免費額度狀態',
          responses: { 200: { description: '成功' }, 401: unauthorized, 403: forbidden },
        },
      },

      // ========== Events（SSE） ==========
      '/api/events': {
        get: {
          tags: ['Events'],
          summary: '即時事件推送（SSE）',
          description: `使用 Server-Sent Events 推送即時通知。

事件類型：
- \`key_status_change\`：Key 狀態變更
- \`request_completed\`：API 請求完成
- \`aid_event\`：互助事件
- \`l0_update\`：L0 額度更新
- \`notification\`：系統通知`,
          responses: {
            200: {
              description: 'SSE 串流',
              content: { 'text/event-stream': {} },
            },
            401: unauthorized,
          },
        },
      },
    },
  };
}
