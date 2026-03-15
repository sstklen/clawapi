# ClawAPI 專案

> 🦞 開源 AI API 鑰匙管理器 + 智慧路由器
> 狀態：規劃階段（規格書撰寫中）
> 授權：AGPL-3.0

## 專案結構

```
ClawAPI/
├── CLAUDE.md              ← 你在這裡
├── docs/                  ← 計畫書 + 研究文件
│   ├── ClawAPI_完整計畫書_v1.md        ← v4.0，170 項決策（最重要）
│   ├── ClawAPI_完整計畫書_v1.md.bak-original  ← v3.0 備份
│   ├── OpenClaw_競爭態勢分析_2026-02.md       ← 競品研究
│   └── OpenClaw_完整計畫書_v1.md              ← 舊版計畫書（改名前）
├── specs/                 ← 規格書（開工的依據）
│   ├── ClawAPI_SPEC-C_通訊協議_v1.md   ← 開源引擎 ↔ VPS 的合約（已完成）
│   ├── ClawAPI_SPEC-A_開源引擎_v1.md   ← 開源部分規格（撰寫中）
│   ├── ClawAPI_SPEC-B_VPS服務_v1.md    ← 閉源部分規格（撰寫中）
│   ├── 終端1_SPEC-A_啟動prompt.md      ← 終端 1 的啟動指令
│   └── 終端2_SPEC-B_啟動prompt.md      ← 終端 2 的啟動指令
└── src/                   ← 程式碼（還沒開始）
```

## 文件優先級

1. **計畫書** = 最高權威（170 項決策都是 tkman 確認的）
2. **SPEC-C** = 合約（開源和閉源兩邊都要遵守）
3. **SPEC-A / SPEC-B** = 實作依據（從計畫書和 SPEC-C 推導出來的）

## 技術棧

- Runtime: Bun
- Framework: Hono
- DB: SQLite（本機）/ SQLite or PostgreSQL（VPS）
- Language: TypeScript
- 打包: Bun compile（四平台可執行檔）
- 容器: Docker + Docker Compose
- CI: GitHub Actions

## 產品架構

```
開源（龍蝦本機）     合約        閉源（tkman VPS）
 SPEC-A          SPEC-C          SPEC-B
   │               │               │
   └───── 通訊 ────┘───── 通訊 ────┘
```

## 關鍵規則

- Key 永遠不過 VPS（鐵律 1）
- VPS 看不到 API 內容（鐵律 2）
- 龍蝦離線照常工作（鐵律 3）
- 所有中文用繁體中文
- 程式碼註釋用繁體中文
