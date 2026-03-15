// VPS 排程器
// 管理 5 個定時任務：
//   1. 集體智慧分析：每 1 小時
//   2. L0 健康檢查：每 5 分鐘
//   3. DB 清理：每天 UTC 3:00
//   4. WAL checkpoint：每 15 分鐘
//   5. ECDH 金鑰輪換：每 30 天
// 冷啟動路由：重啟時讀取最近 24 小時聚合數據，產生過渡路由建議

import type { IntelligenceEngine, ColdStartResult, HourlyAnalysisResult } from '../services/intelligence-engine';
import type { L0Manager, HealthCheckResult } from '../services/l0-manager';
import type { VPSDatabase } from '../storage/database';
import type { VPSKeyManager } from '../core/ecdh';

// ===== 排程器狀態型別 =====
export interface SchedulerStatus {
  running: boolean;
  tasks: {
    intelligence: TaskStatus;
    l0Health: TaskStatus;
    dbCleanup: TaskStatus;
    walCheckpoint: TaskStatus;
    ecdhRotation: TaskStatus;
  };
  coldStartDone: boolean;
  startedAt: string | null;
}

interface TaskStatus {
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  errorCount: number;
  lastError: string | null;
}

// 建立初始 TaskStatus
function createTaskStatus(): TaskStatus {
  return {
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    errorCount: 0,
    lastError: null,
  };
}

// ===== 排程間隔定義 =====
const INTERVAL_INTELLIGENCE_MS = 60 * 60 * 1000;       // 每 1 小時
const INTERVAL_L0_HEALTH_MS = 5 * 60 * 1000;            // 每 5 分鐘
const INTERVAL_WAL_CHECKPOINT_MS = 15 * 60 * 1000;      // 每 15 分鐘
const INTERVAL_ECDH_ROTATION_MS = 30 * 24 * 60 * 60 * 1000;  // 每 30 天（毫秒計算用）
const INTERVAL_DB_CLEANUP_POLL_MS = 60 * 1000;          // 每分鐘檢查是否到 UTC 3:00

// ===== VPS Scheduler 主類別 =====
export class VPSScheduler {
  private intelligenceEngine: IntelligenceEngine;
  private l0Manager: L0Manager;
  private db: VPSDatabase;
  private keyManager: VPSKeyManager;

  // 定時器 handles
  private timers: {
    intelligence: ReturnType<typeof setInterval> | null;
    l0Health: ReturnType<typeof setInterval> | null;
    dbCleanupPoll: ReturnType<typeof setInterval> | null;
    walCheckpoint: ReturnType<typeof setInterval> | null;
    ecdhRotation: ReturnType<typeof setInterval> | null;
  } = {
    intelligence: null,
    l0Health: null,
    dbCleanupPoll: null,
    walCheckpoint: null,
    ecdhRotation: null,
  };

  // 排程狀態
  private status: SchedulerStatus = {
    running: false,
    tasks: {
      intelligence: createTaskStatus(),
      l0Health: createTaskStatus(),
      dbCleanup: createTaskStatus(),
      walCheckpoint: createTaskStatus(),
      ecdhRotation: createTaskStatus(),
    },
    coldStartDone: false,
    startedAt: null,
  };

  // 上次 DB 清理執行的 UTC 日期（'YYYY-MM-DD'，防止同日重複執行）
  private lastCleanupDate: string | null = null;

  constructor(
    intelligenceEngine: IntelligenceEngine,
    l0Manager: L0Manager,
    db: VPSDatabase,
    keyManager: VPSKeyManager,
  ) {
    this.intelligenceEngine = intelligenceEngine;
    this.l0Manager = l0Manager;
    this.db = db;
    this.keyManager = keyManager;
  }

  // ===== 冷啟動路由 =====
  // 重啟時讀取最近 24 小時聚合數據，產生過渡路由建議
  // 確保重啟後服務立即有路由建議可用
  async coldStart(): Promise<ColdStartResult> {
    console.log('[Scheduler] 執行冷啟動路由...');

    try {
      const result = await this.intelligenceEngine.coldStart();
      this.status.coldStartDone = true;
      console.log(
        `[Scheduler] 冷啟動完成：來源=${result.source}，` +
        `載入 ${result.recommendations_loaded} 條路由建議`,
      );
      return result;
    } catch (err) {
      console.error('[Scheduler] 冷啟動失敗：', err);
      this.status.coldStartDone = false;
      return { recommendations_loaded: 0, source: 'empty' };
    }
  }

  // ===== 啟動排程器 =====
  // 依次：冷啟動 → 啟動所有定時任務
  async start(): Promise<void> {
    if (this.status.running) {
      console.warn('[Scheduler] 排程器已在執行中，忽略重複啟動');
      return;
    }

    this.status.running = true;
    this.status.startedAt = new Date().toISOString();

    // 先執行冷啟動
    await this.coldStart();

    // 啟動各排程任務
    this._startIntelligenceTask();
    this._startL0HealthTask();
    this._startDbCleanupTask();
    this._startWalCheckpointTask();
    this._startEcdhRotationTask();

    console.log('[Scheduler] 所有排程任務已啟動');
  }

