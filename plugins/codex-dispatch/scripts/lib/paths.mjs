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

/** 專案根：CLAUDE_PROJECT_DIR → git 根 → cwd */
export function projectRoot(cwd = process.cwd()) {
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env && fs.existsSync(env)) return path.resolve(env);
  return gitTopLevel(cwd) || path.resolve(cwd);
}
