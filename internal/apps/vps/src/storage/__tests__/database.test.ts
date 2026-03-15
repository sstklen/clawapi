// VPSDatabase 單元測試
// 測試：所有表 + index 建立成功、CRUD 操作、裝置快捷方法

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { VPSDatabase } from '../database';

// 使用記憶體資料庫（測試後不留殘檔）
const TEST_DB_PATH = ':memory:';

// 21 張資料表名稱（依 migration001 定義）
const EXPECTED_TABLES = [
  'devices',
  'telemetry_batches',
  'telemetry_entries',
  'routing_recommendations',
  'service_alerts',
  'telemetry_feedback',
  'feedback_aggregation',
  'l0_keys',
  'l0_device_usage',
  'aid_configs',
  'aid_records',
  'aid_stats',
  'aid_suspicious',
  'aid_credits',
  'backups',
  'subkey_validation_cache',
  'schema_version',
  'vps_key_history',
  'access_log',
  'anomaly_detections',
  'alert_history',
  'telemetry_aggregated',
] as const;

describe('VPSDatabase', () => {
  let db: VPSDatabase;

  beforeEach(async () => {
    db = new VPSDatabase(TEST_DB_PATH);
    await db.init();
  });

  afterEach(async () => {
    await db.close();
  });

  // ===== 初始化測試 =====

  describe('init()', () => {
    it('應建立所有 21 張資料表', () => {
      // 排除 SQLite 內部表（如 sqlite_sequence 會因 AUTOINCREMENT 自動建立）
      const tables = db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      );
      const tableNames = tables.map((t) => t.name).sort();

      for (const expected of EXPECTED_TABLES) {
        expect(tableNames).toContain(expected);
      }
      // 確認總數正確（22 張使用者資料表，含 aid_credits）
      expect(tables.length).toBe(EXPECTED_TABLES.length);
    });

    it('應建立所有 index', () => {
      const indexes = db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`,
      );
      // 必須有這些關鍵 index
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_devices_token');
      expect(indexNames).toContain('idx_devices_status');
      expect(indexNames).toContain('idx_devices_region');
      expect(indexNames).toContain('idx_entries_service');
      expect(indexNames).toContain('idx_feedback_service');
      expect(indexNames).toContain('idx_aid_enabled');
      expect(indexNames).toContain('idx_access_created');
      expect(indexNames).toContain('idx_aggregated_provider');
    });

    it('schema_version 應記錄版本 1', () => {
      const versions = db.query<{ version: number; description: string }>(
        'SELECT * FROM schema_version',
      );
      expect(versions.length).toBeGreaterThanOrEqual(1);
      expect(versions[0]?.version).toBe(1);
    });

    it('重複呼叫 init() 不應報錯（冪等性）', async () => {
      // 第二次 init 不應丟出錯誤
      await expect(db.init()).resolves.toBeUndefined();
    });
  });

  // ===== 基本 CRUD 測試 =====

  describe('run() / query()', () => {
    it('應能插入並查詢裝置資料', () => {
      db.run(
        `INSERT INTO devices
          (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['clw_test01', 'fp_abc', 'tok_xyz', '2099-01-01T00:00:00Z', '0.1.0', 'darwin', 'arm64'],
      );

      const devices = db.query<{ device_id: string; status: string }>(
        'SELECT device_id, status FROM devices WHERE device_id = ?',
        ['clw_test01'],
      );
      expect(devices.length).toBe(1);
      expect(devices[0]?.device_id).toBe('clw_test01');
      expect(devices[0]?.status).toBe('active');
    });

    it('run() 應回傳 changes 和 lastInsertRowid', () => {
      const result = db.run(
        `INSERT INTO alert_history (severity, channel, message)
         VALUES (?, ?, ?)`,
        ['info', 'telegram', '測試告警'],
      );
      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBeGreaterThan(0);
    });

    it('query() 無結果時應回傳空陣列', () => {
      const results = db.query<{ device_id: string }>(
        'SELECT * FROM devices WHERE device_id = ?',
        ['不存在的ID'],
      );
      expect(results).toEqual([]);
    });
  });

  // ===== Transaction 測試 =====

  describe('transaction()', () => {
    it('transaction 中所有操作應原子性提交', () => {
      db.transaction(() => {
        db.run(
          `INSERT INTO devices
            (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ['clw_tx01', 'fp_tx', 'tok_tx1', '2099-01-01T00:00:00Z', '0.1.0', 'linux', 'x64'],
        );
        db.run(
          `INSERT INTO devices
            (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ['clw_tx02', 'fp_tx', 'tok_tx2', '2099-01-01T00:00:00Z', '0.1.0', 'linux', 'x64'],
        );
      });

      const count = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM devices WHERE device_id IN ('clw_tx01', 'clw_tx02')`,
      );
      expect(count[0]?.count).toBe(2);
    });

    it('transaction 拋出錯誤時應回滾', () => {
      expect(() => {
        db.transaction(() => {
          db.run(
            `INSERT INTO devices
              (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['clw_rollback', 'fp_rb', 'tok_rb', '2099-01-01T00:00:00Z', '0.1.0', 'darwin', 'arm64'],
          );
          // 故意插入重複主鍵，觸發錯誤
          db.run(
            `INSERT INTO devices
              (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['clw_rollback', 'fp_rb', 'tok_rb2', '2099-01-01T00:00:00Z', '0.1.0', 'darwin', 'arm64'],
          );
        });
      }).toThrow();

      // 回滾後，第一筆也不存在
      const results = db.query<{ device_id: string }>(
        'SELECT * FROM devices WHERE device_id = ?',
        ['clw_rollback'],
      );
      expect(results.length).toBe(0);
    });
  });

  // ===== 裝置快捷方法測試 =====

  describe('getDevice() / getDeviceByToken()', () => {
    beforeEach(() => {
      db.run(
        `INSERT INTO devices
          (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['clw_find01', 'fp_find', 'tok_find_abc', '2099-12-31T00:00:00Z', '0.1.0', 'darwin', 'arm64'],
      );
    });

    it('getDevice() 應依 device_id 找到裝置', () => {
      const device = db.getDevice('clw_find01');
      expect(device).not.toBeNull();
      expect(device?.device_id).toBe('clw_find01');
      expect(device?.status).toBe('active');
    });

    it('getDevice() 找不到時應回傳 null', () => {
      const device = db.getDevice('不存在');
      expect(device).toBeNull();
    });

    it('getDeviceByToken() 應依 token 找到裝置', () => {
      const device = db.getDeviceByToken('tok_find_abc');
      expect(device).not.toBeNull();
      expect(device?.device_id).toBe('clw_find01');
    });

    it('getDeviceByToken() token 不存在時應回傳 null', () => {
      const device = db.getDeviceByToken('不存在的token');
      expect(device).toBeNull();
    });
  });

  // ===== checkpoint 測試 =====

  describe('checkpoint()', () => {
    it('checkpoint() 應正常執行不拋出錯誤', () => {
      expect(() => db.checkpoint()).not.toThrow();
    });
  });

  // ===== updateDeviceLastSeen 測試 =====

  describe('updateDeviceLastSeen()', () => {
    it('應更新 last_seen_at', async () => {
      db.run(
        `INSERT INTO devices
          (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['clw_seen01', 'fp_seen', 'tok_seen', '2099-12-31T00:00:00Z', '0.1.0', 'linux', 'x64'],
      );

      // 初始 last_seen_at 應為 null
      const before = db.getDevice('clw_seen01');
      expect(before?.last_seen_at).toBeNull();

      db.updateDeviceLastSeen('clw_seen01');

      // 更新後 last_seen_at 應有值
      const after = db.getDevice('clw_seen01');
      expect(after?.last_seen_at).not.toBeNull();
    });
  });
});
