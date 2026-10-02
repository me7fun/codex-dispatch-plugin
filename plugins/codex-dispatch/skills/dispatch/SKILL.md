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

子指令：`preflight`、`quota`、`plan-architect <prompt>`、`review`、`review --verify [--fixed 1,3]`、`plan-review <file>`、`rescue [--write] <prompt>`、`state`、`snippet`。一律前景執行（不要 `run_in_background`），review 通常 30–120 秒，plan-architect 依專案大小 1–5 分鐘（預設逾時 600 秒）。
設定檔 `<專案>/.claude/codex-dispatch.config.json`（缺檔用預設）：`quotaThreshold=95`、`lineThreshold=50`、`fileThreshold=3`、`maxRounds=3`、`onCodexUnavailable=auto`、`reviewMode=adversarial`、`planDir=plans`、`selfReview=auto`、`confidenceThreshold=0.75`、`reviewer=codex`、`planner=auto`、`plannerAllowSecrets=false`。

## 審查者／規劃者開關（`reviewer`、`planner`）
- `reviewer=codex`（預設）：本文件其餘規則照舊。
- `reviewer=claude`：使用者明確選擇**不用 Codex**。`review`／`plan-review`／`rescue` 會回 `ok:false, reason:"reviewer-claude"`（不查額度、不佔輪次、不外送；`review` 仍先跑 checks，失敗照舊 `checks-failed`）。我看到 `reviewer-claude` 就直接開自審 subagent（下方「Claude 自審」節，A／B／C 對應變體），把回傳的 `target.label`／`target.base`／`reviewRoot`／`checks` 填進 prompt；findings 規則與 Codex 相同（逐條查證、有證據才修、不分 severity），次數也相同（整份自審 1 次＋驗收最多 2 次，驗收用 D 變體）。**這是使用者的設定，不是失敗：不記未審清單、不加「未經 Codex 審查」標題、回覆裡不特別標「自審」、「收工前」整節跳過；Stop hook 也依設定放行。** 只有 `reviewer=codex` 而 Codex 因額度／連線失敗的降級自審，才保留標記與未審清單。
- `planner=auto`（預設）：有 agy 就先出草案。`planner=off`：`plan-architect` 回 `planner-off`，我直接自己寫計畫，不提 Antigravity。
- 切到 `reviewer=claude` 前若未審清單有殘留，開場會提示；要清就 `state --clear`，不清也不會被擋。

## 分工
- Claude（我）：規劃、架構、實作、套用修正。
- Antigravity CLI `agy`（選配）：只出**規劃草案**，`--mode plan` 唯讀讀整個工作區；草案由我審閱修訂，不是命令。沒裝就當它不存在。
- Codex：審計畫、審 diff、深度找 bug、救援診斷。**只審不寫**——除非使用者明說「讓 Codex 直接改」，否則不加 `--write`。

## 觸發規則
1. **估計**改動 > `lineThreshold` 行或 > `fileThreshold` 個檔案，或使用者直接說「先寫計畫」：
   a. 先 `plan-architect "<需求：目標、限制、涉及範圍>" --json`（agy 唯讀讀工作區，草案寫到 `<planDir>/<slug>.md`；submodule 佈局加 `--cwd`；要指定檔名用 `--output`）。`planner=off`（回 `planner-off`）→ 略過 a，直接自己寫計畫。
      - `ok=true` → 讀草案，**用我的判斷審閱修訂**：錯的檔案／API 引用改掉、缺的失敗情境補上、格式對齊「目標、涉及檔案、步驟、測試方式、不做什麼」；在計畫開頭保留「草案由 Antigravity 產出、Claude 修訂了什麼」一句。
      - `ok=false` 且 `reason` 是 `agy-not-installed`／`agy-error`／`invalid-output` → 一句告知使用者，**自己寫計畫**到 `<planDir>/<slug>.md`，不重試、不中斷、不記未審清單（這不是 Codex 失敗）。
      - `reason=local-error`（機密檔、路徑、不是 git repo）→ 依訊息請使用者處理；這輪同樣自己寫計畫繼續，不自行加 `--allow-secrets`、不自行改 `plannerAllowSecrets`（那是使用者決定「機密內容可送 Google」的開關）。
   b. `plan-review <planDir>/<slug>.md --json`（`reviewer-claude` → 自審 B 變體）。採納合理意見修訂計畫（在計畫尾端記一行審查紀錄），再開始實作。
