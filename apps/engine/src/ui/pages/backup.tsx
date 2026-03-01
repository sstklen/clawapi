// 備份管理頁面
// 匯出/匯入加密備份（v1.1 推遲，目前顯示預告）

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';

/**
 * 備份管理頁面
 */
export const BackupPage: FC = () => {
  return (
    <Layout title="備份管理" activeNav="backup">
      <div class="page-header">
        <h1>{'\ud83d\udce6'} 備份管理</h1>
        <div class="subtitle">加密備份與還原你的 ClawAPI 資料</div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 700px;">
        {/* 匯出備份 */}
        <div class="card">
          <h3 class="section-title">{'\ud83d\udce4'} 匯出備份</h3>
          <p style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 16px;">
            將所有 Key、設定、互助記錄匯出為加密檔案。備份檔以 Master Key 加密，僅你能還原。
          </p>
          <button
            class="btn btn-primary"
            hx-post="/api/backup/export"
            hx-target="#export-result"
            hx-swap="innerHTML"
          >
            匯出備份
          </button>
          <div id="export-result" style="margin-top: 12px;"></div>
        </div>

        {/* 匯入備份 */}
        <div class="card">
          <h3 class="section-title">{'\ud83d\udce5'} 匯入備份</h3>
          <p style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 16px;">
            從加密備份檔還原資料。此操作會覆蓋目前的資料，請謹慎操作。
          </p>
          <button
            class="btn btn-secondary"
            hx-post="/api/backup/import"
            hx-target="#import-result"
            hx-swap="innerHTML"
          >
            選擇備份檔
          </button>
          <div id="import-result" style="margin-top: 12px;"></div>
        </div>
      </div>

      <div class="card" style="margin-top: 24px; max-width: 700px; background: rgba(243,156,18,0.08); border-color: var(--warning);">
        <p style="font-size: 0.875rem;">
          {'\u26a0\ufe0f'} <strong>備份功能即將推出</strong> — 備份匯出/匯入功能規劃於 v1.1 版本實作。
          目前點擊按鈕會收到 501 (Not Implemented) 回應。
        </p>
      </div>
    </Layout>
  );
};

export default BackupPage;
