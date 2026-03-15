// L3 AI 管家層（L3 Concierge）
// 當 model='ask' 時觸發
// 使用Claw Key（Claw Key）作為 AI 大腦，解讀意圖、規劃步驟、整合結果
// 每一步透過 L2 路由引擎執行（享受 Failover 保護）

import type { KeyPool, DecryptedKey } from '../core/key-pool';
import type { AdapterExecutor } from '../adapters/executor';
import type { AdapterConfig } from '../adapters/loader';
import type { L2Gateway } from './l2-gateway';

// ===== 型別定義 =====

/** 執行步驟定義（LLM 回傳的規劃） */
export interface IntentStep {
  /** 使用的工具（對應 Adapter ID） */
  tool: string;
  /** 傳給工具的參數 */
  params: Record<string, unknown>;
  /** 依賴的前置步驟索引（[] 表示無依賴） */
  depends_on: number[];
}

/** LLM 解析意圖的回傳結構 */
export interface IntentResult {
  /** 對用戶意圖的理解說明 */
  understanding: string;
  /** 規劃的執行步驟 */
  steps: IntentStep[];
}

/** LLM 要求澄清的回傳結構 */
export interface ClarificationResult {
  /** 需要用戶回答的問題 */
  clarification: string;
}

/** LLM 回傳的原始 JSON（可能是意圖或澄清） */
export type LLMIntentResponse = IntentResult | ClarificationResult;

/** 單一步驟的執行結果 */
export interface StepResult {
  /** 步驟索引 */
  index: number;
  /** 使用的工具 */
  tool: string;
  /** 是否成功 */
  success: boolean;
  /** 執行結果資料 */
  data?: unknown;
  /** 錯誤訊息 */
  error?: string;
  /** 消耗的 token 數（若工具回傳） */
  tokens?: number;
  /** 延遲時間（ms） */
  latency_ms: number;
}

/** L3 消耗報告 */
export interface L3UsageReport {
  /** Claw Key消耗的 token 總數 */
  claw_key_tokens: number;
  /** 各步驟的消耗明細 */
  steps: Array<{
    tool: string;
    tokens: number;
  }>;
}

/** L3 請求 */
export interface L3Request {
  /** 用戶輸入的訊息（對話歷史） */
  messages: Array<{ role: string; content: string }>;
  /** 傳給後端的額外參數 */
  params?: Record<string, unknown>;
}

/** L3 回應 */
export interface L3Response {
  /** 是否成功 */
  success: boolean;
  /** 最終整合回答（成功時） */
  answer?: string;
  /** 澄清問題（LLM 無法確定意圖時） */
  clarification?: string;
  /** 錯誤訊息（失敗時） */
  error?: string;
  /** 錯誤建議（例如如何設定Claw Key） */
  suggestion?: string;
  /** 消耗報告 */
  usage?: L3UsageReport;
  /** 延遲時間（ms） */
  latency_ms: number;
  /** 意圖理解說明（成功時） */
  understanding?: string;
  /** 各步驟執行結果（除錯用） */
  step_results?: StepResult[];
}

/** Claw Key資訊（含每日額度）*/
export interface ClawKeyInfo {
  /** 解密後的Claw Key */
  key: DecryptedKey;
  /** 今日已使用 token 數 */
  daily_tokens_used: number;
  /** 今日 token 上限（0 表示無限制） */
  daily_token_limit: number;
}

// ===== System Prompt 模板 =====

/**
 * L3 意圖解讀用的 System Prompt 模板
 * {{available_tools}} 會被替換為當前已安裝的 Adapter 清單
 */
const INTENT_SYSTEM_PROMPT_TEMPLATE = `你是 ClawAPI 的 AI 管家（L3 Concierge）。
你的任務是理解用戶的請求，並規劃如何使用以下工具來完成它。

可用工具清單：
{{available_tools}}

請分析用戶的請求，然後回傳以下格式的 JSON：

若可以理解意圖：
{
  "understanding": "用戶想要...",
  "steps": [
    {"tool": "工具ID", "params": {"參數名": "參數值"}, "depends_on": []},
    {"tool": "工具ID", "params": {"參數名": "前一步結果"}, "depends_on": [0]}
  ]
}

若無法確定意圖，需要用戶澄清：
{
  "clarification": "請問您的具體需求是...？"
}

規則：
1. depends_on 陣列填寫前置步驟的「索引編號」（從 0 開始）
2. 無依賴的步驟填寫 []（空陣列），可以並行執行
3. 工具 ID 必須從「可用工具清單」中選取
4. 只回傳 JSON，不要有其他文字

請用繁體中文回應 understanding 和 clarification 欄位。`;

