#!/usr/bin/env node
// 維護者工具：bump patch 版本 → 刷新本機 marketplace → 逐專案更新 plugin 快取
// 用法：node update.js            # bump patch 後發布
//       node update.js --no-bump  # 不改版本，只刷新 marketplace 與各專案快取
// 要更新哪些專案，寫在 projects.local.txt（一行一個專案根目錄，不進 git）
//
// 只適用「目錄型」marketplace（claude plugin marketplace add <本機路徑>）。
// 若此機器的 codex-dispatch-plugin marketplace 是從 GitHub 註冊的，本機改動必須先 commit + push，
// marketplace update 才抓得到——本腳本會偵測並拒絕執行。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const MARKETPLACE = "codex-dispatch-plugin";
const PLUGIN = `codex-dispatch@${MARKETPLACE}`;
const MANIFEST = path.join(ROOT, "plugins", "codex-dispatch", ".claude-plugin", "plugin.json");
const PROJECTS_FILE = path.join(ROOT, "projects.local.txt");
const KNOWN = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins", "known_marketplaces.json");

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}${cwd ? `  (cwd: ${cwd})` : ""}`);
  execSync(cmd, { stdio: "inherit", shell: true, cwd: cwd || ROOT });
}

// 0. marketplace 來源檢查
let source = null;
try {
  source = JSON.parse(fs.readFileSync(KNOWN, "utf8"))[MARKETPLACE]?.source;
} catch {
  source = null;
}
if (!source) {
  console.error(`此機器尚未註冊 marketplace ${MARKETPLACE}：claude plugin marketplace add "${ROOT}"`);
  process.exit(1);
}
if (source.source !== "directory") {
  console.error(`marketplace ${MARKETPLACE} 的來源是 ${source.source}（${source.repo || source.url || ""}），不是本機目錄。`);
  console.error("本機改動要先 commit + push，再跑：claude plugin marketplace update " + MARKETPLACE);
  process.exit(1);
}

// 1. bump patch
const NO_BUMP = process.argv.includes("--no-bump");
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
let version = manifest.version;
if (NO_BUMP) {
  console.log(`version: ${version}（--no-bump）`);
} else {
  const parts = version.split(".").map(Number);
  parts[2] += 1;
  version = parts.join(".");
  console.log(`version: ${manifest.version} -> ${version}`);
  manifest.version = version;
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

// 2. 刷新 marketplace
run(`claude plugin marketplace update ${MARKETPLACE}`);

// 3. 逐專案更新（local scope 依附於專案，必須在專案目錄下執行）
if (!fs.existsSync(PROJECTS_FILE)) {
  console.error(`\n缺 ${PROJECTS_FILE}：一行一個專案根目錄。已 bump + marketplace update，專案側請手動跑：`);
  console.error(`  claude plugin update ${PLUGIN} --scope local`);
  process.exit(1);
}
const projects = fs
  .readFileSync(PROJECTS_FILE, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const updated = [];
const skipped = [];
for (const dir of projects) {
  if (!fs.existsSync(dir)) {
    console.error(`跳過（目錄不存在）: ${dir}`);
    skipped.push(dir);
    continue;
  }
  try {
    run(`claude plugin update ${PLUGIN} --scope local`, dir);
    updated.push(dir);
  } catch (err) {
    console.error(`失敗: ${dir}（${err.message.split("\n")[0]}）`);
    skipped.push(dir);
  }
}
console.log(`\nv${version}：成功 ${updated.length} 個專案，跳過/失敗 ${skipped.length} 個。重啟 session（或 /reload-plugins）生效。`);
if (skipped.length) {
  console.error(`未更新：\n  ${skipped.join("\n  ")}`);
  process.exit(1);
}
