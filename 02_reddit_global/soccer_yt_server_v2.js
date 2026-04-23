// soccer_yt_server_v2.js
// v2 サッカー YouTube ランチャー Pro統合版（port 3004）
// 【改修内容】指示書100%準拠 UI ＋ プロフェッショナルSI取得 ＋ ゲートウェイ統合 ＋ 青色モード

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

const DATA_DIR    = path.join(__dirname, 'data');
const SI_DATA_DIR = path.join(DATA_DIR, 'si_data');
const SAVED_FILE  = path.join(DATA_DIR, 'saved_projects.json');
const LOG_FILE    = path.join(__dirname, 'soccer_yt_v2.log');

[DATA_DIR, SI_DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json({ limit: '100mb' }));

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
  if (data._delegated) return null; 
  
  log(`[Gateway] Local Agent (${LOCAL_AGENT_IP}) へ委託開始: ${endpoint}`);
  try {
    const res = await axios.post(`${LOCAL_AGENT_URL}${endpoint}`, { ...data, _delegated: true }, { timeout: 150000 });
    return res.data;
  } catch (err) {
    log(`[Gateway] Local Agent 連携エラー: ${err.message}`);
    return { success: false, error: `Local Agent連携失敗: ${err.message}`, isGatewayError: true }; 
  }
}

