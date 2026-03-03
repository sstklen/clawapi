// Claw Key 設定頁面
// 管理 Claw Key（特殊用途 Key，指定給特定模型）

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';
import { Table } from '../components/table';

/** Claw Key 項目 */
export interface ClawKeyItem {
  id: number;
  service_id: string;
  model_id: string;
  is_active: boolean;
  daily_used: number;
  daily_limit: number | null;
  created_at: string;
}

/** Claw Key 頁面屬性 */
export interface ClawKeyPageProps {
  clawKeys: ClawKeyItem[];
}

/**
 * Claw Key 設定頁面
 */
export const ClawKeyPage: FC<ClawKeyPageProps> = ({ clawKeys }) => {
  const columns = [
    { key: 'id', label: 'ID', width: '60px' },
    { key: 'service_id', label: '服務' },
    { key: 'model_id', label: '模型' },
    { key: 'status', label: '狀態', width: '80px' },
    { key: 'usage', label: '今日用量', width: '120px', align: 'right' as const },
    { key: 'created_at', label: '建立時間' },
    { key: 'actions', label: '操作', width: '80px' },
  ];

  return (
    <Layout title="Claw Key 設定" activeNav="claw-key">
      <div class="page-header">
        <h1>{'\ud83e\udd9e'} Claw Key 設定</h1>
        <div class="subtitle">指定特殊 Key 給特定模型使用，確保最高品質服務</div>
      </div>

      {/* 新增 Claw Key 表單 */}
      <div class="card" style="margin-bottom: 24px; max-width: 600px;">
        <h3 class="section-title">新增 Claw Key</h3>
        <form
          hx-post="/api/claw-keys"
          hx-target="#claw-key-list"
          hx-swap="outerHTML"
        >
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div class="form-group">
              <label for="service_id">服務 ID *</label>
              <input type="text" name="service_id" id="service_id" placeholder="openai" required />
            </div>
            <div class="form-group">
              <label for="model_id">模型 ID *</label>
              <input type="text" name="model_id" id="model_id" placeholder="gpt-4o" required />
            </div>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div class="form-group">
              <label for="key_value">API Key *</label>
              <input type="password" name="key_value" id="key_value" placeholder="sk-..." required />
            </div>
            <div class="form-group">
              <label for="daily_limit">每日上限</label>
              <input type="number" name="daily_limit" id="daily_limit" placeholder="留空 = 無限制" />
            </div>
          </div>
          <button type="submit" class="btn btn-primary">新增 Claw Key</button>
        </form>
      </div>

      {/* Claw Key 列表 */}
      <div
        id="claw-key-list"
        hx-get="/ui/api/claw-keys"
        hx-trigger="load, every 30s"
        hx-swap="outerHTML"
      >
        <Table columns={columns} emptyMessage="尚無 Claw Key" emptyIcon={'\ud83e\udd9e'}>
          {clawKeys.map((ck) => (
            <tr>
              <td>{ck.id}</td>
              <td><span class="badge badge-info">{ck.service_id}</span></td>
              <td style="font-family: monospace;">{ck.model_id}</td>
              <td>
                <span class={`badge ${ck.is_active ? 'badge-success' : 'badge-danger'}`}>
                  {ck.is_active ? '啟用' : '停用'}
                </span>
              </td>
              <td style="text-align: right">
                {ck.daily_used}{ck.daily_limit !== null ? ` / ${ck.daily_limit}` : ' / \u221e'}
              </td>
              <td style="font-size: 0.8rem; color: var(--text-secondary)">
                {ck.created_at.slice(0, 10)}
              </td>
              <td>
                <button
                  class="btn btn-danger btn-sm"
                  hx-delete={`/api/claw-keys/${ck.id}`}
                  hx-target="#claw-key-list"
                  hx-swap="outerHTML"
                  hx-confirm="確定要移除此 Claw Key？"
                >
                  {'\ud83d\uddd1\ufe0f'}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </Layout>
  );
};

export default ClawKeyPage;
