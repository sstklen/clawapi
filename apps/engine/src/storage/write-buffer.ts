// WriteBuffer：非關鍵寫入緩衝區
// 非關鍵寫入先進 buffer，定期批次 flush；關鍵寫入直接寫入不走 buffer。

import type { ClawDatabase } from './database';

// ===== 型別定義 =====

export interface WriteOperation {
  /** SQL 語句 */
  sql: string;
  /** 綁定參數 */
  params: unknown[];
  /** 寫入類型：critical 直接寫，buffered 走 buffer */
  priority: 'critical' | 'buffered';
}

// ===== SQLITE_BUSY 重試策略 =====
// 指數退避：50ms → 100ms → 200ms，最多 3 次

const BUSY_RETRY = {
  maxRetries: 3,
  baseDelay: 50,   // ms
  maxDelay: 500,   // ms
} as const;

/** 等待指定毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== WriteBuffer 類別 =====

export class WriteBuffer {
  /** 待寫入的操作佇列 */
  queue: WriteOperation[] = [];

  /** buffer 滿了強制 flush */
  readonly maxSize = 100;

  /** 每 5 秒 flush 一次（毫秒） */
  readonly flushInterval = 5000;

  private db: ClawDatabase;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(db: ClawDatabase) {
    this.db = db;
  }

  /**
   * 啟動定時 flush
   * 建立 WriteBuffer 後呼叫此方法
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(err => {
        console.error('[WriteBuffer] 定時 flush 失敗:', err);
      });
    }, this.flushInterval);
  }

  /**
   * 加入寫入操作
   * - critical：直接寫入，帶指數退避重試
   * - buffered：進 buffer；若已滿則立即 flush
   */
  enqueue(op: WriteOperation): void {
    if (op.priority === 'critical') {
      // 關鍵操作直接寫入（帶重試）
      this.writeWithRetry(op.sql, op.params).catch(err => {
        console.error('[WriteBuffer] 關鍵寫入失敗:', err, 'SQL:', op.sql);
        throw err;
      });
      return;
    }

    // 非關鍵操作進 buffer
    this.queue.push(op);

    // buffer 已滿，立即 flush
    if (this.queue.length >= this.maxSize) {
      this.flush().catch(err => {
        console.error('[WriteBuffer] 滿載 flush 失敗:', err);
      });
    }
  }

  /**
   * 批次 flush：把整個 queue 包在單一 transaction 內寫入
   */
  async flush(): Promise<void> {
    // 防止重入
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;

    // 取走當前 queue，讓新的操作繼續進新 queue
    const batch = this.queue.splice(0, this.queue.length);

    try {
      await this.writeWithRetry('BEGIN', []);
      for (const op of batch) {
        this.db.run(op.sql, op.params);
      }
      await this.writeWithRetry('COMMIT', []);
    } catch (err) {
      // 嘗試回滾
      try {
        this.db.run('ROLLBACK');
      } catch {
        // 回滾失敗不拋出
      }
      // 把未完成的操作放回 queue 前端
      this.queue.unshift(...batch);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 停止 WriteBuffer
   * 清除定時器並執行最後一次 flush
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 最後 flush，確保所有待寫入操作都完成
    await this.flush();
  }

  // ===== 私有輔助方法 =====

  /**
   * 帶指數退避的寫入重試
   * 遇到 SQLITE_BUSY 或 locked 時等待後重試
   */
  private async writeWithRetry(sql: string, params: unknown[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= BUSY_RETRY.maxRetries; attempt++) {
      try {
        this.db.run(sql, params);
        return;
      } catch (err: unknown) {
        const isBusy =
          err instanceof Error &&
          (err.message.includes('SQLITE_BUSY') ||
            err.message.includes('database is locked'));

        if (!isBusy || attempt === BUSY_RETRY.maxRetries) {
          throw err;
        }

        // 指數退避：50ms → 100ms → 200ms
        const delay = Math.min(
          BUSY_RETRY.baseDelay * Math.pow(2, attempt),
          BUSY_RETRY.maxDelay
        );
        lastError = err;
        await sleep(delay);
      }
    }
    throw lastError;
  }
}

// ===== 工廠函式 =====

/**
 * 建立並啟動 WriteBuffer
 */
export function createWriteBuffer(db: ClawDatabase): WriteBuffer {
  const buf = new WriteBuffer(db);
  buf.start();
  return buf;
}

export default WriteBuffer;
