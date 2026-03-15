// Claude Bot — 版本發布 SOP
// 7 步驟發布框架、Changelog 自動生成、發布檢查清單

// ===== 型別定義 =====

// 版本號（語意化版本）
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;  // 例如 'alpha.1', 'beta.2'
}

// PR 標籤對應的 Changelog 分類
export type PRLabel =
  | 'breaking-change'
  | 'feature'
  | 'enhancement'
  | 'bug'
  | 'security'
  | 'adapter'
  | 'docs'
  | 'performance'
  | 'refactor'
  | 'test'
  | 'chore';

// PR 資訊（Changelog 用）
export interface PRRecord {
  number: number;
  title: string;
  author: string;
  labels: PRLabel[];
  mergedAt: string;   // ISO 8601
}

// Changelog 條目
export interface ChangelogEntry {
  category: string;
  items: string[];
}

// 發布步驟狀態
export interface ReleaseStep {
  step: number;
  title: string;
  description: string;
  status: 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped';
  checklist?: string[];
}

// 發布計劃
export interface ReleasePlan {
  version: string;
  previousVersion: string;
  releaseType: 'major' | 'minor' | 'patch' | 'prerelease';
  steps: ReleaseStep[];
  changelog: ChangelogEntry[];
  generatedAt: string;
}

// ===== 常數 =====

// PR 標籤對應 Changelog 分類（顯示名稱）
const LABEL_TO_CATEGORY: Partial<Record<PRLabel, string>> = {
  'breaking-change': '⚠️ 破壞性變更',
  'feature': '✨ 新功能',
  'enhancement': '🚀 功能改進',
  'bug': '🐛 Bug 修復',
  'security': '🔒 安全修復',
  'adapter': '🔌 Adapter 更新',
  'docs': '📚 文件更新',
  'performance': '⚡ 效能優化',
};

// 不列入 Changelog 的標籤
const EXCLUDED_LABELS: PRLabel[] = ['refactor', 'test', 'chore'];

// Changelog 分類優先順序
const CATEGORY_ORDER = [
  '⚠️ 破壞性變更',
  '🔒 安全修復',
  '✨ 新功能',
  '🚀 功能改進',
  '🐛 Bug 修復',
  '🔌 Adapter 更新',
  '⚡ 效能優化',
  '📚 文件更新',
];

// ===== 版本號工具 =====

// 解析語意化版本字串
export function parseSemVer(version: string): SemVer | null {
  // 移除 'v' 前綴
  const clean = version.replace(/^v/, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;

  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
    prerelease: match[4],
  };
}

// 格式化語意化版本為字串
export function formatSemVer(version: SemVer): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${base}-${version.prerelease}` : base;
}

// 根據 PR 標籤判定版本升級類型
export function determineReleaseType(
  prs: PRRecord[],
): 'major' | 'minor' | 'patch' {
  const allLabels = prs.flatMap(pr => pr.labels);

  if (allLabels.includes('breaking-change')) return 'major';
  if (allLabels.some(l => l === 'feature' || l === 'enhancement')) return 'minor';
  return 'patch';
}

// 計算下一個版本號
export function bumpVersion(
  current: SemVer,
  releaseType: 'major' | 'minor' | 'patch',
): SemVer {
  switch (releaseType) {
    case 'major':
      return { major: current.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: current.major, minor: current.minor + 1, patch: 0 };
    case 'patch':
      return { major: current.major, minor: current.minor, patch: current.patch + 1 };
  }
}

// ===== Changelog 生成 =====

// 從 PR 列表自動生成 Changelog
export function generateChangelog(prs: PRRecord[]): ChangelogEntry[] {
  const categoryMap = new Map<string, string[]>();

  for (const pr of prs) {
    // 找出第一個有對應分類的標籤
    const primaryLabel = pr.labels.find(l => !EXCLUDED_LABELS.includes(l));
    if (!primaryLabel) continue;

    const category = LABEL_TO_CATEGORY[primaryLabel];
    if (!category) continue;

    const item = `#${pr.number} ${pr.title}（by @${pr.author}）`;

    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }
    categoryMap.get(category)!.push(item);
  }

  // 依優先順序排序
  const result: ChangelogEntry[] = [];
  for (const cat of CATEGORY_ORDER) {
    const items = categoryMap.get(cat);
    if (items && items.length > 0) {
      result.push({ category: cat, items });
    }
  }

  return result;
}

// 將 Changelog 格式化為 Markdown
export function formatChangelog(
  version: string,
  changelog: ChangelogEntry[],
  date?: string,
): string {
  const releaseDate = date ?? new Date().toISOString().slice(0, 10);
  let md = `## [${version}] — ${releaseDate}\n\n`;

  if (changelog.length === 0) {
    md += '本版本僅包含內部改善，無用戶可見的變更。\n';
    return md;
  }

  for (const entry of changelog) {
    md += `### ${entry.category}\n\n`;
    for (const item of entry.items) {
      md += `- ${item}\n`;
    }
    md += '\n';
  }

  return md;
}

// ===== 發布 SOP（7 步驟框架）=====

