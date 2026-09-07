# 實作計畫：AI 審查者與規劃者開關（reviewer / planner switches）

> Antigravity CLI 規劃草案（codex-dispatch plan-architect）。conversation：335dad31-7205-4f63-82ee-330e2c357302；產出：2026-09-07T07:24:36.557Z；耗時 143s。
> 草案僅供 Claude 審閱修訂，並需經 Codex plan-review 後才作為實作依據。
> Claude 修訂：(1) `reviewer=claude` 的 review 仍保留 git repo／submodule／diff 目標（`reviewPaths`）檢查，只跳過機密閘門、額度、輪次——自審 subagent 要靠這些知道審什麼；(2) session-start 在 `reviewer=claude` 且未審清單有殘留時提示 `state --clear`（草案「風險」第二點的對策）；(3) 測試加 session-start 輸出案例；(4) `rescue --write` 在 `reviewer=claude` 時同樣回 `reviewer-claude`（沒有 Codex 可寫）。
> 需求：新增「AI 審查者／規劃者開關」設定，讓沒有 Codex 或 Antigravity CLI 的使用者可以關掉外部 AI，流程不變、改由 Claude 自己的唯讀 subagent 自審。請先讀 scripts/lib/config.mjs、scripts/dispatch.mjs（cmdReview / cmdPlanReview / cmdRescue / cmdPlanArchitect /…

## 目標
在 `.claude/codex-dispatch.config.json` 新增 `reviewer`（`"codex"` | `"claude"`，預設 `"codex"`）與 `planner`（`"auto"` | `"off"`，預設 `"auto"`）設定，讓未安裝或不使用 Codex CLI / Antigravity CLI 的使用者能自主關閉外部 AI 呼叫。當切換為 Claude 自審時，流程維持不變，由 Claude 唯讀 subagent 執行自審；此模式為使用者明確決定，完全不發出未經 Codex 審查的警告標題與未審清單。

## 涉及檔案
- `plugins/codex-dispatch/scripts/lib/config.mjs`：新增 `reviewer` 與 `planner` 預設值與 ENUMS 驗證
- `plugins/codex-dispatch/scripts/dispatch.mjs`：調整 `cmdReview`、`cmdPlanReview`、`cmdRescue`、`cmdPlanArchitect`、`cmdPreflight`、`cmdQuota` 與渲染函式
- `plugins/codex-dispatch/scripts/session-start.mjs`：依設定調整 SessionStart 常駐提示標題與說明文字
- `plugins/codex-dispatch/skills/dispatch/SKILL.md`：新增開關專節、更新觸發規則與跳過收工前步驟
- `plugins/codex-dispatch/commands/review.md`：人工觸發 review 在 `reviewer=claude` 時改跑自審 subagent 呈現結果
- `plugins/codex-dispatch/commands/status.md`：補充 `reviewer=claude` 時 quota 與 state 之說明
- `README.md`：設定段增列兩鍵範例與說明
- `plugins/codex-dispatch/test/switches.test.mjs`（新檔）：新增單元測試涵蓋所有新開關情境
- `plugins/codex-dispatch/test/plan-architect.test.mjs`：既有測試回歸驗證

## 步驟

### 1. 設定層支援（`plugins/codex-dispatch/scripts/lib/config.mjs`）
- 在 `DEFAULTS` 物件中新增兩鍵：
  ```javascript
  reviewer: "codex", // codex | claude
  planner: "auto", // auto | off
  ```
- 在 `ENUMS` 物件中新增合法值陣列：
  ```javascript
  reviewer: ["codex", "claude"],
  planner: ["auto", "off"],
  ```
- 在 `loadConfig` 函式中採用現有 ENUMS fail-soft 驗證：
  ```javascript
  reviewer: ENUMS.reviewer.includes(raw.reviewer) ? raw.reviewer : DEFAULTS.reviewer,
  planner: ENUMS.planner.includes(raw.planner) ? raw.planner : DEFAULTS.planner,
  ```

