# Codex Mia V3 Handover

Last updated: 2026-05-28 JST

## First Read

This file is the active handover for the V3 launcher work. At the start of the next session, read this file before making changes.

Keep V2 preserved. Do not edit or restart V2 unless the user explicitly asks.

## Project Paths

Local project:

`/mnt/c/Users/USER/Documents/side_biz/02_reddit_global`

V3 launcher:

`v3_launcher/`

VPS URL:

`http://37.60.224.54:3010`

VPS project path:

`/root/sekai_no_wadai/02_reddit_global`

PM2:

- V2: `soccer-yt-v2` on port 3004. Preserve it.
- V3: `soccer-yt-v3` on port 3010. Restart only this for V3 deploys.

## Current V3 Goal

Build a V3 "editorial director" layer before the existing V2 video pipeline.

Target flow:

`topic / Reddit / memo -> brief -> arguments -> beats -> slide plan -> research plan -> verified data -> script/TTS`

The user wants V3 to reduce manual work currently spent on:

- slide-by-slide script direction
- data consistency checks
- adding side stories
- increasing script heat and narrative clarity

## Current UI

The V3 launcher is a simple smartphone-friendly prototype.

Current result tabs:

- `1 案件`
- `2 企画提案`
- `3 企画書`
- `4 脚本構成`
- `5 脚本`
- `6 V2`

Recent UX changes:

- Old `リサーチ` / `AI分析` / `テーマ` are combined into `Step2 企画提案`.
- `Step3 企画書` now renders an editable briefing textarea and has `企画書の内容で脚本構成`.
- `Step4 脚本構成` is now a V2-like editor surface with slide type, title, narration, data/source rows, image upload/gallery, and an inline slide preview using `/api/v2/preview-slide-inline`.
- `Step1 案件` can load story candidates by date, select and save them into V2 `saved_projects.json`, then set the selected project into V3 inputs.
- V3 mounts selected V2 API routers for editor reuse: Step3 save modules, Step3.5 image upload/selection, Step4 slide preview.
- 2026-05-27: UI was restyled closer to V2: left sidebar is saved projects, top step nav is sticky, main work area uses V2-style step containers. Colors remain V3 dark/gold.
- 2026-05-27: Step tabs were hardened. V3 now renders only the active step body instead of keeping all step panels in the page and hiding them with CSS. Step1 contains only case selection/input.
- 2026-05-27: Step1 case picker was restyled closer to V2 Step1: date toolbar, selected count, time-group accordions, source badges, checkbox rows.
- 2026-05-27: Saved projects remain in the left sidebar for normal desktop/tablet widths. The responsive breakpoint was lowered so saved projects no longer jump to the top except on narrow mobile.

Important UX preference from the user:

- Keep it simple.
- Avoid long vertical pages.
- Use transitions/tabs for each thinking layer.
- The UI should be human-facing, not JSON-facing.

## Key Files

`v3_launcher/server.js`

- Express standalone launcher.
- Renders the V3 UI.
- Has no-cache headers.
- Shows tabbed result UI.
- Shows slide type, existing/new candidate status, needed data values, and source hints.

`v3_launcher/v3_story_architect.js`

- Builds `argumentPlan`.
- Parses editable brief.
- Converts brief points into grouped chapters, then beats.
- Converts beats into slide plan.
- Adds slide template choice and data requirements.

`v3_launcher/v3_research.js`

- Uses existing V2 fetchers without modifying V2.
- Runs 3 Serper query style topic research.
- Selects 3-5 good URLs per query.
- Fetches article body.
- Fetches capped Wiki side-story candidates.

## Latest Commits

Recent V3 commits:

- `c035f3f feat(v3): show slide templates and data sources`
- `a188a45 feat(v3): add step tabs for design result`
- `bd879fc feat(v3): add slide outline from beats`
- `4850b40 fix(v3): reduce repeated beat details`
- `06f52fb fix(v3): simplify design result view`
- `a0753f6 feat(v3): build beats from editable brief`

GitHub push previously failed because HTTPS credentials were not available. Deploys have been done by `tar` + `scp` directly to VPS.

## Current V3 Behavior

