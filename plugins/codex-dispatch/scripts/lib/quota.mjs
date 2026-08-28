/**
 * Codex 額度查詢：codex app-server stdio JSON-RPC → account/rateLimits/read。
 * 實驗性 API（官方 plugin 未使用）：嚴格 timeout，任何失敗 → status "unknown"，絕不擋流程。查詢本身不耗 Codex 額度。
 */
import { spawn } from "node:child_process";

export const QUOTA_STATUS = ["available", "exhausted", "unknown"];

function toIso(sec) {
  return typeof sec === "number" && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
}

function windowView(w) {
  if (!w || typeof w !== "object") return null;
  return {
    usedPercent: typeof w.usedPercent === "number" ? w.usedPercent : null,
    windowMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
    resetsAt: toIso(w.resetsAt)
  };
}

/** 把 rateLimits 原始物件整理成扁平快照（尚未判定 status）。 */
export function normalizeRateLimits(raw) {
  const rl = raw?.rateLimits ?? raw?.rateLimitsByLimitId?.codex ?? null;
  if (!rl || typeof rl !== "object") return null;
  return {
    planType: rl.planType ?? null,
    reached: rl.rateLimitReachedType ?? null,
    spendControlReached: rl.spendControlReached ?? null,
    primary: windowView(rl.primary),
    secondary: windowView(rl.secondary),
    credits: rl.credits ?? null
  };
}

/** 三態判定：exhausted / available / unknown */
export function classifyQuota(snapshot, threshold = 95) {
  if (!snapshot) return "unknown";
  if (snapshot.reached || snapshot.spendControlReached === true) return "exhausted";
  const windows = [snapshot.primary, snapshot.secondary].filter((w) => w && typeof w.usedPercent === "number");
  if (windows.length === 0) return "unknown";
  return windows.some((w) => w.usedPercent >= threshold) ? "exhausted" : "available";
}

function unknownQuota(error) {
  return { status: "unknown", usedPercent: null, resetsAt: null, planType: null, reached: null, primary: null, secondary: null, error };
}

/**
 * @returns {Promise<{status:string, usedPercent:number|null, resetsAt:string|null, planType:string|null, reached:string|null, primary, secondary, error:string|null}>}
 */
export function readQuota({ timeoutMs = 10_000, threshold = 95 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    let stderr = "";
    let child = null;
    let timer = null;

    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        if (child) child.kill();
      } catch {
        /* ignore */
      }
      resolve(payload);
    };
    const fail = (error) => finish(unknownQuota(error));

    try {
      // 單一命令字串 + shell：Windows 才找得到 codex.cmd，且不觸發 Node DEP0190 警告
      child = spawn("codex app-server", { shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return fail(`無法啟動 codex app-server：${err.message}`);
    }
    timer = setTimeout(() => fail(`額度查詢逾時（${timeoutMs}ms）`), timeoutMs);

    const send = (o) => {
      try {
        child.stdin.write(`${JSON.stringify(o)}\n`);
      } catch (err) {
        fail(`寫入 app-server 失敗：${err.message}`);
      }
    };

    child.on("error", (err) => fail(`codex app-server 錯誤：${err.message}`));
    child.on("exit", (code) => {
      if (!done) {
        const last = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
        fail(`codex app-server 提前結束（exit ${code}）${last ? `：${last}` : ""}`);
      }
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 0) {
          if (msg.error) return fail(`initialize 失敗：${msg.error.message ?? JSON.stringify(msg.error)}`);
          send({ jsonrpc: "2.0", method: "initialized" });
          send({ jsonrpc: "2.0", id: 1, method: "account/rateLimits/read", params: null });
        } else if (msg.id === 1) {
          if (msg.error) return fail(`account/rateLimits/read 失敗（${msg.error.code ?? "?"}）：${msg.error.message ?? ""}`);
          const snap = normalizeRateLimits(msg.result);
          if (!snap) return fail("rateLimits 回應缺少可辨識欄位");
          return finish({
            status: classifyQuota(snap, threshold),
            usedPercent: snap.primary?.usedPercent ?? null,
            resetsAt: snap.primary?.resetsAt ?? null,
            planType: snap.planType,
            reached: snap.reached,
            primary: snap.primary,
            secondary: snap.secondary,
            error: null
          });
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "codex-dispatch", title: "codex-dispatch", version: "0.1.0" } }
    });
  });
}
