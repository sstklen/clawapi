// Dashboard 頁面（首頁）
// 顯示四張統計卡片 + 即時請求流（SSE）+ 服務健康度

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';
import { StatCard } from '../components/card';

/** Dashboard 資料（由路由注入） */
export interface DashboardData {
  /** Key 池統計 */
  keyPool: {
    total: number;
    active: number;
    rateLimited: number;
    dead: number;
  };
  /** 今日用量 */
  todayUsage: {
    count: number;
    trend: string;
  };
  /** 成功率 */
  successRate: number;
  /** 集體智慧（在線龍蝦數） */
  collectiveIntel: {
    onlineLobsters: number;
  };
}

/**
 * Dashboard 頁面
 * - 四張統計卡片（Key 池、今日用量、成功率、集體智慧）
 * - 即時請求流（SSE 推送）
 * - 服務健康度表格
 */
export const DashboardPage: FC<{ data: DashboardData }> = ({ data }) => {
  const { keyPool, todayUsage, successRate, collectiveIntel } = data;

  // Key 狀態分佈文字
  const keyDetail = [
    keyPool.active > 0 ? `\ud83d\udfe2${keyPool.active}` : null,
    keyPool.rateLimited > 0 ? `\ud83d\udfe1${keyPool.rateLimited}` : null,
    keyPool.dead > 0 ? `\ud83d\udd34${keyPool.dead}` : null,
  ].filter(Boolean).join(' ');

  // 成功率顏色
  const rateStr = `${successRate.toFixed(1)}%`;

  return (
    <Layout title="Dashboard" activeNav="dashboard">
      {/* === 統計卡片 === */}
      <div class="card-grid">
        <StatCard
          icon={'\ud83d\udd11'}
          title="Key \u6c60"
          value={keyPool.total}
          detail={keyDetail || '\u5c1a\u7121 Key'}
        />
        <StatCard
          icon={'\ud83d\udcca'}
          title="\u4eca\u65e5\u7528\u91cf"
          value={todayUsage.count}
          detail={todayUsage.trend}
        />
        <StatCard
          icon={'\u2705'}
          title="\u6210\u529f\u7387"
          value={rateStr}
          detail={successRate >= 95 ? '\u826f\u597d' : successRate >= 80 ? '\u6b63\u5e38' : '\u6ce8\u610f'}
        />
        <StatCard
          icon={'\ud83e\udde0'}
          title="\u96c6\u9ad4\u667a\u6167"
          value={collectiveIntel.onlineLobsters}
          detail="\u5728\u7dda\u9f8d\u8766\u6578"
        />
      </div>

      {/* === 即時請求流（SSE） === */}
      <div style="margin-bottom: 24px">
        <h2 class="section-title">{'\ud83d\udce1'} 即時請求流</h2>
        <div
          class="request-stream"
          id="request-stream"
          hx-ext="sse"
          sse-connect="/api/events"
        >
          <div sse-swap="request_completed" hx-swap="afterbegin">
          </div>
          <div class="empty-state" id="stream-empty">
            <p>等待請求中...</p>
          </div>
        </div>
      </div>

      {/* === 服務健康度 === */}
      <div>
        <h2 class="section-title">{'\ud83c\udfe5'} 服務健康度</h2>
        <div
          id="service-health"
          hx-get="/ui/api/health"
          hx-trigger="load, every 30s"
          hx-swap="innerHTML"
        >
          <div class="empty-state">
            <p>載入中...</p>
          </div>
        </div>
      </div>
    </Layout>
  );
};

export default DashboardPage;
