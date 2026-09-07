# v0.1.12：plan-architect（Antigravity CLI `agy` 規劃層，可優雅降級）

> 草案由 Antigravity CLI 1.1.27 以 `--mode plan` 唯讀讀取本 repo 產出（152s），Claude 審閱修訂：掃描根與 `--add-dir` 改為審查根、補 `--force`、Windows 測試改用環境變數覆寫、回應無標題視為 invalid-output、細節對齊既有 helper。來源：`FEAT_GEMINI_ARCHITECT.md`。

## 目標
- 新增 `dispatch.mjs plan-architect <prompt> [--output <file>] [--model m] [--effort low|medium|high] [--timeout sec] [--force] [--allow-secrets] [--cwd d] [--json]`，形成「Antigravity 規劃 → Codex 審計畫 → Claude 實作 → Codex 審 diff」。
- 現有護欄一行不動：額度預檢、嚴重度校準、輪次原子鎖、state、Stop hook（`INVOKE_RE` 不加它）。
- 優雅降級：`agy` 不在 PATH → `reason:"agy-not-installed"`；執行失敗／逾時／`status≠SUCCESS`／工作區被改 → `agy-error`；回應空、讀檔被拒、回應沒有 Markdown 標題 → `invalid-output`（以上 exit 1，帶 `fallback:"claude"`）；引數／路徑／機密／非 git repo → `local-error`（exit 2）。呼叫端看到 `ok:false` 一律自己寫計畫，不重試、不問、不記未審清單。

## 已實測的 `agy` 1.1.27 行為（本計畫的根據）
1. `-p` 是**帶值旗標**：`-p "<prompt>"`，所有其他旗標必須放在 `-p` 前面，否則 `-p` 會吃到下一個旗標當 prompt。stdin 不會被當 prompt。→ prompt 走 argv，`spawnSync(bin, argv)` 無 shell，安全。
2. 沒有 `--add-dir` 時工作區是 agy 自己的 `~/.gemini/antigravity-cli/scratch`，讀 repo 檔案會被自動拒絕（`response:""`、`denied_actions:[{action:"read_file"}]`、exit 0、stderr 提示）。加 `--add-dir <repo>` 後讀檔自動允許。
3. **預設模式 + `--add-dir` 會真的寫檔**（實測建出 PWNED.md）。`--mode plan` 不寫 repo：只在 `~/.gemini/antigravity-cli/brain/<conversation_id>/implementation_plan.md` 留副本，計畫文字放在 `response`；即使加 `--dangerously-skip-permissions` 也不寫。shell 指令 headless 一律自動拒絕。→ 固定 `--mode plan`、永不 `--dangerously-skip-permissions`，執行前後再比對 `git status --porcelain` 當偵測層。
4. `--output-format json` stdout 是單一 JSON：`{conversation_id, status:"SUCCESS"|"ERROR"|…, response, error?, duration_seconds, num_turns, usage, denied_actions?}`。`response` 內有 `[name](file:///C:/abs#L1)` 連結，要壓平成 `name`。
5. `--print-timeout` 是 Go duration（預設 `5m0s`，`600s` 合法）；有 `--model`、`--effort low|medium|high`。Windows 是 `%LOCALAPPDATA%\agy\bin\agy.exe`（Go 二進位，無 npm shim），user PATH 已含該目錄但既有 shell 不一定刷新。
6. 使用者層設定在 `~/.gemini/antigravity-cli/settings.json`（含 `trustedWorkspaces`）；未列入信任的目錄 headless 一樣能跑。