/**
 * L3 結果整合用的 System Prompt
 */
const SYNTHESIS_SYSTEM_PROMPT = `你是 ClawAPI 的 AI 管家（L3 Concierge）。
你已經執行了一系列工具來協助用戶，現在請根據執行結果給出最終回答。

請整合所有工具的執行結果，給出清晰、有用的回答。
用繁體中文回答，語氣自然親切。
如果某個步驟失敗了，請在回答中說明，並提供可用的資訊。`;

// ===== L3Concierge 主類別 =====

/**
 * L3 AI 管家
 *
 * 流程：
 * 1. 檢查Claw Key是否存在且有額度
 * 2. 用Claw Key呼叫 LLM 解讀意圖（含可用工具清單）
 * 3. 若 LLM 要求澄清 → 直接回傳問題
 * 4. 依 DAG 排序執行步驟（無依賴並行、有依賴序列）
 *    每步透過 L2 路由引擎呼叫（享受 Failover）
 * 5. 用Claw Key LLM 整合所有結果
 * 6. 回傳含消耗報告的最終結果
 */
export class L3Concierge {
  /** Claw Key服務 ID（固定服務 ID，用來選取Claw Key） */
  private static readonly CLAW_KEY_SERVICE_ID = '__claw_key__';

  /** 額度降級閾值：剩餘 5% 時開始降級到 L2 */
  private static readonly QUOTA_DEGRADATION_THRESHOLD = 0.05;

  constructor(
    /** Key 池管理器 */
    private readonly keyPool: KeyPool,
    /** Adapter 執行器 */
    private readonly executor: AdapterExecutor,
    /** 已安裝的 Adapter Map */
    private readonly adapters: Map<string, AdapterConfig>,
    /** L2 路由引擎（用於執行各步驟） */
    private readonly l2Gateway: L2Gateway
  ) {}

  // ===== 公開方法 =====

  /**
   * 執行 L3 AI 管家請求
   *
   * @param req L3 請求物件
   * @returns L3 回應
   */
  async execute(req: L3Request): Promise<L3Response> {
    const startTime = Date.now();

    // === 步驟 1：取得Claw Key ===
    const clawKeyResult = await this.getClawKey();

    // 沒有Claw Key → 回傳錯誤 + 建議
    if (!clawKeyResult) {
      return {
        success: false,
        error: '沒有可用的 LLM Key，無法使用 L3 AI 管家',
        suggestion: '請匯入至少一把 LLM Key（如 OpenAI、Gemini、Groq）。執行 setup_wizard(action=auto) 一鍵設定。',
        latency_ms: Date.now() - startTime,
      };
    }

    // 額度檢查：剩餘 5% 以下 → 降級到 L2
    if (this.shouldDegradeToL2(clawKeyResult)) {
      return this.degradeToL2Response(req, startTime);
    }

    // 消耗追蹤
    let clawKeyTokens = 0;

    // === 步驟 2：解讀意圖 ===
    const availableToolsDesc = this.buildAvailableToolsDescription();
    const systemPrompt = this.buildSystemPrompt(availableToolsDesc);

    const intentRaw = await this.callLLMWithClawKey(
      clawKeyResult.key,
      systemPrompt,
      req.messages
    );

    if (!intentRaw.success) {
      return {
        success: false,
        error: `AI 管家意圖解讀失敗：${intentRaw.error}`,
        latency_ms: Date.now() - startTime,
      };
    }

    // 累計Claw Key token 消耗
    clawKeyTokens += intentRaw.tokens ?? 0;

    // 解析 LLM 回傳的 JSON
    const intentResponse = this.parseIntent(intentRaw.content ?? '');
    if (!intentResponse) {
      return {
        success: false,
        error: 'AI 管家回傳的格式無效，無法解析意圖',
        latency_ms: Date.now() - startTime,
      };
    }

    // === 步驟 3：若 LLM 要求澄清 → 直接回傳 ===
    if ('clarification' in intentResponse) {
      return {
        success: true,
        clarification: intentResponse.clarification,
        latency_ms: Date.now() - startTime,
      };
    }

    // === 步驟 4：依 DAG 執行步驟 ===
    const stepResults = await this.executeSteps(intentResponse.steps);

    // 計算各步驟 token 消耗
    const stepsUsage = stepResults.map(sr => ({
      tool: sr.tool,
      tokens: sr.tokens ?? 0,
    }));

    // === 步驟 5：整合結果 ===
    const synthesisResult = await this.synthesizeResult(
      clawKeyResult.key,
      req.messages,
      intentResponse,
      stepResults
    );

    if (!synthesisResult.success) {
      return {
        success: false,
        error: `AI 管家結果整合失敗：${synthesisResult.error}`,
        usage: {
          claw_key_tokens: clawKeyTokens,
          steps: stepsUsage,
        },
        latency_ms: Date.now() - startTime,
      };
    }

    // 累計整合階段的Claw Key token 消耗
    clawKeyTokens += synthesisResult.tokens ?? 0;

    // === 步驟 6：回傳完整結果 ===
    return {
      success: true,
      answer: synthesisResult.answer,
      understanding: intentResponse.understanding,
      step_results: stepResults,
      usage: {
        claw_key_tokens: clawKeyTokens,
        steps: stepsUsage,
      },
      latency_ms: Date.now() - startTime,
    };
  }

