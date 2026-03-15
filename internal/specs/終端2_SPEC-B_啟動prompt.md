# 終端 2 啟動 Prompt — SPEC-B VPS 服務規格書

> 複製以下內容，貼到新的 Claude Code 終端。

---

```
你是 ClawAPI 的首席架構師，現在要寫 SPEC-B：VPS 服務規格書。

## 背景

ClawAPI 是一個開源的 AI API 鑰匙管理器 + 智慧路由器。
VPS 服務是 tkman 控制的閉源部分，提供集體智慧、互助配對、公共 Key 管理等功能。
VPS 是整個生態的「大腦」，但設計上龍蝦離線也能正常使用（VPS 只是加分項）。

技術棧：Bun + Hono + SQLite（或 PostgreSQL）+ TypeScript + Docker

VPS 環境：
- 主機：washin-wt-token（8GB RAM, 160GB SSD）
- 目前跑在：/home/ubuntu/washin-api/（未來 ClawAPI VPS 獨立部署）
- 反向代理：Caddy（Docker 內）
- 域名：api.clawapi.com（規劃中）

## 你的任務

寫 SPEC-B（VPS 服務規格書），這是跑在 tkman VPS 上的閉源部分。

## 必讀文件（先讀完再動筆）

1. 計畫書（170 項已確認決策）：
   ~/Desktop/ClawAPI/docs/ClawAPI_完整計畫書_v1.md

2. 通訊協議（開源引擎 ↔ VPS 的合約）：
   ~/Desktop/ClawAPI/specs/ClawAPI_SPEC-C_通訊協議_v1.md

## 規格書要寫什麼

輸出檔案：~/Desktop/ClawAPI/specs/ClawAPI_SPEC-B_VPS服務_v1.md

### 必須涵蓋的章節：

1. **VPS 架構圖** — 所有模組和它們的關係、Docker Compose 結構
2. **集體智慧分析引擎** — 完整的演算法設計：
   - 資料接收 + 去重 + 驗證
   - 聚合分析（成功率、延遲、服務穩定度）
   - 地區分組分析（asia/europe/americas/other，#88）— 根據 SPEC-C 的 region 欄位分別產生各地區的路由建議
   - 信譽加權（龍蝦數據的可信度評分）
   - 異常偵測（有人灌假數據怎麼識別）
   - 路由建議產生（每小時分析 → 產生推薦清單，每條建議包含 region 欄位）
   - 路由回饋處理（接收 POST /v1/telemetry/feedback 的 positive/negative 回饋，影響下次建議 #86）
   - WebSocket 推送邏輯
3. **L0 公共 Key 管理** — VPS 端的完整設計：
   - Key 儲存 + 加密
   - 下發機制（API 回應 + 快取策略）
   - 額度分配演算法（怎麼分配每日額度給每個龍蝦）
   - 健康監控（Key 快用完 → 通知 tkman）
   - 捐贈 Key 處理流程（POST /v1/l0/donate 的完整驗證邏輯）
4. **互助配對引擎** — 核心演算法：
   - 非同步配對邏輯（收到 POST /v1/aid/request → 回 202 → 配對 → WebSocket 推送 aid_result）
   - ECDH P-256 公鑰管理（VPS 金鑰對 + 龍蝦公鑰儲存 + 金鑰輪換）
   - VPS 中繼流程（WebSocket 轉發，VPS 只做 ECDH 重新加密 payload_key，不碰 payload）
   - 防刷單機制（冷卻期 + 集體智慧交叉驗證）
   - 匿名保護（不洩漏幫助者/被幫助者身份）
   - 負載控制（互助請求限流）
   - 超時處理（30 秒無回應 → 推送 aid_result status=timeout）
5. **雲端備份服務（v1.1+）** — 儲存架構：
   - 備份檔存取（本地 or S3）
   - 配額管理（每個帳號限制多少）
   - Google 帳號綁定驗證
   - 刪除備份（DELETE /v1/backup）
6. **聊天室中繼** — WebSocket 多工設計：
   - 頻道管理
   - 訊息轉發邏輯
   - 線上人數計算（#143）
   - 防洗版
7. **Sub-Key VPS 驗證中繼（#129）**：
   - POST /v1/subkeys/validate 的處理邏輯
   - VPS 透過 WebSocket 問發行者（龍蝦）確認 Sub-Key 狀態
   - 驗證結果快取 5 分鐘
   - 發行者離線時的處理（503）
8. **Claude Bot 六大功能詳細規格**：
   - ① GitHub 管家：Issue 分診規則（用什麼標準判斷 bug/feature/question）、自動回覆模板
   - ② VPS 監控：檢查什麼、多久檢查一次、告警規則、通知管道（Telegram/Discord）
   - ③ Adapter 審核：三層安全掃描的精確規則、通過/不通過的判斷邏輯
   - ④ 龍蝦問題回答：FAQ 知識庫結構、回答模板、什麼時候標記「需要人看」
   - ⑤ 版本發布：完整 SOP（從 tkman 說「發版」到 GitHub Release 的每一步）
   - ⑥ 集體智慧異常告警：什麼指標算異常、告警閾值、通知內容
9. **GitHub Actions 工作流** — 完整的 YAML 規格：
   - PR 測試工作流
   - Adapter 安全掃描工作流
   - 自動發布工作流（push tag → 打包 → Release）
   - 每日健康報告工作流
   - Dependabot 配置
10. **VPS DB Schema** — 完整 SQL：
   - 集體智慧數據表（含 region 欄位）
   - 龍蝦裝置表（含 timezone、region、vps_public_key 欄位）
   - L0 公共 Key 表（含捐贈來源）
   - 互助記錄表
   - 回饋記錄表（telemetry feedback）
   - 備份元數據表
   - Sub-Key 驗證快取表
   - 所有 index + constraint
   - 延遲指標統一用 p95（不是 p99）
11. **VPS API 實作** — 實作 SPEC-C 伺服器端的所有邏輯：
    - 每個端點的處理流程（注意 SPEC-C 新增的端點：devices/reset、auth/google、telemetry/feedback、telemetry/quota、l0/donate、subkeys/validate、DELETE backup）
    - middleware（認證、rate limit、日誌）
    - WebSocket 連線管理 + 頻道多工
    - 互助非同步配對（202 + WebSocket callback）
12. **VPS 監控 + 告警** — 完整的運維設計：
    - 健康檢查端點
    - 指標收集（Prometheus 格式 or 自訂）
    - 告警規則 + 通知管道
    - 日誌策略（保留多久、格式）
13. **VPS 代架服務架構（v1.1+）** — 先規劃好：
    - 多租戶隔離（Docker per tenant or 程序隔離）
    - 收費計算
    - 管理 UI
14. **災難恢復 SOP** — 完整的恢復計畫：
    - DB 備份策略
    - VPS 掛了怎麼恢復
    - 資料遷移流程
15. **部署流程** — 從 git push 到上線：
    - Docker Compose 配置
    - Caddy 設定
    - 環境變數清單
    - 部署檢查清單
16. **安全加固** — VPS 端的安全措施：
    - 防 DDoS
    - Rate Limit 實作（SPEC-C 的完整 Rate Limit 表）
    - 日誌敏感資料遮罩
    - 龍蝦數據隔離
    - ECDH P-256 VPS 金鑰對管理（產生、儲存、輪換）

### 寫作風格：

- 精確到可以直接拿來寫程式碼的程度
- 每個演算法用虛擬碼或 TypeScript 寫清楚
- 每個判斷條件都有明確的閾值和數字
- 用程式碼區塊定義所有介面和 SQL
- GitHub Actions YAML 要能直接複製使用
- Claude Bot 的回覆模板要寫出具體範例

### 注意事項：

- SPEC-C 通訊協議是合約，VPS 端的實作必須完全符合 SPEC-C 的型別定義
- @clawapi/protocol 共享型別包已在 SPEC-C 附錄 B 定義，直接引用不要重複定義
- SPEC-C 的互助已改為非同步（202 + WebSocket callback），不是同步 200
- SPEC-C 新增了 region 欄位（裝置註冊 + 路由建議），VPS 要分區分析和推送
- SPEC-C 新增了 ECDH P-256 公鑰交換機制，VPS 要管理自己的金鑰對 + 中繼時重新加密
- SPEC-C 新增了路由回饋端點（POST /v1/telemetry/feedback），VPS 要收集並影響下次建議
- SPEC-C 新增了 Sub-Key 驗證中繼（POST /v1/subkeys/validate），VPS 要透過 WebSocket 問發行者
- 集體智慧上報頻率：每 1 小時（不是 15 分鐘）
- 延遲指標統一用 p95（不是 p99）
- 集體智慧演算法是護城河，要寫得夠精確但也要留空間迭代
- Claude Bot 是讓 tkman 幾乎不用管日常事務的關鍵，要寫清楚
- VPS 目前是 8GB RAM，所有設計都要在這個限制內跑得動
- 規格書裡的中文註釋要用繁體中文

## 工作方式

你是 Opus，底下帶 Sonnet 子代理。
- Opus 負責：VPS 架構設計、集體智慧演算法、互助配對引擎、安全模型
- Sonnet 子代理負責：DB Schema SQL、GitHub Actions YAML、Bot 回覆模板、API 端點詳細規格、部署配置

先讀完兩份文件，再開始寫。一次寫完，不要分段問。
```
