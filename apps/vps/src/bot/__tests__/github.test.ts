// GitHub Bot 測試
// 驗證：5 種 label 分類、未知 Issue、自動回覆模板

import { describe, it, expect } from 'bun:test';
import {
  classifyIssue,
  getReplyTemplate,
  LABEL_KEYWORDS,
} from '../github';
import type { GitHubIssue } from '../github';

// ===== 測試 Fixture 工廠 =====

function makeIssue(overrides: Partial<GitHubIssue>): GitHubIssue {
  return {
    number: 1,
    title: '',
    body: null,
    created_at: new Date().toISOString(),
    labels: [],
    comments: 0,
    user: { login: 'test-user' },
    ...overrides,
  };
}

// ===== 分類測試 =====

describe('classifyIssue', () => {

  // Bug 分類
  describe('Bug 分類', () => {
    it('標題包含 bug 關鍵字 → bug', () => {
      const issue = makeIssue({ title: 'App crash when loading adapter' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('bug');
    });

    it('內文包含 error → bug', () => {
      const issue = makeIssue({
        title: '使用問題',
        body: 'I get an error when trying to use the routing feature. It fails every time.',
      });
      const result = classifyIssue(issue);
      expect(result.label).toBe('bug');
      expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });

    it('中文 bug 關鍵字「壞了」→ bug', () => {
      const issue = makeIssue({ title: '路由功能壞了，一直報錯誤' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('bug');
    });
  });

  // Security 分類
  describe('Security 分類', () => {
    it('標題包含 security vulnerability → security', () => {
      const issue = makeIssue({ title: 'Security vulnerability in adapter parser' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('security');
    });

    it('XSS injection 關鍵字 → security', () => {
      const issue = makeIssue({
        title: 'Potential XSS issue',
        body: 'Found an injection attack vector in the template rendering.',
      });
      const result = classifyIssue(issue);
      expect(result.label).toBe('security');
    });

    it('中文「安全漏洞」→ security', () => {
      const issue = makeIssue({ title: '發現安全漏洞，有注入風險' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('security');
    });
  });

  // Adapter 分類
  describe('Adapter 分類', () => {
    it('標題包含 adapter yaml → adapter', () => {
      const issue = makeIssue({ title: 'Add adapter yaml support for new service' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('adapter');
    });

    it('plugin integration 關鍵字 → adapter', () => {
      const issue = makeIssue({
        title: 'Request: plugin support',
        body: 'We need a connector for this API provider. Need integration with their system.',
      });
      const result = classifyIssue(issue);
      expect(result.label).toBe('adapter');
    });

    it('中文「插件適配器」→ adapter', () => {
      const issue = makeIssue({ title: '新增插件適配器支援' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('adapter');
    });
  });

  // Feature 分類
  describe('Feature 分類', () => {
    it('feature request 關鍵字 → feature', () => {
      const issue = makeIssue({ title: 'Feature request: add support for multiple keys' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('feature');
    });

    it('enhancement improvement 關鍵字 → feature', () => {
      const issue = makeIssue({
        title: 'Enhancement request',
        body: 'It would be nice to have an improvement to the UI. I suggest adding this feature.',
      });
      const result = classifyIssue(issue);
      expect(result.label).toBe('feature');
    });

    it('中文「功能建議」→ feature', () => {
      const issue = makeIssue({ title: '功能建議：新增批量操作' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('feature');
    });
  });

  // Question 分類
  describe('Question 分類', () => {
    it('how to 關鍵字 → question', () => {
      const issue = makeIssue({ title: 'How to configure routing?' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('question');
    });

    it('help explain 關鍵字 → question', () => {
      const issue = makeIssue({
        title: 'Need help',
        body: 'Can someone explain how this works? I need help understanding the documentation.',
      });
      const result = classifyIssue(issue);
      expect(result.label).toBe('question');
    });

    it('中文「怎麼如何」→ question', () => {
      const issue = makeIssue({ title: '怎麼設定路由？如何使用 L0？' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('question');
    });

    it('包含問號 → question', () => {
      const issue = makeIssue({
        title: 'Why is the response slow?',
        body: 'How do I fix this?',
      });
      const result = classifyIssue(issue);
      expect(result.label).toBe('question');
    });
  });

  // 未知 / needs-triage 分類
  describe('未知 Issue', () => {
    it('無關鍵字匹配 → needs-triage', () => {
      const issue = makeIssue({
        title: 'Something to report',
        body: null,
      });
      const result = classifyIssue(issue);
      expect(result.label).toBe('needs-triage');
    });

    it('空標題空內文 → needs-triage', () => {
      const issue = makeIssue({ title: '', body: '' });
      const result = classifyIssue(issue);
      expect(result.label).toBe('needs-triage');
    });

    it('needs-triage 的 confidence 應為 low', () => {
      const issue = makeIssue({ title: 'Generic title' });
      const result = classifyIssue(issue);
      expect(result.confidence).toBe('low');
    });

    it('needs-triage 的 matchedKeywords 應為空', () => {
      const issue = makeIssue({ title: 'No match here at all' });
      const result = classifyIssue(issue);
      expect(result.matchedKeywords).toEqual([]);
    });
  });

  // confidence 測試
  describe('信心度計算', () => {
    it('匹配 1 個關鍵字 → confidence low', () => {
      const issue = makeIssue({ title: 'bug found' });
      const result = classifyIssue(issue);
      // 'bug' = 1 個關鍵字
      expect(result.confidence).toBe('low');
    });

    it('匹配 2 個關鍵字 → confidence medium', () => {
      const issue = makeIssue({ title: 'crash error in app' });
      const result = classifyIssue(issue);
      // 'crash' + 'error' = 2 個關鍵字
      expect(result.confidence).toBe('medium');
    });

    it('匹配 3+ 個關鍵字 → confidence high', () => {
      const issue = makeIssue({ title: 'security vulnerability xss injection attack' });
      const result = classifyIssue(issue);
      expect(result.confidence).toBe('high');
    });
  });
});

// ===== 回覆模板測試 =====

describe('getReplyTemplate', () => {
  it('bug 模板包含正確的結構', () => {
    const template = getReplyTemplate({
      issueNumber: 42,
      authorLogin: 'testuser',
      label: 'bug',
    });
    expect(template).toContain('@testuser');
    expect(template).toContain('Bug');
    expect(template).toContain('版本');
    expect(template).toContain('自動回覆');
  });

  it('security 模板包含安全警告', () => {
    const template = getReplyTemplate({
      issueNumber: 1,
      authorLogin: 'secreporter',
      label: 'security',
    });
    expect(template).toContain('security@clawapi.dev');
    expect(template).toContain('安全');
  });

  it('feature 模板包含使用場景提問', () => {
    const template = getReplyTemplate({
      issueNumber: 1,
      authorLogin: 'feature-requester',
      label: 'feature',
    });
    expect(template).toContain('Feature Request');
    expect(template).toContain('使用場景');
  });

  it('adapter 模板包含文件連結', () => {
    const template = getReplyTemplate({
      issueNumber: 1,
      authorLogin: 'dev',
      label: 'adapter',
    });
    expect(template).toContain('Adapter');
    expect(template).toContain('adapter-guide');
  });

  it('question 模板包含文件連結', () => {
    const template = getReplyTemplate({
      issueNumber: 1,
      authorLogin: 'questioner',
      label: 'question',
    });
    expect(template).toContain('docs');
    expect(template).toContain('FAQ');
  });

  it('needs-triage 模板包含 48 小時承諾', () => {
    const template = getReplyTemplate({
      issueNumber: 1,
      authorLogin: 'user',
      label: 'needs-triage',
    });
    expect(template).toContain('48 小時');
  });
});

// ===== 關鍵字清單完整性驗證 =====

describe('LABEL_KEYWORDS 完整性', () => {
  const requiredLabels = ['bug', 'security', 'adapter', 'feature', 'question'] as const;

  for (const label of requiredLabels) {
    it(`${label} 應有至少 5 個關鍵字`, () => {
      expect(LABEL_KEYWORDS[label].length).toBeGreaterThanOrEqual(5);
    });
  }
});
