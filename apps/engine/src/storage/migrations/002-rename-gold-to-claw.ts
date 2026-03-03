// Migration 002：Gold Key → Claw Key 改名
// 只改表名，資料和欄位不動

import type { Migration } from './001-init';

export const migration002: Migration = {
  version: 2,
  description: 'Gold Key → Claw Key 表名重新命名',

  up: `
    ALTER TABLE gold_keys RENAME TO claw_keys;
  `,

  down: `
    ALTER TABLE claw_keys RENAME TO gold_keys;
  `,
};
