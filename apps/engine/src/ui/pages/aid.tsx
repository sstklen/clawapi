// 互助設定頁面
// 顯示互助設定、統計、互助紀錄

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';
import { StatCard } from '../components/card';

/** 互助設定資料 */
export interface AidConfig {
  enabled: boolean;
  allowed_services: string[] | null;
  daily_limit: number;
  daily_given: number;
  blackout_hours: number[];
  has_helper_key: boolean;
}

/** 互助統計資料 */
export interface AidStats {
  total_given: number;
  total_received: number;
  karma_score: number;
}

/** 互助頁面屬性 */
export interface AidPageProps {
  config: AidConfig;
  stats: AidStats;
}

/**
 * 互助設定頁面
 */
export const AidPage: FC<AidPageProps> = ({ config, stats }) => {
  return (
    <Layout title="互助設定" activeNav="aid">
      <div class="page-header">
        <h1>{'\ud83e\udd1d'} 互助設定</h1>
        <div class="subtitle">與其他龍蝦互通有無，共享 API 資源</div>
      </div>

      {/* 統計卡片 */}
      <div class="card-grid">
        <StatCard
          icon={'\ud83c\udf81'}
          title="已幫助他人"
          value={stats.total_given}
          detail="次請求"
        />
        <StatCard
          icon={'\ud83d\ude4f'}
          title="獲得幫助"
          value={stats.total_received}
          detail="次請求"
        />
        <StatCard
          icon={'\u2728'}
          title="Karma 分數"
          value={stats.karma_score}
          detail={stats.karma_score >= 0 ? '正面信譽' : '需要改善'}
        />
      </div>

      {/* 互助開關與設定 */}
      <div class="card" style="max-width: 600px; margin-bottom: 24px;">
        <h3 class="section-title">互助設定</h3>
        <form
          hx-put="/api/aid/config"
          hx-target="#aid-result"
          hx-swap="innerHTML"
        >
          <div class="form-group">
            <label>
              <input
                type="checkbox"
                name="enabled"
                value="true"
                checked={config.enabled}
                style="margin-right: 8px;"
              />
              啟用互助功能
            </label>
            <div class="form-hint">啟用後，你可以幫助其他龍蝦，也可以接受幫助</div>
          </div>

          <div class="form-group">
            <label for="daily_limit">每日互助上限</label>
            <input
              type="number"
              name="daily_limit"
              id="daily_limit"
              value={String(config.daily_limit)}
              min="0"
            />
            <div class="form-hint">
              今日已幫助：{config.daily_given} / {config.daily_limit} 次
            </div>
          </div>

          <div class="form-group">
            <label for="allowed_services">允許互助的服務</label>
            <input
              type="text"
              name="allowed_services"
              id="allowed_services"
              placeholder="留空 = 全部允許"
              value={config.allowed_services?.join(', ') ?? ''}
            />
          </div>

          <div class="btn-group" style="margin-top: 16px;">
            <button type="submit" class="btn btn-primary">儲存設定</button>
          </div>
        </form>
        <div id="aid-result" style="margin-top: 12px;"></div>
      </div>

      {/* 即時互助紀錄（SSE） */}
      <div>
        <h2 class="section-title">{'\ud83d\udce1'} 互助即時紀錄</h2>
        <div
          class="request-stream"
          hx-ext="sse"
          sse-connect="/api/events"
        >
          <div sse-swap="aid_event" hx-swap="afterbegin"></div>
          <div class="empty-state">
            <p>等待互助事件...</p>
          </div>
        </div>
      </div>
    </Layout>
  );
};

export default AidPage;
