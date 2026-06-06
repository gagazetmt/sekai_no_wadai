// routes/step5_routes.js
// ═══════════════════════════════════════════════════════════
// Step5: サムネイル AI 生成（2026-05-10 全面リニューアル）
//   - 🤖 AI生成タブ: リネカ題材分類 + DeepSeek プロンプト + Imagen 4 で5枚生成
//   - 🎨 サムネエディタータブ: 既存 /v2_thumbs/_editor/ を iframe 埋込（保険）
//
// 旧 Step5 の動画投稿系（メタ・YouTube 投稿）は step6_routes.js に分離。
// 旧 A/D/L/N/O HTML テンプレ UI は廃止（コードは scripts/v2_thumb/templates/ に温存）。
//
// データファイル:
//   - data/v2_thumbs/{postId}/imagen4_*.png : 生成サムネ
//   - data/{postId}_step5.json              : 選択したサムネを selectedThumb に記録
// ═══════════════════════════════════════════════════════════

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const router     = express.Router();
const costTracker = require('../scripts/cost_tracker');

const ROOT_DIR        = path.join(__dirname, '..');
const THUMB_OUT_BASE  = path.join(ROOT_DIR, 'data', 'v2_thumbs');
// 2026-05-16: postId に '/' 等を含む Reddit 形式に対応するため、 step4 modulesPath と同様にサニタイズ
//   未サニタイズだと '/r/soccer/comments/.../' でパスが壊れて 404
const _sanitizePostId = (s) => (s || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
const _thumbPostId = (s) => String(s || '_unsorted').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const META_FILE       = (postId) => path.join(ROOT_DIR, 'data', _sanitizePostId(postId) + '_step5.json');
const SI_DATA_FILE    = (postId) => path.join(ROOT_DIR, 'data', 'si_data', _sanitizePostId(postId) + '.json');
const MODULES_FILE    = (postId) => path.join(ROOT_DIR, 'data', _sanitizePostId(postId) + '_modules.json');

const thumbAi = require('../scripts/v2_video/thumb_ai');

// ─── 共通: メタ JSON 読み書き（step6 と共用）─────
function readMeta(postId) {
  const file = META_FILE(postId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return {}; }
}
function writeMeta(postId, obj) {
  fs.writeFileSync(META_FILE(postId), JSON.stringify(obj, null, 2));
}

// ─── 案件情報のサーバ側収集 ────────────────────
function _collectPostInfo(postId, override = {}) {
  const info = {
    title: override.title || '',
    entities: override.entities || [],
    summary: override.summary || '',
  };

  // si_data からエンティティ抽出
  if (!info.entities.length) {
    const sf = SI_DATA_FILE(postId);
    if (fs.existsSync(sf)) {
      try {
        const data = JSON.parse(fs.readFileSync(sf, 'utf8'));
        info.entities = Object.keys(data);
      } catch (_) {}
    }
  }

  // modules.json から動画タイトル＆ナレ要約抽出
  if (!info.title || !info.summary) {
    const mf = MODULES_FILE(postId);
    if (fs.existsSync(mf)) {
      try {
        const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const mods = Array.isArray(m) ? m : m.modules || [];
        if (!info.title && mods[0] && mods[0].title) info.title = mods[0].title;
        if (!info.summary) {
          info.summary = mods.map(x => `[${x.type}] ${x.title || ''}`).join(' / ').slice(0, 600);
        }
      } catch (_) {}
    }
  }
  return info;
}

// ════════════════════════════════════════════════════════════
// 🤖 AI 生成系 API
// ════════════════════════════════════════════════════════════

// 題材タイプを自動分類
router.post('/v5/classify-theme', async (req, res) => {
  const { postId, title, entities, summary } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  try {
    const info = _collectPostInfo(postId, { title, entities, summary });
    const result = await thumbAi.classifyTheme(info);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// オープニングスライドから topText / bottomText を抽出
router.post('/v5/extract-thumb-text', async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const mFile = MODULES_FILE(postId);
  if (!fs.existsSync(mFile)) return res.status(404).json({ error: 'modules.json not found' });
  let modules;
  try { modules = JSON.parse(fs.readFileSync(mFile, 'utf8')); }
  catch (_) { return res.status(500).json({ error: 'modules.json parse error' }); }
  const mods = Array.isArray(modules) ? modules : modules.modules || [];
  const opening = mods.find(m => m.type === 'opening' || m.mainKey === 'opening');
  if (!opening) return res.status(404).json({ error: 'opening モジュールが見つからない' });
  try {
    const result = await thumbAi.extractThumbText({
      openingTitle: opening.title || '',
      openingNarration: opening.narration || '',
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// リネカ + DeepSeek で Imagen 4 用英語プロンプト生成
router.post('/v5/suggest-thumb-prompt', async (req, res) => {
  const { postId, theme, topText, bottomText, title, entities, summary } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  try {
    const info = _collectPostInfo(postId, { title, entities, summary });
    info.topText = topText || '';
    info.bottomText = bottomText || '';
    const prompt = await thumbAi.buildPrompt(info, theme || 'default');
    res.json({ ok: true, prompt, theme: theme || 'default' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Imagen 4 で N 枚生成
router.post('/v5/generate-thumb', async (req, res) => {
  const { postId, prompt, count, provider, aspectRatio } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const safePostId = _thumbPostId(postId);
    const outputDir = path.join(THUMB_OUT_BASE, safePostId);
    const results = await thumbAi.generateThumb({
      provider:    provider    || 'imagen4',
      prompt,
      count:       count       || 5,
      aspectRatio: aspectRatio || '16:9',
      outputDir,
    });
    res.json({
      ok: true,
      thumbs: results.map(r => ({
        file: r.file,
        url: `/v2_thumbs/${safePostId}/${r.file}`,
        provider: r.provider,
        model: r.model,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Gemini Vision でサムネ2枚を比較し、より良い方を自動選定 ───
async function _geminiSelectBestThumb(results, outputDir) {
  if (results.length <= 1) return results[0] || null;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return results[0];
  try {
    const parts = [
      { text: 'You are evaluating YouTube thumbnails for a Japanese soccer channel. Which thumbnail (0 or 1) would get more clicks? Consider eye-catching visuals, clear subject, and impact. Return JSON only: {"winner": 0}' },
    ];
    for (let i = 0; i < Math.min(results.length, 2); i++) {
      const imgPath = path.join(outputDir, results[i].file);
      if (!fs.existsSync(imgPath)) continue;
      const base64 = fs.readFileSync(imgPath).toString('base64');
      if (i > 0) parts.push({ text: `Image ${i}:` });
      parts.push({ inline_data: { mime_type: 'image/png', data: base64 } });
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const r = await axios.post(url, {
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 20000 });
    const usage = r.data?.usageMetadata || {};
    costTracker.record({ label: 'thumb_auto_select', provider: 'gemini',
      inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 });
    const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    const winner = m ? (JSON.parse(m[0]).winner || 0) : 0;
    return results[winner] || results[0];
  } catch (e) {
    console.warn('[auto-thumb/gemini-select]', e.message);
    return results[0];
  }
}

// 全自動サムネ生成: classify → extract text → build prompt → generate × 2 → Gemini 選定 → 保存
// Body: { postId, briefing? }   Cost 目安: ¥12〜13（Imagen4 × 2 枚 + Gemini Vision）
router.post('/v5/auto-thumb', async (req, res) => {
  const { postId, briefing } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  try {
    const t0 = Date.now();
    const safePostId = _thumbPostId(postId);
    const outputDir  = path.join(THUMB_OUT_BASE, safePostId);
    fs.mkdirSync(outputDir, { recursive: true });

    // ① テーマ分類（briefing の angle / storyPattern を summary に付加）
    const info = _collectPostInfo(postId, {});
    if (briefing) {
      info.summary = [
        briefing.angle        ? `切り口: ${briefing.angle}`          : '',
        briefing.storyPattern ? `ストーリー: ${briefing.storyPattern}` : '',
        briefing.answer       ? `結論: ${briefing.answer}`            : '',
      ].filter(Boolean).join('\n');
    }
    const { theme } = await thumbAi.classifyTheme(info);

    // ② サムネテキスト抽出（briefing.hookQuestion → topText、answer → bottomText）
    const openingTitle = briefing?.hookQuestion || info.title || '';
    const openingNarration = briefing?.answer || briefing?.angle || '';
    const { topText, bottomText } = await thumbAi.extractThumbText({ openingTitle, openingNarration });

    // ③ Imagen 4 プロンプト生成
    info.topText = topText;
    info.bottomText = bottomText;
    const prompt = await thumbAi.buildPrompt(info, theme);

    // ④ Imagen 4 で 2 枚生成
    const results = await thumbAi.generateThumb({
      provider: 'imagen4', prompt, count: 2, aspectRatio: '16:9', outputDir,
    });
    if (!results.length) throw new Error('Imagen 4 生成失敗: 0枚');

    // ⑤ Gemini Vision で自動選定
    const selected = await _geminiSelectBestThumb(results, outputDir);

    // ⑥ meta に保存（Step6 で使用）
    const meta = readMeta(postId);
    meta.selectedThumb    = selected.file;
    meta.selectedThumbAt  = new Date().toISOString();
    meta.autoThumbTheme   = theme;
    meta.autoThumbTopText = topText;
    meta.autoThumbBotText = bottomText;
    writeMeta(postId, meta);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[auto-thumb] ${postId.slice(-20)} theme:${theme} top:"${topText}" bot:"${bottomText}" selected:${selected.file} (${elapsed}s)`);
    res.json({
      ok: true, theme, topText, bottomText, prompt,
      selected: { file: selected.file, url: `/v2_thumbs/${safePostId}/${selected.file}` },
      all: results.map(r => ({ file: r.file, url: `/v2_thumbs/${safePostId}/${r.file}` })),
      elapsedSec: parseFloat(elapsed),
    });
  } catch (e) {
    console.error('[auto-thumb]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 選択したサムネを meta に記録（Step6 から参照）
router.post('/v5/select-thumb', (req, res) => {
  const { postId, thumbFile } = req.body || {};
  if (!postId || !thumbFile) return res.status(400).json({ error: 'postId/thumbFile required' });
  const meta = readMeta(postId);
  meta.selectedThumb = thumbFile;
  meta.selectedThumbAt = new Date().toISOString();
  writeMeta(postId, meta);
  res.json({ ok: true, selectedThumb: thumbFile });
});

// 外部生成画像（Gemini Web 版・Seedream 等）をアップロード
router.post('/v5/upload-thumb', (req, res) => {
  const { postId, filename, dataUrl } = req.body || {};
  if (!postId || !dataUrl) return res.status(400).json({ error: 'postId/dataUrl required' });

  const m = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid dataUrl format' });

  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');
  const safePostId = _thumbPostId(postId);
  const outDir = path.join(THUMB_OUT_BASE, safePostId);
  fs.mkdirSync(outDir, { recursive: true });
  const safeName = String(filename || 'external')
    .replace(/\.[^.]+$/, '')                    // 拡張子除去
    .replace(/[^a-zA-Z0-9_.-]/g, '_')           // sanitize
    .slice(0, 40);
  const finalFile = `external_${Date.now()}_${safeName}.${ext}`;
  fs.writeFileSync(path.join(outDir, finalFile), buffer);

  // 取り込み即選択（Step6 が selectedThumb=null でサムネ反映されない事故を防ぐ）
  const meta = readMeta(postId);
  meta.selectedThumb = finalFile;
  meta.selectedThumbAt = new Date().toISOString();
  writeMeta(postId, meta);

  res.json({
    ok: true,
    file: finalFile,
    url: `/v2_thumbs/${safePostId}/${finalFile}`,
    size: buffer.length,
    autoSelected: true,
  });
});

// ════════════════════════════════════════════════════════════
// 既存サムネ管理 API（list / delete / case-images）保持
// ════════════════════════════════════════════════════════════
router.get('/v5/list-saved', (req, res) => {
  const { postId } = req.query;
  const safePostId = _thumbPostId(postId);
  const dir = path.join(THUMB_OUT_BASE, safePostId);
  if (!fs.existsSync(dir)) return res.json({ files: [] });
  const files = fs.readdirSync(dir)
    .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { file: f, url: `/v2_thumbs/${safePostId}/${f}`, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json({ files });
});

router.delete('/v5/delete-saved', (req, res) => {
  const { postId, file } = req.query;
  if (!postId || !file) return res.status(400).json({ error: 'missing params' });
  const safePostId = _thumbPostId(postId);
  const safeFile = path.basename(String(file));
  const target = path.join(THUMB_OUT_BASE, safePostId, safeFile);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 案件画像（編集タブで参考用に表示する場合）
router.get('/v5/case-images', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.json({ images: [] });
  const root = path.join(ROOT_DIR, 'images', String(postId));
  if (!fs.existsSync(root)) return res.json({ images: [] });
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(jpe?g|png|webp)$/i.test(ent.name)) {
        const rel = path.relative(ROOT_DIR, full).replace(/\\/g, '/');
        const label = path.basename(path.dirname(full));
        out.push({ path: rel, label, file: ent.name });
      }
    }
  };
  walk(root);
  res.json({ images: out });
});

// ─── 完全自動サムネ生成: Gemini背景 + AIパターン選択 + SVG合成 ──
const compositor = require('../scripts/v2_video/thumb_compositor');
const { callAI } = require('../scripts/ai_client');

// AIにフォントパターン選択 + 英語背景プロンプト生成を一括依頼
async function _selectLayersAndBgPrompt(title, subject, texts) {
  const patternList = compositor.patternsForPrompt();
  const system = `あなたはYouTubeサムネイルの専門家です。
与えられた動画情報をもとに以下の2つをJSONで返してください。

1. bgPrompt: Gemini画像生成用の英語プロンプト
   - 人物名は使わず外見・行動で描写（例: "a confident middle-aged male manager in a suit"）
   - 場所・シーン・照明を英語で詳細に
   - 末尾に必ず "No text or letters in the image. Left 40% darker for text overlay. Cinematic 16:9." を付ける

2. layers: テキストレイヤー配置
   キャンバス: 1280×720px / テキストエリア: x:40〜700, y:60〜680

【フォントパターン一覧】
${patternList}

【出力形式】JSONのみ、前置き不要:
{
  "bgPrompt": "English background scene description...",
  "layers": [
    { "text": "テキスト（\\nで改行可）", "pattern": 番号, "x": x座標, "y": y座標, "fontSize": px数 }
  ]
}

【layersルール】
- 2〜4個。主役はパターン1〜6。バッジは13〜15で1個まで
- y座標が重ならないよう十分スペースを取る（大テキストは fontSize の1.3倍以上の間隔）
- メインの煽り文を最も大きく（fontSize 80以上）`;

  const userMsg = `動画タイトル: ${title}
背景シーン: ${subject}
テキスト内容:
${Object.entries(texts).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('\n')}`;

  const raw = await callAI({
    forceProvider: 'deepseek',
    max_tokens: 1200,
    system,
    messages: [{ role: 'user', content: userMsg }],
  });

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AIレイアウト応答のJSONパース失敗: ' + raw.slice(0, 150));
  const parsed = JSON.parse(m[0]);
  if (!Array.isArray(parsed.layers) || !parsed.layers.length) throw new Error('layers配列が空');
  if (!parsed.bgPrompt) throw new Error('bgPrompt が空');
  return { layers: parsed.layers, bgPrompt: parsed.bgPrompt };
}

router.post('/v5/gen-thumb-full', async (req, res) => {
  const { postId, subject, title, ctx, main, punch, badge } = req.body || {};
  if (!subject) return res.status(400).json({ error: 'subject required' });
  if (!main)    return res.status(400).json({ error: 'main text required' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const t0 = Date.now();
  const safeId = _thumbPostId(postId || 'thumb');
  const outDir = path.join(THUMB_OUT_BASE, safeId);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = Date.now();

  // ① AI でフォントパターン選択 + 英語bgPrompt生成
  let layers, bgPrompt;
  try {
    const result = await _selectLayersAndBgPrompt(
      title || subject, subject, { ctx, main, punch, badge }
    );
    layers   = result.layers;
    bgPrompt = result.bgPrompt;
    console.log(`[gen-thumb-full] bgPrompt: ${bgPrompt.slice(0, 80)}...`);
  } catch (e) {
    // フォールバック
    layers = [
      ...(ctx   ? [{ text: ctx,   pattern: 10, x: 46, y: 80,  fontSize: 38 }] : []),
                  { text: main,   pattern: 2,  x: 46, y: 280, fontSize: 88 },
      ...(punch ? [{ text: punch, pattern: 6,  x: 46, y: 420, fontSize: 72 }] : []),
      ...(badge ? [{ text: badge, pattern: 13, x: 46, y: 510, fontSize: 30 }] : []),
    ].filter(l => l.text);
    bgPrompt = `A dramatic cinematic scene: ${subject}. No text or letters. Left 40% darker for text overlay. 16:9.`;
    console.warn('[gen-thumb-full] AI failed, using fallback:', e.message);
  }

  let bgPath;
  try {
    const gr = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: bgPrompt }] }],
        generationConfig: { responseModalities: ['image', 'text'] },
      },
      { timeout: 90000, validateStatus: () => true }
    );
    if (gr.status !== 200) {
      return res.status(500).json({ error: `Gemini ${gr.status}: ${JSON.stringify(gr.data).slice(0, 300)}` });
    }
    const imgPart = (gr.data?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
    if (!imgPart) return res.status(500).json({ error: 'Gemini: 画像なし（フィルターに引っかかった可能性）' });
    bgPath = path.join(outDir, `bg_${ts}.png`);
    fs.writeFileSync(bgPath, Buffer.from(imgPart.inlineData.data, 'base64'));
  } catch (e) {
    return res.status(500).json({ error: '背景生成失敗: ' + e.message });
  }

  // ③ SVGテキスト + Puppeteer合成
  const finalFile = `final_${ts}.png`;
  const finalPath = path.join(outDir, finalFile);
  try {
    await compositor.composite({ bgPath, layers, outputPath: finalPath });
  } catch (e) {
    return res.status(500).json({ error: 'テキスト合成失敗: ' + e.message });
  }

  // ④ selectedThumb に保存
  if (postId) {
    const meta = readMeta(postId);
    meta.selectedThumb   = finalFile;
    meta.selectedThumbAt = new Date().toISOString();
    writeMeta(postId, meta);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const bgUrl    = `/v2_thumbs/${safeId}/bg_${ts}.png`;
  const finalUrl = `/v2_thumbs/${safeId}/${finalFile}`;
  console.log(`[gen-thumb-full] ${safeId} layers:${layers.length} ${elapsed}s`);
  res.json({ ok: true, bgUrl, finalUrl, layers, elapsedSec: parseFloat(elapsed) });
});

// ─── ① 顔スコアリング ───────────────────────────────────────────
// images/{postId}/ 以下の全画像を Gemini Vision で採点し、顔スコア順に返す
router.post('/v5/face-score', async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const imgDir = path.join(ROOT_DIR, 'images', _sanitizePostId(postId));
  if (!fs.existsSync(imgDir)) return res.json({ images: [] });

  // 再帰的に画像収集（最大 24 枚）
  const candidates = [];
  const walk = (dir) => {
    if (candidates.length >= 24) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (candidates.length >= 24) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(jpe?g|png|webp)$/i.test(e.name)) candidates.push(full);
    }
  };
  walk(imgDir);
  if (!candidates.length) return res.json({ images: [] });

  const scorePrompt = `この画像を分析してください。JSONのみで返答（前置き不要）:
{"score":0-10,"faceVisible":true/false,"faceSize":"large/medium/small/none","clarity":"sharp/blurry/none","expression":"strong/neutral/unclear/none"}
scoreの基準:
10=顔が大きく鮮明で表情が強い 7-9=顔が鮮明で表情あり 4-6=顔は見えるが小さいか不鮮明 1-3=辛うじて顔あり 0=顔なし/後ろ姿/集合写真`;

  const scoreOne = async (imgPath) => {
    try {
      const mimeType = /\.png$/i.test(imgPath) ? 'image/png' : 'image/jpeg';
      const data = fs.readFileSync(imgPath).toString('base64');
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        { contents: [{ parts: [{ text: scorePrompt }, { inlineData: { mimeType, data } }] }] },
        { timeout: 20000, validateStatus: () => true }
      );
      const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const m = text.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : {};
      const rel = path.relative(ROOT_DIR, imgPath).replace(/\\/g, '/');
      return { url: '/' + rel, localPath: imgPath, score: parsed.score || 0, faceVisible: !!parsed.faceVisible, faceSize: parsed.faceSize, clarity: parsed.clarity, expression: parsed.expression };
    } catch (_) {
      const rel = path.relative(ROOT_DIR, imgPath).replace(/\\/g, '/');
      return { url: '/' + rel, localPath: imgPath, score: 0, faceVisible: false };
    }
  };

  // 並列スコアリング（最大 6 並列）
  const results = [];
  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    results.push(...await Promise.all(batch.map(scoreOne)));
  }
  results.sort((a, b) => b.score - a.score);
  res.json({ images: results });
});

// ─── ② 顔画像 × シーン説明 → GPT-image-1 で背景生成 ──────────────
// 固有名詞を使わず「この人物が〜」参照で celebrity フィルター回避
router.post('/v5/gen-bg-from-face', async (req, res) => {
  const { localPath, sceneDesc, postId } = req.body || {};
  if (!localPath || !sceneDesc) return res.status(400).json({ error: 'localPath / sceneDesc required' });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  const absPath = path.isAbsolute(localPath) ? localPath : path.join(ROOT_DIR, localPath.replace(/^\//, ''));
  if (!fs.existsSync(absPath)) return res.status(400).json({ error: 'image not found: ' + absPath });

  const prompt = `この人物が、${sceneDesc}。YouTubeサムネイル用の横型写真風画像。プロのスポーツカメラマンが撮影したような臨場感と迫力。16:9構図。人物を右側か中央に配置し、左側にテキスト用の暗いスペースを確保。背景はドラマティックに。`;

  const FormData = require('form-data');
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('image', fs.createReadStream(absPath), { filename: 'face.jpg', contentType: /\.png$/i.test(absPath) ? 'image/png' : 'image/jpeg' });
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', '1536x1024');

  let genRes;
  try {
    genRes = await axios.post('https://api.openai.com/v1/images/edits', form, {
      headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
      timeout: 120000,
      validateStatus: () => true,
    });
  } catch (e) {
    return res.status(500).json({ error: 'GPT-image-1 network error: ' + e.message });
  }

  if (genRes.status !== 200) {
    return res.status(500).json({ error: `GPT-image-1 ${genRes.status}: ${JSON.stringify(genRes.data).slice(0, 400)}` });
  }

  // b64_json または url から保存
  const item = (genRes.data?.data || [])[0];
  if (!item) return res.status(500).json({ error: 'no image returned' });

  const safePostId = _thumbPostId(postId || 'genbg');
  const outDir = path.join(THUMB_OUT_BASE, safePostId);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = Date.now();
  const outFile = `genbg_${ts}.png`;
  const outPath = path.join(outDir, outFile);

  if (item.b64_json) {
    fs.writeFileSync(outPath, Buffer.from(item.b64_json, 'base64'));
  } else if (item.url) {
    const dl = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(outPath, dl.data);
  } else {
    return res.status(500).json({ error: 'no b64_json or url in response' });
  }

  res.json({ ok: true, url: `/v2_thumbs/${safePostId}/${outFile}`, localPath: outPath });
});

// v2_thumbs/ 全体を再帰的に走査してギャラリー一覧を返す
router.get('/v5/gallery', (req, res) => {
  const images = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '_editor') continue;   // エディター本体はスキップ
        walk(full);
      } else if (/\.(png|jpe?g|webp)$/i.test(ent.name)) {
        const rel = path.relative(THUMB_OUT_BASE, full).replace(/\\/g, '/');
        const stat = fs.statSync(full);
        const dirName = path.basename(path.dirname(full));
        images.push({ url: '/v2_thumbs/' + rel, file: ent.name, dir: dirName, mtime: stat.mtimeMs });
      }
    }
  };
  walk(THUMB_OUT_BASE);
  images.sort((a, b) => b.mtime - a.mtime);
  res.json({ images });
});

// Gemini Vision で背景を読み、商業フォントプリセットを選ぶ
router.post('/v5/analyze-font-layer', async (req, res) => {
  const { imageDataUrl, presets } = req.body || {};
  if (!imageDataUrl) return res.status(400).json({ error: 'imageDataUrl required' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const m = String(imageDataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid imageDataUrl' });
  const mime = m[1] === 'jpg' ? 'image/jpeg' : `image/${m[1]}`;
  const safePresets = Array.isArray(presets) ? presets.slice(0, 30) : [];

  try {
    const prompt = [
      'You are selecting a Japanese YouTube soccer thumbnail typography preset.',
      'Analyze the image for base colors, bright/dark regions, faces, logos/crests, key objects, and safe text zones.',
      'Choose exactly one preset id from the provided list. Do not copy the style of any specific channel; use only general composition principles.',
      'Return JSON only:',
      '{"baseTone":"dark|bright|blue|green|gray|red","safeZone":"bottom_left|bottom_right|top_left|top_right|center_left|center_right","recommendedPresetId":"...","reason":"short Japanese reason"}',
      '',
      'Preset candidates:',
      JSON.stringify(safePresets),
    ].join('\n');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const r = await axios.post(url, {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: m[2] } },
        ],
      }],
      generationConfig: { maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 30000 });

    const usage = r.data?.usageMetadata || {};
    costTracker.record({
      label: 'thumb_font_layer_analyze',
      provider: 'gemini',
      inputTokens: usage.promptTokenCount || 0,
      outputTokens: usage.candidatesTokenCount || 0,
    });

    const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jm = raw.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error('Gemini JSON parse failed: ' + raw.slice(0, 160));
    const parsed = JSON.parse(jm[0]);
    const ids = new Set(safePresets.map(p => p.id));
    if (!ids.has(parsed.recommendedPresetId)) {
      parsed.recommendedPresetId = safePresets[0]?.id || '';
      parsed.reason = (parsed.reason || '') + ' / fallback preset';
    }
    res.json({ ok: true, ...parsed });
  } catch (e) {
    console.error('[thumb-font-layer/analyze]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// UI（AI生成タブ + サムネエディタータブ）
// ════════════════════════════════════════════════════════════
function getUI() {
  return `
<div id="step5" style="display:none; padding:20px;">
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
    <h2 style="color:var(--c); font-size:18px; letter-spacing:1px;">5. サムネイル生成</h2>
    <span id="s5-postlabel" style="color:var(--muted); font-size:12px;"></span>
    <span id="s5-selected-status" style="margin-left:auto; font-size:11px; color:var(--muted);"></span>
  </div>

  <!-- サブタブ -->
  <div id="s5-subnav" style="display:flex; gap:4px; margin-bottom:14px; border-bottom:1px solid var(--border);">
    <button onclick="s5GoSub('fontlayer')" id="s5sub-fontlayer" class="s5sub active">✨ 顔→背景→文字</button>
    <button onclick="s5GoSub('ai')"        id="s5sub-ai"        class="s5sub">🤖 AI生成（Imagen 4）</button>
    <button onclick="s5GoSub('editor')"    id="s5sub-editor"    class="s5sub">🎨 サムネエディター</button>
  </div>
  <style>
    .s5sub { background:transparent; color:var(--muted); border:0; padding:9px 14px; cursor:pointer;
             font-size:12px; font-weight:bold; border-bottom:2px solid transparent; }
    .s5sub:hover { color: var(--text); }
    .s5sub.active { color: var(--c); border-bottom-color: var(--c); }
    .s5card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:12px; }
    .s5label { display:block; font-size:11px; color:var(--muted); margin:8px 0 3px; }
    .s5input { width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border);
               padding:7px 10px; border-radius:4px; font-size:12px; box-sizing:border-box; }
    .s5btn { background:var(--c); color:#fff; border:0; padding:8px 16px; border-radius:6px;
             cursor:pointer; font-weight:bold; font-size:12px; }
    .s5btn:disabled { opacity:.5; cursor:not-allowed; }
    .s5btn-sub { background:var(--panel); color:var(--text); border:1px solid var(--border);
                 padding:7px 14px; border-radius:6px; cursor:pointer; font-size:12px; }
    .s5thumb-card { background:var(--panel); border:2px solid var(--border); border-radius:8px;
                    overflow:hidden; cursor:pointer; transition: border-color .15s, transform .15s; }
    .s5thumb-card:hover { transform: translateY(-2px); border-color: var(--muted); }
    .s5thumb-card.selected { border-color: var(--c); box-shadow: 0 0 12px rgba(255,77,77,.4); }
  </style>

  <!-- ───── ✨ AI サムネ生成 ───── -->
  <div id="s5pane-fontlayer" class="s5pane">
    <div class="s5card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
        <strong style="color:var(--c);font-size:13px;">① 背景 + ② テキスト　ワンクリック生成</strong>
        <span style="font-size:10px;color:var(--muted);">Gemini 3.1 Flash Image → SVG合成 / 約¥10</span>
      </div>

      <label class="s5label">背景の被写体・シーン説明</label>
      <input type="text" id="s5fl-subject" class="s5input" style="margin-bottom:6px;"
        placeholder="シャビアロンソがチェルシーのスタジアムに入る場面">
      <div style="font-size:10px;color:var(--muted);margin-bottom:10px;">固有名詞OK（Geminiはフィルターなし）。「テキスト入れて」は不要。</div>

      <label class="s5label">動画タイトル（AIがレイアウトを最適化）</label>
      <input type="text" id="s5fl-title" class="s5input" style="margin-bottom:10px;"
        placeholder="チェルシー新監督シャビアロンソ就任！低迷する王者を救えるか">

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <div>
          <label class="s5label">コンテキスト行（小・上）任意</label>
          <input type="text" id="s5fl-ctx" class="s5input" placeholder="チェルシー監督就任">
        </div>
        <div>
          <label class="s5label">バッジラベル 任意</label>
          <input type="text" id="s5fl-badge" class="s5input" placeholder="電撃就任">
        </div>
        <div>
          <label class="s5label">メイン文字（大）※必須</label>
          <input type="text" id="s5fl-main" class="s5input" placeholder="シャビアロンソ">
        </div>
        <div>
          <label class="s5label">パンチライン（大・下）任意</label>
          <input type="text" id="s5fl-punch" class="s5input" placeholder="低迷する王者を救えるか！？">
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:140px;">
          <label class="s5label">テキストスタイル</label>
          <select id="s5fl-style" class="s5input">
            <option value="gold">金文字</option>
            <option value="fire">炎文字</option>
            <option value="white">白×黒</option>
            <option value="yellow">黄×白（代表）</option>
          </select>
        </div>
        <div style="flex:1;min-width:140px;">
          <label class="s5label">テキスト位置</label>
          <select id="s5fl-pos" class="s5input">
            <option value="left">左寄せ</option>
            <option value="center">センター</option>
          </select>
        </div>
      </div>

      <button onclick="s5GenThumbFull()" class="s5btn" id="s5fl-gen-btn"
        style="width:100%;font-size:14px;padding:12px;">
        ✨ サムネ生成
      </button>
      <div id="s5fl-status" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5;"></div>
    </div>

    <!-- 結果プレビュー -->
    <div class="s5card" id="s5fl-result-card" style="display:none;">
      <strong style="color:var(--c);font-size:12px;display:block;margin-bottom:10px;">生成結果</strong>
      <img id="s5fl-result-img" style="width:100%;border-radius:6px;border:2px solid var(--c);" alt="">
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button onclick="s5FlSelectResult()" class="s5btn" style="flex:1;">✅ このサムネを採用</button>
        <button onclick="s5GenThumbFull()" class="s5btn-sub" style="flex:1;">↻ 再生成</button>
      </div>
    </div>
  </div>

  <!-- ───── 🤖 AI 生成 ───── -->
  <div id="s5pane-ai" class="s5pane" style="display:none;">

    <div class="s5card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;">
        <strong style="color:var(--c); font-size:12px;">全自動</strong>
        <button onclick="s5AutoThumb()" class="s5btn" id="s5-auto-btn">AIで2枚生成して自動選択</button>
        <span id="s5-auto-status" style="font-size:11px; color:var(--muted);"></span>
      </div>
      <div style="font-size:11px; color:var(--muted); line-height:1.6;">
        題材分類、短文抽出、プロンプト生成、Imagen 4 生成、Gemini Vision 選定まで一括実行。
      </div>
    </div>

    <!-- ステップ 1: 題材分類 -->
    <div class="s5card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
        <strong style="color:var(--c); font-size:12px;">① 題材タイプ</strong>
        <button onclick="s5ClassifyTheme()" class="s5btn-sub" id="s5-classify-btn">🔍 自動判定</button>
        <span id="s5-classify-status" style="font-size:11px; color:var(--muted);"></span>
      </div>
      <select id="s5-theme" class="s5input" style="max-width:340px;">
        <option value="default">default（汎用・該当なし）</option>
        <option value="rivalry">rivalry（クラシコ・ダービー・直接対決）</option>
        <option value="transfer">transfer（移籍・新加入）</option>
        <option value="manager_change">manager_change（監督交代・解任）</option>
        <option value="injury">injury（怪我・離脱・復帰）</option>
        <option value="legend">legend（レジェンド・引退・節目）</option>
        <option value="season_summary">season_summary（総括・ランキング）</option>
        <option value="preview">preview（試合プレビュー）</option>
        <option value="review">review（試合レビュー）</option>
      </select>
    </div>

    <!-- ステップ 2+3: テキスト抽出 + プロンプト生成（一括） -->
    <div class="s5card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;">
        <strong style="color:var(--c); font-size:12px;">②③ サムネテキスト＋プロンプト</strong>
        <button onclick="s5ExtractAndSuggest()" class="s5btn-sub" id="s5-extract-suggest-btn">📺✨ オープニングから一括生成</button>
        <button onclick="s5CopyPrompt()" class="s5btn-sub">📋 プロンプトコピー</button>
        <span id="s5-extract-suggest-status" style="font-size:11px; color:var(--muted);"></span>
      </div>

      <label class="s5label">② 上端 煽り文（10文字以内推奨）</label>
      <input type="text" id="s5-top-text" class="s5input" maxlength="20" placeholder="例: プレミア最終決戦">
      <label class="s5label">② 下端 結論文（12文字以内推奨）</label>
      <input type="text" id="s5-bottom-text" class="s5input" maxlength="24" placeholder="例: 優勝はどちらの手に！？">

      <label class="s5label" style="margin-top:10px;">③ Imagen 4 用プロンプト</label>
      <textarea id="s5-prompt" rows="6" class="s5input" style="resize:vertical; font-family:monospace;" placeholder="📺✨ 一括生成ボタンで自動生成。手動編集可。コピーして無料 Gemini Web 版に貼り付けても OK。"></textarea>
    </div>

    <!-- ステップ 4: 画像生成 -->
    <div class="s5card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap;">
        <strong style="color:var(--c); font-size:12px;">④ Imagen 4 で生成</strong>
        <label style="font-size:11px; color:var(--muted);">モデル:</label>
        <select id="s5-provider" class="s5input" style="width:auto;">
          <option value="imagen4" selected>Imagen 4</option>
          <option value="imagen4-fast">Imagen 4 Fast</option>
          <option value="imagen4-ultra">Imagen 4 Ultra</option>
          <option value="gpt-image-1-low">GPT-image-1 Low</option>
          <option value="gpt-image-1-medium">GPT-image-1 Medium</option>
          <option value="gpt-image-1-high">GPT-image-1 High</option>
          <option value="vertex/imagen4">Vertex Imagen 4</option>
          <option value="vertex/imagen4-fast">Vertex Imagen 4 Fast</option>
          <option value="vertex/imagen4-ultra">Vertex Imagen 4 Ultra</option>
        </select>
        <label style="font-size:11px; color:var(--muted);">枚数:</label>
        <select id="s5-count" class="s5input" style="width:auto;">
          <option value="3">3枚</option>
          <option value="4">4枚</option>
          <option value="5" selected>5枚（推奨）</option>
        </select>
        <button onclick="s5GenerateThumbs()" class="s5btn" id="s5-gen-btn">🎨 サムネ生成</button>
        <span id="s5-gen-status" style="font-size:11px; color:var(--muted);"></span>
      </div>
      <div id="s5-thumbs-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:10px;"></div>
    </div>

    <!-- 外部画像インポート（無料 Gemini Web 版・Seedream 等から） -->
    <div class="s5card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:8px;">📤 外部画像インポート（無料 Gemini Web 版・Seedream 等で生成した画像をアップロード）</strong>
      <input type="file" id="s5-upload-file" accept="image/png,image/jpeg,image/webp" style="display:none;" onchange="s5UploadFile(event)">
      <div id="s5-drop-zone"
           onclick="document.getElementById('s5-upload-file').click()"
           ondragover="event.preventDefault(); this.style.borderColor='var(--c)'; this.style.background='#1a2540';"
           ondragleave="this.style.borderColor='var(--border)'; this.style.background='#0a0e1a';"
           ondrop="event.preventDefault(); this.style.borderColor='var(--border)'; this.style.background='#0a0e1a'; s5HandleDrop(event)"
           style="border:2px dashed var(--border); padding:24px 20px; text-align:center; cursor:pointer; border-radius:6px; background:#0a0e1a; transition: all .15s;">
        <div style="font-size:14px; color:var(--text); font-weight:bold;">📁 クリック or ここに画像をドラッグ</div>
        <div style="font-size:11px; color:var(--muted); margin-top:5px;">PNG / JPG / WEBP 対応 / 1280x720（16:9）推奨</div>
      </div>
      <div id="s5-upload-status" style="font-size:11px; color:var(--muted); margin-top:8px;"></div>
    </div>

    <!-- 保存済みサムネ一覧 -->
    <div class="s5card">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <strong style="color:var(--c); font-size:12px;">💾 保存済みサムネ（AI生成・外部import 含む）</strong>
        <button onclick="s5LoadSaved()" class="s5btn-sub">↻ 再読込</button>
      </div>
      <div id="s5-saved-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:10px;"></div>
    </div>
  </div>

  <!-- ───── 🎨 サムネエディター ───── -->
  <div id="s5pane-editor" class="s5pane" style="display:none;">
    <div class="s5card" style="padding:8px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding:0 6px;">
        <strong style="color:var(--c); font-size:12px;">🎨 サムネエディター（手動作成・保険）</strong>
        <a href="/v2_thumbs/_editor/" target="_blank" class="s5btn-sub" style="text-decoration:none;">↗ 別タブで開く</a>
      </div>
      <iframe id="s5-editor-iframe" src="about:blank" style="width:100%; height:80vh; border:1px solid var(--border); border-radius:6px; background:#000;"></iframe>
    </div>
  </div>
</div>

<script>
(function() {
  if (window.__s5Init) return; window.__s5Init = true;

  const STATE = {
    sub: 'fontlayer',
    selectedThumb: null,
    generated: [],
    editorLoaded: false,
  };

  function _e(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function postId() { return window.APP && window.APP.selected ? window.APP.selected.id : null; }
  function postTitle() { return window.APP && window.APP.selected ? (window.APP.selected.title || '') : ''; }
  function setS5Status(id, text, color) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
  }

  window.s5GoSub = function(name) {
    STATE.sub = name;
    ['fontlayer','ai','editor'].forEach(n => {
      const btn = document.getElementById('s5sub-' + n);
      const pane = document.getElementById('s5pane-' + n);
      if (btn) btn.className = 's5sub' + (n === name ? ' active' : '');
      if (pane) pane.style.display = (n === name ? '' : 'none');
    });
    if (name === 'editor' && !STATE.editorLoaded) {
      document.getElementById('s5-editor-iframe').src = '/v2_thumbs/_editor/';
      STATE.editorLoaded = true;
    }
    if (name === 'fontlayer') {
      // 案件タイトルをsubjectの初期値に設定
      const title = postTitle();
      const sub = document.getElementById('s5fl-subject');
      if (sub && title && !sub.value) sub.value = title;
    }
  };

  // ═══ ✨ AIサムネ生成タブ ═══
  let _s5FlFinalUrl = null;

  window.s5GenThumbFull = async function() {
    const subject = (document.getElementById('s5fl-subject') || {}).value?.trim();
    const main    = (document.getElementById('s5fl-main')    || {}).value?.trim();
    if (!subject) { alert('背景のシーン説明を入力してね'); return; }
    if (!main)    { alert('メイン文字を入力してね'); return; }

    const btn = document.getElementById('s5fl-gen-btn');
    const st  = document.getElementById('s5fl-status');
    const rc  = document.getElementById('s5fl-result-card');
    btn.disabled = true;
    rc.style.display = 'none';
    st.textContent = '⏳ ① Gemini で背景生成中...（20〜40秒）';

    try {
      const id = postId();
      const r = await window.fetchJson('/api/v5/gen-thumb-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postId:  id,
          subject,
          title: (document.getElementById('s5fl-title')||{}).value?.trim() || subject,
          ctx:   (document.getElementById('s5fl-ctx')  ||{}).value?.trim() || '',
          main,
          punch: (document.getElementById('s5fl-punch')||{}).value?.trim() || '',
          badge: (document.getElementById('s5fl-badge')||{}).value?.trim() || '',
        }),
      });
      _s5FlFinalUrl = r.finalUrl;
      document.getElementById('s5fl-result-img').src = r.finalUrl + '?t=' + Date.now();
      rc.style.display = '';
      rc.scrollIntoView({ behavior: 'smooth', block: 'start' });
      st.textContent = \`✅ 完成！（\${r.elapsedSec}秒）　背景: \${r.bgUrl.split('/').pop()}\`;
    } catch(e) {
      st.textContent = 'エラー: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  };

  window.s5FlSelectResult = function() {
    if (!_s5FlFinalUrl) return;
    const fname = _s5FlFinalUrl.split('/').pop();
    STATE.selectedThumb = fname;
    const el = document.getElementById('s5-selected-status');
    if (el) el.textContent = '選択中: ' + fname;
    alert('採用しました！Step6で投稿できます。');
  };

  // ═══ 全自動: 分類 → 文字 → プロンプト → 2枚生成 → AI選定 ═══
  window.s5AutoThumb = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s5-auto-btn');
    btn.disabled = true;
    setS5Status('s5-auto-status', '⏳ 全自動生成中（60〜120秒）...', 'var(--muted)');
    try {
      const r = await window.fetchJson('/api/v5/auto-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id }),
      });
      if (r.theme) document.getElementById('s5-theme').value = r.theme;
      if (r.topText) document.getElementById('s5-top-text').value = r.topText;
      if (r.bottomText) document.getElementById('s5-bottom-text').value = r.bottomText;
      if (r.prompt) document.getElementById('s5-prompt').value = r.prompt;
      STATE.generated = r.all || [];
      STATE.selectedThumb = r.selected && r.selected.file ? r.selected.file : null;
      renderGenerated();
      await s5LoadSaved();
      setS5Status('s5-selected-status', STATE.selectedThumb ? '✅ 選択中: ' + STATE.selectedThumb : '', 'var(--success)');
      setS5Status('s5-auto-status', '✅ 自動選択完了: ' + (STATE.selectedThumb || '生成済み'), 'var(--success)');
    } catch (e) {
      setS5Status('s5-auto-status', '❌ ' + e.message, 'var(--c)');
    } finally {
      btn.disabled = false;
    }
  };

  // ═══ ① 題材分類 ═══
  window.s5ClassifyTheme = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s5-classify-btn');
    btn.disabled = true;
    document.getElementById('s5-classify-status').textContent = '⏳ 分類中…';
    try {
      const r = await window.fetchJson('/api/v5/classify-theme', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, title: postTitle() }),
      });
      document.getElementById('s5-theme').value = r.theme;
      document.getElementById('s5-classify-status').textContent =
        '✅ ' + r.theme + ' (確信度 ' + Math.round((r.confidence||0)*100) + '%): ' + (r.reasoning||'');
      document.getElementById('s5-classify-status').style.color = 'var(--success)';
    } catch (e) {
      document.getElementById('s5-classify-status').textContent = '❌ ' + e.message;
      document.getElementById('s5-classify-status').style.color = 'var(--c)';
    } finally {
      btn.disabled = false;
    }
  };

  // ═══ ②③ 一括生成（テキスト抽出 → プロンプト生成 を順次）═══
  window.s5ExtractAndSuggest = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s5-extract-suggest-btn');
    const status = document.getElementById('s5-extract-suggest-status');
    btn.disabled = true;
    status.style.color = 'var(--muted)';

    // ② オープニングから topText/bottomText
    status.textContent = '⏳ ② オープニングから抽出中…';
    let topText = '', bottomText = '';
    try {
      const r = await window.fetchJson('/api/v5/extract-thumb-text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: id }),
      });
      if (r.error) throw new Error(r.error);
      topText = r.topText || '';
      bottomText = r.bottomText || '';
      if (topText)    document.getElementById('s5-top-text').value    = topText;
      if (bottomText) document.getElementById('s5-bottom-text').value = bottomText;
    } catch (e) {
      status.textContent = '❌ ② 抽出失敗: ' + e.message;
      status.style.color = 'var(--c)';
      btn.disabled = false;
      return;
    }

    // ③ プロンプト生成（②の結果をそのまま渡す）
    status.textContent = '⏳ ② 完了 → ③ DeepSeek 思考中…';
    const theme = document.getElementById('s5-theme').value;
    try {
      const r = await window.fetchJson('/api/v5/suggest-thumb-prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: id, theme, topText, bottomText, title: postTitle() }),
      });
      document.getElementById('s5-prompt').value = r.prompt;
      status.textContent = '✅ 一括生成完了（②テキスト + ③プロンプト・編集可）';
      status.style.color = 'var(--success)';
    } catch (e) {
      status.textContent = '⚠️ ② OK だが ③ プロンプト生成失敗: ' + e.message;
      status.style.color = 'var(--c)';
    } finally {
      btn.disabled = false;
    }
  };

  // ═══ ② オープニングから topText/bottomText 抽出（単体・後方互換）═══
  window.s5ExtractThumbText = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s5-extract-btn');
    if (btn) btn.disabled = true;
    setS5Status('s5-extract-suggest-status', '⏳ オープニングから抽出中…', 'var(--muted)');
    try {
      const r = await window.fetchJson('/api/v5/extract-thumb-text', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id }),
      });
      if (r.error) throw new Error(r.error);
      if (r.topText)    document.getElementById('s5-top-text').value    = r.topText;
      if (r.bottomText) document.getElementById('s5-bottom-text').value = r.bottomText;
      setS5Status('s5-extract-suggest-status', '✅ 抽出完了（編集可）', 'var(--success)');
    } catch (e) {
      setS5Status('s5-extract-suggest-status', '❌ ' + e.message, 'var(--c)');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  // ═══ ③ プロンプト提案 ═══
  window.s5SuggestPrompt = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const theme = document.getElementById('s5-theme').value;
    const topText = document.getElementById('s5-top-text').value.trim();
    const bottomText = document.getElementById('s5-bottom-text').value.trim();
    if (!topText && !bottomText) {
      if (!confirm('上端・下端の日本語テキストが空だよ。それでも進める？')) return;
    }
    const btn = document.getElementById('s5-suggest-btn');
    if (btn) btn.disabled = true;
    setS5Status('s5-extract-suggest-status', '⏳ DeepSeek 思考中…', 'var(--muted)');
    try {
      const r = await window.fetchJson('/api/v5/suggest-thumb-prompt', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, theme, topText, bottomText, title: postTitle() }),
      });
      document.getElementById('s5-prompt').value = r.prompt;
      setS5Status('s5-extract-suggest-status', '✅ プロンプト生成完了（編集可）', 'var(--success)');
    } catch (e) {
      setS5Status('s5-extract-suggest-status', '❌ ' + e.message, 'var(--c)');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  // ═══ ④ Imagen 4 で画像生成 ═══
  window.s5GenerateThumbs = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const prompt = document.getElementById('s5-prompt').value.trim();
    if (!prompt) { alert('プロンプトを入力してね（③ で提案ボタン押すか手動入力）'); return; }
    const provider = document.getElementById('s5-provider').value || 'imagen4';
    const count = parseInt(document.getElementById('s5-count').value, 10) || 5;
    const btn = document.getElementById('s5-gen-btn');
    btn.disabled = true;
    document.getElementById('s5-gen-status').textContent = '⏳ Imagen 4 で ' + count + ' 枚生成中（最大60秒）…';
    document.getElementById('s5-gen-status').style.color = 'var(--muted)';
    try {
      const r = await window.fetchJson('/api/v5/generate-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, prompt, count, provider }),
      });
      STATE.generated = r.thumbs || [];
      renderGenerated();
      document.getElementById('s5-gen-status').textContent = '✅ ' + STATE.generated.length + ' 枚生成完了';
      document.getElementById('s5-gen-status').style.color = 'var(--success)';
      // 保存済み一覧も再読込
      s5LoadSaved();
    } catch (e) {
      document.getElementById('s5-gen-status').textContent = '❌ ' + e.message;
      document.getElementById('s5-gen-status').style.color = 'var(--c)';
    } finally {
      btn.disabled = false;
    }
  };

  function renderGenerated() {
    const el = document.getElementById('s5-thumbs-grid');
    if (!STATE.generated.length) { el.innerHTML = ''; return; }
    el.innerHTML = STATE.generated.map(t => {
      const sel = STATE.selectedThumb === t.file;
      return '<div class="s5thumb-card' + (sel?' selected':'') + '" onclick="s5SelectThumb(\\''+_e(t.file)+'\\')">'
        + '<img src="'+_e(t.url)+'" style="width:100%;aspect-ratio:16/9;display:block;object-fit:cover;">'
        + '<div style="padding:6px 8px;font-size:10px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;">'
        + '<span>'+_e(t.provider)+'</span>'
        + (sel ? '<span style="color:var(--c);font-weight:bold;">✅ 選択中</span>' : '<span style="color:var(--muted);">クリックで選択</span>')
        + '</div></div>';
    }).join('');
  }

  // ═══ プロンプトコピー ═══
  window.s5CopyPrompt = function() {
    const t = document.getElementById('s5-prompt').value.trim();
    if (!t) { alert('プロンプトが空だよ。先に「リネカ＋DeepSeekで提案」押すか、手動入力してね'); return; }
    navigator.clipboard.writeText(t).then(() => {
      setS5Status('s5-extract-suggest-status', '✅ クリップボードにコピー！Gemini Web に貼り付けてね', 'var(--success)');
    }).catch(e => alert('コピー失敗: ' + e.message));
  };

  // ═══ 外部画像アップロード ═══
  window.s5UploadFile = async function(ev) {
    const file = (ev.target.files || [])[0];
    if (!file) return;
    await _s5DoUpload(file);
    ev.target.value = '';  // 同じファイル再選択できるよう reset
  };
  window.s5HandleDrop = async function(ev) {
    const file = (ev.dataTransfer.files || [])[0];
    if (!file) return;
    if (!/^image\\//.test(file.type)) { alert('画像ファイルを選んでね（PNG / JPG / WEBP）'); return; }
    await _s5DoUpload(file);
  };
  async function _s5DoUpload(file) {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const status = document.getElementById('s5-upload-status');
    status.textContent = '⏳ アップロード中... ' + file.name + ' (' + (file.size/1024).toFixed(0) + 'KB)';
    status.style.color = 'var(--muted)';
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('ファイル読み込み失敗'));
        r.readAsDataURL(file);
      });
      const r = await window.fetchJson('/api/v5/upload-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, filename: file.name, dataUrl }),
      });
      status.textContent = '✅ 取り込み完了 → このサムネを自動選択しました: ' + r.file;
      status.style.color = 'var(--success)';
      STATE.selectedThumb = r.file;
      s5LoadSaved();
    } catch (e) {
      status.textContent = '❌ ' + e.message;
      status.style.color = 'var(--c)';
    }
  }

  // ═══ サムネ選択（meta に記録）═══
  window.s5SelectThumb = async function(file) {
    const id = postId(); if (!id) return;
    try {
      await window.fetchJson('/api/v5/select-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, thumbFile: file }),
      });
      STATE.selectedThumb = file;
      document.getElementById('s5-selected-status').textContent = '✅ 選択中: ' + file;
      document.getElementById('s5-selected-status').style.color = 'var(--success)';
      renderGenerated();
      renderSaved();
    } catch (e) { alert('選択失敗: ' + e.message); }
  };

  // ═══ 保存済み一覧 ═══
  window.s5LoadSaved = async function() {
    const id = postId(); if (!id) return;
    try {
      const r = await window.fetchJson('/api/v5/list-saved?postId=' + encodeURIComponent(id));
      STATE.saved = r.files || [];
      renderSaved();
    } catch (e) { console.error(e); }
  };
  function renderSaved() {
    const el = document.getElementById('s5-saved-grid');
    if (!STATE.saved || !STATE.saved.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px;">まだ生成サムネなし</div>'; return; }
    el.innerHTML = STATE.saved.map(f => {
      const sel = STATE.selectedThumb === f.file;
      return '<div class="s5thumb-card' + (sel?' selected':'') + '" onclick="s5SelectThumb(\\''+_e(f.file)+'\\')">'
        + '<img src="'+_e(f.url)+'" style="width:100%;aspect-ratio:16/9;display:block;object-fit:cover;">'
        + '<div style="padding:5px 8px;font-size:10px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:6px;">'
        + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="'+_e(f.file)+'">'+_e(f.file)+'</span>'
        + (sel ? '<span style="color:var(--c);font-weight:bold;">✅</span>' : '')
        + '<button onclick="event.stopPropagation();s5DeleteSaved(\\''+_e(f.file)+'\\')" style="background:transparent;border:0;color:var(--c);cursor:pointer;padding:0;font-size:13px;">✕</button>'
        + '</div></div>';
    }).join('');
  }
  window.s5DeleteSaved = async function(file) {
    if (!confirm('削除する？: ' + file)) return;
    const id = postId(); if (!id) return;
    try {
      await fetch('/api/v5/delete-saved?postId=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(file), { method:'DELETE' });
      if (STATE.selectedThumb === file) STATE.selectedThumb = null;
      s5LoadSaved();
    } catch (e) { alert('削除失敗: ' + e.message); }
  };

  // ═══ INIT ═══
  window.step5Init = async function() {
    const post = window.APP && window.APP.selected;
    document.getElementById('s5-postlabel').textContent = post ? '案件: ' + (post.title || post.id) : '案件未選択';
    s5GoSub('fontlayer');
    // meta から既選択サムネを復元
    if (post) {
      try {
        const m = await window.fetchJson('/api/v6/get-meta?postId=' + encodeURIComponent(post.id));
        if (m.selectedThumb) {
          STATE.selectedThumb = m.selectedThumb;
          document.getElementById('s5-selected-status').textContent = '✅ 選択中: ' + m.selectedThumb;
          document.getElementById('s5-selected-status').style.color = 'var(--success)';
        }
      } catch (_) {}
    }
    s5LoadSaved();
  };
})();
</script>
`;
}

module.exports = { router, getUI };
