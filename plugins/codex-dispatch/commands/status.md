---
description: 顯示 Codex 額度（不耗額度）與本專案未審清單
allowed-tools: Bash(node:*)
---

執行以下兩個指令，把 stdout 原樣呈現（不要改寫、不要補充猜測）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" quota
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" state --list
```

若額度為 `unknown`，說明是查詢失敗（見 error），建議使用者到 Codex CLI 互動模式打 `/status` 確認。
若未審清單非空且額度 `available`，提示使用者可執行 `/codex-dispatch:review` 補審。
