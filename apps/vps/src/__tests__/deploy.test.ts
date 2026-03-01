// ============================================================
// 部署配置驗證測試
// 驗證：Dockerfile、Caddyfile、docker-compose、GitHub Actions
// ============================================================

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// 專案根目錄（從 apps/vps/src/__tests__ 往上 4 層）
const ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const VPS_DIR = resolve(ROOT, 'apps', 'vps');

// ===== 輔助函數 =====

/** 讀取檔案內容 */
function readFile(relativePath: string): string {
  const fullPath = resolve(ROOT, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`檔案不存在：${fullPath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

/** 檢查檔案是否存在 */
function fileExists(relativePath: string): boolean {
  return existsSync(resolve(ROOT, relativePath));
}

// ===== Dockerfile 測試 =====

describe('Dockerfile.vps 結構驗證', () => {
  let dockerfile: string;

  test('檔案存在', () => {
    expect(fileExists('apps/vps/Dockerfile.vps')).toBe(true);
    dockerfile = readFile('apps/vps/Dockerfile.vps');
  });

  test('使用 Bun 官方映像', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('FROM oven/bun');
  });

  test('設定工作目錄', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('WORKDIR /app');
  });

  test('先複製 package.json 再安裝（利用 layer cache）', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    const copyPkgIndex = dockerfile.indexOf('COPY package.json');
    const installIndex = dockerfile.indexOf('bun install');
    const copySrcIndex = dockerfile.lastIndexOf('COPY');
    expect(copyPkgIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(copyPkgIndex);
  });

  test('使用 --frozen-lockfile 安裝', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('--frozen-lockfile');
  });

  test('使用 --production 安裝', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('--production');
  });

  test('建立必要目錄', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('/data');
    expect(dockerfile).toContain('/logs');
    expect(dockerfile).toContain('/keys/ecdh');
    expect(dockerfile).toContain('/data/backups');
    expect(dockerfile).toContain('/data/db-backups');
  });

  test('建立非 root 使用者', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('adduser');
    expect(dockerfile).toContain('clawapi');
  });

  test('切換到非 root 使用者', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('USER clawapi');
  });

  test('USER 指令在 RUN 之後（確保非 root 執行）', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    const userIndex = dockerfile.indexOf('USER clawapi');
    const lastRunIndex = dockerfile.lastIndexOf('RUN ');
    expect(userIndex).toBeGreaterThan(lastRunIndex);
  });

  test('設定 NODE_ENV=production', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('ENV NODE_ENV=production');
  });

  test('暴露 3100 埠', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('EXPOSE 3100');
  });

  test('HEALTHCHECK 使用 bun fetch（不是 curl）', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('bun -e');
    expect(dockerfile).toContain('fetch');
    expect(dockerfile).toContain('/health');
    // 確保沒用 curl
    expect(dockerfile).not.toContain('CMD curl');
  });

  test('CMD 啟動 VPS 服務', () => {
    dockerfile = readFile('apps/vps/Dockerfile.vps');
    expect(dockerfile).toContain('CMD');
    expect(dockerfile).toContain('bun');
  });
});

// ===== docker-compose.vps.yml 測試 =====

describe('docker-compose.vps.yml 結構驗證', () => {
  let compose: string;

  test('檔案存在', () => {
    expect(fileExists('docker-compose.vps.yml')).toBe(true);
    compose = readFile('docker-compose.vps.yml');
  });

  test('定義 clawapi-vps 服務', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('clawapi-vps');
  });

  test('定義 caddy 服務', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('caddy');
  });

  test('VPS 服務暴露 3100 埠', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('3100');
  });

  test('Caddy 暴露 80 和 443 埠', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('"80:80"');
    expect(compose).toContain('"443:443"');
  });

  test('定義 vps-data volume', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('vps-data');
  });

  test('定義 caddy-data volume', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('caddy-data');
  });

  test('定義 clawapi-net 網路', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('clawapi-net');
  });

  test('引用環境變數', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('ADMIN_TOKEN');
    expect(compose).toContain('DB_PATH');
    expect(compose).toContain('ECDH_KEY_DIR');
    expect(compose).toContain('NODE_ENV');
  });

  test('Caddy depends_on VPS 服務', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('depends_on');
    // Caddy 依賴 VPS 健康才啟動
    expect(compose).toContain('condition: service_healthy');
  });

  test('使用 restart: unless-stopped', () => {
    compose = readFile('docker-compose.vps.yml');
    expect(compose).toContain('restart: unless-stopped');
  });
});

// ===== Caddyfile 測試 =====

describe('Caddyfile 結構驗證', () => {
  let caddyfile: string;

  test('檔案存在', () => {
    expect(fileExists('apps/vps/Caddyfile')).toBe(true);
    caddyfile = readFile('apps/vps/Caddyfile');
  });

  test('設定 api.clawapi.com 網域', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    expect(caddyfile).toContain('api.clawapi.com');
  });

  test('反向代理到 clawapi-vps:3100', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    expect(caddyfile).toContain('reverse_proxy');
    expect(caddyfile).toContain('clawapi-vps:3100');
  });

  test('處理 WebSocket 升級', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    expect(caddyfile).toContain('@websocket');
    expect(caddyfile).toContain('Upgrade');
    expect(caddyfile).toContain('websocket');
  });

  test('設定 HSTS header', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    expect(caddyfile).toContain('Strict-Transport-Security');
    expect(caddyfile).toContain('max-age=31536000');
  });

  test('設定 X-Content-Type-Options', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    expect(caddyfile).toContain('X-Content-Type-Options nosniff');
  });

  test('設定 X-Frame-Options DENY', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    expect(caddyfile).toContain('X-Frame-Options DENY');
  });

  test('設定 Referrer-Policy', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    expect(caddyfile).toContain('Referrer-Policy');
    expect(caddyfile).toContain('strict-origin-when-cross-origin');
  });

  test('設定 JSON 存取日誌', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    expect(caddyfile).toContain('log');
    expect(caddyfile).toContain('format json');
  });

  test('不使用 Cloudflare DNS challenge', () => {
    caddyfile = readFile('apps/vps/Caddyfile');
    // Caddy 預設用 HTTP challenge，確保沒有使用 cloudflare 模組
    expect(caddyfile).not.toContain('cloudflare');
    expect(caddyfile).not.toContain('dns_challenge');
  });
});

// ===== .env.example 測試 =====

describe('.env.example 完整性驗證', () => {
  let envExample: string;

  test('檔案存在', () => {
    expect(fileExists('.env.example')).toBe(true);
    envExample = readFile('.env.example');
  });

  test('包含 VPS_PORT', () => {
    envExample = readFile('.env.example');
    expect(envExample).toContain('VPS_PORT=3100');
  });

  test('包含 NODE_ENV', () => {
    envExample = readFile('.env.example');
    expect(envExample).toContain('NODE_ENV=production');
  });

  test('包含 ADMIN_TOKEN', () => {
    envExample = readFile('.env.example');
    expect(envExample).toContain('ADMIN_TOKEN=');
  });

  test('包含 TELEGRAM 相關變數', () => {
    envExample = readFile('.env.example');
    expect(envExample).toContain('TELEGRAM_BOT_TOKEN');
    expect(envExample).toContain('TELEGRAM_CHAT_ID');
  });

  test('包含 GITHUB 相關變數', () => {
    envExample = readFile('.env.example');
    expect(envExample).toContain('GITHUB_TOKEN');
    expect(envExample).toContain('GITHUB_REPO');
  });

  test('包含 DB_PATH', () => {
    envExample = readFile('.env.example');
    expect(envExample).toContain('DB_PATH=/data/clawapi-vps.db');
  });

  test('包含 ECDH_KEY_DIR', () => {
    envExample = readFile('.env.example');
    expect(envExample).toContain('ECDH_KEY_DIR=/keys/ecdh');
  });

  test('不包含真實密碼', () => {
    envExample = readFile('.env.example');
    // 確保範本中不包含真實 token
    const lines = envExample.split('\n').filter(l => !l.startsWith('#') && l.includes('='));
    for (const line of lines) {
      const value = line.split('=').slice(1).join('=').trim();
      // 允許：空值、預設值（如 3100、production）、佔位符
      if (value && !['', '3100', 'production', 'clawapi/clawapi', '/data/clawapi-vps.db', '/keys/ecdh'].includes(value)) {
        expect(value).toMatch(/<.*>|^$/); // 應是 <placeholder> 格式
      }
    }
  });
});

// ===== 部署腳本測試 =====

describe('scripts/deploy.sh 結構驗證', () => {
  let deployScript: string;

  test('檔案存在', () => {
    expect(fileExists('scripts/deploy.sh')).toBe(true);
    deployScript = readFile('scripts/deploy.sh');
  });

  test('使用 bash', () => {
    deployScript = readFile('scripts/deploy.sh');
    expect(deployScript.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('設定 set -euo pipefail', () => {
    deployScript = readFile('scripts/deploy.sh');
    expect(deployScript).toContain('set -euo pipefail');
  });

  test('包含 git pull', () => {
    deployScript = readFile('scripts/deploy.sh');
    expect(deployScript).toContain('git pull');
  });

  test('包含 docker compose build', () => {
    deployScript = readFile('scripts/deploy.sh');
    expect(deployScript).toContain('docker compose');
    expect(deployScript).toContain('build');
  });

  test('包含 docker compose up', () => {
    deployScript = readFile('scripts/deploy.sh');
    expect(deployScript).toContain('up -d');
  });

  test('包含健康檢查等待邏輯', () => {
    deployScript = readFile('scripts/deploy.sh');
    expect(deployScript).toContain('health');
    expect(deployScript).toContain('healthy');
  });

  test('使用 docker-compose.vps.yml', () => {
    deployScript = readFile('scripts/deploy.sh');
    expect(deployScript).toContain('docker-compose.vps.yml');
  });
});

// ===== 備份腳本測試 =====

describe('scripts/backup-db.sh 結構驗證', () => {
  let backupScript: string;

  test('檔案存在', () => {
    expect(fileExists('scripts/backup-db.sh')).toBe(true);
    backupScript = readFile('scripts/backup-db.sh');
  });

  test('使用 bash', () => {
    backupScript = readFile('scripts/backup-db.sh');
    expect(backupScript.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('設定 set -euo pipefail', () => {
    backupScript = readFile('scripts/backup-db.sh');
    expect(backupScript).toContain('set -euo pipefail');
  });

  test('包含每日備份邏輯', () => {
    backupScript = readFile('scripts/backup-db.sh');
    expect(backupScript).toContain('daily');
  });

  test('包含每週備份邏輯', () => {
    backupScript = readFile('scripts/backup-db.sh');
    expect(backupScript).toContain('weekly');
  });

  test('保留 7 天每日備份', () => {
    backupScript = readFile('scripts/backup-db.sh');
    expect(backupScript).toContain('7');
  });

  test('保留 4 週（28 天）每週備份', () => {
    backupScript = readFile('scripts/backup-db.sh');
    expect(backupScript).toContain('28');
  });

  test('包含清理舊備份邏輯', () => {
    backupScript = readFile('scripts/backup-db.sh');
    expect(backupScript).toContain('find');
    expect(backupScript).toContain('-mtime');
  });

  test('使用 SQLite backup 指令（如果有 sqlite3）', () => {
    backupScript = readFile('scripts/backup-db.sh');
    expect(backupScript).toContain('.backup');
  });
});

// ===== GitHub Actions YAML 測試 =====

describe('GitHub Actions YAML 語法驗證', () => {
  // 使用簡易 YAML 驗證（不需要外部庫）
  // 檢查：必要欄位存在、無明顯語法錯誤

  test('pr-test.yml 存在且結構正確', () => {
    expect(fileExists('.github/workflows/pr-test.yml')).toBe(true);
    const yaml = readFile('.github/workflows/pr-test.yml');
    expect(yaml).toContain('name:');
    expect(yaml).toContain('on:');
    expect(yaml).toContain('pull_request');
    expect(yaml).toContain('jobs:');
    expect(yaml).toContain('bun test');
    expect(yaml).toContain('--coverage');
    expect(yaml).toContain('typecheck');
    // 使用 $GITHUB_OUTPUT（不用舊 set-output）
    expect(yaml).toContain('GITHUB_OUTPUT');
    expect(yaml).not.toContain('::set-output');
  });

  test('adapter-scan.yml 存在且結構正確', () => {
    expect(fileExists('.github/workflows/adapter-scan.yml')).toBe(true);
    const yaml = readFile('.github/workflows/adapter-scan.yml');
    expect(yaml).toContain('name:');
    expect(yaml).toContain('on:');
    expect(yaml).toContain('pull_request');
    expect(yaml).toContain('paths:');
    expect(yaml).toContain('adapters');
    expect(yaml).toContain('jobs:');
    // fetch-depth: 0 確保 origin/main 存在
    expect(yaml).toContain('fetch-depth: 0');
  });

  test('release.yml 存在且結構正確', () => {
    expect(fileExists('.github/workflows/release.yml')).toBe(true);
    const yaml = readFile('.github/workflows/release.yml');
    expect(yaml).toContain('name:');
    expect(yaml).toContain('on:');
    expect(yaml).toContain("tags:");
    expect(yaml).toContain("'v*'");
    expect(yaml).toContain('jobs:');
    expect(yaml).toContain('matrix');
    // 四個平台
    expect(yaml).toContain('linux-x64');
    expect(yaml).toContain('darwin-arm64');
    expect(yaml).toContain('darwin-x64');
    expect(yaml).toContain('win-x64');
    // Docker push
    expect(yaml).toContain('docker');
    expect(yaml).toContain('ghcr.io');
  });

  test('daily-health.yml 存在且結構正確', () => {
    expect(fileExists('.github/workflows/daily-health.yml')).toBe(true);
    const yaml = readFile('.github/workflows/daily-health.yml');
    expect(yaml).toContain('name:');
    expect(yaml).toContain('on:');
    expect(yaml).toContain('schedule:');
    expect(yaml).toContain('cron:');
    // UTC 8:00
    expect(yaml).toContain('0 8 * * *');
    expect(yaml).toContain('jobs:');
    expect(yaml).toContain('/health');
    // 建立 Issue
    expect(yaml).toContain('issues.create');
  });

  test('dependabot.yml 存在且結構正確', () => {
    expect(fileExists('.github/dependabot.yml')).toBe(true);
    const yaml = readFile('.github/dependabot.yml');
    expect(yaml).toContain('version: 2');
    expect(yaml).toContain('updates:');
    // 三種 ecosystem
    expect(yaml).toContain('"npm"');
    expect(yaml).toContain('"docker"');
    expect(yaml).toContain('"github-actions"');
  });
});

// ===== 所有檔案存在性總檢查 =====

describe('Phase 5C 所有產出檔案存在性', () => {
  const requiredFiles = [
    'apps/vps/Dockerfile.vps',
    'docker-compose.vps.yml',
    'apps/vps/Caddyfile',
    '.env.example',
    'scripts/deploy.sh',
    'scripts/backup-db.sh',
    '.github/workflows/pr-test.yml',
    '.github/workflows/adapter-scan.yml',
    '.github/workflows/release.yml',
    '.github/workflows/daily-health.yml',
    '.github/dependabot.yml',
  ];

  for (const file of requiredFiles) {
    test(`${file} 存在`, () => {
      expect(fileExists(file)).toBe(true);
    });
  }
});
