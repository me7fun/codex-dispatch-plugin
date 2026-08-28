#!/usr/bin/env node
/**
 * codex-dispatch CLI：包裝官方 codex-plugin-cc 的 codex-companion.mjs，加上額度預檢、失敗分類、重試上限、未審清單。
 *
 * 子指令（全部支援 --json）：
 *   resolve                       官方 plugin 路徑與版本
 *   quota                         Codex 額度快照（available / exhausted / unknown）
 *   preflight [--write-windows-sandbox]
 *                                 綜合檢查：官方 plugin、codex 登入、git repo、Windows 沙箱設定、額度
 *   review [--adversarial|--native] [--base <ref>] [--scope auto|working-tree|branch] [--retries N] [--allow-secrets] [--reset-rounds] [focus...]
 *                                 送審 diff（預設模式依設定 reviewMode）。機密檔閘門；同一批改動（repo+HEAD+目標）最多 maxRounds 輪
 *   plan-review <file> [--model m] [--effort e] [--allow-secrets]
 *                                 請 Codex 唯讀審計畫檔，要求回 JSON
 *   rescue [--write] [--model m] [--effort e] [--prompt-file f] [--allow-secrets] [prompt...]
 *                                 救援：預設唯讀（診斷＋建議 patch）；--write 才讓 Codex 改碼
 *   state [--list] | --add-unreviewed <desc> [--reason r] [--kind k] [--scope s] [--error msg] [--self-reviewed] | --clear [--id x]
 *                                 未審清單（--self-reviewed：已由 Claude subagent 自審，仍未經 Codex）
 *   snippet [--write]             印出（或寫入）目標專案 CLAUDE.md 的 codex-dispatch 段
 *   unwire [--yes] [--purge-config] [--purge-state] [--root <dir>]
 *                                 反接線：移除 CLAUDE.md 的 codex-dispatch 段（預設 dry-run）。
 *                                 config / state 是使用者設定與工作流狀態，預設保留，要加旗標才刪；永不碰 plans/。
 *                                 plugin 本體另外用 claude plugin uninstall。
 *
 * exit code：0 成功；1 Codex 端失敗（quota / codex-error / invalid-output）；2 本地錯誤（local-error）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { projectRoot, gitTopLevel, gitHeadSha, gitChangedPathsForGate, gitDiffPathsForGate, codexHomeDir } from "./lib/paths.mjs";
import { resolveCompanion, runCompanion, parseJsonLoose, tailLines } from "./lib/companion.mjs";
import { readQuota } from "./lib/quota.mjs";
import { loadConfig, CONFIG_REL, DEFAULTS } from "./lib/config.mjs";
import { loadState, addUnreviewed, clearUnreviewed, reserveRound, releaseRound, resetRounds, resetRoundIfLast, purgeState, stateFile } from "./lib/state.mjs";

const SEVERITIES = ["critical", "high", "medium", "low"];
const VERDICTS = ["approve", "needs-attention"];
const SNIPPET_START = "<!-- codex-dispatch:start -->";
const SNIPPET_END = "<!-- codex-dispatch:end -->";

// ---------- 參數 ----------
function parseArgv(argv, { valueOptions = [], booleanOptions = [] } = {}) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const key = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      if (booleanOptions.includes(key)) {
        options[key] = true;
        continue;
      }
      if (valueOptions.includes(key)) {
        if (eq >= 0) options[key] = tok.slice(eq + 1);
        else {
          options[key] = argv[i + 1] ?? "";
          i += 1;
        }
        continue;
      }
      positionals.push(tok);
      continue;
    }
    positionals.push(tok);
  }
  return { options, positionals };
}

// ---------- 結果 ----------
function base(kind, extra = {}) {
  return {
    ok: false,
    kind,
    reason: null, // quota | codex-error | invalid-output | local-error
    quota: null,
    verdict: null,
    summary: null,
    findings: null,
    nextSteps: null,
    raw: null,
    error: null,
    attempts: 0,
    target: null,
    ...extra
  };
}

function localError(kind, error, extra = {}) {
  return { ...base(kind, extra), reason: "local-error", error };
}

function exitCodeFor(r) {
  if (r.ok) return 0;
  return r.reason === "local-error" ? 2 : 1;
}

function emit(result, json, render) {
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(render(result));
  process.exitCode = exitCodeFor(result);
}

const MAX_RETRIES = 3;
/** --retries 只接受 0..MAX_RETRIES 的整數；其他值（含 Infinity、NaN、負數）→ null 表示不合法 */
function parseRetries(v, def = 1) {
  if (v === undefined) return def;
  if (!/^\d+$/.test(String(v))) return null;
  const n = Number(v);
  return n > MAX_RETRIES ? null : n;
}

/** 路徑必須落在專案根內（realpath 後比對，擋 ../ 與 symlink 逃逸） */
function insideRoot(root, abs) {
  let realRoot;
  let realAbs;
  try {
    realRoot = fs.realpathSync.native(root);
    realAbs = fs.realpathSync.native(abs);
  } catch {
    return false;
  }
  const rel = path.relative(realRoot, realAbs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 寫入目標必須不是 symlink（避免經 repo 內 symlink 覆寫任意檔） */
function refuseSymlink(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return `${file} 是 symlink，拒絕寫入`;
  } catch {
    /* 不存在 → 可新建 */
  }
  return null;
}

/** 疑似機密檔案（送 Codex 前擋下；Codex review 會把 diff 內容送到 OpenAI） */
const SECRET_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.env$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i,
  /(^|\/)(auth|credentials?|secrets?|service-account[^/]*)\.(json|ya?ml|toml)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.(aws|ssh|gnupg)\//i
];

function secretPaths(paths) {
  return paths.filter((p) => SECRET_PATTERNS.some((re) => re.test(p.replace(/\\/g, "/"))));
}

