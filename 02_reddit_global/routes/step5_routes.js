// routes/step5_routes.js
// ═══════════════════════════════════════════════════════════
// Step5: 投稿準備
//   - 🎨 サムネ作成 (A/D/L/N/O 5テンプレ)
//   - 🎬 OP/ED 選択 (V1/V2/V3)
//   - 📝 メタデータ (タイトル/概要欄/タグ + AI 自動生成)
//   - 🚀 YouTube 投稿 (Data API v3)
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const TEMPLATES = {
  A: { name: 'A: データ強調',     build: require('../scripts/v2_thumb/templates/dataHero').buildDataHeroThumb },
  D: { name: 'D: 問いかけ',       build: require('../scripts/v2_thumb/templates/question').buildQuestionThumb },
  L: { name: 'L: BREAKING',      build: require('../scripts/v2_thumb/templates/viralData').buildViralDataThumb },
  N: { name: 'N: マガジン',      build: require('../scripts/v2_thumb/templates/magazineCover').buildMagazineCoverThumb },
  O: { name: 'O: トレカ',        build: require('../scripts/v2_thumb/templates/tradingCard').buildTradingCardThumb },
};

const ROOT_DIR = path.join(__dirname, '..');
const THUMB_OUT_BASE = path.join(ROOT_DIR, 'data', 'v2_thumbs');
const VIDEOS_BASE = path.join(ROOT_DIR, 'data', 'v2_videos');
const STEP5_FILE = (postId) => path.join(ROOT_DIR, 'data', `${postId}_step5.json`);
const MODULES_FILE = (postId) => path.join(ROOT_DIR, 'data', `${postId}_modules.json`);

const { callAI } = require('../scripts/ai_client');
const youtubeUploader = require('../scripts/youtube_uploader');

// ── 共通: step5_meta JSON 読み書き ─
function readStep5(postId) {
  const file = STEP5_FILE(postId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return {}; }
}
function writeStep5(postId, obj) {
  fs.writeFileSync(STEP5_FILE(postId), JSON.stringify(obj, null, 2));
}

// ════════════════════════════════════════════════════════════
// 🎨 サムネ系 API
// ════════════════════════════════════════════════════════════

router.post('/v5/thumb-preview', (req, res) => {
  const { template, data } = req.body || {};
  const t = TEMPLATES[template];
  if (!t) return res.status(400).send('unknown template: ' + template);
  try { res.type('html').send(t.build(data || {})); }
  catch (e) { res.status(500).send('build error: ' + e.message); }
});

router.post('/v5/thumb-save', async (req, res) => {
  const { template, data, postId, label } = req.body || {};
  const t = TEMPLATES[template];
  if (!t) return res.status(400).json({ error: 'unknown template' });

  let html;
  try { html = t.build(data || {}); }
  catch (e) { return res.status(500).json({ error: 'build error: ' + e.message }); }

  const safePostId = String(postId || '_unsorted').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const safeLabel = String(label || 'thumb').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const outDir = path.join(THUMB_OUT_BASE, safePostId);
  fs.mkdirSync(outDir, { recursive: true });
  const filename = `${template}_${safeLabel || 'thumb'}_${Date.now()}.png`;
  const outPath = path.join(outDir, filename);

  let browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.evaluateHandle('document.fonts.ready');
    await page.screenshot({ path: outPath, type: 'png', clip: { x: 0, y: 0, width: 1280, height: 720 } });
    await browser.close();
    res.json({ ok: true, file: filename, url: `/v2_thumbs/${safePostId}/${filename}`, size: fs.statSync(outPath).size });
  } catch (e) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    res.status(500).json({ error: e.message });
  }
});

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

router.get('/v5/list-saved', (req, res) => {
  const { postId } = req.query;
  const safePostId = String(postId || '_unsorted').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const dir = path.join(THUMB_OUT_BASE, safePostId);
  if (!fs.existsSync(dir)) return res.json({ files: [] });
  const files = fs.readdirSync(dir)
    .filter(f => /\.png$/i.test(f))
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

// ════════════════════════════════════════════════════════════
// 📝 メタデータ API
// ════════════════════════════════════════════════════════════

router.get('/v5/get-meta', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.json({});
  const m = readStep5(postId);
  res.json({
    title: m.title || '',
    description: m.description || '',
    tags: m.tags || [],
    privacyStatus: m.privacyStatus || 'private',
  });
});

router.post('/v5/save-meta', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const { title, description, tags, privacyStatus } = req.body || {};
  const meta = readStep5(postId);
  if (title !== undefined) meta.title = title;
  if (description !== undefined) meta.description = description;
  if (tags !== undefined) meta.tags = Array.isArray(tags) ? tags : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if (privacyStatus !== undefined) meta.privacyStatus = privacyStatus;
  writeStep5(postId, meta);
  res.json({ ok: true });
});