2. 實作完成（尚未 commit）：`review --json`（`reviewer-claude` → 自審 A 變體，target 照回傳填；預設 adversarial 模式＋內建嚴重度校準。**severity 與 `verdict` 只是標籤，不影響處置**——所有 findings（含 `lowConfidence`）一律走下面的查證，approve 也照走；每條 finding 帶 `index` 編號，驗收時用）。
   - 送審範圍是整個 working tree：若 `git status` 顯示有**不是我這次改的**未提交變更，先告知使用者「這些會一起被審」；要只審某段就用 `--base <ref>`／`--scope branch`。
   - **submodule／多 repo 佈局**（例如 client 根下 `games/<game>/` 各是自己的 repo，而規則、plans/、設定都在 client 根）：CLI 用**雙根**——**審查根**＝改動所在的 repo（diff、HEAD、輪次以它為準），**規則根**＝從審查根往上找到的已接線目錄（設定檔、CLAUDE.md 規則、state 檔都在這）。我要做的只有一件事：review／plan-review／rescue／state 一律加 `--cwd <改動所在 repo 目錄>`（例如 `--cwd games/slot-fe-xxx`）。檔案引數（計畫檔、prompt 檔）相對我目前的 cwd 解析，放規則根的 `plans/` 即可。從上層 repo 送審 git 只看到子模組指標，CLI 會拒絕並提示；未初始化的 submodule 也會直接報錯要求 `git submodule update --init`。各 sub-repo 的 state／輪次／未審清單獨立，集中存在規則根 `.claude/state/codex-dispatch/`；在規則根跑 `state --list` 會列出全部。
   - CLI 會擋下疑似機密檔（.env、*.pem、credentials.json…），回 `local-error`：請使用者處理（移除／gitignore），不要自行加 `--allow-secrets`。
   - **機械檢查先行（ground truth）**：若規則根有 `.claude/codex-dispatch.local.json` 的 `checks`（test／lint／typecheck；此檔不進 git，只有使用者自己能設），CLI 會先跑，任一失敗回 `reason=checks-failed`（exit 2）且**不送 Codex、不佔輪次**——這是確定的失敗，先修到通過再送；不要加 `--skip-checks`，除非使用者明說。全過的結果會附進 prompt 當 Codex 的根據。專案沒設 checks 但有測試指令時，建議使用者設一次。
   - **所有 findings 走同一套處置，不分 severity**（`critical`／`high`／`medium`／`low`／`lowConfidence` 一視同仁）。bug 就是 bug，不依大小篩選；實測同一份 diff 連跑三次，同一個 bug 的 severity 在 HIGH／MEDIUM 之間漂移——標籤是雜訊，不拿來決定任何事。
   - **逐條查證，不照單全收**：Codex 說有 bug 不等於有 bug（研究顯示 Codex 審 Claude 的碼會過度修正，把沒問題的改壞）。**真 bug 的證據＝一個會失敗的測試，或實際跑出的錯誤輸出；只讀碼推論不算**——程式是我寫的，我讀自己的碼說「不會發生」等於自己當裁判。例外：finding 指的是文件／規則文字（SKILL、README、註解）時，證據＝引出互相矛盾的兩處原文，或與程式行為不符的那一行。
     - **有證據 → 修**，不分 severity、不打擾使用者。為 bug 寫的失敗測試留下來當回歸測試。**只改 finding 指到的位置與必要的關聯處**，不重寫、不順手重構其他地方。
     - **沒證據 → 不修**，收工摘要逐條交代（見下）。記下**試了什麼、預期什麼 vs 實際什麼**，不可以只寫「無法複現」——那等於沒給使用者判斷的依據。
   - **修完只驗收修正的部分**：有修任何一條 → `review --verify --fixed <這次修的 index，逗號分隔> --json`（`--base`／`--scope`／`--cwd` 要與整份審相同；一條都沒修就不驗收）。CLI 只把「上次送審之後才改的部分」與對應 findings 送 Codex，只問兩題：修好了沒、修正有沒有弄壞別的。**不要整份重送**——整份重送等於讓審查者對沒改的地方再挑一輪，每輪都會冒出新意見、永遠收斂不了；CLI 也會擋（有快照時整份 `review` 回 `local-error`、`nextAction:"verify"`）。
     - 驗收回來的 `findings`（沒修好的原 bug、修正造成的新缺陷）走同一套查證：有證據就修，再 `review --verify --fixed <新的 index>`（index 以**最近一次**送審結果為準）。
     - 驗收回來的 `outOfScope`＝不在這次修正範圍內的意見：不修，只在收工摘要列出。
     - **總共最多送 3 次**（整份 1＋驗收 2，`maxRounds`，CLI 原子強制）。第 3 次後仍有 findings，或 CLI 回 `nextAction:"handoff"` → 用下方「交還格式」交使用者。不要加 `--reset-rounds` 自行續審（那是使用者明說才用的）。
     - 驗收失敗（`quota`／`codex-error`／`invalid-output`）照「失敗處理」的審 diff 一列處理，未審清單的描述開頭標「修正未經驗收：」。
   - 收工摘要：一句話講送審幾次（整份 1＋驗收 N）、幾條 findings、修了幾條（修好的不用逐條列，要細節再給）。**但沒修的每一條都必須列出來**，一行一條：`<白話說問題是什麼> — 不算 bug：<試了什麼、預期 vs 實際>`；`outOfScope` 的也一行一條列出。不修是我的判斷、可能是誤判，使用者看得到才有機會撿回來；他說「這條要修」就照修。**任何一行都不要丟 severity 標籤要他判斷。**
