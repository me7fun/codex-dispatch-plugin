# codex-dispatch 審查流程重設計：整份審 1 次＋只驗收修正最多 2 次

> 草案由 Antigravity CLI 產出（conversation `63a3477f-09eb-4a03-9b41-ddbd40ca5fcc`，2026-10-02），Claude 修訂：
> ① 只加 `review --verify` 旗標、不加 `verify` 子指令（Stop hook 的 `INVOKE_RE` 只認 `review`，少一個要同步的入口）；
> ② `maxRounds` 現值是 1（草案誤寫「保持為 3」），改為 3，語意＝總送審次數，不另開 `cycleRounds` 計數——整份審／驗收用「有沒有快照」區分；
> ③ 快照在**送出前**取（＝Codex 實際看到的內容），成功後才存；草案是審完才取；
> ④ 快照逐次滾動：第 2 次驗收只看第 1 次驗收之後的改動；
> ⑤ cycle 清除條件由「verdict=approve」改為「沒有任何 finding」——現行 approve 只看 critical/high，會在還有 medium 要修時把快照清掉；
> ⑥ 範圍限制除了寫在 prompt，CLI 再做一道確定性分流（`outOfScope`）；
> ⑦ 補上草案沒處理的：文件類 finding 的證據標準、Codex 失敗降級自審的邊界、tree 物件被 gc、delta 過大、`--strict`／native 不進驗收。

## 目標

v0.1.18（`ac87cbb`）為了擋掉「每輪整份重送 → Codex 每輪都挑出新刺 → 跑滿 3 輪、額度燒光」，改成只送一次、修完不重送、所有 findings 複現得了就修。留下三個問題：

1. **修正沒人審**：Claude 為了修 finding 改的程式碼，要到下次 commit 之後才有人看。
2. **是不是真 bug 只憑 Claude 讀碼判斷**：現行「複現」允許只讀碼，等於作者自己當裁判。
3. **開場摘要過期**：`session-start.mjs` 仍寫「critical/high 修正後重審（上限 3 輪），medium/low 交使用者決定」，與 SKILL.md 矛盾。

使用者定案的新流程：

1. **整份送審 1 次**：現有 `review` 行為不變，Codex 全部照報（prompt 不可叫模型省略 finding）。
2. **Claude 逐條查證，不照單全收**：要有證據才算真 bug。是真 bug 就修（不分 severity、不分大小）；不是就不修，收工逐條列出理由。
3. **只把修正的部分送驗收**：Codex 只看上次送審之後的 delta 與對應的 findings，只答兩題——修好了沒、修正有沒有弄壞別的。
4. **同一批改動最多送 3 次**（1 次整份＋最多 2 次驗收）；仍未通過就用既有交還格式交使用者。

挑刺的兩個來源各由一道關卡擋：「算不上 bug 的刺」由證據查證擋；「越送越多的刺」由驗收只看 delta 擋。因此**不加 severity 篩選**。

## 涉及檔案

- `plugins/codex-dispatch/scripts/lib/paths.mjs`：working tree 快照（臨時 index＋`write-tree`）、兩個 tree 之間的 diff。
- `plugins/codex-dispatch/scripts/lib/state.mjs`：`snapshots` 欄位的存取、清除、TTL；`completeRound` 的清除條件。
- `plugins/codex-dispatch/scripts/lib/config.mjs`：`maxRounds` 預設 1 → 3 與註解。
- `plugins/codex-dispatch/scripts/dispatch.mjs`：`cmdReview` 存快照、`--verify` 分支、驗收 prompt、`renderReview`、檔頭用法註解。
- `plugins/codex-dispatch/prompts/self-review.md`：新增 D 變體（驗收修正）。
- `plugins/codex-dispatch/scripts/session-start.mjs`：開場摘要兩條分支。
- `plugins/codex-dispatch/skills/dispatch/SKILL.md`：觸發規則 2、設定預設值、自審節、收工摘要、交還時機。
- `plugins/codex-dispatch/commands/review.md`、`README.md`：`--verify` 與新流程。
- `plugins/codex-dispatch/test/verify.test.mjs`（新檔）。

