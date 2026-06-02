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
const { router: s1Router,  getUI: s1UI  } = require('./routes/step1_routes');
const { router: s2Router,  getUI: s2UI  } = require('./routes/step2_routes');
const { router: s3Router,  getUI: s3UI  } = require('./routes/step3_routes');
const { router: s35Router, getUI: s35UI } = require('./routes/step35_routes');
const { router: s4Router,  getUI: s4UI  } = require('./routes/step4_routes');
const { router: s5Router,  getUI: s5UI  } = require('./routes/step5_routes');
const { router: s6Router,  getUI: s6UI  } = require('./routes/step6_routes');
const { router: dataExplorerRouter }     = require('./routes/data_explorer_routes');
const { router: chatRouter, getUI: chatUI } = require('./routes/chat_routes');
const { router: curatedRouter }          = require('./routes/curated_routes');
const { router: v25Router }              = require('./routes/v25_autopilot_routes');

app.use('/api', s1Router);
app.use('/api', s2Router);
app.use('/api', s3Router);
app.use('/api', s35Router);
app.use('/api', s4Router);
app.use('/api', s5Router);
app.use('/api', s6Router);
app.use('/api', dataExplorerRouter);
app.use('/api', chatRouter);
app.use('/api', curatedRouter);
app.use('/api', v25Router);

// 取得済み画像を静的配信（Step3 のプレビューに使用）
app.use('/images', require('express').static(path.join(__dirname, 'images')));

// クラブ公式の選手プロフィール写真ストック（Phase 1 バックフィル成果物）
app.use('/images_stock', require('express').static(path.join(__dirname, 'images_stock')));

// 生成済み動画を静的配信（Step4 でブラウザ再生・ダウンロード）
app.use('/v2_videos', require('express').static(path.join(__dirname, 'data', 'v2_videos')));

// 生成済みサムネを静的配信（Step5 で表示・ダウンロード）
app.use('/v2_thumbs', require('express').static(path.join(__dirname, 'data', 'v2_thumbs')));

// データエクスプローラ（walker / recipe / comparison の挙動を可視化）
app.use('/v2_data_explorer', require('express').static(path.join(__dirname, 'data', 'v2_data_explorer')));

// BGM 静的配信（サンプルギャラリーで使う、bgm/ ディレクトリ全体）
app.use('/bgm', require('express').static(path.join(__dirname, 'bgm')));
app.get('/bgm.mp3', (req, res) => {
  // bgm/ にあるファイルから1つ返す（フォールバック付き）
  const bgmDir = path.join(__dirname, 'bgm');
  let pick = null;
  try {
    if (require('fs').existsSync(bgmDir)) {
      const files = require('fs').readdirSync(bgmDir).filter(f => /\.(mp3|m4a)$/i.test(f));
      if (files.length) pick = path.join(bgmDir, files[0]);
    }
  } catch (_) {}
  if (!pick) {
    const fallback = path.join(__dirname, 'bgm.mp3');
    if (require('fs').existsSync(fallback)) pick = fallback;
  }
  if (!pick) return res.status(404).send('no bgm');
  res.sendFile(pick);
});

// テンプレートプレビュー（各モジュール型のHTMLを直接確認する用）
['insight', 'history', 'matchcard'].forEach(name => {
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
           display: flex; flex-direction: column; flex-shrink: 0;
           transition: transform .25s ease; }
.sidebar-header { padding: 12px 14px; background: #1a2540; color: var(--c);
                  font-weight: 900; font-size: 12px; border-bottom: 1px solid #2a3560; letter-spacing: 1px;
                  display: flex; justify-content: space-between; align-items: center; }
.sidebar-close { display: none; background: transparent; border: 1px solid #ff4d4d40;
                 color: var(--c); padding: 4px 9px; border-radius: 4px; cursor: pointer;
                 font-size: 14px; font-weight: bold; }
.saved-list { flex: 1; overflow-y: auto; padding: 8px; }
/* ── ハンバーガー（モバイル時のみ表示）── */
.hamburger { display: none; background: transparent; border: 1px solid var(--c);
             color: var(--c); padding: 6px 10px; border-radius: 6px; cursor: pointer;
             font-size: 16px; font-weight: bold; min-height: 36px; }
.sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5);
                   z-index: 998; }
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