3. 同一個 bug 嘗試修復 2 次仍失敗：停止嘗試，`rescue "<症狀、已試過什麼、相關檔案>" --json`（唯讀；`reviewer-claude` → 自審 C 變體）。Codex 回的診斷／patch 建議由我套用。
4. 使用者說「嚴格審查」「上線前檢查」：`review --strict "<focus>" --json`（全對抗、不校準）。**只跑一次、不進迴圈**：結果整份呈現給使用者決定，不自動修（社群的「收斂後最終稽核」模式）。
5. 小改動（字串、參數、樣式微調、註解、單檔 < 20 行）不送審。
6. 官方 `codex-result-handling` skill 的「審完 STOP、不得自動修」規則**不適用**於本流程「有證據就自動修」的處置；本 skill 優先。

## 結果物件（`--json`）
```
ok, kind(review|plan-review|rescue|plan-architect), reason(null|quota|codex-error|invalid-output|local-error|checks-failed|agy-not-installed|agy-error|reviewer-claude|planner-off),
quota{status(available|exhausted|unknown), usedPercent, resetsAt, planType}, verdict, summary, findings[], nextSteps[], raw, error, attempts
plan-architect 另有：output（計畫檔絕對路徑）、outputRel、agy{bin, model, effort, conversationId, durationMs}、fallback("claude" 表示請我自己寫計畫)
```
exit code：0 成功；1 Codex／agy 端失敗；2 本地錯誤（先修環境，例如未安裝官方 plugin、不是 git repo）。

## 失敗處理（最重要）
CLI 已內建：送審前查額度（`exhausted` 直接不送）、非額度失敗自動重試 1 次、失敗後再查一次額度判因。我收到 `ok=false` 後**不再重試**，依 `reason` 與呼叫類型處理：

| 呼叫 | `onCodexUnavailable=auto` 時 | 說明 |
|---|---|---|
| 審 diff（review、review --verify） | **C：繼續** | Codex 輸出不是下一步的原料。`selfReview=auto` → 先做一次「Claude 自審」（下節），再 `state --add-unreviewed "<改了什麼>" --reason <reason> --error "<error>" --self-reviewed`；`ask` → AskUserQuestion 問一次要不要自審（無法提問就不自審）；`off` → 直接記入（不加 `--self-reviewed`）。告知使用者一句，繼續原本工作。 |
| 審計畫（plan-review） | **B：詢問** | Codex 輸出是下一步的原料。寫 `.claude/state/codex-pending.md`（做到哪、卡在哪、reason、resetsAt），AskUserQuestion 四選一：「改由 Claude 自審計畫後繼續（Recommended）」「跳過審查照 C 繼續」「等你回來再說（停止）」「停止」（`selfReview=off` 時拿掉第一個選項）。無法提問的環境退化為 C。 |
| 救援（rescue） | **B：詢問** | 同上，但第一個選項是「改由 Claude subagent **重新診斷**（不是審 diff）後繼續」——用 self-review.md 的 rescue 變體。無法提問的環境：停止並回報卡住的 bug，不自行猜。 |

`onCodexUnavailable=ask` → 全部 B；`continue` → 全部 C。
`plan-architect` 失敗不在此表：它不是 Codex，失敗一律 C（自己寫計畫），不問、不記未審清單。

