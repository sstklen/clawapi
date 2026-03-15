// Key 管理頁面
// 列出所有 API Key、支援新增 / 刪除 / 釘選 / 輪換

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';
import { Table } from '../components/table';

/** Key 列表資料 */
export interface KeyItem {
  id: number;
  service_id: string;
  masked_key: string;
  pool_type: 'king' | 'friend';
  status: 'active' | 'rate_limited' | 'dead';
  label?: string;
  pinned: boolean;
  success_rate: number;
  total_requests: number;
  created_at: string;
}

/** Key 列表頁屬性 */
export interface KeysPageProps {
  keys: KeyItem[];
}

/** 狀態 badge — 安全規則：用 JSX 組件取代 dangerouslySetInnerHTML */
function statusBadgeJsx(status: string) {
  switch (status) {
    case 'active': return <span class="badge badge-success">正常</span>;
    case 'rate_limited': return <span class="badge badge-warning">限速</span>;
    case 'dead': return <span class="badge badge-danger">失效</span>;
    default: return <span class="badge badge-info">未知</span>;
  }
}

/**
 * Key 管理頁面
 */
export const KeysPage: FC<KeysPageProps> = ({ keys }) => {
  const columns = [
    { key: 'id', label: 'ID', width: '60px' },
    { key: 'service_id', label: '服務' },
    { key: 'key', label: 'Key' },
    { key: 'pool_type', label: '類型', width: '80px' },
    { key: 'status', label: '狀態', width: '80px' },
    { key: 'success_rate', label: '成功率', width: '80px', align: 'right' as const },
    { key: 'requests', label: '請求數', width: '80px', align: 'right' as const },
    { key: 'actions', label: '操作', width: '120px' },
  ];

  return (
    <Layout title="Key \u7ba1\u7406" activeNav="keys">
      <div class="page-header" style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <h1>{'\ud83d\udd11'} Key 管理</h1>
          <div class="subtitle">管理你的 API Key 池</div>
        </div>
        <a href="/ui/keys/add" class="btn btn-primary">+ 新增 Key</a>
      </div>

      <div
        id="key-list"
        hx-get="/ui/api/keys"
        hx-trigger="load, every 30s"
        hx-swap="outerHTML"
      >
        <Table columns={columns} emptyMessage="尚無 Key，點擊右上角新增" emptyIcon={'\ud83d\udd11'}>
          {keys.map((key) => (
            <tr>
              <td>{key.id}</td>
              <td>
                <span class="badge badge-info">{key.service_id}</span>
              </td>
              <td style="font-family: monospace; font-size: 0.8rem;">{key.masked_key}</td>
              <td>{key.pool_type === 'king' ? '\ud83d\udc51 自有' : '\ud83e\udd1d 朋友'}</td>
              <td>{statusBadgeJsx(key.status)}</td>
              <td style="text-align: right">{key.success_rate.toFixed(0)}%</td>
              <td style="text-align: right">{key.total_requests}</td>
              <td>
                <div class="btn-group">
                  <button
                    class="btn btn-secondary btn-sm"
                    hx-put={`/api/keys/${key.id}/pin`}
                    hx-vals={JSON.stringify({ pinned: !key.pinned })}
                    hx-target="#key-list"
                    hx-swap="outerHTML"
                  >
                    {key.pinned ? '\ud83d\udccc' : '\ud83d\udccd'}
                  </button>
                  <button
                    class="btn btn-danger btn-sm"
                    hx-delete={`/api/keys/${key.id}`}
                    hx-target="#key-list"
                    hx-swap="outerHTML"
                    hx-confirm="確定要刪除此 Key？"
                  >
                    {'\ud83d\uddd1\ufe0f'}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </Layout>
  );
};

/**
 * 新增 Key 頁面
 */
export const KeysAddPage: FC = () => {
  return (
    <Layout title="新增 Key" activeNav="keys">
      <div class="page-header">
        <h1>{'\u2795'} 新增 API Key</h1>
        <div class="subtitle">將 API Key 加入 Key 池</div>
      </div>

      <div class="card" style="max-width: 600px;">
        <form
          hx-post="/api/keys"
          hx-target="#form-result"
          hx-swap="innerHTML"
        >
          <div class="form-group">
            <label for="service_id">服務 ID *</label>
            <input
              type="text"
              name="service_id"
              id="service_id"
              placeholder="例如：openai, groq, anthropic"
              required
            />
            <div class="form-hint">對應 Adapter 的服務識別碼</div>
          </div>

          <div class="form-group">
            <label for="key_value">API Key *</label>
            <input
              type="password"
              name="key_value"
              id="key_value"
              placeholder="sk-..."
              required
            />
            <div class="form-hint">Key 會以加密形式儲存在本機</div>
          </div>

          <div class="form-group">
            <label for="pool_type">類型</label>
            <select name="pool_type" id="pool_type">
              <option value="king">自有 Key（king）</option>
              <option value="friend">朋友 Key（friend）</option>
            </select>
          </div>

          <div class="form-group">
            <label for="label">標籤</label>
            <input
              type="text"
              name="label"
              id="label"
              placeholder="選填，方便識別用"
            />
          </div>

          <div class="btn-group" style="margin-top: 24px;">
            <button type="submit" class="btn btn-primary">新增 Key</button>
            <a href="/ui/keys" class="btn btn-secondary">取消</a>
          </div>
        </form>

        <div id="form-result" style="margin-top: 16px;"></div>
      </div>
    </Layout>
  );
};

export default KeysPage;
