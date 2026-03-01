# ClawAPI 交接文件

> 日期：2026-03-01 | 摘要：五方聯合審計全部修復完畢，準備進入部署階段

## ✅ 已完成

### 本次 Session
- [x] 五方聯合審計（紅隊 + 突變 + Gemini 盲審 + 供應鏈 + STRIDE）— 完整報告已產出
- [x] 修復 7 個安全問題：
  1. CORS `origin: '*'` → 限制 localhost（server.ts）
  2. Sub-Key 服務/模型權限繞過 → 路由後加 `checkSubKeyPermissions`（openai-compat.ts 四處）
  3. backup.ts 路徑穿越 → 只允許 `~/.clawapi/backups/` 和 `/tmp/`
  4. db.run 靜默吞錯誤 → auth.ts + management.ts 加 try/catch
  5. masterOnlyGuard 漏掉 4 條路徑 → 補齊 `/api/aid*`、`/api/logs*`、`/api/telemetry*`、`/api/l0*`
  6. 檔案上傳無類型驗證 → 加白名單（50+ 種允許副檔名）
  7. 突變測試 4 個盲點 → 新增 12 個測試，殺死率 100%
- [x] 測試全過：1478 pass / 0 fail
- [x] 已 commit：`e7687e9`

### 歷史累計
- 4 次 commit，從零到安全審計完畢
- 1478 個測試，247 個檔案，85K+ 行程式碼
- **尚未 push 到 GitHub**

## ⏳ 進行中
- 無（本次全部完成）

## 已知問題（低風險，不急）
- WebUI 無認證 — 本機才能存取，Phase 1 再處理
- Sub-Key 明文存 DB — 加密需較大改動，Phase 1
- error message 可能洩漏 token 格式 — 只有本機能看到

## 下一步（按優先順序）

### 1. 推上 GitHub
```bash
cd ~/Desktop/ClawAPI
# 先建 org（如果還沒有）
gh repo create clawapi/clawapi --public --source=. --push
```

### 2. 部署到 VPS（#6B）
```bash
# 設定 domain DNS：api.clawapi.com → VPS IP
# 注意：washin VPS 已有 Caddy 佔 80/443，要整合或分 port
ssh washin
cd /home/ubuntu && git clone https://github.com/clawapi/clawapi.git
cd clawapi
# 設定 .env（ADMIN_TOKEN 等）
docker compose -f docker-compose.vps.yml up -d --build
```

### 3. 冒煙測試
```bash
curl https://api.clawapi.com/health
curl https://api.clawapi.com/v1/models
```

### 4. GitHub Release
```bash
gh release create v0.1.0 --title "v0.1.0 — 首次發布" --notes "ClawAPI 開源 AI API 鑰匙管理器"
```

## 📁 專案結構
```
ClawAPI/                    ~/Desktop/ClawAPI
├── packages/protocol/      共用型別（34 tests）
├── apps/engine/            開源客戶端（795+ tests）
├── apps/vps/               閉源服務端（550+ tests）
├── tests/e2e/              E2E 整合測試（47 tests）
└── specs/                  規格書
```

## 技術棧
Bun 1.3.7 / Hono / SQLite / TypeScript / AES-256-GCM / Docker + Caddy