### Claude 自審（Codex 不可用時的降級；`reviewer=claude` 時則是正式審查者）
- 用 `Agent` 工具開 **Explore**（唯讀）subagent，prompt 用 `${CLAUDE_PLUGIN_ROOT}/prompts/self-review.md` 的對應變體（diff／計畫／rescue；填 `{{TARGET}}`／`{{FOCUS}}`）。subagent 自己跑 git diff、自己讀檔；**不要**把我的摘要或辯解餵給它。subagent 回來後先 `git status --short` 確認 working tree 沒被它動過。
- 回來的 JSON 照同一套 findings 規則處理（不分 severity，逐條查證、有證據才修，不打擾使用者）。自審不消耗 Codex 輪次。
- **降級自審（Codex 整份審就失敗）只做一次、不驗收**：那批改動留在未審清單，額度恢復後補一次整份 Codex 審，再走正常的驗收流程。
- **`reviewer=claude` 的驗收**：`review --verify --json` 回 `reviewer-claude` 與 `delta.fromTree`／`delta.toTree`／`delta.paths` → 開 subagent 跑 D 變體（把兩個 tree 與要驗收的 findings 填進去；`--fixed` 在這條路徑不適用）。CLI 不替自審計輪次、快照也不滾動（delta 是整份自審之後的累積修正），次數由我自己守：整份 1 次＋驗收最多 2 次，仍未過就交還。
- 自審過的條目仍在未審清單（`--self-reviewed`），額度恢復後仍建議補審；我不會因為自審過就把它當成已審。
`reason=local-error` 不是 Codex 問題：告訴使用者修環境（訊息裡有 fix），不記未審清單。
**絕不**因 Codex 失敗而無限重試、阻塞、或自行猜測 Codex 會說什麼。

## 收工前（每次任務結束、回覆使用者之前）
0. `reviewer=claude` → 本節整個跳過（沒有 Codex 可補審，也不標記）。
1. `state --list --json`。未審清單為空 → 正常收工。
2. 非空 → `quota --json`。`available` → 對目前 working tree 跑一次 `review --json` 補審（仍受 maxRounds）；回 `local-error` 且 `nextAction:"verify"`（這批已整份審過、欠的是驗收）→ 改跑 `review --verify --json`；`nextAction:"handoff"`（次數用完）→ 不再送，照步驟 3 標記，commit 後新一輪再審。成功後只清除**這次審查確實涵蓋的條目**：條目的 `changedPaths` 仍在目前 working tree 且 `headSha` 相同 → `state --clear --id <id>`；已被 commit 走的條目不算涵蓋，保留並告知使用者。
3. 仍失敗或額度未恢復 → 最終回覆最上方加醒目標題 **「⚠ 未經 Codex 審查」**（該條目若已自審，標題後加「（已由 Claude 自審）」），逐項列出：改了什麼、原因（額度用完／連線失敗）、重置時間、是否自審；建議使用者稍後 `/codex-dispatch:review`。清單**不會自動清除**（超過 24h 標示 STALE），只有補審成功或使用者明確說不審才 `state --clear`。

## 交還格式（要人裁決時一律用這個，不要自由發揮）
只有這四種情況才交還：Codex 失敗走 B（審計畫／救援）、rescue 失敗、同一個 bug 修 2 次仍失敗、送審 3 次後驗收仍有 findings（把剩下的 findings 白話列在「卡在哪」）。**除此之外 findings 不交還**——有證據就修、沒證據就不修並列出，不要把 severity 清單丟給使用者判斷。

```
## 交還：<一句話說明任務>
**目前成果**：<改了哪些檔／是否已 commit／測試狀態>
**試過的修正**：<一句>；<一句>；…
**卡在哪**：<具體的失敗現象，或缺了什麼資訊才能繼續>
**根據**：<機械檢查結果／Codex verdict／未審清單編號>
**要你決定**：<具體選項 A／B／C>
```
未審清單非空時，回覆最上方另加「⚠ 未經 Codex 審查」標題（Stop hook 會檢查這個標題；沒有會被擋下重答）。

## 使用者體驗
規則寫給我看，使用者照常下指令（「幫我加 XX」）即可，不需背任何 Codex 指令。我只在**真的需要他決定**時打擾使用者（B 情境：審計畫／救援失敗）。findings 一律自動處置（查證 → 修 → 驗收），收工只給一句摘要加上沒修的清單——**不要求使用者判斷 severity**，那不是他的工作。
