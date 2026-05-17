// routes/step6_routes.js
// ═══════════════════════════════════════════════════════════
// Step6: 動画投稿（メタデータ編集 + YouTube 投稿）
//   - 📝 メタデータ（タイトル/概要欄/タグ + AI 自動生成 = DeepSeek）
//   - 🚀 YouTube 投稿（Data API v3）
//
// 旧 Step5 から分離（2026-05-10）。
// Step5 はサムネイル AI 生成専用に再編。
//
// ⚠️ OAuth callback URL は /v5/youtube-callback を維持。
//    Google Cloud Console 登録済の redirect URI のため、変えると認証フロー破綻する。
//    その他のルートは /v6/* に統一。
//
// データファイル: 旧来の `{postId}_step5.json` を引き続き使用（後方互換のため）。
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const ROOT_DIR     = path.join(__dirname, '..');
const VIDEOS_BASE  = path.join(ROOT_DIR, 'data', 'v2_videos');
const THUMB_OUT_BASE = path.join(ROOT_DIR, 'data', 'v2_thumbs');
// 2026-05-16: postId に '/' 等を含む Reddit 形式に対応するため、 step4 modulesPath と同様にサニタイズ
//   未サニタイズだと '/r/soccer/comments/.../' でパスが壊れて 404 (投稿メタデータ生成失敗)
const _sanitizePostId = (s) => (s || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
const META_FILE    = (postId) => path.join(ROOT_DIR, 'data', _sanitizePostId(postId) + '_step5.json');
const MODULES_FILE = (postId) => path.join(ROOT_DIR, 'data', _sanitizePostId(postId) + '_modules.json');

const { callAI }       = require('../scripts/ai_client');
const youtubeUploader  = require('../scripts/youtube_uploader');

// ─── 共通: メタ JSON 読み書き ────────────────────
function readMeta(postId) {
  const file = META_FILE(postId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return {}; }
}
function writeMeta(postId, obj) {
  fs.writeFileSync(META_FILE(postId), JSON.stringify(obj, null, 2));
}

// ════════════════════════════════════════════════════════════
// 📝 メタデータ API
// ════════════════════════════════════════════════════════════
router.get('/v6/get-meta', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.json({});
  const m = readMeta(postId);
  res.json({
    title: m.title || '',
    description: m.description || '',
    tags: m.tags || [],
    privacyStatus: m.privacyStatus || 'private',
    selectedThumb: m.selectedThumb || null,
    uploads: m.uploads || [],
  });
});

router.post('/v6/save-meta', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const { title, description, tags, privacyStatus } = req.body || {};
  const meta = readMeta(postId);
  if (title !== undefined) meta.title = title;
  if (description !== undefined) meta.description = description;
  if (tags !== undefined) meta.tags = Array.isArray(tags) ? tags : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if (privacyStatus !== undefined) meta.privacyStatus = privacyStatus;
  writeMeta(postId, meta);
  res.json({ ok: true });
});

