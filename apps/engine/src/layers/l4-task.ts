// L4 任務引擎（L4 Task Engine）
// 當 model='task' 時觸發
// 支援 DAG 任務規劃、智慧並行、斷點續作、成本預估
// 使用Claw Key作為 AI 大腦，規劃並執行多步驟任務

import type { KeyPool, DecryptedKey } from '../core/key-pool';
import type { AdapterExecutor } from '../adapters/executor';
import type { AdapterConfig } from '../adapters/loader';
import type { L2Gateway } from './l2-gateway';
import type { ClawDatabase } from '../storage/database';
import type { ClawKeyInfo } from './l3-concierge';
import { L3Concierge } from './l3-concierge';

// ===== 型別定義 =====

/** L4 任務計畫中的單一步驟 */
export interface TaskStep {
  /** 步驟唯一 ID（字串形式，如 "step_1"） */
  id: string;
  /** 使用的工具（對應 Adapter ID，或 "llm_analysis" 代表Claw Key LLM 直接分析） */
  tool: string;
  /** 傳給工具的參數（可包含 {{step_id.result}} 佔位符） */
  params: Record<string, unknown>;
  /** 依賴的前置步驟 ID 陣列（[] 表示無依賴，可並行） */
  depends_on: string[];
  /** 失敗時是否自動重試（最多 3 次） */
  retry_on_fail: boolean;
}

/** LLM 回傳的任務計畫 */
export interface TaskPlan {
  /** 用戶的最終目標 */
  goal: string;
  /** 預估的 API 呼叫次數（含各工具呼叫） */
  estimated_calls: number;
  /** 預估Claw Key消耗的 token 數（規劃 + 整合） */
  estimated_claw_key_tokens: number;
  /** 所有任務步驟 */
  steps: TaskStep[];
}

/** LLM 回傳的計畫包裝 */
export interface TaskPlanResponse {
  plan: TaskPlan;
}

/** 單一步驟的執行結果 */
export interface TaskStepResult {
  /** 步驟 ID */
  id: string;
  /** 使用的工具 */
  tool: string;
  /** 是否成功 */
  success: boolean;
  /** 執行結果資料 */
  data?: unknown;
  /** 錯誤訊息（失敗時） */
  error?: string;
  /** 消耗的 token 數（若工具回傳） */
  tokens?: number;
  /** 延遲時間（ms） */
  latency_ms: number;
  /** 實際重試次數 */
  retry_count: number;
}

/** L4 消耗報告（比 L3 更詳細） */
export interface L4UsageReport {
  /** Claw Key消耗的 token 總數（規劃 + 整合） */
  claw_key_tokens: number;
  /** 各工具呼叫的總次數 */
  total_calls: number;
  /** 各步驟的消耗明細 */
  steps: Array<{
    id: string;
    tool: string;
    tokens: number;
    latency_ms: number;
    success: boolean;
    retry_count: number;
  }>;
}

/** L4 成本預估結果 */
export interface CostEstimate {
  /** 預估 API 呼叫次數 */
  estimated_calls: number;
  /** 預估Claw Key token 消耗 */
  estimated_claw_key_tokens: number;
  /** 是否超過用戶設定的 max_claw_key_tokens 限制 */
  exceeds_limit: boolean;
  /** 用戶設定的限制（0 表示無限制） */
  max_claw_key_tokens: number;
}

/** L4 請求 */
export interface L4Request {
  /** 用戶輸入的訊息（對話歷史） */
  messages: Array<{ role: string; content: string }>;
  /** 額外參數（可含 max_claw_key_tokens、checkpoint_id 等） */
  params?: Record<string, unknown>;
}

/** L4 回應 */
export interface L4Response {
  /** 是否成功 */
  success: boolean;
  /** 最終整合報告（成功時） */
  answer?: string;
  /** 任務目標說明 */
  goal?: string;
  /** 成本預估（超過限制時回傳） */
  cost_estimate?: CostEstimate;
  /** 錯誤訊息（失敗時） */
  error?: string;
  /** 錯誤建議 */
  suggestion?: string;
  /** 消耗報告 */
  usage?: L4UsageReport;
  /** 延遲時間（ms） */
  latency_ms: number;
  /** 各步驟執行結果（除錯用） */
  step_results?: TaskStepResult[];
  /** 斷點 ID（斷點續作時回傳） */
  checkpoint_id?: string;
  /** 是否從斷點恢復 */
  resumed_from_checkpoint?: boolean;
}

