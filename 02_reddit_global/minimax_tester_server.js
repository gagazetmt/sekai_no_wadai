const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
require('dotenv').config();

const app      = express();
const PORT     = 4003;
const TEMP_DIR = path.join(__dirname, 'temp');
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.json());
app.use('/temp', express.static(TEMP_DIR));

// ── Sanitizer（DeepSeek投入前に略語・固有名詞を先に補正）────────────
function sanitize(text) {
  return (text || '')
    // 大会名
    .replace(/W杯/g,              'ワールドカップ')
    .replace(/\bCL\b/g,           'チャンピオンズリーグ')
    .replace(/\bEL\b/g,           'ヨーロッパリーグ')
    .replace(/\bECL\b/g,          'カンファレンスリーグ')
    .replace(/\bPL\b/g,           'プレミアリーグ')
    .replace(/\bBL\b/g,           'ブンデスリーガ')
    .replace(/\bSA\b/g,           'セリエエー')
    .replace(/ラ・リーガ|LaLiga/g, 'ラリーガ')
    .replace(/\bEURO\b/g,         'ユーロ')
    .replace(/\bAFCON\b/g,        'アフリカネイションズカップ')
    .replace(/\bACL\b/g,          'アジアチャンピオンズリーグ')
    // 団体名
    .replace(/\bFIFA\b/g,         'フィファ')
    .replace(/\bUEFA\b/g,         'ウエファ')
    .replace(/\bJFA\b/g,          'ジェイエフエー')
    // 審判・ルール
    .replace(/\bVAR\b/g,          'ビデオ判定')
    .replace(/\bDOGSO\b/g,        'ドッグソー')
    .replace(/\bFK\b/g,           'フリーキック')
    .replace(/\bCK\b/g,           'コーナーキック')
    .replace(/\bPK\b/g,           'ペナルティキック')
    // ポジション
    .replace(/\bFW\b/g,           'フォワード')
    .replace(/\bCF\b/g,           'センターフォワード')
    .replace(/\bWG\b/g,           'ウインガー')
    .replace(/\bMF\b/g,           'ミッドフィールダー')
    .replace(/\bDMF?\b/g,         'ボランチ')
    .replace(/\bOMF\b/g,          'トップ下')
    .replace(/\b[LR]MF\b/g,       'サイドハーフ')
    .replace(/\bWB\b/g,           'ウイングバック')
    .replace(/\bSB\b/g,           'サイドバック')
    .replace(/\bLB\b/g,           'レフトバック')
    .replace(/\bRB\b/g,           'ライトバック')
    .replace(/\bCB\b/g,           'センターバック')
    .replace(/\bDF\b/g,           'ディフェンダー')
    .replace(/\bGK\b/g,           'ゴールキーパー')
    .replace(/\bMOM\b/g,          'マンオブザマッチ')
    // スコア記号
    .replace(/(\d+)-(\d+)/g,      '$1対$2')
    .replace(/→/g,                'から')
    .replace(/%/g,                'パーセント')
    .replace(/！/g,               '。')
    // 難読選手名（DeepSeekでも間違えやすい）
    .replace(/三笘(?:薫)?/g,      'みとまかおる')
    .replace(/久保(?:建英)?/g,    'くぼたけふさ')
    .replace(/上田(?:綺世)?/g,    'うえだあやせ')
    .replace(/冨安(?:健洋)?/g,    'とみやすたけひろ')
    .replace(/堂安(?:律)?/g,      'どうあんりつ')
    .replace(/松木(?:玖琉|玖生)?/g,'まつきくりゅう')
    .trim();
}

// ── DeepSeek ひらがな変換 ─────────────────────────────────────────
const HIRAGANA_PROMPT = 'あなたは日本語テキストをひらがなに変換する専門家です。以下のルールを厳守してください。\n1. 漢字・数字はすべてひらがなで読み仮名に変換する\n2. カタカナ（外来語・人名・チーム名）はそのままカタカナで残す\n3. 句読点（。、）はそのまま残す\n4. 変換後のテキストだけを出力し、説明は一切不要';

