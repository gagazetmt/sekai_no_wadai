# Claude Handover - V2.5 Pivot / Soccer YouTube Launcher

Last updated: 2026-06-03 JST

## Current Product Decision

Do not continue trying to make V3 the main launcher.

The correct direction is now **V2.5**:

- V2 remains the mothership.
- V3 contributes only the parts where it is clearly stronger.
- The user explicitly wants this split:
  - Step1 case selection: V2
  - Step2-1 to Step2-4 search query / labels / data acquisition: V2
  - Step3 proposal A/B/C: V3 AI, based on information acquired by V2 Step2
  - Script structure: V2-compatible structure derived from the selected V3 proposal, with real V2 SI data validation
  - Script generation: V2
  - Editing: V2
  - Image acquisition: V3 image fetcher, including named/official-X logic and improved image selection
  - Video generation: V2
- Known continuing issue: subtitle bar timing can drift from narration timing. Keep this as a separate Step6/video-generation follow-up.

## Why This Pivot Happened

V3 full autopilot produced several quality failures:

- Search/label precision was worse than V2 in real football cases.
- It allowed irrelevant labels, including non-football/F1 style noise.
- It produced a bad comparison involving a mysterious "35-year-old Alonso" instead of staying grounded in fetched data.
- Narration was flatter than V2.
- Editing freedom in V3 was weaker than V2.

The user judged that V2 was smarter in too many key steps. Therefore the implementation should preserve V2 intelligence and only graft V3 automation/image strengths into it.

## Implemented By Mia

Files changed locally and deployed to VPS:

- `local_v2_launcher.js`
  - Added API mount for V2.5 route.
  - Added header button: `V2.5 AUTO`.
  - Added browser-side job runner for `/api/v25/autopilot/start` and `/api/v25/autopilot/status`.

- `routes/v25_autopilot_routes.js`
  - New route file.
  - Main endpoint: `POST /api/v25/autopilot/start`
  - Status endpoint: `GET /api/v25/autopilot/status?jobId=...`
  - Plan read endpoint: `GET /api/v25/plan?postId=...`

- `routes/step2_routes.js`
  - Exported `_runSuggestLabels` and `_runFetchAll` so V2.5 can reuse V2 Step2 internals.

- `routes/step3_routes.js`
  - Exported `_runProposeModules` and `_runScenarioJob` for future reuse.

- `handover.md`
  - Added the V2.5 pivot record and verification notes.

## V2.5 Job Flow

`routes/v25_autopilot_routes.js` currently does this:

1. Reads the selected project from `data/saved_projects.json`.
2. Normalizes the project into the post shape expected by V2 Step2.
3. Runs V2 label suggestion via `_runSuggestLabels`.
4. Filters obvious junk:
   - Reddit sentence fragments
   - vague long phrases
   - contextual Alonso noise such as Fernando/Marcos Alonso unless explicitly present in the case context
5. Runs V2 data acquisition via `_runFetchAll`.
6. Builds a research corpus from:
   - saved project body/comments
   - V2 search results
   - curated articles if present
7. Runs V3 proposal generation via `generateAIPlan`.
8. Converts the selected V3 proposal into V2-compatible modules.
9. Validates modules against V2 SI data via `getBindingMeta`.
10. Demotes invalid `comparison`, `stats`, `profile`, or `matchcard` modules to `insight` instead of allowing hallucinated data binding.
11. Attaches images using V3 `fetchAndAssignSlideImages`.
12. Saves:
    - Proposal/debug record: `data/v25_plans/{postId}.json`
    - Final modules: `data/{postId}_modules.json`

## Important Guardrails

Do not reintroduce V3 as the main end-to-end launcher unless the user explicitly reverses the decision.

Do not replace V2 Step2 label logic with V3 label logic.

Do not let AI choose comparison targets unless both sides exist in fetched V2 SI data and share the same role:

- player vs player
- manager vs manager
- team vs team

If a comparison cannot be validated with `getBindingMeta`, demote it to `insight`.

Do not rely on model memory for players/managers/clubs. Use fetched SI data as the authority.

Image acquisition should use V3 image fetcher because Claude-side image pipeline work is considered completed by the user. See `IMAGE_PIPELINE_REPORT.md`.

## VPS Deployment Status

Deployed to:

`/root/sekai_no_wadai/02_reddit_global`

PM2 app restarted:

`pm2 restart soccer-yt-v2`

Verification already done:

- `node --check local_v2_launcher.js`
- `node --check routes/v25_autopilot_routes.js`
- `GET http://127.0.0.1:3004/` returned 200 and contains `V2.5 AUTO`
- `GET /api/v25/plan?postId=__missing__` returned JSON with `plan not found`

Public/user-facing V2 URL is expected to be:

`http://37.60.224.54:3004/`

V3 remains on port 3010 but is no longer the target for this pivot.

## Next Tasks For Claude

1. Run a real case through `V2.5 AUTO` from the V2 UI.
2. Inspect `data/v25_plans/{postId}.json` and `data/{postId}_modules.json`.
3. Confirm the A/B/C proposal quality is better than the old V3 end-to-end output.
4. Confirm invalid comparisons are demoted and no mystery entities appear.
5. Confirm V3 image candidates/images are attached to V2 modules and visible in V2 editing.
6. If the user wants more control, add a compact A/B/C proposal selection panel before modules are finalized.
7. Keep subtitle bar / narration timing drift as a separate video-generation issue.

## Current Known Limitation

The current `V2.5 AUTO` implementation auto-selects the V3 plan's selected candidate. It does not yet expose an explicit A/B/C selection UI inside V2.

If the user wants manual choice, add a review panel that loads `/api/v25/plan?postId=...`, displays the three candidates, and lets the user regenerate/save modules from candidate A/B/C.

## Files To Inspect First

- `routes/v25_autopilot_routes.js`
- `local_v2_launcher.js`
- `routes/step2_routes.js`
- `routes/step3_routes.js`
- `IMAGE_PIPELINE_REPORT.md`
- `handover.md`

## Tone / User Preference

The user wants practical, direct implementation. They have explicitly given broad approval to move fast.

However, avoid broad rewrites. Preserve V2 behavior unless a specific bridge to V3 assets is needed.

The user calls the assistant ミア and expects warm, direct Japanese communication.
