/**
 * Scheduler 模組 — 背景排程框架
 * 負責管理所有定時任務，支援固定間隔、每日定時、啟動時一次執行
 */

// ─── 型別定義 ────────────────────────────────────────────────────────────────

/** 排程任務定義 */
export interface ScheduledTask {
  /** 任務唯一名稱 */
  name: string;
  /** 執行間隔（毫秒），或 'cron' 代表使用 cronExpression */
  interval: number | 'cron';
  /** Cron 表達式，僅當 interval === 'cron' 時使用，如 '0 3 * * *' */
  cronExpression?: string;
  /** 任務處理函式 */
  handler: () => Promise<void>;
  /** 是否正在執行中（防止同任務重複執行） */
  running: boolean;
  /** 上次執行時間 */
  lastRun?: Date;
  /** 下次預定執行時間 */
  nextRun?: Date;
}

/** 任務狀態回報 */
export interface TaskStatus {
  /** 任務名稱 */
  name: string;
  /** 是否正在執行中 */
  running: boolean;
  /** 上次執行時間（ISO 字串），未執行過為 null */
  lastRun: string | null;
  /** 下次執行時間（ISO 字串），已停止為 null */
  nextRun: string | null;
  /** 人類可讀的間隔描述，如 '5 分鐘'、'每日 00:00' */
  interval: string;
}

// ─── 輔助函式 ────────────────────────────────────────────────────────────────

/**
 * 解析 cron 表達式，計算距離下次執行的毫秒數
 * 僅支援簡化格式：'分 時 * * *'（每日定時）
 */
function msUntilNextCron(cronExpression: string, now: Date = new Date()): number {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`不支援的 cron 表達式：${cronExpression}`);
  }
  const [minutePart, hourPart] = parts;
  const targetMinute = parseInt(minutePart, 10);
  const targetHour = parseInt(hourPart, 10);

  if (isNaN(targetMinute) || isNaN(targetHour)) {
    throw new Error(`cron 表達式無效（需要數字）：${cronExpression}`);
  }

  // 計算今天目標時間（本地時區）
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);

  // 如果目標時間已過，推到明天
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

/**
 * 將間隔毫秒數或 cron 表達式轉為人類可讀字串
 */
function formatInterval(task: ScheduledTask): string {
  if (task.interval === 'cron' && task.cronExpression) {
    const parts = task.cronExpression.trim().split(/\s+/);
    if (parts.length >= 2) {
      const minute = parts[0].padStart(2, '0');
      const hour = parts[1].padStart(2, '0');
      return `每日 ${hour}:${minute}`;
    }
    return task.cronExpression;
  }
  const ms = task.interval as number;
  const minutes = ms / 60_000;
  const hours = ms / 3_600_000;
  const days = ms / 86_400_000;
  if (ms === 0) return '啟動時一次';
  if (days >= 1 && ms % 86_400_000 === 0) return `每 ${days} 天`;
  if (hours >= 1 && ms % 3_600_000 === 0) return `每 ${hours} 小時`;
  if (minutes >= 1 && ms % 60_000 === 0) return `每 ${minutes} 分鐘`;
  return `每 ${ms} 毫秒`;
}

// ─── Scheduler 主類別 ────────────────────────────────────────────────────────

/**
 * 背景排程器
 * 管理所有定時任務的生命週期，支援啟動、停止、手動觸發
 */
export class Scheduler {
  /** 所有已註冊的任務 */
  private tasks: Map<string, ScheduledTask> = new Map();
  /** 每個任務對應的 timer（setInterval 或 setTimeout 的回傳值） */
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  /** setTimeout 用於 cron 任務的首次計時器 */
  private cronTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** 排程器是否已啟動 */
  private started = false;

  // ── 公開 API ────────────────────────────────────────────────────────────────

  /**
   * 註冊一個排程任務
   * 若排程器已啟動，立即為此任務建立 timer
   */
  register(task: ScheduledTask): void {
    if (this.tasks.has(task.name)) {
      console.warn(`[Scheduler] 任務已存在，覆蓋：${task.name}`);
      this.unregister(task.name);
    }
    this.tasks.set(task.name, task);
    if (this.started) {
      this._scheduleTask(task);
    }
  }

  /**
   * 取消並移除一個排程任務
   */
  unregister(name: string): void {
    this._clearTaskTimers(name);
    this.tasks.delete(name);
  }