/**
 * 依 review 目標列出會被送出的路徑：working tree 變更 ∪（有 base 或 branch scope 時）base...HEAD 的 diff 檔。
 * branch 目標找不到 base（預設分支不是 main/master）→ resolved=false，呼叫端必須 fail-closed。
 */
function reviewPaths(root, { base, scope }) {
  const set = new Set(gitChangedPathsForGate(root));
  const wantBranch = Boolean(base) || scope === "branch";
  let resolved = true;
  if (wantBranch) {
    let ref = base;
    if (!ref) {
      for (const cand of ["main", "master", "origin/main", "origin/master"]) {
        const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", cand], { cwd: root, encoding: "utf8", windowsHide: true });
        if (r.status === 0) {
          ref = cand;
          break;
        }
      }
    }
    if (ref) gitDiffPathsForGate(root, ref).forEach((p) => set.add(p));
    else resolved = false;
  }
  return { paths: [...set], resolved };
}

/** 統一的機密閘門：所有會把內容送到 Codex 的指令都必須先過。回 null 表示可送。 */
function secretGate(paths, allow) {
  if (allow) return null;
  const hits = secretPaths(paths);
  if (!hits.length) return null;
  return `疑似機密檔案，拒絕送 Codex（內容會送到 OpenAI）：${hits.join(", ")}。請先移除/加入 .gitignore，或確認無機密後加 --allow-secrets`;
}

/** 審查迴圈身分：同一 repo、同一 HEAD、同一目標 → 同一個 cycle；commit 後自動開新 cycle */
function reviewCycleKey(root, { mode, base, scope }) {
  const raw = [root, gitHeadSha(root) || "no-head", mode, base || "", scope || "auto"].join("|");
  return `review:${crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12)}`;
}

function quotaView(q) {
  return {
    status: q.status,
    usedPercent: q.usedPercent,
    resetsAt: q.resetsAt,
    planType: q.planType,
    reached: q.reached,
    secondary: q.secondary,
    error: q.error
  };
}

async function quotaFor(cfg) {
  return quotaView(await readQuota({ threshold: cfg.quotaThreshold }));
}

function quotaMessage(q) {
  const pct = typeof q.usedPercent === "number" ? `${q.usedPercent}%` : "?";
  const reset = q.resetsAt ? `，重置 ${q.resetsAt}` : "";
  const plan = q.planType ? `（${q.planType}）` : "";
  return `Codex 額度 ${q.status}${plan}：已用 ${pct}${reset}${q.error ? `；查詢錯誤：${q.error}` : ""}`;
}

// ---------- findings 正規化 ----------
function normalizeFindings(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== "object") return null;
    const severity = String(f.severity || "").toLowerCase();
    if (!SEVERITIES.includes(severity) || typeof f.title !== "string" || !f.title.trim()) return null;
    out.push({
      severity,
      title: f.title.trim(),
      body: typeof f.body === "string" ? f.body : "",
      file: typeof f.file === "string" ? f.file : null,
      line_start: Number.isInteger(f.line_start) ? f.line_start : null,
      line_end: Number.isInteger(f.line_end) ? f.line_end : null,
      confidence: typeof f.confidence === "number" ? f.confidence : null,
      recommendation: typeof f.recommendation === "string" ? f.recommendation : ""
    });
  }
  out.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return out;
}

function validateStructured(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "輸出不是 JSON 物件" };
  const verdict = String(obj.verdict || "").toLowerCase();
  if (!VERDICTS.includes(verdict)) return { ok: false, error: `verdict 不合法：${JSON.stringify(obj.verdict)}` };
  const findings = normalizeFindings(obj.findings ?? []);
  if (!findings) return { ok: false, error: "findings 欄位格式不合法（severity/title）" };
  return {
    ok: true,
    verdict,
    findings,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    nextSteps: Array.isArray(obj.next_steps) ? obj.next_steps.filter((s) => typeof s === "string") : []
  };
}

// ---------- 通用執行（含重試、失敗分類、失敗後二次查額度） ----------
async function runWithPolicy({ kind, cfg, root, build, interpret, retries, precheck = true }) {
  const result = base(kind);
  const comp = resolveCompanion();
  if (!comp.ok) return localError(kind, comp.error);
  result.companion = { version: comp.version, installPath: comp.installPath };

  if (precheck) {
    result.quota = await quotaFor(cfg);
    if (result.quota.status === "exhausted") {
      result.reason = "quota";
      result.error = quotaMessage(result.quota);
      return result;
    }
  }

  const maxAttempts = 1 + Math.max(0, retries);
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result.attempts = attempt;
    const args = build(attempt);
    const r = runCompanion(args, { cwd: root, scriptPath: comp.scriptPath });
    last = interpret(r, parseJsonLoose(r.stdout));
    if (last.ok) break;
    if (!last.retryable) break;
  }
  Object.assign(result, last);
  delete result.retryable;

  if (!result.ok && result.reason !== "quota") {
    // 失敗後再查一次額度：判斷是否其實是額度用完
    const q2 = await quotaFor(cfg);
    result.quota = q2;
    if (q2.status === "exhausted") {
      result.reason = "quota";
      result.error = `${quotaMessage(q2)}；原始錯誤：${result.error ?? "(無)"}`;
    }
  }
  return result;
}

function interpretSpawn(r) {
  if (r.error) return { ok: false, reason: "codex-error", error: r.error, retryable: true };
  return null;
}

