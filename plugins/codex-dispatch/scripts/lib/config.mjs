import fs from "node:fs";
import path from "node:path";

export const CONFIG_REL = path.join(".claude", "codex-dispatch.config.json");

export const DEFAULTS = Object.freeze({
  quotaThreshold: 95,
  lineThreshold: 50,
  fileThreshold: 3,
  maxRounds: 3,
  onCodexUnavailable: "auto", // auto | ask | continue
  reviewMode: "adversarial", // adversarial | native
  planDir: "plans"
});

const ENUMS = {
  onCodexUnavailable: ["auto", "ask", "continue"],
  reviewMode: ["adversarial", "native"]
};

function pickInt(v, def, min = 0) {
  return Number.isInteger(v) && v >= min ? v : def;
}

/** 讀 <root>/.claude/codex-dispatch.config.json；缺檔/壞檔/壞值一律回落預設（fail-soft）。 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_REL);
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
    planDir: typeof raw.planDir === "string" && raw.planDir.trim() ? raw.planDir.trim() : DEFAULTS.planDir
  };
  return { config, source, warning };
}
