import type { KeyPool } from '../core/key-pool';
import type { AdapterConfig } from '../adapters/loader';
import type { ClawDatabase } from '../storage/database';
import {
  type GrowthPhase,
  type GrowthState,
  type GrowthAction,
  type PoolHealthSummary,
  type ServicePoolInfo,
  type PersonalizedSuggestion,
  type RecommendRoute,
  LLM_SERVICES,
  SEARCH_SERVICES,
  TRANSLATE_SERVICES,
  SERVICE_RECOMMENDATIONS,
} from './types';

// ===== 群體智慧型別（內部用） =====

/** usage_log 各服務統計 */
interface ServiceUsageStats {
  service_id: string;
  total_requests: number;
  success_count: number;
  error_count: number;
  rate_limited_count: number;
  success_rate: number;
  avg_latency_ms: number;
  total_tokens: number;
}

/** routing_intel 快取列 */
interface RoutingIntelRow {
  service_id: string;
  region: string;
  status: string;
  confidence: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  sample_size: number | null;
  note: string | null;
  updated_at: string;
  valid_until: string;
}

/** 群體智慧完整報告 */
export interface IntelligenceReport {
  /** 個人使用統計（近 7 天） */
  personal_stats: ServiceUsageStats[];
  /** 集體數據（VPS 下發） */
  collective_intel: RoutingIntelRow[];
  /** 個人化建議 */
  suggestions: PersonalizedSuggestion[];
  /** 統計總數 */
  total_requests_7d: number;
  /** 數據是否足夠（至少 50 筆才有意義） */
  data_sufficient: boolean;
}

/** 用量洞察（數據驅動的個人化建議） */
export interface UsageInsight {
  /** 洞察類型 */
  type: 'capacity' | 'claw_key' | 'rate_limit' | 'cost_saving';
  /** 圖示 */
  icon: string;
  /** 標題 */
  title: string;
  /** 詳情 */
  detail: string;
}

const EFFORT_ORDER: Record<GrowthAction['effort'], number> = {
  free: 0,
  signup: 1,
  paid: 2,
};

/**
 * 成長引擎核心：計算階段、進度、推薦與池健康
 */
export class GrowthEngine {
  constructor(
    private keyPool: KeyPool,
    private adapters: Map<string, AdapterConfig>,
    private db: ClawDatabase
  ) {
    void this.adapters;
  }

  /**
   * 取得完整成長狀態快照
   */
  async getGrowthState(): Promise<GrowthState> {
    const phase = await this.getPhase();
    const layerProgress = await this.getLayerProgress();
    const layersUnlocked = Object.entries(layerProgress)
      .filter(([, progress]) => progress >= 1)
      .map(([layer]) => layer);

    return {
      phase,
      layers_unlocked: layersUnlocked,
      layer_progress: layerProgress,
      next_actions: await this.getRecommendations('balanced'),
      pool_health: await this.getPoolHealth(),
    };
  }

  /**
   * 依目前 Key 池狀態判斷成長階段
   */
  async getPhase(): Promise<GrowthPhase> {
    const keys = await this.keyPool.listKeys();
    const uniqueServices = new Set(keys.map(k => k.service_id));

    if (keys.length === 0) {
      return 'onboarding';
    }

    if (uniqueServices.size >= 5) {
      return 'mastery';
    }

    const hasDuplicateService = uniqueServices.size < keys.length;
    if (uniqueServices.size >= 3 || hasDuplicateService) {
      return 'scaling';
    }

    return 'awakening';
  }

  /**
   * 計算各層解鎖進度（L0-L4）
   */
  async getLayerProgress(): Promise<Record<string, number>> {
    const keys = await this.keyPool.listKeys();
    const activeKeys = keys.filter(k => k.status === 'active');
    const activeServiceIds = new Set(activeKeys.map(k => k.service_id));
    const llmActiveServices = Array.from(activeServiceIds).filter(serviceId => LLM_SERVICES.has(serviceId));
    const hasLlm = llmActiveServices.length > 0;
    const hasSearch = Array.from(activeServiceIds).some(serviceId => SEARCH_SERVICES.has(serviceId));
    const hasTranslate = Array.from(activeServiceIds).some(serviceId => TRANSLATE_SERVICES.has(serviceId));

    return {
      L0: 0,
      L1: activeKeys.length > 0 ? 1 : 0,
      L2: Math.min(1, llmActiveServices.length / 3),
      L3: hasLlm ? 1 : 0,
      L4: hasLlm && (hasSearch || hasTranslate) ? 1 : 0,
    };
  }

