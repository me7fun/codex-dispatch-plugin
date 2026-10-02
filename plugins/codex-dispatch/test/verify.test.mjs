/**
 * 整份審 1 次＋只驗收修正（review --verify）：快照、delta、輪次、範圍分流、reviewer=claude 路徑。
 * 用假 companion（依佇列回應、記錄每次收到的引數與 prompt）與假 codex（額度查詢立刻失敗 → unknown，不擋流程）。
 * 執行：node --test plugins/codex-dispatch/test/*.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const DISPATCH = path.join(SCRIPTS, "dispatch.mjs");
const SESSION_START = path.join(SCRIPTS, "session-start.mjs");

const TMP_DIRS = [];
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
};
after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", windowsHide: true });

/**
 * 假 companion：每次呼叫從 $FAKE_COMPANION_DIR/queue.json 取第一筆回應，並把收到的引數與 prompt 檔內容寫進 calls.jsonl。
 * 回應：{ findings, touch: {相對路徑: 內容}（執行期間改 working tree）, fail: true（Codex 端失敗） }
 */
const FAKE_COMPANION = `
import fs from "node:fs";
import path from "node:path";
const dir = process.env.FAKE_COMPANION_DIR;
const args = process.argv.slice(2);
const queueFile = path.join(dir, "queue.json");
const queue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, "utf8")) : [];
const resp = queue.shift() ?? { findings: [] };
fs.writeFileSync(queueFile, JSON.stringify(queue));
const pf = args.indexOf("--prompt-file");
const prompt = pf >= 0 ? fs.readFileSync(args[pf + 1], "utf8") : null;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, prompt }) + "\\n");
for (const [rel, content] of Object.entries(resp.touch ?? {})) fs.writeFileSync(path.join(process.cwd(), rel), content);
const body = { verdict: (resp.findings ?? []).length ? "needs-attention" : "approve", summary: "fake", findings: resp.findings ?? [], next_steps: [] };
if (args[0] === "task") {
  process.stdout.write(JSON.stringify(resp.fail ? { status: 1, stderr: "boom" } : { status: 0, rawOutput: JSON.stringify(body), touchedFiles: [], threadId: "t" }));
} else {
  process.stdout.write(JSON.stringify(resp.fail ? { codex: { status: 1, stderr: "boom" } } : { target: { mode: "working-tree", label: "working tree diff" }, codex: { status: 0, stdout: "", stderr: "" }, result: body }));
}
`;