## 涉及檔案
1. `plugins/codex-dispatch/scripts/lib/paths.mjs`（修改）：新增 `gitWorkspaceFiles(root)`——回 `{visible, ignored}`：visible＝tracked ＋ 未忽略 untracked（`git ls-files -co --exclude-standard -z`）；ignored＝被 .gitignore 忽略的檔（`git ls-files -oi --exclude-standard -z`，**agy 實測會讀這些**，含忽略目錄內的檔）；兩者都遞迴進入已初始化 submodule（`gitSubmodulePaths`）與未登記巢狀 repo（`ls-files -o` 以 `dir/` 列出且內含 `.git`）；深度上限 10、去重；任何 git 失敗（含 60s 逾時、64MB 溢出）回 `{error}`（fail-closed）。
2. `plugins/codex-dispatch/scripts/dispatch.mjs`（修改）：
   - `secretGate(paths, allow, sink)` 加第三個參數（預設維持「送 Codex（內容會送到 OpenAI）」），既有呼叫不變。
   - `insideRootForWrite(root, abs)`：往上找最近存在的祖先取 realpath 比對根界線；尚未存在的段落不得含 `.`／`..`（既有 `insideRoot` 對不存在的路徑一律 false）。
   - `findAgy()`：先看環境變數 `CODEX_DISPATCH_AGY`（絕對路徑；`.js/.mjs` 結尾則用 `process.execPath` 跑，給測試與非標準安裝用），再掃 PATH（Windows 只認 `.exe/.com`，不碰 `.cmd/.bat`，因 Node ≥18.20 不能無 shell spawn 它們），最後試 `%LOCALAPPDATA%\agy\bin\agy.exe`。找不到 → `agy-not-installed`。
   - `planSlug`、`flattenFileLinks`（`/\[([^\]]+)\]\(file:\/\/[^)]*\)/g → $1`）、`buildArchitectPrompt`、`formatPlanMarkdown`（標題＋來源前言＋本體＋`## 計畫審查紀錄` 佔位）、`gitStatusSnapshot`、`runAgy`、`interpretAgy`、`cmdPlanArchitect`、`renderPlanArchitect`；header 說明與 `main()` switch 各加一行。
3. `plugins/codex-dispatch/skills/dispatch/SKILL.md`：分工加 Antigravity；觸發規則 1a 改為「先 `plan-architect`，`ok=false` 就自己寫」；子指令清單、結果物件 reason 補齊；失敗表下加一句「plan-architect 失敗一律 C」。
4. `plugins/codex-dispatch/scripts/session-start.mjs`：接線摘要第一條提到 Antigravity 規劃層與降級。
5. `README.md`：「它做什麼」第一列、前置條件（選配 `agy`）、新段「Antigravity 規劃層（選配）」、底層 CLI 清單、資料與安全、已知限制。
6. `plugins/codex-dispatch/test/plan-architect.test.mjs`（新）：`node --test`，假 `agy`（node 腳本，經 `CODEX_DISPATCH_AGY` 注入；另一案例用 PATH 前置的 Unix sh shim／Windows 跳過）。`.claude/codex-dispatch.local.json`（不進 git）設 `checks:["node --test plugins/codex-dispatch/test/*.test.mjs"]`（Node 24 的 `--test` 要 glob）。

