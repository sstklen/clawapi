// 成本預測引擎 — 美元成本估算 + 省錢建議
// 讀取 usage_log + 定價資料 → 計算花費、預測趨勢、推薦替代

import type { ClawDatabase } from '../storage/database';

// ===== 型別定義 =====

/** 服務定價資料（每百萬 token 美元價格） */
export interface ServicePricing {
  /** 服務 ID */
  service_id: string;
  /** 模型名稱匹配模式（如 'gpt-4o*'） */
  model_pattern: string;
  /** Input 每百萬 token 美元 */
  input_per_1m_usd: number;
  /** Output 每百萬 token 美元 */
  output_per_1m_usd: number;
  /** 是否有免費額度 */
  has_free_tier: boolean;
  /** 免費額度描述 */
  free_tier_info?: string;
}

/** 單個服務的成本摘要 */
export interface ServiceCostSummary {
  service_id: string;
  total_requests: number;
  tokens_input: number;
  tokens_output: number;
  estimated_cost_usd: number;
  is_free_tier: boolean;
}

/** 完整成本報告 */
export interface CostReport {
  /** 報告期間 */
  period: '7d' | '30d';
  /** 各服務成本 */
  services: ServiceCostSummary[];
  /** 總成本估算（美元） */
  total_cost_usd: number;
  /** 免費服務省了多少 */
  free_tier_savings_usd: number;
  /** 月度預測（基於趨勢） */
  monthly_projection_usd: number;
  /** 省錢建議 */
  savings_tips: SavingsTip[];
}

/** 省錢建議 */
export interface SavingsTip {
  /** 建議標題 */
  title: string;
  /** 詳情 */
  detail: string;
  /** 預估可省金額 */
  estimated_savings_usd: number;
}

// ===== 定價常數表（2026-03 最新） =====

/**
 * AI API 定價資料
 * 來源：各服務官方定價頁面（2026-03-02 更新）
 * 注意：免費服務的 pricing 設為 0
 */
