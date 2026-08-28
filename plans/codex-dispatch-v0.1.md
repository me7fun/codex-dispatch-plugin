# codex-dispatch v0.1 實作計畫

## 目標
Claude Code plugin：「Claude 寫、Codex 審」的調度規則。官方 codex-plugin-cc 負責與 Codex 溝通（執行期依賴，不 vendor），本 plugin 負責「何時呼叫、失敗怎麼辦、結果怎麼用」。

## 已驗證的技術事實
- 官方 review / adversarial-review / status / result / cancel / transfer 設 `disable-model-invocation: true`（setup、rescue 沒設）。我們需要的 review 類 Claude 不能自己呼叫，故直接執行 `node <官方plugin路徑>/scripts/codex-companion.mjs <subcommand>`。
- 官方 plugin 路徑從 `~/.claude/plugins/installed_plugins.json` 的 `codex@openai-codex[].installPath` 取得：semver 比較取最大、且必須驗證 `installPath/scripts/codex-companion.mjs` 存在。
- 直接呼叫 companion 一律前景執行；`--wait/--background` 對直接呼叫無意義（背景化是 Claude Code Bash 的事），dispatch 不使用。
- `review`：Codex 原生審查，輸出純文字，無 severity 結構。
- `adversarial-review --json [focus]`：結構化 JSON，`result.verdict` ∈ {approve, needs-attention}、`result.findings[].severity` ∈ {critical, high, medium, low}，另有 `file/line_start/line_end/confidence/recommendation`。**注意**：可能 exit 0 但 `result: null` + `parseError` 非空，必須視為失敗（`reason=invalid-output`）。
- `task [--write] [--prompt-file f] [prompt]`：任意文字任務；不加 `--write` 即唯讀。**沒有 output schema 選項**，回傳 JSON 要自己解析＋驗證欄位；失敗 → `reason=invalid-output`。
- 額度（實驗性 API，回應欄位可能變動；程式只讀 primary/secondary.usedPercent、resetsAt、planType、rateLimitReachedType，缺欄位 → unknown）：`codex app-server` stdio JSON-RPC，`initialize` → `initialized` → `account/rateLimits/read`(params null)，回 `result.rateLimits.{primary,secondary}.{usedPercent, windowDurationMins, resetsAt}`、`planType`、`rateLimitReachedType`。查詢不耗 Codex 額度。此 API 為實驗性、官方 plugin 未使用：10 秒 timeout，任何錯誤 → 額度狀態 `unknown`，不擋流程。
- review 類指令需要 git repo（本機 `git init` 即可，不需 commit/remote）。
- Windows 需 `~/.codex/config.toml` 設 `[windows] sandbox = "unelevated"`，否則 Codex 跑 git 被 "blocked by policy" 擋住。
- 官方 review gate 預設關閉；本 plugin 永不開啟。

## 目錄結構
```
codex-dispatch-plugin/
├── .claude-plugin/marketplace.json        # name: codex-dispatch-plugin, plugins: [{name: codex-dispatch, source: ./plugins/codex-dispatch}]
├── README.md
├── plans/                                  # 本專案自己的計畫檔
└── plugins/codex-dispatch/
    ├── .claude-plugin/plugin.json          # name: codex-dispatch, version: 0.1.0
    ├── scripts/
    │   ├── dispatch.mjs                    # CLI 入口（見下）
    │   ├── session-start.mjs               # SessionStart hook 實際執行的程式
    │   └── lib/
    │       ├── companion.mjs               # 解析官方 plugin 路徑、spawn codex-companion.mjs、統一結果物件
    │       ├── quota.mjs                   # app-server rateLimits 查詢（含 timeout、fail-soft）
    │       ├── config.mjs                  # 讀 <project>/.claude/codex-dispatch.config.json，缺值回預設
    │       └── state.mjs                   # <project>/.claude/state/codex-dispatch.json：未審清單、輪次計數（atomic write、條目帶時間戳；不自動刪除，>24h 標 stale）
    ├── skills/dispatch/SKILL.md            # 調度規則正本（給 Claude 常駐讀的規則，user-invocable: false）
    ├── commands/
    │   ├── setup.md                        # 檢查：官方 plugin 已裝 / codex 登入 / git repo / Windows sandbox 設定；預設只印出 CLAUDE.md 段落，加 --write 才寫入
    │   ├── status.md                       # 顯示 Codex 額度 + 未審清單
    │   └── review.md                       # 手動觸發一次 dispatch review（給人用）
    └── hooks/hooks.json                    # SessionStart：只注入一行「本專案啟用 codex-dispatch，規則見 skill」；不查額度（避免啟動延遲）；fail-soft
```