  // ===== 停止排程器 =====
  stop(): void {
    if (!this.status.running) return;

    // 清除所有定時器
    for (const [key, timer] of Object.entries(this.timers)) {
      if (timer !== null) {
        clearInterval(timer as ReturnType<typeof setInterval>);
        this.timers[key as keyof typeof this.timers] = null;
      }
    }

    this.status.running = false;
    console.log('[Scheduler] 排程器已停止');
  }

  // ===== 取得排程器狀態 =====
  getStatus(): Readonly<SchedulerStatus> {
    return this.status;
  }

  // ===== 手動觸發（測試用）=====

  // 手動觸發集體智慧分析
  async triggerIntelligence(): Promise<HourlyAnalysisResult> {
    return this._runIntelligenceAnalysis();
  }

  // 手動觸發 L0 健康檢查
  async triggerL0Health(): Promise<HealthCheckResult> {
    return this._runL0HealthCheck();
  }

  // 手動觸發 DB 清理
  async triggerDbCleanup(): Promise<void> {
    return this._runDbCleanup();
  }

  // 手動觸發 WAL checkpoint
  triggerWalCheckpoint(): void {
    this._runWalCheckpoint();
  }

  // 手動觸發 ECDH 金鑰輪換檢查
  async triggerEcdhRotation(): Promise<boolean> {
    return this._runEcdhRotation();
  }

  // ===== 私有：各任務啟動 =====

  // 任務 1：集體智慧分析（每 1 小時）
  private _startIntelligenceTask(): void {
    const nextRunAt = new Date(Date.now() + INTERVAL_INTELLIGENCE_MS).toISOString();
    this.status.tasks.intelligence.nextRunAt = nextRunAt;

    this.timers.intelligence = setInterval(async () => {
      await this._runIntelligenceAnalysis();
    }, INTERVAL_INTELLIGENCE_MS);

    console.log(`[Scheduler] 集體智慧分析已排程，下次執行：${nextRunAt}`);
  }

  // 任務 2：L0 健康檢查（每 5 分鐘）
  private _startL0HealthTask(): void {
    // 立即執行一次（確保啟動後馬上有健康狀態）
    void this._runL0HealthCheck();

    const nextRunAt = new Date(Date.now() + INTERVAL_L0_HEALTH_MS).toISOString();
    this.status.tasks.l0Health.nextRunAt = nextRunAt;

    this.timers.l0Health = setInterval(async () => {
      await this._runL0HealthCheck();
    }, INTERVAL_L0_HEALTH_MS);

    console.log(`[Scheduler] L0 健康檢查已排程（每 5 分鐘），下次：${nextRunAt}`);
  }

  // 任務 3：DB 清理（每天 UTC 3:00）
  // 實作：每分鐘 polling 當前時間，若為 UTC 03:xx 且今天尚未清理 → 執行
  private _startDbCleanupTask(): void {
    this.timers.dbCleanupPoll = setInterval(async () => {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const todayUtcDate = now.toISOString().slice(0, 10);

      // UTC 3:00 時段（03:00–03:59），且今天還沒清理過
      if (utcHour === 3 && this.lastCleanupDate !== todayUtcDate) {
        this.lastCleanupDate = todayUtcDate;
        await this._runDbCleanup();
      }
    }, INTERVAL_DB_CLEANUP_POLL_MS);

    console.log('[Scheduler] DB 清理已排程（每天 UTC 03:00）');
  }

  // 任務 4：WAL checkpoint（每 15 分鐘）
  private _startWalCheckpointTask(): void {
    const nextRunAt = new Date(Date.now() + INTERVAL_WAL_CHECKPOINT_MS).toISOString();
    this.status.tasks.walCheckpoint.nextRunAt = nextRunAt;

    this.timers.walCheckpoint = setInterval(() => {
      this._runWalCheckpoint();
    }, INTERVAL_WAL_CHECKPOINT_MS);

    console.log(`[Scheduler] WAL checkpoint 已排程（每 15 分鐘），下次：${nextRunAt}`);
  }

  // 任務 5：ECDH 金鑰輪換（每 30 天 polling）
  // 實作：以 24 小時間隔輪詢，讓 VPSKeyManager.rotateIfNeeded() 判斷是否已超過 30 天
  private _startEcdhRotationTask(): void {
    const ECDH_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每天檢查一次
    void INTERVAL_ECDH_ROTATION_MS; // 文件記錄用

    const nextRunAt = new Date(Date.now() + ECDH_POLL_INTERVAL_MS).toISOString();
    this.status.tasks.ecdhRotation.nextRunAt = nextRunAt;

    this.timers.ecdhRotation = setInterval(async () => {
      await this._runEcdhRotation();
    }, ECDH_POLL_INTERVAL_MS);

    console.log(`[Scheduler] ECDH 金鑰輪換檢查已排程（每日，30 天門檻），下次：${nextRunAt}`);
  }

