/**
 * Debug 醫生 — 龍蝦帳戶管理
 * 使用紀錄、貢獻額度、記錄解決問題
 *
 * 所有函數操作 lobster_accounts + lobster_transactions 兩張表
 */

import { getDb } from '../database';
import type { LobsterAccount } from './types';

// ============================================
// 帳戶 CRUD
// ============================================

/** 取得或建立龍蝦帳戶（INSERT OR IGNORE 防併發重複） */
export function getOrCreateAccount(lobsterId: string): LobsterAccount {
  const db = getDb();
  db.run('INSERT OR IGNORE INTO lobster_accounts (lobster_id) VALUES (?)', [lobsterId]);
  return db.prepare('SELECT * FROM lobster_accounts WHERE lobster_id = ?').get(lobsterId) as LobsterAccount;
}

/**
 * 增加額度（onboard 獎勵、管理員手動調整）
 * CLAUDE.md 鐵律：讀+寫全部在 db.transaction() 內（TOCTOU 防護）
 */
export function creditAccount(lobsterId: string, amount: number, type: string, description: string, refId?: string): number {
  if (amount <= 0) throw new Error(`creditAccount: invalid amount ${amount}`);
  const db = getDb();
  getOrCreateAccount(lobsterId); // 確保帳戶存在

  return db.transaction(() => {
    const account = db.prepare('SELECT balance FROM lobster_accounts WHERE lobster_id = ?').get(lobsterId) as { balance: number };
    const newBalance = account.balance + amount;
    db.run('UPDATE lobster_accounts SET balance = ?, updated_at = ? WHERE lobster_id = ?',
      [newBalance, new Date().toISOString(), lobsterId]);
    db.run(
      'INSERT INTO lobster_transactions (lobster_id, type, amount, balance_after, description, ref_id) VALUES (?, ?, ?, ?, ?, ?)',
      [lobsterId, type, amount, newBalance, description, refId || null],
    );
    return newBalance;
  })();
}

/**
 * 記錄使用 — 回傳 { success, balance }（目前所有價格為 0）
 * CLAUDE.md 鐵律：讀+檢查+寫全部在 db.transaction() 內（TOCTOU 防護）
 */
export function debitAccount(lobsterId: string, amount: number, type: string, description: string, refId?: string): { success: boolean; balance: number } {
  if (amount < 0) throw new Error(`debitAccount: negative amount ${amount}`);
  if (amount === 0) {
    // 免費操作 — 直接回傳成功，不建立交易紀錄
    const account = getOrCreateAccount(lobsterId);
    return { success: true, balance: account.balance };
  }
  const db = getDb();
  getOrCreateAccount(lobsterId); // 確保帳戶存在

  return db.transaction(() => {
    const account = db.prepare('SELECT balance FROM lobster_accounts WHERE lobster_id = ?').get(lobsterId) as { balance: number };
    if (account.balance < amount) {
      return { success: false, balance: account.balance };
    }
    const newBalance = account.balance - amount;
    db.run('UPDATE lobster_accounts SET balance = ?, total_spent = total_spent + ?, updated_at = ? WHERE lobster_id = ?',
      [newBalance, amount, new Date().toISOString(), lobsterId]);
    db.run(
      'INSERT INTO lobster_transactions (lobster_id, type, amount, balance_after, description, ref_id) VALUES (?, ?, ?, ?, ?, ?)',
      [lobsterId, type, -amount, newBalance, description, refId || null],
    );
    return { success: true, balance: newBalance };
  })();
}

/** 記錄解決問題 + 節省的金額 */
export function recordProblemSolved(lobsterId: string, saved: number): void {
  const db = getDb();
  db.run('UPDATE lobster_accounts SET problems_solved = problems_solved + 1, total_saved = total_saved + ?, updated_at = ? WHERE lobster_id = ?',
    [saved, new Date().toISOString(), lobsterId]);
}
