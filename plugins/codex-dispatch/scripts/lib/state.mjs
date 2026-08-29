/**
 * 未審清單與輪次計數：<root>/.claude/state/codex-dispatch.json
 * - atomic write（temp + rename）
 * - 條目帶 createdAt；超過 staleHours 只標示 stale=true，**不自動刪除**（未審是義務，只能由明確的 clear 解除）
 * - 條目存 repoRoot / headSha / scope / changedPaths，供日後補審對照
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gitHeadSha, gitChangedPaths, findConfigRoot, canonicalPath } from "./paths.mjs";

export const STATE_REL = path.join(".claude", "state", "codex-dispatch.json");
/** 規則根 ≠ 審查根時，各 sub-repo 的 state 集中放在規則根的這個子目錄 */
export const STATE_SUBDIR = path.join(".claude", "state", "codex-dispatch");
const SUB_STATE_NAME = /^[A-Za-z0-9._-]+-[0-9a-f]{16}\.json$/;
const VERSION = 1;
const STALE_HOURS = 24;
/** 輪次計數超過這麼久沒動就自動清除（沒有任務會跑一週還在同一批改動上） */
const ROUNDS_TTL_DAYS = 7;

/**
 * 進行中的佔用超過這麼久視為程序已死。
 * 一次 review 最多 4 次嘗試（1 + MAX_RETRIES=3），每次 companion 逾時 15 分鐘 → 上限 60 分鐘，取 2 小時留餘裕。
 */
const ACTIVE_STALE_MS = 2 * 60 * 60 * 1000;

function empty() {
  return { version: VERSION, reviewRoot: null, unreviewed: [], rounds: {}, roundsAt: {}, roundsActive: {}, updatedAt: null };
}

function touchRound(st, key) {
  st.roundsAt[key] = new Date().toISOString();
}

function dropRound(st, key) {
  delete st.rounds[key];
  delete st.roundsAt[key];
  delete st.roundsActive[key];
}

function activeIds(st, key) {
  const map = st.roundsActive[key];
  return map && typeof map === "object" ? Object.keys(map) : [];
}

/**
 * state 檔位置：
 * - 規則根 == 審查根（單 repo）：<root>/.claude/state/codex-dispatch.json（不變）
 * - 規則根 ≠ 審查根（submodule 佈局）：<configRoot>/.claude/state/codex-dispatch/<basename>-<sha1(canonical reviewRoot) 16 hex>.json
 *   （game repo 裡不留任何檔；client 根已 gitignore .claude/state/）
 */
export function stateFile(root) {
  const reviewRoot = path.resolve(root);
  const configRoot = findConfigRoot(reviewRoot);
  if (canonicalPath(configRoot) === canonicalPath(reviewRoot)) return path.join(reviewRoot, STATE_REL);
  const slug = (path.basename(reviewRoot) || "repo").replace(/[^A-Za-z0-9._-]+/g, "-");
  const hash = crypto.createHash("sha1").update(canonicalPath(reviewRoot)).digest("hex").slice(0, 16);
  return path.join(configRoot, STATE_SUBDIR, `${slug}-${hash}.json`);
}

/** 讀取並驗證一個 state 檔（不做 stale 計算）。回 {state} 或 {error}。reviewRoot 不符 → 視為碰撞，拒絕。 */
function readStateFile(file, expectedReviewRoot) {
  if (!fs.existsSync(file)) return { state: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { error: `state 檔損壞（${file}）：${err.message}` };
  }
  if (!parsed || parsed.version !== VERSION) return { error: `state 檔版本不符（${file}）` };
  if (expectedReviewRoot && parsed.reviewRoot && canonicalPath(parsed.reviewRoot) !== canonicalPath(expectedReviewRoot)) {
    return { error: `state 檔 ${file} 屬於另一個 repo（${parsed.reviewRoot}），與 ${expectedReviewRoot} 碰撞；請手動處理` };
  }
  return { state: parsed };
}