## 設計

### 狀態機（每個 cycleKey＝repo＋HEAD＋mode＋base＋scope，沿用 `reviewCycleKey`）

`state.snapshots[cycleKey] = { tree, findings, stage: "full"|"verify", at }`；`rounds[cycleKey]` 沿用，語意是「Codex 實際跑過的次數」。

| 呼叫 | 前提 | 成功後 |
|---|---|---|
| `review`（整份） | 該 cycle **沒有**快照，且 `rounds < maxRounds` | findings 非空 → 存快照 `{tree: T0, findings, stage:"full"}`；findings 為空 → 清整個 cycle |
| `review --verify` | 該 cycle **有**快照，且 `rounds < maxRounds`，且 delta 非空 | 範圍內 findings 非空 → 快照滾動為 `{tree: Tnow, findings: 這次的, stage:"verify"}`；為空 → 清整個 cycle |

- 有快照時再跑整份 `review` → `local-error`：「此批改動已整份審過；修完請用 `review --verify`。要重新整份審請 commit，或由使用者明說後加 `--reset-rounds`」。
- 沒快照跑 `--verify` → `local-error`：「找不到先前的整份審查；請先 `review`」。
- `rounds >= maxRounds` → `local-error`，訊息指向交還格式。`maxRounds=1` 等同 v0.1.18（不驗收）。
- 整份審失敗（`codex-error`／`invalid-output`）不存快照，所以額度恢復後的補審仍可再跑整份審，受總數 3 限制；`quota`／`local-error` 照舊退回佔用。
- `--reset-rounds`、`dropRound`、7 天 TTL 清除時一併刪掉該 key 的快照。
- 快照只在 **adversarial 非 strict** 模式存：native（純文字、只呈現）與 `--strict`（只跑一次、不自動修）不進驗收；對這兩種模式下 `--verify` 回 `local-error`。

### 快照與 delta（`paths.mjs`）

- `gitSnapshotTree(cwd)`：`GIT_INDEX_FILE=<tmp>`；有 HEAD 先 `git read-tree HEAD`；`git add -A`（含 untracked、尊重 `.gitignore`）；`git write-tree` → tree SHA；`finally` 刪臨時 index。不動使用者的 `.git/index`。
- `gitTreeDelta(cwd, fromTree, toTree)`：patch 與路徑清單**都加 `--no-renames`**（`git diff --no-renames <from> <to>`、`git diff --no-renames --name-only -z <from> <to>`）——關掉 rename 偵測後，把 `.env` 改名成 `config.txt` 會呈現為「刪 `.env`＋新增 `config.txt`」，兩端路徑都進機密閘門（與既有 `gitDiffPathsForGate` 收 rename 兩端同一個目的）。`fromTree` 物件不存在（被 gc）→ 回錯誤，`--verify` 轉成 `local-error`：「快照已失效，請 commit 後開新一輪」。
- 整份審：**機械檢查跑完之後、送 Codex 之前**取 T0（checks 可能是 formatter／generator，會改檔；快照必須是檢查後的樣子），Codex 成功且有 findings 才存。官方 companion 審的是活的 working tree 而不是 T0，所以 Codex 回來後再取一次 tree：與 T0 不同 → 結果加 `treeChangedDuringReview: true` 警告，快照仍存 T0（基準偏舊只會讓下次 delta 變多，不會漏審）。
- 驗收：取 Tnow，delta＝`diff(snapshot.tree, Tnow)`。delta 為空 → `local-error`（快照之後沒有改動，無需驗收）。delta 超過 200 KB → `local-error`（修正量已不是「修 finding」，請 commit 後開新一輪）。

### `review --verify` 流程（`dispatch.mjs`）

