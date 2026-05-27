// v3_launcher/server.js
// Standalone V3 prototype launcher. It intentionally does not modify V2.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createArgumentPlan } = require('./v3_story_architect');
const { runTopicResearch, fetchWikiSideStories } = require('./v3_research');
const { generateAIPlan } = require('./v3_planner');

const app = express();
const PORT = Number(process.env.V3_LAUNCHER_PORT || 3005);
const UI_VERSION = 'v3-ui-human-pipeline';
// Keep prototype output inside v3_launcher so V2 data directories stay untouched.
const DATA_DIR = path.join(__dirname, 'data', 'argument_plans');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use((_, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.json({ limit: '5mb' }));

function safeId(value) {
  return String(value || 'untitled')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'untitled';
}

app.get('/api/v3/health', (_, res) => {
  res.json({ ok: true, name: 'v3-launcher-prototype', port: PORT });
});

app.post('/api/v3/argument-plan', (req, res) => {
  try {
    const plan = createArgumentPlan(req.body || {});
    res.json({ success: true, plan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/argument-plan/save', (req, res) => {
  try {
    const plan = req.body?.plan;
    if (!plan) return res.status(400).json({ success: false, error: 'plan is required' });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeId(plan.topic)}`;
    const filePath = path.join(DATA_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(plan, null, 2));
    res.json({ success: true, id, filePath });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/research/topic', async (req, res) => {
  try {
    const result = await runTopicResearch(req.body || {});
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/research/wiki-side-stories', async (req, res) => {
  try {
    const result = await fetchWikiSideStories(req.body || {});
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/analyze', async (req, res) => {
  try {
    const { topic, memo, researchCorpus, wikiStories } = req.body || {};
    const result = await generateAIPlan(topic, memo, researchCorpus, wikiStories);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/v3/argument-plans', (_, res) => {
  const items = fs.readdirSync(DATA_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 50)
    .map((name) => {
      const filePath = path.join(DATA_DIR, name);
      try {
        const plan = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
          id: name.replace(/\.json$/, ''),
          file: name,
          topic: plan.topic,
          centralQuestion: plan.centralQuestion,
          thesis: plan.thesis,
          createdAt: plan.createdAt,
        };
      } catch (_) {
        return { id: name, file: name, topic: 'parse error' };
      }
    });
  res.json({ items });
});

app.get('/', (_, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V3 Story Architect</title>
<style>
:root {
  --bg: #0b0d12;
  --panel: #151922;
  --panel2: #1d2430;
  --line: #303846;
  --text: #eef2f7;
  --muted: #94a3b8;
  --gold: #f2b84b;
  --red: #ef4444;
  --green: #22c55e;
  --blue: #60a5fa;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif;
}
header {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 22px;
  border-bottom: 1px solid var(--line);
  background: #10141c;
}
h1 { font-size: 18px; margin: 0; color: var(--gold); }
.tag { color: var(--muted); font-size: 12px; }
.version-badge {
  display: inline-flex;
  margin-top: 6px;
  color: #111827;
  background: var(--gold);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 900;
}
main {
  display: grid;
  grid-template-columns: 360px 1fr;
  height: calc(100vh - 60px);
  min-height: 680px;
}
aside {
  border-right: 1px solid var(--line);
  background: #0f1219;
  padding: 16px;
  overflow: auto;
}
.workspace {
  padding: 18px;
  overflow: auto;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 14px;
}
.label {
  display: block;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  margin-bottom: 8px;
}
input, textarea {
  width: 100%;
  background: #0a0d12;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  font: inherit;
  font-size: 13px;
}
textarea { min-height: 170px; resize: vertical; line-height: 1.55; }
button {
  border: 0;
  border-radius: 6px;
  background: var(--gold);
  color: #111827;
  padding: 10px 12px;
  font-weight: 900;
  cursor: pointer;
}
button.secondary { background: #263142; color: var(--text); border: 1px solid var(--line); }
button:disabled { opacity: .55; cursor: wait; }
.btnrow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.summary h2, .summary p { margin: 0; }
.summary h2 { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.summary p { font-size: 15px; line-height: 1.5; }
.toc {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.toc span {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-left: 4px solid var(--gold);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
}
.human-brief {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.mobile-brief {
  display: none;
}
.mobile-inline-result {
  display: none;
}
.brief-editor {
  display: grid;
  gap: 10px;
}
.brief-editor textarea {
  min-height: 72px;
}
.brief-editor .short {
  min-height: 52px;
}
.brief-card {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
}
.brief-card.wide { grid-column: 1 / -1; }
.brief-card h2 {
  margin: 0 0 8px;
  color: var(--gold);
  font-size: 13px;
}
.brief-card p {
  margin: 0;
  color: #e5e7eb;
  font-size: 15px;
  line-height: 1.55;
}
.view-tabs {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.view-tab {
  background: #263142;
  color: var(--text);
  border: 1px solid var(--line);
}
.view-tab.active {
  background: var(--gold);
  color: #111827;
}
.view-panel { display: none; }
.view-panel.active { display: block; }
.chapter-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.chapter-seed {
  border-left: 4px solid var(--blue);
  background: #111827;
  padding: 10px;
  border-radius: 6px;
}
.chapter-seed b { color: var(--text); font-size: 13px; }
.chapter-seed span { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.45; }
.argument-boxes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.argument-box {
  background: #0b1220;
  border: 1px solid #334155;
  border-left: 6px solid var(--blue);
  border-radius: 8px;
  padding: 12px;
}
.argument-box .arg-label {
  display: inline-flex;
  align-items: center;
  background: rgba(96, 165, 250, .18);
  color: #bfdbfe;
  border: 1px solid rgba(96, 165, 250, .45);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 900;
  margin-bottom: 8px;
}
.argument-box h3 {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--text);
}
.argument-box p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.beat {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 12px;
  padding: 12px;
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-bottom: 10px;
}
.role {
  color: #111827;
  background: var(--blue);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 900;
  text-transform: uppercase;
}
.beat h3 { margin: 0 0 8px; font-size: 15px; }
.beat p { margin: 0 0 8px; color: #cbd5e1; line-height: 1.5; font-size: 13px; }
.slide-list {
  display: grid;
  gap: 8px;
}
.slide-row {
  display: grid;
  grid-template-columns: 54px 1fr;
  gap: 10px;
  align-items: start;
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
}
.slide-no {
  color: #111827;
  background: var(--gold);
  border-radius: 5px;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 900;
}
.slide-row h3 { margin: 0 0 5px; font-size: 14px; }
.slide-row p { margin: 0 0 7px; color: #cbd5e1; font-size: 12px; line-height: 1.45; }
.slide-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 7px;
}
.meta-pill {
  border: 1px solid var(--line);
  background: #111827;
  color: #dbeafe;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}
.meta-pill.new { color: #fde68a; border-color: rgba(242,184,75,.55); }
.data-reqs {
  display: grid;
  gap: 6px;
}
.data-req {
  border: 1px solid var(--line);
  background: #111827;
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  line-height: 1.45;
}
.data-req b { color: var(--text); }
.data-req span { display: block; color: var(--muted); margin-top: 3px; }
.autopilot-grid {
  display: grid;
  grid-template-columns: 1.1fr .9fr;
  gap: 10px;
}
.autopilot-card {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
}
.autopilot-card h2 {
  margin: 0 0 8px;
  color: var(--gold);
  font-size: 13px;
}
.autopilot-card p {
  margin: 0;
  color: #e5e7eb;
  font-size: 14px;
  line-height: 1.55;
}
.script-list {
  display: grid;
  gap: 10px;
}
.script-card {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-left: 5px solid var(--gold);
  border-radius: 8px;
  padding: 12px;
}
.script-card h3 {
  margin: 0 0 7px;
  font-size: 14px;
}
.script-card p {
  margin: 0 0 7px;
  color: #dbeafe;
  font-size: 13px;
  line-height: 1.55;
}
.pipeline-steps {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.pipeline-step {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
}
.pipeline-step b {
  display: block;
  color: var(--gold);
  font-size: 12px;
  margin-bottom: 4px;
}
.pipeline-step span {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
}
.flow-list {
  display: grid;
  gap: 8px;
}
.flow-item {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
}
.flow-item b { color: var(--gold); }
.flow-item p {
  margin: 5px 0 0;
  color: #dbeafe;
  font-size: 13px;
  line-height: 1.5;
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  border: 1px solid var(--line);
  background: #0a0d12;
  color: #cbd5e1;
  border-radius: 999px;
  padding: 4px 8px;
  font-size: 11px;
}
.risk { color: #fecaca; border-color: rgba(239,68,68,.45); }
.research {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  font-size: 11px;
  color: #cbd5e1;
  line-height: 1.45;
}
.research b { color: var(--gold); }
.empty {
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 28px;
  text-align: center;
}
pre {
  white-space: pre-wrap;
  background: #07090d;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  overflow: auto;
  font-size: 12px;
  max-height: 420px;
}
@media (max-width: 1080px) {
  main { grid-template-columns: 1fr; height: auto; }
  aside { border-right: 0; border-bottom: 1px solid var(--line); }
  .summary-grid { grid-template-columns: 1fr; }
  .human-brief { grid-template-columns: 1fr; }
  .chapter-list { grid-template-columns: 1fr; }
  .beat { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  header {
    height: auto;
    align-items: flex-start;
    gap: 6px;
    flex-direction: column;
    padding: 12px 14px;
  }
  h1 { font-size: 16px; }
  .tag { font-size: 11px; }
  main { min-height: 0; }
  aside { padding: 10px; }
  .workspace { padding: 10px; }
  .panel { padding: 10px; margin-bottom: 10px; border-radius: 6px; }
  textarea { min-height: 120px; }
  .btnrow { grid-template-columns: 1fr 1fr; }
  button { min-height: 42px; }
  .mobile-brief {
    display: block;
    border: 2px solid var(--gold);
    background: #111827;
  }
  .mobile-inline-result {
    display: block;
  }
  .mobile-brief h2 {
    margin: 0 0 6px;
    color: var(--gold);
    font-size: 13px;
  }
  .mobile-brief p {
    margin: 0 0 10px;
    line-height: 1.55;
    font-size: 14px;
  }
  .mobile-brief ol {
    margin: 0;
    padding-left: 18px;
    color: #dbeafe;
    font-size: 13px;
    line-height: 1.5;
  }
  .brief-card p { font-size: 14px; }
  .chapter-seed { padding: 8px; }
  .argument-boxes { grid-template-columns: 1fr; }
  .argument-box { padding: 12px; border-left-width: 5px; }
  .argument-box .arg-label { font-size: 12px; }
  .argument-box h3 { font-size: 15px; }
  .argument-box p { font-size: 13px; }
  .beat { padding: 10px; gap: 8px; }
  .view-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .autopilot-grid { grid-template-columns: 1fr; }
  .pipeline-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
</head>
<body>
<header>
  <div>
    <h1>V3 Story Architect</h1>
    <span class="version-badge">${UI_VERSION}</span>
  </div>
  <div class="tag">V2 preserved / argumentPlan prototype / port ${PORT}</div>
</header>
<main>
  <aside>
    <div class="panel">
      <span class="label">ブリーフ微調整</span>
      <div class="brief-editor">
        <label class="label" for="briefCore">核心</label>
        <textarea id="briefCore" class="short"></textarea>
        <label class="label" for="briefAnswer">答え</label>
        <textarea id="briefAnswer" class="short"></textarea>
        <label class="label" for="briefPoints">論点</label>
        <textarea id="briefPoints"></textarea>
        <label class="label" for="briefCautions">注意点</label>
        <textarea id="briefCautions" class="short"></textarea>
      </div>
    </div>
    <div class="panel">
      <label class="label" for="title">動画トピック</label>
      <input id="title" value="スペイン代表、レアル・マドリー所属選手0人">
      <label class="label" for="memo" style="margin-top:12px;">相棒メモ・入れたい小話</label>
      <textarea id="memo">なぜ？
2010年は二大クラブが代表の背骨だった
バルサは若いスペイン代表の顔を抱えている
マドリーは世界最高級の完成済みタレントを外から集めている
ただし育成失敗とは断定しない
ペドリとラウールの扱いに注意</textarea>
      <div class="btnrow">
        <button id="generateBtn" onclick="generatePlan()">案件を整理</button>
        <button class="secondary" id="researchBtn" onclick="runResearch()">リサーチ</button>
        <button class="secondary" id="analyzeBtn" onclick="runAnalysis()">AIで分析</button>
        <button class="secondary" onclick="savePlan()">保存</button>
      </div>
    </div>
    <div class="panel">
      <span class="label">この段階で確認すること</span>
      <div class="chips">
        <span class="chip">中心問い</span>
        <span class="chip">仮結論</span>
        <span class="chip">beat順</span>
        <span class="chip">必要証拠</span>
        <span class="chip">危険な断定</span>
        <span class="chip">小話候補</span>
      </div>
    </div>
    <div class="panel">
      <span class="label">保存済み</span>
      <div id="savedPlans" class="empty">未読込</div>
    </div>
  </aside>
  <section class="workspace">
    <div id="output" class="empty">左の「設計する」で、V3用 argumentPlan を生成する。</div>
  </section>
</main>
<script>
let currentPlan = null;
let currentResearch = null;
let currentWikiStories = null;
let currentAIPlan = null;
let activeView = 'case';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readBriefEditor() {
  return {
    core: document.getElementById('briefCore')?.value || '',
    answer: document.getElementById('briefAnswer')?.value || '',
    points: document.getElementById('briefPoints')?.value || '',
    cautions: document.getElementById('briefCautions')?.value || '',
  };
}

function fillBriefEditor(plan) {
  const brief = plan.humanBrief || {};
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el && !el.value.trim()) el.value = value || '';
  };
  set('briefCore', brief.core || plan.centralQuestion || '');
  set('briefAnswer', brief.answer || plan.thesis || '');
  set('briefPoints', (brief.structure || []).map((x, i) => '論点' + (i + 1) + ': ' + (x.point || x.label || '')).join('\\n'));
  set('briefCautions', (brief.cautions || plan.globalRiskChecks || []).join('\\n'));
}

async function generatePlan(opts = {}) {
  const shouldScroll = opts.scroll !== false;
  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.textContent = '設計中...';
  try {
    const res = await fetch('/api/v3/argument-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: document.getElementById('title').value,
        memo: document.getElementById('memo').value,
        brief: readBriefEditor(),
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'failed');
    currentPlan = data.plan;
    fillBriefEditor(currentPlan);
    renderPlan(currentPlan);
    const target = document.getElementById('resultTop');
    if (shouldScroll) target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    document.getElementById('output').innerHTML = '<div class="empty">生成失敗: ' + esc(error.message) + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '設計する';
  }
}

async function savePlan() {
  if (!currentPlan) return alert('先に設計してね');
  const res = await fetch('/api/v3/argument-plan/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: currentPlan }),
  });
  const data = await res.json();
  if (!data.success) return alert(data.error || '保存失敗');
  await loadSaved();
  alert('保存したよ: ' + data.id);
}

async function runResearch() {
  const btn = document.getElementById('researchBtn');
  btn.disabled = true;
  btn.textContent = 'リサーチ中...';
  try {
    if (!currentPlan) await generatePlan({ scroll: false });
    const baseBody = {
      topic: document.getElementById('title').value,
      memo: document.getElementById('memo').value,
      plan: currentPlan,
    };
    const [topicRes, wikiRes] = await Promise.all([
      fetch('/api/v3/research/topic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseBody),
      }),
      fetch('/api/v3/research/wiki-side-stories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseBody),
      }),
    ]);
    const topicData = await topicRes.json();
    const wikiData = await wikiRes.json();
    if (!topicData.success) throw new Error(topicData.error || 'topic research failed');
    if (!wikiData.success) throw new Error(wikiData.error || 'wiki research failed');
    currentResearch = topicData.result;
    currentWikiStories = wikiData.result;
    if (currentPlan) renderPlan(currentPlan);
    else renderResearchOnly();
    // Auto-trigger AI analysis after research completes
    await runAnalysis();
  } catch (error) {
    alert('リサーチ失敗: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'リサーチ';
  }
}

async function runAnalysis() {
  const btn = document.getElementById('analyzeBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'AI分析中...'; }
  try {
    const res = await fetch('/api/v3/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: document.getElementById('title').value,
        memo: document.getElementById('memo').value,
        researchCorpus: currentResearch,
        wikiStories: currentWikiStories,
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'AI analysis failed');
    currentAIPlan = data.result;
    if (currentPlan) {
      currentPlan.autopilotPlan = buildMergedAutopilotPlan(currentPlan.autopilotPlan, currentAIPlan);
    }
    activeView = 'theme';
    if (currentPlan) renderPlan(currentPlan);
  } catch (error) {
    alert('AI分析失敗: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'AIで再分析'; }
  }
}

function buildMergedAutopilotPlan(base, aiPlan) {
  if (!aiPlan) return base;
  const selectedIdx = aiPlan.themeProposal?.selected || 0;
  const selectedCandidate = (aiPlan.themeProposal?.candidates || [])[selectedIdx] || {};
  return {
    ...base,
    aiGenerated: true,
    articleCount: aiPlan.articleCount || 0,
    themeProposal: {
      ...base?.themeProposal,
      hookQuestion: selectedCandidate.hookQuestion || '',
      answer: selectedCandidate.answer || '',
      angle: selectedCandidate.angle || '',
      candidates: aiPlan.themeProposal?.candidates || [],
      selected: selectedIdx,
      selectedReason: aiPlan.themeProposal?.selectedReason || '',
      rejectedReasons: aiPlan.themeProposal?.rejectedReasons || [],
      dataPlan: (selectedCandidate.dataNeeds || []).map((need, i) => ({ no: i + 1, need })),
    },
    briefing: {
      ...base?.briefing,
      purpose: aiPlan.briefing?.purpose || '',
      coreMessage: aiPlan.briefing?.coreMessage || '',
      chapters: aiPlan.briefing?.chapters || [],
      dataPlan: (aiPlan.briefing?.chapters || [])
        .flatMap((ch) => (ch.dataNeeds || []).map((need) => ({ need })))
        .slice(0, 8),
      riskChecklist: aiPlan.briefing?.riskChecklist || [],
    },
    scriptStructure: aiPlan.scriptStructure?.length ? aiPlan.scriptStructure : (base?.scriptStructure || []),
    scriptDraft: aiPlan.scriptDraft?.length ? aiPlan.scriptDraft : (base?.scriptDraft || []),
    mustCheck: (aiPlan.missingData || []).map((need) => ({ need, query: '', sourcePriority: [] })),
    publishGates: aiPlan.publishGates?.length ? aiPlan.publishGates : (base?.publishGates || []),
  };
}

async function runWikiSideStories() {
  const btn = document.getElementById('wikiBtn');
  btn.disabled = true;
  btn.textContent = '取得中...';
  try {
    const res = await fetch('/api/v3/research/wiki-side-stories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: document.getElementById('title').value,
        memo: document.getElementById('memo').value,
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'failed');
    currentWikiStories = data.result;
    if (currentPlan) renderPlan(currentPlan);
    else renderResearchOnly();
  } catch (error) {
    alert('Wiki小話取得失敗: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '小話Wiki';
  }
}

async function loadSaved() {
  const res = await fetch('/api/v3/argument-plans');
  const data = await res.json();
  const box = document.getElementById('savedPlans');
  if (!data.items.length) {
    box.className = 'empty';
    box.textContent = '保存済みなし';
    return;
  }
  box.className = '';
  box.innerHTML = data.items.map((item) => (
    '<div class="research" style="margin-bottom:8px;">' +
    '<b>' + esc(item.topic) + '</b><br>' +
    esc(item.centralQuestion || '') + '<br>' +
    '<span style="color:var(--muted)">' + esc(item.createdAt || '') + '</span>' +
    '</div>'
  )).join('');
}

function renderPlan(plan) {
  document.getElementById('output').innerHTML = renderResultTabs(plan);
  setResultView(activeView);
}

function setResultView(view) {
  activeView = view;
  document.querySelectorAll('.view-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  document.querySelectorAll('.view-panel').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
}

function renderScriptView(plan) {
  const auto = plan.autopilotPlan || {};
  const script = auto.scriptDraft || [];
  if (!script.length) return '<div class="empty">脚本たたき台はまだありません。</div>';
  return '<span class="label">脚本たたき台。未検証データはあとで差し替える前提</span>' +
    '<div class="script-list">' +
      script.map((item) => (
        '<div class="script-card">' +
          '<div class="slide-meta"><span class="meta-pill">slide ' + esc(item.slideNo) + '</span><span class="meta-pill">' + esc(item.role) + '</span></div>' +
          '<h3>' + esc(item.title) + '</h3>' +
          '<p>' + esc(item.narration) + '</p>' +
          '<div class="chips">' +
            (item.dataNeeds || []).map((x) => '<span class="chip">' + esc(x) + '</span>').join('') +
          '</div>' +
          (item.caution ? '<p style="color:#fecaca;margin-top:8px;">注意: ' + esc(item.caution) + '</p>' : '') +
        '</div>'
      )).join('') +
    '</div>';
}

function renderPipelineSteps() {
  const steps = [
    ['1', '案件', '入力または保存案件を選ぶ'],
    ['2', 'リサーチ', 'Web / SofaScore系 / Wiki候補を集める'],
    ['3', 'テーマ提案', '問い・答え・使うデータを先に決める'],
    ['4', 'ブリーフ', '動画の約束と論点を固定'],
    ['5', '構成', 'スライド順に展開'],
    ['6', '脚本', 'TTS前のたたき台'],
  ];
  return '<div class="pipeline-steps">' + steps.map((s) =>
    '<div class="pipeline-step"><b>' + esc(s[0] + '. ' + s[1]) + '</b><span>' + esc(s[2]) + '</span></div>'
  ).join('') + '</div>';
}

function renderStructureView(plan) {
  const structure = plan.autopilotPlan?.scriptStructure || [];
  return '<span class="label">脚本構成。各スライドで何を見せ、どのデータで支えるか</span>' +
    '<div class="flow-list">' +
      structure.map((item) => (
        '<div class="flow-item"><b>' + esc(item.no + '. ' + item.headline) + '</b><p>' + esc(item.point) + '</p><div class="chips">' +
          (item.dataNeeds || []).map((x) => '<span class="chip">' + esc(x) + '</span>').join('') +
        '</div></div>'
      )).join('') +
    '</div>';
}

function renderResearchOnly() {
  document.getElementById('output').innerHTML = renderResearchPanels() || '<div class="empty">まだリサーチ結果がない。</div>';
}

function renderResearchPanels() {
  let html = '';
  if (currentResearch) {
    html += '<div class="panel"><span class="label">案件リサーチ: 3クエリ → 各3〜5件選抜 → 本文fetch</span>' +
      '<div class="summary-grid">' +
        '<div><h2>Serper推定消費</h2><p>' + esc(currentResearch.serperCreditsEstimated) + ' credits</p></div>' +
        '<div><h2>選抜URL</h2><p>' + esc(currentResearch.summary.selectedUrlCount) + '件 / full text ' + esc(currentResearch.summary.fullTextCount) + '件</p></div>' +
        '<div><h2>検索クエリ</h2><p>' + esc(currentResearch.queries.join(' / ')) + '</p></div>' +
      '</div>' +
      currentResearch.learningCorpus.map((item) => (
        '<div class="research" style="margin-top:10px;">' +
          '<b>[' + esc(item.index) + '] ' + esc(item.title) + '</b><br>' +
          esc(item.host) + ' / score ' + esc(item.score) + ' / ' + esc(item.fetchStatus) + ' / ' + esc(item.usableFor.join(', ')) + '<br>' +
          '<span style="color:var(--muted)">' + esc(item.url) + '</span><br>' +
          esc(String(item.text || '').slice(0, 600)) +
        '</div>'
      )).join('') +
    '</div>';
  }
  if (currentWikiStories) {
    html += '<div class="panel"><span class="label">小話Wiki候補: 主要人物/クラブを最大4件だけ</span>' +
      '<pre>' + esc(JSON.stringify(currentWikiStories, null, 2)) + '</pre>' +
    '</div>';
  }
  return html;
}

function researchStatusLabel() {
  if (currentResearch && currentWikiStories) return '完了: Web / Wiki / side story候補まで取得';
  if (currentResearch) return 'Webリサーチ済み。Wiki候補は未取得';
  return '未実行。まず案件を選んでリサーチ';
}

function researchReadSummary() {
  return {
    webCount: currentResearch?.summary?.selectedUrlCount || 0,
    fullTextCount: currentResearch?.summary?.fullTextCount || 0,
    queries: currentResearch?.queries || [],
    wikiCount: currentWikiStories?.entityCount || 0,
  };
}

function renderSourceSamples() {
  const articles = currentResearch?.learningCorpus || [];
  const wiki = currentWikiStories?.results || [];
  if (!articles.length && !wiki.length) {
    return '<div class="empty">まだ読んだ材料はありません。左の「リサーチ」を押すと、ニュース記事とWiki小話候補をまとめて読みます。</div>';
  }
  return '<div class="flow-list">' +
    articles.slice(0, 6).map((item) => (
      '<div class="flow-item"><b>' + esc(item.title || item.host || 'article') + '</b>' +
      '<p>' + esc((item.host || '') + ' / ' + (item.fetchStatus || '') + ' / score ' + (item.score || '')) + '</p>' +
      '<p>' + esc(String(item.text || '').slice(0, 220)) + '</p></div>'
    )).join('') +
    wiki.slice(0, 4).map((item) => (
      '<div class="flow-item"><b>Wiki: ' + esc(item.entity) + '</b>' +
      '<p>' + esc((item.sideStoryCandidates || []).map((x) => x.text).join(' ').slice(0, 260)) + '</p></div>'
    )).join('') +
  '</div>';
}

function renderCaseView(plan) {
  return renderPipelineSteps() +
    '<div class="autopilot-grid">' +
      '<div class="autopilot-card"><h2>案件入口</h2><p>Redditスレ、5chスレ、またはカスタム入力のどれかを左に貼ります。</p></div>' +
      '<div class="autopilot-card"><h2>手持ち情報</h2><p>スレタイトルとコメント、または相棒が気になった出来事のメモだけで開始します。</p></div>' +
      '<div class="autopilot-card"><h2>選択中の案件</h2><p>' + esc(document.getElementById('title')?.value || plan.topic || '') + '</p></div>' +
      '<div class="autopilot-card"><h2>現在地</h2><p>' + esc(researchStatusLabel()) + '</p></div>' +
    '</div>';
}

function renderResearchWorkflowView(plan) {
  const auto = plan.autopilotPlan || {};
  const summary = researchReadSummary();
  const missingData = auto.mustCheck || [];
  const isAI = !!auto.aiGenerated;

  let html = '<span class="label">ニュース記事やデータを読んだ量と、次の試行に使う材料</span>';
  html += '<div class="autopilot-grid">';
  html += '<div class="autopilot-card"><h2>読んだ材料</h2><p>Web記事: ' + esc(summary.webCount) + '件 / 本文取得: ' + esc(summary.fullTextCount) + '件 / Wiki: ' + esc(summary.wikiCount) + '件</p></div>';
  html += '<div class="autopilot-card"><h2>検索クエリ</h2><p>' + esc(summary.queries.join(' / ') || '未実行') + '</p></div>';

  if (isAI && missingData.length > 0) {
    html += '<div class="autopilot-card" style="grid-column:1/-1;"><h2>AI分析で不足と判定されたデータ</h2>' +
      missingData.map(function(item) {
        return '<p style="color:#fecaca;font-size:13px;">• ' + esc(item.need || item) + '</p>';
      }).join('') +
      '</div>';
  }
  html += '</div>';
  html += '<div style="margin-top:10px;">' + renderSourceSamples() + '</div>';
  return html;
}

function renderThemeProposalView(plan) {
  const auto = plan.autopilotPlan || {};
  const proposal = auto.themeProposal || {};
  const candidates = proposal.candidates || [];
  const selectedIdx = proposal.selected || 0;
  const isAI = !!auto.aiGenerated;
  const summary = researchReadSummary();

  let basisText;
  if (isAI) {
    basisText = 'AI分析済み: Web ' + summary.webCount + '件・本文 ' + summary.fullTextCount + '件・Wiki ' + summary.wikiCount + '件を読んで生成';
  } else if (currentResearch) {
    basisText = 'Web ' + summary.webCount + '件を取得済み。「AIで分析」で切り口を生成できます。';
  } else {
    basisText = 'リサーチ前の仮案。左の「リサーチ」→ AI分析で実際の記事に基づく提案になります。';
  }

  let html = '<span class="label">テーマ提案。どの切り口で動画にするかを決める段階</span>';
  html += '<div class="autopilot-grid">';
  html += '<div class="autopilot-card" style="grid-column:1/-1;"><h2>試行結果</h2><p>' + esc(basisText) + '</p></div>';

  if (candidates.length > 0) {
    candidates.forEach(function(c, i) {
      const isSelected = i === selectedIdx;
      const borderStyle = isSelected
        ? 'border: 2px solid var(--green);'
        : 'border: 1px solid var(--line);';
      html += '<div class="autopilot-card" style="' + borderStyle + '">' +
        '<h2>' + (isSelected ? '✓ ' : '') + '案' + (i + 1) + '. ' + esc(c.angle || c.hookQuestion || '') + '</h2>' +
        '<p><b>問い:</b> ' + esc(c.hookQuestion || '') + '</p>' +
        '<p><b>仮の答え:</b> ' + esc(c.answer || '') + '</p>' +
        '<div class="chips">' + (c.dataNeeds || []).map(function(d) { return '<span class="chip">' + esc(d) + '</span>'; }).join('') + '</div>' +
        (c.risk ? '<p style="color:#fecaca;margin-top:6px;font-size:11px;">リスク: ' + esc(c.risk) + '</p>' : '') +
        '</div>';
    });
    if (proposal.selectedReason) {
      html += '<div class="autopilot-card" style="grid-column:1/-1;"><h2>採用理由</h2><p>' + esc(proposal.selectedReason) + '</p></div>';
    }
    if ((proposal.rejectedReasons || []).length > 0) {
      html += '<div class="autopilot-card" style="grid-column:1/-1;"><h2>棄却理由</h2>' +
        proposal.rejectedReasons.map(function(r) { return '<p style="color:var(--muted);font-size:13px;">• ' + esc(r) + '</p>'; }).join('') +
        '</div>';
    }
  } else {
    html += '<div class="autopilot-card"><h2>フックとなる問題提起</h2><p>' + esc(proposal.hookQuestion || plan.centralQuestion || '') + '</p></div>' +
      '<div class="autopilot-card"><h2>仮の答え</h2><p>' + esc(proposal.answer || plan.thesis || '') + '</p></div>' +
      '<div class="autopilot-card" style="grid-column:1/-1;"><h2>この切り口で使う想定データ</h2><div class="flow-list">' +
        (proposal.dataPlan || []).slice(0, 6).map(function(item) {
          return '<div class="flow-item"><b>' + esc(item.need) + '</b><p>検索: ' + esc(item.query || '') + '</p></div>';
        }).join('') +
      '</div></div>';
  }

  html += '</div>';
  return html;
}

function renderBriefingPipelineView(plan) {
  const briefing = plan.autopilotPlan?.briefing || {};
  const chapters = briefing.chapters || [];
  return '<span class="label">動画ブリーフ。採用テーマで、全体の流れを制作指示にまとめる段階</span>' +
    '<div class="autopilot-grid">' +
      '<div class="autopilot-card"><h2>動画の約束</h2><p>' + esc(briefing.purpose || plan.viewerPromise || '') + '</p></div>' +
      '<div class="autopilot-card"><h2>中心メッセージ</h2><p>' + esc(briefing.coreMessage || plan.thesis || '') + '</p></div>' +
      '<div class="autopilot-card" style="grid-column:1/-1;"><h2>全体の流れ</h2><div class="flow-list">' +
        chapters.slice(0, 7).map((item) => '<div class="flow-item"><b>' + esc(item.no + '. ' + item.role) + '</b><p>' + esc(item.claim) + '</p></div>').join('') +
      '</div></div>' +
      '<div class="autopilot-card" style="grid-column:1/-1;"><h2>使うデータ</h2><div class="chips">' +
        (briefing.dataPlan || []).slice(0, 8).map((x) => '<span class="chip">' + esc(x.need) + '</span>').join('') +
      '</div></div>' +
    '</div>';
}

function renderResultTabs(plan) {
  return '<div class="panel" id="resultTop">' +
    '<div class="view-tabs">' +
      '<button class="view-tab" data-view="case" onclick="setResultView(\\'case\\')">1 案件</button>' +
      '<button class="view-tab" data-view="research" onclick="setResultView(\\'research\\')">2 リサーチ</button>' +
      '<button class="view-tab" data-view="theme" onclick="setResultView(\\'theme\\')">3 テーマ提案</button>' +
      '<button class="view-tab" data-view="briefing" onclick="setResultView(\\'briefing\\')">4 ブリーフ</button>' +
      '<button class="view-tab" data-view="structure" onclick="setResultView(\\'structure\\')">5 脚本構成</button>' +
      '<button class="view-tab" data-view="script" onclick="setResultView(\\'script\\')">6 脚本</button>' +
    '</div>' +
    '<div class="view-panel" data-view="case">' + renderCaseView(plan) + '</div>' +
    '<div class="view-panel" data-view="research">' + renderResearchWorkflowView(plan) + '</div>' +
    '<div class="view-panel" data-view="theme">' + renderThemeProposalView(plan) + '</div>' +
    '<div class="view-panel" data-view="briefing">' + renderBriefingPipelineView(plan) + '</div>' +
    '<div class="view-panel" data-view="structure">' + renderStructureView(plan) + '</div>' +
    '<div class="view-panel" data-view="script">' + renderScriptView(plan) + '</div>' +
  '</div>';
}

function tidyControls() {
  const briefPanel = document.querySelector('.brief-editor')?.closest('.panel');
  if (briefPanel) briefPanel.style.display = 'none';
  document.querySelector('label[for="title"]').textContent = '案件タイトル（Reddit / 5ch / カスタム）';
  document.querySelector('label[for="memo"]').textContent = 'コメント・本文メモ（スレコメントや出来事を貼る）';
}

tidyControls();
loadSaved();
generatePlan({ scroll: false });
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`V3 Story Architect running: http://localhost:${PORT}`);
});
