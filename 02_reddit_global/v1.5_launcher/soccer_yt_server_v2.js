// soccer_yt_server_v2.js
// v2 サッカー YouTube ランチャー Pro統合版 (port 3004)
// 【改修内容】Step 1-3 完遂・完全リセット版 / 鉄の掟(赤) / Claude 4.6 構成提案 / タブUI

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

[DATA_DIR, SI_DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json({ limit: '100mb' }));

// ─── API ───

app.get('/api/v2/content', (req, res) => {
  const d = req.query.date; if (!d) return res.status(400).send('?date=');
  const file = path.join(DATA_DIR, `stories_${d.replace(/-/g, "_")}.json`);
  if (!fs.existsSync(file)) return res.json({ posts: [] });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json({ posts: (data.posts || []).map((p, i) => ({ 
    id: p.id || String(i), title: p.titleJa || p.title, 
    addedAt: p.added_at || p.addedAt, source: p.source, raw: p 
  })) });
});

app.post('/api/v2/saved-projects', (req, res) => { fs.writeFileSync(SAVED_FILE, JSON.stringify(req.body, null, 2)); res.json({ success: true }); });
app.get('/api/v2/saved-projects', (req, res) => { res.json(fs.existsSync(SAVED_FILE) ? JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')) : []); });

app.post('/api/v2/suggest-keywords', async (req, res) => {
  const { post } = req.body;
  try {
    const prompt = `Identify 5-8 main Player, Team, or Match from this soccer news for deep research.
Return ONLY JSON: {"suggestions": [{"type": "player"|"team"|"match"|"wikipedia"|"news", "word": "Entity Name"}]}
Title: ${post.title}`;
    const response = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 1000, messages: [{ role: 'user', content: prompt }] });
    const m = response.match(/\{[\s\S]*\}/);
    res.json(m ? JSON.parse(m[0]) : { suggestions: [] });
  } catch (e) { res.json({ suggestions: [] }); }
});

app.post('/api/v2/search-all', async (req, res) => {
  const { query } = req.body;
  try {
    const searchRes = await axios.get(`https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(query)}`);
    const results = (searchRes.data.results || []).filter(r => ['player', 'team', 'manager'].includes(r.type)).map(r => ({
      id: r.entity.id, type: r.type, title: r.entity.name, sub: r.entity.team?.name || r.entity.category?.name || ''
    }));
    res.json({ success: true, candidates: results.slice(0, 10) });
  } catch (e) { res.json({ success: false }); }
});

app.post('/api/v2/fetch-si', async (req, res) => {
  const { keywords, postId } = req.body;
  try {
    const results = {};
    for (const k of keywords) {
      let data = { ok: false };
      if (k.type === 'player') data = await fetchSofaScorePlayer(k.word);
      else if (k.type === 'team') data = await fetchSofaScoreTeam(k.word);
      else if (k.type === 'manager') data = await fetchSofaScoreManager(k.word);
      else if (k.type === 'match') data = await fetchSofaScoreMatch(null, null, k.id);
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
      fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
    }
    res.json({ success: true, data: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v2/si-history', (req, res) => {
  const postId = req.query.postId || "";
  const filePath = path.join(SI_DATA_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
  if (!fs.existsSync(filePath)) return res.json({ items: [] });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json({ items: Object.keys(data).map(k => ({ title: k, data: data[k] })) });
});

app.post('/api/v2/propose-modules', async (req, res) => {
  const { post, siData } = req.body;
  try {
    const prompt = `あなたはプロのサッカーYouTube脚本家です。5〜10枚のモジュール構成を提案してください。
【案件】${post.title}
【コメント】${post.comments?.map(c => c.bodyJa || c.body).join(' / ')}
【補足】${JSON.stringify(siData).slice(0, 2000)}

【指示】
1. キャッチーなオープニング、盛り上がり、データ深掘り、コメント紹介。
2. stats(スタッツ), insight(解説), reaction(反応), type1〜4を使用。
Return ONLY JSON: {"modules": [{"title": "題名", "type": "insight|stats|...", "reason": "理由"}]}`;
    const response = await callAI({ model: "claude-sonnet-4-6", max_tokens: 3000, messages: [{ role: 'user', content: prompt }] });
    const m = response.match(/\{[\s\S]*\}/);
    res.json(m ? JSON.parse(m[0]) : { modules: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── UI ───
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>⚽ サッカーYT v2 Pro RED</title>
<style>
:root { --main-red: #ff4d4d; --dark-bg: #0f1117; --panel-bg: #161b2e; --border: #2a3050; }
body{font-family:sans-serif;background:var(--dark-bg);color:#e0e0e0;margin:0;display:flex;height:100vh;overflow:hidden;}
.sidebar{width:300px;background:#0d1220;border-right:1px solid var(--border);display:flex;flex-direction:column;}
.sidebar-h{padding:15px;background:#1a2540;color:var(--main-red);font-weight:bold;border-bottom:1px solid var(--border);}
.saved-list{flex:1;overflow-y:auto;padding:10px;}
.lead-item{background:var(--panel-bg);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer;font-size:12px;}
.lead-item.active{border-color:var(--main-red);border-left:4px solid var(--main-red);}
.main{flex:1;display:flex;flex-direction:column;}
.header{background:#1a2040;padding:15px;border-bottom:3px solid var(--main-red);}
.header h1{font-size:20px;color:var(--main-red);margin:0;text-shadow:0 0 10px rgba(255,77,77,0.3);}
.steps{display:flex;background:#0d1220;border-bottom:1px solid var(--border);}
.step{padding:12px 20px;font-size:12px;font-weight:bold;color:#4a5a7a;cursor:pointer;}
.step.active{color:var(--main-red);background:var(--panel-bg);}
.content{flex:1;overflow-y:auto;padding:20px;}
.panel{background:var(--panel-bg);border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid var(--border);}
.btn{padding:8px 16px;border-radius:6px;cursor:pointer;border:none;font-weight:bold;font-size:12px;margin-right:5px;}
.btn-red{background:var(--main-red);color:#fff;}
.btn-green{background:#10b981;color:#fff;}
.time-group{margin-bottom:8px;border:1px solid var(--border);border-radius:6px;overflow:hidden;}
.time-h{background:#1a2840;padding:8px;cursor:pointer;color:#ff9999;font-size:12px;}
.post-row{padding:8px;border-bottom:1px solid #1a2540;display:flex;align-items:center;gap:10px;font-size:12px;cursor:pointer;}
.label-box{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;padding:8px;background:#0d1220;border-radius:8px;min-height:40px;}
.label-item{background:var(--main-red);color:#fff;padding:3px 8px;border-radius:15px;font-size:11px;display:flex;gap:5px;}
.tab-container{display:flex;gap:2px;margin-bottom:15px;overflow-x:auto;}
.tab{padding:8px 15px;background:#1a2540;border-radius:8px 8px 0 0;font-size:11px;cursor:pointer;color:#8a9aba;white-space:nowrap;}
.tab.active{background:var(--main-red);color:#fff;}
pre{background:#0d1220;padding:10px;border-radius:8px;font-size:11px;color:#9bb5e0;white-space:pre-wrap;}
</style></head>
<body>
<div class="sidebar"><div class="sidebar-h">📦 保存済み案件 (RED)</div><div id="savedList" class="saved-list"></div></div>
<div class="main">
  <div class="header"><h1>⚽ サッカーYT v2 Pro RED</h1></div>
  <div class="steps"><div class="step active" id="st1" onclick="goStep(1)">1.案件選択</div><div class="step" id="st2" onclick="goStep(2)">2.SI取得</div><div class="step" id="st3" onclick="goStep(3)">3.構成</div></div>
  <div class="content">
    <div id="step1"><div class="panel"><input type="date" id="dateInput" style="background:#1e2540;color:#fff;padding:6px;border:none;"><button class="btn btn-red" onclick="loadContent()">案件読込</button><button class="btn btn-green" onclick="saveSelected()">💾 保存</button></div><div id="postList"></div></div>
    <div id="step2" style="display:none;"><div class="panel"><h2 id="curTitle" style="color:var(--main-red);margin:0 0 15px 0;"></h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div><input type="text" id="siInput" style="width:70%;background:#0d1220;color:#fff;padding:8px;border:1px solid var(--border);" placeholder="選手・チームを検索..."><button class="btn btn-red" onclick="handleSearch()">🔍 検索</button><div id="candList" style="margin-top:5px;background:#1a2540;display:none;"></div><div id="labels" class="label-box"></div><button class="btn btn-green" style="width:100%" onclick="fetchSi()">⬇️ 情報取得実行</button></div>
      <div><div style="font-size:11px;color:var(--main-red);">🔍 プレビュー</div><pre id="preview" style="height:200px;">データを取得してね</pre><div id="siHistory" style="margin-top:10px;"></div></div>
    </div><button class="btn btn-red" style="width:100%;margin-top:15px;" onclick="goStep(3)">➡️ 構成提案へ</button></div></div>
    <div id="step3" style="display:none;"><div class="panel"><button class="btn btn-red" style="width:100%;margin-bottom:15px;font-size:14px;padding:12px;" onclick="proposeModules()">✨ Claude 4.6 に脚本構成を提案させる</button><div id="tabContainer" class="tab-container"></div><div id="moduleArea"></div><button class="btn btn-green" style="width:100%;margin-top:20px;padding:12px;">🎬 シナリオ生成・画像取得開始</button></div></div>
  </div>
</div>
<script>
let state = { date:'', posts:[], saved:[], selected:null, keywords:[], selectedIds: new Set(), modules: [], activeTab: 0, siData: {} };
async function loadContent() {
  const d = document.getElementById('dateInput').value; if(!d)return;
  const res = await fetch('/api/v2/content?date='+d); const data = await res.json(); state.posts = data.posts;
  const groups = {}; data.posts.forEach(p => { const t = (p.addedAt||'').split('T')[1]?.slice(0,5) || '不明'; if(!groups[t]) groups[t]=[]; groups[t].push(p); });
  document.getElementById('postList').innerHTML = Object.keys(groups).sort().reverse().map(t => \`<div class="time-group"><div class="time-h" onclick="const c=this.parentElement.querySelector('.time-c');c.style.display=c.style.display==='none'?'block':'none'">🕒 \${t} 取得分 (\${groups[t].length})</div><div class="time-c" style="display:none;">\${groups[t].map(p => \`<div class="post-row" onclick="toggleSel('\${p.id}', this)"><input type="checkbox" id="chk_\${p.id}" \${state.selectedIds.has(p.id)?'checked':''}> \${p.title}</div>\`).join('')}</div></div>\`).join('');
}
function toggleSel(id, el){ const chk = document.getElementById('chk_'+id); if(state.selectedIds.has(id)){state.selectedIds.delete(id);chk.checked=false;el.style.background='';}else{state.selectedIds.add(id);chk.checked=true;el.style.background='#1a2440';} }
async function saveSelected(){
  state.selectedIds.forEach(id => { const p=state.posts.find(x=>x.id===id); if(p && !state.saved.find(x=>x.id===id)) state.saved.push(p); });
  await fetch('/api/v2/saved-projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state.saved)}); renderSidebar(); alert('保存しました');
}
function renderSidebar(){ document.getElementById('savedList').innerHTML = state.saved.map(l => \`<div class="lead-item \${state.selected?.id===l.id?'active':''}" onclick="selectLead('\${l.id}')">\${l.title}</div>\`).join(''); }
async function selectLead(id){
  state.selected = state.saved.find(x=>x.id===id); document.getElementById('curTitle').innerText = state.selected.title;
  state.keywords = []; renderLabels(); renderSidebar(); goStep(2);
}
async function handleSearch(){
  const q = document.getElementById('siInput').value;
  const res = await fetch('/api/v2/search-all', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query:q})});
  const data = await res.json();
  const list = document.getElementById('candList'); list.style.display = 'block';
  list.innerHTML = data.candidates.map(c => \`<div style="padding:8px;cursor:pointer;border-bottom:1px solid #2a3560;" onclick='addLabel("\${c.type}", "\${c.title}", "\${c.id}")'><b>[\${c.type}]</b> \${c.title}</div>\`).join('');
}
function addLabel(type, word, id=null){ if(state.keywords.find(k=>k.word===word)) return; state.keywords.push({type, word, id}); renderLabels(); document.getElementById('candList').style.display='none'; }
function renderLabels(){ document.getElementById('labels').innerHTML = state.keywords.map((k,i)=>\`<div class="label-item">\${k.word}<span onclick="state.keywords.splice(\${i},1);renderLabels()" style="cursor:pointer">×</span></div>\`).join(''); }
async function fetchSi(){
  document.getElementById('preview').innerText = "⏳ 取得中...";
  const res = await fetch('/api/v2/fetch-si',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keywords:state.keywords,postId:state.selected.id})});
  state.siData = (await res.json()).data; document.getElementById('preview').innerText = "取得完了"; renderHistory();
}
function renderHistory(){ document.getElementById('siHistory').innerHTML = Object.keys(state.siData).map(k => \`<div style="font-size:11px;margin-top:5px;color:#8a9aba;">📥 \${k} (取得済)</div>\`).join(''); }
function goStep(n){ [1,2,3].forEach(i=>{ const el=document.getElementById('step'+i); if(el){el.style.display=(i===n?'block':'none'); document.getElementById('st'+i).className='step'+(i===n?' active':'');} }); }
async function proposeModules(){
  document.getElementById('moduleArea').innerHTML = "<h3 style='color:var(--main-red)'>⏳ Claude 4.6 が最強の脚本構成を練っています...</h3>";
  const res = await fetch('/api/v2/propose-modules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({post:state.selected.raw, siData:state.siData})});
  state.modules = (await res.json()).modules; state.activeTab = 0; renderModules();
}
function renderModules(){
  document.getElementById('tabContainer').innerHTML = state.modules.map((m,i) => \`<div class="tab \${state.activeTab===i?'active':''}" onclick="state.activeTab=\${i};renderModules()">Slide \${i+1}</div>\`).join('');
  const m = state.modules[state.activeTab];
  document.getElementById('moduleArea').innerHTML = \`<div style="background:var(--panel-bg);border:1px solid var(--main-red);padding:20px;border-radius:0 12px 12px 12px;">
    <div style="margin-bottom:15px;"><b>題名:</b> <input type="text" value="\${m.title}" style="width:70%;background:#0d1220;color:#fff;padding:10px;border:1px solid var(--border);border-radius:8px;"></div>
    <div style="margin-bottom:15px;"><b>スライド型:</b> <select style="background:#0d1220;color:#fff;padding:10px;border:1px solid var(--border);border-radius:8px;">
      \${['insight','stats','reaction','type1','type2','type3','type4'].map(t=>\`<option value="\${t}" \${m.type===t?'selected':''}>\${t}</option>\`).join('')}
    </select></div>
    <div style="font-size:13px;color:#8a9aba;line-height:1.6;"><b>AIの狙い:</b> \${m.reason}</div>
  </div>\`;
}
window.onload = () => { document.getElementById('dateInput').value=new Date().toISOString().slice(0,10); fetch('/api/v2/saved-projects').then(r=>r.json()).then(d=>{state.saved=d||[]; renderSidebar();}); };
</script></body></html>`));

app.listen(PORT, () => console.log('⚽ v2 Pro RED Gateway Server running at http://localhost:' + PORT));
