// L2 Gateway — 智慧路由層
// 支援三種路由策略：fast（最快）、smart（智慧評分）、cheap（最便宜）
// 內建 Failover：429 指數退避、401/403 標記死亡、超時累計錯誤
// 無集體智慧數據時自動降級到 Round-Robin

import type { KeyPool, DecryptedKey } from '../core/key-pool';
import type { AdapterExecutor } from '../adapters/executor';
import type { AdapterConfig } from '../adapters/loader';
import type { RoutingStrategy, ServiceStatus } from '@clawapi/protocol';

// ===== 型別定義 =====

/** 集體智慧數據（VPS 提供，可能為 null） */
export interface CollectiveIntel {
  /** 服務 ID → 統計數據 */
  [serviceId: string]: ServiceIntel;
}

/** 單一服務的集體智慧數據 */
export interface ServiceIntel {
  /** 成功率（0~1） */
  success_rate: number;
  /** p95 延遲（ms） */
  p95_latency_ms: number;
  /** 集體評分的信心度（0~1） */
  confidence: number;
  /** VPS 對這個服務的狀態判斷 */
  status: ServiceStatus;
  /** 剩餘配額比例（0~1，未知時預設 0.5） */
  quota_remaining_ratio?: number;
}

/** L2 請求 */
export interface L2Request {
  /** model = 'auto' 或已知模型名稱（非 service/model 格式） */
  model: string;
  /** 路由策略 */
  strategy?: RoutingStrategy;
  /** 轉發給後端的參數 */
  params: Record<string, unknown>;
}

/** L2 回應 */
export interface L2Response {
  /** 是否成功 */
  success: boolean;
  /** 實際選中的服務 ID */
  serviceId?: string;
  /** 實際使用的模型名稱 */
  modelName?: string;
  /** 使用的路由策略 */
  strategy: RoutingStrategy;
  /** 後端回應資料 */
  data?: unknown;
  /** 錯誤訊息 */
  error?: string;
  /** HTTP 狀態碼 */
  status?: number;
  /** 延遲時間（ms） */
  latency_ms: number;
  /** 嘗試過的服務清單（依順序） */
  tried: string[];
}

/** 服務候選評分項目 */
interface ScoredService {
  serviceId: string;
  score: number;
  key: DecryptedKey;
}

// ===== L2Gateway 主類別 =====

/**
 * L2 Gateway：智慧路由層
 *
 * 路由策略：
 * - fast：按 p95_latency_ms 升序，挑最快的
 * - smart（預設）：綜合成功率、延遲、配額、集體智慧評分
 * - cheap：T0 免費優先，按配額剩餘排序
 *
 * smart 評分公式：
 *   score = success_rate × 0.4
 *         + (1 - normalized_latency) × 0.3
 *         + quota_remaining_ratio × 0.2
 *         + collective_boost × 0.1
 *
 * Failover：
 * - 429 → 指數退避（Key 已在 KeyPool 標記），換下一個服務
 * - 401/403 → Key 標記 dead，換下一個服務
 * - 超時/網路錯誤 → consecutive_failures++，換下一個服務
 * - 全掛 → 友善錯誤 + tried 清單
 */
export class L2Gateway {
  constructor(
    private readonly keyPool: KeyPool,
    private readonly executor: AdapterExecutor,
    private readonly adapters: Map<string, AdapterConfig>,
    /** 集體智慧數據（可為 null，代表無數據） */
    private collectiveIntel: CollectiveIntel | null = null
  ) {}

  /**
   * 更新集體智慧數據
   * VPS 推送新數據時呼叫此方法
   */
  updateCollectiveIntel(intel: CollectiveIntel | null): void {
    this.collectiveIntel = intel;
  }

  /**
   * 執行 L2 智慧路由請求
   *
   * @param req L2 請求物件
   * @returns L2 回應
   */
  async execute(req: L2Request): Promise<L2Response> {
    const startTime = Date.now();
    const strategy: RoutingStrategy = req.strategy ?? 'smart';
    const tried: string[] = [];

    // === 取得所有有 Key 的服務 ===
    const serviceIds = this.keyPool.getServiceIds ? this.keyPool.getServiceIds() : [];

    if (serviceIds.length === 0) {
      return {
        success: false,
        strategy,
        error: '目前沒有任何可用的服務 Key，請新增 API Key 後再試',
        latency_ms: Date.now() - startTime,
        tried,
      };
    }

    // === 為每個服務選取最佳 Key 並評分 ===
    const candidates = await this.buildCandidates(serviceIds, strategy);

    if (candidates.length === 0) {
      return {
        success: false,
        strategy,
        error: '所有服務的 Key 均不可用（dead 或冷卻中），請稍後再試',
        latency_ms: Date.now() - startTime,
        tried,
      };
    }

    // === 依策略排序候選 ===
    const sorted = this.sortCandidates(candidates, strategy);

    // === 逐一嘗試 Failover ===
    for (const candidate of sorted) {
      const { serviceId, key } = candidate;
      tried.push(serviceId);

      const adapter = this.adapters.get(serviceId);
      if (!adapter) {
        // 找不到 Adapter，跳過
        continue;
      }

      // 構建請求參數（model 欄位用候選服務的預設模型）
      const modelName = this.selectModel(adapter, req.model);
      const requestParams: Record<string, unknown> = {
        ...req.params,
        model: modelName,
      };

      const result = await this.executor.execute(
        adapter,
        'chat',
        requestParams,
        key
      );

      if (result.success) {
        return {
          success: true,
          serviceId,
          modelName,
          strategy,
          data: result.data,
          status: result.status,
          latency_ms: Date.now() - startTime,
          tried,
        };
      }

      // 失敗，繼續嘗試下一個服務
      // KeyPool 在 executor 內部已自動更新 Key 狀態（429/401/403/5xx）
    }

    // === 全部嘗試完畢，均失敗 ===
    return {
      success: false,
      strategy,
      error: `所有可用服務均嘗試失敗（已嘗試：${tried.join('、')}），請稍後再試`,
      latency_ms: Date.now() - startTime,
      tried,
    };
  }

