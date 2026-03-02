// API 文件路由 — Scalar UI + OpenAPI JSON
// 提供 /docs（互動式 API 文件）和 /openapi.json（OpenAPI 規格檔）
// 不需要認證，任何人都能查閱 API 文件

import { Hono } from 'hono';
import { generateOpenAPISpec } from './openapi-spec';

// ===== 建立文件路由 =====

export function createDocsRouter(): Hono {
  const app = new Hono();

  // 快取產生的 OpenAPI 規格（啟動後不變）
  let cachedSpec: Record<string, unknown> | null = null;

  /** 取得 OpenAPI 規格（延遲產生，啟動後快取） */
  function getSpec(): Record<string, unknown> {
    if (!cachedSpec) {
      cachedSpec = generateOpenAPISpec();
    }
    return cachedSpec;
  }

  // --- /openapi.json — OpenAPI 3.1.0 規格檔 ---
  app.get('/openapi.json', (c) => {
    // [LOW-3 修復] 加 Cache-Control
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(getSpec());
  });

  // --- /docs — Scalar 互動式 API 文件 ---
  app.get('/docs', (c) => {
    // [HIGH 修復] 加 CSP + 安全 Headers
    c.header('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "connect-src 'self'; " +
      "img-src 'self' data: https:"
    );
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');

    // [HIGH 修復] CDN 釘選版本
    const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClawAPI — API 文件</title>
  <meta name="description" content="ClawAPI 開源 AI API 閘道器 — 完整 API 文件" />
  <style>
    body { margin: 0; }
  </style>
</head>
<body>
  <script
    id="api-reference"
    data-url="/openapi.json"
  ></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.70"></script>
</body>
</html>`;

    return c.html(html);
  });

  return app;
}
