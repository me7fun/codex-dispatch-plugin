# v0.1.10：Ground Truth 先行、交還格式、Stop hook 兜底、最小修改範圍

來源：社群「自己修正ループ」文章（Builder/Judge/Manager、Layer 1 機械檢查、固定引繼格式、Judge 不編輯、最多修正回數）。與本 plugin 已一致的部分不動，只補四項。

## 1. Ground Truth 先行（機械檢查）
- 設定 `checks: string[]`（預設 `[]`，不自動偵測——測試套件可能很長）；`checksTimeoutSec`（預設 300）。在**規則根**設定、在**審查根**執行（cwd=reviewRoot，shell）。
- `review`：送 Codex 前逐一執行；任一失敗 → `ok:false, reason:"checks-failed", checks:[{cmd, status, durationMs, tail}]`，exit 1，**不呼叫 Codex、不佔輪次**。全過 → 把「Ground truth: <cmd> → exit 0 (Ns)」摘要附進 focus（校準段之後），讓 Codex 以確定結果為根據。
- `--skip-checks` 跳過（SKILL：只在使用者明說時用）。`preflight` 顯示已設定的 checks。
- 輸出 tail 限最後 30 行、每行 400 字；命令以 `spawnSync(cmd, {shell:true, cwd:reviewRoot, timeout})` 執行；逾時視為失敗。
- 安全：checks 來自規則根設定檔（使用者自己寫的），CLI 不從引數接受任意命令。

## 2. 固定的交還格式（SKILL）
到頂、Codex 失敗走 B、rescue 失敗、或任何要人裁決的情況，最終回覆一律用：
```
## 交還：<一句話任務>
**目前成果**：<檔案／狀態；已 commit 與否>
**試過的修正**：round 1 → …；round 2 → …
**剩餘**：critical N／high N／medium N／low N／低信心 N（逐條：位置＋一句話）
**根據**：測試結果／Codex verdict／未審清單編號
**要你決定**：<具體選項>
```
## 3. Stop hook 兜底（不呼叫 Codex，不會無限迴圈）
- `scripts/stop-gate.mjs`，兩模式共用 session 旗標檔 `os.tmpdir()/codex-dispatch-stop-<md5(session_id)>.json`：
  - `mark`（PostToolUse，matcher Bash|PowerShell）：指令含 `dispatch.mjs` 且子指令為 review／plan-review／rescue／state --add-unreviewed → 立 `touched` 旗標。只認真的執行過。
  - `gate`（Stop）：`stop_hook_active` 為真 → 放行。無 `touched` → 放行。有 → 讀規則根（`CLAUDE_PROJECT_DIR` → cwd）所有 state 檔（含 codex-dispatch/*.json）的未審清單；為空 → 放行並清旗標；非空且 `last_assistant_message` 在 code fence 外沒有獨立成行的「⚠ 未經 Codex 審查」標題 → block，reason 列出條目要求加標題；一輪最多擋 2 次後放行重置。
  - fail-soft：任何錯誤輸出 `{}`。
- hooks.json 註冊 PostToolUse 與 Stop（timeout 5）。
- 與官方 review gate 的差別寫進 README：本 hook 只檢查文字標記與本機 state，零 Codex 呼叫。

## 4. 最小修改範圍（SKILL 一句）
修 finding 時只改它指到的位置與必要的關聯處；不重寫、不順手重構其他地方——round 2 常抓到「修正引入的新 bug」就是這個原因。

## 測試
- checks：假專案設 `checks:["node -e \"process.exit(0)\""]` → review（假 companion）成功且 focus 含 Ground truth；設失敗命令 → reason=checks-failed、rounds 不變、companion 未被呼叫（假 companion 寫記號檔）；逾時 → 失敗；`--skip-checks` 跳過。
- stop-gate：模擬 PostToolUse 輸入（含 dispatch review 指令）→ 旗標；Stop 輸入無標題 + 有未審 → block；有標題 → 放行清旗標；`stop_hook_active` → 放行；擋 2 次後第 3 次放行；未 touched → 放行；未審清單空 → 放行。
- 單 repo 與 submodule 佈局的 state 讀取都要涵蓋。

## 計畫審查紀錄
- 2026-08-30 dispatch plan-review：needs-attention，2 HIGH + 5 MEDIUM + 2 LOW，全採納：checks 改讀本機 `.claude/codex-dispatch.local.json`（被 git 追蹤即停用）；native 模式 checks 只當閘門；checks-failed 用 exit 2；順序 = 引數/根/diff/機密 → 額度預檢 → checks → 佔輪次 → Codex；輸出 maxBuffer 8MB、tail 30 行、逾時/訊號/ENOBUFS 分開；Stop hook state 讀取失敗擋一次並附診斷；旗標生命週期 = touched 保留、標題出現記 ackDigest、清單變動再擋；PostToolUse 用嚴格 invocation regex；checks 驗證上限（10 條、500 字、10–1800s）。
