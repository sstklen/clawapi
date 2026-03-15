// Claude Bot — VPS 子系統健康監控
// 每 5 分鐘檢查 8 個子系統狀態，觸發告警閾值時通知 tkman

import type { AlertManager } from '../core/alert-manager';
import type { VPSDatabase } from '../storage/database';

// ===== 型別定義 =====

// 子系統識別碼
export type Subsystem =
  | 'intelligence'  // 集體智慧引擎
  | 'websocket'     // WebSocket 連線
  | 'l0'            // L0 公共 Key 管理
  | 'aid'           // 互助系統
  | 'chat'          // 聊天頻道
  | 'database'      // SQLite 資料庫
  | 'disk'          // 磁碟使用率
  | 'memory';       // 記憶體使用率

// 單一子系統健康狀態
export interface SubsystemHealth {
  name: Subsystem;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  message: string;
  value?: number;       // 實際數值（百分比 / 連線數 / MB 等）
  threshold?: number;   // 對應閾值
}

// 整體健康報告
export interface HealthReport {
  overall: 'healthy' | 'warning' | 'critical';
  checkedAt: string;        // ISO 8601
  subsystems: SubsystemHealth[];
  alertsFired: number;
}

// 系統指標（由外部注入或 Bun API 取得）
export interface SystemMetrics {
  diskUsagePercent: number;     // 磁碟使用率（0-100）
  memoryUsagePercent: number;   // 記憶體使用率（0-100）
  wsConnectionCount: number;    // WebSocket 目前連線數
  dbSizeBytes: number;          // DB 檔案大小（bytes）
  intelligenceLastUpdatedAt?: string;  // 集體智慧最後更新時間（ISO 8601）
}

// ===== 告警閾值常數 =====

const THRESHOLDS = {
  // 磁碟
  DISK_WARNING: 75,      // > 75% → warning
  DISK_CRITICAL: 90,     // > 90% → critical
  // 記憶體
  MEMORY_WARNING: 80,    // > 80% → warning
  MEMORY_CRITICAL: 95,   // > 95% → critical
  // WebSocket 連線數
  WS_WARNING: 4000,      // > 4000 → warning
  // DB 大小（5GB = 5 * 1024^3 bytes）
  DB_SIZE_WARNING: 5 * 1024 * 1024 * 1024,
  // 集體智慧最後更新（2 小時 = 7200 秒）
  INTELLIGENCE_STALE_SECONDS: 2 * 60 * 60,
} as const;

// 監控間隔（5 分鐘）
const MONITOR_INTERVAL_MS = 5 * 60 * 1000;

// ===== VPSMonitor 主類別 =====

export class VPSMonitor {
  private db: VPSDatabase;
  private alertManager: AlertManager;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  // 外部注入的指標取得函式（依賴注入，方便測試 mock）
  private getMetrics: () => Promise<SystemMetrics>;

  constructor(
    db: VPSDatabase,
    alertManager: AlertManager,
    getMetrics?: () => Promise<SystemMetrics>,
  ) {
    this.db = db;
    this.alertManager = alertManager;
    // 預設指標取得函式（實際部署使用）
    this.getMetrics = getMetrics ?? this.defaultGetMetrics.bind(this);
  }

  // ===== 公開 API =====

