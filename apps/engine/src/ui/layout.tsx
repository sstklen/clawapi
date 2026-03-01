// ClawAPI Web UI — 共用 Layout
// SSR HTML 外殼：包含 DOCTYPE、CSS 變數、HTMX CDN、導覽列
// 所有 CSS 內嵌於此檔案中（零外部依賴）

import type { FC, PropsWithChildren } from 'hono/jsx';
import { Nav } from './components/nav';

/** Layout 頁面屬性 */
export interface LayoutProps {
  /** 頁面標題（顯示在 <title> 和 header） */
  title: string;
  /** 目前選中的導覽項目 */
  activeNav?: string;
}

/** 內嵌 CSS 樣式（深淺主題 + 響應式） */
const CSS = `
/* ===== 基礎變數（淺色主題） ===== */
:root {
  --bg: #ffffff;
  --bg-secondary: #f8f9fa;
  --text: #1a1a1a;
  --text-secondary: #6c757d;
  --card: #f5f5f5;
  --card-border: #e0e0e0;
  --accent: #e74c3c;
  --accent-hover: #c0392b;
  --success: #2ecc71;
  --warning: #f39c12;
  --danger: #e74c3c;
  --info: #3498db;
  --border: #dee2e6;
  --shadow: 0 2px 8px rgba(0,0,0,0.08);
  --radius: 8px;
  --nav-bg: #ffffff;
  --nav-border: #e0e0e0;
  --input-bg: #ffffff;
  --input-border: #ced4da;
  --table-stripe: #f8f9fa;
  --progress-bg: #e9ecef;
  --code-bg: #f1f3f5;
}

/* ===== 深色主題 ===== */
[data-theme="dark"] {
  --bg: #1a1a2e;
  --bg-secondary: #16213e;
  --text: #e0e0e0;
  --text-secondary: #a0a0b0;
  --card: #16213e;
  --card-border: #2a2a4a;
  --accent: #ff6b6b;
  --accent-hover: #ee5a5a;
  --success: #2ecc71;
  --warning: #f39c12;
  --danger: #ff6b6b;
  --info: #5dade2;
  --border: #2a2a4a;
  --shadow: 0 2px 8px rgba(0,0,0,0.3);
  --nav-bg: #16213e;
  --nav-border: #2a2a4a;
  --input-bg: #1a1a2e;
  --input-border: #2a2a4a;
  --table-stripe: #1e1e3a;
  --progress-bg: #2a2a4a;
  --code-bg: #0f0f23;
}

/* ===== 基礎 Reset ===== */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans TC', sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
}

a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); text-decoration: underline; }

/* ===== 主容器 ===== */
.app-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.main-content {
  flex: 1;
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
  padding: 24px 16px;
}

/* ===== 頁面標頭 ===== */
.page-header {
  margin-bottom: 24px;
}
.page-header h1 {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text);
}
.page-header .subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* ===== 卡片 ===== */
.card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  padding: 20px;
  box-shadow: var(--shadow);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.card:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.card .card-title {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.card .card-value {
  font-size: 1.75rem;
  font-weight: 700;
}
.card .card-detail {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* ===== 表格 ===== */
.table-container {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
thead th {
  background: var(--card);
  padding: 12px 16px;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 2px solid var(--border);
  white-space: nowrap;
}
tbody td {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
tbody tr:nth-child(even) {
  background: var(--table-stripe);
}
tbody tr:hover {
  background: var(--card);
}

/* ===== 表單 ===== */
.form-group {
  margin-bottom: 16px;
}
.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 6px;
}
.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--input-border);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 0.875rem;
  transition: border-color 0.15s;
}
.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(231, 76, 60, 0.15);
}
.form-hint {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* ===== 按鈕 ===== */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
  text-decoration: none;
}
.btn:hover { transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); color: #fff; text-decoration: none; }
.btn-secondary { background: var(--card); color: var(--text); border: 1px solid var(--border); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-success { background: var(--success); color: #fff; }
.btn-sm { padding: 4px 10px; font-size: 0.8rem; }
.btn-group { display: flex; gap: 8px; flex-wrap: wrap; }

/* ===== 狀態指示 ===== */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}
.status-dot.green { background: var(--success); }
.status-dot.yellow { background: var(--warning); }
.status-dot.red { background: var(--danger); }

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
}
.badge-success { background: rgba(46,204,113,0.15); color: var(--success); }
.badge-warning { background: rgba(243,156,18,0.15); color: var(--warning); }
.badge-danger { background: rgba(231,76,60,0.15); color: var(--danger); }
.badge-info { background: rgba(52,152,219,0.15); color: var(--info); }

/* ===== 進度條 ===== */
.progress {
  width: 100%;
  height: 8px;
  background: var(--progress-bg);
  border-radius: 4px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}
.progress-bar.green { background: var(--success); }
.progress-bar.yellow { background: var(--warning); }
.progress-bar.red { background: var(--danger); }

/* ===== 即時請求流 ===== */
.request-stream {
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--bg-secondary);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.8rem;
}
.stream-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.stream-item:last-child { border-bottom: none; }
.stream-time { color: var(--text-secondary); white-space: nowrap; }

/* ===== 主題切換 ===== */
.theme-toggle {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 1rem;
  color: var(--text);
  transition: background 0.15s;
}
.theme-toggle:hover {
  background: var(--card);
}

/* ===== 空狀態 ===== */
.empty-state {
  text-align: center;
  padding: 48px 24px;
  color: var(--text-secondary);
}
.empty-state .emoji { font-size: 3rem; margin-bottom: 12px; }
.empty-state p { font-size: 0.875rem; }

/* ===== Section 標題 ===== */
.section-title {
  font-size: 1.1rem;
  font-weight: 700;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--accent);
  display: inline-block;
}

/* ===== 載入指示（HTMX） ===== */
.htmx-indicator {
  display: none;
}
.htmx-request .htmx-indicator,
.htmx-request.htmx-indicator {
  display: inline-block;
}

/* ===== 響應式：平板 ===== */
@media (max-width: 1024px) {
  .card-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .main-content {
    padding: 16px 12px;
  }
}

/* ===== 響應式：手機 ===== */
@media (max-width: 768px) {
  .card-grid {
    grid-template-columns: 1fr;
  }
  .main-content {
    padding: 12px 8px;
    padding-bottom: 80px;
  }
  .page-header h1 {
    font-size: 1.25rem;
  }
  table { font-size: 0.8rem; }
  thead th, tbody td { padding: 8px 10px; }
}
`;

