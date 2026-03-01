// 版本檢查路由處理器
// GET /v1/version/check — 回傳最新版本資訊 + 下載 URL

import { Hono } from 'hono';
import type { AuthVariables } from '../middleware/auth';

// 版本資訊型別
interface VersionInfo {
  version: string;
  release_date: string;
  download_urls: {
    darwin_arm64: string;
    darwin_x64: string;
    linux_x64: string;
    linux_arm64: string;
    windows_x64: string;
  };
  changelog_url: string;
  min_supported_version: string;
  update_required: boolean;
}

// 當前最新版本（靜態設定，日後可改為從 DB 或 GitHub Releases 讀取）
const LATEST_VERSION: VersionInfo = {
  version: '0.1.0',
  release_date: '2026-01-01T00:00:00Z',
  download_urls: {
    darwin_arm64: 'https://github.com/clawapi/clawapi/releases/latest/download/clawapi-darwin-arm64',
    darwin_x64: 'https://github.com/clawapi/clawapi/releases/latest/download/clawapi-darwin-x64',
    linux_x64: 'https://github.com/clawapi/clawapi/releases/latest/download/clawapi-linux-x64',
    linux_arm64: 'https://github.com/clawapi/clawapi/releases/latest/download/clawapi-linux-arm64',
    windows_x64: 'https://github.com/clawapi/clawapi/releases/latest/download/clawapi-windows-x64.exe',
  },
  changelog_url: 'https://github.com/clawapi/clawapi/blob/main/CHANGELOG.md',
  min_supported_version: '0.1.0',
  update_required: false,
};

// 版本字串比較（簡化版：只比較 major.minor.patch）
// 回傳：-1 = a < b，0 = a == b，1 = a > b
function compareVersions(a: string, b: string): number {
  const parseVersion = (v: string): number[] =>
    v.split('.').map((p) => parseInt(p.replace(/[^0-9]/g, ''), 10) || 0);

  const [aMajor = 0, aMinor = 0, aPatch = 0] = parseVersion(a);
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parseVersion(b);

  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

// 建立版本路由（需注入 — 目前版本資訊為靜態，未來可注入 DB）
export function createVersionRouter(): Hono<{ Variables: AuthVariables }> {
  const router = new Hono<{ Variables: AuthVariables }>();

  // ─────────────────────────────────────────────────────────────────
  // GET /v1/version/check
  // 版本檢查端點，需要 deviceAuth
  // Query param: current_version（可選，用於比對是否需要更新）
  // ─────────────────────────────────────────────────────────────────
  router.get('/check', (c) => {
    // 取得客戶端當前版本（若有提供）
    const clientVersion = c.req.query('current_version');

    // 判斷是否需要更新
    let updateAvailable = false;
    let updateRequired = LATEST_VERSION.update_required;

    if (clientVersion) {
      // 比對版本號
      const comparison = compareVersions(clientVersion, LATEST_VERSION.version);
      updateAvailable = comparison < 0;

      // 若客戶端版本低於最低支援版本 → 強制更新
      const minComparison = compareVersions(clientVersion, LATEST_VERSION.min_supported_version);
      if (minComparison < 0) {
        updateRequired = true;
      }
    }

    return c.json({
      latest_version: LATEST_VERSION.version,
      release_date: LATEST_VERSION.release_date,
      download_urls: LATEST_VERSION.download_urls,
      changelog_url: LATEST_VERSION.changelog_url,
      min_supported_version: LATEST_VERSION.min_supported_version,
      update_available: updateAvailable,
      update_required: updateRequired,
      server_time: new Date().toISOString(),
    });
  });

  return router;
}
