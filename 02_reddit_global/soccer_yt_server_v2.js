// soccer_yt_server_v2.js
// v2 サッカー YouTube ランチャー Pro統合版 (port 3004)
// 【改修内容】DeepSeekキーワード自動提案 ＋ 統合検索 ＋ P/M/T属性別表示 ＋ 鉄の掟(赤)

require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');

const { callAI }             = require('./scripts/ai_client');
const { fetchWikipediaSafe } = require('./scripts/modules/fetchers/wikipedia');
const { fetchSofaScorePlayer } = require('./scripts/modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam } = require('./scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreManager } = require('./scripts/modules/fetchers/sofascore_manager');
const { fetchSofaScoreMatch } = require('./scripts/modules/fetchers/sofascore_match');
const { fetchSerper } = require('./scripts/modules/fetchers/serper_module');

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

const LOCAL_AGENT_IP = process.env.LOCAL_AGENT_IP || null;
const LOCAL_AGENT_URL = LOCAL_AGENT_IP ? `http://${LOCAL_AGENT_IP}:3004` : null;

async function delegateToLocal(endpoint, data) {
  if (!LOCAL_AGENT_URL || data._delegated) return null; 
  log(`[Gateway] Local Agent (${LOCAL_AGENT_IP}) 委託: ${endpoint}`);
  try {
    const res = await axios.post(`${LOCAL_AGENT_URL}${endpoint}`, { ...data, _delegated: true }, { timeout: 120000 });
    return res.data;
  } catch (err) {
    log(`[Gateway] 委託エラー: ${err.message}`);
    return { success: false, error: err.message, isGatewayError: true }; 
  }
}

// ─── API ───

// DeepSeekによるキーワード自動提案 (#NEW)
app.post('/api/v2/suggest-keywords', async (req, res) => {
  const { post } = req.body;
  log(`[AI] キーワード提案リクエスト: ${post.title}`);
  try {
    const prompt = `Analyze this soccer news and comments. Identify the main Player, Team, and Match mentioned.
Return ONLY JSON format like this: {"suggestions": [{"type": "player"|"team"|"match", "word": "Entity Name"}]}
Title: ${post.title}
Comments: ${post.comments?.map(c => c.body).join('\n').slice(0, 2000)}`;

    const response = await callAI(prompt, { json: true });
    res.json(JSON.parse(response));
  } catch (e) { log(`[AI] 提案エラー: ${e.message}`); res.json({ suggestions: [] }); }
});