順序：引數／根 → 讀快照（沒有就拒絕）→ 額度預檢（`reviewer=claude` 略過）→ 機械檢查（失敗 `checks-failed`、不佔輪次）→ **檢查跑完才**取 Tnow 與 delta → 機密閘門（對最終 delta 路徑）→ `reviewer=claude` 分支在此返回 → `reserveRound` → Codex。

- 旗標：沿用 `--cwd`／`--base`／`--scope`（必須與整份審相同，否則 cycleKey 不同 → 找不到快照）、`--allow-secrets`、`--skip-checks`、`--retries`、`--json`；新增 `--fixed 1,3`（省略＝全部都宣稱已修）。只收索引，不收自由文字——不讓作者的辯解進到審查者的 prompt。
- **索引契約**：每一次送審（整份或驗收）回來的 findings 都由 CLI 在排序、分流**之後**編 1 起算的 `index`（整份審：findings 在前、lowConfidence 在後；驗收：只編範圍內的），連同 findings 一起存進快照。`--fixed` 永遠指**最新快照**裡的 index；索引不存在 → `local-error`。
- 走官方 companion `task --json --prompt-file <tmp>`（唯讀，比照 `cmdPlanReview`），`interpretTask({requireJson:true})`＋`validateStructured` 解析，同一套 schema。
- 驗收 prompt 要點：
  - 「You are verifying fixes, not performing a new review.」附上宣稱已修的 findings（編號、title、body、file、行號）與 delta 全文。
  - 兩題：(1) 每條宣稱已修的 finding 是否真的解決；(2) delta 改動的程式碼是否造成新的缺陷（含它直接弄壞的呼叫端——要指出是 delta 的哪一行造成）。
  - 「Scope: the delta below. Code that the delta does not touch was reviewed in the previous round and is not under review here.」**不寫「省略／不要報」**（知識庫 pitfall：叫模型省略會連真缺陷一起吞掉）；範圍外的東西由 CLI 分流。
  - 未宣稱已修的 findings 列在另一段：「declined by the author as not reproducible; not in question」。
  - 機械檢查結果照舊附上（`checksSummaryForPrompt`）。
- 驗收 prompt 要求每條 finding 多帶兩個欄位（`normalizeFindings` 目前會丟掉未知欄位，需擴充保留）：`ref`＝它指的是哪一條「宣稱已修」的 finding 的 index（沒修好時填；否則 null）、`caused_by_file`＝造成這個新缺陷的 delta 檔案（修正弄壞別處時填；否則 null）。
- **CLI 的確定性分流**：finding 屬於範圍內，只要符合任一條——① `ref` 是這次宣稱已修的 index（原 bug 沒修好：即使它的位置不在 delta 裡也算，修正可能改在別的檔）；② `file` 在 delta 路徑內；③ `caused_by_file` 在 delta 路徑內（delta 弄壞了沒被改動的呼叫端）。三條都不符合 → 移到 `outOfScope`（只呈現、不自動修、不影響 verdict、不進下一輪快照）。verdict 由 CLI 重算：範圍內 findings 為空＝`approve`，否則 `needs-attention`。不做 confidence 分流（驗收是封閉題）。
- 結果物件新增：`stage: "full"|"verify"`、`snapshotTree`、`delta: { fromTree, toTree, paths, bytes }`、`outOfScope[]`；整份審的 findings 每條加 `index`。
- `completeRound` 的 `approve` 參數改為「範圍內 findings（整份審含 lowConfidence）為空」；函式簽名不變。

### `reviewer=claude`

