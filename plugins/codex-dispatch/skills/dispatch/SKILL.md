---
name: dispatch
description: 「Claude 寫、Codex 審」調度規則正本：何時送 Codex 審計畫／審 diff／救援、findings 怎麼處理、Codex 失敗怎麼辦。動工前、實作完成要送審、或 Codex 呼叫失敗時載入。
user-invocable: false
---

# codex-dispatch 調度規則

前提：官方 `codex@openai-codex` 已安裝、Codex CLI 已登入、專案是 git repo。不確定就先跑 preflight。
所有 Codex 呼叫一律透過本 plugin 的 CLI，**不要**直接呼叫官方 `/codex:*` slash command（review 類設了 `disable-model-invocation`，Claude 呼叫不到）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" <子指令> --json ...
```

子指令：`preflight`、`quota`、`review`、`plan-review <file>`、`rescue [--write] <prompt>`、`state`、`snippet`。一律前景執行（不要 `run_in_background`），review 通常 30–120 秒。
設定檔 `<專案>/.claude/codex-dispatch.config.json`（缺檔用預設）：`quotaThreshold=95`、`lineThreshold=50`、`fileThreshold=3`、`maxRounds=3`、`onCodexUnavailable=auto`、`reviewMode=adversarial`、`planDir=plans`、`selfReview=auto`、`confidenceThreshold=0.75`。

## 分工
- Claude（我）：規劃、架構、實作、套用修正。
- Codex：審計畫、審 diff、深度找 bug、救援診斷。**只審不寫**——除非使用者明說「讓 Codex 直接改」，否則不加 `--write`。

## 觸發規則
1. **估計**改動 > `lineThreshold` 行或 > `fileThreshold` 個檔案，或使用者直接說「先寫計畫」：
   a. 寫計畫到 `<planDir>/<slug>.md`（目標、涉及檔案、步驟、測試方式、不做什麼）。
   b. `plan-review <planDir>/<slug>.md --json`。採納合理意見修訂計畫（在計畫尾端記一行審查紀錄），再開始實作。
2. 實作完成（尚未 commit）：`review --json`（預設 adversarial 模式＋內建嚴重度校準：HIGH 只算單人正常操作會碰到的缺陷，多 session／極端時序最高 MEDIUM，confidence 低於門檻的另列 `lowConfidence` 不自動修，沒有 HIGH 就 approve）。
   - 送審範圍是整個 working tree：若 `git status` 顯示有**不是我這次改的**未提交變更，先告知使用者「這些會一起被審」；要只審某段就用 `--base <ref>`／`--scope branch`。
   - **submodule／多 repo 佈局**（例如 client 根下 `games/<game>/` 各是自己的 repo，而規則、plans/、設定都在 client 根）：CLI 用**雙根**——**審查根**＝改動所在的 repo（diff、HEAD、輪次以它為準），**規則根**＝從審查根往上找到的已接線目錄（設定檔、CLAUDE.md 規則、state 檔都在這）。我要做的只有一件事：review／plan-review／rescue／state 一律加 `--cwd <改動所在 repo 目錄>`（例如 `--cwd games/slot-fe-xxx`）。檔案引數（計畫檔、prompt 檔）相對我目前的 cwd 解析，放規則根的 `plans/` 即可。從上層 repo 送審 git 只看到子模組指標，CLI 會拒絕並提示；未初始化的 submodule 也會直接報錯要求 `git submodule update --init`。各 sub-repo 的 state／輪次／未審清單獨立，集中存在規則根 `.claude/state/codex-dispatch/`；在規則根跑 `state --list` 會列出全部。
   - CLI 會擋下疑似機密檔（.env、*.pem、credentials.json…），回 `local-error`：請使用者處理（移除／gitignore），不要自行加 `--allow-secrets`。
   - **機械檢查先行（ground truth）**：若規則根有 `.claude/codex-dispatch.local.json` 的 `checks`（test／lint／typecheck；此檔不進 git，只有使用者自己能設），CLI 會先跑，任一失敗回 `reason=checks-failed`（exit 2）且**不送 Codex、不佔輪次**——這是確定的失敗，先修到通過再送；不要加 `--skip-checks`，除非使用者明說。全過的結果會附進 prompt 當 Codex 的根據。專案沒設 checks 但有測試指令時，建議使用者設一次。
   - `critical` / `high`：**先驗證再修**——照 finding 的 body 複現失敗情境（讀碼、跑測試、或寫最小重現）；複現得了才修，複現不了就降為 medium 列給使用者並說明為什麼。（研究顯示 Codex 審 Claude 的碼會過度修正，把沒問題的改壞；驗證是防線。）**只改 finding 指到的位置與必要的關聯處**，不重寫、不順手重構其他地方——下一輪抓到的「修正引入的新 bug」多半來自順手改。修正後重送 `review`。
   - 上限 `maxRounds` 輪——**CLI 會強制**：同一批改動（repo + HEAD + 目標）送審達上限就回 `local-error`（訊息含 maxRounds）。**到頂就真的停：剩下的 critical/high 只呈現、不修**，由使用者決定；使用者說修 → 修完 commit 開新一輪正常審。不要「順手修掉再記未審」——那會製造永遠審不完的尾巴。不要加 `--reset-rounds` 自行續審。`verdict=approve` 或 commit 後自動開新一輪。
   - **同一 finding（file + title 相同）連續兩輪都出現 → 視為無進展，停止並交使用者裁決。**
   - `medium` / `low` / `lowConfidence`：列出交使用者決定，不自行修改。
3. 同一個 bug 嘗試修復 2 次仍失敗：停止嘗試，`rescue "<症狀、已試過什麼、相關檔案>" --json`（唯讀）。Codex 回的診斷／patch 建議由我套用。
4. 使用者說「嚴格審查」「上線前檢查」：`review --strict "<focus>" --json`（全對抗、不校準）。**只跑一次、不進迴圈**：結果整份呈現給使用者決定，不自動修（社群的「收斂後最終稽核」模式）。
5. 小改動（字串、參數、樣式微調、註解、單檔 < 20 行）不送審。
6. 官方 `codex-result-handling` skill 的「審完 STOP、不得自動修」規則**不適用**於本流程的 critical/high 自動修正；本 skill 優先。

## 結果物件（`--json`）
```
ok, kind(review|plan-review|rescue), reason(null|quota|codex-error|invalid-output|local-error),
quota{status(available|exhausted|unknown), usedPercent, resetsAt, planType}, verdict, summary, findings[], nextSteps[], raw, error, attempts
```
exit code：0 成功；1 Codex 端失敗；2 本地錯誤（先修環境，例如未安裝官方 plugin、不是 git repo）。

## 失敗處理（最重要）
CLI 已內建：送審前查額度（`exhausted` 直接不送）、非額度失敗自動重試 1 次、失敗後再查一次額度判因。我收到 `ok=false` 後**不再重試**，依 `reason` 與呼叫類型處理：

| 呼叫 | `onCodexUnavailable=auto` 時 | 說明 |
|---|---|---|
| 審 diff（review） | **C：繼續** | Codex 輸出不是下一步的原料。`selfReview=auto` → 先做一次「Claude 自審」（下節），再 `state --add-unreviewed "<改了什麼>" --reason <reason> --error "<error>" --self-reviewed`；`ask` → AskUserQuestion 問一次要不要自審（無法提問就不自審）；`off` → 直接記入（不加 `--self-reviewed`）。告知使用者一句，繼續原本工作。 |
| 審計畫（plan-review） | **B：詢問** | Codex 輸出是下一步的原料。寫 `.claude/state/codex-pending.md`（做到哪、卡在哪、reason、resetsAt），AskUserQuestion 四選一：「改由 Claude 自審計畫後繼續（Recommended）」「跳過審查照 C 繼續」「等你回來再說（停止）」「停止」（`selfReview=off` 時拿掉第一個選項）。無法提問的環境退化為 C。 |
| 救援（rescue） | **B：詢問** | 同上，但第一個選項是「改由 Claude subagent **重新診斷**（不是審 diff）後繼續」——用 self-review.md 的 rescue 變體。無法提問的環境：停止並回報卡住的 bug，不自行猜。 |

`onCodexUnavailable=ask` → 全部 B；`continue` → 全部 C。

### Claude 自審（Codex 不可用時的降級，不是替代）
- 用 `Agent` 工具開 **Explore**（唯讀）subagent，prompt 用 `${CLAUDE_PLUGIN_ROOT}/prompts/self-review.md` 的對應變體（diff／計畫／rescue；填 `{{TARGET}}`／`{{FOCUS}}`）。subagent 自己跑 git diff、自己讀檔；**不要**把我的摘要或辯解餵給它。subagent 回來後先 `git status --short` 確認 working tree 沒被它動過。
- 回來的 JSON 照同一套 findings 規則處理（critical/high 修、medium/low 交使用者）。自審不消耗 Codex 輪次，自審自己上限 **2 輪**。
- 自審過的條目仍在未審清單（`--self-reviewed`），額度恢復後仍建議補審；我不會因為自審過就把它當成已審。
`reason=local-error` 不是 Codex 問題：告訴使用者修環境（訊息裡有 fix），不記未審清單。
**絕不**因 Codex 失敗而無限重試、阻塞、或自行猜測 Codex 會說什麼。

## 收工前（每次任務結束、回覆使用者之前）
1. `state --list --json`。未審清單為空 → 正常收工。
2. 非空 → `quota --json`。`available` → 對目前 working tree 跑一次 `review --json` 補審（仍受 maxRounds）。成功後只清除**這次審查確實涵蓋的條目**：條目的 `changedPaths` 仍在目前 working tree 且 `headSha` 相同 → `state --clear --id <id>`；已被 commit 走的條目不算涵蓋，保留並告知使用者。
3. 仍失敗或額度未恢復 → 最終回覆最上方加醒目標題 **「⚠ 未經 Codex 審查」**（該條目若已自審，標題後加「（已由 Claude 自審）」），逐項列出：改了什麼、原因（額度用完／連線失敗）、重置時間、是否自審；建議使用者稍後 `/codex-dispatch:review`。清單**不會自動清除**（超過 24h 標示 STALE），只有補審成功或使用者明確說不審才 `state --clear`。

## 交還格式（要人裁決時一律用這個，不要自由發揮）
到頂剩 HIGH、Codex 失敗走 B、rescue 失敗、同一 finding 連兩輪、或任何需要使用者決定的情況，最終回覆用：
```
## 交還：<一句話說明任務>
**目前成果**：<改了哪些檔／是否已 commit／測試狀態>
**試過的修正**：round 1 → <一句>；round 2 → <一句>；…
**剩餘**：critical N／high N／medium N／low N／低信心 N
- [<severity>] <檔案:行> <一句話問題> → <建議修法>
**根據**：<機械檢查結果／Codex verdict 與輪次／未審清單編號>
**要你決定**：<具體選項 A／B／C>
```
未審清單非空時，回覆最上方另加「⚠ 未經 Codex 審查」標題（Stop hook 會檢查這個標題；沒有會被擋下重答）。

## 使用者體驗
規則寫給我看，使用者照常下指令（「幫我加 XX」）即可，不需背任何 Codex 指令。我只在需要決策（B 情境、medium/low findings、輪次到頂）時打擾使用者。
