#!/usr/bin/env bun
// ClawAPI CLI 入口（npm bin 包裝）
// 用 import.meta.dir 解析正確的相對路徑，不受 symlink 影響
// 注意：動態 import 時 import.meta.main = false，所以要手動呼叫 main()
const path = require('path');
const cli = path.resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const { main } = await import(cli);
await main();