The default sample topic is:

`スペイン代表、レアル・マドリー所属選手0人`

On `設計する`:

1. Reads editable brief.
2. Builds human brief:
   - core
   - answer
   - arguments
   - cautions
3. Builds beats.
4. Builds slide plan.
5. For each slide, shows:
   - slide type
   - existing V2 type or V3 candidate
   - needed data value
   - source hint

Current V2 slide types recognized in V3:

- `opening`
- `history`
- `comparison`
- `stats`
- `profile`
- `insight`

If no existing type fits, V3 can mark it as:

- `argument_map` with `templateStatus: "v3_candidate"`

## Current Research Assessment

The V3 launcher can currently design research direction, but it does not yet fully bind actual values into each slide.

Current working pieces:

- 3-query Serper topic research
- URL selection
- article body fetch
- Wiki side-story fetch
- source hints per slide data requirement

Missing next layer:

`slide.dataSlots[] -> researchTask -> valueCandidate -> sourceUrl -> confidence -> verified/binding`

## User's Important Clarification

The user asked whether the V3 launcher can include an AI like "Codex Mia" that thinks through the solution and research method.

Answer: yes. This should become the core of V3.

The next addition should be a `調査設計` layer/tab.

It should not just search broadly. It should reason:

- What has to be proven?
- What data would prove it?
- What is the most reliable source?
- What query should be used?
- How should extracted values be verified?
- What unsafe claims must be avoided?

Example for the Madrid/Spain topic:

- `2010年スペイン代表メンバー`
  - Source: Wikipedia / FIFA / worldfootball.net.
  - Need: player name + club at tournament.
  - Method: parse squad table and count Barcelona / Real Madrid players.

- `2026年または最新スペイン代表メンバー`
  - Source: RFEF official list or latest reliable news.
  - Need: player name + current club.
  - Method: fetch latest squad, then resolve each player's current club.

- `2010年のバルサ・レアル所属人数`
  - Source: squad table club column.
  - Do not research whole club rosters. Count clubs inside the national squad list.

- `現在のバルサ・レアル所属人数`
  - Source: latest squad list + current club data from SofaScore/FotMob/Transfermarkt/Wiki.
  - Need: count Barcelona and Real Madrid players in that specific squad.

Risk checks:

- Specify the exact squad/list date.
- Do not say "2010 was exactly half Barca and half Madrid" unless data supports it.
- Do not treat Pedri as a Barca academy product.
- Do not treat Raul as a bought gem.
- Do not conclude "Madrid failed at development" too strongly.

## Next Implementation Step

Add a new tab:

- `調査設計`

Suggested tabs after change:

- `ブリーフ`
- `論点`
- `beat`
- `スライド`
- `調査設計`

Suggested research design object:

```json
{
  "need": "2010年スペイン代表メンバーと所属クラブ",
  "method": "Wikipedia/FIFAの2010 squad表からclub列を抽出",
  "query": "2010 FIFA World Cup Spain squad club",
  "expectedOutput": "選手名、所属クラブ、バルサ人数、マドリー人数",
  "sourcePriority": ["Wikipedia", "FIFA", "worldfootball.net"],
  "risk": "2010年を半々と雑に言わない"
}
```

Implementation idea:

- In `v3_story_architect.js`, generate `researchDesign` from `slidePlan.dataSlots`.
- Add source-specific method rules:
  - historical squad table
  - latest squad news
  - current club resolver
  - cross-check task
- In `server.js`, add a `調査設計` tab rendering the plan in human-readable cards.

## Deploy Notes

Avoid broad git operations on VPS because the VPS worktree is dirty.

Safe deploy pattern:

```bash
tar -C /mnt/c/Users/USER/Documents/side_biz -cf /tmp/v3_launcher.tar \
  02_reddit_global/v3_launcher/README.md \
  02_reddit_global/v3_launcher/server.js \
  02_reddit_global/v3_launcher/v3_story_architect.js \
  02_reddit_global/v3_launcher/v3_research.js

scp -i /tmp/web_claude_vps -o BatchMode=yes /tmp/v3_launcher.tar root@37.60.224.54:/tmp/v3_launcher.tar

ssh -i /tmp/web_claude_vps -o BatchMode=yes root@37.60.224.54 \
'cd /root/sekai_no_wadai &&
 tar -xf /tmp/v3_launcher.tar &&
 cd 02_reddit_global &&
 node --check v3_launcher/server.js &&
 node --check v3_launcher/v3_story_architect.js &&
 pm2 restart soccer-yt-v3 --update-env &&
 sleep 1 &&
 curl -s http://127.0.0.1:3010/api/v3/health &&
 echo &&
 pm2 list | grep soccer-yt'
```

Do not restart `soccer-yt-v2` for V3 work.

---

## 2026-05-27 JST Update - V3 Human Pipeline UI

Today V3 was moved from a raw "show all thinking layers" prototype toward a human-facing production workflow.

Deployed URL:

`http://37.60.224.54:3010`

Deployed PM2 target:

- Restarted only `soccer-yt-v3`.
- Did not restart or edit `soccer-yt-v2`.

Changed local/VPS files:

- `v3_launcher/server.js`
- `v3_launcher/v3_story_architect.js`

Current V3 UI flow:

1. `案件`
2. `リサーチ`
3. `テーマ提案`
4. `ブリーフ`
5. `脚本構成`
6. `脚本`

Important UX clarification from user:

- The starting "案件" has only one of these source shapes:
  - Reddit thread title + comments
  - 5ch thread title + comments
  - custom free-text event/memo from the user
- At the案件 stage, do not assume structured research data already exists.
- The user wants the system to read a lot of news/data first, then show the trial result.

Current conceptual separation:

- `テーマ提案`
  - Choose the video angle/cut.
  - Show the hook question, tentative answer, and data expected for that cut.
  - This is not the full briefing.
- `ブリーフ`
  - After choosing the theme, summarize the whole video flow.
  - It should become the production instruction before script structure.
- `脚本構成`
  - Slide/order level outline.
- `脚本`
  - Draft narration generated from the current structure.

Current data objects added by `v3_story_architect.js`:

- `researchDesign`
  - Generated from `slidePlan.dataSlots`.
  - Contains task-level research methods, queries, expected output, source priority, verification, risk.
- `autopilotPlan`
  - Contains:
    - `themeProposal`
    - `briefing`
    - `scriptStructure`
    - `scriptDraft`
    - `mustCheck`
    - `publishGates`

Current research button behavior:

- `runResearch()` now attempts to run both:
  - `/api/v3/research/topic`
  - `/api/v3/research/wiki-side-stories`
- The UI can show read material counts:
  - selected Web article count
  - full text count
  - Wiki candidate count
  - article sample snippets

Important caveat:

- The UI file currently has some legacy duplicated render functions from iterative patching. Later definitions override earlier ones, so the page works, but a cleanup pass should remove old duplicate functions and mojibake text.
- The current implementation is still mostly heuristic. It does not yet truly bind extracted values into `valueCandidate/sourceUrl/confidence`.

## 2026-05-27 JST Second Update - AI Analysis Layer

Commit: `4d1c97e feat(v3): add AI analysis layer via DeepSeek`

New file: `v3_launcher/v3_planner.js`

- `generateAIPlan(topic, memo, researchCorpus, wikiStories)`
- Calls DeepSeek with the full research corpus (up to 6 articles × 1200 chars + 3 Wiki)
- Returns: themeProposal (2-3 candidates), briefing, scriptStructure, scriptDraft, missingData, publishGates

New endpoint: `POST /api/v3/analyze`

UI changes in `server.js`:
- `runResearch()` now auto-triggers `runAnalysis()` after Serper + Wiki fetch
- `runAnalysis()` calls `/api/v3/analyze`, merges result into `currentPlan.autopilotPlan`
- `buildMergedAutopilotPlan()` maps AI response shape to existing render function shape
- `renderThemeProposalView()` now shows 2-3 AI candidate cards with selected (green border) + reason + rejected reasons
- `renderResearchWorkflowView()` shows AI-identified missing data gaps
- Sidebar button row: 案件を整理 / リサーチ / AIで分析 / 保存

