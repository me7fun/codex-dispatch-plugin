#!/usr/bin/env node
/**
 * stop-gate.mjs — 收工兜底（不呼叫 Codex，所以不會有官方 review gate 那種無限迴圈）
 *
 * 兩個模式共用 session 旗標檔 os.tmpdir()/codex-dispatch-stop-<md5(session_id)>.json：
 *
 *   mark（PostToolUse，matcher Bash|PowerShell）：
 *     真的執行過 dispatch.mjs 的 review / plan-review / rescue / state --add-unreviewed → 立 touched 旗標。
 *
 *   gate（Stop）：
 *     - stop_hook_active → 放行（防遞迴）
 *     - 本 session 沒 touched → 放行
 *     - 讀規則根（CLAUDE_PROJECT_DIR → cwd）全部 state 檔的未審清單：
 *         空 → 放行
 *         非空 且 最終回覆在 code fence 外有獨立成行的「⚠ 未經 Codex 審查」標題 → 放行，記下已確認的清單摘要（digest）
 *         非空 且 沒標題 → block 要求加標題（同一輪最多擋 2 次，之後放行但旗標保留）
 *         清單摘要與上次確認相同 → 放行（同一批未審已經標過）
 *     - state 檔壞掉／讀不到 → 視為「有未審」擋一次並附診斷（不是靜默放行）
 *   任何非預期錯誤 → 輸出 {}（fail-soft）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const MAX_BLOCKS_PER_TURN = 2;
const HEADING_RE = new RegExp("^[ \\t]*(?:>[ \\t]*)*(?:#{1,6}[ \\t]+)?(?:\\*\\*)?[ \\t]*(?:⚠[ \\t]*)?未經[ \\t]*Codex[ \\t]*審查", "i");
const FENCE_RE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/;
// 只認「node <路徑>dispatch.mjs <子指令>」這種真正的呼叫；echo／註解／引用文字不算。單一 shell 片段內（不跨 | & ;）。
const INVOKE_RE = /(?:^|[|&;]\s*)node\b[^|&;]*?[\\/]dispatch\.mjs["']?\s+(?:review|plan-review|rescue|state\s+--add-unreviewed)\b/;

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return null;
  }
}

function flagFile(data) {
  const key = data.session_id || data.transcript_path || "unknown";
  return path.join(os.tmpdir(), `codex-dispatch-stop-${crypto.createHash("md5").update(String(key)).digest("hex").slice(0, 16)}.json`);
}

function readFlag(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { blockCount: 0 };
  }
}

function writeFlag(p, st) {
  try {
    fs.writeFileSync(p, JSON.stringify(st));
  } catch {
    /* ignore */
  }
}

/** 標題須在 code fence 外獨立成行 */
function hasHeading(message) {
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of String(message).split("\n")) {
    const fence = line.match(FENCE_RE);
    if (fence) {
      const token = fence[1];
      if (!inFence) {
        inFence = true;
        fenceChar = token[0];
        fenceLen = token.length;
      } else if (token[0] === fenceChar && token.length >= fenceLen) {
        inFence = false;
      }
      continue;
    }
    if (!inFence && HEADING_RE.test(line)) return true;
  }
  return false;
}

/** 規則根：CLAUDE_PROJECT_DIR → hook 輸入的 cwd → process.cwd() */
function projectRoot(data) {
  for (const c of [process.env.CLAUDE_PROJECT_DIR, data.cwd, process.cwd()]) {
    if (c && fs.existsSync(c)) return path.resolve(c);
  }
  return process.cwd();
}

/** 讀規則根底下所有 state 檔的未審清單。回 {entries, errors} */
function pendingEntries(root) {
  const entries = [];
  const errors = [];
  const stateDir = path.join(root, ".claude", "state");
  const files = [path.join(stateDir, "codex-dispatch.json")];
  const subDir = path.join(stateDir, "codex-dispatch");
  try {
    if (fs.existsSync(subDir)) for (const n of fs.readdirSync(subDir)) if (/^[A-Za-z0-9._-]+-[0-9a-f]{16}\.json$/.test(n)) files.push(path.join(subDir, n));
  } catch (err) {
    errors.push(`無法列舉 ${subDir}：${err.message}`);
  }
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const st = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const e of Array.isArray(st.unreviewed) ? st.unreviewed : []) entries.push({ id: e.id, description: e.description, reviewRoot: st.reviewRoot || root });
    } catch (err) {
      errors.push(`state 檔讀取失敗 ${f}：${err.message}`);
    }
  }
  return { entries, errors };
}

function mark(data) {
  if (data.tool_name !== "Bash" && data.tool_name !== "PowerShell") return;
  const cmd = data.tool_input && typeof data.tool_input === "object" ? data.tool_input.command : "";
  if (typeof cmd !== "string" || !INVOKE_RE.test(cmd)) return;
  const p = flagFile(data);
  const st = readFlag(p);
  st.touched = true;
  writeFlag(p, st);
}

function gate(data) {
  if (data.stop_hook_active) return out({});
  const p = flagFile(data);
  const st = readFlag(p);
  if (!st.touched) return out({});
  const root = projectRoot(data);
  const { entries, errors } = pendingEntries(root);
  if (entries.length === 0 && errors.length === 0) {
    writeFlag(p, { touched: true, blockCount: 0, ackDigest: null });
    return out({});
  }
  const digest = crypto.createHash("md5").update(entries.map((e) => e.id).sort().join(",") + errors.join("|")).digest("hex");
  const last = typeof data.last_assistant_message === "string" ? data.last_assistant_message : "";
  if (hasHeading(last)) {
    writeFlag(p, { touched: true, blockCount: 0, ackDigest: digest });
    return out({});
  }
  if (st.ackDigest === digest) return out({}); // 同一批未審已在先前回覆標過
  if ((st.blockCount || 0) >= MAX_BLOCKS_PER_TURN) {
    writeFlag(p, { ...st, blockCount: 0 }); // 放行但旗標保留，下一輪再要求
    return out({});
  }
  writeFlag(p, { ...st, blockCount: (st.blockCount || 0) + 1 });
  const list = entries.map((e) => `- #${e.id} ${e.description}`).join("\n");
  const diag = errors.length ? `\n（state 讀取問題：${errors.join("；")}）` : "";
  out({
    decision: "block",
    reason:
      `codex-dispatch 收工檢查：未審清單仍有 ${entries.length} 筆，但最終回覆沒有「⚠ 未經 Codex 審查」標題。` +
      `請先依 Skill codex-dispatch:dispatch 的「收工前」步驟：額度可用就補審（review --cwd <repo>），否則在回覆最上方加醒目標題「⚠ 未經 Codex 審查」並逐項列出：\n${list}${diag}`
  });
}

try {
  const mode = process.argv[2] || "gate";
  const data = readStdin();
  if (!data) {
    out({});
  } else if (mode === "mark") {
    mark(data);
  } else {
    gate(data);
  }
} catch {
  out({});
}