/** 主題切換 JavaScript */
const THEME_SCRIPT = `
(function() {
  var theme = localStorage.getItem('clawapi-theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);

  window.toggleTheme = function() {
    var current = document.documentElement.getAttribute('data-theme');
    var next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('clawapi-theme', next);
    var btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = next === 'dark' ? '\\u2600\\ufe0f' : '\\ud83c\\udf19';
  };
})();
`;

/**
 * 共用 Layout 元件
 * 提供完整 HTML 外殼，包含 CSS、HTMX CDN、導覽列
 */
export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, activeNav, children }) => {
  return (
    <html lang="zh-Hant" data-theme="light">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title} — ClawAPI</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <div class="app-container">
          <Nav active={activeNav} />
          <main class="main-content">
            {children}
          </main>
        </div>
        {/* HTMX CDN（放在 body 底部以加速首屏） */}
        <script src="https://unpkg.com/htmx.org@1.9.12" integrity="sha384-ujb1lZYygJmzgSwoxRggbCHcjc0rB2XoQrxeTUQyRjrOnlCoYta87iKBWq3EsdM2" crossorigin="anonymous"></script>
        {/* HTMX SSE 擴展 */}
        <script src="https://unpkg.com/htmx.org@1.9.12/dist/ext/sse.js" integrity="sha384-OZrRw8/Zvv0VFGJJF6TN3gABVZvvO60Xz7RWkQKAmoRe+t1dc5J/ySJvXbpL+N+Q" crossorigin="anonymous"></script>
      </body>
    </html>
  );
};

export default Layout;