/** DB 中存取的斷點資料列 */
interface CheckpointRow {
  id: string;
  task_hash: string;
  plan_json: string;
  completed_steps_json: string;
  created_at: string;
  expires_at: string;
}

// ===== System Prompt 模板 =====

/**
 * L4 任務規劃用的 System Prompt 模板
 * {{available_tools}} 會被替換為當前已安裝的 Adapter 清單
 */
const TASK_PLANNING_PROMPT_TEMPLATE = `你是 ClawAPI 的 L4 任務引擎（Task Engine）。
你的任務是將用戶的請求拆解成可執行的 DAG 任務計畫。

可用工具清單：
{{available_tools}}

特殊工具：
- llm_analysis：使用Claw Key LLM 直接分析文字或整合資訊（無需外部 API Key）

請分析用戶的請求，然後回傳以下格式的 JSON：

{
  "plan": {
    "goal": "用戶的最終目標（一句話說明）",
    "estimated_calls": 5,
    "estimated_claw_key_tokens": 500,
    "steps": [
      {
        "id": "step_1",
        "tool": "工具ID",
        "params": {"參數名": "參數值"},
        "depends_on": [],
        "retry_on_fail": true
      },
      {
        "id": "step_2",
        "tool": "工具ID",
        "params": {"input": "{{step_1.result}}"},
        "depends_on": ["step_1"],
        "retry_on_fail": false
      }
    ]
  }
}

規則：
1. depends_on 填寫前置步驟的 ID 字串（如 "step_1"）
2. 無依賴的步驟填寫 []（可並行執行）
3. 工具 ID 必須從「可用工具清單」或「特殊工具」中選取
4. 使用 {{step_id.result}} 語法引用前置步驟結果
5. estimated_calls 包含所有工具呼叫次數
6. estimated_claw_key_tokens 只計算Claw Key LLM 呼叫的 token（規劃 + 整合）
7. retry_on_fail：重要步驟設 true，整合步驟設 false
8. 只回傳 JSON，不要有其他文字

請用繁體中文回應 goal 欄位。`;

/**
 * L4 結果整合用的 System Prompt
 */
const TASK_SYNTHESIS_PROMPT = `你是 ClawAPI 的 L4 任務引擎（Task Engine）。
你已經執行了一系列任務步驟，現在請根據執行結果給出最終報告。

請整合所有步驟的執行結果，給出清晰、完整的報告。
用繁體中文回答，格式清晰。
如果某個步驟失敗了，請明確標注「此部分未能取得」，但繼續整合其他成功部分的資訊。`;

// ===== L4TaskEngine 主類別 =====

/**
 * L4 任務引擎
 *
 * 流程：
 * 1. 檢查Claw Key是否存在且有額度
 * 2. 嘗試從斷點恢復（若提供 checkpoint_id）
 * 3. 用Claw Key LLM 規劃 DAG 任務計畫
 * 4. 預估成本，若超過 max_claw_key_tokens 則拒絕執行
 * 5. 依 DAG 拓撲排序執行步驟（無依賴並行、有依賴序列）
 *    每步支援 retry_on_fail（最多 3 次）
 *    每步完成後存入斷點
 * 6. 用Claw Key LLM 整合所有結果
 * 7. 回傳含詳細消耗報告的最終結果
 */
export class L4TaskEngine {
  /** Claw Key服務 ID（固定服務 ID，用來選取Claw Key） */
  private static readonly CLAW_KEY_SERVICE_ID = '__claw_key__';

  /** 額度降級閾值：剩餘 5% 時開始降級到 L2 */
  private static readonly QUOTA_DEGRADATION_THRESHOLD = 0.05;

  /** 步驟失敗時最多重試次數 */
  private static readonly MAX_RETRY_COUNT = 3;

  /** 斷點保留時間：24 小時（ms） */
  private static readonly CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

  /** 借用 L3Concierge 的Claw Key管理方法 */
  private readonly l3Helper: L3Concierge;

