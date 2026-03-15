// VPS 端寫入佇列 + SQLITE_BUSY 重試策略
// 所有 DB 寫入透過 WriteQueue 串行化，避免 SQLITE_BUSY 錯誤
// 搭配 BatchWriter 優化高頻小寫入

import type { TelemetryEntry } from '@clawapi/protocol';

// SQLITE_BUSY 重試設定
const BUSY_RETRY = {
  maxRetries: 3,
  delays: [50, 100, 200],  // 毫秒，逐次遞增
} as const;

// 遙測記錄型別（用於 BatchWriter buffer）
export interface TelemetryRecord {
  batchId: string;
  deviceId: string;
  region: string;
  entry: TelemetryEntry;
  reputationWeight: number;
  receivedAt: string;
}

// 等待指定毫秒
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 包裝寫入操作，遇到 SQLITE_BUSY 自動重試
export async function withBusyRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let i = 0; i <= BUSY_RETRY.maxRetries; i++) {
    try {
      return await operation();
    } catch (err: unknown) {
      const anyErr = err as { code?: string };
      // 判斷是否為 SQLITE_BUSY 錯誤
      if (anyErr?.code === 'SQLITE_BUSY' && i < BUSY_RETRY.maxRetries) {
        await sleep(BUSY_RETRY.delays[i]);
        continue;
      }
      throw err;
    }
  }
  // 此行理論上不會到達，TypeScript 需要明確 throw
  throw new Error('SQLITE_BUSY: 重試次數已用盡');
}

// VPS 端所有 DB 寫入串行化佇列
export class WriteQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  // 將寫入操作加入佇列，回傳 Promise（等待完成）
  async enqueue(operation: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await operation();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      // 若目前沒有在處理，立刻開始
      void this.processNext();
    });
  }

  // 依序處理佇列中的操作
  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const op = this.queue.shift()!;
    try {
      await op();
    } finally {
      this.processing = false;
      void this.processNext();
    }
  }

  // 取得目前佇列長度（測試用）
  get pendingCount(): number {
    return this.queue.length;
  }

  // 取得目前是否正在處理（測試用）
  get isProcessing(): boolean {
    return this.processing;
  }
}

// 遙測批次寫入器（高頻小寫入優化）
export class BatchWriter {
  telemetryBuffer: TelemetryRecord[] = [];
  readonly maxBufferSize: number = 200;
  readonly flushInterval: number = 10_000; // 每 10 秒 flush

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly writeQueue: WriteQueue;
  private readonly flushFn: (records: TelemetryRecord[]) => Promise<void>;

  constructor(
    writeQueue: WriteQueue,
    flushFn: (records: TelemetryRecord[]) => Promise<void>,
  ) {
    this.writeQueue = writeQueue;
    this.flushFn = flushFn;
  }

  // 啟動定時 flush
  start(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  // 停止定時 flush
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // 新增遙測記錄到 buffer
  async add(record: TelemetryRecord): Promise<void> {
    this.telemetryBuffer.push(record);
    // buffer 滿了立刻 flush
    if (this.telemetryBuffer.length >= this.maxBufferSize) {
      await this.flush();
    }
  }

  // 將 buffer 內的所有記錄批次寫入 DB（一個 transaction）
  async flush(): Promise<void> {
    if (this.telemetryBuffer.length === 0) return;

    // 取出目前 buffer 並清空（避免 flush 期間新增的記錄遺失）
    const toFlush = this.telemetryBuffer.splice(0, this.telemetryBuffer.length);

    await this.writeQueue.enqueue(async () => {
      await withBusyRetry(async () => {
        await this.flushFn(toFlush);
      });
    });
  }
}