const RELEASE_STEPS: Omit<ReleaseStep, 'status'>[] = [
  {
    step: 1,
    title: '準備發布分支',
    description: '從 main 建立 release 分支，更新版本號',
    checklist: [
      '確認 main 分支所有 CI 通過',
      '建立 release/v{version} 分支',
      '更新 package.json 版本號',
      '更新 CHANGELOG.md',
      '提交版本更新 commit',
    ],
  },
  {
    step: 2,
    title: '安全審查',
    description: '對本次發布的所有 Adapter 變更執行安全掃描',
    checklist: [
      '執行 Adapter 三層安全掃描',
      '確認無未知 URL 域名',
      '確認無危險模板變數',
      '確認無危險程式碼模式',
      'Security 標記的 PR 已由人工複審',
    ],
  },
  {
    step: 3,
    title: '測試驗證',
    description: '執行完整測試套件確認本版本穩定',
    checklist: [
      '執行 `bun test` 全部通過',
      '執行 `bunx tsc --noEmit` 零型別錯誤',
      '執行整合測試（所有子系統）',
      '在 staging 環境驗證核心功能',
      '確認 breaking change 有對應的遷移指南',
    ],
  },
  {
    step: 4,
    title: '文件更新',
    description: '確認文件與新版本同步',
    checklist: [
      'README.md 更新（如有 API 變更）',
      'CHANGELOG.md 自動生成已確認',
      'Adapter 開發指南更新（如有 Schema 變更）',
      'MCP 整合文件更新（如有介面變更）',
      'Migration Guide（如有破壞性變更）',
    ],
  },
  {
    step: 5,
    title: '建構與打包',
    description: '建構四平台可執行檔',
    checklist: [
      'bun build — linux-x64',
      'bun build — linux-arm64',
      'bun build — darwin-x64',
      'bun build — darwin-arm64',
      '確認所有平台二進位檔可正常執行',
      '計算 SHA256 校驗碼',
    ],
  },
  {
    step: 6,
    title: '發布 GitHub Release',
    description: '建立 Git Tag 並發布 GitHub Release',
    checklist: [
      '建立 Git Tag v{version}',
      '推送 Tag 到遠端',
      '建立 GitHub Release（附 Changelog）',
      '上傳四平台二進位檔',
      '上傳 SHA256 校驗檔',
    ],
  },
  {
    step: 7,
    title: '發布後驗證',
    description: '確認發布成功並通知社群',
    checklist: [
      '確認安裝腳本可下載新版本',
      '測試 `clawapi --version` 顯示正確版本',
      '發布 Discord / Telegram 公告',
      '更新 GitHub 專案網站',
      '標記上一個版本為 superseded',
    ],
  },
];

// ===== ReleaseManager 主類別 =====

export class ReleaseManager {
  // 建立發布計劃（7 步驟 + Changelog）
  createReleasePlan(
    currentVersion: string,
    prs: PRRecord[],
  ): ReleasePlan {
    const current = parseSemVer(currentVersion);
    if (!current) {
      throw new Error(`無效的版本號格式：${currentVersion}，請使用 x.y.z 格式`);
    }

    // 判定版本升級類型
    const releaseType = determineReleaseType(prs);

    // 計算新版本號
    const nextVersion = bumpVersion(current, releaseType);
    const versionString = `v${formatSemVer(nextVersion)}`;

    // 生成 Changelog
    const changelog = generateChangelog(prs);

    // 建立 7 步驟框架
    const steps: ReleaseStep[] = RELEASE_STEPS.map(step => ({
      ...step,
      status: 'pending' as const,
    }));

    return {
      version: versionString,
      previousVersion: `v${currentVersion.replace(/^v/, '')}`,
      releaseType,
      steps,
      changelog,
      generatedAt: new Date().toISOString(),
    };
  }

  // 格式化發布計劃為 Markdown（供 GitHub Issue / PR 留言）
  formatReleasePlan(plan: ReleasePlan): string {
    let md = `# 🚀 發布計劃：${plan.version}\n\n`;
    md += `**前一版本：** ${plan.previousVersion}\n`;
    md += `**發布類型：** ${plan.releaseType}\n`;
    md += `**計劃生成：** ${plan.generatedAt.slice(0, 10)}\n\n`;

    // Changelog 預覽
    md += `## Changelog 預覽\n\n`;
    md += formatChangelog(plan.version, plan.changelog);

    // 7 步驟檢查清單
    md += `## 發布 SOP 檢查清單\n\n`;
    for (const step of plan.steps) {
      md += `### 步驟 ${step.step}：${step.title}\n`;
      md += `${step.description}\n\n`;
      if (step.checklist) {
        for (const item of step.checklist) {
          md += `- [ ] ${item}\n`;
        }
      }
      md += '\n';
    }

    md += `---\n*🤖 由 ClawAPI Bot 自動生成*`;
    return md;
  }

  // 更新步驟狀態
  updateStepStatus(
    plan: ReleasePlan,
    stepNumber: number,
    status: ReleaseStep['status'],
  ): ReleasePlan {
    const updatedSteps = plan.steps.map(step =>
      step.step === stepNumber ? { ...step, status } : step,
    );
    return { ...plan, steps: updatedSteps };
  }

  // 計算發布進度（0-100）
  getProgress(plan: ReleasePlan): number {
    const done = plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
    return Math.round((done / plan.steps.length) * 100);
  }
}

// 匯出工具函式
export {
  LABEL_TO_CATEGORY,
  RELEASE_STEPS,
  CATEGORY_ORDER,
};