  // ===== Claw Key管理 =====

  /**
   * 取得Claw Key
   * Claw Key儲存在特殊服務 ID '__claw_key__' 下
   *
   * @returns Claw Key資訊，若不存在則回傳 null
   */
  async getClawKey(): Promise<ClawKeyInfo | null> {
    // 1. 先找專門設定的 __claw_key__（CLI claw-key set 設定的）
    const dedicated = await this.keyPool.selectKey(L3Concierge.CLAW_KEY_SERVICE_ID);
    if (dedicated) {
      return {
        key: dedicated,
        daily_tokens_used: dedicated.daily_used,
        daily_token_limit: 1_000_000,
      };
    }

    // 2. Fallback：使用任何已匯入的 LLM Key（setup_wizard 匯入的）
    //    這讓 setup_wizard(auto) 匯入 Key 後，L3 立刻能用，不需額外設定
    for (const [adapterId, config] of this.adapters) {
      if (config.adapter.category === 'llm' && config.capabilities.chat) {
        const key = await this.keyPool.selectKey(adapterId);
        if (key) {
          return {
            key,
            daily_tokens_used: key.daily_used,
            daily_token_limit: 1_000_000,
          };
        }
      }
    }

    return null;
  }

  /**
   * 判斷是否應降級到 L2
   * 條件：剩餘額度 ≤ 5%（QUOTA_DEGRADATION_THRESHOLD）
   */
  shouldDegradeToL2(clawKeyInfo: ClawKeyInfo): boolean {
    // 若 daily_token_limit = 0 表示無限制，不降級
    if (clawKeyInfo.daily_token_limit === 0) return false;

    const remaining = clawKeyInfo.daily_token_limit - clawKeyInfo.daily_tokens_used;
    const remainingRatio = remaining / clawKeyInfo.daily_token_limit;

    return remainingRatio <= L3Concierge.QUOTA_DEGRADATION_THRESHOLD;
  }

