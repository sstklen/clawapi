// 卡片元件
// 用於 Dashboard 統計卡片、區塊容器

import type { FC, PropsWithChildren } from 'hono/jsx';

/** 統計卡片屬性 */
export interface StatCardProps {
  /** 卡片標題 */
  title: string;
  /** 主要數值 */
  value: string | number;
  /** 描述文字 */
  detail?: string;
  /** 圖示（emoji） */
  icon?: string;
}

/** 一般容器卡片屬性 */
export interface CardProps {
  /** 卡片標題（選填） */
  title?: string;
  /** HTML id（HTMX target 用） */
  id?: string;
  /** 額外的 CSS class */
  className?: string;
}

/**
 * 統計卡片 — Dashboard 用
 * 顯示圖示、標題、數值、輔助文字
 */
export const StatCard: FC<StatCardProps> = ({ title, value, detail, icon }) => {
  return (
    <div class="card">
      <div class="card-title">
        {icon && <span style="margin-right: 4px">{icon}</span>}
        {title}
      </div>
      <div class="card-value">{value}</div>
      {detail && <div class="card-detail">{detail}</div>}
    </div>
  );
};

/**
 * 通用容器卡片
 * 帶可選標題的區塊容器
 */
export const Card: FC<PropsWithChildren<CardProps>> = ({ title, id, className, children }) => {
  return (
    <div class={`card ${className ?? ''}`} id={id}>
      {title && <h3 class="section-title">{title}</h3>}
      {children}
    </div>
  );
};

export default Card;
