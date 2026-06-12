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

const { runScout, SCOUT_FILE }   = require('./scripts/v4_scout');
const { buildNetaBook, getCachedBook } = require('./scripts/v4_neta');
const { generateV4Video }        = require('./scripts/v4_video');

const app  = express();
const PORT = process.env.V4_PORT || 3005;
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 動画・画像を V2 インフラと共有
app.use('/v2_videos',    express.static(path.join(__dirname, '..', 'data', 'v2_videos')));
app.use('/images_stock', express.static(path.join(__dirname, '..', 'images_stock')));

// ── ① スカウト実行 ──────────────────────────────────────────
app.post('/api/scout', (req, res) => {
  const jobId = createJob('sc4', { kind: 'v4-scout', step: 'running' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      updateJob(jobId, { status: 'running', message: 'X / Yahoo / Reddit を収集中...' });
      const topics = await runScout({ maxTopics: 7 });
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
  const { book } = req.body || {};
  if (!book?.topic) return res.status(400).json({ error: 'book required' });
  const jobId = createJob('vd4', { kind: 'v4-video', step: 'running' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      updateJob(jobId, { status: 'running', message: 'TTS・動画生成中...' });
      const result = await generateV4Video(book);
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

// ── 起動 ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 V4ランチャー起動: http://localhost:${PORT}`));
module.exports = app;
