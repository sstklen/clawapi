# ClawAPI 交接文件

> 日期：2026-03-04 Session 4 | 摘要：三大功能完工 — Adapter 市集 + 數據驅動成長 + 互助進階
> 版本：0.1.13 | 測試：1741 pass / 2 fail (pre-existing) | 安全審查：Codex ✅ + Gemini ✅

---

## 已完成

### 功能 1：Adapter 市集 Phase 1
- [x] `AdapterRegistry` 類別 — 搜尋/安裝/版本檢查，GitHub registry.json 1 小時快取
- [x] CLI `adapters search <query>` + `adapters marketplace` 子指令
- [x] MCP `adapters` 工具新增 `view` 參數（installed/marketplace/search）
- [x] Config 新增 `registry` 設定區塊（url, enabled, auto_check_updates）
- [x] Path traversal 安全修復（adapterId regex + 路徑遏制檢查）

### 功能 2：成長引導數據驅動
- [x] `getClawKeyRecommendations()` — 覆蓋缺口/效能不佳/升級建議
- [x] `getUsageInsights()` 新增 3 條洞察 — 韌性/限速替代/Claw Key 錯配
- [x] MCP growth_guide overview 尾部加「Claw Key 建議」區塊

### 功能 3：互助進階
- [x] 感謝榜 — `GET /v1/aid/leaderboard`（匿名「龍蝦 #XXX」排行 Top 20）
- [x] 積分系統 — `GET /v1/aid/credits` + `aid_credits` 資料表（migration 002）
- [x] 優先使用權 — creditBonus 加成配對（Math.max(0, Math.min(credits/10, 2.0))）
- [x] CLI `aid leaderboard` + `aid stats` 含積分餘額

### 基礎建設
- [x] Protocol 型別 — RegistryCatalog, RegistryAdapter, LeaderboardEntry, AidCredits, ClawKeyInsight
- [x] RATE_LIMITS 21→23 端點（leaderboard + credits）
- [x] 61 個新測試（registry 40 + growth 11 + aid-engine 10）
- [x] Codex 代碼審查 + Gemini 安全審查（交叉驗證）

### 改動統計
- **26 個檔案**（含 3 個新檔），1,579 行新增 / 55 行刪除

---

## 已知問題
- 2 個 pre-existing 測試 fail：Dockerfile `adduser` + Caddyfile 域名（跟這次無關）
- Codex ⚠️ 非阻擋建議：credit bonus × reputation_weight 可能 >2、djb2 碰撞風險

---

## 下一步（按優先順序）

1. **提交所有改動**
   ```bash
   cd /Users/tkman/Desktop/ClawAPI
   git add apps/ packages/ && git add apps/engine/src/adapters/registry.ts apps/engine/src/adapters/__tests__/registry.test.ts apps/vps/src/storage/migrations/002-aid-credits.ts
   git commit -m "feat: v0.1.13 三大功能 — Adapter 市集 + 數據驅動成長 + 互助進階"
   ```

2. **四平台編譯**
   ```bash
   cd apps/engine && bun run build
   ```

3. **VPS 部署測試**
   ```bash
   ssh washin-old "cd /home/ubuntu/clawapi && git pull && docker compose up -d --build"
   curl https://clawapi.washinmura.jp/v1/aid/leaderboard
   curl -H "X-Device-Id: test" https://clawapi.washinmura.jp/v1/aid/credits
   ```

4. **npm publish 0.1.13**（如果準備好的話）

---

*交接人：Claude Code（老大）| 2026-03-04*