// ---------- review ----------
function interpretReview(mode) {
  return (r, payload) => {
    const spawnErr = interpretSpawn(r);
    if (spawnErr) return spawnErr;
    if (!payload) {
      return {
        ok: false,
        reason: r.status === 0 ? "invalid-output" : "codex-error",
        error: tailLines(r.stderr || r.stdout) || `companion exit ${r.status}`,
        retryable: true
      };
    }
    const target = payload.target ?? null;
    const codexStatus = payload.codex?.status;
    if (codexStatus !== 0) {
      return {
        ok: false,
        reason: "codex-error",
        error: tailLines(payload.codex?.stderr) || `codex status ${codexStatus ?? "?"}`,
        target,
        raw: payload.codex?.stdout ?? null,
        retryable: true
      };
    }
    if (mode === "native") {
      const raw = payload.codex?.stdout ?? "";
      if (!raw.trim()) return { ok: false, reason: "invalid-output", error: "Codex 原生審查沒有輸出", target, retryable: true };
      return { ok: true, reason: null, raw, target, context: payload.context ?? null };
    }
    if (payload.parseError || !payload.result) {
      return {
        ok: false,
        reason: "invalid-output",
        error: `結構化輸出解析失敗：${payload.parseError ?? "result 為空"}`,
        target,
        raw: payload.rawOutput ?? payload.codex?.stdout ?? null,
        retryable: true
      };
    }
    const v = validateStructured(payload.result);
    if (!v.ok) return { ok: false, reason: "invalid-output", error: v.error, target, raw: payload.rawOutput ?? null, retryable: true };
    return {
      ok: true,
      reason: null,
      verdict: v.verdict,
      summary: v.summary,
      findings: v.findings,
      nextSteps: v.nextSteps,
      raw: payload.codex?.stdout ?? payload.rawOutput ?? null,
      target,
      context: payload.context ?? null
    };
  };
}

async function cmdReview(argv) {
  const { options, positionals } = parseArgv(argv, {
    valueOptions: ["base", "scope", "cwd", "retries"],
    booleanOptions: ["json", "adversarial", "native", "allow-secrets", "reset-rounds"]
  });
  const root = projectRoot(options.cwd);
  const { config: cfg } = loadConfig(root);
  const mode = options.adversarial ? "adversarial" : options.native ? "native" : cfg.reviewMode;
  const focus = positionals.join(" ").trim();
  if (!gitTopLevel(root)) return emit(localError("review", `${root} 不是 git repo；Codex review 依賴 git diff，請先 git init`), options.json, renderReview);
  const retries = parseRetries(options.retries);
  if (retries === null) return emit(localError("review", `--retries 必須是 0..${MAX_RETRIES} 的整數`), options.json, renderReview);
  const target = reviewPaths(root, { base: options.base, scope: options.scope });
  if (!target.resolved) {
    return emit(localError("review", "--scope branch 找不到基準分支（只認 main/master/origin/main/origin/master），機密閘門無法列舉 diff；請明確指定 --base <ref>"), options.json, renderReview);
  }
  const gate = secretGate(target.paths, options["allow-secrets"]);
  if (gate) return emit(localError("review", gate), options.json, renderReview);

  // maxRounds 由 CLI 強制：同一 cycle（repo+HEAD+目標）送審次數達上限就拒絕，交使用者裁決
  const cycleKey = reviewCycleKey(root, { mode, base: options.base, scope: options.scope });
  if (options["reset-rounds"]) resetRounds(root, cycleKey);
  const reserved = reserveRound(root, cycleKey, cfg.maxRounds); // 檢查＋佔用在同一把鎖內
  if (!reserved.ok) {
    return emit(
      localError("review", `此批改動已送審 ${reserved.used} 輪（maxRounds=${cfg.maxRounds}），不再自動送審；請交使用者裁決剩餘 findings。確定要再審請加 --reset-rounds，或 commit 後開新一輪`, { round: reserved.used, maxRounds: cfg.maxRounds, cycleKey }),
      options.json,
      renderReview
    );
  }
  const round = reserved.round;

  const build = () => {
    const args = mode === "adversarial" ? ["adversarial-review", "--json"] : ["review", "--json"];
    if (options.base) args.push("--base", options.base);
    if (options.scope) args.push("--scope", options.scope);
    if (focus && mode === "adversarial") args.push(focus);
    return args;
  };
  const result = await runWithPolicy({
    kind: "review",
    cfg,
    root,
    build,
    interpret: interpretReview(mode),
    retries
  });
  result.mode = mode;
  result.round = round;
  result.maxRounds = cfg.maxRounds;
  result.cycleKey = cycleKey;
  // approve 結束 cycle：只在沒有其他 session 在我之後佔用時清計數（否則會清掉別人的）；沒 commit 的專案靠這條開新輪
  if (result.ok && result.verdict === "approve") result.cycleReset = resetRoundIfLast(root, cycleKey, round);
  if (!result.ok && (result.reason === "quota" || result.reason === "local-error")) {
    // Codex 根本沒跑（額度不足／本地錯誤）→ 退回這一輪，額度恢復後不會被 maxRounds 擋住
    releaseRound(root, cycleKey);
    result.round = round - 1;
    result.roundReleased = true;
  }
  if (focus && mode === "native") result.note = "native review 不支援 focus 文字，已忽略；要帶 focus 請用 --adversarial";
  emit(result, options.json, renderReview);
}

// ---------- plan-review ----------
function buildPlanPrompt(relPath, content) {
  return [
    "You are reviewing an IMPLEMENTATION PLAN (a markdown document), not code. Do not modify any files.",
    `Plan file: ${relPath}`,
    "You may read the repository (read-only) to verify claims the plan makes about existing code or dependencies.",
    "",
    "Report:",
    "1. Factual errors (claims about APIs, tools, or existing code that are wrong).",
    "2. Design flaws, missing failure modes, unsafe defaults.",
    "3. Items that are unnecessary for the stated scope.",
    "",
    "Output ONLY a single JSON object, no markdown fences, no prose before or after, with exactly this shape:",
    '{"verdict":"approve"|"needs-attention","summary":"one paragraph","findings":[{"severity":"critical"|"high"|"medium"|"low","title":"...","body":"...","file":"<plan path>","line_start":<int>,"line_end":<int>,"confidence":<0..1>,"recommendation":"..."}],"next_steps":["..."]}',
    "line_start/line_end refer to line numbers in the plan file. Use an empty findings array if there is nothing to report.",
    "",
    "----- PLAN CONTENT BEGIN -----",
    content,
    "----- PLAN CONTENT END -----"
  ].join("\n");
}