## dispatch.mjs 子指令（全部支援 --json；exit code 0 成功、1 Codex 失敗、2 本地錯誤如找不到官方 plugin）
| 子指令 | 做什麼 | 底層 |
|---|---|---|
| `resolve` | 印官方 plugin 路徑與版本 | installed_plugins.json |
| `quota` | 額度快照 | app-server rateLimits/read |
| `preflight` | 綜合檢查（官方 plugin、codex login、git repo、Windows sandbox、額度） | setup --json + quota |
| `review [--adversarial] [--base ref] [--scope s] [--allow-secrets] [focus]` | 送審 diff；先查額度、擋疑似機密檔（.env/*.pem/credentials…）；失敗再查一次額度判因；回統一結果 | companion review / adversarial-review --json |
| `plan-review <file>` | 用固定 prompt 請 Codex 審計畫檔；要求回 JSON（同 review schema），自行解析驗證 | companion task（唯讀）--prompt-file |
| `rescue [--write] [prompt]` | 轉送救援。**預設唯讀**（診斷＋提出 patch 建議）；`--write` 只在使用者明確同意讓 Codex 改碼時由 SKILL 加上 | companion task [--write] |
| `state [--add-unreviewed <desc>] [--clear] [--list]` | 未審清單維護；條目存 repoRoot、HEAD sha、scope、changed paths、reason、createdAt | state.mjs |

### 統一結果物件
```json
{ "ok": true|false, "kind": "review|plan-review|rescue", "reason": null|"quota"|"codex-error"|"invalid-output"|"local-error",
  "quota": { "status": "available|exhausted|unknown", "usedPercent": 12, "resetsAt": "2026-09-27T…", "planType": "free" },
  "verdict": "approve|needs-attention"|null, "findings": [...], "raw": "<原始輸出>", "error": "<stderr 摘要>"|null }
```

## 設定檔 `.claude/codex-dispatch.config.json`（全部可省略）
```json
{ "quotaThreshold": 95, "lineThreshold": 50, "fileThreshold": 3, "maxRounds": 3,
  "onCodexUnavailable": "auto", "reviewMode": "adversarial", "planDir": "plans" }
```
- `onCodexUnavailable`: `auto`（審 diff→C、審計畫/rescue→B）| `ask`（全 B）| `continue`（全 C）
- 額度判定：`rateLimitReachedType` 非 null 或任一窗口 `usedPercent ≥ quotaThreshold` → `exhausted`；查詢失敗/欄位缺 → `unknown`（照常送審，交給失敗處理）
- `reviewMode`: `adversarial`（結構化，自動迴圈用）| `native`（純文字，只呈現不自動修）

## SKILL.md 規則（摘要，正本寫在 skill）
1. Claude **估計**改動 >lineThreshold 行或 >fileThreshold 檔（或使用者直接說「先寫計畫」）：先寫計畫到 planDir → `dispatch plan-review` → 採納合理意見 → 實作。
2. 實作完成：`dispatch review`。critical/high → 修正後重送，最多 maxRounds 輪；每輪修完若專案有測試就跑；同一 finding（file+title）連續兩輪出現 → 視為無進展，停止並交使用者。medium/low → 列出交使用者決定，不自行修。
3. 同一 bug 修 2 次失敗 → `dispatch rescue`（唯讀）。Codex 提出的修法由 Claude 套用；只有使用者明說「讓 Codex 直接改」才加 `--write`。
4. 使用者說「嚴格審查／上線前檢查」→ `dispatch review --adversarial` 並加 focus。
5. 小改動（字串、參數、樣式、註解）不送審。
6. 失敗處理：依 `ok=false` 的 `reason` 與呼叫類型：
   - 審 diff：C——記入未審清單（`dispatch state --add-unreviewed`），繼續工作。
   - 審計畫／rescue：B——dispatch.mjs 只回 `ok=false`；由 SKILL 層寫 `.claude/state/codex-pending.md`（做到哪、卡在哪、resetsAt）並 AskUserQuestion：等你回來 / 跳過照 C / 停止。非互動環境（無法提問）退化為 C。
   - 絕不無限重試；非額度原因最多重試 1 次。
7. 收工前：未審清單非空 → `dispatch quota` → 恢復則補審（仍受 maxRounds）；否則最終回覆以醒目標題「⚠ 未經 Codex 審查」逐項列出（含原因、重置時間）。
8. 本流程的「critical/high 自動修正」優先於官方 codex-result-handling skill 的「審完 STOP」規則。

## setup 產出的 CLAUDE.md 段落
預設印出讓使用者自己貼；`--write` 才寫入。以 `<!-- codex-dispatch:start/end -->` 標記包住，僅 5 行：啟用宣告、規則正本位置（skill）、設定檔位置、失敗策略一句話、「規則寫給 Claude 看，使用者照常下指令」。

## 測試計畫（手動，本 repo 自身 dogfood）
- `dispatch resolve / quota / preflight --json` 各跑一次。
- `dispatch review` 對本 repo 未 commit 改動跑一次，確認 findings 解析。
- `dispatch plan-review plans/codex-dispatch-v0.1.md`。
- 模擬失敗：`codex logout` 後跑 `dispatch review`，確認 `ok=false, reason=codex-error`、exit 1、不重試超過 1 次；再 `codex login`。
- 模擬額度：暫時設 `quotaThreshold: 0`，確認 preflight 擋下並回 `reason=quota`。

## 計畫審查紀錄
- 2026-08-28 Codex plan-review（task 唯讀）：needs-attention，14 條；全部採納或半採納，已反映於本文。
- 2026-08-28 實作後 dispatch plan-review（自家 CLI）：needs-attention，5 條。採納：目錄補 session-start.mjs、額度 API 契約註記、送審範圍含使用者既有變更須告知（寫入 SKILL）、機密檔防護（--allow-secrets）、未審條目不自動刪除。
- 2026-08-28 實作 diff 審查：round 1 → 3 HIGH（plan 路徑逃逸、--retries Infinity、Windows TOML 重複表）已修；round 2 → 2 HIGH（symlink 覆寫、TTL 靜默丟失義務）已修、1 MEDIUM（review 成功清空無關條目）改為只清涵蓋條目；round 3 → 2 HIGH（機密閘門未涵蓋 --base/branch 與 plan/prompt 檔、maxRounds 未由 CLI 強制）已修但**已達 maxRounds，未再送審**（標記：未經 Codex 審查）、1 MEDIUM（state 並行鎖，第二次出現）→ 使用者決定修。
- 2026-08-28 第二個 cycle（加 lockfile 後）：round 1 → 2 HIGH（rename 繞過機密閘門、輪次檢查與遞增不原子）已修；round 2 → 1 HIGH（額度不足也佔輪次）已修（quota/local-error 退回輪次）；round 3 → 2 HIGH：branch scope 找不到 base 時 fail-closed 已修（**未再送審**）、多 session 同時審時 approve 清掉他人計數（邊角案例）交使用者決定。

## 不做（v0.1）
- review gate、cloud task、fast mode、transfer。
- 自動等待額度重置（改用 state 檔 + 下次 session 接手）。
- Codex 寫程式（只審不寫，rescue 除外）。
