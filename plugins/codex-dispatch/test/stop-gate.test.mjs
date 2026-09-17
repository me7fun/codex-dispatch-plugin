/**
 * stop-gate 測試：reviewer=claude 時放行（含殘留未審、壞 state）；reviewer=codex 時照擋（回歸）。
 * 執行：node --test plugins/codex-dispatch/test/*.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const STOP_GATE = fileURLToPath(new URL("../scripts/stop-gate.mjs", import.meta.url));

const TMP_DIRS = [];
after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

function makeRoot({ config = {}, state = null, corruptState = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-sg-"));
  TMP_DIRS.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8", windowsHide: true });
  fs.mkdirSync(path.join(dir, ".claude", "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "codex-dispatch.config.json"), JSON.stringify(config));
  if (state) fs.writeFileSync(path.join(dir, ".claude", "state", "codex-dispatch.json"), JSON.stringify(state));
  if (corruptState) fs.writeFileSync(path.join(dir, ".claude", "state", "codex-dispatch.json"), "{not json");
  return dir;
}

function hook(mode, data, root) {
  const r = spawnSync(process.execPath, [STOP_GATE, mode], { cwd: root, encoding: "utf8", windowsHide: true, input: JSON.stringify(data), env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

/** 先 mark（本 session 真的呼叫過 dispatch review），再 gate */
function markThenGate(root, { message = "done." } = {}) {
  const session_id = `test-${crypto.randomBytes(6).toString("hex")}`;
  hook("mark", { session_id, tool_name: "Bash", tool_input: { command: `node "C:/x/scripts/dispatch.mjs" review --json` } }, root);
  const res = hook("gate", { session_id, cwd: root, stop_hook_active: false, last_assistant_message: message }, root);
  try {
    fs.unlinkSync(path.join(os.tmpdir(), `codex-dispatch-stop-${crypto.createHash("md5").update(session_id).digest("hex").slice(0, 16)}.json`));
  } catch {
    /* ignore */
  }
  return res;
}

const PENDING = { unreviewed: [{ id: "1", description: "old change" }], rounds: {} };

test("reviewer=claude ＋ 殘留未審 ＋ 沒標題 → 放行，state 不動", () => {
  const root = makeRoot({ config: { reviewer: "claude" }, state: PENDING });
  const res = markThenGate(root);
  assert.deepEqual(res, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".claude", "state", "codex-dispatch.json"), "utf8")), PENDING);
});

test("reviewer=claude ＋ 壞掉的 state 檔 → 放行", () => {
  const root = makeRoot({ config: { reviewer: "claude" }, corruptState: true });
  assert.deepEqual(markThenGate(root), {});
});

test("reviewer=codex（預設）＋ 殘留未審 ＋ 沒標題 → block（回歸）", () => {
  const root = makeRoot({ config: {}, state: PENDING });
  const res = markThenGate(root);
  assert.equal(res.decision, "block");
  assert.match(res.reason, /未經 Codex 審查/);
  assert.match(res.reason, /#1 old change/);
});

function flagPath(session_id) {
  return path.join(os.tmpdir(), `codex-dispatch-stop-${crypto.createHash("md5").update(session_id).digest("hex").slice(0, 16)}.json`);
}

/** 用指定的指令 mark，再 gate——測 INVOKE_RE 認不認得這種寫法（不認得＝閘門靜默失效） */
function markWithThenGate(root, command) {
  const session_id = `test-${crypto.randomBytes(6).toString("hex")}`;
  hook("mark", { session_id, tool_name: "Bash", tool_input: { command } }, root);
  const res = hook("gate", { session_id, cwd: root, stop_hook_active: false, last_assistant_message: "done." }, root);
  try {
    fs.unlinkSync(flagPath(session_id));
  } catch {
    /* ignore */
  }
  return res;
}

const MULTILINE_CMD = `git status
node "C:/x/scripts/dispatch.mjs" review --json`;

test("INVOKE_RE：換行分隔的呼叫也算（漏配會讓閘門靜默失效）", () => {
  const root = makeRoot({ config: {}, state: PENDING });
  assert.equal(markWithThenGate(root, MULTILINE_CMD)?.decision, "block");
});

test("INVOKE_RE：state 與 --add-unreviewed 之間夾 --cwd 也算（submodule 佈局規定要帶）", () => {
  const root = makeRoot({ config: {}, state: PENDING });
  const cmd = `node "C:/x/scripts/dispatch.mjs" state --cwd games/slot-fe-a --add-unreviewed "改了 foo"`;
  assert.equal(markWithThenGate(root, cmd)?.decision, "block");
});

test("INVOKE_RE：引用文字裡提到不算呼叫（修漏配不能放寬過頭）", () => {
  const root = makeRoot({ config: {}, state: PENDING });
  assert.deepEqual(markWithThenGate(root, `echo "node dispatch.mjs review"`), {});
});

test("continuation 輪要記下 ackDigest，下一輪正常對話不再被擋", () => {
  const root = makeRoot({ config: {}, state: PENDING });
  const session_id = `test-${crypto.randomBytes(6).toString("hex")}`;
  hook("mark", { session_id, tool_name: "Bash", tool_input: { command: `node "C:/x/scripts/dispatch.mjs" review --json` } }, root);

  // 1. 沒標題 → 擋
  assert.equal(hook("gate", { session_id, cwd: root, stop_hook_active: false, last_assistant_message: "做完了。" }, root).decision, "block");

  // 2. 補上標題；這一輪是 Stop hook 觸發的續寫 → 放行，且必須把 digest 記下來
  assert.deepEqual(hook("gate", { session_id, cwd: root, stop_hook_active: true, last_assistant_message: "⚠ 未經 Codex 審查" }, root), {});
  const flag = JSON.parse(fs.readFileSync(flagPath(session_id), "utf8"));
  assert.ok(flag.ackDigest, "continuation 輪沒記下 ackDigest → 下一輪會重複擋");
  assert.equal(flag.blockCount, 0, "blockCount 不可洩到下一輪");

  // 3. 下一輪使用者換話題、回覆沒標題 → 不該再被擋
  assert.deepEqual(hook("gate", { session_id, cwd: root, stop_hook_active: false, last_assistant_message: "不客氣！" }, root), {});

  try {
    fs.unlinkSync(flagPath(session_id));
  } catch {
    /* ignore */
  }
});

test("reviewer=codex ＋ 有標題 → 放行", () => {
  const root = makeRoot({ config: {}, state: PENDING });
  assert.deepEqual(markThenGate(root, { message: "⚠ 未經 Codex 審查\n- #1 old change" }), {});
});
