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
  --c:      #e06b58;
  --bg:     #151617;
  --panel:  #1d1f21;
  --surface:#25282b;
  --border: #363b40;
  --text:   #e8e2d8;
  --muted:  #a6adb5;
  --success:#10b981;
  --soft-blue:#7db2ff;
  --soft-green:#6fd39a;
  --shadow: 0 12px 30px rgba(0, 0, 0, .26);
}

/* ── ベースリセット ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text);
       display: flex; height: 100vh; overflow: hidden; }

/* ── サイドバー（コンパクト化）── */
.sidebar { width: 220px; background: #17191b; border-right: 1px solid var(--border);
           display: flex; flex-direction: column; flex-shrink: 0;
           transition: transform .25s ease; }
.sidebar-header { padding: 12px 14px; background: #202326; color: var(--c);
                  font-weight: 900; font-size: 12px; border-bottom: 1px solid var(--border); letter-spacing: 1px;
                  display: flex; justify-content: space-between; align-items: center; }
.sidebar-close { display: none; background: transparent; border: 1px solid #ff4d4d40;
                 color: var(--c); padding: 4px 9px; border-radius: 4px; cursor: pointer;
                 font-size: 14px; font-weight: bold; }
.saved-list { flex: 1; overflow-y: auto; padding: 8px; }
/* ── ハンバーガー（モバイル時のみ表示）── */
.hamburger { display: none; background: transparent; border: 1px solid var(--c);
             color: var(--c); padding: 6px 10px; border-radius: 6px; cursor: pointer;
             font-size: 16px; font-weight: bold; min-height: 36px; }
.sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.55);
                   z-index: 998; }
.lead-item { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
             padding: 8px 10px; margin-bottom: 6px; cursor: pointer; font-size: 11px;
             transition: border-color .15s; line-height: 1.35; word-break: break-all; }