function makeProject(name, { config = {}, checks = null, files = { "a.txt": "v1\n" }, commit = true } = {}) {
  const dir = tmpDir(`cd-vf-${name}-`);
  assert.equal(git(dir, "-c", "init.defaultBranch=main", "init", "-q").status, 0);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "codex-dispatch.config.json"), JSON.stringify(config));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (commit) {
    assert.equal(git(dir, "add", "-A").status, 0);
    assert.equal(git(dir, "commit", "-qm", "init").status, 0);
  }
  // commit 之後才寫：本機 checks 檔被 git 追蹤時會整組停用
  if (checks) fs.writeFileSync(path.join(dir, ".claude", "codex-dispatch.local.json"), JSON.stringify({ checks, checksTimeoutSec: 30 }));
  const side = tmpDir("cd-vf-side-");
  const plugin = path.join(side, "fake-plugin");
  fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "scripts", "codex-companion.mjs"), FAKE_COMPANION);
  fs.mkdirSync(path.join(side, "claude-config", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(side, "claude-config", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "codex@openai-codex": [{ installPath: plugin, version: "9.9.9" }] } }));
  fs.mkdirSync(path.join(side, "codex-home"));
  fs.mkdirSync(path.join(side, "bin"));
  fs.writeFileSync(path.join(side, "bin", "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(side, "bin", "codex.cmd"), "@exit /b 1\r\n");
  fs.mkdirSync(path.join(side, "fake"));
  return { dir, side, fake: path.join(side, "fake") };
}

function envFor(p) {
  const PATH = [path.join(p.side, "bin"), process.env.PATH].join(path.delimiter);
  return { ...process.env, PATH, Path: PATH, CLAUDE_PROJECT_DIR: "", CLAUDE_CONFIG_DIR: path.join(p.side, "claude-config"), CODEX_HOME: path.join(p.side, "codex-home"), FAKE_COMPANION_DIR: p.fake };
}

function dispatch(p, args) {
  const r = spawnSync(process.execPath, [DISPATCH, ...args, "--json"], { cwd: p.dir, encoding: "utf8", windowsHide: true, env: envFor(p) });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const queue = (p, ...responses) => fs.writeFileSync(path.join(p.fake, "queue.json"), JSON.stringify(responses));
const calls = (p) =>
  fs.existsSync(path.join(p.fake, "calls.jsonl"))
    ? fs
        .readFileSync(path.join(p.fake, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const write = (p, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(p.dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(p.dir, rel), content);
};
const state = (p) => JSON.parse(fs.readFileSync(path.join(p.dir, ".claude", "state", "codex-dispatch.json"), "utf8"));
const snapshotOf = (p) => Object.values(state(p).snapshots ?? {})[0] ?? null;
const finding = (title, file, extra = {}) => ({ severity: "medium", title, body: `${title} body`, file, line_start: 1, line_end: 1, confidence: 0.9, recommendation: "", ...extra });
/** 檔案在 delta 裡的區塊（從它的 diff --git 標頭到下一個標頭） */
const deltaOf = (prompt) => prompt.split("----- DELTA BEGIN -----")[1].split("----- DELTA END -----")[0];

/** 起手式：a.txt 有未提交改動、整份審回 findings */
function reviewed(name, findings, opts = {}) {
  const p = makeProject(name, opts);
  write(p, "a.txt", "v2 with bug\n");
  queue(p, { findings });
  const r = dispatch(p, ["review"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { p, r };
}

test("沒有先前的整份審查：--verify 回 local-error（nextAction=full）", () => {
  const p = makeProject("nosnap");
  write(p, "a.txt", "v2\n");
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.json.reason, "local-error");
  assert.equal(r.json.nextAction, "full");
  assert.equal(calls(p).length, 0);
});

test("整份審有 findings：編號、存快照；再整份審被擋（nextAction=verify）", () => {
  const { p, r } = reviewed("full", [finding("bug one", "a.txt"), finding("shaky", "a.txt", { confidence: 0.3 })]);
  assert.equal(r.json.stage, "full");
  assert.deepEqual(r.json.findings.map((f) => f.index), [1]);
  assert.deepEqual(r.json.lowConfidence.map((f) => f.index), [2]);
  assert.match(r.json.snapshotTree, /^[0-9a-f]{40}$/);
  const snap = snapshotOf(p);
  assert.equal(snap.tree, r.json.snapshotTree);
  assert.equal(snap.findings.length, 2);
  const again = dispatch(p, ["review"]);
  assert.equal(again.status, 2, again.stdout);
  assert.equal(again.json.nextAction, "verify");
  assert.equal(calls(p).length, 1); // 第二次沒碰 companion
});

test("整份審只有 medium（verdict=approve）仍保留 cycle 與快照", () => {
  const { p, r } = reviewed("medium", [finding("only medium", "a.txt")]);
  assert.equal(r.json.verdict, "approve"); // 標籤：沒有 critical/high
  assert.equal(r.json.cycleReset, false);
  assert.ok(snapshotOf(p));
});

test("整份審沒有 findings：不留快照、cycle 清除，可再整份審", () => {
  const { p, r } = reviewed("clean", []);
  assert.equal(r.json.cycleReset, true);
  assert.equal(snapshotOf(p), null);
  queue(p, { findings: [] });
  assert.equal(dispatch(p, ["review"]).status, 0);
});

test("delta 只含快照之後的改動；untracked 新檔進 delta、被忽略的檔不進", () => {
  const { p } = reviewed("delta", [finding("bug", "a.txt")], { files: { "a.txt": "v1\n", "b.txt": "untouched\n", ".gitignore": "ignored.log\n" } });
  write(p, "a.txt", "v2 fixed\n");
  write(p, "new.txt", "brand new file\n");
  write(p, "ignored.log", "secret noise\n");
  queue(p, { findings: [] });
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.stage, "verify");
  assert.deepEqual([...r.json.delta.paths].sort(), ["a.txt", "new.txt"]);
  const c = calls(p)[1];
  assert.deepEqual(c.args.slice(0, 2), ["task", "--json"]);
  const d = deltaOf(c.prompt);
  assert.match(d, /-v2 with bug/);
  assert.match(d, /\+v2 fixed/);
  assert.match(d, /\+brand new file/);
  assert.doesNotMatch(d, /v1/); // 整份審已看過的原始改動不在 delta 裡
  assert.doesNotMatch(d, /untouched|secret noise|codex-dispatch\.json/);
  assert.equal(r.json.verdict, "approve");
  assert.equal(r.json.cycleReset, true);
  assert.equal(snapshotOf(p), null);
});

test("快照之後沒改動：--verify 回 local-error，不碰 companion", () => {
  const { p } = reviewed("nochange", [finding("bug", "a.txt")]);
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.json.error, /沒有任何改動/);
  assert.equal(calls(p).length, 1);
});

test("輪次：整份 1＋驗收 2 次，第 3 次驗收被拒（handoff）；滾動快照讓第 2 次只看新改動", () => {
  const { p } = reviewed("rounds", [finding("bug", "a.txt")]);
  write(p, "a.txt", "fix attempt 1\n");
  queue(p, { findings: [finding("still broken", "a.txt", { ref: 1 })] });
  const v1 = dispatch(p, ["review", "--verify"]);
  assert.equal(v1.status, 0, v1.stdout + v1.stderr);
  assert.equal(v1.json.round, 2);
  assert.equal(v1.json.verdict, "needs-attention");
  assert.equal(snapshotOf(p).stage, "verify");
  write(p, "a.txt", "fix attempt 2\n");
  queue(p, { findings: [finding("still broken again", "a.txt", { ref: 1 })] });
  const v2 = dispatch(p, ["review", "--verify"]);
  assert.equal(v2.status, 0, v2.stdout + v2.stderr);
  assert.equal(v2.json.round, 3);
  const d2 = deltaOf(calls(p)[2].prompt);
  assert.match(d2, /-fix attempt 1/);
  assert.match(d2, /\+fix attempt 2/);
  assert.doesNotMatch(d2, /v2 with bug/); // 第 1 次驗收已看過的那段不重送
  write(p, "a.txt", "fix attempt 3\n");
  const v3 = dispatch(p, ["review", "--verify"]);
  assert.equal(v3.status, 2, v3.stdout);
  assert.equal(v3.json.nextAction, "handoff");
  assert.equal(calls(p).length, 3);
});

test("maxRounds=1：整份審後第一次驗收就被拒（等同只審一次）", () => {
  const { p } = reviewed("max1", [finding("bug", "a.txt")], { config: { maxRounds: 1 } });
  write(p, "a.txt", "fixed\n");
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.json.nextAction, "handoff");
});

test("範圍分流：位置不在 delta 的新意見進 outOfScope，verdict=approve、cycle 清除", () => {
  const { p } = reviewed("oos", [finding("bug", "a.txt")], { files: { "a.txt": "v1\n", "b.txt": "other\n" } });
  write(p, "a.txt", "fixed\n");
  queue(p, { findings: [finding("nitpick elsewhere", "b.txt")] });
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.findings.length, 0);
  assert.equal(r.json.outOfScope.length, 1);
  assert.equal(r.json.verdict, "approve");
  assert.equal(r.json.modelVerdict, "needs-attention");
  assert.equal(r.json.cycleReset, true);
});

test("範圍分流：原 bug 沒修好（ref）即使位置不在 delta 也留在範圍內並進下一輪快照", () => {
  const { p } = reviewed("ref", [finding("bug in b", "b.txt")], { files: { "a.txt": "v1\n", "b.txt": "other\n" } });
  write(p, "a.txt", "tried to fix b's bug from here\n");
  queue(p, { findings: [finding("bug in b still there", "b.txt", { ref: 1 })] });
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.findings.length, 1);
  assert.equal(r.json.findings[0].index, 1);
  assert.equal(r.json.outOfScope.length, 0);
  assert.equal(r.json.verdict, "needs-attention");
  assert.equal(snapshotOf(p).findings[0].title, "bug in b still there");
});