async function toHiragana(text) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('.envにDEEPSEEK_API_KEYが未設定');
  const r = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: HIRAGANA_PROMPT },
        { role: 'user',   content: text }
      ],
      temperature: 0
    },
    { headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' } }
  );
  return r.data.choices[0].message.content.trim();
}

// ── Engine Config ─────────────────────────────────────────────────
const ENGINE_CONFIG = {
  minimax: {
    label: 'MiniMax',
    models: [
      { id: 'speech-2.8-hd', label: 'speech-2.8-hd（高品質）' },
      { id: 'speech-2.1',    label: 'speech-2.1（標準）' }
    ],
    voices: [
      { id: 'Japanese_CalmLady',        label: '小夜風（落ち着いた女性）' },
      { id: 'Japanese_InnocentBoy',     label: 'ずんだもん風（無邪気な少年）' },
      { id: 'Japanese_GracefulMaiden',  label: 'めたん風（上品な女性）' },
      { id: 'Japanese_PowerfulMan',     label: '熱血男（力強い）' },
      { id: 'Japanese_SweetGirl',       label: '甘い声の少女' },
      { id: 'Japanese_ElegantLady',     label: '上品な貴婦人' },
      { id: 'Japanese_SmartMale',       label: '知的な青年' },
      { id: 'Japanese_LivelyGirl',      label: '元気な女の子' },
      { id: 'Japanese_DeepMale',        label: '渋い紳士（低音）' },
      { id: 'Japanese_BrightFemale',    label: '明るいお姉さん' },
      { id: 'Japanese_AnimeGirl',       label: 'アニメヒロイン風' },
      { id: 'Japanese_GentleMale',      label: '優しい男性' },
      { id: 'Japanese_NewsAnchor',      label: 'ニュースキャスター' },
      { id: 'Japanese_WhisperingLady',  label: 'ささやき声（女性）' },
      { id: 'Japanese_YouthfulBoy',     label: '爽やかな少年' },
      { id: 'English_ManWithDeepVoice', label: '青山龍星風（英語対応）' }
    ],
    emotions: [
      { id: 'neutral', label: '通常' },
      { id: 'happy',   label: '喜び' },
      { id: 'sad',     label: '悲しみ' },
      { id: 'angry',   label: '怒り' },
      { id: 'fear',    label: '恐怖' }
    ],
    hasPitch: true, hasEmotion: true, hasInstructions: false,
    defaultVoice: 'Japanese_CalmLady', defaultSpeed: 1.1,
    speedMin: 0.5, speedMax: 2.0
  },
  openai: {
    label: 'OpenAI TTS',
    models: [
      { id: 'tts-1-hd',        label: 'tts-1-hd（高品質）' },
      { id: 'tts-1',           label: 'tts-1（標準・安価）' },
      { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts（感情制御）' }
    ],
    voices: [
      { id: 'alloy',   label: 'alloy（中性・落ち着き）' },
      { id: 'echo',    label: 'echo（男性・明瞭）' },
      { id: 'fable',   label: 'fable（男性・暖かみ）' },
      { id: 'onyx',    label: 'onyx（男性・低音）' },
      { id: 'nova',    label: 'nova（女性・快活）' },
      { id: 'shimmer', label: 'shimmer（女性・柔らか）' }
    ],
    emotions: [],
    hasPitch: false, hasEmotion: false, hasInstructions: true,
    defaultVoice: 'nova', defaultSpeed: 1.0,
    speedMin: 0.25, speedMax: 4.0
  },
  voicevox: {
    label: 'VoiceVox',
    models: [
      { id: 'local', label: 'VoiceVox（ローカル）' }
    ],
    voices: [
      { id: '0',  label: '四国めたん（ノーマル）' },
      { id: '1',  label: 'ずんだもん（ノーマル）' },
      { id: '3',  label: 'ずんだもん（ささやき）' },
      { id: '8',  label: '春日部つむぎ' },
      { id: '10', label: '波音リツ' },
      { id: '11', label: '雨晴はう' },
      { id: '13', label: '青山龍星' },
      { id: '14', label: '冥鳴ひまり' }
    ],
    emotions: [],
    hasPitch: false, hasEmotion: false, hasInstructions: false,
    defaultVoice: '1', defaultSpeed: 1.2,
    speedMin: 0.5, speedMax: 2.0
  }
};

// ── API: Projects ─────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  const date = req.query.date;
  if (!date) return res.json({ success: false, error: '日付が未指定' });
  const fp = path.join(DATA_DIR, 'auto_generated_' + date + '.json');
  if (!fs.existsSync(fp)) return res.json({ success: false, error: date + ' のデータなし' });
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const posts = Array.isArray(raw) ? raw : (raw.posts || []);
    res.json({ success: true, posts });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── API: Generate TTS ─────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { engine, model, text, voice, speed, pitch, emotion, instructions } = req.body;
  if (!text || !text.trim()) return res.json({ success: false, error: 'テキストが空です' });

  // sanitize（略語補正）は全エンジン共通
  const sanitized = sanitize(text);

  // VoiceVox・MiniMax はさらに DeepSeek でひらがな変換
  const useHiragana = (engine === 'voicevox' || engine === 'minimax');
  let ttsText = sanitized;
  let hiragana = null;

  const ext      = engine === 'voicevox' ? 'wav' : 'mp3';
  const filename = 'tts_' + Date.now() + '.' + ext;
  const outPath  = path.join(TEMP_DIR, filename);
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  try {
    if (useHiragana) {
      hiragana = await toHiragana(sanitized);
      ttsText  = hiragana;
    }

    if (engine === 'minimax') {
      await genMinimax(ttsText, outPath, {
        model, voice,
        speed:   parseFloat(speed)  || 1.1,
        pitch:   parseInt(pitch)    || 0,
        emotion: emotion            || 'neutral'
      });
    } else if (engine === 'openai') {
      await genOpenAI(ttsText, outPath, {
        model, voice,
        speed:        parseFloat(speed) || 1.0,
        instructions: instructions || ''
      });
    } else if (engine === 'voicevox') {
      await genVoiceVox(ttsText, outPath, {
        speaker: parseInt(voice) || 1,
        speed:   parseFloat(speed) || 1.2
      });
    } else {
      return res.json({ success: false, error: '不明なエンジン: ' + engine });
    }
    res.json({ success: true, filename, hiragana });
  } catch (e) {
    console.error('[TTS Error]', e.message);
    res.json({ success: false, error: e.message });
  }
});