export function loadState(root, { staleHours = STALE_HOURS } = {}) {
  const file = stateFile(root);
  const read = readStateFile(file, path.resolve(root));
  if (read.error && /碰撞/.test(read.error)) throw new Error(read.error);
  let st = read.state ? { ...empty(), ...read.state } : empty();
  st.reviewRoot = path.resolve(root);
  if (!Array.isArray(st.unreviewed)) st.unreviewed = [];
  if (!st.rounds || typeof st.rounds !== "object") st.rounds = {};
  if (!st.roundsAt || typeof st.roundsAt !== "object") st.roundsAt = {};
  if (!st.roundsActive || typeof st.roundsActive !== "object") st.roundsActive = {};
  // 輪次計數過期清理：沒時間戳的舊資料視為現在起算
  const roundsCutoff = Date.now() - ROUNDS_TTL_DAYS * 24 * 3600 * 1000;
  st.roundsPruned = 0;
  for (const key of Object.keys(st.rounds)) {
    if (!st.roundsAt[key]) touchRound(st, key);
    else if (Date.parse(st.roundsAt[key]) < roundsCutoff) {
      dropRound(st, key);
      st.roundsPruned += 1;
    }
  }
  for (const key of Object.keys(st.roundsAt)) if (!(key in st.rounds)) delete st.roundsAt[key];
  // 進行中佔用：程序死掉沒釋放的（超過 ACTIVE_STALE_MS）清掉
  const activeCutoff = Date.now() - ACTIVE_STALE_MS;
  for (const key of Object.keys(st.roundsActive)) {
    const map = st.roundsActive[key];
    if (!map || typeof map !== "object" || !(key in st.rounds)) {
      delete st.roundsActive[key];
      continue;
    }
    for (const id of Object.keys(map)) {
      if (Date.parse(map[id]) < activeCutoff) {
        // 程序死掉沒釋放：把它佔的那一輪退回去，否則會一直佔著 maxRounds 直到 7 天 TTL
        delete map[id];
        if (st.rounds[key] > 0) st.rounds[key] -= 1;
      }
    }
    if (Object.keys(map).length === 0) delete st.roundsActive[key];
    if (!st.rounds[key]) dropRound(st, key);
  }
  const cutoff = Date.now() - staleHours * 3600 * 1000;
  st.unreviewed = st.unreviewed.map((e) => ({ ...e, stale: Date.parse(e.createdAt || 0) < cutoff }));
  st.staleCount = st.unreviewed.filter((e) => e.stale).length;
  return st;
}

const LOCK_STALE_MS = 60_000; // 持鎖內的操作都應在幾秒內完成；超過視為程序已死
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
  return withLockFile(stateFile(root), fn);
}

/** 以明確的 state 檔路徑加鎖（聚合操作逐檔使用） */
export function withLockFile(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = `${process.pid}:${crypto.randomBytes(6).toString("hex")}`; // 擁有者 token：釋放時只刪自己的鎖
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, `${token} ${new Date().toISOString()}\n`);
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
        // 清 stale 鎖用 rename（原子）：多個程序同時發現 stale，只有一個 rename 成功，其餘 ENOENT 重試
        const graveyard = `${lock}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
        try {
          fs.renameSync(lock, graveyard);
          fs.unlinkSync(graveyard);
        } catch {
          /* 別人先搬走了 */
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
    // 釋放：先 rename 到私有名稱（原子，別人搶走並重建的鎖不會被我們碰到），再驗 token；不是我們的就 rename 回去
    const mine = `${lock}.rel.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.renameSync(lock, mine);
      if (fs.readFileSync(mine, "utf8").startsWith(`${token} `)) fs.unlinkSync(mine);
      else fs.renameSync(mine, lock); // 那是別人的（我們的已被判定 stale 搬走）→ 還回去
    } catch {
      /* 鎖已不存在 */
    }
  }
}

/** 呼叫端可用來確認自己仍持有鎖（被搶走則回 false）。fn 內部長操作後、破壞性動作前使用。 */
export function lockStillOwned(root) {
  const lock = `${stateFile(root)}.lock`;
  try {
    const owner = fs.readFileSync(lock, "utf8").split(" ")[0];
    return owner.startsWith(`${process.pid}:`);
  } catch {
    return false;
  }
}

