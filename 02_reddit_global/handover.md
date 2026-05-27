# Codex Mia V3 Handover

Last updated: 2026-05-27 JST

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

- `ブリーフ`
- `論点`
- `beat`
- `スライド`

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
