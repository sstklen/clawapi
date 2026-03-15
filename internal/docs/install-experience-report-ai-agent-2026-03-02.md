# ClawAPI MCP 安裝體驗回報（AI Agent 視角）

> **回報者：** Claude Code（AI Agent）
> **日期：** 2026-03-02
> **測試次數：** 3 輪完整清除 → 重裝（v0.1.5 → v0.1.6 → v0.1.7）
> **環境：** macOS darwin arm64, Bun 1.3.7, Claude Code
> **結論：能用，但不絲滑。中間有 3 個地方要自己猜。**

---

## 絲滑度評分：⭐⭐⭐ (3/5)

「能裝起來」跟「絲滑」是兩回事。能裝起來，但過程中我（AI agent）踩了好幾次坑，
每次都要自己想 workaround。如果是人類第一次裝，沒有我這份 Skill 文件，大概要花 15-30 分鐘。

---

## 逐步體驗紀錄（100% 真實）

### Step 1: 找到套件 — ⚠️ 卡

**期望：** Google 搜「ClawAPI MCP install」就有文件。
**實際：** 搜不到任何有用結果。WebSearch、WebFetch 全部撲空。

**最後怎麼解的：** 用 `npm search clawapi` CLI 指令直接搜 registry。

**感受：** 一個 2026 年的開發工具，Google 搜不到安裝文件，這不正常。
對人類開發者來說，第一步就勸退了。
對 AI agent 來說，我知道可以用 `npm search`，但這不是直覺路徑。

**建議：** README 要被 Google 索引到。或者至少在 GitHub repo 的 description 裡放「installation」關鍵字。

---

### Step 2: 安裝 CLI — ✅ 絲滑

```bash
bun install -g @clawapi/engine
```

1.7 秒，沒問題。這步滿分。

---

### Step 3: 初始設定 — ❌ 最卡的一步

**期望：** `clawapi setup` 一鍵搞定。
**實際：** `clawapi setup` 是互動式 wizard。我是 AI，沒有鍵盤，跑不了。

**最後怎麼解的：** 自己手動做了 3 件事：
```bash
mkdir -p ~/.clawapi
find ~/.bun/install -name "default.yaml" -path "*clawapi*"   # 找預設 config 在哪
cp {找到的路徑} ~/.clawapi/config.yaml
```

**感受：** 這是整個流程最不絲滑的地方。問題不是「做不到」，是「要猜」：
1. 我要猜設定目錄是 `~/.clawapi`（沒有文件說）
2. 我要猜 config 檔叫 `config.yaml`（沒有文件說）
3. 我要自己去翻 node_modules 找 default.yaml（沒有文件說在哪）

如果有 `clawapi init --defaults` 或 `clawapi setup --non-interactive`，
上面 3 行變 1 行，這步就絲滑了。

**建議（優先度最高）：**
```bash
# 理想情況，一行搞定：
clawapi init          # 非互動，用預設值建好 config
clawapi init --force  # 已存在也覆蓋
```

---

### Step 4: 加 MCP — ✅ 絲滑（但重裝會爆）

首次安裝：
```bash
claude mcp add clawapi --scope user -- clawapi mcp
```
一行搞定，沒問題。

**但是！** 第二輪測試（清除重裝）時：
```
MCP server clawapi already exists in user config
```
因為 `~/.claude.json` 裡的 MCP 設定不會因為 `bun remove` 消失。
要先跑 `claude mcp remove clawapi -s user` 才能重新加。

**感受：** 第一次裝的人不會碰到。但只要你重裝過一次就會踩到。
而且錯誤訊息沒告訴你「用 claude mcp remove 先清掉」，只說 already exists。

**建議：**
- `clawapi uninstall` 指令自動清 MCP 設定
- 或 `claude mcp add` 加個 `--force` 覆蓋

---

### Step 5: 驗證 — ✅ 好用

```bash
clawapi doctor
```

這步很讚。一眼看出哪些 OK 哪些不 OK。
v0.1.6 把 master.key 從紅色 FAIL 改成黃色 WARN，明顯更合理。

---

## 三輪測試的版本改進追蹤

| 問題 | v0.1.5 | v0.1.6 | v0.1.7 |
|------|--------|--------|--------|
| 版號寫死 (顯示 v0.1.0) | ❌ | ✅ 修了 | ✅ |
| doctor master.key 紅色 FAIL | ❌ | ✅ 改 WARN | ✅ |
| 缺非互動 setup | ❌ | ❌ | ❌ |
| MCP 殘留問題 | ❌ | ❌ | ❌ |
| Google 搜不到 | ❌ | ❌ | ❌ |

反應速度很快（2 個版本修 2 個問題），但核心痛點（Step 3）還在。

---

## 如果要做到「AI 都覺得絲滑」

理想的安裝流程應該是這樣：

```bash
bun install -g @clawapi/engine    # 裝 CLI
clawapi init                       # 一行建好 config（非互動）
claude mcp add clawapi --scope user -- clawapi mcp   # 加 MCP
clawapi doctor                     # 驗證
```

四行，每行都不用猜，沒有任何 `find`、`cp`、`mkdir`。
目前卡在第二行不存在，要用 3 行手動操作替代。

**差距：4 行 vs 7 行，但重點不是行數，是「要不要猜」。**

---

## 總結

| 面向 | 評分 | 說明 |
|------|------|------|
| 裝 CLI | ⭐⭐⭐⭐⭐ | 完美，bun install 一行 |
| 找文件 | ⭐⭐ | Google 搜不到，要靠 npm search |
| 初始設定 | ⭐⭐ | 要猜目錄、猜檔名、翻 node_modules |
| 加 MCP | ⭐⭐⭐⭐ | 首次絲滑，重裝會卡 |
| 驗證 | ⭐⭐⭐⭐⭐ | doctor 很實用 |
| 錯誤修復速度 | ⭐⭐⭐⭐⭐ | 回報後兩個版本就修了 |

**一句話：裝得起來，但中間要猜 3 次。加一個 `clawapi init` 指令就能從 3 星變 5 星。**
