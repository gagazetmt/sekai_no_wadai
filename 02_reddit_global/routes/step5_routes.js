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
const sharp      = require('sharp');

const ROOT_DIR        = path.join(__dirname, '..');
const THUMB_OUT_BASE  = path.join(ROOT_DIR, 'data', 'v2_thumbs');
// 2026-05-16: postId に '/' 等を含む Reddit 形式に対応するため、 step4 modulesPath と同様にサニタイズ
//   未サニタイズだと '/r/soccer/comments/.../' でパスが壊れて 404
const _sanitizePostId = (s) => (s || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
const _thumbPostId = (s) => String(s || '_unsorted').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const META_FILE       = (postId) => path.join(ROOT_DIR, 'data', _sanitizePostId(postId) + '_step5.json');
const SI_DATA_FILE    = (postId) => path.join(ROOT_DIR, 'data', 'si_data', _sanitizePostId(postId) + '.json');
const MODULES_FILE    = (postId) => path.join(ROOT_DIR, 'data', _sanitizePostId(postId) + '_modules.json');
const V25_PLAN_FILE   = (postId) => path.join(ROOT_DIR, 'data', 'v25_plans', _sanitizePostId(postId) + '.json');

const thumbAi = require('../scripts/v2_video/thumb_ai');
const { findStockMatches } = require('../scripts/modules/stock_match');

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

function _collectThumbnailStoryContext(postId) {
  const lines = [];
  const mf = MODULES_FILE(postId);
  if (fs.existsSync(mf)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mf, 'utf8'));
      const modules = Array.isArray(parsed) ? parsed : parsed.modules || [];
      const opening = modules.find(m => m.type === 'opening' || m.mainKey === 'opening') || modules[0];
      if (opening?.title) lines.push(`動画タイトル: ${opening.title}`);
      if (opening?.scriptDir) lines.push(`事件の核心: ${opening.scriptDir}`);
      if (opening?.narration) lines.push(`冒頭ナレーション: ${opening.narration.slice(0, 700)}`);

      const outline = modules.slice(0, 8).map((m, i) => {
        const detail = m.scriptDir || m.narration || '';
        return `${i + 1}. ${m.title || m.type || 'slide'}: ${String(detail).slice(0, 280)}`;
      });
      if (outline.length) lines.push(`動画構成:\n${outline.join('\n')}`);
    } catch (_) {}
  }

  const pf = V25_PLAN_FILE(postId);
  if (fs.existsSync(pf)) {
    try {
      const plan = JSON.parse(fs.readFileSync(pf, 'utf8'));
      const briefing = plan.briefing
        || plan.aiPlan?.briefing
        || plan.result?.briefing
        || plan.plan?.briefing
        || plan.proposals?.briefing;
      if (briefing) {
        if (briefing.purpose) lines.push(`動画の目的: ${briefing.purpose}`);
        if (briefing.coreMessage) lines.push(`核心メッセージ: ${briefing.coreMessage}`);
        if (briefing.angle) lines.push(`切り口: ${briefing.angle}`);
        if (briefing.storyPattern) lines.push(`構成型: ${briefing.storyPattern}`);
      }
    } catch (_) {}
  }

  return lines.join('\n').slice(0, 5000);
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