  /**
   * 降級到 L2 的回應
   * 用 L2Gateway 處理請求，並標注是從 L3 降級而來
   */
  private async degradeToL2Response(
    req: L3Request,
    startTime: number
  ): Promise<L3Response> {
    // 取最後一則用戶訊息作為 L2 的輸入
    const lastUserMessage = req.messages
      .filter(m => m.role === 'user')
      .pop();

    const l2Result = await this.l2Gateway.execute({
      model: 'auto',
      strategy: 'smart',
      params: {
        messages: req.messages,
        ...(lastUserMessage ? {} : {}),
        ...(req.params ?? {}),
      },
    });

    if (l2Result.success) {
      return {
        success: true,
        answer: `（Claw Key今日額度不足，已降級至 L2 智慧路由）\n${JSON.stringify(l2Result.data)}`,
        latency_ms: Date.now() - startTime,
      };
    }

    return {
      success: false,
      error: 'Claw Key今日額度不足，降級到 L2 後仍失敗',
      suggestion: 'Claw Key今日 token 額度已接近上限，將在明日重置',
      latency_ms: Date.now() - startTime,
    };
  }

  // ===== System Prompt 構建 =====

  /**
   * 構建 System Prompt
   * 將 {{available_tools}} 替換為實際已安裝的 Adapter 清單
   *
   * @param availableToolsDesc 已格式化的可用工具說明
   * @returns 完整 System Prompt
   */
  buildSystemPrompt(availableToolsDesc: string): string {
    return INTENT_SYSTEM_PROMPT_TEMPLATE.replace(
      '{{available_tools}}',
      availableToolsDesc
    );
  }

  /**
   * 構建可用工具說明字串
   * 遍歷已安裝的 Adapter，提取 ID、名稱、分類
   *
   * @returns 格式化的工具說明（供注入 System Prompt）
   */
  buildAvailableToolsDescription(): string {
    if (this.adapters.size === 0) {
      return '（目前沒有已安裝的工具）';
    }

    const lines: string[] = [];
    for (const [adapterId, config] of this.adapters) {
      const models = config.capabilities.models
        .map(m => m.id)
        .slice(0, 3)  // 只顯示前 3 個模型，避免過長
        .join(', ');

      const endpointNames = Object.keys(config.endpoints).join(', ');

      lines.push(
        `- ${adapterId}（${config.adapter.name}）` +
        `\n  類別：${config.adapter.category}` +
        `\n  端點：${endpointNames}` +
        (models ? `\n  模型：${models}` : '')
      );
    }

    return lines.join('\n\n');
  }

  // ===== 意圖解析 =====

  /**
   * 解析 LLM 回傳的 JSON 字串
   * 支援直接 JSON 或包在 markdown code block 中的 JSON
   *
   * @param rawContent LLM 回傳的原始文字
   * @returns 解析後的意圖結果，解析失敗回傳 null
   */
  parseIntent(rawContent: string): LLMIntentResponse | null {
    // 先嘗試直接解析
    let jsonStr = rawContent.trim();

    // 移除 markdown code block 包裝（```json ... ``` 或 ``` ... ```）
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch?.[1]) {
      jsonStr = codeBlockMatch[1].trim();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // 嘗試找到 JSON 物件的起始位置
      const jsonStart = jsonStr.indexOf('{');
      const jsonEnd = jsonStr.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        try {
          parsed = JSON.parse(jsonStr.slice(jsonStart, jsonEnd + 1));
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }

    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;

    // 澄清回應
    if (typeof obj['clarification'] === 'string') {
      return { clarification: obj['clarification'] };
    }

    // 意圖回應
    if (typeof obj['understanding'] === 'string' && Array.isArray(obj['steps'])) {
      const steps = this.parseIntentSteps(obj['steps']);
      if (steps === null) return null;

      return {
        understanding: obj['understanding'],
        steps,
      };
    }

    return null;
  }

  /**
   * 解析步驟陣列
   * 驗證每個步驟的必填欄位
   *
   * @param rawSteps 未驗證的步驟陣列
   * @returns 驗證後的步驟陣列，驗證失敗回傳 null
   */
  private parseIntentSteps(rawSteps: unknown[]): IntentStep[] | null {
    const steps: IntentStep[] = [];

    for (const raw of rawSteps) {
      if (!raw || typeof raw !== 'object') return null;
      const step = raw as Record<string, unknown>;

      if (typeof step['tool'] !== 'string') return null;
      if (!step['params'] || typeof step['params'] !== 'object') return null;
      if (!Array.isArray(step['depends_on'])) return null;

      // 驗證 depends_on 裡的每個值都是數字
      for (const dep of step['depends_on']) {
        if (typeof dep !== 'number') return null;
      }

      steps.push({
        tool: step['tool'],
        params: step['params'] as Record<string, unknown>,
        depends_on: step['depends_on'] as number[],
      });
    }

    return steps;
  }