- 整份 `review`：照舊回 `reviewer-claude`、不佔輪次；新增「存快照 `{tree: T0, findings: null, stage:"full"}`」並回 `snapshotTree`。
- `review --verify`：回 `reviewer-claude`，附 `delta.fromTree`／`delta.toTree`／`delta.paths`。**快照不滾動**——CLI 在 subagent 開始前就返回，不知道自審有沒有成功；若先滾動，subagent 失敗或 session 中斷後重試會得到空 delta、救不回來。所以 claude 路徑的 delta 一律是「整份自審之後的累積修正」（自審不吃 Codex 額度，重看已驗過的修正只是多花一點時間）。
- claude 路徑的 findings 只存在於 Claude 的對話裡（CLI 沒有），所以 `--fixed` 在 `reviewer=claude` 時不適用（帶了回 `local-error`）；Claude 把要驗收的 findings 直接填進 `self-review.md` D 變體，subagent 自己跑 `git diff --no-renames <fromTree> <toTree>`（兩個 tree 物件都已寫進 repo 物件庫）。
- 自審上限由「2 輪」改為與 Codex 路徑一致的「1 次整份＋最多 2 次驗收」，由 SKILL 規範（CLI 對 claude 路徑照舊不計輪次）。

### SKILL.md 規則（觸發規則 2 重寫）

- **查證標準**：真 bug 的證據＝一個會失敗的測試，或實際跑出的錯誤輸出。只讀碼推論不算。例外：finding 指的是文件／規則文字（SKILL、README、註解）時，證據＝引出互相矛盾的兩處原文或與程式行為不符的那一行。
- 有證據 → 修（不分 severity）；為 bug 寫的失敗測試留下來當回歸測試。只改 finding 指到的位置與必要關聯處。
- 沒證據 → 不修，收工摘要逐條列：`<白話說問題> — 不算 bug：<試了什麼、預期 vs 實際>`。
- 有修 → `review --verify --fixed <索引> --json`；沒有任何一條要修 → 不驗收。
- 驗收回來的範圍內 findings 走同一套查證標準；`outOfScope` 只在收工摘要列出，不修。
- 第 3 次送審後仍有範圍內 findings → 用交還格式交使用者（交還時機新增這一條）。
- 驗收失敗（`quota`／`codex-error`／`invalid-output`）：比照審 diff 的 C（繼續），快照保留不動，記入未審清單並在描述開頭標「修正未經驗收：」。
- **補審走哪條路由 CLI 指路**：被快照守門擋下的 `local-error` 帶機器可讀的 `nextAction`——有快照時跑整份 `review` 回 `nextAction:"verify"`、沒快照跑 `--verify` 回 `nextAction:"full"`、輪次用完回 `nextAction:"handoff"`。收工前補審（SKILL「收工前」步驟 2）先跑整份 `review`，收到 `nextAction:"verify"` 就改跑 `review --verify`；收到 `handoff` 就不再送，條目留在未審清單、照既有規則在回覆最上方標記，commit 後新 cycle 再審。
- 收工摘要：送審幾次（整份 1＋驗收 N）、幾條 findings、修了幾條；不修的與 `outOfScope` 逐條列。
- 設定節的 `maxRounds=1` 改 `maxRounds=3`；「修完不重送」「不要加 `--reset-rounds` 自行續審」改寫為新流程。

### 開場摘要（`session-start.mjs`）

- codex 分支：「實作完成 → 送 Codex 整份審 1 次；findings 逐條查證（要有失敗測試或錯誤輸出才算），真 bug 就修、不分 severity；修完 `review --verify` 只驗收修正的部分（最多 2 次），仍未過交使用者。」
- claudeOnly 分支同義，審查者換成 Claude 唯讀 subagent。

## 步驟

1. `paths.mjs`：`gitSnapshotTree`、`gitTreeDelta`。
2. `state.mjs`：`snapshots` 正規化／TTL／`dropRound`／`resetRounds` 連動；`saveSnapshot`、`getSnapshot`（都在 `withLock` 內）。
3. `config.mjs`：`maxRounds` 預設 3、註解。
4. `dispatch.mjs`：整份審前置檢查「已有快照 → 拒絕」、送出前取 T0、成功後存快照、findings 加 `index`、`completeRound` 條件；`--verify` 分支；`renderReview` 顯示 stage／delta／outOfScope；檔頭用法。
5. `prompts/self-review.md`：D 變體。
6. `session-start.mjs`、`SKILL.md`、`commands/review.md`、`README.md`。
7. `test/verify.test.mjs`。
8. 跑 `node --test "plugins/codex-dispatch/test/*.test.mjs"` 全過。
9. **實測額度**：用這次改動本身走一遍新流程，`quota --json` 記錄整份審前後、驗收前後的 `usedPercent`，結果寫進本計畫尾端，並向使用者提案更新知識庫的決策頁（v0.1.18 那頁的結論已被取代）。

