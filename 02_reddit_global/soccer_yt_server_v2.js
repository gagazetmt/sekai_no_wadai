// soccer_yt_server_v2.js
// v2 サッカー YouTube ランチャー Pro統合版（port 3004）

require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const { spawn, execSync } = require('child_process');
const { google } = require('googleapis');

const { proposeModules }    = require('./scripts/modules/proposer');
const { proposeWithData, proposeWithClaude } = require('./scripts/modules/propose_with_data');
const { fetchAllModuleData } = require('./scripts/modules/fetcher');
const { callAI }             = require('./scripts/ai_client');
const { buildSlide }         = require('./scripts/slide_builder');
const { computePresetValues, autoStatsRows, getPresetsForClient, getTopicPresetsForClient } = require('./scripts/stat_presets');

const app  = express();
const PORT = 3004;

const TEMP_DIR    = path.join(__dirname, 'temp');
const DATA_DIR    = path.join(__dirname, 'data');
const IMG_DIR     = path.join(__dirname, 'images');
const SLIDES_DIR  = path.join(__dirname, 'soccer_yt_slides');
const VIDEO_DIR   = path.join(__dirname, 'soccer_yt_videos_v2');
const THUMB_DIR   = path.join(__dirname, 'soccer_yt_thumbnails_v2');
const LOG_FILE    = path.join(__dirname, 'soccer_yt_v2.log');

