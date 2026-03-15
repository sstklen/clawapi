// 關於頁面
// 顯示版本資訊、專案連結、授權

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';

/** 關於頁面屬性 */
export interface AboutPageProps {
  version: string;
  uptime: number;
  startedAt: string;
}

/**
 * 關於頁面
 */
export const AboutPage: FC<AboutPageProps> = ({ version, uptime, startedAt }) => {
  // 格式化 uptime
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const uptimeStr = hours > 0 ? `${hours} 小時 ${minutes} 分鐘` : `${minutes} 分鐘`;

  return (
    <Layout title="關於" activeNav="about">
      <div class="page-header">
        <h1>{'\u2139\ufe0f'} 關於 ClawAPI</h1>
      </div>

      <div style="max-width: 600px;">
        {/* Logo + 標語 */}
        <div class="card" style="text-align: center; margin-bottom: 24px;">
          <div style="font-size: 4rem; margin-bottom: 8px;">{'\ud83e\udd9e'}</div>
          <h2 style="font-size: 1.5rem; font-weight: 800; color: var(--accent);">ClawAPI</h2>
          <p style="color: var(--text-secondary); margin-top: 4px;">開源 AI API 鑰匙管理器 + 智慧路由器</p>
          <div style="margin-top: 16px; font-family: monospace; font-size: 1.1rem;">
            v{version}
          </div>
        </div>

        {/* 引擎狀態 */}
        <div class="card" style="margin-bottom: 16px;">
          <h3 class="section-title">引擎狀態</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 0.875rem;">
            <div>
              <span style="color: var(--text-secondary);">版本</span>
              <div style="font-weight: 600;">v{version}</div>
            </div>
            <div>
              <span style="color: var(--text-secondary);">運行時間</span>
              <div style="font-weight: 600;">{uptimeStr}</div>
            </div>
            <div>
              <span style="color: var(--text-secondary);">啟動時間</span>
              <div style="font-weight: 600;">{startedAt.slice(0, 19).replace('T', ' ')}</div>
            </div>
            <div>
              <span style="color: var(--text-secondary);">Runtime</span>
              <div style="font-weight: 600;">Bun + Hono</div>
            </div>
          </div>
        </div>

        {/* 專案連結 */}
        <div class="card" style="margin-bottom: 16px;">
          <h3 class="section-title">專案連結</h3>
          <div style="display: flex; flex-direction: column; gap: 8px; font-size: 0.875rem;">
            <a href="https://github.com/sstklen/clawapi" target="_blank" rel="noopener">
              {'\ud83d\udc19'} GitHub Repository
            </a>
            <a href="https://github.com/sstklen/clawapi/issues" target="_blank" rel="noopener">
              {'\ud83d\udc1b'} 回報問題
            </a>
            <a href="https://github.com/sstklen/clawapi/discussions" target="_blank" rel="noopener">
              {'\ud83d\udcac'} 社群討論
            </a>
          </div>
        </div>

        {/* 授權 */}
        <div class="card">
          <h3 class="section-title">授權</h3>
          <p style="font-size: 0.875rem; color: var(--text-secondary);">
            ClawAPI 以 <strong>AGPL-3.0</strong> 授權開源。
            你可以自由使用、修改和散佈，但修改後的版本也必須開源。
          </p>
          <p style="font-size: 0.875rem; color: var(--text-secondary); margin-top: 8px;">
            {'\ud83e\udd9e'} 龍蝦共好，集體智慧。
          </p>
        </div>
      </div>
    </Layout>
  );
};

export default AboutPage;
