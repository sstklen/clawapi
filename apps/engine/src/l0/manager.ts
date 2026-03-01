// L0 Manager — 引擎端 L0 公共 Key 快取與每日限額管理
// 對應 VPS 端 #2D，負責從 VPS 拉取 L0 Key 並在本機快取 6 小時
// L0 Key 選取順序：Ollama → DuckDuckGo → L0 公共 Key

import type { L0Key, L0KeysResponse } from '@clawapi/protocol';
import { L0_CACHE_TTL_MS } from '@clawapi/protocol';

// ===== 型別定義 =====

/** L0 Key 選取結果 */
export interface L0KeyResult {
  /** 選到的 Key（null = 全部用盡或無可用 Key） */
  key: L0Key | null;
  /** Key 的來源 */
  source: 'ollama' | 'duckduckgo' | 'l0_public' | 'none';
  /** 若 null，提示原因 */
  reason?: string;
}

/** VPS 客戶端的簡化介面（避免循環依賴） */
export interface VPSClientLike {
  getL0Keys(since?: string): Promise<L0KeysResponse | null>;
  getIsOffline(): boolean;
}

/** 每日限額追蹤記錄 */
interface DailyLimitRecord {
  limit: number;
  used: number;
  reset_at: string;
}

// ===== L0Manager 主類別 =====

/**
 * 引擎端 L0 管理器
 *
 * 職責：
 * 1. 從 VPS 拉取 L0 Key 清單並本機快取（6 小時 TTL）
 * 2. 追蹤每日限額（從 VPS 回應中取得 device_daily_limits）
 * 3. 按優先順序選取可用 L0 Key
 * 4. 限額到達時回傳友善提示
 */
export class L0Manager {
  /** 快取的 L0 Key 清單 */
  private cachedKeys: L0Key[] = [];

  /** 快取的每日限額資訊（serviceId → 限額記錄） */
  private dailyLimits: Map<string, DailyLimitRecord> = new Map();

  /** 上次從 VPS 拉取的時間（毫秒 timestamp，0 代表尚未拉取） */
  private lastFetchedAt: number = 0;

  /** 快取 TTL（預設 6 小時，可測試時覆蓋） */
  private readonly cacheTtlMs: number;