// ─── データ整形 ───
function sanitizeData(data, depth = 0) {
  if (depth > 2) return data; 
  if (typeof data === 'string') return data.replace(/"/g, '”').replace(/'/g, '’').replace(/,/g, '，').replace(/\n/g, ' ');
  if (Array.isArray(data)) return data.slice(0, 50).map(item => sanitizeData(item, depth + 1));
  if (typeof data === 'object' && data !== null) {
    const res = {};
    for (const key in data) res[key] = sanitizeData(data[key], depth + 1);
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
  log(`[SI] リクエスト受信: ${req.body.keywords?.length}件`);
  const { keywords, postId } = req.body;

  // VPS環境かどうかを判定（簡易的にIPの有無やホスト名で判断可能だが、ここでは委託設定があれば必ず委託する）
  const remoteResult = await delegateToLocal('/api/v2/fetch-si', req.body);
  
  // 委託結果が「成功」または「接続エラー（Gatewayエラー）」なら、VPS側で直接取得は絶対にしない
  if (remoteResult) {
    if (remoteResult.success || remoteResult.data) {
      log(`[SI] ローカルエージェントからデータ取得成功`);
      if (postId) {
        const savePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
        fs.writeFileSync(savePath, JSON.stringify(remoteResult.data, null, 2));
      }
      return res.json(remoteResult);
    } else if (remoteResult.isGatewayError) {
      log(`[SI] ローカルエージェント連携に失敗したため、403回避のため直接取得を中止します`);
      return res.status(502).json(remoteResult);
    }
  }

  // ここからは、自分がLocal Agent（または委託設定なし）の場合のみ実行される
  log(`[SI] 本機で直接取得を実行します（403リスクを承知の上）`);
  try {
    const results = {};
    for (const k of keywords) {
      log(`[SI] 処理開始 (${k.type}): ${k.word}`);
      let data = { ok: false, error: '取得失敗' };
      if (k.type === 'otherURL') {
        results[k.word] = { ok: true, url: k.word, note: '外部URL参照' }; continue;
      }
      let wordEn = k.word;
      if (/[\u3000-\u9fff\uff00-\uffef]/.test(k.word)) {
        const trans = await callAI(`Official English name for: "${k.word}". Return ONLY the name.`);
        wordEn = trans.trim().replace(/^["']|["']$/g, '');
      }
      if (k.type === 'wikipedia') data = await fetchWikipediaSafe([wordEn, k.word]);
      else if (k.type === 'sofascore_pmt') {
        data = await fetchSofaScorePlayer(wordEn);
        if (!data.ok) data = await fetchSofaScoreTeam(wordEn);
        if (!data.ok) data = await fetchSofaScoreManager(wordEn);
      } else if (k.type === 'sofascore_event') {
        try {
          const parsed = await callAI(`Extract home/away teams from "${k.word}". JSON: { "home": "...", "away": "..." }`, { json: true });
          const { home, away } = JSON.parse(parsed);
          data = await fetchSofaScoreMatch(home, away);
        } catch (e) {
          const teams = k.word.split(/vs|VS|-|－/);
          if (teams.length >= 2) data = await fetchSofaScoreMatch(teams[0].trim(), teams[1].trim());
        }
      } else if (k.type === 'news') {
        const news = await fetchSerper(wordEn, 'news', 'en');
        data = { ok: !!news.organic?.length, items: news.organic || [], summary: news.answerBox?.snippet || null };
      }
      results[k.word] = (k.type.includes('sofascore')) ? data : sanitizeData(data);
    }
    if (postId) {
      const savePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
      fs.writeFileSync(savePath, JSON.stringify(results, null, 2));
    }
    res.json({ success: true, data: results });
  } catch (err) { log(`[SI] エラー: ${err.message}`); res.status(500).json({ error: err.message }); }
});

app.get('/api/v2/si-history', (req, res) => {
  const { postId } = req.query;
  const filePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
  if (!fs.existsSync(filePath)) return res.json({ success: true, items: [] });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json({ success: true, items: Object.keys(data).map(key => ({ title: key, data: data[key] })) });
});

app.get('/api/v2/saved-projects', (req, res) => {
  if (!fs.existsSync(SAVED_FILE)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')));
});

app.post('/api/v2/saved-projects', (req, res) => {
  fs.writeFileSync(SAVED_FILE, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

app.get('/api/v2/content', (req, res) => {
  const d = req.query.date; if (!d) return res.status(400).json({ error: '?date=YYYY-MM-DD' });
  const storyFile = path.join(DATA_DIR, `stories_${d.replace(/-/g, "_")}.json`);
  if (!fs.existsSync(storyFile)) return res.json({ date: d, posts: [] });
  const data = JSON.parse(fs.readFileSync(storyFile, 'utf8'));
  res.json({ date: d, posts: (data.posts || []).map((p, i) => ({ id: p.id || String(i), title: p.titleJa || p.title, addedAt: p.addedAt, source: p.source, raw: p })) });
});

// ─── UI (HTML) ───
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚽ サッカーYT v2 Pro Full Blue</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#0f1117;color:#e0e0e0;height:100vh;overflow:hidden}
.layout { display: flex; height: 100vh; width: 100vw; }
.sidebar { width: 320px; background: #0d1220; border-right: 1px solid #1e2540; display: flex; flex-direction: column; flex-shrink: 0; }
.sidebar-header { padding: 18px; background: #1a2540; border-bottom: 1px solid #2a3560; color: #1a6ef5; font-weight: 900; font-size: 14px; }
.saved-list { flex: 1; overflow-y: auto; padding: 12px; }
.lead-item { background: #161b2e; border: 1px solid #2a3050; border-radius: 10px; padding: 12px; margin-bottom: 10px; cursor: pointer; transition: 0.2s; border-left: 4px solid transparent; }
.lead-item:hover { border-color: #1a6ef5; transform: translateX(4px); }
.lead-item.active { border-color: #1a6ef5; background: #262c40; border-left-color: #1a6ef5; }
.content-main { flex: 1; display: flex; flex-direction: column; background: #0f1117; }
.header{ background: #1a2040; padding: 12px 20px; border-bottom: 2px solid #1a6ef5; display: flex; justify-content: space-between; align-items: center; }
h1{ font-size: 18px; color: #1a6ef5; font-weight: 900; }
.steps { display: flex; background: #0d1220; border-bottom: 1px solid #1e2540; }
.step { padding: 12px 20px; font-size: 11px; font-weight: bold; color: #3a4a6a; }
.step.active { color: #1a6ef5; background: #161b2e; }
.main-scroll { flex: 1; overflow-y: auto; padding: 20px; }
.panel{background:#161b2e; border-radius:12px; padding:20px; margin-bottom:20px; border:1px solid #2a3050;}
.btn{padding:8px 16px; border-radius:8px; cursor:pointer; border:none; font-weight:bold; transition:0.2s; display:inline-flex; align-items:center; gap:6px;}
.btn-primary{background:#1a6ef5; color:#fff;}
.btn-success{background:#10b981; color:#fff;}
.btn-ghost{background:#1e2540; color:#9bb5e0; border:1px solid #2a3050;}
.time-group { margin-bottom: 10px; border: 1px solid #2a3050; border-radius: 8px; overflow: hidden; }
.time-summary { background: #1a2840; padding: 10px; cursor: pointer; color: #7dc8ff; font-size: 12px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
.time-summary:after { content: '▼'; font-size: 10px; transition: 0.3s; }
.time-group.open .time-summary:after { transform: rotate(180deg); }
.time-content { display: none; background: #161b2e; }
.time-group.open .time-content { display: block; }
.post-row { padding: 10px; border-bottom: 1px solid #1a2540; display: flex; align-items: center; gap: 10px; font-size: 13px; cursor: pointer; }
.post-row:hover { background: #141a30; }
.label-box { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 15px; padding: 10px; background: #0d1220; border-radius: 8px; min-height: 50px; }
.label-item { background: #1a6ef5; color: #fff; padding: 4px 10px; border-radius: 20px; font-size: 11px; display: flex; align-items: center; gap: 6px; }
.label-badge { background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 4px; font-size: 9px; font-weight: bold; color: #7dc8ff; text-transform: uppercase; }
.si-list { margin-top: 5px; background: #0d1220; border-radius: 8px; overflow: hidden; border: 1px solid #1e2540; }
.si-item { padding: 8px 12px; border-bottom: 1px solid #1e2540; font-size: 12px; display: flex; align-items: center; gap: 10px; cursor: pointer; transition: 0.2s; }
.si-item:hover { background: #1a2440; }
.dl-icon { color: #10b981; font-size: 16px; }
pre{background:#0d1220; padding:10px; border-radius:8px; font-size:11px; overflow-x:auto; color:#9bb5e0; white-space:pre-wrap;}
</style>
</head>
<body>
<div class="layout"><div class="sidebar"><div class="sidebar-header">📦 保存済み案件 (Pro Blue)</div><div id="savedList" class="saved-list"></div></div>
<div class="content-main"><div class="header"><h1>⚽ サッカーYT v2 Pro Full Blue</h1><div style="font-size:12px; color:#1a6ef5;">📡 連携: ${LOCAL_AGENT_IP ? 'Local Agent (' + LOCAL_AGENT_IP + ')' : 'DIRECT'}</div></div>
<div class="steps"><div class="step active" id="st1">1.案件選択</div><div class="step" id="st2">2.SIスライド</div><div class="step" id="st3">3.モジュール</div><div class="step" id="st4">4.脚本</div><div class="step" id="st5">5.出力</div></div>
<div class="main-scroll">
<div id="step1"><div class="panel"><input type="date" id="dateInput" style="background:#1e2540; color:#fff; border:1px solid #2a3050; padding:6px; border-radius:4px;"><button class="btn btn-primary" onclick="loadContent()">案件読込</button><button class="btn btn-ghost" onclick="fetchNow()">⚡ 今すぐ抽出</button><button class="btn btn-success" onclick="saveSelectedPosts()" style="margin-left:10px;">💾 案件を保存</button></div><div id="postList"></div></div>
<div id="step2" style="display:none;"><div class="panel"><div id="currentTitle" style="font-size:18px; font-weight:900; color:#1a6ef5; margin-bottom:15px;"></div><div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;"><div><div style="display:flex; gap:5px; margin-bottom:10px;"><select id="siType" style="background:#1e2540; color:#fff; border:1px solid #2a3050; border-radius:4px; padding:5px;"><option value="news">News</option><option value="wikipedia">Wikipedia</option><option value="sofascore_pmt">SofaScore (P/M/T)</option><option value="sofascore_event">SofaScore (Match)</option><option value="otherURL">Other URL</option></select><input type="text" id="siInput" style="flex:1; background:#1e2540; color:#fff; border:1px solid #2a3050; padding:5px;" placeholder="キーワード..."><button class="btn btn-primary" onclick="addLabel()">＋</button></div><div id="labels" class="label-box"></div><button class="btn btn-success" style="width:100%;" onclick="fetchSi()">⬇️ SI情報取得実行</button></div><div style="display:flex; flex-direction:column; gap:10px;"><div style="font-size:11px; color:#1a6ef5; font-weight:bold;">🔍 取得データプレビュー</div><pre id="preview" style="height:200px;">キーワードを追加してね</pre><div style="font-size:11px; color:#1a6ef5; font-weight:bold; margin-top:5px;">📂 取得済み情報一覧</div><div id="siHistory" class="si-list" style="height:150px; overflow-y:auto;"></div></div></div><button class="btn btn-primary" style="width:100%; margin-top:20px;" onclick="goStep(3)">➡️ 次へ進む</button></div></div>
</div></div></div>
<script>
let state = { date:'', posts:[], saved:[], selected:null, keywords:[], selectedIds: new Set(), siItems: [] };
const TYPE_NAME = { news: 'NEWS', wikipedia: 'WIKI', sofascore_pmt: 'SOFA(P)', sofascore_event: 'SOFA(M)', otherURL: 'URL' };
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function loadContent() {
  const d = document.getElementById('dateInput').value; if(!d) return; state.date = d;
  const res = await fetch('/api/v2/content?date='+d); const data = await res.json();
  state.posts = data.posts; state.selectedIds.clear();
  const groups = {}; data.posts.forEach(p => { const t = p.addedAt ? p.addedAt.slice(11,16) : '不明'; if(!groups[t]) groups[t]=[]; groups[t].push(p); });
  document.getElementById('postList').innerHTML = Object.keys(groups).sort().reverse().map(t => {
    const postsHtml = groups[t].map(p => \`<div class="post-row" onclick="toggleSelect('\${p.id}', this)"><input type="checkbox" id="chk_\${p.id}" \${state.selectedIds.has(p.id)?'checked':''} onclick="event.stopPropagation()"><div style="flex:1;"><div style="font-weight:bold;">\${esc(p.title)}</div></div></div>\`).join('');
    return \`<div class="time-group open"><div class="time-summary" onclick="this.parentElement.classList.toggle('open')">🕒 \${t} 取得分 (\${groups[t].length}件)</div><div class="time-content">\${postsHtml}</div></div>\`;
  }).join('');
}
function toggleSelect(id, el) {
  if (state.selectedIds.has(id)) { state.selectedIds.delete(id); document.getElementById('chk_'+id).checked=false; el.style.background=''; }
  else { state.selectedIds.add(id); document.getElementById('chk_'+id).checked=true; el.style.background='#1a2440'; }
}
async function saveSelectedPosts() {
  state.selectedIds.forEach(id => { const p = state.posts.find(x => x.id === id); if(p && !state.saved.find(x => x.id === id)) state.saved.push(p); });
  await fetch('/api/v2/saved-projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(state.saved) });
  renderSidebar(); state.selectedIds.clear(); loadContent(); alert('案件を保存しました');
}
function renderSidebar() {
  document.getElementById('savedList').innerHTML = state.saved.map(l => \`
    <div class="lead-item \${state.selected?.id === l.id ? 'active' : ''}" onclick="selectLead('\${l.id}')"><div style="font-size:12px; font-weight:bold;">\${esc(l.title)}</div></div>\`).join('');
}
async function selectLead(id) {
  state.selected = state.saved.find(x => x.id === id); if(!state.selected) return;
  document.getElementById('currentTitle').innerText = state.selected.title;
  state.keywords = []; renderLabels(); document.getElementById('preview').innerText = "キーワードを追加してね";
  renderSidebar(); await loadSiHistory(); goStep(2);
}
async function loadSiHistory() {
  const res = await fetch(\`/api/v2/si-history?postId=\${encodeURIComponent(state.selected.id)}\`);
  const data = await res.json(); state.siItems = data.items || []; renderSiHistory();
}
function renderSiHistory() {
  document.getElementById('siHistory').innerHTML = state.siItems.length ? state.siItems.map((item, i) => \`<div class="si-item" onclick="previewSi(\${i})"><span class="dl-icon">📥</span><span>\${esc(item.title)}</span></div>\`).join('') : '<div style="padding:20px; font-size:11px; color:#5a6a8a; text-align:center;">なし</div>';
}
function previewSi(i) { document.getElementById('preview').innerText = JSON.stringify(state.siItems[i].data, null, 2); }
function goStep(n) { [1,2,3,4,5].forEach(i => { const el=document.getElementById('step'+i); if(el) el.style.display=(i===n?'block':'none'); const st=document.getElementById('st'+i); if(st) st.className='step'+(i===n?' active':''); }); }
function addLabel() {
  const type=document.getElementById('siType').value, word=document.getElementById('siInput').value.trim();
  if(!word || (['wikipedia','sofascore_pmt','sofascore_event'].includes(type) && state.keywords.find(k=>k.type===type && k.word===word))) return;
  state.keywords.push({type, word}); document.getElementById('siInput').value=''; renderLabels();
}
function renderLabels() {
  document.getElementById('labels').innerHTML = state.keywords.map((k,i) => \`
    <div class="label-item"><span class="label-badge">\${TYPE_NAME[k.type]}</span><span>\${esc(k.word)}</span><span onclick="state.keywords.splice(\${i},1);renderLabels();" style="cursor:pointer; margin-left:5px;">×</span></div>\`).join('');
}
async function fetchSi() {
  if(!state.keywords.length) return alert('キーワードを追加してください');
  const pre = document.getElementById('preview'); pre.innerHTML = "⏳ 取得中...";
  try {
    const res = await fetch('/api/v2/fetch-si', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ keywords: state.keywords, postId: state.selected.id }) });
    const data = await res.json(); 
    if (data.isGatewayError) { pre.innerHTML = "❌ 403回避のため直接取得を中止しました。Local Agentを確認してください: " + data.error; }
    else { pre.innerHTML = JSON.stringify(data.data, null, 2); await loadSiHistory(); }
  } catch(e) { pre.innerHTML = "❌ エラー: " + e.message; }
}
window.onload = async () => {
  document.getElementById('dateInput').value = new Date().toISOString().slice(0,10);
  try { const res = await fetch('/api/v2/saved-projects'); state.saved = await res.json() || []; renderSidebar(); } catch(e) {}
};
</script></body></html>`));

app.listen(PORT, () => console.log('v2 Full Pro Blue Server running at http://localhost:' + PORT));