### 2. 調度層分支邏輯（`plugins/codex-dispatch/scripts/dispatch.mjs`）

#### A. `cmdReview`
- 在 `rootsOrFail`、git repo 檢查、`--retries` 驗證、`reviewPaths`（含 `target.resolved` fail-closed）、submodule 守門**之後**，若 `cfg.reviewer === "claude"`：
  - 不執行機密閘門（`secretGate`，內容不外送）
  - 不預檢額度（`quotaFor` / `quotaEarly`）
  - 照常執行本機機械檢查（`cfg.checks` 且未帶 `--skip-checks`）：
    - 若失敗：立即回傳 `reason: "checks-failed"`（exit 2）
  - 不佔輪次（不呼叫 `reserveRound`）、不記未審清單（不呼叫 `addUnreviewed`）
  - 檢查全過或無 checks 時，回傳 `{ ...base("review"), ok: false, reason: "reviewer-claude", checks: checksResults, mode, reviewRoot: roots.reviewRoot, configRoot: roots.configRoot, target }`（由 `exitCodeFor` 決定 exit code 1）

#### B. `cmdPlanReview` 與 `cmdRescue`
- `cmdPlanReview`：
  - 解析輸入檔案 `resolveInputFile` 後，若 `cfg.reviewer === "claude"`：
    - 不走機密閘門、不查額度、不呼叫 companion
    - 直接回傳 `{ ...base("plan-review"), ok: false, reason: "reviewer-claude", target: { mode: "plan", label: resolved.rel }, reviewRoot: roots.reviewRoot, configRoot: roots.configRoot }`（exit 1）
- `cmdRescue`：
  - 驗證 prompt 存在後，若 `cfg.reviewer === "claude"`：
    - 不讀 prompt 檔內容、不走機密閘門、不呼叫 companion
    - 直接回傳 `{ ...base("rescue"), ok: false, reason: "reviewer-claude", write: Boolean(options.write), reviewRoot: roots.reviewRoot, configRoot: roots.configRoot }`（exit 1）

#### C. `cmdPlanArchitect`
- 在 `rootsOrFail` 與 prompt 檢查後，若 `cfg.planner === "off"`：
  - 不呼叫 `findAgy()`、不掃描工作區機密（`gitWorkspaceFiles`）
  - 直接回傳 `{ ...base(K, { reviewRoot: roots.reviewRoot, configRoot: roots.configRoot, prompt }), ok: false, reason: "planner-off", fallback: "claude", error: "planner=off（已停用 Antigravity 規劃層，由 Claude 自行規劃）" }`（exit 1）

#### D. `cmdPreflight` 與 `renderPreflight`
- 在 `renderPreflight` 中，新增狀態圖示映射：`icon = { ok: "✓", warn: "⚠", fail: "✗", skip: "－" }`
- 在 `cmdPreflight` 中：
  - 若 `cfg.reviewer === "claude"`：
    - 將 `companion`、`codexCli`、`codexAuth`、`reviewGate`、`windowsSandbox`、`quota` 全部改為 `{ name, required: false, status: "skip", detail: "reviewer=claude，已停用" }`
    - 不執行 `resolveCompanion`、`runCompanion`、`windowsSandboxCheck`、`quotaFor`
  - 新增 `planner` 檢查項（`required: false`，informational）：
    - 若 `cfg.planner === "off"`：`{ name: "planner", required: false, status: "skip", detail: "planner=off，已停用" }`
    - 若 `cfg.planner !== "off"`：執行 `findAgy()`。若存在回報 `{ status: "ok", detail: "Antigravity CLI agy（${found.bin}）" }`；若找不到回報 `{ status: "warn", detail: "找不到 agy 指令（選配，未裝時自動降級為 Claude 自己寫計畫）", fix: "..." }`
  - `ready` 判斷維持 `checks.every((c) => !c.required || c.status === "ok")`，因此 `status: "skip"` 與 `required: false` 不影響 `ready` 結果