Current flow when user clicks "リサーチ":
1. Fetch Serper (3 queries)
2. Fetch Wiki side stories
3. Auto-call `/api/v3/analyze` with corpus
4. DeepSeek reads articles → generates theme candidates + briefing + script draft
5. テーマ提案 tab shows candidates

Next recommended implementation step:

1. Make案件 input explicit with a source type selector:
   - Reddit
   - 5ch
   - カスタム
2. Bind research values into data slots properly:
   - `slide.dataSlots[] -> valueCandidate -> sourceUrl -> confidence`
   - Currently AI generates narration with placeholder data markers; need a second pass to fill real values
3. "AIで再分析" button after editing topic/memo should re-run without re-fetching Serper (cache research)
4. Export the generated script draft to V2 pipeline (Step2 or new V3 handoff endpoint)

## 2026-05-27 JST Third Update - V3 Autopilot Handoff Start

Local change made in:

- `v3_launcher/server.js`

Added:

- 案件タイプ selector:
  - Reddit
  - 5ch
  - カスタム
- Direct `AIで分析` now reuses cached research if available; if no research exists, it starts the research flow first.
- After research, V3 now performs a first-pass candidate binding:
  - `researchDesign.tasks[] -> valueCandidate/sourceUrl/sourceTitle/confidence/status`
  - This is heuristic matching against fetched article corpus, not final verification.
  - UI shows up to 6 `仮バインド済みの確認候補` cards in theリサーチ tab.
- New endpoint:
  - `POST /api/v3/export-v2`
  - Converts V3 `autopilotPlan.scriptDraft` or fallback `slidePlan` into V2-shaped `modules.json`.
  - Appends a saved V2 project to `data/saved_projects.json`.
  - Writes minimal `data/si_data/{postId}.json`.
  - UI button: `V2へ渡す`.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_story_architect.js`
- `node --check v3_launcher/v3_planner.js`
- Temporary local V3 server health check passed on port 3005.

Deploy note:

- VPS deploy was not performed from this environment because `/tmp/web_claude_vps` was not present.
- When deploying, copy at least `v3_launcher/server.js` and restart only `soccer-yt-v3`.

## 2026-05-27 JST Fourth Update - V2 Video Quality First Pass

Local change made in:

- `scripts/v2_video/slides/_common.js`
- `scripts/v2_video/slides/universal.js`

Purpose:

- Start improving V2 video-generation quality while keeping V3/V2 pipeline contracts intact.

Added/fixed:

- Fixed a subtitle timing bug in `buildSubtitleBar()`:
  - `startSec` was documented and used downstream, but the item normalization step dropped it.
  - It is now preserved and used when timing chunked subtitles.
- Added optional global subtitle timing offset:
  - `SUBTITLE_SYNC_OFFSET_SEC`
  - Default remains `0`.
  - Use this for small global subtitle nudge tests without code edits.
- Improved subtitle entrance/exit:
  - Slight vertical movement + blur fade for chunk transitions.
  - More polished subtitle background gradient and shadow.
- Added global visual texture via `wrapHTML()`:
  - subtle vignette/light focus
  - very light scanline/ambient color movement
  - affects all V2 slide templates because every slide uses `wrapHTML()`.
- Improved fallback `universal` slide:
  - Ken Burns background movement.
  - badge/title/card staged entrances.

Verification:

- `node --check scripts/v2_video/slides/_common.js`
- `node --check scripts/v2_video/slides/universal.js`
- `node --check scripts/v2_video/render.js`

Next visual-quality steps:

1. Generate one short V2 video and check subtitle timing and whether ambient overlay is too visible.
2. If subtitles are consistently early/late, test `SUBTITLE_SYNC_OFFSET_SEC` in small increments such as `0.10`, `-0.10`, `0.20`.
3. Add or upgrade slide types after timing/design baseline is stable.

## 2026-05-27 JST Fifth Update - V2 Launcher Preview UX

Local change made in:

- `routes/step4_routes.js`

Added:

- Step4 slide preview controls:
  - `更新`
  - `別タブ`
- Step4 generated-video preview:
  - Latest generated video is embedded as a `<video controls>` player inside the launcher.
  - Existing file links remain below it.

Verification:

- `node --check routes/step4_routes.js`

## 2026-05-27 JST Sixth Update - V3 Step Workflow Split

Local change made in:

- `v3_launcher/server.js`

Reason:

- User reported `AI分析失敗`.
- The old UI mixed `案件整理 / リサーチ / AI分析` controls in one sidebar and auto-ran AI analysis after research.
- This made failures hard to understand because Step2 and Step3 were coupled.

Changed:

- V3 UI now has a V2-like step workflow:
  1. 案件
  2. リサーチ
  3. AI分析
  4. テーマ
  5. ブリーフ
  6. 構成
  7. 脚本
  8. V2
- Sidebar now renders a workflow step nav.
- Old mixed action row is hidden.
- Each result tab has its own task action.
- `runResearch()` no longer auto-triggers `runAnalysis()`.
- `runAnalysis()` now requires completed research and sends the user back to Step2 if missing.
- `/api/v3/analyze` now logs server-side errors to help debug actual AI failures.

Verification:

- `node --check v3_launcher/server.js`

## 2026-05-27 JST Seventh Update - V3 Proposal Step Consolidation

Local change made in:

- `v3_launcher/server.js`

Changed:

- Reduced visible V3 workflow from 8 steps to 6:
  1. 案件
  2. 企画提案
  3. 企画書
  4. 構成
  5. 脚本
  6. V2
- Combined old `リサーチ / AI分析 / テーマ` into new Step2 `企画提案`.
- Step2 button `企画提案を作る` now runs:
  - topic research
  - wiki side-story fetch
  - AI analysis
  - multi-theme proposal rendering
- Step2 theme cards now have `この案を採用` buttons.
- Step3 `企画書` is the briefing view based on the selected proposal.
- Top tabs are now the only visible workflow tabs.

Verification:

- `node --check v3_launcher/server.js`

## 2026-05-27 JST Eighth Update - V3 Launcher UI / Editing Workflow

Local changes made in:

- `v3_launcher/server.js`
- `handover.md`

Deployed to VPS:

- `soccer-yt-v3` on `http://37.60.224.54:3010`
- Current UI marker: `v3-ui-left-saved-sidebar`