export const SERVICE_PRICING: ServicePricing[] = [
  // === 免費服務 ===
  // 來源：各官方定價頁面（2026-03-02 搜索確認）
  {
    service_id: 'groq',
    model_pattern: 'llama-3.1-8b*',
    input_per_1m_usd: 0.05,
    output_per_1m_usd: 0.08,
    has_free_tier: true,
    free_tier_info: '免費 tier 無需信用卡，有速率限制',
  },
  {
    service_id: 'groq',
    model_pattern: 'llama-3.3-70b*',
    input_per_1m_usd: 0.59,
    output_per_1m_usd: 0.79,
    has_free_tier: true,
    free_tier_info: '免費 tier 無需信用卡，有速率限制',
  },
  {
    service_id: 'groq',
    model_pattern: '*',
    input_per_1m_usd: 0.05,
    output_per_1m_usd: 0.08,
    has_free_tier: true,
    free_tier_info: '免費 tier 無需信用卡，有速率限制',
  },
  {
    service_id: 'gemini',
    model_pattern: 'gemini-2.0-flash*',
    input_per_1m_usd: 0.10,
    output_per_1m_usd: 0.40,
    has_free_tier: true,
    free_tier_info: '有免費額度（15 RPM）',
  },
  {
    service_id: 'gemini',
    model_pattern: 'gemini-2.5-flash*',
    input_per_1m_usd: 0.30,
    output_per_1m_usd: 2.50,
    has_free_tier: true,
    free_tier_info: '有免費額度',
  },
  {
    service_id: 'gemini',
    model_pattern: 'gemini-2.5-pro*',
    input_per_1m_usd: 1.25,
    output_per_1m_usd: 10.00,
    has_free_tier: true,
    free_tier_info: '有限免費額度',
  },
  {
    service_id: 'gemini',
    model_pattern: '*',
    input_per_1m_usd: 0.10,
    output_per_1m_usd: 0.40,
    has_free_tier: true,
    free_tier_info: '免費額度（Flash 系列）',
  },
  {
    service_id: 'cerebras',
    model_pattern: 'llama-3.1-8b*',
    input_per_1m_usd: 0.10,
    output_per_1m_usd: 0.10,
    has_free_tier: true,
    free_tier_info: '每日 1M tokens 免費',
  },
  {
    service_id: 'cerebras',
    model_pattern: '*',
    input_per_1m_usd: 0.60,
    output_per_1m_usd: 0.60,
    has_free_tier: true,
    free_tier_info: '每日 1M tokens 免費',
  },
  {
    service_id: 'sambanova',
    model_pattern: 'llama-3.1-8b*',
    input_per_1m_usd: 0.13,
    output_per_1m_usd: 0.13,
    has_free_tier: true,
    free_tier_info: '$5 初始額度',
  },
  {
    service_id: 'sambanova',
    model_pattern: '*',
    input_per_1m_usd: 0.63,
    output_per_1m_usd: 1.80,
    has_free_tier: true,
    free_tier_info: '$5 初始額度',
  },
  // === 便宜服務 ===
  {
    service_id: 'deepseek',
    model_pattern: 'deepseek-chat*',
    input_per_1m_usd: 0.14,
    output_per_1m_usd: 0.28,
    has_free_tier: false,
    free_tier_info: '首次註冊送 500 萬 token',
  },
  {
    service_id: 'deepseek',
    model_pattern: 'deepseek-reasoner*',
    input_per_1m_usd: 0.55,
    output_per_1m_usd: 2.19,
    has_free_tier: false,
  },
  {
    service_id: 'deepseek',
    model_pattern: '*',
    input_per_1m_usd: 0.14,
    output_per_1m_usd: 0.28,
    has_free_tier: false,
  },
  // === 主流服務 ===
  {
    service_id: 'openai',
    model_pattern: 'gpt-4o-mini*',
    input_per_1m_usd: 0.15,
    output_per_1m_usd: 0.60,
    has_free_tier: false,
  },
  {
    service_id: 'openai',
    model_pattern: 'gpt-4o*',
    input_per_1m_usd: 2.50,
    output_per_1m_usd: 10.00,
    has_free_tier: false,
  },
  {
    service_id: 'openai',
    model_pattern: '*',
    input_per_1m_usd: 2.50,
    output_per_1m_usd: 10.00,
    has_free_tier: false,
  },
  {
    service_id: 'anthropic',
    model_pattern: 'claude-*-haiku*',
    input_per_1m_usd: 1.00,
    output_per_1m_usd: 5.00,
    has_free_tier: false,
  },
  {
    service_id: 'anthropic',
    model_pattern: 'claude-*-sonnet*',
    input_per_1m_usd: 3.00,
    output_per_1m_usd: 15.00,
    has_free_tier: false,
  },
  {
    service_id: 'anthropic',
    model_pattern: 'claude-*-opus*',
    input_per_1m_usd: 5.00,
    output_per_1m_usd: 25.00,
    has_free_tier: false,
  },
  {
    service_id: 'anthropic',
    model_pattern: '*',
    input_per_1m_usd: 3.00,
    output_per_1m_usd: 15.00,
    has_free_tier: false,
  },
  // === 搜尋服務（按次計費，token 模式不適用，設為 0） ===
  {
    service_id: 'brave-search',
    model_pattern: '*',
    input_per_1m_usd: 0,
    output_per_1m_usd: 0,
    has_free_tier: true,
    free_tier_info: '$5/月信用（約 1000 次搜尋）',
  },
  {
    service_id: 'tavily',
    model_pattern: '*',
    input_per_1m_usd: 0,
    output_per_1m_usd: 0,
    has_free_tier: true,
    free_tier_info: '免費 1000 credits/月',
  },
  {
    service_id: 'serper',
    model_pattern: '*',
    input_per_1m_usd: 0,
    output_per_1m_usd: 0,
    has_free_tier: true,
    free_tier_info: '免費 2500 次搜尋',
  },
  // === 翻譯服務 ===
  {
    service_id: 'deepl',
    model_pattern: '*',
    input_per_1m_usd: 0,
    output_per_1m_usd: 0,
    has_free_tier: true,
    free_tier_info: '免費 50 萬字/月',
  },
];

// ===== 成本引擎 =====

/**
 * 成本預測引擎
 * 讀取 usage_log 的 token 用量 + 定價常數 → 計算花費
 */
export class CostEngine {
  constructor(private db: ClawDatabase) {}

  /**
   * 取得成本報告
   * @param period 報告期間：'7d' 或 '30d'
   */
  getCostReport(period: '7d' | '30d' = '7d'): CostReport {
    const days = period === '7d' ? 7 : 30;
    const usageStats = this.queryUsageByService(days);

    const services: ServiceCostSummary[] = [];
    let totalCost = 0;
    let freeSavings = 0;

    for (const stat of usageStats) {
      const pricing = this.findPricing(stat.service_id, stat.top_model);
      const inputCost = (stat.tokens_input / 1_000_000) * (pricing?.input_per_1m_usd ?? 0);
      const outputCost = (stat.tokens_output / 1_000_000) * (pricing?.output_per_1m_usd ?? 0);
      const cost = inputCost + outputCost;
      const isFreeTier = pricing?.has_free_tier ?? false;

      // 如果是免費服務，計算「如果用 GPT-4o 要花多少」來顯示省了多少
      if (isFreeTier && stat.tokens_input > 0) {
        const gpt4oCost =
          (stat.tokens_input / 1_000_000) * 2.5 +
          (stat.tokens_output / 1_000_000) * 10.0;
        freeSavings += gpt4oCost;
      }

      services.push({
        service_id: stat.service_id,
        total_requests: stat.total_requests,
        tokens_input: stat.tokens_input,
        tokens_output: stat.tokens_output,
        estimated_cost_usd: Math.round(cost * 1000) / 1000, // 三位小數
        is_free_tier: isFreeTier,
      });

      totalCost += cost;
    }

    // 月度預測（用日均乘以 30）
    const dailyAvg = totalCost / days;
    const monthlyProjection = Math.round(dailyAvg * 30 * 100) / 100;

    // 省錢建議
    const savingsTips = this.generateSavingsTips(services, usageStats);

    // 依成本排序（高→低）
    services.sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd);