#### E. `cmdQuota` 與 `renderQuota`
- 在 `cmdQuota` 中：
  - 若 `cfg.reviewer === "claude"`，不呼叫 `readQuota`，直接回傳 `{ ok: true, kind: "quota", reason: null, status: "disabled", detail: "reviewer=claude，Codex 額度檢查已停用", quota: null }`
- 在 `renderQuota` 中：若 `r.status === "disabled"` 或 `!r.quota`，輸出 `"Codex 額度檢查已停用（reviewer=claude）\n"`

### 3. 常駐提示更新（`plugins/codex-dispatch/scripts/session-start.mjs`）
- 引入 `loadConfig`：`const { config: cfg } = loadConfig(root);`
- 若 `cfg.reviewer === "claude"`：
  - 標題由 `"[codex-dispatch] 本專案啟用「Claude 寫、Codex 審」："` 改為 `"[codex-dispatch] 本專案啟用 Claude 自審（Codex 已停用）："`
  - 審 diff 項目中的「送 Codex 審 diff」文字換成「自審 diff（上限 2 輪）」
  - 救援項目中的「交 Codex 救援」換成「自審救援」
  - 移除 Codex 失敗處理條目，改為「- 自審不佔 Codex 額度、不進未審清單。」
- 若 `cfg.planner === "off"`：
  - 第一條規劃條目中完全不提及 Antigravity CLI / agy，改為「→ 先寫計畫 → 審閱修訂 → ...」
- 若 `cfg.reviewer === "claude"` 且未審清單 `pending > 0`：改提示「⚠ 未審清單殘留 N 筆（reviewer=claude 不再補審）；確認不需要後 `state --clear`」，取代原本的「待補審」字樣。
- `loadConfig` 失敗（壞檔）走現有 fail-soft 回預設，不影響 hook 輸出。

### 4. 調度規則文件（`plugins/codex-dispatch/skills/dispatch/SKILL.md`）
- 在頂部設定清單後新增章節 `## 審查者／規劃者開關`：
  - 詳述 `reviewer`（`codex` | `claude`）與 `planner`（`auto` | `off`）各模式行為
  - 明確強調：`reviewer=claude` 是使用者自主決定，全程「完全不提醒」（不加標題、不記入未審清單、Stop hook 不擋、回覆不標 Claude 自審）
- 在 `## 觸發規則`：
  - 規劃草案：註明 `planner=off` 時直接由 Claude 自己寫計畫
  - 審計畫、審 diff、救援：註明若 `reviewer=claude` 則改走唯讀 Explore subagent 自審流程（引用 `prompts/self-review.md` 對應變體，自審上限 2 輪，findings 處置規則相同）
- 在 `## 收工前`：
  - 於第 1 步前加入短路規則：若 `reviewer=claude`，收工前步驟直接跳過（不產生未審清單、不補審、不標記）

### 5. Slash Commands 調整
- `plugins/codex-dispatch/commands/review.md`：
  - 在第 2 步呈現邏輯中新增：若收到 `reason=reviewer-claude`，改為啟動 Explore 唯讀 subagent 執行 `prompts/self-review.md` 的「A. 審 diff」變體，並把結果原樣呈現；人工觸發仍不自動修碼，不記入未審清單
- `plugins/codex-dispatch/commands/status.md`：
  - 補充說明：在 `reviewer=claude` 模式下，quota 顯示已停用為正常現象，不需連線 Codex

### 6. 說明文件更新（`README.md`）
- 在 `## 設定（可省略）` 區塊：
  - JSON 範例中加入 `"reviewer": "codex"` 與 `"planner": "auto"`
  - 說明列表加入 `reviewer`（`codex` 預設；`claude` 關閉外部 AI、改走唯讀 subagent、完全不發警告標題）與 `planner`（`auto` 預設；`off` 停用 agy 規劃層）

