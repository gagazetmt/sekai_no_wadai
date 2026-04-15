// mia_launcher.js
// Mia Chat V2 ランチャー（port 3005）
// - CLIへ指示を送れるフルページチャット
// - 作業ログ・生成シナリオの閲覧
// - soccer_yt_server_v2（port 3004）のAPIを内部でプロキシ

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3005;
app.use(express.json());

const V2_BASE   = 'http://localhost:3004';
const DATA_DIR  = path.join(__dirname, 'data');
const LOG_FILE  = path.join(__dirname, 'logs', 'daily_fetch.log');
const HIST_FILE = path.join(__dirname, 'data', 'mia_chat_history.json');

// ── チャット履歴（サーバーサイド保持） ──────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch { return []; }
}
function saveHistory(hist) {
  fs.writeFileSync(HIST_FILE, JSON.stringify(hist.slice(-200), null, 2));
}

// ── API: CLIへメッセージ送信（proxy） ────────────────────────────────────────
app.post('/api/mia/send', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message が必要です' });
  try {
    const r   = await axios.post(`${V2_BASE}/api/v2/cli-message`, { message }, { timeout: 5000 });
    const id  = r.data.id;
    const hist = loadHistory();
    hist.push({ role: 'user', text: message, ts: Date.now(), id });
    saveHistory(hist);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: `CLIへの送信失敗: ${e.message}` });
  }
});

// ── API: ステータス取得（proxy）＋最新返信の履歴保存 ──────────────────────────
app.get('/api/mia/status', async (req, res) => {
  try {
    const r    = await axios.get(`${V2_BASE}/api/v2/cli-status`, { timeout: 5000 });
    const data = r.data;

    // 未保存の返信があれば履歴に追記
    if (data.reply) {
      const hist    = loadHistory();
      const already = hist.find(h => h.role === 'mia' && h.id === data.reply.id);
      if (!already) {
        hist.push({ role: 'mia', text: data.reply.text, ts: data.reply.timestamp, id: data.reply.id });
        saveHistory(hist);
      }
    }
    res.json(data);
  } catch (e) {
    res.json({ online: false, reply: null, lastSeen: null });
  }
});

// ── API: チャット履歴取得 ─────────────────────────────────────────────────────
app.get('/api/mia/history', (req, res) => {
  const hist = loadHistory();
  res.json({ history: hist.slice(-100) });
});

// ── API: チャット履歴クリア ───────────────────────────────────────────────────
app.post('/api/mia/clear-history', (req, res) => {
  saveHistory([]);
  res.json({ ok: true });
});