router.post('/v6/gen-meta', async (req, res) => {
  const { postId, sprint } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  // ⚡SPRINT モード: 最初から DeepSeek 直行
  const _sprint = !!sprint;
  const _initialProv = _sprint ? 'deepseek' : 'anthropic';

  const mFile = MODULES_FILE(postId);
  if (!fs.existsSync(mFile)) return res.status(404).json({ error: 'modules.json not found' });

  let modules;
  try { modules = JSON.parse(fs.readFileSync(mFile, 'utf8')); }
  catch (_) { return res.status(500).json({ error: 'modules.json parse error' }); }

  const mods = Array.isArray(modules) ? modules : modules.modules || [];
  const opening = mods.find(m => m.type === 'opening' || m.mainKey === 'opening');
  const openingHighlight = opening
    ? `★最重要・オープニングスライド★\n  タイトル: 「${opening.title || ''}」\n  ナレーション: ${opening.narration || ''}\n\n`
    : '';
  const summary = openingHighlight
    + mods.map(m => `[${m.type}] ${m.title || ''} ${m.narration || ''}`).join('\n').slice(0, 4000);

  const sys = `あなたは日本のサッカー解説 YouTuber「5分でサッカー分析」のSNSマーケ担当です。
出力は厳密な JSON のみ。説明文や前置きは絶対に書かない。`;

  const prompt = `以下は動画の構成です。これを元に YouTube 投稿用のタイトル・概要欄・タグを生成してください。

${summary}

要件:
- titles: バズる候補3つ。30文字前後、煽り系・数字入り重視。【】や絵文字を1個入れる。
  ⭐ オープニングタイトルのキーワード（人物名・チーム名・キーフレーズ）を必ず1つ以上使うこと。動画とサムネ・タイトルの一貫性を保つため
- description: 動画の概要欄。3〜5段落、各段落は2〜3行。
  - 1段落: 動画の要点（フック）
  - 2-3段落: 主要データの紹介（数字を含める）
  - 末尾: チャンネル登録誘導 + ハッシュタグ列（#で5-8個）
- tags: YouTube タグ 10〜15個。チーム名/選手名/大会名を中心に、英語混在でOK。

JSON形式で返してください:
{ "titles": ["...", "...", "..."], "description": "...", "tags": ["...", "...", ...] }`;

  async function _ask(provider) {
    const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
    return callAI({ forceProvider: provider, model, max_tokens: 2000, system: sys, messages: [{ role: 'user', content: prompt }] });
  }
  try {
    let text = '', parsed = null;
    try {
      text = await _ask(_initialProv);
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (e) { console.warn(`[step6 meta-gen] ${_initialProv} 例外:`, e.message); }
    if (!parsed && _initialProv !== 'deepseek') {
      console.warn('[step6 meta-gen] sonnet 失敗、deepseek にフォールバック');
      text = await _ask('deepseek');
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }
    if (!parsed) return res.status(500).json({ error: 'AI 応答に JSON 含まれず', raw: text.slice(0, 300) });
    res.json({ ok: true, ...parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// 🚀 投稿系 API
// ════════════════════════════════════════════════════════════
router.get('/v6/list-videos', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.json({ videos: [] });
  if (!fs.existsSync(VIDEOS_BASE)) return res.json({ videos: [] });
  const prefix = String(postId).replace(/[\/\?%*:|"<>\.]/g, '_').slice(-20) + '_';
  const out = [];
  for (const f of fs.readdirSync(VIDEOS_BASE)) {
    if (!/\.mp4$/i.test(f)) continue;
    if (!f.startsWith(prefix)) continue;
    const full = path.join(VIDEOS_BASE, f);
    const stat = fs.statSync(full);
    out.push({
      file: f,
      url: '/v2_videos/' + f,
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  res.json({ videos: out });
});

router.get('/v6/youtube-status', (_req, res) => {
  res.json({ authenticated: youtubeUploader.isAuthenticated() });
});

router.get('/v6/youtube-auth-url', (_req, res) => {
  try {
    const url = youtubeUploader.getAuthUrl();
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ⚠️ OAuth callback URL は /v5/youtube-callback を維持（Google Cloud Console 登録済のため）
router.get('/v5/youtube-callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('code が無い');
  try {
    await youtubeUploader.handleCallback(code);
    res.send(`<!doctype html><meta charset=utf-8>
<div style="text-align:center; padding:40px; font-family:sans-serif;">
<h2 style="color:#10b981;">✅ YouTube 認証完了</h2>
<p>このタブを閉じて、ランチャーに戻ってください。</p>
<script>setTimeout(()=>window.close(),1500);</script>
</div>`);
  } catch (e) {
    res.status(500).send('認証失敗: ' + e.message);
  }
});

router.post('/v6/youtube-upload', async (req, res) => {
  const { postId, videoFile, thumbFile, title, description, tags, privacyStatus } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  if (!videoFile) return res.status(400).json({ error: 'videoFile required' });

  const videoPath = path.join(VIDEOS_BASE, path.basename(videoFile));
  const thumbPath = thumbFile
    ? path.join(THUMB_OUT_BASE, String(postId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80), path.basename(thumbFile))
    : null;

  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: '動画ファイル無し: ' + videoFile });

  try {
    const result = await youtubeUploader.upload({
      videoPath, thumbPath, title, description, tags, privacyStatus,
    });
    const meta = readMeta(postId);
    meta.uploads = meta.uploads || [];
    meta.uploads.unshift({
      videoId: result.videoId,
      url: result.url,
      thumbSet: result.thumbSet,
      title, privacyStatus,
      videoFile, thumbFile,
      uploadedAt: new Date().toISOString(),
    });
    writeMeta(postId, meta);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// UI（メタタブ + 投稿タブ）
// ════════════════════════════════════════════════════════════
function getUI() {
  return `
<div id="step6" style="display:none; padding:20px;">
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
    <h2 style="color:var(--c); font-size:18px; letter-spacing:1px;">6. 動画投稿</h2>
    <span id="s6-postlabel" style="color:var(--muted); font-size:12px;"></span>
    <span id="s6-yt-status" style="margin-left:auto; font-size:11px; color:var(--muted);"></span>
  </div>

  <!-- サブタブ -->
  <div id="s6-subnav" style="display:flex; gap:4px; margin-bottom:14px; border-bottom:1px solid var(--border);">
    <button onclick="s6GoSub('meta')"  id="s6sub-meta"  class="s6sub active">📝 メタデータ</button>
    <button onclick="s6GoSub('post')"  id="s6sub-post"  class="s6sub">🚀 投稿</button>
  </div>
  <style>
    .s6sub { background:transparent; color:var(--muted); border:0; padding:9px 14px; cursor:pointer;
             font-size:12px; font-weight:bold; border-bottom:2px solid transparent; }
    .s6sub:hover { color: var(--text); }
    .s6sub.active { color: var(--c); border-bottom-color: var(--c); }
    .s6card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:12px; }
    .s6label { display:block; font-size:11px; color:var(--muted); margin:8px 0 3px; }
    .s6input { width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border);
               padding:7px 10px; border-radius:4px; font-size:12px; }
    .s6btn { background:var(--c); color:#fff; border:0; padding:8px 16px; border-radius:6px;
             cursor:pointer; font-weight:bold; font-size:12px; }
    .s6btn-sub { background:var(--panel); color:var(--text); border:1px solid var(--border);
                 padding:7px 14px; border-radius:6px; cursor:pointer; font-size:12px; }
  </style>

  <!-- ───── 📝 メタデータ ───── -->
  <div id="s6pane-meta" class="s6pane">
    <div class="s6card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
        <strong style="color:var(--c); font-size:12px;">📝 投稿メタデータ</strong>
        <button onclick="s6GenMeta()" class="s6btn-sub" id="s6-gen-meta-btn">✨ AI 自動生成（Sonnet → DeepSeek フォールバック）</button>
        <span id="s6-meta-status" style="font-size:11px; color:var(--muted);"></span>
      </div>
      <div id="s6-title-candidates" style="display:none; padding:8px; background:#0a0e1a; border:1px dashed var(--border); border-radius:4px; margin-bottom:10px;"></div>
      <label class="s6label">タイトル（YouTube 投稿時の動画タイトル / 100文字以内）</label>
      <input type="text" id="s6-title" class="s6input" maxlength="100">
      <label class="s6label">概要欄（5000文字以内）</label>
      <textarea id="s6-description" rows="10" class="s6input" style="resize:vertical;"></textarea>
      <label class="s6label">タグ（カンマ区切り）</label>
      <input type="text" id="s6-tags" class="s6input" placeholder="タグ1, タグ2, ...">
      <label class="s6label">公開設定</label>
      <select id="s6-privacy" class="s6input" style="width:auto;">
        <option value="private">private（非公開）</option>
        <option value="unlisted">unlisted（限定公開）</option>
        <option value="public">public（公開）</option>
      </select>
      <div style="margin-top:14px;"><button onclick="s6SaveMeta()" class="s6btn">💾 保存</button></div>
    </div>
  </div>

  <!-- ───── 🚀 投稿 ───── -->
  <div id="s6pane-post" class="s6pane" style="display:none;">
    <div class="s6card" id="s6-yt-auth-card" style="display:none;">
      <strong style="color:var(--c); font-size:12px;">🔐 YouTube 認証が必要</strong>
      <p style="margin:8px 0; font-size:12px; color:var(--muted);">
        既存の <code>.youtube_tokens.json</code> が見つからない、または期限切れです。
      </p>
      <button onclick="s6StartAuth()" class="s6btn">🔓 認証ウィンドウを開く</button>
    </div>

    <div class="s6card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:10px;">🎞 動画ファイルを選択</strong>
      <div id="s6-video-list" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:8px;"></div>
      <div style="margin-top:6px; font-size:11px; color:var(--muted);" id="s6-video-selected">未選択</div>
    </div>
    <div class="s6card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:10px;">🖼 サムネを選択（Step5 で生成・選択したものから）</strong>
      <div id="s6-thumb-list" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:8px;"></div>
      <div style="margin-top:6px; font-size:11px; color:var(--muted);" id="s6-thumb-selected">未選択（サムネ無しでもOK）</div>
    </div>
    <div class="s6card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:6px;">📋 投稿前確認</strong>
      <div id="s6-post-summary" style="font-size:12px; color:var(--text); line-height:1.6;"></div>
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button onclick="s6DoUpload()" id="s6-upload-btn" class="s6btn">🚀 YouTube に投稿</button>
        <span id="s6-upload-status" style="font-size:11px; color:var(--muted); align-self:center;"></span>
      </div>
    </div>
    <div class="s6card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:6px;">📜 投稿履歴</strong>
      <div id="s6-upload-history" style="font-size:12px; color:var(--text);"></div>
    </div>
  </div>
</div>

<script>
(function() {
  if (window.__s6Init) return; window.__s6Init = true;

  const STATE = {
    sub: 'meta',
    selectedVideo: null,
    selectedThumb: null,
    meta: { title: '', description: '', tags: [], privacyStatus: 'private' },
  };

  function _e(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function postId() { return window.APP && window.APP.selected ? window.APP.selected.id : null; }

  window.s6GoSub = function(name) {
    STATE.sub = name;
    ['meta','post'].forEach(n => {
      const btn = document.getElementById('s6sub-' + n);
      const pane = document.getElementById('s6pane-' + n);
      if (btn) btn.className = 's6sub' + (n === name ? ' active' : '');
      if (pane) pane.style.display = (n === name ? '' : 'none');
    });
    if (name === 'meta') loadMeta();
    if (name === 'post') initPostPane();
  };

  // ═══ 📝 メタデータ ═══
  async function loadMeta() {
    const id = postId(); if (!id) return;
    try {
      const r = await window.fetchJson('/api/v6/get-meta?postId=' + encodeURIComponent(id));
      STATE.meta = { title: r.title || '', description: r.description || '', tags: r.tags || [], privacyStatus: r.privacyStatus || 'private' };
      document.getElementById('s6-title').value = STATE.meta.title;
      document.getElementById('s6-description').value = STATE.meta.description;
      document.getElementById('s6-tags').value = (STATE.meta.tags || []).join(', ');
      document.getElementById('s6-privacy').value = STATE.meta.privacyStatus;
    } catch (e) { console.error(e); }
  }
  window.s6SaveMeta = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const body = {
      title: document.getElementById('s6-title').value,
      description: document.getElementById('s6-description').value,
      tags: document.getElementById('s6-tags').value.split(',').map(t=>t.trim()).filter(Boolean),
      privacyStatus: document.getElementById('s6-privacy').value,
    };
    try {
      await window.fetchJson('/api/v6/save-meta?postId=' + encodeURIComponent(id), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      STATE.meta = body;
      document.getElementById('s6-meta-status').textContent = '✅ 保存完了';
      document.getElementById('s6-meta-status').style.color = 'var(--success)';
    } catch (e) { alert('保存失敗: ' + e.message); }
  };
  window.s6GenMeta = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s6-gen-meta-btn');
    btn.disabled = true; btn.textContent = '⏳ 生成中…';
    document.getElementById('s6-meta-status').textContent = 'AI にお願い中…';
    try {
      const r = await window.fetchJson('/api/v6/gen-meta', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ postId: id, sprint: localStorage.getItem('v2_sprint_mode') === '1' }) });
      const candEl = document.getElementById('s6-title-candidates');
      candEl.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:6px;">💡 タイトル候補（クリックで採用）</div>'
        + (r.titles || []).map((t,i) => '<div onclick="document.getElementById(\\'s6-title\\').value = this.dataset.t" data-t="'+_e(t)+'" style="cursor:pointer;padding:6px 10px;background:var(--panel);border:1px solid var(--border);border-radius:4px;margin-bottom:4px;font-size:12px;">'+(i+1)+'. '+_e(t)+'</div>').join('');
      candEl.style.display = '';
      if (r.titles && r.titles[0] && !document.getElementById('s6-title').value) document.getElementById('s6-title').value = r.titles[0];
      if (r.description) document.getElementById('s6-description').value = r.description;
      if (r.tags) document.getElementById('s6-tags').value = r.tags.join(', ');
      document.getElementById('s6-meta-status').textContent = '✅ 生成完了（保存ボタンで反映）';
      document.getElementById('s6-meta-status').style.color = 'var(--success)';
    } catch (e) {
      document.getElementById('s6-meta-status').textContent = '❌ 生成失敗: ' + e.message;
      document.getElementById('s6-meta-status').style.color = 'var(--c)';
    } finally {
      btn.disabled = false; btn.textContent = '✨ AI 自動生成（Sonnet → DeepSeek フォールバック）';
    }
  };

  // ═══ 🚀 投稿 ═══
  async function checkYouTubeAuth() {
    try {
      const r = await window.fetchJson('/api/v6/youtube-status');
      const card = document.getElementById('s6-yt-auth-card');
      const status = document.getElementById('s6-yt-status');
      if (r.authenticated) {
        card.style.display = 'none';
        status.textContent = '🔓 YouTube 認証済み';
        status.style.color = 'var(--success)';
      } else {
        card.style.display = '';
        status.textContent = '🔒 YouTube 未認証';
        status.style.color = 'var(--c)';
      }
    } catch (_) {}
  }
  window.s6StartAuth = async function() {
    try {
      const r = await window.fetchJson('/api/v6/youtube-auth-url');
      // 2026-05-17: ポップアップブロック対策。 _blank で新タブを開く + 失敗時は同タブ遷移
      let w = null;
      try { w = window.open(r.url, '_blank'); } catch (_) {}
      if (!w || w.closed || typeof w.closed === 'undefined') {
        // ポップアップブロックされた → カード内にクリック可能なリンクを表示
        const card = document.getElementById('s6-yt-auth-card');
        if (card) {
          card.insertAdjacentHTML('beforeend',
            '<div style="margin-top:10px;font-size:12px;color:var(--c);">'
            + '⚠️ ポップアップブロックされました。 下記リンクを<b>右クリック → 新しいタブで開く</b>でも OK：<br>'
            + '<a href="' + r.url + '" target="_blank" rel="noopener" '
            + 'style="color:var(--c);word-break:break-all;text-decoration:underline;">' + r.url + '</a>'
            + '</div>');
        } else {
          // フォールバック：同タブで遷移
          window.location.href = r.url;
        }
        return;
      }
      // ポップアップ open 成功 → 閉じたら認証 status 再チェック
      const tm = setInterval(() => {
        if (w && w.closed) { clearInterval(tm); checkYouTubeAuth(); }
      }, 1000);
    } catch (e) { alert('認証URL取得失敗: ' + e.message); }
  };

  async function initPostPane() {
    await checkYouTubeAuth();
    await loadVideoList();
    await loadThumbListForPost();
    updatePostSummary();
    await loadUploadHistory();
  }
  async function loadVideoList() {
    const id = postId(); if (!id) return;
    try {
      const r = await window.fetchJson('/api/v6/list-videos?postId=' + encodeURIComponent(id));
      const el = document.getElementById('s6-video-list');
      if (!r.videos.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;">動画なし（Step4で生成して）</div>'; return; }
      el.innerHTML = r.videos.map(v => {
        const sel = (STATE.selectedVideo && STATE.selectedVideo.file === v.file);
        const sizeStr = (v.size / 1024 / 1024).toFixed(1) + 'MB';
        return '<div onclick="s6PickVideo(\\''+_e(v.file)+'\\')" style="cursor:pointer;background:var(--panel);border:2px solid '+(sel?'var(--c)':'var(--border)')+';border-radius:6px;padding:8px;font-size:11px;">'
          + '<video src="'+v.url+'" preload="none" controls style="width:100%;aspect-ratio:16/9;display:block;background:#000;border-radius:4px;margin-bottom:6px;"></video>'
          + '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);" title="'+_e(v.file)+'">'+_e(v.file)+'</div>'
          + '<div style="color:var(--muted);font-size:10px;">'+sizeStr+'</div></div>';
      }).join('');
    } catch (e) { console.error(e); }
  }
  window.s6PickVideo = function(file) {
    STATE.selectedVideo = { file };
    document.getElementById('s6-video-selected').textContent = '✅ 選択: ' + file;
    document.getElementById('s6-video-selected').style.color = 'var(--success)';
    loadVideoList(); updatePostSummary();
  };
  async function loadThumbListForPost() {
    // Step5 の /api/v5/list-saved を再利用してサムネ一覧取得
    const id = postId() || '_unsorted';
    try {
      const r = await window.fetchJson('/api/v5/list-saved?postId=' + encodeURIComponent(id));
      const el = document.getElementById('s6-thumb-list');
      if (!r.files.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;">サムネ未保存（Step5 で生成して）</div>'; return; }
      // Step5 の selectedThumb を初期値にする
      try {
        const m = await window.fetchJson('/api/v6/get-meta?postId=' + encodeURIComponent(id));
        if (m.selectedThumb && !STATE.selectedThumb) STATE.selectedThumb = { file: m.selectedThumb };
      } catch (_) {}
      el.innerHTML = r.files.map(f => {
        const sel = (STATE.selectedThumb && STATE.selectedThumb.file === f.file);
        return '<div onclick="s6PickThumb(\\''+_e(f.file)+'\\')" style="cursor:pointer;background:var(--panel);border:2px solid '+(sel?'var(--c)':'var(--border)')+';border-radius:6px;padding:6px;">'
          + '<img src="'+_e(f.url)+'" style="width:100%;aspect-ratio:16/9;display:block;object-fit:cover;border-radius:4px;">'
          + '<div style="padding:3px 4px;font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+_e(f.file)+'">'+_e(f.file)+'</div></div>';
      }).join('');
    } catch (e) { console.error(e); }
  }
  window.s6PickThumb = function(file) {
    STATE.selectedThumb = { file };
    document.getElementById('s6-thumb-selected').textContent = '✅ 選択: ' + file;
    document.getElementById('s6-thumb-selected').style.color = 'var(--success)';
    loadThumbListForPost(); updatePostSummary();
  };
  function updatePostSummary() {
    const lines = [];
    lines.push('動画: ' + (STATE.selectedVideo ? STATE.selectedVideo.file : '（未選択）'));
    lines.push('サムネ: ' + (STATE.selectedThumb ? STATE.selectedThumb.file : '（無し）'));
    const meta = {
      title: document.getElementById('s6-title') ? document.getElementById('s6-title').value : '',
      description: document.getElementById('s6-description') ? document.getElementById('s6-description').value : '',
      tags: document.getElementById('s6-tags') ? document.getElementById('s6-tags').value : '',
      privacy: document.getElementById('s6-privacy') ? document.getElementById('s6-privacy').value : 'private',
    };
    lines.push('タイトル: ' + (meta.title || '（未入力）'));
    lines.push('概要欄: ' + (meta.description ? meta.description.slice(0, 80) + '...' : '（未入力）'));
    lines.push('タグ: ' + (meta.tags || '（未入力）'));
    lines.push('公開設定: ' + meta.privacy);
    document.getElementById('s6-post-summary').innerHTML = lines.map(_e).join('<br>');
  }
  window.s6DoUpload = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    if (!STATE.selectedVideo) { alert('動画ファイルを選択して'); return; }
    const meta = {
      title: document.getElementById('s6-title').value,
      description: document.getElementById('s6-description').value,
      tags: document.getElementById('s6-tags').value.split(',').map(t=>t.trim()).filter(Boolean),
      privacyStatus: document.getElementById('s6-privacy').value,
    };
    if (!meta.title) { alert('タイトル必須'); return; }
    const ok = confirm('このまま YouTube に投稿します。OK?\\n\\n動画: '+STATE.selectedVideo.file+'\\nタイトル: '+meta.title+'\\n公開: '+meta.privacyStatus);
    if (!ok) return;

    const btn = document.getElementById('s6-upload-btn');
    const status = document.getElementById('s6-upload-status');
    btn.disabled = true; btn.textContent = '⏳ アップロード中…';
    status.textContent = 'アップロード処理中（数分かかる場合あり）';
    status.style.color = 'var(--muted)';
    try {
      const r = await window.fetchJson('/api/v6/youtube-upload', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
        postId: id,
        videoFile: STATE.selectedVideo.file,
        thumbFile: STATE.selectedThumb ? STATE.selectedThumb.file : null,
        title: meta.title, description: meta.description, tags: meta.tags, privacyStatus: meta.privacyStatus,
      }) });
      status.innerHTML = '✅ 投稿完了！ <a href="'+_e(r.url)+'" target="_blank" style="color:var(--c);">'+_e(r.url)+'</a>';
      status.style.color = 'var(--success)';
      await loadUploadHistory();
    } catch (e) {
      status.textContent = '❌ 失敗: ' + e.message;
      status.style.color = 'var(--c)';
    } finally {
      btn.disabled = false; btn.textContent = '🚀 YouTube に投稿';
    }
  };
  async function loadUploadHistory() {
    const id = postId(); if (!id) return;
    try {
      const r = await window.fetchJson('/api/v6/get-meta?postId=' + encodeURIComponent(id));
      const uploads = r.uploads || [];
      const el = document.getElementById('s6-upload-history');
      if (!uploads.length) { el.textContent = '（投稿履歴なし）'; return; }
      el.innerHTML = uploads.map(u =>
        '<div style="border-bottom:1px solid var(--border);padding:6px 0;">'
        + '<a href="'+_e(u.url)+'" target="_blank" style="color:var(--c);">'+_e(u.title || u.videoId)+'</a>'
        + ' <span style="color:var(--muted);font-size:11px;">'+_e(u.privacyStatus)+' / '+_e(u.uploadedAt)+'</span></div>'
      ).join('');
    } catch (_) {}
  }

  // ═══ INIT ═══
  window.step6Init = function() {
    const post = window.APP && window.APP.selected;
    document.getElementById('s6-postlabel').textContent = post ? '案件: ' + (post.title || post.id) : '案件未選択';
    s6GoSub('meta');  // デフォルトはメタデータタブ
  };
})();
</script>
`;
}

module.exports = { router, getUI };
