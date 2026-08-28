# codex-dispatch-plugin

Claude Code plugin：**「Claude 寫、Codex 審」的調度規則**。

- 官方 [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 負責「怎麼跟 Codex 溝通」。
- 本 plugin 負責「**何時**呼叫、**失敗**怎麼辦、**額度**怎麼顧、結果怎麼用」——規則寫給 Claude 看，使用者照常下指令，不需背任何 Codex 指令。
- 單向：Claude Code 呼叫 Codex，Codex 只審不寫（救援也預設唯讀）。

## 為什麼用它，而不是直接裝官方 plugin 就好

官方 plugin 給你的是幾個 slash command——**要記得打、要自己判斷什麼時候打、失敗了自己處理**。本 plugin 把這些變成規則與護欄：

- **不用背指令**：規則在 SessionStart 注入、細節在 Skill；你照常說「幫我加 XX」，Claude 自己決定要不要先寫計畫、什麼時候送審、審完怎麼修。
- **Claude 其實叫不到官方指令**：官方 review 類 slash command 設了 `disable-model-invocation`，只能人打。本 plugin 直接呼叫底層 `codex-companion.mjs`，讓「Claude 自動送審」真的成立。
- **額度看得到、也擋得住**：從 Codex app-server 挖出未公開的 `account/rateLimits/read`，送審前先查（不耗額度）；≥95% 直接不送；失敗後再查一次分辨是額度還是連線。官方 issue #102「plugin 內查不到額度」在這裡不存在。
- **絕不卡死、絕不無限重試**：官方 review gate 撞限額會無限迴圈燒掉兩邊額度（issue #306）。本 plugin 永不開 gate；Codex 失敗時審 diff→記入未審清單繼續做、審計畫／救援→問你，重試上限 1 次。
- **Codex 掛了還有第二道**：額度用完時 Claude 開一個獨立的唯讀 subagent 自審（同一套 JSON schema、對抗式 prompt），結果照規則處理，但仍標記「未經 Codex 審查」等額度恢復補審。
- **護欄寫在程式裡，不靠 Claude 自律**：審查輪次上限（CLI 原子強制、多視窗安全）、疑似機密檔擋送（含 rename 繞過）、未審清單不自動消失（只標 STALE）、反接線先預覽再動手。
- **只審不寫**：Codex 額度花在最值得的地方——審計畫、審 diff、找根因；連救援都預設唯讀，由 Claude 套用建議。Plus 方案的 5 小時窗口撐得住。
- **自己審自己長大**：本 repo 從第一行就走這套流程。v0.1 到 v0.1.2 共 10 輪審查（Codex 9 輪 + Claude 自審 1 輪），抓出 20+ 個 HIGH——路徑逃逸、`--retries Infinity`、TOML 寫壞、rename 繞過機密閘門、輪次計數競態、TOCTOU symlink、沒 commit 的專案變終身上限……每一條都在 `plans/` 的審查紀錄裡。

## 它做什麼

| 情境 | 行為 |
|---|---|
| 估計改動 >50 行或 >3 檔 | 先寫計畫 → Codex 審計畫 → 採納後才實作 |
| 實作完成 | Codex 審 diff（結構化 findings）：critical/high 自動修正重審（上限 3 輪、無進展即停）；medium/low 交使用者 |
| 同一 bug 修 2 次失敗 | 交 Codex 救援（唯讀診斷，Claude 套用建議） |
| 使用者說「嚴格審查」 | adversarial review 帶 focus |
| 小改動 | 不送審 |
| **Codex 失敗／額度用完** | 送審前先查額度（不耗額度）；失敗自動分類（額度／連線／輸出壞掉）；審 diff 失敗→**Claude 開獨立 subagent 自審**後記入未審清單繼續做，審計畫／救援失敗→詢問使用者（選項含「改由 Claude 自審」）。**絕不阻塞、絕不無限重試。** 收工前補審或逐項標記「⚠ 未經 Codex 審查（已由 Claude 自審）」 |

## 前置條件

1. Node.js ≥ 18.18
2. Codex CLI：`npm install -g @openai/codex`，並在終端機 `codex login`（ChatGPT 帳號，Free 可用但額度小）
3. 官方 plugin（在 Claude Code 內）：
   ```
   /plugin marketplace add openai/codex-plugin-cc
   /plugin install codex@openai-codex
   ```
   **不要**開啟它的 review gate（撞限額會無限迴圈）。
4. 目標專案是 git repo（本機 `git init` 即可，不需 commit 或 remote；Codex review 靠 git diff 定義「改了什麼」）
5. **Windows 必做**：`~/.codex/config.toml` 加入
   ```toml
   [windows]
   sandbox = "unelevated"
   ```
   否則 Codex 在沙箱裡跑 git 會被 `blocked by policy` 擋住、什麼都審不了。`/codex-dispatch:setup` 會檢查並可代寫。

## 安裝

```bash
claude plugin marketplace add me7fun/codex-dispatch-plugin
# 在目標專案根目錄：
claude plugin install codex-dispatch@codex-dispatch-plugin --scope local
```
然後在 Claude Code 內執行 `/codex-dispatch:setup`：檢查上述前置條件、把 5 行規則段接線到專案 `CLAUDE.md`。

## 指令

| 指令 | 用途 |
|---|---|
| `/codex-dispatch:setup [--write]` | 前置檢查 + 接線 CLAUDE.md |
| `/codex-dispatch:status` | Codex 額度（不耗額度）+ 未審清單 |
| `/codex-dispatch:review [--adversarial\|--native] [--base ref] [--scope s] [focus]` | 手動送審目前改動 |
| `/codex-dispatch:uninstall [--purge-config] [--purge-state]` | 反接線：移除 CLAUDE.md 段（預設只預覽、再確認），可選一併 `claude plugin uninstall` |

平常不需要打指令——SessionStart hook 會注入規則摘要，Claude 依 Skill `codex-dispatch:dispatch` 自動調度。

## 設定（可省略）

`<專案>/.claude/codex-dispatch.config.json`：
```json
{
  "quotaThreshold": 95,
  "lineThreshold": 50,
  "fileThreshold": 3,
  "maxRounds": 3,
  "onCodexUnavailable": "auto",
  "reviewMode": "adversarial",
  "planDir": "plans",
  "selfReview": "auto"
}
```
- `onCodexUnavailable`：`auto`（審 diff→繼續、審計畫/救援→詢問）｜`ask`（全部詢問）｜`continue`（全部繼續）
- `selfReview`：Codex 不可用時的降級——`auto`（審 diff 失敗自動由 Claude 唯讀 subagent 自審）｜`ask`（每次先問）｜`off`。自審過的條目仍留在未審清單（標「[自審]」），額度恢復後仍建議補審。prompt 有三個變體（審 diff／審計畫／rescue 重新診斷）在 `prompts/self-review.md`。手動的 `/codex-dispatch:review` 不會自審，它只回報 Codex 結果。
- `reviewMode`：`adversarial`（結構化 JSON，自動迴圈用）｜`native`（Codex 原生審查，純文字，只呈現不自動修）

## 底層 CLI

所有 Codex 呼叫走 `plugins/codex-dispatch/scripts/dispatch.mjs`（`--json` 回統一結果物件；exit 0 成功、1 Codex 端失敗、2 本地錯誤）：
`resolve` / `quota` / `preflight` / `review` / `plan-review <file>` / `rescue [--write] <prompt>` / `state` / `snippet` / `unwire`。
它會從 `~/.claude/plugins/installed_plugins.json` 找官方 plugin 的 `codex-companion.mjs` 直接執行——因為官方 review 類 slash command 設了 `disable-model-invocation`，Claude 自己呼叫不到。

## 資料與安全

- Codex review 會把 **diff 內容**（含未 commit、未追蹤的檔案）送到 OpenAI；plan-review 送計畫全文。
- CLI 送審前會擋下疑似機密檔（`.env*`、`*.pem/*.key`、`credentials.json`、`auth.json`、`.npmrc`…），回 `local-error`；確認無機密才加 `--allow-secrets`。
- `plan-review` / `--prompt-file` 只接受專案根目錄內的一般檔案（realpath 比對，擋 symlink 逃逸）。
- 未審清單**不會自動清除**（超過 24 小時標示 STALE）——「沒審」是義務，只有補審成功或使用者明確決定才解除。
- 審查輪次計數（同一批未 commit 改動最多 `maxRounds` 輪）：approve 或 commit 開新一輪；7 天沒動自動清除。多個 Claude 視窗同時審同一專案是安全的（跨程序鎖 + 原子佔用）。

## 已知限制

- 額度查詢用的 `account/rateLimits/read` 是 Codex app-server 的實驗性 API；查不到時狀態為 `unknown`，不擋流程。
- 官方 plugin 更新可能改變 `codex-companion.mjs` 的介面；本 plugin 只依賴 `review/adversarial-review/task/setup` 四個子指令與 `--json` 輸出。
- 不做：review gate、cloud task、fast mode、自動等待額度重置（改用未審清單 + 下次 session 接手）。

## 反安裝

```
/codex-dispatch:uninstall
```
只移除 setup 寫進 `CLAUDE.md` 的標記段（先預覽、再確認）。`.claude/codex-dispatch.config.json`（你的設定）與 `.claude/state/`（未審清單）預設保留，要清才加 `--purge-config` / `--purge-state`；`plans/` 永不碰。plugin 本體由指令最後詢問是否執行 `claude plugin uninstall codex-dispatch@codex-dispatch-plugin --scope local`。

底層：`node <plugin>/scripts/dispatch.mjs unwire [--yes] [--purge-config] [--purge-state] [--root <dir>]`。

## 開發

本 repo 用 `plans/` 放計畫、以自身流程 dogfood（計畫先經 Codex 審查再實作）。維護者本機另裝 wiki plugin 做知識庫，相關檔案走 `.git/info/exclude` 不進版控。

**改完怎麼更新到各專案**：安裝本質是「複製到版本化快取」，改原始碼不會自動生效。維護者本機把 marketplace 註冊為目錄（`claude plugin marketplace add <本機路徑>`），改完跑 `node update.js`（bump patch → marketplace update → 對 `projects.local.txt` 列的專案跑 `claude plugin update`）。從 GitHub 安裝的使用者則是 `claude plugin marketplace update codex-dispatch-plugin` + `claude plugin update codex-dispatch@codex-dispatch-plugin --scope local`（需先 push）。