  // ===== 步驟執行（DAG 排程） =====

  /**
   * 依 DAG 排序執行所有步驟
   * - 無依賴步驟 → 並行執行（Promise.all）
   * - 有依賴步驟 → 等待前置步驟完成後執行
   *
   * @param steps 所有步驟定義
   * @returns 所有步驟的執行結果
   */
  async executeSteps(steps: IntentStep[]): Promise<StepResult[]> {
    const results: (StepResult | undefined)[] = new Array(steps.length).fill(undefined);
    const completed = new Set<number>();

    // 持續執行，直到所有步驟完成
    let maxIterations = steps.length + 1;
    while (completed.size < steps.length && maxIterations > 0) {
      maxIterations--;

      // 找出目前可以執行的步驟（依賴已全部完成的步驟）
      const ready: number[] = [];
      for (let i = 0; i < steps.length; i++) {
        if (completed.has(i)) continue;  // 已完成，跳過

        const step = steps[i]!;
        const allDepsCompleted = step.depends_on.every(dep => completed.has(dep));
        if (allDepsCompleted) {
          ready.push(i);
        }
      }

      if (ready.length === 0) {
        // 沒有可執行的步驟（可能是循環依賴），跳出
        break;
      }

      // 並行執行所有就緒步驟
      const parallelPromises = ready.map(async (stepIndex) => {
        const step = steps[stepIndex]!;
        const result = await this.executeSingleStep(stepIndex, step, results);
        results[stepIndex] = result;
        completed.add(stepIndex);
      });

      await Promise.all(parallelPromises);
    }

    // 過濾掉未定義的結果（不應發生，但確保型別安全）
    return results.filter((r): r is StepResult => r !== undefined);
  }

  /**
   * 執行單一步驟
   * 透過 L2Gateway 呼叫指定工具
   *
   * @param stepIndex 步驟索引
   * @param step 步驟定義
   * @param previousResults 已完成步驟的結果（用於注入依賴數據）
   * @returns 步驟執行結果
   */
  private async executeSingleStep(
    stepIndex: number,
    step: IntentStep,
    previousResults: (StepResult | undefined)[]
  ): Promise<StepResult> {
    const startTime = Date.now();

    // 將前置步驟的結果注入到當前步驟的 params 中
    const enrichedParams = this.enrichParamsWithPreviousResults(
      step.params,
      step.depends_on,
      previousResults
    );

    // 透過 L2 路由引擎執行（享受 Failover）
    // 使用 'service_id/auto' 格式讓 L1 直轉到指定服務
    // 若 adapter 在清單中，用 service/model 格式，否則用 auto
    const adapter = this.adapters.get(step.tool);
    const modelStr = adapter
      ? `${step.tool}/${adapter.capabilities.models[0]?.id ?? 'auto'}`
      : step.tool;

    let l2Result;
    try {
      l2Result = await this.l2Gateway.execute({
        model: modelStr,
        strategy: 'smart',
        params: {
          ...enrichedParams,
          _tool: step.tool,  // 額外傳遞工具 ID 供 Adapter 參考
        },
      });
    } catch (err) {
      return {
        index: stepIndex,
        tool: step.tool,
        success: false,
        error: `步驟執行異常：${(err as Error).message}`,
        latency_ms: Date.now() - startTime,
      };
    }

    if (!l2Result.success) {
      return {
        index: stepIndex,
        tool: step.tool,
        success: false,
        error: l2Result.error,
        latency_ms: Date.now() - startTime,
      };
    }

    // 嘗試從回應中提取 token 消耗
    const tokens = this.extractTokensFromData(l2Result.data);

    return {
      index: stepIndex,
      tool: step.tool,
      success: true,
      data: l2Result.data,
      tokens,
      latency_ms: Date.now() - startTime,
    };
  }