async function genMinimax(text, outPath, opts) {
  const apiKey  = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey || !groupId) throw new Error('.envにMINIMAX_API_KEY / MINIMAX_GROUP_IDが未設定');
  const r = await axios.post(
    'https://api-uw.minimax.io/v1/t2a_v2?GroupId=' + groupId,
    {
      model: opts.model || 'speech-2.8-hd',
      text,
      voice_setting:  { voice_id: opts.voice, speed: opts.speed, vol: 1.0, pitch: opts.pitch, emotion: opts.emotion },
      audio_setting:  { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      output_format:  'hex'
    },
    { headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' } }
  );
  const d = r.data;
  if (d.base_resp?.status_code !== 0) throw new Error('MiniMax ' + d.base_resp?.status_code + ': ' + d.base_resp?.status_msg);
  if (!d.data?.audio) throw new Error('音声データなし');
  fs.writeFileSync(outPath, Buffer.from(d.data.audio, 'hex'));
}

async function genOpenAI(text, outPath, opts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('.envにOPENAI_API_KEYが未設定');
  const body = { model: opts.model || 'tts-1-hd', input: text, voice: opts.voice || 'nova', speed: opts.speed };
  if (opts.model === 'gpt-4o-mini-tts' && opts.instructions) body.instructions = opts.instructions;
  const r = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    body,
    { headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
  );
  fs.writeFileSync(outPath, Buffer.from(r.data));
}

async function genVoiceVox(text, outPath, opts) {
  const VV = process.env.VOICEVOX_URL || 'http://localhost:50021';
  const qr = await axios.post(VV + '/audio_query?text=' + encodeURIComponent(text) + '&speaker=' + opts.speaker, null);
  const q  = qr.data;
  q.speedScale = opts.speed;
  const sr = await axios.post(VV + '/synthesis?speaker=' + opts.speaker, q, { responseType: 'arraybuffer' });
  fs.writeFileSync(outPath, Buffer.from(sr.data));
}

// ── HTML ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send(buildHTML()));

function buildHTML() {
  // JSON.stringify は バックティック・${} を含まないので安全に埋め込める
  const cfgJson = JSON.stringify(ENGINE_CONFIG);

  const css = `
:root{--bg:#0d1117;--surface:#161b22;--card:#1c2128;--border:#30363d;--accent:#58a6ff;--play:#f78166;--text:#e6edf3;--dim:#7d8590;--input:#0d1117;--blue:#58a6ff;--orange:#e3b341;--green:#3fb950;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden;font-size:13px;}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:9px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;flex-wrap:wrap;}
.logo{font-weight:800;font-size:14px;color:var(--accent);white-space:nowrap;}
.sep{color:var(--border);}
.engine-btns{display:flex;gap:5px;}
.ebtn{padding:4px 13px;border-radius:20px;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer;font-size:11px;font-weight:700;transition:all .15s;white-space:nowrap;}
.ebtn.active{background:var(--accent);border-color:var(--accent);color:#000;}
.ebtn:hover:not(.active){border-color:var(--accent);color:var(--accent);}
.model-wrap{display:flex;align-items:center;gap:6px;}
.model-wrap label{font-size:10px;color:var(--dim);white-space:nowrap;}
select,input[type=date]{background:var(--input);color:var(--text);border:1px solid var(--border);padding:4px 7px;border-radius:5px;font-size:12px;}
.load-btn{background:var(--accent);color:#000;border:none;padding:4px 12px;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;}
.load-btn:hover{opacity:.85;}
.status{font-size:11px;color:var(--dim);margin-left:auto;}
.layout{display:flex;flex:1;overflow:hidden;}
.sidebar{width:230px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;}
.sidebar-ttl{padding:9px 12px;font-size:10px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--border);}
.proj-list{flex:1;overflow-y:auto;padding:6px;}
.pitem{padding:7px 10px;border-radius:5px;cursor:pointer;color:var(--dim);border:1px solid transparent;margin-bottom:3px;line-height:1.4;font-size:12px;}
.pitem:hover{background:rgba(255,255,255,.04);color:var(--text);}
.pitem.active{background:rgba(88,166,255,.12);border-color:rgba(88,166,255,.3);color:var(--accent);font-weight:600;}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;}
.stabs{background:var(--surface);border-bottom:1px solid var(--border);display:flex;padding:0 16px;flex-shrink:0;}
.stab{padding:9px 18px;cursor:pointer;font-size:12px;font-weight:700;color:var(--dim);border-bottom:2px solid transparent;transition:all .15s;}
.stab:hover{color:var(--text);}
.stab.active{color:var(--accent);border-bottom-color:var(--accent);}
.content{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
.vbox{background:var(--card);border:1px solid var(--border);border-radius:9px;overflow:hidden;}
.vbox-hdr{display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:rgba(255,255,255,.02);border-bottom:1px solid var(--border);gap:8px;}
.vbox-lbl{font-size:11px;font-weight:800;letter-spacing:.3px;}
.vbox-key{font-size:10px;color:var(--dim);font-family:monospace;margin-left:6px;}
.play-btn{background:var(--play);color:#fff;border:none;padding:5px 14px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;transition:opacity .15s;flex-shrink:0;}
.play-btn:hover{opacity:.85;}
.play-btn:disabled{opacity:.4;cursor:not-allowed;}
.vbox-body{display:flex;}
.vbox-text{flex:1;padding:10px;}
textarea{width:100%;height:68px;background:var(--input);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:7px;font-size:12px;line-height:1.6;resize:none;font-family:inherit;}
textarea:focus{outline:none;border-color:var(--accent);}
.vbox-ctrl{width:215px;border-left:1px solid var(--border);padding:10px;display:flex;flex-direction:column;gap:7px;flex-shrink:0;background:rgba(0,0,0,.15);}
.ctrl{display:flex;flex-direction:column;gap:3px;}
.ctrl label{font-size:9px;color:var(--dim);font-weight:700;text-transform:uppercase;letter-spacing:.5px;}
.ctrl select{font-size:11px;}
.slider-row{display:flex;align-items:center;gap:5px;}
input[type=range]{flex:1;accent-color:var(--accent);height:3px;}
.sval{font-size:11px;color:var(--accent);font-weight:700;min-width:30px;text-align:right;}
.instr-ta{height:48px !important;font-size:11px !important;}
.yomi{font-size:10px;color:var(--dim);margin-top:4px;line-height:1.5;padding:4px 6px;background:rgba(255,255,255,.03);border-radius:4px;border-left:2px solid var(--border);display:none;}
.yomi.show{display:block;}
.yomi-label{color:var(--accent);font-weight:700;margin-right:4px;}
.lc-narr{color:var(--blue);}
.lc-cmt{color:var(--orange);}
.lc-outro{color:var(--green);}
.empty{color:var(--dim);text-align:center;padding:50px 20px;line-height:1.8;}
#loading{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:100;}
.ld-box{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:22px 36px;text-align:center;}
.spinner{width:22px;height:22px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 10px;}
@keyframes spin{to{transform:rotate(360deg);}}
`;

  const html = `
<div class="topbar">
  <div class="logo">&#127897; TTS Previewer</div>
  <div class="engine-btns">
    <button class="ebtn active" data-engine="minimax">MiniMax</button>
    <button class="ebtn" data-engine="openai">OpenAI TTS</button>
    <button class="ebtn" data-engine="voicevox">VoiceVox</button>
  </div>
  <div class="sep">|</div>
  <div class="model-wrap">
    <label>Model</label>
    <select id="modelSel"></select>
  </div>
  <div class="sep">|</div>
  <input type="date" id="dateIn">
  <button class="load-btn" onclick="loadProjects()">&#128229; 読み込み</button>
  <div id="status" class="status"></div>
</div>
<div class="layout">
  <div class="sidebar">
    <div class="sidebar-ttl">&#128193; プロジェクト</div>
    <div class="proj-list" id="projList"></div>
  </div>
  <div class="main">
    <div class="stabs" id="stabs">
      <div class="stab active" data-slide="1">S1 キャッチ</div>
      <div class="stab" data-slide="2">S2 概要</div>
      <div class="stab" data-slide="3">S3 反応&#9312;</div>
      <div class="stab" data-slide="4">S4 反応&#9313;</div>
      <div class="stab" data-slide="5">S5 アウトロ</div>
    </div>
    <div class="content" id="content">
      <div class="empty">日付を選んで「読み込み」&#8594; 左のプロジェクトを選択</div>
    </div>
  </div>
</div>
<div id="loading"><div class="ld-box"><div class="spinner"></div><div style="color:var(--dim);font-size:12px;">生成中...</div></div></div>
`;

  // クライアントJS — テンプレートリテラルの外で文字列結合して生成することで
  // バックティック内の \'  が ' に化ける問題を完全回避。
  // イベントハンドラは data-* 属性 + 委譲で実装。
  const js = `
var ENG = ` + cfgJson + `;
var posts=[],postIdx=-1,slide=1,engine="minimax",model="speech-2.8-hd";
var ST={},audioMap={};

// ── Init ──────────────────────────────────────────────────────
(function(){
  var d=new Date(); d.setHours(d.getHours()+9);
  document.getElementById("dateIn").value=d.toISOString().slice(0,10);
  refreshModelOpts();
  // エンジンボタン
  document.querySelectorAll(".ebtn").forEach(function(b){
    b.addEventListener("click",function(){ setEngine(b.dataset.engine); });
  });
  // スライドタブ
  document.querySelectorAll(".stab").forEach(function(t){
    t.addEventListener("click",function(){ selectSlide(parseInt(t.dataset.slide)); });
  });
  // モデル選択
  document.getElementById("modelSel").addEventListener("change",function(){
    model=this.value; renderContent();
  });
})();

// ── Engine / Model ────────────────────────────────────────────
function setEngine(eng){
  engine=eng;
  model=ENG[eng].models[0].id;
  document.querySelectorAll(".ebtn").forEach(function(b){
    b.classList.toggle("active", b.dataset.engine===eng);
  });
  Object.keys(ST).forEach(function(k){ delete ST[k]; });
  refreshModelOpts();
  renderContent();
}
function refreshModelOpts(){
  var sel=document.getElementById("modelSel");
  sel.innerHTML=ENG[engine].models.map(function(m){
    return "<option value=\\""+m.id+"\\">"+(m.label)+"</option>";
  }).join("");
  sel.value=model;
}

// ── Projects ──────────────────────────────────────────────────
async function loadProjects(){
  var date=document.getElementById("dateIn").value;
  setStatus("読み込み中...");
  try{
    var res=await fetch("/api/projects?date="+date);
    var data=await res.json();
    if(!data.success){ setStatus("❌ "+data.error); return; }
    posts=data.posts; postIdx=-1;
    document.getElementById("projList").innerHTML=posts.map(function(p,i){
      return "<div class=\\"pitem\\" data-idx=\\""+i+"\\">"+esc(p.youtubeTitle||p.catchLine1||"Post "+i)+"</div>";
    }).join("");
    document.getElementById("projList").addEventListener("click",function(e){
      var t=e.target.closest(".pitem"); if(!t) return;
      selectPost(parseInt(t.dataset.idx));
    });
    if(posts.length>0) selectPost(0);
    setStatus(posts.length+"件");
  }catch(e){ setStatus("❌ "+e.message); }
}
function selectPost(i){
  postIdx=i;
  document.querySelectorAll(".pitem").forEach(function(el){ el.classList.remove("active"); });
  var el=document.querySelector(".pitem[data-idx=\\""+i+"\\"]");
  if(el) el.classList.add("active");
  renderContent();
}

// ── Slides ────────────────────────────────────────────────────
function selectSlide(n){
  slide=n;
  document.querySelectorAll(".stab").forEach(function(t){
    t.classList.toggle("active", parseInt(t.dataset.slide)===n);
  });
  renderContent();
}
function getSlideItems(post,n){
  var items=[];
  if(n===1){
    items.push({key:"narr_0",label:"S1 キャッチコピー",text:post.catchLine1||"",cls:"lc-narr"});
  }else if(n===2){
    items.push({key:"narr_1",label:"S2 ナレーション",text:post.overviewNarration||"",cls:"lc-narr"});
  }else if(n===3){
    var s3=post.slide3||{};
    var t3=s3.narration||s3.subtitleBox||"";
    if(!s3.noNarration&&t3.trim()) items.push({key:"narr_2",label:"S3 ナレーション",text:t3,cls:"lc-narr"});
    (s3.comments||[]).forEach(function(c,i){
      var txt=typeof c==="string"?c:(c.text||"");
      if(txt.trim()) items.push({key:"cmt_2_"+i,label:"S3 コメント"+(i+1),text:txt,cls:"lc-cmt"});
    });
  }else if(n===4){
    var s4=post.slide4||{};
    var t4=s4.narration||"";
    if(!s4.noNarration&&t4.trim()) items.push({key:"narr_3",label:"S4 ナレーション",text:t4,cls:"lc-narr"});
    (s4.comments||[]).forEach(function(c,i){
      var txt=typeof c==="string"?c:(c.text||"");
      if(txt.trim()) items.push({key:"cmt_3_"+i,label:"S4 コメント"+(i+1),text:txt,cls:"lc-cmt"});
    });
  }else if(n===5){
    var t5=post.outroTelop||post.outroNarration||"";
    if(t5.trim()) items.push({key:"narr_4",label:"S5 アウトロ",text:t5,cls:"lc-outro"});
  }
  return items;
}

// ── Render ────────────────────────────────────────────────────
function renderContent(){
  var area=document.getElementById("content");
  if(postIdx<0||!posts[postIdx]){
    area.innerHTML="<div class=\\"empty\\">左のプロジェクトを選択してください</div>"; return;
  }
  var post=posts[postIdx];
  var items=getSlideItems(post,slide);
  if(!items.length){
    area.innerHTML="<div class=\\"empty\\">このスライドにコンテンツがありません</div>"; return;
  }
  var cfg=ENG[engine];
  var isInstr=(engine==="openai"&&model==="gpt-4o-mini-tts");
  var showEmo=cfg.hasEmotion;
  var showPitch=cfg.hasPitch;

  area.innerHTML=items.map(function(item){
    if(!ST[item.key]){
      ST[item.key]={
        voice: cfg.defaultVoice||(cfg.voices[0]&&cfg.voices[0].id)||"",
        emotion:(cfg.emotions[0]&&cfg.emotions[0].id)||"neutral",
        speed: cfg.defaultSpeed||1.0,
        pitch: 0,
        instructions:""
      };
    }
    var s=ST[item.key];
    var k=item.key;

    var vOpts=cfg.voices.map(function(v){
      return "<option value=\\""+v.id+"\\""+( v.id===s.voice?" selected":"")+">"+v.label+"</option>";
    }).join("");

    var eOpts=showEmo ? cfg.emotions.map(function(e){
      return "<option value=\\""+e.id+"\\""+( e.id===s.emotion?" selected":"")+">"+e.label+"</option>";
    }).join("") : "";

    var emoRow= showEmo
      ? "<div class=\\"ctrl\\"><label>感情</label>"
        +"<select class=\\"v-emo\\" data-key=\\""+k+"\\">"+eOpts+"</select></div>"
      : "";

    var instrRow= isInstr
      ? "<div class=\\"ctrl\\"><label>Instructions</label>"
        +"<textarea class=\\"instr-ta v-instr\\" data-key=\\""+k+"\\" placeholder=\\"例: Speak with excitement.\\">"+esc(s.instructions||"")+"</textarea></div>"
      : "";

    var pitchRow= showPitch
      ? "<div class=\\"ctrl\\"><label>ピッチ</label><div class=\\"slider-row\\">"
        +"<input type=\\"range\\" class=\\"v-pitch\\" data-key=\\""+k+"\\" min=\\"-12\\" max=\\"12\\" step=\\"1\\" value=\\""+s.pitch+"\\">"
        +"<span class=\\"sval\\">"+s.pitch+"</span></div></div>"
      : "";

    var spVal=parseFloat(s.speed).toFixed(2);

    return "<div class=\\"vbox\\">"
      +"<div class=\\"vbox-hdr\\">"
        +"<div><span class=\\"vbox-lbl "+item.cls+"\\">"+item.label+"</span>"
        +"<span class=\\"vbox-key\\">"+k+"</span></div>"
        +"<button class=\\"play-btn\\" data-key=\\""+k+"\\">&#9654; 生成・再生</button>"
      +"</div>"
      +"<div class=\\"vbox-body\\">"
        +"<div class=\\"vbox-text\\">"
          +"<textarea class=\\"v-txt\\" data-key=\\""+k+"\\">"+esc(item.text)+"</textarea>"
          +"<div class=\\"yomi\\" id=\\"yomi_"+k+"\\"><span class=\\"yomi-label\\">読み:</span><span class=\\"yomi-text\\"></span></div>"
        +"</div>"
        +"<div class=\\"vbox-ctrl\\">"
          +"<div class=\\"ctrl\\"><label>声 / キャラ</label>"
            +"<select class=\\"v-voice\\" data-key=\\""+k+"\\">"+vOpts+"</select>"
          +"</div>"
          +emoRow
          +instrRow
          +"<div class=\\"ctrl\\"><label>速度</label><div class=\\"slider-row\\">"
            +"<input type=\\"range\\" class=\\"v-speed\\" data-key=\\""+k+"\\" min=\\""+cfg.speedMin+"\\" max=\\""+cfg.speedMax+"\\" step=\\"0.05\\" value=\\""+s.speed+"\\">"
            +"<span class=\\"sval\\">"+spVal+"</span>"
          +"</div></div>"
          +pitchRow
        +"</div>"
      +"</div>"
    +"</div>";
  }).join("");

  // イベント委譲でまとめて登録
  area.addEventListener("change", onAreaChange);
  area.addEventListener("input",  onAreaInput);
  area.addEventListener("click",  onAreaClick);
}

// ── イベント委譲ハンドラ ──────────────────────────────────────
function onAreaChange(e){
  var el=e.target, k=el.dataset.key;
  if(!k) return;
  if(el.classList.contains("v-voice"))  { setST(k,"voice",el.value); }
  if(el.classList.contains("v-emo"))    { setST(k,"emotion",el.value); }
  if(el.classList.contains("v-instr"))  { setST(k,"instructions",el.value); }
  if(el.classList.contains("v-txt"))    { upTxt(k,el.value); }
}
function onAreaInput(e){
  var el=e.target, k=el.dataset.key;
  if(!k) return;
  if(el.classList.contains("v-speed")){
    var v=parseFloat(el.value); setST(k,"speed",v);
    el.nextElementSibling.textContent=v.toFixed(2);
  }
  if(el.classList.contains("v-pitch")){
    var v=parseInt(el.value); setST(k,"pitch",v);
    el.nextElementSibling.textContent=v;
  }
}
async function onAreaClick(e){
  var btn=e.target.closest(".play-btn"); if(!btn) return;
  var k=btn.dataset.key;
  var ta=document.querySelector(".v-txt[data-key=\\""+k+"\\"]");
  if(!ta) return;
  var text=ta.value.trim();
  if(!text){ alert("テキストが空です"); return; }
  var s=ST[k]||{};
  var body={engine:engine,model:model,text:text,voice:s.voice,emotion:s.emotion,
            speed:s.speed||1.0,pitch:s.pitch||0,instructions:s.instructions||""};
  btn.disabled=true; btn.textContent="生成中...";
  document.getElementById("loading").style.display="flex";
  try{
    var res=await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    var data=await res.json();
    if(data.success){
      if(audioMap[k]) audioMap[k].pause();
      audioMap[k]=new Audio("/temp/"+data.filename);
      audioMap[k].onended=function(){ btn.textContent="&#9654; 生成・再生"; btn.disabled=false; };
      audioMap[k].play();
      btn.textContent="&#9646; 再生中...";
      // ひらがな読みを表示
      if(data.hiragana){
        var yomiEl=document.getElementById("yomi_"+k);
        if(yomiEl){
          yomiEl.querySelector(".yomi-text").textContent=data.hiragana;
          yomiEl.classList.add("show");
        }
      }
    }else{
      alert("❌ "+data.error);
      btn.textContent="&#9654; 生成・再生"; btn.disabled=false;
    }
  }catch(e){
    alert("❌ 通信エラー: "+e.message);
    btn.textContent="&#9654; 生成・再生"; btn.disabled=false;
  }finally{
    document.getElementById("loading").style.display="none";
  }
}

// ── Helpers ───────────────────────────────────────────────────
function setST(k,f,v){ if(!ST[k]) ST[k]={}; ST[k][f]=v; }
function upTxt(k,v){
  var p=posts[postIdx]; if(!p) return;
  if(k==="narr_0") p.catchLine1=v;
  else if(k==="narr_1") p.overviewNarration=v;
  else if(k==="narr_2"){ if(!p.slide3) p.slide3={}; p.slide3.narration=v; }
  else if(k==="narr_3"){ if(!p.slide4) p.slide4={}; p.slide4.narration=v; }
  else if(k==="narr_4"){ p.outroTelop=v; p.outroNarration=v; }
  else if(k.indexOf("cmt_2_")===0){ var i=parseInt(k.split("_")[2]); if(p.slide3&&p.slide3.comments&&p.slide3.comments[i]) p.slide3.comments[i].text=v; }
  else if(k.indexOf("cmt_3_")===0){ var i=parseInt(k.split("_")[2]); if(p.slide4&&p.slide4.comments&&p.slide4.comments[i]) p.slide4.comments[i].text=v; }
}
function setStatus(m){ document.getElementById("status").textContent=m; }
function esc(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
`;

  return '<!DOCTYPE html>\n'
    + '<html lang="ja"><head><meta charset="UTF-8"><title>TTS Previewer</title>'
    + '<style>' + css + '</style></head>'
    + '<body>' + html
    + '<script>' + js + '<\/script>'
    + '</body></html>';
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('TTS Previewer: http://localhost:' + PORT);
});
