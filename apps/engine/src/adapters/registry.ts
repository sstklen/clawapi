// Adapter 市集（Registry）模組
// 從 GitHub 拉取社群 Adapter 目錄，支援搜尋、安裝、版本檢查
// Phase 1：唯讀目錄 + 安裝到本地

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { RegistryCatalog, RegistryAdapter, RegistryUpdateInfo } from '@clawapi/protocol';
import type { AdapterLoader, AdapterConfig } from './loader';
import type { AdapterScanner, ScanResult } from './scanner';

// ===== 常數 =====

/** 目錄快取 TTL：1 小時 */
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;

/** 預設 Registry URL（GitHub raw） */
const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/clawapi/adapters/main/registry.json';

// ===== AdapterRegistry 主類別 =====

/**
 * Adapter 市集客戶端
 *
 * 職責：
 * 1. fetchCatalog()  — 從 GitHub 拉 registry.json（1 小時快取）
 * 2. search()        — 名稱/描述/分類模糊搜尋
 * 3. installFromRegistry() — 下載 YAML → 驗證 → 安全掃描 → 存檔
 * 4. checkUpdates()  — 比對已安裝版本與最新版本
 */
export class AdapterRegistry {
  private registryUrl: string;
  private loader: AdapterLoader;
  private scanner: AdapterScanner;
  private userAdapterDir: string;

  /** 記憶體快取 */
  private cachedCatalog: RegistryCatalog | null = null;
  private cacheTimestamp: number = 0;

  constructor(options: {
    registryUrl?: string;
    loader: AdapterLoader;
    scanner: AdapterScanner;
    userAdapterDir: string;
  }) {
    this.registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.loader = options.loader;
    this.scanner = options.scanner;
    this.userAdapterDir = options.userAdapterDir;
  }

  // ===== 公開方法 =====

  /**
   * 取得市集目錄
   * 1 小時記憶體快取，離線時用上次快取
   */
  async fetchCatalog(): Promise<RegistryCatalog> {
    const now = Date.now();

    // 快取命中
    if (this.cachedCatalog && (now - this.cacheTimestamp) < CATALOG_CACHE_TTL_MS) {
      return this.cachedCatalog;
    }

    try {
      const response = await fetch(this.registryUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000), // 10 秒超時
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as RegistryCatalog;

      // 基本驗證
      if (!data.adapters || !Array.isArray(data.adapters)) {
        throw new Error('registry.json 格式不正確：缺少 adapters 陣列');
      }

      // 更新快取
      this.cachedCatalog = data;
      this.cacheTimestamp = now;

      return data;

    } catch (err) {
      // 有快取就用舊的（離線容錯）
      if (this.cachedCatalog) {
        console.warn(`[Registry] 無法更新目錄（使用快取）：${(err as Error).message}`);
        return this.cachedCatalog;
      }

      throw new Error(`無法取得 Adapter 市集目錄：${(err as Error).message}`);
    }
  }

  /**
   * 搜尋市集 Adapter
   * 模糊比對名稱、描述、分類、作者
   *
   * @param query 搜尋關鍵字
   * @param category 篩選分類（可選）
   */
  async search(query: string, category?: string): Promise<RegistryAdapter[]> {
    const catalog = await this.fetchCatalog();
    const lowerQuery = query.toLowerCase().trim();

    return catalog.adapters.filter((adapter) => {
      // 分類篩選
      if (category && adapter.category !== category) {
        return false;
      }

      // 模糊搜尋：名稱、描述、ID、作者
      if (lowerQuery) {
        const searchable = [
          adapter.id,
          adapter.name,
          adapter.description,
          adapter.author,
          adapter.category,
        ]
          .join(' ')
          .toLowerCase();

        return searchable.includes(lowerQuery);
      }

      return true;
    });
  }