  // ===== 私有：各任務執行 =====

  // 執行集體智慧分析
  private async _runIntelligenceAnalysis(): Promise<HourlyAnalysisResult> {
    const task = this.status.tasks.intelligence;
    try {
      console.log('[Scheduler] 開始執行集體智慧分析...');
      const result = await this.intelligenceEngine.runHourlyAnalysis();

      task.lastRunAt = new Date().toISOString();
      task.nextRunAt = new Date(Date.now() + INTERVAL_INTELLIGENCE_MS).toISOString();
      task.runCount++;

      console.log(
        `[Scheduler] 集體智慧分析完成：` +
        `生成 ${result.recommendations_generated} 條建議，` +
        `觸發 ${result.alerts_fired} 個警報，` +
        `分析 ${result.services_analyzed} 個服務`,
      );
      return result;
    } catch (err) {
      task.errorCount++;
      task.lastError = String(err);
      console.error('[Scheduler] 集體智慧分析失敗：', err);
      throw err;
    }
  }

  // 執行 L0 健康檢查
  private async _runL0HealthCheck(): Promise<HealthCheckResult> {
    const task = this.status.tasks.l0Health;
    try {
      const result = await this.l0Manager.checkHealth();

      task.lastRunAt = new Date().toISOString();
      task.nextRunAt = new Date(Date.now() + INTERVAL_L0_HEALTH_MS).toISOString();
      task.runCount++;

      if (result.warnings > 0) {
        console.warn(
          `[Scheduler] L0 健康檢查：${result.checked} 個 key，` +
          `${result.updated} 個狀態更新，${result.warnings} 個警告`,
        );
      }
      return result;
    } catch (err) {
      task.errorCount++;
      task.lastError = String(err);
      console.error('[Scheduler] L0 健康檢查失敗：', err);
      throw err;
    }
  }

  // 執行 DB 清理
  private async _runDbCleanup(): Promise<void> {
    const task = this.status.tasks.dbCleanup;
    try {
      console.log('[Scheduler] 開始執行每日 DB 清理...');

      // 清理過期遙測批次（超過 90 天）
      const batchResult = this.db.run(
        `DELETE FROM telemetry_batches
         WHERE received_at < datetime('now', '-90 days')`,
      );

      // 清理過期遙測條目（超過 90 天）
      const entryResult = this.db.run(
        `DELETE FROM telemetry_entries
         WHERE received_at < datetime('now', '-90 days')`,
      );

      // 清理過期路由建議（valid_until < now - 7 天）
      const recResult = this.db.run(
        `DELETE FROM routing_recommendations
         WHERE valid_until < datetime('now', '-7 days')`,
      );

      // 清理過期的 ECDH 金鑰記錄（retired 超過 7 天）
      await this.keyManager.cleanupExpired();

      task.lastRunAt = new Date().toISOString();
      task.nextRunAt = null; // 下次執行由 polling 觸發，不是固定間隔
      task.runCount++;

      console.log(
        `[Scheduler] DB 清理完成：` +
        `清除 ${batchResult.changes} 個批次，` +
        `${entryResult.changes} 條遙測條目，` +
        `${recResult.changes} 條路由建議`,
      );
    } catch (err) {
      task.errorCount++;
      task.lastError = String(err);
      console.error('[Scheduler] DB 清理失敗：', err);
      throw err;
    }
  }

  // 執行 WAL checkpoint
  private _runWalCheckpoint(): void {
    const task = this.status.tasks.walCheckpoint;
    try {
      this.db.checkpoint();

      task.lastRunAt = new Date().toISOString();
      task.nextRunAt = new Date(Date.now() + INTERVAL_WAL_CHECKPOINT_MS).toISOString();
      task.runCount++;
    } catch (err) {
      task.errorCount++;
      task.lastError = String(err);
      console.error('[Scheduler] WAL checkpoint 失敗：', err);
    }
  }

  // 執行 ECDH 金鑰輪換檢查
  private async _runEcdhRotation(): Promise<boolean> {
    const task = this.status.tasks.ecdhRotation;
    try {
      const rotated = await this.keyManager.rotateIfNeeded();

      task.lastRunAt = new Date().toISOString();
      task.runCount++;

      if (rotated) {
        console.log('[Scheduler] ECDH 金鑰已輪換（超過 30 天門檻）');
      }

      return rotated;
    } catch (err) {
      task.errorCount++;
      task.lastError = String(err);
      console.error('[Scheduler] ECDH 金鑰輪換失敗：', err);
      throw err;
    }
  }
}
