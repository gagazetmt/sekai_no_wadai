// routes/step5_routes.js
// ═══════════════════════════════════════════════════════════
// Step5: サムネイル AI 生成（2026-05-10 全面リニューアル）
//   - 🤖 AI生成タブ: リネカ題材分類 + DeepSeek プロンプト + Imagen 4 で5枚生成
//   - 🎨 サムネエディタータブ: 既存 /v2_thumbs/_editor/ を iframe 埋込（保険）
//
// 旧 Step5 の動画投稿系（メタ・YouTube 投稿）は step6_routes.js に分離。
// 旧 A/D/L/N/O HTML テンプレ UI は廃止（コードは scripts/v2_thumb/templates/ に温存）。
//
// データファイル:
//   - data/v2_thumbs/{postId}/imagen4_*.png : 生成サムネ
//   - data/{postId}_step5.json              : 選択したサムネを selectedThumb に記録
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const ROOT_DIR        = path.join(__dirname, '..');
const THUMB_OUT_BASE  = path.join(ROOT_DIR, 'data', 'v2_thumbs');
const META_FILE       = (postId) => path.join(ROOT_DIR, 'data', `${postId}_step5.json`);
const SI_DATA_FILE    = (postId) => path.join(ROOT_DIR, 'data', 'si_data', `${postId.replace(/[\/\?%*:|"<>\.]/g, '_')}.json`);
const MODULES_FILE    = (postId) => path.join(ROOT_DIR, 'data', `${postId}_modules.json`);

const thumbAi = require('../scripts/v2_video/thumb_ai');

// ─── 共通: メタ JSON 読み書き（step6 と共用）─────
function readMeta(postId) {
  const file = META_FILE(postId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return {}; }
}
function writeMeta(postId, obj) {
  fs.writeFileSync(META_FILE(postId), JSON.stringify(obj, null, 2));
}

// ─── 案件情報のサーバ側収集 ────────────────────
function _collectPostInfo(postId, override = {}) {
  const info = {
    title: override.title || '',
    entities: override.entities || [],
    summary: override.summary || '',
  };

  // si_data からエンティティ抽出
  if (!info.entities.length) {
    const sf = SI_DATA_FILE(postId);
    if (fs.existsSync(sf)) {
      try {
        const data = JSON.parse(fs.readFileSync(sf, 'utf8'));
        info.entities = Object.keys(data);
      } catch (_) {}
    }
  }

  // modules.json から動画タイトル＆ナレ要約抽出
  if (!info.title || !info.summary) {
    const mf = MODULES_FILE(postId);
    if (fs.existsSync(mf)) {
      try {
        const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const mods = Array.isArray(m) ? m : m.modules || [];
        if (!info.title && mods[0] && mods[0].title) info.title = mods[0].title;
        if (!info.summary) {
          info.summary = mods.map(x => `[${x.type}] ${x.title || ''}`).join(' / ').slice(0, 600);
        }
      } catch (_) {}
    }
  }
  return info;
}

// ════════════════════════════════════════════════════════════
// 🤖 AI 生成系 API
// ════════════════════════════════════════════════════════════

