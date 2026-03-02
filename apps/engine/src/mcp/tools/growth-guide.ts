// MCP Tool: growth_guide — 成長引導
// 路由解鎖進度、推薦下一步、額度池健康、群體智慧
// 爽點 2/3/4 的入口：持續引導成長

import type {
  GrowthState,
  GrowthAction,
  PoolHealthSummary,
  GrowthPhase,
  RecommendRoute,
} from '../../growth/types';
import { PHASE_NAMES, PHASE_DESCRIPTIONS } from '../../growth/types';
import type { GrowthEngine, IntelligenceReport, UsageInsight } from '../../growth/engine';
import type { CostEngine, CostReport } from '../../growth/cost-engine';

// ===== 型別定義 =====

/** growth_guide tool 的輸入參數 */
export interface GrowthGuideToolInput {
  /** 檢視模式（預設 overview） */
  view?: 'overview' | 'recommend' | 'pool' | 'intel' | 'cost';
  /** 推薦路線偏好（recommend 用） */
  route?: RecommendRoute;
}

/** growth_guide tool 的 JSON Schema */
export const growthGuideToolSchema = {
  name: 'growth_guide',
  description:
    '成長引導。當用戶問「還能加什麼」、遇到限速、想優化路由、或想了解使用狀況時，請主動呼叫此 tool。顯示 L1-L4 進度、推薦免費 API、額度池健康、群體智慧分析。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      view: {
        type: 'string',
        enum: ['overview', 'recommend', 'pool', 'intel', 'cost'],
        description:
          '檢視模式：overview=總覽、recommend=推薦、pool=額度池、intel=群體智慧、cost=成本分析（預設 overview）',
      },
      route: {
        type: 'string',
        enum: ['free', 'balanced', 'full'],
        description: '推薦路線偏好：free=免費優先、balanced=性價比、full=全開（預設 balanced）',
      },
    },
  },
};

// ===== Tool 執行 =====

/**
 * 執行 growth_guide tool
 */
export async function executeGrowthGuideTool(
  input: GrowthGuideToolInput,
  growthEngine?: GrowthEngine,
  costEngine?: CostEngine
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!growthEngine) {
    return {
      content: [
        {
          type: 'text',
          text: '⚠️ 成長引擎未初始化。請確認引擎已完整啟動。',
        },
      ],
    };
  }

  const view = input.view ?? 'overview';

  try {
    switch (view) {
      case 'overview':
        return await handleOverview(growthEngine);

      case 'recommend':
        return await handleRecommend(growthEngine, input.route ?? 'balanced');

      case 'pool':
        return await handlePool(growthEngine);

      case 'intel':
        return await handleIntel(growthEngine);

      case 'cost':
        return await handleCost(costEngine);

      default:
        return {
          content: [
            {
              type: 'text',
              text: `不支援的 view：${view}。可用：overview, recommend, pool, intel, cost`,
            },
          ],
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `成長引導查詢失敗：${(err as Error).message}`,
        },
      ],
    };
  }
}

// ===== 各 view 處理器 =====

/**
 * overview — 成長總覽：階段 + L1-L4 進度條 + 精選推薦
 */