### 7. 測試套件實作（`plugins/codex-dispatch/test/switches.test.mjs`）
- 採用 `node:test` 與 `node:assert/strict`，沿用 `plan-architect.test.mjs` 假專案隔離輔助函式（`makeProject`、`tmpDir`、`git`）：
  - 測試案例 1（`reviewer=claude` 下 `review`）：
    - 設置空目錄為 `CLAUDE_CONFIG_DIR`（無官方 companion）
    - 配置 `.claude/codex-dispatch.config.json` 為 `{"reviewer":"claude"}`，配置本機 checks
    - 驗證 exit code 為 1，不回 `local-error`，回傳 `reason: "reviewer-claude"`，且 `checks` 成功執行
    - 驗證 checks 失敗時仍回傳 `reason: "checks-failed"`（exit 2）
  - 測試案例 2（`reviewer=claude` 下 `plan-review` 與 `rescue`）：
    - 在無 companion 環境下分別執行 `plan-review` 與 `rescue`，驗證皆回傳 exit code 1 與 `reason: "reviewer-claude"`
  - 測試案例 3（`planner=off` 下 `plan-architect`）：
    - 配置 `{"planner":"off"}`，注入帶有計數記號的假 agy 腳本
    - 執行 `plan-architect`，驗證回傳 exit code 1、`reason: "planner-off"`、`fallback: "claude"`，且假 agy 記號檔未被產生（未被呼叫）
  - 測試案例 4（`preflight` 寬鬆放行）：
    - 在 `reviewer=claude` 且 `CLAUDE_CONFIG_DIR` 與 `CODEX_HOME` 皆為空目錄下執行 `preflight`
    - 驗證 exit code 為 0，`ok: true`
    - 驗證 `companion`、`codexCli`、`codexAuth`、`reviewGate`、`windowsSandbox`、`quota` 之 status 皆為 `"skip"`、`required: false`
    - 驗證 `planner` 項目存在（`planner=off` 時 status 為 `"skip"`）
  - 測試案例 5（非法值 fail-soft 退回預設）：
    - 設定檔寫入非法值（`{"reviewer":"unknown","planner":"bad"}`）
    - 驗證退回預設值（`preflight --json` 的 `config.reviewer === "codex"`、`config.planner === "auto"`）
  - 測試案例 6（session-start 輸出）：
    - 以 `{"reviewer":"claude"}` 接線的假專案，`echo '{"cwd":"<dir>"}' | node session-start.mjs`：`additionalContext` 含「Claude 自審（Codex 已停用）」、不含「送 Codex」；再放一個含 1 筆 unreviewed 的 state 檔 → 含「殘留」與 `state --clear`
    - `{"planner":"off"}` → 不含「Antigravity」
  - 測試案例 7（`rescue --write` 在 `reviewer=claude`）→ `reviewer-claude`

## 測試方式
- 執行新開關測試套件：
  `node --test plugins/codex-dispatch/test/switches.test.mjs`
- 執行既有規劃層測試套件確保無回歸：
  `node --test plugins/codex-dispatch/test/plan-architect.test.mjs`
- 執行全指令語法檢查：
  `node --check plugins/codex-dispatch/scripts/dispatch.mjs`
  `node --check plugins/codex-dispatch/scripts/session-start.mjs`
  `node --check plugins/codex-dispatch/scripts/lib/config.mjs`

### 8. Stop hook 尊重設定（`plugins/codex-dispatch/scripts/stop-gate.mjs`）——plan-review 採納
- `gate` 讀規則根後先 `loadConfig(root)`（import `./lib/config.mjs`，任何錯誤 fail-soft 當 `codex`）；`reviewer === "claude"` → 直接放行並清 touched 旗標，**不刪 state**（殘留條目保留給使用者自己決定）。`mark` 不變。
- 測試（新 `test/stop-gate.test.mjs`，直接以 stdin JSON 呼叫腳本）：reviewer=claude ＋ 既有 1 筆未審 ＋ 無標題 → `{}` 放行；reviewer=claude ＋ 壞掉的 state 檔 → 放行；reviewer=codex ＋ 1 筆未審 ＋ 無標題 → block（回歸）。

