# v0.1.2：Claude 自審備援、多視窗計數修正、update.js 計數、LICENSE

## 目標
1. **Claude 自審備援（self-review）**：Codex 不可用（額度／連線／輸出壞掉）時，由 Claude 開獨立 subagent 依同一套 schema 做對抗式審查，作為降級方案。
   - 設定 `selfReview`：`auto`（審 diff 失敗自動自審）｜`ask`（B 情境選項之一）｜`off`。預設 `auto`。
   - prompt 正本：`plugins/codex-dispatch/prompts/self-review.md`（輸入：diff／計畫內容；輸出：同 review schema 的 JSON）。
   - 自審結果照 findings 規則處理（critical/high 修、medium/low 交使用者），但**不消耗 Codex 輪次**、自審自己上限 2 輪。
   - 未審清單條目加 `selfReviewed: true`（`state --add-unreviewed ... --self-reviewed`），list 顯示「[自審]」；收工標題改為「⚠ 未經 Codex 審查（已由 Claude 自審）」。額度恢復後仍建議補審。
   - B 情境（審計畫／救援）AskUserQuestion 增加選項：「改由 Claude 自審後繼續」。
2. **多視窗計數**：`verdict=approve` 不再清除 cycle 計數（會清掉其他 session 的佔用）。approve 後若不 commit 繼續改同一批，仍受 maxRounds；commit 或 `--reset-rounds` 開新輪。
3. **update.js**：分開統計成功／跳過，任一跳過 exit 1 並印精確數字。
4. **LICENSE**：MIT，比照 claude-knowledge-plugin。

## 不做
- 不讓自審取代 Codex：自審過的條目仍留在未審清單，只是加註。
- 自審不寫進 CLI（它是 Claude 的行為，CLI 只負責 prompt 檔與 state 註記）。

## 測試
- `state --add-unreviewed --self-reviewed` → list 顯示 [自審]。
- 假 companion 回 approve 兩次 → rounds 不歸零（第 4 次仍被擋）。
- update.js：projects.local.txt 含一個不存在目錄 → exit 1、印「成功 N／跳過 M」。
- 本批改動用自審流程審一次（dogfood）。

## 審查紀錄
- 2026-08-28 Codex 額度 98%（exhausted），本批改動**改用 Claude 自審（Explore subagent，dogfood）**：needs-attention，1 HIGH + 2 MEDIUM + 3 LOW。
  - HIGH（已修）：拿掉 approve 清計數後，沒 commit 的專案 HEAD 固定 → maxRounds 變成終身上限。改為 `resetRoundIfLast`：approve 且沒有其他 session 在我之後佔用才清。
  - MEDIUM（已補規格）：rescue 的自審不能用審 diff 的 prompt → self-review.md 分 A 審 diff／B 審計畫／C rescue 重新診斷三變體；`selfReview=ask` 在 C 路徑定義為先問；手動 /review 不自審。
  - LOW（交使用者）：rounds map 無上限成長（approve 清計數後大多會清掉，殘留有限）；subagent 改用 Explore 唯讀型（已採）；`state --add-unreviewed --self-reviewed "x"` 順序反時把 --self-reviewed 當描述。
- 本批 Codex 未審（額度用完），已記未審清單。