async function handleOverview(
  engine: GrowthEngine
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const state = await engine.getGrowthState();
  const lines: string[] = [];

  // 標題 + 成長階段
  lines.push('📊 ClawAPI 成長總覽');
  lines.push('═══════════════════════\n');
  lines.push(
    `階段：${PHASE_NAMES[state.phase]}（${state.phase}）`
  );
  lines.push(`說明：${PHASE_DESCRIPTIONS[state.phase]}`);
  lines.push('');

  // L0-L4 進度條
  lines.push('路由層解鎖進度：');
  const layerNames: Record<string, string> = {
    L0: '本機模型',
    L1: '直轉代理',
    L2: '智慧路由',
    L3: 'AI 管家',
    L4: '任務引擎',
  };

  for (const [layer, name] of Object.entries(layerNames)) {
    const progress = state.layer_progress[layer] ?? 0;
    const bar = makeProgressBar(progress);
    const pct = Math.round(progress * 100);
    const unlocked = state.layers_unlocked.includes(layer) ? ' ✅' : '';
    lines.push(`  ${layer} ${name.padEnd(8)} ${bar} ${pct}%${unlocked}`);
  }

  // 精選推薦（最多 2 個）
  if (state.next_actions.length > 0) {
    lines.push('');
    lines.push('💡 推薦下一步：');
    const topActions = state.next_actions.slice(0, 2);
    for (const action of topActions) {
      const effort = formatEffort(action.effort);
      lines.push(`  ${priorityIcon(action.priority)} ${action.title} ${effort}`);
      lines.push(`     ${action.reason}`);
      if (action.unlocks) {
        lines.push(`     → ${action.unlocks}`);
      }
      if (action.signup_url) {
        lines.push(`     🔗 ${action.signup_url}`);
      }
    }
  }

  // 用量洞察（數據驅動推薦）
  try {
    const insights = await engine.getUsageInsights();
    if (insights.length > 0) {
      lines.push('');
      lines.push('🔍 用量洞察：');
      for (const insight of insights) {
        lines.push(`  ${insight.icon} ${insight.title}`);
        lines.push(`     ${insight.detail}`);
      }
    }
  } catch {
    // 用量洞察失敗不影響 overview 輸出
  }

  // 額度池簡報
  lines.push('');
  lines.push(
    `Key 池：${state.pool_health.total_keys} 把 Key / ${state.pool_health.total_services} 個服務`
  );
  if (state.pool_health.rate_limited_count > 0) {
    lines.push(
      `⚠️ ${state.pool_health.rate_limited_count} 把 Key 限速中`
    );
  }

  // 下一步提示
  lines.push('');
  lines.push('使用 growth_guide(view=recommend) 看完整推薦清單');
  lines.push('使用 growth_guide(view=pool) 看額度池詳情');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * recommend — 完整推薦清單
 */
async function handleRecommend(
  engine: GrowthEngine,
  route: RecommendRoute
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const recommendations = await engine.getRecommendations(route);
  const lines: string[] = [];

  const routeNames: Record<RecommendRoute, string> = {
    free: '免費優先',
    balanced: '性價比',
    full: '全開',
  };

  lines.push(`📋 推薦清單（${routeNames[route]} 路線）`);
  lines.push('═══════════════════════\n');

  if (recommendations.length === 0) {
    lines.push('🎉 太棒了！你已經加齊了這條路線推薦的所有服務。');
    lines.push('');
    if (route !== 'full') {
      lines.push(`試試 growth_guide(view=recommend, route=full) 看看還能加什麼？`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  for (let i = 0; i < recommendations.length; i++) {
    const action = recommendations[i]!;
    const effort = formatEffort(action.effort);
    lines.push(`${i + 1}. ${action.title} ${effort}`);
    lines.push(`   ${action.reason}`);
    if (action.unlocks) {
      lines.push(`   解鎖：${action.unlocks}`);
    }
    if (action.signup_url) {
      lines.push(`   申請：${action.signup_url}`);
    }
    lines.push('');
  }

  lines.push('───────────────────────');
  lines.push('取得 Key 後使用 setup_wizard(action=import, service=xxx, key=xxx) 匯入');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * pool — 額度池詳情
 */
async function handlePool(
  engine: GrowthEngine
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const health = await engine.getPoolHealth();
  const lines: string[] = [];

  lines.push('🔋 額度池健康報告');
  lines.push('═══════════════════════\n');
  lines.push(
    `總計：${health.total_keys} 把 Key / ${health.total_services} 個服務`
  );
  if (health.rate_limited_count > 0) {
    lines.push(
      `⚠️ ${health.rate_limited_count} 把 Key 目前限速中`
    );
  }
  lines.push('');

  if (health.services.length === 0) {
    lines.push('Key 池為空。使用 setup_wizard(action=scan) 掃描環境。');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // 按服務列出
  for (const svc of health.services) {
    const statusIcon =
      svc.rate_limited_count > 0 ? '⚠️' : '✅';
    lines.push(
      `${statusIcon} ${svc.service_id}`
    );
    lines.push(
      `   Key 數：${svc.key_count}（正常 ${svc.active_count} / 限速 ${svc.rate_limited_count}）`
    );
    if (svc.suggestion) {
      lines.push(`   💡 ${svc.suggestion}`);
    }
    lines.push('');
  }

  // 整體建議
  const singleKeyServices = health.services.filter(s => s.key_count === 1);
  if (singleKeyServices.length > 0) {
    lines.push('───────────────────────');
    lines.push('建議：以下服務只有 1 把 Key，加第 2 把可提升容錯和額度：');
    for (const svc of singleKeyServices) {
      lines.push(`  → ${svc.service_id}`);
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * intel — 群體智慧：個人統計 + 集體數據 + 個人化建議
 */
async function handleIntel(
  engine: GrowthEngine
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const report = await engine.getIntelligenceReport();
  const lines: string[] = [];

  lines.push('🧠 群體智慧報告');
  lines.push('═══════════════════════\n');

  // 數據充足性
  if (!report.data_sufficient) {
    lines.push(`📊 近 7 天使用：${report.total_requests_7d} 次請求`);
    lines.push(`⏳ 至少需要 50 次請求才能產生有效建議（目前 ${report.total_requests_7d}/50）`);
    lines.push('');
    lines.push('持續使用 ClawAPI，數據會自動累積。');
    if (report.personal_stats.length > 0) {
      lines.push('');
      lines.push('已有的初步統計：');
    }
  } else {
    lines.push(`📊 近 7 天使用：${report.total_requests_7d} 次請求`);
    lines.push('');
  }

  // 個人使用統計
  if (report.personal_stats.length > 0) {
    lines.push('【個人使用統計（近 7 天）】');
    for (const stat of report.personal_stats) {
      const successPct = Math.round(stat.success_rate * 100);
      const statusIcon = successPct >= 95 ? '🟢' : successPct >= 80 ? '🟡' : '🔴';
      lines.push(
        `  ${statusIcon} ${stat.service_id.padEnd(12)} ` +
        `${stat.total_requests} 次 | 成功 ${successPct}% | ` +
        `延遲 ${stat.avg_latency_ms}ms | ` +
        `${Math.round(stat.total_tokens / 1000)}K tokens`
      );
    }
    lines.push('');
  }

  // 集體數據
  if (report.collective_intel.length > 0) {
    lines.push('【集體龍蝦實測數據】');
    for (const intel of report.collective_intel.slice(0, 5)) {
      const successPct = intel.success_rate !== null
        ? `${Math.round(intel.success_rate * 100)}%`
        : '?';
      const latency = intel.avg_latency_ms !== null
        ? `${intel.avg_latency_ms}ms`
        : '?';
      const samples = intel.sample_size !== null
        ? `${intel.sample_size} 龍蝦`
        : '?';
      lines.push(
        `  ${intel.service_id.padEnd(12)} 成功 ${successPct} | ` +
        `延遲 ${latency} | ${samples} 實測`
      );
      if (intel.note) {
        lines.push(`     📝 ${intel.note}`);
      }
    }
    lines.push('');
  }

  // 個人化建議
  if (report.suggestions.length > 0) {
    lines.push('【個人化建議】');
    for (const suggestion of report.suggestions) {
      const typeIcon =
        suggestion.type === 'model_recommendation' ? '🔄' :
        suggestion.type === 'cost_saving' ? '💰' : '⬆️';
      const confidence = Math.round(suggestion.confidence * 100);
      lines.push(`  ${typeIcon} ${suggestion.title}（信心 ${confidence}%）`);
      lines.push(`     ${suggestion.detail}`);
      lines.push('');
    }
  } else if (report.data_sufficient) {
    lines.push('✨ 目前使用狀況很好，沒有需要特別調整的。');
    lines.push('');
  }

  // 尾巴
  lines.push('───────────────────────');
  lines.push('數據經過匿名化，幫助所有龍蝦一起變聰明 🦞');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * cost — 成本分析：花費估算 + 月度預測 + 省錢建議
 */
async function handleCost(
  costEngine?: CostEngine
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!costEngine) {
    return {
      content: [
        {
          type: 'text',
          text: '⚠️ 成本引擎未初始化。請確認引擎已完整啟動。',
        },
      ],
    };
  }

  const report = costEngine.getCostReport('7d');
  const lines: string[] = [];

  lines.push('💰 成本分析報告（近 7 天）');
  lines.push('═══════════════════════\n');

  if (report.services.length === 0) {
    lines.push('📊 還沒有使用記錄。開始使用 ClawAPI 後這裡會顯示成本分析。');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // 總成本
  lines.push(`總花費：$${report.total_cost_usd.toFixed(2)}`);
  if (report.free_tier_savings_usd > 0) {
    lines.push(`免費服務幫你省了：$${report.free_tier_savings_usd.toFixed(2)}（vs 全用 GPT-4o）`);
  }
  lines.push(`月度預估：$${report.monthly_projection_usd.toFixed(2)}/月`);
  lines.push('');

  // 各服務明細
  lines.push('【各服務花費】');
  for (const svc of report.services) {
    const freeTag = svc.is_free_tier ? ' 🟢免費' : '';
    const costStr = svc.estimated_cost_usd > 0
      ? `$${svc.estimated_cost_usd.toFixed(3)}`
      : '$0.00';
    const tokensK = Math.round((svc.tokens_input + svc.tokens_output) / 1000);
    lines.push(
      `  ${svc.service_id.padEnd(12)} ${costStr.padStart(8)} | ` +
      `${svc.total_requests} 次 | ${tokensK}K tokens${freeTag}`
    );
  }
  lines.push('');

  // 省錢建議
  if (report.savings_tips.length > 0) {
    lines.push('【省錢建議】');
    for (const tip of report.savings_tips) {
      const savingsStr = tip.estimated_savings_usd > 0
        ? `（可省 $${tip.estimated_savings_usd.toFixed(2)}）`
        : '';
      lines.push(`  💡 ${tip.title}${savingsStr}`);
      lines.push(`     ${tip.detail}`);
      lines.push('');
    }
  }

  lines.push('───────────────────────');
  lines.push('定價來源：各服務官方頁面（2026-03 更新）');
  lines.push('使用 growth_guide(view=cost) 查看最新分析');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ===== 格式化輔助 =====

/**
 * 產生進度條
 * @param progress 0.0 ~ 1.0
 * @returns 如 [████████░░] 格式
 */
function makeProgressBar(progress: number): string {
  const total = 10;
  const filled = Math.round(progress * total);
  const empty = total - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

/**
 * 格式化努力程度
 */
function formatEffort(effort: string): string {
  switch (effort) {
    case 'free':
      return '🟢 免費';
    case 'signup':
      return '🟡 需註冊';
    case 'paid':
      return '🔴 付費';
    default:
      return '';
  }
}

/**
 * 優先級圖示
 */
function priorityIcon(priority: string): string {
  switch (priority) {
    case 'high':
      return '🔥';
    case 'medium':
      return '📌';
    case 'low':
      return '💭';
    default:
      return '•';
  }
}
