# Changelog

所有重要變更都會記錄在這裡。格式遵循 [Keep a Changelog](https://keepachangelog.com/)。

## [0.1.12] - 2026-03-02

### Added
- `.env` 檔案掃描：自動從 `~/.env`、`~/Desktop/*/`、`~/Projects/*/` 等位置找 API Key
- Claw Key 引導：匯入後顯示 L2/L3/L4 能力說明和多 Key 輪換技巧
- DuckDuckGo 搜尋 demo：`clawapi init` 時展示免費搜尋功能
- 四爽點預告：init 完成後顯示一鍵全自動、主動推薦、碰壁引導、群體智慧
- CLI i18n：讀 config.yaml locale 設定，doctor/init 全中文化
- data.db 檔案權限限制為 600（與 auth.token/master.key 一致）
- doctor VPS 檢查顯示用途說明（匿名路由數據，不傳 Key）
- doctor Key 健康檢查：直接查 DB 顯示 Key 數量
- init 修改 ~/.claude.json 前顯示提示

### Changed
- Gold Key 全面改名為 Claw Key（50+ 檔案，保留 `gold` 向後相容）
- DuckDuckGo API URL 從 `api.duckduckgo.com` 改為 `duckduckgo.com`（修復 Bun User-Agent 被拒）
- key-validator：HTTP 400 偵測 `API_KEY_INVALID` 和 `RATE_LIMIT_EXCEEDED`
- doctor port 4141 佔用從 FAIL 降級為 WARN（MCP 模式不需要 port）
- config.yaml 路由策略加強說明

### Fixed
- setup_wizard(auto) 掃描時只找 process.env，遺漏 .env 檔案的 Key
- MCP Server 缺少 SubKeyManager 注入，導致無法產生 Claw Key
- DuckDuckGo demo 在 Bun 下取得空 body（根因：api. 子域名拒絕 Bun User-Agent）
- Gemini API 回 HTTP 400 rate limit 被誤判為 Key 無效

## [0.1.11] - 2026-03-01

### Added
- 四爽點體驗引導（setup_wizard MCP tool）
- 成長引擎（Growth Engine）：5 階段 + 推薦系統
- Phase relay：成長階段轉換慶祝動畫
- 環境掃描器（env-scanner）
- Key 驗證器（key-validator）
- 主動推薦下一個免費服務

### Changed
- 引擎架構重構：L1-L4 四層分離
- MCP Server 擴充為 10+ tools

## [0.1.10] - 2026-02-28

### Added
- 初版 MCP Server（stdio 模式）
- `clawapi init` / `clawapi doctor` CLI 命令
- `clawapi mcp --install` 自動註冊到 Claude Code
- SQLite WAL 模式 + 自動遷移
- API Key 加密存儲（AES-256-GCM）