## 步驟
1. `cmdPlanArchitect`：`parseArgv` → `rootsOrFail`（雙根）→ `loadConfig(reviewRoot)` 取 `planDir` → 驗 prompt 非空、`--model` 符合 `/^[A-Za-z0-9._-]{1,80}$/`、`--effort` ∈ low|medium|high、`--timeout` 5..1800 整數（預設 600）→ `gitTopLevel(reviewRoot)` 否則 local-error。
2. 輸出路徑 `resolveOutputPath`：`--output` 相對呼叫者 cwd；預設 `<configRoot>/<planDir>/<slug>.md`；必須 `.md`、`insideRootForWrite` 落在兩根之一、`refuseSymlink`、已存在且無 `--force` → 拒絕。
3. 機密閘門：`gitWorkspaceFiles(reviewRoot)`（agy 的 `--add-dir` 就是它）→ error 即 local-error；`secretGate([...visible, ...ignored], allow, "交給 Antigravity（agy 會讀整個工作區，含 .gitignore 忽略的檔，內容送到 Google）")`。ignored 清單套一個例外：`.env.example|.env.sample|.env.template|.env.dist` 不算（範本檔常見於 node_modules，不含祕密）；visible 清單維持 review 同一套規則。
4. `findAgy()` 失敗 → `{...base, reason:"agy-not-installed", fallback:"claude"}`。
5. `workspaceFingerprint(reviewRoot)` 前快照：`git status --porcelain=v1 -z --untracked-files=all` 的條目 ＋ **每個 dirty／untracked 檔的內容 sha1**（>8MB 改用 size+mtime）＋ 遞迴巢狀 repo／submodule 同樣處理；取不到 → local-error。（Codex 指出：只比 porcelain 文字，已經 dirty 的檔再被改一次、或既有 untracked 檔內容變了，狀態列完全一樣。）ignored 檔仍不在指紋內——README 註明。
6. `runAgy`：argv＝`["--add-dir", reviewRoot, "--mode", "plan", "--output-format", "json", "--print-timeout", `${sec}s`, (--model m), (--effort e), "-p", buildArchitectPrompt(prompt)]`——`-p` 永遠最後；`spawnSync` 無 shell、`cwd=reviewRoot`、`timeout=sec*1000+5000`（agy 自己的 print-timeout 先到，父程序 5 秒後兜底）、`maxBuffer 64MB`、`windowsHide`。
7. 後指紋 ≠ 前指紋或取不到 → `agy-error`「工作區有變動」不採用輸出。
8. `interpretAgy`：spawn error／逾時／status≠0 → `agy-error`（error 取 stderr tail）；stdout 非 JSON → `invalid-output`；`payload.status !== "SUCCESS"` → `agy-error`（帶 `payload.error`）；`denied_actions` 含 `read_file` → `invalid-output`「讀檔被拒（沒帶 --add-dir？）」；`response` 空白或沒有任何 `^#` 標題行 → `invalid-output`；否則回 `{response, conversationId, durationSeconds, usage, deniedActions}`。
9. `formatPlanMarkdown`：`flattenFileLinks` → 剝整段 fence → 第一個 `# ` 當標題（沒有就用 prompt 前 60 字）→ 前言 `> Antigravity CLI 規劃草案（codex-dispatch plan-architect）。conversation：…；產出：ISO；耗時 Ns。` ＋ `> 草案僅供 Claude 審閱修訂，需經 Codex plan-review 後才作為實作依據。` ＋ `> 需求：…（≤200 字）` → 本體 → 沒有 `## 計畫審查紀錄` 就補「（尚未經 Codex plan-review）」。
10. 寫檔：`mkdirSync recursive`；**無 `--force`** → `writeFileSync(out, doc, {flag:"wx"})`（exclusive create：agy 跑了幾分鐘期間若有人建了同名檔，直接 local-error 不覆蓋）；**有 `--force`** → 暫存檔 → `refuseSymlink` → `renameSync` 取代。失敗清暫存檔。結果 `{ok:true, kind:"plan-architect", output, outputRel, prompt, agy:{bin, model, effort, conversationId, durationMs, usage, timeoutSec}, raw:response, nextSteps:[審閱, plan-review 指令], reviewRoot, configRoot}`；render 印路徑、agy 資訊、前 20 行、next steps。
11. SKILL／session-start／README 依「涉及檔案」更新。

