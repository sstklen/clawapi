# ClawAPI v0.1.8 MCP 安裝體驗回報（AI Agent 視角・第四輪）

> **回報者：** Claude Code（AI Agent）
> **日期：** 2026-03-02
> **版本：** @clawapi/engine@0.1.8
> **環境：** macOS darwin arm64, Bun 1.3.7, Claude Code
> **前提：** 完全乾淨環境，零殘留，第一次安裝

---

## 絲滑度評分：⭐⭐⭐⭐ (4/5)

比 v0.1.5 的 3 星進步很大。`clawapi init` 解決了最大痛點。
但還沒到「無敵絲滑」。以下是嚴格批判。

---

## 完整安裝流程（實際執行的每一行）

```bash
bun install -g @clawapi/engine    # 2.08s ✅ 絲滑
clawapi init                       # 自動建 config + 加 MCP ✅ 絲滑
clawapi doctor                     # 6 pass, 1 warn ✅ 絲滑
```

三行。比 v0.1.5 的七行少了一半以上。零猜測。這部分滿分。

---

## 嚴格批判：還差什麼才能「無敵絲滑」

### 🔴 批判 1：Google 搜不到（依然沒修）

第一次想裝 ClawAPI 的人，第一步是什麼？Google。

```
搜「ClawAPI MCP install」→ 零有用結果
搜「ClawAPI Claude Code」→ 零有用結果
搜「@clawapi/engine」→ 零有用結果
```

npm 頁面也被 403 擋。GitHub README 沒被索引。
**一個搜不到的工具，裝都裝不到，後面再絲滑也沒用。**

這是漏斗最頂端的問題。100 個想裝的人，可能 80 個在這步就放棄了。

**要到無敵：**
- GitHub README 第一段就要有安裝指令（被 Google 抓到）
- npmjs.com 頁面要能正常訪問
- 最好有一頁 `docs.clawapi.com/install` 或 GitHub Wiki

---

### 🟡 批判 2：`clawapi init` 替你決定了 MCP client

```
已新增 MCP 設定到 Claude Code（~/.claude.json）
```

它假設你用 Claude Code。如果用 Cursor？VS Code + Continue？Windsurf？
直接寫 `~/.claude.json` 不問一聲。

目前 Claude Code 確實是最大宗的 MCP client，所以這步「大部分情況沒問題」。
但對於一個通用工具來說，假設使用者的 MCP client = 不夠嚴謹。

**要到無敵：**
```bash
clawapi init                        # 預設 Claude Code（目前行為，OK）
clawapi init --mcp-client cursor    # 支援其他 client
clawapi init --no-mcp               # 只建 config，不動 MCP 設定
```
至少要有 `--no-mcp` 選項，讓進階使用者自己管 MCP。

---

### 🟡 批判 3：沒有 `clawapi uninstall`

裝得進去，拆不乾淨。我清了四輪環境，每次都要手動跑 5 個指令：

```bash
bun remove -g @clawapi/engine
rm -rf ~/.clawapi
rm -rf ~/.bun/install/cache/@clawapi
claude mcp remove clawapi -s user
claude mcp remove clawapi -s local
```

**五個地方，漏一個就有殘留。** 然後重裝就爆 `already exists`。

**要到無敵：**
```bash
clawapi uninstall          # 一行清光（config + db + MCP 設定 + 自己）
clawapi uninstall --keep-data   # 保留 key 和 db，只移除程式
```

---

### 🟡 批判 4：`clawapi init` 沒有冪等性

跑第二次會怎樣？我沒測，但根據之前經驗：
- `claude mcp add` 會報 `already exists`
- config 檔會被覆蓋？還是跳過？不確定。

**一個好的 init 指令應該是冪等的** — 跑幾次結果都一樣，不報錯。

**要到無敵：**
- 偵測到已初始化 → 顯示「已經設定好了，跳過」或「要重新設定嗎？」
- 不要讓使用者看到紅色錯誤訊息

---

### ⚪ 批判 5：doctor 的 WARN 在全新安裝時多餘

```
WARN  master.key exists (Not yet generated — will be created on first start)
```

我剛裝完，當然還沒啟動過，當然沒有 master.key。
**在「剛 init 完」的情境下，這個 WARN 是噪音。**

v0.1.6 把 FAIL 改 WARN 已經好很多。但如果要無敵：
- 剛 init 完跑 doctor → master.key 顯示 INFO「首次啟動時自動產生」
- 已經跑過但 key 不見了 → 才顯示 WARN

---

### ⚪ 批判 6：npm 撞名風險依然存在

```
npm search clawapi
→ clawapi          ← 別人的（playwright 自動化）
→ @clawapi/engine  ← 我們的
```

新手可能 `bun install -g clawapi`（少了 scope），裝到別人的東西。
雖然不是你能控制的，但 README 和文件裡要大字標注「是 @clawapi/engine 不是 clawapi」。

---

## 四輪測試版本進化追蹤

| 問題 | v0.1.5 | v0.1.6 | v0.1.7 | v0.1.8 |
|------|--------|--------|--------|--------|
| 版號寫死 | ❌ | ✅ | ✅ | ✅ |
| doctor FAIL → WARN | ❌ | ✅ | ✅ | ✅ |
| 缺 `clawapi init` | ❌ | ❌ | ❌ | ✅ 加了！|
| init 自動加 MCP | — | — | — | ✅ 加了！|
| Google 搜不到 | ❌ | ❌ | ❌ | ❌ |
| 缺 `clawapi uninstall` | ❌ | ❌ | ❌ | ❌ |
| init 冪等性 | — | — | — | ❓ 未測 |
| npm 撞名 | ❌ | ❌ | ❌ | ❌ |

---

## 從 3 星到 5 星的路線圖

| 優先度 | 做什麼 | 影響 |
|--------|--------|------|
| 🔴 P0 | 讓 Google 搜得到 | 漏斗最頂端，沒這個後面都白搭 |
| 🔴 P1 | 加 `clawapi uninstall` | 重裝/升級體驗，目前是地雷區 |
| 🟡 P2 | `clawapi init` 冪等 | 跑兩次不爆 |
| 🟡 P3 | `clawapi init --no-mcp` | 支援非 Claude Code 用戶 |
| ⚪ P4 | doctor 情境感知 | 剛 init 完 vs 已在用，顯示不同訊息 |

**一句話：v0.1.8 的「裝」已經絲滑了，但「找到」和「拆掉」還不是。
一個產品的安裝體驗 = 找到 + 裝上 + 拆掉，三段都要絲滑才算無敵。**