function interpretTask({ requireJson }) {
  return (r, payload) => {
    const spawnErr = interpretSpawn(r);
    if (spawnErr) return spawnErr;
    if (!payload) {
      return {
        ok: false,
        reason: r.status === 0 ? "invalid-output" : "codex-error",
        error: tailLines(r.stderr || r.stdout) || `companion exit ${r.status}`,
        retryable: true
      };
    }
    if (payload.status !== 0) {
      return { ok: false, reason: "codex-error", error: tailLines(payload.stderr) || `codex status ${payload.status ?? "?"}`, raw: payload.rawOutput ?? null, retryable: true };
    }
    const raw = typeof payload.rawOutput === "string" ? payload.rawOutput : "";
    if (!requireJson) {
      if (!raw.trim()) return { ok: false, reason: "invalid-output", error: "Codex 沒有輸出", retryable: true };
      return { ok: true, reason: null, raw, touchedFiles: payload.touchedFiles ?? [], threadId: payload.threadId ?? null };
    }
    const parsed = parseJsonLoose(raw);
    const v = validateStructured(parsed);
    if (!v.ok) return { ok: false, reason: "invalid-output", error: v.error, raw, retryable: true };
    return { ok: true, reason: null, verdict: v.verdict, summary: v.summary, findings: v.findings, nextSteps: v.nextSteps, raw, threadId: payload.threadId ?? null };
  };
}

