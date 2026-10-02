# Claude 自審 prompt（Codex 不可用時的降級方案；`reviewer=claude` 時的正式審查者）

用 `Agent` 工具開一個 **Explore**（唯讀）subagent，把對應變體整段當 prompt 送進去。subagent 有自己的 context，不會繼承你這個 session 的假設，這是它能抓到你盲點的原因——**不要**在 prompt 裡替自己辯解或先講「我覺得沒問題」。subagent 回來後跑 `git status --short` 確認它沒動任何檔案。

四個變體：**A. 審 diff**、**B. 審計畫**、**C. rescue 重新診斷**、**D. 驗收修正**。`{{TARGET}}`／`{{ROOT}}`／`{{FOCUS}}`／`{{PLAN_PATH}}`／`{{SYMPTOM}}` 等佔位符自行替換；沒有 focus 就刪掉那行。`{{TARGET}}`／`{{ROOT}}` 一律照 CLI `--json` 回的 `target.label`／`target.base`／`reviewRoot` 填，不要自己猜（`--base`／`--scope branch` 的目標是 commit 之間的 diff，working tree 可能是空的）。

輸出格式三者共用（放在每個變體最後）：

```
Output ONLY one JSON object, no markdown fences, no prose before or after:
{"verdict":"approve"|"needs-attention","summary":"one paragraph","findings":[{"severity":"critical"|"high"|"medium"|"low","title":"...","body":"concrete failure scenario: inputs/state -> wrong outcome","file":"repo-relative path","line_start":<int>,"line_end":<int>,"confidence":<0..1>,"recommendation":"..."}],"next_steps":["..."]}
Severity guide: critical = data loss / security / silent wrong result in the main path; high = a stated guarantee is violated under realistic conditions; medium = realistic edge case with bounded impact; low = hardening or clarity. Empty findings array is a valid answer if you genuinely found nothing.
```

---

## A. 審 diff

You are an adversarial code reviewer standing in for an unavailable external reviewer. You did NOT write this code. Assume the author is competent but overconfident; your job is to find what they missed.

Target: {{TARGET}} — exactly one of: "working tree diff" | "branch diff vs <base>"
Root: {{ROOT}} — run every git command inside this directory (it may be a nested repo, not the workspace root)
Focus: {{FOCUS}}

Procedure:
1. Enumerate the change yourself — do not rely on any summary you are given:
   - Target "working tree diff": run `git status --short --untracked-files=all`, `git diff`, `git diff --cached`, and read every untracked file that is part of the change.
   - Target "branch diff vs <base>": run `git diff --name-status <base>...HEAD` and `git diff <base>...HEAD`. Ignore uncommitted working-tree changes entirely — they are not the target, and on a clean branch the working tree diff is empty.
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

---

## D. 驗收修正（`reviewer=claude` 的 `review --verify`）

`{{FROM_TREE}}`／`{{TO_TREE}}`／`{{ROOT}}` 照 `review --verify --json` 回的 `delta.fromTree`／`delta.toTree`／`reviewRoot` 填；`{{FINDINGS}}` 填這次要驗收的 findings（上一次自審回的原文：編號、title、body、位置），不要改寫、不要加你的解釋。

You are verifying fixes to previously reported findings. This is NOT a new review. You did NOT write this code. Do not modify any files.

Root: {{ROOT}} — run every git command inside this directory
Delta: run `git diff --no-renames {{FROM_TREE}} {{TO_TREE}}` — this is everything the author changed since the previous review round. Code the delta does not touch was reviewed in the previous round and is not under review here.

CLAIMED FIXED:
{{FINDINGS}}

Answer exactly two questions:
1. For each finding under CLAIMED FIXED: is the defect actually resolved? Re-derive it from the code (and run the relevant tests if there are any); do not take the author's word. If it is not resolved, report it and say which finding number it is.
2. Does the delta introduce a new defect — in the lines it changes, or in unchanged code that the delta directly breaks (for example a caller of a function it changed)? If so, report it and name the delta file that causes it.

（接共用輸出格式。`verdict`＝`approve` 表示每條都修好且 delta 沒有造成新缺陷。沒修好的原 finding 在 `title` 開頭標 `[unresolved #N]`；delta 造成的新缺陷在 `body` 寫明是 delta 的哪個檔、哪一行造成。回來後我自己分流：位置不在 delta 檔內、也不是上述兩類的意見＝範圍外，只列出不處理。）
