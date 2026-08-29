import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function codexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function gitTopLevel(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status === 0 && r.stdout.trim()) return path.resolve(r.stdout.trim());
  return null;
}

export function gitHeadSha(cwd) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function gitChangedPaths(cwd) {
  const r = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim());
}

/**
 * 給機密閘門用：working tree 所有會進 diff 的路徑，rename/copy 同時含新舊路徑
 * （`.env -> config.txt` 的刪除側仍會把 .env 內容送出去）。用 -z 機器可讀格式，不靠字串猜。
 */
export function gitChangedPathsForGate(cwd) {
  const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return [];
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (!f) continue;
    const xy = f.slice(0, 2);
    out.push(f.slice(3));
    if (/[RC]/.test(xy)) {
      // rename/copy：下一個欄位是原路徑
      i += 1;
      if (fields[i]) out.push(fields[i]);
    }
  }
  return out;
}

/** base...HEAD 的 diff 路徑，rename/copy 含新舊路徑。git 失敗（ref 無效、無 merge base）回 null，呼叫端必須 fail-closed。 */
export function gitDiffPathsForGate(cwd, ref) {
  const r = spawnSync("git", ["diff", "--name-status", "-z", `${ref}...HEAD`], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i];
    if (!status) continue;
    i += 1;
    if (fields[i]) out.push(fields[i]);
    if (/^[RC]/.test(status)) {
      i += 1;
      if (fields[i]) out.push(fields[i]);
    }
  }
  return out;
}

/**
 * 專案根：cwd 所在的 git 根 → CLAUDE_PROJECT_DIR → cwd。
 * git 根優先：submodule／多 repo 佈局下，cwd 在 game1/ 時專案根必須是 game1（自己的 HEAD、diff、state），
 * 不能因為 Claude Code 的 CLAUDE_PROJECT_DIR 指著上層 client 根就被帶走。
 */
export function projectRoot(cwd = process.cwd()) {
  const top = gitTopLevel(cwd);
  if (top) return top;
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env && fs.existsSync(env)) return path.resolve(env);
  return path.resolve(cwd);
}

const GIT_OPTS = (cwd) => ({ cwd, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });

/**
 * 目前 repo 的 submodule 路徑（相對 repo 根，/ 分隔）。三個來源聯集，涵蓋未初始化、staged 刪除、.gitmodules 已移除等情況：
 * HEAD tree 的 gitlink（160000）、index 的 gitlink、工作樹 .gitmodules。不是 git repo 回 []。
 */
export function gitSubmodulePaths(cwd) {
  const set = new Set();
  const addGitlinks = (out) => {
    for (const line of out.split(/\r?\n/)) {
      if (!line.startsWith("160000")) continue;
      const tab = line.indexOf("\t");
      if (tab > 0) set.add(line.slice(tab + 1).trim());
    }
  };
  const tree = spawnSync("git", ["ls-tree", "-r", "HEAD"], GIT_OPTS(cwd));
  if (tree.status === 0) addGitlinks(tree.stdout);
  const index = spawnSync("git", ["ls-files", "--stage"], GIT_OPTS(cwd));
  if (index.status === 0) addGitlinks(index.stdout);
  const modules = spawnSync("git", ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], GIT_OPTS(cwd));
  if (modules.status === 0) {
    for (const l of modules.stdout.split(/\r?\n/)) {
      const p = l.split(/\s+/).slice(1).join(" ").trim();
      if (p) set.add(p);
    }
  }
  return [...set].map((p) => p.replace(/\\/g, "/").replace(/\/$/, ""));
}

/** 路徑正規化：realpath（不存在則 resolve），Windows 忽略大小寫，統一 / 分隔。用於 state 檔命名與 root 比對。 */
export function canonicalPath(p) {
  let out = path.resolve(p);
  try {
    out = fs.realpathSync.native(out);
  } catch {
    /* 不存在 → 用 resolve 結果 */
  }
  out = out.replace(/\\/g, "/");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/** CLAUDE.md／CLAUDE.local.md 標記段狀態（與 dispatch.mjs locateSnippet 同一套規則） */
export function snippetMarkerState(file) {
  if (!fs.existsSync(file)) return "missing";
  const START = "<!-- codex-dispatch:start -->";
  const END = "<!-- codex-dispatch:end -->";
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const starts = lines.map((l, i) => (l.trim() === START ? i : -1)).filter((i) => i >= 0);
  const ends = lines.map((l, i) => (l.trim() === END ? i : -1)).filter((i) => i >= 0);
  if (starts.length === 0 && ends.length === 0) return "absent";
  return starts.length === 1 && ends.length === 1 && starts[0] < ends[0] ? "valid" : "invalid";
}

/** 這個目錄是否「已接線」：有設定檔，或 CLAUDE.md／CLAUDE.local.md 含有效標記段 */
export function isWiredRoot(dir) {
  if (fs.existsSync(path.join(dir, ".claude", "codex-dispatch.config.json"))) return true;
  return ["CLAUDE.md", "CLAUDE.local.md"].some((b) => snippetMarkerState(path.join(dir, b)) === "valid");
}

/**
 * 規則根：從 reviewRoot 往上（含自身）找第一個已接線的目錄；找不到 → reviewRoot 自身。
 * 不越過 CLAUDE_PROJECT_DIR 之上（若它是祖先）。
 */
export function findConfigRoot(reviewRoot) {
  const stopAt = process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR) ? canonicalPath(process.env.CLAUDE_PROJECT_DIR) : null;
  let dir = path.resolve(reviewRoot);
  for (;;) {
    if (isWiredRoot(dir)) return dir;
    if (stopAt && canonicalPath(dir) === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(reviewRoot);
}

/**
 * 解析雙根：reviewRoot（改動所在 git repo）與 configRoot（規則所在）。
 * cwd 落在上層 repo 的 gitlink 路徑上但該 submodule 未初始化 → 回 error（不要當成上層 repo 的一部分去審）。
 */
export function resolveRoots(cwd = process.cwd()) {
  const abs = path.resolve(cwd);
  const top = gitTopLevel(abs);
  if (top && canonicalPath(top) !== canonicalPath(abs)) {
    const rel = path.relative(top, abs).replace(/\\/g, "/");
    const subs = gitSubmodulePaths(top);
    const hit = subs.find((s) => rel === s || rel.startsWith(`${s}/`));
    if (hit) {
      return { reviewRoot: top, configRoot: findConfigRoot(top), error: `${hit} 是尚未初始化的 submodule（目錄裡沒有自己的 .git），無法在其中送審；請先 git submodule update --init -- ${hit}` };
    }
  }
  const reviewRoot = top || (process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR) ? path.resolve(process.env.CLAUDE_PROJECT_DIR) : abs);
  return { reviewRoot, configRoot: findConfigRoot(reviewRoot), error: null };
}
