# 交接文件：Claude Code × Codex 協作整合

> 本文件交接給 Claude Code 執行。目標:安裝官方 codex-plugin-cc、建立跨模型調度規則,並避開社群已知的坑。
> 撰寫日期:2026-08-28。plugin 生態變動快,執行前請以官方 repo README 為準。

---

## 1. 背景與目標

使用者(Mickey)想建立「Claude 寫、Codex 審」的跨模型工作流:

- **Claude Code**:主控端 + 建設方。負責規劃、實作。
- **Codex**:被呼叫的工具 + 批判方。負責審計畫、審 diff、救援卡住的 bug。
- 溝通走 **官方 codex-plugin-cc**(OpenAI 維護),調度規則由我們自訂(寫在 CLAUDE.md,之後可包成 plugin)。
- 方向是單向:Claude Code 呼叫 Codex,結果回傳。不做反向。

方案配置:Claude Max 20x(已有)+ ChatGPT Plus(Codex 端,輕度審查用途足夠)。

---

## 2. 前置條件檢查

執行安裝前,依序確認:

1. **Codex CLI 已安裝**
   ```bash
   codex --version
   ```
   未安裝的話:
   ```bash
   npm install -g @openai/codex
   # 或 macOS: brew install --cask codex
   ```
   注意:npm 套件只是 wrapper,會下載對應平台的 Rust binary。npm 安裝路徑需要 Node 18.18+。

2. **Codex 已登入**
   ```bash
   codex login status
   ```
   未登入則執行 `codex login`,用 ChatGPT 帳號(Plus)登入。用量會計入該帳號的 Codex 額度。

3. **Claude Code 版本**:確認支援 plugin marketplace(近期版本皆支援;過舊請先更新)。

---

## 3. 安裝官方 codex-plugin-cc

在 Claude Code 內執行:

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

`/codex:setup` 會檢查 Codex CLI 是否就緒與已認證;若缺少且 npm 可用,它會提議代為安裝。

**安裝後驗證**:跑一次 `/codex:review` 對任意小改動,確認能拿到 Codex 的審查回覆。

**重要:不要啟用 review gate**(`/codex:setup --enable-review-gate` 之類的選項一律跳過)。原因見第 5 節。

plugin 提供的指令(規則中會用到):

| 指令 | 用途 |
|---|---|
| `/codex:review` | 一般唯讀審查(當前變更或 branch vs main) |
| `/codex:adversarial-review` | 對抗式嚴格審查 |
| `/codex:rescue` | 把卡住的任務交給 Codex 處理 |
| `/codex:transfer` | 把當前 session 轉成 Codex thread |
| `/codex:status` / `/codex:result` / `/codex:cancel` | 背景任務管理 |

**模型/推理強度調整**(可選):在專案根目錄 `.codex/config.toml`:
```toml
model = "gpt-5.4-mini"          # 省額度時用 mini
model_reasoning_effort = "high"
```
plugin 使用全域 codex binary 與其設定,此檔可做專案層覆寫。

---

## 4. 調度規則(寫入專案 CLAUDE.md)

把以下區塊加入目標專案的 `CLAUDE.md`。門檻數字是初始值,之後依額度消耗調整。

```markdown
## Codex 協作規則

前提:已安裝官方 codex-plugin-cc,且 Codex CLI 已登入。

### 分工原則
- Claude(我):規劃、架構、實作。
- Codex:審查計畫、審查 diff、深度找 bug、救援。

### 觸發規則
1. 新功能或改動預計超過 50 行、或涉及 3 個以上檔案:
   a. 先產出實作計畫(存到 plans/ 目錄)。
   b. 呼叫 /codex:review 審核計畫,採納合理意見修訂後才開始實作。
2. 實作完成後,呼叫 /codex:review 審查未 commit 的 diff:
   - CRITICAL / HIGH 問題:直接修正並重新送審,最多 3 輪。
   - MEDIUM / LOW 問題:列出來讓使用者決定,不自行修改。
3. 同一個 bug 嘗試修復 2 次仍失敗:停止嘗試,呼叫 /codex:rescue。
4. 使用者明確說「上線前檢查」或「嚴格審查」:使用 /codex:adversarial-review。
5. 小改動(字串、參數、樣式微調、註解)不經過 Codex。

### 失敗處理(重要)
- 任何 Codex 呼叫失敗(含疑似 rate limit、空輸出、status 1):
  - 記錄失敗、告知使用者,重試最多 1 次,然後繼續原本工作。
  - 絕不因 Codex 失敗而阻塞或無限重試。
  - 建議使用者到 Codex CLI 跑 /status 確認額度。
- 審查迴圈硬上限 3 輪,到頂就交還使用者裁決。
```