async function cmdPlanReview(argv) {
  const { options, positionals } = parseArgv(argv, {
    valueOptions: ["cwd", "model", "effort", "retries"],
    booleanOptions: ["json", "allow-secrets"]
  });
  const root = projectRoot(options.cwd);
  const { config: cfg } = loadConfig(root);
  const file = positionals[0];
  if (!file) return emit(localError("plan-review", "缺少計畫檔路徑：plan-review <file>"), options.json, renderReview);
  const abs = path.resolve(root, file);
  if (!fs.existsSync(abs)) return emit(localError("plan-review", `找不到計畫檔：${abs}`), options.json, renderReview);
  if (!insideRoot(root, abs) || !fs.statSync(abs).isFile()) {
    return emit(localError("plan-review", `計畫檔必須是專案根目錄（${root}）內的一般檔案：${abs}`), options.json, renderReview);
  }
  const gate = secretGate([path.relative(root, abs)], options["allow-secrets"]);
  if (gate) return emit(localError("plan-review", gate), options.json, renderReview);
  const retries = parseRetries(options.retries);
  if (retries === null) return emit(localError("plan-review", `--retries 必須是 0..${MAX_RETRIES} 的整數`), options.json, renderReview);
  const content = fs.readFileSync(abs, "utf8");
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const tmp = path.join(os.tmpdir(), `codex-dispatch-plan-${crypto.randomBytes(4).toString("hex")}.md`);
  fs.writeFileSync(tmp, buildPlanPrompt(rel, content), "utf8");
  try {
    const build = () => {
      const args = ["task", "--json", "--prompt-file", tmp];
      if (options.model) args.push("--model", options.model);
      if (options.effort) args.push("--effort", options.effort);
      return args;
    };
    const result = await runWithPolicy({
      kind: "plan-review",
      cfg,
      root,
      build,
      interpret: interpretTask({ requireJson: true }),
      retries
    });
    result.target = { mode: "plan", label: rel };
    emit(result, options.json, renderReview);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

// ---------- rescue ----------
async function cmdRescue(argv) {
  const { options, positionals } = parseArgv(argv, {
    valueOptions: ["cwd", "model", "effort", "prompt-file", "retries"],
    booleanOptions: ["json", "write", "allow-secrets"]
  });
  const root = projectRoot(options.cwd);
  const { config: cfg } = loadConfig(root);
  const prompt = positionals.join(" ").trim();
  if (!prompt && !options["prompt-file"]) return emit(localError("rescue", "缺少任務描述：rescue [--write] <prompt> 或 --prompt-file <f>"), options.json, renderRescue);
  const write = Boolean(options.write);
  if (options["prompt-file"]) {
    const pf = path.resolve(root, options["prompt-file"]);
    if (!fs.existsSync(pf) || !insideRoot(root, pf) || !fs.statSync(pf).isFile()) {
      return emit(localError("rescue", `--prompt-file 必須是專案根目錄內的既有檔案：${pf}`), options.json, renderRescue);
    }
    const gate = secretGate([path.relative(root, pf)], options["allow-secrets"]);
    if (gate) return emit(localError("rescue", gate), options.json, renderRescue);
  }
  const retries = parseRetries(options.retries, write ? 0 : 1);
  if (retries === null) return emit(localError("rescue", `--retries 必須是 0..${MAX_RETRIES} 的整數`), options.json, renderRescue);
  const build = () => {
    const args = ["task", "--json"];
    if (write) args.push("--write");
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options["prompt-file"]) args.push("--prompt-file", path.resolve(root, options["prompt-file"]));
    if (prompt) args.push(prompt);
    return args;
  };
  const result = await runWithPolicy({
    kind: "rescue",
    cfg,
    root,
    build,
    interpret: interpretTask({ requireJson: false }),
    // 有寫入權限時預設不自動重試，避免重複改碼
    retries: write ? 0 : retries
  });
  result.write = write;
  emit(result, options.json, renderRescue);
}

// ---------- resolve / quota / preflight ----------
function cmdResolve(argv) {
  const { options } = parseArgv(argv, { booleanOptions: ["json"] });
  const r = resolveCompanion();
  const result = r.ok ? { ok: true, kind: "resolve", ...r } : localError("resolve", r.error, { candidates: r.candidates });
  emit(result, options.json, (x) => (x.ok ? `官方 codex plugin ${x.version}\n${x.scriptPath}\n` : `✗ ${x.error}\n`));
}

async function cmdQuota(argv) {
  const { options } = parseArgv(argv, { valueOptions: ["cwd", "threshold"], booleanOptions: ["json"] });
  const root = projectRoot(options.cwd);
  const { config: cfg } = loadConfig(root);
  const threshold = options.threshold !== undefined ? Number(options.threshold) : cfg.quotaThreshold;
  const q = quotaView(await readQuota({ threshold }));
  const result = { ok: q.status !== "unknown", kind: "quota", reason: q.status === "unknown" ? "codex-error" : null, threshold, quota: q, error: q.error };
  emit(result, options.json, renderQuota);
}

/** 在 TOML 文字中找 [windows] 表的行範圍（含表頭行；到下一個 [table] 前）。找不到回 null。 */
function findWindowsTable(lines) {
  const start = lines.findIndex((l) => /^\s*\[windows\]\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function windowsSandboxCheck() {
  if (process.platform !== "win32") return { status: "ok", detail: "非 Windows，無需設定" };
  const file = path.join(codexHomeDir(), "config.toml");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const table = findWindowsTable(lines);
  const sandboxLine = table ? lines.slice(table.start + 1, table.end).find((l) => /^\s*sandbox\s*=/.test(l)) : null;
  const m = sandboxLine ? sandboxLine.match(/^\s*sandbox\s*=\s*"([^"]*)"/) : null;
  const value = m ? m[1] : null;
  if (value === "unelevated") return { status: "ok", detail: `${file}: [windows] sandbox = "unelevated"`, file };
  if (value === "elevated") {
    return {
      status: "warn",
      detail: `${file}: [windows] sandbox = "elevated"——需已完成管理員端沙箱設定；若 Codex review 回 "blocked by policy"，改成 "unelevated"`,
      fix: `preflight --write-windows-sandbox 會把它改為 "unelevated"`,
      file
    };
  }
  return {
    status: "fail",
    detail: value
      ? `${file}: [windows] sandbox = "${value}" 不是支援的值（elevated | unelevated）`
      : `${file} 未設定 [windows] sandbox；Codex 在沙箱內跑 git 會被 "blocked by policy" 擋住`,
    fix: `在 ${file} 的 [windows] 表設定：sandbox = "unelevated"（或執行 preflight --write-windows-sandbox）`,
    file
  };
}

/** TOML 感知寫入：已有 [windows] 表 → 就地改/加 sandbox 行；沒有 → 檔尾新增表。不會產生重複表。 */
function writeWindowsSandbox(file) {
  const symlinkErr = refuseSymlink(file);
  if (symlinkErr) throw new Error(symlinkErr);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = text.split(/\r?\n/);
  const table = findWindowsTable(lines);
  const assignment = 'sandbox = "unelevated"';
  if (table) {
    const idx = lines.slice(table.start + 1, table.end).findIndex((l) => /^\s*sandbox\s*=/.test(l));
    if (idx >= 0) lines[table.start + 1 + idx] = assignment;
    else lines.splice(table.start + 1, 0, assignment);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push("[windows]", assignment);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
}

async function cmdPreflight(argv) {
  const { options } = parseArgv(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "write-windows-sandbox"] });
  const root = projectRoot(options.cwd);
  const { config: cfg, source, warning } = loadConfig(root);
  const checks = [];

  const comp = resolveCompanion();
  checks.push({
    name: "companion",
    required: true,
    status: comp.ok ? "ok" : "fail",
    detail: comp.ok ? `codex@openai-codex ${comp.version}（${comp.installPath}）` : comp.error
  });

  if (comp.ok) {
    const r = runCompanion(["setup", "--json"], { cwd: root, scriptPath: comp.scriptPath, timeoutMs: 60_000 });
    const p = parseJsonLoose(r.stdout);
    checks.push({
      name: "codexCli",
      required: true,
      status: p?.codex?.available ? "ok" : "fail",
      detail: p?.codex?.detail ?? tailLines(r.stderr) ?? "無法取得 setup 結果",
      fix: p?.codex?.available ? undefined : "npm install -g @openai/codex"
    });
    checks.push({
      name: "codexAuth",
      required: true,
      status: p?.auth?.loggedIn ? "ok" : "fail",
      detail: p?.auth?.detail ?? "未知",
      fix: p?.auth?.loggedIn ? undefined : "在終端機執行 codex login"
    });
    checks.push({
      name: "reviewGate",
      required: false,
      status: p?.reviewGateEnabled ? "warn" : "ok",
      detail: p?.reviewGateEnabled ? "官方 review gate 已開啟——撞限額會無限迴圈，建議 /codex:setup --disable-review-gate" : "官方 review gate 關閉（正確）"
    });
  }

  const top = gitTopLevel(root);
  checks.push({ name: "git", required: true, status: top ? "ok" : "fail", detail: top ? `git 根：${top}` : `${root} 不是 git repo`, fix: top ? undefined : "git init（不需 commit 或 remote）" });

  let ws = windowsSandboxCheck();
  if (ws.status !== "ok" && options["write-windows-sandbox"]) {
    try {
      writeWindowsSandbox(ws.file);
      ws = { ...windowsSandboxCheck(), written: true };
    } catch (err) {
      ws = { ...ws, detail: `${ws.detail}；自動寫入失敗：${err.message}` };
    }
  }
  checks.push({ name: "windowsSandbox", required: true, ...ws });

  const q = await quotaFor(cfg);
  checks.push({
    name: "quota",
    required: false,
    status: q.status === "exhausted" ? "warn" : q.status === "unknown" ? "warn" : "ok",
    detail: quotaMessage(q)
  });

  checks.push({ name: "config", required: false, status: warning ? "warn" : "ok", detail: warning ?? `${source === "defaults" ? "使用預設值" : source}` });

  const ready = checks.every((c) => !c.required || c.status === "ok");
  const result = { ok: ready, kind: "preflight", reason: ready ? null : "local-error", root, config: cfg, checks, quota: q };
  emit(result, options.json, renderPreflight);
}

// ---------- state ----------
function cmdState(argv) {
  const { options } = parseArgv(argv, {
    valueOptions: ["cwd", "add-unreviewed", "reason", "kind", "scope", "error", "id"],
    booleanOptions: ["json", "list", "clear", "self-reviewed"]
  });
  const root = projectRoot(options.cwd);
  if (options["add-unreviewed"] !== undefined) {
    const entry = addUnreviewed(root, {
      description: options["add-unreviewed"],
      reason: options.reason || "codex-error",
      kind: options.kind || "review",
      scope: options.scope || "working-tree",
      error: options.error || null,
      selfReviewed: Boolean(options["self-reviewed"])
    });
    return emit({ ok: true, kind: "state", action: "add", entry, file: stateFile(root) }, options.json, (x) => `已記入未審清單 #${x.entry.id}：${x.entry.description}\n`);
  }
  if (options.clear) {
    const n = clearUnreviewed(root, options.id ? [options.id] : null);
    return emit({ ok: true, kind: "state", action: "clear", removed: n, file: stateFile(root) }, options.json, (x) => `已清除 ${x.removed} 筆未審條目\n`);
  }
  const st = loadState(root);
  emit({ ok: true, kind: "state", action: "list", file: stateFile(root), unreviewed: st.unreviewed, rounds: st.rounds, staleCount: st.staleCount }, options.json, renderState);
}

// ---------- snippet ----------
function snippetText() {
  return [
    SNIPPET_START,
    "## Codex 協作（codex-dispatch）",
    "- 本專案啟用 codex-dispatch：Claude 規劃與實作，Codex 只審不寫。規則正本：Skill `codex-dispatch:dispatch`（動工前先讀）。",
    "- 設定：`.claude/codex-dispatch.config.json`（門檻、輪數上限、失敗策略）；未審清單：`.claude/state/codex-dispatch.json`。",
    "- Codex 失敗絕不阻塞或無限重試：審 diff 失敗→記入未審清單繼續做；審計畫/救援失敗→詢問使用者。收工前補審或逐項標記「未經 Codex 審查」。",
    "- 使用者照常下指令即可，不需背 Codex 指令。",
    SNIPPET_END,
    ""
  ].join("\n");
}

function cmdSnippet(argv) {
  const { options } = parseArgv(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "write"] });
  const root = projectRoot(options.cwd);
  const file = path.join(root, "CLAUDE.md");
  const snippet = snippetText();
  const symlinkErr = refuseSymlink(file);
  if (symlinkErr) return emit(localError("snippet", symlinkErr), options.json, (x) => `✗ ${x.error}\n`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const has = existing.includes(SNIPPET_START) && existing.includes(SNIPPET_END);
  if (!options.write) {
    return emit({ ok: true, kind: "snippet", file, present: has, snippet }, options.json, (x) => `${x.present ? `（${x.file} 已含此段）` : `（尚未寫入 ${x.file}）`}\n\n${x.snippet}`);
  }
  let next;
  if (has) {
    const a = existing.indexOf(SNIPPET_START);
    const b = existing.indexOf(SNIPPET_END) + SNIPPET_END.length;
    next = `${existing.slice(0, a)}${snippet.trimEnd()}${existing.slice(b)}`;
  } else {
    next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${snippet}`;
  }
  fs.writeFileSync(file, next, "utf8");
  emit({ ok: true, kind: "snippet", file, present: true, updated: has, snippet }, options.json, (x) => `${x.updated ? "已更新" : "已寫入"} ${x.file}\n`);
}

// ---------- unwire（反接線） ----------
/** 找 CLAUDE.md 的標記段：必須恰好各一、start 在前。回 {start,end} 行索引或 {error}。 */
function locateSnippet(lines) {
  const starts = lines.map((l, i) => (l.trim() === SNIPPET_START ? i : -1)).filter((i) => i >= 0);
  const ends = lines.map((l, i) => (l.trim() === SNIPPET_END ? i : -1)).filter((i) => i >= 0);
  if (starts.length === 0 && ends.length === 0) return { absent: true };
  if (starts.length !== 1 || ends.length !== 1) return { error: `標記數量不對（start ${starts.length}、end ${ends.length}），需各恰好一個；請手動整理後再跑` };
  if (starts[0] > ends[0]) return { error: "標記順序相反（end 在 start 前）；請手動整理後再跑" };
  return { start: starts[0], end: ends[0] };
}

/**
 * 路徑安全：root 到 file 的每一層都不能是 symlink，且 realpath 必須留在 root 內。
 * 不存在的層級視為安全（尚未建立）。回 null 表示安全，否則回錯誤訊息。
 */
function unsafePath(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return `${file} 不在專案根 ${root} 內`;
  let cur = root;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return `${cur} 是 symlink，拒絕處理`;
    } catch {
      return null; // 這層不存在 → 之後也不存在
    }
  }
  return fs.existsSync(file) && !insideRoot(root, file) ? `${file} 解析後不在專案根內` : null;
}

function cmdUnwire(argv) {
  const { options } = parseArgv(argv, { valueOptions: ["root", "cwd"], booleanOptions: ["json", "yes", "purge-config", "purge-state"] });
  const root = options.root ? path.resolve(options.root) : projectRoot(options.cwd);
  const dryRun = !options.yes;
  const actions = [];
  const warnings = [];
  const fail = (error) => emit(localError("unwire", error, { dryRun, actions, warnings }), options.json, renderUnwire);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return fail(`專案根不存在：${root}`);

  // ===== 階段 1：只規劃，不動任何檔案 =====
  const claudeMd = path.join(root, "CLAUDE.md");
  const cfgFile = path.join(root, CONFIG_REL);
  const stFile = stateFile(root);
  const pendingFile = path.join(path.dirname(stFile), "codex-pending.md");
  for (const f of [claudeMd, cfgFile, stFile, pendingFile]) {
    const err = unsafePath(root, f);
    if (err) return fail(err);
  }

  let claudePlan = null; // {mode:"delete"|"modify", remaining, loc}
  if (fs.existsSync(claudeMd)) {
    const lines = fs.readFileSync(claudeMd, "utf8").split(/\r?\n/);
    const loc = locateSnippet(lines);
    if (loc.error) return fail(`${claudeMd}：${loc.error}`);
    if (!loc.absent) {
      const rest = [...lines.slice(0, loc.start), ...lines.slice(loc.end + 1)];
      while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
      const remaining = rest.join("\n");
      claudePlan = remaining.trim() === "" ? { mode: "delete", loc } : { mode: "modify", loc, remaining, kept: rest.length };
    }
  }

  const purgeConfig = options["purge-config"] && fs.existsSync(cfgFile);
  if (fs.existsSync(cfgFile) && !purgeConfig) warnings.push(`保留使用者設定 ${cfgFile}（要刪加 --purge-config）`);

  const statePaths = [stFile, pendingFile].filter((p) => fs.existsSync(p));
  const purgeStateWanted = options["purge-state"] && statePaths.length > 0;
  if (statePaths.length) {
    const st = loadState(root);
    if (st.unreviewed.length) {
      warnings.push(`⚠ 未審清單仍有 ${st.unreviewed.length} 筆（${st.unreviewed.map((e) => `#${e.id} ${e.description}`).join("；")}）`);
    }
    if (!purgeStateWanted) warnings.push(`保留工作流狀態 ${stFile}（要刪加 --purge-state；請先關閉其他 Claude session）`);
  }

  // 規劃清單（執行順序：state → config → CLAUDE.md；最可能失敗的鎖操作放最前，失敗時什麼都還沒動）
  if (purgeStateWanted) for (const p of statePaths) actions.push({ file: p, action: "delete", detail: "--purge-state（在 state 鎖內刪除）" });
  if (purgeConfig) actions.push({ file: cfgFile, action: "delete", detail: "--purge-config" });
  if (claudePlan?.mode === "delete") actions.push({ file: claudeMd, action: "delete", detail: `刪除標記段（第 ${claudePlan.loc.start + 1}–${claudePlan.loc.end + 1} 行）後整檔為空，刪除檔案` });
  if (claudePlan?.mode === "modify") actions.push({ file: claudeMd, action: "modify", detail: `刪除標記段第 ${claudePlan.loc.start + 1}–${claudePlan.loc.end + 1} 行，其餘 ${claudePlan.kept} 行保留` });

  // ===== 階段 2：執行（每一步前重新驗證路徑，防檢查後被換成 symlink；任一步失敗回報已完成/未完成）=====
  if (!dryRun) {
    const mark = (file, status) => {
      const a = actions.find((x) => x.file === file && !x.status);
      if (a) a.status = status;
    };
    const guard = (file) => {
      const err = unsafePath(root, file);
      if (err) throw new Error(err);
    };
    try {
      if (purgeStateWanted) {
        for (const p of statePaths) guard(p);
        purgeState(root); // 拿不到鎖會拋錯 → 此時尚未動任何檔案
        for (const p of statePaths) mark(p, "done");
      }
      if (purgeConfig) {
        guard(cfgFile);
        fs.unlinkSync(cfgFile);
        mark(cfgFile, "done");
      }
      if (claudePlan?.mode === "delete") {
        guard(claudeMd);
        fs.unlinkSync(claudeMd); // unlink 不跟隨 symlink
        mark(claudeMd, "done");
      }
      if (claudePlan?.mode === "modify") {
        guard(claudeMd);
        // 寫暫存檔再 rename：rename 取代的是目標本身，不會跟隨 symlink 寫到別處
        const tmp = `${claudeMd}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(tmp, `${claudePlan.remaining}\n`, "utf8");
        fs.renameSync(tmp, claudeMd);
        mark(claudeMd, "done");
      }
    } catch (err) {
      for (const a of actions) if (!a.status) a.status = "not-done";
      const done = actions.filter((a) => a.status === "done").map((a) => a.file);
      return fail(`執行中斷：${err.message}${done.length ? `；已完成：${done.join(", ")}` : "（未動任何檔案）"}；其餘未執行`);
    }
  }

  const next = [
    "plugin 本體請另外執行：claude plugin uninstall codex-dispatch@codex-dispatch-plugin --scope local",
    "（本指令永不碰 plans/、也不動 ~/.codex/config.toml 與官方 codex plugin）"
  ];
  emit({ ok: true, kind: "unwire", root, dryRun, actions, warnings, next }, options.json, renderUnwire);
}

