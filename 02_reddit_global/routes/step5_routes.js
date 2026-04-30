// routes/step5_routes.js
// ═══════════════════════════════════════════════════════════
// Step5: 投稿準備（サムネ作成）
//   - A/D/L/N/O 5テンプレを HTML レンダー
//   - ライブプレビュー（iframe srcdoc / blob URL）
//   - PNG 保存（Puppeteer 1280x720）
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

// ── ライブプレビュー: HTMLを返す（iframe で blob URL 化される想定）─
router.post('/v5/thumb-preview', (req, res) => {
  const { template, data } = req.body || {};
  const t = TEMPLATES[template];
  if (!t) return res.status(400).send('unknown template: ' + template);
  try {
    res.type('html').send(t.build(data || {}));
  } catch (e) {
    res.status(500).send('build error: ' + e.message);
  }
});

// ── PNG 保存（Puppeteer 1280x720）─
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
    await page.screenshot({
      path: outPath,
      type: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 720 },
    });
    await browser.close();
    res.json({
      ok: true,
      file: filename,
      url: `/v2_thumbs/${safePostId}/${filename}`,
      size: fs.statSync(outPath).size,
    });
  } catch (e) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    res.status(500).json({ error: e.message });
  }
});

// ── 案件の画像一覧（imageRoot 配下を再帰スキャン）─
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

// ── 保存済みサムネ一覧 ─
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

