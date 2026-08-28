---
description: 手動送 Codex 審查目前改動（經 codex-dispatch：額度預檢、失敗分類、未審清單）
argument-hint: "[--adversarial|--native] [--base <ref>] [--scope auto|working-tree|branch] [focus...]"
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
   - `reason=codex-error` / `invalid-output`：呈現 error，同樣記入未審清單（`--reason` 對應），**不要**再重試。
   - `reason=local-error`：這是環境問題（未裝官方 plugin、不是 git repo 等），照 error 裡的 fix 指引使用者，建議跑 `/codex-dispatch:setup`。
3. 最後問使用者要處理哪些 findings（若有）。