export function saveState(root, st) {
  const file = stateFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const { staleCount, roundsPruned, ...rest } = st;
  rest.unreviewed = rest.unreviewed.map(({ stale, ...e }) => e); // stale 是讀取時計算的，不落地
  const body = `${JSON.stringify({ ...rest, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function addUnreviewed(root, { kind = "review", description, reason = "codex-error", quota = null, scope = "working-tree", error = null, selfReviewed = false }) {
  // git 查詢放鎖外，縮短持鎖時間
  const entry = {
    id: crypto.randomBytes(4).toString("hex"),
    kind,
    description: description || "(未描述)",
    reason,
    error,
    quota,
    selfReviewed: Boolean(selfReviewed), // 已由 Claude subagent 自審（仍未經 Codex）
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
 * 原子地「檢查上限並佔用一輪」：在同一把鎖內讀 count、比較、遞增，並登記一個本次專屬的 reservationId。
 * 回 {ok:true, round, reservationId} 或 {ok:false, used}——兩個 session 同時在 max-1 也只會有一個成功。
 */
export function reserveRound(root, key, max) {
  return withLock(root, () => {
    const st = loadState(root);
    const used = st.rounds[key] || 0;
    if (used >= max) return { ok: false, used };
    const reservationId = crypto.randomBytes(6).toString("hex");
    st.rounds[key] = used + 1;
    if (!st.roundsActive[key]) st.roundsActive[key] = {};
    st.roundsActive[key][reservationId] = new Date().toISOString();
    touchRound(st, key);
    saveState(root, st);
    return { ok: true, round: used + 1, reservationId };
  });
}

/**
 * 審查完成：只移除自己的 reservationId。approve 且**沒有任何其他進行中的佔用**才清整個 cycle。
 * 別的 session 還在審 → 只解除自己的登記，計數保留；它們完成時再判斷。
 * 回 true 表示 cycle 已清。
 */
export function completeRound(root, key, reservationId, { approve = false } = {}) {
  return withLock(root, () => {
    const st = loadState(root);
    if (st.roundsActive[key]) delete st.roundsActive[key][reservationId];
    const othersActive = activeIds(st, key).length > 0;
    if (approve && !othersActive) {
      dropRound(st, key);
      saveState(root, st);
      return true;
    }
    if (st.roundsActive[key] && Object.keys(st.roundsActive[key]).length === 0) delete st.roundsActive[key];
    saveState(root, st);
    return false;
  });
}

/**
 * 退回一輪（例如額度不足／本地錯誤，Codex 根本沒跑）：只退自己的那一次。
 * 自己的 reservationId 已不存在（被判定 stale 清掉、或 cycle 已被 approve 清除）→ 冪等 no-op，不動別人的計數。回 true 表示有退。
 */
export function releaseRound(root, key, reservationId) {
  return withLock(root, () => {
    const st = loadState(root);
    if (!st.roundsActive[key] || !(reservationId in st.roundsActive[key])) return false;
    delete st.roundsActive[key][reservationId];
    if (st.rounds[key] > 0) st.rounds[key] -= 1;
    if (!st.rounds[key]) dropRound(st, key);
    else {
      touchRound(st, key);
      if (st.roundsActive[key] && Object.keys(st.roundsActive[key]).length === 0) delete st.roundsActive[key];
    }
    saveState(root, st);
    return true;
  });
}

/**
 * 列出規則根底下所有 state 檔：自身的 codex-dispatch.json（若有）＋ codex-dispatch/ 子目錄中符合命名規則的一般 JSON 檔。
 * 只列符合 <slug>-<16hex>.json 的 regular file，不碰 .lock / .tmp / symlink。
 */
export function listStateFiles(configRoot) {
  const out = [];
  const own = path.join(configRoot, STATE_REL);
  if (fs.existsSync(own) && fs.lstatSync(own).isFile()) out.push(own);
  const dir = path.join(configRoot, STATE_SUBDIR);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isDirectory()) {
    for (const name of fs.readdirSync(dir)) {
      if (!SUB_STATE_NAME.test(name)) continue;
      const f = path.join(dir, name);
      try {
        if (fs.lstatSync(f).isFile()) out.push(f);
      } catch {
        /* 剛被 rename 走 */
      }
    }
  }
  return out;
}

/** 聚合讀取（規則根執行 state --list 用）：每個檔獨立驗證；壞檔進 warnings 不中斷。 */
export function loadAllStates(configRoot, { staleHours = STALE_HOURS } = {}) {
  const states = [];
  const warnings = [];
  for (const f of listStateFiles(configRoot)) {
    const read = readStateFile(f, null);
    if (read.error) {
      warnings.push(read.error);
      continue;
    }
    if (!read.state) continue;
    const st = { ...empty(), ...read.state };
    const cutoff = Date.now() - staleHours * 3600 * 1000;
    st.unreviewed = (st.unreviewed || []).map((e) => ({ ...e, stale: Date.parse(e.createdAt || 0) < cutoff }));
    st.file = f;
    states.push(st);
  }
  return { states, warnings };
}

/**
 * 刪除 state 檔（unwire --purge-state 用）：在鎖內進行，其他 session 持鎖時等待/逾時，不會硬刪別人正在寫的檔。
 * 回傳實際刪掉的檔案清單。鎖檔本身由 withLock 的 finally 釋放。
 */
export function purgeState(root) {
  const file = stateFile(root);
  const pending = path.join(path.dirname(file), "codex-pending.md");
  return withLockFile(file, () => {
    const removed = [];
    for (const p of [file, pending]) {
      if (fs.existsSync(p) && fs.lstatSync(p).isFile()) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    }
    return removed;
  });
}

/**
 * 規則根的全部 state 清除（unwire --purge-state 在規則根執行）：
 * 自身 state + codex-pending.md + codex-dispatch/ 下每個合法 state 檔（各自鎖內、逐檔驗證後刪）。
 * 只刪一般檔；.lock/.tmp/不符命名/損壞（無法驗證）的檔不動並回報。
 */
export function purgeAllStates(configRoot) {
  const removed = [];
  const skipped = [];
  const own = path.join(configRoot, STATE_REL);
  const pending = path.join(path.dirname(own), "codex-pending.md");
  withLockFile(own, () => {
    for (const p of [own, pending]) {
      if (fs.existsSync(p) && fs.lstatSync(p).isFile()) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    }
  });
  for (const f of listStateFiles(configRoot)) {
    if (f === own) continue;
    const read = readStateFile(f, null);
    if (read.error) {
      skipped.push(`${f}：${read.error}`);
      continue;
    }
    withLockFile(f, () => {
      if (fs.existsSync(f) && fs.lstatSync(f).isFile()) {
        fs.unlinkSync(f);
        removed.push(f);
      }
    });
  }
  const dir = path.join(configRoot, STATE_SUBDIR);
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* 留著無妨 */
  }
  return { removed, skipped };
}

export function resetRounds(root, key = null) {
  withLock(root, () => {
    const st = loadState(root);
    if (key) dropRound(st, key);
    else {
      st.rounds = {};
      st.roundsAt = {};
    }
    saveState(root, st);
  });
}
