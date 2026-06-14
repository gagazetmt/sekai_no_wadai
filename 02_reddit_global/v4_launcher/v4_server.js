// v4_launcher/v4_server.js
// V4ランチャー Expressサーバー（port 3005）
//   GET  /                        → UI
//   POST /api/scout               → ニューススカウト実行
//   GET  /api/scout/latest        → 最新スカウト結果
//   POST /api/neta                → ネタブック生成
//   POST /api/video               → 動画生成
//   GET  /api/video/status/:jobId → 動画生成状況
'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { createJob, readJob, updateJob } = require('../routes/_job_helper');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { runScout, SCOUT_FILE }                       = require('./scripts/v4_scout');
const { buildNetaBook, getCachedBook, getWarehousePath } = require('./scripts/v4_neta');
const { buildModules, generateV4Video }              = require('./scripts/v4_video');
const { fetchBookAssets }                            = require('./scripts/v4_assets');
const {
  matchPlayers,
  matchManagers,
  matchClubs,
} = require('../scripts/modules/stock_match');

const app  = express();
const PORT = process.env.V4_PORT || 3005;
const CLIENT_VERSION = '20260614-6';
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, version: CLIENT_VERSION, port: Number(PORT) });
});
// 動画・画像を V2 インフラと共有
app.use('/v2_videos',    express.static(path.join(__dirname, '..', 'data', 'v2_videos')));
app.use('/images_stock', express.static(path.join(__dirname, '..', 'images_stock')));

const slideBuilders = (() => {
  const opV1 = require('../scripts/v2_video/slides/opening').buildOpeningHTML;
  const opV2 = require('../scripts/v2_video/slides/opening_v2').buildOpeningHTML;
  const opV3 = require('../scripts/v2_video/slides/opening_v3').buildOpeningHTML;
  const edV1 = require('../scripts/v2_video/slides/ending').buildEndingHTML;
  const edV2 = require('../scripts/v2_video/slides/ending_v2').buildEndingHTML;
  const edV3 = require('../scripts/v2_video/slides/ending_v3').buildEndingHTML;
  return {
    opening: { v1: opV1, v2: opV2, v3: opV3 },
    ending: { v1: edV1, v2: edV2, v3: edV3 },
    universal: require('../scripts/v2_video/slides/universal').buildUniversalHTML,
    insight: require('../scripts/v2_video/slides/insight').buildInsightHTML,
    history: require('../scripts/v2_video/slides/history').buildHistoryHTML,
    matchcard: require('../scripts/v2_video/slides/matchcard').buildMatchcardHTML,
    profile: require('../scripts/v2_video/slides/profile').buildProfileHTML,
    stats: require('../scripts/v2_video/slides/stats').buildStatsHTML,
    comparison: require('../scripts/v2_video/slides/comparison').buildComparisonHTML,
    reaction: require('../scripts/v2_video/slides/reaction').buildReactionHTML,
    toc: require('../scripts/v2_video/slides/toc').buildTocHTML,
    ranking: require('../scripts/v2_video/slides/ranking').buildRankingHTML,
    timeline: require('../scripts/v2_video/slides/timeline').buildTimelineHTML,
    picture: require('../scripts/v2_video/slides/picture').buildPictureHTML,
    mapPreview: require('../scripts/v2_video/slides/_common').mapImagesToModulePreview,
  };
})();

function buildSlidePreview(module) {
  const m = slideBuilders.mapPreview(module);
  const variant = String(m.variant || 'v1');
  if (m.type === 'opening') {
    return (slideBuilders.opening[variant] || slideBuilders.opening.v1)(m);
  }
  if (m.type === 'ending') {
    return (slideBuilders.ending[variant] || slideBuilders.ending.v1)(m);
  }
  return (slideBuilders[m.type] || slideBuilders.universal)(m);
}