function renderUnwire(r) {
  const lines = [`codex-dispatch unwire — ${r.dryRun ? "預覽（dry-run，未動任何檔案）" : "已執行"}${r.root ? `  root=${r.root}` : ""}`];
  if (!r.ok) lines.push(`✗ ${r.error}`);
  if (r.actions?.length) {
    lines.push(r.dryRun ? "將執行：" : "已執行：");
    for (const a of r.actions) lines.push(`  - [${a.action}]${a.status ? ` (${a.status})` : ""} ${a.file}  ${a.detail}`);
  } else if (r.ok) {
    lines.push("（沒有可移除的接線）");
  }
  for (const w of r.warnings ?? []) lines.push(`  ${w}`);
  if (r.ok && r.dryRun && r.actions?.length) lines.push("確認後加 --yes 執行。");
  for (const n of r.next ?? []) lines.push(n);
  return `${lines.join("\n")}\n`;
}

// ---------- 渲染 ----------
function renderFindings(findings) {
  if (!findings || findings.length === 0) return "（無 findings）\n";
  return `${findings
    .map((f) => {
      const loc = f.file ? ` — ${f.file}${f.line_start ? `:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ""}` : ""}` : "";
      const conf = typeof f.confidence === "number" ? ` (confidence ${f.confidence})` : "";
      return `- [${f.severity.toUpperCase()}] ${f.title}${loc}${conf}\n  ${f.body}${f.recommendation ? `\n  → ${f.recommendation}` : ""}`;
    })
    .join("\n")}\n`;
}