  /**
   * 將前置步驟結果注入到當前步驟的 params 中
   * 使用 _step_{index}_result 格式傳遞前置步驟的輸出
   *
   * @param params 當前步驟原始參數
   * @param dependsOn 依賴的前置步驟索引陣列
   * @param previousResults 已完成步驟的結果
   * @returns 注入後的完整參數
   */
  private enrichParamsWithPreviousResults(
    params: Record<string, unknown>,
    dependsOn: number[],
    previousResults: (StepResult | undefined)[]
  ): Record<string, unknown> {
    const enriched = { ...params };

    for (const depIndex of dependsOn) {
      const depResult = previousResults[depIndex];
      if (depResult?.success && depResult.data !== undefined) {
        enriched[`_step_${depIndex}_result`] = depResult.data;
      }
    }

    return enriched;
  }

  /**
   * 從 Adapter 回應資料中提取 token 消耗
   * 支援 OpenAI 格式：data.usage.total_tokens
   * 支援 Anthropic 格式：data.usage.input_tokens + output_tokens
   *
   * @param data 後端回應資料
   * @returns token 消耗數，無法提取則回傳 0
   */
  private extractTokensFromData(data: unknown): number {
    if (!data || typeof data !== 'object') return 0;
    const obj = data as Record<string, unknown>;

    // OpenAI 格式：{ usage: { total_tokens: N } }
    if (obj['usage'] && typeof obj['usage'] === 'object') {
      const usage = obj['usage'] as Record<string, unknown>;
      if (typeof usage['total_tokens'] === 'number') {
        return usage['total_tokens'];
      }
      // Anthropic 格式：{ usage: { input_tokens: N, output_tokens: N } }
      if (
        typeof usage['input_tokens'] === 'number' &&
        typeof usage['output_tokens'] === 'number'
      ) {
        return usage['input_tokens'] + usage['output_tokens'];
      }
    }

    return 0;
  }

  // ===== 結果整合 =====

  /**
   * 用Claw Key LLM 整合所有步驟結果
   * 生成最終回答，附加執行摘要
   *
   * @param clawKey Claw Key
   * @param originalMessages 用戶原始訊息
   * @param intent 解析出的意圖
   * @param stepResults 所有步驟執行結果
   * @returns 整合結果（含最終回答和 token 消耗）
   */
  async synthesizeResult(
    clawKey: DecryptedKey,
    originalMessages: Array<{ role: string; content: string }>,
    intent: IntentResult,
    stepResults: StepResult[]
  ): Promise<{ success: boolean; answer?: string; tokens?: number; error?: string }> {
    // 構建整合訊息：包含原始請求 + 步驟結果摘要
    const stepsContext = stepResults
      .map((sr, i) => {
        if (sr.success) {
          return `步驟 ${i + 1}（${sr.tool}）：成功\n結果：${JSON.stringify(sr.data, null, 2)}`;
        } else {
          return `步驟 ${i + 1}（${sr.tool}）：失敗 - ${sr.error}`;
        }
      })
      .join('\n\n');

    const synthesisUserMessage = `用戶原始請求：
${originalMessages.map(m => `[${m.role}] ${m.content}`).join('\n')}

我的意圖理解：${intent.understanding}

執行結果：
${stepsContext}

請根據以上執行結果，給用戶一個完整、清晰的回答。`;

    const synthesisMessages = [
      { role: 'user', content: synthesisUserMessage },
    ];

    const result = await this.callLLMWithClawKey(
      clawKey,
      SYNTHESIS_SYSTEM_PROMPT,
      synthesisMessages
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      answer: result.content,
      tokens: result.tokens,
    };
  }

  // ===== Claw Key LLM 呼叫 =====