/* ════════════════════════════════════════════════
   📱 タブレット (≤1024px) — 中間ブレイクポイント
   サイドバーをやや狭く、ヘッダは保持
   ════════════════════════════════════════════════ */
@media (max-width: 1024px) {
  .sidebar { width: 180px; }
  .header h1 { font-size: 16px; }
  .step-nav { padding: 10px 14px; }
  .step-container { padding: 14px 16px; }
}

/* ════════════════════════════════════════════════
   📱 モバイル (≤768px) — 完全レスポンシブ
   ハンバーガー / 縦積み / タッチ最適化
   ════════════════════════════════════════════════ */
@media (max-width: 768px) {
  /* ── ベース：縦積み、ページスクロール解放 ── */
  body { flex-direction: column; height: auto; min-height: 100vh; overflow: auto; }

  /* ── サイドバー：オーバーレイ式（デフォ非表示・ハンバーガーで開閉）── */
  .sidebar { position: fixed; top: 0; left: 0; bottom: 0; z-index: 999;
             width: 80vw; max-width: 280px; max-height: 100vh;
             border-right: 1px solid var(--border); border-bottom: none;
             transform: translateX(-100%); box-shadow: 4px 0 20px rgba(0,0,0,0.5); }
  .sidebar.open { transform: translateX(0); }
  .sidebar-close { display: inline-block; }
  .sidebar-overlay.show { display: block; }

  /* ── ハンバーガー表示 ── */
  .hamburger { display: inline-block; }

  /* ── メインエリア：オーバーフロー解放 ── */
  .main-area { width: 100%; overflow: visible; }
  .content-scroll { overflow-y: visible; }

  /* ── ヘッダ ── */
  .header { padding: 10px 12px; gap: 8px; }
  .header h1 { font-size: 14px; flex: 1; min-width: 0; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; }
  .header-sub { display: none; }

  /* ── ステップナビ：横スクロール ── */
  .steps { overflow-x: auto; -webkit-overflow-scrolling: touch;
           scrollbar-width: none; }
  .steps::-webkit-scrollbar { display: none; }
  .step-nav { padding: 12px 14px; font-size: 12px; flex-shrink: 0;
              min-height: 44px; display: flex; align-items: center;
              white-space: nowrap; }

  /* ── コンテンツ ── */
  .step-container { padding: 10px 12px; }
  .panel { padding: 12px; margin-bottom: 12px; }

  /* ── ボタン：タップ領域 ≥ 40px ── */
  .btn { padding: 10px 16px; font-size: 13px; min-height: 40px; }
  .btn-sm { padding: 8px 12px; font-size: 12px; min-height: 36px; }

  /* ── 入力欄：iOS自動ズーム防止のため font-size 16px ── */
  .inp { padding: 10px 12px; font-size: 16px; min-height: 40px; }
  textarea.inp { min-height: 80px; }

  /* ── リスト系：タップ領域確保 ── */
  .post-row { padding: 12px 14px; font-size: 13px; flex-wrap: wrap; }
  .lead-item { padding: 12px 14px; font-size: 12px; }
  .cand-row, .si-hist-row { padding: 12px; font-size: 12px; }
  .time-summary { padding: 12px 14px; font-size: 12px; }

  /* ── pre：横スクロール保険 ── */
  pre { font-size: 11px; padding: 10px; max-width: 100%;
        overflow-x: auto; word-break: break-all; }

  /* ── Step3/4 のインライン2カラム grid を縦積みに上書き ── */
  [style*="grid-template-columns:1fr 1fr"] {
    grid-template-columns: 1fr !important;
  }
  /* ── Step3 inline 4列 / 5列 grid を縦積みに ── */
  [style*="grid-template-columns:repeat(5,1fr)"] {
    grid-template-columns: repeat(2, 1fr) !important;
  }
  [style*="grid-template-columns:repeat(4,1fr)"] {
    grid-template-columns: repeat(2, 1fr) !important;
  }
  /* ── Step4 dataSlots 行レイアウト（label + value + 削除ボタン）── */
  [style*="grid-template-columns:140px 1fr 28px"] {
    grid-template-columns: 1fr 1fr 32px !important;
  }
  [style*="grid-template-columns:1fr 1fr 1fr 28px"] {
    grid-template-columns: 1fr 1fr 1fr 32px !important;
  }

  /* ── Step4 プレビューを大きく（iframe scale は JS 側で再計算）── */
  #s4PreviewWrap { width: 100% !important; }

  /* ── モジュールタブ ── */
  .s3-tab { padding: 12px 14px; font-size: 12px; min-width: 80px;
            min-height: 44px; display: inline-flex; align-items: center;
            justify-content: center; }

  /* ── 画像ギャラリー：サムネ大きめに ── */
  [style*="width:96px;height:72px"] {
    width: 80px !important; height: 60px !important;
  }
}

