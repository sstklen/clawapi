// 導覽列元件
// 桌面：頂部水平導覽；手機：底部固定導覽
// 包含主題切換按鈕

import type { FC } from 'hono/jsx';

/** 導覽項目定義 */
interface NavItem {
  /** 路徑 */
  href: string;
  /** 顯示文字 */
  label: string;
  /** 圖示（emoji） */
  icon: string;
  /** 導覽 key（用於 active 判斷） */
  key: string;
}

/** 導覽列屬性 */
export interface NavProps {
  /** 目前選中的導覽 key */
  active?: string;
}

/** 導覽項目列表 */
const NAV_ITEMS: NavItem[] = [
  { href: '/ui', label: '總覽', icon: '\ud83c\udfe0', key: 'dashboard' },
  { href: '/ui/keys', label: 'Keys', icon: '\ud83d\udd11', key: 'keys' },
  { href: '/ui/claw-key', label: 'Claw Key', icon: '\ud83e\udd9e', key: 'claw-key' },
  { href: '/ui/sub-keys', label: 'Sub-Keys', icon: '\ud83d\udd10', key: 'sub-keys' },
  { href: '/ui/aid', label: '\u4e92\u52a9', icon: '\ud83e\udd1d', key: 'aid' },
  { href: '/ui/adapters', label: 'Adapter', icon: '\ud83e\udde9', key: 'adapters' },
  { href: '/ui/logs', label: '\u65e5\u8a8c', icon: '\ud83d\udcdd', key: 'logs' },
  { href: '/ui/settings', label: '\u8a2d\u5b9a', icon: '\u2699\ufe0f', key: 'settings' },
];

/** 導覽列 CSS（行內樣式避免汙染全域） */
const NAV_CSS = `
.top-nav {
  background: var(--nav-bg);
  border-bottom: 1px solid var(--nav-border);
  padding: 0 16px;
  display: flex;
  align-items: center;
  height: 56px;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}
.nav-brand {
  font-size: 1.1rem;
  font-weight: 800;
  color: var(--accent);
  margin-right: 32px;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.nav-brand:hover { text-decoration: none; }
.nav-links {
  display: flex;
  gap: 4px;
  flex: 1;
  overflow-x: auto;
}
.nav-link {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.825rem;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.nav-link:hover {
  background: var(--card);
  color: var(--text);
  text-decoration: none;
}
.nav-link.active {
  background: var(--accent);
  color: #fff;
}
.nav-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* 手機底部導覽 */
.bottom-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--nav-bg);
  border-top: 1px solid var(--nav-border);
  padding: 4px 0;
  z-index: 100;
  box-shadow: 0 -1px 3px rgba(0,0,0,0.05);
}
.bottom-nav-links {
  display: flex;
  justify-content: space-around;
}
.bottom-nav-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  font-size: 0.65rem;
  color: var(--text-secondary);
  text-decoration: none;
}
.bottom-nav-link .nav-icon { font-size: 1.2rem; }
.bottom-nav-link.active { color: var(--accent); }
.bottom-nav-link:hover { text-decoration: none; }

@media (max-width: 768px) {
  .top-nav .nav-links { display: none; }
  .bottom-nav { display: block; }
}
`;

/**
 * 導覽列元件
 * - 桌面：頂部黏著式水平導覽
 * - 手機：底部固定式圖示導覽
 */
export const Nav: FC<NavProps> = ({ active }) => {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: NAV_CSS }} />

      {/* 桌面導覽列 */}
      <nav class="top-nav">
        <a href="/ui" class="nav-brand">
          <span>{'\ud83e\udd9e'}</span>
          <span>ClawAPI</span>
        </a>
        <div class="nav-links">
          {NAV_ITEMS.map((item) => (
            <a
              href={item.href}
              class={`nav-link ${active === item.key ? 'active' : ''}`}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </a>
          ))}
        </div>
        <div class="nav-right">
          <a href="/ui/backup" class={`nav-link ${active === 'backup' ? 'active' : ''}`}>
            {'\ud83d\udce6'} 備份
          </a>
          <a href="/ui/about" class={`nav-link ${active === 'about' ? 'active' : ''}`}>
            {'\u2139\ufe0f'} 關於
          </a>
          <button
            id="theme-btn"
            class="theme-toggle"
            onclick="toggleTheme()"
            title="切換深淺主題"
          >
            {'\ud83c\udf19'}
          </button>
        </div>
      </nav>

      {/* 手機底部導覽 */}
      <nav class="bottom-nav">
        <div class="bottom-nav-links">
          {NAV_ITEMS.slice(0, 5).map((item) => (
            <a
              href={item.href}
              class={`bottom-nav-link ${active === item.key ? 'active' : ''}`}
            >
              <span class="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </a>
          ))}
          <a
            href="/ui/settings"
            class={`bottom-nav-link ${active === 'settings' ? 'active' : ''}`}
          >
            <span class="nav-icon">{'\u2699\ufe0f'}</span>
            <span>更多</span>
          </a>
        </div>
      </nav>
    </>
  );
};

export default Nav;
