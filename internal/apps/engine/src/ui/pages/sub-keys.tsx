// Sub-Key 管理頁面
// 列出、發行、撤銷 Sub-Key

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';
import { Table } from '../components/table';

/** Sub-Key 項目 */
export interface SubKeyItem {
  id: number;
  label: string;
  token: string;
  is_active: boolean;
  daily_used: number;
  daily_limit: number | null;
  total_requests: number;
  created_at: string;
  expires_at: string | null;
}

/** Sub-Key 列表頁屬性 */
export interface SubKeysPageProps {
  subKeys: SubKeyItem[];
}

/**
 * Sub-Key 管理頁面
 */
export const SubKeysPage: FC<SubKeysPageProps> = ({ subKeys }) => {
  const columns = [
    { key: 'id', label: 'ID', width: '60px' },
    { key: 'label', label: '標籤' },
    { key: 'token', label: 'Token' },
    { key: 'status', label: '狀態', width: '80px' },
    { key: 'usage', label: '用量', width: '100px', align: 'right' as const },
    { key: 'total', label: '總請求', width: '80px', align: 'right' as const },
    { key: 'expires', label: '過期時間' },
    { key: 'actions', label: '操作', width: '80px' },
  ];

  return (
    <Layout title="Sub-Key 管理" activeNav="sub-keys">
      <div class="page-header" style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <h1>{'\ud83d\udd10'} Sub-Key 管理</h1>
          <div class="subtitle">發行與管理下游存取 Token</div>
        </div>
        <a href="/ui/sub-keys/issue" class="btn btn-primary">+ 發行 Sub-Key</a>
      </div>

      <div
        id="sub-key-list"
        hx-get="/ui/api/sub-keys"
        hx-trigger="load, every 30s"
        hx-swap="outerHTML"
      >
        <Table columns={columns} emptyMessage="尚無 Sub-Key" emptyIcon={'\ud83d\udd10'}>
          {subKeys.map((sk) => (
            <tr>
              <td>{sk.id}</td>
              <td>{sk.label}</td>
              <td style="font-family: monospace; font-size: 0.8rem;">{sk.token}</td>
              <td>
                <span class={`badge ${sk.is_active ? 'badge-success' : 'badge-danger'}`}>
                  {sk.is_active ? '啟用' : '停用'}
                </span>
              </td>
              <td style="text-align: right">
                {sk.daily_used}{sk.daily_limit !== null ? ` / ${sk.daily_limit}` : ''}
              </td>
              <td style="text-align: right">{sk.total_requests}</td>
              <td style="font-size: 0.8rem; color: var(--text-secondary)">
                {sk.expires_at ? sk.expires_at.slice(0, 10) : '永不過期'}
              </td>
              <td>
                <button
                  class="btn btn-danger btn-sm"
                  hx-delete={`/api/sub-keys/${sk.id}`}
                  hx-target="#sub-key-list"
                  hx-swap="outerHTML"
                  hx-confirm={`確定要撤銷 Sub-Key「${sk.label}」？`}
                >
                  {'\ud83d\udeab'}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </Layout>
  );
};

/**
 * 發行 Sub-Key 頁面
 */
export const SubKeysIssuePage: FC = () => {
  return (
    <Layout title="發行 Sub-Key" activeNav="sub-keys">
      <div class="page-header">
        <h1>{'\ud83c\udf9f\ufe0f'} 發行 Sub-Key</h1>
        <div class="subtitle">建立帶有限額的下游存取 Token</div>
      </div>

      <div class="card" style="max-width: 600px;">
        <form
          hx-post="/api/sub-keys"
          hx-target="#issue-result"
          hx-swap="innerHTML"
        >
          <div class="form-group">
            <label for="label">標籤 *</label>
            <input
              type="text"
              name="label"
              id="label"
              placeholder="例如：前端 App、朋友小明"
              required
            />
            <div class="form-hint">用來識別此 Sub-Key 的用途</div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div class="form-group">
              <label for="daily_limit">每日請求上限</label>
              <input type="number" name="daily_limit" id="daily_limit" placeholder="留空 = 無限制" />
            </div>
            <div class="form-group">
              <label for="expires_in_days">有效天數</label>
              <input type="number" name="expires_in_days" id="expires_in_days" placeholder="留空 = 永不過期" />
            </div>
          </div>

          <div class="form-group">
            <label for="allowed_services">允許服務</label>
            <input
              type="text"
              name="allowed_services"
              id="allowed_services"
              placeholder="留空 = 全部允許，或用逗號分隔：openai,groq"
            />
            <div class="form-hint">限制此 Sub-Key 可存取的服務清單</div>
          </div>

          <div class="btn-group" style="margin-top: 24px;">
            <button type="submit" class="btn btn-primary">發行 Sub-Key</button>
            <a href="/ui/sub-keys" class="btn btn-secondary">取消</a>
          </div>
        </form>

        <div id="issue-result" style="margin-top: 16px;"></div>
      </div>
    </Layout>
  );
};

export default SubKeysPage;