/* ════════════════════════════════════════════════
   📱 小型モバイル (≤480px) — さらに最適化
   ════════════════════════════════════════════════ */
@media (max-width: 480px) {
  .header h1 { font-size: 13px; }
  .step-nav { padding: 11px 10px; font-size: 11px; }
  .step-container { padding: 8px 10px; }
  .panel { padding: 10px; }
  .btn { font-size: 12px; padding: 9px 12px; }
  /* 5列グリッドを 1列に */
  [style*="grid-template-columns:repeat(5,1fr)"] {
    grid-template-columns: 1fr !important;
  }
}
</style>
</head>
<body>

<!-- ─── 早期ブートストラップ（ステップ IIFE が runJob/registerJobResumer を使うので最先頭）─── -->
<script>
/* ════════════════════════════════════════════════
   非同期ジョブ実行ヘルパー（サーバー側 non-blocking job + クライアント polling）
   モバイル Safari/Chrome のバックグラウンドタブ強制終了対策。
   - サーバーで処理を完結 / クライアントは jobId で polling だけ
   - 起動した jobId を localStorage に保存 → リロード後も resume 可能
   - 完了/エラー時に localStorage から該当ジョブを削除
   ════════════════════════════════════════════════ */
(function() {
  const KEY = 'v2_active_jobs_v1';
  window._loadActiveJobs = function() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch (_) { return {}; }
  };
  window._saveActiveJobs = function(jobs) {
    try { localStorage.setItem(KEY, JSON.stringify(jobs)); } catch (_) {}
  };
  window._addActiveJob = function(key, meta) {
    const jobs = window._loadActiveJobs();
    jobs[key] = Object.assign({}, meta, { savedAt: Date.now() });
    window._saveActiveJobs(jobs);
  };
  window._removeActiveJob = function(key) {
    const jobs = window._loadActiveJobs();
    delete jobs[key];
    window._saveActiveJobs(jobs);
  };

  window.JOB_RESUMERS = {};
  window.registerJobResumer = function(kind, fn) { window.JOB_RESUMERS[kind] = fn; };

  /* ジョブ起動 or 復帰 → 結果を返す Promise.
     - opts.key で localStorage に既存ジョブが残ってればその jobId を polling して resume
     - 無ければ opts.startUrl に POST、 jobId を localStorage に保存して polling
     opts: { startUrl, statusUrl, body, kind, key?, intervalMs?, timeoutMs?, onProgress? } */
  window.runJob = async function(opts) {
    const startUrl  = opts.startUrl;
    const statusUrl = opts.statusUrl;
    const body      = opts.body || {};
    const kind      = opts.kind || 'unknown';
    const key       = opts.key  || kind;
    const intervalMs = opts.intervalMs || 3000;
    const timeoutMs  = opts.timeoutMs  || 20 * 60 * 1000;
    const onProgress = opts.onProgress;

    let jobId = null;
    const stored = window._loadActiveJobs()[key];
    if (stored && stored.jobId && stored.statusUrl === statusUrl) {
      jobId = stored.jobId;
      console.log('[runJob] resume', key, jobId.slice(-8));
    }

    if (!jobId) {
      if (!startUrl) throw new Error('runJob: startUrl 必須 (resume も不可)');
      const r = await fetch(startUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error('start ' + r.status + ': ' + t.slice(0, 200));
      }
      const d = await r.json();
      if (!d.jobId) throw new Error('jobId not returned');
      jobId = d.jobId;
      window._addActiveJob(key, { jobId, kind, statusUrl, body });
    }

    const started = Date.now();
    while (true) {
      if (Date.now() - started > timeoutMs) {
        window._removeActiveJob(key);
        throw new Error('job timeout: ' + key);
      }
      await new Promise(r => setTimeout(r, intervalMs));
      let r;
      try {
        r = await fetch(statusUrl + '?jobId=' + encodeURIComponent(jobId));
      } catch (e) {
        console.warn('[runJob] poll network error, retrying:', e.message);
        continue;
      }
      if (r.status === 404) {
        window._removeActiveJob(key);
        throw new Error('job vanished: ' + jobId);
      }
      let job;
      try { job = await r.json(); }
      catch (e) {
        console.warn('[runJob] parse error, retrying:', e.message);
        continue;
      }
      if (typeof onProgress === 'function') {
        try { onProgress(job); } catch (_) {}
      }
      if (job.status === 'error') {
        window._removeActiveJob(key);
        throw new Error(job.error || 'job error');
      }
      if (job.status === 'done') {
        window._removeActiveJob(key);
        return job.result;
      }
    }
  };

  /* 起動時に未完了ジョブをスキャン → resumer 登録済みなら自動再開 */
  window.resumeStoredJobs = async function() {
    const jobs = window._loadActiveJobs();
    const entries = Object.entries(jobs);
    if (!entries.length) return;
    console.log('[runJob] stored jobs:', entries.map(([k, m]) => k + '=' + (m.jobId || '').slice(-8)).join(', '));
    for (const [key, meta] of entries) {
      const fn = window.JOB_RESUMERS[meta.kind];
      if (!fn) {
        console.log('[runJob] no resumer for kind=' + meta.kind + ', skip ' + key);
        continue;
      }
      Promise.resolve().then(() => fn({ key, meta }))
        .catch(e => console.warn('[resumer]', key, e.message));
    }
  };
})();
</script>

