// local_v2_launcher.js
// ═══════════════════════════════════════════════════════════
// V2ランチャー 統合版 / 【改修 RED】
// 各 Step は routes/ 以下のファイルで独立管理。
// このファイルはシェル（共通CSS・サイドバー・ナビ・グローバル状態）のみ担当。
// ═══════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3004;

app.use(express.json({ limit: '100mb' }));

// ─── 各ステップのルート（API + UI を完全独立で管理）───────
const { router: s1Router, getUI: s1UI } = require('./routes/step1_routes');
const { router: s2Router, getUI: s2UI } = require('./routes/step2_routes');
const { router: s3Router, getUI: s3UI } = require('./routes/step3_routes');
const { router: s4Router, getUI: s4UI } = require('./routes/step4_routes');

app.use('/api', s1Router);
app.use('/api', s2Router);
app.use('/api', s3Router);
app.use('/api', s4Router);

// 取得済み画像を静的配信（Step3 のプレビューに使用）
app.use('/images', require('express').static(path.join(__dirname, 'images')));

// 生成済み動画を静的配信（Step4 でブラウザ再生・ダウンロード）
app.use('/v2_videos', require('express').static(path.join(__dirname, 'data', 'v2_videos')));

// テンプレートプレビュー（各モジュール型のHTMLを直接確認する用）
['insight', 'history', 'matchcard', 'matchcenter'].forEach(name => {
  app.use('/template/' + name, require('express').static(path.join(__dirname, name)));
});

// ─── メインページ（シェルのみ）────────────────────────────
app.get('/', (_, res) => res.send(buildPage()));

function buildPage() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚽ サッカーYT v2 Pro RED</title>
<style>
/* ── グローバル変数 ── */
:root {
  --c:      #ff4d4d;
  --bg:     #0f1117;
  --panel:  #161b2e;
  --border: #2a3050;
  --text:   #e0e0e0;
  --muted:  #8a9aba;
  --success:#10b981;
}

/* ── ベースリセット ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: sans-serif; background: var(--bg); color: var(--text);
       display: flex; height: 100vh; overflow: hidden; }

/* ── サイドバー（コンパクト化）── */
.sidebar { width: 220px; background: #0d1220; border-right: 1px solid var(--border);
           display: flex; flex-direction: column; flex-shrink: 0; }
