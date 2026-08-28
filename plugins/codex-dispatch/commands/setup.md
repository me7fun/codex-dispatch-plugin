---
description: 檢查 codex-dispatch 前置條件（官方 codex plugin、Codex 登入、git、Windows 沙箱、額度），並把規則段接線到本專案 CLAUDE.md
argument-hint: "[--write]"
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
   - `codexAuth` fail → 提示使用者在終端機執行 `codex login`（需要瀏覽器，不能代跑）。
   - `git` fail → 提示 `git init`（可代跑，需先確認使用者同意）。
   - `windowsSandbox` fail → 用 AskUserQuestion 問一次是否要自動寫入 `~/.codex/config.toml` 的 `[windows] sandbox = "unelevated"`；同意就跑 `preflight --write-windows-sandbox --json`。
   - `reviewGate` warn → 提醒使用者執行 `/codex:setup --disable-review-gate`（review gate 撞限額會無限迴圈）。
   - `quota` warn → 照實說明（額度用完或查不到，不影響安裝）。
3. 接線 CLAUDE.md：
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" snippet --json
```
   - `present=false`：若 `$ARGUMENTS` 含 `--write`，直接跑 `snippet --write`；否則用 AskUserQuestion 問一次是否寫入本專案 CLAUDE.md（選項：寫入 / 我自己貼），同意才跑 `snippet --write --json`，不同意就把 snippet 原文印給使用者。
   - `present=true`：略過。
4. 最後用一段話總結：READY 或 NOT READY、哪些要使用者自己做。不要開啟官方 review gate。
