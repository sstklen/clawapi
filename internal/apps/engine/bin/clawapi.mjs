#!/usr/bin/env bun
// ClawAPI CLI 入口（npm bin 包裝）
// npm 不接受 .ts 作為 bin，所以用 .mjs 包一層
await import('../src/cli/index.ts');