  /** 定期檢查計時器 */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly vpsClient: VPSClientLike,
    /** 允許測試覆蓋 TTL（毫秒） */
    cacheTtlMs: number = L0_CACHE_TTL_MS
  ) {
    this.cacheTtlMs = cacheTtlMs;
  }

  // ===== 生命週期 =====

  /**
   * 啟動 L0Manager
   * 立即拉取一次 + 每 6 小時定期刷新
   */
  async start(): Promise<void> {
    // 啟動時立刻拉一次
    await this.refresh();

    // 每 cacheTtlMs 檢查一次（若 TTL 已到期則重新拉取）
    this.refreshTimer = setInterval(async () => {
      if (this.isCacheExpired()) {
        await this.refresh();
      }
    }, this.cacheTtlMs);
  }

  /**
   * 停止 L0Manager，清除計時器
   */
  stop(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ===== 快取管理 =====

  /**
   * 從 VPS 拉取最新 L0 Key 並更新快取
   * 若 VPS 離線或回傳 null，保留舊快取不覆蓋
   */
  async refresh(): Promise<void> {
    // VPS 離線時不嘗試拉取（避免拋出錯誤）
    if (this.vpsClient.getIsOffline()) {
      return;
    }

    try {
      const response = await this.vpsClient.getL0Keys();
      if (response === null) {
        // VPS 回傳 null（離線模式），保留舊快取
        return;
      }

      // 更新 Key 快取
      this.cachedKeys = response.keys;

      // 更新每日限額
      this.dailyLimits.clear();
      for (const [serviceId, limitInfo] of Object.entries(response.device_daily_limits)) {
        this.dailyLimits.set(serviceId, {
          limit: limitInfo.limit,
          used: limitInfo.used,
          reset_at: limitInfo.reset_at,
        });
      }

      // 記錄拉取時間
      this.lastFetchedAt = Date.now();
    } catch {
      // 拉取失敗，保留舊快取，下次再試
    }
  }

  /**
   * 判斷快取是否已過期
   */
  isCacheExpired(): boolean {
    if (this.lastFetchedAt === 0) return true;
    return Date.now() - this.lastFetchedAt >= this.cacheTtlMs;
  }

  // ===== Key 選取 =====

  /**
   * 選取可用的 L0 Key
   *
   * 選取優先順序：
   * 1. Ollama（本機，service_id = 'ollama'）
   * 2. DuckDuckGo（免費無 Key，service_id = 'duckduckgo'）
   * 3. L0 公共 Key（VPS 提供，其他服務）
   *
   * @param serviceId 指定服務（可選，不指定則從全部可用的 Key 選）
   */
  selectKey(serviceId?: string): L0KeyResult {
    // 若快取為空，回傳無可用
    if (this.cachedKeys.length === 0 && !this.hasLocalFallback(serviceId)) {
      return {
        key: null,
        source: 'none',
        reason: '目前沒有可用的 L0 Key，請稍後再試或新增個人 API Key',
      };
    }

    // 1. 優先嘗試 Ollama（本機服務，不需要 Key）
    if (!serviceId || serviceId === 'ollama') {
      const ollamaResult = this.tryLocalService('ollama');
      if (ollamaResult) return ollamaResult;
    }

    // 2. 嘗試 DuckDuckGo（免費，不需要 Key）
    if (!serviceId || serviceId === 'duckduckgo') {
      const ddgResult = this.tryLocalService('duckduckgo');
      if (ddgResult) return ddgResult;
    }

    // 3. 從 L0 公共 Key 清單選取
    return this.selectFromPublicKeys(serviceId);
  }

  /**
   * 嘗試選取本機服務（Ollama / DuckDuckGo）
   * 這些服務不需要真正的 API Key
   */
  private tryLocalService(svc: 'ollama' | 'duckduckgo'): L0KeyResult | null {
    // 從快取找這個服務的活躍 Key
    const key = this.cachedKeys.find(k => k.service_id === svc && k.status === 'active');
    if (key) {
      return { key, source: svc };
    }
    return null;
  }

  /**
   * 是否有本機 Fallback（Ollama 或 DuckDuckGo）
   */
  private hasLocalFallback(serviceId?: string): boolean {
    if (serviceId && serviceId !== 'ollama' && serviceId !== 'duckduckgo') {
      return false;
    }
    return this.cachedKeys.some(
      k => (k.service_id === 'ollama' || k.service_id === 'duckduckgo') && k.status === 'active'
    );
  }

  /**
   * 從 VPS 提供的 L0 公共 Key 清單選取可用 Key
   *
   * 選取條件：
   * - status = 'active'（degraded 也可用但排後面）
   * - 未超過每日配額
   */
  private selectFromPublicKeys(serviceId?: string): L0KeyResult {
    // 過濾候選 Key
    let candidates = this.cachedKeys.filter(k => {
      // 跳過本機服務（已在上面處理）
      if (k.service_id === 'ollama' || k.service_id === 'duckduckgo') return false;
      // 若指定服務 ID，只選該服務
      if (serviceId && k.service_id !== serviceId) return false;
      // 跳過 dead 的 Key
      if (k.status === 'dead') return false;
      return true;
    });

    if (candidates.length === 0) {
      return {
        key: null,
        source: 'none',
        reason: serviceId
          ? `服務 ${serviceId} 目前沒有可用的 L0 Key`
          : '目前沒有可用的 L0 Key，請稍後再試或新增個人 API Key',
      };
    }

    // 檢查每日限額
    if (serviceId) {
      const limitRecord = this.dailyLimits.get(serviceId);
      if (limitRecord && limitRecord.used >= limitRecord.limit) {
        const resetAt = new Date(limitRecord.reset_at).toLocaleTimeString('zh-TW', {
          hour: '2-digit',
          minute: '2-digit',
        });
        return {
          key: null,
          source: 'none',
          reason: `服務 ${serviceId} 的今日 L0 配額已用完（${limitRecord.used}/${limitRecord.limit}），將在 ${resetAt} 重置`,
        };
      }
    }

    // preferred → active 優先，degraded 排後
    candidates = candidates.sort((a, b) => {
      const statusScore = (s: L0Key['status']) => s === 'active' ? 0 : 1;
      return statusScore(a.status) - statusScore(b.status);
    });

    return {
      key: candidates[0]!,
      source: 'l0_public',
    };
  }

  // ===== 用量回報 =====

  /**
   * 回報 L0 Key 使用一次（本機計數，不立即上傳 VPS）
   * @param serviceId 服務 ID
   */
  recordUsage(serviceId: string): void {
    const record = this.dailyLimits.get(serviceId);
    if (record) {
      record.used += 1;
    }
  }

  // ===== 查詢方法 =====

  /**
   * 取得目前快取的所有 L0 Key 數量
   */
  getCachedKeyCount(): number {
    return this.cachedKeys.length;
  }

  /**
   * 取得某服務的每日限額資訊
   */
  getDailyLimit(serviceId: string): DailyLimitRecord | null {
    return this.dailyLimits.get(serviceId) ?? null;
  }

  /**
   * 取得上次從 VPS 拉取的時間（毫秒 timestamp）
   * 0 代表尚未拉取
   */
  getLastFetchedAt(): number {
    return this.lastFetchedAt;
  }

  /**
   * 手動設定快取（供測試使用）
   */
  _setCache(keys: L0Key[], fetchedAt: number): void {
    this.cachedKeys = keys;
    this.lastFetchedAt = fetchedAt;
  }

  /**
   * 手動設定每日限額（供測試使用）
   */
  _setDailyLimits(limits: Map<string, DailyLimitRecord>): void {
    this.dailyLimits = limits;
  }
}