// ─── SVG合成のみ（背景は生成済み） ──────────────────────────────
router.post('/v5/composite-thumb', async (req, res) => {
  const { postId, bgLocalPath, ctx, main, punch, badge, style } = req.body || {};
  if (!bgLocalPath) return res.status(400).json({ error: 'bgLocalPath required' });
  if (!main)        return res.status(400).json({ error: 'main text required' });

  const absPath = path.isAbsolute(bgLocalPath)
    ? bgLocalPath
    : path.join(ROOT_DIR, bgLocalPath.replace(/^\//, ''));
  if (!fs.existsSync(absPath)) return res.status(400).json({ error: '背景画像が見つかりません: ' + absPath });

  // AI でパターン選択
  const { callAI } = require('../scripts/ai_client');
  const { patternsForPrompt } = require('../scripts/v2_video/thumb_compositor');
  let layers;
  try {
    const raw = await callAI({
      forceProvider: 'deepseek', max_tokens: 800,
      system: `YouTubeサムネイルのタイポグラフィ専門家。JSONのみ返答。
キャンバス1280x720。テキストエリアx:40-700, y:60-680。
フォントパターン:\n${patternsForPrompt()}
出力: {"layers":[{"text":"...","pattern":番号,"x":数,"y":数,"fontSize":数}]}
ルール: 2-4個。主役はパターン1-6(大)。バッジは13-15で最大1個。y重複禁止。`,
      messages: [{ role: 'user', content: `テキスト: ctx="${ctx||''}" main="${main}" punch="${punch||''}" badge="${badge||''}" style=${style||'gold'}` }],
    });
    const m = raw.match(/\{[\s\S]*\}/);
    layers = m ? JSON.parse(m[0]).layers : null;
  } catch (_) {}

  // フォールバック
  if (!layers || !layers.length) {
    const pat = { gold:2, fire:3, white:5, yellow:11 }[style] || 2;
    layers = [
      ...(ctx   ? [{ text: ctx,   pattern: 10, x: 46, y: 80,  fontSize: 38 }] : []),
                  { text: main,   pattern: pat, x: 46, y: 280, fontSize: 88 },
      ...(punch ? [{ text: punch, pattern: pat, x: 46, y: 420, fontSize: 74 }] : []),
      ...(badge ? [{ text: badge, pattern: 13,  x: 46, y: 510, fontSize: 30 }] : []),
    ].filter(l => l.text);
  }

  const safeId  = _thumbPostId(postId || 'thumb');
  const outDir  = path.join(THUMB_OUT_BASE, safeId);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = `final_${Date.now()}.png`;
  const outPath = path.join(outDir, outFile);

  try {
    await compositor.composite({ bgPath: absPath, layers, outputPath: outPath });
  } catch (e) {
    return res.status(500).json({ error: 'SVG合成失敗: ' + e.message });
  }

  if (postId) {
    const meta = readMeta(postId);
    meta.selectedThumb   = outFile;
    meta.selectedThumbAt = new Date().toISOString();
    writeMeta(postId, meta);
  }
  res.json({ ok: true, file: outFile, url: `/v2_thumbs/${safeId}/${outFile}` });
});

// ─── ① 顔スコアリング ───────────────────────────────────────────
// images/{postId}/ 以下の全画像を Gemini Vision で採点し、顔スコア順に返す
// AIがシーン説明プリセットを提案
router.post('/v5/suggest-bg-prompts', async (req, res) => {
  const { postId } = req.body || {};
  const { callAI } = require('../scripts/ai_client');
  const context = postId ? _collectThumbnailStoryContext(postId) : '';

  try {
    const raw = await callAI({
      forceProvider: 'deepseek', max_tokens: 1000,
      system: `あなたはサッカー報道専門のYouTubeサムネイル・ディレクターです。
渡された動画情報から、事件の核心が一目で伝わる背景シーンを設計してください。
JSONのみ返答（前置き不要）: {"prompts":["...", "...", "...", "..."]}

ルール:
- 4案提案する
- 各案は必ず、動画情報に書かれた実際のニュース・試合・移籍・会見などを一場面に変換する
- 動画情報にない設定、職業、場所、出来事を創作しない
- 抽象的な「決意」「苦悩」だけで済ませず、空港、スタジアム、会見場、ベンチなど案件に合う具体的な場所と行動を書く
- 人物名、クラブ名、大会名などの固有名詞は出力しない。「この人物が〜」で始める
- 画像内の看板、モニター、書類にも文字や固有名詞を描かせない
- 炎、武器、戦場、瓦礫、災害、犯罪的演出は、元情報に明記されていない限り絶対に使わない
- 実写スポーツ報道として自然で、ドラマティックかつ視覚的に分かりやすくする
- 4案はカメラ位置や場所を変えても、同じ案件の核心から逸脱しない
- 「クラブのロゴはOK」「テキストは不要」は出力に含めない（生成側で付ける）`,
      messages: [{
        role: 'user',
        content: `以下の案件だけを根拠にしてください。\n\n${context || '案件情報を取得できませんでした。一般案を作らず、サッカー報道の場面に限定してください。'}`,
      }],
    });
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    const prompts = (Array.isArray(parsed.prompts) ? parsed.prompts : [])
      .map(p => String(p || '').trim())
      .filter(Boolean)
      .slice(0, 4);
    res.json({ prompts });
  } catch (e) {
    console.warn('[suggest-bg-prompts]', e.message);
    res.json({ prompts: [] });
  }
});

router.post('/v5/face-score', async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  // ─── 候補収集: ストック画像（公式優先）+ X画像 ────────────────
  // PL/LaLiga等の公式リーグ判定（league値が slugified/raw 両方に対応）
  const _isOfficialLeague = (league, leagueSlug, stockProvider) => {
    const l = `${league || ''} ${leagueSlug || ''}`.toLowerCase().replace(/[-]+/g, ' ').trim();
    if (/official/i.test(stockProvider || '')) return true;
    return ['premier league', 'la liga', 'bundesliga', 'serie a', 'ligue 1']
      .some(name => l.includes(name));
  };

  const _collectPeople = () => {
    const people = [];
    const add = (name, role, priority = 10) => {
      const cleanName = String(name || '').replace(/^(?:entity|manager):/, '').trim();
      const cleanRole = String(role || '').toLowerCase();
      if (!cleanName || !['player', 'entity'].includes(cleanRole)) return;
      people.push({ name: cleanName, role: 'player', priority });
    };

    // 動画構成で主役に指定された選手を最優先
    const modulesFile = MODULES_FILE(postId);
    if (fs.existsSync(modulesFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(modulesFile, 'utf8'));
        const modules = Array.isArray(parsed) ? parsed : parsed.modules || [];
        let playerOrder = 0;
        for (const mod of modules) {
          const subject = String(mod?.binding?.subject || '').toLowerCase();
          if (subject === 'player') add(mod?.binding?.primary, 'player', playerOrder++);
          if (String(mod?.mainKey || '').startsWith('entity:') && subject === 'player') {
            add(mod.mainKey, 'player', Math.max(0, playerOrder - 1));
          }
        }
      } catch (_) {}
    }

    const siFile = SI_DATA_FILE(postId);
    if (fs.existsSync(siFile)) {
      try {
        const siData = JSON.parse(fs.readFileSync(siFile, 'utf8'));
        const entityItems = siData?.boxes?.entity?.items;
        if (Array.isArray(entityItems)) {
          for (const item of entityItems) add(item?.label || item?.name, item?.role, 10);
        }
        // 旧形式との互換
        for (const key of Object.keys(siData || {})) {
          if (key.startsWith('entity:')) add(key, 'player', 10);
        }
      } catch (_) {}
    }

    const best = new Map();
    for (const person of people) {
      const key = person.name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key) continue;
      const current = best.get(key);
      if (!current || person.priority < current.priority) best.set(key, person);
    }
    return [...best.values()].sort((a, b) => a.priority - b.priority);
  };

  // source優先度: official_stock(0) > other_stock(1) > x(2)
  const stockCandidates = [];  // { localPath, source: 'official_stock'|'other_stock' }
  const xCandidates    = [];  // { localPath, source: 'x' }

  // ストック画像: si_data の人物ラベル + modules binding から検索
  const seenUrls = new Set();
  for (const person of _collectPeople()) {
    if (stockCandidates.length >= 24) break;
    const matches = findStockMatches({ type: 'player', entity: person.name, limit: 30 });
    const official = matches.filter(m => _isOfficialLeague(m.league, m.leagueSlug, m.stockProvider)).slice(0, 2);
    const other = matches.filter(m => !_isOfficialLeague(m.league, m.leagueSlug, m.stockProvider)).slice(0, 5);
    for (const m of [...official, ...other]) {
      if (!m.url || seenUrls.has(m.url)) continue;
      seenUrls.add(m.url);
      const localPath = path.join(ROOT_DIR, m.url.replace(/^\//, ''));
      if (!fs.existsSync(localPath)) continue;
      const src = _isOfficialLeague(m.league, m.leagueSlug, m.stockProvider)
        ? 'official_stock'
        : 'other_stock';
      stockCandidates.push({ localPath, source: src, entity: person.name, entityPriority: person.priority });
      if (stockCandidates.length >= 24) break;
    }
  }

  // X取得済み画像（最大16枚）
  const imgDir = path.join(ROOT_DIR, 'images', _sanitizePostId(postId));
  const walkForX = (dir, arr, max) => {
    if (arr.length >= max) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (arr.length >= max) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkForX(full, arr, max);
      else if (/\.(jpe?g|png|webp)$/i.test(e.name)) arr.push({ localPath: full, source: 'x' });
    }
  };
  if (fs.existsSync(imgDir)) walkForX(imgDir, xCandidates, 16);

  // 結合順: 公式ストック → その他ストック → X画像
  const candidates = [...stockCandidates, ...xCandidates];
  if (!candidates.length) return res.json({ images: [] });

  const scorePrompt = `この画像を分析してください。JSONのみで返答（前置き不要）:
{"score":0-10,"faceVisible":true/false,"faceSize":"large/medium/small/none","clarity":"sharp/blurry/none","expression":"strong/neutral/unclear/none"}
scoreの基準:
10=顔が大きく鮮明で表情が強い 7-9=顔が鮮明で表情あり 4-6=顔は見えるが小さいか不鮮明 1-3=辛うじて顔あり 0=顔なし/後ろ姿/集合写真`;

  const scoreOne = async ({ localPath, source, entity, entityPriority }) => {
    try {
      const mimeType = /\.png$/i.test(localPath) ? 'image/png' : 'image/jpeg';
      const data = fs.readFileSync(localPath).toString('base64');
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        { contents: [{ parts: [{ text: scorePrompt }, { inlineData: { mimeType, data } }] }] },
        { timeout: 20000, validateStatus: () => true }
      );
      const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const m = text.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : {};
      const rel = path.relative(ROOT_DIR, localPath).replace(/\\/g, '/');
      return { url: '/' + rel, localPath, source, entity, entityPriority, score: parsed.score || 0, faceVisible: !!parsed.faceVisible, faceSize: parsed.faceSize, clarity: parsed.clarity, expression: parsed.expression };
    } catch (_) {
      const rel = path.relative(ROOT_DIR, localPath).replace(/\\/g, '/');
      return { url: '/' + rel, localPath, source, entity, entityPriority, score: 0, faceVisible: false };
    }
  };

  // 並列スコアリング（最大 6 並列）
  const results = [];
  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    results.push(...await Promise.all(batch.map(scoreOne)));
  }

  // ソート: official_stock → other_stock → x の中で顔スコア降順
  const _srcPriority = { official_stock: 0, other_stock: 1, x: 2 };
  results.sort((a, b) => {
    const ea = Number(a.entityPriority ?? 99);
    const eb = Number(b.entityPriority ?? 99);
    if (ea !== eb) return ea - eb;
    const pa = _srcPriority[a.source] ?? 3;
    const pb = _srcPriority[b.source] ?? 3;
    if (pa !== pb) return pa - pb;
    return b.score - a.score;
  });
  res.json({ images: results });
});

