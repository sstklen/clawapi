// Key 池管理模組
// 負責 API Key 的新增、刪除、選取、健康偵測、每日重置
// 所有 Key 在記憶體中以解密明文存在，寫入 DB 前用 CryptoModule 加密

import type { ClawDatabase } from '../storage/database';
import type { CryptoModule } from './encryption';
import type { NotificationManager } from '../notifications/manager';

// ===== 型別定義 =====

/** 解密後的 Key（只存在記憶體中，不寫入 DB） */
export interface DecryptedKey {
  id: number;
  service_id: string;
  key_value: string;
  pool_type: 'king' | 'friend';
  status: 'active' | 'rate_limited' | 'dead';
  pinned: boolean;
  priority: number;
  daily_used: number;
  consecutive_failures: number;
  rate_limit_until: string | null;
  last_success_at: string | null;
}

/** listKeys 回傳的遮罩版 Key */
export interface KeyListItem {
  id: number;
  service_id: string;
  key_masked: string;
  pool_type: 'king' | 'friend';
  label: string | null;
  status: 'active' | 'rate_limited' | 'dead';
  priority: number;
  pinned: boolean;
  daily_used: number;
  consecutive_failures: number;
  rate_limit_until: string | null;
  last_success_at: string | null;
  created_at: string;
}

/** DB 查詢回傳的原始列 */
interface KeyRow {
  id: number;
  service_id: string;
  key_encrypted: Uint8Array;
  pool_type: 'king' | 'friend';
  label: string | null;
  status: 'active' | 'rate_limited' | 'dead';
  priority: number;
  pinned: number;
  daily_used: number;
  consecutive_failures: number;
  rate_limit_until: string | null;
  last_success_at: string | null;
  created_at: string;
}

// ===== Round-Robin 選擇器 =====

/**
 * 輪流選取 Key，pinned 最優先
 * 維護每個 service_id 的上次選取索引，實現輪流效果
 */
export class RoundRobinSelector {
  /** 記錄每個 service_id 上次選取的索引 */
  private lastIndex: Map<string, number> = new Map();

  /**
   * 從候選 Key 中選取一個
   * - pinned=true 的優先
   * - 同優先級內 Round-Robin
   */
  select(keys: DecryptedKey[]): DecryptedKey | null {
    if (keys.length === 0) return null;

    // 先找 pinned 的
    const pinned = keys.filter(k => k.pinned);
    if (pinned.length > 0) {
      // pinned 之中也輪流
      const serviceId = pinned[0]!.service_id + ':pinned';
      const last = this.lastIndex.get(serviceId) ?? -1;
      const next = (last + 1) % pinned.length;
      this.lastIndex.set(serviceId, next);
      return pinned[next]!;
    }

    // 一般 Round-Robin
    const serviceId = keys[0]!.service_id;
    const last = this.lastIndex.get(serviceId) ?? -1;
    const next = (last + 1) % keys.length;
    this.lastIndex.set(serviceId, next);
    return keys[next]!;
  }

  /** 重置某個 service_id 的索引（測試用） */
  reset(serviceId?: string): void {
    if (serviceId) {
      this.lastIndex.delete(serviceId);
      this.lastIndex.delete(serviceId + ':pinned');
    } else {
      this.lastIndex.clear();
    }
  }
}

// ===== KeyPool 主類別 =====

/**
 * Key 池管理器
 * 負責 Key 的 CRUD、選取策略、健康偵測
 */
export class KeyPool {
  private selector: RoundRobinSelector;
  /** 通知管理器（可選，注入後自動發送 Key 狀態通知） */
  private notifier?: NotificationManager;

  constructor(
    private db: ClawDatabase,
    private crypto: CryptoModule
  ) {
    this.selector = new RoundRobinSelector();
  }

  /** 注入通知管理器（在 index.ts 啟動後設定） */
  setNotificationManager(notifier: NotificationManager): void {
    this.notifier = notifier;
  }

  // ===== CRUD =====

  /**
   * 新增 Key
   * - 加密 keyValue 後存入 DB
   * - 檢查同服務 Key 數量 ≤ max_keys_per_service（預設 5）
   * @returns 新 Key 的 id
   */
  async addKey(
    serviceId: string,
    keyValue: string,
    poolType: 'king' | 'friend',
    label?: string,
    maxKeysPerService: number = 5
  ): Promise<number> {
    // 檢查數量限制
    const count = this.db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM keys WHERE service_id = ?',
      [serviceId]
    );
    const currentCount = count[0]?.cnt ?? 0;
    if (currentCount >= maxKeysPerService) {
      throw new Error(
        `服務 ${serviceId} 已達 Key 數量上限（${maxKeysPerService}），請先刪除舊 Key`
      );
    }

    // 加密 Key 值
    const encrypted = this.crypto.encrypt(keyValue);

    // 插入 DB
    const result = this.db.run(
      `INSERT INTO keys
        (service_id, key_encrypted, pool_type, label, status, priority, pinned, daily_used, consecutive_failures)
       VALUES (?, ?, ?, ?, 'active', 0, 0, 0, 0)`,
      [serviceId, encrypted, poolType, label ?? null]
    );

