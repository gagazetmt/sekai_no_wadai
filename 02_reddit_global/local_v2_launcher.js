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
const { router: vpRouter }               = require('./routes/viewpoint_routes');

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
app.use('/api', vpRouter);

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

/* ── 視点パレット ── */
.vp-card { display:flex; align-items:flex-start; gap:10px; padding:10px 12px;
           background:#1a2540; border:1px solid #2a3a5a; border-radius:8px;
           margin-bottom:6px; cursor:pointer; transition:border-color .15s; }
.vp-card:hover { border-color:#4a6090; }
.vp-card.vp-fixed { opacity:.8; cursor:default; }
.vp-card input[type=checkbox] { margin-top:3px; flex-shrink:0; cursor:pointer; }
.vp-card-body { flex:1; min-width:0; }
.vp-card-title { font-size:13px; font-weight:600; color:#e2e8f0; margin-bottom:2px; }
.vp-card-preview { font-size:11px; color:#64748b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vp-card-script { font-size:11px; color:#94a3b8; margin-top:3px; }
.vp-type-badge { font-size:9px; font-weight:bold; padding:2px 6px; border-radius:4px;
                 white-space:nowrap; flex-shrink:0; margin-top:3px; }
.vp-t-opening,.vp-t-ending   { background:#ff4d4d22; color:#ff4d4d; border:1px solid #ff4d4d44; }
.vp-t-stats                   { background:#3b82f622; color:#60a5fa; border:1px solid #3b82f644; }
.vp-t-profile                 { background:#8b5cf622; color:#a78bfa; border:1px solid #8b5cf644; }
.vp-t-history                 { background:#f59e0b22; color:#fbbf24; border:1px solid #f59e0b44; }
.vp-t-timeline                { background:#06b6d422; color:#22d3ee; border:1px solid #06b6d444; }
.vp-t-insight                 { background:#10b98122; color:#34d399; border:1px solid #10b98144; }
.vp-t-comparison              { background:#ec489922; color:#f472b6; border:1px solid #ec489944; }
.vp-t-reaction                { background:#f9731622; color:#fb923c; border:1px solid #f9731644; }
.vp-t-ranking                 { background:#eab30822; color:#facc15; border:1px solid #eab30844; }
.vp-t-matchcard,.vp-t-picture { background:#64748b22; color:#94a3b8; border:1px solid #64748b44; }
.vp-confidence { font-size:10px; font-weight:bold; flex-shrink:0; margin-top:3px; }
.vp-conf-high   { color:#22c55e; }
.vp-conf-medium { color:#f59e0b; }
.vp-conf-low    { color:#ef4444; }
.vp-palette-footer { display:flex; align-items:center; gap:12px; padding:12px 0; border-top:1px solid #2a3a5a; margin-top:8px; }
.vp-count-label { font-size:12px; color:#64748b; }

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
    <span class="header-sub">Local Launcher - port ${PORT}</span>
  </div>
  <div class="steps">
    <div class="step-nav active" id="nav1"  onclick="goStep(1)">1. 案件選択</div>
    <div class="step-nav"        id="nav2"  onclick="goStep(2)">2. データ取得</div>
    <div class="step-nav"        id="nav25" onclick="goStep(25)">3. 視点パレット</div>
    <div class="step-nav"        id="nav3"  onclick="goStep(3)" style="font-size:10px;opacity:.5;">[旧構成]</div>
    <div class="step-nav"        id="nav4"  onclick="goStep(4)">5. 脚本編集</div>
    <div class="step-nav"        id="nav5"  onclick="goStep(5)">6. サムネ生成</div>
    <div class="step-nav"        id="nav6"  onclick="goStep(6)">7. 動画投稿</div>
    <div class="step-nav"        id="nav35" onclick="goStep(35)" style="display:none;font-size:9px;opacity:.4;">[旧3.5(裏)]</div>
  </div>
  <div class="content-scroll">
    <!-- 各 Step の UI（routes/*.js から注入） -->
    ${s1UI()}
    ${s2UI()}
    <div id="step25" class="step-container" style="display:none">
<div class="panel" style="padding:16px 18px;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
    <button id="vpGenBtn" onclick="window.generateViewpoints()">📌 視点カードを生成</button>
    <button class="secondary" id="vpRegenBtn" onclick="window.generateViewpoints()" style="display:none;font-size:11px;">再生成</button>
    <span id="vpStatus" style="font-size:11px;color:#94a3b8;"></span>
  </div>
  <div id="vpCards" style="color:#64748b;font-size:12px;padding:24px;text-align:center;">
    案件を選択して「視点カードを生成」を押してください
  </div>
  <div class="vp-palette-footer" id="vpFooter" style="display:none;">
    <span class="vp-count-label" id="vpCountLabel">0枚選択</span>
    <button onclick="window.generateFromViewpoints()">この視点で脚本生成 →</button>
  </div>
</div>
</div>
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
  [1, 2, 25, 3, 35, 4, 5, 6].forEach(i => {
    const content = document.getElementById('step' + i);
    const nav     = document.getElementById('nav' + i);
    if (content) content.style.display = (i === n) ? 'block'  : 'none';
    if (nav)     nav.className         = 'step-nav' + (i === n ? ' active' : '');
  });
  /* 各 Step の初期化関数を呼び出す */
  const fn = window['step' + n + 'Init'];
  if (typeof fn === 'function') fn();
};

/* ════════════════════════════════════════
   📌 視点パレット（step25）
   ════════════════════════════════════════ */
window._vpState = { cards: [], generating: false };

window._vpEsc = function(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

window._vpIsFixed = function(slideType) {
  return slideType === 'opening' || slideType === 'ending';
};

window._vpTypeCls = function(slideType) {
  var map = {
    opening:'vp-t-opening', ending:'vp-t-ending', stats:'vp-t-stats',
    profile:'vp-t-profile', history:'vp-t-history', timeline:'vp-t-timeline',
    insight:'vp-t-insight', comparison:'vp-t-comparison', reaction:'vp-t-reaction',
    ranking:'vp-t-ranking', matchcard:'vp-t-matchcard', picture:'vp-t-picture'
  };
  return map[slideType] || 'vp-t-matchcard';
};

window._vpRenderCards = function(cards) {
  if (!cards || !cards.length) return '<div class="empty">カードなし</div>';
  var html = '';
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    var fixed = window._vpIsFixed(card.slideType);
    var conf = card.confidence || 'medium';
    var dot = conf === 'high' ? '●' : conf === 'medium' ? '◐' : '○';
    var confCls = 'vp-confidence vp-conf-' + conf;
    var typeCls = window._vpTypeCls(card.slideType);
    html += '<div class="vp-card' + (fixed ? ' vp-fixed' : '') + '" onclick="window._vpToggle(' + i + ',event)">';
    html += '<input type="checkbox"' + (fixed ? ' checked disabled' : ' data-vp-idx="' + i + '"') + '>';
    html += '<div class="vp-card-body">';
    html += '<div class="vp-card-title">' + window._vpEsc(card.title) + '</div>';
    if (card.dataPreview) html += '<div class="vp-card-preview">' + window._vpEsc(card.dataPreview) + '</div>';
    if (card.scriptDir)   html += '<div class="vp-card-script">' + window._vpEsc(card.scriptDir) + '</div>';
    html += '</div>';
    html += '<span class="vp-type-badge ' + typeCls + '">' + window._vpEsc(card.slideType) + '</span>';
    html += '<span class="' + confCls + '">' + dot + '</span>';
    html += '</div>';
  }
  return html;
};

window._vpUpdateFooter = function() {
  var cards = window._vpState.cards;
  var count = 0;
  for (var i = 0; i < cards.length; i++) {
    if (window._vpIsFixed(cards[i].slideType)) { count++; continue; }
    var cb = document.querySelector('[data-vp-idx="' + i + '"]');
    if (cb && cb.checked) count++;
  }
  var lbl = document.getElementById('vpCountLabel');
  if (lbl) lbl.textContent = count + '枚選択中';
  var footer = document.getElementById('vpFooter');
  if (footer) footer.style.display = count >= 3 ? '' : 'none';
};

window._vpToggle = function(idx, evt) {
  var card = (window._vpState.cards || [])[idx];
  if (!card || window._vpIsFixed(card.slideType)) return;
  var cb = document.querySelector('[data-vp-idx="' + idx + '"]');
  if (!cb) return;
  if (evt && evt.target !== cb) cb.checked = !cb.checked;
  window._vpUpdateFooter();
};

window.step25Init = function() {
  /* 案件が変わったら前回カードをクリア */
  var postId = window.APP && window.APP.selected && window.APP.selected.id;
  if (!postId) {
    var el = document.getElementById('vpCards');
    if (el) el.innerHTML = '<div style="color:#64748b;padding:24px;text-align:center;">先に案件を選択してください</div>';
    return;
  }
  /* 生成済みカードがあれば再描画だけ */
  if (window._vpState.cards && window._vpState.cards.length && window._vpState.postId === postId) {
    var el2 = document.getElementById('vpCards');
    if (el2) el2.innerHTML = window._vpRenderCards(window._vpState.cards);
    window._vpUpdateFooter();
    var rb = document.getElementById('vpRegenBtn');
    if (rb) rb.style.display = '';
  }
};

window.generateViewpoints = function() {
  var postId = window.APP && window.APP.selected && window.APP.selected.id;
  if (!postId) { alert('先に案件を選択してください'); return; }
  if (window._vpState.generating) return;
  window._vpState.generating = true;
  window._vpState.postId = postId;

  var btn    = document.getElementById('vpGenBtn');
  var regen  = document.getElementById('vpRegenBtn');
  var status = document.getElementById('vpStatus');
  var cardsEl = document.getElementById('vpCards');
  var footer = document.getElementById('vpFooter');
  if (btn)    btn.disabled = true;
  if (regen)  regen.style.display = 'none';
  if (status) status.textContent = '生成中...';
  if (cardsEl) cardsEl.innerHTML = '<div style="color:#64748b;padding:20px;text-align:center;">視点カードを生成しています（20〜40秒）...</div>';
  if (footer) footer.style.display = 'none';

  window.fetchJson('/api/v3/generate-viewpoints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId: postId }),
  }).then(function(r1) {
    if (!r1.ok || !r1.jobId) throw new Error(r1.error || 'ジョブ起動失敗');
    var tick = 0;
    function poll() {
      setTimeout(function() {
        window.fetchJson('/api/v3/viewpoints-status?jobId=' + r1.jobId).then(function(r2) {
          if (r2.status === 'error') throw new Error(r2.error || '生成失敗');
          if (r2.status === 'done') {
            window._vpState.cards = r2.cards || [];
            window._vpState.generating = false;
            if (cardsEl) cardsEl.innerHTML = window._vpRenderCards(window._vpState.cards);
            if (status)  status.textContent = window._vpState.cards.length + '枚生成完了';
            if (btn)     btn.disabled = false;
            if (regen)   regen.style.display = '';
            window._vpUpdateFooter();
            return;
          }
          tick++;
          if (tick > 60) { window._vpState.generating = false; throw new Error('タイムアウト'); }
          if (status) status.textContent = '生成中... ' + (tick * 3) + 's';
          poll();
        }).catch(function(e2) {
          window._vpState.generating = false;
          if (status)  status.textContent = 'エラー: ' + (e2.message || e2);
          if (cardsEl) cardsEl.innerHTML = '<div style="color:#ef4444;padding:20px;">' + window._vpEsc(e2.message || String(e2)) + '</div>';
          if (btn) btn.disabled = false;
        });
      }, 3000);
    }
    poll();
  }).catch(function(e) {
    window._vpState.generating = false;
    if (status)  status.textContent = 'エラー: ' + (e.message || e);
    if (cardsEl) cardsEl.innerHTML = '<div style="color:#ef4444;padding:20px;">' + window._vpEsc(e.message || String(e)) + '</div>';
    if (btn) btn.disabled = false;
  });
};

window.generateFromViewpoints = function() {
  var cards = window._vpState.cards || [];
  if (!cards.length) { alert('先に視点カードを生成してください'); return; }

  var selected = [];
  for (var i = 0; i < cards.length; i++) {
    if (window._vpIsFixed(cards[i].slideType)) { selected.push(cards[i]); continue; }
    var cb = document.querySelector('[data-vp-idx="' + i + '"]');
    if (cb && cb.checked) selected.push(cards[i]);
  }
  if (selected.length < 3) { alert('3枚以上選択してください'); return; }

  var modules = [];
  for (var j = 0; j < selected.length; j++) {
    var c = selected[j];
    modules.push({ type: c.slideType, mainKey: c.mainKey, secondary: c.secondary || null,
                   scriptDir: c.scriptDir || '', recipeKey: c.recipeKey || null });
  }

  var postId = window.APP && window.APP.selected && window.APP.selected.id;
  var post   = window.APP && window.APP.selected;
  if (!postId) { alert('案件が未選択です'); return; }

  var status = document.getElementById('vpStatus');
  var footer = document.getElementById('vpFooter');
  if (status) status.textContent = '脚本生成を開始します...';
  if (footer) footer.style.display = 'none';

  /* モジュールを保存してから generate-scenario を起動 */
  window.fetchJson('/api/save-modules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId: postId, modules: modules }),
  }).catch(function() {}).then(function() {
    return window.fetchJson('/api/v3/generate-scenario', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: postId, modules: modules, post: post }),
    });
  }).then(function(r) {
    if (!r.ok || !r.jobId) throw new Error(r.error || '脚本生成ジョブ起動失敗');
    var jobId = r.jobId;
    if (status) status.textContent = '脚本生成中... (jobId:' + jobId + ')';
    /* Step4 に遷移してポーリング開始 */
    window.APP.modules = modules;
    if (window.APP.s3) window.APP.s3.modules = modules;
    window.goStep(4);
    if (typeof window.step4Init === 'function') window.step4Init();
    /* step4 に専用ポーリング関数があれば渡す、なければ内部ポーリング */
    if (typeof window.startScenarioPolling === 'function') {
      window.startScenarioPolling(jobId);
      return;
    }
    /* フォールバック: ポーリングしてモジュールを反映 */
    var tick2 = 0;
    function pollScenario() {
      setTimeout(function() {
        window.fetchJson('/api/v3/scenario-status?jobId=' + jobId).then(function(j) {
          if (j.status === 'error') { alert('脚本生成失敗: ' + (j.error || '')); return; }
          if (j.status === 'done' && j.modules && j.modules.length) {
            window.APP.modules = j.modules;
            if (window.APP.s3) window.APP.s3.modules = j.modules;
            window.fetchJson('/api/save-modules', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ postId: postId, modules: j.modules }),
            }).catch(function() {});
            if (typeof window.step4Init === 'function') window.step4Init();
            return;
          }
          tick2++;
          if (tick2 < 80) pollScenario();
        }).catch(function() { tick2++; if (tick2 < 80) pollScenario(); });
      }, 3000);
    }
    pollScenario();
  }).catch(function(e) {
    if (status) status.textContent = 'エラー: ' + (e.message || e);
    alert('エラー: ' + (e.message || e));
    if (footer) footer.style.display = '';
  });
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
    setStatus('');
    var plan = await fetch('/api/v25/plan?postId=' + encodeURIComponent(post.id)).then(function(r){ return r.json(); }).catch(function(){ return null; });
    window.goStep(25);
    window.renderV25Proposals(plan, post);
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
/* ── Step25: 企画提案タブ ─────────────────────────────────── */
window.step25Init = function() {
  var post = window.APP && window.APP.selected;
  var area = document.getElementById('v25ProposalArea');
  if (!area) return;
  if (!post || !post.id) {
    area.innerHTML = '<div style="color:#64748b;font-size:12px;padding:24px;text-align:center;">Step1で案件を選択してください</div>';
    return;
  }
  area.innerHTML = '<div style="color:#94a3b8;font-size:12px;padding:16px;text-align:center;">読込中...</div>';
  fetch('/api/v25/plan?postId=' + encodeURIComponent(post.id))
    .then(function(r){ return r.json(); })
    .then(function(plan) {
      var cands = plan && plan.aiPlan && plan.aiPlan.themeProposal && plan.aiPlan.themeProposal.candidates;
      if (cands && cands.length) { window.renderV25Proposals(plan, post); }
      else { area.innerHTML = '<div style="color:#64748b;font-size:12px;padding:24px;text-align:center;">企画提案がまだありません。▶ V2.5 AUTO実行ボタンを押してください</div>'; }
    })
    .catch(function() {
      area.innerHTML = '<div style="color:#64748b;font-size:12px;padding:24px;text-align:center;">企画提案がまだありません</div>';
    });
};

window.runV25FromTab = async function() {
  var post = window.APP && window.APP.selected;
  if (!post || !post.id) { alert('Step1で案件を選択してください'); return; }
  var statusEl = document.getElementById('v25TabStatus');
  var btn = document.getElementById('v25RunBtn');
  function setStatus(t) { if(statusEl) statusEl.textContent = t||''; }
  if (btn) btn.disabled = true;
  try {
    setStatus('実行中...');
    var result = await window.runJob({
      startUrl: '/api/v25/autopilot/start',
      statusUrl: '/api/v25/autopilot/status',
      kind: 'v25-autopilot',
      key: 'v25_autopilot:' + post.id,
      intervalMs: 3000,
      timeoutMs: 40 * 60 * 1000,
      body: { postId: post.id, count: 7, sprint: !!window.appSprint, attachImages: true },
      onProgress: function(job) {
        var p = job.progress != null && job.total ? ' '+job.progress+'/'+job.total : '';
        setStatus((job.step||'running')+p);
      },
    });
    var pc = result && result.cost || {};
    setStatus((result&&result.proposals||0)+'案 ¥'+(pc.totalJpy||0));
    var plan = await fetch('/api/v25/plan?postId=' + encodeURIComponent(post.id)).then(function(r){ return r.json(); }).catch(function(){ return null; });
    window.renderV25Proposals(plan, post);
  } catch(e) {
    console.error('[v25 tab]', e);
    setStatus('失敗: '+(e.message||e));
    alert('V2.5 AUTO失敗: '+(e.message||e));
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.renderV25Proposals = function(plan, post) {
  var area = document.getElementById('v25ProposalArea');
  if (!area) return;
  var tp = (plan && plan.aiPlan && plan.aiPlan.themeProposal) || {};
  var cands = tp.candidates || [];
  if (!cands.length) { area.innerHTML = '<div style="color:#64748b;padding:20px;text-align:center;">企画提案なし</div>'; return; }
  var selected = tp.selected || 0;
  var LAB = ['A', 'B', 'C', 'D', 'E'];
  var LEN = { short:'短尺', standard:'標準', long:'長尺' };
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function outlineToText(o){ return (o||[]).map(function(s){ return (s.slideType||'insight')+' | '+(s.headline||'')+(s.point?' | '+s.point:''); }).join('\\n'); }
  function textToOutline(t){ return String(t||'').split('\\n').map(function(line){ var p=line.split('|').map(function(x){return x.trim();}); if(!p[0]&&!p[1]) return null; return {slideType:p[0]||'insight',headline:p[1]||'',point:p[2]||''}; }).filter(Boolean); }

  function render() {
    var c = cands[selected] || {};
    var html = '';
    // A/B/C cards
    html += '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">';
    for (var i=0; i<cands.length; i++) {
      var cc = cands[i]||{};
      var on = (i===selected);
      var border = on ? '#f59e0b' : '#334155';
      var bg = on ? '#1f2937' : '#111827';
      html += '<div class="v25pCard" data-idx="'+i+'" style="flex:1;min-width:200px;cursor:pointer;border:2px solid '+border+';background:'+bg+';border-radius:8px;padding:10px;">';
      html += '<div style="font-weight:700;color:#fcd34d;margin-bottom:4px;font-size:12px;">案'+LAB[i]+' · '+(LEN[cc.videoLengthType]||cc.videoLengthType||'')+' · '+(cc.recommendedSlideCount||(cc.slideOutline?cc.slideOutline.length:'?'))+'枚</div>';
      html += '<div style="font-size:12px;color:#e5e7eb;margin-bottom:3px;">'+esc((cc.hookQuestion||'').slice(0,70))+'</div>';
      html += '<div style="font-size:11px;color:#94a3b8;">'+esc((cc.angle||'').slice(0,50))+'</div>';
      html += '</div>';
    }
    html += '</div>';
    // Edit area
    var c2 = cands[selected]||{};
    html += '<div style="border-top:1px solid #334155;padding-top:12px;">';
    html += '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">▼ 案'+LAB[selected]+' 微修正（編集すると V2 がこの内容で構成）</div>';
    html += '<label style="font-size:11px;color:#94a3b8;">フック</label>';
    html += '<input id="v25p_hook" style="width:100%;margin:2px 0 8px;padding:6px;background:#111827;border:1px solid #334155;border-radius:5px;color:#e5e7eb;font-size:12px;" value="'+esc(c2.hookQuestion)+'">';
    html += '<label style="font-size:11px;color:#94a3b8;">切り口</label>';
    html += '<input id="v25p_angle" style="width:100%;margin:2px 0 8px;padding:6px;background:#111827;border:1px solid #334155;border-radius:5px;color:#e5e7eb;font-size:12px;" value="'+esc(c2.angle)+'">';
    html += '<label style="font-size:11px;color:#94a3b8;">結論</label>';
    html += '<textarea id="v25p_answer" rows="2" style="width:100%;margin:2px 0 8px;padding:6px;background:#111827;border:1px solid #334155;border-radius:5px;color:#e5e7eb;font-size:12px;">'+esc(c2.answer)+'</textarea>';
    html += '<label style="font-size:11px;color:#94a3b8;">スライド構成（slideType | 見出し | 補足）</label>';
    html += '<textarea id="v25p_outline" rows="7" style="width:100%;margin:2px 0 8px;padding:6px;background:#111827;border:1px solid #334155;border-radius:5px;color:#e5e7eb;font-size:11px;font-family:monospace;">'+esc(outlineToText(c2.slideOutline))+'</textarea>';
    html += '<div style="border-top:1px solid #1e3a5f;padding-top:10px;margin-top:4px;">';
    html += '<label style="font-size:11px;color:#60a5fa;font-weight:700;">追加エンティティ（比較対象変更等。"名前:role" 形式）</label>';
    html += '<div style="display:flex;gap:6px;margin:4px 0 8px;">';
    html += '<input id="v25p_entity" style="flex:1;padding:5px 8px;background:#111827;border:1px solid #334155;border-radius:5px;color:#e5e7eb;font-size:12px;" placeholder="例: Malo Gusto:player">';
    html += '<button id="v25pFetchBtn" style="background:#1d4ed8;color:#fff;border:none;border-radius:5px;padding:5px 10px;cursor:pointer;font-size:11px;">SIに取得</button>';
    html += '</div>';
    html += '<label style="font-size:11px;color:#94a3b8;">修正指示（構成生成AIへの最優先指示）</label>';
    html += '<textarea id="v25p_note" rows="2" style="width:100%;margin:4px 0 10px;padding:6px;background:#111827;border:1px solid #1e3a5f;border-radius:5px;color:#e5e7eb;font-size:12px;" placeholder="例: 比較スライドはCucurellaではなくMalo Gusto(RSB)と比較すること"></textarea>';
    html += '</div>';
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">';
    html += '<button id="v25pGoBtn" class="btn" style="font-size:13px;font-weight:700;">▶ 脚本構成を生成</button>';
    html += '</div>';
    html += '</div>';
    area.innerHTML = html;

    // wire card selection
    area.querySelectorAll('.v25pCard').forEach(function(el) {
      el.addEventListener('click', function() {
        var idx = parseInt(el.getAttribute('data-idx'),10);
        if (idx === selected) return;
        captureEdits(); selected = idx; render();
      });
    });
    // wire entity fetch
    area.querySelector('#v25pFetchBtn').addEventListener('click', async function() {
      var entityText = (area.querySelector('#v25p_entity')||{}).value||'';
      if (!entityText.trim()) return;
      var items = entityText.trim().split(/\s+/).filter(Boolean).map(function(t){ var p=t.split(':'); return {box:'entity',label:p[0].trim(),role:p[1]?p[1].trim():'player'}; });
      var statusEl = document.getElementById('v25TabStatus');
      if(statusEl) statusEl.textContent = '取得中...';
      try {
        await fetch('/api/v2/fetch-all',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({postId:post.id,items:items})});
        if(statusEl) statusEl.textContent = '取得完了: '+items.map(function(x){return x.label;}).join(', ');
      } catch(e) { if(statusEl) statusEl.textContent = '取得失敗'; }
    });
    // wire generate button
    area.querySelector('#v25pGoBtn').addEventListener('click', generateStructure);
  }

  function val(id){ var el=area.querySelector('#'+id); return el?el.value:''; }
  function captureEdits() {
    var c = cands[selected];
    if(!c) return;
    c.hookQuestion = val('v25p_hook');
    c.angle = val('v25p_angle');
    c.answer = val('v25p_answer');
    c.slideOutline = textToOutline(val('v25p_outline'));
    c.structureNote = val('v25p_note');
  }

  async function generateStructure() {
    captureEdits();
    var editedCandidate = { hookQuestion:val('v25p_hook'), angle:val('v25p_angle'), answer:val('v25p_answer'), slideOutline:textToOutline(val('v25p_outline')), structureNote:val('v25p_note') };
    var statusEl = document.getElementById('v25TabStatus');
    function setStatus(t){ if(statusEl) statusEl.textContent = t||''; }
    setStatus('脚本構成生成中...');
    var btn = area.querySelector('#v25pGoBtn');
    if(btn) btn.disabled = true;
    try {
      var jobRes = await window.runJob({
        startUrl: '/api/v25/structure',
        statusUrl: '/api/v25/structure/status',
        kind: 'v25-structure',
        key: 'v25_structure:' + post.id,
        intervalMs: 3000,
        timeoutMs: 20*60*1000,
        body: { postId:post.id, selectedIndex:selected, editedCandidate:editedCandidate, sprint:!!window.appSprint, attachImages:true },
        onProgress: function(job){ setStatus('構成生成: '+(job.step||'...')); },
      });
      var sc = jobRes && jobRes.cost || {};
      setStatus('構成完了 '+( jobRes&&jobRes.moduleCount||0)+'枚 ¥'+(sc.totalJpy||0));
      window.APP.modules = jobRes && jobRes.modules || [];
      if (window.APP.s3) window.APP.s3.modules = window.APP.modules;
      window.goStep(3);
      if (typeof window.step3Init === 'function') window.step3Init();
    } catch(e) {
      console.error('[v25 structure]', e);
      setStatus('構成生成失敗');
      alert('脚本構成生成に失敗: '+(e.message||e));
      if(btn) btn.disabled = false;
    }
  }

  render();
};

/* 後方互換: overlay版 showV25PlanPanel → step25 にリダイレクト */
window.showV25PlanPanel = function(plan, post, defaultModules) {
  window.goStep(25);
  window.renderV25Proposals(plan, post);
};

/* ── V2.5 ③ 脚本構成確認パネル（後方互換・企画提案タブから呼ばれなくなったが残置）── */
window.showV25StructurePanel = function(modules, post) {
  if (!modules || !modules.length) { window.goStep(3); return; }
  var postId = post && post.id;
  if (!postId) { window.goStep(3); return; }
  var statusEl = document.getElementById('v25AutoStatus');
  function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  var TYPE_CLR = { opening:'#4b5563',ending:'#4b5563',stats:'#1d4ed8',comparison:'#6d28d9',profile:'#047857',history:'#b45309',insight:'#7c3aed',reaction:'#c2410c',matchcard:'#0e7490',ranking:'#b91c1c' };
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.80);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px;';
  var box = document.createElement('div');
  box.style.cssText = 'background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:12px;max-width:900px;width:100%;padding:20px;';
  overlay.appendChild(box);
  function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  function render() {
    var html = '';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
    html += '<div style="font-size:15px;font-weight:700;color:#fcd34d;">③ 脚本構成確認 <span style="font-size:12px;color:#94a3b8;font-weight:400;">— ' + modules.length + 'スライド</span></div>';
    html += '<button id="v25scClose" style="background:#334155;color:#e5e7eb;border:none;border-radius:6px;padding:5px 11px;cursor:pointer;">✕</button>';
    html += '</div>';
    html += '<div style="font-size:11px;color:#64748b;margin-bottom:12px;">scriptDir（脚本の方向性）を確認・修正してから④脚本生成へ。変更なしでそのまま進んでもOK。</div>';
    for (var i = 0; i < modules.length; i++) {
      var m = modules[i];
      var clr = TYPE_CLR[m.type] || '#374151';
      html += '<div style="border:1px solid #1e293b;border-radius:8px;padding:10px;margin-bottom:8px;background:#0a0f1a;">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
      html += '<span style="background:' + clr + ';color:#fff;font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700;white-space:nowrap;">' + esc(m.type) + '</span>';
      html += '<input data-si="' + i + '" data-f="title" style="flex:1;padding:4px 8px;background:#111827;border:1px solid #374151;border-radius:4px;color:#e5e7eb;font-size:13px;font-weight:600;" value="' + esc(m.title || '') + '">';
      html += '</div>';
      html += '<textarea data-si="' + i + '" data-f="scriptDir" rows="2" style="width:100%;padding:6px;background:#111827;border:1px solid #374151;border-radius:4px;color:#94a3b8;font-size:12px;resize:vertical;">' + esc(m.scriptDir || '') + '</textarea>';
      html += '</div>';
    }
    html += '<div style="border-top:1px solid #1e293b;padding-top:10px;margin-top:4px;">';
    html += '<label style="font-size:11px;color:#94a3b8;">追加指示（全スライド共通 / ナレーションのトーン・禁止事項など）</label>';
    html += '<textarea id="v25sc_note" rows="2" style="width:100%;margin:4px 0 10px;padding:6px;background:#111827;border:1px solid #1e3a5f;border-radius:6px;color:#e5e7eb;font-size:12px;" placeholder="例: テンション高め・数字を具体的に・断定は避ける"></textarea>';
    html += '</div>';
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;">';
    html += '<button id="v25scV2" style="background:#334155;color:#e5e7eb;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;">V2で編集</button>';
    html += '<button id="v25scGo" style="background:#f59e0b;color:#111827;border:none;border-radius:6px;padding:8px 20px;font-weight:700;cursor:pointer;">④ 全スライド脚本生成</button>';
    html += '</div>';
    box.innerHTML = html;
    box.querySelector('#v25scClose').addEventListener('click', function(){ close(); window.goStep(3); });
    box.querySelector('#v25scV2').addEventListener('click', function(){ close(); window.APP.modules = modules; if(window.APP.s3) window.APP.s3.modules = modules; window.goStep(3); });
    box.querySelector('#v25scGo').addEventListener('click', generateNarration);
  }
  function collectEdits() {
    var mods = modules.map(function(m){ return Object.assign({}, m); });
    box.querySelectorAll('[data-si]').forEach(function(el){
      var idx = parseInt(el.getAttribute('data-si'),10);
      var f = el.getAttribute('data-f');
      if (mods[idx] != null) mods[idx][f] = el.value;
    });
    return mods;
  }
  async function generateNarration() {
    var edited = collectEdits();
    var note = (box.querySelector('#v25sc_note') || {}).value || '';
    close();
    setStatus('脚本生成中...');
    try {
      await fetch('/api/v25/save-modules', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ postId: postId, modules: edited }) });
      var postData = Object.assign({}, (window.APP && window.APP.selected) || {});
      if (note) postData.customNote = note;
      // generate-scenario のジョブは job.modules がトップレベル (job.result 不在)
      // runJob は job.result を返すため使わず直接ポーリング
      var startR = await fetch('/api/v3/generate-scenario', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: postId, modules: edited, post: postData, sprint: false }),
      });
      var startD = await startR.json();
      if (!startD.jobId) throw new Error('jobId not returned');
      var scJobId = startD.jobId;
      var deadline = Date.now() + 15 * 60 * 1000;
      var narratedModules = null;
      while (true) {
        if (Date.now() > deadline) throw new Error('narration timeout');
        await new Promise(function(resolve){ setTimeout(resolve, 3500); });
        var pollR = await fetch('/api/v3/scenario-status?jobId=' + encodeURIComponent(scJobId));
        if (pollR.status === 404) throw new Error('narration job vanished');
        var job = await pollR.json();
        setStatus('脚本生成: ' + (job.step || '...'));
        if (job.status === 'error') throw new Error(job.error || 'narration error');
        if (job.status === 'done') { narratedModules = job.modules || edited; break; }
      }
      setStatus('脚本生成完了');
      window.showV25NarrationPanel(narratedModules, post);
    } catch(e) {
      console.error('[v25 narration]', e);
      setStatus('脚本生成失敗: ' + (e.message || e));
      alert('脚本生成失敗: ' + (e.message || e));
      window.APP.modules = edited; if(window.APP.s3) window.APP.s3.modules = edited; window.goStep(3);
    }
  }
  render();
  document.body.appendChild(overlay);
};

/* ── V2.5 ⑤ 脚本確認パネル ── */
window.showV25NarrationPanel = function(modules, post) {
  if (!modules || !modules.length) { window.goStep(4); return; }
  var postId = post && post.id;
  var statusEl = document.getElementById('v25AutoStatus');
  function setStatus(t) { if (statusEl) statusEl.textContent = t || ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.80);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px;';
  var box = document.createElement('div');
  box.style.cssText = 'background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:12px;max-width:900px;width:100%;padding:20px;';
  overlay.appendChild(box);
  function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  function render() {
    var totalChr = modules.reduce(function(s,m){ return s + (m.narration||'').length; }, 0);
    var html = '';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
    html += '<div style="font-size:15px;font-weight:700;color:#34d399;">⑤ 脚本確認 <span style="font-size:12px;color:#94a3b8;font-weight:400;">— ' + modules.length + 'スライド / 合計 ' + totalChr + '字</span></div>';
    html += '<button id="v25nrClose" style="background:#334155;color:#e5e7eb;border:none;border-radius:6px;padding:5px 11px;cursor:pointer;">✕</button>';
    html += '</div>';
    html += '<div style="font-size:11px;color:#64748b;margin-bottom:12px;">ナレーションを確認・修正して動画生成へ。</div>';
    for (var i = 0; i < modules.length; i++) {
      var m = modules[i];
      var charN = (m.narration||'').length;
      var warn = charN < 50 ? ' style="color:#f87171;"' : '';
      html += '<div style="border:1px solid #1e293b;border-radius:8px;padding:10px;margin-bottom:8px;background:#0a0f1a;">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">';
      html += '<span style="font-size:10px;color:#94a3b8;background:#1e293b;padding:2px 6px;border-radius:4px;">' + esc(m.type) + '</span>';
      html += '<span style="font-size:13px;font-weight:600;flex:1;">' + esc(m.title||'') + '</span>';
      html += '<span' + warn + ' style="font-size:10px;color:#6b7280;">' + charN + '字</span>';
      html += '</div>';
      html += '<textarea data-ni="' + i + '" rows="3" style="width:100%;padding:6px;background:#111827;border:1px solid #374151;border-radius:4px;color:#e5e7eb;font-size:12px;resize:vertical;">' + esc(m.narration||'') + '</textarea>';
      html += '</div>';
    }
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">';
    html += '<button id="v25nrV2" style="background:#334155;color:#e5e7eb;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;">V2で続けて編集</button>';
    html += '<button id="v25nrGo" style="background:#10b981;color:#111827;border:none;border-radius:6px;padding:8px 20px;font-weight:700;cursor:pointer;">動画生成へ →</button>';
    html += '</div>';
    box.innerHTML = html;
    box.querySelector('#v25nrClose').addEventListener('click', close);
    box.querySelector('#v25nrV2').addEventListener('click', function(){
      var mods = collectFinal();
      close();
      window.APP.modules = mods; if(window.APP.s3) window.APP.s3.modules = mods;
      window.goStep(3);
    });
    box.querySelector('#v25nrGo').addEventListener('click', goVideo);
  }
  function collectFinal() {
    var mods = modules.map(function(m){ return Object.assign({}, m); });
    box.querySelectorAll('textarea[data-ni]').forEach(function(el){
      var idx = parseInt(el.getAttribute('data-ni'),10);
      if (mods[idx]) mods[idx].narration = el.value;
    });
    return mods;
  }
  async function goVideo() {
    var finalMods = collectFinal();
    if (postId) {
      await fetch('/api/v25/save-modules', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ postId: postId, modules: finalMods }) }).catch(function(){});
    }
    close();
    window.APP.modules = finalMods;
    if (window.APP.s3) window.APP.s3.modules = finalMods;
    setStatus('Step4（TTS・動画生成）へ');
    window.goStep(4);
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
