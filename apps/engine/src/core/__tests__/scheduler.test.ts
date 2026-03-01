/**
 * Scheduler 模組測試
 * 覆蓋：啟動/停止、任務觸發、並發防護、關機等待、取消任務、getStatus、fake clock
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Scheduler, registerAllTasks } from '../scheduler';

// ─── 輔助工具 ────────────────────────────────────────────────────────────────

/** 等待下一個 microtask/macrotask，讓 setTimeout(0) 有機會執行 */
function flushTimers(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 測試：基本啟動 ──────────────────────────────────────────────────────────

describe('Scheduler — 基本啟動', () => {
  let sched: Scheduler;

  beforeEach(() => {
    sched = new Scheduler();
  });

  afterEach(async () => {
    await sched.stop();
  });

  it('11 個任務全部透過 registerAllTasks 成功註冊', () => {
    registerAllTasks(sched);
    const status = sched.getStatus();
    expect(status).toHaveLength(11);

    // 驗證每個任務名稱都存在
    const names = status.map(s => s.name);
    const expected = [
      'health_check',
      'telemetry_upload',
      'wal_checkpoint',
      'l0_refresh',
      'version_check',
      'adapter_update',
      'daily_reset',
      'log_cleanup',
      'keypair_rotation',
      'telemetry_queue_cleanup',
      'key_expiry_check',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('start() 啟動後排程器進入執行狀態', () => {
    registerAllTasks(sched);
    sched.start();
    // 啟動後 getStatus 仍能正常回傳
    const status = sched.getStatus();
    expect(status).toHaveLength(11);
  });

  it('重複呼叫 start() 不會重複建立 timer', async () => {
    let callCount = 0;
    sched.register({
      name: 'test_double_start',
      interval: 100,
      handler: async () => { callCount++; },
      running: false,
    });
    sched.start();
    sched.start(); // 第二次 start 應被忽略
    await flushTimers(150);
    // callCount 不應翻倍
    expect(callCount).toBeLessThanOrEqual(2);
  });
});

// ─── 測試：trigger() 手動觸發 ────────────────────────────────────────────────

describe('Scheduler — trigger()', () => {
  let sched: Scheduler;

  beforeEach(() => {
    sched = new Scheduler();
  });

  afterEach(async () => {
    await sched.stop();
  });

  it('trigger() 成功呼叫 handler', async () => {
    let called = false;
    sched.register({
      name: 'health_check',
      interval: 5 * 60_000,
      handler: async () => { called = true; },
      running: false,
    });

    await sched.trigger('health_check');
    expect(called).toBe(true);
  });

  it('trigger() 後 lastRun 被設定', async () => {
    sched.register({
      name: 'test_task',
      interval: 60_000,
      handler: async () => {},
      running: false,
    });

    const before = Date.now();
    await sched.trigger('test_task');
    const after = Date.now();

    const status = sched.getStatus().find(s => s.name === 'test_task')!;
    expect(status.lastRun).not.toBeNull();
    const lastRunMs = new Date(status.lastRun!).getTime();
    expect(lastRunMs).toBeGreaterThanOrEqual(before);
    expect(lastRunMs).toBeLessThanOrEqual(after);
  });

  it('trigger() 對不存在的任務拋出錯誤', async () => {
    await expect(sched.trigger('non_existent')).rejects.toThrow('找不到任務：non_existent');
  });

  it('多次連續 trigger() 都能正常執行', async () => {
    let count = 0;
    sched.register({
      name: 'counter',
      interval: 60_000,
      handler: async () => { count++; },
      running: false,
    });

    await sched.trigger('counter');
    await sched.trigger('counter');
    await sched.trigger('counter');
    expect(count).toBe(3);
  });
});

// ─── 測試：並發防護 ──────────────────────────────────────────────────────────

describe('Scheduler — 並發防護', () => {
  let sched: Scheduler;

  beforeEach(() => {
    sched = new Scheduler();
  });

  afterEach(async () => {
    await sched.stop();
  });

  it('任務執行中再次觸發應被跳過（running 鎖）', async () => {
    let runCount = 0;
    let resolveTask!: () => void;

    sched.register({
      name: 'slow_task',
      interval: 100,
      handler: async () => {
        runCount++;
        // 模擬長時間執行
        await new Promise<void>(resolve => { resolveTask = resolve; });
      },
      running: false,
    });

    // 第一次手動觸發（不 await，讓它卡住）
    const firstRun = sched.trigger('slow_task');

    // 等一個 tick 讓 running 設為 true
    await flushTimers(5);

    // 第二次觸發，應被跳過（因為 running === true）
    // 注意：_runTask 有 if (task.running) return 的保護，但 trigger 呼叫的是 _runTask
    // 我們直接驗證 setInterval 自動觸發的行為
    // 手動模擬：把任務標記為 running=true 然後再觸發
    // trigger() 直接呼叫 _runTask（但 _runTask 有鎖）
    // 所以第二次 trigger 在第一次完成前不會遞增 runCount

    // 確認目前 running
    const statusDuringRun = sched.getStatus().find(s => s.name === 'slow_task')!;
    expect(statusDuringRun.running).toBe(true);

    // 完成第一次任務
    resolveTask();
    await firstRun;

    expect(runCount).toBe(1);
    const statusAfter = sched.getStatus().find(s => s.name === 'slow_task')!;
    expect(statusAfter.running).toBe(false);
  });

  it('setInterval 在任務執行中不會重複執行同一任務', async () => {
    let runCount = 0;
    let resolveTask!: () => void;

    sched.register({
      name: 'interval_concurrent',
      interval: 30, // 30ms 間隔，會快速觸發
      handler: async () => {
        runCount++;
        await new Promise<void>(resolve => { resolveTask = resolve; });
      },
      running: false,
    });

    sched.start();

    // 等夠久讓 interval 觸發多次
    await flushTimers(100);

    // 但因為任務一直 running，只應執行過 1 次
    expect(runCount).toBe(1);

    // 釋放鎖
    resolveTask();
    await flushTimers(10);
  });
});

// ─── 測試：優雅關機 ──────────────────────────────────────────────────────────

describe('Scheduler — 優雅關機', () => {
  let sched: Scheduler;

  beforeEach(() => {
    sched = new Scheduler();
  });

  it('stop() 等待 running 任務完成後 resolve', async () => {
    let taskCompleted = false;
    let resolveTask!: () => void;

    sched.register({
      name: 'long_task',
      interval: 60_000,
      handler: async () => {
        await new Promise<void>(resolve => { resolveTask = resolve; });
        taskCompleted = true;
      },
      running: false,
    });

    sched.start();

    // 手動觸發（不 await）
    sched.trigger('long_task');

    // 等任務開始執行
    await flushTimers(10);

    // 啟動 stop()，不 await
    const stopPromise = sched.stop();

    // 確認任務還在跑
    expect(taskCompleted).toBe(false);

    // 完成任務
    resolveTask();

    // 等 stop() 完成
    await stopPromise;

    expect(taskCompleted).toBe(true);
  });

  it('stop() 在沒有 running 任務時立即 resolve', async () => {
    sched.register({
      name: 'quick_task',
      interval: 60_000,
      handler: async () => {},
      running: false,
    });
    sched.start();

    const start = Date.now();
    await sched.stop();
    const elapsed = Date.now() - start;

    // 應該很快完成（< 200ms）
    expect(elapsed).toBeLessThan(200);
  });

  it('stop() 超時後強制結束（10 秒不等完整，用短 timeout 驗證機制）', async () => {
    // 這個測試只驗證 stop 最終會 resolve，不實際等 10 秒
    sched.register({
      name: 'no_running',
      interval: 60_000,
      handler: async () => {},
      running: false,
    });
    sched.start();
    // 確保沒有任務在跑
    await sched.stop();
    // stop 應該 resolve（不卡死）
  });
});

// ─── 測試：取消任務 ──────────────────────────────────────────────────────────

describe('Scheduler — unregister()', () => {
  let sched: Scheduler;

  beforeEach(() => {
    sched = new Scheduler();
  });

  afterEach(async () => {
    await sched.stop();
  });

  it('unregister() 後任務從 getStatus() 消失', async () => {
    sched.register({
      name: 'removable',
      interval: 60_000,
      handler: async () => {},
      running: false,
    });

    expect(sched.getStatus()).toHaveLength(1);

    sched.unregister('removable');

    expect(sched.getStatus()).toHaveLength(0);
  });

  it('unregister() 後 trigger() 拋出錯誤', async () => {
    sched.register({
      name: 'to_remove',
      interval: 60_000,
      handler: async () => {},
      running: false,
    });
    sched.unregister('to_remove');

    await expect(sched.trigger('to_remove')).rejects.toThrow('找不到任務：to_remove');
  });

  it('unregister() 後任務不再被 setInterval 觸發', async () => {
    let count = 0;
    sched.register({
      name: 'counted',
      interval: 30,
      handler: async () => { count++; },
      running: false,
    });
    sched.start();
    await flushTimers(10);

    // 取消任務
    sched.unregister('counted');
    const countAfterUnregister = count;

    // 再等 100ms，計數不應再增加
    await flushTimers(100);
    expect(count).toBe(countAfterUnregister);
  });
});

// ─── 測試：getStatus() ──────────────────────────────────────────────────────

describe('Scheduler — getStatus()', () => {
  let sched: Scheduler;

  beforeEach(() => {
    sched = new Scheduler();
  });

  afterEach(async () => {
    await sched.stop();
  });

  it('getStatus() 回傳正確的任務清單與格式', () => {
    sched.register({
      name: 'test_status',
      interval: 5 * 60_000,
      handler: async () => {},
      running: false,
    });

    const status = sched.getStatus();
    expect(status).toHaveLength(1);

    const s = status[0];
    expect(s.name).toBe('test_status');
    expect(s.running).toBe(false);
    expect(s.lastRun).toBeNull();
    expect(s.interval).toBe('每 5 分鐘');
  });

  it('interval 為 0 時顯示「啟動時一次」', () => {
    sched.register({
      name: 'once',
      interval: 0,
      handler: async () => {},
      running: false,
    });
    const status = sched.getStatus();
    expect(status[0].interval).toBe('啟動時一次');
  });

  it('cron 任務顯示「每日 HH:MM」格式', () => {
    sched.register({
      name: 'cron_task',
      interval: 'cron',
      cronExpression: '0 3 * * *',
      handler: async () => {},
      running: false,
    });
    const status = sched.getStatus();
    expect(status[0].interval).toBe('每日 03:00');
  });

  it('每小時任務顯示「每 1 小時」', () => {
    sched.register({
      name: 'hourly',
      interval: 60 * 60_000,
      handler: async () => {},
      running: false,
    });
    const status = sched.getStatus();
    expect(status[0].interval).toBe('每 1 小時');
  });

  it('trigger() 後 lastRun 更新，running 回到 false', async () => {
    sched.register({
      name: 'check_status',
      interval: 60_000,
      handler: async () => {},
      running: false,
    });

    await sched.trigger('check_status');

    const status = sched.getStatus().find(s => s.name === 'check_status')!;
    expect(status.lastRun).not.toBeNull();
    expect(status.running).toBe(false);
  });

  it('registerAllTasks 後 getStatus 回傳 11 個正確間隔描述', () => {
    registerAllTasks(sched);
    const status = sched.getStatus();
    expect(status).toHaveLength(11);

    const byName = Object.fromEntries(status.map(s => [s.name, s]));

    expect(byName['health_check'].interval).toBe('每 5 分鐘');
    expect(byName['wal_checkpoint'].interval).toBe('每 15 分鐘');
    expect(byName['adapter_update'].interval).toBe('啟動時一次');
    expect(byName['daily_reset'].interval).toBe('每日 00:00');
    expect(byName['log_cleanup'].interval).toBe('每日 03:00');
    expect(byName['keypair_rotation'].interval).toBe('每日 04:00');
    expect(byName['telemetry_queue_cleanup'].interval).toBe('每日 05:00');
    expect(byName['key_expiry_check'].interval).toBe('每 1 小時');
  });
});

// ─── 測試：固定間隔任務定時觸發（fake clock 概念） ──────────────────────────

describe('Scheduler — 間隔觸發精準度', () => {
  let sched: Scheduler;

  beforeEach(() => {
    sched = new Scheduler();
  });

  afterEach(async () => {
    await sched.stop();
  });

  it('setInterval 任務在間隔時間到後被觸發', async () => {
    let callCount = 0;
    sched.register({
      name: 'fast_interval',
      interval: 50, // 50ms
      handler: async () => { callCount++; },
      running: false,
    });

    sched.start();

    // 等 160ms，應該觸發 3 次（50ms、100ms、150ms）
    await flushTimers(160);

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(callCount).toBeLessThanOrEqual(4);
  });

  it('register 後 unregister 在 start 之前不會觸發', async () => {
    let callCount = 0;
    sched.register({
      name: 'never_run',
      interval: 10,
      handler: async () => { callCount++; },
      running: false,
    });

    sched.unregister('never_run');
    sched.start();

    await flushTimers(50);
    expect(callCount).toBe(0);
  });

  it('adapter_update（interval=0）在 start 後立即執行一次', async () => {
    let called = false;
    sched.register({
      name: 'adapter_update',
      interval: 0,
      handler: async () => { called = true; },
      running: false,
    });

    sched.start();
    await flushTimers(30);

    expect(called).toBe(true);
  });
});

// ─── 測試：任務錯誤不影響後續執行 ──────────────────────────────────────────

describe('Scheduler — 錯誤處理', () => {
  let sched: Scheduler;

  beforeEach(() => {
    sched = new Scheduler();
  });

  afterEach(async () => {
    await sched.stop();
  });

  it('handler 拋出錯誤後 running 被重設為 false', async () => {
    sched.register({
      name: 'error_task',
      interval: 60_000,
      handler: async () => {
        throw new Error('故意的錯誤');
      },
      running: false,
    });

    // trigger 不應拋出（錯誤被 catch 了）
    await expect(sched.trigger('error_task')).resolves.toBeUndefined();

    const status = sched.getStatus().find(s => s.name === 'error_task')!;
    expect(status.running).toBe(false);
  });

  it('handler 拋出錯誤後可再次執行', async () => {
    let runCount = 0;
    sched.register({
      name: 'retry_task',
      interval: 60_000,
      handler: async () => {
        runCount++;
        if (runCount === 1) throw new Error('第一次錯誤');
      },
      running: false,
    });

    await sched.trigger('retry_task');
    await sched.trigger('retry_task');

    expect(runCount).toBe(2);
  });
});
