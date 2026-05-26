// v3_launcher/server.js
// Standalone V3 prototype launcher. It intentionally does not modify V2.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createArgumentPlan } = require('./v3_story_architect');
const { runTopicResearch, fetchWikiSideStories } = require('./v3_research');

const app = express();
const PORT = Number(process.env.V3_LAUNCHER_PORT || 3005);
const UI_VERSION = 'v3-ui-e08946f-plus';
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
  grid-template-columns: 118px 1fr 340px;
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
    <div id="mobileInlineResult" class="mobile-inline-result"></div>
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
        <button id="generateBtn" onclick="generatePlan()">設計する</button>
        <button class="secondary" id="researchBtn" onclick="runResearch()">リサーチ</button>
        <button class="secondary" id="wikiBtn" onclick="runWikiSideStories()">小話Wiki</button>
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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'failed');
    currentPlan = data.plan;
    renderPlan(currentPlan);
    const inline = document.getElementById('mobileInlineResult');
    if (inline) inline.innerHTML = renderHumanBrief(currentPlan, true);
    const target = window.matchMedia('(max-width: 720px)').matches ? inline : document.getElementById('resultTop');
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
  btn.textContent = '検索中...';
  try {
    const res = await fetch('/api/v3/research/topic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: document.getElementById('title').value,
        memo: document.getElementById('memo').value,
        plan: currentPlan,
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'failed');
    currentResearch = data.result;
    if (currentPlan) renderPlan(currentPlan);
    else renderResearchOnly();
  } catch (error) {
    alert('リサーチ失敗: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'リサーチ';
  }
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
  const tasksByBeat = {};
  for (const task of plan.evidencePlan.researchTasks) {
    if (!tasksByBeat[task.beatId]) tasksByBeat[task.beatId] = [];
    tasksByBeat[task.beatId].push(task);
  }

  const beatsHtml = plan.beats.map((beat, index) => {
    const tasks = tasksByBeat[beat.id] || [];
    return '<div class="beat">' +
      '<div><div class="role">' + esc(beat.role) + '</div><div style="font-size:11px;color:var(--muted);margin-top:8px;">slide ' + (index + 1) + '</div></div>' +
      '<div>' +
        '<h3>' + esc(beat.claim) + '</h3>' +
        '<p>' + esc(beat.slideIntent) + '</p>' +
        '<div class="chips">' +
          beat.evidenceNeeded.map((x) => '<span class="chip">' + esc(x) + '</span>').join('') +
        '</div>' +
        '<div class="chips" style="margin-top:8px;">' +
          beat.riskChecks.map((x) => '<span class="chip risk">' + esc(x) + '</span>').join('') +
        '</div>' +
      '</div>' +
      '<div>' +
        tasks.map((task) => '<div class="research"><b>' + esc(task.question) + '</b><br>' +
          esc(task.queries.join(' / ')) + '<br>' +
          '<span style="color:var(--muted)">source: ' + esc(task.sourceType) + ' / required: ' + task.required + '</span></div>'
        ).join('') +
      '</div>' +
    '</div>';
  }).join('');

  document.getElementById('output').innerHTML =
    renderHumanBrief(plan) +
    '<div class="panel summary">' +
      '<div class="summary-grid">' +
        '<div><h2>中心問い</h2><p>' + esc(plan.centralQuestion) + '</p></div>' +
        '<div><h2>仮結論</h2><p>' + esc(plan.thesis) + '</p></div>' +
        '<div><h2>視聴者への約束</h2><p>' + esc(plan.viewerPromise) + '</p></div>' +
      '</div>' +
    '</div>' +
    '<div class="panel"><span class="label">TOC: 答えまでの道筋</span><div class="toc">' +
      plan.toc.map((item, i) => '<span>' + (i + 1) + '. ' + esc(item.label) + '</span>').join('') +
    '</div></div>' +
    '<div class="panel"><span class="label">beats: 論旨上の一手 + 必要証拠 + 危険チェック</span>' + beatsHtml + '</div>' +
    '<div class="panel"><span class="label">サムネ / 声 / 全体リスク</span>' +
      '<pre>' + esc(JSON.stringify({
        thumbnailPlan: plan.thumbnailPlan,
        voicePlan: plan.voicePlan,
        globalRiskChecks: plan.globalRiskChecks,
        editorialNotes: plan.editorialNotes,
      }, null, 2)) + '</pre>' +
    '</div>' +
    renderResearchPanels() +
    '<div class="panel"><span class="label">raw JSON</span><pre>' + esc(JSON.stringify(plan, null, 2)) + '</pre></div>';
}

function renderHumanBrief(plan, inline = false) {
  const brief = plan.humanBrief || {
    core: plan.centralQuestion,
    answer: plan.thesis,
    structure: (plan.beats || []).map((beat, i) => ({ no: i + 1, label: beat.role, point: beat.claim })),
    cautions: plan.globalRiskChecks || [],
  };
  const mobileStructure = (brief.structure || []).slice(0, 6).map((item) =>
    '<li>' + esc(item.label) + '</li>'
  ).join('');
  const resultId = inline ? '' : ' id="resultTop"';
  return '<div class="panel mobile-brief">' +
      '<h2>案件の核心</h2><p>' + esc(brief.core) + '</p>' +
      '<h2>答え</h2><p>' + esc(brief.answer) + '</p>' +
      '<h2>流れ</h2><ol>' + mobileStructure + '</ol>' +
    '</div>' +
    '<div class="panel"' + resultId + '>' +
    '<span class="label">人間用ブリーフ: まずここだけ見れば判断できる</span>' +
    '<div class="human-brief">' +
      '<div class="brief-card"><h2>1. 話題になっている核心</h2><p>' + esc(brief.core) + '</p></div>' +
      '<div class="brief-card"><h2>2. それに対する答え</h2><p>' + esc(brief.answer) + '</p></div>' +
      '<div class="brief-card wide"><h2>3. 論理展開の構造</h2><div class="argument-boxes">' +
        (brief.structure || []).map((item) => (
          '<div class="argument-box">' +
            '<span class="arg-label">論点' + esc(item.no) + '</span>' +
            '<h3>' + esc(item.label) + '</h3>' +
            '<p>' + esc(item.point) + '</p>' +
          '</div>'
        )).join('') +
      '</div></div>' +
      '<div class="brief-card wide"><h2>4. 留意すべき点</h2><div class="chips">' +
        (brief.cautions || []).map((x) => '<span class="chip risk">' + esc(x) + '</span>').join('') +
      '</div></div>' +
    '</div>' +
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

loadSaved();
generatePlan({ scroll: false });
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`V3 Story Architect running: http://localhost:${PORT}`);
});