### 9. 自審交接要帶目標（`prompts/self-review.md` A 變體、SKILL、commands/review.md）——plan-review 採納
- CLI 回 `reviewer-claude` 時**附上** `target`（`{mode:"working-tree"|"branch", label, base, scope}`）、`reviewRoot`、`checks`；`renderFailure` 在 reason 為 `reviewer-claude` 時印出 `Target:` 與 `Root:`。
- self-review.md A 變體的枚舉步驟改為依 `{{TARGET}}` 分流：working tree → `git status --short --untracked-files=all`、`git diff`、`git diff --cached`、讀 untracked；branch／base → `git diff --name-status <base>...HEAD` 與 `git diff <base>...HEAD`（**不看** working tree）。新增佔位符 `{{ROOT}}`（在該目錄執行）。
- SKILL 與 commands/review.md：呼叫 CLI 一律 `--json`，把 `target.label`／`target.base`／`reviewRoot` 填進 prompt。
- 測試：乾淨 feature branch（commit 後 working tree 無變更）跑 `review --base main` → 回 `reviewer-claude` 且 `target.mode==="branch"`、`target.base==="main"`。

### 10. session-start 措辭（plan-review 採納）
- 規劃條目拆成三段各自依設定：`planner` 決定「先 plan-architect／先寫計畫」，`reviewer` 決定「送 Codex 審計畫／自審計畫」；四種組合都測（reviewer×planner）。

### 11. README 措辭（plan-review 採納）
- `reviewer=claude` 只停用 **Codex 審查與救援**；要完全不用外部 AI 要同時 `"planner": "off"`，範例明列兩鍵都關的組合。

## 不做什麼
- 不修改 `plugins/codex-dispatch/scripts/lib/state.mjs` 的資料結構與存取 API；Stop hook 只讀設定，不刪 state
- 不新增任何 slash command（例如 `/codex-dispatch:switch`）
- `prompts/self-review.md` 只改 A 變體的枚舉步驟與佔位符，B／C 不動
- 不在 `reviewer=claude` 時呼叫 Codex 額度查詢 API 或佔用審查輪次

## 風險與未知
- **多 repo / submodule 佈局**：在 submodule 中使用 `reviewer=claude` 時，雖然跳過 Codex，但仍依賴 `rootsOrFail` 解析審查根與規則根。若 submodule 尚未初始化，仍會提示 `git submodule update --init`，此為預期防禦。
- **既有未審殘留**：使用者在 `reviewer=codex` 時殘留未審條目、之後切到 `claude`——Stop hook 改為看設定放行（步驟 8），殘留條目保留；session-start 仍提示可 `state --clear`（步驟 3）。

## 計畫審查紀錄
- 2026-09-07 dispatch plan-review：needs-attention，2 HIGH ＋ 2 MEDIUM，全採納：(1) Stop hook 不看設定，殘留未審條目會照擋且反覆擋 → stop-gate 讀 `loadConfig`，`reviewer=claude` 放行不刪 state，補 hook 測試；(2) 自審 prompt A 變體只看 working tree，`--base`／`--scope branch` 會審到空 diff → CLI 回 `target`／`reviewRoot`，prompt 依目標分流枚舉，補乾淨分支測試；(3) session-start 的「送 Codex 審計畫」沒隨 reviewer 換 → 規劃條目拆三段依設定組合，四種組合都測；(4) README「關閉外部 AI」過頭 → 改為只停用 Codex 審查／救援，範例列兩鍵都關。

## 計畫審查紀錄
- 2026-09-07 dispatch review（adversarial、round 1/3，checks 29 pass／1 skip）：approve，0 findings。
