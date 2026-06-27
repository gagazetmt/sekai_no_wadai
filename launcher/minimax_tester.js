// launcher/minimax_tester.js
// MiniMax TTS 採用6ボイス音量確認ツール
//   起動: node launcher/minimax_tester.js → http://localhost:3457

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');

const PORT    = 3457;
const API_KEY  = process.env.MINIMAX_API_KEY;
const GROUP_ID = process.env.MINIMAX_GROUP_ID;

async function minimaxSynth(text, voice, model, speed, vol, pitch) {
  if (!API_KEY || !GROUP_ID) throw new Error('MINIMAX_API_KEY / MINIMAX_GROUP_ID が .env にありません');
  const res = await fetch(`https://api.minimax.io/v1/t2a_v2?GroupId=${GROUP_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: model || 'speech-01-hd',
      text,
      stream: false,
      language_boost: 'Japanese',
      voice_setting: { voice_id: voice, speed: Number(speed)||1.1, vol: Number(vol)||1.0, pitch: Number(pitch)||0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`MiniMax ${res.status}: ${(await res.text()).slice(0,200)}`);
  const data = await res.json();
  if (data.base_resp?.status_code !== 0) throw new Error(`MiniMax: ${data.base_resp?.status_msg}`);
  const hex = data.data?.audio || data.audio_file;
  if (!hex) throw new Error('音声データなし');
  return Buffer.from(hex, 'hex');
}

// ── HTML（採用6ボイスをハードコード） ────────────────

function buildHtml() {
  const voices = [
    { id: 'Japanese_GenerousIzakayaOwner',        label: 'メインナレーション',   role: 'main' },
    { id: 'Japanese_deep_voiced_storyteller_vv1', label: 'コメント男1 ／ 深み',  role: 'male' },
    { id: 'Japanese_DependableWoman',             label: 'コメント男2 ／ 頼れる', role: 'male' },
    { id: 'Japanese_refined_storyteller_vv1',     label: 'コメント男3 ／ 上品',  role: 'male' },
    { id: 'Japanese_LoyalKnight',                 label: 'コメント男4 ／ 騎士',  role: 'male' },
    { id: 'Japanese_energetic_anime_girl_vv1',    label: 'コメント女 ／ 元気',   role: 'female' },
  ];

  const cards = voices.map((v, i) => {
    const border = v.role === 'main' ? '#f59e0b' : v.role === 'female' ? '#60a5fa' : '#2a3344';
    return `
<div style="background:#151b27;border:1px solid ${border};border-radius:10px;padding:14px">
  <div style="font-weight:700;font-size:14px;margin-bottom:2px">${v.label}</div>
  <div style="font-size:11px;color:#6b7a8f;margin-bottom:10px">${v.id}</div>
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
    <span style="font-size:12px;color:#9aa7b8">vol</span>
    <input type="range" id="vol${i}" min="0.5" max="2.0" step="0.05" value="1.0"
      oninput="document.getElementById('vv${i}').textContent=parseFloat(this.value).toFixed(2)"
      style="width:100px">
    <span id="vv${i}" style="font-size:12px;color:#e6ebf2;min-width:30px">1.00</span>
  </div>
  <button onclick="go(${i},'${v.id}')"
    id="btn${i}"
    style="background:#f59e0b;color:#1a1206;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer">
    ▶ 合成
  </button>
  <div id="box${i}" style="margin-top:8px"></div>
</div>`;
  }).join('\n');

  const voicesJson = JSON.stringify(voices);

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MiniMax TTS テスター</title>
<style>
  body{margin:0;background:#0b0f17;color:#e6ebf2;font-family:'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;padding:20px;max-width:820px;margin:0 auto}
  h2{font-size:16px;margin:20px 0 10px;color:#f59e0b}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:560px){.grid{grid-template-columns:1fr}}
  textarea{width:100%;background:#1d2533;border:1px solid #2a3344;border-radius:8px;color:#e6ebf2;padding:10px;font-size:14px;resize:vertical}
  select{background:#1d2533;border:1px solid #2a3344;border-radius:8px;color:#e6ebf2;padding:8px;font-size:13px}
  audio{width:100%;height:36px;margin-top:4px}
  .err{color:#f87171;font-size:12px}
</style>
</head><body>
<h1 style="font-size:20px;margin-bottom:4px">MiniMax TTS テスター</h1>
<p style="font-size:12px;color:#6b7a8f;margin-bottom:16px">採用6ボイスの音量確認。volを調整して「合成」→ 耳で確認。</p>

<div style="background:#151b27;border:1px solid #2a3344;border-radius:10px;padding:14px;margin-bottom:16px">
  <textarea id="txt" rows="3">これは最高だよ！メッシがまたやらかした！終了間際の一発で逆転。ガチで震えたわ。</textarea>
  <div style="display:flex;gap:12px;align-items:center;margin-top:8px;flex-wrap:wrap">
    <label style="font-size:12px;color:#9aa7b8">モデル
      <select id="mdl">
        <option value="speech-01-hd">speech-01-hd（現メイン）</option>
        <option value="speech-2.6-hd">speech-2.6-hd（最新HD）</option>
        <option value="speech-2.6-turbo">speech-2.6-turbo</option>
      </select>
    </label>
    <label style="font-size:12px;color:#9aa7b8">速度
      <input type="range" id="spd" min="0.8" max="1.4" step="0.05" value="1.1"
        oninput="document.getElementById('spdv').textContent=this.value"
        style="width:80px">
      <span id="spdv">1.1</span>
    </label>
    <button onclick="goAll()"
      style="background:#10b981;color:#051a0e;border:none;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer">
      ▶▶ 全6ボイス一括合成
    </button>
  </div>
</div>

<h2>採用6ボイス</h2>
<div class="grid">
${cards}
</div>

<script>
var VOICES = ${voicesJson};

async function go(idx, voiceId) {
  var btn = document.getElementById('btn'+idx);
  var box = document.getElementById('box'+idx);
  var vol = parseFloat(document.getElementById('vol'+idx).value);
  var spd = parseFloat(document.getElementById('spd').value);
  var mdl = document.getElementById('mdl').value;
  var txt = document.getElementById('txt').value;
  btn.disabled = true; btn.textContent = '合成中…';
  box.innerHTML = '';
  try {
    var res = await fetch('/synth', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({voice:voiceId, model:mdl, text:txt, speed:spd, vol:vol, pitch:0})
    });
    if (!res.ok) { box.innerHTML = '<div class="err">' + (await res.text()) + '</div>'; return; }
    var blob = await res.blob();
    var url  = URL.createObjectURL(blob);
    box.innerHTML = '<audio controls autoplay src="' + url + '"></audio>';
  } catch(e) {
    box.innerHTML = '<div class="err">' + e.message + '</div>';
  } finally {
    btn.disabled = false; btn.textContent = '▶ 合成';
  }
}

async function goAll() {
  for (var i = 0; i < VOICES.length; i++) {
    await go(i, VOICES[i].id);
  }
}
</script>
</body></html>`;
}

// ── HTTP サーバー ─────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buildHtml());
    return;
  }
  if (req.method === 'POST' && req.url === '/synth') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text, voice, model, speed, vol, pitch } = JSON.parse(body || '{}');
        if (!text || !voice) { res.writeHead(400); res.end('text と voice が必要'); return; }
        console.log(`  [synth] ${voice}  vol=${vol}  model=${model}`);
        const mp3 = await minimaxSynth(text, voice, model, speed, vol, pitch);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length });
        res.end(mp3);
      } catch (e) {
        console.warn(`  [synth] error: ${e.message}`);
        res.writeHead(500); res.end(e.message);
      }
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  MiniMax TTS テスター: http://localhost:${PORT}\n`);
  if (!API_KEY || !GROUP_ID) console.warn('  MINIMAX_API_KEY / MINIMAX_GROUP_ID が未設定');
});
