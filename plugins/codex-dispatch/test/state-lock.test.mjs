/**
 * state 鎖測試：lockStillOwned 必須比對完整 token。
 * 只比 PID 前綴的話，鎖被別人判定 stale 搶走後仍會回 true——而它是 cmdSnippet 寫檔前的
 * 最後一道確認，等於沒有防線。
 * 執行：node --test plugins/codex-dispatch/test/*.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withLock, lockStillOwned, stateFile } from "../scripts/lib/state.mjs";

const TMP_DIRS = [];
after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-lock-"));
  TMP_DIRS.push(dir);
  fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true });
  return dir;
}

test("沒持鎖時 lockStillOwned = false", () => {
  assert.equal(lockStillOwned(makeRoot()), false);
});

test("持鎖中 lockStillOwned = true；離開後回 false", () => {
  const root = makeRoot();
  let inside = null;
  withLock(root, () => {
    inside = lockStillOwned(root);
  });
  assert.equal(inside, true);
  assert.equal(lockStillOwned(root), false);
});

test("鎖被同一個 PID 的另一把鎖換掉 → lockStillOwned 必須回 false", () => {
  const root = makeRoot();
  const lock = `${stateFile(root)}.lock`;
  let stolen = null;
  withLock(root, () => {
    // 模擬：我們停頓過久被判定 stale，別人搬走並重建了鎖。同一個 PID、不同隨機碼——
    // 只比 `${pid}:` 前綴會誤判成「還是我的」。
    fs.writeFileSync(lock, `${process.pid}:deadbeefcafe ${new Date().toISOString()}\n`);
    stolen = lockStillOwned(root);
  });
  assert.equal(stolen, false);
});

test("鎖檔不存在時 lockStillOwned = false，不拋錯", () => {
  const root = makeRoot();
  let gone = null;
  withLock(root, () => {
    fs.unlinkSync(`${stateFile(root)}.lock`);
    gone = lockStillOwned(root);
  });
  assert.equal(gone, false);
});