.sidebar-header { padding: 12px 14px; background: #1a2540; color: var(--c);
                  font-weight: 900; font-size: 12px; border-bottom: 1px solid #2a3560; letter-spacing: 1px; }
.saved-list { flex: 1; overflow-y: auto; padding: 8px; }
.lead-item { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
             padding: 8px 10px; margin-bottom: 6px; cursor: pointer; font-size: 11px;
             transition: border-color .15s; line-height: 1.35; word-break: break-all; }
.lead-item:hover { border-color: var(--muted); }
.lead-item.active { border-color: var(--c); border-left: 3px solid var(--c); background: #1e2540; }

/* ── メインエリア ── */
.main-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.header { background: #1a2040; padding: 13px 22px; border-bottom: 3px solid var(--c);
          display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
.header h1 { font-size: 18px; color: var(--c); font-weight: 900;
             text-shadow: 0 0 12px rgba(255,77,77,.35); }
.header-sub { font-size: 11px; color: var(--muted); }

/* ── ステップナビ ── */
.steps { display: flex; background: #0d1220; border-bottom: 1px solid #1e2540; flex-shrink: 0; }
.step-nav { padding: 11px 22px; font-size: 11px; font-weight: bold; color: #3a4a6a; cursor: pointer;
            transition: color .15s; user-select: none; }
.step-nav:hover { color: var(--muted); }
.step-nav.active { color: var(--c); background: var(--panel); border-bottom: 2px solid var(--c); }

/* ── コンテンツスクロール ── */
.content-scroll { flex: 1; overflow-y: auto; }

/* ── 共通パーツ（各 Step から使用可）── */
.panel { background: var(--panel); border-radius: 10px; padding: 18px;
         margin-bottom: 16px; border: 1px solid var(--border); }
.step-container { padding: 18px 20px; }

.btn { padding: 8px 16px; border-radius: 7px; cursor: pointer; border: none;
       font-weight: bold; font-size: 12px; transition: opacity .15s; }
.btn:hover { opacity: 0.85; }
.btn-primary { background: var(--c); color: #fff; }
.btn-success { background: var(--success); color: #fff; }
.btn-sm { background: #1e2a4a; color: var(--text); font-size: 11px; padding: 5px 10px; }

.inp { background: #0d1220; color: var(--text); border: 1px solid var(--border);
       padding: 7px 10px; border-radius: 6px; font-size: 12px; outline: none; }
.inp:focus { border-color: var(--c); }
select.inp { cursor: pointer; }

/* ── 案件一覧（Step1）── */
.time-group { margin-bottom: 10px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.time-summary { background: #1a2840; padding: 9px 14px; cursor: pointer;
                color: #7dc8ff; font-size: 12px; font-weight: bold; }
.time-summary:hover { background: #1f3050; }
.time-content {}
.post-row { padding: 9px 14px; border-bottom: 1px solid #1a2540; display: flex;
            align-items: center; gap: 10px; font-size: 13px; cursor: pointer; transition: background .1s; }
.post-row:hover { background: #131a30; }
.post-row.selected { background: #1a2440; }
.post-row input[type=checkbox] { flex-shrink: 0; }
.src-badge { padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: bold; flex-shrink: 0; }
.badge-reddit { background: #ff4500; color: #fff; }
.badge-5ch    { background: #ff9900; color: #000; }

/* ── SI関連（Step2）── */
.label-item { padding: 4px 10px; border-radius: 20px; font-size: 11px;
              display: inline-flex; align-items: center; gap: 5px; color: #fff; }
.cand-row { padding: 9px 12px; cursor: pointer; border-bottom: 1px solid #1e2a40;
            font-size: 12px; display: flex; align-items: center; gap: 6px; }
.cand-row:hover { background: #1a2540; }
.si-hist-row { padding: 8px 12px; border-bottom: 1px solid #1a2540;
               font-size: 12px; display: flex; align-items: center; gap: 6px; }
.si-hist-row:hover { background: #131a30; }
pre { background: #0d1220; padding: 12px; border-radius: 8px; font-size: 11px;
      overflow-x: auto; color: #9bb5e0; white-space: pre-wrap;
      border: 1px solid #1a2540; word-break: break-all; }

/* ── モジュールタブ（Step3）── */
.s3-tab { padding: 8px 12px; background: #1a2540; border-radius: 8px 8px 0 0;
          font-size: 11px; cursor: pointer; color: var(--muted); min-width: 60px;
          text-align: center; border: 1px solid var(--border); border-bottom: none;
          transition: background .15s; }
.s3-tab:hover { background: #252f4a; }
.s3-tab-active { color: #fff; border-color: var(--c); }
</style>
</head>
<body>

<!-- ─── サイドバー（保存済み案件）─── -->
<div class="sidebar">
  <div class="sidebar-header">📦 保存済み案件 (RED)</div>
  <div id="savedList" class="saved-list"></div>
</div>

<!-- ─── メインエリア ─── -->
<div class="main-area">
  <div class="header">
    <h1>⚽ サッカーYT v2 Pro <span style="color:var(--c);">RED</span></h1>
    <span class="header-sub">Local Launcher — port ${PORT}</span>
  </div>
  <div class="steps">
    <div class="step-nav active" id="nav1" onclick="goStep(1)">1. 案件選択</div>
    <div class="step-nav"        id="nav2" onclick="goStep(2)">2. SI情報取得</div>
    <div class="step-nav"        id="nav3" onclick="goStep(3)">3. 構成提案</div>
    <div class="step-nav"        id="nav4" onclick="goStep(4)">4. シナリオ編集</div>
  </div>
  <div class="content-scroll">
    <!-- 各 Step の UI（routes/*.js から注入） -->
    ${s1UI()}
    ${s2UI()}
    ${s3UI()}
    ${s4UI()}
  </div>
</div>

<!-- ─── グローバル JS ─── -->
<script>
/* ====================================================
   グローバル状態 window.APP
   各 Step はこのオブジェクトで状態を共有する。
   Step をまたぐ遷移もここで管理。
   ==================================================== */
/* step2/step3 の IIFE が先に window.APP.s2 等をセットしているので、
   ここでは上書きせず「未定義のキーのみデフォルト値を追加」する形にする。 */
window.APP = window.APP || {};
Object.assign(window.APP, Object.assign({
  posts:       [],           // Step1: 案件一覧
  postMap:     {},           // Step1: id → post の逆引き
  selectedIds: new Set(),    // Step1: チェック中のID
  saved:       [],           // 保存済み案件リスト（サイドバー）
  selected:    null,         // 現在編集中の案件（Step2〜3で使用）
  keywords:    [],           // Step2: SIキーワード（レガシー互換用）
  siData:      {},           // Step2: 取得済みSIデータ（レガシー互換用）
  modules:     [],           // Step3: モジュール一覧
  activeTab:   0,            // Step3: 現在のタブ
}, window.APP));

/* ── fetchJson ヘルパー（全 Step で使用）── */
window.fetchJson = async function(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text();
    throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 200));
  }
  return res.json();
};

/* ── ステップナビ ── */
window.goStep = function(n) {
  [1, 2, 3, 4].forEach(i => {
    const content = document.getElementById('step' + i);
    const nav     = document.getElementById('nav' + i);
    if (content) content.style.display = (i === n) ? 'block'  : 'none';
    if (nav)     nav.className         = 'step-nav' + (i === n ? ' active' : '');
  });
  /* 各 Step の初期化関数を呼び出す */
  const fn = window['step' + n + 'Init'];
  if (typeof fn === 'function') fn();
};

/* ── サイドバー描画 ── */
window.renderSidebar = function() {
  document.getElementById('savedList').innerHTML = window.APP.saved.length
    ? window.APP.saved.map((item, i) =>
        '<div class="lead-item' + (window.APP.selected?.id === item.id ? ' active' : '') + '"'
        + ' onclick="selectLead(' + i + ')">'
        + _shEsc(item.title || '(タイトル不明)')
        + '</div>'
      ).join('')
    : '<div style="padding:10px;font-size:11px;color:#3a4a6a;">保存された案件はありません</div>';
};

/* ── 案件選択（サイドバー → Step2 遷移）── */
window.selectLead = function(idx) {
  const item = window.APP.saved[idx];
  if (!item) return;
  window.APP.selected  = item;
  window.APP.keywords  = [];
  window.APP.siData    = {};
  window.APP.modules   = [];
  window.APP.activeTab = 0;
  window.renderSidebar();
  window.goStep(2);
};

/* ── エスケープ（シェル用）── */
function _shEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── 起動時初期化 ── */
window.addEventListener('DOMContentLoaded', async () => {
  /* 保存済み案件を読み込む */
  try {
    const data = await fetchJson('/api/saved-projects');
    window.APP.saved = Array.isArray(data) ? data : [];
  } catch(e) {
    window.APP.saved = [];
  }
  renderSidebar();
  goStep(1);  /* Step1 を表示 */
});
</script>

</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] ⚽ V2 Pro RED @ http://localhost:${PORT}`);
  console.log('  Step1: 案件選択    → routes/step1_routes.js');
  console.log('  Step2: SI情報取得  → routes/step2_routes.js');
  console.log('  Step3: 構成提案    → routes/step3_routes.js');
  console.log('  Step4: シナリオ編集 → routes/step4_routes.js');
});