<!-- ─── サイドバー（保存済み案件）─── -->
<div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar(false)"></div>
<div class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <span>📦 保存済み案件 (RED)</span>
    <button class="sidebar-close" onclick="toggleSidebar(false)">✕</button>
  </div>
  <div id="savedList" class="saved-list"></div>
</div>

<!-- ─── メインエリア ─── -->
<div class="main-area">
  <div class="header">
    <button class="hamburger" onclick="toggleSidebar(true)" aria-label="メニュー">☰</button>
    <h1>⚽ サッカーYT v2 Pro <span style="color:var(--c);">RED</span></h1>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
      <button class="btn btn-sm" id="v25AutoBtn" onclick="runV25Autopilot()" title="V2.5: V2 data + V3 proposal/images + V2 editing" style="background:#f59e0b;color:#111827;">V2.5 AUTO</button>
      <span id="v25AutoStatus" style="font-size:11px;color:#fcd34d;"></span>
      <span class="header-sub">Local Launcher - port ${PORT}</span>
    </div>
  </div>
  <div class="steps">
    <div class="step-nav active" id="nav1"  onclick="goStep(1)">1. 案件選択</div>
    <div class="step-nav"        id="nav2"  onclick="goStep(2)">2. SI情報取得 + 画像選定</div>
    <div class="step-nav"        id="nav3"  onclick="goStep(3)">3. 構成提案</div>
    <div class="step-nav"        id="nav4"  onclick="goStep(4)">4. シナリオ編集</div>
    <div class="step-nav"        id="nav5"  onclick="goStep(5)">5. サムネ生成</div>
    <div class="step-nav"        id="nav6"  onclick="goStep(6)">6. 動画投稿</div>
    <div class="step-nav"        id="nav35" onclick="goStep(35)" style="display:none;font-size:9px;opacity:.4;">[旧3.5(裏)]</div>
  </div>
  <div class="content-scroll">
    <!-- 各 Step の UI（routes/*.js から注入） -->
    ${s1UI()}
    ${s2UI()}
    ${s3UI()}
    ${s35UI()}
    ${s4UI()}
    ${s5UI()}
    ${s6UI()}
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
/* runJob / registerJobResumer / resumeStoredJobs は <body> 直下の早期ブートストラップで定義済 */