  constructor(
    /** Key 池管理器 */
    private readonly keyPool: KeyPool,
    /** Adapter 執行器 */
    private readonly executor: AdapterExecutor,
    /** 已安裝的 Adapter Map */
    private readonly adapters: Map<string, AdapterConfig>,
    /** L2 路由引擎（用於執行各步驟） */
    private readonly l2Gateway: L2Gateway,
    /** 資料庫（用於斷點存取） */
    private readonly db: ClawDatabase
  ) {
    // 借用 L3Concierge 的Claw Key管理和 Adapter 輔助方法
    this.l3Helper = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    // 確保斷點資料表存在
    this.ensureCheckpointTable();
  }

  // ===== 公開方法 =====

  /**
   * 執行 L4 任務引擎請求
   *
   * @param req L4 請求物件
   * @returns L4 回應
   */
  async execute(req: L4Request): Promise<L4Response> {
    const startTime = Date.now();

    // === 步驟 1：取得Claw Key ===
    const clawKeyResult = await this.getClawKey();

    // 沒有Claw Key → 回傳錯誤 + 建議
    if (!clawKeyResult) {
      return {
        success: false,
        error: '未設定Claw Key，無法使用 L4 任務引擎功能',
        suggestion: '請執行：clawapi claw-key set <your-api-key> 來設定Claw Key',
        latency_ms: Date.now() - startTime,
      };
    }

    // 額度檢查：剩餘 5% 以下 → 降級到 L2
    if (this.shouldDegradeToL2(clawKeyResult)) {
      return this.degradeToL2Response(req, startTime);
    }

    // 讀取 max_claw_key_tokens 限制（0 = 無限制）
    const maxClawKeyTokens = (req.params?.['max_claw_key_tokens'] as number) ?? 0;

    // 清除過期斷點
    this.clearExpiredCheckpoints();

    // === 步驟 2：嘗試從斷點恢復 ===
    const checkpointId = req.params?.['checkpoint_id'] as string | undefined;
    let checkpoint: { plan: TaskPlan; completedSteps: Map<string, TaskStepResult> } | null = null;
    let resumedFromCheckpoint = false;

    if (checkpointId) {
      checkpoint = this.loadCheckpoint(checkpointId);
      if (checkpoint) {
        resumedFromCheckpoint = true;
      }
    }

    // 消耗追蹤
    let clawKeyTokens = 0;

    // === 步驟 3：規劃任務（若無斷點則重新規劃） ===
    let plan: TaskPlan;

    if (checkpoint) {
      // 從斷點恢復，直接使用之前的計畫
      plan = checkpoint.plan;
    } else {
      // 用Claw Key LLM 規劃任務
      const planResult = await this.planTask(clawKeyResult.key, req.messages);

      if (!planResult.success || !planResult.plan) {
        return {
          success: false,
          error: `L4 任務規劃失敗：${planResult.error}`,
          latency_ms: Date.now() - startTime,
        };
      }

      plan = planResult.plan;
      clawKeyTokens += planResult.tokens ?? 0;
    }

    // === 步驟 4：成本預估 ===
    const costEstimate = this.estimateCost(plan, maxClawKeyTokens);

    // 若超過 max_claw_key_tokens 限制 → 拒絕執行
    if (costEstimate.exceeds_limit) {
      return {
        success: false,
        error: `任務預估消耗 ${costEstimate.estimated_claw_key_tokens} tokens，超過您設定的上限 ${maxClawKeyTokens} tokens`,
        suggestion: `請提高 max_claw_key_tokens 參數，或簡化任務描述`,
        cost_estimate: costEstimate,
        goal: plan.goal,
        latency_ms: Date.now() - startTime,
      };
    }

    // === 步驟 5：執行 DAG ===
    // 若從斷點恢復，繼承已完成的步驟
    const completedSteps: Map<string, TaskStepResult> = checkpoint?.completedSteps ?? new Map();

    // 生成斷點 ID（若無現有斷點）
    const newCheckpointId = checkpointId ?? this.generateCheckpointId(plan.goal, req.messages);

    const stepResults = await this.executeDAG(
      plan,
      completedSteps,
      newCheckpointId
    );

    // 計算各步驟 token 消耗
    const stepsUsage = stepResults.map(sr => ({
      id: sr.id,
      tool: sr.tool,
      tokens: sr.tokens ?? 0,
      latency_ms: sr.latency_ms,
      success: sr.success,
      retry_count: sr.retry_count,
    }));

    const totalCalls = stepResults.length;

    // === 步驟 6：整合結果 ===
    const synthesisResult = await this.synthesizeResults(
      clawKeyResult.key,
      req.messages,
      plan,
      stepResults
    );

    if (!synthesisResult.success) {
      return {
        success: false,
        error: `L4 任務結果整合失敗：${synthesisResult.error}`,
        goal: plan.goal,
        usage: {
          claw_key_tokens: clawKeyTokens,
          total_calls: totalCalls,
          steps: stepsUsage,
        },
        step_results: stepResults,
        latency_ms: Date.now() - startTime,
      };
    }

    // 累計整合階段的Claw Key token 消耗
    clawKeyTokens += synthesisResult.tokens ?? 0;

    // 清除已完成任務的斷點
    this.clearCheckpoint(newCheckpointId);

    // === 步驟 7：回傳完整結果 ===
    return {
      success: true,
      answer: synthesisResult.answer,
      goal: plan.goal,
      step_results: stepResults,
      usage: {
        claw_key_tokens: clawKeyTokens,
        total_calls: totalCalls,
        steps: stepsUsage,
      },
      latency_ms: Date.now() - startTime,
      resumed_from_checkpoint: resumedFromCheckpoint || undefined,
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
    const key = await this.keyPool.selectKey(L4TaskEngine.CLAW_KEY_SERVICE_ID);
    if (!key) return null;

    return {
      key,
      daily_tokens_used: key.daily_used,
      // 若無明確上限，預設每日 1,000,000 tokens（充足額度）
      daily_token_limit: 1_000_000,
    };
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

    return remainingRatio <= L4TaskEngine.QUOTA_DEGRADATION_THRESHOLD;
  }

  /**
   * 降級到 L2 的回應
   * 用 L2Gateway 處理請求，並標注是從 L4 降級而來
   */
  private async degradeToL2Response(
    req: L4Request,
    startTime: number
  ): Promise<L4Response> {
    const l2Result = await this.l2Gateway.execute({
      model: 'auto',
      strategy: 'smart',
      params: {
        messages: req.messages,
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

  // ===== 任務規劃 =====

  /**
   * 用Claw Key LLM 產生 DAG 任務計畫
   *
   * @param clawKey Claw Key
   * @param messages 用戶訊息
   * @returns 規劃結果（含 TaskPlan 和 token 消耗）
   */
  async planTask(
    clawKey: DecryptedKey,
    messages: Array<{ role: string; content: string }>
  ): Promise<{ success: boolean; plan?: TaskPlan; tokens?: number; error?: string }> {
    // 構建含可用工具的 System Prompt
    const availableToolsDesc = this.l3Helper.buildAvailableToolsDescription();
    const systemPrompt = TASK_PLANNING_PROMPT_TEMPLATE.replace(
      '{{available_tools}}',
      availableToolsDesc
    );

    // 呼叫Claw Key LLM
    const llmResult = await this.l3Helper.callLLMWithClawKey(
      clawKey,
      systemPrompt,
      messages
    );

    if (!llmResult.success) {
      return {
        success: false,
        error: llmResult.error,
      };
    }

    // 解析 LLM 回傳的 JSON
    const plan = this.parsePlan(llmResult.content ?? '');
    if (!plan) {
      return {
        success: false,
        error: 'L4 任務規劃 LLM 回傳的格式無效，無法解析計畫',
      };
    }

    return {
      success: true,
      plan,
      tokens: llmResult.tokens,
    };
  }

  /**
   * 解析 LLM 回傳的任務計畫 JSON
   * 支援直接 JSON 或包在 markdown code block 中的 JSON
   *
   * @param rawContent LLM 回傳的原始文字
   * @returns 解析後的 TaskPlan，解析失敗回傳 null
   */
  parsePlan(rawContent: string): TaskPlan | null {
    // 先嘗試直接解析
    let jsonStr = rawContent.trim();

    // 移除 markdown code block 包裝
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

    // 驗證頂層 plan 欄位
    if (!obj['plan'] || typeof obj['plan'] !== 'object') return null;
    const planObj = obj['plan'] as Record<string, unknown>;

    // 驗證必填欄位
    if (typeof planObj['goal'] !== 'string') return null;
    if (typeof planObj['estimated_calls'] !== 'number') return null;
    if (typeof planObj['estimated_claw_key_tokens'] !== 'number') return null;
    if (!Array.isArray(planObj['steps'])) return null;

    // 解析步驟陣列
    const steps = this.parsePlanSteps(planObj['steps']);
    if (steps === null) return null;

    return {
      goal: planObj['goal'],
      estimated_calls: planObj['estimated_calls'],
      estimated_claw_key_tokens: planObj['estimated_claw_key_tokens'],
      steps,
    };
  }

  /**
   * 解析任務步驟陣列
   * 驗證每個步驟的必填欄位
   *
   * @param rawSteps 未驗證的步驟陣列
   * @returns 驗證後的步驟陣列，驗證失敗回傳 null
   */
  private parsePlanSteps(rawSteps: unknown[]): TaskStep[] | null {
    const steps: TaskStep[] = [];

    for (const raw of rawSteps) {
      if (!raw || typeof raw !== 'object') return null;
      const step = raw as Record<string, unknown>;

      if (typeof step['id'] !== 'string') return null;
      if (typeof step['tool'] !== 'string') return null;
      if (!step['params'] || typeof step['params'] !== 'object') return null;
      if (!Array.isArray(step['depends_on'])) return null;
      if (typeof step['retry_on_fail'] !== 'boolean') return null;

      // 驗證 depends_on 裡的每個值都是字串
      for (const dep of step['depends_on']) {
        if (typeof dep !== 'string') return null;
      }

      steps.push({
        id: step['id'],
        tool: step['tool'],
        params: step['params'] as Record<string, unknown>,
        depends_on: step['depends_on'] as string[],
        retry_on_fail: step['retry_on_fail'],
      });
    }

    return steps;
  }

  // ===== 成本預估 =====

  /**
   * 預估任務執行成本
   *
   * @param plan 任務計畫
   * @param maxClawKeyTokens 用戶設定的 token 上限（0 = 無限制）
   * @returns 成本預估結果
   */
  estimateCost(plan: TaskPlan, maxClawKeyTokens: number = 0): CostEstimate {
    const exceedsLimit =
      maxClawKeyTokens > 0 &&
      plan.estimated_claw_key_tokens > maxClawKeyTokens;

    return {
      estimated_calls: plan.estimated_calls,
      estimated_claw_key_tokens: plan.estimated_claw_key_tokens,
      exceeds_limit: exceedsLimit,
      max_claw_key_tokens: maxClawKeyTokens,
    };
  }

  // ===== DAG 執行 =====

  /**
   * 依 DAG 拓撲排序執行所有步驟
   * - 無依賴步驟 → 並行執行（Promise.all）
   * - 有依賴步驟 → 等待前置步驟完成後執行
   * - 每步完成後存入斷點
   *
   * @param plan 任務計畫
   * @param completedSteps 已完成的步驟（斷點續作時傳入）
   * @param checkpointId 斷點 ID（用於存取進度）
   * @returns 所有步驟的執行結果（含已完成 + 新執行）
   */
  async executeDAG(
    plan: TaskPlan,
    completedSteps: Map<string, TaskStepResult>,
    checkpointId: string
  ): Promise<TaskStepResult[]> {
    // 所有結果 Map（含從斷點繼承的）
    const allResults = new Map<string, TaskStepResult>(completedSteps);
    const completedIds = new Set<string>(completedSteps.keys());

    // 持續執行，直到所有步驟完成
    let maxIterations = plan.steps.length + 1;
    while (completedIds.size < plan.steps.length && maxIterations > 0) {
      maxIterations--;

      // 找出目前可以執行的步驟（依賴已全部完成，且尚未執行）
      const ready: TaskStep[] = [];
      for (const step of plan.steps) {
        if (completedIds.has(step.id)) continue;  // 已完成，跳過

        const allDepsCompleted = step.depends_on.every(dep => completedIds.has(dep));
        if (allDepsCompleted) {
          ready.push(step);
        }
      }

      if (ready.length === 0) {
        // 沒有可執行的步驟（可能是循環依賴），跳出
        break;
      }

      // 並行執行所有就緒步驟
      const parallelPromises = ready.map(async (step) => {
        const result = await this.executeStep(step, allResults);
        allResults.set(step.id, result);
        completedIds.add(step.id);

        // 每步完成後更新斷點
        this.saveCheckpoint(checkpointId, plan, allResults);
      });

      await Promise.all(parallelPromises);
    }

    // 按原始步驟順序回傳結果
    return plan.steps
      .map(step => allResults.get(step.id))
      .filter((r): r is TaskStepResult => r !== undefined);
  }

  /**
   * 執行單一步驟（含重試機制）
   *
   * @param step 步驟定義
   * @param previousResults 已完成步驟的結果 Map（用於結果注入）
   * @returns 步驟執行結果
   */
  async executeStep(
    step: TaskStep,
    previousResults: Map<string, TaskStepResult>
  ): Promise<TaskStepResult> {
    const maxAttempts = step.retry_on_fail
      ? L4TaskEngine.MAX_RETRY_COUNT + 1  // 首次 + 重試 3 次
      : 1;

    let lastResult: TaskStepResult | null = null;
    let retryCount = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        retryCount++;
      }

      lastResult = await this.executeSingleAttempt(step, previousResults, retryCount);

      // 成功就直接回傳
      if (lastResult.success) {
        return lastResult;
      }
    }

    // 所有嘗試都失敗
    return lastResult!;
  }

  /**
   * 執行單次嘗試（無重試）
   *
   * @param step 步驟定義
   * @param previousResults 已完成步驟的結果 Map
   * @param retryCount 當前重試計數
   * @returns 步驟執行結果
   */
  private async executeSingleAttempt(
    step: TaskStep,
    previousResults: Map<string, TaskStepResult>,
    retryCount: number
  ): Promise<TaskStepResult> {
    const startTime = Date.now();

    // 將前置步驟的結果注入到當前步驟的 params 中
    const enrichedParams = this.enrichParamsWithResults(step.params, step.depends_on, previousResults);

    // 特殊工具 llm_analysis：直接用Claw Key LLM
    if (step.tool === 'llm_analysis') {
      return this.executeLlmAnalysis(step.id, enrichedParams, retryCount, startTime);
    }

    // 其他工具：透過 L2 路由引擎執行
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
          _tool: step.tool,
        },
      });
    } catch (err) {
      return {
        id: step.id,
        tool: step.tool,
        success: false,
        error: `步驟執行異常：${(err as Error).message}`,
        latency_ms: Date.now() - startTime,
        retry_count: retryCount,
      };
    }

