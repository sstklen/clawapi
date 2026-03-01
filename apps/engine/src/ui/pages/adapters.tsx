// Adapter 瀏覽 + 安裝頁面
// 列出已安裝的 Adapter，支援安裝新的社群 Adapter

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';

/** Adapter 項目 */
export interface AdapterItem {
  id: string;
  name: string;
  version: string;
  category: string;
  requires_key: boolean;
  free_tier: boolean;
  capabilities: {
    chat: boolean;
    streaming: boolean;
    embeddings: boolean;
    images: boolean;
    audio: boolean;
    model_count: number;
  };
}

/** Adapter 頁面屬性 */
export interface AdaptersPageProps {
  adapters: AdapterItem[];
}

/**
 * Adapter 瀏覽頁面
 */
export const AdaptersPage: FC<AdaptersPageProps> = ({ adapters }) => {
  return (
    <Layout title="Adapter" activeNav="adapters">
      <div class="page-header" style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <h1>{'\ud83e\udde9'} Adapter 管理</h1>
          <div class="subtitle">瀏覽和管理 AI 服務轉接器</div>
        </div>
      </div>

      {/* 安裝新 Adapter */}
      <div class="card" style="margin-bottom: 24px; max-width: 600px;">
        <h3 class="section-title">安裝社群 Adapter</h3>
        <form
          hx-post="/api/adapters/install"
          hx-target="#install-result"
          hx-swap="innerHTML"
          style="display: flex; gap: 12px; align-items: flex-end;"
        >
          <div class="form-group" style="flex: 1; margin-bottom: 0;">
            <label for="adapter_path">檔案路徑或 URL</label>
            <input
              type="text"
              name="path"
              id="adapter_path"
              placeholder="/path/to/adapter.yaml 或 https://..."
            />
          </div>
          <button type="submit" class="btn btn-primary" style="white-space: nowrap;">安裝</button>
        </form>
        <div id="install-result" style="margin-top: 12px;"></div>
      </div>

      {/* Adapter 列表 */}
      <div
        id="adapter-list"
        hx-get="/ui/api/adapters"
        hx-trigger="load, every 60s"
        hx-swap="outerHTML"
      >
        {adapters.length === 0 ? (
          <div class="empty-state">
            <div class="emoji">{'\ud83e\udde9'}</div>
            <p>尚無已安裝的 Adapter</p>
          </div>
        ) : (
          <div class="card-grid">
            {adapters.map((adapter) => (
              <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                  <div>
                    <div style="font-weight: 700; font-size: 1rem;">{adapter.name}</div>
                    <div style="font-size: 0.75rem; color: var(--text-secondary);">
                      {adapter.id} v{adapter.version}
                    </div>
                  </div>
                  <button
                    class="btn btn-danger btn-sm"
                    hx-delete={`/api/adapters/${adapter.id}`}
                    hx-target="#adapter-list"
                    hx-swap="outerHTML"
                    hx-confirm={`確定要移除 ${adapter.name}？`}
                  >
                    移除
                  </button>
                </div>

                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;">
                  <span class="badge badge-info">{adapter.category}</span>
                  {adapter.requires_key
                    ? <span class="badge badge-warning">需要 Key</span>
                    : <span class="badge badge-success">免費</span>
                  }
                  {adapter.free_tier && <span class="badge badge-success">Free Tier</span>}
                </div>

                <div style="font-size: 0.8rem; color: var(--text-secondary);">
                  <div>模型數：{adapter.capabilities.model_count}</div>
                  <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">
                    {adapter.capabilities.chat && <span class="badge badge-info">Chat</span>}
                    {adapter.capabilities.streaming && <span class="badge badge-info">Streaming</span>}
                    {adapter.capabilities.embeddings && <span class="badge badge-info">Embeddings</span>}
                    {adapter.capabilities.images && <span class="badge badge-info">Images</span>}
                    {adapter.capabilities.audio && <span class="badge badge-info">Audio</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
};

export default AdaptersPage;