    return result.lastInsertRowid;
  }

  /**
   * 刪除 Key
   */
  async removeKey(keyId: number): Promise<void> {
    this.db.run('DELETE FROM keys WHERE id = ?', [keyId]);
  }

  /**
   * 列出所有 Key（遮罩版）
   * @param serviceId 若指定則只列出該服務的 Key
   */
  async listKeys(serviceId?: string): Promise<KeyListItem[]> {
    let rows: KeyRow[];
    if (serviceId) {
      rows = this.db.query<KeyRow>(
        'SELECT * FROM keys WHERE service_id = ? ORDER BY pool_type, priority DESC, id',
        [serviceId]
      );
    } else {
      rows = this.db.query<KeyRow>(
        'SELECT * FROM keys ORDER BY service_id, pool_type, priority DESC, id'
      );
    }

    return rows.map(row => {
      // 解密以取得原始值（僅用來遮罩）
      let keyMasked = '****';
      try {
        const decrypted = this.crypto.decrypt(row.key_encrypted);
        keyMasked = this.crypto.maskKey(decrypted);
      } catch {
        keyMasked = '(解密失敗)';
      }

      return {
        id: row.id,
        service_id: row.service_id,
        key_masked: keyMasked,
        pool_type: row.pool_type,
        label: row.label,
        status: row.status,
        priority: row.priority,
        pinned: row.pinned === 1,
        daily_used: row.daily_used,
        consecutive_failures: row.consecutive_failures,
        rate_limit_until: row.rate_limit_until,
        last_success_at: row.last_success_at,
        created_at: row.created_at,
      };
    });
  }

  // ===== Key 選取 =====

  /**
   * 選取一個可用 Key
   * 優先級：pinned > active > rate_limited（冷卻結束）
   * 跳過：dead、冷卻中的 rate_limited
   * @param poolType 若指定只從該池選取
   */
  async selectKey(
    serviceId: string,
    poolType?: 'king' | 'friend'
  ): Promise<DecryptedKey | null> {
    // 查詢所有非 dead 的 Key
    let rows: KeyRow[];
    if (poolType) {
      rows = this.db.query<KeyRow>(
        `SELECT * FROM keys
         WHERE service_id = ? AND pool_type = ? AND status != 'dead'
         ORDER BY pinned DESC, priority DESC, id`,
        [serviceId, poolType]
      );
    } else {
      rows = this.db.query<KeyRow>(
        `SELECT * FROM keys
         WHERE service_id = ? AND status != 'dead'
         ORDER BY pinned DESC, priority DESC, id`,
        [serviceId]
      );
    }

    // 過濾出可用的 Key（active 或冷卻結束的 rate_limited）
    const now = new Date().toISOString();
    const available = rows.filter(row => {
      if (row.status === 'active') return true;
      if (row.status === 'rate_limited') {
        // 冷卻結束了才可用
        if (!row.rate_limit_until) return true;
        return row.rate_limit_until <= now;
      }
      return false;
    });

    if (available.length === 0) return null;

    // 解密並轉換成 DecryptedKey
    const decryptedKeys: DecryptedKey[] = available.map(row => ({
      id: row.id,
      service_id: row.service_id,
      key_value: this.crypto.decrypt(row.key_encrypted),
      pool_type: row.pool_type,
      status: row.status,
      pinned: row.pinned === 1,
      priority: row.priority,
      daily_used: row.daily_used,
      consecutive_failures: row.consecutive_failures,
      rate_limit_until: row.rate_limit_until,
      last_success_at: row.last_success_at,
    }));

    return this.selector.select(decryptedKeys);
  }

  // ===== 健康偵測（被動式） =====

  /**
   * 回報成功
   * - status = 'active'
   * - consecutive_failures = 0
   * - last_success_at = now
   * - daily_used++
   */
  async reportSuccess(keyId: number): Promise<void> {
    // 先查原狀態（如果從 rate_limited/dead 恢復，要發通知）
    let wasUnhealthy = false;
    if (this.notifier) {
      const rows = this.db.query<{ status: string }>(
        'SELECT status FROM keys WHERE id = ?',
        [keyId]
      );
      wasUnhealthy = rows[0]?.status !== 'active';
    }

    const now = new Date().toISOString();
    this.db.run(
      `UPDATE keys
       SET status = 'active',
           consecutive_failures = 0,
           last_success_at = ?,
           daily_used = daily_used + 1,
           monthly_used = monthly_used + 1,
           updated_at = ?
       WHERE id = ?`,
      [now, now, keyId]
    );

    // Key 恢復通知（從 rate_limited 或 dead 恢復到 active）
    if (this.notifier && wasUnhealthy) {
      const serviceId = this.getKeyServiceId(keyId);
      this.notifier.notify('key.recovered', {
        service_id: serviceId,
        key_id: keyId,
        message: `${serviceId} Key #${keyId} 已恢復正常 ✅`,
      }).catch(() => {});
    }
  }

  /**
   * 回報速率限制（429）
   * - status = 'rate_limited'
   * - rate_limit_until = now + 指數退避時間（1s, 2s, 4s, 8s ... max 300s）
   */
  async reportRateLimit(keyId: number): Promise<void> {
    // 先查 consecutive_failures 以計算退避時間
    const rows = this.db.query<{ consecutive_failures: number }>(
      'SELECT consecutive_failures FROM keys WHERE id = ?',
      [keyId]
    );
    const failures = rows[0]?.consecutive_failures ?? 0;

    // 指數退避：1s * 2^failures，最大 300s
    const backoffSeconds = Math.min(Math.pow(2, failures), 300);
    const now = new Date();
    const rateLimitUntil = new Date(now.getTime() + backoffSeconds * 1000).toISOString();

    this.db.run(
      `UPDATE keys
       SET status = 'rate_limited',
           rate_limit_until = ?,
           consecutive_failures = consecutive_failures + 1,
           updated_at = ?
       WHERE id = ?`,
      [rateLimitUntil, now.toISOString(), keyId]
    );

    // 觸發通知（非同步，不影響主流程）
    if (this.notifier) {
      const serviceId = this.getKeyServiceId(keyId);
      this.notifier.notify('key.rate_limited', {
        service_id: serviceId,
        key_id: keyId,
        message: `${serviceId} Key #${keyId} 被限速，退避 ${backoffSeconds} 秒`,
      }).catch(() => {});
    }
  }

  /**
   * 回報認證錯誤（401/403）
   * - status = 'dead'
   */
  async reportAuthError(keyId: number): Promise<void> {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE keys
       SET status = 'dead',
           last_error = '認證失敗（401/403）',
           updated_at = ?
       WHERE id = ?`,
      [now, keyId]
    );

    // 觸發通知（Key 死亡 — 認證失敗是永久性的）
    if (this.notifier) {
      const serviceId = this.getKeyServiceId(keyId);
      this.notifier.notify('key.dead', {
        service_id: serviceId,
        key_id: keyId,
        message: `${serviceId} Key #${keyId} 已死亡（認證失敗 401/403）`,
      }).catch(() => {});
    }
  }

  /**
   * 回報一般錯誤
   * - consecutive_failures++
   * - 累計 >= 3 → status = 'dead'
   */
  async reportError(keyId: number): Promise<void> {
    const now = new Date().toISOString();

    // 先更新 consecutive_failures
    this.db.run(
      `UPDATE keys
       SET consecutive_failures = consecutive_failures + 1,
           updated_at = ?
       WHERE id = ?`,
      [now, keyId]
    );

    // 查詢更新後的值
    const rows = this.db.query<{ consecutive_failures: number }>(
      'SELECT consecutive_failures FROM keys WHERE id = ?',
      [keyId]
    );
    const failures = rows[0]?.consecutive_failures ?? 0;

    // 累計 3 次以上 → dead
    if (failures >= 3) {
      this.db.run(
        `UPDATE keys
         SET status = 'dead',
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
        [`累計錯誤 ${failures} 次`, now, keyId]
      );

      // 觸發通知（累計錯誤死亡）
      if (this.notifier) {
        const serviceId = this.getKeyServiceId(keyId);
        this.notifier.notify('key.dead', {
          service_id: serviceId,
          key_id: keyId,
          message: `${serviceId} Key #${keyId} 已死亡（累計 ${failures} 次錯誤）`,
        }).catch(() => {});
      }
    }
  }

  // ===== 通知輔助 =====

  /**
   * 查詢 Key 的 service_id（用於通知，查不到就回傳 unknown）
   */
  private getKeyServiceId(keyId: number): string {
    const rows = this.db.query<{ service_id: string }>(
      'SELECT service_id FROM keys WHERE id = ?',
      [keyId]
    );
    return rows[0]?.service_id ?? 'unknown';
  }

  // ===== 每日重置 =====

  /**
   * 每日重置
   * daily_used = 0 for all keys
   */
  async dailyReset(): Promise<void> {
    this.db.run('UPDATE keys SET daily_used = 0');
  }

  // ===== 四層 Fallback =====

  /**
   * 取得所有有 Key 的服務 ID 清單
   * L2 Gateway 用來取得候選服務列表
   */
  getServiceIds(): string[] {
    const rows = this.db.query<{ service_id: string }>(
      `SELECT DISTINCT service_id FROM keys WHERE status != 'dead'`
    );
    return rows.map(r => r.service_id);
  }

  /**
   * 帶 Fallback 的 Key 選取
   * 1. king pool
   * 2. friend pool
   * 3. 都沒有 → null（L0 和 aid 由 router 層處理）
   */
  async selectKeyWithFallback(
    serviceId: string
  ): Promise<{ key: DecryptedKey; source: string } | null> {
    // 第一層：king pool
    const kingKey = await this.selectKey(serviceId, 'king');
    if (kingKey) {
      return { key: kingKey, source: 'king' };
    }

    // 第二層：friend pool
    const friendKey = await this.selectKey(serviceId, 'friend');
    if (friendKey) {
      return { key: friendKey, source: 'friend' };
    }

    // 沒有可用的 Key
    return null;
  }
}