// ── API: 作業ログ取得 ─────────────────────────────────────────────────────────
app.get('/api/mia/logs', (req, res) => {
  try {
    const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    const lines   = content.split('\n').filter(Boolean).slice(-80);
    res.json({ lines });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: 最近の生成シナリオ一覧 ──────────────────────────────────────────────
app.get('/api/mia/scenarios', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('v2_scenario_') && f.endsWith('.json'))
      .sort().reverse().slice(0, 15);
    const items = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return {
          file:   f,
          title:  data.scenario?.youtubeTitle || f,
          date:   data.date  || '',
          postId: data.postId || '',
          mods:   (data.scenario?.modules || []).length,
        };
      } catch { return { file: f, title: f, date: '', postId: '', mods: 0 }; }
    });
    res.json({ scenarios: items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── メインUI ─────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mia Chat V2</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0b0f1e;color:#e0e8ff;height:100dvh;display:flex;flex-direction:column;overflow:hidden}

/* ── ヘッダー ── */
.header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:#111827;border-bottom:1px solid #1e2a42;flex-shrink:0}
.avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#1a6ef5,#5eb3ff);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.header-title{font-size:18px;font-weight:800;color:#7dc8ff;letter-spacing:.5px}
.header-sub{font-size:11px;color:#4a6080;margin-top:1px}
.status-dot{width:10px;height:10px;border-radius:50%;background:#2a3050;flex-shrink:0;transition:background .3s}
.status-dot.on{background:#5ed4a0;box-shadow:0 0 6px #5ed4a0}
.status-dot.off{background:#e06060}
#statusLabel{font-size:12px;color:#4a6080}
.header-link{margin-left:auto;font-size:12px;color:#5eb3ff;text-decoration:none;padding:4px 12px;border:1px solid #2a4060;border-radius:8px;white-space:nowrap}
.header-link:hover{background:#1a2a40}

/* ── メインレイアウト ── */
.main{display:flex;flex:1;overflow:hidden;gap:0}

/* ── チャットカラム ── */
.chat-col{display:flex;flex-direction:column;flex:1;min-width:0;border-right:1px solid #1e2a42}
.messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.messages::-webkit-scrollbar{width:4px}
.messages::-webkit-scrollbar-thumb{background:#2a3050;border-radius:4px}
.bubble{max-width:82%;padding:10px 14px;border-radius:16px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.bubble.user{background:#1a3a60;color:#c8dcf0;align-self:flex-end;border-bottom-right-radius:4px}
.bubble.mia{background:#1a2640;color:#ddeeff;align-self:flex-start;border-bottom-left-radius:4px;border-left:3px solid #1a6ef5}
.bubble.thinking{color:#4a6080;font-style:italic;align-self:flex-start;font-size:12px}
.bubble .ts{font-size:10px;color:#3a5070;margin-top:4px;text-align:right}
.input-area{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #1e2a42;background:#0d1120;flex-shrink:0}
#msgInput{flex:1;background:#111827;border:1px solid #2a3560;color:#e0e8ff;border-radius:12px;padding:10px 14px;font-size:14px;outline:none;font-family:inherit;resize:none;line-height:1.5;max-height:120px;overflow-y:auto}
#msgInput:focus{border-color:#1a6ef5}
#sendBtn{background:#1a6ef5;border:none;color:#fff;border-radius:12px;width:44px;flex-shrink:0;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center}
#sendBtn:hover{background:#2a7eff}
#sendBtn:disabled{background:#1a3060;cursor:not-allowed}
.clear-btn{background:none;border:1px solid #2a3050;color:#4a6080;border-radius:8px;padding:4px 10px;font-size:11px;cursor:pointer}
.clear-btn:hover{border-color:#e06060;color:#e06060}

/* ── 右パネル ── */
.right-col{width:340px;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden;background:#0d1120}
.right-tab-bar{display:flex;border-bottom:1px solid #1e2a42;flex-shrink:0}
.right-tab{flex:1;padding:10px 6px;font-size:12px;text-align:center;cursor:pointer;color:#4a6080;border-bottom:2px solid transparent;transition:.2s}
.right-tab.active{color:#7dc8ff;border-bottom-color:#1a6ef5}
.right-panel{flex:1;overflow-y:auto;padding:12px}
.right-panel::-webkit-scrollbar{width:3px}
.right-panel::-webkit-scrollbar-thumb{background:#2a3050}

/* ログ */
.log-line{font-size:11px;color:#607090;line-height:1.5;padding:1px 0;border-bottom:1px solid #111827;white-space:pre-wrap;word-break:break-all}
.log-line.info{color:#5ed4a0}
.log-line.err{color:#e06060}
.log-line.warn{color:#e0c060}

/* シナリオ */
.scenario-item{padding:10px;margin-bottom:8px;background:#111827;border:1px solid #1e2a42;border-radius:8px;cursor:pointer;transition:.15s}
.scenario-item:hover{border-color:#2a4060;background:#141d30}
.scenario-title{font-size:12px;font-weight:600;color:#9bb5e0;line-height:1.4;margin-bottom:4px}
.scenario-meta{font-size:10px;color:#3a5070}

/* レスポンシブ */
@media(max-width:680px){
  .right-col{display:none}
}
</style>
</head>
<body>

<div class="header">
  <div class="avatar">🤖</div>
  <div>
    <div class="header-title">Mia Chat V2</div>
    <div class="header-sub">CLI直結 — PCのClaudeと会話</div>
  </div>
  <span class="status-dot" id="statusDot"></span>
  <span id="statusLabel">確認中...</span>
  <a class="header-link" href="http://100.116.25.91:3004" target="_blank">🎬 V2ランチャー</a>
</div>

<div class="main">
  <!-- ── チャット ── -->
  <div class="chat-col">
    <div class="messages" id="messages">
      <div class="bubble mia">相棒！Mia Chat V2 へようこそ！<br>PCで動いてる Claude Code に直接指示を送れるよ。<br>ステータスが🟢になったら送信OK！</div>
    </div>
    <div class="input-area">
      <textarea id="msgInput" placeholder="CLIへの指示を入力... (Shift+Enterで改行)" rows="1"
        onkeydown="onKey(event)"
        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
      <button id="sendBtn" onclick="send()">➤</button>
    </div>
  </div>

  <!-- ── 右パネル ── -->
  <div class="right-col">
    <div class="right-tab-bar">
      <div class="right-tab active" id="tab-log" onclick="switchTab('log')">📋 作業ログ</div>
      <div class="right-tab" id="tab-scenario" onclick="switchTab('scenario')">🎬 生成済み</div>
    </div>
    <div class="right-panel" id="rightPanel"></div>
  </div>
</div>

<script>
const POLL_MS     = 5000;   // 返信ポーリング間隔
const LOG_MS      = 10000;  // ログ更新間隔
let waitingId     = null;
let currentTab    = 'log';
let thinkBubble   = null;

// ── 時刻フォーマット ──────────────────────────────────────────────────────────
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
}

// ── チャット履歴をサーバーから復元 ──────────────────────────────────────────
async function loadHistory() {
  try {
    const d = await fetch('/api/mia/history').then(r => r.json());
    const box = document.getElementById('messages');
    d.history.forEach(h => {
      if (h.role === 'user') appendBubble('user', h.text, h.ts);
      else                   appendBubble('mia',  h.text, h.ts);
    });
  } catch(_) {}
}

// ── バブル追加 ────────────────────────────────────────────────────────────────
function appendBubble(type, text, ts) {
  const box  = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'bubble ' + type;
  div.innerHTML = esc(text) + (ts ? \`<div class="ts">\${fmtTime(ts)}</div>\` : '');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function appendThinking() {
  const box = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'bubble thinking';
  div.id = 'thinkBubble';
  div.textContent = '⌛ CLIが作業中...';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── 送信 ─────────────────────────────────────────────────────────────────────
async function send() {
  const input = document.getElementById('msgInput');
  const msg   = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  appendBubble('user', msg, Date.now());

  try {
    const r = await fetch('/api/mia/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || '送信失敗');
    waitingId = d.id;
    appendThinking();
  } catch(e) {
    appendBubble('thinking', '❌ 送信失敗: ' + e.message, null);
    btn.disabled = false;
  }
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

// ── ステータス + 返信ポーリング ──────────────────────────────────────────────
async function pollStatus() {
  try {
    const d   = await fetch('/api/mia/status').then(r => r.json());
    const dot = document.getElementById('statusDot');
    const lbl = document.getElementById('statusLabel');

    dot.className = 'status-dot ' + (d.online ? 'on' : 'off');
    if (d.online) {
      const sec = d.lastSeen ?? 0;
      lbl.textContent = sec < 10 ? 'オンライン' : \`\${sec}秒前\`;
      lbl.style.color = '#5ed4a0';
    } else {
      lbl.textContent = d.lastSeen != null ? \`\${d.lastSeen}秒前\` : 'オフライン';
      lbl.style.color = '#e06060';
    }

    // 返信待ち中に返信が届いたら表示
    if (waitingId && d.reply && d.reply.id >= waitingId) {
      document.getElementById('thinkBubble')?.remove();
      appendBubble('mia', d.reply.text, d.reply.timestamp);
      waitingId = null;
      document.getElementById('sendBtn').disabled = false;
    }
  } catch(_) {}
}

// ── タブ切り替え ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.right-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'log')      loadLogs();
  else if (tab === 'scenario') loadScenarios();
}

// ── 作業ログ読み込み ──────────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const d    = await fetch('/api/mia/logs').then(r => r.json());
    const panel = document.getElementById('rightPanel');
    panel.innerHTML = d.lines.map(line => {
      let cls = 'log-line';
      if (/error|失敗|エラー/i.test(line))  cls += ' err';
      else if (/完了|成功|✅/i.test(line)) cls += ' info';
      else if (/warn|注意/i.test(line))     cls += ' warn';
      return \`<div class="\${cls}">\${esc(line)}</div>\`;
    }).join('') || '<div style="color:#3a5070;font-size:12px;padding:8px">ログなし</div>';
    panel.scrollTop = panel.scrollHeight;
  } catch(_) {}
}

// ── シナリオ一覧読み込み ──────────────────────────────────────────────────────
async function loadScenarios() {
  try {
    const d     = await fetch('/api/mia/scenarios').then(r => r.json());
    const panel = document.getElementById('rightPanel');
    panel.innerHTML = d.scenarios.map(s => \`
      <div class="scenario-item" onclick="window.open('http://100.116.25.91:3004','_blank')">
        <div class="scenario-title">\${esc(s.title)}</div>
        <div class="scenario-meta">\${esc(s.date)} | \${s.mods}モジュール | \${esc(s.file)}</div>
      </div>
    \`).join('') || '<div style="color:#3a5070;font-size:12px;padding:8px">シナリオなし</div>';
  } catch(_) {}
}

// ── 初期化 ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

(async () => {
  await loadHistory();
  await pollStatus();
  loadLogs();
  setInterval(pollStatus, POLL_MS);
  setInterval(() => { if (currentTab === 'log') loadLogs(); }, LOG_MS);
  document.getElementById('msgInput').focus();
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

app.listen(PORT, () => {
  console.log(`[mia-launcher] Mia Chat V2 起動: http://localhost:${PORT}`);
});