function renderFailure(r) {
  const lines = [`✗ ${r.kind} 失敗（reason=${r.reason}，attempts=${r.attempts}）`, `  ${r.error ?? "(無錯誤訊息)"}`];
  if (r.quota) lines.push(`  ${quotaMessage(r.quota)}`);
  return `${lines.join("\n")}\n`;
}

function renderReview(r) {
  if (!r.ok) return renderFailure(r);
  const head = `# Codex ${r.kind}${r.mode ? ` (${r.mode})` : ""}\nTarget: ${r.target?.label ?? "?"}${r.round ? `\nRound: ${r.round}/${r.maxRounds}` : ""}${r.quota ? `\n${quotaMessage(r.quota)}` : ""}\n`;
  if (r.verdict === null || r.verdict === undefined) return `${head}\n${r.raw ?? ""}\n${r.note ? `\n（${r.note}）\n` : ""}`;
  return `${head}\nVerdict: ${r.verdict}\n${r.summary ? `${r.summary}\n` : ""}\n## Findings\n${renderFindings(r.findings)}${r.nextSteps?.length ? `\n## Next steps\n${r.nextSteps.map((s) => `- ${s}`).join("\n")}\n` : ""}`;
}

function renderRescue(r) {
  if (!r.ok) return renderFailure(r);
  return `# Codex rescue${r.write ? " (write)" : " (read-only)"}\n${r.quota ? `${quotaMessage(r.quota)}\n` : ""}\n${r.raw ?? ""}\n${r.touchedFiles?.length ? `\nTouched files:\n${r.touchedFiles.map((f) => `- ${f}`).join("\n")}\n` : ""}`;
}

