/**
 * plan-architect 子指令測試：用假 agy（經 CODEX_DISPATCH_AGY 注入的 node 腳本）驗證輸出格式、參數、機密閘門、指紋與各種錯誤捕獲。
 * 執行：node --test plugins/codex-dispatch/test/*.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DISPATCH = fileURLToPath(new URL("../scripts/dispatch.mjs", import.meta.url));
const WIN = process.platform === "win32";

/** PATH 去掉所有含 agy 的目錄（避免測到真的 agy） */
function pathWithoutAgy() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter((d) => d && !["agy", "agy.exe"].some((n) => fs.existsSync(path.join(d, n))))
    .join(path.delimiter);
}

const FAKE_AGY_JS = `
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const cwd = process.cwd();
const walk = (d, prefix, acc) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + "/", acc); else acc.push(prefix + e.name); } return acc; };
let files = null;
try { files = walk(cwd, "", []).sort(); } catch { files = null; }
if (process.env.FAKE_AGY_OUT) fs.writeFileSync(process.env.FAKE_AGY_OUT, JSON.stringify({ argv, cwd, files }));
if (process.env.FAKE_AGY_WRITE) fs.writeFileSync(path.join(cwd, process.env.FAKE_AGY_WRITE), "pwned");
if (process.env.FAKE_AGY_APPEND) fs.appendFileSync(path.join(cwd, process.env.FAKE_AGY_APPEND), "\\nmore");
if (process.env.FAKE_AGY_MKFILE_ABS) { fs.mkdirSync(path.dirname(process.env.FAKE_AGY_MKFILE_ABS), { recursive: true }); fs.writeFileSync(process.env.FAKE_AGY_MKFILE_ABS, "someone else"); }
const sleep = Number(process.env.FAKE_AGY_SLEEP_MS || 0);
if (sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep);
if (process.env.FAKE_AGY_EXIT) { process.stderr.write("fake agy boom\\n"); process.exit(Number(process.env.FAKE_AGY_EXIT)); }
if (process.env.FAKE_AGY_STDOUT !== undefined) { process.stdout.write(process.env.FAKE_AGY_STDOUT); process.exit(0); }
let resp = process.env.FAKE_AGY_RESPONSE !== undefined ? process.env.FAKE_AGY_RESPONSE : "# Fake plan\\n\\n## 目標\\nSee [index.js](file:///C:/x/index.js#L1) and [add](file:///C:/x/index.js).\\n";
if (process.env.FAKE_AGY_ECHO_CWD) resp = "# Echo\\n\\nnative: " + cwd + "\\\\src\\\\a.js\\nfwd: " + cwd.replace(/\\\\/g, "/") + "/src/a.js\\nurl: " + require("node:url").pathToFileURL(path.join(cwd, "src", "a.js")).href + "\\n";
const payload = { conversation_id: "fake-conv", status: process.env.FAKE_AGY_STATUS || "SUCCESS", response: resp, duration_seconds: 1.5, num_turns: 1, usage: { input_tokens: 1 } };
if (process.env.FAKE_AGY_ERROR) payload.error = process.env.FAKE_AGY_ERROR;
if (process.env.FAKE_AGY_DENIED) payload.denied_actions = [{ action: process.env.FAKE_AGY_DENIED, display_name: "X" }];
process.stdout.write(JSON.stringify(payload));
`;

const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", windowsHide: true });

/** 所有 tmp 目錄跑完一律清掉（每案例 2 個，不清會在 %TEMP% 越積越多） */
const TMP_DIRS = [];
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
};
after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

function makeProject(name, { files = {}, commit = false } = {}) {
  const dir = tmpDir(`cd-pa-${name}-`);
  assert.equal(git(dir, "init", "-q").status, 0);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (commit) {
    assert.equal(git(dir, "add", "-A").status, 0);
    assert.equal(git(dir, "commit", "-qm", "init").status, 0);
  }
  // 假 agy 與記號檔放 repo 外（不能污染工作區清單與指紋）
  const side = tmpDir("cd-pa-side-");
  fs.writeFileSync(path.join(side, "fake-agy.js"), FAKE_AGY_JS);
  return { dir, fake: path.join(side, "fake-agy.js"), marker: path.join(side, "marker.json"), side };
}

