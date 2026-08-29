#!/usr/bin/env node
/**
 * SessionStart hook：注入一小段常駐提示（不查額度，避免啟動延遲）。
 * - 專案已接線（有 .claude/codex-dispatch.config.json 或 CLAUDE.md 含 codex-dispatch 標記）→ 注入規則摘要
 * - 未接線 → 只提示可執行 /codex-dispatch:setup
 * fail-soft：任何錯誤輸出 {}
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  // 接線段可能在 CLAUDE.md（進 git）或 CLAUDE.local.md（只在本機），Claude Code 兩個都載入。
  // 判定與 dispatch.mjs 的 locateSnippet 同一套：start/end 各恰好一個且 start 在前才算有效；壞掉的要提示修復，不能當成已接線。
  const START = "<!-- codex-dispatch:start -->";
  const END = "<!-- codex-dispatch:end -->";
  const broken = [];
  let hasMarker = false;
  for (const base of ["CLAUDE.md", "CLAUDE.local.md"]) {
    const f = path.join(root, base);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    const starts = lines.map((l, i) => (l.trim() === START ? i : -1)).filter((i) => i >= 0);
    const ends = lines.map((l, i) => (l.trim() === END ? i : -1)).filter((i) => i >= 0);
    if (starts.length === 0 && ends.length === 0) continue;
    if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) hasMarker = true;
    else broken.push(base);
  }
  const wired = hasConfig || hasMarker;

  // 未審清單：自身 + codex-dispatch/ 子目錄（submodule 佈局下各 sub-repo 的 state 集中在規則根）
  let pending = 0;
  const stateDir = path.join(root, ".claude", "state");
  const candidates = [path.join(stateDir, "codex-dispatch.json")];
  const subDir = path.join(stateDir, "codex-dispatch");
  if (fs.existsSync(subDir)) {
    for (const n of fs.readdirSync(subDir)) if (/^[A-Za-z0-9._-]+-[0-9a-f]{16}\.json$/.test(n)) candidates.push(path.join(subDir, n));
  }
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const st = JSON.parse(fs.readFileSync(f, "utf8"));
      pending += Array.isArray(st.unreviewed) ? st.unreviewed.length : 0;
    } catch {
      /* 壞檔略過 */
    }
  }
  // submodule 佈局提示：規則在這裡、改動在 sub-repo 時送審要 --cwd
  let hasGitlinks = false;
  try {
    const r = spawnSync("git", ["ls-files", "--stage"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 5000 });
    hasGitlinks = r.status === 0 && /^160000 /m.test(r.stdout);
  } catch {
    hasGitlinks = false;
  }

  const lines = wired
    ? [
        "[codex-dispatch] 本專案啟用「Claude 寫、Codex 審」：",
        "- 估計改動 >50 行或 >3 檔（或使用者說「先寫計畫」）→ 先寫計畫並送 Codex 審計畫，再實作。",
        "- 實作完成 → 送 Codex 審 diff；critical/high 修正後重審（上限 3 輪），medium/low 交使用者決定。",
        "- 同一 bug 修 2 次失敗 → 交 Codex 救援（唯讀診斷）。小改動不送審。",
        "- Codex 失敗絕不阻塞：審 diff 失敗記入未審清單、繼續；審計畫/救援失敗詢問使用者。收工前補審或逐項標記。",
        "- 完整規則與指令：先載入 Skill `codex-dispatch:dispatch` 再動工。",
        hasGitlinks ? "- 本 repo 含 submodule：改動在 sub-repo（例如 games/<game>/）時，review／plan-review／state 一律加 `--cwd <該目錄>`；各 sub-repo 的 state、輪次獨立，集中存在本根的 .claude/state/codex-dispatch/。" : null,
        pending ? `- ⚠ 未審清單有 ${pending} 筆待補審（收工前處理）。` : null,
        broken.length ? `- ⚠ ${broken.join("、")} 的 codex-dispatch 標記段損壞（start/end 不成對或順序反），setup/uninstall 會拒絕動它；請手動修正。` : null
      ].filter(Boolean)
    : [
        "[codex-dispatch] 已安裝但本專案尚未接線；需要 Codex 審查流程時執行 /codex-dispatch:setup。",
        broken.length ? `⚠ ${broken.join("、")} 含損壞的 codex-dispatch 標記段（start/end 不成對或順序反），請先手動修正再 setup。` : null
      ].filter(Boolean);

  out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
} catch {
  out({});
}