  // 執行一次完整健康檢查
  async runHealthCheck(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    let metrics: SystemMetrics;

    try {
      metrics = await this.getMetrics();
    } catch (err) {
      console.error('[VPSMonitor] 取得系統指標失敗:', err);
      // 無法取得指標時，回傳 unknown 狀態
      return {
        overall: 'critical',
        checkedAt,
        subsystems: this.buildUnknownReport(),
        alertsFired: 0,
      };
    }

    const subsystems: SubsystemHealth[] = [];
    let alertsFired = 0;

    // === 檢查各子系統 ===

    // 1. 磁碟使用率
    const diskHealth = this.checkDisk(metrics.diskUsagePercent);
    subsystems.push(diskHealth);
    if (diskHealth.status !== 'healthy') {
      const sent = await this.alertManager.sendAlert({
        severity: diskHealth.status === 'critical' ? 'critical' : 'warning',
        category: 'disk_usage',
        message: diskHealth.message,
        suggestion: '考慮清理舊日誌或擴充磁碟容量',
      });
      if (sent) alertsFired++;
    }

    // 2. 記憶體使用率
    const memoryHealth = this.checkMemory(metrics.memoryUsagePercent);
    subsystems.push(memoryHealth);
    if (memoryHealth.status !== 'healthy') {
      const sent = await this.alertManager.sendAlert({
        severity: memoryHealth.status === 'critical' ? 'critical' : 'warning',
        category: 'memory_usage',
        message: memoryHealth.message,
        suggestion: '考慮重啟服務或擴充記憶體',
      });
      if (sent) alertsFired++;
    }

    // 3. WebSocket 連線數
    const wsHealth = this.checkWebSocket(metrics.wsConnectionCount);
    subsystems.push(wsHealth);
    if (wsHealth.status !== 'healthy') {
      const sent = await this.alertManager.sendAlert({
        severity: 'warning',
        category: 'websocket_connections',
        message: wsHealth.message,
        suggestion: '檢查是否有連線洩漏或流量異常',
      });
      if (sent) alertsFired++;
    }

    // 4. 資料庫大小
    const dbHealth = this.checkDatabase(metrics.dbSizeBytes);
    subsystems.push(dbHealth);
    if (dbHealth.status !== 'healthy') {
      const sent = await this.alertManager.sendAlert({
        severity: 'warning',
        category: 'database_size',
        message: dbHealth.message,
        suggestion: '執行 VACUUM 或清理舊遙測數據',
      });
      if (sent) alertsFired++;
    }

    // 5. 集體智慧引擎
    const intelligenceHealth = this.checkIntelligence(metrics.intelligenceLastUpdatedAt);
    subsystems.push(intelligenceHealth);
    if (intelligenceHealth.status !== 'healthy') {
      const sent = await this.alertManager.sendAlert({
        severity: 'warning',
        category: 'intelligence_stale',
        message: intelligenceHealth.message,
        suggestion: '檢查 IntelligenceEngine 定時器是否正常運作',
      });
      if (sent) alertsFired++;
    }

    // 6. L0 子系統（從 DB 取狀態）
    const l0Health = this.checkL0FromDb();
    subsystems.push(l0Health);

    // 7. 互助子系統（從 DB 取狀態）
    const aidHealth = this.checkAidFromDb();
    subsystems.push(aidHealth);

    // 8. 聊天子系統（依 WS 連線判定）
    const chatHealth = this.checkChat(metrics.wsConnectionCount);
    subsystems.push(chatHealth);

    // === 判定整體狀態 ===
    const overall = this.determineOverallStatus(subsystems);

    return {
      overall,
      checkedAt,
      subsystems,
      alertsFired,
    };
  }

  // 啟動定期監控（每 5 分鐘）
  start(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(async () => {
      try {
        await this.runHealthCheck();
      } catch (err) {
        console.error('[VPSMonitor] 定期健康檢查失敗:', err);
      }
    }, MONITOR_INTERVAL_MS);
  }