.lead-item:hover { border-color: var(--muted); }
.lead-item.active { border-color: var(--c); border-left: 3px solid var(--c); background: #2a2422; }

/* ── メインエリア ── */
.main-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.header { background: #202326; padding: 13px 22px; border-bottom: 3px solid var(--c);
          display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
.header h1 { font-size: 18px; color: var(--c); font-weight: 900;
             text-shadow: none; }
.header-sub { font-size: 11px; color: var(--muted); }

/* ── ステップナビ ── */
.steps { display: flex; background: #191b1d; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.step-nav { padding: 11px 22px; font-size: 11px; font-weight: bold; color: #8f98a2; cursor: pointer;
             transition: color .15s; user-select: none; }
.step-nav:hover { color: var(--muted); }
.step-nav.active { color: var(--c); background: var(--panel); border-bottom: 2px solid var(--c); }

/* ── コンテンツスクロール ── */
.content-scroll { flex: 1; overflow-y: auto; background: var(--bg); }

/* ── 共通パーツ（各 Step から使用可）── */
.panel { background: var(--panel); border-radius: 10px; padding: 18px;
         margin-bottom: 16px; border: 1px solid var(--border); box-shadow: var(--shadow); }
.step-container { padding: 18px 20px; }

.btn { padding: 8px 16px; border-radius: 7px; cursor: pointer; border: none;
       font-weight: bold; font-size: 12px; transition: opacity .15s; }
.btn:hover { opacity: 0.85; }
.btn-primary { background: var(--c); color: #fff; }
.btn-success { background: var(--success); color: #fff; }
.btn-sm { background: #30343a; color: var(--text); font-size: 11px; padding: 5px 10px; }
button { background: var(--c); color:#fff; border:none; border-radius:7px; padding:8px 13px;
         font-weight:800; font-size:12px; cursor:pointer; }
button.secondary { background:#30343a; color:#d5dce4; border:1px solid #424850; }
button:disabled { opacity:.5; cursor:default; }

.inp { background: var(--surface); color: var(--text); border: 1px solid var(--border);
       padding: 7px 10px; border-radius: 6px; font-size: 12px; outline: none; }
.inp:focus { border-color: var(--c); }
select.inp { cursor: pointer; }

/* ── 案件一覧（Step1）── */
.time-group { margin-bottom: 10px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.time-summary { background: #202326; padding: 9px 14px; cursor: pointer;
                color: var(--soft-blue); font-size: 12px; font-weight: bold; }
.time-summary:hover { background: #282c30; }
.time-content {}
.post-row { padding: 9px 14px; border-bottom: 1px solid #30343a; display: flex;
            align-items: center; gap: 10px; font-size: 13px; cursor: pointer; transition: background .1s; }
.post-row:hover { background: #202326; }
.post-row.selected { background: #2a2422; }
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

/* ── STEP3: 企画ビルダー ── */
.vp-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
.vp-title { font-size:17px; font-weight:800; color:var(--text); }
.vp-sub { font-size:11px; color:var(--muted); margin-top:3px; line-height:1.5; }
.vp-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.vp-status { font-size:11px; color:var(--muted); min-height:16px; }
.vp-builder { display:grid; grid-template-columns:minmax(0,1.05fr) minmax(280px,.95fr); gap:14px; align-items:start; }
.vp-column { min-width:0; }
.vp-column-head { display:flex; align-items:flex-end; justify-content:space-between; gap:10px; margin-bottom:8px; }
.vp-column-title { font-size:13px; font-weight:800; color:var(--text); }
.vp-column-note { font-size:10px; color:var(--muted); }
.vp-list { display:flex; flex-direction:column; gap:8px; }
.vp-card { display:grid; grid-template-columns:32px minmax(0,1fr) auto; gap:10px; padding:12px;
           background:var(--surface); border:1px solid var(--border); border-radius:8px;
           cursor:pointer; transition:border-color .15s, background .15s, opacity .15s, transform .15s; }
.vp-card:hover { border-color:#59616b; background:#2b2f34; transform:translateY(-1px); }
.vp-card.vp-added { opacity:.48; }
.vp-card.vp-fixed { cursor:default; }
.vp-card-icon { width:30px; height:30px; border-radius:8px; display:flex; align-items:center; justify-content:center;
                font-size:13px; font-weight:900; background:#30343a; color:#f0c6bd; border:1px solid #444a52; }
.vp-card-body { flex:1; min-width:0; }
.vp-card-title { font-size:13px; font-weight:800; color:var(--text); margin-bottom:3px; line-height:1.35; }
.vp-card-preview { font-size:11px; color:#aab2bb; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vp-card-script { font-size:11px; color:#c6cdd4; margin-top:4px; line-height:1.45; }
.vp-card-bullets { margin:6px 0 0; padding-left:16px; color:#d7dde3; font-size:11px; line-height:1.45; }
.vp-card-bullets li { margin:1px 0; }
.vp-type-badge { font-size:9px; font-weight:bold; padding:2px 6px; border-radius:4px;
                 white-space:nowrap; flex-shrink:0; margin-top:2px; }
.vp-t-opening,.vp-t-ending   { background:#3a2725; color:#ff9a89; border:1px solid #6e443d; }
.vp-t-stats                   { background:#223047; color:#9fc5ff; border:1px solid #405a84; }
.vp-t-profile                 { background:#312a47; color:#c3b5ff; border:1px solid #5a4d84; }
.vp-t-history                 { background:#3a321f; color:#f0c96d; border:1px solid #6c5a2f; }
.vp-t-timeline                { background:#203a39; color:#80d5cf; border:1px solid #376d68; }
.vp-t-insight                 { background:#20382b; color:#8be3ab; border:1px solid #386b4a; }
.vp-t-comparison              { background:#3a2432; color:#f29ac4; border:1px solid #70445f; }
.vp-t-reaction                { background:#3b2b21; color:#f3b178; border:1px solid #704e35; }
.vp-t-ranking                 { background:#38351f; color:#eadf74; border:1px solid #6b6534; }
.vp-t-matchcard,.vp-t-picture { background:#2a3036; color:#cad2dc; border:1px solid #4a535d; }
.vp-confidence { font-size:10px; font-weight:bold; flex-shrink:0; margin-top:3px; }
.vp-conf-high   { color:#6fd39a; }
.vp-conf-medium { color:#e6b35f; }
.vp-conf-low    { color:#ff8c7a; }
.vp-hook { font-size:9px; font-weight:900; letter-spacing:.2px; padding:2px 5px; border-radius:4px;
           background:#332825; color:#ffb199; border:1px solid #5f4038; white-space:nowrap; }
.vp-subtype { font-size:9px; color:#aab2bb; text-transform:uppercase; }
.vp-add-btn { background:#4078b8; color:#fff; border:none; border-radius:7px; width:30px; height:30px; font-weight:900; cursor:pointer; }
.vp-add-btn:disabled { background:#454a51; cursor:default; }
.vp-card-toggle { display:none; font-size:10px; color:#aab2bb; margin-top:5px; }
.vp-plan-box { background:#202326; border:1px solid var(--border); border-radius:8px; padding:10px; }
.vp-plan-empty { padding:24px 12px; text-align:center; color:#aab2bb; font-size:12px; border:1px dashed #4c535b; border-radius:8px; }
.vp-plan-item { display:grid; grid-template-columns:28px minmax(0,1fr) auto; gap:9px; align-items:start;
                background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:10px; margin-bottom:8px; }
.vp-plan-no { width:24px; height:24px; border-radius:999px; background:#30343a; color:#d5dce4;
              display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; }
.vp-plan-main { min-width:0; }
.vp-plan-title { font-size:12px; font-weight:800; color:var(--text); line-height:1.35; margin-bottom:5px; }
.vp-plan-script { width:100%; min-height:48px; resize:vertical; margin-top:6px; padding:7px 8px;
                  background:#17191b; border:1px solid #424850; border-radius:6px; color:#d7dde3; font-size:11px; line-height:1.45; }
.vp-plan-tools { display:flex; flex-direction:column; gap:5px; }
.vp-icon-btn { width:28px; height:28px; border-radius:7px; padding:0; display:flex; align-items:center;
               justify-content:center; background:#30343a; color:#d5dce4; border:1px solid #424850; }
.vp-icon-btn:disabled { opacity:.35; cursor:default; }
.vp-palette-footer { display:flex; align-items:center; justify-content:space-between; gap:12px;
                     padding:12px 0 0; border-top:1px solid var(--border); margin-top:12px; flex-wrap:wrap; }
.vp-count-label { font-size:12px; color:var(--muted); }

/* ════════════════════════════════════════════════
   📱 タブレット (≤1024px) — 中間ブレイクポイント
   サイドバーをやや狭く、ヘッダは保持
   ════════════════════════════════════════════════ */
@media (max-width: 1024px) {
  .sidebar { width: 180px; }
  .header h1 { font-size: 16px; }
  .step-nav { padding: 10px 14px; }
  .step-container { padding: 14px 16px; }
  .vp-builder { grid-template-columns:1fr; }
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
  .vp-head { gap:10px; }
  .vp-title { font-size:15px; }
  .vp-actions { width:100%; }
  .vp-actions button { flex:1; min-height:42px; }
  .vp-card { padding:12px; }
  .vp-plan-box { padding:8px; }
  .vp-plan-item { grid-template-columns:26px minmax(0,1fr); }
  .vp-plan-tools { grid-column:1 / -1; flex-direction:row; justify-content:flex-end; }
  .vp-icon-btn { width:36px; height:34px; }
  .vp-palette-footer button { width:100%; min-height:44px; }
  .vp-card { grid-template-columns:32px minmax(0,1fr) auto; }
  .vp-card-details { display:none; }
  .vp-card.vp-card-open .vp-card-details { display:block; }
  .vp-card-toggle { display:block; }

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
  <!-- Autopilot パネル（案件選択時に表示） -->
  <div id="apPanel" style="display:none;border-top:1px solid var(--border);padding:10px 8px 8px;">
    <div style="font-size:10px;color:var(--muted);margin-bottom:7px;font-weight:bold;letter-spacing:.3px;">⚡ AUTOPILOT</div>
    <div style="display:grid;gap:5px;">
      <button onclick="runAutopilot('semi')" style="background:#1e3a5f;color:#7dc8ff;border:1px solid #2a4a6f;border-radius:5px;padding:5px 8px;cursor:pointer;font-size:11px;text-align:left;">
        🔷 SemiAuto <span style="color:#5a8ab0;font-size:9px;">→ 企画ピース選択まで</span>
      </button>
      <button onclick="runAutopilot('S')" style="background:#1a3a2a;color:#6fd39a;border:1px solid #2a5a3a;border-radius:5px;padding:5px 8px;cursor:pointer;font-size:11px;text-align:left;">
        🟢 FullAuto(S) <span style="color:#4a8a5a;font-size:9px;">→ 脚本まで / 最小2-3ピース</span>
      </button>
      <button onclick="runAutopilot('M')" style="background:#2a3a1a;color:#b0d060;border:1px solid #3a5a2a;border-radius:5px;padding:5px 8px;cursor:pointer;font-size:11px;text-align:left;">
        🟡 FullAuto(M) <span style="color:#7a9a40;font-size:9px;">→ 脚本まで / 中3-5ピース</span>
      </button>
      <button onclick="runAutopilot('L')" style="background:#3a2a1a;color:#f0b060;border:1px solid #5a4a2a;border-radius:5px;padding:5px 8px;cursor:pointer;font-size:11px;text-align:left;">
        🟠 FullAuto(L) <span style="color:#a07040;font-size:9px;">→ 脚本まで / 長5-8ピース</span>
      </button>
    </div>
    <div id="apStatus" style="margin-top:8px;font-size:10px;color:var(--muted);min-height:16px;word-break:break-all;"></div>
  </div>
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
    <div class="step-nav"        id="nav25" onclick="goStep(25)">3. 企画ビルダー</div>
    <div class="step-nav"        id="nav4"  onclick="goStep(4)">4. 脚本編集</div>
    <div class="step-nav"        id="nav5"  onclick="goStep(5)">5. サムネ生成</div>
    <div class="step-nav"        id="nav6"  onclick="goStep(6)">6. 動画投稿</div>
    <div class="step-nav"        id="nav35" onclick="goStep(35)" style="display:none;font-size:9px;opacity:.4;">[旧3.5(裏)]</div>
  </div>
  <div class="content-scroll">
    <!-- 各 Step の UI（routes/*.js から注入） -->
    ${s1UI()}
    ${s2UI()}
    <div id="step25" class="step-container" style="display:none">
<div class="panel" style="padding:16px 18px;">
  <div class="vp-head">
    <div>
      <div class="vp-title">企画ビルダー</div>
      <div class="vp-sub">AIが出した企画ピースをタップして、相棒の企画書に積んでいく画面です。</div>
    </div>
    <div class="vp-actions">
      <button id="vpGenBtn" onclick="window.generateViewpoints()">企画ピース生成</button>
      <button class="secondary" id="vpAutoBtn" onclick="window.autoBuildViewpointPlan()" style="display:none;font-size:11px;">量産おまかせ</button>
      <button class="secondary" id="vpRegenBtn" onclick="window.generateViewpoints()" style="display:none;font-size:11px;">再生成</button>
    </div>
  </div>
  <div id="vpStatus" class="vp-status"></div>
  <div class="vp-builder">
    <div class="vp-column">
      <div class="vp-column-head">
        <div>
          <div class="vp-column-title">AIの企画ピース</div>
          <div class="vp-column-note">タップで右の企画書に追加</div>
        </div>
      </div>
      <div id="vpCards" class="vp-list" style="color:#64748b;font-size:12px;padding:18px;text-align:center;border:1px dashed #334155;border-radius:8px;">
        案件を選択して「企画ピース生成」を押してください
      </div>
    </div>
    <div class="vp-column">
      <div class="vp-column-head">
        <div>
          <div class="vp-column-title">相棒の企画書</div>
          <div class="vp-column-note">順番変更・指示文編集OK</div>
        </div>
      </div>
      <div id="vpPlan" class="vp-plan-box">
        <div class="vp-plan-empty">企画ピースをタップするとここに追加されます</div>
      </div>
    </div>
  </div>
  <div class="vp-palette-footer" id="vpFooter" style="display:none;">
    <span class="vp-count-label" id="vpCountLabel">0枚の企画</span>
    <button onclick="window.generateFromViewpoints()">この企画書で脚本生成 →</button>
  </div>
</div>
</div>
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
  [1, 2, 25, 35, 4, 5, 6].forEach(i => {
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
   STEP3: 企画ビルダー（企画ピース → 企画書）
   ════════════════════════════════════════ */
window._vpState = { cards: [], plan: [], generating: false, postId: null, openCards: {} };

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

window._vpTypeIcon = function(slideType) {
  var map = {
    opening:'OP', ending:'ED', stats:'#', profile:'ID', history:'YR',
    timeline:'TL', insight:'IN', comparison:'VS', reaction:'RX',
    ranking:'RK', matchcard:'MC', picture:'PX'
  };
  return map[slideType] || 'SL';
};

window._vpClone = function(card) {
  return Object.assign({}, card, { bullets: Array.isArray(card && card.bullets) ? card.bullets.slice(0, 6) : [] });
};

window._vpHasInPlan = function(cardId) {
  return (window._vpState.plan || []).some(function(c) { return c && c.id === cardId; });
};

window._vpBulletHtml = function(card, max) {
  var bs = Array.isArray(card && card.bullets) ? card.bullets.slice(0, max || 6) : [];
  if (!bs.length) return '';
  return '<ul class="vp-card-bullets">' + bs.map(function(b) {
    return '<li>' + window._vpEsc(b) + '</li>';
  }).join('') + '</ul>';
};

window._vpFallbackCard = function(type) {
  if (type === 'opening') {
    return { id:'opening', title:'動画冒頭フック', slideType:'opening', mainKey:'opening',
      secondary:null, recipeKey:null, scriptDir:'タイトルで視聴者を掴む', confidence:'high', bullets:[] };
  }
  return { id:'ending', title:'締め・問いかけ', slideType:'ending', mainKey:'ending',
    secondary:null, recipeKey:null, scriptDir:'視聴者への投げかけと登録誘導', confidence:'high', bullets:[] };
};

window._vpResetPlan = function() {
  var cards = window._vpState.cards || [];
  var opening = cards.find(function(c) { return c.slideType === 'opening'; }) || window._vpFallbackCard('opening');
  var ending  = cards.find(function(c) { return c.slideType === 'ending'; })  || window._vpFallbackCard('ending');
  window._vpState.plan = [window._vpClone(opening), window._vpClone(ending)];
};

window._vpRenderCards = function(cards) {
  var pool = (cards || []).filter(function(c) { return c && !window._vpIsFixed(c.slideType); });
  if (!pool.length) return '<div class="vp-plan-empty">企画ピースなし</div>';
  var html = '';
  for (var i = 0; i < pool.length; i++) {
    var card = pool[i];
    var realIdx = cards.indexOf(card);
    var added = window._vpHasInPlan(card.id);
    var conf = card.confidence || 'medium';
    var dot = conf === 'high' ? '●' : conf === 'medium' ? '◐' : '○';
    var confCls = 'vp-confidence vp-conf-' + conf;
    var typeCls = window._vpTypeCls(card.slideType);
    var hook = Math.max(0, Math.min(100, Number(card.hookScore) || 0));
    var subtype = card.slideType === 'insight' && card.insightSubtype && card.insightSubtype !== 'none' ? card.insightSubtype : '';
    var open = !!(window._vpState.openCards && window._vpState.openCards[card.id]);
    html += '<div class="vp-card' + (added ? ' vp-added' : '') + (open ? ' vp-card-open' : '') + '" onclick="window._vpCardTap(' + realIdx + ',event)">';
    html += '<div class="vp-card-icon ' + typeCls + '">' + window._vpEsc(window._vpTypeIcon(card.slideType)) + '</div>';
    html += '<div class="vp-card-body">';
    html += '<div class="vp-card-title">' + window._vpEsc(card.title) + '</div>';
    html += '<div class="vp-card-toggle">' + (open ? '詳細を閉じる' : '詳細を見る') + '</div>';
    html += '<div class="vp-card-details">';
    if (card.dataPreview) html += '<div class="vp-card-preview">' + window._vpEsc(card.dataPreview) + '</div>';
    if (card.scriptDir)   html += '<div class="vp-card-script">' + window._vpEsc(card.scriptDir) + '</div>';
    if (card.slideType === 'insight') html += window._vpBulletHtml(card, 6);
    html += '</div>';
    html += '</div>';
    html += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">';
    html += '<span class="vp-type-badge ' + typeCls + '">' + window._vpEsc(card.slideType) + '</span>';
    if (hook) html += '<span class="vp-hook">HOOK ' + hook + '</span>';
    if (subtype) html += '<span class="vp-subtype">' + window._vpEsc(subtype) + '</span>';
    html += '<span class="' + confCls + '">' + dot + '</span>';
    html += '<button class="vp-add-btn" title="企画書に追加" onclick="window._vpAddToPlan(' + realIdx + ');event.stopPropagation();" ' + (added ? 'disabled' : '') + '>+</button>';
    html += '</div>';
    html += '</div>';
  }
  return html;
};

window._vpRenderPlan = function() {
  var planEl = document.getElementById('vpPlan');
  if (!planEl) return;
  var plan = window._vpState.plan || [];
  if (!plan.length) {
    planEl.innerHTML = '<div class="vp-plan-empty">企画ピースをタップするとここに追加されます</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < plan.length; i++) {
    var card = plan[i];
    var fixed = window._vpIsFixed(card.slideType);
    var typeCls = window._vpTypeCls(card.slideType);
    var canUp = !fixed && i > 1;
    var canDown = !fixed && i < plan.length - 2;
    html += '<div class="vp-plan-item">';
    html += '<div class="vp-plan-no">' + (i + 1) + '</div>';
    html += '<div class="vp-plan-main">';
    html += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">';
    html += '<span class="vp-card-icon ' + typeCls + '" style="width:24px;height:24px;font-size:10px;">' + window._vpEsc(window._vpTypeIcon(card.slideType)) + '</span>';
    html += '<span class="vp-type-badge ' + typeCls + '">' + window._vpEsc(card.slideType) + '</span>';
    if (card.hookScore) html += '<span class="vp-hook">HOOK ' + Math.max(0, Math.min(100, Number(card.hookScore) || 0)) + '</span>';
    html += '<span class="vp-plan-title">' + window._vpEsc(card.title) + '</span>';
    html += '</div>';
    if (card.slideType === 'insight') html += window._vpBulletHtml(card, 6);
    html += '<textarea class="vp-plan-script" oninput="window._vpEditPlanScript(' + i + ',this.value)">' + window._vpEsc(card.scriptDir || '') + '</textarea>';
    html += '</div>';
    html += '<div class="vp-plan-tools">';
    html += '<button class="vp-icon-btn" title="上へ" onclick="window._vpMovePlan(' + i + ',-1)"' + (canUp ? '' : ' disabled') + '>↑</button>';
    html += '<button class="vp-icon-btn" title="下へ" onclick="window._vpMovePlan(' + i + ',1)"' + (canDown ? '' : ' disabled') + '>↓</button>';
    html += '<button class="vp-icon-btn" title="削除" onclick="window._vpRemovePlan(' + i + ')"' + (fixed ? ' disabled' : '') + '>×</button>';
    html += '</div>';
    html += '</div>';
  }
  planEl.innerHTML = html;
};

window._vpRenderAll = function() {
  var cardsEl = document.getElementById('vpCards');
  if (cardsEl) {
    cardsEl.style.padding = '0';
    cardsEl.style.borderStyle = 'none';
    cardsEl.style.textAlign = 'left';
    cardsEl.innerHTML = window._vpRenderCards(window._vpState.cards || []);
  }
  window._vpRenderPlan();
  window._vpUpdateFooter();
};

window._vpUpdateFooter = function() {
  var plan = window._vpState.plan || [];
  var middleCount = plan.filter(function(c) { return c && !window._vpIsFixed(c.slideType); }).length;
  var lbl = document.getElementById('vpCountLabel');
  if (lbl) lbl.textContent = '企画ピース ' + middleCount + '枚 / 全' + plan.length + '枚';
  var footer = document.getElementById('vpFooter');
  if (footer) footer.style.display = middleCount >= 1 ? '' : 'none';
};

window._vpAddToPlan = function(idx) {
  var card = (window._vpState.cards || [])[idx];
  if (!card || window._vpIsFixed(card.slideType) || window._vpHasInPlan(card.id)) return;
  var plan = window._vpState.plan || [];
  var insertAt = Math.max(0, plan.findIndex(function(c) { return c.slideType === 'ending'; }));
  if (insertAt < 0) insertAt = plan.length;
  plan.splice(insertAt, 0, window._vpClone(card));
  window._vpState.plan = plan;
  window._vpRenderAll();
};

window._vpCardTap = function(idx, evt) {
  var card = (window._vpState.cards || [])[idx];
  if (!card || window._vpIsFixed(card.slideType)) return;
  if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
    window._vpState.openCards = window._vpState.openCards || {};
    window._vpState.openCards[card.id] = !window._vpState.openCards[card.id];
    window._vpRenderAll();
    return;
  }
  window._vpAddToPlan(idx);
};

window._vpRemovePlan = function(idx) {
  var plan = window._vpState.plan || [];
  if (!plan[idx] || window._vpIsFixed(plan[idx].slideType)) return;
  plan.splice(idx, 1);
  window._vpRenderAll();
};

window._vpMovePlan = function(idx, dir) {
  var plan = window._vpState.plan || [];
  var next = idx + dir;
  if (!plan[idx] || window._vpIsFixed(plan[idx].slideType)) return;
  if (next <= 0 || next >= plan.length - 1) return;
  var tmp = plan[idx];
  plan[idx] = plan[next];
  plan[next] = tmp;
  window._vpRenderAll();
};

window._vpEditPlanScript = function(idx, value) {
  if (window._vpState.plan && window._vpState.plan[idx]) {
    window._vpState.plan[idx].scriptDir = value;
  }
};

window._vpCardScore = function(card) {
  var n = Number(card && card.hookScore);
  if (!isFinite(n) || n <= 0) n = 50;
  if (card && card.confidence === 'high') n += 5;
  if (card && card.confidence === 'low') n -= 8;
  return Math.max(0, Math.min(100, n));
};

window._vpBalancedMiddle = function(source, targetCount) {
  var cards = (source || []).filter(function(c) { return c && !window._vpIsFixed(c.slideType); });
  var picked = [];
  var used = {};
  var insightCount = 0;
  var visualTypes = { profile:1, stats:1, history:1, timeline:1, picture:1, comparison:1, matchcard:1 };
  cards = cards.slice().sort(function(a, b) { return window._vpCardScore(b) - window._vpCardScore(a); });
  function canPick(c) {
    if (!c || used[c.id]) return false;
    if (c.slideType === 'insight' && insightCount >= 4) return false;
    var last = picked[picked.length - 1];
    var prev = picked[picked.length - 2];
    if (c.slideType === 'insight' && last && prev && last.slideType === 'insight' && prev.slideType === 'insight') return false;
    return true;
  }
  function push(c) {
    if (!canPick(c)) return false;
    picked.push(window._vpClone(c));
    used[c.id] = true;
    if (c.slideType === 'insight') insightCount++;
    return true;
  }
  cards.filter(function(c) { return visualTypes[c.slideType]; }).forEach(function(c) {
    if (picked.length < targetCount) push(c);
  });
  cards.forEach(function(c) {
    if (picked.length < targetCount) push(c);
  });
  return picked;
};

window._vpRepairPlanBalance = function(plan) {
  if (!Array.isArray(plan) || plan.length < 3) return plan || [];
  var opening = plan.find(function(c) { return c && c.slideType === 'opening'; }) || window._vpFallbackCard('opening');
  var ending = plan.find(function(c) { return c && c.slideType === 'ending'; }) || window._vpFallbackCard('ending');
  var middle = plan.filter(function(c) { return c && !window._vpIsFixed(c.slideType); });
  var out = [];
  var stash = [];
  var insightCount = 0;
  for (var i = 0; i < middle.length; i++) {
    var c = middle[i];
    if (c.slideType === 'insight' && insightCount >= 4) { stash.push(c); continue; }
    var last = out[out.length - 1];
    var prev = out[out.length - 2];
    if (c.slideType === 'insight' && last && prev && last.slideType === 'insight' && prev.slideType === 'insight') {
      stash.push(c);
      continue;
    }
    out.push(c);
    if (c.slideType === 'insight') insightCount++;
  }
  stash.forEach(function(c) {
    if (c.slideType === 'insight' && insightCount >= 4) return;
    out.push(c);
    if (c.slideType === 'insight') insightCount++;
  });
  return [window._vpClone(opening)].concat(out.map(window._vpClone), [window._vpClone(ending)]);
};

window.autoBuildViewpointPlan = function() {
  if (!window._vpState.cards || !window._vpState.cards.length) { alert('先に企画ピースを生成してください'); return; }
  var opening = (window._vpState.cards || []).find(function(c) { return c.slideType === 'opening'; }) || window._vpFallbackCard('opening');
  var ending = (window._vpState.cards || []).find(function(c) { return c.slideType === 'ending'; }) || window._vpFallbackCard('ending');
  var middle = window._vpBalancedMiddle(window._vpState.cards, 8);
  window._vpState.plan = [window._vpClone(opening)].concat(middle, [window._vpClone(ending)]);
  window._vpRenderAll();
  var status = document.getElementById('vpStatus');
  if (status) status.textContent = '量産向けに強い企画ピースを自動で組みました。必要なら順番と指示文だけ微調整してください';
};

window._vpAttachImagesFromSelections = function(modules, selections) {
  var all = selections || {};
  var labels = Object.keys(all);
  if (!labels.length) return modules;
  var firstPool = null;
  for (var p = 0; p < labels.length && !firstPool; p++) {
    var arr0 = all[labels[p]];
    if (Array.isArray(arr0) && arr0.length) firstPool = arr0[0];
  }
  return (modules || []).map(function(m) {
    if (!m || (Array.isArray(m.images) && m.images.length)) return m;
    var cands = [];
    if (typeof m.mainKey === 'string' && m.mainKey.indexOf('entity:') === 0) {
      cands.push(m.mainKey);
      cands.push(m.mainKey.slice(7));
    }
    if (m.secondary) {
      cands.push(m.secondary);
      if (String(m.secondary).indexOf(':') < 0) cands.push('entity:' + m.secondary);
    }
    var picked = null;
    for (var i = 0; i < cands.length && !picked; i++) {
      var arr = all[cands[i]];
      if (Array.isArray(arr) && arr.length) picked = arr[0];
    }
    if (!picked && (m.type === 'opening' || m.type === 'ending' || m.type === 'insight' || m.type === 'picture')) {
      picked = firstPool;
    }
    if (picked) m.images = [picked];
    return m;
  });
};

window._vpRepairFinalModules = function(modules) {
  return (modules || []).map(function(m) {
    if (!m) return m;
    var out = Object.assign({}, m);
    var bullets = Array.isArray(out.viewpointBullets) ? out.viewpointBullets.filter(Boolean).slice(0, 6) : [];
    if (!out.narration && out.scriptDir) out.narration = out.scriptDir;
    if (out.type === 'insight') {
      if (!Array.isArray(out.catchphrases) || !out.catchphrases.length) {
        out.catchphrases = bullets.map(function(b) { return { text: String(b).slice(0, 18), chunkText: String(b) }; }).slice(0, 6);
      }
      if (!Array.isArray(out.narrationChunks) || !out.narrationChunks.length) {
        out.narrationChunks = bullets.length ? bullets : null;
      }
    }
    if ((out.type === 'profile' || out.type === 'stats' || out.type === 'history') &&
        (!Array.isArray(out.dataSlots) || !out.dataSlots.length) && out.dataPreview) {
      var parts = String(out.dataPreview).split(/\s*[/／・,、]\s*/).filter(Boolean).slice(0, 6);
      out.dataSlots = parts.map(function(p, i) {
        var kv = String(p).split(/[:：]/);
        return { label: (kv[0] || ('項目' + (i + 1))).slice(0, 12), value: (kv[1] || kv[0] || '').slice(0, 36) };
      });
    }
    if (out.type === 'picture' && (!Array.isArray(out.images) || !out.images.length) && out.mainKey) {
      out.imagePromptHint = out.title || out.scriptDir || out.mainKey;
    }
    return out;
  });
};

window.step25Init = function() {
  var postId = window.APP && window.APP.selected && window.APP.selected.id;
  var cardsEl = document.getElementById('vpCards');
  var planEl = document.getElementById('vpPlan');
  var footer = document.getElementById('vpFooter');
  if (!postId) {
    window._vpState.cards = [];
    window._vpState.plan = [];
    if (cardsEl) cardsEl.innerHTML = '<div style="color:#64748b;padding:24px;text-align:center;">先に案件を選択してください</div>';
    if (planEl) planEl.innerHTML = '<div class="vp-plan-empty">案件選択後に企画書を組み立てます</div>';
    if (footer) footer.style.display = 'none';
    return;
  }
  if (window._vpState.postId && window._vpState.postId !== postId) {
    window._vpState.cards = [];
    window._vpState.plan = [];
    window._vpState.openCards = {};
  }
  window._vpState.postId = postId;
  if (window._vpState.cards && window._vpState.cards.length) {
    window._vpRenderAll();
    var rb = document.getElementById('vpRegenBtn');
    var ab = document.getElementById('vpAutoBtn');
    if (rb) rb.style.display = '';
    if (ab) ab.style.display = '';
  }
};

window.generateViewpoints = function() {
  var postId = window.APP && window.APP.selected && window.APP.selected.id;
  if (!postId) { alert('先に案件を選択してください'); return; }
  if (window._vpState.generating) return;
  window._vpState.generating = true;
  window._vpState.postId = postId;
  window._vpState.cards = [];
  window._vpState.plan = [];
  window._vpState.openCards = {};

  var btn    = document.getElementById('vpGenBtn');
  var regen  = document.getElementById('vpRegenBtn');
  var autoBtn = document.getElementById('vpAutoBtn');
  var status = document.getElementById('vpStatus');
  var cardsEl = document.getElementById('vpCards');
  var planEl = document.getElementById('vpPlan');
  var footer = document.getElementById('vpFooter');
  if (btn)    btn.disabled = true;
  if (regen)  regen.style.display = 'none';
  if (autoBtn) autoBtn.style.display = 'none';
  if (status) status.textContent = '企画ピース生成中...';
  if (cardsEl) cardsEl.innerHTML = '<div style="color:#64748b;padding:20px;text-align:center;">記事・Wiki・データから企画ピースを生成しています（20〜40秒）...</div>';
  if (planEl) planEl.innerHTML = '<div class="vp-plan-empty">生成後、ここに冒頭と締めが入ります</div>';
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
            window._vpResetPlan();
            if (btn) btn.disabled = false;
            if (regen) regen.style.display = '';
            if (autoBtn) autoBtn.style.display = '';
            window.autoBuildViewpointPlan();  // hookScore順で自動プラン組み立て
            if (status) status.textContent = window._vpState.cards.length + '枚生成 → AIのおすすめ順で自動プランを組みました。順番や指示文を調整してから脚本生成へ';
            return;
          }
          tick++;
          if (tick > 60) { window._vpState.generating = false; throw new Error('タイムアウト'); }
          if (status) status.textContent = '企画ピース生成中... ' + (tick * 3) + 's';
          poll();
        }).catch(function(e2) {
          window._vpState.generating = false;
          if (status) status.textContent = 'エラー: ' + (e2.message || e2);
          if (cardsEl) cardsEl.innerHTML = '<div style="color:#ef4444;padding:20px;">' + window._vpEsc(e2.message || String(e2)) + '</div>';
          if (btn) btn.disabled = false;
        });
      }, 3000);
    }
    poll();
  }).catch(function(e) {
    window._vpState.generating = false;
    if (status) status.textContent = 'エラー: ' + (e.message || e);
    if (cardsEl) cardsEl.innerHTML = '<div style="color:#ef4444;padding:20px;">' + window._vpEsc(e.message || String(e)) + '</div>';
    if (btn) btn.disabled = false;
  });
};

window.generateFromViewpoints = function() {
  var plan = window._vpRepairPlanBalance(window._vpState.plan || []);
  window._vpState.plan = plan;
  if (!window._vpState.cards.length) { alert('先に企画ピースを生成してください'); return; }
  var middleCount = plan.filter(function(c) { return c && !window._vpIsFixed(c.slideType); }).length;
  if (middleCount < 1) { alert('企画ピースを1枚以上追加してください'); return; }

  var modules = [];
  for (var j = 0; j < plan.length; j++) {
    var c = plan[j];
    var bullets = Array.isArray(c.bullets) ? c.bullets.filter(Boolean).slice(0, 6) : [];
    var dir = c.scriptDir || '';
    if (bullets.length) dir += ' / 論点: ' + bullets.join(' / ');
    modules.push({ title: c.title || '', type: c.slideType, mainKey: c.mainKey,
                   secondary: c.secondary || null, scriptDir: dir, recipeKey: c.recipeKey || null,
                   viewpointBullets: bullets, dataPreview: c.dataPreview || '', dataSource: c.dataSource || '',
                   hookScore: Number(c.hookScore) || 0, insightSubtype: c.insightSubtype || 'none' });
  }

  var postId = window.APP && window.APP.selected && window.APP.selected.id;
  var post   = window.APP && window.APP.selected;
  if (!postId) { alert('案件が未選択です'); return; }

  var status = document.getElementById('vpStatus');
  var footer = document.getElementById('vpFooter');
  var btn = document.querySelector('#vpFooter button');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '脚本生成を開始します...';
  if (footer) footer.style.display = 'none';

  window.fetchJson('/api/v3/generate-scenario', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId: postId, modules: modules, post: post }),
  }).then(function(r) {
    if (!r.ok || !r.jobId) throw new Error(r.error || '脚本生成ジョブ起動失敗');
    var jobId = r.jobId;
    if (status) status.textContent = '脚本生成中... (jobId:' + jobId + ')';
    var tick2 = 0;
    function pollScenario() {
      setTimeout(function() {
        window.fetchJson('/api/v3/scenario-status?jobId=' + jobId).then(function(j) {
          if (j.status === 'error') { alert('脚本生成失敗: ' + (j.error || '')); return; }
          if (j.status === 'done' && j.modules && j.modules.length) {
            if (status) status.textContent = '脚本生成完了。画像とデータを反映しています...';
            window.fetchJson('/api/v35/get-selection?postId=' + encodeURIComponent(postId))
              .catch(function() { return { selections: {} }; })
              .then(function(sel) {
                var finalModules = window._vpAttachImagesFromSelections(j.modules, (sel && sel.selections) || {});
                finalModules = window._vpRepairFinalModules(finalModules);
                window.APP.modules = finalModules;
                if (window.APP.s3) window.APP.s3.modules = finalModules;
                return window.fetchJson('/api/save-modules', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ postId: postId, modules: finalModules }),
                }).catch(function() {});
              })
              .then(function() {
                if (status) status.textContent = 'STEP4へ移動します...';
                window.goStep(4);
                if (typeof window.step4Init === 'function') window.step4Init();
              });
            return;
          }
          tick2++;
          if (status) status.textContent = '脚本生成中... ' + (j.step || 'running') + ' / ' + (tick2 * 3) + 's';
          if (tick2 < 120) pollScenario();
          else throw new Error('脚本生成タイムアウト');
        }).catch(function(e) {
          tick2++;
          if (status) status.textContent = '脚本生成待機中... ' + (tick2 * 3) + 's';
          if (tick2 < 120) pollScenario();
          else {
            if (btn) btn.disabled = false;
            if (footer) footer.style.display = '';
            alert('脚本生成確認に失敗: ' + (e.message || e));
          }
        });
      }, 3000);
    }
    pollScenario();
  }).catch(function(e) {
    if (status) status.textContent = 'エラー: ' + (e.message || e);
    alert('エラー: ' + (e.message || e));
    if (btn) btn.disabled = false;
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
/* ── Autopilot パネル表示切替 ── */
function _apPanelToggle() {
  var panel = document.getElementById('apPanel');
  if (panel) panel.style.display = window.APP.selected ? 'block' : 'none';
}

/* ── Autopilot 実行 ── */
window._apRunning = false; // 並走防止フラグ
window.runAutopilot = async function(mode) {
  var post = window.APP.selected;
  if (!post?.id) { alert('先に案件を選択してください'); return; }
  if (window._apRunning) { alert('⚠️ Autopilotが既に実行中です。完了を待ってから再実行してください。'); return; }
  window._apRunning = true;
  var statusEl = document.getElementById('apStatus');
  var modeLabel = { semi:'SemiAuto', S:'FullAuto(S)', M:'FullAuto(M)', L:'FullAuto(L)' }[mode] || mode;
  var setStatus = function(msg) { if (statusEl) statusEl.textContent = msg; };
  var btns = document.querySelectorAll('#apPanel button');
  btns.forEach(function(b) { b.disabled = true; b.style.opacity = '.5'; });
  try {
    setStatus('⏳ ' + modeLabel + ' 起動中...');
    var r = await fetchJson('/api/v25/autopilot/vp-start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: post.id, mode: mode }),
    });
    if (!r?.jobId) throw new Error('jobId 受信失敗');
    var STEP_LABELS = {
      'suggest-labels': '① ラベル提案・記事収集中',
      'fetch-all':      '② データ取得中',
      'viewpoints':     '③ 企画ピース生成中（Sonnet）',
      'scenario':       '④ 脚本生成中（DeepSeek）',
    };
    for (var tick = 0; tick < 400; tick++) {
      await new Promise(function(res) { setTimeout(res, 3000); });
      var j = await fetchJson('/api/v25/autopilot/vp-status?jobId=' + encodeURIComponent(r.jobId));
      if (!j) continue;
      if (j.status === 'done') {
        setStatus('✅ 完了！' + (j.message || ''));
        if (j.navigateTo === '25' && Array.isArray(j.cards)) {
          window._vpState = window._vpState || {};
          window._vpState.cards = j.cards;
          if (j.briefing) window._vpState.briefing = j.briefing;
          window._vpState.plan = [];
          window.goStep(25);
          if (typeof window.autoBuildViewpointPlan === 'function') {
            setTimeout(window.autoBuildViewpointPlan, 300);
          }
        } else if (j.navigateTo === '4') {
          window.goStep(4);
        }
        break;
      }
      if (j.status === 'error') { setStatus('❌ エラー: ' + (j.error || '不明')); break; }
      setStatus('⏳ ' + (STEP_LABELS[j.step] || j.message || '処理中') + ' (' + ((tick+1)*3) + 's)');
    }
  } catch(e) {
    setStatus('❌ ' + e.message);
  } finally {
    window._apRunning = false;
    btns.forEach(function(b) { b.disabled = false; b.style.opacity = '1'; });
  }
};

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
  _apPanelToggle();
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