function renderQuota(r) {
  const q = r.quota;
  const lines = [quotaMessage(q), `  門檻 ${r.threshold}%`];
  if (q.secondary?.usedPercent !== undefined && q.secondary !== null) lines.push(`  secondary 窗口：${q.secondary.usedPercent}%${q.secondary.resetsAt ? `，重置 ${q.secondary.resetsAt}` : ""}`);
  return `${lines.join("\n")}\n`;
}

function renderPreflight(r) {
  const icon = { ok: "✓", warn: "⚠", fail: "✗" };
  const lines = r.checks.map((c) => `${icon[c.status]} ${c.name.padEnd(15)} ${c.detail}${c.fix ? `\n    → ${c.fix.replace(/\n/g, "\n      ")}` : ""}${c.written ? "\n    （已自動寫入）" : ""}`);
  return `codex-dispatch preflight — ${r.ok ? "READY" : "NOT READY"}\n${lines.join("\n")}\n`;
}

function renderState(r) {
  const lines = [`未審清單（${r.unreviewed.length} 筆${r.staleCount ? `，其中 ${r.staleCount} 筆超過 24h 未處理` : ""}）：`];
  for (const e of r.unreviewed) {
    lines.push(`- #${e.id} [${e.kind}/${e.reason}]${e.selfReviewed ? " [自審]" : ""}${e.stale ? " [STALE]" : ""} ${e.description}`);
    lines.push(`    ${e.createdAt}  head=${e.headSha ? e.headSha.slice(0, 8) : "-"}  files=${e.changedPaths?.length ?? 0}${e.quota?.resetsAt ? `  重置 ${e.quota.resetsAt}` : ""}`);
  }
  if (r.unreviewed.length === 0) lines.push("  （空）");
  return `${lines.join("\n")}\n`;
}

// ---------- help / main ----------
function help() {
  const header = fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, "");
  return `${header.replace(/^\/\*\*?\s?|^ \*\s?/gm, "")}\n預設設定：${JSON.stringify(DEFAULTS)}\n設定檔：<專案>/${CONFIG_REL}\n`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "resolve":
      return cmdResolve(rest);
    case "quota":
      return cmdQuota(rest);
    case "preflight":
      return cmdPreflight(rest);
    case "review":
      return cmdReview(rest);
    case "plan-review":
      return cmdPlanReview(rest);
    case "rescue":
      return cmdRescue(rest);
    case "state":
      return cmdState(rest);
    case "snippet":
      return cmdSnippet(rest);
    case "unwire":
      return cmdUnwire(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(help());
      return;
    default:
      process.stderr.write(`未知子指令：${cmd}\n\n${help()}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ ok: false, kind: "dispatch", reason: "local-error", error: err?.stack || String(err) }, null, 2)}\n`);
  process.exitCode = 2;
});
