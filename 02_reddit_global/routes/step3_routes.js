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

  // SI取得済みキーワード一覧を整形
  const siItems = [];
  if (siData.boxes) {
    Object.entries(siData.boxes).forEach(([boxType, box]) => {
      (box.fetched || []).forEach(f => siItems.push({ type: boxType, label: f.label }));
    });
  }
  const siSummary = siItems.length
    ? siItems.map(i => i.label + '(' + i.type + ')').join(', ')
    : JSON.stringify(siData).slice(0, 1500);

  const prompt = `あなたはプロのサッカーYouTubeチャンネルの脚本家です。
以下の案件・コメント・補足情報をもとに、視聴者を最初の3秒から最後まで釘付けにするスライド構成を6〜9枚で提案してください。

【案件（日本語）】${post.title || post.titleOrig}
【案件（原文）】${post.titleOrig || ''}
【コメント要約】${comments || '(なし)'}
【取得済みSI情報】${siSummary || '(なし)'}

【絶対ルール】
- 必ず1枚目のtypeを "opening" にすること
- 必ず最後の1枚のtypeを "ending" にすること
- 全モジュールにscriptDirフィールドを必ず記入すること

【構成指針】
- オープニング: 視聴者を3秒で掴む衝撃フック・問いかけ
- 中盤: ピーク演出(1〜2枚) + データ深掘り(2〜3枚) + コメント反応(1〜2枚)
- エンディング: 余韻・チャンネル登録を促す

【使用可能なスライドタイプ】
- opening     : 冒頭10秒で視聴者を掴むインパクトタイトル（常に1枚目）
- insight     : 3〜5個のキャッチコピーが上から積み上がる（例: "18歳でCL8得点" "ドルトムントで80ゴール" 等）
- stats       : 選手/チームのスタッツをデータカード2x2グリッドで表示
- reaction    : 海外ファンのコメント吹き出し（Reddit/5chコメント紹介）
- profile     : 選手/監督の詳細プロフィール（画像＋データカード）
- comparison  : 2者を左右で対比（VS形式。選手vs選手、チームvsチーム）
- history     : 時系列のタイムライン（キャリア年表・出来事の流れ）
- matchcard   : 試合プレビューカード（両チーム情報の並列表示・試合前の紹介）
- matchcenter : 試合詳細（スコア・ピッチ図・スタッツ一覧）
- ending      : チャンネル登録を促す締め（常に最後）

JSONのみ返すこと（説明・マークダウン不要）:
{"modules": [{"title": "スライドタイトル", "type": "opening", "reason": "採用理由（1行）", "scriptDir": "このスライドのナレーション方向性・演出ポイント（2〜3文）", "siBinding": null}, {"title": "...", "type": "insight|stats|reaction|profile|comparison|history|matchcard|matchcenter", "reason": "...", "scriptDir": "...", "siBinding": "SI取得済みキーワード名またはnull"}, {"title": "エンディングタイトル", "type": "ending", "reason": "...", "scriptDir": "...", "siBinding": null}]}`;

  try {
    const raw    = await callAI({ model: 'claude-sonnet-4-6', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] });
    const m      = raw.match(/\{[\s\S]*\}/);
    if (!m) { console.error('[Step3] JSONパース失敗:', raw.slice(0,200)); return res.status(500).json({ error: 'JSONパース失敗' }); }
    const parsed = JSON.parse(m[0]);
    const mods   = parsed.modules || [];

    // scriptDir が欠けている場合のデフォルト補完
    const defaultScriptDir = {
      opening:     '衝撃的な問いかけや事実で始め、視聴者を最初の3秒で引き込む。',
      insight:     'キャッチコピーを3〜5個ナレーションに合わせて積み上げ、視聴者の記憶に残す。',
      stats:       '具体的な数字・データを見せ、情報の信頼性と説得力を高める。',
      reaction:    '海外ファンのリアルなコメントを紹介し、視聴者の共感を生む。',
      profile:     '選手・監督のプロフィールや実績を深掘りし、視聴者の興味を引く。',
      comparison:  '2者を比較することで違いを際立たせ、視聴者に気づきを与える。',
      history:     '時系列でストーリーを展開し、出来事の流れを分かりやすく伝える。',
      matchcard:   '両チームの情報を並列で紹介し、試合への期待感を高める。',
      matchcenter: 'スコア・ピッチ・スタッツを順に見せ、試合の全貌を伝える。',
      ending:      '全体のまとめと感想を述べ、コメントへの参加とチャンネル登録を促す。',
    };
    mods.forEach(mod => {
      if (!mod.scriptDir || !mod.scriptDir.trim()) {
        mod.scriptDir = defaultScriptDir[mod.type] || '';
      }
    });

    // opening が先頭になければ自動挿入
    if (!mods.length || mods[0].type !== 'opening') {
      const topTitle = (post.title || post.titleOrig || '').slice(0, 25);
      mods.unshift({
        title:     '衝撃！' + topTitle,
        type:      'opening',
        reason:    '視聴者を最初の3秒で引き込むオープニング',
        scriptDir: defaultScriptDir.opening,
        siBinding: null,
      });
    }
    // ending が末尾になければ自動挿入
    if (!mods.length || mods[mods.length - 1].type !== 'ending') {
      mods.push({
        title:     'まとめ・チャンネル登録を！',
        type:      'ending',
        reason:    '余韻を残しチャンネル登録を促す',
        scriptDir: defaultScriptDir.ending,
        siBinding: null,
      });
    }

    parsed.modules = mods;
    console.log('[Step3] 提案成功:', mods.length, '件 (opening/ending補完済み)');
    res.json(parsed);
  } catch (e) {
    console.error('[Step3] エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// モジュール1件の脚本指示再提案
router.post('/regen-module-script', async (req, res) => {
  const { post, module: mod, allModules } = req.body;
  if (!post || !mod) return res.status(400).json({ error: 'post + module required' });
  console.log('[Step3] 脚本指示再提案:', mod.title);
  const otherTitles = (allModules || []).filter(m => m.title !== mod.title).map(m => m.title).join(', ');
  try {
    const raw = await callAI({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content:
        `あなたはサッカーYouTubeの脚本家です。以下のスライドの脚本指示を再提案してください。
スライドタイプ: ${mod.type}、タイトル: 「${mod.title}」
案件: ${post.title || post.titleOrig}
全体構成（他のスライド）: ${otherTitles || 'なし'}
SIバインド: ${mod.siBinding || 'なし'}

このスライドの脚本指示（ナレーション方向性・演出ポイント）を2〜3文で提案してください。
JSONのみ: {"scriptDir": "脚本指示テキスト"}` }]
    });
    const m = raw.match(/\{[\s\S]*\}/);
    res.json(m ? JSON.parse(m[0]) : { scriptDir: '' });
  } catch (e) {
    console.error('[Step3] 脚本指示再提案エラー:', e.message);
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
    opening:'#ff4d4d', insight:'#1a6ef5', stats:'#10b981', reaction:'#f59e0b',
    profile:'#8b5cf6', comparison:'#ef4444', history:'#6366f1',
    matchcard:'#14b8a6', matchcenter:'#06b6d4', ending:'#64748b',
  };
  const TYPE_LABELS = {
    opening:'オープニング', insight:'キャッチコピー', stats:'スタッツ・数値',
    reaction:'コメント反応', profile:'プロフィール', comparison:'対比',
    history:'時系列ヒストリー', matchcard:'試合プレビュー',
    matchcenter:'試合詳細', ending:'エンディング',
  };
  const ALL_TYPES = ['opening','insight','stats','reaction','profile','comparison','history','matchcard','matchcenter','ending'];

  /* SIデータ（サーバーから取得）*/
  window.APP = window.APP || {};
  window.APP.s3SiData = {};

  window.step3Init = function() {
    var postId = window.APP.selected && window.APP.selected.id;
    if (!postId) { s3RenderTabs(); s3RenderEditor(); return; }
    /* サーバーからSIデータを取得してからレンダリング */
    fetchJson('/api/si-data?postId=' + encodeURIComponent(postId))
      .then(function(d) {
        window.APP.s3SiData = d || {};
      })
      .catch(function() {})
      .then(function() {
        s3RenderTabs();
        s3RenderEditor();
        s3LoadImages();
      });
  };

  /* ── モジュール提案 (3-1/3-2/3-3) ── */
  window.s3Propose = async function() {
    _s3Msg('⏳ Claude 4.6 が構成を練っています...');
    document.getElementById('s3Editor').innerHTML = '<div style="color:var(--c);padding:20px;">⏳ 提案生成中...</div>';
    document.getElementById('s3Tabs').innerHTML = '';
    try {
      const d = await fetchJson('/api/propose-modules', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ post:window.APP.selected, postId:window.APP.selected?.id, siDataIn:window.APP.s3SiData||{} }),
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

    /* SIデータバインドドロップダウン（新Step2構造対応）*/
    var siItems = [];
    var s3si = window.APP.s3SiData || {};
    if (s3si.boxes) {
      Object.entries(s3si.boxes).forEach(function(entry) {
        var boxType = entry[0], box = entry[1];
        (box.fetched || []).forEach(function(f) {
          siItems.push({ key: f.label, label: f.label + ' [' + boxType + ']' });
        });
      });
    }
    var siOpts = '<option value="">(バインドなし)</option>'
      + siItems.map(function(it) {
          return '<option value="' + _e(it.key) + '"' + (m.siBinding===it.key?' selected':'') + '>' + _e(it.label) + '</option>';
        }).join('');

    document.getElementById('s3Editor').innerHTML =
      /* タイトル */
      '<div style="margin-bottom:14px;">'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">&#x1F4DD; スライドタイトル</div>'
      + '<input id="s3TitleInp" type="text" class="inp" style="width:100%;font-size:15px;font-weight:bold;" value="' + _e(m.title) + '">'
      + '</div>'

      /* タイプ + バッジ */
      + '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:14px;">'
      + '<div>'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">&#x1F39E; スライドタイプ</div>'
      + '<select id="s3TypeSel" class="inp" style="width:100%;">' + typeOpts + '</select>'
      + '</div>'
      + '<div style="display:flex;flex-direction:column;justify-content:flex-end;gap:6px;">'
      + '<div style="background:'+col+';color:#fff;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:bold;text-align:center;">'
      + (m.type||'?').toUpperCase() + '</div>'
      + '<button class="btn btn-sm" style="background:#dc2626;color:#fff;" onclick="s3Delete('+i+')">&#x1F5D1; 削除</button>'
      + '</div>'
      + '</div>'

      /* SIバインド */
      + '<div style="margin-bottom:14px;">'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">&#x1F517; SIデータバインド</div>'
      + (siItems.length
          ? '<select id="s3SiBind" class="inp" style="width:100%;">' + siOpts + '</select>'
          : '<div style="font-size:11px;color:#5a6a8a;">Step2でSIデータを取得してください</div>')
      + '</div>'

      /* 脚本指示 (#3-2-2) */
      + '<div style="margin-bottom:14px;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">'
      + '<span style="font-size:11px;color:var(--c);font-weight:bold;">&#x1F3AD; 脚本指示</span>'
      + '<button class="btn btn-sm" id="s3RegenBtn" onclick="s3RegenScript()">&#x21BB; 再提案</button>'
      + '</div>'
      + '<textarea id="s3ScriptDir" class="inp" style="width:100%;height:80px;font-size:12px;resize:vertical;">'
      + _e(m.scriptDir || '') + '</textarea>'
      + '</div>'

      /* AI制作意図 */
      + '<div style="background:#0d1220;border-radius:8px;padding:12px;margin-bottom:10px;">'
      + '<div style="font-size:10px;color:#8a9aba;margin-bottom:4px;">&#x1F4A1; AI制作意図</div>'
      + '<div style="font-size:12px;color:#c0cce0;line-height:1.6;">' + _e(m.reason||'') + '</div>'
      + '</div>'

      /* 位置表示 */
      + '<div style="font-size:10px;color:#5a6a8a;">スライド ' + (i+1) + ' / ' + mods.length + '</div>';
  }

  /* 現在タブの入力を APP に反映 */
  function _s3SaveCurrent() {
    const i = window.APP.activeTab;
    const m = window.APP.modules?.[i];
    if (!m) return;
    const t = document.getElementById('s3TitleInp');
    const s = document.getElementById('s3TypeSel');
    const b = document.getElementById('s3SiBind');
    const d = document.getElementById('s3ScriptDir');
    if (t) m.title     = t.value;
    if (s) m.type      = s.value;
    if (b) m.siBinding = b.value || null;
    if (d) m.scriptDir = d.value;
  }

  /* 脚本指示再提案 (#3-2-2) */
  window.s3RegenScript = async function() {
    _s3SaveCurrent();
    const i = window.APP.activeTab;
    const m = window.APP.modules?.[i];
    if (!m) return;
    const btn = document.getElementById('s3RegenBtn');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    _s3Msg('脚本指示を再提案中...');
    try {
      const d = await fetchJson('/api/regen-module-script', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ post: window.APP.selected, module: m, allModules: window.APP.modules }),
      });
      if (d.scriptDir) {
        m.scriptDir = d.scriptDir;
        const ta = document.getElementById('s3ScriptDir');
        if (ta) ta.value = d.scriptDir;
        _s3Msg('脚本指示を更新しました');
      }
    } catch(e) { _s3Msg('再提案失敗: ' + e.message); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '↻ 再提案'; } }
  };

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

      /* 画像取得キーワードを収集（SIバインドがある場合は優先） */
      const kwSet = new Set();
      window.APP.modules.forEach(m => {
        if (m.siBinding) kwSet.add(m.siBinding);
      });
      /* SI取得済みのplayer/teamラベルを追加（上限6件）*/
      const s3si = window.APP.s3SiData || {};
      if (s3si.boxes) {
        ['sofascore_player','sofascore_team'].forEach(function(boxType) {
          const box = s3si.boxes[boxType];
          if (box) (box.fetched || []).forEach(function(f) { kwSet.add(f.label); });
        });
      }
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