  /**
   * 用Claw Key呼叫 LLM API
   * 透過 Adapter Executor 直接呼叫Claw Key對應的服務
   *
   * @param clawKey Claw Key
   * @param systemPrompt 系統提示詞
   * @param messages 對話訊息
   * @returns LLM 回應（含文字內容和 token 消耗）
   */
  async callLLMWithClawKey(
    clawKey: DecryptedKey,
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>
  ): Promise<{ success: boolean; content?: string; tokens?: number; error?: string }> {
    // 找到Claw Key對應的 Adapter
    // Claw Key的服務 ID 是 '__claw_key__'，但實際 Adapter 可能是任何 LLM 服務
    // 嘗試用 Claw Key 的 service_id 找 Adapter，失敗則嘗試所有 LLM Adapter
    const adapterForClawKey = this.findAdapterForClawKey(clawKey.service_id);

    if (!adapterForClawKey) {
      return {
        success: false,
        error: '找不到Claw Key對應的 LLM Adapter，請確認已安裝 LLM 類型的 Adapter',
      };
    }

    const { adapter, modelId } = adapterForClawKey;

    // 構建訊息陣列（加入 system prompt）
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const result = await this.executor.execute(
      adapter,
      'chat',
      {
        model: modelId,
        messages: fullMessages,
        temperature: 0.7,
      },
      clawKey
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? `LLM 呼叫失敗（HTTP ${result.status}）`,
      };
    }

    // 從回應中提取文字內容
    const content = this.extractContentFromResponse(result.data);
    const tokens = this.extractTokensFromData(result.data);

    return {
      success: true,
      content,
      tokens,
    };
  }

  /**
   * 尋找適合Claw Key的 Adapter
   *
   * 匹配邏輯（依優先順序）：
   * 1. 若 keyServiceId 不是 '__claw_key__'（fallback 模式），直接用該服務的 Adapter
   * 2. 否則找第一個 LLM 類別（category='llm'）的 Adapter
   * 3. 最後找任何支援 chat 的 Adapter
   *
   * @param keyServiceId Claw Key 的服務 ID（用來精確匹配 Adapter）
   * @returns 找到的 Adapter 和模型 ID，或 null
   */
  private findAdapterForClawKey(keyServiceId?: string): { adapter: AdapterConfig; modelId: string } | null {
    // 1. 若是 fallback Key（service_id 不是 __claw_key__），直接精確匹配
    if (keyServiceId && keyServiceId !== '__claw_key__') {
      const config = this.adapters.get(keyServiceId);
      if (config && config.capabilities.chat) {
        const modelId = config.capabilities.models[0]?.id ?? 'default';
        return { adapter: config, modelId };
      }
    }

    // 2. 專用 Claw Key 或精確匹配失敗 → 找第一個 LLM Adapter
    for (const [, config] of this.adapters) {
      if (config.adapter.category === 'llm' && config.capabilities.chat) {
        const modelId = config.capabilities.models[0]?.id ?? 'default';
        return { adapter: config, modelId };
      }
    }

    // 3. 沒有 LLM Adapter，找任何支援 chat 的 Adapter
    for (const [, config] of this.adapters) {
      if (config.capabilities.chat) {
        const modelId = config.capabilities.models[0]?.id ?? 'default';
        return { adapter: config, modelId };
      }
    }

    return null;
  }

  /**
   * 從 LLM 回應中提取文字內容
   * 支援 OpenAI 和 Anthropic 的回應格式
   *
   * @param data 後端回應資料
   * @returns 提取的文字內容，提取失敗回傳空字串
   */
  private extractContentFromResponse(data: unknown): string {
    if (!data || typeof data !== 'object') return '';
    const obj = data as Record<string, unknown>;

    // OpenAI 格式：{ choices: [{ message: { content: '...' } }] }
    if (Array.isArray(obj['choices']) && obj['choices'].length > 0) {
      const choice = obj['choices'][0] as Record<string, unknown>;
      if (choice['message'] && typeof choice['message'] === 'object') {
        const msg = choice['message'] as Record<string, unknown>;
        if (typeof msg['content'] === 'string') {
          return msg['content'];
        }
      }
      // 有時 content 直接在 choice 上
      if (typeof choice['text'] === 'string') {
        return choice['text'];
      }
    }

    // Anthropic 格式：{ content: [{ type: 'text', text: '...' }] }
    if (Array.isArray(obj['content']) && obj['content'].length > 0) {
      const contentBlock = obj['content'][0] as Record<string, unknown>;
      if (typeof contentBlock['text'] === 'string') {
        return contentBlock['text'];
      }
    }

    // 純文字回應
    if (typeof obj['text'] === 'string') {
      return obj['text'];
    }

    return JSON.stringify(data);
  }
}
