# Codex Mia V3 Handover

Last updated: 2026-05-30 JST

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

## 2026-05-29 JST Update - V3 Autopilot Reliability Pass

Local changes made in:

- `v3_launcher/server.js`
- `v3_launcher/v3_research.js`
- `v3_launcher/v3_planner.js`

Focus requested by user for the next V3 work:

1. Are search queries appropriate, or too long to hit well?
2. Are SofaScore / Transfermarkt / Wiki fetches stable?
3. Are fetched data points being used enough in proposal papers?
4. When turning proposal paper into script structure, are slide type selection and data slot selection optimal?
5. Are there likely error points in the workflow?

Changed:

- Search query compaction was hardened.
  - V3 now strips URLs/brackets/noise, cuts long clauses, caps Latin queries to about 10 words, and caps Japanese fallback queries to 72 chars.
  - Duplicate queries after compaction are removed.
  - Known Madrid/Spain case still uses explicit English high-intent queries.
- Browser-side `compactSearchTopic()` was also strengthened before Step2 research.
  - If a mixed Japanese/English title contains Latin player/team names, those are preferred over a long Japanese sentence.
- `runResearch()` no longer crashes if the legacy `researchBtn` is absent from the current hard-separated UI.
- `/api/v3/auto-prefetch` now uses `Promise.allSettled`.
  - SofaScore and Transfermarkt run in parallel, but one side failing no longer kills the whole prefetch response.
  - Response includes warnings when either side fails.
- Step2 AI analysis memo enrichment was improved.
  - Successful structured data is passed as `[取得済みデータ（企画書・脚本構成で優先使用）]`.
  - Failed entity fetches are passed as `[取得失敗・未確認データ（断定禁止）]`.
- `v3_planner.js` prompt now explicitly tells DeepSeek:
  - Use acquired stats/profile/injury data in `dataNeeds` and `scriptDraft`.
  - Put failed/unconfirmed targets into `missingData` or `publishGates`.
  - Include at least one slide that uses acquired numeric data when available.
- Step4 script-structure conversion now chooses V2 slide type by role/headline/claim/data wording instead of defaulting to `stats` whenever data exists.
  - history/context -> `history`
  - contrast/comparison -> `comparison`
  - profile/person/player/club facts -> `profile`
  - stats/evidence/numbers/list -> `stats`
  - otherwise -> `insight`
- Resolved SofaScore/TM slots now include source entity name in the slot label, e.g. `João Pedro ゴール`, reducing ambiguity when multiple players are fetched.
- After VPS log review, JSON parsing and entity-noise guards were tightened:
  - `v3_research.js` now uses loose JSON extraction for DeepSeek query/entity expansion instead of failing on fenced or prefixed JSON.
  - V3 auto-prefetch filters obvious non-entity noise such as `Last`, `Injured`, `Official`, `Report`, `God`, `SNS`, `MVP`, `VAR`, `TV`.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- `node --check v3_launcher/v3_planner.js`
- Local query-selection smoke test for the Madrid/Spain case and a João Pedro mixed Japanese/English title.

Caveats / next recommended checks:

- This was a local reliability pass; VPS deploy was not performed.
- Network-backed real fetch stability still needs one live Step2 run on VPS or local with valid env.
- Next high-value check:
  - Run Step2 on 2 cases:
    1. Madrid/Spain squad-count case.
    2. A player-transfer/stats case such as João Pedro.
  - Confirm the proposal cards actually mention acquired stats and that Step4 creates appropriate `stats/profile/comparison/history` slides.

### 2026-05-29 JST Hotfix - V3 Blank UI / Browser Console

User reported the V3 site became unusable / "nothing can be grabbed".

Cause found:

- Browser-side inline JS had a syntax error generated from `compactSearchTopic()`.
- In `server.js`, client JS is embedded inside a template literal. Regex backslashes such as `\S` and `\s` must be double-escaped in the server source.
- The emitted HTML contained invalid JS:
  - `/https?://S+/g`
- This caused the whole client script to fail parsing.

Fix:

- Escaped the client-side regex correctly:
  - `https?:\\/\\/\\S+`
  - `\\s+`
- Redeployed `v3_launcher/server.js` to VPS.
- Restarted only `soccer-yt-v3`.

Verification:

- VPS `node --check v3_launcher/server.js`
- VPS `node --check v3_launcher/v3_research.js`
- VPS `node --check v3_launcher/v3_planner.js`
- VPS health check OK on port 3010.
- Fetched generated HTML from `http://127.0.0.1:3010/`, extracted inline `<script>`, and ran:
  - `node --check /tmp/v3_after_fix_0.js`
