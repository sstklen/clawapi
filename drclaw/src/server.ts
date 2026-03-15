/**
 * ========================================
 * Dr. Claw — 獨立 HTTP Server
 * ========================================
 *
 * 從 Confucius Debug 分拆的獨立開源項目
 * 繼承了孔子所有好的東西，完全獨立運作
 *
 * 三層解坑瀑布：
 * 1. 知識庫命中（Qdrant 向量搜尋） → 秒回
 * 2. Opus Relay 在線 → 品質最高
 * 3. Sonnet 4.6 + Prompt Caching → 備援分析
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLogger } from './logger';
import { isFeatureEnabled } from './config';
import { getEnv, getEnvNum } from './config';
import { initQdrant } from './qdrant';
import { getDb, closeDb } from './database';
import { loadStatsFromDb } from './core/stats';
import { handleRelayOpen, handleRelayClose, handleRelayMessage } from './core/opus-bridge';

// 路由模組
import { registerCoreRoutes } from './routes/core';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerOnboardRoutes } from './routes/onboard';
import { registerEscalateRoutes } from './routes/escalate';
import { registerAdminRoutes } from './routes/admin';

// MCP
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createDebugMcpServer } from './mcp/mcp-server';

const log = createLogger('Server');
const PORT = getEnvNum('PORT', 3200);

// ============================================
// Hono App
// ============================================

const app = new Hono();

// CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-admin-password', 'x-lobster-id'],
}));

// ============================================
// 健康檢查
// ============================================

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'drclaw',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// Debug AI 路由
// ============================================

// 功能開關
app.use('/api/v2/debug-ai*', async (c, next) => {
  if (!isFeatureEnabled('debug_ai')) {
    return c.json({
      error: 'Dr. Claw 尚未開放',
      hint: '設定 FEATURE_DEBUG_AI=true 後可使用',
    }, 503);
  }
  await next();
});

// 建立路由子應用
const debugRouter = new Hono();
registerCoreRoutes(debugRouter);
registerKnowledgeRoutes(debugRouter);
registerOnboardRoutes(debugRouter);
registerEscalateRoutes(debugRouter);
registerAdminRoutes(debugRouter);

app.route('/api/v2', debugRouter);

// ============================================
// MCP 端點
// ============================================

// /mcp/debug — Stateless MCP（每次請求建新 transport + server）
// enableJsonResponse: stateless 模式不需要 SSE 串流，直接回 JSON
app.all('/mcp/debug', async (c) => {
  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createDebugMcpServer();
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  } catch (err: any) {
    log.error(`/mcp/debug 處理失敗: ${err.message}`);
    return c.json({ error: 'MCP request failed' }, 500);
  }
});

// /mcp/debug/:lobster_id — 龍蝦專屬連結（自動認人）
app.all('/mcp/debug/:lobster_id', async (c) => {
  try {
    const rawLobsterId = c.req.param('lobster_id') || '';
    const lobsterId = rawLobsterId.replace(/[^a-zA-Z0-9_\-\.]/g, '').substring(0, 100);
    if (!lobsterId) {
      return c.text('Invalid lobster ID', 400);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createDebugMcpServer(lobsterId);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  } catch (err: any) {
    log.error(`/mcp/debug/:id 處理失敗: ${err.message}`);
    return c.json({ error: 'MCP request failed' }, 500);
  }
});

// ============================================
// 啟動
// ============================================

async function startup() {
  // 初始化 DB（建表）
  getDb();

  // 載入累計統計
  loadStatsFromDb();

  // 初始化 Qdrant
  await initQdrant();

  log.info(`🦞🔧 Dr. Claw 獨立服務啟動: http://localhost:${PORT}`);
  log.info(`   API:    /api/v2/debug-ai`);
  log.info(`   MCP:    /mcp/debug`);
  log.info(`   Health: /health`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('收到 SIGINT，正在關閉...');
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('收到 SIGTERM，正在關閉...');
  closeDb();
  process.exit(0);
});

// 啟動
startup().catch((err) => {
  log.error(`啟動失敗: ${err}`);
  process.exit(1);
});

// Bun HTTP server（idleTimeout 加大，MCP SSE 可能需要較長時間）
export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 120,
};
