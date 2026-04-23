// soccer_yt_server_v2.js
// v2 サッカー YouTube ランチャー Pro統合版 (port 3004)
// 【改修内容】取得後のキーワードクリア ＋ 鉄壁プロキシ ＋ 青色モード ＋ 永続保存

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

// ─── ゲートウェイ設定 ───
const LOCAL_AGENT_IP = process.env.LOCAL_AGENT_IP || null;
const LOCAL_AGENT_URL = LOCAL_AGENT_IP ? `http://${LOCAL_AGENT_IP}:3004` : null;

async function delegateToLocal(endpoint, data) {
  if (!LOCAL_AGENT_URL || data._delegated) return null; 
  log(`[Gateway] Local Agent (${LOCAL_AGENT_IP}) へ委託: ${endpoint}`);
  try {
    const res = await axios.post(`${LOCAL_AGENT_URL}${endpoint}`, { ...data, _delegated: true }, { timeout: 120000 });
    return res.data;
  } catch (err) {
    log(`[Gateway] 委託エラー: ${err.message}`);
    return { success: false, error: `Local Agent連携失敗: ${err.message}`, isGatewayError: true }; 
  }
}

// ─── API エンドポイント ───

app.post('/api/v2/fetch-si', async (req, res) => {
  log(`[SI] リクエスト受信: ${req.body.keywords?.length}件`);
  const { keywords, postId, _delegated } = req.body;

  if (!_delegated && LOCAL_AGENT_URL) {
    const remoteResult = await delegateToLocal('/api/v2/fetch-si', req.body);
    if (remoteResult) {
      if (remoteResult.success || remoteResult.data) {
        if (postId) {
          const filePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
          let existing = {};
          if (fs.existsSync(filePath)) existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const merged = { ...existing, ...remoteResult.data };
          fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
        }
        return res.json({ success: true, data: remoteResult.data });
      } else if (remoteResult.isGatewayError) {
        return res.status(502).json(remoteResult);
      }
    }
  }

  try {
    const results = {};
    for (const k of keywords) {
      log(`[SI] 取得実行: ${k.type} - ${k.word}`);
      let data = { ok: false };
      if (k.type === 'otherURL') { results[k.word] = { ok: true, url: k.word }; continue; }
      
      let wordEn = k.word;
      if (/[\u3000-\u9fff\uff00-\uffef]/.test(k.word)) {
        try {
          const trans = await callAI(`Soccer term: "${k.word}". Return ONLY the official English name.`);
          wordEn = trans.trim().replace(/^["']|["']$/g, '');
        } catch(e) { log(`[SI] AI翻訳失敗、原文使用`); }
      }

      if (k.type === 'wikipedia') data = await fetchWikipediaSafe([wordEn, k.word]);
      else if (k.type === 'sofascore_pmt') {
        data = await fetchSofaScorePlayer(wordEn);
        if (!data.ok) data = await fetchSofaScoreTeam(wordEn);
        if (!data.ok) data = await fetchSofaScoreManager(wordEn);
      } else if (k.type === 'sofascore_event') {
        const teams = k.word.split(/vs|VS|-|－/);
        if (teams.length >= 2) data = await fetchSofaScoreMatch(teams[0].trim(), teams[1].trim());
        else {
          try {
            const parsed = await callAI(`Extract teams from "${k.word}". JSON: {"home":"...", "away":"..."}`, { json: true });
            const { home, away } = JSON.parse(parsed);
            data = await fetchSofaScoreMatch(home, away);
          } catch(e) { log(`[SI] SofaScore Match Parse Error`); }
        }
      } else if (k.type === 'news') {
        const news = await fetchSerper(wordEn, 'news', 'en');
        data = news.organic?.length ? { ok: true, items: news.organic } : { ok: false };
      }
      results[k.word] = data;
    }

    if (postId) {
      const filePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
      let existing = {};
      if (fs.existsSync(filePath)) existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const merged = { ...existing, ...results };
      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
    }
    res.json({ success: true, data: results });
  } catch (err) { log(`[SI] Fatal: ${err.message}`); res.status(500).json({ error: err.message }); }
});

app.get('/api/v2/si-history', (req, res) => {
  const { postId } = req.query;
  const filePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
  if (!fs.existsSync(filePath)) return res.json({ items: [] });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json({ items: Object.keys(data).map(key => ({ title: key, data: data[key] })) });
});

app.get('/api/v2/saved-projects', (req, res) => {
  res.json(fs.existsSync(SAVED_FILE) ? JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')) : []);
});

app.post('/api/v2/saved-projects', (req, res) => {
  fs.writeFileSync(SAVED_FILE, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

app.get('/api/v2/content', (req, res) => {
  const d = req.query.date; if (!d) return res.status(400).send('?date=YYYY-MM-DD');
  const file = path.join(DATA_DIR, `stories_${d.replace(/-/g, "_")}.json`);
  if (!fs.existsSync(file)) return res.json({ posts: [] });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json({ posts: (data.posts || []).map((p, i) => ({ id: p.id || String(i), title: p.titleJa || p.title, addedAt: p.addedAt, source: p.source, raw: p })) });
});

// ─── UI (HTML/JS) ───
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>⚽ サッカーYT v2 Pro Full Blue</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#0f1117;color:#e0e0e0;height:100vh;overflow:hidden;display:flex;}
.sidebar{width:320px;background:#0d1220;border-right:1px solid #1e2540;display:flex;flex-direction:column;flex-shrink:0;}
.sidebar-header{padding:18px;background:#1a2540;border-bottom:1px solid #2a3560;color:#1a6ef5;font-weight:900;font-size:14px;}
.saved-list{flex:1;overflow-y:auto;padding:12px;}
.lead-item{background:#161b2e;border:1px solid #2a3050;border-radius:10px;padding:12px;margin-bottom:10px;cursor:pointer;transition:0.2s;font-size:13px;}
.lead-item.active{border-color:#1a6ef5;background:#262c40;border-left:4px solid #1a6ef5;}
.main{flex:1;display:flex;flex-direction:column;}
.header{background:#1a2040;padding:12px 20px;border-bottom:2px solid #1a6ef5;display:flex;justify-content:space-between;align-items:center;}
h1{font-size:18px;color:#1a6ef5;font-weight:900;}
.steps{display:flex;background:#0d1220;border-bottom:1px solid #1e2540;}
.step{padding:12px 20px;font-size:11px;font-weight:bold;color:#3a4a6a;}
.step.active{color:#1a6ef5;background:#161b2e;}
.content{flex:1;overflow-y:auto;padding:20px;}
.panel{background:#161b2e;border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid #2a3050;}
.btn{padding:8px 16px;border-radius:8px;cursor:pointer;border:none;font-weight:bold;transition:0.2s;display:inline-flex;align-items:center;gap:6px;}
.btn-primary{background:#1a6ef5;color:#fff;}
.btn-success{background:#10b981;color:#fff;}
.time-group{margin-bottom:10px;border:1px solid #2a3050;border-radius:8px;overflow:hidden;}
.time-summary{background:#1a2840;padding:10px;cursor:pointer;color:#7dc8ff;font-size:12px;font-weight:bold;}
.post-row{padding:10px;border-bottom:1px solid #1a2540;display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;}
.label-box{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;padding:10px;background:#0d1220;border-radius:8px;min-height:50px;}
.label-item{background:#1a6ef5;color:#fff;padding:4px 10px;border-radius:20px;font-size:11px;display:flex;align-items:center;gap:6px;}
.label-badge{background:rgba(0,0,0,0.3);padding:1px 5px;border-radius:4px;font-size:9px;color:#7dc8ff;}
.si-list{margin-top:10px;background:#0d1220;border-radius:8px;border:1px solid #1e2540;}
.si-item{padding:8px 12px;border-bottom:1px solid #1e2540;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:8px;}
pre{background:#0d1220;padding:10px;border-radius:8px;font-size:11px;overflow-x:auto;color:#9bb5e0;white-space:pre-wrap;}
</style></head>
<body>
<div class="sidebar"><div class="sidebar-header">📦 保存済み案件 (Pro Blue)</div><div id="savedList" class="saved-list"></div></div>
<div class="main">
  <div class="header"><h1>⚽ サッカーYT v2 Pro Full Blue</h1><div style="font-size:12px; color:#1a6ef5;">📡 連携: ${LOCAL_AGENT_IP ? 'Local Agent (' + LOCAL_AGENT_IP + ')' : 'DIRECT'}</div></div>
  <div class="steps"><div class="step active" id="st1">1.案件選択</div><div class="step" id="st2">2.SIスライド</div><div class="step" id="st3">3.構成</div></div>
  <div class="content">
    <div id="step1"><div class="panel"><input type="date" id="dateInput" style="background:#1e2540;color:#fff;border:1px solid #2a3050;padding:6px;border-radius:4px;"><button class="btn btn-primary" onclick="loadContent()">案件読込</button> <button class="btn btn-success" onclick="saveSelected()">💾 案件を保存</button></div><div id="postList"></div></div>
    <div id="step2" style="display:none;"><div class="panel"><div id="curTitle" style="font-size:18px;font-weight:900;color:#1a6ef5;margin-bottom:15px;"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div><div style="display:flex;gap:5px;"><select id="siType" style="background:#1e2540;color:#fff;border:1px solid #2a3050;border-radius:4px;padding:5px;"><option value="news">News</option><option value="wikipedia">Wiki</option><option value="sofascore_pmt">Sofa(P/M/T)</option><option value="sofascore_event">Sofa(Match)</option></select><input type="text" id="siInput" style="flex:1;background:#1e2540;color:#fff;border:1px solid #2a3050;padding:5px;" placeholder="ワード..."><button class="btn btn-primary" onclick="addLabel()">＋</button></div><div id="labels" class="label-box"></div><button class="btn btn-success" style="width:100%" onclick="fetchSi()">⬇️ SI情報取得実行</button></div>
      <div style="display:flex;flex-direction:column;"><div style="font-size:11px;color:#1a6ef5;font-weight:bold;margin-bottom:5px;">🔍 データプレビュー</div><pre id="preview" style="height:200px;">データを取得してね</pre><div style="font-size:11px;color:#1a6ef5;font-weight:bold;margin-top:10px;">📂 取得済み履歴</div><div id="siHistory" class="si-list" style="height:150px;overflow-y:auto;"></div></div>
    </div><button class="btn btn-primary" style="width:100%;margin-top:20px;" onclick="goStep(3)">➡️ 次へ進む</button></div></div>
  </div>
</div>
<script>
let state = { date:'', posts:[], saved:[], selected:null, keywords:[], selectedIds: new Set(), curHist: [] };
const TYPE_NAME = { news: 'NEWS', wikipedia: 'WIKI', sofascore_pmt: 'SOFA', sofascore_event: 'MATCH' };
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function loadContent() {
  const d = document.getElementById('dateInput').value; if(!d)return;
  const res = await fetch('/api/v2/content?date='+d); const data = await res.json(); state.posts = data.posts;
  const groups = {}; data.posts.forEach(p => { const t = p.addedAt ? p.addedAt.slice(11,16) : '不明'; if(!groups[t]) groups[t]=[]; groups[t].push(p); });
  document.getElementById('postList').innerHTML = Object.keys(groups).sort().reverse().map(t => \`<div class="time-group"><div class="time-summary" onclick="this.parentElement.querySelector('.time-content').style.display=this.parentElement.querySelector('.time-content').style.display==='none'?'block':'none'">🕒 \${t} 取得分 (\${groups[t].length})</div><div class="time-content" style="display:none;">\${groups[t].map(p => \`<div class="post-row" onclick="toggleSel('\${p.id}', this)"><input type="checkbox" id="chk_\${p.id}" \${state.selectedIds.has(p.id)?'checked':''}> \${esc(p.title)}</div>\`).join('')}</div></div>\`).join('');
}
function toggleSel(id, el){ const chk = document.getElementById('chk_'+id); if(state.selectedIds.has(id)){state.selectedIds.delete(id);chk.checked=false;el.style.background='';}else{state.selectedIds.add(id);chk.checked=true;el.style.background='#1a2440';} }
async function saveSelected(){
  state.selectedIds.forEach(id => { const p=state.posts.find(x=>x.id===id); if(p && !state.saved.find(x=>x.id===id)) state.saved.push(p); });
  await fetch('/api/v2/saved-projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state.saved)});
  renderSidebar(); alert('保存完了');
}
function renderSidebar(){ document.getElementById('savedList').innerHTML = state.saved.map(l => \`<div class="lead-item \${state.selected?.id===l.id?'active':''}" onclick="selectLead('\${l.id}')">\${esc(l.title)}</div>\`).join(''); }
async function selectLead(id){
  state.selected = state.saved.find(x=>x.id===id); if(!state.selected)return;
  document.getElementById('curTitle').innerText = state.selected.title;
  state.keywords = []; renderLabels(); document.getElementById('preview').innerText = "取得してね";
  renderSidebar(); const res = await fetch(\`/api/v2/si-history?postId=\${encodeURIComponent(state.selected.id)}\`);
  const data = await res.json(); renderHistory(data.items); goStep(2);
}
function renderHistory(items){ state.curHist = items; document.getElementById('siHistory').innerHTML = items.length ? items.map((item, i) => \`<div class="si-item" onclick="document.getElementById('preview').innerText=JSON.stringify(state.curHist[\${i}].data,null,2)">📥 \${esc(item.title)}</div>\`).join('') : '<div style="padding:10px;font-size:10px;color:#5a6a8a;">なし</div>'; }
function goStep(n){ [1,2,3].forEach(i=>{ if(document.getElementById('step'+i)){document.getElementById('step'+i).style.display=(i===n?'block':'none'); document.getElementById('st'+i).className='step'+(i===n?' active':'');} }); }
function addLabel(){ const t=document.getElementById('siType').value, w=document.getElementById('siInput').value.trim(); if(w) state.keywords.push({type:t,word:w}); document.getElementById('siInput').value=''; renderLabels(); }
function renderLabels(){ document.getElementById('labels').innerHTML = state.keywords.map((k,i)=>\`<div class="label-item"><span class="label-badge">\${TYPE_NAME[k.type]}</span>\${esc(k.word)}<span onclick="state.keywords.splice(\${i},1);renderLabels()" style="cursor:pointer">×</span></div>\`).join(''); }
async function fetchSi(){
  if(!state.keywords.length) return alert('キーワードを追加してください');
  const pre = document.getElementById('preview'); pre.innerText = "取得中...";
  try {
    const res = await fetch('/api/v2/fetch-si',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keywords:state.keywords,postId:state.selected.id})});
    const data = await res.json();
    if (data.isGatewayError) pre.innerHTML = "❌ Local Agentを確認してください: " + data.error;
    else { 
      pre.innerText = JSON.stringify(data.data,null,2); 
      state.keywords = []; renderLabels(); // 成功したらキーワードをクリア！
      const h = await fetch(\`/api/v2/si-history?postId=\${encodeURIComponent(state.selected.id)}\`); 
      renderHistory((await h.json()).items); 
    }
  } catch(e) { pre.innerHTML = "❌ エラー: " + e.message; }
}
window.onload = async () => { document.getElementById('dateInput').value=new Date().toISOString().slice(0,10); try{const r=await fetch('/api/v2/saved-projects'); state.saved=await r.json()||[]; renderSidebar();}catch(e){} };
</script></body></html>`));

app.listen(PORT, () => console.log('v2 Full Pro Blue Gateway Server running at http://localhost:' + PORT));