- Result: inline script syntax check passed.

## 2026-05-29 JST Update - V3 Background Proposal Jobs / Data Handoff Hardening

Local changes made in:

- `v3_launcher/server.js`
- `v3_launcher/v3_research.js`
- `v3_launcher/v3_planner.js`

User request:

- Reduce `企画提案失敗` and `データ取得失敗`.
- Make Step2 continue even if the browser is backgrounded.
- Improve selection of acquired data and handoff into slides.
- Do not damage non-data-related code.
- Use three review roles and repeat until reevaluation passes, max 5 loops.

Changed:

- Step2 `runProposal()` now starts a server-side job:
  - `POST /api/v3/proposal-job/start`
  - `GET /api/v3/proposal-job/:jobId`
- The browser now only starts and polls the job.
  - Web research, Wiki, SofaScore/TM, AI analysis, data selection, and saved-project progress updates run on the VPS Node process.
  - If the browser is backgrounded, the server job should continue.
- Server job saves progress to the selected saved project:
  - `researchData.plan`
  - `researchData.research`
  - `researchData.wikiStories`
  - `researchData.aiPlan`
  - `researchData.acquiredData`
  - `researchData.fetchedData`
  - `researchData.jobStatus`
- Wiki side-story fetch now catches `fetchWikipediaSafe()` per entity, so one Wiki miss no longer kills the full proposal flow.
- Auto-prefetch logic was extracted into `runAutoPrefetchCore()` and reused by both the old endpoint and the new background job.
- Entity safety fixes:
  - `守田` now maps to `Hidemasa Morita` instead of `Daichi Kamada`.
  - Managers are no longer treated as player stat targets.
  - Auto-prefetch only sends `player` / `team` entities to SofaScore/TM.
- Acquired data now has selection metadata:
  - `relevanceScore`
  - `selected`
  - `sourceTitle`
  - `sourceUrl`
  - `fetchedAt`
  - `confidence`
- `selectFetchedDataForPlan()` is stricter:
  - data must be `ok`
  - entity name must appear in the plan/research needs
  - score must pass threshold
- `v3_planner.js` prompt/schema now supports:
  - `scriptDraft[].selectedData`
- Server attaches selected data to script slides via `attachSelectedDataToPlan()`.
  - Final rule after reevaluation: no entity-name match, no automatic slide injection.
  - Generic stats/data wording alone is not enough.
- `makeModulesFromCurrentPlan()` now prioritizes `scriptDraft[].selectedData` for `dataSlots`.
  - Removed broad fallback injection of all successful fetched data.
  - Removed single-player unconditional fallback.

Three-role review loop:

1. 改善提案ミア:
   - Recommended server-side jobs, progress saving, and explicit `selectedData`.
2. エラーチェックミア:
   - Flagged Wiki per-entity failure, browser fetch chain, bad entity mapping, manager-as-player, and weak data assignment.
3. 再評価ミア:
   - Loop 1: failed because selected data was too broad.
   - Loop 2: failed because unselected ok data still had injection paths.
   - Loop 3: failed because semantic matching could still inject without name match.
   - Loop 4: failed because generic stats slide still accepted data.
   - Loop 5: passed after requiring entity-name match and removing broad fallback paths.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- `node --check v3_launcher/v3_planner.js`

Deploy note:

- Deploy only these V3 files and restart only `soccer-yt-v3`.

## 2026-05-29 JST Update - Separate Proposal / Structure / Script

Local changes made in:

- `v3_launcher/server.js`
- `v3_launcher/v3_planner.js`
- `handover.md`

User clarified the intended V3 flow:

`企画書 -> 脚本構成 -> 脚本生成`

Problem:

- Step2 proposal job was already asking the AI for `scriptStructure` and `scriptDraft`.
- That made the three-step workflow less meaningful because Step2 had already drafted the full script and data handoff.

Changed:

- `v3_planner.js`
  - Step2 prompt now stops at:
    - `themeProposal`
    - `briefing`
    - `missingData`
    - `publishGates`
  - It explicitly tells AI not to write script structure or narration at the proposal stage.
  - Returned `scriptStructure` and `scriptDraft` are forced to `[]` for Step2.
- `server.js`
  - `mergeAutopilotPlanServer()` and browser `buildMergedAutopilotPlan()` no longer import AI `scriptStructure` / `scriptDraft` from Step2.
- Step4 `企画書の内容で脚本生成` now builds V3 modules internally from the editable briefing.
- Visible standalone `構成` tab was removed.
  - The structure editor code remains as an internal/backward-compatible helper, but normal flow does not expose it.