Changed:

- Step tabs are now hard-separated:
  - The launcher renders only the active step body.
  - It no longer keeps all step panels on the page and hides them with CSS.
  - This was done because the user said case selection, thinking, and other work were visually crammed into one vertical page.
- Step1 `案件` was cleaned up:
  - It now focuses on case selection/input only.
  - The analysis/status cards were removed from Step1.
  - Case selection UI was restyled closer to V2 Step1:
    - date toolbar
    - `案件読込`
    - selected count
    - time-group accordions
    - Reddit / 5ch / custom source badges
    - checkbox rows
- Saved projects were moved into the left sidebar:
  - Desktop/tablet widths keep saved projects in the left sidebar.
  - Only narrow mobile widths allow the sidebar to stack above the main area.
  - Selected saved project is highlighted in the sidebar.
- Step3 `企画書` became editable:
  - The briefing is shown in a large textarea.
  - Added `企画書の内容で脚本構成`.
  - Edited briefing text is parsed back into the plan before moving to structure.
- Step4 `脚本構成` became a V2-like editor:
  - slide type selector
  - title editor
  - narration editor
  - data/source rows
  - image upload/gallery
  - inline slide preview using `/api/v2/preview-slide-inline`
- V3 mounts selected V2 routers so Step4 preview and image upload can reuse existing V2 behavior without editing V2.

Verification:

- `node --check v3_launcher/server.js`
- VPS `pm2 restart soccer-yt-v3 --update-env`
- VPS health check: `curl -s http://127.0.0.1:3010/api/v3/health`
- HTML marker checks for:
  - `v3-ui-left-saved-sidebar`
  - `saved-lead-item`
  - `time-group`
  - `src-badge`

Notes / next likely work:

- The user confirmed PC view now has saved projects in the left sidebar and the look is good.
- Keep V2 preserved unless explicitly asked.
- Next UI work should continue using strict tab separation: one step, one task surface.