router.post('/v5/gen-meta', async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });

  // modules.json から構成情報を抽出
  const mFile = MODULES_FILE(postId);
  if (!fs.existsSync(mFile)) return res.status(404).json({ error: 'modules.json not found' });
  let modules;
  try { modules = JSON.parse(fs.readFileSync(mFile, 'utf8')); }
  catch (e) { return res.status(500).json({ error: 'modules.json parse error' }); }

  // ナレ + タイトルを抽出
  const summary = (Array.isArray(modules) ? modules : modules.modules || [])
    .map(m => `[${m.type}] ${m.title || ''} ${m.narration || ''}`)
    .join('\n')
    .slice(0, 4000);

  const sys = `あなたは日本のサッカー解説 YouTuber「5分でサッカー分析」のSNSマーケ担当です。
出力は厳密な JSON のみ。説明文や前置きは絶対に書かない。`;

  const prompt = `以下は動画の構成です。これを元に YouTube 投稿用のタイトル・概要欄・タグを生成してください。

${summary}

要件:
- titles: バズる候補3つ。30文字前後、煽り系・数字入り重視。【】や絵文字を1個入れる。
- description: 動画の概要欄。3〜5段落、各段落は2〜3行。
  - 1段落: 動画の要点（フック）
  - 2-3段落: 主要データの紹介（数字を含める）
  - 末尾: チャンネル登録誘導 + ハッシュタグ列（#で5-8個）
- tags: YouTube タグ 10〜15個。チーム名/選手名/大会名を中心に、英語混在でOK。

JSON形式で返してください:
{ "titles": ["...", "...", "..."], "description": "...", "tags": ["...", "...", ...] }`;

  try {
    const text = await callAI({
      model: 'deepseek-chat',
      max_tokens: 2000,
      forceProvider: 'deepseek',
      system: sys,
      messages: [{ role: 'user', content: prompt }],
    });
    // JSON 抽出
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'AI 応答に JSON 含まれず', raw: text.slice(0, 300) });
    const parsed = JSON.parse(m[0]);
    res.json({ ok: true, ...parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// 🚀 投稿系 API
// ════════════════════════════════════════════════════════════

router.get('/v5/list-videos', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.json({ videos: [] });
  if (!fs.existsSync(VIDEOS_BASE)) return res.json({ videos: [] });
  const out = [];
  for (const f of fs.readdirSync(VIDEOS_BASE)) {
    if (!/\.mp4$/i.test(f)) continue;
    // ファイル名に postId 関連のキーワードが含まれてるか緩くマッチ
    // V2 では `{postId(短)}_{timestamp}.mp4` 形式想定だが、表記揺れがあるので全mp4返す
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

router.get('/v5/youtube-status', (_req, res) => {
  res.json({ authenticated: youtubeUploader.isAuthenticated() });
});

router.get('/v5/youtube-auth-url', (_req, res) => {
  try {
    const url = youtubeUploader.getAuthUrl();
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OAuth 認証コールバック（Google 側からブラウザ経由でリダイレクトされる）
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

router.post('/v5/youtube-upload', async (req, res) => {
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
    // Step5 メタに記録
    const meta = readStep5(postId);
    meta.uploads = meta.uploads || [];
    meta.uploads.unshift({
      videoId: result.videoId,
      url: result.url,
      thumbSet: result.thumbSet,
      title, privacyStatus,
      videoFile, thumbFile,
      uploadedAt: new Date().toISOString(),
    });
    writeStep5(postId, meta);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// UI
// ════════════════════════════════════════════════════════════
function getUI() {
  return `
<div id="step5" style="display:none; padding:20px;">
  <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
    <h2 style="color:var(--c); font-size:18px; letter-spacing:1px;">5. 投稿準備</h2>
    <span id="s5-postlabel" style="color:var(--muted); font-size:12px;"></span>
    <span id="s5-yt-status" style="margin-left:auto; font-size:11px; color:var(--muted);"></span>
  </div>

  <!-- サブタブ -->
  <div id="s5-subnav" style="display:flex; gap:4px; margin-bottom:14px; border-bottom:1px solid var(--border);">
    <button onclick="s5GoSub('thumb')" id="s5sub-thumb" class="s5sub active">🎨 サムネ</button>
    <button onclick="s5GoSub('meta')"  id="s5sub-meta"  class="s5sub">📝 メタデータ</button>
    <button onclick="s5GoSub('post')"  id="s5sub-post"  class="s5sub">🚀 投稿</button>
  </div>
  <style>
    .s5sub { background:transparent; color:var(--muted); border:0; padding:9px 14px; cursor:pointer;
             font-size:12px; font-weight:bold; border-bottom:2px solid transparent; }
    .s5sub:hover { color: var(--text); }
    .s5sub.active { color: var(--c); border-bottom-color: var(--c); }
    .s5card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:12px; }
    .s5label { display:block; font-size:11px; color:var(--muted); margin:8px 0 3px; }
    .s5input { width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border);
               padding:7px 10px; border-radius:4px; font-size:12px; }
    .s5btn { background:var(--c); color:#fff; border:0; padding:8px 16px; border-radius:6px;
             cursor:pointer; font-weight:bold; font-size:12px; }
    .s5btn-sub { background:var(--panel); color:var(--text); border:1px solid var(--border);
                 padding:7px 14px; border-radius:6px; cursor:pointer; font-size:12px; }
  </style>

  <!-- ───── 🎨 サムネ ───── -->
  <div id="s5pane-thumb" class="s5pane">
    <div id="s5-tabs" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px;"></div>
    <div style="display:grid; grid-template-columns: minmax(360px, 1fr) minmax(560px, 1.2fr); gap:18px;">
      <div>
        <div id="s5-form" class="s5card"></div>
        <div class="s5card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <strong style="color:var(--c); font-size:12px;">📷 案件の画像</strong>
            <button onclick="s5LoadImages()" class="s5btn-sub" style="padding:3px 10px; font-size:11px;">↻ 再読込</button>
          </div>
          <div id="s5-images" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap:6px; max-height:300px; overflow-y:auto;"></div>
          <div id="s5-image-target" style="margin-top:8px; font-size:11px; color:var(--muted);">画像枠をクリックしてから候補を選択</div>
        </div>
      </div>
      <div>
        <div style="position:relative; aspect-ratio:16/9; background:#000; border:2px solid var(--border); border-radius:8px; overflow:hidden;">
          <iframe id="s5-preview" style="position:absolute; top:0; left:0; width:1280px; height:720px; border:0; transform-origin:top left;"></iframe>
        </div>
        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
          <input type="text" id="s5-savelabel" placeholder="保存ラベル（任意）" class="s5input" style="flex:1; min-width:120px;">
          <button onclick="s5Save()" class="s5btn">💾 PNG 保存</button>
          <button onclick="s5RefreshPreview()" class="s5btn-sub">🔄 プレビュー更新</button>
        </div>
        <div id="s5-saved-list" style="margin-top:14px;"></div>
      </div>
    </div>
  </div>

  <!-- ───── 📝 メタデータ ───── -->
  <div id="s5pane-meta" class="s5pane" style="display:none;">
    <div class="s5card">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
        <strong style="color:var(--c); font-size:12px;">📝 投稿メタデータ</strong>
        <button onclick="s5GenMeta()" class="s5btn-sub" id="s5-gen-meta-btn">✨ AI 自動生成（DeepSeek）</button>
        <span id="s5-meta-status" style="font-size:11px; color:var(--muted);"></span>
      </div>
      <div id="s5-title-candidates" style="display:none; padding:8px; background:#0a0e1a; border:1px dashed var(--border); border-radius:4px; margin-bottom:10px;"></div>
      <label class="s5label">タイトル（YouTube 投稿時の動画タイトル / 100文字以内）</label>
      <input type="text" id="s5-title" class="s5input" maxlength="100">
      <label class="s5label">概要欄（5000文字以内）</label>
      <textarea id="s5-description" rows="10" class="s5input" style="resize:vertical;"></textarea>
      <label class="s5label">タグ（カンマ区切り）</label>
      <input type="text" id="s5-tags" class="s5input" placeholder="タグ1, タグ2, ...">
      <label class="s5label">公開設定</label>
      <select id="s5-privacy" class="s5input" style="width:auto;">
        <option value="private">private（非公開）</option>
        <option value="unlisted">unlisted（限定公開）</option>
        <option value="public">public（公開）</option>
      </select>
      <div style="margin-top:14px;"><button onclick="s5SaveMeta()" class="s5btn">💾 保存</button></div>
    </div>
  </div>

  <!-- ───── 🚀 投稿 ───── -->
  <div id="s5pane-post" class="s5pane" style="display:none;">
    <div class="s5card" id="s5-yt-auth-card" style="display:none;">
      <strong style="color:var(--c); font-size:12px;">🔐 YouTube 認証が必要</strong>
      <p style="margin:8px 0; font-size:12px; color:var(--muted);">
        既存の <code>.youtube_tokens.json</code> が見つからない、または期限切れです。
      </p>
      <button onclick="s5StartAuth()" class="s5btn">🔓 認証ウィンドウを開く</button>
    </div>

    <div class="s5card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:10px;">🎞 動画ファイルを選択</strong>
      <div id="s5-video-list" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:8px;"></div>
      <div style="margin-top:6px; font-size:11px; color:var(--muted);" id="s5-video-selected">未選択</div>
    </div>
    <div class="s5card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:10px;">🖼 サムネを選択</strong>
      <div id="s5-thumb-list" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:8px;"></div>
      <div style="margin-top:6px; font-size:11px; color:var(--muted);" id="s5-thumb-selected">未選択（サムネ無しでもOK）</div>
    </div>
    <div class="s5card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:6px;">📋 投稿前確認</strong>
      <div id="s5-post-summary" style="font-size:12px; color:var(--text); line-height:1.6;"></div>
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button onclick="s5DoUpload()" id="s5-upload-btn" class="s5btn">🚀 YouTube に投稿</button>
        <span id="s5-upload-status" style="font-size:11px; color:var(--muted); align-self:center;"></span>
      </div>
    </div>
    <div class="s5card">
      <strong style="color:var(--c); font-size:12px; display:block; margin-bottom:6px;">📜 投稿履歴</strong>
      <div id="s5-upload-history" style="font-size:12px; color:var(--text);"></div>
    </div>
  </div>
</div>

<script>
(function() {
  if (window.__s5Init) return; window.__s5Init = true;

  // ═══ 共通 STATE ═══
  const STATE = {
    sub: 'thumb',
    template: 'A',
    data: null,
    images: [],
    activeImageField: null,
    selectedVideo: null,
    selectedThumb: null,
    meta: { title: '', description: '', tags: [], privacyStatus: 'private' },
  };

  // ═══ サムネテンプレ定義 ═══
  const TPL = {
    A: {
      label: 'A: データ強調',
      defaults: { tone: 'dark', heroNumber: '161', heroLabel: '在籍試合', catch: 'タイトルキャッチ', badge: '衝撃', badgeColor: '#ef4444', heroImage: '' },
      fields: [
        { key:'tone', type:'select', options:['dark','light'], label:'tone' },
        { key:'badge', type:'text', label:'バッジ文字（任意）' },
        { key:'badgeColor', type:'color', label:'バッジ色' },
        { key:'heroNumber', type:'text', label:'数字（hero）' },
        { key:'heroLabel', type:'text', label:'数字の意味' },
        { key:'catch', type:'textarea', label:'キャッチ' },
        { key:'heroImage', type:'image', label:'写真（左）' },
      ],
    },
    D: {
      label: 'D: 問いかけ',
      defaults: { tone: 'dark', question: 'なぜ？', subData: 'データ補足', bottomBadge: '5分で解説', bgImage:'', heroImage:'' },
      fields: [
        { key:'tone', type:'select', options:['dark','light'], label:'tone' },
        { key:'question', type:'text', label:'問い' },
        { key:'subData', type:'text', label:'データ補足' },
        { key:'bottomBadge', type:'text', label:'右下バッジ（任意）' },
        { key:'bgImage', type:'image', label:'背景画像' },
        { key:'heroImage', type:'image', label:'右上の顔写真（任意）' },
      ],
    },
    L: {
      label: 'L: BREAKING',
      defaults: { breakingLabel: '衝撃のデータ', title: 'メインタイトル', titleHighlight: '', mainStat: { value: '', label: '' }, subStat: { value: '', label: '' }, heroImage: '' },
      fields: [
        { key:'breakingLabel', type:'text', label:'BREAKINGラベル' },
        { key:'title', type:'text', label:'タイトル（黒帯1行）' },
        { key:'titleHighlight', type:'text', label:'ハイライト（赤2行目・任意）' },
        { key:'mainStat.value', type:'text', label:'数字（中央円）' },
        { key:'mainStat.label', type:'text', label:'数字ラベル' },
        { key:'subStat.value', type:'text', label:'サブ数字（任意）' },
        { key:'subStat.label', type:'text', label:'サブラベル' },
        { key:'heroImage', type:'image', label:'背景写真' },
      ],
    },
    N: {
      label: 'N: マガジン',
      defaults: { issueLabel: 'ISSUE 042', title: 'メインタイトル', subtitle: 'サブタイトル',
        stickers: [{ value: '63%', label: 'xG超過', color: 'red' }, { value: '+5', label: 'Goal Diff', color: 'gold' }, { value: '8.4', label: 'Avg Rating', color: 'green' }],
        heroImage: '' },
      fields: [
        { key:'issueLabel', type:'text', label:'号数' },
        { key:'title', type:'text', label:'メインタイトル' },
        { key:'subtitle', type:'text', label:'サブタイトル' },
        { key:'stickers.0.value', type:'text', label:'ステッカー1: 数字' },
        { key:'stickers.0.label', type:'text', label:'ステッカー1: ラベル' },
        { key:'stickers.0.color', type:'select', options:['red','gold','green','blue'], label:'ステッカー1: 色' },
        { key:'stickers.1.value', type:'text', label:'ステッカー2: 数字' },
        { key:'stickers.1.label', type:'text', label:'ステッカー2: ラベル' },
        { key:'stickers.1.color', type:'select', options:['red','gold','green','blue'], label:'ステッカー2: 色' },
        { key:'stickers.2.value', type:'text', label:'ステッカー3: 数字' },
        { key:'stickers.2.label', type:'text', label:'ステッカー3: ラベル' },
        { key:'stickers.2.color', type:'select', options:['red','gold','green','blue'], label:'ステッカー3: 色' },
        { key:'heroImage', type:'image', label:'背景写真' },
      ],
    },
    O: {
      label: 'O: トレカ',
      defaults: { playerName: '選手名', position: 'POS', team: 'TEAM', overallRating: 89,
        stats: [{ label: 'GOL', value: '0' }, { label: 'AST', value: '0' }, { label: 'RAT', value: '0' }, { label: 'APP', value: '0' }],
        bottomCatch: '', heroImage: '' },
      fields: [
        { key:'playerName', type:'text', label:'選手名' },
        { key:'position', type:'text', label:'ポジション' },
        { key:'team', type:'text', label:'チーム' },
        { key:'overallRating', type:'number', label:'OVR' },
        { key:'stats.0.label', type:'text', label:'スタッツ1 ラベル' },
        { key:'stats.0.value', type:'text', label:'スタッツ1 値' },
        { key:'stats.1.label', type:'text', label:'スタッツ2 ラベル' },
        { key:'stats.1.value', type:'text', label:'スタッツ2 値' },
        { key:'stats.2.label', type:'text', label:'スタッツ3 ラベル' },
        { key:'stats.2.value', type:'text', label:'スタッツ3 値' },
        { key:'stats.3.label', type:'text', label:'スタッツ4 ラベル' },
        { key:'stats.3.value', type:'text', label:'スタッツ4 値' },
        { key:'bottomCatch', type:'text', label:'下キャッチ（任意）' },
        { key:'heroImage', type:'image', label:'写真（左）' },
      ],
    },
  };

  // ═══ 共通ユーティリティ ═══
  function dget(o, k) { return k.split('.').reduce((acc, key) => { if (acc == null) return acc; if (/^\\d+$/.test(key)) return acc[Number(key)]; return acc[key]; }, o); }
  function dset(o, k, v) {
    const parts = k.split('.'); let cur = o;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i], next = parts[i+1]; const idx = /^\\d+$/.test(p) ? Number(p) : p;
      if (cur[idx] == null) cur[idx] = /^\\d+$/.test(next) ? [] : {};
      cur = cur[idx];
    }
    const last = parts[parts.length - 1]; cur[/^\\d+$/.test(last) ? Number(last) : last] = v;
  }
  function _e(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function postId() { return window.APP && window.APP.selected ? window.APP.selected.id : null; }

  // ═══ サブタブ切替 ═══
  window.s5GoSub = function(name) {
    STATE.sub = name;
    ['thumb','meta','post'].forEach(n => {
      const btn = document.getElementById('s5sub-' + n);
      const pane = document.getElementById('s5pane-' + n);
      if (btn) btn.className = 's5sub' + (n === name ? ' active' : '');
      if (pane) pane.style.display = (n === name ? '' : 'none');
    });
    if (name === 'meta') loadMeta();
    if (name === 'post') initPostPane();
  };

  // ═══════════════════════════════════════════════════════
  // 🎨 サムネ
  // ═══════════════════════════════════════════════════════
  function renderThumbTabs() {
    document.getElementById('s5-tabs').innerHTML = Object.entries(TPL).map(([k,t]) => {
      const active = k === STATE.template;
      return '<button onclick="s5SwitchTpl(\\''+k+'\\')" style="background:'+(active?'var(--c)':'var(--panel)')+';color:'+(active?'#fff':'var(--text)')+';border:1px solid '+(active?'var(--c)':'var(--border)')+';padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;">'+t.label+'</button>';
    }).join('');
  }
  window.s5SwitchTpl = function(k) {
    STATE.template = k;
    STATE.data = structuredClone(TPL[k].defaults);
    renderThumbTabs(); renderForm(); refreshPreview();
  };
  function renderForm() {
    const tpl = TPL[STATE.template];
    const html = tpl.fields.map(f => {
      const v = dget(STATE.data, f.key);
      const id = 's5f_' + f.key.replace(/\\./g, '_');
      const lab = '<label class="s5label">'+f.label+'</label>';
      if (f.type === 'select') return lab + '<select id="'+id+'" data-key="'+f.key+'" class="s5input">'+f.options.map(o=>'<option'+(o===v?' selected':'')+'>'+o+'</option>').join('')+'</select>';
      if (f.type === 'textarea') return lab + '<textarea id="'+id+'" data-key="'+f.key+'" rows="2" class="s5input" style="resize:vertical;">'+_e(v)+'</textarea>';
      if (f.type === 'image') return lab + '<div id="'+id+'" data-key="'+f.key+'" onclick="s5SetImageTarget(\\''+f.key+'\\')" style="cursor:pointer;padding:8px 10px;border:2px dashed '+(STATE.activeImageField===f.key?'var(--c)':'var(--border)')+';background:#0a0e1a;border-radius:4px;font-size:11px;color:'+(v?'var(--text)':'var(--muted)')+';word-break:break-all;">'+(v?_e(v):'(クリックして画像を選択)')+'</div>';
      if (f.type === 'color') return lab + '<input type="color" id="'+id+'" data-key="'+f.key+'" value="'+(v||'#ef4444')+'" style="width:100%;background:#0a0e1a;border:1px solid var(--border);padding:2px;border-radius:4px;height:30px;">';
      if (f.type === 'number') return lab + '<input type="number" id="'+id+'" data-key="'+f.key+'" value="'+(v==null?'':v)+'" class="s5input">';
      return lab + '<input type="text" id="'+id+'" data-key="'+f.key+'" value="'+_e(v)+'" class="s5input">';
    }).join('');
    const el = document.getElementById('s5-form');
    el.innerHTML = html;
    el.querySelectorAll('[data-key]').forEach(node => {
      if (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA') {
        node.addEventListener('input', () => {
          const k = node.getAttribute('data-key');
          let v = node.value; if (node.type === 'number') v = v === '' ? null : Number(v);
          dset(STATE.data, k, v); refreshPreviewDebounced();
        });
      }
    });
  }
  window.s5SetImageTarget = function(key) {
    STATE.activeImageField = key;
    document.getElementById('s5-image-target').textContent = '画像セット先: ' + key + '（候補からクリック）';
    renderForm();
  };
  window.s5LoadImages = async function() {
    const id = postId();
    if (!id) { document.getElementById('s5-images').innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px;">案件未選択</div>'; return; }
    try {
      const r = await window.fetchJson('/api/v5/case-images?postId=' + encodeURIComponent(id));
      STATE.images = r.images || []; renderImages();
    } catch (e) { document.getElementById('s5-images').innerHTML = '<div style="color:var(--c);font-size:11px;">読込失敗: '+_e(e.message)+'</div>'; }
  };
  function renderImages() {
    const el = document.getElementById('s5-images');
    if (!STATE.images.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px;">画像なし（Step3.5で取得してから戻ってきて）</div>'; return; }
    el.innerHTML = STATE.images.map(img => {
      const ep = _e(img.path).replace(/\\\\/g,'\\\\\\\\').replace(/\\'/g,'&#39;');
      return '<div onclick="s5PickImage(\\''+ep+'\\')" style="cursor:pointer;border:1px solid var(--border);border-radius:4px;overflow:hidden;background:#000;" title="'+_e(img.label)+'/'+_e(img.file)+'">'
        + '<div style="aspect-ratio:1/1;background:url(/'+_e(img.path)+') center/cover;"></div>'
        + '<div style="padding:3px 5px;font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+_e(img.label)+'</div></div>';
    }).join('');
  }
  window.s5PickImage = function(path) {
    if (!STATE.activeImageField) { alert('先に画像枠（点線）をクリックして選択先を決めて'); return; }
    dset(STATE.data, STATE.activeImageField, path); renderForm(); refreshPreview();
  };
  let lastBlobUrl = null, _previewTimer = null;
  function refreshPreviewDebounced() { clearTimeout(_previewTimer); _previewTimer = setTimeout(refreshPreview, 350); }
  async function refreshPreview() {
    const iframe = document.getElementById('s5-preview'); if (!iframe) return;
    try {
      const res = await fetch('/api/v5/thumb-preview', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ template: STATE.template, data: STATE.data }) });
      const html = await res.text();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      iframe.src = url;
      if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = url; fitThumbIframe();
    } catch (e) { console.error('preview', e); }
  }
  window.s5RefreshPreview = refreshPreview;
  function fitThumbIframe() {
    const iframe = document.getElementById('s5-preview'); if (!iframe) return;
    const w = iframe.parentElement.clientWidth;
    iframe.style.transform = 'scale(' + (w / 1280) + ')';
  }
  window.addEventListener('resize', () => { fitThumbIframe(); });
  window.s5Save = async function() {
    const id = postId() || '_unsorted';
    const labelEl = document.getElementById('s5-savelabel');
    const label = labelEl.value.trim() || (STATE.data.heroNumber || STATE.data.title || STATE.data.playerName || '');
    try {
      const r = await window.fetchJson('/api/v5/thumb-save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ template: STATE.template, data: STATE.data, postId: id, label }) });
      labelEl.value = ''; await loadSavedThumbs(); alert('保存完了: ' + r.file);
    } catch (e) { alert('保存失敗: ' + e.message); }
  };
  async function loadSavedThumbs() {
    const id = postId() || '_unsorted';
    const el = document.getElementById('s5-saved-list');
    try {
      const r = await window.fetchJson('/api/v5/list-saved?postId=' + encodeURIComponent(id));
      if (!r.files.length) { el.innerHTML = ''; return; }
      el.innerHTML = '<div style="color:var(--c);font-size:11px;margin-bottom:6px;font-weight:bold;">💾 保存済みサムネ ('+r.files.length+'件)</div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;">'
        + r.files.map(f => '<div style="background:var(--panel);border:1px solid var(--border);border-radius:6px;overflow:hidden;">'
          + '<a href="'+_e(f.url)+'" target="_blank"><img src="'+_e(f.url)+'" style="width:100%;aspect-ratio:16/9;display:block;object-fit:cover;"></a>'
          + '<div style="padding:5px 8px;font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;justify-content:space-between;gap:6px;">'
          + '<span style="overflow:hidden;text-overflow:ellipsis;" title="'+_e(f.file)+'">'+_e(f.file)+'</span>'
          + '<button onclick="s5DeleteSaved(\\''+_e(f.file)+'\\')" style="background:transparent;border:0;color:var(--c);cursor:pointer;padding:0;font-size:11px;">✕</button>'
          + '</div></div>').join('') + '</div>';
    } catch (e) { el.innerHTML = '<div style="color:var(--c);font-size:11px;">一覧取得失敗: '+_e(e.message)+'</div>'; }
  }
  window.s5DeleteSaved = async function(file) {
    if (!confirm('削除する？: ' + file)) return;
    const id = postId() || '_unsorted';
    try { await fetch('/api/v5/delete-saved?postId=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(file), { method: 'DELETE' }); await loadSavedThumbs(); }
    catch (e) { alert('削除失敗: ' + e.message); }
  };

  // ═══════════════════════════════════════════════════════
  // 📝 メタデータ
  // ═══════════════════════════════════════════════════════
  async function loadMeta() {
    const id = postId(); if (!id) return;
    try {
      const r = await window.fetchJson('/api/v5/get-meta?postId=' + encodeURIComponent(id));
      STATE.meta = { title: r.title || '', description: r.description || '', tags: r.tags || [], privacyStatus: r.privacyStatus || 'private' };
      document.getElementById('s5-title').value = STATE.meta.title;
      document.getElementById('s5-description').value = STATE.meta.description;
      document.getElementById('s5-tags').value = (STATE.meta.tags || []).join(', ');
      document.getElementById('s5-privacy').value = STATE.meta.privacyStatus;
    } catch (e) { console.error(e); }
  }
  window.s5SaveMeta = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const body = {
      title: document.getElementById('s5-title').value,
      description: document.getElementById('s5-description').value,
      tags: document.getElementById('s5-tags').value.split(',').map(t=>t.trim()).filter(Boolean),
      privacyStatus: document.getElementById('s5-privacy').value,
    };
    try {
      await window.fetchJson('/api/v5/save-meta?postId=' + encodeURIComponent(id), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      STATE.meta = body;
      document.getElementById('s5-meta-status').textContent = '✅ 保存完了';
      document.getElementById('s5-meta-status').style.color = 'var(--success)';
    } catch (e) { alert('保存失敗: ' + e.message); }
  };
  window.s5GenMeta = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    const btn = document.getElementById('s5-gen-meta-btn');
    btn.disabled = true; btn.textContent = '⏳ 生成中…';
    document.getElementById('s5-meta-status').textContent = 'DeepSeek にお願い中…';
    try {
      const r = await window.fetchJson('/api/v5/gen-meta', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ postId: id }) });
      // タイトル候補をボックスに表示
      const candEl = document.getElementById('s5-title-candidates');
      candEl.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:6px;">💡 タイトル候補（クリックで採用）</div>'
        + (r.titles || []).map((t,i) => '<div onclick="document.getElementById(\\'s5-title\\').value = this.dataset.t" data-t="'+_e(t)+'" style="cursor:pointer;padding:6px 10px;background:var(--panel);border:1px solid var(--border);border-radius:4px;margin-bottom:4px;font-size:12px;">'+(i+1)+'. '+_e(t)+'</div>').join('');
      candEl.style.display = '';
      if (r.titles && r.titles[0] && !document.getElementById('s5-title').value) document.getElementById('s5-title').value = r.titles[0];
      if (r.description) document.getElementById('s5-description').value = r.description;
      if (r.tags) document.getElementById('s5-tags').value = r.tags.join(', ');
      document.getElementById('s5-meta-status').textContent = '✅ 生成完了（保存ボタンで反映）';
      document.getElementById('s5-meta-status').style.color = 'var(--success)';
    } catch (e) {
      document.getElementById('s5-meta-status').textContent = '❌ 生成失敗: ' + e.message;
      document.getElementById('s5-meta-status').style.color = 'var(--c)';
    } finally {
      btn.disabled = false; btn.textContent = '✨ AI 自動生成（DeepSeek）';
    }
  };

  // ═══════════════════════════════════════════════════════
  // 🚀 投稿
  // ═══════════════════════════════════════════════════════
  async function checkYouTubeAuth() {
    try {
      const r = await window.fetchJson('/api/v5/youtube-status');
      const card = document.getElementById('s5-yt-auth-card');
      const status = document.getElementById('s5-yt-status');
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
  window.s5StartAuth = async function() {
    try {
      const r = await window.fetchJson('/api/v5/youtube-auth-url');
      const w = window.open(r.url, 'ytauth', 'width=600,height=700');
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
      const r = await window.fetchJson('/api/v5/list-videos?postId=' + encodeURIComponent(id));
      const el = document.getElementById('s5-video-list');
      if (!r.videos.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;">動画なし（Step4で生成して）</div>'; return; }
      // case-relevant filter (緩い): postId の最初の数語を含む or 全部
      const idShort = id.replace(/^_r_soccer_comments_/,'').slice(0,30);
      el.innerHTML = r.videos.map(v => {
        const sel = (STATE.selectedVideo && STATE.selectedVideo.file === v.file);
        const sizeStr = (v.size / 1024 / 1024).toFixed(1) + 'MB';
        return '<div onclick="s5PickVideo(\\''+_e(v.file)+'\\')" style="cursor:pointer;background:var(--panel);border:2px solid '+(sel?'var(--c)':'var(--border)')+';border-radius:6px;padding:8px;font-size:11px;">'
          + '<video src="'+v.url+'" style="width:100%;aspect-ratio:16/9;display:block;background:#000;border-radius:4px;margin-bottom:6px;"></video>'
          + '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);" title="'+_e(v.file)+'">'+_e(v.file)+'</div>'
          + '<div style="color:var(--muted);font-size:10px;">'+sizeStr+'</div></div>';
      }).join('');
    } catch (e) { console.error(e); }
  }
  window.s5PickVideo = function(file) {
    STATE.selectedVideo = { file };
    document.getElementById('s5-video-selected').textContent = '✅ 選択: ' + file;
    document.getElementById('s5-video-selected').style.color = 'var(--success)';
    loadVideoList(); updatePostSummary();
  };
  async function loadThumbListForPost() {
    const id = postId() || '_unsorted';
    try {
      const r = await window.fetchJson('/api/v5/list-saved?postId=' + encodeURIComponent(id));
      const el = document.getElementById('s5-thumb-list');
      if (!r.files.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;">サムネ未保存（🎨タブで作って）</div>'; return; }
      el.innerHTML = r.files.map(f => {
        const sel = (STATE.selectedThumb && STATE.selectedThumb.file === f.file);
        return '<div onclick="s5PickThumb(\\''+_e(f.file)+'\\')" style="cursor:pointer;background:var(--panel);border:2px solid '+(sel?'var(--c)':'var(--border)')+';border-radius:6px;padding:6px;">'
          + '<img src="'+_e(f.url)+'" style="width:100%;aspect-ratio:16/9;display:block;object-fit:cover;border-radius:4px;">'
          + '<div style="padding:3px 4px;font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+_e(f.file)+'">'+_e(f.file)+'</div></div>';
      }).join('');
    } catch (e) { console.error(e); }
  }
  window.s5PickThumb = function(file) {
    STATE.selectedThumb = { file };
    document.getElementById('s5-thumb-selected').textContent = '✅ 選択: ' + file;
    document.getElementById('s5-thumb-selected').style.color = 'var(--success)';
    loadThumbListForPost(); updatePostSummary();
  };
  function updatePostSummary() {
    const lines = [];
    lines.push('動画: ' + (STATE.selectedVideo ? STATE.selectedVideo.file : '（未選択）'));
    lines.push('サムネ: ' + (STATE.selectedThumb ? STATE.selectedThumb.file : '（無し）'));
    const meta = {
      title: document.getElementById('s5-title') ? document.getElementById('s5-title').value : '',
      description: document.getElementById('s5-description') ? document.getElementById('s5-description').value : '',
      tags: document.getElementById('s5-tags') ? document.getElementById('s5-tags').value : '',
      privacy: document.getElementById('s5-privacy') ? document.getElementById('s5-privacy').value : 'private',
    };
    lines.push('タイトル: ' + (meta.title || '（未入力）'));
    lines.push('概要欄: ' + (meta.description ? meta.description.slice(0, 80) + '...' : '（未入力）'));
    lines.push('タグ: ' + (meta.tags || '（未入力）'));
    lines.push('公開設定: ' + meta.privacy);
    document.getElementById('s5-post-summary').innerHTML = lines.map(_e).join('<br>');
  }
  window.s5DoUpload = async function() {
    const id = postId(); if (!id) { alert('案件を選択してね'); return; }
    if (!STATE.selectedVideo) { alert('動画ファイルを選択して'); return; }
    // 確認ダイアログ
    const meta = {
      title: document.getElementById('s5-title').value,
      description: document.getElementById('s5-description').value,
      tags: document.getElementById('s5-tags').value.split(',').map(t=>t.trim()).filter(Boolean),
      privacyStatus: document.getElementById('s5-privacy').value,
    };
    if (!meta.title) { alert('タイトル必須'); return; }
    const ok = confirm('このまま YouTube に投稿します。OK?\\n\\n動画: '+STATE.selectedVideo.file+'\\nタイトル: '+meta.title+'\\n公開: '+meta.privacyStatus);
    if (!ok) return;

    const btn = document.getElementById('s5-upload-btn');
    const status = document.getElementById('s5-upload-status');
    btn.disabled = true; btn.textContent = '⏳ アップロード中…';
    status.textContent = 'アップロード処理中（数分かかる場合あり）';
    status.style.color = 'var(--muted)';
    try {
      const r = await window.fetchJson('/api/v5/youtube-upload', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
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
      const r = await window.fetchJson('/api/v5/get-meta?postId=' + encodeURIComponent(id)); // dummy pull
      const meta = await window.fetchJson('/api/v5/get-meta?postId=' + encodeURIComponent(id));
      // _step5.json の uploads を直接読む方が良いが、get-meta は uploads を返さない設計
      // → 既存の保存・削除と同じく fetch で生 step5 を取りに行く（簡易）
      // 別 GET エンドポイントを作るのが望ましいが、当面は scheme で
    } catch (_) {}
    // 別途 history endpoint を後で追加する。当面ノーオプ。
    document.getElementById('s5-upload-history').textContent = '（次回拡張で表示）';
  }

  // ═══════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════
  window.step5Init = function() {
    const post = window.APP && window.APP.selected;
    document.getElementById('s5-postlabel').textContent = post ? '案件: ' + (post.title || post.id) : '案件未選択';
    if (!STATE.data) STATE.data = structuredClone(TPL.A.defaults);
    renderThumbTabs(); renderForm();
    refreshPreview(); s5LoadImages(); loadSavedThumbs();
    checkYouTubeAuth();
    // メタは meta タブ表示時にロード
  };
})();
</script>
`;
}

module.exports = { router, getUI };
