# ClawAPI 交接文件

> 日期：2026-03-03 | 摘要：UX 大修完成 + sub-keys 非互動模式
> Git：待 commit | 測試：1653/0 | Build：四平台 ✅ | 全局安裝 ✅

---

## 已完成（前 session）

### UX 大修 — 8 項修復 + MCP 四爽點引導（`b706ed2`）

| 嚴重度 | 問題 | 修法 |
|--------|------|------|
| P0 | ask 說「未設定 Claw Key」 | L3 fallback 到已匯入的 LLM Key |
| P0 | Claw Key 被文字淹沒 | 視覺框框顯示 |
| P0 | 命名混亂 | 澄清 + fallback 消除 |
| P1 | status 說「已停止」 | 加 MCP (stdio) 模式 |
| P1 | 驗證失敗沒下一步 | 碰壁引導（爽點③） |
| P1 | 多人分發沒提到 | Sub-Key 提示 |
| P2 | L 層級沒說明 | 人話對照 |
| P2 | Claw Key 無法重看 | status 顯示遮罩版 |

---

## 已完成（本 session）

### P1-2 + P1-5：sub-keys CLI 非互動模式

`clawapi sub-keys issue` 現在支援非互動 CLI 旗標：

```bash
# 最簡（只需 --label）
clawapi sub-keys issue --label "龍蝦001"

# 完整參數
clawapi sub-keys issue --label "朋友A" --expire 7 --limit 50 --rate 120 --services "groq,openai"

# JSON 輸出（適合腳本/程式解析）
clawapi sub-keys issue --label "API" --json
```

**旗標：**
| 旗標 | 預設值 | 說明 |
|------|--------|------|
| `--label` | 必填 | 標籤名稱 |
| `--expire` | 30 | 有效期（天），0 = 永久 |
| `--limit` | 100 | 每日用量上限，0 = 無限 |
| `--rate` | 60 | 每小時速率限制，0 = 無限 |
| `--services` | 全部 | 允許的服務（逗號分隔） |

**同時修復：**
- `clawapi sub-keys issue --help` 顯示子命令用法
- `clawapi sub-keys --help` 顯示子命令總覽
- `clawapi --help` 有命令時不再攔截，交給子命令處理

**改動檔案（3 檔）：**
- `cli/index.ts` — `isValueFlag()` 加入 5 個旗標 + `--help` 邏輯修正
- `cli/commands/sub-keys.ts` — 非互動模式 + help 畫面
- `cli/__tests__/cli.test.ts` — 8 個新測試

**驗證：** 1653 tests / 0 fail | 四平台 build ✅ | 全局安裝 ✅ | CLI 實測 ✅

---

## 未完成

- 無（UX 回報的 11 個問題已全部處理完畢）
  - P2-2（doctor port WARN）已在 v0.1.12 修好

---

## 測試員下次測試重點

1. `clawapi sub-keys issue --label "test" --json` → 不問問題直接出 JSON
2. `clawapi sub-keys issue` → 維持互動模式（向後相容）
3. `clawapi sub-keys issue --help` → 顯示旗標用法
4. `clawapi sub-keys --help` → 顯示子命令總覽

---

*交接人：Claude Code（老大）| 2026-03-03*
