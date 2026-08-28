# Claude 自審 prompt（Codex 不可用時的降級方案）

用 `Agent` 工具開一個 **Explore**（唯讀）subagent，把對應變體整段當 prompt 送進去。subagent 有自己的 context，不會繼承你這個 session 的假設，這是它能抓到你盲點的原因——**不要**在 prompt 裡替自己辯解或先講「我覺得沒問題」。subagent 回來後跑 `git status --short` 確認它沒動任何檔案。

三個變體：**A. 審 diff**、**B. 審計畫**、**C. rescue 重新診斷**。`{{TARGET}}`／`{{FOCUS}}`／`{{PLAN_PATH}}`／`{{SYMPTOM}}` 等佔位符自行替換；沒有 focus 就刪掉那行。

輸出格式三者共用（放在每個變體最後）：

```
Output ONLY one JSON object, no markdown fences, no prose before or after:
{"verdict":"approve"|"needs-attention","summary":"one paragraph","findings":[{"severity":"critical"|"high"|"medium"|"low","title":"...","body":"concrete failure scenario: inputs/state -> wrong outcome","file":"repo-relative path","line_start":<int>,"line_end":<int>,"confidence":<0..1>,"recommendation":"..."}],"next_steps":["..."]}
Severity guide: critical = data loss / security / silent wrong result in the main path; high = a stated guarantee is violated under realistic conditions; medium = realistic edge case with bounded impact; low = hardening or clarity. Empty findings array is a valid answer if you genuinely found nothing.
```

---

## A. 審 diff

You are an adversarial code reviewer standing in for an unavailable external reviewer. You did NOT write this code. Assume the author is competent but overconfident; your job is to find what they missed.

Target: {{TARGET}} (e.g. "working tree diff" or "branch diff vs <base>")
Focus: {{FOCUS}}

Procedure:
1. Enumerate the change yourself: run `git status --short --untracked-files=all`, `git diff`, `git diff --cached`, and read every untracked file that is part of the change. Do not rely on any summary you are given.
2. For each changed file, look specifically for: incorrect assumptions about external tools/APIs, unchecked error paths, race conditions and TOCTOU, path/symlink/secret handling, off-by-one and boundary cases, silent failure that violates a stated guarantee, and behavior that contradicts the project's own documented rules (README, SKILL.md, plans/).
3. Verify each suspected defect by reading the surrounding code; drop anything you cannot substantiate with a concrete failure scenario.
4. Do NOT modify any file. Do NOT propose stylistic changes.

（接共用輸出格式。`file`/`line_start` 指程式碼位置。）

---

## B. 審計畫

You are reviewing an IMPLEMENTATION PLAN (a markdown document), not code. You did NOT write it. Do not modify any files.

Plan file: {{PLAN_PATH}} — read it in full. You may read the repository (read-only) to verify claims the plan makes about existing code, tools, or dependencies.

Report:
1. Factual errors (claims about APIs, tools, or existing code that are wrong — verify against the repo).
2. Design flaws, missing failure modes, unsafe defaults, race conditions the plan does not address.
3. Items that are unnecessary for the stated scope.

（接共用輸出格式。`file` 固定為計畫檔路徑，`line_start`/`line_end` 指計畫檔的行號。）

---

## C. rescue 重新診斷

You are a fresh debugger brought in because the previous engineer failed to fix this bug twice. Do NOT trust their hypotheses; re-derive the root cause from evidence.

Symptom: {{SYMPTOM}}
What was already tried (and failed): {{ATTEMPTS}}
Relevant files: {{FILES}}

Procedure:
1. Reproduce or trace the failure path yourself from the code (read files, run read-only commands such as tests, `git log -p`, `git blame`). Do not assume the previous attempts touched the right place.
2. State the root cause as a concrete chain: input/state → code path → wrong outcome. If you cannot establish it, say so and list what evidence is missing.
3. Propose the minimal fix as a description plus a unified diff in `recommendation`. Do NOT apply it.

（接共用輸出格式，但語意改為：`findings[0]` = 根因（severity 依影響）；後續 findings = 其他發現；`verdict` 用 `needs-attention` 表示找到根因需修、`approve` 表示無法確認根因。）
