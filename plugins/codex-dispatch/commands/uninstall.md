---
description: 反接線：移除 setup 寫進本專案 CLAUDE.md 或 CLAUDE.local.md 的 codex-dispatch 段（自動偵測在哪；預設只預覽），並可選擇一併移除 plugin 本體
argument-hint: "[--purge-config] [--purge-state]"
allowed-tools: Bash(node:*), Bash(claude:*), AskUserQuestion
---

1. 先預覽（不動任何檔案），把 stdout 原樣呈現：
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" unwire $ARGUMENTS
```
2. 若輸出有「將執行」清單或警告：
   - 未審清單非空的警告要**特別提醒**使用者（這些改動沒經 Codex 審查）。
   - 用 AskUserQuestion 問一次是否執行（選項：執行 / 取消）。使用者選執行才跑：
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" unwire --yes $ARGUMENTS
```
   - 沒有可移除的接線 → 直接說明，跳到第 3 步。
3. 用 AskUserQuestion 問是否一併移除 plugin 本體（選項：移除 / 保留）。選移除才跑：
```bash
claude plugin uninstall codex-dispatch@codex-dispatch-plugin --scope local
```
4. 總結做了什麼、沒做什麼。不要碰 `plans/`、`~/.codex/config.toml`、官方 codex plugin。`.claude/codex-dispatch.config.json` 與 `.claude/state/` 預設保留，使用者要清才加 `--purge-config` / `--purge-state`（後者需先關閉其他 Claude session）。
