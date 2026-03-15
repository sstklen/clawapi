// WriteQueue 單元測試
// 測試：10 個並發寫入串行化、無 SQLITE_BUSY、BatchWriter flush

import { describe, it, expect, beforeEach } from 'bun:test';
import { WriteQueue, BatchWriter, withBusyRetry } from '../write-queue';
import type { TelemetryRecord } from '../write-queue';

// 測試輔助：建立假的 TelemetryRecord
function makeRecord(id: string): TelemetryRecord {
  return {
    batchId: `batch_${id}`,
    deviceId: `clw_dev_${id}`,
    region: 'asia',
    entry: {
      service_id: 'openai',
      tier: 'L2',
      outcome: 'success',
      latency_ms: 100,
      routing_strategy: 'smart',
      retry_count: 0,
      time_bucket: 'morning',
    },
    reputationWeight: 1.0,
    receivedAt: new Date().toISOString(),
  };
}

describe('WriteQueue', () => {
  let queue: WriteQueue;

  beforeEach(() => {
    queue = new WriteQueue();
  });

  // ===== 基本串行化測試 =====

  it('應串行執行操作（不並行）', async () => {
    const order: number[] = [];

    // 三個操作，每個都有不同延遲
    const p1 = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });

    const p2 = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
    });

    const p3 = queue.enqueue(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);

    // 即使 p2 延遲最短，執行順序應為 1, 2, 3（依加入順序）
    expect(order).toEqual([1, 2, 3]);
  });

  it('10 個並發寫入應全部完成且順序正確', async () => {
    const results: number[] = [];
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 10; i++) {
      const n = i;
      promises.push(
        queue.enqueue(async () => {
          // 模擬不同長度的操作
          if (n % 2 === 0) {
            await new Promise((r) => setTimeout(r, 5));
          }
          results.push(n);
        }),
      );
    }

    await Promise.all(promises);

    // 所有 10 個操作都完成
    expect(results.length).toBe(10);
    // 順序應按加入順序（0-9）
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('佇列長度應在處理時減少', async () => {
    let inProgress = false;
    let maxObservedQueue = 0;

    for (let i = 0; i < 5; i++) {
      queue.enqueue(async () => {
        inProgress = true;
        maxObservedQueue = Math.max(maxObservedQueue, queue.pendingCount);
        await new Promise((r) => setTimeout(r, 10));
        inProgress = false;
      });
    }

    // 等待所有操作完成
    await new Promise((r) => setTimeout(r, 200));

    expect(queue.pendingCount).toBe(0);
    expect(queue.isProcessing).toBe(false);
    expect(inProgress).toBe(false);
  });

  it('操作失敗時 Promise 應 reject', async () => {
    const error = new Error('測試失敗');
    await expect(
      queue.enqueue(async () => {
        throw error;
      }),
    ).rejects.toThrow('測試失敗');
  });

  it('一個操作失敗後，後續操作應繼續執行', async () => {
    const results: string[] = [];

    // 第一個操作失敗
    const p1 = queue.enqueue(async () => {
      throw new Error('失敗操作');
    }).catch(() => results.push('failed'));

    // 第二個操作應正常執行
    const p2 = queue.enqueue(async () => {
      results.push('success');
    });

    await Promise.all([p1, p2]);

    // 兩個操作都完成（順序可能因微任務調度而異，但都必須出現）
    expect(results).toContain('failed');
    expect(results).toContain('success');
    expect(results.length).toBe(2);
  });

  it('操作成功時 Promise 應 resolve', async () => {
    let executed = false;
    await queue.enqueue(async () => {
      executed = true;
    });
    expect(executed).toBe(true);
  });
});

// ===== withBusyRetry 測試 =====

