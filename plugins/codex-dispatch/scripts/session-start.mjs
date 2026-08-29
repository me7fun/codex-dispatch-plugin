#!/usr/bin/env node
/**
 * SessionStart hook：注入一小段常駐提示（不查額度，避免啟動延遲）。
 * - 專案已接線（有 .claude/codex-dispatch.config.json 或 CLAUDE.md 含 codex-dispatch 標記）→ 注入規則摘要
 * - 未接線 → 只提示可執行 /codex-dispatch:setup
 * fail-soft：任何錯誤輸出 {}
 */
import fs from "node:fs";
import path from "node:path";

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

try {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    input = "";
  }
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(input || "{}");
    if (parsed.cwd && fs.existsSync(parsed.cwd)) cwd = parsed.cwd;
  } catch {
    /* ignore */
  }
  const root = process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR) ? process.env.CLAUDE_PROJECT_DIR : cwd;
  const hasConfig = fs.existsSync(path.join(root, ".claude", "codex-dispatch.config.json"));
  // 接線段可能在 CLAUDE.md（進 git）或 CLAUDE.local.md（只在本機），Claude Code 兩個都載入
  const hasMarker = ["CLAUDE.md", "CLAUDE.local.md"].some((base) => {
    const f = path.join(root, base);
    return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("<!-- codex-dispatch:start -->");
  });
  const wired = hasConfig || hasMarker;

  const stateFile = path.join(root, ".claude", "state", "codex-dispatch.json");
  let pending = 0;
  if (fs.existsSync(stateFile)) {
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      pending = Array.isArray(st.unreviewed) ? st.unreviewed.length : 0;
    } catch {
      pending = 0;
    }
  }

  const lines = wired
    ? [
        "[codex-dispatch] 本專案啟用「Claude 寫、Codex 審」：",
        "- 估計改動 >50 行或 >3 檔（或使用者說「先寫計畫」）→ 先寫計畫並送 Codex 審計畫，再實作。",
        "- 實作完成 → 送 Codex 審 diff；critical/high 修正後重審（上限 3 輪），medium/low 交使用者決定。",
        "- 同一 bug 修 2 次失敗 → 交 Codex 救援（唯讀診斷）。小改動不送審。",
        "- Codex 失敗絕不阻塞：審 diff 失敗記入未審清單、繼續；審計畫/救援失敗詢問使用者。收工前補審或逐項標記。",
        "- 完整規則與指令：先載入 Skill `codex-dispatch:dispatch` 再動工。",
        pending ? `- ⚠ 未審清單有 ${pending} 筆待補審（收工前處理）。` : null
      ].filter(Boolean)
    : ["[codex-dispatch] 已安裝但本專案尚未接線；需要 Codex 審查流程時執行 /codex-dispatch:setup。"];

  out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
} catch {
  out({});
}