function _openRouterImagePart(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return {
    type: 'image_url',
    image_url: {
      url: `data:${mimeType};base64,${fs.readFileSync(absPath).toString('base64')}`,
    },
  };
}

async function _generateGemini31Thumb({ prompt, referencePaths }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const content = [
    { type: 'text', text: prompt },
    ...referencePaths.map(_openRouterImagePart),
  ];
  let lastDetail = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'google/gemini-3.1-flash-image-preview',
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '16:9' },
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://sekai-no-wadai.local',
        'X-Title': 'Soccer Thumbnail Step5',
      },
      timeout: 300000,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    if (response.status !== 200) {
      lastDetail = `OpenRouter ${response.status}: ${JSON.stringify(response.data).slice(0, 700)}`;
      continue;
    }
    const imageUrl = response.data?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!imageUrl || !imageUrl.startsWith('data:')) {
      lastDetail = `attempt ${attempt}: ${JSON.stringify(response.data).slice(0, 500)}`;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }
    return {
      buffer: Buffer.from(imageUrl.slice(imageUrl.indexOf(',') + 1), 'base64'),
      costUsd: Number(response.data?.usage?.cost || 0),
    };
  }
  throw new Error(`Gemini 3.1が画像を返しませんでした: ${lastDetail}`);
}

