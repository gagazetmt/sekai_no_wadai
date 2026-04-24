// routes/step3_routes.js
// ═══════════════════════════════════════════════════════
// STEP 3: 構成提案（Claude によるモジュール提案・編集・画像取得）
// 3-1〜3-8 完全実装版
// このファイルのみ編集することで Step3 の挙動・表示を変更できます。
// 他の Step ファイルへの依存: なし
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { callAI }               = require('../scripts/ai_client');
const { fetchWikimediaImages } = require('../scripts/fetch_wikimedia');
const { fetchXImages }         = require('../scripts/fetch_x_images');

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, '..', 'data');
const SI_DIR    = path.join(DATA_DIR, 'si_data');
const IMG_DIR   = path.join(__dirname, '..', 'images');

[DATA_DIR, SI_DIR, IMG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return fallback; }
}

function siPath(postId)      { return path.join(SI_DIR,   (postId||'unknown').replace(/[\/\?%*:|"<>\.]/g,'_') + '.json'); }
function modulesPath(postId) { return path.join(DATA_DIR, (postId||'unknown').replace(/[\/\?%*:|"<>\.]/g,'_') + '_modules.json'); }
function imagesPath(postId)  { return path.join(DATA_DIR, (postId||'unknown').replace(/[\/\?%*:|"<>\.]/g,'_') + '_images.json'); }

// ─── API ─────────────────────────────────────────────────

// モジュール構成提案（Claude Sonnet）
router.post('/propose-modules', async (req, res) => {
  const { post, postId, siDataIn } = req.body;
  if (!post) return res.status(400).json({ error: 'post required' });
  console.log('[Step3] モジュール提案:', post.title || post.titleOrig);

  let siData = siDataIn || {};
  if (postId && !Object.keys(siData).length) siData = safeJson(siPath(postId), {});

  const comments = (post.raw?.comments || [])
    .map(c => c.bodyJa || c.body || '').filter(Boolean).slice(0, 8).join(' / ');
  const siSummary = JSON.stringify(siData).slice(0, 2500);

  const prompt = `あなたはプロのサッカーYouTubeチャンネルの脚本家です。
以下の案件・コメント・補足情報をもとに、視聴者を最初の3秒から最後まで釘付けにする最強のスライド構成を5〜10枚で提案してください。

【案件（日本語）】${post.title || post.titleOrig}
【案件（原文）】${post.titleOrig || ''}
【コメント要約】${comments || '(なし)'}
【補足情報（SI）】${siSummary || '(なし)'}

【構成の鉄則】
1. オープニング（0〜10秒）: 視聴者の心を鷲掴みにする衝撃的な問い・事実・煽りから始める
2. ピーク: 最も盛り上がるポイントを1〜2枚で山場として演出する
3. データ深掘り: スタッツ・数字・比較で信頼性を高める（2〜3枚）
4. コメント紹介: 海外ファンのリアルな反応で共感を生む（1〜2枚）
5. エンディング: 余韻を残し、チャンネル登録を促す

【スライドタイプ】
- insight   : 概要・ストーリー解説（テキスト中心）
- stats     : スタッツ・数値データ（数字・グラフ・比較表）
- reaction  : コメント・ファン反応紹介
- profile   : 選手・監督のプロフィール深掘り
- comparison: 選手/チーム同士の比較
- timeline  : 時系列ストーリー展開

JSONのみ返すこと（前後の説明・マークダウン不要）:
{"modules": [{"title": "スライドタイトル", "type": "insight|stats|reaction|profile|comparison|timeline", "reason": "このスライドを入れる理由（1行）", "siBinding": "SI取得済みキーワード名（なければnull）"}]}`;

  try {
    const raw    = await callAI({ model: 'claude-sonnet-4-6', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] });
    const m      = raw.match(/\{[\s\S]*\}/);
    if (!m) { console.error('[Step3] JSONパース失敗:', raw.slice(0,200)); return res.status(500).json({ error: 'JSONパース失敗' }); }
    const parsed = JSON.parse(m[0]);
    console.log('[Step3] 提案成功:', parsed.modules?.length, '件');
    res.json(parsed);
  } catch (e) {
    console.error('[Step3] エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// モジュール保存（確定時）
router.post('/save-modules', (req, res) => {
  const { postId, modules } = req.body;
  if (!postId || !modules) return res.status(400).json({ error: 'postId + modules required' });
  try {
    fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 画像取得（3-7/3-8: X + Wikimedia Commons）
router.post('/fetch-images', async (req, res) => {
  const { postId, keywords } = req.body;
  if (!postId || !keywords?.length) return res.status(400).json({ error: 'postId + keywords required' });
  console.log(`[Step3] 画像取得開始: ${keywords.length}キーワード / postId:${postId}`);

  const prefix    = (postId||'img').replace(/[\/\?%*:|"<>\.]/g,'_').slice(-20);
  const allImages = [];

  for (const kw of keywords) {
    const safeKw = String(kw).trim();
    if (!safeKw) continue;
    console.log(`  → 画像取得: "${safeKw}"`);
    try {
      const wikiPaths = await fetchWikimediaImages(safeKw, `${prefix}_${allImages.length}`, 3);
      wikiPaths.forEach(p => allImages.push({ path: p, keyword: safeKw, source: 'wikimedia' }));
    } catch (e) { console.warn(`  [Wiki] "${safeKw}" 失敗:`, e.message); }
    try {
      const xPaths = await fetchXImages(safeKw, `${prefix}_x_${allImages.length}`, 3);
      xPaths.forEach(p => allImages.push({ path: p, keyword: safeKw, source: 'x' }));
    } catch (e) { console.warn(`  [X] "${safeKw}" 失敗:`, e.message); }
  }

  // 取得結果を保存
  fs.writeFileSync(imagesPath(postId), JSON.stringify({ postId, images: allImages, fetchedAt: new Date().toISOString() }, null, 2));
  console.log(`[Step3] 画像取得完了: ${allImages.length}枚`);
  res.json({ ok: true, count: allImages.length, images: allImages });
});

// 画像一覧取得（保存済み）
router.get('/images', (req, res) => {
  const data = safeJson(imagesPath(req.query.postId), { images: [] });
  res.json(data);
});

// ─── UI（3-1〜3-8 完全実装）─────────────────────────────

function getUI() {
  return /* html */`
<div id="step3" class="step-container" style="display:none;">
<div style="padding:0 20px 20px;">

  <!-- 提案ボタン -->
  <div class="panel" style="margin-bottom:16px;">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-primary" style="font-size:14px;padding:12px 24px;" onclick="s3Propose()">
        ✨ Claude 4.6 に脚本構成を提案させる
      </button>
      <button class="btn btn-sm" onclick="s3AddModule()">＋ スライド追加</button>
      <span id="s3Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
  </div>

  <!-- タブ行 -->
  <div id="s3Tabs" style="display:flex;gap:3px;flex-wrap:wrap;"></div>

  <!-- モジュールエディタ（3-4, 3-5, 3-6） -->
  <div id="s3Editor" style="background:var(--panel);border:1px solid var(--c);border-radius:0 12px 12px 12px;padding:20px;min-height:240px;margin-bottom:16px;"></div>

  <!-- 画像取得パネル（3-7, 3-8） -->
  <div id="s3ImgPanel" class="panel" style="display:none;margin-bottom:16px;">
    <div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:10px;">🖼️ 取得済み画像</div>
    <div id="s3ImgGrid" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
  </div>

  <!-- 再提案 + 生成ボタン行 -->
  <div style="display:flex;gap:8px;">
    <button class="btn btn-sm" style="flex:1;" onclick="s3Repropose()">🔄 タイトル編集後に再提案</button>
    <button class="btn btn-success" id="s3GenBtn" style="flex:2;font-size:14px;padding:12px;" onclick="s3Generate()">
      🎬 シナリオ生成・画像取得開始
    </button>
  </div>

</div>
</div>

<script>
(function() {
  /* === Step3 スコープ === */

  const TYPE_COLORS = {
    insight:'#1a6ef5', stats:'#10b981', reaction:'#f59e0b',
    profile:'#8b5cf6', comparison:'#ef4444', timeline:'#6b7280',
  };
  const TYPE_LABELS = {
    insight:'概要・解説', stats:'スタッツ・数値', reaction:'コメント反応',
    profile:'プロフィール', comparison:'比較', timeline:'時系列',
  };
  const ALL_TYPES = ['insight','stats','reaction','profile','comparison','timeline'];

  window.step3Init = function() {
    s3RenderTabs();
    s3RenderEditor();
    s3LoadImages();
  };

  /* ── モジュール提案 (3-1/3-2/3-3) ── */
  window.s3Propose = async function() {
    _s3Msg('⏳ Claude 4.6 が構成を練っています...');
    document.getElementById('s3Editor').innerHTML = '<div style="color:var(--c);padding:20px;">⏳ 提案生成中...</div>';
    document.getElementById('s3Tabs').innerHTML = '';
    try {
      const d = await fetchJson('/api/propose-modules', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ post:window.APP.selected, postId:window.APP.selected?.id, siDataIn:window.APP.siData||{} }),
      });
      window.APP.modules   = d.modules || [];
      window.APP.activeTab = 0;
      s3RenderTabs();
      s3RenderEditor();
      _s3Msg('✅ ' + window.APP.modules.length + ' スライド提案完了');
    } catch(e) {
      _s3Msg('❌ 提案失敗: ' + e.message);
      document.getElementById('s3Editor').innerHTML = '<div style="color:#ef4444;padding:20px;">❌ ' + _e(e.message) + '</div>';
    }
  };

  /* ── タブ描画 ── */
  function s3RenderTabs() {
    const mods = window.APP.modules || [];
    document.getElementById('s3Tabs').innerHTML = mods.length
      ? mods.map((m, i) => {
          const col = TYPE_COLORS[m.type] || '#555';
          const act = i === window.APP.activeTab;
          return '<div class="s3-tab' + (act?' s3-tab-active':'') + '"'
            + ' style="' + (act?'background:'+col+';color:#fff;':'') + '"'
            + ' onclick="s3Switch(' + i + ')">'
            + '<span style="font-size:9px;opacity:.8">S' + (i+1) + '</span><br>'
            + '<span style="font-size:10px;">' + _e(m.title.slice(0,10)) + (m.title.length>10?'…':'') + '</span>'
            + '</div>';
        }).join('')
      : '';
  }

  window.s3Switch = function(i) {
    _s3SaveCurrent();
    window.APP.activeTab = i;
    s3RenderTabs();
    s3RenderEditor();
  };

  /* ── エディタ描画 (3-4/3-5/3-6) ── */
  function s3RenderEditor() {
    const mods = window.APP.modules || [];
    if (!mods.length) {
      document.getElementById('s3Editor').innerHTML =
        '<div style="color:#5a6a8a;padding:20px;text-align:center;">「Claude 4.6 に提案させる」ボタンを押してください</div>';
      return;
    }
    const i   = window.APP.activeTab;
    const m   = mods[i];
    if (!m) return;
    const col = TYPE_COLORS[m.type] || '#555';

    /* タイプドロップダウン */
    const typeOpts = ALL_TYPES.map(t =>
      '<option value="' + t + '"' + (m.type===t?' selected':'') + '>' + t + ' — ' + TYPE_LABELS[t] + '</option>'
    ).join('');

    /* 3-6: SIデータバインドドロップダウン */
    const siKeys = Object.keys(window.APP.siData || {});
    const siOpts = ['<option value="">(バインドなし)</option>']
      .concat(siKeys.map(k => {
        const d = window.APP.siData[k];
        const label = k + (d?.siType ? ' [' + d.siType + ']' : '') + (d?.ok===false?' ⚠':'');
        return '<option value="' + _e(k) + '"' + (m.siBinding===k?' selected':'') + '>' + _e(label) + '</option>';
      })).join('');

    document.getElementById('s3Editor').innerHTML =
      /* タイトル */
      '<div style="margin-bottom:14px;">'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">📝 スライドタイトル</div>'
      + '<input id="s3TitleInp" type="text" class="inp" style="width:100%;font-size:15px;font-weight:bold;" value="' + _e(m.title) + '">'
      + '</div>'

      /* タイプ + バッジ */
      + '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:14px;">'
      + '<div>'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">🎞️ スライドタイプ</div>'
      + '<select id="s3TypeSel" class="inp" style="width:100%;">' + typeOpts + '</select>'
      + '</div>'
      + '<div style="display:flex;flex-direction:column;justify-content:flex-end;gap:6px;">'
      + '<div style="background:'+col+';color:#fff;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:bold;text-align:center;">'
      + (m.type||'?').toUpperCase() + '</div>'
      + '<button class="btn btn-sm" style="background:#dc2626;color:#fff;" onclick="s3Delete('+i+')">🗑️ 削除</button>'
      + '</div>'
      + '</div>'

      /* 3-6: SIバインド */
      + '<div style="margin-bottom:14px;">'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">🔗 SIデータバインド (3-6)</div>'
      + (siKeys.length
          ? '<select id="s3SiBind" class="inp" style="width:100%;">' + siOpts + '</select>'
          : '<div style="font-size:11px;color:#5a6a8a;">Step2でSIデータを取得してください</div>')
      + '</div>'

      /* AI意図 */
      + '<div style="background:#0d1220;border-radius:8px;padding:12px;">'
      + '<div style="font-size:10px;color:#8a9aba;margin-bottom:4px;">💡 AI 制作意図</div>'
      + '<div style="font-size:13px;color:#c0cce0;line-height:1.6;">' + _e(m.reason||'') + '</div>'
      + '</div>'

      /* 位置表示 */
      + '<div style="margin-top:10px;font-size:10px;color:#5a6a8a;">スライド ' + (i+1) + ' / ' + mods.length + '</div>';
  }

  /* 現在タブの入力を APP に反映 */
  function _s3SaveCurrent() {
    const i = window.APP.activeTab;
    const m = window.APP.modules?.[i];
    if (!m) return;
    const t = document.getElementById('s3TitleInp');
    const s = document.getElementById('s3TypeSel');
    const b = document.getElementById('s3SiBind');
    if (t) m.title     = t.value;
    if (s) m.type      = s.value;
    if (b) m.siBinding = b.value || null;
  }

  /* 追加 */
  window.s3AddModule = function() {
    _s3SaveCurrent();
    window.APP.modules.push({ title: 'スライド ' + (window.APP.modules.length+1), type: 'insight', reason: '手動追加', siBinding: null });
    window.APP.activeTab = window.APP.modules.length - 1;
    s3RenderTabs(); s3RenderEditor();
  };

  /* 削除 */
  window.s3Delete = function(i) {
    if (window.APP.modules.length <= 1) return alert('最低1枚必要です');
    if (!confirm('このスライドを削除しますか？')) return;
    window.APP.modules.splice(i, 1);
    window.APP.activeTab = Math.min(window.APP.activeTab, window.APP.modules.length-1);
    s3RenderTabs(); s3RenderEditor();
  };

  /* 再提案 (3-5) */
  window.s3Repropose = async function() {
    _s3SaveCurrent();
    if (!window.APP.modules.length) return alert('先に提案してください');
    const titles = window.APP.modules.map(m => m.title).join(', ');
    _s3Msg('⏳ 再提案中...');
    try {
      const d = await fetchJson('/api/propose-modules', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          post: { ...window.APP.selected, titleOrig: '既存タイトル: ' + titles },
          postId: window.APP.selected?.id, siDataIn: window.APP.siData||{},
        }),
      });
      if (d.modules?.length) {
        window.APP.modules = d.modules; window.APP.activeTab = 0;
        s3RenderTabs(); s3RenderEditor(); _s3Msg('✅ 再提案完了');
      }
    } catch(e) { _s3Msg('❌ 失敗: ' + e.message); }
  };

  /* 生成・画像取得 (3-7/3-8) */
  window.s3Generate = async function() {
    _s3SaveCurrent();
    if (!window.APP.modules.length) return alert('モジュールを確定してください');
    const postId = window.APP.selected?.id;
    if (!postId) return alert('案件が選択されていません');

    const btn = document.getElementById('s3GenBtn');
    btn.disabled = true;
    btn.textContent = '⏳ 生成中...';
    _s3Msg('モジュールを保存中...');

    try {
      /* モジュール保存 */
      await fetchJson('/api/save-modules', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId, modules: window.APP.modules }),
      });

      /* 画像取得キーワードを収集（SIバインドがある場合は優先、なければタイトル） */
      const kwSet = new Set();
      window.APP.modules.forEach(m => {
        if (m.siBinding) kwSet.add(m.siBinding);
      });
      /* SI取得済みキーも追加（playerとteamのみ、上限6件） */
      Object.entries(window.APP.siData || {}).forEach(([k, v]) => {
        if (['player','team'].includes(v?.siType)) kwSet.add(k);
      });
      const keywords = [...kwSet].slice(0, 6);

      if (keywords.length) {
        _s3Msg('⏳ 画像取得中 (0/' + keywords.length + ')…');
        const imgRes = await fetchJson('/api/fetch-images', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ postId, keywords }),
        });
        window.APP.images = imgRes.images || [];
        s3RenderImages(window.APP.images);
        _s3Msg('✅ 完了！モジュール ' + window.APP.modules.length + '枚 / 画像 ' + imgRes.count + '枚');
      } else {
        _s3Msg('✅ モジュール保存完了（画像キーワードなし）');
      }
    } catch(e) {
      _s3Msg('❌ 失敗: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🎬 シナリオ生成・画像取得開始';
    }
  };

  /* 既存画像読み込み */
  function s3LoadImages() {
    const id = window.APP.selected?.id;
    if (!id) return;
    fetch('/api/images?postId=' + encodeURIComponent(id))
      .then(r => r.json()).then(d => {
        if (d.images?.length) {
          window.APP.images = d.images;
          s3RenderImages(d.images);
        }
      }).catch(() => {});
  }

  /* 画像グリッド描画 (3-8) */
  function s3RenderImages(images) {
    if (!images?.length) return;
    const panel = document.getElementById('s3ImgPanel');
    const grid  = document.getElementById('s3ImgGrid');
    panel.style.display = 'block';
    grid.innerHTML = images.slice(0, 20).map(img => {
      const fname = img.path.replace(/\\\\/g, '/').split('/').pop();
      const srcBadge = img.source === 'x'
        ? '<span style="background:#1da1f2;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">X</span>'
        : '<span style="background:#339af0;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">Wiki</span>';
      return '<div style="text-align:center;width:90px;">'
        + '<img src="/images/' + fname + '" style="width:90px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border);"'
        + ' onerror="this.style.display=\\'none\\'">'
        + '<div style="font-size:9px;color:#8a9aba;margin-top:2px;">' + srcBadge + ' ' + _e(img.keyword.slice(0,10)) + '</div>'
        + '</div>';
    }).join('');
  }

  function _s3Msg(t) { document.getElementById('s3Msg').textContent = t; }
  function _e(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

})();
</script>`;
}

module.exports = { router, getUI };
