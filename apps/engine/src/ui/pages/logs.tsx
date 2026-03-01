// 使用紀錄頁面
// 搜尋 + 篩選 API 使用記錄、支援匯出 CSV

import type { FC } from 'hono/jsx';
import { Layout } from '../layout';
import { Table } from '../components/table';

/** 日誌項目 */
export interface LogItem {
  id: number;
  timestamp: string;
  service_id: string;
  model: string | null;
  layer: string;
  success: boolean;
  latency_ms: number;
  tokens_input: number | null;
  tokens_output: number | null;
  error_code: string | null;
}

/** 日誌頁面屬性 */
export interface LogsPageProps {
  logs: LogItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 使用紀錄頁面
 */
export const LogsPage: FC<LogsPageProps> = ({ logs, total, page, pageSize }) => {
  const totalPages = Math.ceil(total / pageSize);

  const columns = [
    { key: 'time', label: '時間' },
    { key: 'status', label: '', width: '30px' },
    { key: 'service', label: '服務' },
    { key: 'model', label: '模型' },
    { key: 'layer', label: '層級', width: '60px' },
    { key: 'latency', label: '延遲', width: '80px', align: 'right' as const },
    { key: 'tokens', label: 'Tokens', width: '100px', align: 'right' as const },
    { key: 'error', label: '錯誤', width: '100px' },
  ];

  return (
    <Layout title="使用紀錄" activeNav="logs">
      <div class="page-header" style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <h1>{'\ud83d\udcdd'} 使用紀錄</h1>
          <div class="subtitle">共 {total} 筆紀錄</div>
        </div>
        <a
          href="/api/logs/export"
          class="btn btn-secondary"
          target="_blank"
        >
          {'\ud83d\udce5'} 匯出 CSV
        </a>
      </div>

      {/* 篩選列 */}
      <div class="card" style="margin-bottom: 16px;">
        <form
          hx-get="/ui/api/logs"
          hx-target="#log-table"
          hx-swap="outerHTML"
          style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;"
        >
          <div class="form-group" style="margin-bottom: 0; min-width: 140px;">
            <label for="service_id" style="font-size: 0.75rem;">服務</label>
            <input type="text" name="service_id" id="service_id" placeholder="全部" />
          </div>
          <div class="form-group" style="margin-bottom: 0; min-width: 100px;">
            <label for="layer" style="font-size: 0.75rem;">層級</label>
            <select name="layer" id="layer">
              <option value="">全部</option>
              <option value="L1">L1</option>
              <option value="L2">L2</option>
              <option value="L3">L3</option>
              <option value="L4">L4</option>
            </select>
          </div>
          <div class="form-group" style="margin-bottom: 0; min-width: 100px;">
            <label for="success" style="font-size: 0.75rem;">狀態</label>
            <select name="success" id="success">
              <option value="">全部</option>
              <option value="true">成功</option>
              <option value="false">失敗</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary btn-sm">篩選</button>
        </form>
      </div>

      {/* 日誌表格 */}
      <div id="log-table">
        <Table columns={columns} emptyMessage="無符合條件的紀錄" emptyIcon={'\ud83d\udcdd'}>
          {logs.map((log) => (
            <tr>
              <td style="font-size: 0.8rem; white-space: nowrap; color: var(--text-secondary);">
                {log.timestamp.slice(11, 19)}
              </td>
              <td>
                {log.success
                  ? <span title="成功">{'\u2705'}</span>
                  : <span title="失敗">{'\u274c'}</span>
                }
              </td>
              <td><span class="badge badge-info">{log.service_id}</span></td>
              <td style="font-family: monospace; font-size: 0.8rem;">{log.model ?? '-'}</td>
              <td><span class="badge badge-info">{log.layer}</span></td>
              <td style="text-align: right; font-family: monospace;">{log.latency_ms}ms</td>
              <td style="text-align: right; font-family: monospace; font-size: 0.8rem;">
                {log.tokens_input !== null ? `${log.tokens_input}/${log.tokens_output ?? 0}` : '-'}
              </td>
              <td>
                {log.error_code
                  ? <span class="badge badge-danger">{log.error_code}</span>
                  : '-'
                }
              </td>
            </tr>
          ))}
        </Table>

        {/* 分頁 */}
        {totalPages > 1 && (
          <div style="display: flex; justify-content: center; gap: 8px; margin-top: 16px;">
            {page > 1 && (
              <button
                class="btn btn-secondary btn-sm"
                hx-get={`/ui/api/logs?page=${page - 1}`}
                hx-target="#log-table"
                hx-swap="outerHTML"
              >
                上一頁
              </button>
            )}
            <span style="padding: 4px 12px; font-size: 0.8rem; color: var(--text-secondary);">
              {page} / {totalPages}
            </span>
            {page < totalPages && (
              <button
                class="btn btn-secondary btn-sm"
                hx-get={`/ui/api/logs?page=${page + 1}`}
                hx-target="#log-table"
                hx-swap="outerHTML"
              >
                下一頁
              </button>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
};

export default LogsPage;