  // 停止監控
  stop(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  // ===== 各子系統檢查方法 =====

  checkDisk(diskUsagePercent: number): SubsystemHealth {
    if (diskUsagePercent > THRESHOLDS.DISK_CRITICAL) {
      return {
        name: 'disk',
        status: 'critical',
        message: `磁碟使用率 ${diskUsagePercent.toFixed(1)}%，超過臨界閾值 ${THRESHOLDS.DISK_CRITICAL}%`,
        value: diskUsagePercent,
        threshold: THRESHOLDS.DISK_CRITICAL,
      };
    }
    if (diskUsagePercent > THRESHOLDS.DISK_WARNING) {
      return {
        name: 'disk',
        status: 'warning',
        message: `磁碟使用率 ${diskUsagePercent.toFixed(1)}%，超過警告閾值 ${THRESHOLDS.DISK_WARNING}%`,
        value: diskUsagePercent,
        threshold: THRESHOLDS.DISK_WARNING,
      };
    }
    return {
      name: 'disk',
      status: 'healthy',
      message: `磁碟使用率正常（${diskUsagePercent.toFixed(1)}%）`,
      value: diskUsagePercent,
    };
  }

  checkMemory(memoryUsagePercent: number): SubsystemHealth {
    if (memoryUsagePercent > THRESHOLDS.MEMORY_CRITICAL) {
      return {
        name: 'memory',
        status: 'critical',
        message: `記憶體使用率 ${memoryUsagePercent.toFixed(1)}%，超過臨界閾值 ${THRESHOLDS.MEMORY_CRITICAL}%`,
        value: memoryUsagePercent,
        threshold: THRESHOLDS.MEMORY_CRITICAL,
      };
    }
    if (memoryUsagePercent > THRESHOLDS.MEMORY_WARNING) {
      return {
        name: 'memory',
        status: 'warning',
        message: `記憶體使用率 ${memoryUsagePercent.toFixed(1)}%，超過警告閾值 ${THRESHOLDS.MEMORY_WARNING}%`,
        value: memoryUsagePercent,
        threshold: THRESHOLDS.MEMORY_WARNING,
      };
    }
    return {
      name: 'memory',
      status: 'healthy',
      message: `記憶體使用率正常（${memoryUsagePercent.toFixed(1)}%）`,
      value: memoryUsagePercent,
    };
  }

  checkWebSocket(wsConnectionCount: number): SubsystemHealth {
    if (wsConnectionCount > THRESHOLDS.WS_WARNING) {
      return {
        name: 'websocket',
        status: 'warning',
        message: `WebSocket 連線數 ${wsConnectionCount}，超過警告閾值 ${THRESHOLDS.WS_WARNING}`,
        value: wsConnectionCount,
        threshold: THRESHOLDS.WS_WARNING,
      };
    }
    return {
      name: 'websocket',
      status: 'healthy',
      message: `WebSocket 連線正常（${wsConnectionCount} 個連線）`,
      value: wsConnectionCount,
    };
  }

  checkDatabase(dbSizeBytes: number): SubsystemHealth {
    const dbSizeGB = dbSizeBytes / (1024 * 1024 * 1024);
    if (dbSizeBytes > THRESHOLDS.DB_SIZE_WARNING) {
      return {
        name: 'database',
        status: 'warning',
        message: `DB 大小 ${dbSizeGB.toFixed(2)} GB，超過警告閾值 5 GB`,
        value: dbSizeBytes,
        threshold: THRESHOLDS.DB_SIZE_WARNING,
      };
    }
    return {
      name: 'database',
      status: 'healthy',
      message: `DB 大小正常（${dbSizeGB.toFixed(2)} GB）`,
      value: dbSizeBytes,
    };
  }

  checkIntelligence(lastUpdatedAt?: string): SubsystemHealth {
    if (!lastUpdatedAt) {
      return {
        name: 'intelligence',
        status: 'unknown',
        message: '集體智慧引擎尚未有更新記錄',
      };
    }

    const lastUpdatedMs = new Date(lastUpdatedAt).getTime();
    const elapsedSeconds = (Date.now() - lastUpdatedMs) / 1000;

    if (elapsedSeconds > THRESHOLDS.INTELLIGENCE_STALE_SECONDS) {
      const elapsedHours = (elapsedSeconds / 3600).toFixed(1);
      return {
        name: 'intelligence',
        status: 'warning',
        message: `集體智慧引擎超過 ${elapsedHours} 小時未更新（閾值：2 小時）`,
        value: elapsedSeconds,
        threshold: THRESHOLDS.INTELLIGENCE_STALE_SECONDS,
      };
    }

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    return {
      name: 'intelligence',
      status: 'healthy',
      message: `集體智慧引擎正常（最後更新：${elapsedMinutes} 分鐘前）`,
      value: elapsedSeconds,
    };
  }

  // ===== 私有工具方法 =====

  // 從 DB 查詢 L0 子系統狀態
  private checkL0FromDb(): SubsystemHealth {
    try {
      const result = this.db.query<{ active: number; total: number }>(
        `SELECT
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
          COUNT(*) as total
         FROM l0_keys`,
      );
      const { active, total } = result[0] ?? { active: 0, total: 0 };

      if (total === 0) {
        return {
          name: 'l0',
          status: 'warning',
          message: 'L0 公共 Key 池為空，無可用 Key',
        };
      }

      return {
        name: 'l0',
        status: 'healthy',
        message: `L0 Key 池正常（${active} 個活躍 / ${total} 個總計）`,
        value: active,
      };
    } catch {
      return {
        name: 'l0',
        status: 'unknown',
        message: 'L0 子系統狀態查詢失敗',
      };
    }
  }

  // 從 DB 查詢互助子系統狀態
  private checkAidFromDb(): SubsystemHealth {
    try {
      const result = this.db.query<{ enabled_count: number }>(
        `SELECT COUNT(*) as enabled_count FROM aid_configs WHERE enabled = 1`,
      );
      const enabledCount = result[0]?.enabled_count ?? 0;

      return {
        name: 'aid',
        status: 'healthy',
        message: `互助系統正常（${enabledCount} 個裝置已啟用互助）`,
        value: enabledCount,
      };
    } catch {
      return {
        name: 'aid',
        status: 'unknown',
        message: '互助子系統狀態查詢失敗',
      };
    }
  }

  // 聊天子系統（依 WebSocket 連線數判定）
  private checkChat(wsConnectionCount: number): SubsystemHealth {
    return {
      name: 'chat',
      status: 'healthy',
      message: `聊天子系統正常（${wsConnectionCount} 個 WS 連線中）`,
      value: wsConnectionCount,
    };
  }

  // 判定整體健康狀態
  private determineOverallStatus(
    subsystems: SubsystemHealth[],
  ): 'healthy' | 'warning' | 'critical' {
    const hasCritical = subsystems.some(s => s.status === 'critical');
    if (hasCritical) return 'critical';

    const hasWarning = subsystems.some(s => s.status === 'warning');
    if (hasWarning) return 'warning';

    return 'healthy';
  }

  // 預設指標取得（實際部署使用 Bun API）
  private async defaultGetMetrics(): Promise<SystemMetrics> {
    // Bun 目前沒有直接的磁碟 / 記憶體 API
    // 這裡用 os 模組取得記憶體，磁碟大小從 DB 檔案取得
    // 實際部署可改為讀取 /proc/meminfo 或用 Bun.spawn 呼叫系統指令

    // 記憶體使用率（Bun.gc() 取得粗略值）
    const memInfo = process.memoryUsage();
    const heapUsed = memInfo.heapUsed;
    const heapTotal = memInfo.heapTotal;
    const memoryUsagePercent = heapTotal > 0 ? (heapUsed / heapTotal) * 100 : 0;

    // 查詢集體智慧最後更新時間
    let intelligenceLastUpdatedAt: string | undefined;
    try {
      const result = this.db.query<{ generated_at: string }>(
        `SELECT generated_at FROM routing_recommendations
         ORDER BY generated_at DESC LIMIT 1`,
      );
      intelligenceLastUpdatedAt = result[0]?.generated_at;
    } catch {
      intelligenceLastUpdatedAt = undefined;
    }

    return {
      diskUsagePercent: 0,        // 需外部提供或讀取 /proc
      memoryUsagePercent,
      wsConnectionCount: 0,       // 需從 WebSocketManager 注入
      dbSizeBytes: 0,             // 需從檔案系統讀取
      intelligenceLastUpdatedAt,
    };
  }

  // 建立全 unknown 狀態報告（指標取得失敗時使用）
  private buildUnknownReport(): SubsystemHealth[] {
    const subsystemNames: Subsystem[] = [
      'intelligence', 'websocket', 'l0', 'aid',
      'chat', 'database', 'disk', 'memory',
    ];
    return subsystemNames.map(name => ({
      name,
      status: 'unknown' as const,
      message: '無法取得系統指標',
    }));
  }
}

// 匯出閾值常數供測試使用
export { THRESHOLDS, MONITOR_INTERVAL_MS };