// ── ① スカウト実行 ──────────────────────────────────────────
app.post('/api/scout', (req, res) => {
  const jobId = createJob('sc4', { kind: 'v4-scout', step: 'running' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      updateJob(jobId, { status: 'running', message: 'X / Yahoo / Reddit を収集中...' });
      const topics = await runScout({ perSource: 5 });
      updateJob(jobId, { status: 'done', topics });
    } catch (e) {
      console.error('[v4/scout]', e.message);
      updateJob(jobId, { status: 'error', error: e.message });
    }
  });
});

app.get('/api/scout/status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

app.get('/api/scout/latest', (req, res) => {
  try {
    if (!fs.existsSync(SCOUT_FILE)) return res.json({ topics: [], scoutedAt: null });
    res.json(JSON.parse(fs.readFileSync(SCOUT_FILE, 'utf8')));
  } catch (_) { res.json({ topics: [], scoutedAt: null }); }
});

// ── ② コメント倉庫取得 ───────────────────────────────────────
app.get('/api/neta/warehouse', (req, res) => {
  const { topic } = req.query;
  if (!topic) return res.json({ total: 0, reddit: [], yahoo: [], x: [] });
  try {
    const p = getWarehousePath(topic);
    if (!fs.existsSync(p)) return res.json({ total: 0, reddit: [], yahoo: [], x: [] });
    res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (_) { res.json({ total: 0, reddit: [], yahoo: [], x: [] }); }
});

// ── ② 画像ギャラリー ─────────────────────────────────────────
app.get('/api/neta/images', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, images: [] });
  try {
    const images = [
      ...matchPlayers(q, { limit: 8, threshold: 78 }),
      ...matchManagers(q, { limit: 4, threshold: 78 }),
      ...matchClubs(q, { limit: 6, threshold: 75 }),
    ];
    const seen = new Set();
    const unique = images.filter((image) => {
      if (!image?.url || seen.has(image.url)) return false;
      seen.add(image.url);
      return true;
    }).slice(0, 24);
    res.json({ ok: true, images: unique });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, images: [] });
  }
});

app.post('/api/neta/assets', async (req, res) => {
  const { book } = req.body || {};
  if (!book?.mainEntity) return res.status(400).json({ ok: false, error: 'mainEntity required' });
  try {
    res.json(await fetchBookAssets(book));
  } catch (e) {
    console.error('[v4/assets]', e);
    res.status(500).json({ ok: false, error: e.message, labels: [], dataRows: [], images: [] });
  }
});