## 測試方式

`node:test`＋假 companion＋臨時 git repo（比照 `test/switches.test.mjs` 的 `makeProject`）：

1. 沒快照跑 `--verify` → exit 2、`local-error`。
2. 整份審有 findings → state 有快照；再跑整份 `review` → `local-error`。
3. 整份審 findings 為空 → 不留快照、cycle 清除，可再整份審。
4. delta 只含快照之後的改動：假 companion 收到的 prompt 檔含修正行、不含原 diff 未變動的行。
5. 修正時新增的 untracked 檔進 delta；被 `.gitignore` 忽略的檔不進。
6. 快照之後沒改動 → `--verify` 回 `local-error`。
7. 輪次：整份 1 → 驗收 2 次成功 → 第 3 次驗收 `local-error`；`maxRounds=1` 時第 1 次驗收就被拒。
8. 滾動快照：第 2 次驗收的 delta 不含第 1 次驗收已看過的改動。
9. `outOfScope`：假 companion 回一條 `file` 不在 delta 內的 finding → 進 `outOfScope`、verdict=`approve`、cycle 清除。
10. `--fixed 2`：prompt 的「宣稱已修」段只有第 2 條，其餘在 declined 段；索引超出範圍 → `local-error`。
11. commit 後 cycleKey 改變 → 可開新一輪整份審。
12. `reviewer=claude`：整份審回 `snapshotTree`；`--verify` 回 `reviewer-claude`＋`delta.fromTree/toTree`，不碰 companion、不佔輪次。
13. 驗收的機密閘門：delta 新增 `.env` → `local-error`；機械檢查失敗 → `checks-failed` 且不佔輪次。
14. 快照 tree 不存在 → `local-error`。
15. `session-start` 輸出不再含「上限 3 輪」「medium/low 交使用者」。
16. 機密檔改名：快照後把已追蹤的 `.env` 改名為 `config.txt` 並修改 → `--verify` 被機密閘門擋下。
17. 原 bug 沒修好且位置不在 delta：假 companion 回 `ref:1`、`file` 不在 delta 內 → 留在範圍內、verdict=`needs-attention`、進下一輪快照。
18. delta 弄壞沒改動的呼叫端：`caused_by_file` 在 delta 內、`file` 不在 → 範圍內。
19. 會改檔的 check：check 指令改寫一個檔 → 驗收 prompt 的 delta 含該改寫、滾動後的快照等於檢查後的 tree。
20. 完整序列：整份審（3 條）→ `--verify --fixed 1,3` → 回 2 條（新 index 1、2）→ `--verify --fixed 2` 的 prompt 只把新快照的第 2 條列為宣稱已修。
21. `reviewer=claude` 連跑兩次 `--verify`、中間不改檔 → 兩次 delta 相同（快照沒滾動）；帶 `--fixed` → `local-error`。
22. 驗收 `codex-error` 後：快照仍在、整份 `review` 回 `nextAction:"verify"`；輪次用完回 `nextAction:"handoff"`。
23. 整份審期間 working tree 被改（假 companion 在執行時寫一個檔）→ 結果有 `treeChangedDuringReview`、快照是 T0。

## 不做什麼