  // ===== 候選構建 =====

  /**
   * 為每個服務選取最佳 Key，構建候選清單
   * 沒有可用 Key 的服務直接跳過
   */
  private async buildCandidates(
    serviceIds: string[],
    strategy: RoutingStrategy
  ): Promise<ScoredService[]> {
    const candidates: ScoredService[] = [];

    for (const serviceId of serviceIds) {
      const key = await this.keyPool.selectKey(serviceId);
      if (!key) continue;  // 沒有可用 Key，跳過

      const score = this.computeScore(serviceId, strategy);
      candidates.push({ serviceId, score, key });
    }

    return candidates;
  }

  // ===== 評分計算 =====

  /**
   * 根據策略計算服務評分
   *
   * fast：分數 = -p95_latency_ms（負值，越小越好）
   * smart：綜合評分公式
   * cheap：分數 = quota_remaining_ratio（越多越好），T0 服務額外加分
   */
  private computeScore(serviceId: string, strategy: RoutingStrategy): number {
    const intel = this.collectiveIntel?.[serviceId];

    // === 無集體智慧數據 → Round-Robin 用隨機數確保輪流 ===
    if (!intel) {
      // 無數據時回傳隨機數，實現 Round-Robin 效果
      return Math.random();
    }

    switch (strategy) {
      case 'fast':
        return this.computeFastScore(intel);

      case 'smart':
        return this.computeSmartScore(intel);

      case 'cheap':
        return this.computeCheapScore(serviceId, intel);

      default:
        return this.computeSmartScore(intel);
    }
  }

  /**
   * fast 策略評分：-p95_latency_ms（越小越好）
   */
  private computeFastScore(intel: ServiceIntel): number {
    // 取負值，讓排序時最快的排最前
    return -intel.p95_latency_ms;
  }

  /**
   * smart 策略評分（預設）
   *
   * score = success_rate × 0.4
   *       + (1 - normalized_latency) × 0.3
   *       + quota_remaining_ratio × 0.2
   *       + collective_boost × 0.1
   *
   * normalized_latency = min(p95_latency_ms, 30000) / 30000
   * quota_remaining_ratio：未知時預設 0.5
   * collective_boost = confidence × status_weight
   *   status_weight：preferred=1, degraded=0.5, avoid=0
   */
  private computeSmartScore(intel: ServiceIntel): number {
    // 成功率分量（0.4 權重）
    const successRate = Math.max(0, Math.min(1, intel.success_rate));

    // 延遲分量（0.3 權重）
    const normalizedLatency = Math.min(intel.p95_latency_ms, 30000) / 30000;
    const latencyScore = 1 - normalizedLatency;

    // 配額剩餘分量（0.2 權重），未知時預設 0.5
    const quotaRatio = intel.quota_remaining_ratio ?? 0.5;
    const clampedQuota = Math.max(0, Math.min(1, quotaRatio));

    // 集體智慧加成分量（0.1 權重）
    const statusWeight = this.getStatusWeight(intel.status);
    const collectiveBoost = intel.confidence * statusWeight;

    const score =
      successRate * 0.4 +
      latencyScore * 0.3 +
      clampedQuota * 0.2 +
      collectiveBoost * 0.1;

    return score;
  }

  /**
   * cheap 策略評分：免費(T0)優先，按配額排序
   * T0 服務（adapter.free_tier = true）額外加 2 分
   */
  private computeCheapScore(serviceId: string, intel: ServiceIntel): number {
    const adapter = this.adapters.get(serviceId);
    const isFreeTier = adapter?.adapter?.free_tier ?? false;

    const quotaRatio = intel.quota_remaining_ratio ?? 0.5;
    const freeTierBonus = isFreeTier ? 2.0 : 0;

    return quotaRatio + freeTierBonus;
  }

  /**
   * 根據服務狀態取得權重
   * preferred=1, degraded=0.5, avoid=0
   */
  private getStatusWeight(status: ServiceStatus): number {
    switch (status) {
      case 'preferred': return 1.0;
      case 'degraded':  return 0.5;
      case 'avoid':     return 0.0;
      default:          return 0.5;
    }
  }

  // ===== 排序 =====

  /**
   * 依策略排序候選（分數高的排前面）
   */
  private sortCandidates(
    candidates: ScoredService[],
    _strategy: RoutingStrategy
  ): ScoredService[] {
    // fast 策略：負值分數，大的（即絕對值小的）排前面 → 還是降序
    return [...candidates].sort((a, b) => b.score - a.score);
  }

  // ===== 模型選取 =====

  /**
   * 從 Adapter 能力清單選取適合的模型
   * 若 model = 'auto'，選第一個可用模型
   * 若 model 是已知模型名稱，嘗試匹配，找不到則選第一個
   */
  private selectModel(adapter: AdapterConfig, model: string): string {
    const models = adapter.capabilities.models;

    if (!models || models.length === 0) {
      // Adapter 沒有定義模型清單，直接用傳入的 model 名稱
      return model === 'auto' ? 'default' : model;
    }

    if (model === 'auto') {
      // 自動選第一個模型
      return models[0]!.id;
    }

    // 嘗試精確匹配
    const matched = models.find(m => m.id === model);
    if (matched) return matched.id;

    // 找不到，選第一個
    return models[0]!.id;
  }
}
