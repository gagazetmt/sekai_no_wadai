// routes/step4_routes.js  (V3 redesign)
// ═══════════════════════════════════════════════════════════
// STEP 4: シナリオ確認 + 微調整 + 動画生成（V3）
//   - V3 module shape を表示・編集
//   - 動画生成 / プレビュー / 単体ナレーション再生成
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

const { callAI } = require('../scripts/ai_client');

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, '..', 'data');
const SI_DIR    = path.join(DATA_DIR, 'si_data');
const VIDEO_DIR = path.join(DATA_DIR, 'v2_videos');
const JOB_DIR   = path.join(DATA_DIR, 'v2_jobs');

[VIDEO_DIR, JOB_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return fallback; }
}
function modulesPath(postId) { return path.join(DATA_DIR, (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '_modules.json'); }
function siPath(postId)      { return path.join(SI_DIR,   (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '.json'); }

// ─── /v2/modules : 読み込み ─────────────────────────────
router.get('/v2/modules', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  res.json(safeJson(modulesPath(postId), { modules: [] }));
});

// ─── /v2/regen-narration : 1カードのナレーション再生成 ─
router.post('/v2/regen-narration', async (req, res) => {
  const { postId, idx } = req.body;
  if (!postId || idx == null) return res.status(400).json({ error: 'postId + idx required' });
  try {
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).json({ error: 'modules not found' });
    const j = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const m = j.modules?.[parseInt(idx, 10)];
    if (!m) return res.status(404).json({ error: 'idx out of range' });

    const si = safeJson(siPath(postId), { boxes: { entity: { items: [] } } });
    const entityCtx = (si.boxes.entity?.items || []).slice(0, 6).map(e => `- ${e.label} [${e.role}]`).join('\n');
    const prompt = `あなたはサッカーYouTubeの脚本家。1枚のスライドのナレーションだけを再生成してください。

【カード情報】
type: ${m.type}
mainKey: ${m.mainKey || '?'}
sub: ${m.subSource || '-'}:${m.subValue || '-'}
title: ${m.title || ''}
脚本指示: ${m.scriptDir || ''}

【既存のデータ（参考、ここから外れない）】
${m.dataSlots?.length ? 'dataSlots: ' + JSON.stringify(m.dataSlots).slice(0, 600) : ''}
${m.catchphrases?.length ? 'catchphrases: ' + JSON.stringify(m.catchphrases) : ''}

【関連entity】
${entityCtx}

【ルール】
- 視聴者に語りかける口調、80〜200文字
- データに無い固有名は出さない
- JSONのみ: {"narration":"..."}`;

    const raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-chat', max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const m1 = raw.match(/\{[\s\S]*\}/);
    if (!m1) return res.status(500).json({ error: 'JSON parse failed' });
    const parsed = JSON.parse(m1[0]);
    if (!parsed.narration) return res.status(500).json({ error: 'narration empty' });
    res.json({ ok: true, narration: parsed.narration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/generate-video : 動画生成ジョブ起動 ────────────
router.post('/v2/generate-video', (req, res) => {
  const { postId, modules } = req.body;
  if (!postId) return res.status(400).json({ error: 'postId required' });

  // モジュールが渡された場合は先に保存
  if (Array.isArray(modules) && modules.length) {
    try { fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2)); }
    catch (e) { console.warn('[Step4] modules保存失敗:', e.message); }
  }

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const jp    = path.join(JOB_DIR, jobId + '.json');
  fs.writeFileSync(jp, JSON.stringify({
    jobId, postId, status: 'queued', createdAt: new Date().toISOString(),
  }, null, 2));

  const renderScript = path.join(__dirname, '..', 'scripts', 'v2_video', 'render.js');
  const proc = spawn('node', [renderScript, postId, jobId], {
    detached: true, stdio: 'ignore', cwd: path.join(__dirname, '..'),
  });
  proc.unref();

  console.log(`[Step4] 動画生成 job 起動: ${jobId} (postId: ${postId})`);
  res.json({ ok: true, jobId });
});

// ─── /v2/video-status : ジョブ進捗 ──────────────────────
router.get('/v2/video-status', (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const jp = path.join(JOB_DIR, jobId + '.json');
  if (!fs.existsSync(jp)) return res.status(404).json({ error: 'job not found' });
  try { res.json(JSON.parse(fs.readFileSync(jp, 'utf8'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── /v2/videos : 生成済み動画一覧 ───────────────────────
router.get('/v2/videos', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const prefix = (postId || '').replace(/[\/\?%*:|"<>\.]/g, '_').slice(-20);
  try {
    const all = fs.readdirSync(VIDEO_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.mp4'));
    const videos = all.map(f => {
      const full = path.join(VIDEO_DIR, f);
      const st   = fs.statSync(full);
      return { file: f, sizeBytes: st.size, createdAt: st.birthtime || st.ctime, url: '/v2_videos/' + f };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ videos });
  } catch (e) { res.json({ videos: [], error: e.message }); }
});

// ─── /v2/preview-slide : 1モジュールのスライドHTML ──────
router.get('/v2/preview-slide', (req, res) => {
  const { postId, idx } = req.query;
  if (!postId) return res.status(400).send('<!doctype html><title>err</title><body>postId required</body>');
  try {
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).send('<!doctype html><title>err</title><body>modules not found</body>');
    const { modules = [] } = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const i = Math.max(0, Math.min(modules.length - 1, parseInt(idx || '0', 10)));
    const mod = modules[i];
    if (!mod) return res.status(404).send('<!doctype html><title>err</title><body>module out of range</body>');

    const { buildOpeningHTML }    = require('../scripts/v2_video/slides/opening');
    const { buildEndingHTML }     = require('../scripts/v2_video/slides/ending');
    const { buildUniversalHTML }  = require('../scripts/v2_video/slides/universal');
    const { buildInsightHTML }    = require('../scripts/v2_video/slides/insight');
    const { buildHistoryHTML }    = require('../scripts/v2_video/slides/history');
    const { buildMatchcardHTML }  = require('../scripts/v2_video/slides/matchcard');
    const { buildProfileHTML }    = require('../scripts/v2_video/slides/profile');
    const { buildStatsHTML }      = require('../scripts/v2_video/slides/stats');
    const { buildComparisonHTML } = require('../scripts/v2_video/slides/comparison');
    const { buildReactionHTML }   = require('../scripts/v2_video/slides/reaction');

    let html;
    switch (mod.type) {
      case 'opening':     html = buildOpeningHTML(mod);     break;
      case 'ending':      html = buildEndingHTML(mod);      break;
      case 'insight':     html = buildInsightHTML(mod);     break;
      case 'history':     html = buildHistoryHTML(mod);     break;
      case 'matchcard':   html = buildMatchcardHTML(mod);   break;
      case 'stats':       html = buildStatsHTML(mod);       break;
      case 'profile':     html = buildProfileHTML(mod);     break;
      case 'comparison':  html = buildComparisonHTML(mod);  break;
      case 'reaction':    html = buildReactionHTML(mod);    break;
      default:            html = buildUniversalHTML(mod);
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) { res.status(500).send('<!doctype html><title>err</title><body>' + e.message + '</body>'); }
});

// ─── UI ─────────────────────────────────────────────────
function getUI() {
  return `
<div id="step4" class="step-container" style="display:none">
<div style="padding:0 20px 20px;">

  <!-- TOP -->
  <div class="panel" style="margin-bottom:12px;">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span id="s4Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">案件未選択</span>
      <button class="btn btn-sm" id="s4BtnSave" style="background:#3b82f6;color:#fff;">💾 保存</button>
      <button class="btn btn-success" id="s4BtnGenVideo" style="font-size:13px;padding:8px 18px;">🎬 動画生成</button>
      <span id="s4Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
  </div>

  <!-- 2カラム: タブ&エディタ / プレビュー -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:flex-start;">

    <!-- 左：タブ + エディタ -->
    <div>
      <div id="s4Tabs" style="display:flex;gap:3px;flex-wrap:wrap;margin-bottom:8px;"></div>
      <div id="s4Editor" class="panel" style="min-height:300px;"></div>
    </div>

    <!-- 右：プレビュー + 動画一覧 -->
    <div>
      <div class="panel" style="padding:10px;">
        <div style="font-size:11px;color:#8a9aba;font-weight:bold;margin-bottom:6px;">🖼️ プレビュー（1920×1080 縮小表示）</div>
        <div id="s4PreviewWrap" style="position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border:1px solid #1a2540;border-radius:6px;background:#000;">
          <iframe id="s4PreviewFrame" scrolling="no" style="position:absolute;top:0;left:0;width:1920px;height:1080px;border:0;transform-origin:top left;"></iframe>
        </div>
      </div>
      <div class="panel" style="margin-top:12px;">
        <div style="font-size:11px;color:#8a9aba;font-weight:bold;margin-bottom:6px;">📦 生成済み動画</div>
        <div id="s4VideoList" style="font-size:11px;color:#5a6a8a;">なし</div>
      </div>
      <div class="panel" style="margin-top:12px;">
        <div style="font-size:11px;color:#8a9aba;font-weight:bold;margin-bottom:6px;">⏳ 動画生成 進捗</div>
        <div id="s4JobStatus" style="font-size:11px;color:#5a6a8a;">未起動</div>
      </div>
    </div>
  </div>
</div>
</div>

<script>
(function() {
  'use strict';
  window.APP = window.APP || {};
  window.APP.s4 = { modules: [], activeTab: 0, currentJobId: null };

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _msg(s) { const el = document.getElementById('s4Msg'); if (el) el.innerHTML = s; }

  /* ── 初期化 ── */
  window.step4Init = async function() {
    const post = window.APP.selected;
    document.getElementById('s4Title').textContent = post
      ? (post.titleJa || post.title || '(タイトル不明)').slice(0, 80)
      : '案件を選択してください';
    if (!post?.id) { _renderTabs(); _renderEditor(); return; }
    try {
      const j = await fetchJson('/api/v2/modules?postId=' + encodeURIComponent(post.id));
      window.APP.s4.modules = j.modules || [];
      window.APP.modules    = window.APP.s4.modules;
    } catch (_) { window.APP.s4.modules = []; }
    _renderTabs();
    _renderEditor();
    _reloadPreview();
    _loadVideos();
  };

  /* ── タブ描画 ── */
  function _renderTabs() {
    const el = document.getElementById('s4Tabs');
    if (!el) return;
    const mods = window.APP.s4.modules || [];
    if (!mods.length) {
      el.innerHTML = '<div style="font-size:11px;color:#5a6a8a;padding:8px;">Step3で脚本を生成してください</div>';
      return;
    }
    el.innerHTML = mods.map(function(m, i) {
      const act = i === window.APP.s4.activeTab;
      return '<div class="s3-tab' + (act ? ' s3-tab-active' : '') + '"'
        + ' onclick="s4Switch(' + i + ')">'
        + '<span style="font-size:9px;opacity:.8">' + (i+1) + '/' + mods.length + '</span><br>'
        + '<span style="font-size:10px;">' + _esc((m.title || '').slice(0,10)) + '</span>'
        + '</div>';
    }).join('');
  }

  /* ── エディタ描画 ── */
  function _renderEditor() {
    const el = document.getElementById('s4Editor');
    const mods = window.APP.s4.modules || [];
    if (!mods.length) {
      el.innerHTML = '<div style="color:#5a6a8a;padding:30px;text-align:center;">「Step3」で脚本を生成してください</div>';
      return;
    }
    const i = window.APP.s4.activeTab;
    const m = mods[i];
    if (!m) return;

    let dataHtml = '';
    if (Array.isArray(m.dataSlots) && m.dataSlots.length) {
      const isCmp = m.type === 'comparison';
      dataHtml = '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">📊 dataSlots</div>'
        + m.dataSlots.map(function(s, idx) {
            if (isCmp) {
              return '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:4px;">'
                + '<input class="inp s4-cmp-label" data-idx="' + idx + '" value="' + _esc(s.label||'') + '" placeholder="LABEL" style="font-size:11px;padding:4px 6px;">'
                + '<input class="inp s4-cmp-left" data-idx="' + idx + '" value="' + _esc(s.leftValue||'') + '" placeholder="左" style="font-size:11px;padding:4px 6px;color:#93c5fd;">'
                + '<input class="inp s4-cmp-right" data-idx="' + idx + '" value="' + _esc(s.rightValue||'') + '" placeholder="右" style="font-size:11px;padding:4px 6px;color:#fca5a5;">'
                + '</div>';
            } else {
              return '<div style="display:grid;grid-template-columns:140px 1fr;gap:6px;margin-bottom:4px;">'
                + '<input class="inp s4-slot-label" data-idx="' + idx + '" value="' + _esc(s.label||'') + '" placeholder="ラベル" style="font-size:11px;padding:4px 6px;">'
                + '<input class="inp s4-slot-value" data-idx="' + idx + '" value="' + _esc(s.value||'') + '" placeholder="値" style="font-size:11px;padding:4px 6px;">'
                + '</div>';
            }
          }).join('');
    }

    let extraHtml = '';
    if (Array.isArray(m.catchphrases) && m.catchphrases.length) {
      extraHtml += '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">🎯 catchphrases</div>'
        + m.catchphrases.map(function(p, idx) {
            return '<input class="inp s4-phrase" data-idx="' + idx + '" value="' + _esc(p) + '" placeholder="キャッチコピー" style="display:block;width:100%;font-size:11px;padding:4px 6px;margin-bottom:4px;">';
          }).join('');
    }
    if (Array.isArray(m.comments) && m.comments.length) {
      extraHtml += '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">💬 comments</div>'
        + m.comments.map(function(c, idx) {
            return '<div style="display:grid;grid-template-columns:1fr 60px;gap:6px;margin-bottom:4px;">'
              + '<input class="inp s4-cmt-text" data-idx="' + idx + '" value="' + _esc(c.text||'') + '" style="font-size:11px;padding:4px 6px;">'
              + '<input type="number" class="inp s4-cmt-score" data-idx="' + idx + '" value="' + (c.score||0) + '" style="font-size:11px;padding:4px 6px;">'
              + '</div>';
          }).join('');
    }

    const ALL_TYPES = ['opening','insight','stats','profile','reaction','comparison','history','matchcard','ending'];
    const typeOpts = ALL_TYPES.map(function(t) {
      return '<option value="' + t + '"' + (m.type === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');

    el.innerHTML = ''
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap;">'
      + '<div style="display:flex;align-items:center;gap:6px;">'
      + '<span style="font-size:11px;color:#94a3b8;">type:</span>'
      + '<select class="inp" id="s4TypeSel" onchange="s4OnTypeChange()" style="font-size:11px;padding:3px 6px;background:#0d1220;color:var(--c);font-weight:bold;">'
      + typeOpts
      + '</select>'
      + '<span style="font-size:10px;color:#5a6a8a;">main=' + _esc(m.mainKey||'?') + (m.subSource ? ' / sub=' + _esc(m.subSource+':'+m.subValue) : '') + '</span>'
      + '</div>'
      + '<button class="btn btn-sm" onclick="s4RegenNarr()" style="background:#3b82f6;color:#fff;font-size:10px;padding:4px 10px;">↻ ナレーション再生成</button>'
      + '</div>'
      + '<div style="font-size:11px;color:#8a9aba;margin-bottom:4px;">タイトル</div>'
      + '<input class="inp" id="s4Title' + i + '" value="' + _esc(m.title||'') + '" oninput="s4OnInput()" style="display:block;width:100%;font-size:13px;padding:6px 8px;margin-bottom:10px;">'
      + '<div style="font-size:11px;color:#8a9aba;margin-bottom:4px;">脚本指示（読み取り専用）</div>'
      + '<pre style="background:#0d1220;padding:6px 8px;border-radius:4px;font-size:10px;color:#94a3b8;margin-bottom:10px;max-height:60px;overflow-y:auto;">' + _esc(m.scriptDir||'(なし)') + '</pre>'
      + '<div style="font-size:11px;color:#8a9aba;margin-bottom:4px;">narration</div>'
      + '<textarea class="inp" id="s4Narr' + i + '" oninput="s4OnInput()" style="display:block;width:100%;font-size:12px;padding:6px 8px;min-height:120px;resize:vertical;">' + _esc(m.narration||'') + '</textarea>'
      + dataHtml
      + extraHtml;
  }

  function _collectInputs() {
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const t = document.getElementById('s4Title' + i);
    const n = document.getElementById('s4Narr' + i);
    if (t) m.title = t.value;
    if (n) m.narration = n.value;

    const isCmp = m.type === 'comparison';
    if (Array.isArray(m.dataSlots)) {
      if (isCmp) {
        const lbl = document.querySelectorAll('.s4-cmp-label');
        const lf  = document.querySelectorAll('.s4-cmp-left');
        const rt  = document.querySelectorAll('.s4-cmp-right');
        m.dataSlots = m.dataSlots.map((s, idx) => ({
          label: lbl[idx]?.value || s.label || '',
          leftValue:  lf[idx]?.value  || s.leftValue  || '',
          rightValue: rt[idx]?.value || s.rightValue || '',
        }));
      } else {
        const ll = document.querySelectorAll('.s4-slot-label');
        const vv = document.querySelectorAll('.s4-slot-value');
        m.dataSlots = m.dataSlots.map((s, idx) => ({
          label: ll[idx]?.value || s.label || '',
          value: vv[idx]?.value || s.value || '',
        }));
      }
    }
    if (Array.isArray(m.catchphrases)) {
      const ps = document.querySelectorAll('.s4-phrase');
      m.catchphrases = Array.from(ps).map(el => el.value);
    }
    if (Array.isArray(m.comments)) {
      const ts = document.querySelectorAll('.s4-cmt-text');
      const ss = document.querySelectorAll('.s4-cmt-score');
      m.comments = m.comments.map((c, idx) => ({
        text:  ts[idx]?.value || c.text || '',
        score: Number(ss[idx]?.value) || 0,
      }));
    }
  }

  /* ── タブ切替 ── */
  window.s4Switch = function(i) {
    _collectInputs();
    window.APP.s4.activeTab = i;
    _renderTabs();
    _renderEditor();
    _reloadPreview();
  };

  /* ── type 手動変更（強制上書き）── */
  window.s4OnTypeChange = function() {
    _collectInputs();
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const sel = document.getElementById('s4TypeSel');
    if (!sel) return;
    const newType = sel.value;
    m.type = newType;
    // 型に対応するフィールドが空なら最低限スケルトン投入（編集UI表示用）
    if (newType === 'insight' && (!m.catchphrases || !m.catchphrases.length)) m.catchphrases = ['', '', ''];
    if (newType === 'reaction' && (!m.comments || !m.comments.length)) {
      m.comments = Array.from({length: 7}, () => ({ text: '', score: 0 }));
    }
    if (['stats','profile','history'].includes(newType) && (!m.dataSlots || !m.dataSlots.length)) {
      m.dataSlots = [{label:'',value:''},{label:'',value:''},{label:'',value:''},{label:'',value:''}];
    }
    if (newType === 'comparison' && (!m.dataSlots || !m.dataSlots.length || m.dataSlots[0]?.value !== undefined)) {
      m.dataSlots = [{label:'',leftValue:'',rightValue:''},{label:'',leftValue:'',rightValue:''},{label:'',leftValue:'',rightValue:''},{label:'',leftValue:'',rightValue:''}];
    }
    _saveModulesQuiet();
    _renderEditor();
    setTimeout(_reloadPreview, 200);
  };

  /* ── 入力監視 → debounceでプレビュー更新 ── */
  let _previewTimer = null;
  window.s4OnInput = function() {
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(function() {
      _collectInputs();
      _saveModulesQuiet();
      _reloadPreview();
    }, 1000);
  };

  /* ── ナレーション再生成 ── */
  window.s4RegenNarr = async function() {
    _collectInputs();
    const post = window.APP.selected;
    const i = window.APP.s4.activeTab;
    if (!post?.id) return;
    _msg('⏳ ナレーション再生成中...');
    try {
      await _saveModulesQuiet();  // 先に保存（endpointはディスクから読む）
      const j = await fetchJson('/api/v2/regen-narration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, idx: i }),
      });
      if (j.narration) {
        window.APP.s4.modules[i].narration = j.narration;
        _renderEditor();
        _reloadPreview();
        _msg('✅ 再生成完了');
      } else {
        _msg('❌ 失敗');
      }
    } catch (e) { _msg('❌ ' + e.message); }
  };

  /* ── 保存（手動 + 自動） ── */
  async function _saveModulesQuiet() {
    const post = window.APP.selected;
    if (!post?.id) return;
    try {
      await fetchJson('/api/save-modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: window.APP.s4.modules }),
      });
    } catch (_) {}
  }
  document.getElementById('s4BtnSave').addEventListener('click', async function() {
    _collectInputs();
    await _saveModulesQuiet();
    _msg('✅ 保存しました');
  });

  /* ── プレビュー縮小スケール再計算 ── */
  function _resizePreview() {
    const wrap  = document.getElementById('s4PreviewWrap');
    const frame = document.getElementById('s4PreviewFrame');
    if (!wrap || !frame) return;
    const w = wrap.clientWidth || 1;
    frame.style.transform = 'scale(' + (w / 1920) + ')';
  }
  if (!window.APP.s4._resizeBound) {
    window.addEventListener('resize', _resizePreview);
    window.APP.s4._resizeBound = true;
  }

  /* ── プレビュー再読み込み ── */
  function _reloadPreview() {
    const post = window.APP.selected;
    if (!post?.id) return;
    const i = window.APP.s4.activeTab;
    const url = '/api/v2/preview-slide?postId=' + encodeURIComponent(post.id) + '&idx=' + i + '&_=' + Date.now();
    const f = document.getElementById('s4PreviewFrame');
    f.onload = _resizePreview;
    f.src = url;
    _resizePreview();
  }

  /* ── 動画一覧読み込み ── */
  async function _loadVideos() {
    const post = window.APP.selected;
    if (!post?.id) return;
    try {
      const j = await fetchJson('/api/v2/videos?postId=' + encodeURIComponent(post.id));
      const el = document.getElementById('s4VideoList');
      if (!j.videos?.length) { el.innerHTML = '<div style="color:#5a6a8a;">なし</div>'; return; }
      el.innerHTML = j.videos.map(function(v) {
        return '<div style="margin-bottom:6px;">'
          + '<a href="' + v.url + '" target="_blank" style="color:#7dc8ff;">' + _esc(v.file) + '</a>'
          + ' <span style="color:#5a6a8a;font-size:10px;">(' + Math.round(v.sizeBytes/1024) + 'KB)</span>'
          + '</div>';
      }).join('');
    } catch (_) {}
  }

  /* ── 動画生成 ── */
  document.getElementById('s4BtnGenVideo').addEventListener('click', async function() {
    _collectInputs();
    const post = window.APP.selected;
    if (!post?.id) return;
    _msg('⏳ 動画生成 開始...');
    try {
      const j = await fetchJson('/api/v2/generate-video', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: window.APP.s4.modules }),
      });
      window.APP.s4.currentJobId = j.jobId;
      _msg('✅ Job起動: ' + j.jobId);
      _pollJobStatus();
    } catch (e) { _msg('❌ ' + e.message); }
  });

  /* ── 進捗ポーリング ── */
  async function _pollJobStatus() {
    const id = window.APP.s4.currentJobId;
    if (!id) return;
    try {
      const j = await fetchJson('/api/v2/video-status?jobId=' + encodeURIComponent(id));
      const el = document.getElementById('s4JobStatus');
      el.innerHTML = '<div>status: <b>' + _esc(j.status||'?') + '</b></div>'
        + (j.progress ? '<div>progress: ' + _esc(JSON.stringify(j.progress)) + '</div>' : '')
        + (j.error    ? '<div style="color:#ef4444;">error: ' + _esc(j.error) + '</div>' : '')
        + (j.outputUrl? '<div><a href="' + j.outputUrl + '" target="_blank" style="color:#10b981;">▶ ' + _esc(j.outputFile||'video') + '</a></div>' : '');
      if (j.status === 'done' || j.status === 'failed') {
        _loadVideos();
        return;  // ポーリング終了
      }
    } catch (_) {}
    setTimeout(_pollJobStatus, 3000);
  }

})();
</script>`;
}

module.exports = { router, getUI };