function run(p, args, { env = {}, fake = true } = {}) {
  const PATH = pathWithoutAgy();
  const spawnEnv = { ...process.env, PATH, Path: PATH, FAKE_AGY_OUT: p.marker, CLAUDE_PROJECT_DIR: "", ...env };
  if (fake) spawnEnv.CODEX_DISPATCH_AGY = p.fake;
  else {
    delete spawnEnv.CODEX_DISPATCH_AGY;
    spawnEnv.LOCALAPPDATA = p.side; // 沒有 agy/bin
  }
  const r = spawnSync(process.execPath, [DISPATCH, "plan-architect", ...args, "--json"], { cwd: p.dir, encoding: "utf8", windowsHide: true, env: spawnEnv });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  const calls = fs.existsSync(p.marker) ? JSON.parse(fs.readFileSync(p.marker, "utf8")) : null;
  try {
    fs.unlinkSync(p.marker);
  } catch {
    /* ignore */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, calls };
}

test("成功：寫出計畫檔、JSON 欄位齊全、argv 安全（plan mode、add-dir＝淨化副本、skip-permissions、-p 最後）、連結壓平", () => {
  const p = makeProject("ok", { files: { "src/a.js": "x" } });
  const r = run(p, ["Add a login page with OAuth"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.kind, "plan-architect");
  assert.equal(r.json.reason, null);
  assert.equal(r.json.outputRel, "plans/add-a-login-page-with-oauth.md");
  assert.ok(fs.existsSync(r.json.output));
  const doc = fs.readFileSync(r.json.output, "utf8");
  assert.match(doc, /^# Fake plan\n/);
  assert.match(doc, /> Antigravity CLI 規劃草案/);
  assert.match(doc, /conversation：fake-conv/);
  assert.match(doc, /> 需求：Add a login page with OAuth/);
  assert.match(doc, /See index\.js and add\./);
  assert.ok(!doc.includes("file:///"));
  assert.match(doc, /## 計畫審查紀錄\n- （尚未經 Codex plan-review）/);
  assert.equal(r.json.agy.conversationId, "fake-conv");
  assert.ok(Array.isArray(r.json.nextSteps) && r.json.nextSteps.some((s) => s.includes("plan-review")));
  const argv = r.calls.argv;
  const i = (flag) => argv.indexOf(flag);
  assert.ok(i("--mode") >= 0 && argv[i("--mode") + 1] === "plan");
  assert.ok(i("--output-format") >= 0 && argv[i("--output-format") + 1] === "json");
  assert.ok(i("--add-dir") >= 0);
  const addDir = argv[i("--add-dir") + 1];
  assert.notEqual(path.resolve(addDir), path.resolve(fs.realpathSync.native(p.dir))); // 交給 agy 的不是真目錄
  assert.match(path.basename(addDir), /^codex-dispatch-agy-/);
  assert.ok(!fs.existsSync(addDir), "副本用完即刪");
  assert.equal(path.resolve(r.calls.cwd), path.resolve(addDir));
  assert.deepEqual(r.calls.files, ["src/a.js"]);
  assert.equal(r.json.workspace.mode, "sandbox-copy");
  assert.equal(r.json.workspace.files, 1);
  assert.deepEqual(r.json.workspace.excluded, []);
  assert.ok(i("--print-timeout") >= 0 && /^\d+s$/.test(argv[i("--print-timeout") + 1]));
  assert.equal(argv[argv.length - 2], "-p");
  assert.match(argv[argv.length - 1], /Add a login page with OAuth/);
  assert.match(argv[argv.length - 1], /READ-ONLY/);
  assert.match(argv[argv.length - 1], /sanitized copy/);
  assert.ok(argv.includes("--dangerously-skip-permissions")); // print 模式沒人能答工具確認，不帶會被 soft-deny 成空回應
});

test("--no-sandbox-copy：add-dir 與 cwd 是真目錄，prompt 不提副本", () => {
  const p = makeProject("direct", { files: { "src/a.js": "x" } });
  const r = run(p, ["do thing", "--no-sandbox-copy"]);
  assert.equal(r.status, 0, r.stdout);
  const argv = r.calls.argv;
  assert.equal(path.resolve(argv[argv.indexOf("--add-dir") + 1]), path.resolve(fs.realpathSync.native(p.dir)));
  assert.equal(path.resolve(r.calls.cwd), path.resolve(fs.realpathSync.native(p.dir)));
  assert.ok(!/sanitized copy/.test(argv[argv.length - 1]));
  assert.equal(r.json.workspace.mode, "direct");
});

test("淨化副本：agy 回應裡的副本路徑（原生／正斜線／file URL）全部換回真目錄", () => {
  const p = makeProject("rewrite", { files: { "src/a.js": "x" } });
  const r = run(p, ["do thing"], { env: { FAKE_AGY_ECHO_CWD: "1" } });
  assert.equal(r.status, 0, r.stdout);
  const doc = fs.readFileSync(r.json.output, "utf8");
  const real = fs.realpathSync.native(p.dir);
  assert.ok(!/codex-dispatch-agy-/.test(doc), doc);
  assert.ok(doc.includes(`${real}${path.sep}src${path.sep}a.js`) || doc.toLowerCase().includes(`${real}${path.sep}src${path.sep}a.js`.toLowerCase()), doc);
  assert.ok(doc.toLowerCase().includes(`${real.replace(/\\/g, "/")}/src/a.js`.toLowerCase()), doc);
  assert.ok(!/codex-dispatch-agy-/.test(r.json.raw));
});

test("未安裝 agy → agy-not-installed、exit 1、不建檔", () => {
  const p = makeProject("missing");
  const r = run(p, ["anything"], { fake: false });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.reason, "agy-not-installed");
  assert.equal(r.json.fallback, "claude");
  assert.ok(!fs.existsSync(path.join(p.dir, "plans")));
});

test("PATH 上的 agy（Unix sh shim）也找得到", (t) => {
  if (WIN) {
    t.skip("Windows 只認 .exe，假的做不出來");
    return;
  }
  const p = makeProject("pathbin");
  const bin = path.join(p.side, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${p.fake}" "$@"\n`);
  fs.chmodSync(path.join(bin, "agy"), 0o755);
  const PATH = `${bin}${path.delimiter}${pathWithoutAgy()}`;
  const r = run(p, ["do thing"], { fake: false, env: { PATH, Path: PATH } });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.agy.bin, path.join(bin, "agy"));
});

test("agy exit 非 0 → agy-error 含 stderr；status ERROR → agy-error 含 error；不建檔", () => {
  const p = makeProject("exit");
  const r = run(p, ["do thing"], { env: { FAKE_AGY_EXIT: "3" } });
  assert.equal(r.status, 1);
  assert.equal(r.json.reason, "agy-error");
  assert.match(r.json.error, /fake agy boom/);
  const r2 = run(p, ["do thing"], { env: { FAKE_AGY_STATUS: "ERROR", FAKE_AGY_ERROR: "model quota exceeded" } });
  assert.equal(r2.json.reason, "agy-error");
  assert.match(r2.json.error, /quota exceeded/);
  assert.ok(!fs.existsSync(path.join(p.dir, "plans", "do-thing.md")));
});

test("invalid-output：stdout 非 JSON／讀檔被拒／回應空白／回應沒有標題", () => {
  const p = makeProject("invalid");
  assert.equal(run(p, ["do thing"], { env: { FAKE_AGY_STDOUT: "not json at all" } }).json.reason, "invalid-output");
  const d = run(p, ["do thing"], { env: { FAKE_AGY_DENIED: "read_file", FAKE_AGY_RESPONSE: "" } });
  assert.equal(d.json.reason, "invalid-output");
  assert.match(d.json.error, /soft-deny/);
  assert.match(d.json.error, /--dangerously-skip-permissions/);
  assert.ok(!/add-dir|沒被加入/.test(d.json.error));
  assert.equal(run(p, ["do thing"], { env: { FAKE_AGY_RESPONSE: "   " } }).json.reason, "invalid-output");
  const n = run(p, ["do thing"], { env: { FAKE_AGY_RESPONSE: "I generated the implementation plan at file:///x/plan.md for your review." } });
  assert.equal(n.json.reason, "invalid-output");
  assert.match(n.json.error, /標題/);
  assert.ok(!fs.existsSync(path.join(p.dir, "plans")));
});

test("指紋：agy 建新檔／改本來就 dirty 的 tracked 檔／改既有 untracked 檔 → 都是 agy-error", () => {
  const p = makeProject("fp", { files: { "src/a.js": "v1\n", "notes.txt": "n1\n" }, commit: true });
  fs.writeFileSync(path.join(p.dir, "src", "a.js"), "v2\n"); // tracked，已 dirty
  fs.writeFileSync(path.join(p.dir, "scratch.txt"), "u1\n"); // untracked
  // 淨化副本模式：agy 的 cwd 是副本，相對路徑寫入只弄髒副本（用完即刪），真 repo 不動 → 仍成功
  const sb = run(p, ["do thing"], { env: { FAKE_AGY_WRITE: "PWNED.txt" } });
  assert.equal(sb.status, 0, sb.stdout);
  assert.ok(!fs.existsSync(path.join(p.dir, "PWNED.txt")));
  fs.rmSync(path.join(p.dir, "plans"), { recursive: true, force: true });
  // 真目錄模式：任何變動都是 agy-error
  const r1 = run(p, ["do thing", "--no-sandbox-copy"], { env: { FAKE_AGY_WRITE: "PWNED.txt" } });
  assert.equal(r1.json.reason, "agy-error", r1.stdout);
  assert.match(r1.json.error, /工作區有變動/);
  fs.unlinkSync(path.join(p.dir, "PWNED.txt"));
  const r2 = run(p, ["do thing", "--no-sandbox-copy"], { env: { FAKE_AGY_APPEND: path.join("src", "a.js") } });
  assert.equal(r2.json.reason, "agy-error", r2.stdout);
  const r3 = run(p, ["do thing", "--no-sandbox-copy"], { env: { FAKE_AGY_APPEND: "scratch.txt" } });
  assert.equal(r3.json.reason, "agy-error", r3.stdout);
  assert.ok(!fs.existsSync(path.join(p.dir, "plans")));
  // 副本模式下用絕對路徑改真 repo 一樣抓得到
  const r4 = run(p, ["do thing"], { env: { FAKE_AGY_MKFILE_ABS: path.join(p.dir, "PWNED2.txt") } });
  assert.equal(r4.json.reason, "agy-error", r4.stdout);
  fs.unlinkSync(path.join(p.dir, "PWNED2.txt"));
  const ok = run(p, ["do thing"]);
  assert.equal(ok.status, 0, ok.stdout);
});

test("輸出檔在 agy 執行期間被建立（無 --force）→ local-error、原內容保留；--force 才覆寫", () => {
  // plans/ 放進 .gitignore：ignored 不在指紋內，才測得到 wx 這一層
  const p = makeProject("clobber", { files: { ".gitignore": "plans/\n" } });
  const dest = path.join(p.dir, "plans", "do-thing.md");
  const r = run(p, ["do thing"], { env: { FAKE_AGY_MKFILE_ABS: dest } });
  assert.equal(r.json.reason, "local-error", r.stdout);
  assert.match(r.json.error, /執行期間被建立/);
  assert.equal(fs.readFileSync(dest, "utf8"), "someone else");
  const r2 = run(p, ["do thing", "--force"], { env: { FAKE_AGY_RESPONSE: "# Second" } });
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(fs.readFileSync(dest, "utf8"), /^# Second/);
});

test("逾時 → agy-error（父程序 timeout+5s 兜底）", () => {
  const p = makeProject("timeout");
  const r = run(p, ["do thing", "--timeout", "5"], { env: { FAKE_AGY_SLEEP_MS: "12000" } });
  assert.equal(r.status, 1);
  assert.equal(r.json.reason, "agy-error");
  assert.match(r.json.error, /逾時/);
});

test("引數驗證：--model 元字元／--effort 非法／--timeout 0 → local-error、agy 未被呼叫", () => {
  const p = makeProject("args");
  for (const args of [["do thing", "--model", "x;calc"], ["do thing", "--effort", "ultra"], ["do thing", "--timeout", "0"], []]) {
    const r = run(p, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.json.reason, "local-error");
    assert.equal(r.calls, null);
  }
  const ok = run(p, ["do thing", "--model", "gemini-3.1-pro", "--effort", "high"]);
  assert.equal(ok.status, 0, ok.stdout);
  const i = ok.calls.argv.indexOf("--effort");
  assert.equal(ok.calls.argv[i + 1], "high");
});

test("機密：根 .env → 淨化副本不複製它、照常成功並列在 excluded；--allow-secrets 才複製；--no-sandbox-copy 整個拒絕", () => {
  const p = makeProject("secret", { files: { ".env": "KEY=1", "src/a.js": "x" } });
  const r = run(p, ["do thing"]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.calls.files, ["src/a.js"]); // agy 物理上讀不到 .env
  assert.deepEqual(r.json.workspace.excluded, [".env"]);
  fs.rmSync(path.join(p.dir, "plans"), { recursive: true, force: true });
  const r2 = run(p, ["do thing", "--allow-secrets"]);
  assert.equal(r2.status, 0, r2.stdout);
  assert.deepEqual(r2.calls.files, [".env", "src/a.js"]);
  assert.deepEqual(r2.json.workspace.excluded, []);
  const r3 = run(p, ["do thing", "--no-sandbox-copy", "--force"]);
  assert.equal(r3.status, 2);
  assert.equal(r3.json.reason, "local-error");
  assert.match(r3.json.error, /\.env/);
  assert.match(r3.json.error, /Antigravity/);
  assert.match(r3.json.error, /淨化副本/);
  assert.match(r3.json.error, /--cwd <子 repo>/);
  assert.equal(r3.calls, null);
});

test("機密：gitignored .env 與忽略目錄內的 .pem 根本不複製（不在 excluded，因為 ignored 一律不進副本）；--no-sandbox-copy 才擋；.env.example 放行", () => {
  const p = makeProject("ignored", { files: { ".gitignore": ".env\nvendor/\n", ".env": "KEY=1", "vendor/creds.pem": "x", "src/a.js": "x" } });
  const r = run(p, ["do thing"]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.calls.files, [".gitignore", "src/a.js"]);
  assert.deepEqual(r.json.workspace.excluded, []);
  const d = run(p, ["do thing", "--no-sandbox-copy", "--force"]);
  assert.equal(d.status, 2, d.stdout);
  assert.match(d.json.error, /\.env/);
  assert.match(d.json.error, /vendor\/creds\.pem/);
  assert.equal(d.calls, null);
  const p2 = makeProject("template", { files: { ".gitignore": "node_modules/\n", "node_modules/foo/.env.example": "KEY=", "src/a.js": "x" } });
  const r2 = run(p2, ["do thing", "--no-sandbox-copy"]);
  assert.equal(r2.status, 0, r2.stdout);
});

test("機密在巢狀 repo（git ls-files 不會進去）→ 副本排除它、其他檔照複製；--no-sandbox-copy 仍被擋", () => {
  const p = makeProject("nested", { files: { "src/a.js": "x" } });
  const nested = path.join(p.dir, "games", "slot");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(git(nested, "init", "-q").status, 0);
  fs.writeFileSync(path.join(nested, "credentials.json"), "{}");
  fs.writeFileSync(path.join(nested, "game.js"), "g");
  const r = run(p, ["do thing"]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.calls.files, ["games/slot/game.js", "src/a.js"]);
  assert.deepEqual(r.json.workspace.excluded, ["games/slot/credentials.json"]);
  const d = run(p, ["do thing", "--no-sandbox-copy", "--force"]);
  assert.equal(d.status, 2, d.stdout);
  assert.match(d.json.error, /games\/slot\/credentials\.json/);
  assert.equal(d.calls, null);
});

test("淨化副本：未 ignore 的 node_modules 與 symlink 不複製；副本裡沒有 .git", (t) => {
  const p = makeProject("nm", { files: { "node_modules/x/index.js": "m", "src/a.js": "x" }, commit: true });
  const outside = tmpDir("cd-pa-out-");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  let linked = false;
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(p.dir, "link.txt"), "file");
    linked = true;
  } catch {
    linked = false;
  }
  const r = run(p, ["do thing"]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.calls.files, ["src/a.js"]);
  assert.ok(r.json.workspace.skipped.nodeModules >= 1);
  if (linked) assert.equal(r.json.workspace.skipped.symlink, 1);
  else t.diagnostic("symlink 建不出來（Windows 需權限），略過 symlink 斷言");
});

test("--output：逃逸、非 .md、已存在 → local-error；--force 覆寫；新目錄自動建立", () => {
  const p = makeProject("output");
  assert.equal(run(p, ["do thing", "--output", path.join("..", "escape.md")]).json.reason, "local-error");
  assert.equal(run(p, ["do thing", "--output", "plan.txt"]).json.reason, "local-error");
  const r1 = run(p, ["do thing", "--output", path.join("docs", "deep", "plan.md")]);
  assert.equal(r1.status, 0, r1.stdout);
  assert.equal(r1.json.outputRel, "docs/deep/plan.md");
  const r2 = run(p, ["do thing", "--output", path.join("docs", "deep", "plan.md")]);
  assert.equal(r2.json.reason, "local-error");
  assert.match(r2.json.error, /已存在/);
  const r3 = run(p, ["do thing", "--output", path.join("docs", "deep", "plan.md"), "--force"], { env: { FAKE_AGY_RESPONSE: "# Second" } });
  assert.equal(r3.status, 0, r3.stdout);
  assert.match(fs.readFileSync(r3.json.output, "utf8"), /^# Second/);
});

test("--output 父目錄是指向 repo 外的 symlink → local-error", (t) => {
  const p = makeProject("symlink");
  const outside = tmpDir("cd-pa-outside-");
  try {
    fs.symlinkSync(outside, path.join(p.dir, "linked"), WIN ? "junction" : "dir");
  } catch {
    t.skip("無法建立 symlink（Windows 需權限）");
    return;
  }
  const r = run(p, ["do thing", "--output", path.join("linked", "plan.md")]);
  assert.equal(r.json.reason, "local-error");
  assert.ok(!fs.existsSync(path.join(outside, "plan.md")));
});

test("中文需求 → slug 退回 plan-<日期>-<hex>；不是 git repo → local-error", () => {
  const p = makeProject("cjk");
  const r = run(p, ["新增登入頁"]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.json.outputRel, /^plans\/plan-\d{8}-[0-9a-f]{4}\.md$/);
  const plain = tmpDir("cd-pa-plain-");
  const PATH = pathWithoutAgy();
  const g = spawnSync(process.execPath, [DISPATCH, "plan-architect", "x", "--json"], { cwd: plain, encoding: "utf8", windowsHide: true, env: { ...process.env, PATH, Path: PATH, CLAUDE_PROJECT_DIR: "", CODEX_DISPATCH_AGY: p.fake } });
  const j = JSON.parse(g.stdout);
  assert.equal(j.reason, "local-error");
  assert.match(j.error, /git/);
});

test("help 列出 plan-architect；所有 scripts 通過 node --check", () => {
  const h = spawnSync(process.execPath, [DISPATCH, "help"], { encoding: "utf8", windowsHide: true });
  assert.match(h.stdout, /plan-architect <prompt>/);
  const scriptsDir = path.dirname(DISPATCH);
  for (const f of ["dispatch.mjs", "session-start.mjs", "stop-gate.mjs", path.join("lib", "paths.mjs")]) {
    const c = spawnSync(process.execPath, ["--check", path.join(scriptsDir, f)], { encoding: "utf8", windowsHide: true });
    assert.equal(c.status, 0, `${f}: ${c.stderr}`);
  }
});