// ── ③ 動画生成前の確認 ───────────────────────────────────────
app.post('/api/confirm/modules', (req, res) => {
  const { book } = req.body || {};
  if (!book?.topic) return res.status(400).json({ error: 'book required' });
  try {
    res.json({ ok: true, modules: buildModules(book) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/confirm/preview', (req, res) => {
  const { module } = req.body || {};
  if (!module) return res.status(400).send('<!doctype html><body>module required</body>');
  try {
    const origin = req.protocol + '://' + req.get('host');
    let html = buildSlidePreview(module);
    html = html.replace('<head>', `<head><base href="${origin}/">`);
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send(`<!doctype html><body>${String(e.message)}</body>`);
  }
});

app.get('/api/confirm/tts-presets', (req, res) => {
  try {
    const tts = require('../scripts/v2_video/tts_engine');
    const d = tts.getDefaults(req.query.provider || tts.DEFAULT_PROVIDER);
    res.json({
      ok: true,
      provider: d.provider,
      providers: tts.PRESET_PROVIDERS,
      voices: d.presetVoices,
      models: d.presetModels,
      defaultVoice: d.voice,
      defaultModel: d.model,
      emotions: d.emotions || [],
      styleInstructions: d.styleInstructions || '',
      supports: d.supports,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/confirm/tts-preview', (req, res) => {
  const { text } = req.body || {};
  if (!String(text || '').trim()) return res.status(400).json({ error: 'text required' });
  const jobId = createJob('tp4', { kind: 'v4-tts-preview', step: 'running' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    const audioDir = path.join(__dirname, '..', 'data', 'v2_audio');
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
    const tempPath = path.join(
      audioDir,
      `_v4_preview_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`,
    );
    try {
      const tts = require('../scripts/v2_video/tts_engine');
      await tts.generate({
        ...req.body,
        text: String(text).slice(0, 800),
        outputPath: tempPath,
      });
      const base64 = fs.readFileSync(tempPath).toString('base64');
      updateJob(jobId, { status: 'done', result: { ok: true, mime: 'audio/mpeg', base64 } });
    } catch (e) {
      updateJob(jobId, { status: 'error', error: e.message });
    } finally {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  });
});

app.get('/api/confirm/tts-preview-status', (req, res) => {
  const job = readJob(req.query.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

// ── ② ネタブック（キャッシュ確認）──────────────────────────────
app.get('/api/neta/cached', (req, res) => {
  const { topic } = req.query;
  if (!topic) return res.json({ cached: false });
  const book = getCachedBook(topic);
  if (book) return res.json({ cached: true, book });
  res.json({ cached: false });
});

// ── ② ネタブック生成 ─────────────────────────────────────────
// force=true → キャッシュ無視して再生成
app.post('/api/neta', (req, res) => {
  const { topic, hook, url, force } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic required' });
  const jobId = createJob('nb4', { kind: 'v4-neta', step: 'running' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      updateJob(jobId, { status: 'running', message: '記事収集・ネタブック生成中...' });
      const book = await buildNetaBook({ topic, hook, url }, { force: !!force });
      updateJob(jobId, { status: 'done', book });
    } catch (e) {
      console.error('[v4/neta]', e.message);
      updateJob(jobId, { status: 'error', error: e.message });
    }
  });
});

app.get('/api/neta/status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

// ── ③ 動画生成 ──────────────────────────────────────────────
app.post('/api/video', (req, res) => {
  const { book, modules } = req.body || {};
  if (!book?.topic) return res.status(400).json({ error: 'book required' });
  const jobId = createJob('vd4', { kind: 'v4-video', step: 'running' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      updateJob(jobId, { status: 'running', message: 'TTS・動画生成中...' });
      const result = await generateV4Video(book, modules);
      updateJob(jobId, { status: 'done', result });
    } catch (e) {
      console.error('[v4/video]', e.message);
      updateJob(jobId, { status: 'error', error: e.message });
    }
  });
});

app.get('/api/video/status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

// ── ④ 完全自動: (スカウト→)ネタブック→動画 ─────────────────
//   body.topic あり → その案件で neta→video
//   body.topic なし → スカウト実行 → トップ案件で neta→video
app.post('/api/fullauto', (req, res) => {
  const { topic, hook, url } = req.body || {};
  const jobId = createJob('fa4', { kind: 'v4-fullauto', step: 'running' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      let t = topic ? { topic, hook: hook || '', url: url || '' } : null;

      if (!t) {
        updateJob(jobId, { status: 'running', stage: 'scout', message: 'X / Yahoo / Reddit / 5ch をスカウト中...' });
        const topics = await runScout({ perSource: 5 });
        if (!topics?.length) throw new Error('スカウト結果が0件でした');
        t = topics[0];  // 最高スコア案件を自動採用
        updateJob(jobId, { status: 'running', stage: 'scout', message: `案件決定: ${t.topic}`, topic: t.topic });
      }

      updateJob(jobId, { status: 'running', stage: 'neta', message: `ネタブック生成中: ${t.topic}`, topic: t.topic });
      const book = await buildNetaBook({ topic: t.topic, hook: t.hook, url: t.url });

      updateJob(jobId, { status: 'running', stage: 'video', message: 'TTS・スライド・動画合成中...', topic: t.topic, book });
      const result = await generateV4Video(book);

      updateJob(jobId, { status: 'done', stage: 'done', message: '完成', topic: t.topic, book, result });
    } catch (e) {
      console.error('[v4/fullauto]', e.message);
      updateJob(jobId, { status: 'error', error: e.message });
    }
  });
});

app.get('/api/fullauto/status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

// ── 起動 ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 V4ランチャー起動: http://localhost:${PORT}`));
module.exports = app;
