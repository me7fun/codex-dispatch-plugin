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
設定檔 `<專案>/.claude/codex-dispatch.config.json`（缺檔用預設）：`quotaThreshold=95`、`lineThreshold=50`、`fileThreshold=3`、`maxRounds=3`、`onCodexUnavailable=auto`、`reviewMode=adversarial`、`planDir=plans`。

## 分工
- Claude（我）：規劃、架構、實作、套用修正。
- Codex：審計畫、審 diff、深度找 bug、救援診斷。**只審不寫**——除非使用者明說「讓 Codex 直接改」，否則不加 `--write`。

## 觸發規則
1. **估計**改動 > `lineThreshold` 行或 > `fileThreshold` 個檔案，或使用者直接說「先寫計畫」：
   a. 寫計畫到 `<planDir>/<slug>.md`（目標、涉及檔案、步驟、測試方式、不做什麼）。
   b. `plan-review <planDir>/<slug>.md --json`。採納合理意見修訂計畫（在計畫尾端記一行審查紀錄），再開始實作。
2. 實作完成（尚未 commit）：`review --json`（預設 adversarial 模式，輸出結構化 findings）。
   - 送審範圍是整個 working tree：若 `git status` 顯示有**不是我這次改的**未提交變更，先告知使用者「這些會一起被審」；要只審某段就用 `--base <ref>`／`--scope branch`。
   - CLI 會擋下疑似機密檔（.env、*.pem、credentials.json…），回 `local-error`：請使用者處理（移除／gitignore），不要自行加 `--allow-secrets`。
   - `critical` / `high`：直接修正，重送 `review`。每輪修完若專案有測試就跑。上限 `maxRounds` 輪——**CLI 會強制**：同一批改動（repo + HEAD + 目標）送審達上限就回 `local-error`（訊息含 maxRounds），此時不要加 `--reset-rounds` 自行續審，交使用者裁決；`verdict=approve` 或 commit 後自動開新一輪。
   - **同一 finding（file + title 相同）連續兩輪都出現 → 視為無進展，停止並交使用者裁決。**
   - `medium` / `low`：列出交使用者決定，不自行修改。
   - 到頂仍有 critical/high → 列出交使用者。
3. 同一個 bug 嘗試修復 2 次仍失敗：停止嘗試，`rescue "<症狀、已試過什麼、相關檔案>" --json`（唯讀）。Codex 回的診斷／patch 建議由我套用。
4. 使用者說「嚴格審查」「上線前檢查」：`review --adversarial "<focus>" --json`，focus 寫使用者關心的面向。
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
| 審 diff（review） | **C：繼續** | Codex 輸出不是下一步的原料。`state --add-unreviewed "<改了什麼>" --reason <reason> --error "<error>"`，告知使用者一句，繼續原本工作。 |
| 審計畫（plan-review）／救援（rescue） | **B：詢問** | Codex 輸出是下一步的原料。寫 `.claude/state/codex-pending.md`（做到哪、卡在哪、reason、resetsAt），AskUserQuestion 三選一：「等你回來再說（停止）」「跳過 Codex 照 C 繼續」「停止」。無法提問的環境退化為 C。 |

`onCodexUnavailable=ask` → 全部 B；`continue` → 全部 C。
`reason=local-error` 不是 Codex 問題：告訴使用者修環境（訊息裡有 fix），不記未審清單。
**絕不**因 Codex 失敗而無限重試、阻塞、或自行猜測 Codex 會說什麼。

## 收工前（每次任務結束、回覆使用者之前）
1. `state --list --json`。未審清單為空 → 正常收工。
2. 非空 → `quota --json`。`available` → 對目前 working tree 跑一次 `review --json` 補審（仍受 maxRounds）。成功後只清除**這次審查確實涵蓋的條目**：條目的 `changedPaths` 仍在目前 working tree 且 `headSha` 相同 → `state --clear --id <id>`；已被 commit 走的條目不算涵蓋，保留並告知使用者。
3. 仍失敗或額度未恢復 → 最終回覆最上方加醒目標題 **「⚠ 未經 Codex 審查」**，逐項列出：改了什麼、原因（額度用完／連線失敗）、重置時間；建議使用者稍後 `/codex-dispatch:review`。清單**不會自動清除**（超過 24h 標示 STALE），只有補審成功或使用者明確說不審才 `state --clear`。

## 使用者體驗
規則寫給我看，使用者照常下指令（「幫我加 XX」）即可，不需背任何 Codex 指令。我只在需要決策（B 情境、medium/low findings、輪次到頂）時打擾使用者。
