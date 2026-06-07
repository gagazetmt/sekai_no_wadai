# Soccer YouTube Launcher Architecture

Last updated: 2026-06-07 JST

## Purpose

This is the durable architecture record for the active soccer YouTube launcher. Use `02_reddit_global/handover.md` for recent work details and this file for the current end-to-end system.

## Active Product

- Active launcher: V2.5, built on the V2 launcher.
- Production app: PM2 `soccer-yt-v2`.
- Production directory: `/root/sekai_no_wadai/02_reddit_global`.
- Production port: `3004`.
- V3 on port `3010` is not the main product.
- Architectural rule: keep V2 as the mothership and graft in only the V3 components that are demonstrably stronger.

## End-To-End Ownership

1. Step1, case selection: V2.
2. Step2, search queries, story-cast labels, article and structured-data acquisition: V2.
3. Step3, proposal A/B/C: V3 AI working from V2-acquired evidence.
4. Structure conversion and validation: V2-compatible modules, validated against V2 SI bindings.
5. Script generation and editing: V2.
6. Image acquisition: V3 named/official-X fetcher plus local stock libraries.
7. Step5 thumbnail generation: V2 UI with Gemini Vision and Gemini image generation.
8. Video generation: V2.
9. Step6 metadata and YouTube upload: V2.

## Main Data Contracts

- Selected cases: `data/saved_projects.json`.
- Structured information: `data/si_data/{sanitizedPostId}.json`.
- V2.5 proposal/research record: `data/v25_plans/{sanitizedPostId}.json`.
- Final slide/script modules: `data/{sanitizedPostId}_modules.json`.
- Step5/Step6 shared metadata: `data/{sanitizedPostId}_step5.json`.
- Thumbnail outputs: `data/v2_thumbs/{thumbPostId}/`.
- Video outputs: `data/v2_videos/`.
- Official player stock index: `data/players_official_index.json`.
- Stock assets: `images_stock/`.

## Step2 Research

- V2 owns entity suggestion and all data acquisition.
- Labels should describe the story cast: players, managers, clubs, national teams, tournaments, and stadiums.
- Reject sentence fragments, vague concepts, source names, and unrelated names.
- Structured data is authoritative. Do not rely on model memory for stats, roles, or comparison targets.
- V2.5 builds its research corpus from the selected case, Reddit body/comments, search results, retrieved articles, and curated sources.

## Step3 Planning

- V3 AI proposes editorial plans A/B/C from the V2 evidence corpus.
- The selected plan is converted into V2-compatible modules.
- `comparison`, `stats`, `profile`, and `matchcard` modules must resolve to real V2 SI bindings.
- Invalid comparisons are demoted to `insight`, not invented.
- Proposal/debug state is stored under `data/v25_plans/`.

## Script And Editing

- V2 owns script generation because its narration and editor remain stronger than the old V3 end-to-end flow.
- The opening module is the primary source for the video hook, thumbnail wording, and Step6 metadata.
- Keep slide text, narration, data binding, and image assignment editable.
- Known issue: subtitle-bar timing can drift from narration timing.

## Image Acquisition

- Use the V3 image fetcher for named people and official-X acquisition.
- The candidate pool can contain:
  - case/X images
  - Wikipedia or other acquired references
  - official league/player stock
  - other local stock
- Official player and league images must remain eligible for Step5 face scoring.
- Prefer images with a large clear face, usable expression, sharpness, low obstruction, and low watermark risk.

## Step5 Thumbnail Pipeline

### Automatic Brief

- Route: `POST /api/v5/suggest-bg-prompts`.
- Model: direct `gemini-2.5-flash` through `scripts/ai_client.js`.
- JSON mode and zero thinking budget are used for reliable structured output.
- Inputs:
  - opening and script modules
  - module outline
  - V2.5 briefing
  - V2.5 entities
  - retrieved article titles and snippets
- Outputs:
  - `ctx`
  - `badge`
  - `main`
  - `punch`
  - four scene candidates
  - editorial reason
- The UI auto-fills these fields when Step5 opens. `AI再提案` runs it again.

### Face Selection

- Route: `POST /api/v5/face-score`.
- Gemini Vision scores acquired images and stock images.
- Official league/player stock is included and prioritized.
- The selected face is reference image one. Up to three top references are supplied to generation.

### Finished Thumbnail Generation

- Route: `POST /api/v5/gen-bg-from-face`.
- Model: OpenRouter `google/gemini-3.1-flash-image-preview`.
- Output: two 16:9 PNG finished thumbnails with Japanese text.
- A layout: subject large on right, strong text area on left.
- B layout: diagonal opposition composition with club/stadium visual language.
- Calls run sequentially and retry up to three times because OpenRouter can return HTTP 200 with no image.
- Typical measured cost: about USD 0.068 per image, USD 0.136 or JPY 20-21 for A/B.

### Editorial Safety

- Image generation must stay grounded in the retrieved case.
- Unconfirmed transfers use symbolic editorial collages.
- Do not invent signing, travel, unveiling, shirt changes, or meetings.
- Generated Japanese may still be imperfect. The SVG compositor remains the correction fallback.

### Selection

- Clicking an A/B result marks it as the finished thumbnail.
- `/api/v5/select-thumb` stores the filename in shared Step5 metadata.
- Step6 loads this selected thumbnail for upload.

## Step6 Metadata And Upload

- Route: `POST /api/v6/gen-meta`.
- The AI reads the opening and module narration.
- It proposes:
  - three YouTube title candidates
  - description
  - 10-15 tags
- Current UI requires pressing `AI 自動生成`; it is not automatically run on Step6 entry.
- Normal mode uses Sonnet with DeepSeek fallback. Sprint mode uses DeepSeek.
- Metadata is saved through `/api/v6/save-meta`.
- YouTube upload uses `/api/v6/youtube-upload` and the selected video/thumbnail.

## Provider Decisions

- Thumbnail brief: Gemini 2.5 Flash direct API.
- Finished thumbnail images: Gemini 3.1 Flash Image through OpenRouter.
- Vertex Imagen remains available for experiments but is not the selected Step5 production path.
- Direct Gemini image calls may reject or return empty data for real-person edits; OpenRouter currently performs better in this workflow.
- Keep provider choice isolated in route/helper functions so it can be replaced after a measured comparison.

## Operational Rules

- Deploy only scoped files.
- Run `node --check` before restart.
- Restart only `soccer-yt-v2` for V2.5 changes.
- Verify PM2 status and route output before committing.
- Commit only the intended tracked files; production contains many generated and untracked assets.
- Never force-push.

## Key Files

- `02_reddit_global/local_v2_launcher.js`
- `02_reddit_global/routes/v25_autopilot_routes.js`
- `02_reddit_global/routes/step2_routes.js`
- `02_reddit_global/routes/step3_routes.js`
- `02_reddit_global/routes/step4_routes.js`
- `02_reddit_global/routes/step5_routes.js`
- `02_reddit_global/routes/step6_routes.js`
- `02_reddit_global/scripts/ai_client.js`
- `02_reddit_global/scripts/modules/stock_match.js`
- `02_reddit_global/scripts/v2_video/thumb_compositor.js`
- `02_reddit_global/handover.md`