- Step5 now has `脚本生成`.
  - It generates narration from the finalized Step4企画書 slide outline and selected data.
  - `autopilotPlan.scriptDraft` is created only here.
- Step5 also supports regeneration after Step4企画書 edits.

Current intended flow:

1. Step3 `企画提案`
   - research and proposal papers only.
2. Step4 `企画書`
   - human-editable production brief with theme, flow, core message, slide outline, slide type, and data plan.
3. Step5 `脚本生成`
   - narration draft generation.
4. Step6 `V2`
   - handoff to V2 modules.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_planner.js`
- `node --check v3_launcher/v3_research.js`

### Follow-up - Move Preview to Step5 Script

User clarified that preview belongs with the script stage, not the structure stage.

Changed:

- Step4 `構成`
  - Removed inline slide preview iframe.
  - Removed preview auto-refresh from structure edits.
  - This step now focuses on slide type, title, point/script direction, data slots, source, and images.
- Step5 `脚本`
  - Added slide tabs and inline slide preview next to generated narration.
  - Preview refresh runs when Step5 is active.
  - Structure edits can still generate/re-generate script, then Step5 shows narration + actual slide view together.

Verification:

- `node --check v3_launcher/server.js`

### Follow-up - Make Briefing Paper Explicit

User clarified that the difference between `企画書` and `脚本構成` was becoming unclear.

Changed:

- Step3 `企画書` textarea now explicitly includes:
  - `動画のテーマ`
  - `動画の約束`
  - `中心メッセージ`
  - `全体の流れ`
  - `スライド構成`
    - headline
    - summary/point
    - slide type
    - data type / needed data
  - `使うデータ`
  - `脚本指示`
  - `注意点`
- `脚本指示` is editable by the user.
  - Default instruction preserves consistency with the adopted proposal and warns against unsupported claims.
- Step5 `脚本生成` now prioritizes `briefing.slideOutline` parsed from the Step4 paper.
  - This keeps script generation aligned with the adopted Step2 proposal while still letting the user add production instructions.
- Purpose:
  - Step3 is now the production paper with a proposed slide outline.
  - The former visible structure step is now internal; the user-facing path goes from企画書 directly to脚本生成.

### Follow-up - Remove Visible Structure Step

User asked whether Step5 `構成` can be removed now that `企画書` includes the slide outline.

Changed:

- Top tabs are now:
  - `1 案件取得`
  - `2 保存済み`
  - `3 企画提案`
  - `4 企画書`
  - `5 脚本生成`
  - `6 V2`
- `企画書の内容で脚本生成` now:
  - parses the editable企画書
  - builds internal V3 modules from `スライド構成`
  - creates `scriptStructure` internally
  - immediately generates `scriptDraft`
- Step5 script view returns to `企画書`, not `構成`.
- `collectV3SlideInputs()` now no-ops when the hidden/internal structure editor is not mounted, preventing title/data loss during direct企画書 -> 脚本生成.

### Follow-up - Backfill Existing Briefing Text

User found existing Neymar / João Pedro saved cases did not show `スライド構成案` in the企画書.

Cause:

- Existing saved cases can have old `briefing.rawText`.
- `formatBriefingText()` returned that raw text as-is, so new sections added later were not visible unless the case was re-researched.

Changed:

- Existing raw企画書 text is preserved.
- If old raw text is missing new sections, V3 appends generated sections for:
  - `動画のテーマ`
  - `スライド構成`
  - `脚本指示`
- This lets existing saved cases show the new企画書 structure after page reload/open, without pressing再調査.

## 2026-05-30 JST Update - V3 Recipe Launcher Added

User and Mia pivoted from free-form AI slide composition to fixed editable slide recipes.

User-provided initial player recipe ideas:

- 今期成績
- 前期成績
- キャリアハイ成績
- 市場価格推移
- 代表通算成績
- クラブ通算成績
- 全クラブ通算成績
- 比較-今季VS前期
- 比較-今季VSキャリアハイ

Implemented:

- New standalone V3 recipe page:
  - `http://37.60.224.54:3010/recipes`
  - Local route: `GET /recipes`
- New APIs:
  - `GET /api/v3/recipe-slot-options`
  - `GET /api/v3/recipes`
  - `POST /api/v3/recipes`
- New local/VPS save target:
  - `v3_launcher/data/slide_recipes.json`
  - This file is generated by the UI when the user clicks save. It is not required to exist in git.
- V3 header now has a `Recipe Launcher` link.
- Recipe table fields:
  - category
  - recipe id
  - title
  - slide type
  - data slot 1-8
  - note
  - priority
  - status