test("範圍分流：delta 弄壞沒改動的呼叫端（caused_by_file 在 delta 內）算範圍內", () => {
  const { p } = reviewed("caused", [finding("bug", "a.txt")], { files: { "a.txt": "v1\n", "caller.txt": "calls a\n" } });
  write(p, "a.txt", "fixed but changed signature\n");
  queue(p, { findings: [finding("caller now breaks", "caller.txt", { caused_by_file: "a.txt" })] });
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.json.findings.length, 1);
  assert.equal(r.json.verdict, "needs-attention");
});

test("--fixed：只把指定編號列為宣稱已修；第 2 次驗收的編號指最新快照；不存在的編號被拒", () => {
  const { p } = reviewed("fixed", [finding("alpha bug", "a.txt"), finding("beta bug", "a.txt"), finding("gamma bug", "a.txt")]);
  write(p, "a.txt", "fixed alpha and gamma\n");
  assert.equal(dispatch(p, ["review", "--verify", "--fixed", "9"]).json.reason, "local-error");
  assert.equal(dispatch(p, ["review", "--verify", "--fixed", "a,b"]).json.reason, "local-error");
  assert.equal(calls(p).length, 1);
  queue(p, { findings: [finding("alpha still broken", "a.txt", { ref: 1 }), finding("regression delta", "a.txt")] });
  const v1 = dispatch(p, ["review", "--verify", "--fixed", "1,3"]);
  assert.equal(v1.status, 0, v1.stdout + v1.stderr);
  assert.deepEqual(v1.json.fixed, [1, 3]);
  const [claimed1, rest1] = calls(p)[1].prompt.split("DECLINED BY THE AUTHOR");
  assert.match(claimed1, /#1 \[medium\] alpha bug/);
  assert.match(claimed1, /#3 \[medium\] gamma bug/);
  assert.doesNotMatch(claimed1.split("CLAIMED FIXED:")[1], /beta bug/);
  assert.match(rest1.split("Output ONLY")[0], /#2 beta bug/);
  assert.deepEqual(v1.json.findings.map((f) => [f.index, f.title]), [[1, "alpha still broken"], [2, "regression delta"]]);
  write(p, "a.txt", "fixed regression too\n");
  queue(p, { findings: [] });
  const v2 = dispatch(p, ["review", "--verify", "--fixed", "2"]);
  assert.equal(v2.status, 0, v2.stdout + v2.stderr);
  const [claimed2, rest2] = calls(p)[2].prompt.split("DECLINED BY THE AUTHOR");
  assert.match(claimed2, /#2 \[medium\] regression delta/);
  assert.doesNotMatch(claimed2.split("CLAIMED FIXED:")[1], /alpha still broken/);
  assert.match(rest2.split("Output ONLY")[0], /#1 alpha still broken/);
});

test("commit 後是新的 cycle：可再整份審", () => {
  const { p } = reviewed("commit", [finding("bug", "a.txt")]);
  assert.equal(git(p.dir, "add", "a.txt").status, 0);
  assert.equal(git(p.dir, "commit", "-qm", "fix").status, 0);
  write(p, "a.txt", "next change\n");
  queue(p, { findings: [] });
  const r = dispatch(p, ["review"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.round, 1);
});

test("reviewer=claude：整份審回 snapshotTree；--verify 回 delta 的兩個 tree、不滾動快照、不碰 companion；--fixed 被拒", () => {
  const p = makeProject("claude", { config: { reviewer: "claude" } });
  write(p, "a.txt", "v2\n");
  const full = dispatch(p, ["review"]);
  assert.equal(full.json.reason, "reviewer-claude");
  assert.match(full.json.snapshotTree, /^[0-9a-f]{40}$/);
  write(p, "a.txt", "v3 fixed\n");
  const v1 = dispatch(p, ["review", "--verify"]);
  assert.equal(v1.status, 1, v1.stdout);
  assert.equal(v1.json.reason, "reviewer-claude");
  assert.equal(v1.json.stage, "verify");
  assert.equal(v1.json.delta.fromTree, full.json.snapshotTree);
  assert.deepEqual(v1.json.delta.paths, ["a.txt"]);
  assert.equal(v1.json.round, undefined);
  const diff = git(p.dir, "diff", "--no-renames", v1.json.delta.fromTree, v1.json.delta.toTree).stdout;
  assert.match(diff, /\+v3 fixed/); // subagent 自己跑這條就拿得到 delta
  const v2 = dispatch(p, ["review", "--verify"]);
  assert.deepEqual(v2.json.delta, v1.json.delta); // 沒滾動：重試拿到同一段
  assert.equal(dispatch(p, ["review", "--verify", "--fixed", "1"]).json.reason, "local-error");
  assert.equal(calls(p).length, 0);
});

test("驗收的機密閘門：把已追蹤的 .env 改名為 config.txt 再修改，仍被擋下", () => {
  const p = makeProject("secret", { files: { "a.txt": "v1\n", ".env": "TOKEN=abc\n" } });
  write(p, "a.txt", "v2\n");
  queue(p, { findings: [finding("bug", "a.txt")] });
  const full = dispatch(p, ["review", "--allow-secrets"]);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  fs.renameSync(path.join(p.dir, ".env"), path.join(p.dir, "config.txt"));
  fs.appendFileSync(path.join(p.dir, "config.txt"), "MORE=1\n");
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.json.error, /疑似機密檔案/);
  assert.match(r.json.error, /\.env/);
  assert.equal(calls(p).length, 1);
});

test("驗收前機械檢查失敗：checks-failed、不佔輪次、不碰 companion", () => {
  const { p } = reviewed("checks", [finding("bug", "a.txt")], { checks: [`node -e "process.exit(require('fs').existsSync('broken') ? 1 : 0)"`] });
  write(p, "a.txt", "fixed\n");
  write(p, "broken", "");
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.json.reason, "checks-failed");
  assert.equal(calls(p).length, 1);
  assert.equal(Object.values(state(p).rounds)[0], 1);
});

test("會改檔的 check：delta 與滾動後的快照都以檢查後的 working tree 為準", () => {
  const check = `node -e "const fs=require('fs');if(fs.existsSync('run-fmt'))fs.writeFileSync('formatted.txt','by check')"`;
  const { p } = reviewed("fmt", [finding("bug", "a.txt")], { checks: [check] });
  write(p, "a.txt", "fixed\n");
  write(p, "run-fmt", "");
  queue(p, { findings: [finding("not yet", "a.txt", { ref: 1 })] });
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.json.delta.paths.includes("formatted.txt"));
  assert.match(deltaOf(calls(p)[1].prompt), /\+by check/);
  assert.equal(snapshotOf(p).tree, r.json.delta.toTree);
  // 之後沒再改檔 → 快照與現況一致
  assert.match(dispatch(p, ["review", "--verify"]).json.error, /沒有任何改動/);
});

test("驗收失敗（codex-error）：快照保留、整份審指路 verify；輪次用完指路 handoff", () => {
  const { p } = reviewed("fail", [finding("bug", "a.txt")]);
  const before = snapshotOf(p);
  write(p, "a.txt", "fixed\n");
  queue(p, { fail: true });
  const v1 = dispatch(p, ["review", "--verify", "--retries", "0"]);
  assert.equal(v1.status, 1, v1.stdout);
  assert.equal(v1.json.reason, "codex-error");
  assert.deepEqual(snapshotOf(p), before);
  assert.equal(dispatch(p, ["review"]).json.nextAction, "verify");
  queue(p, { fail: true });
  assert.equal(dispatch(p, ["review", "--verify", "--retries", "0"]).json.reason, "codex-error");
  assert.equal(dispatch(p, ["review", "--verify"]).json.nextAction, "handoff");
});

test("整份審期間 working tree 被改：treeChangedDuringReview，快照是送出前的 tree", () => {
  const p = makeProject("live");
  write(p, "a.txt", "v2 with bug\n");
  queue(p, { findings: [finding("bug", "a.txt")], touch: { "late.txt": "written during review\n" } });
  const r = dispatch(p, ["review"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.treeChangedDuringReview, true);
  queue(p, { findings: [] });
  const v = dispatch(p, ["review", "--verify"]);
  assert.deepEqual(v.json.delta.paths, ["late.txt"]); // 審查期間寫入的檔算進下次 delta，不會漏
});

test("快照的 tree 物件不存在：local-error", () => {
  const { p } = reviewed("gone", [finding("bug", "a.txt")]);
  const file = path.join(p.dir, ".claude", "state", "codex-dispatch.json");
  const st = state(p);
  for (const k of Object.keys(st.snapshots)) st.snapshots[k].tree = "0123456789012345678901234567890123456789";
  fs.writeFileSync(file, JSON.stringify(st));
  write(p, "a.txt", "fixed\n");
  const r = dispatch(p, ["review", "--verify"]);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.json.error, /快照已失效/);
});

test("--verify 不支援 --strict／--native／focus 文字；--fixed 不能單獨用", () => {
  const { p } = reviewed("flags", [finding("bug", "a.txt")]);
  write(p, "a.txt", "fixed\n");
  for (const args of [["review", "--verify", "--strict"], ["review", "--verify", "--native"], ["review", "--verify", "please look at x"], ["review", "--fixed", "1"]]) {
    const r = dispatch(p, args);
    assert.equal(r.status, 2, `${args.join(" ")}：${r.stdout}`);
    assert.equal(r.json.reason, "local-error");
  }
  assert.equal(calls(p).length, 1);
});

test("--reset-rounds：清掉快照與輪次，可重新整份審", () => {
  const { p } = reviewed("reset", [finding("bug", "a.txt")]);
  queue(p, { findings: [] });
  const r = dispatch(p, ["review", "--reset-rounds"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.round, 1);
});

test("session-start：開場摘要是新流程，不再有舊規則的字眼", () => {
  for (const config of [{}, { reviewer: "claude" }]) {
    const p = makeProject("ss", { config });
    const r = spawnSync(process.execPath, [SESSION_START], { cwd: p.dir, encoding: "utf8", windowsHide: true, input: JSON.stringify({ cwd: p.dir }), env: envFor(p) });
    const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /review --verify/);
    assert.match(text, /不分 severity/);
    for (const stale of ["上限 3 輪", "上限 2 輪", "medium/low 交使用者", "修正後重審"]) assert.ok(!text.includes(stale), `不該再出現「${stale}」：\n${text}`);
  }
});

test(".claude/state/ 被 .gitignore 忽略（實際專案的常態）：整份審仍存得了快照", () => {
  const { p, r } = reviewed("ignoredstate", [finding("bug", "a.txt")], { files: { "a.txt": "v1\n", ".gitignore": ".claude/state/\n" } });
  assert.equal(r.json.snapshotError, undefined);
  assert.match(r.json.snapshotTree ?? "", /^[0-9a-f]{40}$/);
  write(p, "a.txt", "fixed\n");
  queue(p, { findings: [] });
  const v = dispatch(p, ["review", "--verify"]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.deepEqual(v.json.delta.paths, ["a.txt"]);
});

test("force-add 的被忽略檔（git add -f）在快照裡：之後對它的修正進得了 delta", () => {
  const p = makeProject("forceadd", { files: { "a.txt": "v1\n", ".gitignore": "generated.js\n" } });
  write(p, "generated.js", "buggy output\n");
  assert.equal(git(p.dir, "add", "-f", "generated.js").status, 0);
  queue(p, { findings: [finding("bug in generated", "generated.js")] });
  assert.equal(dispatch(p, ["review"]).status, 0);
  write(p, "generated.js", "fixed output\n");
  queue(p, { findings: [] });
  const v = dispatch(p, ["review", "--verify"]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.deepEqual(v.json.delta.paths, ["generated.js"]);
  const d = deltaOf(calls(p)[1].prompt);
  assert.match(d, /-buggy output/);
  assert.match(d, /\+fixed output/);
});

test("被標 assume-unchanged／skip-worktree 的檔：之後的修正仍進得了 delta", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const p = makeProject("flagged", { files: { "a.txt": "v1\n", "b.txt": "b v1\n" } });
    assert.equal(git(p.dir, "update-index", flag, "b.txt").status, 0);
    write(p, "a.txt", "v2 with bug\n");
    queue(p, { findings: [finding("bug needs change in b", "b.txt")] });
    assert.equal(dispatch(p, ["review"]).status, 0);
    write(p, "b.txt", "b fixed\n");
    queue(p, { findings: [] });
    const v = dispatch(p, ["review", "--verify"]);
    assert.equal(v.status, 0, `${flag}：${v.stdout}${v.stderr}`);
    assert.deepEqual(v.json.delta.paths, ["b.txt"], flag);
    // 使用者真正的 index 旗標不能被動到
    assert.match(git(p.dir, "ls-files", "-v", "b.txt").stdout, flag === "--assume-unchanged" ? /^h b\.txt/ : /^S b\.txt/);
  }
});