  /**
   * 依路線偏好給出下一步推薦
   */
  async getRecommendations(route: RecommendRoute = 'balanced'): Promise<GrowthAction[]> {
    const keys = await this.keyPool.listKeys();
    const existingServices = new Set(keys.map(k => k.service_id));

    return SERVICE_RECOMMENDATIONS
      .filter(item => !existingServices.has(item.service_id))
      .filter(item => item.routes.includes(route))
      .map((item): GrowthAction => ({
        priority: 'medium',
        action_id: `add_${item.service_id.replaceAll('-', '_')}_key`,
        title: `加 ${item.title}`,
        reason: item.reason,
        effort: item.effort,
        signup_url: item.signup_url,
        unlocks: item.unlocks,
      }))
      .sort((a, b) => EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort])
      .slice(0, 5);
  }

  /**
   * 統計 Key 池健康與各服務狀態
   */
  async getPoolHealth(): Promise<PoolHealthSummary> {
    const keys = await this.keyPool.listKeys();
    const group = new Map<string, typeof keys>();

    for (const key of keys) {
      const current = group.get(key.service_id) ?? [];
      current.push(key);
      group.set(key.service_id, current);
    }

    const services: ServicePoolInfo[] = [];
    let totalRateLimited = 0;

    for (const [serviceId, serviceKeys] of group.entries()) {
      const keyCount = serviceKeys.length;
      const activeCount = serviceKeys.filter(k => k.status === 'active').length;
      const rateLimitedCount = serviceKeys.filter(k => k.status === 'rate_limited').length;
      totalRateLimited += rateLimitedCount;

      const suggestions: string[] = [];
      if (keyCount === 1) {
        suggestions.push('加第 2 把 Key 可翻倍額度');
      }
      if (rateLimitedCount > 0) {
        suggestions.push('目前有限速，考慮加更多 Key');
      }

      services.push({
        service_id: serviceId,
        key_count: keyCount,
        active_count: activeCount,
        rate_limited_count: rateLimitedCount,
        suggestion: suggestions.length > 0 ? suggestions.join('；') : undefined,
      });
    }

    services.sort((a, b) => a.service_id.localeCompare(b.service_id));

    return {
      services,
      total_keys: keys.length,
      total_services: group.size,
      rate_limited_count: totalRateLimited,
    };
  }

  // ===== 用量洞察（Claw Key 數據驅動推薦） =====

  /**
   * 取得基於用量數據的個人化洞察
   * 用於 growth_guide overview 的智慧推薦區塊
   */
  async getUsageInsights(): Promise<UsageInsight[]> {
    const insights: UsageInsight[] = [];
    const stats = this.queryPersonalStats();
    if (stats.length === 0) return insights;

    const keys = await this.keyPool.listKeys();
    const existingServices = new Set(keys.map(k => k.service_id));

    // 洞察 1：用量最大的服務 — 如果只有 1 把 Key，建議加第 2 把
    const topService = stats[0];
    if (topService && topService.total_requests >= 20) {
      const serviceKeys = keys.filter(k => k.service_id === topService.service_id);
      if (serviceKeys.length === 1) {
        insights.push({
          type: 'capacity',
          icon: '🔑',
          title: `${topService.service_id} 是你的主力（${topService.total_requests} 次/週）`,
          detail: `只有 1 把 Key，加第 2 把可翻倍額度、減少限速`,
        });
      }
    }

    // 洞察 2：如果有 2+ 服務但沒有用過 Claw Key，建議建一把
    if (existingServices.size >= 2) {
      insights.push({
        type: 'claw_key',
        icon: '🪙',
        title: '你有多個服務 — 考慮用 Claw Key 統一管理',
        detail: `一把 Claw Key 通吃所有 ${existingServices.size} 個服務，不用記每把 Key`,
      });
    }

    // 洞察 3：成功率或限速問題 — 數據驅動建議
    for (const stat of stats) {
      if (stat.rate_limited_count > 3 && stat.total_requests >= 10) {
        const pct = Math.round((stat.rate_limited_count / stat.total_requests) * 100);
        insights.push({
          type: 'rate_limit',
          icon: '⚡',
          title: `${stat.service_id} 有 ${pct}% 請求被限速`,
          detail: `加更多 Key 或切換到免費替代（如 Groq）可解決`,
        });
        break; // 只顯示最嚴重的一個
      }
    }

    // 洞察 4：免費服務推薦 — 如果只用付費服務，推薦免費的
    const freeServices = ['groq', 'gemini', 'cerebras'];
    const hasFree = freeServices.some(s => existingServices.has(s));
    if (!hasFree && existingServices.size > 0) {
      insights.push({
        type: 'cost_saving',
        icon: '💰',
        title: '你還沒加免費服務',
        detail: 'Groq 和 Gemini 都有免費額度，加了可以省錢又當備援',
      });
    }

    return insights.slice(0, 3); // 最多顯示 3 個洞察
  }

  // ===== 群體智慧（爽點 4） =====

  /**
   * 取得群體智慧報告：個人統計 + 集體數據 + 個人化建議
   * 讀取 usage_log（近 7 天）和 routing_intel 表
   */
  async getIntelligenceReport(): Promise<IntelligenceReport> {
    const personalStats = this.queryPersonalStats();
    const collectiveIntel = this.queryCollectiveIntel();
    const totalRequests = personalStats.reduce((sum, s) => sum + s.total_requests, 0);
    const dataSufficient = totalRequests >= 50;

    const suggestions = dataSufficient
      ? this.generateSuggestions(personalStats, collectiveIntel)
      : [];

    return {
      personal_stats: personalStats,
      collective_intel: collectiveIntel,
      suggestions,
      total_requests_7d: totalRequests,
      data_sufficient: dataSufficient,
    };
  }

  /**
   * 查詢個人使用統計（近 7 天，按服務分組）
   */
  private queryPersonalStats(): ServiceUsageStats[] {
    try {
      const rows = this.db.query<{
        service_id: string;
        total_requests: number;
        success_count: number;
        error_count: number;
        rate_limited_count: number;
        avg_latency_ms: number;
        total_tokens: number;
      }>(
        `SELECT
          service_id,
          COUNT(*) AS total_requests,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN success = 0 AND error_code != 'rate_limited' THEN 1 ELSE 0 END) AS error_count,
          SUM(CASE WHEN error_code = 'rate_limited' OR success = 0 AND latency_ms = 0 THEN 1 ELSE 0 END) AS rate_limited_count,
          ROUND(AVG(latency_ms), 0) AS avg_latency_ms,
          COALESCE(SUM(tokens_input), 0) + COALESCE(SUM(tokens_output), 0) AS total_tokens
        FROM usage_log
        WHERE timestamp >= datetime('now', '-7 days')
        GROUP BY service_id
        ORDER BY total_requests DESC`
      );

      return rows.map(row => ({
        ...row,
        success_rate: row.total_requests > 0
          ? row.success_count / row.total_requests
          : 0,
      }));
    } catch {
      // DB 查詢失敗（例如表不存在），回傳空陣列
      return [];
    }
  }

  /**
   * 查詢集體路由建議（VPS 定期下發到 routing_intel 表）
   */
  private queryCollectiveIntel(): RoutingIntelRow[] {
    try {
      return this.db.query<RoutingIntelRow>(
        `SELECT *
        FROM routing_intel
        WHERE valid_until >= datetime('now')
        ORDER BY confidence DESC`
      );
    } catch {
      return [];
    }
  }

  /**
   * 根據個人統計 + 集體數據，產出個人化建議
   */
  private generateSuggestions(
    personalStats: ServiceUsageStats[],
    collectiveIntel: RoutingIntelRow[]
  ): PersonalizedSuggestion[] {
    const suggestions: PersonalizedSuggestion[] = [];

    // 建議 1：成功率低的服務 → 推薦替代
    for (const stat of personalStats) {
      if (stat.success_rate < 0.8 && stat.total_requests >= 10) {
        // 找集體數據中同類型但成功率更高的服務
        const betterAlternative = collectiveIntel.find(
          intel =>
            intel.service_id !== stat.service_id &&
            intel.success_rate !== null &&
            intel.success_rate > 0.95
        );

        const alternativeHint = betterAlternative
          ? `，集體數據顯示 ${betterAlternative.service_id} 成功率 ${Math.round((betterAlternative.success_rate ?? 0) * 100)}%`
          : '';

        suggestions.push({
          type: 'model_recommendation',
          title: `${stat.service_id} 成功率偏低（${Math.round(stat.success_rate * 100)}%）`,
          detail: `過去 7 天 ${stat.total_requests} 次請求中有 ${stat.error_count} 次失敗${alternativeHint}`,
          confidence: Math.min(0.9, stat.total_requests / 100),
        });
      }
    }

    // 建議 2：高延遲服務 → 推薦更快的替代
    for (const stat of personalStats) {
      if (stat.avg_latency_ms > 3000 && stat.total_requests >= 10) {
        const fasterService = collectiveIntel.find(
          intel =>
            intel.service_id !== stat.service_id &&
            intel.avg_latency_ms !== null &&
            intel.avg_latency_ms < stat.avg_latency_ms * 0.5
        );

        if (fasterService) {
          suggestions.push({
            type: 'model_recommendation',
            title: `${stat.service_id} 延遲偏高（平均 ${stat.avg_latency_ms}ms）`,
            detail: `集體數據顯示 ${fasterService.service_id} 平均延遲只有 ${fasterService.avg_latency_ms}ms，快 ${Math.round(stat.avg_latency_ms / (fasterService.avg_latency_ms ?? 1))} 倍`,
            confidence: Math.min(0.85, stat.total_requests / 100),
          });
        }
      }
    }

    // 建議 3：常被限速 → 建議加 Key
    for (const stat of personalStats) {
      if (stat.rate_limited_count > 5 && stat.total_requests >= 10) {
        const rateLimitPct = Math.round((stat.rate_limited_count / stat.total_requests) * 100);
        suggestions.push({
          type: 'cost_saving',
          title: `${stat.service_id} 常被限速（${rateLimitPct}% 請求被拒）`,
          detail: `加第 2 把 ${stat.service_id} Key 可分散請求，大幅減少限速`,
          confidence: 0.9,
        });
      }
    }

    // 建議 4：Token 用量大的服務 → 推薦更便宜替代
    const topTokenService = personalStats
      .filter(s => s.total_tokens > 100000)
      .sort((a, b) => b.total_tokens - a.total_tokens)[0];

    if (topTokenService) {
      const cheaperServices = ['deepseek', 'groq', 'cerebras'];
      const existingServices = new Set(personalStats.map(s => s.service_id));
      const suggestion = cheaperServices.find(s => !existingServices.has(s));

      if (suggestion) {
        suggestions.push({
          type: 'cost_saving',
          title: `${topTokenService.service_id} Token 用量大（${Math.round(topTokenService.total_tokens / 1000)}K tokens/週）`,
          detail: `加 ${suggestion} 可以把部分請求分流到更便宜的服務，省下成本`,
          confidence: 0.7,
        });
      }
    }

    // 建議 5：集體品質升級 — 如果集體數據有高品質服務但用戶沒用
    const existingServiceIds = new Set(personalStats.map(s => s.service_id));
    for (const intel of collectiveIntel) {
      if (
        !existingServiceIds.has(intel.service_id) &&
        intel.success_rate !== null &&
        intel.success_rate > 0.98 &&
        intel.sample_size !== null &&
        intel.sample_size > 1000 &&
        suggestions.length < 5
      ) {
        suggestions.push({
          type: 'quality_upgrade',
          title: `龍蝦們推薦 ${intel.service_id}`,
          detail: `集體數據：${intel.sample_size} 個龍蝦測試，成功率 ${Math.round(intel.success_rate * 100)}%，平均延遲 ${intel.avg_latency_ms ?? '?'}ms`,
          confidence: intel.confidence,
        });
        break; // 只推一個
      }
    }

    // 最多回 5 個建議，按信心度排序
    return suggestions
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  }
}