/* ── ステップナビ ── */
window.goStep = function(n) {
  [1, 2, 3, 35, 4, 5, 6].forEach(i => {
    const content = document.getElementById('step' + i);
    const nav     = document.getElementById('nav' + i);
    if (content) content.style.display = (i === n) ? 'block'  : 'none';
    if (nav)     nav.className         = 'step-nav' + (i === n ? ' active' : '');
  });
  /* 各 Step の初期化関数を呼び出す */
  const fn = window['step' + n + 'Init'];
  if (typeof fn === 'function') fn();
};

/* ── ハンバーガー: サイドバー開閉（モバイル）── */
window.toggleSidebar = function(open) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!sidebar || !overlay) return;
  if (open === undefined) open = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  overlay.classList.toggle('show', open);
};

/* ── サイドバー描画 ── */
window.renderSidebar = function() {
  document.getElementById('savedList').innerHTML = window.APP.saved.length
    ? window.APP.saved.map((item, i) =>
        '<div class="lead-item' + (window.APP.selected?.id === item.id ? ' active' : '') + '"'
        + ' style="display:flex;align-items:center;gap:6px;"'
        + ' onclick="selectLead(' + i + ')">'
        + '<div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;">'
        + _shEsc(item.title || '(タイトル不明)')
        + '</div>'
        + '<span class="lead-del" title="削除"'
        + ' style="flex-shrink:0;color:#7a8aaa;cursor:pointer;padding:2px 6px;font-size:14px;line-height:1;"'
        + ' onclick="event.stopPropagation();deleteSavedProject(' + i + ')">✕</span>'
        + '</div>'
      ).join('')
    : '<div style="padding:10px;font-size:11px;color:#3a4a6a;">保存された案件はありません</div>';
};

/* ── 保存案件を個別削除 ── */
window.deleteSavedProject = async function(idx) {
  const item = window.APP.saved[idx];
  if (!item) return;
  if (!confirm('「' + (item.title || '(タイトル不明)') + '」を削除する？')) return;
  try {
    await fetchJson('/api/saved-projects/' + encodeURIComponent(item.id), { method: 'DELETE' });
  } catch (e) {
    alert('削除エラー: ' + (e.message || e));
    return;
  }
  window.APP.saved.splice(idx, 1);
  if (window.APP.selected?.id === item.id) {
    window.APP.selected = null;
    try { localStorage.removeItem('v2_selected_id'); } catch (_) {}
  }
  window.renderSidebar();
};

/* ── 案件選択（サイドバー → Step2 遷移）── */