  /**
   * 從市集安裝 Adapter
   *
   * 流程：
   * 1. 在目錄中找到 adapterId
   * 2. 下載 YAML 檔案
   * 3. 用 AdapterLoader.validate() 驗證 schema
   * 4. 用 AdapterScanner.scan() 安全掃描
   * 5. 存到 userAdapterDir
   *
   * @returns ScanResult（含 warnings/errors）
   */
  async installFromRegistry(adapterId: string): Promise<ScanResult & { config?: AdapterConfig }> {
    // 0. adapterId 安全驗證（防止 path traversal 攻擊）
    // 只允許小寫字母、數字、連字符、底線、點號
    if (!/^[a-z0-9][a-z0-9\-_.]*$/.test(adapterId)) {
      return {
        passed: false,
        warnings: [],
        errors: [`adapterId 格式不合法（只允許小寫字母、數字、-、_、.）：${adapterId}`],
      };
    }

    // 1. 在目錄中找到此 Adapter
    const catalog = await this.fetchCatalog();
    const entry = catalog.adapters.find((a) => a.id === adapterId);

    if (!entry) {
      return {
        passed: false,
        warnings: [],
        errors: [`Adapter "${adapterId}" 不在市集目錄中`],
      };
    }

    // 2. 下載 YAML
    let yamlContent: string;
    try {
      const response = await fetch(entry.yaml_url, {
        signal: AbortSignal.timeout(15_000), // 15 秒超時
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      yamlContent = await response.text();
    } catch (err) {
      return {
        passed: false,
        warnings: [],
        errors: [`下載 Adapter YAML 失敗：${(err as Error).message}`],
      };
    }

    // 3. 解析 + 驗證 schema
    let config: AdapterConfig;
    try {
      const parsed = yaml.load(yamlContent);
      config = this.loader.validate(parsed);
    } catch (err) {
      return {
        passed: false,
        warnings: [],
        errors: [`Adapter YAML 驗證失敗：${(err as Error).message}`],
      };
    }

    // 4. 安全掃描
    const scanResult = this.scanner.scan(config);
    if (!scanResult.passed) {
      return scanResult;
    }

    // 5. 存到 userAdapterDir
    try {
      // 確保目錄存在
      if (!existsSync(this.userAdapterDir)) {
        mkdirSync(this.userAdapterDir, { recursive: true });
      }

      const targetPath = join(this.userAdapterDir, `${adapterId}.yaml`);

      // 路徑遏制檢查：確保解析後的路徑仍在 userAdapterDir 內
      const resolvedTarget = resolve(targetPath);
      const resolvedDir = resolve(this.userAdapterDir);
      if (!resolvedTarget.startsWith(resolvedDir + '/') && resolvedTarget !== resolvedDir) {
        return {
          passed: false,
          warnings: [],
          errors: [`路徑安全檢查失敗：${adapterId} 嘗試寫入到目錄外`],
        };
      }

      writeFileSync(targetPath, yamlContent, 'utf8');
    } catch (err) {
      return {
        passed: false,
        warnings: scanResult.warnings,
        errors: [`儲存 Adapter 檔案失敗：${(err as Error).message}`],
      };
    }

    return {
      ...scanResult,
      config,
    };
  }

  /**
   * 檢查已安裝 Adapter 是否有更新
   *
   * @param installed 已安裝的 Adapter Map（id → AdapterConfig）
   * @returns 有更新的 Adapter 清單
   */
  async checkUpdates(installed: Map<string, AdapterConfig>): Promise<RegistryUpdateInfo[]> {
    const catalog = await this.fetchCatalog();
    const updates: RegistryUpdateInfo[] = [];

    for (const [id, config] of installed) {
      const registryEntry = catalog.adapters.find((a) => a.id === id);
      if (!registryEntry) continue;

      // 比對語意版本
      if (this.isNewerVersion(config.adapter.version, registryEntry.version)) {
        updates.push({
          id,
          current_version: config.adapter.version,
          latest_version: registryEntry.version,
        });
      }
    }

    return updates;
  }

  /**
   * 強制清除快取（測試用）
   */
  clearCache(): void {
    this.cachedCatalog = null;
    this.cacheTimestamp = 0;
  }

  // ===== 私有方法 =====

  /**
   * 簡易語意版本比較
   * @returns true 如果 latest > current
   */
  private isNewerVersion(current: string, latest: string): boolean {
    const parseVersion = (v: string): number[] => {
      return v
        .replace(/^v/, '')
        .split('.')
        .map((n) => parseInt(n, 10) || 0);
    };

    const c = parseVersion(current);
    const l = parseVersion(latest);

    // 逐位比較 major.minor.patch
    for (let i = 0; i < Math.max(c.length, l.length); i++) {
      const cv = c[i] ?? 0;
      const lv = l[i] ?? 0;
      if (lv > cv) return true;
      if (lv < cv) return false;
    }

    return false; // 相同版本
  }
}
