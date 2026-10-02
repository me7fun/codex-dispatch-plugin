---
description: 手動送 Codex 審查目前改動（經 codex-dispatch：額度預檢、失敗分類、未審清單）
argument-hint: "[--adversarial|--native|--strict] [--verify [--fixed 1,3]] [--base <ref>] [--scope auto|working-tree|branch] [focus...]"
allowed-tools: Bash(node:*), Bash(git:*)
---

這是**人工觸發**的審查：呈現結果，**不要**自動修改任何檔案，修哪些由使用者決定。

1. 前景執行（不要 run_in_background）：
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" review $ARGUMENTS
```
2. 呈現：
   - 成功：把 stdout 原樣呈現（findings 已依 severity 排序）。若未審清單原本非空，只清除本次確實涵蓋的條目（`changedPaths` 仍在 working tree 且 `headSha` 相同）：`state --clear --id <id>`，並告知；其餘保留。
   - `reason=quota`：說明額度用完與重置時間；把本次改動記入未審清單：`state --add-unreviewed "<一句話描述改動>" --reason quota`。
   - `reason=codex-error` / `invalid-output`：呈現 error，同樣記入未審清單（`--reason` 對應），**不要**再重試。本指令是人工觸發，**不做** Claude 自審；使用者要的話可以說「幫我自審」，再依 Skill `codex-dispatch:dispatch` 的自審流程做。
   - `reason=local-error`：多半是環境問題（未裝官方 plugin、不是 git repo 等），照 error 裡的 fix 指引使用者，建議跑 `/codex-dispatch:setup`。例外是帶 `nextAction` 的：`verify`＝這批改動已整份審過，改跑 `review --verify`（只驗收上次送審之後的修正；`--fixed 1,3` 指出修了哪幾條，省略＝全部）；`full`＝還沒整份審過，先跑不帶 `--verify` 的 review；`handoff`＝同一批改動已送滿 `maxRounds` 次，commit 後才開新一輪（或使用者明說後加 `--reset-rounds`）。
   - `--verify` 成功：`Findings` 是沒修好的原 bug 與修正造成的新缺陷；`Out of scope` 是不在這次修正範圍內的意見，只呈現。
   - `reason=reviewer-claude`（輸出以「○ review：reviewer=claude」開頭）：本專案設定不用 Codex。用 `Agent`（Explore 唯讀）跑 `${CLAUDE_PLUGIN_ROOT}/prompts/self-review.md` 的 **A. 審 diff** 變體，`{{TARGET}}`／`{{ROOT}}` 照輸出的 `Target:`／`Root:` 行填、`{{FOCUS}}` 填 `$ARGUMENTS` 的 focus（帶 `--verify` 時改用 **D. 驗收修正** 變體，兩個 tree 照輸出的 `Delta:` 行填）；結果照 findings 格式呈現。仍然不自動修、不記未審清單、不加任何標題。
3. 最後問使用者要處理哪些 findings（若有）。
