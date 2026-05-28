// v3_launcher/server.js
// Standalone V3 prototype launcher. It intentionally does not modify V2.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createArgumentPlan } = require('./v3_story_architect');
const { runTopicResearch, fetchWikiSideStories } = require('./v3_research');
const { generateAIPlan } = require('./v3_planner');
const { router: s3Router } = require('../routes/step3_routes');
const { router: s35Router } = require('../routes/step35_routes');
const { router: s4Router } = require('../routes/step4_routes');

const app = express();
const PORT = Number(process.env.V3_LAUNCHER_PORT || 3005);
const UI_VERSION = 'v3-ui-client-js-fixed-yellow';
// Keep prototype output inside v3_launcher so V2 data directories stay untouched.
const DATA_DIR = path.join(__dirname, 'data', 'argument_plans');
const V2_DATA_DIR = path.join(__dirname, '..', 'data');
const V2_SI_DIR = path.join(V2_DATA_DIR, 'si_data');
const V2_SAVED_FILE = path.join(V2_DATA_DIR, 'saved_projects.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(V2_SI_DIR)) fs.mkdirSync(V2_SI_DIR, { recursive: true });

app.use((_, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use('/api', s3Router);
app.use('/api', s35Router);
app.use('/api', s4Router);
app.use('/images', express.static(path.join(__dirname, '..', 'images')));
app.use('/images_stock', express.static(path.join(__dirname, '..', 'images_stock')));
app.use('/v2_videos', express.static(path.join(__dirname, '..', 'data', 'v2_videos')));

function safeId(value) {
  return String(value || 'untitled')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'untitled';
}

function safeFileId(value) {
  return String(value || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function makeV2PostId(title) {
  const now = new Date(Date.now() + 9 * 3600_000);
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hms = now.toISOString().slice(11, 19).replace(/:/g, '');
  const slug = safeId(title).toLowerCase().replace(/_/g, '').slice(0, 18) || Math.random().toString(36).slice(2, 8);
  const rand = Math.random().toString(36).slice(2, 6);
  return `v3_${ymd}_${hms}_${slug}_${rand}`;
}

function normalizeV2Type(role, type, index, total) {
  if (index === 0) return 'opening';
  if (index === total - 1) return 'ending';
  if (['history', 'comparison', 'stats', 'profile', 'insight'].includes(type)) return type;
  if (role === 'answer') return 'insight';
  if (role === 'contrast') return 'comparison';
  return 'insight';
}

function buildV2ModulesFromPlan(plan) {
  if (Array.isArray(plan?.v3Modules) && plan.v3Modules.length) {
    return plan.v3Modules;
  }
  const auto = plan?.autopilotPlan || {};
  const script = Array.isArray(auto.scriptDraft) && auto.scriptDraft.length
    ? auto.scriptDraft
    : (Array.isArray(plan?.slidePlan) ? plan.slidePlan.map((slide, index) => ({
      slideNo: index + 1,
      title: slide.headline,
      role: slide.role,
      narration: slide.claim,
      dataNeeds: (slide.dataSlots || []).map((slot) => slot.label),
    })) : []);
  const slideById = new Map((plan?.slidePlan || []).map((slide) => [slide.id, slide]));

  return script.map((item, index) => {
    const slide = slideById.get(item.slideId) || (plan?.slidePlan || [])[index] || {};
    const dataNeeds = Array.isArray(item.dataNeeds) ? item.dataNeeds : [];
    const dataSlots = dataNeeds.slice(0, 5).map((need) => ({
      label: String(need || '').slice(0, 60),
      value: '',
    }));
    return {
      mainKey: index === 0 ? 'opening' : (index === script.length - 1 ? 'ending' : `v3:${slide.id || item.slideNo || index + 1}`),
      subSource: 'v3',
      subValue: item.role || slide.role || '',
      secondary: null,
      type: normalizeV2Type(item.role || slide.role, slide.slideType, index, script.length),
      scriptDir: '',
      title: String(item.title || slide.headline || `Slide ${index + 1}`).slice(0, 80),
      narration: String(item.narration || slide.claim || '').trim(),
      dataSlots,
      catchphrases: [],
      comments: [],
      v3Meta: {
        slideId: item.slideId || slide.id || '',
        role: item.role || slide.role || '',
        visualIntent: item.visual || slide.visualIntent || '',
        caution: item.caution || '',
      },
    };
  });
}

app.get('/api/v3/health', (_, res) => {
  res.json({ ok: true, name: 'v3-launcher-prototype', port: PORT });
});

app.get('/api/v3/content', (req, res) => {
  const d = req.query.date;
  if (!d) return res.status(400).json({ error: 'date is required' });
  const file = path.join(V2_DATA_DIR, `stories_${String(d).replace(/-/g, '_')}.json`);
  const data = readJson(file, { posts: [] });
  const posts = (data.posts || []).map((p, i) => ({
    idx: i,
    id: p.id || String(i),
    title: p.titleJa || p.title || '(タイトル不明)',
    titleOrig: p.title || '',
    addedAt: p.added_at || p.addedAt || (p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null),
    source: p.source || 'reddit',
    score: p.score || 0,
    raw: p,
  }));
  res.json({ posts });
});

app.get('/api/v3/saved-projects', (_, res) => {
  const saved = readJson(V2_SAVED_FILE, []);
  res.json(Array.isArray(saved) ? saved : []);
});

app.post('/api/v3/saved-projects', (req, res) => {
  try {
    const projects = Array.isArray(req.body?.projects) ? req.body.projects : [];
    fs.writeFileSync(V2_SAVED_FILE, JSON.stringify(projects, null, 2));
    res.json({ ok: true, count: projects.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    console.error('[v3/analyze]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── auto-prefetch: 記事から entity 抽出 → SofaScore で構造化データを自動取得 ──
function extractEntitiesV3(topic, memo, learningCorpus, wikiResults) {
  const entities = [];
  const seen = new Set();
  const TEAM_RE = /\b(fc|cf|sc|united|city|athletic|real|chelsea|arsenal|liverpool|barcelona|madrid|juventus|national|inter|ac milan|as roma|psv|ajax|dortmund)\b/i;
  const STOP = new Set(['Reddit','World','Cup','League','Premier','Serie','Bundesliga','Ligue','English','Spanish','Italian','French','German','European','Champion','Europa','Super','Final','Season','Soccer','Football','Players']);
  function add(type, nameEn) {
    const k = nameEn.toLowerCase().trim();
    if (!k || k.length < 3 || seen.has(k)) return;
    seen.add(k);
    entities.push({ type, nameEn: nameEn.trim() });
  }
  (wikiResults || []).forEach(w => {
    const isTeam = TEAM_RE.test(w.entity) || /national football team|fc |cf |sc /i.test(w.entity);
    add(isTeam ? 'team' : 'player', w.entity);
  });
  const allText = [topic, memo, ...(learningCorpus || []).slice(0, 6).map(x => x.title || '')].join(' ');
  const propNouns = allText.match(/[A-Z][A-Za-z'.-]{1,}(?:\s+[A-Z][A-Za-z'.-]{1,}){0,2}/g) || [];
  propNouns.forEach(name => {
    if (name.length < 3 || STOP.has(name.split(' ')[0])) return;
    add(TEAM_RE.test(name) ? 'team' : 'player', name);
  });
  return entities.slice(0, 5);
}

function buildDataLabelsV3(prefetched) {
  return Object.values(prefetched || {}).map(e => {
    if (!e.data) return { type: e.type, nameEn: e.nameEn, ok: false, summary: '取得失敗', labels: [] };
    const labels = [];
    if (e.type === 'player') {
      const ss = e.data.seasonStats || {};
      if (ss.goals != null)   labels.push('G' + ss.goals);
      if (ss.assists != null) labels.push('A' + ss.assists);
      if (ss.rating != null)  labels.push('評' + ss.rating);
      if (e.data.team)        labels.push('@' + e.data.team);
      if (e.data.age)         labels.push(e.data.age + '歳');
    } else {
      const st = e.data.standing || {};
      if (st.position != null) labels.push(st.position + '位');
      if (st.wins != null)     labels.push(st.wins + 'W');
      if (st.draws != null)    labels.push(st.draws + 'D');
      if (st.losses != null)   labels.push(st.losses + 'L');
    }
    return { type: e.type, nameEn: e.nameEn, ok: true, summary: labels.join(' / ') || '取得OK', labels };
  });
}

app.post('/api/v3/auto-prefetch', async (req, res) => {
  try {
    const { topic = '', memo = '', learningCorpus = [], wikiResults = [] } = req.body || {};
    const { prefetchEntities } = require(path.join(__dirname, '..', 'scripts', 'modules', 'fetchers', 'entity_prefetcher'));
    const entities = extractEntitiesV3(topic, memo, learningCorpus, wikiResults);
    if (!entities.length) return res.json({ success: true, entities: [], labels: [], note: 'no entities found' });
    const prefetched = await prefetchEntities(entities);
    const labels = buildDataLabelsV3(prefetched);
    res.json({ success: true, entities, labels });
  } catch (error) {
    console.error('[v3/auto-prefetch]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/export-v2', (req, res) => {
  try {
    const { plan, sourceType = 'custom', memo = '' } = req.body || {};
    if (!plan) return res.status(400).json({ success: false, error: 'plan is required' });

    const postId = makeV2PostId(plan.topic || plan.title);
    const now = new Date().toISOString();
    const modules = buildV2ModulesFromPlan(plan);
    if (!modules.length) return res.status(400).json({ success: false, error: 'scriptDraft or slidePlan is empty' });

    const project = {
      id: postId,
      title: plan.topic || plan.title || 'V3 draft',
      titleOrig: '',
      addedAt: now,
      source: `v3_${sourceType}`,
      score: 0,
      raw: {
        id: postId,
        title: plan.topic || plan.title || 'V3 draft',
        source: `v3_${sourceType}`,
        isCustom: true,
        customNote: String(memo || plan.viewerPromise || '').slice(0, 1000),
        v3: {
          exportedAt: now,
          centralQuestion: plan.centralQuestion || '',
          thesis: plan.thesis || '',
          publishGates: plan.autopilotPlan?.publishGates || [],
        },
        addedAt: now,
      },
    };

    const saved = readJson(V2_SAVED_FILE, []);
    const list = Array.isArray(saved) ? saved : [];
    list.push(project);
    fs.writeFileSync(V2_SAVED_FILE, JSON.stringify(list, null, 2));

    const modulesFile = path.join(V2_DATA_DIR, `${safeFileId(postId)}_modules.json`);
    fs.writeFileSync(modulesFile, JSON.stringify({ postId, modules, savedAt: now, source: 'v3_launcher' }, null, 2));

    const siFile = path.join(V2_SI_DIR, `${safeFileId(postId)}.json`);
    if (!fs.existsSync(siFile)) {
      fs.writeFileSync(siFile, JSON.stringify({
        postId,
        version: 'v3',
        boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } },
        v3Export: {
          topic: plan.topic || '',
          researchDesign: plan.researchDesign || null,
          researchSummary: plan.autopilotPlan?.mustCheck || [],
        },
      }, null, 2));
    }

    res.json({ success: true, postId, project, modulesFile, siFile, moduleCount: modules.length });
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

app.get('/case-fetch', (_, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V3 案件取得</title>
<style>
body { margin:0; background:#0b0d12; color:#eef2f7; font-family:"Yu Gothic","Noto Sans JP",sans-serif; }
header { padding:14px 16px; border-bottom:4px solid #f2b84b; background:#111827; }
h1 { margin:0; color:#f2b84b; font-size:18px; }
.badge { display:inline-block; margin-top:6px; padding:3px 8px; background:#f2b84b; color:#111827; border-radius:999px; font-size:11px; font-weight:900; }
main { padding:12px; }
.panel { border:1px solid #303846; background:#151922; border-radius:8px; padding:12px; margin-bottom:12px; }
.row { display:grid; grid-template-columns:1fr auto; gap:8px; }
input, button { min-height:42px; border-radius:6px; border:1px solid #303846; font:inherit; }
input { background:#0a0d12; color:#eef2f7; padding:0 10px; }
button { background:#f2b84b; color:#111827; font-weight:900; padding:0 12px; }
.item { padding:10px; border:1px solid #303846; border-radius:6px; margin-top:8px; background:#0a0d12; line-height:1.45; }
.item b { color:#f2b84b; }
.muted { color:#94a3b8; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>V3 案件取得</h1>
  <span class="badge">standalone-case-fetch-yellow</span>
</header>
<main>
  <div class="panel">
    <div class="row">
      <input id="date" type="date">
      <button id="loadBtn" type="button">案件取得</button>
    </div>
    <p class="muted">既存V3トップ画面から完全に切り離した確認用ページです。</p>
  </div>
  <div id="list" class="panel">日付を選んで案件取得を押してください。</div>
</main>
<script>
function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });
}
document.getElementById('date').value = today();
document.getElementById('loadBtn').addEventListener('click', async function() {
  const box = document.getElementById('list');
  box.textContent = '読込中...';
  try {
    const d = document.getElementById('date').value;
    const res = await fetch('/api/v3/content?date=' + encodeURIComponent(d));
    const data = await res.json();
    const posts = data.posts || [];
    box.innerHTML = '<b>取得 ' + posts.length + '件</b>' + (posts.length ? posts.map(function(p) {
      return '<div class="item"><b>' + esc(p.title) + '</b><div class="muted">' + esc((p.source || '') + ' / score ' + (p.score || 0) + ' / ' + (p.addedAt || '')) + '</div></div>';
    }).join('') : '<p class="muted">この日付の案件はありません。</p>');
  } catch (error) {
    box.innerHTML = '<b>取得失敗</b><p>' + esc(error.message || error) + '</p>';
  }
});
</script>
</body>
</html>`);
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
html { overflow-x: hidden; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif;
  height: 100vh;
  overflow: hidden;
}
header {
  height: 62px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 22px;
  border-bottom: 3px solid var(--gold);
  background: #111827;
  flex-shrink: 0;
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
  grid-template-columns: 240px minmax(0, 1fr);
  height: calc(100vh - 106px);
  min-height: 0;
  min-width: 0;
}
main.full-workspace {
  grid-template-columns: minmax(0, 1fr);
}
main.full-workspace aside {
  display: none;
}
aside {
  border-right: 1px solid var(--line);
  background: #0d1220;
  padding: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.workspace {
  padding: 0;
  overflow: auto;
  min-width: 0;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
  margin: 0 0 14px;
}
.step-container { padding: 16px 18px; }
.sidebar-head {
  padding: 12px 14px;
  color: var(--gold);
  background: #111827;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: .04em;
}
.sidebar-body {
  flex: 1;
  overflow: auto;
  padding: 10px;
}
.sidebar-footer {
  border-top: 1px solid var(--line);
  padding: 10px;
  background: #0a0d12;
}
.sidebar-footer button {
  width: 100%;
}
.sidebar-hint {
  margin-top: 8px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}
.brief-side-panel,
.case-input-side-panel {
  display: none;
}
.saved-lead-item {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 10px;
  margin-bottom: 7px;
  cursor: pointer;
  font-size: 11px;
  line-height: 1.35;
  word-break: break-word;
}
.saved-lead-item:hover {
  border-color: var(--muted);
}
.saved-lead-item.active {
  border-color: var(--gold);
  border-left: 4px solid var(--gold);
  background: #1b2230;
}
.saved-lead-item b {
  display: block;
  color: var(--text);
  margin-bottom: 5px;
}
.saved-lead-item span {
  display: block;
  color: var(--muted);
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
select {
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
  min-width: 0;
  overflow-wrap: anywhere;
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
  display: flex;
  gap: 0;
  margin: 0;
  min-width: 0;
  background: #0d1220;
  border-bottom: 1px solid var(--line);
  height: 44px;
  position: relative;
  z-index: 20;
}
.view-tab {
  flex: 1;
  background: transparent;
  color: var(--text);
  border: 0;
  border-right: 1px solid #1e293b;
  border-radius: 0;
  min-height: 44px;
  font-size: 12px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: rgba(242,184,75,.22);
}
.view-tab.active {
  background: var(--panel);
  color: var(--gold);
  border-bottom: 3px solid var(--gold);
}
.view-panel { display: block; }
.custom-case-panel {
  display: none;
  margin-bottom: 10px;
}
.custom-case-panel.open {
  display: block;
}
.custom-case-panel textarea {
  min-height: 96px;
}
.selected-case-box {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-left: 4px solid var(--gold);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 12px;
}
.proposal-hook-text {
  font-size: 15px;
  font-weight: 700;
  color: #facc15;
  margin: 6px 0 4px;
  line-height: 1.45;
}
.proposal-hook-text::before { content: '「'; }
.proposal-hook-text::after  { content: '」'; }
.proposal-divider {
  border: none;
  border-top: 1px solid var(--line);
  margin: 10px 0;
}
.proposal-meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 4px 0 8px;
}
.proposal-meta-grid .label { font-size: 10px; }
.proposal-meta-grid p { margin: 2px 0 0; font-size: 13px; line-height: 1.4; }
@media (max-width: 720px) { .proposal-meta-grid { grid-template-columns: 1fr; } }
.selected-case-box h2 {
  margin: 0 0 8px;
  color: var(--gold);
  font-size: 18px;
}
.selected-case-box pre {
  max-height: 220px;
  margin: 10px 0 0;
}
.research-flow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.research-action-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}
.research-action-inline {
  text-align: center;
  padding: 4px 0 10px;
}
.research-step {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}
.research-heading {
  margin: 10px 0 5px;
  color: var(--gold);
  font-size: 15px;
  font-weight: 900;
}
.evidence-section {
  margin-top: 8px;
}
.evidence-list {
  display: grid;
  gap: 5px;
}
.evidence-item {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 9px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.35;
}
.evidence-item b {
  color: var(--gold);
}
.briefing-paper {
  background: #101827;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 11px;
  margin-top: 8px;
}
.briefing-paper.selected {
  border: 2px solid var(--green);
}
.briefing-paper h2 {
  margin: 0 0 7px;
  color: var(--gold);
  font-size: 16px;
}
.briefing-paper h3 {
  margin: 9px 0 4px;
  color: #dbeafe;
  font-size: 12px;
}
.briefing-paper p,
.briefing-paper li {
  color: var(--text);
  line-height: 1.38;
  font-size: 12px;
  margin-top: 0;
}
.proposal-paper-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.proposal-paper-grid .briefing-paper {
  margin-top: 0;
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
  grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr);
  gap: 10px;
}
.autopilot-card {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.autopilot-card h2 {
  margin: 0 0 8px;
  color: var(--gold);
  font-size: 13px;
}
.autopilot-card p {
  margin: 0;
  color: #e5e7eb;
  font-size: 12px;
  line-height: 1.35;
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.workflow-nav {
  display: grid;
  gap: 8px;
}
.workflow-step-btn {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 8px;
  align-items: center;
  width: 100%;
  text-align: left;
  background: #0a0d12;
  color: var(--text);
  border: 1px solid var(--line);
  padding: 9px;
}
.workflow-step-btn.active {
  border-color: var(--gold);
  background: #1b2230;
}
.workflow-step-btn.done .step-no {
  background: var(--green);
}
.step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  background: #263142;
  color: #fff;
  font-size: 12px;
  font-weight: 900;
}
.step-text b {
  display: block;
  font-size: 12px;
}
.step-text span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  margin-top: 2px;
  line-height: 1.3;
}
.task-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.task-status {
  margin-top: 10px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
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
  gap: 5px;
}
.flow-item {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 9px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.flow-item b { color: var(--gold); }
.flow-item p {
  margin: 3px 0 0;
  color: #dbeafe;
  font-size: 12px;
  line-height: 1.35;
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  border: 1px solid var(--line);
  background: #0a0d12;
  color: #cbd5e1;
  border-radius: 999px;
  padding: 3px 7px;
  font-size: 10px;
}
.source-url {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
.case-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.case-toolbar input[type="date"] {
  width: 170px;
}
.case-toolbar .case-spacer {
  flex: 1;
}
.case-editor-grid {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 10px;
}
.case-editor-grid textarea {
  min-height: 130px;
}
.case-list {
  margin-top: 10px;
  max-height: calc(100vh - 360px);
  min-height: 260px;
  overflow: auto;
}
.case-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 9px 12px;
  cursor: pointer;
  border-bottom: 1px solid #1a2540;
  background: #0a0d12;
  font-size: 13px;
  line-height: 1.4;
}
.case-row:hover { background: #111827; }
.case-row.selected { background: #1b2230; }
.case-row input[type="checkbox"] { flex-shrink: 0; }
.case-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.time-group {
  margin-bottom: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: #0a0d12;
}
.time-summary {
  background: #1d2430;
  padding: 9px 14px;
  cursor: pointer;
  color: var(--blue);
  font-size: 12px;
  font-weight: 900;
}
.time-summary:hover { background: #253044; }
.time-content { display: none; }
.time-group.open .time-content { display: block; }
.src-badge {
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 900;
  flex-shrink: 0;
}
.badge-reddit { background: #ff4500; color: #fff; }
.badge-5ch { background: #ff9900; color: #111827; }
.badge-custom { background: var(--gold); color: #111827; }
.case-count {
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
}
.brief-textarea { min-height: 420px; font-size: 14px; line-height: 1.65; }
.editor-layout {
  display: grid;
  grid-template-columns: minmax(300px, 520px) minmax(0, 1fr);
  gap: 12px;
}
.slide-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.slide-tab {
  background: #263142;
  color: var(--text);
  border: 1px solid var(--line);
  padding: 7px 10px;
  font-size: 12px;
}
.slide-tab.active { background: var(--gold); color: #111827; }
.data-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 34px;
  gap: 6px;
  margin-bottom: 6px;
}
.preview-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: #000;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.preview-wrap iframe {
  position: absolute;
  inset: 0;
  width: 1920px;
  height: 1080px;
  border: 0;
  transform-origin: top left;
}
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}
.gallery-thumb {
  height: 68px;
  border: 2px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: #000;
  cursor: pointer;
}
.gallery-thumb.selected { border-color: var(--gold); }
.gallery-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
@media (max-width: 900px) {
  main { grid-template-columns: 210px minmax(0, 1fr); }
  .summary-grid { grid-template-columns: 1fr; }
  .human-brief { grid-template-columns: 1fr; }
  .chapter-list { grid-template-columns: 1fr; }
  .beat { grid-template-columns: 1fr; }
  .editor-layout { grid-template-columns: 1fr; }
  .case-toolbar { grid-template-columns: 1fr 1fr; }
  .case-editor-grid { grid-template-columns: 1fr; }
}
/* hidden state storage — input[type=hidden] なので追加CSSは不要 */

/* compact selected-case badge on step2+ */
.case-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: #111827;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  min-height: 0;
  flex-shrink: 0;
}
.case-badge b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.case-badge.empty-badge { color: var(--muted); font-style: italic; }

/* collapsed proposal card (unselected) */
.briefing-paper--compact {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.briefing-paper--compact h2 { margin: 0 0 4px; font-size: 13px; color: var(--muted); }
.briefing-paper--compact p { margin: 0; font-size: 13px; line-height: 1.4; }
.briefing-paper--compact .task-actions { margin-top: 10px; }

/* topic panel in step1 workspace */
.topic-panel-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  align-items: center;
}
.topic-panel-grid label { font-size: 12px; color: var(--muted); white-space: nowrap; }
.topic-panel-grid select,
.topic-panel-grid input { margin: 0; }

/* hamburger + drawer */
.hamburger-btn {
  display: none;
  background: none;
  border: none;
  color: var(--gold);
  font-size: 22px;
  cursor: pointer;
  padding: 4px 8px;
  min-height: unset;
  line-height: 1;
}
.sidebar-overlay { display: none; }
.sidebar-overlay.active {
  display: block;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,.55);
  z-index: 199;
}
body.drawer-is-open #savedDrawer {
  display: flex !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 85vw !important;
  max-width: 320px !important;
  height: 100dvh !important;
  z-index: 10000 !important;
  visibility: visible !important;
  opacity: 1 !important;
  transform: translateX(0) !important;
  -webkit-transform: translateX(0) !important;
  pointer-events: auto !important;
}
body.drawer-is-open #sidebarOverlay {
  display: block !important;
  z-index: 9999 !important;
}
.drawer-close {
  display: none;
  background: transparent;
  color: var(--text);
  border: 1px solid var(--line);
  min-height: 34px;
  padding: 6px 9px;
}

@media (max-width: 720px) {
  body { height: auto; min-height: 100vh; overflow: auto; }
  header {
    height: auto;
    align-items: center;
    flex-direction: row;
    justify-content: space-between;
    flex-wrap: wrap;
    padding: 10px 14px;
    gap: 4px;
  }
  h1 { font-size: 16px; }
  .tag { font-size: 11px; }
  .hamburger-btn {
    display: inline-flex;
    position: relative;
    z-index: 220;
    min-width: 42px;
    min-height: 42px;
    align-items: center;
    justify-content: center;
    touch-action: manipulation;
  }
  main { display: block; height: auto; }
  /* iOS Safari fix: never use display:none on aside — textarea inside kills all touch events.
     Use transform off-screen + pointer-events:none instead. */
  main.full-workspace aside { display: -webkit-flex; display: flex; }
  aside {
    display: -webkit-flex;
    display: flex;
    -webkit-flex-direction: column;
    flex-direction: column;
    position: fixed;
    top: 0; left: 0;
    width: 85vw; max-width: 300px;
    height: 100%;
    z-index: 200;
    background: #0d1220;
    border-right: 1px solid var(--line);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    -webkit-transform: translateX(-110%);
    transform: translateX(-110%);
    pointer-events: none;
    -webkit-transition: -webkit-transform 0.22s ease;
    transition: transform 0.22s ease;
  }
  aside.drawer-open {
    -webkit-transform: translateX(0);
    transform: translateX(0) !important;
    pointer-events: auto !important;
    box-shadow: 10px 0 28px rgba(0,0,0,.42);
  }
  .drawer-close { display: inline-flex; }
  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .workspace { padding: 0; }
  .step-container { padding: 10px; }
  .panel { padding: 10px; margin-bottom: 10px; border-radius: 6px; }
  textarea { min-height: 120px; }
  .btnrow { grid-template-columns: 1fr; }
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
  .view-tabs {
    position: sticky;
    top: 0;
    z-index: 180;
    height: 48px;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
    touch-action: auto;
    pointer-events: auto;
  }
  .view-tab {
    flex: 0 0 118px;
    min-height: 48px;
    scroll-snap-align: start;
    pointer-events: auto;
  }
  .autopilot-grid { grid-template-columns: 1fr; }
  .proposal-paper-grid { grid-template-columns: 1fr; }
  .research-flow { grid-template-columns: 1fr; }
  .pipeline-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .case-toolbar { grid-template-columns: 1fr; }
  .case-row { grid-template-columns: 24px 56px minmax(0, 1fr); }
  .data-row { grid-template-columns: 1fr; }
  .brief-textarea { min-height: 320px; }
}
</style>
</head>
<body>
<header>
  <div style="display:flex;align-items:center;gap:10px;">
    <button id="hamburgerBtn" class="hamburger-btn" type="button" onclick="openSidebar()" aria-label="保存済み案件">☰</button>
    <div>
      <h1>V3 Story Architect</h1>
      <span class="version-badge">${UI_VERSION}</span>
    </div>
  </div>
  <div class="tag">V2 preserved / argumentPlan prototype / port ${PORT}</div>
</header>
<div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>
<nav class="view-tabs" id="stepTabs">
  <button class="view-tab" type="button" data-view="case" onclick="setResultView('case')">1 案件取得</button>
  <button class="view-tab" type="button" data-view="saved" onclick="setResultView('saved')">2 保存済み</button>
  <button class="view-tab" type="button" data-view="proposal" onclick="setResultView('proposal')">3 企画提案</button>
  <button class="view-tab" type="button" data-view="briefing" onclick="setResultView('briefing')">4 企画書</button>
  <button class="view-tab" type="button" data-view="structure" onclick="setResultView('structure')">5 脚本構成</button>
  <button class="view-tab" type="button" data-view="script" onclick="setResultView('script')">6 脚本</button>
  <button class="view-tab" type="button" data-view="export" onclick="setResultView('export')">7 V2</button>
</nav>
<main>
  <aside id="savedDrawer" aria-hidden="true">
    <div class="sidebar-head"><span>保存済み案件</span><button class="drawer-close" type="button" onclick="closeSidebar()">閉じる</button></div>
    <div class="sidebar-body">
    <input type="hidden" id="sourceType" value="custom">
    <input type="hidden" id="title" value="">
    <input type="hidden" id="memo" value="">
      <div id="savedPlans" class="empty">未読込</div>
    </div>
    <div class="sidebar-footer">
      <button onclick="setResultView('saved')">2 保存済み案件</button>
      <div class="sidebar-hint">案件を選んで「2 保存済み」タブから企画提案へ進みます。</div>
    </div>
  </aside>
  <section class="workspace">
    <div id="output">
      <div class="step-container">
        <div class="panel">
          <span class="label">案件取得</span>
          <div class="task-status">画面初期化中。表示が切り替わらない場合も、この画面が見えていればV3本体は配信されています。</div>
        </div>
      </div>
    </div>
  </section>
</main>
<script>
window.addEventListener('error', function(event) {
  var box = document.getElementById('output');
  if (!box) return;
  box.innerHTML = '<div class="step-container"><div class="panel" style="border:2px solid #ef4444;"><span class="label">画面エラー</span><pre>' +
    String((event && (event.message || event.error)) || 'unknown error').replace(/[&<>"]/g, function(c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
    }) + '</pre></div></div>';
});
let currentPlan = null;
let currentResearch = null;
let currentWikiStories = null;
let currentAIPlan = null;
let currentAcquiredData = null;
let currentFetchedData = null;
let savedProjects = [];
let loadedCases = [];
let selectedProject = null;
let selectedCaseIds = new Set();
let activeSlideIdx = 0;
let imageSelections = {};
let activeView = 'case';
const V3_STATE_KEY = 'v3_launcher_working_state';
let stepStatus = {
  case: false,
  saved: false,
  proposal: false,
  briefing: false,
  structure: false,
  script: false,
  export: false,
};

function persistV3State() {
  try {
    localStorage.setItem(V3_STATE_KEY, JSON.stringify({
      currentPlan,
      currentResearch,
      currentWikiStories,
      currentAIPlan,
      currentAcquiredData,
      currentFetchedData,
      selectedProject,
      activeView,
      activeSlideIdx,
      title: document.getElementById('title')?.value || '',
      memo: document.getElementById('memo')?.value || '',
      sourceType: document.getElementById('sourceType')?.value || 'custom',
    }));
  } catch (_) {}
}

function restoreV3State() {
  try {
    const raw = localStorage.getItem(V3_STATE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    currentPlan = state.currentPlan || null;
    currentResearch = state.currentResearch || null;
    currentWikiStories = state.currentWikiStories || null;
    currentAIPlan = state.currentAIPlan || null;
    currentAcquiredData = state.currentAcquiredData || null;
    currentFetchedData = state.currentFetchedData || null;
    selectedProject = state.selectedProject || null;
    activeView = state.activeView || 'case';
    activeSlideIdx = state.activeSlideIdx || 0;
    if (state.title && document.getElementById('title')) document.getElementById('title').value = state.title;
    if (state.memo && document.getElementById('memo')) document.getElementById('memo').value = state.memo;
    if (state.sourceType && document.getElementById('sourceType')) document.getElementById('sourceType').value = state.sourceType;
  } catch (_) {}
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function todayLocalDate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function applyProjectToInputs(project) {
  if (!project) return;
  selectedProject = project;
  const title = document.getElementById('title');
  const memo = document.getElementById('memo');
  const source = document.getElementById('sourceType');
  if (title) title.value = project.title || project.titleJa || project.raw?.title || '';
  if (source) source.value = project.source === '5ch' ? '5ch' : (project.source === 'reddit' ? 'reddit' : 'custom');
  if (memo) {
    const raw = project.raw || {};
    memo.value = [
      raw.selftext || raw.body || raw.customNote || '',
      Array.isArray(raw.comments) ? raw.comments.slice(0, 8).map((c) => c.body || c.text || c).join('\\n') : '',
    ].filter(Boolean).join('\\n\\n').trim();
  }
}

function projectMemoText(project) {
  const raw = project?.raw || {};
  return [
    raw.selftext || raw.body || raw.customNote || '',
    Array.isArray(raw.comments) ? raw.comments.slice(0, 8).map((c) => c.body || c.text || c).join('\\n') : '',
  ].filter(Boolean).join('\\n\\n').trim();
}

function toggleCustomCasePanel() {
  document.getElementById('customCasePanel')?.classList.toggle('open');
}

function setSidebarOpen(isOpen) {
  const aside = document.getElementById('savedDrawer') || document.querySelector('aside');
  const overlay = document.getElementById('sidebarOverlay');
  if (!aside || !overlay) return;
  document.body.classList.toggle('drawer-is-open', isOpen);
  aside.classList.toggle('drawer-open', isOpen);
  aside.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  aside.style.display = 'flex';
  aside.style.transform = isOpen ? 'translateX(0)' : 'translateX(-110%)';
  aside.style.webkitTransform = isOpen ? 'translateX(0)' : 'translateX(-110%)';
  aside.style.pointerEvents = isOpen ? 'auto' : 'none';
  aside.style.position = 'fixed';
  aside.style.zIndex = isOpen ? '10000' : '';
  aside.style.visibility = isOpen ? 'visible' : '';
  aside.style.opacity = isOpen ? '1' : '';
  overlay.classList.toggle('active', isOpen);
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function openSidebar() {
  setSidebarOpen(true);
}

function closeSidebar() {
  setSidebarOpen(false);
}

function toggleSidebar() {
  const aside = document.getElementById('savedDrawer') || document.querySelector('aside');
  setSidebarOpen(!aside?.classList.contains('drawer-open'));
}

function bindHamburgerMenu() {
  const btn = document.getElementById('hamburgerBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSidebar();
  }, { passive: false });
  btn.addEventListener('touchend', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSidebar();
  }, { passive: false });
}

window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.toggleSidebar = toggleSidebar;

async function persistSavedProjects() {
  const res = await fetch('/api/v3/saved-projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: savedProjects }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '保存失敗');
  return data;
}

async function saveCustomCase() {
  const title = document.getElementById('customCaseTitle')?.value.trim();
  const memo = document.getElementById('customCaseMemo')?.value.trim();
  if (!title) return alert('カスタム案件名を入れてください');
  const now = new Date().toISOString();
  const id = 'custom_' + Date.now();
  const item = {
    id,
    title,
    titleOrig: title,
    addedAt: now,
    source: 'custom',
    score: 0,
    raw: { id, title, source: 'custom', isCustom: true, customNote: memo || '', addedAt: now },
  };
  savedProjects.push(item);
  try {
    await persistSavedProjects();
    applyProjectToInputs(item);
    selectedProject = item;
    document.getElementById('customCaseTitle').value = '';
    document.getElementById('customCaseMemo').value = '';
    activeView = 'saved';
    await loadSaved();
    renderPlan(currentPlan);
  } catch (error) {
    alert(error.message);
  }
}

async function loadCases() {
  const date = document.getElementById('caseDate')?.value || todayLocalDate();
  const box = document.getElementById('caseList');
  if (box) box.innerHTML = '<div class="empty">読込中...</div>';
  try {
    const res = await fetch('/api/v3/content?date=' + encodeURIComponent(date));
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    loadedCases = data.posts || [];
    selectedCaseIds = new Set();
    renderPlan(currentPlan);
  } catch (error) {
    if (box) box.innerHTML = '<div class="empty">案件読込失敗: ' + esc(error.message) + '</div>';
  }
}

function toggleCase(id) {
  if (selectedCaseIds.has(id)) selectedCaseIds.delete(id);
  else selectedCaseIds.add(id);
  renderPlan(currentPlan);
}

function toggleCaseIndex(index) {
  const item = loadedCases[index];
  if (item?.id) toggleCase(item.id);
}

function toggleCaseGroup(el) {
  const group = el?.closest('.time-group');
  if (!group) return;
  group.classList.toggle('open');
}

async function saveSelectedCases() {
  const picked = loadedCases.filter((p) => selectedCaseIds.has(p.id));
  if (!picked.length) return alert('保存する案件を選んでください');
  const byId = new Map(savedProjects.map((p) => [p.id, p]));
  picked.forEach((p) => byId.set(p.id, p));
  savedProjects = Array.from(byId.values());
  await persistSavedProjects();
  applyProjectToInputs(picked[0]);
  selectedCaseIds = new Set();
  currentPlan = null;
  currentResearch = null;
  currentWikiStories = null;
  currentAIPlan = null;
  currentAcquiredData = null;
  activeView = 'saved';
  await loadSaved();
  renderPlan(currentPlan);
}

function selectSavedProject(index) {
  const project = savedProjects[index];
  if (!project) return;
  applyProjectToInputs(project);
  currentPlan = null;
  currentResearch = null;
  currentWikiStories = null;
  currentAIPlan = null;
  currentAcquiredData = null;
  renderPlan(currentPlan);
  loadSaved();
  closeSidebar();
}

async function goToProposalFromSidebar() {
  if (!selectedProject) return alert('先に左の保存済み案件を選んでください');
  activeView = 'proposal';
  renderPlan(currentPlan);
}

function markStepDone(view) {
  stepStatus[view] = true;
  if (view === 'proposal') {
    stepStatus.briefing = true;
    stepStatus.structure = true;
    stepStatus.script = true;
  }
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
  if (btn) {
    btn.disabled = true;
    btn.textContent = '設計中...';
  }
  try {
    const res = await fetch('/api/v3/argument-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: document.getElementById('title').value,
        memo: document.getElementById('memo').value,
        sourceType: document.getElementById('sourceType').value,
        brief: readBriefEditor(),
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'failed');
    currentPlan = data.plan;
    markStepDone('case');
    fillBriefEditor(currentPlan);
    renderPlan(currentPlan);
    const target = document.getElementById('resultTop');
    if (shouldScroll) target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    document.getElementById('output').innerHTML = '<div class="empty">生成失敗: ' + esc(error.message) + '</div>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '設計する';
    }
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
    bindResearchCandidates();
    markStepDone('research');
    if (currentPlan) renderPlan(currentPlan);
    else renderResearchOnly();
    activeView = 'proposal';
    if (currentPlan) renderPlan(currentPlan);
  } catch (error) {
    alert('リサーチ失敗: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'リサーチ';
  }
}

async function runProposal() {
  const btn = document.getElementById('proposalStepBtn');
  const status = document.getElementById('proposalRunStatus');
  if (btn) { btn.disabled = true; btn.textContent = '調査中...'; }
  if (status) status.textContent = '1/4 検索クエリを作成しています...';
  try {
    if (!currentPlan) await generatePlan({ scroll: false });
    if (status) status.textContent = '2/4 Webリサーチ中です...';
    const searchTopic = compactSearchTopic(document.getElementById('title').value, document.getElementById('memo').value);
    const baseBody = {
      topic: searchTopic,
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
    bindResearchCandidates();
    currentAcquiredData = buildAcquiredDataSummary();
    activeView = 'proposal';
    renderPlan(currentPlan);
    const nextStatus = document.getElementById('proposalRunStatus');
    if (nextStatus) nextStatus.textContent = '3/4 記事からエンティティを抽出し、SofaScoreからデータを自動取得中...';

    // Auto-prefetch: 記事テキストから選手/チームを抽出→SofaScore叩く
    try {
      const prefetchRes = await fetch('/api/v3/auto-prefetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: document.getElementById('title').value,
          memo: document.getElementById('memo').value,
          learningCorpus: currentResearch?.learningCorpus || [],
          wikiResults: currentWikiStories?.results || [],
        }),
      });
      const prefetchData = await prefetchRes.json();
      currentFetchedData = prefetchData.success ? (prefetchData.labels || []) : [];
    } catch (prefetchErr) {
      console.warn('[auto-prefetch] failed:', prefetchErr.message);
      currentFetchedData = [];
    }
    currentAcquiredData = buildAcquiredDataSummary();
    renderPlan(currentPlan);
    if (nextStatus) nextStatus.textContent = '4/4 データ取得完了。AI企画書を作成中...';

    try {
      const fetchedSummary = (currentFetchedData || []).filter(d => d.ok)
        .map(d => d.nameEn + ': ' + d.summary).join('\\n');
      const enrichedMemo = document.getElementById('memo').value +
        (fetchedSummary ? '\\n\\n[SofaScore自動取得データ]\\n' + fetchedSummary : '');
      const analyzeRes = await fetch('/api/v3/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: document.getElementById('title').value,
          memo: enrichedMemo,
          researchCorpus: currentResearch,
          wikiStories: currentWikiStories,
        }),
      });
      const analyzeData = await analyzeRes.json();
      if (!analyzeData.success) throw new Error(analyzeData.error || 'AI analysis failed');
      currentAIPlan = analyzeData.result;
      currentPlan.autopilotPlan = buildMergedAutopilotPlan(currentPlan.autopilotPlan, currentAIPlan);
    } catch (aiError) {
      currentPlan.autopilotPlan = buildFallbackAutopilotPlan(currentPlan.autopilotPlan, aiError.message);
    }
    currentAcquiredData = buildAcquiredDataSummary();
    markStepDone('proposal');
    activeView = 'proposal';
    renderPlan(currentPlan);
    const doneStatus = document.getElementById('proposalRunStatus');
    if (doneStatus) doneStatus.textContent = '4/4 調査完了。取得材料と企画書案を表示しました。';
  } catch (error) {
    alert('企画提案失敗: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '調査'; }
  }
}

function tokenizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 40);
}

function bindResearchCandidates() {
  const tasks = currentPlan?.researchDesign?.tasks || [];
  const articles = currentResearch?.learningCorpus || [];
  if (!tasks.length || !articles.length) return;

  tasks.forEach((task) => {
    const terms = tokenizeForMatch([task.need, task.query, task.expectedOutput].join(' '));
    let best = null;
    articles.forEach((article) => {
      const hay = [article.title, article.host, article.text].join(' ').toLowerCase();
      const hits = terms.filter((term) => hay.includes(term)).length;
      const score = hits + Number(article.score || 0);
      if (!best || score > best.score) best = { article, score, hits };
    });
    if (!best || best.hits === 0) return;
    task.valueCandidate = String(best.article.text || '').slice(0, 260);
    task.sourceUrl = best.article.url || '';
    task.sourceTitle = best.article.title || '';
    task.confidence = best.hits >= 4 ? 'medium' : 'low';
    task.status = 'candidate_bound';
  });
}

function inferEntityLabels() {
  const text = [
    document.getElementById('title')?.value || '',
    document.getElementById('memo')?.value || '',
    ...(currentResearch?.learningCorpus || []).slice(0, 4).map((x) => x.title || ''),
  ].join(' ');
  const matches = text.match(/[A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+){0,3}|[ァ-ヶー]{3,}|[一-龯]{2,}/g) || [];
  const stop = new Set([
    'Reddit', 'Step', 'VPS', 'AI', 'Web', 'Wiki', 'SofaScore', 'Transfermarkt',
    '杯出場国', '出場国', '北米予選', '予選', '種子島', '人口', '背景', '本件',
    '検索', '記事', '調査', '企画', '作成', '取得',
  ]);
  return Array.from(new Set(matches.map((x) => x.trim()).filter((x) => x.length >= 3 && !stop.has(x)))).slice(0, 8);
}

function compactSearchTopic(title, memo) {
  const s = String(title || memo || '').trim();
  const seeds = [];
  if (/キュラソー|Cura[cç]ao|Curacao/i.test(s)) seeds.push('Curacao national football team World Cup qualification');
  if (/北米予選|CONCACAF|北中米/i.test(s)) seeds.push('CONCACAF World Cup qualifying Curacao');
  if (/人口|15万|小さい|種子島/.test(s)) seeds.push('Curacao population football World Cup smallest country');
  if (seeds.length) return seeds.join(' / ');
  return s
    .replace(/[、。！？!?].*$/, '')
    .split(/\s+/)
    .slice(0, 10)
    .join(' ')
    .slice(0, 100) || s.slice(0, 100);
}

function sentencePick(text, patterns, fallback = '') {
  const sentences = String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[。.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 220);
  for (const pattern of patterns) {
    const hit = sentences.find((s) => pattern.test(s));
    if (hit) return hit;
  }
  return fallback || sentences[0] || '';
}

function buildArticleDigest(articles) {
  const full = articles.filter((item) => /^full_text/.test(item.fetchStatus || ''));
  const pool = full.length ? full : articles;
  const merged = pool.map((item) => [item.title, item.text].join('。')).join(' ');
  return {
    bullets: [
      { label: '出来事の概要', text: sentencePick(merged, [/qualif|予選|World Cup|W杯|出場|Cura[cç]ao|キュラソー/i], 'キュラソーのW杯予選突破と、その背景を確認する流れ。') },
      { label: '主な論点', text: sentencePick(merged, [/population|人口|small|小さ|diaspora|Netherlands|オランダ|CONCACAF|北中米/i], '人口規模、北中米予選の構造、海外育成選手の活用が主な論点。') },
      { label: '裏話・人物', text: sentencePick(merged, [/coach|manager|player|選手|監督|comment|said|コメント/i], '関係者コメントや主要選手の裏取りは、本文取得できた記事と構造化データで追加確認する。') },
      { label: '企画化の材料', text: sentencePick(merged, [/historic|history|first|初|smallest|快挙|record|記録/i], '奇跡の一言に絞らず、制度・人材供給・チーム作りを別々の企画切り口にできる。') },
    ],
    fullTextCount: full.length,
    articleCount: articles.length,
  };
}

function buildAcquiredDataSummary() {
  const articles = currentResearch?.learningCorpus || [];
  const tasks = currentPlan?.researchDesign?.tasks || [];
  const boundTasks = tasks.filter((task) => task.status === 'candidate_bound' || task.sourceUrl || task.valueCandidate);
  const wikiResults = currentWikiStories?.results || [];
  const entities = inferEntityLabels();
  const structured = [];
  wikiResults.slice(0, 4).forEach((item) => {
    structured.push({
      label: item.entity + ' - Wiki小話候補',
      source: 'Wikipedia',
      value: (item.sideStoryCandidates || []).map((x) => x.text).join(' ').slice(0, 220),
      status: 'side_story',
    });
  });
  return {
    queries: currentResearch?.queries || tasks.map((task) => task.query).filter(Boolean).slice(0, 6),
    articleDigest: buildArticleDigest(articles),
    webSources: articles.slice(0, 8).map((item) => ({
      title: item.title || item.host || 'article',
      url: item.url || '',
      host: item.host || '',
      fetchStatus: item.fetchStatus || '',
    })),
    structuredData: structured.slice(0, 12),
    entities,
  };
}

async function runAnalysis(opts = {}) {
  if (!currentResearch && !opts.allowEmptyCorpus) {
    alert('先にStep2「企画提案を作る」を実行してね。AI分析はリサーチ済み材料を使います。');
    activeView = 'proposal';
    if (currentPlan) renderPlan(currentPlan);
    return;
  }
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
    markStepDone('proposal');
    activeView = 'proposal';
    if (currentPlan) renderPlan(currentPlan);
  } catch (error) {
    alert('AI分析失敗: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'AIで再分析'; }
  }
}

async function exportToV2() {
  if (!currentPlan) await generatePlan({ scroll: false });
  collectV3SlideInputs();
  const btn = document.getElementById('exportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'V2保存中...'; }
  try {
    const res = await fetch('/api/v3/export-v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: currentPlan,
        sourceType: document.getElementById('sourceType').value,
        memo: document.getElementById('memo').value,
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'export failed');
    markStepDone('export');
    alert('V2へ渡したよ: ' + data.postId + '\\nV2ランチャーの保存済み案件から開けます。');
  } catch (error) {
    alert('V2連携失敗: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'V2へ渡す'; }
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

function buildFallbackAutopilotPlan(base, reason) {
  const topic = document.getElementById('title')?.value || currentPlan?.topic || '';
  const tasks = currentPlan?.researchDesign?.tasks || [];
  const dataNeeds = tasks.map((task) => task.need || task.expectedOutput || task.query).filter(Boolean).slice(0, 6);
  const queries = currentResearch?.queries || [];
  const candidates = [
    {
      angle: '小国がW杯へ届いた理由を分解する',
      hookQuestion: 'なぜ人口15万人規模のキュラソーが北米予選を勝ち上がれたのか？',
      answer: '偶然の快進撃ではなく、選手供給ルート、予選構造、チーム作りの噛み合わせを検証する。',
      dataNeeds,
      risk: '出場確定日、予選方式、人口などの数字は必ず出典付きで固定する。',
    },
    {
      angle: '人口規模の異常値から見るサッカー代表の作り方',
      hookQuestion: '種子島より小さい国が、なぜ大国を押しのけられたのか？',
      answer: '国の規模だけでなく、ディアスポラ、二重国籍、海外育成選手の活用が競争力を作る。',
      dataNeeds,
      risk: '国籍・ルーツの説明は断定しすぎず、公式登録と報道で確認する。',
    },
    {
      angle: '北中米予選の構造が生んだ歴史的チャンス',
      hookQuestion: '今回のW杯予選は、なぜキュラソーに追い風だったのか？',
      answer: '開催国枠や予選フォーマットの変化、地域内の力関係を背景として整理する。',
      dataNeeds: queries.length ? queries : dataNeeds,
      risk: '予選制度の説明はFIFA/CONCACAF公式を優先する。',
    },
  ];
  return {
    ...base,
    aiGenerated: false,
    aiFallback: true,
    aiFallbackReason: reason || '',
    themeProposal: {
      ...(base?.themeProposal || {}),
      candidates,
      selected: 0,
      selectedReason: 'AI分析が完了しない場合の暫定案。Webリサーチ材料をもとに次工程で精査する。',
      rejectedReasons: [],
    },
    briefing: {
      ...(base?.briefing || {}),
      purpose: topic + 'を、人口規模・選手供給・予選構造の3点から検証する。',
      coreMessage: '小国の奇跡として消費せず、勝ち上がりの背景をデータで説明する。',
      chapters: [
        { no: 1, role: 'hook', claim: '人口15万人規模という異常値を提示する。' },
        { no: 2, role: 'context', claim: 'キュラソーがどの予選ルートで勝ち上がったかを整理する。' },
        { no: 3, role: 'data', claim: '代表メンバーの所属先・ルーツ・主要選手を確認する。' },
        { no: 4, role: 'answer', claim: '小国でも戦える構造的理由をまとめる。' },
      ],
      dataPlan: dataNeeds.map((need) => ({ need })),
      riskChecklist: ['出場確定日を固定する', '人口・面積比較に出典を付ける', '国籍やルーツを雑に断定しない'],
    },
    mustCheck: dataNeeds.map((need) => ({ need, query: '', sourcePriority: [] })),
  };
}

function selectThemeCandidate(index) {
  if (!currentPlan?.autopilotPlan?.themeProposal) return;
  const proposal = currentPlan.autopilotPlan.themeProposal;
  const candidates = proposal.candidates || [];
  const selected = candidates[index];
  if (!selected) return;
  proposal.selected = index;
  proposal.hookQuestion = selected.hookQuestion || proposal.hookQuestion || '';
  proposal.answer = selected.answer || proposal.answer || '';
  proposal.angle = selected.angle || proposal.angle || '';
  proposal.dataPlan = (selected.dataNeeds || []).map((need, i) => ({ no: i + 1, need }));
  activeView = 'proposal';
  renderPlan(currentPlan);
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
  const res = await fetch('/api/v3/saved-projects');
  const data = await res.json();
  savedProjects = Array.isArray(data) ? data : [];
  const box = document.getElementById('savedPlans');
  if (box) {
    if (!savedProjects.length) {
      box.className = 'empty';
      box.textContent = '保存済みなし';
    } else {
      box.className = 'saved-list';
      box.innerHTML = savedProjects.slice().reverse().slice(0, 30).map((item, revIndex) => {
        const index = savedProjects.length - 1 - revIndex;
        const active = selectedProject?.id && selectedProject.id === item.id;
        return '<div class="saved-lead-item' + (active ? ' active' : '') + '" onclick="selectSavedProject(' + index + ')">' +
        '<b>' + esc(item.title || item.titleJa || item.id) + '</b><br>' +
        '<span>' + esc(item.source || '') + ' / score ' + esc(item.score || 0) + '</span>' +
        '<span>' + esc(item.addedAt || '') + '</span>' +
        '</div>';
      }).join('');
    }
  }
  if (activeView === 'saved') renderPlan(currentPlan);
}

function renderPlan(plan) {
  document.getElementById('output').innerHTML = renderResultTabs(plan);
  updateWorkspaceChrome();
  document.querySelectorAll('.view-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === activeView);
  });
  syncProxyInputs();
  persistV3State();
  if (activeView === 'structure') setTimeout(() => reloadV3Preview(), 50);
}

function syncProxyInputs() {
  const title = document.getElementById('title')?.value || '';
  const memo = document.getElementById('memo')?.value || '';
  const sourceType = document.getElementById('sourceType')?.value || 'custom';
  const pt = document.getElementById('proxyTitle');
  const pm = document.getElementById('proxyMemo');
  const ps = document.getElementById('proxySourceType');
  if (pt) pt.value = title;
  if (pm) pm.value = memo;
  if (ps) ps.value = sourceType;
}

function syncProxySourceType(el) {
  const target = document.getElementById('sourceType');
  if (target) target.value = el?.value || 'custom';
}

function syncProxyTitle(el) {
  const target = document.getElementById('title');
  if (target) target.value = el?.value || '';
}

function syncProxyMemo(el) {
  const target = document.getElementById('memo');
  if (target) target.value = el?.value || '';
}

function updateWorkspaceChrome() {
  document.querySelector('main')?.classList.toggle('full-workspace', activeView !== 'case');
}

function setResultView(view) {
  if (activeView === 'structure' && view !== 'structure') collectV3SlideInputs();
  if (activeView === 'briefing' && view !== 'briefing') updateBriefingFromEditor();
  closeSidebar();
  activeView = view;
  renderPlan(currentPlan);
  if (view === 'saved') loadSaved();
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
    ['2', '企画提案', 'リサーチ→AI分析→複数案'],
    ['3', '企画書', '採用案を制作指示にする'],
    ['4', '構成', 'スライド順に展開'],
    ['5', '脚本', 'TTS前のたたき台'],
    ['6', 'V2', '動画生成ラインへ渡す'],
  ];
  return '<div class="pipeline-steps">' + steps.map((s) =>
    '<div class="pipeline-step"><b>' + esc(s[0] + '. ' + s[1]) + '</b><span>' + esc(s[2]) + '</span></div>'
  ).join('') + '</div>';
}

function renderStructureView(plan) {
  if (!Array.isArray(plan.v3Modules) || !plan.v3Modules.length) {
    plan.v3Modules = makeModulesFromCurrentPlan();
  }
  const modules = plan.v3Modules || [];
  const active = Math.max(0, Math.min(activeSlideIdx, modules.length - 1));
  const m = modules[active] || {};
  const dataRows = (m.dataSlots || []).map((slot, i) => (
    '<div class="data-row">' +
      '<input class="v3-data-label" data-idx="' + i + '" value="' + esc(slot.label || '') + '" placeholder="使うデータ" oninput="collectV3SlideInputs()">' +
      '<input class="v3-data-value" data-idx="' + i + '" value="' + esc(slot.value || slot.sourceUrl || '') + '" placeholder="値 / ソースURL" oninput="collectV3SlideInputs()">' +
      '<button class="secondary" onclick="deleteV3DataSlot(' + i + ')">×</button>' +
    '</div>'
  )).join('');
  const pool = Object.values(imageSelections || {}).flat();
  const selectedImgs = Array.isArray(m.images) ? m.images : [];
  return '<span class="label">脚本構成。使うスライド、使うデータとソース、画像、プレビューをここで編集</span>' +
    '<div class="slide-tabs">' + modules.map((item, i) => (
      '<button class="slide-tab' + (i === active ? ' active' : '') + '" onclick="switchV3Slide(' + i + ')">' + esc((i + 1) + ' ' + (item.type || 'slide')) + '</button>'
    )).join('') + '</div>' +
    '<div class="editor-layout">' +
      '<div class="panel">' +
        '<label class="label">使うスライド</label>' +
        '<select id="v3SlideType" onchange="collectV3SlideInputs();reloadV3Preview()">' +
          ['opening','insight','stats','profile','reaction','comparison','history','matchcard','ranking','timeline','picture','ending'].map((type) => '<option value="' + type + '"' + (m.type === type ? ' selected' : '') + '>' + type + '</option>').join('') +
        '</select>' +
        '<label class="label" style="margin-top:10px;">タイトル</label>' +
        '<input id="v3SlideTitle" value="' + esc(m.title || '') + '" oninput="collectV3SlideInputs();scheduleV3Preview()">' +
        '<label class="label" style="margin-top:10px;">脚本</label>' +
        '<textarea id="v3SlideNarration" oninput="collectV3SlideInputs();scheduleV3Preview()">' + esc(m.narration || '') + '</textarea>' +
        '<label class="label" style="margin-top:10px;">使うデータ / ソース</label>' +
        '<div id="v3DataRows">' + (dataRows || '<div class="empty">データ未設定</div>') + '</div>' +
        '<button class="secondary" onclick="addV3DataSlot()">データ行を追加</button>' +
        '<label class="label" style="margin-top:14px;">画像ギャラリー</label>' +
        '<input id="v3ImageUpload" type="file" accept="image/*" onchange="uploadV3Image()" style="display:none;">' +
        '<div class="task-actions"><button class="secondary" onclick="document.getElementById(\\'v3ImageUpload\\').click()">画像アップロード</button><button onclick="reloadV3Preview()">プレビュー更新</button></div>' +
        '<div class="gallery-grid">' +
          (pool.length ? pool.map((src) => (
            '<div class="gallery-thumb' + (selectedImgs.includes(src) ? ' selected' : '') + '" onclick="toggleV3Image(\\'' + esc(src).replace(/'/g, '&#39;') + '\\')"><img src="' + esc(src) + '"></div>'
          )).join('') : '<div class="empty">画像未登録。アップロードすると共有ギャラリーに入ります。</div>') +
        '</div>' +
      '</div>' +
      '<div class="panel">' +
        '<div class="preview-wrap" id="v3PreviewWrap"><iframe id="v3PreviewFrame" scrolling="no"></iframe></div>' +
        '<div class="task-status">編集内容はV3内に保持され、Step6でV2 modules として渡します。</div>' +
        '<div class="panel" style="margin-top:12px;">' + renderStructureSourceList(plan) + '</div>' +
      '</div>' +
    '</div>';
}

function renderStructureSourceList(plan) {
  const modules = plan.v3Modules || [];
  return '<span class="label">明示データ・ソース一覧</span>' +
    '<div class="flow-list">' + modules.map((m, i) => (
      '<div class="flow-item"><b>' + esc((i + 1) + '. ' + (m.title || m.type || 'slide')) + '</b>' +
      '<p>slide: ' + esc(m.type || '') + '</p>' +
      '<div class="chips">' + (m.dataSlots || []).map((s) => '<span class="chip">' + esc((s.label || '') + (s.value ? ': ' + s.value : '') + (s.sourceUrl ? ' / ' + s.sourceUrl : '')) + '</span>').join('') + '</div>' +
      '</div>'
    )).join('') + '</div>';
}

function collectV3SlideInputs() {
  if (!currentPlan?.v3Modules?.length) return;
  const m = currentPlan.v3Modules[activeSlideIdx];
  if (!m) return;
  m.type = document.getElementById('v3SlideType')?.value || m.type;
  m.title = document.getElementById('v3SlideTitle')?.value || '';
  m.narration = document.getElementById('v3SlideNarration')?.value || '';
  const labels = Array.from(document.querySelectorAll('.v3-data-label'));
  m.dataSlots = labels.map((el) => {
    const i = Number(el.dataset.idx);
    const value = document.querySelector('.v3-data-value[data-idx="' + i + '"]')?.value || '';
    return { label: el.value || '', value, sourceUrl: /^https?:/.test(value) ? value : '' };
  }).filter((slot) => slot.label || slot.value);
}

function switchV3Slide(index) {
  collectV3SlideInputs();
  activeSlideIdx = index;
  activeView = 'structure';
  renderPlan(currentPlan);
  setTimeout(() => reloadV3Preview(), 50);
}

function addV3DataSlot() {
  collectV3SlideInputs();
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m) return;
  m.dataSlots = m.dataSlots || [];
  m.dataSlots.push({ label: '', value: '' });
  renderPlan(currentPlan);
}

function deleteV3DataSlot(index) {
  collectV3SlideInputs();
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m) return;
  m.dataSlots.splice(index, 1);
  renderPlan(currentPlan);
  setTimeout(() => reloadV3Preview(), 50);
}

function toggleV3Image(src) {
  collectV3SlideInputs();
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m) return;
  m.images = Array.isArray(m.images) ? m.images : [];
  if (m.images.includes(src)) m.images = m.images.filter((x) => x !== src);
  else m.images.push(src);
  renderPlan(currentPlan);
  setTimeout(() => reloadV3Preview(), 50);
}

async function uploadV3Image() {
  const input = document.getElementById('v3ImageUpload');
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const postId = selectedProject?.id || currentPlan?.topic || 'v3_manual';
    const res = await fetch('/api/v35/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, label: '__v3_manual__', filename: file.name, dataUrl: reader.result }),
    });
    const data = await res.json();
    if (!data.ok) return alert(data.error || 'アップロード失敗');
    imageSelections.__v3_manual__ = imageSelections.__v3_manual__ || [];
    imageSelections.__v3_manual__.push(data.url);
    toggleV3Image(data.url);
  };
  reader.readAsDataURL(file);
}

let v3PreviewTimer = null;
function scheduleV3Preview() {
  clearTimeout(v3PreviewTimer);
  v3PreviewTimer = setTimeout(reloadV3Preview, 350);
}

async function reloadV3Preview() {
  collectV3SlideInputs();
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  const frame = document.getElementById('v3PreviewFrame');
  const wrap = document.getElementById('v3PreviewWrap');
  if (!m || !frame || !wrap) return;
  const res = await fetch('/api/v2/preview-slide-inline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module: m }),
  });
  const html = await res.text();
  const blob = new Blob([html], { type: 'text/html' });
  frame.src = URL.createObjectURL(blob);
  frame.style.transform = 'scale(' + ((wrap.clientWidth || 1) / 1920) + ')';
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

function renderCasePickerPanel() {
  const today = document.getElementById('caseDate')?.value || todayLocalDate();
  const groups = {};
  loadedCases.forEach((p, i) => {
    let t = '不明';
    const at = p.addedAt || '';
    if (at.includes('T')) t = at.split('T')[1].slice(0, 5);
    else if (at.includes(':')) t = at.slice(0, 5);
    if (!groups[t]) groups[t] = [];
    groups[t].push({ p, i });
  });
  const caseRows = loadedCases.length ? Object.keys(groups).sort().reverse().map((t) => {
    const rows = groups[t].map(({ p, i }) => {
      const selected = selectedCaseIds.has(p.id);
      const source = String(p.source || 'custom').toLowerCase();
      const badgeClass = source === '5ch' ? 'badge-5ch' : (source === 'reddit' ? 'badge-reddit' : 'badge-custom');
      const badgeLabel = source === '5ch' ? '5ch' : (source === 'reddit' ? 'Reddit' : source);
      return '<div class="case-row' + (selected ? ' selected' : '') + '" onclick="toggleCaseIndex(' + i + ')">' +
        '<input type="checkbox" ' + (selected ? 'checked ' : '') + 'onclick="event.stopPropagation();toggleCaseIndex(' + i + ')">' +
        '<span class="src-badge ' + badgeClass + '">' + esc(badgeLabel) + '</span>' +
        '<span class="case-title">' + esc(p.title || '') + '</span>' +
      '</div>';
    }).join('');
    return '<div class="time-group open">' +
      '<div class="time-summary" onclick="toggleCaseGroup(this)">' + esc(t) + ' 取得分 (' + groups[t].length + '件)</div>' +
      '<div class="time-content">' + rows + '</div>' +
    '</div>';
  }).join('') : '<div class="empty">日付を選んで「案件取得」を押してください。</div>';

  return '<div class="panel">' +
      '<span class="label">案件取得</span>' +
      '<div class="case-toolbar">' +
        '<input id="caseDate" type="date" value="' + esc(today) + '">' +
        '<button type="button" onclick="loadCases()">案件取得</button>' +
        '<button class="secondary" type="button" onclick="saveSelectedCases()">選択を保存</button>' +
        '<span class="case-spacer"></span>' +
        '<span class="case-count">' + esc(loadedCases.length) + '件 / 選択 ' + esc(selectedCaseIds.size) + '件</span>' +
      '</div>' +
      '<div id="caseList" class="case-list">' + caseRows + '</div>' +
    '</div>';
}

function goToProposal() {
  if (!selectedProject && !document.getElementById('title')?.value) return alert('先に案件を選んでください');
  activeView = 'proposal';
  renderPlan(currentPlan);
}

function renderSavedView(plan) {
  plan = plan || {};
  const selectedTitle = document.getElementById('title')?.value || selectedProject?.title || '';
  const selectedSource = document.getElementById('sourceType')?.value || selectedProject?.source || 'custom';

  if (!savedProjects.length) {
    return '<div class="panel">' +
      '<span class="label">保存済み案件</span>' +
      '<div class="empty">保存済み案件がありません。Step1で案件を取得・保存してください。</div>' +
      '<div class="task-actions"><button class="secondary" onclick="setResultView(\'case\')">← 1 案件取得へ</button></div>' +
    '</div>';
  }

  const listHtml = savedProjects.slice().reverse().slice(0, 50).map(function(item, revIndex) {
    const index = savedProjects.length - 1 - revIndex;
    const active = selectedProject?.id && selectedProject.id === item.id;
    const source = String(item.source || 'custom').toLowerCase();
    const badgeClass = source === '5ch' ? 'badge-5ch' : (source === 'reddit' ? 'badge-reddit' : 'badge-custom');
    const badgeLabel = source === '5ch' ? '5ch' : (source === 'reddit' ? 'Reddit' : 'カスタム');
    const dateStr = (item.addedAt || '').slice(0, 10);
    return '<div class="case-row' + (active ? ' selected' : '') + '" onclick="selectSavedProject(' + index + ')">' +
      '<span class="src-badge ' + badgeClass + '">' + esc(badgeLabel) + '</span>' +
      '<span class="case-title">' + esc(item.title || item.id) + '</span>' +
      '<span style="color:var(--muted);font-size:11px;flex-shrink:0;">' + esc(dateStr) + '</span>' +
    '</div>';
  }).join('');

  const selectedBlock = selectedTitle
    ? '<div class="selected-case-box" style="margin-top:12px;">' +
        '<span class="label">選択中</span>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">' +
          '<span class="src-badge ' + (selectedSource === '5ch' ? 'badge-5ch' : selectedSource === 'reddit' ? 'badge-reddit' : 'badge-custom') + '">' + esc(selectedSource === '5ch' ? '5ch' : selectedSource === 'reddit' ? 'Reddit' : 'カスタム') + '</span>' +
          '<b style="font-size:15px;">' + esc(selectedTitle) + '</b>' +
        '</div>' +
      '</div>'
    : '<div class="task-status" style="margin-top:12px;">上のリストから案件を1つ選んでください。</div>';

  return '<div class="panel">' +
    '<span class="label">保存済み案件 — ' + savedProjects.length + '件</span>' +
    '<div class="case-list" style="max-height:calc(100vh - 430px);min-height:180px;">' + listHtml + '</div>' +
    selectedBlock +
    '<div class="task-actions" style="margin-top:12px;">' +
      '<button ' + (!selectedTitle ? 'disabled ' : '') + 'onclick="goToProposal()">3 企画提案へ進む →</button>' +
      '<button class="secondary" onclick="setResultView(\'case\')">← 1 案件取得</button>' +
    '</div>' +
  '</div>';
}

function renderCaseFetchView() {
  return '<div class="panel">' +
      '<span class="label">Step0 案件取得画面</span>' +
      '<div class="task-status">Reddit / 5ch の取得済み候補を日付で読み込み、使う案件を保存します。</div>' +
    '</div>' +
    renderCasePickerPanel();
}

function renderCaseView(plan) {
  plan = plan || {};
  return renderCasePickerPanel() +
    '<div class="panel">' +
      '<span class="label">カスタム案件入力</span>' +
      '<input id="customCaseTitle" placeholder="例: 久保建英、移籍報道の温度感" style="margin-bottom:8px;">' +
      '<label class="label" style="margin-top:8px;">概要・気になる点</label>' +
      '<textarea id="customCaseMemo" style="min-height:72px;" placeholder="記事URL、相棒メモ、見たい切り口を短く書く"></textarea>' +
      '<div class="task-actions">' +
        '<button onclick="saveCustomCase()">保存</button>' +
        '<button class="secondary" onclick="setResultView(\'saved\')">2 保存済み →</button>' +
      '</div>' +
    '</div>';
}

function renderSelectedCaseBox() {
  const title = document.getElementById('title')?.value || selectedProject?.title || selectedProject?.titleJa || '';
  const source = document.getElementById('sourceType')?.value || selectedProject?.source || '';
  if (!title) {
    return '<div class="case-badge empty-badge">案件未選択 — Step1で案件を選んでください</div>';
  }
  return '<div class="case-badge">' +
    '<span class="chip">' + esc(source || 'custom') + '</span>' +
    '<b>' + esc(title) + '</b>' +
  '</div>';
}

function renderResearchActionPanel() {
  return '<div class="research-action-inline">' +
    '<div class="research-action-row">' +
      '<button id="proposalStepBtn" onclick="runProposal()">調査</button>' +
    '</div>' +
    '<div class="research-flow"><span class="research-step">検索クエリ作成 → Webリサーチ → データ取得 → 企画書A/B/C生成</span></div>' +
    '<div id="proposalRunStatus" class="task-status">調査を押すと、Webリサーチが終わった時点で材料を先に表示します。</div>' +
  '</div>';
}

function renderAcquiredDataView() {
  const data = currentAcquiredData || buildAcquiredDataSummary();
  const hasAny = (data.queries || []).length || (data.webSources || []).length || (data.structuredData || []).length;
  if (!hasAny) {
    return '<div class="panel evidence-section"><span class="label">調査で得た材料</span><div class="empty">まだ調査していません。「調査」を押すと、検索クエリ・Web記事・取得データ候補をここに明示します。</div></div>';
  }
  const fetchedOk = (currentFetchedData || []).filter(d => d.ok);
  const fetchedFail = (currentFetchedData || []).filter(d => !d.ok);
  const fetchedBlock = currentFetchedData
    ? '<div class="panel" style="margin-bottom:10px;">' +
        '<span class="label">SofaScore取得済みデータ</span>' +
        (fetchedOk.length
          ? '<div class="chips" style="margin-top:6px;">' +
              fetchedOk.map(d => '<span class="chip" style="background:#0f2a1a;border-color:#22c55e;color:#bbf7d0;">' + esc(d.nameEn) + ': ' + esc(d.summary) + '</span>').join('') +
            '</div>'
          : '') +
        (fetchedFail.length
          ? '<div class="chips" style="margin-top:4px;">' +
              fetchedFail.map(d => '<span class="chip" style="background:#2a0f0f;border-color:#ef4444;color:#fca5a5;">' + esc(d.nameEn) + ' 取得失敗</span>').join('') +
            '</div>'
          : '') +
        (fetchedOk.length === 0 && fetchedFail.length === 0
          ? '<div class="task-status">SofaScore対象エンティティが検出されませんでした。</div>'
          : '') +
      '</div>'
    : '';
  const summary = 'Web ' + (data.webSources || []).length + '件 / 本文取得 ' + (data.webSources || []).filter((s) => s.fetchStatus === 'full_text' || s.fetchStatus === 'full_text_reader').length + '件 / 関連候補 ' + (data.entities || []).length + '件';
  return fetchedBlock + '<div class="panel evidence-section">' +
    '<details>' +
    '<summary class="label" style="cursor:pointer;user-select:none;">調査で得た材料 — ' + esc(summary) + '</summary>' +
    '<h3 class="research-heading">1. 検索クエリ作成</h3>' +
    '<div class="evidence-list">' +
      '<div class="evidence-item"><div class="chips">' + (data.queries || []).map((q) => '<span class="chip">' + esc(q) + '</span>').join('') + '</div></div>' +
    '</div>' +
    '<h3 class="research-heading">2. Webリサーチ</h3>' +
    '<div class="evidence-list">' + (data.webSources || []).map((item) =>
      '<div class="evidence-item"><b>' + esc(item.title) + '</b><div class="chips"><span class="chip">' + esc(item.host || 'source') + '</span><span class="chip">' + esc(item.fetchStatus || 'snippet') + '</span></div><div class="source-url">' + esc(item.url) + '</div></div>'
    ).join('') + '</div>' +
    '<h3 class="research-heading">3. 関連人物・チーム候補</h3>' +
    '<div class="evidence-list">' +
      '<div class="evidence-item"><div class="chips">' + (data.entities || []).slice(0, 8).map((q) => '<span class="chip">' + esc(q) + '</span>').join('') + '</div></div>' +
    '</div>' +
    '<h3 class="research-heading">4. 記事要約</h3>' +
    '<div class="evidence-list">' + ((data.articleDigest?.bullets || []).map((item) =>
      '<div class="evidence-item"><b>' + esc(item.label) + '</b><p>' + esc(item.text || '') + '</p></div>'
    ).join('')) + '</div>' +
    '</details>' +
  '</div>';
}

function renderReadableBriefingPaper(plan) {
  const auto = plan.autopilotPlan || {};
  const proposal = auto.themeProposal || {};
  const candidates = proposal.candidates || [];
  const selected = candidates[proposal.selected || 0] || {};
  const briefing = auto.briefing || {};
  const chapters = briefing.chapters || [];
  const hasBrief = selected.title || briefing.purpose || briefing.coreMessage || chapters.length;
  if (!hasBrief) {
    return '<div class="briefing-paper"><h2>企画書</h2><p>調査後、ここに採用候補・動画の約束・中心メッセージ・構成案を見やすく表示します。</p></div>';
  }
  return '<div class="briefing-paper">' +
    '<h2>企画書</h2>' +
    '<h3>採用候補</h3><p>' + esc(selected.title || selected.angle || '未選択') + '</p>' +
    '<h3>フック質問</h3><p>' + esc(selected.hook || currentPlan?.centralQuestion || '') + '</p>' +
    '<h3>仮の答え</h3><p>' + esc(selected.answer || briefing.coreMessage || currentPlan?.thesis || '') + '</p>' +
    '<h3>動画の約束</h3><p>' + esc(briefing.purpose || currentPlan?.viewerPromise || '') + '</p>' +
    '<h3>構成案</h3><ol>' + chapters.slice(0, 7).map((item) => '<li>' + esc((item.role || '') + ' - ' + (item.claim || '')) + '</li>').join('') + '</ol>' +
    '<h3>必要データ</h3><div class="chips">' + (briefing.dataPlan || selected.dataNeeds || []).slice(0, 10).map((x) => '<span class="chip">' + esc(x.need || x) + '</span>').join('') + '</div>' +
  '</div>';
}

function fallbackProposalCandidates(plan, defaultNeeds) {
  const topic = plan.topic || document.getElementById('title')?.value || 'この案件';
  return [
    {
      angle: '小国がW杯に届いた構造を分解する',
      hookQuestion: 'なぜ人口規模の小さいキュラソーがW杯予選を勝ち上がれたのか？',
      answer: '人口だけでは説明できず、選手供給ルート、予選構造、チーム作りの組み合わせを検証する。',
      dataNeeds: defaultNeeds,
      risk: '出場確定日、予選方式、人口・面積比較は出典付きで固定する。',
    },
    {
      angle: 'ディアスポラと海外育成が代表を強くする話',
      hookQuestion: '小国代表は、どうやって国の規模を超える戦力を作ったのか？',
      answer: 'オランダ圏とのつながりや海外育成選手の活用を軸に、代表強化の仕組みとして見せる。',
      dataNeeds: defaultNeeds,
      risk: '選手のルーツや国籍条件を推測で断定しない。',
    },
    {
      angle: '北中米予選の制度が生んだ歴史的チャンス',
      hookQuestion: '今回の予選フォーマットはキュラソーにどんな追い風を作ったのか？',
      answer: '開催国枠や地域予選の構造を整理し、歴史的出場の条件を説明する。',
      dataNeeds: defaultNeeds,
      risk: 'CONCACAF/FIFA公式情報で予選制度を確認する。',
    },
  ].map((item) => ({ ...item, title: topic }));
}

function renderProposalPapers(plan) {
  const auto = plan.autopilotPlan || {};
  const proposal = auto.themeProposal || {};
  let candidates = proposal.candidates || [];
  const selectedIdx = proposal.selected || 0;
  const briefing = auto.briefing || {};
  const chapters = briefing.chapters || [];
  const summary = researchReadSummary();
  const basisText = auto.aiGenerated
    ? 'Web ' + summary.webCount + '件・本文 ' + summary.fullTextCount + '件・Wiki ' + summary.wikiCount + '件を読んで生成'
    : '調査後、ここに企画書A/B/Cを表示します。';
  const fallbackPurpose = briefing.purpose || plan.viewerPromise || 'この話題の違和感を、事実とデータで説明する。';
  const fallbackChapters = chapters.length ? chapters : [
    { role: 'hook', claim: plan.centralQuestion || 'まず何が異常なのかを提示する。' },
    { role: 'context', claim: 'ニュースの背景と前提条件を整理する。' },
    { role: 'data', claim: '確認できた記事・数字・関係者情報を並べる。' },
    { role: 'answer', claim: '視聴者が納得できる答えにまとめる。' },
  ];
  const defaultNeeds = (briefing.dataPlan || plan.researchDesign?.tasks || [])
    .map((x) => x.need || x.expectedOutput || x.query || x)
    .filter(Boolean)
    .slice(0, 8);
  const fallbackCandidates = fallbackProposalCandidates(plan, defaultNeeds);
  candidates = [0, 1, 2].map((i) => {
    const c = candidates[i] || {};
    const hasCore = c.angle || c.title || c.hookQuestion || c.hook || c.answer;
    return hasCore ? { ...fallbackCandidates[i], ...c } : fallbackCandidates[i];
  });

  return '<div class="panel">' +
    '<span class="label">4. 企画書A / B / C生成</span>' +
    '<div class="task-status">' + esc(basisText) + '</div>' +
    '<div class="proposal-paper-grid">' +
      candidates.slice(0, 3).map(function(c, i) {
        const letter = String.fromCharCode(65 + i);
        const isSelected = i === selectedIdx;
        const dataNeeds = (c.dataNeeds && c.dataNeeds.length ? c.dataNeeds : defaultNeeds);
        const angle = c.angle || c.title || c.hookQuestion || plan.angle || plan.topic || '調査結果から切り口を作る';
        const hook = c.hookQuestion || c.hook || plan.centralQuestion || plan.topic || 'この話題の本質は何か？';
        const answer = c.answer || briefing.coreMessage || plan.thesis || '取得データをもとに仮説を検証する。';
        if (!isSelected) {
          return '<div class="briefing-paper briefing-paper--compact">' +
            '<h2>企画書' + letter + '</h2>' +
            '<p><b>切り口:</b> ' + esc(angle) + '</p>' +
            '<p><b>フック:</b> ' + esc(hook) + '</p>' +
            '<div class="task-actions"><button onclick="selectThemeCandidate(' + i + ')">この企画書を採用</button></div>' +
          '</div>';
        }
        return '<div class="briefing-paper selected">' +
          '<span class="label" style="font-size:10px;color:var(--muted);">採用中: 企画書' + letter + '</span>' +
          '<p class="proposal-hook-text">' + esc(hook) + '</p>' +
          '<hr class="proposal-divider">' +
          '<div class="proposal-meta-grid">' +
            '<div><span class="label">切り口</span><p>' + esc(angle) + '</p></div>' +
            '<div><span class="label">仮の答え</span><p>' + esc(answer) + '</p></div>' +
          '</div>' +
          '<hr class="proposal-divider">' +
          '<span class="label">動画の約束</span><p style="margin:4px 0 10px;font-size:13px;">' + esc(fallbackPurpose) + '</p>' +
          '<span class="label">構成案</span><ol style="margin:4px 0 10px;padding-left:18px;">' +
            fallbackChapters.slice(0, 5).map((item) => '<li style="font-size:13px;line-height:1.5;">' + esc((item.role || '') + ' — ' + (item.claim || '')) + '</li>').join('') +
          '</ol>' +
          '<span class="label">必要データ</span><div class="chips" style="margin:4px 0 10px;">' +
            dataNeeds.slice(0, 8).map((x) => {
              const need = x.need || x;
              const hit = (currentFetchedData || []).some(d => d.ok && d.nameEn.toLowerCase().split(' ').some(p => String(need).toLowerCase().includes(p)));
              return '<span class="chip" style="' + (hit ? 'border-color:#22c55e;color:#bbf7d0;' : '') + '">' + (hit ? '✅ ' : '❓ ') + esc(need) + '</span>';
            }).join('') +
          '</div>' +
          (c.risk ? '<span class="label" style="color:#f87171;">注意点</span><p style="color:#fecaca;margin:4px 0 10px;font-size:13px;">' + esc(c.risk) + '</p>' : '') +
          '<div class="task-actions"><button disabled>採用中</button></div>' +
        '</div>';
      }).join('') +
    '</div>' +
    (proposal.selectedReason ? '<div class="task-status">採用理由: ' + esc(proposal.selectedReason) + '</div>' : '') +
  '</div>';
}

function renderProposalView(plan) {
  plan = plan || {};
  let html = renderSelectedCaseBox();
  html += renderResearchActionPanel();
  html += renderAcquiredDataView();
  html += renderProposalPapers(plan);
  html += '<div class="task-actions"><button class="secondary" onclick="setResultView(\\'briefing\\')">採用案で企画書へ</button></div>';
  return html;
}

function renderResearchWorkflowView(plan, opts = {}) {
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
  html += renderBoundResearchCards(plan);
  html += '</div>';
  if (!opts.embedded) {
    html += '<div class="task-actions"><button id="researchStepBtn" onclick="runResearch()">リサーチだけ実行</button><button class="secondary" onclick="runProposal()">企画提案まで実行</button></div>';
    html += '<div class="task-status">通常は「企画提案まで実行」でOK。原因切り分けしたい時だけリサーチ単体で使います。</div>';
  }
  html += '<div style="margin-top:10px;">' + renderSourceSamples() + '</div>';
  return html;
}

function renderAnalysisView(plan) {
  const hasResearch = !!currentResearch;
  const auto = plan.autopilotPlan || {};
  const isAI = !!auto.aiGenerated;
  return '<span class="label">AI分析。読んだ材料をもとに、切り口候補・採用案・脚本草稿を作るStep</span>' +
    '<div class="autopilot-grid">' +
      '<div class="autopilot-card"><h2>入力材料</h2><p>' + esc(hasResearch ? researchStatusLabel() : '未リサーチ。先にStep2を実行してください。') + '</p></div>' +
      '<div class="autopilot-card"><h2>分析状態</h2><p>' + esc(isAI ? 'AI分析済み。Step4以降で確認できます。' : '未実行。') + '</p></div>' +
      '<div class="autopilot-card" style="grid-column:1/-1;"><h2>このStepでやること</h2><p>記事を読んだAI編集長が、動画の切り口を2〜3案出し、採用案・ブリーフ・構成・脚本草稿をまとめます。</p></div>' +
    '</div>' +
    '<div class="task-actions">' +
      '<button id="analyzeStepBtn" onclick="runAnalysis()">Step3 AIで分析</button>' +
      '<button class="secondary" onclick="setResultView(\\'theme\\')">結果を見る</button>' +
    '</div>' +
    '<div class="task-status">失敗した場合はこのStepだけが失敗します。リサーチ結果は保持されます。</div>';
}

function renderBoundResearchCards(plan) {
  const bound = (plan.researchDesign?.tasks || [])
    .filter((task) => task.status === 'candidate_bound')
    .slice(0, 6);
  if (!bound.length) return '';
  return '<div class="autopilot-card" style="grid-column:1/-1;"><h2>仮バインド済みの確認候補</h2>' +
    '<div class="flow-list">' +
      bound.map(function(task) {
        return '<div class="flow-item"><b>' + esc(task.need) + '</b>' +
          '<p>' + esc(task.sourceTitle || task.sourceUrl || '') + '</p>' +
          '<p>' + esc(String(task.valueCandidate || '').slice(0, 180)) + '</p>' +
          '<div class="chips"><span class="chip">' + esc(task.confidence) + '</span><span class="chip">' + esc(task.sourceUrl || '') + '</span></div>' +
        '</div>';
      }).join('') +
    '</div></div>';
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
        '<div class="task-actions"><button ' + (isSelected ? 'disabled ' : '') + 'onclick="selectThemeCandidate(' + i + ')">' + (isSelected ? '採用中' : 'この案を採用') + '</button></div>' +
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

function formatBriefingText(plan) {
  const briefing = plan.autopilotPlan?.briefing || {};
  if (briefing.rawText) return briefing.rawText;
  const chapters = briefing.chapters || [];
  const dataPlan = briefing.dataPlan || [];
  const risks = briefing.riskChecklist || [];
  return [
    '【動画の約束】',
    briefing.purpose || plan.viewerPromise || '',
    '',
    '【中心メッセージ】',
    briefing.coreMessage || plan.thesis || '',
    '',
    '【全体の流れ】',
    chapters.map((item) => (item.no || '') + '. ' + (item.role || '') + ' - ' + (item.claim || '')).join('\\n') || '',
    '',
    '【使うデータ】',
    dataPlan.map((x) => '- ' + (x.need || x)).join('\\n') || '',
    '',
    '【注意点】',
    risks.map((x) => '- ' + x).join('\\n') || '',
  ].join('\\n').trim();
}

function updateBriefingFromEditor() {
  if (!currentPlan) return;
  const el = document.getElementById('briefingText');
  const rawText = el ? el.value : formatBriefingText(currentPlan);
  const auto = currentPlan.autopilotPlan || (currentPlan.autopilotPlan = {});
  const briefing = auto.briefing || (auto.briefing = {});
  briefing.rawText = rawText;
  const section = (name) => {
    const m = rawText.match(new RegExp('【' + name + '】([\\\\s\\\\S]*?)(?=\\\\n【|$)'));
    return m ? m[1].trim() : '';
  };
  briefing.purpose = section('動画の約束') || briefing.purpose || '';
  briefing.coreMessage = section('中心メッセージ') || briefing.coreMessage || '';
  const flow = section('全体の流れ');
  if (flow) {
    briefing.chapters = flow.split(/\\n+/).map((line, i) => {
      const clean = line.replace(/^[-・\\d.\\s]+/, '').trim();
      const parts = clean.split(/\\s+-\\s+/);
      return { no: i + 1, role: parts[0] || 'chapter', claim: parts.slice(1).join(' - ') || clean };
    }).filter((x) => x.claim);
  }
  const data = section('使うデータ');
  if (data) {
    briefing.dataPlan = data.split(/\\n+/).map((line) => ({ need: line.replace(/^[-・\\s]+/, '').trim() })).filter((x) => x.need);
  }
}

function makeModulesFromCurrentPlan() {
  if (!currentPlan) return [];
  const auto = currentPlan.autopilotPlan || {};
  const script = Array.isArray(auto.scriptDraft) && auto.scriptDraft.length ? auto.scriptDraft : [];
  const structure = Array.isArray(auto.scriptStructure) ? auto.scriptStructure : [];
  const chapters = auto.briefing?.chapters || [];
  const sourceTasks = currentPlan.researchDesign?.tasks || [];
  const rows = script.length ? script : (structure.length ? structure : chapters).map((item, index) => ({
    slideNo: item.no || index + 1,
    role: item.role || 'chapter',
    title: item.headline || item.role || 'Slide ' + (index + 1),
    narration: item.narration || item.point || item.claim || '',
    dataNeeds: item.dataNeeds || [],
  }));
  if (!rows.length) {
    rows.push({
      slideNo: 1,
      role: 'opening',
      title: currentPlan.topic || document.getElementById('title')?.value || 'Opening',
      narration: auto.briefing?.coreMessage || currentPlan.thesis || '',
      dataNeeds: (auto.briefing?.dataPlan || []).map((x) => x.need).slice(0, 3),
    });
  }
  const total = rows.length;
  return rows.map((item, index) => {
    const needs = Array.isArray(item.dataNeeds) ? item.dataNeeds : [];
    const type = index === 0 ? 'opening' : (index === total - 1 ? 'ending' : (item.slideType || item.type || (needs.length ? 'stats' : 'insight')));
    return {
      mainKey: index === 0 ? 'opening' : (index === total - 1 ? 'ending' : 'v3:slide' + (index + 1)),
      subSource: 'v3',
      subValue: item.role || '',
      secondary: null,
      type,
      scriptDir: item.point || item.claim || '',
      title: item.title || item.headline || 'Slide ' + (index + 1),
      narration: item.narration || item.point || item.claim || '',
      dataSlots: needs.slice(0, 6).map((need) => {
        const task = sourceTasks.find((t) => [t.need, t.expectedOutput, t.query].join(' ').includes(need));
        return { label: need, value: '', sourceUrl: task?.sourceUrl || '', sourceTitle: task?.sourceTitle || '' };
      }),
      images: [],
      catchphrases: [],
      comments: [],
      v3Meta: { role: item.role || '', source: 'v3_editor' },
    };
  });
}

function buildStructureFromBriefing() {
  updateBriefingFromEditor();
  if (!currentPlan) return;
  currentPlan.v3Modules = makeModulesFromCurrentPlan();
  currentPlan.autopilotPlan = currentPlan.autopilotPlan || {};
  currentPlan.autopilotPlan.scriptStructure = currentPlan.v3Modules.map((m, i) => ({
    no: i + 1,
    headline: m.title,
    point: m.scriptDir || m.narration,
    slideType: m.type,
    dataNeeds: (m.dataSlots || []).map((s) => s.label),
    sources: (m.dataSlots || []).map((s) => s.sourceUrl || s.sourceTitle).filter(Boolean),
  }));
  activeSlideIdx = 0;
  markStepDone('structure');
  activeView = 'structure';
  renderPlan(currentPlan);
  setTimeout(() => reloadV3Preview(), 50);
}

function dataStatusChip(need) {
  const hit = (currentFetchedData || []).some(d => d.ok && d.nameEn.toLowerCase().split(' ').some(p => p.length >= 3 && String(need).toLowerCase().includes(p)));
  return '<span class="chip" style="' + (hit ? 'border-color:#22c55e;color:#bbf7d0;' : 'border-color:#ef4444;color:#fca5a5;') + '">' + (hit ? '✅ ' : '❓ ') + esc(need) + '</span>';
}

function renderBriefingPipelineView(plan) {
  const briefing = plan.autopilotPlan?.briefing || {};
  const chapters = briefing.chapters || [];
  const fetchedOk = (currentFetchedData || []).filter(d => d.ok);
  const fetchedPanel = fetchedOk.length
    ? '<div class="panel" style="margin-bottom:10px;">' +
        '<span class="label">取得済みデータ（SofaScore）</span>' +
        '<div class="chips" style="margin-top:6px;">' +
          fetchedOk.map(d => '<span class="chip" style="background:#0f2a1a;border-color:#22c55e;color:#bbf7d0;">' + esc(d.nameEn) + ': ' + esc(d.summary) + '</span>').join('') +
        '</div>' +
      '</div>'
    : '';
  return fetchedPanel +
    '<span class="label">企画書。採用テーマをもとに、動画のブリーフィングを作る段階</span>' +
    '<textarea id="briefingText" class="brief-textarea" oninput="updateBriefingFromEditor()">' + esc(formatBriefingText(plan)) + '</textarea>' +
    '<div class="task-actions"><button onclick="buildStructureFromBriefing()">企画書の内容で脚本構成</button><button class="secondary" onclick="updateBriefingFromEditor();renderPlan(currentPlan)">企画書を反映</button></div>' +
    '<div class="autopilot-grid">' +
      '<div class="autopilot-card"><h2>動画の約束</h2><p>' + esc(briefing.purpose || plan.viewerPromise || '') + '</p></div>' +
      '<div class="autopilot-card"><h2>中心メッセージ</h2><p>' + esc(briefing.coreMessage || plan.thesis || '') + '</p></div>' +
      '<div class="autopilot-card" style="grid-column:1/-1;"><h2>全体の流れ</h2><div class="flow-list">' +
        chapters.slice(0, 7).map((item) => {
          const needs = Array.isArray(item.dataNeeds) ? item.dataNeeds : [];
          const needsHtml = needs.length
            ? '<div class="chips" style="margin-top:4px;">' + needs.map(dataStatusChip).join('') + '</div>'
            : '';
          return '<div class="flow-item"><b>' + esc((item.no || '') + '. ' + (item.role || '')) + '</b><p>' + esc(item.claim) + '</p>' + needsHtml + '</div>';
        }).join('') +
      '</div></div>' +
      '<div class="autopilot-card" style="grid-column:1/-1;"><h2>使うデータ <span style="font-size:11px;font-weight:400;color:var(--muted);">✅取得済 ❓未確認</span></h2><div class="chips">' +
        (briefing.dataPlan || []).slice(0, 10).map((x) => dataStatusChip(x.need || x)).join('') +
      '</div></div>' +
    '</div>';
}

function renderResultTabs(plan) {
  plan = plan || {};
  const panels = {
    case: renderCaseView,
    saved: renderSavedView,
    proposal: renderProposalView,
    briefing: renderBriefingPipelineView,
    structure: renderStructureView,
    script: renderScriptView,
    export: renderExportView,
  };
  const renderActive = panels[activeView] || panels.case;
  return '<div id="resultTop">' +
    '<div class="step-container view-panel" data-view="' + esc(activeView) + '">' + renderActive(plan) + '</div>' +
  '</div>';
}

function renderExportView(plan) {
  const auto = plan.autopilotPlan || {};
  const scriptCount = (auto.scriptDraft || []).length;
  return '<span class="label">V2連携。ここで初めて既存の動画生成ランチャーへ渡します</span>' +
    '<div class="autopilot-grid">' +
      '<div class="autopilot-card"><h2>渡す内容</h2><p>脚本スライド ' + esc(scriptCount || (plan.slidePlan || []).length || 0) + ' 枚分をV2 modules.json形式に変換します。</p></div>' +
      '<div class="autopilot-card"><h2>次の作業</h2><p>V2ランチャーの保存済み案件から開き、Step4でプレビュー確認して動画生成へ進みます。</p></div>' +
    '</div>' +
    '<div class="task-actions"><button id="exportStepBtn" onclick="exportToV2()">Step6 V2へ渡す</button><button class="secondary" onclick="savePlan()">V3案を保存</button></div>' +
    '<div class="task-status">V2へ渡すまではV2データを作りません。ここが最終確認Stepです。</div>';
}

function tidyControls() {
  const briefPanel = document.querySelector('.brief-editor')?.closest('.panel');
  if (briefPanel) briefPanel.style.display = 'none';
  const legacy = document.querySelector('.legacy-actions');
  if (legacy) legacy.style.display = 'none';
}

try {
  tidyControls();
  loadSaved();
  restoreV3State();
  activeView = 'case';
  renderPlan(currentPlan);
  bindHamburgerMenu();
} catch (error) {
  window.dispatchEvent(new ErrorEvent('error', { message: error.message || String(error), error: error }));
}
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`V3 Story Architect running: http://localhost:${PORT}`);
});