// 統合検索API (SofaScore候補出し)
app.post('/api/v2/search-all', async (req, res) => {
  const { query } = req.body;
  const remoteResult = await delegateToLocal('/api/v2/search-all', req.body);
  if (remoteResult) return res.json(remoteResult);

  try {
    const searchRes = await axios.get(`https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(query)}`);
    const results = searchRes.data.results || [];
    let candidates = [];
    
    for (const r of results) {
      if (['player', 'team', 'manager'].includes(r.type)) {
        candidates.push({ id: r.entity.id, type: r.type, title: r.entity.name, sub: r.entity.team?.name || r.entity.category?.name || '' });
      }
    }
    // チームがヒットしたら試合も探す
    const team = results.find(r => r.type === 'team');
    if (team) {
      try {
        const eventsRes = await axios.get(`https://api.sofascore.com/api/v1/team/${team.entity.id}/events/last/0`);
        (eventsRes.data.events || []).slice(0, 3).forEach(ev => {
          candidates.push({ id: ev.id, type: 'match', title: `${ev.homeTeam.name} vs ${ev.awayTeam.name}`, sub: `Match: ${new Date(ev.startTimestamp * 1000).toLocaleDateString()}` });
        });
      } catch(e) {}
    }
    res.json({ success: true, candidates: candidates.slice(0, 10) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/v2/fetch-si', async (req, res) => {
  const { keywords, postId, _delegated } = req.body;
  if (!_delegated && LOCAL_AGENT_URL) {
    const remoteResult = await delegateToLocal('/api/v2/fetch-si', req.body);
    if (remoteResult?.success) {
      if (postId) {
        const filePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
        let existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
        fs.writeFileSync(filePath, JSON.stringify({ ...existing, ...remoteResult.data }, null, 2));
      }
      return res.json(remoteResult);
    } else if (remoteResult?.isGatewayError) return res.status(502).json(remoteResult);
  }

  try {
    const results = {};
    for (const k of keywords) {
      let data = { ok: false };
      if (k.type === 'player') data = await fetchSofaScorePlayer(null, k.id || k.word);
      else if (k.type === 'team') data = await fetchSofaScoreTeam(null, k.id || k.word);
      else if (k.type === 'manager') data = await fetchSofaScoreManager(null, k.id || k.word);
      else if (k.type === 'match') data = await fetchSofaScoreMatch(null, null, k.id || k.word);
      else if (k.type === 'wikipedia') data = await fetchWikipediaSafe([k.word, k.word]);
      else if (k.type === 'news') {
        const news = await fetchSerper(k.word, 'news', 'en');
        data = news.organic?.length ? { ok: true, items: news.organic } : { ok: false };
      }
      data.siType = k.type;
      results[k.word] = data;
    }
    if (postId) {
      const filePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
      let existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
      fs.writeFileSync(filePath, JSON.stringify({ ...existing, ...results }, null, 2));
    }
    res.json({ success: true, data: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v2/si-history', (req, res) => {
  const filePath = path.join(SI_DATA_DIR, `${req.query.postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
  if (!fs.existsSync(filePath)) return res.json({ items: [] });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json({ items: Object.keys(data).map(k => ({ title: k, data: data[k] })) });
});

app.get('/api/v2/saved-projects', (req, res) => { res.json(fs.existsSync(SAVED_FILE) ? JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')) : []); });
app.post('/api/v2/saved-projects', (req, res) => { fs.writeFileSync(SAVED_FILE, JSON.stringify(req.body, null, 2)); res.json({ success: true }); });
app.get('/api/v2/content', (req, res) => {
  const d = req.query.date; if (!d) return res.status(400).send('?date=');
  const file = path.join(DATA_DIR, `stories_${d.replace(/-/g, "_")}.json`);
  if (!fs.existsSync(file)) return res.json({ posts: [] });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json({ posts: (data.posts || []).map((p, i) => ({ 
    id: p.id || String(i), title: p.titleJa || p.title, 
    addedAt: p.added_at || p.addedAt || (p.created_utc ? new Date(p.created_utc*1000).toISOString() : "2026-04-23T00:00:00Z"), 
    source: p.source, raw: p 
  })) });
});

// ─── UI (HTML/CSS/JS) ───
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>⚽ サッカーYT v2 Pro Full Red</title>
<style>
:root { --main-red: #ff3b3b; --dark-bg: #0f0f12; --panel-bg: #1e1e26; --border-line: #3d3d4d; }
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:var(--dark-bg);color:#e0e0e0;height:100vh;overflow:hidden;display:flex;}
.sidebar{width:320px;background:#0d0d12;border-right:1px solid var(--border-line);display:flex;flex-direction:column;flex-shrink:0;}
.sidebar-header-red{padding:18px;background:#2a1010;color:var(--main-red);font-weight:900;font-size:14px;border-bottom:1px solid #4a1a1a;}
.saved-list{flex:1;overflow-y:auto;padding:12px;}
.lead-item{background:var(--panel-bg);border:1px solid var(--border-line);border-radius:10px;padding:12px;margin-bottom:10px;cursor:pointer;font-size:13px;transition:0.2s;}
.lead-item.active{border-color:var(--main-red);background:#331a1a;border-left:4px solid var(--main-red);}
.main-area{flex:1;display:flex;flex-direction:column;}
.header-red-force{background:#2a1010;padding:15px 25px;border-bottom:3px solid var(--main-red) !important;display:flex;justify-content:space-between;align-items:center;}
.header-red-force h1{font-size:22px;color:var(--main-red) !important;font-weight:900;margin:0;text-shadow:0 0-12px rgba(255,59,59,0.5);}
.steps{display:flex;background:#0d0d12;border-bottom:1px solid var(--border-line);}
.step{padding:12px 20px;font-size:11px;font-weight:bold;color:#5a5a6a;}
.step.active{color:var(--main-red);background:var(--panel-bg);}
.content-scroll{flex:1;overflow-y:auto;padding:20px;}
.panel{background:var(--panel-bg);border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid var(--border-line);}
.btn{padding:8px 16px;border-radius:8px;cursor:pointer;border:none;font-weight:bold;font-size:12px;display:inline-flex;align-items:center;gap:6px;}
.btn-primary{background:var(--main-red);color:#fff;}
.btn-success{background:#10b981;color:#fff;}
.time-group{margin-bottom:10px;border:1px solid var(--border-line);border-radius:8px;overflow:hidden;}
.time-summary{background:#2a1a1a;padding:10px;cursor:pointer;color:#ff9b9b;font-size:12px;font-weight:bold;}
.post-row{padding:10px;border-bottom:1px solid #2a2020;display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;}
.label-box{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;padding:10px;background:#0d0d12;border-radius:8px;min-height:50px;}
.label-item{background:var(--main-red);color:#fff;padding:4px 10px;border-radius:20px;font-size:11px;display:flex;align-items:center;gap:6px;}
.label-badge{background:rgba(0,0,0,0.3);padding:1px 5px;border-radius:4px;font-size:9px;color:#ff9b9b;}
.si-list{margin-top:10px;background:#0d0d12;border-radius:8px;border:1px solid var(--border-line);}
.si-item{padding:10px 15px;border-bottom:1px solid #1e1e26;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:8px;}
.cand-list{background:#331a1a;border-radius:8px;padding:8px;margin-top:8px;max-height:200px;overflow-y:auto;display:none;border:1px solid var(--main-red);}
.cand-item{padding:8px;font-size:12px;cursor:pointer;border-bottom:1px solid #4a2a2a;transition:0.2s;}
pre{background:#0d0d12;padding:15px;border-radius:8px;font-size:12px;overflow-x:auto;color:#ff9b9b;white-space:pre-wrap;border:1px solid #2a1010;}
</style></head>
<body>
<div class="sidebar"><div class="sidebar-header-red">📦 保存済み案件 (Pro Red)</div><div id="savedList" class="saved-list"></div></div>
<div class="main-area">
  <div class="header-red-force"><h1>⚽ サッカーYT v2 Pro Full Red</h1><div style="font-size:12px; color:var(--main-red);">📡 連携: \${LOCAL_AGENT_IP || 'DIRECT'}</div></div>
  <div class="steps"><div class="step active" id="st1">1.案件選択</div><div class="step" id="st2">2.SIスライド</div><div class="step" id="st3">3.構成</div></div>
  <div class="content-scroll">
    <div id="step1"><div class="panel"><input type="date" id="dateInput" style="background:#0d0d12;color:#fff;border:1px solid var(--border-line);padding:6px;border-radius:4px;"><button class="btn btn-primary" onclick="loadContent()">案件読込</button> <button class="btn btn-success" onclick="saveSelected()">💾 案件を保存</button></div><div id="postList"></div></div>
    <div id="step2" style="display:none;"><div class="panel"><div id="curTitle" style="font-size:18px;font-weight:900;color:var(--main-red);margin-bottom:15px;"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div><div style="display:flex;gap:5px;"><input type="text" id="siInput" style="flex:1;background:#0d0d12;color:#fff;border:1px solid var(--border-line);padding:10px;border-radius:8px;" placeholder="選手・チーム・試合を検索..."><button class="btn btn-primary" id="searchBtn" onclick="handleSearch()">🔍 検索</button></div>
      <div id="candList" class="cand-list"></div>
      <div style="margin-top:15px; font-size:11px; color:#5a5a6a;">Wiki/Newsは直接追加:</div>
      <div style="display:flex; gap:5px; margin-top:5px;"><select id="directType" style="background:#0d0d12; color:#fff; border:1px solid var(--border); border-radius:4px;"><option value="wikipedia">Wiki</option><option value="news">News</option></select><button class="btn btn-ghost" style="border:1px solid var(--border); color:#888;" onclick="addDirect()">＋追加</button></div>
      <div id="labels" class="label-box"></div><button class="btn btn-success" style="width:100%" onclick="fetchSi()">⬇️ SI情報取得実行</button></div>
      <div style="display:flex;flex-direction:column;"><div style="font-size:11px;color:var(--main-red);font-weight:bold;margin-bottom:8px;">🔍 データプレビュー</div><pre id="preview" style="height:250px;">データを取得してね</pre><div style="font-size:11px;color:var(--main-red);font-weight:bold;margin-top:10px;margin-bottom:5px;">📂 取得済み履歴</div><div id="siHistory" class="si-list" style="height:150px;overflow-y:auto;"></div></div>
    </div><button class="btn btn-primary" style="width:100%;margin-top:20px;" onclick="goStep(3)">➡️ 次へ進む</button></div></div>
  </div>
</div>
<script>
let state = { date:'', posts:[], saved:[], selected:null, keywords:[], selectedIds: new Set(), curHist: [] };
const TYPE_NAME = { news: 'NEWS', wikipedia: 'WIKI', player:'PLAYER', team:'TEAM', manager:'MGR', match: 'MATCH' };
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function loadContent() {
  const d = document.getElementById('dateInput').value; if(!d)return;
  const res = await fetch('/api/v2/content?date='+d); const data = await res.json(); state.posts = data.posts;
  const groups = {}; data.posts.forEach(p => { 
    const timeFull = p.addedAt || '不明'; let t = '不明';
    if(timeFull.includes('T')) t = timeFull.split('T')[1].slice(0,5);
    else if(timeFull.includes(':')) t = timeFull.slice(0,5);
    if(!groups[t]) groups[t]=[]; groups[t].push(p); 
  });
  document.getElementById('postList').innerHTML = Object.keys(groups).sort().reverse().map(t => \`<div class="time-group"><div class="time-summary" onclick="const c=this.parentElement.querySelector('.time-content');c.style.display=c.style.display==='none'?'block':'none'">🕒 \${t} 取得分 (\${groups[t].length})</div><div class="time-content" style="display:none;">\${groups[t].map(p => \`<div class="post-row" onclick="toggleSel('\${p.id}', this)"><input type="checkbox" id="chk_\${p.id}" \${state.selectedIds.has(p.id)?'checked':''}> \${esc(p.title)}</div>\`).join('')}</div></div>\`).join('');
}
function toggleSel(id, el){ const chk = document.getElementById('chk_'+id); if(state.selectedIds.has(id)){state.selectedIds.delete(id);chk.checked=false;el.style.background='';}else{state.selectedIds.add(id);chk.checked=true;el.style.background='#331a1a';} }
async function saveSelected(){
  state.selectedIds.forEach(id => { const p=state.posts.find(x=>x.id===id); if(p && !state.saved.find(x=>x.id===id)) state.saved.push(p); });
  await fetch('/api/v2/saved-projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state.saved)});
  renderSidebar(); alert('保存完了');
}
function renderSidebar(){ document.getElementById('savedList').innerHTML = state.saved.map(l => \`<div class="lead-item \${state.selected?.id===l.id?'active':''}" onclick="selectLead('\${l.id}')">\${esc(l.title)}</div>\`).join(''); }

async function selectLead(id){
  state.selected = state.saved.find(x=>x.id===id); if(!state.selected)return;
  document.getElementById('curTitle').innerText = state.selected.title;
  state.keywords = []; renderLabels(); document.getElementById('preview').innerText = "AIキーワード抽出中...";
  renderSidebar();
  // AIキーワード提案の実行
  const aiRes = await fetch('/api/v2/suggest-keywords', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post: state.selected.raw})});
  const aiData = await aiRes.json();
  if(aiData.suggestions) aiData.suggestions.forEach(s => addLabel(s.type, s.word));
  document.getElementById('preview').innerText = "AIによるキーワードをセットしました。取得を実行してください。";
  const hRes = await fetch(\`/api/v2/si-history?postId=\${encodeURIComponent(state.selected.id)}\`);
  renderHistory((await hRes.json()).items); goStep(2);
}

function renderHistory(items){ state.curHist = items; document.getElementById('siHistory').innerHTML = items.length ? items.map((item, i) => \`<div class="si-item" onclick="previewSi(\${i})">📥 \${esc(item.title)}</div>\`).join('') : '<div style="padding:10px;font-size:10px;color:#5a5a6a;">なし</div>'; }
function previewSi(i){
  const d = state.curHist[i].data; let txt = "";
  if(d.siType==='player') txt = \`【選手】\${d.name}\\n年齢: \${d.age} / 身長: \${d.height} / 体重: \${d.weight}\\n所属: \${d.teamName} / ポジション: \${d.position}\`;
  else if(d.siType==='team') txt = \`【チーム】\${d.name}\\n本拠地: \${d.venueName} / リーグ: \${d.leagueName} / 設立: \${d.foundedYear}\`;
  else if(d.siType==='manager') txt = \`【監督】\${d.name}\\n国籍: \${d.nationality} / 年齢: \${d.age} / フォーメーション: \${d.preferredFormation}\`;
  else if(d.siType==='match') txt = \`【試合】\${d.homeTeam} vs \${d.awayTeam}\\nスコア: \${d.homeScore}-\${d.awayScore} / 日時: \${d.date}\\nスタジアム: \${d.venue}\`;
  else if(d.items) txt = d.items.map(it => \`・\${it.title}\\n  \${it.snippet}\`).join('\\n\\n');
  else txt = JSON.stringify(d, null, 2);
  document.getElementById('preview').innerText = txt;
}
function goStep(n){ [1,2,3].forEach(i=>{ const el=document.getElementById('step'+i); if(el){el.style.display=(i===n?'block':'none'); document.getElementById('st'+i).className='step'+(i===n?' active':'');} }); }

async function handleSearch(){
  const query = document.getElementById('siInput').value.trim(); if(!query) return;
  document.getElementById('searchBtn').innerText = '...';
  const res = await fetch('/api/v2/search-all', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query})});
  const data = await res.json();
  if(data.candidates?.length){
    const list = document.getElementById('candList'); list.style.display = 'block';
    list.innerHTML = data.candidates.map(c => \`<div class="cand-item" onclick='addLabel("\${c.type}", "\${esc(c.title)}", "\${c.id}")'><b>[\${c.type.toUpperCase()}]</b> \${esc(c.title)} <small>\${esc(c.sub)}</small></div>\`).join('');
  } else alert('見つかりませんでした');
  document.getElementById('searchBtn').innerText = '🔍 検索';
}
function addDirect(){ const t=document.getElementById('directType').value, w=document.getElementById('siInput').value.trim(); if(w) addLabel(t, w); }
function addLabel(type, word, id=null){
  if(state.keywords.find(k=>k.word===word)) return;
  state.keywords.push({type, word, id}); document.getElementById('siInput').value = '';
  document.getElementById('candList').style.display = 'none'; renderLabels();
}
function renderLabels(){ document.getElementById('labels').innerHTML = state.keywords.map((k,i)=>\`<div class="label-item"><span class="label-badge">\${TYPE_NAME[k.type] || k.type.toUpperCase()}</span>\${esc(k.word)}<span onclick="state.keywords.splice(\${i},1);renderLabels()" style="cursor:pointer">×</span></div>\`).join(''); }

async function fetchSi(){
  if(!state.keywords.length) return alert('キーワードを追加してください');
  const pre = document.getElementById('preview'); pre.innerHTML = "⏳ 取得中...";
  const res = await fetch('/api/v2/fetch-si',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keywords:state.keywords,postId:state.selected.id})});
  const data = await res.json();
  if (data.isGatewayError) pre.innerHTML = "❌ Local Agentエラー";
  else { pre.innerText = "取得完了！"; state.keywords = []; renderLabels(); const h = await fetch(\`/api/v2/si-history?postId=\${encodeURIComponent(state.selected.id)}\`); renderHistory((await h.json()).items); }
}
window.onload = async () => { document.getElementById('dateInput').value=new Date().toISOString().slice(0,10); try{const r=await fetch('/api/v2/saved-projects'); state.saved=await r.json()||[]; renderSidebar();}catch(e){} };
</script></body></html>`));

app.listen(PORT, () => console.log('v2 Full Pro Red Server running at http://localhost:' + PORT));
