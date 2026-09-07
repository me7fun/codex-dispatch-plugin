/**
 * reviewer / planner 開關測試：reviewer=claude 時 review／plan-review／rescue／quota／preflight 不碰 Codex，
 * planner=off 時 plan-architect 不碰 agy；session-start 依設定換字。
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

function pathWithoutAgy() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter((d) => d && !["agy", "agy.exe"].some((n) => fs.existsSync(path.join(d, n))))
    .join(path.delimiter);
}

/** 假專案：git init、寫設定檔（接線）、可選本機 checks；環境完全沒有 Codex（CLAUDE_CONFIG_DIR / CODEX_HOME 都指到空目錄） */
function makeProject(name, { config = {}, checks = null, files = {}, commit = false } = {}) {
  const dir = tmpDir(`cd-sw-${name}-`);
  assert.equal(git(dir, "-c", "init.defaultBranch=main", "init", "-q").status, 0);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "codex-dispatch.config.json"), JSON.stringify(config));
  if (checks) fs.writeFileSync(path.join(dir, ".claude", "codex-dispatch.local.json"), JSON.stringify({ checks, checksTimeoutSec: 30 }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (commit) {
    assert.equal(git(dir, "add", "-A").status, 0);
    assert.equal(git(dir, "commit", "-qm", "init").status, 0);
  }
  const side = tmpDir("cd-sw-side-");
  fs.mkdirSync(path.join(side, "claude-config"));
  fs.mkdirSync(path.join(side, "codex-home"));
  return { dir, side };
}

function envFor(p, extra = {}) {
  const PATH = pathWithoutAgy();
  const env = { ...process.env, PATH, Path: PATH, CLAUDE_PROJECT_DIR: "", CLAUDE_CONFIG_DIR: path.join(p.side, "claude-config"), CODEX_HOME: path.join(p.side, "codex-home"), LOCALAPPDATA: p.side, ...extra };
  delete env.CODEX_DISPATCH_AGY;
  return env;
}

function dispatch(p, args, extra = {}) {
  const r = spawnSync(process.execPath, [DISPATCH, ...args, "--json"], { cwd: p.dir, encoding: "utf8", windowsHide: true, env: envFor(p, extra) });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const OK_CHECK = `node -e "process.exit(0)"`;
const FAIL_CHECK = `node -e "process.exit(1)"`;

test("reviewer=claude：review 沒有 Codex 也不回 local-error，跑 checks 後回 reviewer-claude（working tree 目標）", () => {
  const p = makeProject("review", { config: { reviewer: "claude" }, checks: [OK_CHECK], files: { "a.txt": "x" } });
  const r = dispatch(p, ["review"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.reason, "reviewer-claude");
  assert.equal(r.json.reviewer, "claude");
  assert.equal(r.json.target.mode, "working-tree");
  assert.equal(r.json.target.label, "working tree diff");
  assert.equal(r.json.checks.length, 1);
  assert.equal(r.json.checks[0].ok, true);
  assert.equal(r.json.quota, null);
  assert.equal(r.json.round, undefined);
  // 非 JSON 輸出印 Target／Root 給人看
  const t = spawnSync(process.execPath, [DISPATCH, "review"], { cwd: p.dir, encoding: "utf8", windowsHide: true, env: envFor(p) });
  assert.match(t.stdout, /reviewer=claude/);
  assert.match(t.stdout, /Target: working tree diff/);
  assert.match(t.stdout, /Root: /);
});

test("reviewer=claude：checks 失敗仍回 checks-failed（exit 2）", () => {
  const p = makeProject("checksfail", { config: { reviewer: "claude" }, checks: [FAIL_CHECK], files: { "a.txt": "x" } });
  const r = dispatch(p, ["review"]);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.json.reason, "checks-failed");
});

test("reviewer=claude：乾淨 feature branch 用 --base main → target 是 branch 且帶 base", () => {
  const p = makeProject("branch", { config: { reviewer: "claude" }, files: { "a.txt": "v1\n" }, commit: true });
  assert.equal(git(p.dir, "checkout", "-qb", "feat").status, 0);
  fs.writeFileSync(path.join(p.dir, "a.txt"), "v2\n");
  assert.equal(git(p.dir, "commit", "-qam", "change").status, 0);
  assert.equal(git(p.dir, "status", "--porcelain").stdout.trim(), ""); // working tree 乾淨
  const r = dispatch(p, ["review", "--base", "main"]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.reason, "reviewer-claude");
  assert.equal(r.json.target.mode, "branch");
  assert.equal(r.json.target.base, "main");
  assert.equal(r.json.target.label, "branch diff vs main");
  const r2 = dispatch(p, ["review", "--scope", "branch"]);
  assert.equal(r2.json.target.mode, "branch");
  assert.equal(r2.json.target.base, "main"); // 自動找到的基準也要回報
});

test("reviewer=claude：plan-review 回 reviewer-claude 帶計畫路徑；rescue（含 --write）也回 reviewer-claude", () => {
  const p = makeProject("planrescue", { config: { reviewer: "claude" }, files: { "plans/x.md": "# plan" } });
  const pr = dispatch(p, ["plan-review", "plans/x.md"]);
  assert.equal(pr.status, 1, pr.stdout);
  assert.equal(pr.json.reason, "reviewer-claude");
  assert.equal(pr.json.target.mode, "plan");
  assert.equal(pr.json.target.label, "plans/x.md");
  assert.equal(dispatch(p, ["plan-review", "plans/missing.md"]).json.reason, "local-error"); // 檔案檢查仍在前面
  const rs = dispatch(p, ["rescue", "it is broken"]);
  assert.equal(rs.status, 1, rs.stdout);
  assert.equal(rs.json.reason, "reviewer-claude");
  assert.equal(rs.json.write, false);
  const rw = dispatch(p, ["rescue", "--write", "it is broken"]);
  assert.equal(rw.json.reason, "reviewer-claude");
  assert.equal(rw.json.write, true);
});

test("planner=off：plan-architect 回 planner-off、假 agy 未被呼叫、不建檔", () => {
  const p = makeProject("planner", { config: { planner: "off" }, files: { "src/a.js": "x" } });
  const fake = path.join(p.side, "fake-agy.js");
  const marker = path.join(p.side, "marker.json");
  fs.writeFileSync(fake, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called"); process.stdout.write(JSON.stringify({status:"SUCCESS",response:"# x"}));`);
  const r = dispatch(p, ["plan-architect", "do thing"], { CODEX_DISPATCH_AGY: fake });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.reason, "planner-off");
  assert.equal(r.json.fallback, "claude");
  assert.ok(!fs.existsSync(marker));
  assert.ok(!fs.existsSync(path.join(p.dir, "plans")));
});

test("preflight：reviewer=claude 且沒有 Codex → ok=true，Codex 項目全 skip；planner 依設定回報", () => {
  const p = makeProject("preflight", { config: { reviewer: "claude", planner: "off" } });
  const r = dispatch(p, ["preflight"]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.ok, true);
  const by = Object.fromEntries(r.json.checks.map((c) => [c.name, c]));
  for (const n of ["companion", "codexCli", "codexAuth", "reviewGate", "windowsSandbox", "quota"]) {
    assert.equal(by[n].status, "skip", n);
    assert.equal(by[n].required, false, n);
  }
  assert.equal(by.git.status, "ok");
  assert.equal(by.planner.status, "skip");
  assert.equal(r.json.quota, null);
  const p2 = makeProject("preflight2", { config: { reviewer: "claude" } });
  const r2 = dispatch(p2, ["preflight"]);
  assert.equal(r2.json.ok, true, r2.stdout);
  const planner = r2.json.checks.find((c) => c.name === "planner");
  assert.equal(planner.status, "warn"); // PATH 去掉 agy、LOCALAPPDATA 指到空目錄 → 找不到，只 warn
  assert.equal(planner.required, false);
  // 文字輸出有「－」略過圖示
  const t = spawnSync(process.execPath, [DISPATCH, "preflight"], { cwd: p.dir, encoding: "utf8", windowsHide: true, env: envFor(p) });
  assert.match(t.stdout, /READY/);
  assert.match(t.stdout, /－ companion/);
});

test("quota：reviewer=claude 回 ok 且 disabled，不連 Codex", () => {
  const p = makeProject("quota", { config: { reviewer: "claude" } });
  const r = dispatch(p, ["quota"]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.disabled, true);
  const t = spawnSync(process.execPath, [DISPATCH, "quota"], { cwd: p.dir, encoding: "utf8", windowsHide: true, env: envFor(p) });
  assert.match(t.stdout, /已停用（reviewer=claude）/);
});

test("非法值退回預設（reviewer=codex、planner=auto）", () => {
  const p = makeProject("invalid", { config: { reviewer: "unknown", planner: "bad" } });
  const r = dispatch(p, ["preflight"]);
  assert.equal(r.json.config.reviewer, "codex");
  assert.equal(r.json.config.planner, "auto");
  assert.equal(r.json.checks.find((c) => c.name === "companion").status, "fail"); // 沒 Codex 就真的 fail
});

function sessionStart(p) {
  const r = spawnSync(process.execPath, [SESSION_START], { cwd: p.dir, encoding: "utf8", windowsHide: true, input: JSON.stringify({ cwd: p.dir }), env: envFor(p) });
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

test("session-start：四種 reviewer×planner 組合各自換字", () => {
  const cases = [
    { config: {}, has: ["Claude 寫、Codex 審", "plan-architect", "送 Codex 審計畫", "送 Codex 審 diff"], not: ["Claude 自審（"] },
    { config: { reviewer: "claude" }, has: ["Claude 自審（reviewer=claude", "plan-architect", "自審計畫", "自審 diff", "不進未審清單"], not: ["送 Codex"] },
    { config: { planner: "off" }, has: ["先寫計畫", "送 Codex 審計畫"], not: ["Antigravity", "plan-architect"] },
    { config: { reviewer: "claude", planner: "off" }, has: ["先寫計畫", "自審計畫"], not: ["Antigravity", "送 Codex"] }
  ];
  for (const c of cases) {
    const p = makeProject("ss", { config: c.config });
    const text = sessionStart(p);
    for (const s of c.has) assert.ok(text.includes(s), `${JSON.stringify(c.config)} 應含「${s}」：\n${text}`);
    for (const s of c.not) assert.ok(!text.includes(s), `${JSON.stringify(c.config)} 不應含「${s}」：\n${text}`);
  }
});

test("session-start：reviewer=claude 且未審清單殘留 → 提示 state --clear 而不是「待補審」", () => {
  const p = makeProject("residue", { config: { reviewer: "claude" } });
  fs.mkdirSync(path.join(p.dir, ".claude", "state"), { recursive: true });
  fs.writeFileSync(path.join(p.dir, ".claude", "state", "codex-dispatch.json"), JSON.stringify({ unreviewed: [{ id: "1", description: "old" }], rounds: {} }));
  const text = sessionStart(p);
  assert.match(text, /殘留 1 筆/);
  assert.match(text, /state --clear/);
  assert.ok(!text.includes("待補審"));
});
