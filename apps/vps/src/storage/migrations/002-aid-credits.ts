// Migration 002：互助積分系統
// 新增 aid_credits 表，追蹤龍蝦的互助積分

import type { Migration } from './001-init';

export const migration002: Migration = {
  version: 2,
  description: '新增互助積分表（aid_credits）— 感謝榜 + 優先配對',

  up: `
    -- 互助積分表：每次成功幫助 +1 積分，高積分龍蝦配對更優先
    CREATE TABLE IF NOT EXISTS aid_credits (
      device_id     TEXT PRIMARY KEY,
      credits       INTEGER NOT NULL DEFAULT 0,
      earned_total  INTEGER NOT NULL DEFAULT 0,
      spent_total   INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 按積分降序索引（感謝榜排名用）
    CREATE INDEX IF NOT EXISTS idx_aid_credits_credits
      ON aid_credits(credits DESC);
  `,

  down: `
    DROP INDEX IF EXISTS idx_aid_credits_credits;
    DROP TABLE IF EXISTS aid_credits;
  `,
};
