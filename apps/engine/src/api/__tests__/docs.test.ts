// API 文件路由測試
import { describe, expect, test } from 'bun:test';
import { generateOpenAPISpec } from '../openapi-spec';
import { createDocsRouter } from '../docs';

// ===== OpenAPI 規格測試 =====

describe('OpenAPI Spec', () => {
  const spec = generateOpenAPISpec() as Record<string, unknown>;

  test('應為 OpenAPI 3.1.0', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  test('應包含完整的 info 區塊', () => {
    const info = spec.info as Record<string, unknown>;
    expect(info.title).toBe('ClawAPI Engine');
    expect(info.version).toBeDefined();
    expect(info.description).toBeDefined();
    expect(info.license).toBeDefined();
  });

  test('應包含 BearerAuth 認證方案', () => {
    const components = spec.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<string, unknown>;
    expect(schemes.BearerAuth).toBeDefined();
    const bearer = schemes.BearerAuth as Record<string, unknown>;
    expect(bearer.type).toBe('http');
    expect(bearer.scheme).toBe('bearer');
  });

  test('應包含所有核心路徑', () => {
    const paths = spec.paths as Record<string, unknown>;
    // Health
    expect(paths['/health']).toBeDefined();
    expect(paths['/v1/health']).toBeDefined();
    // Chat
    expect(paths['/v1/chat/completions']).toBeDefined();
    // Models
    expect(paths['/v1/models']).toBeDefined();
    // Embeddings
    expect(paths['/v1/embeddings']).toBeDefined();
    // Images
    expect(paths['/v1/images/generations']).toBeDefined();
    // Audio
    expect(paths['/v1/audio/transcriptions']).toBeDefined();
    expect(paths['/v1/audio/speech']).toBeDefined();
    // Files
    expect(paths['/v1/files']).toBeDefined();
    // Simplified API
    expect(paths['/api/llm']).toBeDefined();
    expect(paths['/api/search']).toBeDefined();
    expect(paths['/api/translate']).toBeDefined();
    expect(paths['/api/ask']).toBeDefined();
    expect(paths['/api/task']).toBeDefined();
    // Management
    expect(paths['/api/keys']).toBeDefined();
    expect(paths['/api/sub-keys']).toBeDefined();
    expect(paths['/api/claw-keys']).toBeDefined();
    expect(paths['/api/status']).toBeDefined();
    expect(paths['/api/adapters']).toBeDefined();
    expect(paths['/api/settings']).toBeDefined();
    // Logs
    expect(paths['/api/logs']).toBeDefined();
    expect(paths['/api/logs/export']).toBeDefined();
    // Events
    expect(paths['/api/events']).toBeDefined();
    // Aid
    expect(paths['/api/aid/config']).toBeDefined();
    expect(paths['/api/aid/stats']).toBeDefined();
  });

  test('應有 15 個 tags', () => {
    const tags = spec.tags as unknown[];
    expect(tags.length).toBe(15);
  });

  test('health 端點不需認證', () => {
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const healthGet = paths['/health']!.get!;
    expect(healthGet.security).toEqual([]);
  });

  test('chat 端點需要認證', () => {
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const chatPost = paths['/v1/chat/completions']!.post!;
    // 沒有設定 security: [] 就會用全域的 BearerAuth
    expect(chatPost.security).toBeUndefined();
  });

  test('路徑數量 >= 30', () => {
    const paths = spec.paths as Record<string, unknown>;
    const count = Object.keys(paths).length;
    expect(count).toBeGreaterThanOrEqual(30);
  });

  test('schemas 應包含核心型別', () => {
    const components = spec.components as Record<string, Record<string, unknown>>;
    const schemas = components.schemas!;
    expect(schemas.ChatCompletionRequest).toBeDefined();
    expect(schemas.ChatCompletionResponse).toBeDefined();
    expect(schemas.KeyListItem).toBeDefined();
    expect(schemas.SubKey).toBeDefined();
    expect(schemas.LlmRequest).toBeDefined();
    expect(schemas.LlmResponse).toBeDefined();
    expect(schemas.EngineStatus).toBeDefined();
    expect(schemas.Error).toBeDefined();
  });
});

// ===== 文件路由測試 =====

describe('Docs Router', () => {
  const router = createDocsRouter();

  test('/openapi.json 應回傳有效 JSON', async () => {
    const res = await router.request('/openapi.json');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.openapi).toBe('3.1.0');
  });

  test('/docs 應回傳 HTML 頁面', async () => {
    const res = await router.request('/docs');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('ClawAPI');
    expect(html).toContain('api-reference');
    expect(html).toContain('/openapi.json');
  });

  test('/openapi.json 應可被多次請求（快取）', async () => {
    const res1 = await router.request('/openapi.json');
    const res2 = await router.request('/openapi.json');
    const json1 = await res1.json();
    const json2 = await res2.json();
    // 應該是同一份內容
    expect(JSON.stringify(json1)).toBe(JSON.stringify(json2));
  });
});
