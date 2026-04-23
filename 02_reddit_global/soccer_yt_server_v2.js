// soccer_yt_server_v2.js
// v2 サッカー YouTube ランチャー Pro統合版（port 3004）
// 【改修内容】全SIソースの本気実装 ＋ ゲートウェイ維持 ＋ 赤色モード

require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const { spawn, execSync } = require('child_process');
const axios     = require('axios');

const { proposeWithData }    = require('./scripts/modules/propose_with_data');
const { fetchAllModuleData } = require('./scripts/modules/fetcher');
const { callAI }             = require('./scripts/ai_client');

const app  = express();
const PORT = 3004;

const TEMP_DIR    = path.join(__dirname, 'temp');
const DATA_DIR    = path.join(__dirname, 'data');
const IMG_DIR     = path.join(__dirname, 'images');
const LOG_FILE    = path.join(__dirname, 'soccer_yt_v2.log');

[TEMP_DIR, DATA_DIR, IMG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json({ limit: '10mb' }));
app.use('/images', express.static(IMG_DIR));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ─── ゲートウェイ設定 ───
const LOCAL_AGENT_IP = process.env.LOCAL_AGENT_IP || null;
const LOCAL_AGENT_URL = LOCAL_AGENT_IP ? `http://${LOCAL_AGENT_IP}:3004` : null;

async function delegateToLocal(endpoint, data) {
  if (!LOCAL_AGENT_URL) return null;
  log(`[Gateway] Local Agent へ委託: ${endpoint}`);
  try {
    const res = await axios.post(`${LOCAL_AGENT_URL}${endpoint}`, data, { timeout: 120000 });
    return res.data;
  } catch (err) {
    log(`[Gateway] Local Agent 連携エラー: ${err.message}`);
    return null; 
  }
}