- Data slot dropdown options are restricted to fields that should be obtainable from:
  - SofaScore
  - Transfermarkt
  - Wiki
- Initial default recipes are seeded from the user's 9 player recipe ideas.

Deploy:

- Commit: `af57dc3 Add V3 recipe launcher page`
- Pushed to GitHub `main`.
- VPS pull/restart completed.
- Restarted only `soccer-yt-v3`.

Verification:

- `node --check v3_launcher/server.js`
- Local HTTP checks:
  - `/recipes` rendered
  - `/api/v3/recipes` returned 9 defaults
  - `/api/v3/recipe-slot-options` returned 49 options
  - save API can write a test JSON when filesystem permission allows
- VPS checks:
  - `curl http://127.0.0.1:3010/api/v3/health`
  - `/api/v3/recipes` includes `PLAYER_SEASON_CURRENT`
  - `/recipes` includes Recipe page markup
  - `pm2 list` shows `soccer-yt-v3` online

Important next-session instruction:

- The user is going to edit recipes in the recipe launcher.
- Do not continue recipe integration until the user says they are done editing the recipe launcher.
- When the user says they are done, resume from:
  1. Read `v3_launcher/data/slide_recipes.json` from the VPS or local if available.
  2. Validate/normalize recipes and data slots.
  3. Integrate recipes into the V3 Step4/Step5 flow so slide building chooses from the user's recipe definitions instead of broad AI free composition.
  4. Make sure generated slides follow the recipe title/slide type/data slots exactly.
  5. Re-test with a real case and verify data is flowing only into appropriate slide types.

### Follow-up - Mobile Recipe Launcher UX

User said the first table version was hard to use on mobile and did not want horizontal scrolling.

Changed locally after the first recipe launcher deploy:

- `/recipes` no longer uses a wide table.
- The page now has:
  - `新規作成`
  - saved recipe card list
  - single-recipe vertical editor
  - category buttons at the top (`選手`, `チーム`, `監督`, `試合`, `移籍`)
  - title field under category
  - slide type field
  - data slots 1-8 as vertical dropdown rows
  - recipe id / priority / status / note below
- Initial default saved recipes were expanded from 9 player-only recipes to 33 starter recipes:
  - player
  - team
  - manager
  - match
  - transfer
- The page still saves all recipes through `POST /api/v3/recipes`.
- If `v3_launcher/data/slide_recipes.json` exists on VPS, it takes priority over the built-in defaults.

## 2026-05-30 JST Update - Step2 Research Flow Clarified

User requested Step2 to become an explicit five-stage pipeline:

1. Step2-1:
   - Pressing `調査` first creates search query labels from the case title.
   - Example: `ジョアン・ペドロ、負傷したネイマールに変わりブラジル代表選出か`
   - Desired labels: `ジョアン・ペドロ`, `ネイマール`, `ブラジル代表`
   - The UI should show these labels as chips.
2. Step2-2:
   - Show hit article title, URL, site name, and whether it was full text or snippet.
3. Step2-3:
   - After reading articles, propose labels/entities that seem central to the story.
   - Example: Neymar, Joao Pedro, Ancelotti, Brazil, Santos FC, Chelsea FC, Estevao, Endrick.
4. Step2-4:
   - For those labels, fetch data from sources that do not consume Serper tokens:
     - SofaScore
     - Transfermarkt
     - Wikipedia
5. Step2-5:
   - Generate proposal papers A/B/C from the article and data results.

Implemented locally:

- `v3_research.js`
  - Added `generateSearchPlan(topic, memo)`.
  - It returns:
    - `queryLabels`
    - targeted `queries`
  - `runTopicResearch()` now includes `queryLabels` in the research result.
- `server.js`
  - Proposal job stages now use:
    - `Step2-1 検索クエリ作成中...`
    - `Step2-2 ニュース記事取得中...`
    - `Step2-3 本筋ラベル作成中...`
    - `Step2-4 SofaScore / Transfermarkt / Wiki データ取得中...`
    - `Step2-5 取得結果から企画書A/B/C作成中...`
  - `research.labelCandidates` is saved from AI entity expansion.
  - Step2 display now has explicit sections:
    - Step2-1 query labels and search queries
    - Step2-2 article hits
    - Step2-3 central label candidates
    - Step2-4 free data results
    - Step2-5 proposal source material
  - Proposal job no longer runs extra follow-up Serper queries after Step2-2; Step2-4 is kept to non-Serper data fetching.

Verification:

- `node --check v3_launcher/server.js`
- `node --check v3_launcher/v3_research.js`
- Local V3 health check on temporary port passed.
- Local HTML contains Step2-1 through Step2-5 labels.