## 測試方式
`node --test plugins/codex-dispatch/test/*.test.mjs`。每案例 tmp 目錄 `git init` 假專案，假 `agy` 是 node 腳本（讀 `FAKE_AGY_*` 環境變數控制行為，把 argv／cwd 寫記號檔），以 `CODEX_DISPATCH_AGY=<腳本路徑>` 注入；PATH 一律先去掉含真 `agy` 的目錄。
- 成功：`{status:"SUCCESS", response:"# Plan\n…[index.js](file:///C:/x/index.js#L1)…"}` → `ok:true`、`plans/<slug>.md` 存在、連結壓平、含前言與審查紀錄段、`argv` 含 `--mode plan`、`--add-dir <repo realpath>`、`--output-format json`、`-p` 是最後一個旗標且其值含 prompt、**不含** `--dangerously-skip-permissions`、cwd＝repo。
- 未安裝：無 env 覆寫、PATH 去掉 agy、`LOCALAPPDATA` 指到空目錄 → `agy-not-installed`、exit 1、沒建檔。
- PATH 找到（Unix）：sh shim 前置 PATH → 成功（Windows 跳過）。
- exit≠0 → `agy-error` 含 stderr；`{status:"ERROR", error:"quota"}` → `agy-error` 含 quota；stdout 非 JSON → `invalid-output`；`denied_actions:[{action:"read_file"}]` → `invalid-output`；`response:"  "` → `invalid-output`；`response:"I made a plan at file:///…"`（無標題）→ `invalid-output`。
- 假 agy 在 cwd 建新檔 → `agy-error`「工作區有變動」、計畫不落地；假 agy **改一個本來就 dirty 的 tracked 檔**（porcelain 不變）→ 同樣 `agy-error`；假 agy **改一個既有 untracked 檔的內容** → 同樣 `agy-error`。
- 假 agy 執行期間在目的路徑建了檔（無 `--force`）→ local-error、原檔內容保留。
- 逾時：`FAKE_AGY_SLEEP_MS=12000`、`--timeout 5`（父程序 10s 兜底）→ `agy-error` 含逾時。
- `--model "x;calc"`、`--effort ultra`、`--timeout 0` → local-error、agy 未被呼叫。
- 機密：根 `.env` → local-error 且未呼叫；`--allow-secrets` 放行；巢狀 repo 內 `credentials.json` → local-error；**gitignored `.env` 與忽略目錄內的 `creds.pem` → 也 local-error**（實測 agy 讀得到）；ignored 的 `.env.example` → 放行。
- `--output`：`../x.md` 逃逸、`plan.txt`、已存在無 `--force` → local-error；`--force` 覆寫；`docs/deep/plan.md` 新目錄自動建立；父目錄為指向 repo 外的 symlink → local-error（建不出 symlink 就 skip）。
- 中文 prompt → `plans/plan-<yyyymmdd>-<4hex>.md`。缺 prompt／非 git repo → local-error。
- `help` 含 plan-architect；三支 scripts `node --check`。
- 真機（不進自動測試，實作後做一次）：本 repo 跑 `plan-architect "<小需求>"`，確認格式與 `git status` 乾淨。

## 不做什麼
- 不加設定鍵、不加 slash command、不改 config.mjs／state.mjs／quota.mjs／stop-gate.mjs／hooks.json。
- 不用 `--dangerously-skip-permissions`、不用預設模式、不代改 `~/.gemini/antigravity-cli/settings.json`。
- 不自動接著呼叫 `plan-review`；不查 Antigravity 額度；不自動 commit。

## 風險與未知
- agy 在 plan mode 偶爾只回「已產生計畫（連結）」而不把計畫放在 `response`：以「沒有標題就 invalid-output → 降級」處理，不重試。
- agy **不尊重 `.gitignore`**（實測：讀出 gitignored `.env` 與忽略目錄內的檔）→ 閘門連 ignored 一起掃；代價是大型 node_modules 列舉較慢（60s／64MB 上限，超過 fail-closed）。指紋比對不含 ignored 檔（agy 若改了 ignored 檔偵測不到；plan mode 本身不寫，這是第三層）。
- 大型 monorepo 列舉：`git ls-files` 30s／64MB 上限，超過即 fail-closed。
- `trustedWorkspaces` 之外的目錄未來版本可能要求信任（未驗證）；屆時會是 `agy-error` 降級，不卡流程。

## 計畫審查紀錄
- 2026-09-07 dispatch plan-review：needs-attention，2 HIGH ＋ 2 MEDIUM，全採納：(1) gitignored 機密會漏——實測 agy 讀得到 gitignored `.env` 與忽略目錄內的檔 → 閘門加掃 `git ls-files -oi`；(2) porcelain 文字相等不代表內容沒變 → 指紋改為條目＋dirty/untracked 檔內容 sha1，補「改 dirty 檔」「改 untracked 檔」測試；(3) 跑完 rename 可能蓋掉期間新建的檔 → 無 `--force` 用 `wx` exclusive create；(4) 逾時測試睡 8s 撞不到 20s 父逾時 → 父逾時改 sec+5s、fake 睡 12s。
- 2026-09-07 dispatch review（adversarial、round 1/3，checks 15 pass／1 skip）：approve，0 findings。真 agy 1.1.27 手動驗證：`--mode plan` 不寫 repo（連 `--dangerously-skip-permissions` 也擋）、預設模式會寫、不看 .gitignore；小 repo 端對端 42s 產出六段落計畫，工作區乾淨。
