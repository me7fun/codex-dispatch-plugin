import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findConfigRoot } from "./paths.mjs";

export const CONFIG_REL = path.join(".claude", "codex-dispatch.config.json");
/**
 * 本機設定（不進 git）：只有這裡可以放會被執行的 shell 指令（checks）。
 * 進版控的 config.json 可能是別人寫的，clone 下來就執行等於任意程式碼執行——所以 checks 絕不從 config.json 讀。
 */
export const LOCAL_CONFIG_REL = path.join(".claude", "codex-dispatch.local.json");
const CHECKS_MAX = 10;
const CHECK_CMD_MAX_LEN = 500;
const CHECKS_TIMEOUT_DEFAULT = 300;
const CHECKS_TIMEOUT_MIN = 10;
const CHECKS_TIMEOUT_MAX = 1800;

export const DEFAULTS = Object.freeze({
  quotaThreshold: 95,
  lineThreshold: 50,
  fileThreshold: 3,
  maxRounds: 3,
  onCodexUnavailable: "auto", // auto | ask | continue
  reviewMode: "adversarial", // adversarial | native
  planDir: "plans",
  selfReview: "auto", // auto | ask | off：Codex 不可用時由 Claude subagent 自審
  confidenceThreshold: 0.75 // 低於此信心的 finding 不進 findings（另列 lowConfidence，不自動修）
});

const ENUMS = {
  onCodexUnavailable: ["auto", "ask", "continue"],
  reviewMode: ["adversarial", "native"],
  selfReview: ["auto", "ask", "off"]
};

function pickInt(v, def, min = 0) {
  return Number.isInteger(v) && v >= min ? v : def;
}

/**
 * 讀設定：以 reviewRoot 往上找到的規則根（configRoot）為準——submodule 佈局下規則在上層 client 根。
 * 缺檔/壞檔/壞值一律回落預設（fail-soft）。
 */
export function loadConfig(root) {
  const configRoot = findConfigRoot(root);
  const file = path.join(configRoot, CONFIG_REL);
  let raw = {};
  let source = "defaults";
  let warning = null;
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
      source = file;
    } catch (err) {
      warning = `設定檔解析失敗，使用預設值：${err.message}`;
    }
  }
  const config = {
    quotaThreshold: pickInt(raw.quotaThreshold, DEFAULTS.quotaThreshold),
    lineThreshold: pickInt(raw.lineThreshold, DEFAULTS.lineThreshold),
    fileThreshold: pickInt(raw.fileThreshold, DEFAULTS.fileThreshold),
    maxRounds: pickInt(raw.maxRounds, DEFAULTS.maxRounds, 1),
    onCodexUnavailable: ENUMS.onCodexUnavailable.includes(raw.onCodexUnavailable)
      ? raw.onCodexUnavailable
      : DEFAULTS.onCodexUnavailable,
    reviewMode: ENUMS.reviewMode.includes(raw.reviewMode) ? raw.reviewMode : DEFAULTS.reviewMode,
    planDir: typeof raw.planDir === "string" && raw.planDir.trim() ? raw.planDir.trim() : DEFAULTS.planDir,
    selfReview: ENUMS.selfReview.includes(raw.selfReview) ? raw.selfReview : DEFAULTS.selfReview,
    confidenceThreshold:
      typeof raw.confidenceThreshold === "number" && raw.confidenceThreshold >= 0 && raw.confidenceThreshold <= 1
        ? raw.confidenceThreshold
        : DEFAULTS.confidenceThreshold
  };
  const local = loadLocalChecks(configRoot);
  config.checks = local.checks;
  config.checksTimeoutSec = local.timeoutSec;
  return { config, source, warning, configRoot, checksSource: local.source, checksWarnings: local.warnings };
}

/**
 * 讀本機 checks：<configRoot>/.claude/codex-dispatch.local.json → { "checks": ["npm test", ...], "checksTimeoutSec": 300 }
 * - 檔案被 git 追蹤 → 整組停用（它就不是「本機」了）
 * - 逐條驗證：非空字串、≤500 字、最多 10 條；壞的跳過並警告
 */
function loadLocalChecks(configRoot) {
  const file = path.join(configRoot, LOCAL_CONFIG_REL);
  const out = { checks: [], timeoutSec: CHECKS_TIMEOUT_DEFAULT, source: null, warnings: [] };
  if (!fs.existsSync(file)) return out;
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", LOCAL_CONFIG_REL.split(path.sep).join("/")], { cwd: configRoot, encoding: "utf8", windowsHide: true, timeout: 5000 }).status === 0;
  if (tracked) {
    out.warnings.push(`${file} 已被 git 追蹤——checks 會執行 shell 指令，只能來自本機檔案；已停用，請 git rm --cached 並加入 .gitignore`);
    return out;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (err) {
    out.warnings.push(`本機設定解析失敗，checks 停用：${err.message}`);
    return out;
  }
  out.source = file;
  if (Array.isArray(raw.checks)) {
    for (const [i, c] of raw.checks.entries()) {
      if (out.checks.length >= CHECKS_MAX) {
        out.warnings.push(`checks 超過 ${CHECKS_MAX} 條，其餘忽略`);
        break;
      }
      if (typeof c !== "string" || !c.trim()) {
        out.warnings.push(`checks[${i}] 不是非空字串，跳過`);
        continue;
      }
      if (c.length > CHECK_CMD_MAX_LEN) {
        out.warnings.push(`checks[${i}] 超過 ${CHECK_CMD_MAX_LEN} 字，跳過`);
        continue;
      }
      out.checks.push(c.trim());
    }
  } else if (raw.checks !== undefined) {
    out.warnings.push("checks 必須是字串陣列，已忽略");
  }
  if (raw.checksTimeoutSec !== undefined) {
    const t = raw.checksTimeoutSec;
    if (Number.isInteger(t) && t >= CHECKS_TIMEOUT_MIN && t <= CHECKS_TIMEOUT_MAX) out.timeoutSec = t;
    else out.warnings.push(`checksTimeoutSec 需為 ${CHECKS_TIMEOUT_MIN}..${CHECKS_TIMEOUT_MAX} 的整數，使用預設 ${CHECKS_TIMEOUT_DEFAULT}`);
  }
  return out;
}