  /**
   * 啟動所有已註冊的排程任務
   */
  start(): void {
    if (this.started) {
      console.warn('[Scheduler] 排程器已在執行中');
      return;
    }
    this.started = true;
    for (const task of this.tasks.values()) {
      this._scheduleTask(task);
    }
    console.log(`[Scheduler] 啟動完成，共 ${this.tasks.size} 個任務`);
  }

  /**
   * 停止排程器
   * 等待所有正在執行的任務完成（最多等 10 秒）後才 resolve
   */
  async stop(): Promise<void> {
    this.started = false;

    // 清除所有 timer，停止後續觸發
    for (const name of this.tasks.keys()) {
      this._clearTaskTimers(name);
    }

    // 等待執行中的任務完成，最多 10 秒
    const TIMEOUT_MS = 10_000;
    const POLL_INTERVAL_MS = 50;
    const deadline = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
      const anyRunning = Array.from(this.tasks.values()).some(t => t.running);
      if (!anyRunning) break;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const stillRunning = Array.from(this.tasks.values())
      .filter(t => t.running)
      .map(t => t.name);

    if (stillRunning.length > 0) {
      console.warn(`[Scheduler] 超時強制停止，仍有任務未完成：${stillRunning.join(', ')}`);
    } else {
      console.log('[Scheduler] 已優雅停止，所有任務完成');
    }
  }

  /**
   * 手動觸發指定任務（測試用，不受 running 鎖保護）
   */
  async trigger(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (!task) {
      throw new Error(`[Scheduler] 找不到任務：${name}`);
    }
    await this._runTask(task);
  }

  /**
   * 取得所有任務的目前狀態
   */
  getStatus(): TaskStatus[] {
    return Array.from(this.tasks.values()).map(task => ({
      name: task.name,
      running: task.running,
      lastRun: task.lastRun?.toISOString() ?? null,
      nextRun: task.nextRun?.toISOString() ?? null,
      interval: formatInterval(task),
    }));
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  /**
   * 為單一任務建立對應的 timer
   */
  private _scheduleTask(task: ScheduledTask): void {
    if (task.interval === 0) {
      // 啟動時一次：用 setTimeout(0) 非同步執行
      const timer = setTimeout(() => {
        this._runTask(task);
      }, 0) as unknown as ReturnType<typeof setInterval>;
      this.timers.set(task.name, timer);

    } else if (task.interval === 'cron') {
      // Cron 模式：每日定時，先等到目標時間，再每 24hr 重複
      this._scheduleCronTask(task);

    } else {
      // 固定間隔：用 setInterval
      const intervalMs = task.interval as number;
      task.nextRun = new Date(Date.now() + intervalMs);
      const timer = setInterval(() => {
        task.nextRun = new Date(Date.now() + intervalMs);
        this._runTask(task);
      }, intervalMs);
      this.timers.set(task.name, timer);
    }
  }

  /**
   * 為 cron 任務設定首次計時器（等到目標時間），之後每 24hr 重複
   */
  private _scheduleCronTask(task: ScheduledTask): void {
    const delayMs = msUntilNextCron(task.cronExpression!);
    task.nextRun = new Date(Date.now() + delayMs);

    const cronTimer = setTimeout(() => {
      this.cronTimers.delete(task.name);
      // 觸發執行
      this._runTask(task);
      // 每 24hr 後重複
      if (this.started && this.tasks.has(task.name)) {
        const intervalTimer = setInterval(() => {
          task.nextRun = new Date(Date.now() + 86_400_000);
          this._runTask(task);
        }, 86_400_000);
        this.timers.set(task.name, intervalTimer);
      }
    }, delayMs);

    this.cronTimers.set(task.name, cronTimer);
  }

  /**
   * 清除指定任務的所有 timer
   */
  private _clearTaskTimers(name: string): void {
    const timer = this.timers.get(name);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(name);
    }
    const cronTimer = this.cronTimers.get(name);
    if (cronTimer !== undefined) {
      clearTimeout(cronTimer);
      this.cronTimers.delete(name);
    }
  }

