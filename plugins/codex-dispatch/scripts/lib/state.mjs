/**
 * 未審清單與輪次計數：<root>/.claude/state/codex-dispatch.json
 * - atomic write（temp + rename）
 * - 條目帶 createdAt；超過 staleHours 只標示 stale=true，**不自動刪除**（未審是義務，只能由明確的 clear 解除）
 * - 條目存 repoRoot / headSha / scope / changedPaths，供日後補審對照
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gitHeadSha, gitChangedPaths } from "./paths.mjs";

export const STATE_REL = path.join(".claude", "state", "codex-dispatch.json");
const VERSION = 1;
const STALE_HOURS = 24;

function empty() {
  return { version: VERSION, unreviewed: [], rounds: {}, updatedAt: null };
}

export function stateFile(root) {
  return path.join(root, STATE_REL);
}

export function loadState(root, { staleHours = STALE_HOURS } = {}) {
  const file = stateFile(root);
  let st = empty();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && parsed.version === VERSION) st = { ...empty(), ...parsed };
    } catch {
      st = empty();
    }
  }
  if (!Array.isArray(st.unreviewed)) st.unreviewed = [];
  if (!st.rounds || typeof st.rounds !== "object") st.rounds = {};
  const cutoff = Date.now() - staleHours * 3600 * 1000;
  st.unreviewed = st.unreviewed.map((e) => ({ ...e, stale: Date.parse(e.createdAt || 0) < cutoff }));
  st.staleCount = st.unreviewed.filter((e) => e.stale).length;
  return st;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 跨程序互斥鎖：<state>.lock 以 O_EXCL 建立；拿不到就等（最多 LOCK_WAIT_MS），
 * 超過 LOCK_STALE_MS 沒更新的鎖視為前一個程序死掉，強制移除。
 * 所有 read-modify-write 都必須在 withLock 內做，否則兩個 session 同時寫會互蓋。
 */
export function withLock(root, fn) {
  const lock = `${stateFile(root)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // 鎖剛被釋放，立刻重試
      }
      if (age > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* 別人先清了 */
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`state 鎖等待逾時（${lock}），可能有其他 session 卡住；確認後可手動刪除該檔`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
}

export function saveState(root, st) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const { staleCount, ...rest } = st;
  rest.unreviewed = rest.unreviewed.map(({ stale, ...e }) => e); // stale 是讀取時計算的，不落地
  const body = `${JSON.stringify({ ...rest, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function addUnreviewed(root, { kind = "review", description, reason = "codex-error", quota = null, scope = "working-tree", error = null }) {
  // git 查詢放鎖外，縮短持鎖時間
  const entry = {
    id: crypto.randomBytes(4).toString("hex"),
    kind,
    description: description || "(未描述)",
    reason,
    error,
    quota,
    repoRoot: root,
    headSha: gitHeadSha(root),
    scope,
    changedPaths: gitChangedPaths(root),
    createdAt: new Date().toISOString()
  };
  return withLock(root, () => {
    const st = loadState(root);
    st.unreviewed.push(entry);
    saveState(root, st);
    return entry;
  });
}

export function clearUnreviewed(root, ids = null) {
  return withLock(root, () => {
    const st = loadState(root);
    const before = st.unreviewed.length;
    st.unreviewed = ids ? st.unreviewed.filter((e) => !ids.includes(e.id)) : [];
    saveState(root, st);
    return before - st.unreviewed.length;
  });
}

/**
 * 原子地「檢查上限並佔用一輪」：在同一把鎖內讀 count、比較、遞增。
 * 回 {ok:true, round} 或 {ok:false, used}——兩個 session 同時在 max-1 也只會有一個成功。
 */
export function reserveRound(root, key, max) {
  return withLock(root, () => {
    const st = loadState(root);
    const used = st.rounds[key] || 0;
    if (used >= max) return { ok: false, used };
    st.rounds[key] = used + 1;
    saveState(root, st);
    return { ok: true, round: used + 1 };
  });
}

/** 退回一輪（例如額度不足／本地錯誤，Codex 根本沒跑） */
export function releaseRound(root, key) {
  withLock(root, () => {
    const st = loadState(root);
    if (st.rounds[key] > 0) st.rounds[key] -= 1;
    if (!st.rounds[key]) delete st.rounds[key];
    saveState(root, st);
  });
}

/**
 * 刪除 state 檔（unwire --purge-state 用）：在鎖內進行，其他 session 持鎖時等待/逾時，不會硬刪別人正在寫的檔。
 * 回傳實際刪掉的檔案清單。鎖檔本身由 withLock 的 finally 釋放。
 */
export function purgeState(root) {
  const file = stateFile(root);
  const pending = path.join(path.dirname(file), "codex-pending.md");
  return withLock(root, () => {
    const removed = [];
    for (const p of [file, pending]) {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    }
    return removed;
  });
}

export function bumpRound(root, key) {
  return withLock(root, () => {
    const st = loadState(root);
    st.rounds[key] = (st.rounds[key] || 0) + 1;
    saveState(root, st);
    return st.rounds[key];
  });
}

export function resetRounds(root, key = null) {
  withLock(root, () => {
    const st = loadState(root);
    if (key) delete st.rounds[key];
    else st.rounds = {};
    saveState(root, st);
  });
}