// 題材タイプを自動分類
router.post('/v5/classify-theme', async (req, res) => {
  const { postId, title, entities, summary } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  try {
    const info = _collectPostInfo(postId, { title, entities, summary });
    const result = await thumbAi.classifyTheme(info);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// オープニングスライドから topText / bottomText を抽出
router.post('/v5/extract-thumb-text', async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const mFile = MODULES_FILE(postId);
  if (!fs.existsSync(mFile)) return res.status(404).json({ error: 'modules.json not found' });
  let modules;
  try { modules = JSON.parse(fs.readFileSync(mFile, 'utf8')); }
  catch (_) { return res.status(500).json({ error: 'modules.json parse error' }); }
  const mods = Array.isArray(modules) ? modules : modules.modules || [];
  const opening = mods.find(m => m.type === 'opening' || m.mainKey === 'opening');
  if (!opening) return res.status(404).json({ error: 'opening モジュールが見つからない' });
  try {
    const result = await thumbAi.extractThumbText({
      openingTitle: opening.title || '',
      openingNarration: opening.narration || '',
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// リネカ + DeepSeek で Imagen 4 用英語プロンプト生成
router.post('/v5/suggest-thumb-prompt', async (req, res) => {
  const { postId, theme, topText, bottomText, title, entities, summary } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  try {
    const info = _collectPostInfo(postId, { title, entities, summary });
    info.topText = topText || '';
    info.bottomText = bottomText || '';
    const prompt = await thumbAi.buildPrompt(info, theme || 'default');
    res.json({ ok: true, prompt, theme: theme || 'default' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Imagen 4 で N 枚生成
router.post('/v5/generate-thumb', async (req, res) => {
  const { postId, prompt, count, provider, aspectRatio } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const safePostId = String(postId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const outputDir = path.join(THUMB_OUT_BASE, safePostId);
    const results = await thumbAi.generateThumb({
      provider:    provider    || 'imagen4',
      prompt,
      count:       count       || 5,
      aspectRatio: aspectRatio || '16:9',
      outputDir,
    });
    res.json({
      ok: true,
      thumbs: results.map(r => ({
        file: r.file,
        url: `/v2_thumbs/${safePostId}/${r.file}`,
        provider: r.provider,
        model: r.model,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 選択したサムネを meta に記録（Step6 から参照）
router.post('/v5/select-thumb', (req, res) => {
  const { postId, thumbFile } = req.body || {};
  if (!postId || !thumbFile) return res.status(400).json({ error: 'postId/thumbFile required' });
  const meta = readMeta(postId);
  meta.selectedThumb = thumbFile;
  meta.selectedThumbAt = new Date().toISOString();
  writeMeta(postId, meta);
  res.json({ ok: true, selectedThumb: thumbFile });
});

// 外部生成画像（Gemini Web 版・Seedream 等）をアップロード
router.post('/v5/upload-thumb', (req, res) => {
  const { postId, filename, dataUrl } = req.body || {};
  if (!postId || !dataUrl) return res.status(400).json({ error: 'postId/dataUrl required' });

  const m = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid dataUrl format' });

  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');
  const safePostId = String(postId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const outDir = path.join(THUMB_OUT_BASE, safePostId);
  fs.mkdirSync(outDir, { recursive: true });
  const safeName = String(filename || 'external')
    .replace(/\.[^.]+$/, '')                    // 拡張子除去
    .replace(/[^a-zA-Z0-9_.-]/g, '_')           // sanitize
    .slice(0, 40);
  const finalFile = `external_${Date.now()}_${safeName}.${ext}`;
  fs.writeFileSync(path.join(outDir, finalFile), buffer);

  // 取り込み即選択（Step6 が selectedThumb=null でサムネ反映されない事故を防ぐ）
  const meta = readMeta(postId);
  meta.selectedThumb = finalFile;
  meta.selectedThumbAt = new Date().toISOString();
  writeMeta(postId, meta);

  res.json({
    ok: true,
    file: finalFile,
    url: `/v2_thumbs/${safePostId}/${finalFile}`,
    size: buffer.length,
    autoSelected: true,
  });
});

// ════════════════════════════════════════════════════════════
// 既存サムネ管理 API（list / delete / case-images）保持
// ════════════════════════════════════════════════════════════
router.get('/v5/list-saved', (req, res) => {
  const { postId } = req.query;
  const safePostId = String(postId || '_unsorted').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const dir = path.join(THUMB_OUT_BASE, safePostId);
  if (!fs.existsSync(dir)) return res.json({ files: [] });
  const files = fs.readdirSync(dir)
    .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { file: f, url: `/v2_thumbs/${safePostId}/${f}`, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json({ files });
});

router.delete('/v5/delete-saved', (req, res) => {
  const { postId, file } = req.query;
  if (!postId || !file) return res.status(400).json({ error: 'missing params' });
  const safePostId = String(postId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const safeFile = path.basename(String(file));
  const target = path.join(THUMB_OUT_BASE, safePostId, safeFile);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 案件画像（編集タブで参考用に表示する場合）
router.get('/v5/case-images', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.json({ images: [] });
  const root = path.join(ROOT_DIR, 'images', String(postId));
  if (!fs.existsSync(root)) return res.json({ images: [] });
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(jpe?g|png|webp)$/i.test(ent.name)) {
        const rel = path.relative(ROOT_DIR, full).replace(/\\/g, '/');
        const label = path.basename(path.dirname(full));
        out.push({ path: rel, label, file: ent.name });
      }
    }
  };
  walk(root);
  res.json({ images: out });
});

// ════════════════════════════════════════════════════════════
// UI（AI生成タブ + サムネエディタータブ）
// ════════════════════════════════════════════════════════════
function getUI() {
  return `
<div id="step5" style="display:none; padding:20px;">
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
    <h2 style="color:var(--c); font-size:18px; letter-spacing:1px;">5. サムネイル生成</h2>
    <span id="s5-postlabel" style="color:var(--muted); font-size:12px;"></span>
    <span id="s5-selected-status" style="margin-left:auto; font-size:11px; color:var(--muted);"></span>
  </div>

  <!-- サブタブ -->
  <div id="s5-subnav" style="display:flex; gap:4px; margin-bottom:14px; border-bottom:1px solid var(--border);">
    <button onclick="s5GoSub('ai')"     id="s5sub-ai"     class="s5sub active">🤖 AI生成（Imagen 4）</button>
    <button onclick="s5GoSub('editor')" id="s5sub-editor" class="s5sub">🎨 サムネエディター</button>
  </div>
  <style>
    .s5sub { background:transparent; color:var(--muted); border:0; padding:9px 14px; cursor:pointer;
             font-size:12px; font-weight:bold; border-bottom:2px solid transparent; }
    .s5sub:hover { color: var(--text); }
    .s5sub.active { color: var(--c); border-bottom-color: var(--c); }
    .s5card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:12px; }
    .s5label { display:block; font-size:11px; color:var(--muted); margin:8px 0 3px; }
    .s5input { width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border);
               padding:7px 10px; border-radius:4px; font-size:12px; box-sizing:border-box; }
    .s5btn { background:var(--c); color:#fff; border:0; padding:8px 16px; border-radius:6px;
             cursor:pointer; font-weight:bold; font-size:12px; }
    .s5btn:disabled { opacity:.5; cursor:not-allowed; }
    .s5btn-sub { background:var(--panel); color:var(--text); border:1px solid var(--border);
                 padding:7px 14px; border-radius:6px; cursor:pointer; font-size:12px; }
    .s5thumb-card { background:var(--panel); border:2px solid var(--border); border-radius:8px;
                    overflow:hidden; cursor:pointer; transition: border-color .15s, transform .15s; }
    .s5thumb-card:hover { transform: translateY(-2px); border-color: var(--muted); }
    .s5thumb-card.selected { border-color: var(--c); box-shadow: 0 0 12px rgba(255,77,77,.4); }
  </style>

  <!-- ───── 🤖 AI 生成 ───── -->
  <div id="s5pane-ai" class="s5pane">
    <!-- ステップ 1: 題材分類 -->
    <div class="s5card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
        <strong style="color:var(--c); font-size:12px;">① 題材タイプ</strong>
        <button onclick="s5ClassifyTheme()" class="s5btn-sub" id="s5-classify-btn">🔍 自動判定</button>
        <span id="s5-classify-status" style="font-size:11px; color:var(--muted);"></span>
      </div>
      <select id="s5-theme" class="s5input" style="max-width:340px;">
        <option value="default">default（汎用・該当なし）</option>
        <option value="rivalry">rivalry（クラシコ・ダービー・直接対決）</option>
        <option value="transfer">transfer（移籍・新加入）</option>
        <option value="manager_change">manager_change（監督交代・解任）</option>
        <option value="injury">injury（怪我・離脱・復帰）</option>
        <option value="legend">legend（レジェンド・引退・節目）</option>
        <option value="season_summary">season_summary（総括・ランキング）</option>
        <option value="preview">preview（試合プレビュー）</option>
        <option value="review">review（試合レビュー）</option>
      </select>
    </div>

    <!-- ステップ 2+3: テキスト抽出 + プロンプト生成（一括） -->
    <div class="s5card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;">
        <strong style="color:var(--c); font-size:12px;">②③ サムネテキスト＋プロンプト</strong>
        <button onclick="s5ExtractAndSuggest()" class="s5btn-sub" id="s5-extract-suggest-btn">📺✨ オープニングから一括生成</button>
        <button onclick="s5CopyPrompt()" class="s5btn-sub">📋 プロンプトコピー</button>
        <span id="s5-extract-suggest-status" style="font-size:11px; color:var(--muted);"></span>
      </div>

      <label class="s5label">② 上端 煽り文（10文字以内推奨）</label>
      <input type="text" id="s5-top-text" class="s5input" maxlength="20" placeholder="例: プレミア最終決戦">
      <label class="s5label">② 下端 結論文（12文字以内推奨）</label>
      <input type="text" id="s5-bottom-text" class="s5input" maxlength="24" placeholder="例: 優勝はどちらの手に！？">

      <label class="s5label" style="margin-top:10px;">③ Imagen 4 用プロンプト</label>
      <textarea id="s5-prompt" rows="6" class="s5input" style="resize:vertical; font-family:monospace;" placeholder="📺✨ 一括生成ボタンで自動生成。手動編集可。コピーして無料 Gemini Web 版に貼り付けても OK。"></textarea>
    </div>

    <!-- ステップ 4: 画像生成 -->
    <div class="s5card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap;">
        <strong style="color:var(--c); font-size:12px;">④ Imagen 4 で生成</strong>
        <label style="font-size:11px; color:var(--muted);">枚数:</label>
        <select id="s5-count" class="s5input" style="width:auto;">
          <option value="3">3枚</option>
          <option value="4">4枚</option>
          <option value="5" selected>5枚（推奨）</option>
        </select>
        <button onclick="s5GenerateThumbs()" class="s5btn" id="s5-gen-btn">🎨 サムネ生成</button>
        <span id="s5-gen-status" style="font-size:11px; color:var(--muted);"></span>
      </div>
      <div id="s5-thumbs-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:10px;"></div>
    </div>

    <!-- 外部画像インポート（無料 Gemini Web 版・Seedream 等から） -->
    <div class="s5card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:8px;">📤 外部画像インポート（無料 Gemini Web 版・Seedream 等で生成した画像をアップロード）</strong>
      <input type="file" id="s5-upload-file" accept="image/png,image/jpeg,image/webp" style="display:none;" onchange="s5UploadFile(event)">
      <div id="s5-drop-zone"
           onclick="document.getElementById('s5-upload-file').click()"
           ondragover="event.preventDefault(); this.style.borderColor='var(--c)'; this.style.background='#1a2540';"
           ondragleave="this.style.borderColor='var(--border)'; this.style.background='#0a0e1a';"
           ondrop="event.preventDefault(); this.style.borderColor='var(--border)'; this.style.background='#0a0e1a'; s5HandleDrop(event)"
           style="border:2px dashed var(--border); padding:24px 20px; text-align:center; cursor:pointer; border-radius:6px; background:#0a0e1a; transition: all .15s;">
        <div style="font-size:14px; color:var(--text); font-weight:bold;">📁 クリック or ここに画像をドラッグ</div>
        <div style="font-size:11px; color:var(--muted); margin-top:5px;">PNG / JPG / WEBP 対応 / 1280x720（16:9）推奨</div>
      </div>
      <div id="s5-upload-status" style="font-size:11px; color:var(--muted); margin-top:8px;"></div>
    </div>

    <!-- 保存済みサムネ一覧 -->
    <div class="s5card">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <strong style="color:var(--c); font-size:12px;">💾 保存済みサムネ（AI生成・外部import 含む）</strong>
        <button onclick="s5LoadSaved()" class="s5btn-sub">↻ 再読込</button>
      </div>
      <div id="s5-saved-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:10px;"></div>
    </div>
  </div>

  <!-- ───── 🎨 サムネエディター ───── -->
  <div id="s5pane-editor" class="s5pane" style="display:none;">
    <div class="s5card" style="padding:8px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding:0 6px;">
        <strong style="color:var(--c); font-size:12px;">🎨 サムネエディター（手動作成・保険）</strong>
        <a href="/v2_thumbs/_editor/" target="_blank" class="s5btn-sub" style="text-decoration:none;">↗ 別タブで開く</a>
      </div>
      <iframe id="s5-editor-iframe" src="about:blank" style="width:100%; height:80vh; border:1px solid var(--border); border-radius:6px; background:#000;"></iframe>
    </div>
  </div>
</div>

<script>
(function() {
  if (window.__s5Init) return; window.__s5Init = true;

  const STATE = {
    sub: 'ai',
    selectedThumb: null,  // file 名
    generated: [],        // 直近生成バッチの thumbs
    editorLoaded: false,
  };

  function _e(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function postId() { return window.APP && window.APP.selected ? window.APP.selected.id : null; }
  function postTitle() { return window.APP && window.APP.selected ? (window.APP.selected.title || '') : ''; }

  window.s5GoSub = function(name) {
    STATE.sub = name;
    ['ai','editor'].forEach(n => {
      const btn = document.getElementById('s5sub-' + n);
      const pane = document.getElementById('s5pane-' + n);
      if (btn) btn.className = 's5sub' + (n === name ? ' active' : '');
      if (pane) pane.style.display = (n === name ? '' : 'none');
    });
    if (name === 'editor' && !STATE.editorLoaded) {
      document.getElementById('s5-editor-iframe').src = '/v2_thumbs/_editor/';
      STATE.editorLoaded = true;
    }
  };

  // ═══ ① 題材分類 ═══
  window.s5ClassifyTheme = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s5-classify-btn');
    btn.disabled = true;
    document.getElementById('s5-classify-status').textContent = '⏳ 分類中…';
    try {
      const r = await window.fetchJson('/api/v5/classify-theme', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, title: postTitle() }),
      });
      document.getElementById('s5-theme').value = r.theme;
      document.getElementById('s5-classify-status').textContent =
        '✅ ' + r.theme + ' (確信度 ' + Math.round((r.confidence||0)*100) + '%): ' + (r.reasoning||'');
      document.getElementById('s5-classify-status').style.color = 'var(--success)';
    } catch (e) {
      document.getElementById('s5-classify-status').textContent = '❌ ' + e.message;
      document.getElementById('s5-classify-status').style.color = 'var(--c)';
    } finally {
      btn.disabled = false;
    }
  };

  // ═══ ②③ 一括生成（テキスト抽出 → プロンプト生成 を順次）═══
  window.s5ExtractAndSuggest = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s5-extract-suggest-btn');
    const status = document.getElementById('s5-extract-suggest-status');
    btn.disabled = true;
    status.style.color = 'var(--muted)';

    // ② オープニングから topText/bottomText
    status.textContent = '⏳ ② オープニングから抽出中…';
    let topText = '', bottomText = '';
    try {
      const r = await window.fetchJson('/api/v5/extract-thumb-text', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: id }),
      });
      if (r.error) throw new Error(r.error);
      topText = r.topText || '';
      bottomText = r.bottomText || '';
      if (topText)    document.getElementById('s5-top-text').value    = topText;
      if (bottomText) document.getElementById('s5-bottom-text').value = bottomText;
    } catch (e) {
      status.textContent = '❌ ② 抽出失敗: ' + e.message;
      status.style.color = 'var(--c)';
      btn.disabled = false;
      return;
    }

    // ③ プロンプト生成（②の結果をそのまま渡す）
    status.textContent = '⏳ ② 完了 → ③ DeepSeek 思考中…';
    const theme = document.getElementById('s5-theme').value;
    try {
      const r = await window.fetchJson('/api/v5/suggest-thumb-prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: id, theme, topText, bottomText, title: postTitle() }),
      });
      document.getElementById('s5-prompt').value = r.prompt;
      status.textContent = '✅ 一括生成完了（②テキスト + ③プロンプト・編集可）';
      status.style.color = 'var(--success)';
    } catch (e) {
      status.textContent = '⚠️ ② OK だが ③ プロンプト生成失敗: ' + e.message;
      status.style.color = 'var(--c)';
    } finally {
      btn.disabled = false;
    }
  };

  // ═══ ② オープニングから topText/bottomText 抽出（単体・後方互換）═══
  window.s5ExtractThumbText = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s5-extract-btn');
    btn.disabled = true;
    document.getElementById('s5-extract-status').textContent = '⏳ オープニングから抽出中…';
    document.getElementById('s5-extract-status').style.color = 'var(--muted)';
    try {
      const r = await window.fetchJson('/api/v5/extract-thumb-text', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id }),
      });
      if (r.error) throw new Error(r.error);
      if (r.topText)    document.getElementById('s5-top-text').value    = r.topText;
      if (r.bottomText) document.getElementById('s5-bottom-text').value = r.bottomText;
      document.getElementById('s5-extract-status').textContent = '✅ 抽出完了（編集可）';
      document.getElementById('s5-extract-status').style.color = 'var(--success)';
    } catch (e) {
      document.getElementById('s5-extract-status').textContent = '❌ ' + e.message;
      document.getElementById('s5-extract-status').style.color = 'var(--c)';
    } finally {
      btn.disabled = false;
    }
  };

  // ═══ ③ プロンプト提案 ═══
  window.s5SuggestPrompt = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const theme = document.getElementById('s5-theme').value;
    const topText = document.getElementById('s5-top-text').value.trim();
    const bottomText = document.getElementById('s5-bottom-text').value.trim();
    if (!topText && !bottomText) {
      if (!confirm('上端・下端の日本語テキストが空だよ。それでも進める？')) return;
    }
    const btn = document.getElementById('s5-suggest-btn');
    btn.disabled = true;
    document.getElementById('s5-prompt-status').textContent = '⏳ DeepSeek 思考中…';
    try {
      const r = await window.fetchJson('/api/v5/suggest-thumb-prompt', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, theme, topText, bottomText, title: postTitle() }),
      });
      document.getElementById('s5-prompt').value = r.prompt;
      document.getElementById('s5-prompt-status').textContent = '✅ プロンプト生成完了（編集可）';
      document.getElementById('s5-prompt-status').style.color = 'var(--success)';
    } catch (e) {
      document.getElementById('s5-prompt-status').textContent = '❌ ' + e.message;
      document.getElementById('s5-prompt-status').style.color = 'var(--c)';
    } finally {
      btn.disabled = false;
    }
  };

  // ═══ ④ Imagen 4 で画像生成 ═══
  window.s5GenerateThumbs = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const prompt = document.getElementById('s5-prompt').value.trim();
    if (!prompt) { alert('プロンプトを入力してね（③ で提案ボタン押すか手動入力）'); return; }
    const count = parseInt(document.getElementById('s5-count').value, 10) || 5;
    const btn = document.getElementById('s5-gen-btn');
    btn.disabled = true;
    document.getElementById('s5-gen-status').textContent = '⏳ Imagen 4 で ' + count + ' 枚生成中（最大60秒）…';
    document.getElementById('s5-gen-status').style.color = 'var(--muted)';
    try {
      const r = await window.fetchJson('/api/v5/generate-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, prompt, count }),
      });
      STATE.generated = r.thumbs || [];
      renderGenerated();
      document.getElementById('s5-gen-status').textContent = '✅ ' + STATE.generated.length + ' 枚生成完了';
      document.getElementById('s5-gen-status').style.color = 'var(--success)';
      // 保存済み一覧も再読込
      s5LoadSaved();
    } catch (e) {
      document.getElementById('s5-gen-status').textContent = '❌ ' + e.message;
      document.getElementById('s5-gen-status').style.color = 'var(--c)';
    } finally {
      btn.disabled = false;
    }
  };

  function renderGenerated() {
    const el = document.getElementById('s5-thumbs-grid');
    if (!STATE.generated.length) { el.innerHTML = ''; return; }
    el.innerHTML = STATE.generated.map(t => {
      const sel = STATE.selectedThumb === t.file;
      return '<div class="s5thumb-card' + (sel?' selected':'') + '" onclick="s5SelectThumb(\\''+_e(t.file)+'\\')">'
        + '<img src="'+_e(t.url)+'" style="width:100%;aspect-ratio:16/9;display:block;object-fit:cover;">'
        + '<div style="padding:6px 8px;font-size:10px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;">'
        + '<span>'+_e(t.provider)+'</span>'
        + (sel ? '<span style="color:var(--c);font-weight:bold;">✅ 選択中</span>' : '<span style="color:var(--muted);">クリックで選択</span>')
        + '</div></div>';
    }).join('');
  }

  // ═══ プロンプトコピー ═══
  window.s5CopyPrompt = function() {
    const t = document.getElementById('s5-prompt').value.trim();
    if (!t) { alert('プロンプトが空だよ。先に「リネカ＋DeepSeekで提案」押すか、手動入力してね'); return; }
    navigator.clipboard.writeText(t).then(() => {
      const el = document.getElementById('s5-prompt-status');
      el.textContent = '✅ クリップボードにコピー！Gemini Web に貼り付けてね';
      el.style.color = 'var(--success)';
    }).catch(e => alert('コピー失敗: ' + e.message));
  };

  // ═══ 外部画像アップロード ═══
  window.s5UploadFile = async function(ev) {
    const file = (ev.target.files || [])[0];
    if (!file) return;
    await _s5DoUpload(file);
    ev.target.value = '';  // 同じファイル再選択できるよう reset
  };
  window.s5HandleDrop = async function(ev) {
    const file = (ev.dataTransfer.files || [])[0];
    if (!file) return;
    if (!/^image\\//.test(file.type)) { alert('画像ファイルを選んでね（PNG / JPG / WEBP）'); return; }
    await _s5DoUpload(file);
  };
  async function _s5DoUpload(file) {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const status = document.getElementById('s5-upload-status');
    status.textContent = '⏳ アップロード中... ' + file.name + ' (' + (file.size/1024).toFixed(0) + 'KB)';
    status.style.color = 'var(--muted)';
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('ファイル読み込み失敗'));
        r.readAsDataURL(file);
      });
      const r = await window.fetchJson('/api/v5/upload-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, filename: file.name, dataUrl }),
      });
      status.textContent = '✅ 取り込み完了 → このサムネを自動選択しました: ' + r.file;
      status.style.color = 'var(--success)';
      STATE.selectedThumb = r.file;
      s5LoadSaved();
    } catch (e) {
      status.textContent = '❌ ' + e.message;
      status.style.color = 'var(--c)';
    }
  }

  // ═══ サムネ選択（meta に記録）═══
  window.s5SelectThumb = async function(file) {
    const id = postId(); if (!id) return;
    try {
      await window.fetchJson('/api/v5/select-thumb', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId: id, thumbFile: file }),
      });
      STATE.selectedThumb = file;
      document.getElementById('s5-selected-status').textContent = '✅ 選択中: ' + file;
      document.getElementById('s5-selected-status').style.color = 'var(--success)';
      renderGenerated();
      renderSaved();
    } catch (e) { alert('選択失敗: ' + e.message); }
  };

  // ═══ 保存済み一覧 ═══
  window.s5LoadSaved = async function() {
    const id = postId(); if (!id) return;
    try {
      const r = await window.fetchJson('/api/v5/list-saved?postId=' + encodeURIComponent(id));
      STATE.saved = r.files || [];
      renderSaved();
    } catch (e) { console.error(e); }
  };
  function renderSaved() {
    const el = document.getElementById('s5-saved-grid');
    if (!STATE.saved || !STATE.saved.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px;">まだ生成サムネなし</div>'; return; }
    el.innerHTML = STATE.saved.map(f => {
      const sel = STATE.selectedThumb === f.file;
      return '<div class="s5thumb-card' + (sel?' selected':'') + '" onclick="s5SelectThumb(\\''+_e(f.file)+'\\')">'
        + '<img src="'+_e(f.url)+'" style="width:100%;aspect-ratio:16/9;display:block;object-fit:cover;">'
        + '<div style="padding:5px 8px;font-size:10px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:6px;">'
        + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="'+_e(f.file)+'">'+_e(f.file)+'</span>'
        + (sel ? '<span style="color:var(--c);font-weight:bold;">✅</span>' : '')
        + '<button onclick="event.stopPropagation();s5DeleteSaved(\\''+_e(f.file)+'\\')" style="background:transparent;border:0;color:var(--c);cursor:pointer;padding:0;font-size:13px;">✕</button>'
        + '</div></div>';
    }).join('');
  }
  window.s5DeleteSaved = async function(file) {
    if (!confirm('削除する？: ' + file)) return;
    const id = postId(); if (!id) return;
    try {
      await fetch('/api/v5/delete-saved?postId=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(file), { method:'DELETE' });
      if (STATE.selectedThumb === file) STATE.selectedThumb = null;
      s5LoadSaved();
    } catch (e) { alert('削除失敗: ' + e.message); }
  };

  // ═══ INIT ═══
  window.step5Init = async function() {
    const post = window.APP && window.APP.selected;
    document.getElementById('s5-postlabel').textContent = post ? '案件: ' + (post.title || post.id) : '案件未選択';
    s5GoSub('ai');
    // meta から既選択サムネを復元
    if (post) {
      try {
        const m = await window.fetchJson('/api/v6/get-meta?postId=' + encodeURIComponent(post.id));
        if (m.selectedThumb) {
          STATE.selectedThumb = m.selectedThumb;
          document.getElementById('s5-selected-status').textContent = '✅ 選択中: ' + m.selectedThumb;
          document.getElementById('s5-selected-status').style.color = 'var(--success)';
        }
      } catch (_) {}
    }
    s5LoadSaved();
  };
})();
</script>
`;
}

module.exports = { router, getUI };
