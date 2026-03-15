# ClawAPI MCP 全新安裝測試報告

> **測試日期：** 2026-03-02
> **環境：** macOS (darwin arm64), Bun 1.3.7, Claude Code
> **測試方式：** 徹底清除所有 ClawAPI 痕跡後，以「第一次安裝的人」角度重新安裝
> **安裝版本：** @clawapi/engine@0.1.5

---

## 清除範圍（測試前）

完整移除了以下項目，確保零殘留：
- `bun remove -g @clawapi/engine`
- `~/.clawapi/` 整個目錄（auth.token, config.yaml, data.db, data.db-shm, data.db-wal, master.key）
- `~/.bun/bin/clawapi` symlink
- `~/.bun/install/cache/@clawapi/` cache
- `~/Desktop/clawapi-darwin-arm64` 獨立執行檔
- `settings.local.json` 中 8 條 clawapi 相關權限規則

---

## 發現的問題（按嚴重度排序）

### 🔴 P1 — `~/.claude.json` MCP 設定殘留，清除流程不完整

**現象：** 徹底清除後跑 `claude mcp add clawapi --scope user -- clawapi mcp`，報錯：
```
MCP server clawapi already exists in user config
```

**原因：** `~/.claude.json` 裡的 `mcpServers.clawapi` 不會因為 uninstall 套件而消失。
使用者（或 AI agent）做「清除重裝」時，容易漏掉這個檔案。

**建議：**
- `clawapi uninstall` 指令應自動清除 MCP 設定（偵測 `~/.claude.json` 並移除對應條目）
- 或至少在文件中提醒：「重裝前記得跑 `claude mcp remove clawapi -s user`」
- 安裝 Skill 已更新此步驟

---

### 🟡 P2 — `clawapi version` 顯示 v0.1.0，但套件版本是 0.1.5

**現象：**
```
$ clawapi version
ClawAPI v0.1.0        ← 寫死的？
Runtime: Bun 1.3.7
Platform: darwin arm64
```

```
$ npm search clawapi
@clawapi/engine  Version 0.1.5  ← npm 上是 0.1.5
```

**原因：** `version` 子指令可能讀的是 hardcoded 字串，沒有從 `package.json` 動態取。

**建議：** 從 `package.json` 的 `version` 欄位動態讀取，避免每次 publish 忘記更新。

---

### 🟡 P3 — `clawapi setup` 無非互動模式，AI Agent 無法自動化安裝

**現象：** `clawapi setup` 是互動式 wizard，在 Claude Code / CI 環境無法執行。

**目前 workaround：** 手動 `mkdir -p ~/.clawapi` + `cp default.yaml`

**建議：**
- 加 `clawapi setup --non-interactive` 或 `clawapi init --defaults`
- 或偵測到非 TTY 時自動用預設值

---

### 🟡 P4 — `clawapi doctor` 的 master.key FAIL 訊息可更友善

**現象：**
```
FAIL  master.key exists (Not yet generated (will be created on first start))
```

**問題：** 新使用者看到紅色 FAIL 會以為安裝壞了。但這其實是正常狀態（首次啟動時才產生）。

**建議：** 改為 WARN 或 INFO 級別，用黃色標示：
```
WARN  master.key (Not yet generated — will be created on first start)
```

---

### ⚪ P5 — npm 上有另一個無關的 `clawapi` 套件

**現象：** `npm search clawapi` 第一筆結果是別人的 `clawapi`（非官方、不相關）：
```
clawapi   ← 別人的，playwright 自動化工具
@clawapi/engine  ← 我們的
```

**風險：** 新使用者可能 `npm install -g clawapi`（少了 @clawapi/engine scope），裝錯東西。

**建議：**
- README 和文件中強調完整套件名 `@clawapi/engine`
- 考慮是否需要在 npm 上佔位 `clawapi`（或聯繫該套件作者）

---

## 安裝成功的部分 ✅

| 步驟 | 結果 | 耗時 |
|------|------|------|
| `bun install -g @clawapi/engine` | ✅ 1.54s 完成 | 快 |
| 預設 config 複製 | ✅ default.yaml 齊全、註解清楚 | 好 |
| `claude mcp add` | ✅ stdio 模式正確寫入 | 順 |
| `clawapi doctor` | ✅ 6/7 PASS | 實用 |
| config.yaml 中文註解 | ✅ 全中文，locale 預設 zh-TW | 讚 |
| Adapter 自動偵測 | ✅ 6 core adapters ready | 好 |

---

## 總結

**整體安裝體驗：⭐⭐⭐⭐ (4/5)**

好的部分：裝完 2 分鐘能用、config 全中文、doctor 診斷實用。
可改進：version 對不上、首次 FAIL 嚇人、缺非互動模式、重裝流程有殘留坑。

P1 建議優先修（影響重裝/CI 流程），P2-P4 可排入下個版本。
