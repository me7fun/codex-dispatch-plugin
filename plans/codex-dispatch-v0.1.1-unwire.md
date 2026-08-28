# v0.1.1：反接線（unwire）、維護者更新腳本、清理

## 目標
1. `dispatch.mjs unwire`：移除 `/codex-dispatch:setup` 放進專案的東西，比照 wiki plugin 的 `wiki-uninstall.js`（預設 dry-run，`--yes` 才動手，只碰 plugin 自己放的檔案）。
2. `/codex-dispatch:uninstall` 指令：跑 dry-run → AskUserQuestion 確認 → `--yes` → 詢問是否順便 `claude plugin uninstall codex-dispatch@codex-dispatch-plugin --scope local`。
3. repo 根 `update.js`（維護者工具，比照 claude-knowledge-plugin）：bump patch 版本 → `claude plugin marketplace update codex-dispatch-plugin` → 對 `projects.local.txt` 列的每個專案跑 `claude plugin update ... --scope local`。`projects.local.txt` 進 .gitignore。
4. 刪 `codex-integration-handover.md`（內容已由 README / plans / wiki 涵蓋，git 歷史保留）。
5. plugin.json 0.1.0 → 0.1.1；README 補「反安裝」「維護者更新」兩節。

## unwire 規格
| 目標 | 動作 | 條件 |
|---|---|---|
| `CLAUDE.md` 的 `<!-- codex-dispatch:start/end -->` 段 | 只刪標記段（含標記行）；刪後若整檔只剩空白 → 刪檔並明示 | start/end 標記必須**恰好各一且 start 在前**；缺一、重複、順序反 → local-error 不動 |
| `.claude/codex-dispatch.config.json` | **預設保留**（是使用者設定，setup 不建立它）；`--purge-config` 才刪 | 存在才列 |
| `.claude/state/codex-dispatch.json`、`.lock`、`codex-pending.md` | **預設保留**（是工作流狀態，setup 不建立它）；`--purge-state` 才刪，且刪除在 state 鎖內進行（有其他 session 持鎖 → 等待/逾時報錯，不硬刪） | 未審清單非空 → 醒目列出 |
| `plans/`、任何非上列檔案 | **永不碰** | — |
| symlink | 拒絕（沿用 refuseSymlink） | — |

- 輸出：dry-run 列「將刪除 / 將修改（行號）」；執行後列實際結果；結尾提示 plugin 本體的 uninstall 指令。
- `--json` 回 `{ok, kind:"unwire", dryRun, actions:[{file, action, detail}], warnings:[]}`。
- 路徑一律用 `projectRoot()` + `insideRoot` 檢查；`--root <dir>` 可指定專案根（比照 wiki）。

## update.js 規格
- 純 Node，無依賴；`--no-bump` 不改版本。
- **只適用維護者本機的目錄型 marketplace**：先讀 `~/.claude/plugins/known_marketplaces.json`，`codex-dispatch-plugin` 的 source 不是 `directory` → 印「先 commit + push，marketplace update 才抓得到」並 exit 1。
- 版本來源：`plugins/codex-dispatch/.claude-plugin/plugin.json`。
- 專案清單缺檔 → 只做 bump + marketplace update，印出手動指令，exit 1。

## 測試
- unwire dry-run 於本 repo（有 CLAUDE.md？無；有 state）→ 列出 state 檔與未審警告，不動檔案。
- 假專案：建 CLAUDE.md（含標記段＋其他內容）、config、state → dry-run 列三項 → `--yes` → CLAUDE.md 只剩其他內容、其餘檔案消失、plans/ 原封不動。
- CLAUDE.md 只有一個標記 / 標記重複 / 順序反 → 報錯、不動。
- 預設不刪 config/state；`--purge-config --purge-state --yes` 才刪；state 鎖被持有時 purge-state 逾時報錯。
- CLAUDE.md 只有標記段 → 執行後檔案被刪且有明示。
- update.js `--no-bump` 於本 repo：marketplace update 成功；無 projects.local.txt → exit 1 並印指令。

## 不做
- 不刪 `~/.codex/config.toml` 的 `[windows] sandbox`（那是 Codex 設定，不是本 plugin 放的）。
- 不動官方 codex plugin。

## 計畫審查紀錄
- 2026-08-28 dispatch plan-review：needs-attention，3 HIGH + 1 MEDIUM（unwire 不該刪 setup 沒建的檔、marketplace update 不會發布本機版本、刪 state 與活動 session 競態、標記重複/順序未定義）。全部採納，已反映於上文。
- 2026-08-28 實作 diff 審查：round 1 → 2 HIGH（purge 未防 .claude symlink、state 鎖失敗時前面已動檔）已修（先規劃、state→config→CLAUDE.md 順序執行）；round 2 → 2 HIGH（執行階段無 try/catch 部分完成回報、檢查後被換 symlink）已修（每步前重驗、tmp+rename、失敗回報已完成清單）但**額度 91% 接近門檻，未再送審**；1 MEDIUM（update.js 跳過的專案算成功）交使用者決定。