[TEMP_DIR, VIDEO_DIR, THUMB_DIR, SLIDES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(express.json({ limit: '10mb' }));
app.use('/images',  express.static(IMG_DIR));
app.use('/narrations', express.static(SLIDES_DIR));
app.use('/video-files', express.static(VIDEO_DIR));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function scenarioPath(date, postId) {
  return path.join(TEMP_DIR, `v2_scenario_${date}_${postId}.json`);
}

app.get('/api/v2/content', (req, res) => {
  const dateStr = req.query.date;
  if (!dateStr) return res.status(400).json({ error: '?date=YYYY-MM-DD が必要です' });
  const formattedDate = dateStr.replace(/-/g, "_");
  const storyFile = path.join(DATA_DIR, `stories_${formattedDate}.json`);
  const autoFile  = path.join(DATA_DIR, `auto_generated_${dateStr}.json`);
  const candFile  = path.join(TEMP_DIR, `candidates_${dateStr}.json`);
  let targetFile = null;
  if (fs.existsSync(storyFile)) targetFile = storyFile;
  else if (fs.existsSync(autoFile)) targetFile = autoFile;
  else if (fs.existsSync(candFile)) targetFile = candFile;
  if (!targetFile) return res.json({ date: dateStr, posts: [] });
  const data  = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const posts = (data.posts || []).map((p, i) => {
    const id = p.id || String(i);
    return {
      id,
      title:   p.titleJa || p.title || '（タイトルなし）',
      addedAt: p.addedAt || p.added_at || null,
      source:  p.source || 'unknown',
      score:   p.score || 0,
      hasScenario: fs.existsSync(scenarioPath(dateStr, id)),
      raw:     p
    };
  });
  res.json({ date: dateStr, posts });
});

app.post('/api/v2/fetch-si', async (req, res) => {
  const { date, postId, keywords } = req.body;
  log(`SI取得開始: ${date} ${postId}`);
  try {
    const results = await fetchAllModuleData(keywords);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚽ サッカーYT v2 Pro統合版</title>
<style>
/* ─── 基本スタイル ─── */
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#0f1117;color:#e0e0e0;height:100vh;overflow:hidden}

.layout { display: flex; height: 100vh; width: 100vw; }

/* ─── 左サイドバー (指示書 #1-9) ─── */
.sidebar-left { width: 320px; background: #0d1220; border-right: 1px solid #1e2540; display: flex; flex-direction: column; flex-shrink: 0; }
.sidebar-header { padding: 18px; background: #1a2540; border-bottom: 1px solid #2a3560; color: #7dc8ff; font-weight: 900; font-size: 14px; display: flex; align-items: center; gap: 10px; }
.saved-leads-list { flex: 1; overflow-y: auto; padding: 12px; }
.lead-item { background: #161b2e; border: 1px solid #2a3050; border-radius: 10px; padding: 12px; margin-bottom: 10px; cursor: pointer; transition: all 0.2s; border-left: 4px solid transparent; }
.lead-item:hover { border-color: #1a6ef5; transform: translateX(4px); background: #1e2540; }
.lead-item.active { border-color: #f59e0b; background: #262c40; border-left-color: #f59e0b; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
.lead-title { font-size: 12px; font-weight: bold; color: #e0e8ff; margin-bottom: 6px; line-height: 1.4; }
.lead-meta { font-size: 10px; color: #5a7abf; display: flex; justify-content: space-between; }

/* ─── メインエリア ─── */
.content-main { flex: 1; overflow-y: auto; display: flex; flex-direction: column; background: #0f1117; }
.header{background:linear-gradient(135deg,#1a2040,#0d1220);padding:0 12px;border-bottom:1px solid #2a3050;display:flex;align-items:stretch;min-height:56px;flex-shrink:0}
.header-brand{display:flex;align-items:center;gap:10px;padding-right:16px;border-right:1px solid #2a3050}
.header h1{font-size:16px;font-weight:900;color:#ff4b4b}
.badge{background:#1a4a8a;color:#7dc8ff;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700}
.header-steps{display:flex;align-items:stretch;flex:1;overflow-x:auto}
.hstep{display:flex;align-items:center;gap:6px;padding:0 12px;color:#3a4a6a;font-size:11px;font-weight:600;white-space:nowrap;border-right:1px solid #1a2540;cursor:pointer}
.hstep.active{color:#7dc8ff}
.hstep-num{width:18px;height:18px;border-radius:50%;background:#1a2340;color:#3a4a6a;font-size:9px;display:flex;align-items:center;justify-content:center}
.hstep.active .hstep-num{background:#1a6ef5;color:#fff}

.main-scroll { flex: 1; overflow-y: auto; padding: 20px; }
.panel{background:#161b2e;border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid #2a3050}
.panel-title{font-size:14px;font-weight:700;color:#9bb5e0;margin-bottom:16px;display:flex;align-items:center;gap:8px}

/* ─── 案件リスト (アコーディオン) ─── */
.time-group { margin-bottom: 12px; border: 1px solid #2a3050; border-radius: 10px; overflow: hidden; }
.time-summary { background: #1a2840; padding: 12px 16px; cursor: pointer; color: #f0e080; font-weight: bold; font-size: 13px; display: flex; justify-content: space-between; align-items: center; user-select: none; }
.time-summary:hover { background: #1e2d50; }
.post-item { background: #0d1220; border-bottom: 1px solid #1a2040; padding: 10px 16px; display: flex; align-items: center; gap: 12px; transition: 0.1s; }
.post-item:last-child { border-bottom: none; }
.post-item:hover { background: #141a30; }
.post-title { font-size: 13px; color: #c0d0e0; flex: 1; cursor: pointer; overflow: hidden; text-overflow: ellipsis; }

/* ─── 汎用ボタン ─── */
.btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; border: none; transition: 0.2s; display: inline-flex; align-items: center; gap: 6px; }
.btn-primary { background: #1a6ef5; color: #fff; }
.btn-primary:hover { background: #2a7ef5; }
.btn-success { background: #1a8a4a; color: #fff; }
.btn-success:hover { background: #2a9a5a; }
.btn-ghost { background: #1e2540; color: #9bb5e0; border: 1px solid #2a3050; }
.btn-ghost:hover { background: #2a3560; }
</style>
</head>
<body>
<div class="layout">
  <!-- 左サイドバー: 保存済み案件 (指示書 #1-9) -->
  <div class="sidebar-left">
    <div class="sidebar-header">📦 保存済み案件 (SIスライド候補)</div>
    <div class="saved-leads-list" id="savedLeadsList"></div>
  </div>

  <div class="content-main">
    <div class="header">
      <div class="header-brand"><h1>⚽ サッカーYT</h1><span class="badge">v2 Pro</span></div>
      <div class="header-steps" id="stepNav">
        <div class="hstep active" id="sNav0"><div class="hstep-num">1</div>案件選択</div>
        <div class="hstep" id="sNav1"><div class="hstep-num">2</div>SIスライド</div>
        <div class="hstep" id="sNav2"><div class="hstep-num">3</div>モジュール</div>
        <div class="hstep" id="sNav3"><div class="hstep-num">4</div>脚本・編集</div>
        <div class="hstep" id="sNav4"><div class="hstep-num">5</div>出力</div>
      </div>
    </div>

    <div class="main-scroll">
      <!-- STEP 1: 案件選択 -->
      <div id="step1">
        <div class="panel">
          <div class="panel-title">🕒 案件収集スケジュール (Stories Fetch)</div>
          <div style="display:flex; gap:10px">
            <input type="date" id="dateInput">
            <button class="btn btn-primary" onclick="loadContent()">案件を読み込む</button>
          </div>
        </div>

        <div id="postListPanel" style="display:none">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px">
            <h3 style="font-size:14px; color:#9bb5e0">📋 取得済み案件一覧</h3>
            <button class="btn btn-success" onclick="saveSelectedLeads()">✔️ 選択した案件を保存</button>
          </div>
          <div id="postList"></div>
        </div>
      </div>

      <div id="step2" style="display:none">
        <div class="panel"><div class="panel-title">🎯 選択中の案件</div><div id="selectedPostInfo"></div></div>
        <div class="panel"><div class="panel-title">🔍 SIスライド情報</div><div style="color:#5a7abf;font-size:12px;">（ここにSI情報のUIが入ります）</div></div>
      </div>
      <div id="step3" style="display:none">
        <div class="panel"><div class="panel-title">🧩 モジュール構成</div><div style="color:#5a7abf;font-size:12px;">（モジュール提案のUIが入ります）</div></div>
      </div>
      <div id="step4" style="display:none">
        <div class="panel"><div class="panel-title">✍️ 脚本・編集</div><div style="color:#5a7abf;font-size:12px;">（各モジュールのテキスト編集UIが入ります）</div></div>
      </div>
      <div id="step5" style="display:none">
        <div class="panel"><div class="panel-title">🎬 出力設定</div><div style="color:#5a7abf;font-size:12px;">（動画生成・アップロードUIが入ります）</div></div>
      </div>
    </div>
  </div>
</div>

<script>
let state = {
  date: '',
  posts: [],
  savedLeads: JSON.parse(localStorage.getItem('savedLeads') || '[]'),
  selectedLeadId: null,
  currentStep: 1
};

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function loadContent() {
  const date = document.getElementById('dateInput').value;
  if (!date) return alert('日付を選択してください');
  state.date = date;

  const res  = await fetch('/api/v2/content?date=' + date);
  const data = await res.json();
  state.posts = data.posts;

  const groups = {};
  data.posts.forEach(p => {
    const time = p.addedAt ? p.addedAt.slice(11, 16) : '不明';
    if (!groups[time]) groups[time] = [];
    groups[time].push(p);
  });

  const list = document.getElementById('postList');
  const sortedTimes = Object.keys(groups).sort((a,b) => b.localeCompare(a));

  list.innerHTML = sortedTimes.map(time => {
    return '<details open class="time-group">' +
      '<summary class="time-summary">🕒 ' + time + ' 取得分 (' + groups[time].length + '件)</summary>' +
      '<div>' +
        groups[time].map(p => {
          return '<div class="post-item">' +
            '<input type="checkbox" class="lead-check" value="' + p.id + '" style="width:18px;height:18px">' +
            '<span class="post-title" onclick="selectLeadFromList(\\'' + p.id + '\\')">' + esc(p.title) + '</span>' +
          '</div>';
        }).join('') +
      '</div>' +
    '</details>';
  }).join('');
  
  document.getElementById('postListPanel').style.display = 'block';
  renderSavedLeads();
}

function selectLeadFromList(id) {
  const checkbox = document.querySelector('.lead-check[value="' + id + '"]');
  if (checkbox) checkbox.checked = !checkbox.checked;
}

function saveSelectedLeads() {
  const checked = Array.from(document.querySelectorAll('.lead-check:checked')).map(el => el.value);
  const selectedPosts = state.posts.filter(p => checked.includes(p.id));
  if (selectedPosts.length === 0) return alert('保存する案件を選択してください');

  selectedPosts.forEach(p => {
    if (!state.savedLeads.find(l => l.id === p.id)) {
      state.savedLeads.unshift({ id: p.id, title: p.title, source: p.source, addedAt: p.addedAt, raw: p.raw });
    }
  });
  localStorage.setItem('savedLeads', JSON.stringify(state.savedLeads));
  renderSavedLeads();
  document.querySelectorAll('.lead-check:checked').forEach(el => el.checked = false);
}

function renderSavedLeads() {
  const list = document.getElementById('savedLeadsList');
  if (state.savedLeads.length === 0) {
    list.innerHTML = '<div style=\"color:#3a4a6a;padding:20px;font-size:12px;text-align:center\">保存済みなし</div>';
    return;
  }
  list.innerHTML = state.savedLeads.map(l => {
    const isActive = state.selectedLeadId === l.id ? 'active' : '';
    const time = l.addedAt ? l.addedAt.slice(11, 16) : '--:--';
    return '<div class=\"lead-item ' + isActive + '\" onclick=\"clickLead(\\'' + l.id + '\\')\">' +
             '<div class=\"lead-title\">' + esc(l.title) + '</div>' +
             '<div class=\"lead-meta\"><span>' + l.source + '</span><span>' + time + '</span></div>' +
           '</div>';
  }).join('');
}

function clickLead(id) {
  state.selectedLeadId = id;
  const lead = state.savedLeads.find(l => l.id === id);
  if (!lead) return;
  renderSavedLeads();
  state.selectedPost = lead.raw || lead;
  document.getElementById('selectedPostInfo').innerHTML = 
    '<div style=\"font-size:16px; font-weight:bold; color:#7dc8ff; margin-bottom:8px\">' + esc(lead.title) + '</div>' +
    '<div style=\"font-size:11px; color:#5a7abf\">Source: ' + lead.source + ' | Time: ' + (lead.addedAt || 'Unknown') + '</div>';
  goStep(2);
}

function goStep(n) {
  state.currentStep = n;
  for(let i=1; i<=5; i++) {
    const el = document.getElementById('step'+i);
    if (el) el.style.display = (i===n ? 'block' : 'none');
  }
  for(let i=0; i<5; i++) {
    const nav = document.getElementById('sNav'+i);
    if (nav) nav.className = 'hstep' + (i===n-1 ? ' active' : '');
  }
}

window.onload = () => {
  document.getElementById('dateInput').value = new Date().toISOString().slice(0,10);
  renderSavedLeads();
};
</script>
</body></html>`));

app.listen(PORT, () => console.log('v2 Server running at http://localhost:' + PORT));