  /**
   * 執行任務並管理 running 鎖
   * 若任務已在執行中，跳過本次觸發
   */
  private async _runTask(task: ScheduledTask): Promise<void> {
    if (task.running) {
      console.log(`[Scheduler] 跳過（執行中）：${task.name}`);
      return;
    }
    task.running = true;
    task.lastRun = new Date();
    try {
      await task.handler();
    } catch (err) {
      console.error(`[Scheduler] 任務發生錯誤：${task.name}`, err);
    } finally {
      task.running = false;
    }
  }
}

// ─── 建立預設 Scheduler 實例 ─────────────────────────────────────────────────

/** 全域共用的排程器實例 */
export const scheduler = new Scheduler();

// ─── 11 個排程任務定義 ───────────────────────────────────────────────────────

/**
 * 建立並註冊所有系統排程任務到指定排程器
 * 所有任務目前為空殼，只記錄 log
 */
export function registerAllTasks(s: Scheduler = scheduler): void {

  // 1. health_check — 每 5 分鐘，檢查 VPS 連線狀態
  s.register({
    name: 'health_check',
    interval: 5 * 60_000,
    handler: async () => {
      console.log('[health_check] 檢查 VPS 連線狀態（空殼）');
    },
    running: false,
  });

  // 2. telemetry_upload — 每 1 小時 + 0~5 分鐘 jitter，批次上報匿名統計
  s.register({
    name: 'telemetry_upload',
    interval: 60 * 60_000 + Math.floor(Math.random() * 300_000),
    handler: async () => {
      console.log('[telemetry_upload] 批次上報匿名統計（空殼）');
    },
    running: false,
  });

  // 3. wal_checkpoint — 每 15 分鐘，SQLite WAL checkpoint
  s.register({
    name: 'wal_checkpoint',
    interval: 15 * 60_000,
    handler: async () => {
      console.log('[wal_checkpoint] SQLite WAL checkpoint（空殼）');
    },
    running: false,
  });

  // 4. l0_refresh — 每 6 小時，從 VPS 更新 L0 Key
  s.register({
    name: 'l0_refresh',
    interval: 6 * 60 * 60_000,
    handler: async () => {
      console.log('[l0_refresh] 從 VPS 更新 L0 Key（空殼）');
    },
    running: false,
  });

  // 5. version_check — 每 24 小時，檢查新版本
  s.register({
    name: 'version_check',
    interval: 24 * 60 * 60_000,
    handler: async () => {
      console.log('[version_check] 檢查新版本（空殼）');
    },
    running: false,
  });

  // 6. adapter_update — 啟動時執行一次，檢查 Adapter 更新
  s.register({
    name: 'adapter_update',
    interval: 0,
    handler: async () => {
      console.log('[adapter_update] 檢查 Adapter 更新（空殼）');
    },
    running: false,
  });

  // 7. daily_reset — 每日 00:00（本地時區），重置每日計數器
  s.register({
    name: 'daily_reset',
    interval: 'cron',
    cronExpression: '0 0 * * *',
    handler: async () => {
      console.log('[daily_reset] 重置每日計數器（空殼）');
    },
    running: false,
  });

  // 8. log_cleanup — 每日 03:00，清理 > 30 天的日誌
  s.register({
    name: 'log_cleanup',
    interval: 'cron',
    cronExpression: '0 3 * * *',
    handler: async () => {
      console.log('[log_cleanup] 清理 >30 天日誌（空殼）');
    },
    running: false,
  });

  // 9. keypair_rotation — 每日 04:00，檢查 ECDH 金鑰到期
  s.register({
    name: 'keypair_rotation',
    interval: 'cron',
    cronExpression: '0 4 * * *',
    handler: async () => {
      console.log('[keypair_rotation] 檢查 ECDH 金鑰到期（空殼）');
    },
    running: false,
  });

  // 10. telemetry_queue_cleanup — 每日 05:00，清理 > 30 天的待上報資料
  s.register({
    name: 'telemetry_queue_cleanup',
    interval: 'cron',
    cronExpression: '0 5 * * *',
    handler: async () => {
      console.log('[telemetry_queue_cleanup] 清理 >30 天待上報（空殼）');
    },
    running: false,
  });

  // 11. key_expiry_check — 每 1 小時，檢查 Key 到期提醒
  s.register({
    name: 'key_expiry_check',
    interval: 60 * 60_000,
    handler: async () => {
      console.log('[key_expiry_check] 檢查 Key 到期提醒（空殼）');
    },
    running: false,
  });
}
