// Adapter 安全審查測試
// 驗證：三層安全掃描各通過/失敗

import { describe, it, expect } from 'bun:test';
import {
  scanUrls,
  scanTemplateVars,
  scanDangerousPatterns,
  AdapterReviewer,
  ALLOWED_DOMAINS,
} from '../adapter-review';

// ===== 層 1：URL 白名單測試 =====

describe('層 1：URL 白名單掃描（scanUrls）', () => {

  it('白名單域名通過', () => {
    const content = `
base_url: https://api.openai.com/v1
endpoint: https://api.anthropic.com/v1/messages
`;
    const findings = scanUrls(content);
    expect(findings).toHaveLength(0);
  });

  it('未知域名觸發告警', () => {
    const content = `
base_url: https://api.unknown-service.com/v1/chat
`;
    const findings = scanUrls(content);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.layer).toBe(1);
    expect(findings[0]!.type).toBe('unknown_url');
  });

  it('所有 15 個白名單域名都能通過', () => {
    const allowedUrls = [
      'https://api.groq.com/v1',
      'https://generativelanguage.googleapis.com/v1',
      'https://api.openai.com/v1',
      'https://api.anthropic.com/v1',
      'https://api.deepseek.com/v1',
      'https://api.search.brave.com/res/v1',
      'https://api.tavily.com/search',
      'https://google.serper.dev/search',
      'https://api.duckduckgo.com',
      'https://api-free.deepl.com/v2',
      'https://api.deepl.com/v2',
      'https://api.cerebras.ai/v1',
      'https://api.sambanova.ai/v1',
      'https://openrouter.ai/api/v1',
      'https://dashscope.aliyuncs.com/api/v1',
    ];

    for (const url of allowedUrls) {
      const findings = scanUrls(`base_url: ${url}`);
      const unknownFindings = findings.filter(f => f.type === 'unknown_url');
      expect(unknownFindings).toHaveLength(0);
    }
  });

  it('混合白名單和未知 URL，只報告未知的', () => {
    const content = `
base_url: https://api.openai.com/v1
fallback: https://evil.example.com/api
`;
    const findings = scanUrls(content);
    expect(findings.length).toBe(1);
    expect(findings[0]!.type).toBe('unknown_url');
  });

  it('ALLOWED_DOMAINS 包含 15 個域名', () => {
    expect(ALLOWED_DOMAINS.size).toBe(15);
  });
});

// ===== 層 2：模板變數測試 =====

describe('層 2：模板變數掃描（scanTemplateVars）', () => {

  it('安全的模板變數通過', () => {
    const content = `
body:
  messages: "{{ messages }}"
  model: "{{ model | default: 'gpt-4' }}"
`;
    const findings = scanTemplateVars(content);
    expect(findings).toHaveLength(0);
  });

  it('{{ key }} 觸發告警', () => {
    const content = `
auth:
  token: "{{ key }}"
`;
    const findings = scanTemplateVars(content);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.layer).toBe(2);
    expect(findings[0]!.type).toBe('key_access');
  });

  it('{{ env.API_SECRET }} 觸發告警', () => {
    const content = `
headers:
  Authorization: "Bearer {{ env.API_SECRET }}"
`;
    const findings = scanTemplateVars(content);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.type).toBe('env_access');
  });

  it('{{ file.config }} 觸發告警', () => {
    const content = `
config: "{{ file.secrets.json }}"
`;
    const findings = scanTemplateVars(content);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.type).toBe('file_access');
  });

  it('包含行號資訊', () => {
    const content = `name: test
version: 1
token: "{{ key }}"
`;
    const findings = scanTemplateVars(content);
    expect(findings[0]!.line).toBe(3);
  });
});

// ===== 層 3：危險模式測試 =====

describe('層 3：危險模式掃描（scanDangerousPatterns）', () => {

  it('無危險模式通過', () => {
    const content = `
name: safe-adapter
description: 安全的 Adapter
base_url: https://api.openai.com/v1
`;
    const findings = scanDangerousPatterns(content);
    expect(findings).toHaveLength(0);
  });

  it('eval() 呼叫觸發告警', () => {
    const content = `
transform: eval(userInput)
`;
    const findings = scanDangerousPatterns(content);
    expect(findings.some(f => f.type === 'eval_call')).toBe(true);
    expect(findings[0]!.layer).toBe(3);
  });

  it('exec() 呼叫觸發告警', () => {
    const content = `
script: exec("rm -rf /")
`;
    const findings = scanDangerousPatterns(content);
    expect(findings.some(f => f.type === 'exec_call')).toBe(true);
  });

  it('child_process require 觸發告警', () => {
    const content = `const cp = require('child_process');`;
    const findings = scanDangerousPatterns(content);
    expect(findings.some(f => f.type === 'child_process')).toBe(true);
  });

  it('__proto__ 觸發告警', () => {
    const content = `obj.__proto__.admin = true;`;
    const findings = scanDangerousPatterns(content);
    expect(findings.some(f => f.type === 'prototype_pollution')).toBe(true);
  });

  it('process.env 觸發告警', () => {
    const content = `const key = process.env.SECRET_KEY;`;
    const findings = scanDangerousPatterns(content);
    expect(findings.some(f => f.type === 'process_env')).toBe(true);
  });
});

// ===== AdapterReviewer 完整審查測試 =====

describe('AdapterReviewer.review', () => {

  it('乾淨的 Adapter 三層全通過', () => {
    const content = `
name: openai-chat
description: OpenAI Chat Completion Adapter
version: 1.0.0
base_url: https://api.openai.com/v1
auth:
  type: bearer
endpoints:
  - path: /chat/completions
    method: POST
`;
    const reviewer = new AdapterReviewer();
    const result = reviewer.review(content);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.findings).toHaveLength(0);
  });

  it('包含危險模式 → passed = false', () => {
    const content = `
name: bad-adapter
transform: eval(user_input)
`;
    const reviewer = new AdapterReviewer();
    const result = reviewer.review(content);

    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(100);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('未知 URL → passed = false', () => {
    const content = `
name: unknown-url-adapter
base_url: https://evil.example.com/api
`;
    const reviewer = new AdapterReviewer();
    const result = reviewer.review(content);

    expect(result.passed).toBe(false);
  });

  it('PR 留言格式包含必要資訊', () => {
    const content = `name: test`;
    const reviewer = new AdapterReviewer();
    const result = reviewer.review(content, {
      number: 42,
      authorLogin: 'contributor',
      filename: 'adapters/test.yaml',
    });

    expect(result.prComment).toContain('@contributor');
    expect(result.prComment).toContain('test.yaml');
    expect(result.prComment).toContain('ClawAPI Bot');
  });

  it('通過時 PR 留言顯示三層全部通過', () => {
    const cleanContent = `
name: clean-adapter
base_url: https://api.openai.com/v1
`;
    const reviewer = new AdapterReviewer();
    const result = reviewer.review(cleanContent);

    expect(result.prComment).toContain('✅');
    expect(result.prComment).not.toContain('❌');
  });

  it('失敗時 PR 留言顯示問題詳情', () => {
    const badContent = `eval("code") && process.env.SECRET`;
    const reviewer = new AdapterReviewer();
    const result = reviewer.review(badContent);

    expect(result.prComment).toContain('❌');
    expect(result.prComment).toContain('需要修改');
  });
});