/* V2.5 AUTO: V2 data acquisition + V3 proposal/images + V2 editing bridge */
window.runV25Autopilot = async function() {
  const post = window.APP && window.APP.selected;
  const status = document.getElementById('v25AutoStatus');
  const btn = document.getElementById('v25AutoBtn');
  if (!post || !post.id) return alert('Select a case first');
  const setStatus = (txt) => { if (status) status.textContent = txt || ''; };
  try {
    if (btn) btn.disabled = true;
    setStatus('starting...');
    const result = await window.runJob({
      startUrl: '/api/v25/autopilot/start',
      statusUrl: '/api/v25/autopilot/status',
      kind: 'v25-autopilot',
      key: 'v25_autopilot:' + post.id,
      intervalMs: 3000,
      timeoutMs: 40 * 60 * 1000,
      body: { postId: post.id, count: 7, sprint: !!window.appSprint, attachImages: true },
      onProgress: (job) => {
        const p = job.progress != null && job.total ? ' ' + job.progress + '/' + job.total : '';
        setStatus((job.step || 'running') + p);
      },
    });
    var pc = result.cost || {};
    setStatus((result.proposals || 0) + '案できた（提案 ¥' + (pc.totalJpy || 0) + ' / ' + (pc.calls || 0) + 'コール）— 企画書を選択');
    var plan = await fetch('/api/v25/plan?postId=' + encodeURIComponent(post.id)).then(function(r){ return r.json(); }).catch(function(){ return null; });
    window.showV25PlanPanel(plan, post, []);
  } catch (e) {
    console.error('[V2.5 AUTO]', e);
    setStatus('failed');
    alert('V2.5 AUTO failed: ' + (e.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.registerJobResumer && window.registerJobResumer('v25-autopilot', async ({ key, meta }) => {
  const status = document.getElementById('v25AutoStatus');
  if (status) status.textContent = 'V2.5 resuming...';
  const result = await window.runJob({ startUrl: null, statusUrl: meta.statusUrl, kind: 'v25-autopilot', key });
  window.APP.modules = result.modules || [];
  if (window.APP.s3) window.APP.s3.modules = window.APP.modules;
  if (status) status.textContent = 'done: ' + (result.moduleCount || 0) + ' slides';
});

/* V2.5: 企画書 A/B/C 選択＋微修正パネル (Fix#3)
   - 注: この関数は buildPage() のテンプレートリテラル内。 バッククォート/＄{} 禁止。
     文字列連結のみ。 改行リテラルは '\\n' (ブラウザに '\n' で届く)。 */
window.showV25PlanPanel = function(plan, post, defaultModules) {
  var tp = (plan && plan.aiPlan && plan.aiPlan.themeProposal) || {};
  var cands = tp.candidates || [];
  var defaultIndex = (tp.selected | 0) || 0;
  function gotoStep3(mods) {
    window.APP.modules = mods || [];
    if (window.APP.s3) window.APP.s3.modules = window.APP.modules;
    window.goStep(3);
    if (typeof window.step3Init === 'function') window.step3Init();
  }
  if (!cands.length) { gotoStep3(defaultModules); return; }

  var selected = defaultIndex;
  var edited = false;
  var LAB = ['A', 'B', 'C', 'D', 'E'];
  var LEN = { short: '短尺', standard: '標準', long: '長尺' };
  var statusEl = document.getElementById('v25AutoStatus');
  function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function outlineToText(o) {
    return (o || []).map(function(s){
      return (s.slideType || 'insight') + ' | ' + (s.headline || '') + (s.point ? ' | ' + s.point : '');
    }).join('\\n');
  }
  function textToOutline(t) {
    return String(t || '').split('\\n').map(function(line){
      var parts = line.split('|').map(function(x){ return x.trim(); });
      if (!parts[0] && !parts[1]) return null;
      return { slideType: parts[0] || 'insight', headline: parts[1] || '', point: parts[2] || '' };
    }).filter(Boolean);
  }

  var overlay = document.createElement('div');
  overlay.id = 'v25PlanOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.74);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px;';
  var box = document.createElement('div');
  box.style.cssText = 'background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:12px;max-width:1080px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,0.6);';
  overlay.appendChild(box);
  function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

  function render() {
    var c = cands[selected] || {};
    var html = '';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
    html += '<div style="font-size:16px;font-weight:700;">企画書を選んで微修正 — V2.5</div>';
    html += '<button id="v25pClose" style="background:#334155;color:#e5e7eb;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;">✕ 閉じる</button>';
    html += '</div>';
    html += '<div style="font-size:11px;color:#94a3b8;margin-bottom:12px;">A=Sonnet / B=DeepSeek V4 / C=DeepSeek Chat の3案。 選択した企画書を seed に V2 が脚本構成を作る。</div>';
    // cards
    html += '<div style="display:flex;gap:10px;margin-bottom:16px;">';
    for (var i = 0; i < cands.length; i++) {
      var cc = cands[i] || {};
      var on = (i === selected);
      var border = on ? '#f59e0b' : '#334155';
      var bg = on ? '#1f2937' : '#111827';
      html += '<div class="v25pCard" data-idx="' + i + '" style="flex:1;cursor:pointer;border:2px solid ' + border + ';background:' + bg + ';border-radius:10px;padding:12px;">';
      html += '<div style="font-weight:700;color:#fcd34d;margin-bottom:4px;">案' + LAB[i] + ' · ' + esc(LEN[cc.videoLengthType] || cc.videoLengthType || '') + ' · ' + esc(cc.recommendedSlideCount || (cc.slideOutline ? cc.slideOutline.length : '?')) + '枚</div>';
      html += '<div style="font-size:12px;color:#e5e7eb;margin-bottom:4px;min-height:32px;">' + esc((cc.hookQuestion || '').slice(0, 70)) + '</div>';
      html += '<div style="font-size:11px;color:#94a3b8;">' + esc((cc.angle || '').slice(0, 50)) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    // editor
    html += '<div style="border-top:1px solid #334155;padding-top:14px;">';
    html += '<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">▼ 案' + LAB[selected] + ' の微修正（編集すると V2 がこの内容で構成し直す）</div>';
    html += '<label style="font-size:11px;color:#94a3b8;">フック（hook）</label>';
    html += '<input id="v25f_hook" style="width:100%;margin:2px 0 8px;padding:6px;background:#111827;border:1px solid #334155;border-radius:6px;color:#e5e7eb;" value="' + esc(c.hookQuestion) + '">';
    html += '<label style="font-size:11px;color:#94a3b8;">切り口（angle）</label>';
    html += '<input id="v25f_angle" style="width:100%;margin:2px 0 8px;padding:6px;background:#111827;border:1px solid #334155;border-radius:6px;color:#e5e7eb;" value="' + esc(c.angle) + '">';
    html += '<label style="font-size:11px;color:#94a3b8;">結論（answer）</label>';
    html += '<textarea id="v25f_answer" rows="2" style="width:100%;margin:2px 0 8px;padding:6px;background:#111827;border:1px solid #334155;border-radius:6px;color:#e5e7eb;">' + esc(c.answer) + '</textarea>';
    html += '<label style="font-size:11px;color:#94a3b8;">スライド構成（1行=1枚 / 形式: slideType | 見出し | 補足）</label>';
    html += '<textarea id="v25f_outline" rows="8" style="width:100%;margin:2px 0 8px;padding:6px;background:#111827;border:1px solid #334155;border-radius:6px;color:#e5e7eb;font-family:monospace;font-size:12px;">' + esc(outlineToText(c.slideOutline)) + '</textarea>';
    html += '</div>';
    // footer
    html += '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">';
    html += '<button id="v25pCancel" style="background:#334155;color:#e5e7eb;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;">キャンセル</button>';
    html += '<button id="v25pGo" style="background:#f59e0b;color:#111827;border:none;border-radius:6px;padding:8px 16px;font-weight:700;cursor:pointer;">▶ この企画書で脚本構成</button>';
    html += '</div>';
    box.innerHTML = html;

    // wire
    var cardEls = box.querySelectorAll('.v25pCard');
    for (var k = 0; k < cardEls.length; k++) {
      cardEls[k].addEventListener('click', function(ev) {
        var idx = parseInt(ev.currentTarget.getAttribute('data-idx'), 10);
        if (idx === selected) return;
        // 既存の編集内容を退避してから切替（取りこぼし防止）
        captureEdits();
        selected = idx;
        render();
      });
    }
    ['v25f_hook', 'v25f_angle', 'v25f_answer', 'v25f_outline'].forEach(function(id) {
      var el = box.querySelector('#' + id);
      if (el) el.addEventListener('input', function() { edited = true; });
    });
    box.querySelector('#v25pClose').addEventListener('click', close);
    box.querySelector('#v25pCancel').addEventListener('click', close);
    box.querySelector('#v25pGo').addEventListener('click', confirmGo);
  }

  function val(id) { var el = box.querySelector('#' + id); return el ? el.value : ''; }
  function captureEdits() {
    var c = cands[selected];
    if (!c) return;
    c.hookQuestion = val('v25f_hook');
    c.angle = val('v25f_angle');
    c.answer = val('v25f_answer');
    c.slideOutline = textToOutline(val('v25f_outline'));
  }

  async function confirmGo() {
    captureEdits();
    var editedCandidate = {
      hookQuestion: val('v25f_hook'),
      angle: val('v25f_angle'),
      answer: val('v25f_answer'),
      slideOutline: textToOutline(val('v25f_outline')),
    };
    var needRebuild = edited || (selected !== defaultIndex);
    // 案A 無編集ならば autopilot が既に作った modules を流用（再生成コスト回避）
    if (!needRebuild && defaultModules && defaultModules.length) {
      close();
      gotoStep3(defaultModules);
      return;
    }
    close();
    setStatus('構成生成中... 案' + LAB[selected]);
    try {
      var jobRes = await window.runJob({
        startUrl: '/api/v25/structure',
        statusUrl: '/api/v25/structure/status',
        kind: 'v25-structure',
        key: 'v25_structure:' + post.id,
        intervalMs: 3000,
        timeoutMs: 20 * 60 * 1000,
        body: { postId: post.id, selectedIndex: selected, editedCandidate: editedCandidate, sprint: !!window.appSprint, attachImages: true },
        onProgress: function(job) { setStatus((job.step || 'running')); },
      });
      var sc = jobRes.cost || {};
      setStatus('done: ' + (jobRes.moduleCount || 0) + ' slides (案' + LAB[selected] + ' / 構成 ¥' + (sc.totalJpy || 0) + ')');
      gotoStep3(jobRes.modules || []);
    } catch (e) {
      console.error('[V2.5 structure]', e);
      setStatus('structure failed');
      alert('脚本構成に失敗: ' + (e.message || e));
    }
  }

  render();
  document.body.appendChild(overlay);
};

window.selectLead = function(idx) {
  const item = window.APP.saved[idx];
  if (!item) return;
  window.APP.selected  = item;
  window.APP.keywords  = [];
  window.APP.siData    = {};
  window.APP.modules   = [];
  window.APP.activeTab = 0;
  /* ブラウザリロードでも選択を維持するため localStorage に保存 */
  try { localStorage.setItem('v2_selected_id', item.id || ''); } catch (_) {}
  window.renderSidebar();
  window.goStep(2);
  window.toggleSidebar(false);  // モバイルでは選択後にサイドバー閉じる
};

/* ── localStorage から選択を復元（DOMContentLoaded で呼ぶ）── */
window._restoreSelectedFromStorage = function() {
  let id = '';
  try { id = localStorage.getItem('v2_selected_id') || ''; } catch (_) {}
  if (!id) return;
  const found = (window.APP.saved || []).find(p => p.id === id);
  if (found) {
    window.APP.selected = found;
  }
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
  /* localStorage から前回の選択を復元（リロード対策）*/
  window._restoreSelectedFromStorage();
  renderSidebar();
  goStep(1);  /* Step1 を表示 */
  /* 各 Step の IIFE が読込時に registerJobResumer 済 (この時点で揃ってる)
     未完了ジョブを resume → モバイル復帰時に「サーバー側で完了 → 戻ってきたら結果表示」が成立 */
  window.resumeStoredJobs();
});
</script>

${chatUI()}

</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] ⚽ V2 Pro RED @ http://localhost:${PORT}`);
  console.log('  Step1:   案件選択    → routes/step1_routes.js');
  console.log('  Step2:   SI情報取得  → routes/step2_routes.js');
  console.log('  Step3:   構成提案    → routes/step3_routes.js');
  console.log('  Step3.5: 画像選定    → routes/step35_routes.js');
  console.log('  Step4:   シナリオ編集 → routes/step4_routes.js');
  console.log('  Step5:   サムネ生成   → routes/step5_routes.js');
  console.log('  Step6:   動画投稿     → routes/step6_routes.js');
  console.log('  Chat:    リサーチミア → routes/chat_routes.js');
  console.log('  Curated:    良質サイト RAG (RSS + 本文取得 / ¥0) → routes/curated_routes.js');
});