    return {
      period,
      services,
      total_cost_usd: Math.round(totalCost * 100) / 100,
      free_tier_savings_usd: Math.round(freeSavings * 100) / 100,
      monthly_projection_usd: monthlyProjection,
      savings_tips: savingsTips,
    };
  }

  /**
   * 估算單次請求成本
   */
  estimateRequestCost(
    serviceId: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    const pricing = this.findPricing(serviceId, model);
    if (!pricing) return 0;
    return (
      (inputTokens / 1_000_000) * pricing.input_per_1m_usd +
      (outputTokens / 1_000_000) * pricing.output_per_1m_usd
    );
  }

  // ===== 私有方法 =====

  /**
   * 查詢各服務的 token 用量（指定天數內）
   */
  private queryUsageByService(days: number): UsageByService[] {
    try {
      return this.db.query<UsageByService>(
        `SELECT
          service_id,
          COUNT(*) AS total_requests,
          COALESCE(SUM(tokens_input), 0) AS tokens_input,
          COALESCE(SUM(tokens_output), 0) AS tokens_output,
          (SELECT model FROM usage_log u2
           WHERE u2.service_id = usage_log.service_id
           GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1) AS top_model
        FROM usage_log
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY service_id
        ORDER BY tokens_input + tokens_output DESC`,
        [days]
      );
    } catch {
      return [];
    }
  }

  /**
   * 找到服務+模型對應的定價
   * 用 glob 匹配 model_pattern（簡化版：* 匹配任意）
   */
  private findPricing(serviceId: string, model?: string): ServicePricing | null {
    const candidates = SERVICE_PRICING.filter(p => p.service_id === serviceId);
    if (candidates.length === 0) return null;

    // 如果有具體模型名，嘗試匹配
    if (model) {
      for (const p of candidates) {
        if (this.matchPattern(model, p.model_pattern)) {
          return p;
        }
      }
    }

    // 回傳第一個（預設定價）
    return candidates[0]!;
  }

  /**
   * 簡單的 glob 匹配（只支援尾部 *）
   */
  private matchPattern(value: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      return value.startsWith(pattern.slice(0, -1));
    }
    return value === pattern;
  }

  /**
   * 產生省錢建議
   */
  private generateSavingsTips(
    services: ServiceCostSummary[],
    usageStats: UsageByService[]
  ): SavingsTip[] {
    const tips: SavingsTip[] = [];

    // 建議 1：最貴的服務 → 推薦替代
    const mostExpensive = services.find(s => s.estimated_cost_usd > 0.1);
    if (mostExpensive) {
      const totalTokens = mostExpensive.tokens_input + mostExpensive.tokens_output;
      // 如果用 DeepSeek 可以省多少
      const deepseekCost =
        (mostExpensive.tokens_input / 1_000_000) * 0.27 +
        (mostExpensive.tokens_output / 1_000_000) * 1.10;
      const savings = mostExpensive.estimated_cost_usd - deepseekCost;

      if (savings > 0.05) {
        tips.push({
          title: `${mostExpensive.service_id} 換 DeepSeek 可省 $${savings.toFixed(2)}`,
          detail: `${Math.round(totalTokens / 1000)}K tokens 用 DeepSeek 只要 $${deepseekCost.toFixed(2)}`,
          estimated_savings_usd: Math.round(savings * 100) / 100,
        });
      }
    }

    // 建議 2：如果都沒用免費服務
    const hasFreeTier = services.some(s => s.is_free_tier);
    const totalCost = services.reduce((sum, s) => sum + s.estimated_cost_usd, 0);
    if (!hasFreeTier && totalCost > 0) {
      tips.push({
        title: '加免費服務（Groq/Gemini）當日常用途',
        detail: '日常問答用免費服務，把付費額度留給重要任務',
        estimated_savings_usd: Math.round(totalCost * 0.5 * 100) / 100,
      });
    }

    // 建議 3：如果某服務請求量大但 token 少（可能在做短對話）
    for (const stat of usageStats) {
      const avgTokens = stat.total_requests > 0
        ? (stat.tokens_input + stat.tokens_output) / stat.total_requests
        : 0;
      if (avgTokens < 500 && stat.total_requests > 50) {
        const pricing = this.findPricing(stat.service_id);
        if (pricing && !pricing.has_free_tier) {
          tips.push({
            title: `${stat.service_id} 短對話多 — 用免費模型更划算`,
            detail: `平均每次只用 ${Math.round(avgTokens)} tokens，用 Groq 免費就夠了`,
            estimated_savings_usd: 0,
          });
          break;
        }
      }
    }

    return tips.slice(0, 3);
  }
}

// ===== 內部型別 =====

interface UsageByService {
  service_id: string;
  total_requests: number;
  tokens_input: number;
  tokens_output: number;
  top_model: string;
}