- 不加 severity／重要性篩選（使用者決定：bug 就是 bug）。
- 不改 `--strict`、native 模式、`plan-review`、`rescue`、`plan-architect`。
- 不加第二審查者（agy 審 diff 是另一個題目）。
- **整份審就失敗（Codex 沒審到）的降級自審不做驗收**：沒有快照，那批改動留在未審清單，額度恢復後補一次整份 Codex 審（沒快照所以不會被守門擋），再走正常的驗收流程。（整份審成功、只有驗收失敗的情況見上方「補審走哪條路」。）
- 不提供 `verify` 子指令、不改 Stop hook 的 `INVOKE_RE`。
- 不處理「兩個視窗同時對同一 cycle 驗收」的快照先後（鎖保證 state 不壞；後寫者勝）。
- 版本號不手動改（`update.js` 負責 bump）。

## 風險與未知

1. **驗收吃多少 Codex 額度沒量過**。已知整份 adversarial 審約半個 5 小時窗（2026-09-17 觀測）。步驟 9 實測；若單次驗收仍 >20% 窗，退路是把驗收改由 Claude 唯讀 subagent 做（D 變體已備），做成設定開關是後續題目，本次不做。
2. **prompt 的範圍限制靠不住** → 已由 CLI 的 `outOfScope` 分流兜底；但 finding 若把 `file` 填成 delta 內的檔、內容卻講別處，分流擋不到，仍靠 Claude 查證那一關。
3. **查證標準變嚴會誤殺**：難以寫成測試的真 bug（競態、環境相依）會被判「不算」。緩解：不修的每一條都列在收工摘要，使用者可撿回。
4. **快照 tree 是不可達物件**：`git gc` 預設寬限 2 週、cycle TTL 7 天，正常不會被清；被清時回 `local-error`。

## 審查紀錄

- 2026-10-02 Codex plan-review（needs-attention，6 條，全數核對後採納）：① delta 路徑用 `--name-only` 會漏掉 rename 來源端、可繞過機密閘門 → patch 與路徑都加 `--no-renames`；② 只用 `file` 分流會把「沒修好的原 bug」與「被 delta 弄壞的呼叫端」丟進 outOfScope 而誤判 approve → 加 `ref`／`caused_by_file` 兩欄位、三條件任一即範圍內；③ 快照取在機械檢查之前，會改檔的 check 會讓快照過期 → 檢查後才取，並偵測審查期間 tree 變動；④ 第 2 次驗收的 `--fixed` 索引沒有定義 → 每次送審都編 index 並存進快照，`--fixed` 指最新快照；⑤ claude 路徑在 subagent 成功前就滾動快照，失敗後救不回 → claude 路徑不滾動、delta 為累積；⑥ 驗收失敗後的補審會被快照守門擋住 → `local-error` 帶 `nextAction` 指路。
- 2026-10-02 實作後照新流程 dogfood（Codex plus 方案，5 小時窗 `usedPercent`）：
  - 整份審（11 檔、約 1000 行 diff）：7% → 9%。1 條 finding（force-add 的被忽略檔不在快照裡）——寫出失敗測試後修正。
  - 同時 dogfood 自己抓到 1 個 bug：`.claude/state/` 被 git 忽略時（實際專案的常態）`git add -- . ':(exclude).claude/state'` 直接失敗，快照存不了；測試專案沒忽略該目錄所以沒測到。改為事後 `git rm --cached` 並補測試。
  - 驗收 1（delta 4.7 KB）：9% → 9%。原 finding 已解決；回 1 條由修正造成的新缺陷（複製真 index 會帶著 assume-unchanged 旗標）——寫出失敗測試後修正（skip-worktree 同理，一併涵蓋）。
  - 驗收 2（delta 3.5 KB）：9% → 10%，approve，cycle 清除。
  - 結論：1 次整份＋2 次驗收共用 3 個百分點；驗收成本遠低於風險節設的 20% 門檻，退路（改由 Claude subagent 驗收）不需要啟用。9 月紀錄的「整份審≈半個額度窗」這次沒有重現（當時是連續兩次 adversarial review 由 4% 到 100%）。