## 2026-05-28 JST Update - V3 Step1/Step2 Research UX

Local changes made in:

- `v3_launcher/server.js`
- `v3_launcher/v3_research.js`
- `scripts/modules/fetchers/article_fetcher.js`
- `handover.md`

Deployed to VPS:

- `soccer-yt-v3` on `http://37.60.224.54:3010`
- Restarted only `soccer-yt-v3`.
- Did not edit or restart `soccer-yt-v2`.

Changed:

- Top workflow tabs now span the full screen width above the work area.
- Step1 is now only for case selection/saving:
  - Scheduled fetched candidates are grouped by time accordion.
  - Selected cases are saved into the left sidebar.
  - Left sidebar is visible only in Step1.
  - Step2 and later hide the sidebar and use full width.
- Step1 sidebar now has a `カスタム案件` form:
  - custom case title
  - short memo/overview
  - save into the saved-project sidebar
- Step2 now starts with:
  - selected case title/source/memo box
  - centered `調査` button
  - small flow text: `検索クエリ作成 → Webリサーチ → データ取得 → 企画書A/B/C生成`
- Step2 research results are now grouped as:
  1. `検索クエリ作成`
  2. `Webリサーチ`
  3. `関連人物・チーム候補 / 追加データ候補`
  4. `記事要約`
  5. `企画書A/B/C生成`
- Related-person/team candidates remain as compact chips because they can later become data-fetch labels.
- Removed misleading task cards such as `直近ニュース` / `関係者コメント`.
  - Those are now folded into `記事要約`.
- `記事要約` is not forced into one conclusion. It shows multiple lenses:
  - `出来事の概要`
  - `主な論点`
  - `裏話・人物`
  - `企画化の材料`
- `企画書A/B/C` is combined with theme proposals:
  - each paper shows angle, hook question, tentative answer, promise, structure, data needs, and cautions
  - if AI returns empty/malformed proposal candidates, display-side fallback candidates fill A/B/C so the cards are not blank
- Research progress now updates mid-run:
  - after Web research finishes, queries/articles/data candidates render before AI analysis completes
  - if AI analysis fails, research results remain visible and fallback proposal papers are shown
- Browser-side temporary state persistence was added:
  - `currentPlan`
  - `currentResearch`
  - `currentWikiStories`
  - `currentAIPlan`
  - `currentAcquiredData`
  - selected project and active step
  - This prevents small UI changes/reloads from immediately wiping the visible research result in the same browser.

Full-text retrieval improvements:

- `scripts/modules/fetchers/article_fetcher.js`
  - fetch timeout increased from 5s to 9s
  - max article text increased from 1500 chars to 4000 chars
  - direct fetch now normalizes article text more aggressively
  - Jina Reader fallback was added for direct-fetch failures
- `v3_launcher/v3_research.js`
  - per-article V3 corpus limit increased from 1800 chars to 3200 chars
  - pick max increased from 5 to 6
  - if too few full-text articles are obtained, V3 tries extra search candidates and appends useful full-text results
  - `full_text_reader` is treated as full text
- Query compaction was added in `server.js` before V3 research:
  - for the Curacao case, long Japanese case titles are converted to shorter English research phrases such as:
    - `Curacao national football team World Cup qualification`
    - `CONCACAF World Cup qualifying Curacao`
    - `Curacao population football World Cup smallest country`

Important caveats:

- Step2 still does not yet call the existing V2/V3 structured data fetch jobs for SofaScore / Transfermarkt / Wiki entity fetch.
- Current `関連人物・チーム候補 / 追加データ候補` is still candidate extraction from article text/Wiki side-story pass.
- The next real data-quality step should connect Step2 labels to existing `/api/v3/fetch-all` or related Step2 fetcher routes so selected people/teams can actually retrieve SofaScore, Transfermarkt, and Wiki structured data.
- Existing saved browser state can show old research output until the user reruns `調査`; this is intentional to prevent accidental data loss during UI tweaks.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- `node --check scripts/modules/fetchers/article_fetcher.js`
- VPS `pm2 restart soccer-yt-v3 --update-env`
- VPS health check: `curl -s http://127.0.0.1:3010/api/v3/health`