// ─── データ整形プログラム (指示書 #2-4) ───
function sanitizeData(data) {
  if (typeof data === 'string') {
    return data.replace(/"/g, '”').replace(/'/g, '’').replace(/,/g, '，').replace(/\n/g, ' ');
  }
  if (Array.isArray(data)) return data.map(sanitizeData);
  if (typeof data === 'object' && data !== null) {
    const res = {};
    for (const key in data) res[key] = sanitizeData(data[key]);
    return res;
  }
  return data;
}

// ─── API エンドポイント ───

const { fetchWikipediaSafe } = require('./scripts/modules/fetchers/wikipedia');
const { fetchSofaScorePlayer } = require('./scripts/modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam } = require('./scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreManager } = require('./scripts/modules/fetchers/sofascore_manager');
const { fetchSofaScoreMatch } = require('./scripts/modules/fetchers/sofascore_match');
const { fetchSerper } = require('./scripts/modules/fetchers/serper_module');

app.post('/api/v2/fetch-si', async (req, res) => {
  log(`SI取得リクエスト受付: ${JSON.stringify(req.body.keywords)}`);
  
  // 1. ローカルプロキシへ委託
  const remoteResult = await delegateToLocal('/api/v2/fetch-si', req.body);
  if (remoteResult && (remoteResult.success || remoteResult.data)) return res.json(remoteResult);

  // 2. 自身で取得 (VPS)
  const { keywords } = req.body;
  try {
    const results = {};
    for (const k of keywords) {
      log(`[Direct] Fetching ${k.type}: ${k.word}`);
      let data = { ok: false, error: '取得失敗' };
      
      if (k.type === 'wikipedia') {
        data = await fetchWikipediaSafe([k.word]);
      } else if (k.type === 'sofascore_pmt') {
        data = await fetchSofaScorePlayer(k.word);
        if (!data.ok) data = await fetchSofaScoreTeam(k.word);
        if (!data.ok) data = await fetchSofaScoreManager(k.word);
      } else if (k.type === 'sofascore_event') {
        const teams = k.word.split(/vs|VS|-|－/);
        if (teams.length >= 2) data = await fetchSofaScoreMatch(teams[0].trim(), teams[1].trim());
        else data = { ok: false, error: '対戦形式で入力してください' };
      } else if (k.type === 'news') {
        data = await fetchSerper(k.word, 'news', 'en');
        data = { ok: !!data, items: data };
      }
      
      results[k.word] = sanitizeData(data);
    }
    res.json({ success: true, data: results });
  } catch (err) {
    log(`[Direct] SI取得エラー: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v2/content', (req, res) => {
  const dateStr = req.query.date;
  if (!dateStr) return res.status(400).json({ error: '?date=YYYY-MM-DD が必要です' });
  const formattedDate = dateStr.replace(/-/g, "_");
  const storyFile = path.join(DATA_DIR, `stories_${formattedDate}.json`);
  if (!fs.existsSync(storyFile)) return res.json({ date: dateStr, posts: [] });
  const data = JSON.parse(fs.readFileSync(storyFile, 'utf8'));
  res.json({ date: dateStr, posts: (data.posts || []).map((p, i) => ({ id: p.id || String(i), title: p.titleJa || p.title, addedAt: p.addedAt, source: p.source, score: p.score, raw: p })) });
});

// ─── UI (HTML) ───
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>⚽ サッカーYT v2 SI Professional (Red)</title>
<style>
  body{font-family:sans-serif; background:#0f1117; color:#e0e0e0; margin:0; padding:20px;}
  .header{ border-bottom: 2px solid #ff4b4b; padding-bottom:15px; margin-bottom:20px; display:flex; justify-content:space-between; align-items:center; }
  h1{ color: #ff4b4b; margin:0; font-size:20px; }
  .panel{background:#161b2e; border-radius:12px; padding:20px; margin-bottom:20px; border:1px solid #2a3050;}
  .btn{padding:8px 16px; border-radius:8px; cursor:pointer; border:none; font-weight:bold; transition:0.2s;}
  .btn-primary{background:#ff4b4b; color:#fff;}
  .btn-success{background:#10b981; color:#fff;}
  .btn-ghost{background:#1e2540; color:#9bb5e0; border:1px solid #2a3050;}
  .label-box{display:flex; flex-wrap:wrap; gap:8px; margin-bottom:15px; padding:10px; background:#0d1220; border-radius:8px;}
  .label-item{background:#ff4b4b; color:#fff; padding:4px 10px; border-radius:20px; font-size:11px; display:flex; align-items:center; gap:6px;}
  pre{background:#0d1220; padding:10px; border-radius:8px; font-size:11px; overflow-x:auto; color:#9bb5e0; white-space:pre-wrap;}
</style>
</head>
<body>
  <div class="header">
    <h1>⚽ サッカーYT v2 SI Professional (Red)</h1>
    <div style="font-size:12px; color:#ff4b4b;">📡 連携: ${LOCAL_AGENT_IP ? `Local Agent (\${LOCAL_AGENT_IP})` : 'VPS直接'}</div>
  </div>

  <div class="panel">
    <input type="date" id="dateInput">
    <button class="btn btn-primary" onclick="loadContent()">案件読込</button>
  </div>

  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
    <div>
      <div class="panel">
        <div style="margin-bottom:10px; display:flex; gap:5px;">
          <select id="siType" style="background:#1e2540; color:#fff; border:1px solid #2a3050; border-radius:4px; padding:5px;">
            <option value="news">News</option>
            <option value="wikipedia">Wikipedia</option>
            <option value="sofascore_pmt">SofaScore (P/M/T)</option>
            <option value="sofascore_event">SofaScore (Match)</option>
          </select>
          <input type="text" id="siInput" style="flex:1; background:#1e2540; color:#fff; border:1px solid #2a3050; border-radius:4px; padding:5px;" placeholder="キーワード...">
          <button class="btn btn-primary" onclick="addLabel()">＋</button>
        </div>
        <div id="labels" class="label-box"></div>
        <button class="btn btn-success" style="width:100%;" onclick="fetchSi()">⬇️ SI情報取得実行</button>
      </div>
      <div id="postList"></div>
    </div>
    <div>
      <div class="panel">
        <h3>📺 取得データプレビュー</h3>
        <div id="preview" style="min-height:300px; max-height:600px; overflow-y:auto;">案件とキーワードを選んでね</div>
      </div>
    </div>
  </div>

  <script>
    let state = { posts: [], selectedPost: null, keywords: [] };

    async function loadContent() {
      const d = document.getElementById('dateInput').value;
      if(!d) return;
      const res = await fetch('/api/v2/content?date='+d);
      const data = await res.json();
      state.posts = data.posts;
      document.getElementById('postList').innerHTML = data.posts.map(p => 
        \`<div class="panel" onclick="selectPost('\${p.id}')" style="cursor:pointer; padding:10px; font-size:13px;">\${p.title}</div>\`
      ).join('');
    }

    function addLabel() {
      const type = document.getElementById('siType').value;
      const word = document.getElementById('siInput').value.trim();
      if(!word) return;
      if((type==='wikipedia' || type==='sofascore_pmt') && state.keywords.find(k => k.word === word)) return alert('重複しています');
      state.keywords.push({type, word});
      document.getElementById('siInput').value = '';
      renderLabels();
    }

    function renderLabels() {
      document.getElementById('labels').innerHTML = state.keywords.map((k, i) => 
        \`<div class="label-item">\${k.word} (\${k.type}) <span onclick="state.keywords.splice(\${i},1);renderLabels();" style="cursor:pointer">×</span></div>\`
      ).join('');
    }

    async function selectPost(id) {
      state.selectedPost = state.posts.find(p => p.id === id);
      document.querySelectorAll('.panel').forEach(p => p.style.borderColor = '#2a3050');
      event.currentTarget.style.borderColor = '#ff4b4b';
    }

    async function fetchSi() {
      if(!state.selectedPost) return alert('案件を選んでね');
      if(state.keywords.length === 0) return alert('キーワードを追加してね');
      
      const preview = document.getElementById('preview');
      preview.innerHTML = "⏳ 取得中... (ローカル連携)";
      
      const res = await fetch('/api/v2/fetch-si', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ keywords: state.keywords })
      });
      const data = await res.json();
      preview.innerHTML = \`<pre>\${JSON.stringify(data.data, null, 2)}</pre>\`;
    }

    window.onload = () => { document.getElementById('dateInput').value = new Date().toISOString().slice(0,10); };
  </script>
</body></html>`));

app.listen(PORT, () => console.log('v2 SI Professional Server running at http://localhost:' + PORT));
