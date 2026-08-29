# v0.1.4：接線目標可選 CLAUDE.md（進 git）或 CLAUDE.local.md（只在本機）

## 問題
setup / snippet --write 只會寫 CLAUDE.md；unwire 只會找 CLAUDE.md；session-start 只認 CLAUDE.md 的標記。
使用者若把段落放在 CLAUDE.local.md（Claude Code 原生支援、慣例不進 git），setup 會重複寫進 CLAUDE.md、uninstall 找不到、開場注入說「尚未接線」。

## 規格
- 兩個合法目標：`CLAUDE.md`（進 git，全隊共用）、`CLAUDE.local.md`（只在本機；Claude Code 會一起載入）。
- `snippet`：
  - 預覽輸出 `presentIn: ["CLAUDE.md"|"CLAUDE.local.md"...]`（可能兩者都有 → warning）。
  - `--write [--target claude|local]`：明確指定目標；未指定時，若已有一個檔含標記 → 更新那個檔；都沒有 → 預設 `CLAUDE.md`。兩者都有 → local-error 要求先清理。
  - 寫 `CLAUDE.local.md` 時檢查 `.gitignore` 是否忽略它；沒有 → warning 建議加（不自動改 .gitignore）。
- `unwire`：同時找兩個檔，有標記的都處理（各自 symlink 檢查、雜湊比對、備份）。標記數量/順序錯誤 → 該檔報錯、整體中止（規劃階段，未動任何檔）。
- `session-start.mjs`：任一檔含標記即視為已接線。
- `commands/setup.md`：AskUserQuestion 三選一：「寫入 CLAUDE.md（進 git，全隊共用）」「寫入 CLAUDE.local.md（只在本機）」「我自己貼」。已接線則略過。
- `commands/uninstall.md`、README：文字更新。
- `--json` 結果物件加 `target`（snippet）與每個 action 的 `file`（unwire 已有）。

## 不做
- 不搬移既有段落（CLAUDE.md ↔ CLAUDE.local.md）；要換目標請先 uninstall 再 setup。
- 不自動改 .gitignore。

## 測試
- 假專案：`snippet --write --target local` → CLAUDE.local.md 有段、CLAUDE.md 不存在；`snippet` 預覽 presentIn=["CLAUDE.local.md"]；再 `--write` 不指定 → 更新 local 而非新建 CLAUDE.md；hook 回「已接線」；`unwire --yes` 從 local 移除。
- 兩檔都有標記 → snippet --write 拒絕；unwire 兩個都清。
- .gitignore 沒列 CLAUDE.local.md → warning。

## 計畫審查紀錄
- 2026-08-29 dispatch plan-review：needs-attention，2 HIGH（明確 --target 可能雙重接線、snippet 未規定畸形標記行為）+ 2 MEDIUM（.gitignore 判定要用 git 有效規則、測試缺跨目標/畸形案例）+ 1 LOW（target 欄位多餘）。全部採納：寫入前掃描兩檔、共用 locateSnippet、git check-ignore + ls-files、不加 target 欄位、補測試。
- 2026-08-29 實作 diff 審查 round 1：1 HIGH（多檔 unwire 第二檔檢查晚於第一檔刪除）已修（所有目標先驗證＋備份再動手）；1 MEDIUM（session-start 只比對 start 字串，畸形標記也算已接線）交使用者決定。
- round 2：1 HIGH（preflight 雜湊與實際 unlink/rename 之間仍有窗口）已修（每個目標動手前一刻再比對雜湊）。
- round 3：1 HIGH（snippet 寫入沒在鎖內重掃，兩視窗同時 setup 可能各寫一檔）已修（withLock 內掃描→決定→寫，rename 前比對原文，temp 失敗清除）；**已達 maxRounds 未再送審**，記入未審清單。