**設計原則**(供未來調整時參考):
- 官方 plugin 管「溝通」,我們的規則管「調度」,職責分離。官方更新不影響規則。
- 規則寫給 Claude 看,使用者操作方式不變(「幫我加 XX」),不需背指令。
- 之後若要跨專案共用,可把此規則包成 plugin(skill + 可選 hooks + commands),把官方 plugin 當依賴。目前先用 CLAUDE.md 驗證流程,穩定後再包。
- **plugin 專案名稱已定案**:
  - GitHub repo 名:`codex-dispatch-plugin`(一眼可辨識為 plugin 格式,與使用者既有的 claude-knowledge-plugin 命名風格一致)
  - plugin 內部名(plugin.json 的 name):`codex-dispatch`(安裝指令與 slash command 前綴維持簡短)
  - 結構建議比照 claude-knowledge-plugin 的 marketplace 型:repo 根目錄放 marketplace.json,`plugins/codex-dispatch/` 底下才是 plugin 本體
  - 預期安裝指令:
    ```
    claude plugin marketplace add me7fun/codex-dispatch-plugin
    claude plugin install codex-dispatch@codex-dispatch-plugin
    ```

---

## 5. 社群已知的坑(務必避開)

### 坑 1:review gate 撞限額 → 無限迴圈(issue #306,截至撰寫時未修復)
- review gate 用 Stop hook 在 Claude 每次收工前強制 Codex 審查,不過不放行。
- Codex 撞到 ChatGPT 5 小時限額後,審查持續失敗(status 1、空輸出),但 hook 仍擋住 session 結束 → Claude 不停重試 → 白燒 Claude token,掛機時可能一路燒到 Claude 額度見底。
- 錯誤訊息看不出是 rate limit,只有空殼錯誤。
- **對策**:不開 review gate。改用第 4 節的規則觸發 + 失敗處理條款。若未來要開,只在使用者盯著螢幕的關鍵任務短暫開啟,結束立刻關。

### 坑 2:review gate 設定寫錯目錄(issue #59)
- `/codex:setup --enable-review-gate` 曾有 bug:setup 寫入 temp 目錄,hook 讀 persistent 目錄,看似開啟實際沒生效(或反之造成狀態混亂)。
- **對策**:同上,不用 review gate 就不會踩到。若哪天要用,先確認此 issue 已修復。

### 坑 3:plugin 內查不到 Codex 額度(issue #102,功能請求中)
- Claude Code 裡沒有指令能看 Codex 剩餘限額,必須切到 Codex CLI 跑 `/status`。
- **對策**:規則的失敗處理已涵蓋——失敗就提示使用者去 Codex 端查,不要瞎猜重試。

### 坑 4:額度是共用桶 + token 計費
- Codex 用量從 ChatGPT 帳號的 shared agentic usage limit 扣,與其他 agentic 功能共用。
- 2026/4 起改 token 式計費(input / cached input / output),credit 消耗依 token 組成浮動;fast mode 消耗更高。
- Plus 方案的 5 小時滾動窗口不大,把 Codex 當主力寫程式會撞牆;純審查用途通常撐得住。
- **對策**:維持「只審不寫」的分工。cloud task、fast mode、automations 都先不碰。

### 坑 5:審查迴圈放大消耗
- 每輪「Codex 審 → Claude 修 → 再審」兩邊額度一起燒。
- **對策**:規則已設 3 輪硬上限 + MEDIUM/LOW 不自動修。不要調高輪數上限。

---

## 6. 額度監控與調整

- **Codex 端**:Codex CLI `/status` 看 5h / 週限額。撞牆時可等窗口滾動恢復,或買 credit 續用。
- **Claude 端**:Claude Code `/usage`。
- **跑 1–2 週後檢視**:
  - Codex 常撞限額 → 提高送審門檻(50 行 → 100 行)、減少 adversarial-review、或審查改用 mini 模型。
  - Codex 額度大量剩餘 → 降門檻,或考慮把部分實作委派給 Codex(此時才評估是否升 Pro)。

---

## 7. 執行清單(依序)

- [ ] 確認 Codex CLI 安裝且登入(第 2 節)
- [ ] 安裝 codex-plugin-cc 並跑 `/codex:setup`(第 3 節)
- [ ] 跑一次 `/codex:review` 驗證通路
- [ ] 把調度規則寫入目標專案 CLAUDE.md(第 4 節)
- [ ] 用一個真實小任務(>50 行)走完整流程:plan → Codex 審 plan → 實作 → Codex 審 diff
- [ ] 確認失敗處理有效:可模擬(暫時登出 Codex)驗證 Claude 不會卡死
- [ ] 回報使用者:流程結果 + 兩邊額度消耗概況
