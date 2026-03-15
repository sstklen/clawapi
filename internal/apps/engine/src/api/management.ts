// 管理 API 路由
// 提供 Dashboard 和 CLI 使用的 CRUD 端點
//
// 端點清單：
//   GET    /api/status              引擎狀態
//   GET    /api/keys                列出 Key（遮罩版）
//   POST   /api/keys                新增 Key
//   DELETE /api/keys/:id            刪除 Key
//   PUT    /api/keys/:id/pin        釘選/取消釘選
//   PUT    /api/keys/:id/rotate     輪換 Key
//   GET    /api/claw-keys           列出 Claw Key
//   POST   /api/claw-keys           設定 Claw Key
//   DELETE /api/claw-keys/:id       移除 Claw Key
//   GET    /api/sub-keys            列出 Sub-Key
//   POST   /api/sub-keys            發行 Sub-Key
//   DELETE /api/sub-keys/:id        撤銷 Sub-Key
//   GET    /api/sub-keys/:id/usage  Sub-Key 用量
//   GET    /api/aid/config          互助設定
//   PUT    /api/aid/config          更新互助設定
//   GET    /api/aid/stats           互助統計
//   GET    /api/adapters            列出 Adapter
//   POST   /api/adapters/install    安裝社群 Adapter
//   DELETE /api/adapters/:id        移除 Adapter
//   GET    /api/logs                查詢使用紀錄（支援搜尋+篩選）
//   GET    /api/logs/export         匯出 CSV
//   GET    /api/l0/status           L0 狀態
//   POST   /api/backup/export       匯出加密備份（stub → 501）
//   POST   /api/backup/import       匯入備份（stub → 501）
//   GET    /api/settings            取得設定
//   PUT    /api/settings            更新設定
//   GET    /api/telemetry/pending   查看待上報內容
//   PUT    /api/telemetry/enabled   開關統計上報

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { KeyPool } from '../core/key-pool';
import type { SubKeyManager, IssueSubKeyParams } from '../sharing/sub-key';
import type { AidClient, AidClientConfig } from '../sharing/mutual-aid';
import type { AdapterLoader, AdapterConfig } from '../adapters/loader';

/** 安全 JSON 解析（壞資料不會炸 500） */
function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
import type { TelemetryCollector } from '../intelligence/telemetry';
import type { L0Manager } from '../l0/manager';
import type { ClawDatabase } from '../storage/database';
import type { ClawConfig } from '../core/config';
import { getCrypto } from '../core/encryption';
import { getEngineVersion } from '../version';

// ===== 型別定義 =====

/** 管理 API 的依賴注入包 */
export interface ManagementDeps {
  keyPool: KeyPool;
  subKeyManager: SubKeyManager;
  aidClient: AidClient;
  adapterLoader: AdapterLoader;
  telemetry: TelemetryCollector;
  l0Manager: L0Manager;
  db: ClawDatabase;
  adapters: Map<string, AdapterConfig>;
  /** 取得目前設定 */
  getConfig: () => ClawConfig;
  /** 更新設定（partial） */
  updateConfig: (partial: Partial<ClawConfig>) => Promise<void>;
  /** 引擎啟動時間 */
  startedAt: Date;
}

/** Claw Key DB 資料列 */
interface ClawKeyRow {
  id: number;
  service_id: string;
  model_id: string;
  is_active: number;
  daily_used: number;
  daily_limit: number | null;
  created_at: string;
}

/** 使用記錄 DB 資料列 */
interface UsageLogRow {
  id: number;
  timestamp: string;
  service_id: string;
  model: string | null;
  layer: string;
  key_id: number | null;
  sub_key_id: number | null;
  success: number;
  latency_ms: number;
  error_code: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  routing_strategy: string | null;
  retry_count: number;
}

// ===== 主路由工廠 =====

/**
 * 建立管理 API 路由器
 *
 * @param deps 依賴注入包
 * @returns Hono 路由實例（掛載到 /api 下）
 */
