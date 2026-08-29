# v0.1.6：審查迴圈校準（解決「永遠審不完的尾巴」）

## 問題
自動迴圈用官方 adversarial prompt（定義：只要有任何實質風險就 needs-attention），每批都跑滿 3 輪、越修越偏極端情境（多視窗同時、鎖被搶、睡眠 2 小時），且我在到頂後「順手修再記未審」製造無限尾巴。
社群/研究調查見 README「為什麼要校準」：迴圈用一般審查、2–3 輪收斂、confidence ≥ 0.75、對抗式只在最後跑一次；Codex 審 Claude 會過度修正（arXiv 2607.21656）。

## 改動
1. `review`（adversarial 非 strict）自動附嚴重度校準：HIGH 限單人正常操作；多 session/極端時序最高 MEDIUM；confidence < 門檻不列；沒 HIGH 即 approve。
2. `confidenceThreshold=0.75`：低於門檻（或缺/無效 confidence）的 finding 移到 `lowConfidence`，不自動修；verdict 依過濾後重算（`modelVerdict` 保留原值）。
3. `--strict`：全對抗不校準，SKILL 規定只跑一次不進迴圈。
4. SKILL：修 HIGH 前先驗證能複現；到頂剩下的只呈現不修。

## 審查紀錄
- 試金石（--base f3a3959~1，涵蓋 #2be5b556 鎖 token 修正）：round 1 → 多視窗/鎖被搶情境**不再列 HIGH**，1 HIGH（過濾後 verdict 未重算，conf 0.98）已修；round 2 → 1 HIGH（缺 confidence 的 finding 繞過門檻，conf 0.98）已修；round 3 見下。
- round 3 → **approve**（cycle 正常結束）。1 MEDIUM（鎖 token 檢查與 unlink 非原子，多程序競態）交使用者決定。校準前這類情境全被列 HIGH；校準後正確降為 MEDIUM。
