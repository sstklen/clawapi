// 表格元件
// 通用可排序表格，支援 HTMX 動態載入

import type { FC, PropsWithChildren } from 'hono/jsx';

/** 表格欄位定義 */
export interface TableColumn {
  /** 欄位 key */
  key: string;
  /** 顯示標題 */
  label: string;
  /** 對齊方式 */
  align?: 'left' | 'center' | 'right';
  /** 寬度 */
  width?: string;
}

/** 表格屬性 */
export interface TableProps {
  /** 欄位定義 */
  columns: TableColumn[];
  /** HTML id（HTMX target 用） */
  id?: string;
  /** 空狀態訊息 */
  emptyMessage?: string;
  /** 空狀態圖示 */
  emptyIcon?: string;
}

/**
 * 通用表格元件
 * children 放 <tbody> 內容（<tr> 列）
 */
export const Table: FC<PropsWithChildren<TableProps>> = ({
  columns,
  id,
  emptyMessage,
  emptyIcon,
  children,
}) => {
  return (
    <div class="table-container" id={id}>
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                style={`${col.align ? `text-align: ${col.align}` : ''}${col.width ? `; width: ${col.width}` : ''}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children}
        </tbody>
      </table>
      {/* 空狀態（由 HTMX 動態決定是否顯示） */}
      {emptyMessage && !children && (
        <div class="empty-state">
          {emptyIcon && <div class="emoji">{emptyIcon}</div>}
          <p>{emptyMessage}</p>
        </div>
      )}
    </div>
  );
};

/**
 * 分頁控制列
 */
export interface PaginationProps {
  /** 目前頁碼 */
  page: number;
  /** 總頁數 */
  totalPages: number;
  /** 基礎 URL（例如 /ui/api/logs?page=） */
  baseUrl: string;
  /** HTMX target */
  hxTarget?: string;
}

export const Pagination: FC<PaginationProps> = ({ page, totalPages, baseUrl, hxTarget }) => {
  if (totalPages <= 1) return null;

  return (
    <div style="display: flex; justify-content: center; gap: 8px; margin-top: 16px;">
      {page > 1 && (
        <a
          href={`${baseUrl}${page - 1}`}
          class="btn btn-secondary btn-sm"
          {...(hxTarget ? { 'hx-get': `${baseUrl}${page - 1}`, 'hx-target': hxTarget, 'hx-swap': 'outerHTML' } : {})}
        >
          上一頁
        </a>
      )}
      <span style="padding: 4px 12px; font-size: 0.8rem; color: var(--text-secondary);">
        {page} / {totalPages}
      </span>
      {page < totalPages && (
        <a
          href={`${baseUrl}${page + 1}`}
          class="btn btn-secondary btn-sm"
          {...(hxTarget ? { 'hx-get': `${baseUrl}${page + 1}`, 'hx-target': hxTarget, 'hx-swap': 'outerHTML' } : {})}
        >
          下一頁
        </a>
      )}
    </div>
  );
};

export default Table;