export function createManagementRouter(deps: ManagementDeps): Hono {
  const app = new Hono();

  const {
    keyPool,
    subKeyManager,
    aidClient,
    adapterLoader,
    telemetry,
    l0Manager,
    db,
    adapters,
    getConfig,
    updateConfig,
    startedAt,
  } = deps;

  // =========================================================
  // GET /api/status — 引擎狀態
  // =========================================================
  app.get('/status', (c: Context) => {
    const uptime = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    const config = getConfig();

    return c.json({
      status: 'ok',
      version: getEngineVersion(),
      uptime_seconds: uptime,
      started_at: startedAt.toISOString(),
      port: config.server.port,
      host: config.server.host,
      l0_enabled: config.l0.enabled,
      aid_enabled: config.aid.enabled,
      telemetry_enabled: config.telemetry.enabled,
      timestamp: new Date().toISOString(),
    });
  });

  // =========================================================
  // Key 管理
  // =========================================================

  /** GET /api/keys — 列出 Key（遮罩版） */
  app.get('/keys', async (c: Context) => {
    const serviceId = c.req.query('service_id');
    const keys = await keyPool.listKeys(serviceId ?? undefined);
    return c.json({ keys });
  });

  /** POST /api/keys — 新增 Key */
  app.post('/keys', async (c: Context) => {
    let body: {
      service_id: string;
      key_value: string;
      pool_type?: 'king' | 'friend';
      label?: string;
    };

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (!body.service_id || typeof body.service_id !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：service_id' }, 400);
    }
    if (!body.key_value || typeof body.key_value !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：key_value' }, 400);
    }

    const poolType = body.pool_type ?? 'king';
    if (poolType !== 'king' && poolType !== 'friend') {
      return c.json({ error: 'invalid_request', message: 'pool_type 必須是 king 或 friend' }, 400);
    }

    try {
      const config = getConfig();
      const id = await keyPool.addKey(
        body.service_id,
        body.key_value,
        poolType,
        body.label,
        config.advanced.max_keys_per_service
      );
      return c.json({ success: true, id }, 201);
    } catch (err) {
      return c.json({ error: 'failed', message: (err as Error).message }, 400);
    }
  });

  /** DELETE /api/keys/:id — 刪除 Key */
  app.delete('/keys/:id', async (c: Context) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ error: 'invalid_request', message: 'id 必須是數字' }, 400);
    }

    await keyPool.removeKey(id);
    return c.json({ success: true, id });
  });

  /** PUT /api/keys/:id/pin — 釘選/取消釘選 Key */
  app.put('/keys/:id/pin', async (c: Context) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ error: 'invalid_request', message: 'id 必須是數字' }, 400);
    }

    let body: { pinned: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (typeof body.pinned !== 'boolean') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：pinned（布林值）' }, 400);
    }

    // 更新 pinned 狀態
    try {
      db.run(
        'UPDATE keys SET pinned = ?, updated_at = ? WHERE id = ?',
        [body.pinned ? 1 : 0, new Date().toISOString(), id]
      );
    } catch (err) {
      console.error(`[Management] 更新 pinned 失敗（key id=${id}）:`, err);
      return c.json({ error: 'db_error', message: '資料庫更新失敗' }, 500);
    }

    return c.json({ success: true, id, pinned: body.pinned });
  });

  /** PUT /api/keys/:id/rotate — 輪換 Key */
  app.put('/keys/:id/rotate', async (c: Context) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ error: 'invalid_request', message: 'id 必須是數字' }, 400);
    }

    let body: { new_key_value: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (!body.new_key_value || typeof body.new_key_value !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：new_key_value' }, 400);
    }

    // 查詢現有 Key 資訊
    const rows = db.query<{
      service_id: string;
      pool_type: 'king' | 'friend';
      label: string | null;
    }>(
      'SELECT service_id, pool_type, label FROM keys WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return c.json({ error: 'not_found', message: `找不到 Key：${id}` }, 404);
    }

    const existing = rows[0]!;

    // 刪除舊 Key，新增新 Key
    await keyPool.removeKey(id);
    const newId = await keyPool.addKey(
      existing.service_id,
      body.new_key_value,
      existing.pool_type,
      existing.label ?? undefined
    );

    return c.json({ success: true, old_id: id, new_id: newId });
  });

  // =========================================================
  // Claw Key 管理
  // =========================================================

  /** GET /api/claw-keys — 列出 Claw Key */
  app.get('/claw-keys', (c: Context) => {
    const rows = db.query<ClawKeyRow>(
      'SELECT id, service_id, model_id, is_active, daily_used, daily_limit, created_at FROM claw_keys ORDER BY created_at DESC'
    );

    const clawKeys = rows.map(row => ({
      id: row.id,
      service_id: row.service_id,
      model_id: row.model_id,
      is_active: row.is_active === 1,
      daily_used: row.daily_used,
      daily_limit: row.daily_limit,
      created_at: row.created_at,
    }));

    return c.json({ claw_keys: clawKeys });
  });

  /** POST /api/claw-keys — 設定 Claw Key */
  app.post('/claw-keys', async (c: Context) => {
    let body: {
      service_id: string;
      key_value: string;
      model_id: string;
      daily_limit?: number;
    };

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (!body.service_id || typeof body.service_id !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：service_id' }, 400);
    }
    if (!body.key_value || typeof body.key_value !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：key_value' }, 400);
    }
    if (!body.model_id || typeof body.model_id !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：model_id' }, 400);
    }

    // Claw Key 加密後存入 DB（與 KeyPool 同等安全等級）
    // 安全規則：加密失敗時禁止明文 fallback，直接拒絕
    let encryptedKey: Uint8Array;
    try {
      encryptedKey = getCrypto().encrypt(body.key_value);
    } catch (err) {
      return c.json({
        error: 'crypto_not_ready',
        message: '加密模組未就緒，請先完成 clawapi setup 初始化 Master Key',
      }, 500);
    }
    let result;
    try {
      result = db.run(
        `INSERT INTO claw_keys (service_id, key_encrypted, model_id, is_active, daily_used, daily_limit)
         VALUES (?, ?, ?, 1, 0, ?)`,
        [body.service_id, encryptedKey, body.model_id, body.daily_limit ?? null]
      );
    } catch (err) {
      console.error('[Management] 新增 Claw Key 失敗:', err);
      return c.json({ error: 'db_error', message: '資料庫寫入失敗' }, 500);
    }

    return c.json({ success: true, id: result.lastInsertRowid }, 201);
  });

  /** DELETE /api/claw-keys/:id — 移除 Claw Key */
  app.delete('/claw-keys/:id', (c: Context) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ error: 'invalid_request', message: 'id 必須是數字' }, 400);
    }

    let result;
    try {
      result = db.run('DELETE FROM claw_keys WHERE id = ?', [id]);
    } catch (err) {
      console.error(`[Management] 刪除 Claw Key 失敗（id=${id}）:`, err);
      return c.json({ error: 'db_error', message: '資料庫刪除失敗' }, 500);
    }

    if (result.changes === 0) {
      return c.json({ error: 'not_found', message: `找不到 Claw Key：${id}` }, 404);
    }

    return c.json({ success: true, id });
  });

  // =========================================================
  // Sub-Key 管理
  // =========================================================

  /** GET /api/sub-keys — 列出 Sub-Key */
  app.get('/sub-keys', async (c: Context) => {
    const activeOnly = c.req.query('active') === 'true';
    const subKeys = activeOnly
      ? await subKeyManager.listActive()
      : await subKeyManager.list();

    // Sub-Key 的 token 欄位只顯示部分（安全起見遮罩）
    const masked = subKeys.map(sk => ({
      ...sk,
      token: maskSubKeyToken(sk.token),
    }));

    return c.json({ sub_keys: masked });
  });

  /** POST /api/sub-keys — 發行 Sub-Key */
  app.post('/sub-keys', async (c: Context) => {
    let body: IssueSubKeyParams;

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (!body.label || typeof body.label !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：label' }, 400);
    }

    try {
      const subKey = await subKeyManager.issue(body);
      return c.json({ success: true, sub_key: subKey }, 201);
    } catch (err) {
      return c.json({ error: 'failed', message: (err as Error).message }, 400);
    }
  });

  /** DELETE /api/sub-keys/:id — 撤銷 Sub-Key */
  app.delete('/sub-keys/:id', async (c: Context) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ error: 'invalid_request', message: 'id 必須是數字' }, 400);
    }

    const revoked = await subKeyManager.revoke(id);

    if (!revoked) {
      return c.json({ error: 'not_found', message: `找不到 Sub-Key：${id}` }, 404);
    }

    return c.json({ success: true, id });
  });

  /** GET /api/sub-keys/:id/usage — Sub-Key 用量 */
  app.get('/sub-keys/:id/usage', async (c: Context) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ error: 'invalid_request', message: 'id 必須是數字' }, 400);
    }

    // 從 DB 查詢 Sub-Key 用量資訊
    const rows = db.query<{
      id: number;
      label: string;
      daily_used: number;
      daily_limit: number | null;
      total_requests: number;
      total_tokens: number;
      last_used_at: string | null;
      is_active: number;
    }>(
      'SELECT id, label, daily_used, daily_limit, total_requests, total_tokens, last_used_at, is_active FROM sub_keys WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return c.json({ error: 'not_found', message: `找不到 Sub-Key：${id}` }, 404);
    }

    const row = rows[0]!;

    return c.json({
      id: row.id,
      label: row.label,
      daily_used: row.daily_used,
      daily_limit: row.daily_limit,
      daily_remaining: row.daily_limit !== null ? Math.max(0, row.daily_limit - row.daily_used) : null,
      total_requests: row.total_requests,
      total_tokens: row.total_tokens,
      last_used_at: row.last_used_at,
      is_active: row.is_active === 1,
    });
  });

  // =========================================================
  // 互助設定
  // =========================================================

  /** GET /api/aid/config — 互助設定 */
  app.get('/aid/config', (c: Context) => {
    // 從 DB 讀取互助設定
    const rows = db.query<{
      enabled: number;
      allowed_services: string | null;
      daily_limit: number;
      daily_given: number;
      blackout_hours: string | null;
      helper_public_key: string | null;
    }>(
      'SELECT enabled, allowed_services, daily_limit, daily_given, blackout_hours, helper_public_key FROM aid_config LIMIT 1'
    );

    if (rows.length === 0) {
      return c.json({
        enabled: false,
        allowed_services: null,
        daily_limit: 50,
        daily_given: 0,
        blackout_hours: [],
        has_helper_key: false,
      });
    }

    const row = rows[0]!;
    return c.json({
      enabled: row.enabled === 1,
      allowed_services: safeJsonParse(row.allowed_services, null),
      daily_limit: row.daily_limit,
      daily_given: row.daily_given,
      blackout_hours: safeJsonParse(row.blackout_hours, []),
      has_helper_key: row.helper_public_key !== null,
    });
  });

  /** PUT /api/aid/config — 更新互助設定 */
  app.put('/aid/config', async (c: Context) => {
    let body: Partial<AidClientConfig>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    try {
      await aidClient.updateConfig(body);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'failed', message: (err as Error).message }, 500);
    }
  });

  /** GET /api/aid/stats — 互助統計 */
  app.get('/aid/stats', async (c: Context) => {
    try {
      const stats = await aidClient.getStats();
      return c.json(stats);
    } catch (err) {
      return c.json({ error: 'failed', message: (err as Error).message }, 500);
    }
  });

  // =========================================================
  // Adapter 管理
  // =========================================================

  /** GET /api/adapters — 列出 Adapter */
  app.get('/adapters', (c: Context) => {
    const adapterList = Array.from(adapters.values()).map(a => ({
      id: a.adapter.id,
      name: a.adapter.name,
      version: a.adapter.version,
      category: a.adapter.category,
      requires_key: a.adapter.requires_key,
      free_tier: a.adapter.free_tier ?? false,
      capabilities: {
        chat: a.capabilities.chat,
        streaming: a.capabilities.streaming,
        embeddings: a.capabilities.embeddings,
        images: a.capabilities.images,
        audio: a.capabilities.audio,
        model_count: a.capabilities.models.length,
      },
    }));

    return c.json({ adapters: adapterList });
  });

  /** POST /api/adapters/install — 安裝社群 Adapter */
  app.post('/adapters/install', async (c: Context) => {
    let body: { path?: string; url?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (!body.path && !body.url) {
      return c.json({ error: 'invalid_request', message: '必須提供 path 或 url' }, 400);
    }

    // 安全檢查：路徑穿越防護
    if (body.path) {
      const { resolve } = await import('node:path');
      const { relative } = await import('node:path');
      const resolved = resolve(body.path);
      // 只允許 ~/.clawapi/adapters/ 目錄或 https:// URL
      const homeDir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
      const allowedDir = resolve(homeDir, '.clawapi', 'adapters');
      // 用 relative() 防止前綴繞過（如 adapters-evil/）
      const rel = relative(allowedDir, resolved);
      if (rel.startsWith('..') || resolve(allowedDir, rel) !== resolved) {
        return c.json({
          error: 'forbidden',
          message: `路徑受限：只允許 ${allowedDir} 目錄下的 Adapter 檔案`,
        }, 403);
      }
    }
    if (body.url && !body.url.startsWith('https://')) {
      return c.json({
        error: 'invalid_request',
        message: 'URL 必須使用 HTTPS 協議',
      }, 400);
    }

    try {
      // 從指定路徑載入 Adapter
      const source = body.path ?? body.url!;
      const config = await adapterLoader.loadFromFile(source);
      adapters.set(config.adapter.id, config);
      return c.json({ success: true, id: config.adapter.id, name: config.adapter.name }, 201);
    } catch (err) {
      return c.json({ error: 'install_failed', message: (err as Error).message }, 400);
    }
  });

  /** DELETE /api/adapters/:id — 移除 Adapter */
  app.delete('/adapters/:id', (c: Context) => {
    const id = c.req.param('id');

    if (!adapters.has(id)) {
      return c.json({ error: 'not_found', message: `找不到 Adapter：${id}` }, 404);
    }

    adapters.delete(id);
    return c.json({ success: true, id });
  });

  // =========================================================
  // 日誌查詢
  // =========================================================

  /** GET /api/logs — 查詢使用紀錄 */
  app.get('/logs', (c: Context) => {
    const serviceId = c.req.query('service_id');
    const layer = c.req.query('layer');
    const success = c.req.query('success');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500));
    const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
    const from = c.req.query('from');
    const to = c.req.query('to');

    // 動態組裝 SQL 條件
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (serviceId) {
      conditions.push('service_id = ?');
      params.push(serviceId);
    }
    if (layer) {
      conditions.push('layer = ?');
      params.push(layer);
    }
    if (success !== undefined && success !== '') {
      conditions.push('success = ?');
      params.push(success === 'true' ? 1 : 0);
    }
    if (from) {
      conditions.push('timestamp >= ?');
      params.push(from);
    }
    if (to) {
      conditions.push('timestamp <= ?');
      params.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 查詢總數
    const countResult = db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM usage_log ${where}`,
      params
    );
    const total = countResult[0]?.cnt ?? 0;

    // 查詢資料
    const rows = db.query<UsageLogRow>(
      `SELECT id, timestamp, service_id, model, layer, key_id, sub_key_id,
              success, latency_ms, error_code, tokens_input, tokens_output,
              routing_strategy, retry_count
       FROM usage_log ${where}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const logs = rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      service_id: row.service_id,
      model: row.model,
      layer: row.layer,
      key_id: row.key_id,
      sub_key_id: row.sub_key_id,
      success: row.success === 1,
      latency_ms: row.latency_ms,
      error_code: row.error_code,
      tokens_input: row.tokens_input,
      tokens_output: row.tokens_output,
      routing_strategy: row.routing_strategy,
      retry_count: row.retry_count,
    }));

    return c.json({
      logs,
      total,
      limit,
      offset,
      has_more: offset + limit < total,
    });
  });

  /** GET /api/logs/export — 匯出 CSV */
  app.get('/logs/export', (c: Context) => {
    const serviceId = c.req.query('service_id');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '1000', 10) || 1000, 10000));

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (serviceId) {
      conditions.push('service_id = ?');
      params.push(serviceId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db.query<UsageLogRow>(
      `SELECT id, timestamp, service_id, model, layer, success, latency_ms,
              tokens_input, tokens_output, routing_strategy, retry_count, error_code
       FROM usage_log ${where}
       ORDER BY timestamp DESC
       LIMIT ?`,
      [...params, limit]
    );

    // 組裝 CSV
    const headers = [
      'id', 'timestamp', 'service_id', 'model', 'layer', 'success',
      'latency_ms', 'tokens_input', 'tokens_output', 'routing_strategy',
      'retry_count', 'error_code',
    ];

    const csvRows = rows.map(row => [
      row.id,
      row.timestamp,
      row.service_id,
      row.model ?? '',
      row.layer,
      row.success ? 'true' : 'false',
      row.latency_ms,
      row.tokens_input ?? '',
      row.tokens_output ?? '',
      row.routing_strategy ?? '',
      row.retry_count,
      row.error_code ?? '',
    ].map(v => {
      let str = String(v).replace(/"/g, '""');
      // 防止 CSV 公式注入：=, +, -, @ 開頭的值加上單引號前綴
      if (/^[=+\-@]/.test(str)) str = `'${str}`;
      return `"${str}"`;
    }).join(','));

    const csv = [headers.join(','), ...csvRows].join('\n');

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="clawapi-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  });

  // =========================================================
  // L0 狀態
  // =========================================================

  /** GET /api/l0/status — L0 狀態 */
  app.get('/l0/status', (c: Context) => {
    const config = getConfig();

    return c.json({
      enabled: config.l0.enabled,
      cached_key_count: l0Manager.getCachedKeyCount(),
      last_fetched_at: l0Manager.getLastFetchedAt()
        ? new Date(l0Manager.getLastFetchedAt()).toISOString()
        : null,
      cache_expired: l0Manager.isCacheExpired(),
      ollama_auto_detect: config.l0.ollama_auto_detect,
      ollama_url: config.l0.ollama_url,
    });
  });

  // =========================================================
  // 備份（Stub → 501）
  // =========================================================

  /** POST /api/backup/export — 匯出加密備份（v1.1 推遲） */
  app.post('/backup/export', (c: Context) => {
    return c.json({
      error: 'not_implemented',
      message: '備份匯出功能已規劃於 v1.1 推遲實作',
    }, 501);
  });

  /** POST /api/backup/import — 匯入備份（v1.1 推遲） */
  app.post('/backup/import', (c: Context) => {
    return c.json({
      error: 'not_implemented',
      message: '備份匯入功能已規劃於 v1.1 推遲實作',
    }, 501);
  });

  // =========================================================
  // 設定管理
  // =========================================================

  /** GET /api/settings — 取得設定 */
  app.get('/settings', (c: Context) => {
    const config = getConfig();
    return c.json({ settings: config });
  });

  /** PUT /api/settings — 更新設定 */
  app.put('/settings', async (c: Context) => {
    let body: Partial<ClawConfig>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    try {
      await updateConfig(body);
      return c.json({ success: true, settings: getConfig() });
    } catch (err) {
      return c.json({ error: 'failed', message: (err as Error).message }, 400);
    }
  });

  // =========================================================
  // 遙測設定
  // =========================================================

  /** GET /api/telemetry/pending — 查看待上報內容 */
  app.get('/telemetry/pending', async (c: Context) => {
    const batch = await telemetry.buildBatch();

    if (!batch) {
      return c.json({ pending: false, batch: null });
    }

    return c.json({
      pending: true,
      batch: {
        batch_id: batch.batch_id,
        period: batch.period,
        entry_count: batch.entries.length,
        summary: batch.summary,
      },
    });
  });

  /** PUT /api/telemetry/enabled — 開關統計上報 */
  app.put('/telemetry/enabled', async (c: Context) => {
    let body: { enabled: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：enabled（布林值）' }, 400);
    }

    try {
      await updateConfig({ telemetry: { ...getConfig().telemetry, enabled: body.enabled } });
      return c.json({ success: true, enabled: body.enabled });
    } catch (err) {
      return c.json({ error: 'failed', message: (err as Error).message }, 500);
    }
  });

  return app;
}

// ===== 私有輔助函式 =====

/**
 * Sub-Key token 遮罩處理
 * 格式：sk_live_xxxxxxxx_前4位...後4位
 */
function maskSubKeyToken(token: string): string {
  // token 格式：sk_live_{8hex}_{UUID}
  // 顯示前綴 + 最後 4 碼
  if (token.length <= 12) return '****';
  const prefix = token.slice(0, token.indexOf('_', 8) + 1 || 12);
  const suffix = token.slice(-4);
  return `${prefix}****${suffix}`;
}

export default createManagementRouter;
