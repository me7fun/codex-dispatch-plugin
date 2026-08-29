# v0.1.9：規則根 vs 審查根（submodule／多 repo 佈局）

## 情境（實際：slot-fe-client）
- Claude session 的 cwd 與規則（CLAUDE.md、`.claude/`、plans/、wiki）都在 client 根。
- 改動在 `games/<game>/`，每個 game 是 submodule（gitlink 160000），各自獨立 repo；部分 submodule 未初始化（目錄存在但 git 根解析成 client 根）。
- client 根已 gitignore `.claude/state/`；game repo 沒有。

## 名詞
- **審查根（reviewRoot）**：改動所在的 git repo 根（`--cwd` 或 cwd 的 git toplevel）。diff、HEAD、輪次 cycle key 都以它為準。
- **規則根（configRoot）**：從審查根往上（含自身）找到第一個「已接線」的目錄：有 `.claude/codex-dispatch.config.json`，或 CLAUDE.md／CLAUDE.local.md 含有效標記段。找不到 → configRoot = reviewRoot（單 repo 行為不變）。往上找以檔案系統根為止，不越過 `CLAUDE_PROJECT_DIR`（若有設且為祖先）之上。

## 規格
1. `paths.mjs`：`resolveRoots(cwd)` → `{ reviewRoot, configRoot }`。
2. `config.mjs`：`loadConfig(reviewRoot)` 內部改讀 configRoot 的設定檔。
3. `state.mjs`：`stateFile(reviewRoot)`：configRoot ≠ reviewRoot 時 → `<configRoot>/.claude/state/codex-dispatch/<basename>-<sha1(reviewRoot) 前 8>.json`；相同時維持 `<root>/.claude/state/codex-dispatch.json`。鎖檔跟著 state 檔。條目記 `reviewRoot`。
4. `plan-review`／`rescue --prompt-file`：檔案允許在 reviewRoot **或** configRoot 內（realpath 檢查各自套用）。
5. `unwire --purge-state`（在規則根執行）：一併刪 `.claude/state/codex-dispatch/` 目錄下所有檔（在各自鎖內逐檔刪）。
6. submodule 偵測改用 `git ls-files --stage`（mode 160000）＋ `.gitmodules` 聯集，涵蓋未初始化與已移除的情況。
7. `session-start.mjs`：在規則根注入時，若 repo 有 gitlink → 加一行「本 repo 含 submodule：改動在 games/x 時送審一律 `--cwd games/x`」；未審清單計數加總 `codex-dispatch/*.json`。
8. `state --list`（在規則根執行）：列出所有 sub-repo 的清單（每個 state 檔），標示 reviewRoot。
9. SKILL：明寫「規則根＝有接線的上層；審查根＝改動所在 repo；一律 `--cwd <改動所在 repo>`；plans 放規則根」。
10. `--json` 結果加 `reviewRoot`、`configRoot`。

## 不做
- 不把多個 sub-repo 的改動合併成一次審查（各自送）。
- 不自動初始化 submodule；未初始化的 submodule 目錄視為上層 repo 的一部分（gitlink 指標），送審會被 guard 擋下並提示先 `git submodule update --init`。

## 測試（scratch：client + games/g1（已初始化）+ games/g2（未初始化 gitlink））
- client 根接線（CLAUDE.local.md）；`review --cwd games/g1` → configRoot=client、reviewRoot=g1；state 落在 client/.claude/state/codex-dispatch/g1-xxxx.json；g1 內沒有 .claude/。
- `plan-review --cwd games/g1 plans/x.md`（plans 在 client）→ 接受；`plan-review --cwd games/g1 ../../outside.md` → 拒絕。
- 兩個 game 同時 review（假 companion）→ 各自 round=1，互不影響。
- client 根 `state --list` 列出兩個 game 的條目。
- 未初始化 g2：`review --cwd games/g2` → root 解析成 client，改動只有 gitlink → 擋下並提示 submodule update --init。
- 單 repo（本 repo）行為完全不變：state 路徑、config、hook 回歸。

## 計畫審查紀錄
- 2026-08-29 dispatch plan-review：needs-attention，3 HIGH + 3 MEDIUM + 1 LOW，全採納：submodule 清單改 HEAD tree + index + .gitmodules 聯集；未初始化 submodule 在 resolveRoots 直接報錯；purge 只刪符合命名且驗過內容的一般 JSON、逐檔鎖；state 頂層記 reviewRoot、canonical 路徑 + 16 hex、載入核對防碰撞；檔案引數相對呼叫者 cwd、須在審查根或規則根內；聚合 list 壞檔只警告；`reviewRoot`/`configRoot` 只加在 review/plan-review/rescue/state 結果。
- 實作測試（scratch client + g1 已初始化 + g2 未初始化）7 情境全過；單 repo 回歸不變。
