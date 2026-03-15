// SQLite in-memory 測試 DB 工具
import { Database } from 'bun:sqlite';

export function createTestDb(): Database {
  return new Database(':memory:');
}

export function closeTestDb(db: Database): void {
  db.close();
}