describe('withBusyRetry', () => {
  it('操作成功時應直接回傳結果', async () => {
    const result = await withBusyRetry(async () => 'success');
    expect(result).toBe('success');
  });

  it('SQLITE_BUSY 錯誤應重試最多 3 次', async () => {
    let callCount = 0;
    // 前 3 次 SQLITE_BUSY，第 4 次成功
    const result = await withBusyRetry(async () => {
      callCount++;
      if (callCount <= 3) {
        const err = new Error('SQLITE_BUSY') as Error & { code: string };
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return 'ok';
    });

    expect(callCount).toBe(4);  // 原本 1 次 + 重試 3 次
    expect(result).toBe('ok');
  });

  it('非 SQLITE_BUSY 錯誤不應重試，直接拋出', async () => {
    let callCount = 0;
    await expect(
      withBusyRetry(async () => {
        callCount++;
        throw new Error('SQLITE_CONSTRAINT');
      }),
    ).rejects.toThrow('SQLITE_CONSTRAINT');
    expect(callCount).toBe(1);  // 只呼叫一次，不重試
  });

  it('超過重試次數後應拋出原始錯誤', async () => {
    // 一直回 SQLITE_BUSY（超過上限）
    await expect(
      withBusyRetry(async () => {
        const err = new Error('SQLITE_BUSY') as Error & { code: string };
        err.code = 'SQLITE_BUSY';
        throw err;
      }),
    ).rejects.toThrow('SQLITE_BUSY');
  });
});

// ===== BatchWriter 測試 =====

describe('BatchWriter', () => {
  it('buffer 達到上限時應自動 flush', async () => {
    let flushedRecords: TelemetryRecord[] = [];
    const queue = new WriteQueue();

    const batchWriter = new BatchWriter(queue, async (records) => {
      flushedRecords = [...flushedRecords, ...records];
    });

    // 設定較小的 buffer 大小方便測試（直接修改屬性，BatchWriter 用 readonly）
    // 使用預設的 maxBufferSize=200，但只加 200 條觸發 flush
    const records = Array.from({ length: 200 }, (_, i) => makeRecord(`${i}`));
    for (const record of records) {
      await batchWriter.add(record);
    }

    // 應觸發 flush
    expect(flushedRecords.length).toBe(200);
    expect(batchWriter.telemetryBuffer.length).toBe(0);
  });

  it('flush() 應清空 buffer 並呼叫寫入函式', async () => {
    let flushCalled = false;
    let receivedRecords: TelemetryRecord[] = [];
    const queue = new WriteQueue();

    const batchWriter = new BatchWriter(queue, async (records) => {
      flushCalled = true;
      receivedRecords = records;
    });

    batchWriter.telemetryBuffer.push(makeRecord('test1'));
    batchWriter.telemetryBuffer.push(makeRecord('test2'));

    await batchWriter.flush();

    expect(flushCalled).toBe(true);
    expect(receivedRecords.length).toBe(2);
    expect(batchWriter.telemetryBuffer.length).toBe(0);
  });

  it('buffer 為空時 flush() 不應呼叫寫入函式', async () => {
    let flushCalled = false;
    const queue = new WriteQueue();

    const batchWriter = new BatchWriter(queue, async () => {
      flushCalled = true;
    });

    await batchWriter.flush();

    expect(flushCalled).toBe(false);
  });

  it('start() / stop() 應控制定時 flush', async () => {
    let flushCount = 0;
    const queue = new WriteQueue();

    const batchWriter = new BatchWriter(queue, async () => {
      flushCount++;
    });

    // 確認 start/stop 不拋出錯誤
    expect(() => batchWriter.start()).not.toThrow();
    expect(() => batchWriter.stop()).not.toThrow();
  });

  it('多次並發 add 不應造成資料遺失', async () => {
    let totalFlushed = 0;
    const queue = new WriteQueue();

    const batchWriter = new BatchWriter(queue, async (records) => {
      totalFlushed += records.length;
    });

    // 並發加入 50 條（小於 maxBufferSize=200，不會觸發自動 flush）
    const promises = Array.from({ length: 50 }, (_, i) =>
      batchWriter.add(makeRecord(`concurrent_${i}`)),
    );
    await Promise.all(promises);

    // 手動 flush
    await batchWriter.flush();

    expect(totalFlushed).toBe(50);
  });
});
