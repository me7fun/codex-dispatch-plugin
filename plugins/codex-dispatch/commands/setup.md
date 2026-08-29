---
description: 檢查 codex-dispatch 前置條件（官方 codex plugin、Codex 登入、git、Windows 沙箱、額度），並把規則段接線到本專案（CLAUDE.md 或 CLAUDE.local.md）
argument-hint: "[--write] [--local]"
allowed-tools: Bash(node:*), Read, AskUserQuestion
---

依序執行，結果如實呈現給使用者。

1. 跑 preflight：
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" preflight --json
```
2. 逐項處理 `checks`：
   - `companion` fail → 告訴使用者先在 Claude Code 執行 `/plugin marketplace add openai/codex-plugin-cc` 與 `/plugin install codex@openai-codex`，然後停止。
   - `codexCli` fail → 提示 `npm install -g @openai/codex`（可代跑）。
   - `codexAuth` fail → 提示使用者在終端機執行 `codex login`（token 過期則 `codex logout` 再 `codex login`；需要瀏覽器，不能代跑）。
   - `git` fail → 提示 `git init`（可代跑，需先確認使用者同意）。
   - `windowsSandbox` fail → 用 AskUserQuestion 問一次是否要自動寫入 `~/.codex/config.toml` 的 `[windows] sandbox = "unelevated"`；同意就跑 `preflight --write-windows-sandbox --json`。
   - `reviewGate` warn → 提醒使用者執行 `/codex:setup --disable-review-gate`（review gate 撞限額會無限迴圈）。
   - `quota` warn → 照實說明（額度用完或查不到，不影響安裝）。
3. 接線：
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" snippet --json
```
   - `presentIn` 非空 → 已接線，略過（若有 `warnings` 照實轉達）。
   - `presentIn` 為空：
     - `$ARGUMENTS` 含 `--write` → 直接寫：含 `--local` 用 `snippet --write --target local --json`，否則 `snippet --write --target claude --json`。
     - 否則用 AskUserQuestion 問一次要寫到哪（三選一）：
       - 「CLAUDE.md（進 git，全隊共用）(Recommended)」→ `snippet --write --target claude --json`
       - 「CLAUDE.local.md（只在本機，不進 git）」→ `snippet --write --target local --json`；結果若有「未被 .gitignore 忽略」的 warning，提醒使用者加一行 `CLAUDE.local.md` 到 `.gitignore`（不代改）
       - 「我自己貼」→ 把 snippet 原文印給使用者，說明兩個檔擇一
   - 回 `local-error` → 照 error 說明（例如另一檔已接線、標記畸形），不要自行改檔。
4. 最後用一段話總結：READY 或 NOT READY、接線寫在哪個檔、哪些要使用者自己做。不要開啟官方 review gate。