    if (!l2Result.success) {
      return {
        id: step.id,
        tool: step.tool,
        success: false,
        error: l2Result.error,
        latency_ms: Date.now() - startTime,
        retry_count: retryCount,
      };
    }

    // 嘗試從回應中提取 token 消耗
    const tokens = this.l3Helper['extractTokensFromData'](l2Result.data);

    return {
      id: step.id,
      tool: step.tool,
      success: true,
      data: l2Result.data,
      tokens,
      latency_ms: Date.now() - startTime,
      retry_count: retryCount,
    };
  }

  /**
   * 執行 llm_analysis 特殊工具（直接用Claw Key LLM）
   *
   * @param stepId 步驟 ID
   * @param params 步驟參數（應包含 input 欄位）
   * @param retryCount 重試計數
   * @param startTime 開始時間
   * @returns 步驟執行結果
   */
  private async executeLlmAnalysis(
    stepId: string,
    params: Record<string, unknown>,
    retryCount: number,
    startTime: number
  ): Promise<TaskStepResult> {
    // 取得Claw Key
    const clawKeyInfo = await this.getClawKey();
    if (!clawKeyInfo) {
      return {
        id: stepId,
        tool: 'llm_analysis',
        success: false,
        error: 'llm_analysis 步驟無法執行：Claw Key不存在',
        latency_ms: Date.now() - startTime,
        retry_count: retryCount,
      };
    }

    // 將 params.input 作為用戶訊息
    const inputText = typeof params['input'] === 'string'
      ? params['input']
      : JSON.stringify(params['input'] ?? params);

    const result = await this.l3Helper.callLLMWithClawKey(
      clawKeyInfo.key,
      '你是一個資料分析助手，請分析並整合以下資訊，給出清晰的結論。用繁體中文回答。',
      [{ role: 'user', content: inputText }]
    );

    if (!result.success) {
      return {
        id: stepId,
        tool: 'llm_analysis',
        success: false,
        error: result.error,
        latency_ms: Date.now() - startTime,
        retry_count: retryCount,
      };
    }

    return {
      id: stepId,
      tool: 'llm_analysis',
      success: true,
      data: { analysis: result.content },
      tokens: result.tokens,
      latency_ms: Date.now() - startTime,
      retry_count: retryCount,
    };
  }

  /**
   * 將前置步驟結果注入到當前步驟的 params 中
   * 支援 {{step_id.result}} 佔位符替換
   *
   * @param params 當前步驟原始參數
   * @param dependsOn 依賴的前置步驟 ID 陣列
   * @param previousResults 已完成步驟的結果 Map
   * @returns 注入後的完整參數
   */
  enrichParamsWithResults(
    params: Record<string, unknown>,
    dependsOn: string[],
    previousResults: Map<string, TaskStepResult>
  ): Record<string, unknown> {
    const enriched: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        // 替換 {{step_id.result}} 佔位符
        enriched[key] = value.replace(/\{\{(\w+)\.result\}\}/g, (_, stepId: string) => {
          const stepResult = previousResults.get(stepId);
          if (stepResult?.success && stepResult.data !== undefined) {
            return typeof stepResult.data === 'string'
              ? stepResult.data
              : JSON.stringify(stepResult.data);
          }
          return `[${stepId} 結果不可用]`;
        });
      } else {
        enriched[key] = value;
      }
    }

    // 也以 _step_{id}_result 格式注入（與 L3 相容）
    for (const depId of dependsOn) {
      const depResult = previousResults.get(depId);
      if (depResult?.success && depResult.data !== undefined) {
        enriched[`_step_${depId}_result`] = depResult.data;
      }
    }

    return enriched;
  }

  // ===== 結果整合 =====

  /**
   * 用Claw Key LLM 整合所有步驟結果
   * 成功步驟 → 完整報告；失敗步驟 → 標註「此部分未能取得」
   *
   * @param clawKey Claw Key
   * @param originalMessages 用戶原始訊息
   * @param plan 任務計畫
   * @param stepResults 所有步驟執行結果
   * @returns 整合結果（含最終報告和 token 消耗）
   */
  async synthesizeResults(
    clawKey: DecryptedKey,
    originalMessages: Array<{ role: string; content: string }>,
    plan: TaskPlan,
    stepResults: TaskStepResult[]
  ): Promise<{ success: boolean; answer?: string; tokens?: number; error?: string }> {
    // 構建整合訊息
    const stepsContext = stepResults
      .map((sr) => {
        if (sr.success) {
          return `步驟 ${sr.id}（${sr.tool}）：成功${sr.retry_count > 0 ? `（重試 ${sr.retry_count} 次後成功）` : ''}\n結果：${JSON.stringify(sr.data, null, 2)}`;
        } else {
          return `步驟 ${sr.id}（${sr.tool}）：失敗（此部分未能取得） - ${sr.error}`;
        }
      })
      .join('\n\n');

    const synthesisUserMessage = `用戶原始請求：
${originalMessages.map(m => `[${m.role}] ${m.content}`).join('\n')}

任務目標：${plan.goal}

各步驟執行結果：
${stepsContext}

請根據以上執行結果，給用戶一個完整、清晰的報告。對於失敗的步驟，請標注「此部分未能取得」並繼續整合其他可用資訊。`;

    const result = await this.l3Helper.callLLMWithClawKey(
      clawKey,
      TASK_SYNTHESIS_PROMPT,
      [{ role: 'user', content: synthesisUserMessage }]
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

  // ===== 斷點管理 =====

  /**
   * 確保斷點資料表存在
   * 在建構時呼叫，若表格不存在則建立
   */
  private ensureCheckpointTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS l4_checkpoints (
          id              TEXT PRIMARY KEY,
          task_hash       TEXT NOT NULL,
          plan_json       TEXT NOT NULL,
          completed_steps_json TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_l4_checkpoints_expires
          ON l4_checkpoints(expires_at);
      `);
    } catch {
      // 表格已存在或建立失敗，忽略（不阻止 L4 運作）
    }
  }

  /**
   * 儲存執行斷點
   * 每步完成後呼叫，保存已完成步驟的結果
   *
   * @param checkpointId 斷點 ID
   * @param plan 完整任務計畫
   * @param completedSteps 已完成的步驟結果 Map
   */
  saveCheckpoint(
    checkpointId: string,
    plan: TaskPlan,
    completedSteps: Map<string, TaskStepResult>
  ): void {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + L4TaskEngine.CHECKPOINT_TTL_MS).toISOString();

    // 將 Map 轉為 JSON 可序列化的物件
    const completedStepsObj: Record<string, TaskStepResult> = {};
    for (const [id, result] of completedSteps) {
      completedStepsObj[id] = result;
    }

    try {
      this.db.run(
        `INSERT OR REPLACE INTO l4_checkpoints
          (id, task_hash, plan_json, completed_steps_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          checkpointId,
          this.hashPlanGoal(plan.goal),
          JSON.stringify(plan),
          JSON.stringify(completedStepsObj),
          now.toISOString(),
          expiresAt,
        ]
      );
    } catch {
      // 斷點寫入失敗不影響主流程，忽略
    }
  }

  /**
   * 讀取斷點
   *
   * @param checkpointId 斷點 ID
   * @returns 斷點資料（含計畫和已完成步驟），不存在或過期回傳 null
   */
  loadCheckpoint(
    checkpointId: string
  ): { plan: TaskPlan; completedSteps: Map<string, TaskStepResult> } | null {
    try {
      const rows = this.db.query<CheckpointRow>(
        `SELECT * FROM l4_checkpoints
         WHERE id = ? AND expires_at > datetime('now')`,
        [checkpointId]
      );

      if (rows.length === 0) return null;

      const row = rows[0]!;
      const plan = JSON.parse(row.plan_json) as TaskPlan;
      const completedStepsObj = JSON.parse(row.completed_steps_json) as Record<string, TaskStepResult>;

      const completedSteps = new Map<string, TaskStepResult>(
        Object.entries(completedStepsObj)
      );

      return { plan, completedSteps };
    } catch {
      return null;
    }
  }

  /**
   * 清除指定斷點（任務完成後呼叫）
   *
   * @param checkpointId 斷點 ID
   */
  clearCheckpoint(checkpointId: string): void {
    try {
      this.db.run(
        'DELETE FROM l4_checkpoints WHERE id = ?',
        [checkpointId]
      );
    } catch {
      // 忽略清除失敗
    }
  }

  /**
   * 清除所有過期斷點（24 小時以上）
   * 在每次 execute() 開始時呼叫
   */
  clearExpiredCheckpoints(): void {
    try {
      this.db.run(
        `DELETE FROM l4_checkpoints WHERE expires_at <= datetime('now')`
      );
    } catch {
      // 忽略清除失敗
    }
  }

  // ===== 輔助方法 =====

  /**
   * 生成斷點 ID
   * 根據任務目標和訊息內容生成唯一 ID
   *
   * @param goal 任務目標（規劃後才有）
   * @param messages 用戶訊息（規劃前用於生成 ID）
   * @returns 斷點 ID 字串
   */
  private generateCheckpointId(
    goal: string,
    messages: Array<{ role: string; content: string }>
  ): string {
    // 用訊息內容 + 時間戳產生唯一 ID（非加密用途，簡單 hash 即可）
    const input = `${goal}::${messages.map(m => m.content).join('::')}::${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;  // 轉為 32-bit 整數
    }
    return `l4_ckpt_${Math.abs(hash).toString(16).padStart(8, '0')}_${Date.now()}`;
  }

  /**
   * 計算任務目標的簡單 hash（用於斷點資料表的 task_hash 欄位）
   *
   * @param goal 任務目標字串
   * @returns hash 字串
   */
  private hashPlanGoal(goal: string): string {
    let hash = 0;
    for (let i = 0; i < goal.length; i++) {
      const char = goal.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }
}