// ── 削除 ─
router.delete('/v5/delete-saved', (req, res) => {
  const { postId, file } = req.query;
  if (!postId || !file) return res.status(400).json({ error: 'missing params' });
  const safePostId = String(postId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const safeFile = path.basename(String(file));
  const target = path.join(THUMB_OUT_BASE, safePostId, safeFile);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    res.json({ ok: true });
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
    <h2 style="color:var(--c); font-size:18px; letter-spacing:1px;">5. サムネ作成（投稿準備）</h2>
    <span id="s5-postlabel" style="color:var(--muted); font-size:12px;"></span>
  </div>

  <!-- テンプレタブ -->
  <div id="s5-tabs" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px;"></div>

  <div style="display:grid; grid-template-columns: minmax(360px, 1fr) minmax(560px, 1.2fr); gap:18px;">
    <!-- 左: 入力フォーム + 画像ピッカー -->
    <div>
      <div id="s5-form" style="background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; margin-bottom:12px;"></div>
      <div style="background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong style="color:var(--c); font-size:12px;">📷 案件の画像</strong>
          <button onclick="s5LoadImages()" style="background:transparent; color:var(--muted); border:1px solid var(--border); padding:3px 10px; border-radius:4px; cursor:pointer; font-size:11px;">↻ 再読込</button>
        </div>
        <div id="s5-images" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap:6px; max-height:300px; overflow-y:auto;"></div>
        <div id="s5-image-target" style="margin-top:8px; font-size:11px; color:var(--muted);">画像枠をクリックしてから候補を選択</div>
      </div>
    </div>

    <!-- 右: ライブプレビュー + 保存 -->
    <div>
      <div style="position:relative; aspect-ratio: 16/9; background:#000; border:2px solid var(--border); border-radius:8px; overflow:hidden;">
        <iframe id="s5-preview" style="position:absolute; top:0; left:0; width:1280px; height:720px; border:0; transform-origin:top left;"></iframe>
      </div>
      <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
        <input type="text" id="s5-savelabel" placeholder="保存ラベル（任意・英数字）" style="flex:1; min-width:120px; background:#0a0e1a; color:var(--text); border:1px solid var(--border); padding:8px 10px; border-radius:6px; font-size:12px;">
        <button onclick="s5Save()" style="background:var(--c); color:#fff; border:0; padding:8px 18px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:12px;">💾 PNG 保存</button>
        <button onclick="s5RefreshPreview()" style="background:var(--panel); color:var(--text); border:1px solid var(--border); padding:8px 14px; border-radius:6px; cursor:pointer; font-size:12px;">🔄 プレビュー更新</button>
      </div>
      <div id="s5-saved-list" style="margin-top:14px;"></div>
    </div>
  </div>
</div>

<script>
(function() {
  if (window.__s5Init) return; window.__s5Init = true;

  // ─── テンプレ別フィールド定義 ───
  const TPL = {
    A: {
      label: 'A: データ強調',
      defaults: { tone: 'dark', heroNumber: '161', heroLabel: '在籍試合', catch: 'タイトルキャッチ', badge: '衝撃', badgeColor: '#ef4444', heroImage: '' },
      fields: [
        { key:'tone',        type:'select', options:['dark','light'], label:'tone' },
        { key:'badge',       type:'text',    label:'バッジ文字（任意）' },
        { key:'badgeColor',  type:'color',   label:'バッジ色' },
        { key:'heroNumber',  type:'text',    label:'数字（hero）' },
        { key:'heroLabel',   type:'text',    label:'数字の意味' },
        { key:'catch',       type:'textarea',label:'キャッチ' },
        { key:'heroImage',   type:'image',   label:'写真（左）' },
      ],
    },
    D: {
      label: 'D: 問いかけ',
      defaults: { tone: 'dark', question: 'なぜ？', subData: 'データ補足', bottomBadge: '5分で解説', bgImage:'', heroImage:'' },
      fields: [
        { key:'tone',        type:'select', options:['dark','light'], label:'tone' },
        { key:'question',    type:'text',    label:'問い（末尾の?が強調色）' },
        { key:'subData',     type:'text',    label:'データ補足' },
        { key:'bottomBadge', type:'text',    label:'右下バッジ（任意）' },
        { key:'bgImage',     type:'image',   label:'背景画像' },
        { key:'heroImage',   type:'image',   label:'右上の顔写真（任意）' },
      ],
    },
    L: {
      label: 'L: BREAKING',
      defaults: {
        breakingLabel: '衝撃のデータ',
        title: 'メインタイトル',
        titleHighlight: '',
        mainStat: { value: '', label: '' },
        subStat:  { value: '', label: '' },
        heroImage: '',
      },
      fields: [
        { key:'breakingLabel', type:'text', label:'BREAKINGラベル' },
        { key:'title',         type:'text', label:'タイトル（黒帯1行）' },
        { key:'titleHighlight',type:'text', label:'ハイライト（赤2行目・任意）' },
        { key:'mainStat.value',type:'text', label:'数字（中央円）' },
        { key:'mainStat.label',type:'text', label:'数字ラベル' },
        { key:'subStat.value', type:'text', label:'サブ数字（任意）' },
        { key:'subStat.label', type:'text', label:'サブラベル' },
        { key:'heroImage',     type:'image',label:'背景写真' },
      ],
    },
    N: {
      label: 'N: マガジン',
      defaults: {
        issueLabel: 'ISSUE 042',
        title: 'メインタイトル',
        subtitle: 'サブタイトル',
        stickers: [
          { value: '63%', label: 'xG超過', color: 'red' },
          { value: '+5', label: 'Goal Diff', color: 'gold' },
          { value: '8.4', label: 'Avg Rating', color: 'green' },
        ],
        heroImage: '',
      },
      fields: [
        { key:'issueLabel', type:'text',  label:'号数（ISSUE 042 等）' },
        { key:'title',      type:'text',  label:'メインタイトル' },
        { key:'subtitle',   type:'text',  label:'サブタイトル' },
        { key:'stickers.0.value',type:'text',  label:'ステッカー1: 数字' },
        { key:'stickers.0.label',type:'text',  label:'ステッカー1: ラベル' },
        { key:'stickers.0.color',type:'select',options:['red','gold','green','blue'], label:'ステッカー1: 色' },
        { key:'stickers.1.value',type:'text',  label:'ステッカー2: 数字' },
        { key:'stickers.1.label',type:'text',  label:'ステッカー2: ラベル' },
        { key:'stickers.1.color',type:'select',options:['red','gold','green','blue'], label:'ステッカー2: 色' },
        { key:'stickers.2.value',type:'text',  label:'ステッカー3: 数字' },
        { key:'stickers.2.label',type:'text',  label:'ステッカー3: ラベル' },
        { key:'stickers.2.color',type:'select',options:['red','gold','green','blue'], label:'ステッカー3: 色' },
        { key:'heroImage',  type:'image', label:'背景写真' },
      ],
    },
    O: {
      label: 'O: トレカ',
      defaults: {
        playerName: '選手名',
        position: 'POS',
        team: 'TEAM',
        overallRating: 89,
        stats: [
          { label: 'GOL', value: '0' },
          { label: 'AST', value: '0' },
          { label: 'RAT', value: '0' },
          { label: 'APP', value: '0' },
        ],
        bottomCatch: '',
        heroImage: '',
      },
      fields: [
        { key:'playerName',    type:'text',   label:'選手名' },
        { key:'position',      type:'text',   label:'ポジション (RB · DF 等)' },
        { key:'team',          type:'text',   label:'チーム' },
        { key:'overallRating', type:'number', label:'OVR' },
        { key:'stats.0.label', type:'text',   label:'スタッツ1 ラベル' },
        { key:'stats.0.value', type:'text',   label:'スタッツ1 値' },
        { key:'stats.1.label', type:'text',   label:'スタッツ2 ラベル' },
        { key:'stats.1.value', type:'text',   label:'スタッツ2 値' },
        { key:'stats.2.label', type:'text',   label:'スタッツ3 ラベル' },
        { key:'stats.2.value', type:'text',   label:'スタッツ3 値' },
        { key:'stats.3.label', type:'text',   label:'スタッツ4 ラベル' },
        { key:'stats.3.value', type:'text',   label:'スタッツ4 値' },
        { key:'bottomCatch',   type:'text',   label:'下キャッチ（任意）' },
        { key:'heroImage',     type:'image',  label:'写真（左）' },
      ],
    },
  };

  const STATE = {
    template: 'A',
    data: structuredClone(TPL.A.defaults),
    images: [],
    activeImageField: null,
  };

  // ─── 深いキー（"a.b.0.c"）の get/set ─
  function dget(o, k) {
    return k.split('.').reduce((acc, key) => {
      if (acc == null) return acc;
      if (/^\d+$/.test(key)) return acc[Number(key)];
      return acc[key];
    }, o);
  }
  function dset(o, k, v) {
    const parts = k.split('.');
    let cur = o;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i], next = parts[i + 1];
      const isIdx = /^\d+$/.test(p);
      const idx = isIdx ? Number(p) : p;
      if (cur[idx] == null) cur[idx] = /^\d+$/.test(next) ? [] : {};
      cur = cur[idx];
    }
    const last = parts[parts.length - 1];
    cur[/^\d+$/.test(last) ? Number(last) : last] = v;
  }

  // ─── タブ ─
  function renderTabs() {
    const el = document.getElementById('s5-tabs');
    el.innerHTML = Object.entries(TPL).map(([k, t]) => {
      const active = k === STATE.template;
      return '<button onclick="s5SwitchTpl(\\''+k+'\\')" style="'
        + 'background:'+(active?'var(--c)':'var(--panel)')+';'
        + 'color:'+(active?'#fff':'var(--text)')+';'
        + 'border:1px solid '+(active?'var(--c)':'var(--border)')+';'
        + 'padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:12px;'
        + '">'+t.label+'</button>';
    }).join('');
  }
  window.s5SwitchTpl = function(key) {
    STATE.template = key;
    STATE.data = structuredClone(TPL[key].defaults);
    renderTabs(); renderForm(); refreshPreview();
  };

  // ─── フォーム ─
  function renderForm() {
    const tpl = TPL[STATE.template];
    const html = tpl.fields.map(f => {
      const v = dget(STATE.data, f.key);
      const id = 's5f_' + f.key.replace(/\\./g, '_');
      const lab = '<label style="display:block; font-size:11px; color:var(--muted); margin:8px 0 3px;">'+f.label+'</label>';
      if (f.type === 'select') {
        return lab + '<select id="'+id+'" data-key="'+f.key+'" style="width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border); padding:6px 8px; border-radius:4px; font-size:12px;">'
          + f.options.map(o => '<option'+(o===v?' selected':'')+'>'+o+'</option>').join('') + '</select>';
      } else if (f.type === 'textarea') {
        return lab + '<textarea id="'+id+'" data-key="'+f.key+'" rows="2" style="width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border); padding:6px 8px; border-radius:4px; font-size:12px; resize:vertical;">'+(v==null?'':_e(v))+'</textarea>';
      } else if (f.type === 'image') {
        const empty = !v;
        return lab + '<div id="'+id+'" data-key="'+f.key+'" onclick="s5SetImageTarget(\\''+f.key+'\\')" style="cursor:pointer; padding:8px 10px; border:2px dashed '+(STATE.activeImageField===f.key?'var(--c)':'var(--border)')+'; background:#0a0e1a; border-radius:4px; font-size:11px; color:'+(empty?'var(--muted)':'var(--text)')+'; word-break:break-all;">'+(empty?'(クリックして画像を選択)':_e(v))+'</div>';
      } else if (f.type === 'color') {
        return lab + '<input type="color" id="'+id+'" data-key="'+f.key+'" value="'+(v||'#ef4444')+'" style="width:100%; background:#0a0e1a; border:1px solid var(--border); padding:2px; border-radius:4px; height:30px;">';
      } else if (f.type === 'number') {
        return lab + '<input type="number" id="'+id+'" data-key="'+f.key+'" value="'+(v==null?'':v)+'" style="width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border); padding:6px 8px; border-radius:4px; font-size:12px;">';
      } else {
        return lab + '<input type="text" id="'+id+'" data-key="'+f.key+'" value="'+(v==null?'':_e(v))+'" style="width:100%; background:#0a0e1a; color:var(--text); border:1px solid var(--border); padding:6px 8px; border-radius:4px; font-size:12px;">';
      }
    }).join('');
    const el = document.getElementById('s5-form');
    el.innerHTML = html;
    el.querySelectorAll('[data-key]').forEach(node => {
      if (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA') {
        node.addEventListener('input', () => {
          const k = node.getAttribute('data-key');
          let v = node.value;
          if (node.type === 'number') v = v === '' ? null : Number(v);
          dset(STATE.data, k, v);
          refreshPreviewDebounced();
        });
      }
    });
  }
  function _e(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  window.s5SetImageTarget = function(key) {
    STATE.activeImageField = key;
    document.getElementById('s5-image-target').textContent = '画像セット先: ' + key + '（候補からクリック）';
    renderForm();
  };

  // ─── 画像ロード ─
  window.s5LoadImages = async function() {
    const postId = window.APP && window.APP.selected ? window.APP.selected.id : null;
    if (!postId) {
      document.getElementById('s5-images').innerHTML = '<div style="color:var(--muted); font-size:11px; padding:8px;">案件未選択</div>';
      return;
    }
    try {
      const r = await window.fetchJson('/api/v5/case-images?postId=' + encodeURIComponent(postId));
      STATE.images = r.images || [];
      renderImages();
    } catch (e) {
      document.getElementById('s5-images').innerHTML = '<div style="color:var(--c); font-size:11px;">読込失敗: '+_e(e.message)+'</div>';
    }
  };
  function renderImages() {
    const el = document.getElementById('s5-images');
    if (!STATE.images.length) {
      el.innerHTML = '<div style="color:var(--muted); font-size:11px; padding:8px;">画像なし（Step3.5で取得してから戻ってきて）</div>';
      return;
    }
    el.innerHTML = STATE.images.map(img =>
      '<div onclick="s5PickImage(\\''+_e(img.path).replace(/\\\\/g,'\\\\\\\\').replace(/\\'/g,'&#39;')+'\\')" style="cursor:pointer; border:1px solid var(--border); border-radius:4px; overflow:hidden; background:#000;" title="'+_e(img.label)+'/'+_e(img.file)+'">'
        + '<div style="aspect-ratio:1/1; background:url(/'+_e(img.path)+') center/cover;"></div>'
        + '<div style="padding:3px 5px; font-size:9px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">'+_e(img.label)+'</div>'
        + '</div>'
    ).join('');
  }
  window.s5PickImage = function(path) {
    if (!STATE.activeImageField) {
      alert('先に画像枠（点線）をクリックして選択先を決めて');
      return;
    }
    dset(STATE.data, STATE.activeImageField, path);
    renderForm();
    refreshPreview();
  };

  // ─── プレビュー（POST → blob URL）─
  let lastBlobUrl = null;
  let _previewTimer = null;
  function refreshPreviewDebounced() {
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(refreshPreview, 350);
  }
  async function refreshPreview() {
    const iframe = document.getElementById('s5-preview');
    if (!iframe) return;
    try {
      const res = await fetch('/api/v5/thumb-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: STATE.template, data: STATE.data }),
      });
      const html = await res.text();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      iframe.src = url;
      if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
      lastBlobUrl = url;
      fitIframe();
    } catch (e) { console.error('preview error', e); }
  }
  window.s5RefreshPreview = refreshPreview;

  function fitIframe() {
    const iframe = document.getElementById('s5-preview');
    if (!iframe) return;
    const wrap = iframe.parentElement;
    const w = wrap.clientWidth;
    const scale = w / 1280;
    iframe.style.transform = 'scale(' + scale + ')';
  }
  window.addEventListener('resize', fitIframe);

  // ─── 保存 ─
  window.s5Save = async function() {
    const postId = window.APP && window.APP.selected ? window.APP.selected.id : '_unsorted';
    const labelEl = document.getElementById('s5-savelabel');
    const label = labelEl.value.trim() || (STATE.data.heroNumber || STATE.data.title || STATE.data.playerName || '');
    try {
      const r = await window.fetchJson('/api/v5/thumb-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: STATE.template, data: STATE.data, postId, label }),
      });
      labelEl.value = '';
      await loadSavedList();
      alert('保存完了: ' + r.file);
    } catch (e) {
      alert('保存失敗: ' + e.message);
    }
  };

  // ─── 保存済み一覧 ─
  async function loadSavedList() {
    const postId = window.APP && window.APP.selected ? window.APP.selected.id : '_unsorted';
    const el = document.getElementById('s5-saved-list');
    try {
      const r = await window.fetchJson('/api/v5/list-saved?postId=' + encodeURIComponent(postId));
      if (!r.files.length) { el.innerHTML = ''; return; }
      el.innerHTML = '<div style="color:var(--c); font-size:11px; margin-bottom:6px; font-weight:bold;">💾 保存済みサムネ ('+r.files.length+'件)</div>'
        + '<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:8px;">'
        + r.files.map(f =>
          '<div style="background:var(--panel); border:1px solid var(--border); border-radius:6px; overflow:hidden;">'
          + '<a href="'+_e(f.url)+'" target="_blank"><img src="'+_e(f.url)+'" style="width:100%; aspect-ratio:16/9; display:block; object-fit:cover;"></a>'
          + '<div style="padding:5px 8px; font-size:10px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; justify-content:space-between; gap:6px;">'
          + '<span style="overflow:hidden; text-overflow:ellipsis;" title="'+_e(f.file)+'">'+_e(f.file)+'</span>'
          + '<button onclick="s5DeleteSaved(\\''+_e(f.file)+'\\')" style="background:transparent; border:0; color:var(--c); cursor:pointer; padding:0; font-size:11px;">✕</button>'
          + '</div></div>'
        ).join('') + '</div>';
    } catch (e) {
      el.innerHTML = '<div style="color:var(--c); font-size:11px;">一覧取得失敗: '+_e(e.message)+'</div>';
    }
  }
  window.s5DeleteSaved = async function(file) {
    if (!confirm('削除する？: ' + file)) return;
    const postId = window.APP && window.APP.selected ? window.APP.selected.id : '_unsorted';
    try {
      await fetch('/api/v5/delete-saved?postId=' + encodeURIComponent(postId) + '&file=' + encodeURIComponent(file), { method: 'DELETE' });
      await loadSavedList();
    } catch (e) { alert('削除失敗: ' + e.message); }
  };

  // ─── Step5 init ─
  window.step5Init = function() {
    const post = window.APP && window.APP.selected;
    document.getElementById('s5-postlabel').textContent = post ? '案件: ' + (post.title || post.id) : '案件未選択';
    renderTabs();
    renderForm();
    refreshPreview();
    s5LoadImages();
    loadSavedList();
  };
})();
</script>
`;
}

module.exports = { router, getUI };
