/**
 * 官方 codex-plugin-cc（codex@openai-codex）定位與呼叫。
 * 官方 plugin 是執行期依賴：從 installed_plugins.json 找 installPath，直接執行其 scripts/codex-companion.mjs。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { claudeConfigDir } from "./paths.mjs";

export const OFFICIAL_PLUGIN_KEY = "codex@openai-codex";
const COMPANION_REL = path.join("scripts", "codex-companion.mjs");

function semverParts(v) {
  const m = String(v || "0").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

export function compareSemver(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** @returns {{ok:boolean, installPath?:string, version?:string, scriptPath?:string, candidates:number, error?:string}} */
export function resolveCompanion() {
  const file = path.join(claudeConfigDir(), "plugins", "installed_plugins.json");
  if (!fs.existsSync(file)) {
    return { ok: false, candidates: 0, error: `找不到 ${file}；請先安裝官方 plugin：/plugin marketplace add openai/codex-plugin-cc → /plugin install codex@openai-codex` };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, candidates: 0, error: `無法解析 ${file}：${err.message}` };
  }
  const entries = Array.isArray(data?.plugins?.[OFFICIAL_PLUGIN_KEY]) ? data.plugins[OFFICIAL_PLUGIN_KEY] : [];
  const valid = entries
    .filter((e) => e && typeof e.installPath === "string")
    .map((e) => ({ ...e, scriptPath: path.join(e.installPath, COMPANION_REL) }))
    .filter((e) => fs.existsSync(e.scriptPath))
    .sort((a, b) => compareSemver(b.version, a.version));
  if (valid.length === 0) {
    return {
      ok: false,
      candidates: entries.length,
      error: entries.length
        ? `installed_plugins.json 有 ${entries.length} 筆 ${OFFICIAL_PLUGIN_KEY}，但 installPath 下都找不到 ${COMPANION_REL}；請重新安裝官方 plugin`
        : `尚未安裝官方 plugin ${OFFICIAL_PLUGIN_KEY}：/plugin marketplace add openai/codex-plugin-cc → /plugin install codex@openai-codex`
    };
  }
  const pick = valid[0];
  return { ok: true, installPath: pick.installPath, version: pick.version, scriptPath: pick.scriptPath, candidates: entries.length };
}

/**
 * 前景執行 companion。回 {status, stdout, stderr, timedOut, error}。
 * 一律前景：--wait/--background 對直接呼叫無意義。
 */
export function runCompanion(args, { cwd, timeoutMs = 15 * 60 * 1000, scriptPath } = {}) {
  const resolved = scriptPath ? { ok: true, scriptPath } : resolveCompanion();
  if (!resolved.ok) return { status: null, stdout: "", stderr: "", timedOut: false, error: resolved.error };
  const r = spawnSync(process.execPath, [resolved.scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-deprecation"].filter(Boolean).join(" ") }
  });
  const timedOut = Boolean(r.error && r.error.code === "ETIMEDOUT");
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    timedOut,
    error: r.error ? (timedOut ? `companion 逾時（${Math.round(timeoutMs / 1000)}s）` : r.error.message) : null
  };
}

/** 寬鬆 JSON：先整段 parse，失敗則取第一個 { 到最後一個 } 再試。 */
export function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* fallthrough */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function tailLines(text, n = 8) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/DeprecationWarning|trace-deprecation/.test(l))
    .slice(-n)
    .join("\n");
}