// ─── Gemini 3.1 Flash ImageでYouTubeサムネ背景をA/B生成 ──
router.post('/v5/gen-bg-from-face', async (req, res) => {
  const {
    localPath, referencePaths = [], sceneDesc, postId,
    ctx = '', main = '', punch = '', badge = '',
  } = req.body || {};
  if (!localPath || !sceneDesc || !String(main).trim()) {
    return res.status(400).json({ error: 'localPath / sceneDesc / main required' });
  }
  const requested = [localPath, ...referencePaths].filter(Boolean);
  const absPaths = [];
  for (const item of requested) {
    const absPath = path.isAbsolute(item) ? item : path.join(ROOT_DIR, String(item).replace(/^\//, ''));
    if (!fs.existsSync(absPath) || !absPath.startsWith(ROOT_DIR)) continue;
    if (!absPaths.includes(absPath)) absPaths.push(absPath);
    if (absPaths.length >= 3) break;
  }
  if (!absPaths.length) return res.status(400).json({ error: '参照画像が見つかりません' });

  const scene = String(sceneDesc).trim();
  const exactText = [
    ctx && `コンテキスト: 「${String(ctx).trim()}」`,
    `メインキャッチ: 「${String(main).trim()}」`,
    punch && `サブキャッチ: 「${String(punch).trim()}」`,
    badge && `バッジ: 「${String(badge).trim()}」`,
  ].filter(Boolean).join('\n');
  const identityRule = `添付画像は同じ中心人物の参照です。1枚目の顔を最優先し、目、眉、鼻、頬骨、顎、髪型を維持して別人化させないでください。`;
  const shared = `日本のサッカーYouTube用に、リアルな実写フォトスタイルの高品質な16:9完成サムネイルを生成してください。
${identityRule}
案件シーン: ${scene}
主役の顔と上半身を大きく、強い表情とドラマチックなスタジアム照明で描く。
強いコントラスト、逆光、火花、チームカラーの光を使う。
以下の日本語を一字一句そのまま、読みやすく画像内へ描画する:
${exactText}
日本のYouTubeサムネイルらしい極太ゴシック体。太い黒縁と白縁の二重フチ、影、立体感、赤・黄・白・金の高コントラスト配色を使う。
文字の欠落、別表記、英訳、文字化け、余計な文章は禁止。指定した文字以外の字幕や透かしは生成しない。`;
  const prompts = [
    `${shared}
【A案】主役を画面右側に大きく配置し、左側45%を暗く整理された文字スペースとして空ける。スマートフォンで主役の顔が強く見える構図。`,
    `${shared}
【B案】画面を斜めに分割した対立構図。主役を右側手前に大きく、左側に対立チームやクラブを象徴するスタジアム、紋章風の視覚要素、サポーターを配置する。中央から左下に文字を置ける暗い領域を確保する。`,
  ];

  let generated;
  try {
    generated = [];
    for (const prompt of prompts) {
      generated.push(await _generateGemini31Thumb({
        prompt,
        referencePaths: absPaths,
      }));
    }
  } catch (e) {
    console.warn('[gen-bg-from-face/gemini31]', e.message);
    return res.status(500).json({ error: e.message });
  }

  const safePostId = _thumbPostId(postId || 'genbg');
  const outDir = path.join(THUMB_OUT_BASE, safePostId);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const results = generated.map((item, index) => {
    const variant = index === 0 ? 'A' : 'B';
    const outFile = `gemini31_${stamp}_${variant}.png`;
    const outPath = path.join(outDir, outFile);
    fs.writeFileSync(outPath, item.buffer);
    return {
      variant,
      url: `/v2_thumbs/${safePostId}/${outFile}`,
      file: outFile,
      localPath: outPath,
      costUsd: item.costUsd,
    };
  });
  res.json({
    ok: true,
    results,
    estimatedCostUsd: results.reduce((sum, item) => sum + item.costUsd, 0),
  });
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
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px;">
    <h2 style="color:var(--c); font-size:18px; letter-spacing:1px;">5. サムネイル生成</h2>
    <span id="s5-postlabel" style="color:var(--muted); font-size:12px;"></span>
    <span id="s5-selected-status" style="margin-left:auto; font-size:11px; color:var(--muted);"></span>
  </div>
  <style>
    .s5card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:14px; }
    .s5label { display:block; font-size:11px; color:var(--muted); margin:8px 0 3px; }
    .s5input { width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border);
               padding:7px 10px; border-radius:4px; font-size:12px; box-sizing:border-box; }
    .s5btn   { background:var(--c); color:#fff; border:0; padding:9px 18px; border-radius:6px;
               cursor:pointer; font-weight:bold; font-size:12px; }
    .s5btn:disabled { opacity:.45; cursor:not-allowed; }
    .s5btn-sub { background:var(--panel); color:var(--text); border:1px solid var(--border);
                 padding:7px 14px; border-radius:6px; cursor:pointer; font-size:12px; }
    .s5face-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(148px,1fr)); gap:8px; margin-top:10px; }
    .s5face-card { border:2px solid var(--border); border-radius:6px; overflow:hidden;
                   cursor:pointer; background:#000; aspect-ratio:1; position:relative; transition:border-color .15s; }
    .s5face-card:hover { border-color:var(--c); }
    .s5face-card.selected { border-color:var(--c); box-shadow:0 0 10px rgba(255,77,77,.4); }
    .s5face-card img { width:100%; height:100%; object-fit:cover; }
    .s5face-card .s5score { position:absolute; bottom:0; left:0; right:0;
                            background:rgba(0,0,0,.78); font-size:10px; color:#fff; padding:2px 5px; }
    .s5variant-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .s5variant { border:3px solid var(--border); border-radius:7px; overflow:hidden;
                 cursor:pointer; background:#000; transition:border-color .15s, box-shadow .15s; }
    .s5variant:hover { border-color:var(--c); }
    .s5variant.selected { border-color:var(--c); box-shadow:0 0 14px rgba(255,77,77,.45); }
    .s5variant img { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; }
    .s5variant-label { padding:5px 8px; font-size:11px; font-weight:bold; color:#fff; background:#111827; }
    @media(max-width:700px) { .s5variant-grid { grid-template-columns:1fr; } }
  </style>

  <!-- ① 顔選出 -->
  <div class="s5card">
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px;">
      <strong style="color:var(--c); font-size:13px;">① 顔選出</strong>
      <button onclick="s5RunFaceScore()" class="s5btn" id="s5-face-btn">Geminiでスコアリング</button>
      <span id="s5-face-status" style="font-size:11px; color:var(--muted);"></span>
    </div>
    <div style="font-size:11px; color:var(--muted); line-height:1.6;">
      この案件の X / Wikipedia 取得済み画像から、中心人物の顔が最も鮮明な1枚をAIが選出します。
    </div>
    <div class="s5face-grid" id="s5-face-grid"></div>
  </div>

  <!-- ② テキスト込み完成サムネ生成 -->
  <div class="s5card" id="s5-bg-card" style="display:none;">
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
      <strong style="color:var(--c); font-size:13px;">② テキスト込みサムネA/B生成（Gemini 3.1 Flash）</strong>
      <button onclick="s5GenBg()" class="s5btn" id="s5-bg-btn">完成サムネを2案生成</button>
      <span id="s5-bg-status" style="font-size:11px; color:var(--muted);"></span>
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">
      <div>
        <label class="s5label">コンテキスト行（小・上）任意</label>
        <input type="text" id="s5-ctx" class="s5input" placeholder="レアル・マドリーが本気">
      </div>
      <div>
        <label class="s5label">バッジ 任意</label>
        <input type="text" id="s5-badge" class="s5input" placeholder="衝撃">
      </div>
      <div>
        <label class="s5label">メイン文字（大）※必須</label>
        <input type="text" id="s5-main" class="s5input" placeholder="マック・アリスター強奪か？！">
      </div>
      <div>
        <label class="s5label">パンチライン（大・下）任意</label>
        <input type="text" id="s5-punch" class="s5input" placeholder="契約延長交渉なし">
      </div>
    </div>
    <div style="display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap;">
      <div>
        <div style="font-size:10px; color:var(--muted); margin-bottom:4px;">選択中</div>
        <img id="s5-face-selected" style="width:130px; border-radius:6px; border:2px solid var(--c);" alt="">
      </div>
      <div style="flex:1; min-width:200px;">
        <label class="s5label">シーン説明（日本語OK）</label>
        <input type="text" id="s5-scene" class="s5input"
          placeholder="レアルマドリーの会長選挙の景品となっている場面">
        <div id="s5-scene-presets" style="display:flex; flex-wrap:wrap; gap:5px; margin-top:6px;"></div>
        <div style="font-size:10px; color:var(--muted); margin-top:5px; line-height:1.5;">
          顔参照は上位3枚を自動使用。日本語テキストを含むA案とB案から完成サムネを選択します。
        </div>
      </div>
    </div>
    <div id="s5-bg-preview" style="margin-top:12px;"></div>
  </div>

  <!-- 文字崩れ時の旧SVG合成（通常フローでは非表示） -->
  <div class="s5card" id="s5-text-card" style="display:none;">
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
      <strong style="color:var(--c); font-size:13px;">③ テキストレイヤー（SVG合成）</strong>
      <button onclick="s5GenFinal()" class="s5btn" id="s5-final-btn">完成サムネを生成</button>
      <span id="s5-final-status" style="font-size:11px; color:var(--muted);"></span>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <div style="flex:1; min-width:140px;">
        <label class="s5label">スタイル</label>
        <select id="s5-style" class="s5input">
          <option value="gold">金文字</option>
          <option value="fire">炎文字</option>
          <option value="white">白×黒</option>
          <option value="yellow">黄×白（代表）</option>
        </select>
      </div>
      <div style="flex:1; min-width:140px;">
        <label class="s5label">テキスト位置</label>
        <select id="s5-pos" class="s5input">
          <option value="left">左寄せ</option>
          <option value="center">センター</option>
        </select>
      </div>
    </div>
  </div>

  <!-- 結果 -->
  <div class="s5card" id="s5-result-card" style="display:none;">
    <strong style="color:var(--c); font-size:13px; display:block; margin-bottom:10px;">完成サムネ</strong>
    <img id="s5-result-img" style="width:100%; border-radius:6px; border:2px solid var(--c);" alt="">
    <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
      <button onclick="s5AdoptThumb()" class="s5btn" style="flex:1;">✅ このサムネを採用してStep6へ</button>
      <button onclick="s5GenBg()" class="s5btn-sub" style="flex:1;">↻ A/Bを再生成</button>
    </div>
  </div>
</div>

<script>
(function() {
  if (window.__s5Init) return; window.__s5Init = true;

  const STATE = { selectedFacePath: null, faceImages: [], bgLocalPath: null, selectedThumb: null };
  const _v  = id => (document.getElementById(id) || {}).value?.trim() || '';
  const _el = id => document.getElementById(id);
  const _pid = () => window.APP && window.APP.selected ? window.APP.selected.id : null;

  window.step5Init = async function() {
    const post = window.APP && window.APP.selected;
    _el('s5-postlabel').textContent = post ? '案件: ' + (post.title || post.id) : '案件未選択';
    STATE.selectedFacePath = STATE.bgLocalPath = STATE.selectedThumb = null;
    STATE.faceImages = [];
    ['s5-bg-card','s5-text-card','s5-result-card'].forEach(id => _el(id).style.display = 'none');
    _el('s5-face-grid').innerHTML = '';
    _el('s5-face-status').textContent = '';
    _el('s5-scene').value = '';
    _el('s5-scene-presets').innerHTML = '';
    if (post) {
      // 顔スコアリングを待たずに、案件に沿ったシーン案を先に用意する
      _loadScenePresets(post.id);
      try {
        const m = await window.fetchJson('/api/v6/get-meta?postId=' + encodeURIComponent(post.id));
        if (m.selectedThumb) {
          STATE.selectedThumb = m.selectedThumb;
          _el('s5-selected-status').textContent = '✅ 選択中: ' + m.selectedThumb;
        }
      } catch (_) {}
    }
  };

  // プリセット提案を非同期で取得・表示
  async function _loadScenePresets(id) {
    const box = _el('s5-scene-presets');
    if (!box) return;
    box.innerHTML = '<span style="font-size:10px;color:var(--muted);">AIがシーン案を考え中...</span>';
    try {
      const r = await window.fetchJson('/api/v5/suggest-bg-prompts', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id }),
      });
      const prompts = r.prompts || [];
      if (!prompts.length) {
        box.innerHTML = '<span style="font-size:10px;color:#f59e0b;">シーン案を生成できませんでした。再読み込みしてください。</span>';
        return;
      }
      // 案件変更前の古い提案を残さず、最新案件の1件目を自動入力
      const sceneEl = _el('s5-scene');
      if (sceneEl && prompts[0]) sceneEl.value = prompts[0];
      box.innerHTML = prompts.map(p => \`
        <button onclick="_s5UsePreset(this.dataset.p)" data-p="\${p.replace(/"/g,'&quot;')}"
          style="font-size:10px;background:#0a0e1a;border:1px solid var(--border);
                 border-radius:4px;padding:4px 8px;cursor:pointer;color:var(--muted);
                 text-align:left;max-width:100%;"
          onmouseover="this.style.borderColor='var(--c)'"
          onmouseout="this.style.borderColor='var(--border)'">\${p}</button>
      \`).join('');
    } catch(e) {
      box.innerHTML = '<span style="font-size:10px;color:#ef4444;">シーン案エラー: ' + e.message + '</span>';
    }
  }
  window._s5UsePreset = p => { const el = _el('s5-scene'); if (el) el.value = p; };

  // ① 顔スコアリング
  window.s5RunFaceScore = async function() {
    const id = _pid(); if (!id) { alert('案件を選択してください'); return; }
    const btn = _el('s5-face-btn'); btn.disabled = true;
    _el('s5-face-status').textContent = '⏳ Gemini Vision でスコアリング中...';
    _el('s5-face-grid').innerHTML = '';
    _el('s5-bg-card').style.display = 'none';
    try {
      const r = await window.fetchJson('/api/v5/face-score', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id }),
      });
      const imgs = r.images || [];
      STATE.faceImages = imgs;
      if (!imgs.length) { _el('s5-face-status').textContent = '画像なし（images/{postId}/ を確認）'; return; }
      _el('s5-face-status').textContent = imgs.length + ' 枚スコア完了 — 顔をクリックして選択';
      _el('s5-face-grid').innerHTML = imgs.map(img => \`
        <div class="s5face-card" onclick="s5SelectFace('\${img.localPath}','\${img.url}',this)">
          <img src="\${img.url}" loading="lazy" alt="">
          <div class="s5score">\${img.source==='official_stock'?'公式リーグ':img.source==='other_stock'?'ストック':'X'}　★\${img.score} \${img.faceSize||''} \${img.clarity||''}</div>
        </div>
      \`).join('');
      // 最高スコアを自動選択
      const first = _el('s5-face-grid').querySelector('.s5face-card');
      if (first) first.click();
    } catch(e) {
      _el('s5-face-status').textContent = 'エラー: ' + e.message;
    } finally { btn.disabled = false; }
  };

  window.s5SelectFace = function(localPath, url, card) {
    STATE.selectedFacePath = localPath;
    document.querySelectorAll('.s5face-card').forEach(c => c.classList.remove('selected'));
    if (card) card.classList.add('selected');
    _el('s5-face-selected').src = url;
    _el('s5-bg-card').style.display = '';
    _el('s5-bg-card').scrollIntoView({ behavior:'smooth', block:'start' });
  };

  // ② 背景生成
  window.s5GenBg = async function() {
    if (!STATE.selectedFacePath) { alert('顔画像を選んでください'); return; }
    const scene = _v('s5-scene');
    if (!scene) { alert('シーン説明を入力してください'); return; }
    const main = _v('s5-main');
    if (!main) { alert('メイン文字を入力してください'); return; }
    const btn = _el('s5-bg-btn'); btn.disabled = true;
    _el('s5-bg-status').textContent = '⏳ Gemini 3.1 Flashでテキスト込みA/B生成中...（30〜120秒）';
    _el('s5-bg-preview').innerHTML = '';
    _el('s5-text-card').style.display = 'none';
    try {
      const r = await window.fetchJson('/api/v5/gen-bg-from-face', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          localPath: STATE.selectedFacePath,
          referencePaths: STATE.faceImages.map(x => x.localPath).filter(Boolean).slice(0, 3),
          sceneDesc: scene,
          postId: _pid() || 'thumb',
          ctx: _v('s5-ctx'),
          main,
          punch: _v('s5-punch'),
          badge: _v('s5-badge'),
        }),
      });
      const results = r.results || [];
      if (!results.length) throw new Error('生成画像がありません');
      STATE.bgLocalPath = null;
      _el('s5-bg-preview').innerHTML = \`
        <div style="font-size:10px;color:var(--muted);margin-bottom:6px;">採用する案をクリックしてください</div>
        <div class="s5variant-grid">
          \${results.map((item, i) => \`
            <div class="s5variant" onclick="s5SelectVariant('\${item.localPath}','\${item.url}','\${item.file}',this)">
              <img src="\${item.url}" alt="案\${item.variant}">
              <div class="s5variant-label">案\${item.variant}　\${i===0?'右主役＋左テキスト':'斜め対立＋テキスト'}</div>
            </div>
          \`).join('')}
        </div>
      \`;
      const yen = Math.round(Number(r.estimatedCostUsd || 0) * 150);
      _el('s5-bg-status').textContent = '✅ 2案完成' + (yen ? '（約¥' + yen + '）' : '') + ' → 1案選択';
    } catch(e) {
      _el('s5-bg-status').textContent = 'エラー: ' + e.message;
    } finally { btn.disabled = false; }
  };

  window.s5SelectVariant = function(localPath, url, file, card) {
    STATE.bgLocalPath = localPath;
    STATE.selectedThumb = file;
    document.querySelectorAll('.s5variant').forEach(c => c.classList.remove('selected'));
    if (card) card.classList.add('selected');
    _el('s5-bg-status').textContent = '✅ テキスト込み完成サムネを選択済み';
    _el('s5-result-img').src = url + '?t=' + Date.now();
    _el('s5-result-card').style.display = '';
    _el('s5-result-card').scrollIntoView({ behavior:'smooth', block:'start' });
  };

  // ③ SVG合成
  window.s5GenFinal = async function() {
    if (!STATE.bgLocalPath) { alert('先に背景を生成してください'); return; }
    const main = _v('s5-main'); if (!main) { alert('メイン文字を入力してください'); return; }
    const btn = _el('s5-final-btn'); btn.disabled = true;
    _el('s5-final-status').textContent = '⏳ SVG合成中...';
    _el('s5-result-card').style.display = 'none';
    try {
      const r = await window.fetchJson('/api/v5/composite-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          postId: _pid() || 'thumb',
          bgLocalPath: STATE.bgLocalPath,
          ctx:   _v('s5-ctx'),   main,
          punch: _v('s5-punch'), badge: _v('s5-badge'),
          style: _v('s5-style') || 'gold',
          pos:   _v('s5-pos')   || 'left',
        }),
      });
      STATE.selectedThumb = r.file;
      _el('s5-result-img').src = r.url + '?t=' + Date.now();
      _el('s5-result-card').style.display = '';
      _el('s5-result-card').scrollIntoView({ behavior:'smooth', block:'start' });
      _el('s5-final-status').textContent = '✅ 完成！';
    } catch(e) {
      _el('s5-final-status').textContent = 'エラー: ' + e.message;
    } finally { btn.disabled = false; }
  };

  window.s5AdoptThumb = async function() {
    if (!STATE.selectedThumb) return;
    const id = _pid();
    if (id) {
      await window.fetchJson('/api/v5/select-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId:id, thumbFile:STATE.selectedThumb }),
      });
    }
    _el('s5-selected-status').textContent = '✅ 採用: ' + STATE.selectedThumb;
    _el('s5-selected-status').style.color = 'var(--success, #22c55e)';
    if (window.goStep) window.goStep(6);
  };
})();
</script>
`;
}


module.exports = { router, getUI };
