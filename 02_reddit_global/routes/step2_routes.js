// routes/step2_routes.js
// ═══════════════════════════════════════════════════════
// STEP 2: SI情報取得（指示書V2 #2-1〜2-3）
// sourceボックス7種 / DeepSeekラベル提案 / 取得済み管理
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const { callAI }               = require('../scripts/ai_client');
const { fetchWikipediaSafe,
        searchWikipediaTitles }= require('../scripts/modules/fetchers/wikipedia');
const { fetchSofaScorePlayer } = require('../scripts/modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam }   = require('../scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreManager }= require('../scripts/modules/fetchers/sofascore_manager');
const { fetchSofaScoreMatch }  = require('../scripts/modules/fetchers/sofascore_match');
const { fetchSerper }          = require('../scripts/modules/fetchers/serper_module');
const { apiGetLight: sofaApiGetLight } = require('../scripts/modules/fetchers/_sofa_common');

const router = express.Router();
const SI_DIR = path.join(__dirname, '..', 'data', 'si_data');

if (!fs.existsSync(SI_DIR)) fs.mkdirSync(SI_DIR, { recursive: true });

// ─── ユーティリティ ───────────────────────────────────────

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[Step2] JSON読み込みエラー:', e.message);
    return fallback;
  }
}

function siPath(postId) {
  return path.join(SI_DIR, (postId || 'unknown').replace(/[/\?%*:|"<>.]/g, '_') + '.json');
}

function emptySiData(postId) {
  return {
    postId,
    createdAt: new Date().toISOString(),
    boxes: {
      news:              { labels: [], fetched: [] },
      wikipedia:         { labels: [], fetched: [] },
      sofascore_player:  { labels: [], fetched: [] },
      sofascore_manager: { labels: [], fetched: [] },
      sofascore_team:    { labels: [], fetched: [] },
      sofascore_match:   { labels: [], fetched: [] },
      otherURL:          { labels: [], fetched: [] },
    },
  };
}

// ─── ラベル検証ヘルパー（Phase 3: Plan C 軽量検証）───────────
//   各関数: string を受けて { valid: boolean, canonical?: string } を返す

// Wikipedia: タイトル検索だけで存在確認（本文fetchしない）
async function validateWikipediaLabel(label) {
  try {
    const titles = await searchWikipediaTitles(label);
    return titles && titles.length
      ? { valid: true, canonical: titles[0] }
      : { valid: false };
  } catch (_) { return { valid: false }; }
}

// SofaScore: 汎用ヘルパー。type で絞る
async function _validateSofaByType(label, typeFilter) {
  try {
    const data = await sofaApiGetLight(`/search/all/?q=${encodeURIComponent(label)}`);
    const hit = (data.results || []).find(r =>
      r.type === typeFilter && (r.entity?.sport?.id === 1 || !r.entity?.sport)
    );
    return hit ? { valid: true, canonical: hit.entity?.name || label } : { valid: false };
  } catch (_) { return { valid: false }; }
}
const validateSofaPlayer  = l => _validateSofaByType(l, 'player');
const validateSofaTeam    = l => _validateSofaByType(l, 'team');
const validateSofaManager = async l => {
  // manager 型は稀。team 経由でもOKとする
  const r = await _validateSofaByType(l, 'manager');
  if (r.valid) return r;
  // フォールバック: 監督名 → team 検索で誰かのチームなら valid 扱い
  return { valid: false };
};
const validateSofaMatch = async (label) => {
  const parts = label.split(' vs ').map(s => s.trim());
  if (parts.length < 2 || !parts[1]) return { valid: false };
  // 両チームが SofaScore にヒットすれば valid（実試合検索は取得時に行う）
  const [h, a] = await Promise.all([
    _validateSofaByType(parts[0], 'team'),
    _validateSofaByType(parts[1], 'team'),
  ]);
  if (h.valid && a.valid) return { valid: true, canonical: `${h.canonical} vs ${a.canonical}` };
  return { valid: false };
};

// AI ラベル補正（Plan B フォールバック）
async function aiCorrectLabel(boxType, originalLabel, errorMsg) {
  try {
    const hint = {
      wikipedia:         'Wikipedia article title',
      sofascore_player:  'soccer player full name (e.g. "Lionel Messi")',
      sofascore_manager: 'soccer manager full name (e.g. "Pep Guardiola")',
      sofascore_team:    'soccer club official name (e.g. "Manchester City")',
      sofascore_match:   'match in "HomeTeam vs AwayTeam" format',
    }[boxType] || 'canonical name';

    const raw = await callAI({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages:   [{ role: 'user', content:
        `The label "${originalLabel}" failed (${errorMsg || 'not found'}) when searched on ${boxType}.
Suggest the most likely ${hint}. Common abbreviations to expand:
UCL→UEFA Champions League, EPL→Premier League, Man Utd→Manchester United, Real→Real Madrid
Return ONLY the corrected name, no quotes or explanation.` }]
    });
    return raw.trim().replace(/^["'「」]|["'「」]$/g, '').slice(0, 120);
  } catch (_) { return null; }
}

// ─── API ─────────────────────────────────────────────────

// AIラベル提案（DeepSeek / Claude Haiku）
router.post('/suggest-si-labels', async (req, res) => {
  const { post } = req.body;
  if (!post) return res.json({ boxes: {} });

  const title    = post.titleOrig || post.title || '';
  const comments = (post.raw?.comments || [])
    .map(c => c.body || '').filter(Boolean).slice(0, 5).join('\n').slice(0, 600);

  console.log('[Step2] AIラベル提案:', title.slice(0, 60));

  try {
    const response = await callAI({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages:   [{ role: 'user', content:
        `Soccer news analysis. Suggest search keywords per source type.
Return ONLY JSON (no markdown), all values in English:
{
  "news": ["search query 1","search query 2","search query 3"],
  "wikipedia": ["EntityName1","EntityName2","EntityName3"],
  "sofascore_player": ["PlayerName1","PlayerName2","PlayerName3"],
  "sofascore_manager": ["ManagerName1","ManagerName2"],
  "sofascore_team": ["TeamName1","TeamName2","TeamName3"],
  "sofascore_match": ["HomeTeam vs AwayTeam"],
  "otherURL": []
}
Title: ${title}
Comments: ${comments}` }],
    });

    const m = response.match(/\{[\s\S]*\}/);
    if (!m) return res.json({ boxes: {}, unvalidated: {} });
    const boxes = JSON.parse(m[0]);

    // ── ラベル検証（Plan C: 軽量検証のみ。ハズレは除外せずマークだけ付ける）──
    const unvalidated = {
      wikipedia:         [],
      sofascore_player:  [],
      sofascore_manager: [],
      sofascore_team:    [],
      sofascore_match:   [],
    };
    const validators = {
      wikipedia:         validateWikipediaLabel,
      sofascore_player:  validateSofaPlayer,
      sofascore_manager: validateSofaManager,
      sofascore_team:    validateSofaTeam,
      sofascore_match:   validateSofaMatch,
    };

    console.log('[Step2] ラベル検証開始...');
    for (const [boxType, validator] of Object.entries(validators)) {
      const labels = boxes[boxType] || [];
      const newLabels = [];
      for (const lbl of labels) {
        if (!lbl) continue;
        const r = await validator(lbl);
        if (r.valid) {
          // 公式名で正規化
          newLabels.push(r.canonical || lbl);
        } else {
          // ハズレは残すがマーク
          newLabels.push(lbl);
          unvalidated[boxType].push(lbl);
        }
      }
      boxes[boxType] = newLabels;
    }
    console.log('[Step2] 検証完了。未検証ラベル:',
      Object.entries(unvalidated).filter(([_,v]) => v.length).map(([k,v]) => `${k}:${v.length}`).join(', ') || 'なし');

    res.json({ boxes, unvalidated });
  } catch (e) {
    console.error('[Step2] AI提案エラー:', e.message);
    res.json({ boxes: {}, unvalidated: {} });
  }
});

// type + label で1件フェッチする内部関数
async function _fetchByType(type, label) {
  switch (type) {
    case 'news':              return await fetchSerper(label);
    case 'wikipedia':         return await fetchWikipediaSafe(label);
    case 'sofascore_player':  return await fetchSofaScorePlayer(label);
    case 'sofascore_manager': return await fetchSofaScoreManager(label);
    case 'sofascore_team':    return await fetchSofaScoreTeam(label);
    case 'sofascore_match': {
      const parts = label.split(' vs ').map(s => s.trim());
      if (parts.length < 2 || !parts[1])
        throw new Error('"HomeTeam vs AwayTeam" 形式で入力してください');
      return await fetchSofaScoreMatch(parts[0], parts[1]);
    }
    case 'otherURL':          return { url: label, type: 'manual', ok: true };
    default: throw new Error('不明なタイプ: ' + type);
  }
}

// 結果が成功かどうか判定（null / ok:false / ハズレ状態 をハズレとして判定）
function _isFetchFailed(data) {
  if (!data) return true;
  if (data.ok === false) return true;
  return false;
}

// SI一件取得（type + label → データ保存。ハズレ時は AI 補正で再試行）
router.post('/fetch-si-item', async (req, res) => {
  const { postId, type, label } = req.body;
  if (!postId || !type || !label) return res.status(400).json({ error: 'params required' });

  console.log('[Step2] SI取得:', type, label);

  const filePath = siPath(postId);
  const siData   = safeJson(filePath, emptySiData(postId));
  const box      = siData.boxes[type];
  if (!box) return res.status(400).json({ error: 'unknown type: ' + type });

  // 取得済みキャッシュ
  const existing = box.fetched.find(f => f.label === label);
  if (existing) return res.json({ ok: true, cached: true, data: existing.data });

  let data = null;
  let error = null;
  let corrected = null; // AI補正で使った代替ラベル

  // ── ① 1回目: 素のラベルでフェッチ ──
  try {
    data = await _fetchByType(type, label);
  } catch (e) {
    error = e.message;
    console.error('[Step2] SI取得1回目失敗:', type, label, e.message);
  }

  // ── ② ハズレたら AI 補正で1回だけリトライ（news/otherURL は補正対象外）──
  const AI_CORRECTIBLE = ['wikipedia','sofascore_player','sofascore_manager','sofascore_team','sofascore_match'];
  if (_isFetchFailed(data) && AI_CORRECTIBLE.includes(type)) {
    const errMsg = error || (data?.error) || 'not found';
    console.log('[Step2] AI補正リトライ試行:', type, label);
    const fixed = await aiCorrectLabel(type, label, errMsg);
    if (fixed && fixed !== label) {
      console.log('[Step2] AI補正結果:', label, '→', fixed);
      corrected = fixed;
      try {
        const retryData = await _fetchByType(type, fixed);
        if (!_isFetchFailed(retryData)) {
          data = retryData;
          error = null;
        } else {
          // リトライも失敗なら最初のdataを残す
          if (!data) data = retryData;
        }
      } catch (e2) {
        console.error('[Step2] AI補正リトライも失敗:', e2.message);
      }
    }
  }

  // 保存（成功時のみ）
  const success = !_isFetchFailed(data);
  if (success) {
    box.fetched.push({
      label,
      correctedLabel: corrected || null,
      data,
      fetchedAt: new Date().toISOString(),
    });
    if (!box.labels.includes(label)) box.labels.push(label);
    try { fs.writeFileSync(filePath, JSON.stringify(siData, null, 2)); } catch (_) {}
  }

  res.json({
    ok: success,
    error: success ? null : (error || data?.error || '取得失敗'),
    data: data || null,
    corrected,
  });
});

// SIデータ取得
router.get('/si-data', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  res.json(safeJson(siPath(postId), emptySiData(postId)));
});

// SIデータ保存
router.post('/si-data', (req, res) => {
  const { postId, siData } = req.body;
  if (!postId || !siData) return res.status(400).json({ error: 'postId/siData required' });
  try {
    fs.writeFileSync(siPath(postId), JSON.stringify(siData, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── UI ──────────────────────────────────────────────────

function getUI() {
  return `
<div id="step2" class="step-container" style="display:none">

  <!-- TOP PANEL -->
  <div class="panel" style="margin-bottom:12px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span id="s2Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">案件を選択してください</span>
      <button class="btn btn-primary" id="s2BtnSuggest">&#x1F916; AIラベル提案</button>
      <button class="btn btn-sm"      id="s2BtnReload">&#x1F4C2; 保存済み読込</button>
      <span id="s2Msg" style="font-size:12px;color:#8a9aba"></span>
    </div>
  </div>

  <!-- 2カラム -->
  <div style="display:flex;gap:16px;align-items:flex-start">

    <!-- LEFT: ソースボックス群 -->
    <div style="flex:0 0 55%;display:flex;flex-direction:column;gap:10px">
      <div id="s2Boxes">
        <div style="color:#3a4a6a;text-align:center;padding:30px">
          案件を選択するとAIがラベルを提案します
        </div>
      </div>
      <button class="btn btn-primary" id="s2BtnFetch" style="padding:12px;font-size:14px">
        &#x1F4E1; SI取得
      </button>
      <div id="s2FetchProg" style="font-size:11px;color:#8a9aba;min-height:16px"></div>
    </div>

    <!-- RIGHT: プレビュー / 取得済み / 履歴 -->
    <div style="flex:1;display:flex;flex-direction:column;gap:10px">

      <div class="panel">
        <div style="font-size:11px;font-weight:bold;color:#8a9aba;margin-bottom:8px">&#x1F4CB; プレビュー</div>
        <pre id="s2Preview" style="max-height:220px;overflow-y:auto;font-size:10px;margin:0">（取得済みデータをクリックして確認）</pre>
      </div>

      <div class="panel">
        <div style="font-size:11px;font-weight:bold;color:#8a9aba;margin-bottom:8px">&#x2705; 取得済みラベル</div>
        <div id="s2FetchedChips" style="display:flex;flex-wrap:wrap;gap:5px">
          <span style="font-size:11px;color:#3a4a6a">なし</span>
        </div>
      </div>

      <div class="panel">
        <div style="font-size:11px;font-weight:bold;color:#8a9aba;margin-bottom:8px">&#x1F4C1; 取得済みデータ一覧</div>
        <div id="s2History">
          <div style="font-size:11px;color:#3a4a6a">まだデータがありません</div>
        </div>
      </div>

      <button class="btn btn-success" id="s2BtnNext" style="width:100%;padding:13px;font-size:14px;font-weight:bold">
        &#x1F3AC; モジュール提案へ &#x2192;
      </button>

    </div>
  </div>
</div>

<script>
(function() {
/* =====================================================
   STEP 2: SI情報取得 クライアントロジック
   ===================================================== */

/* ─ ソースボックス定義 ─ */
var BOX_TYPES = {
  news:              { ja: 'NEWS',    label: 'ニュース',    color: '#0ea5e9', hint: '例: chelsea relegation 2024' },
  wikipedia:         { ja: 'WIKI',    label: 'Wikipedia',  color: '#6366f1', hint: '例: Chelsea FC' },
  sofascore_player:  { ja: 'PLY',     label: '選手',        color: '#10b981', hint: '例: Erling Haaland' },
  sofascore_manager: { ja: 'MGR',     label: '監督',        color: '#f59e0b', hint: '例: Pep Guardiola' },
  sofascore_team:    { ja: 'TEM',     label: 'チーム',      color: '#8b5cf6', hint: '例: Manchester City' },
  sofascore_match:   { ja: 'MTH',     label: '試合',        color: '#ef4444', hint: '例: Chelsea vs Arsenal' },
  otherURL:          { ja: 'URL',     label: 'その他URL',   color: '#64748b', hint: 'URLを入力' },
};

/* ─ 初期化（window.APPが未定義ならこのスコープで作る）─ */
window.APP = window.APP || {};
window.APP.s2 = {
  boxes:   {},
  history: [],
};
Object.keys(BOX_TYPES).forEach(function(k) {
  /* unvalidatedLabels: 検証でハズレたラベルのリスト（⚠️表示用）*/
  window.APP.s2.boxes[k] = { labels: [], fetched: [], unvalidatedLabels: [] };
});

/* ─ step2Init（goStepから呼ばれる）─ */
window.step2Init = function() {
  var post = window.APP.selected;

  /* 状態リセット */
  Object.keys(BOX_TYPES).forEach(function(k) {
    window.APP.s2.boxes[k] = { labels: [], fetched: [], unvalidatedLabels: [] };
  });
  window.APP.s2.history = [];
  window._s2HistData    = [];

  /* 案件が未選択でも7ボックスは常に描画 */
  document.getElementById('s2Title').textContent = post
    ? (post.title || '(タイトル不明)').slice(0, 80)
    : '← 左サイドバーの保存済み案件をクリックしてください';
  _s2Msg('');
  _s2RenderBoxes();
  _s2RenderHistory();
  _s2RenderFetchedChips();

  if (!post) return;

  /* サーバーから既存SIデータを読み込む */
  fetchJson('/api/si-data?postId=' + encodeURIComponent(post.id))
    .then(function(d) {
      if (!d || !d.boxes) return;
      Object.keys(BOX_TYPES).forEach(function(k) {
        if (d.boxes[k]) {
          window.APP.s2.boxes[k] = {
            labels:            d.boxes[k].labels            || [],
            fetched:           d.boxes[k].fetched           || [],
            unvalidatedLabels: d.boxes[k].unvalidatedLabels  || [],
          };
        }
      });
      /* history を全ボックスから再構築 */
      window.APP.s2.history = [];
      Object.entries(d.boxes).forEach(function(entry) {
        var type = entry[0], box = entry[1];
        (box.fetched || []).forEach(function(f) {
          window.APP.s2.history.push({ type: type, label: f.label, data: f.data, fetchedAt: f.fetchedAt });
        });
      });
      window.APP.s2.history.sort(function(a, b) {
        return (b.fetchedAt || '').localeCompare(a.fetchedAt || '');
      });
      _s2RenderBoxes();
      _s2RenderHistory();
      _s2RenderFetchedChips();
    })
    .catch(function() {});
};

/* ─ AIラベル提案 ─ */
function s2SuggestLabels() {
  var post = window.APP.selected;
  if (!post) { alert('案件が選択されていません'); return; }
  _s2Msg('AI提案中... (ラベル検証に数秒かかります)');
  fetchJson('/api/suggest-si-labels', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ post: post }),
  })
  .then(function(d) {
    if (!d.boxes) { _s2Msg('提案なし'); return; }
    var warnCount = 0;
    Object.keys(BOX_TYPES).forEach(function(k) {
      var labels = d.boxes[k];
      if (!Array.isArray(labels)) return;
      labels.forEach(function(lbl) {
        if (lbl && !window.APP.s2.boxes[k].labels.includes(lbl)) {
          window.APP.s2.boxes[k].labels.push(lbl);
        }
      });
      /* 未検証ラベルリストを更新 */
      var unval = (d.unvalidated && d.unvalidated[k]) || [];
      window.APP.s2.boxes[k].unvalidatedLabels = unval;
      warnCount += unval.length;
    });
    _s2RenderBoxes();
    _s2Msg(warnCount
      ? 'AIラベルを追加しました（⚠️ 未検証: ' + warnCount + '件、取得時にAI補正します）'
      : 'AIラベルを追加しました（全て検証済み）');
  })
  .catch(function(e) { _s2Msg('AIエラー: ' + e.message); });
}

/* ─ ラベル追加 ─ */
window.s2AddLabel = function(type) {
  var inp = document.getElementById('s2inp_' + type);
  if (!inp) return;
  var val = inp.value.trim();
  if (!val) return;
  var box = window.APP.s2.boxes[type];
  if (!box) return;
  if (!box.labels.includes(val)) box.labels.push(val);
  inp.value = '';
  _s2RenderBoxes();
  _s2SaveState();
};

/* ─ ラベル削除 ─ */
window.s2RemoveLabel = function(type, idx) {
  var box = window.APP.s2.boxes[type];
  if (!box) return;
  box.labels.splice(idx, 1);
  _s2RenderBoxes();
  _s2SaveState();
};

/* ─ 一件取得 ─ */
function s2FetchItem(type, label) {
  var post = window.APP.selected;
  if (!post) return Promise.resolve(false);
  return fetchJson('/api/fetch-si-item', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ postId: post.id, type: type, label: label }),
  })
  .then(function(d) {
    if (d.ok) {
      var entry = {
        label: label,
        correctedLabel: d.corrected || null,
        data: d.data,
        fetchedAt: new Date().toISOString(),
      };
      /* fetchedに追加（重複回避）*/
      var box = window.APP.s2.boxes[type];
      if (!box.fetched.find(function(f) { return f.label === label; })) {
        box.fetched.push(entry);
      }
      /* 取得成功したら未検証リストからも除去 */
      var uidx = (box.unvalidatedLabels || []).indexOf(label);
      if (uidx >= 0) box.unvalidatedLabels.splice(uidx, 1);
      /* history に追加 */
      window.APP.s2.history.unshift({
        type: type, label: label, correctedLabel: d.corrected || null,
        data: d.data, fetchedAt: entry.fetchedAt,
      });
      _s2RenderBoxes();
      _s2RenderHistory();
      _s2RenderFetchedChips();
      _s2Msg(d.corrected
        ? label + ' → AI補正「' + d.corrected + '」で取得成功'
        : label + ' 取得完了');
      return true;
    } else {
      _s2Msg(label + ' 失敗: ' + (d.error || '不明'));
      return false;
    }
  })
  .catch(function(e) {
    _s2Msg(label + ' エラー: ' + e.message);
    return false;
  });
}

/* ─ 全件取得 ─ */
function s2FetchAll() {
  var post = window.APP.selected;
  if (!post) { alert('案件が選択されていません'); return; }

  var tasks = [];
  Object.keys(BOX_TYPES).forEach(function(type) {
    var box = window.APP.s2.boxes[type];
    box.labels.forEach(function(lbl) {
      if (!box.fetched.find(function(f) { return f.label === lbl; })) {
        tasks.push({ type: type, label: lbl });
      }
    });
  });

  if (!tasks.length) { _s2Msg('すべて取得済み、またはラベルがありません'); return; }

  var prog = document.getElementById('s2FetchProg');
  var i = 0;

  function next() {
    if (i >= tasks.length) {
      if (prog) prog.textContent = tasks.length + '件取得完了';
      _s2SaveState();
      return;
    }
    var t = tasks[i++];
    if (prog) prog.textContent = i + '/' + tasks.length + ' ' + t.type + ': ' + t.label;
    /* SofaScore系はレート制限が厳しいので長めに待つ */
    var delay = t.type.indexOf('sofascore') === 0 ? 1500 : 400;
    s2FetchItem(t.type, t.label).then(function() {
      setTimeout(next, delay);
    });
  }
  next();
}

/* ─ 状態保存 ─ */
function _s2SaveState() {
  var post = window.APP.selected;
  if (!post) return;
  var payload = {
    postId: post.id,
    siData: {
      postId:    post.id,
      savedAt:   new Date().toISOString(),
      boxes:     window.APP.s2.boxes,
    },
  };
  fetchJson('/api/si-data', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(function() {});
}

/* ─ プレビュー ─ */
window.s2ShowPreview = function(data) {
  var pre = document.getElementById('s2Preview');
  if (pre) pre.textContent = JSON.stringify(data, null, 2);
};

/* ─ ダウンロード ─ */
window.s2Download = function(type, label) {
  var box = window.APP.s2.boxes[type];
  if (!box) return;
  var item = box.fetched.find(function(f) { return f.label === label; });
  if (!item) return;
  var blob = new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = type + '_' + label.replace(/[^a-zA-Z0-9]/g, '_') + '.json';
  a.click();
  URL.revokeObjectURL(url);
};

/* ─ ボックス再描画 ─ */
function _s2RenderBoxes() {
  var el = document.getElementById('s2Boxes');
  if (!el) return;

  var html = '';
  Object.entries(BOX_TYPES).forEach(function(entry) {
    var type = entry[0], cfg = entry[1];
    var box  = window.APP.s2.boxes[type] || { labels: [], fetched: [] };

    var unvalidated = box.unvalidatedLabels || [];
    var chips = box.labels.map(function(lbl, idx) {
      var isFetched     = !!box.fetched.find(function(f) { return f.label === lbl; });
      var isUnvalidated = unvalidated.indexOf(lbl) >= 0 && !isFetched;
      var borderStyle   = isUnvalidated
        ? '1px dashed #f59e0b'
        : '1px solid ' + cfg.color;
      var bgColor       = isUnvalidated ? '#f59e0b22' : cfg.color + '33';
      var titleAttr     = isUnvalidated
        ? ' title="未検証ラベル: SofaScore/Wikipediaでヒットしませんでした。取得時にAI補正が走ります"'
        : '';
      return '<span' + titleAttr + ' style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:12px;'
        + 'font-size:11px;background:' + bgColor + ';border:' + borderStyle + ';color:#fff;margin:2px">'
        + (isFetched ? '<span style="color:#10b981">&#x2705;</span>' : '')
        + (isUnvalidated ? '<span style="color:#fbbf24">&#x26A0;</span>' : '')
        + _esc(lbl)
        + (isFetched ? '' : '<span class="s2-chip-remove" data-type="' + type + '" data-idx="' + idx + '" '
          + 'style="cursor:pointer;margin-left:5px;color:#aaa;font-size:13px">&#xD7;</span>')
        + '</span>';
    }).join('');

    html += '<div class="panel" style="padding:12px;border-left:3px solid ' + cfg.color + '">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
      + '<span style="font-size:12px;font-weight:bold;color:' + cfg.color + '">' + cfg.ja + ' ' + cfg.label + '</span>'
      + '<span style="font-size:10px;color:#5a6a8a">' + cfg.hint + '</span>'
      + '</div>'
      + '<div style="min-height:24px;margin-bottom:8px">'
      + (chips || '<span style="font-size:11px;color:#3a4a6a">ラベルなし</span>')
      + '</div>'
      + '<div style="display:flex;gap:6px">'
      + '<input class="inp s2-label-inp" id="s2inp_' + type + '" data-type="' + type + '" '
      + 'placeholder="' + cfg.hint + '" style="flex:1;font-size:11px;padding:4px 8px">'
      + '<button class="btn btn-sm s2-add-btn" data-type="' + type + '">+追加</button>'
      + '</div>'
      + '</div>';
  });

  el.innerHTML = html;
}

/* ─ 取得済みチップ再描画 ─ */
function _s2RenderFetchedChips() {
  var el = document.getElementById('s2FetchedChips');
  if (!el) return;
  var chips = [];
  Object.entries(BOX_TYPES).forEach(function(entry) {
    var type = entry[0], cfg = entry[1];
    (window.APP.s2.boxes[type].fetched || []).forEach(function(f) {
      chips.push('<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;'
        + 'font-size:10px;background:' + cfg.color + '22;border:1px solid ' + cfg.color + ';color:#ccc">'
        + cfg.ja + ' ' + _esc(f.label)
        + '</span>');
    });
  });
  el.innerHTML = chips.length
    ? chips.join('')
    : '<span style="font-size:11px;color:#3a4a6a">なし</span>';
}

/* ─ 履歴再描画 ─ */
function _s2RenderHistory() {
  var el = document.getElementById('s2History');
  if (!el) return;
  window._s2HistData = [];
  var items = window.APP.s2.history;
  if (!items.length) {
    el.innerHTML = '<div style="font-size:11px;color:#3a4a6a">まだデータがありません</div>';
    return;
  }
  var html = items.map(function(h, i) {
    window._s2HistData[i] = h.data;
    var cfg = BOX_TYPES[h.type] || { ja: '?', color: '#888' };
    var lbl = String(h.label || '').slice(0, 35);
    var ts  = h.fetchedAt ? h.fetchedAt.slice(0, 16).replace('T', ' ') : '';
    var type = h.type, label = h.label;
    return '<div class="si-hist-row s2-hist-item" data-idx="' + i + '" '
      + 'style="cursor:pointer">'
      + '<span style="font-size:10px;color:' + cfg.color + ';font-weight:bold;min-width:38px">' + cfg.ja + '</span>'
      + '<span style="flex:1;font-size:11px">' + _esc(lbl) + '</span>'
      + '<span style="font-size:9px;color:#5a6a8a">' + ts + '</span>'
      + '<button class="btn-sm s2-dl-btn" data-type="' + type + '" data-label="' + encodeURIComponent(label) + '" '
      + 'style="background:none;border:none;cursor:pointer;color:#8a9aba;font-size:13px;padding:0 4px" '
      + 'title="ダウンロード">&#x1F4BE;</button>'
      + '</div>';
  }).join('');
  el.innerHTML = html;
}

/* ─ ヘルパー ─ */
function _s2Msg(t) {
  var el = document.getElementById('s2Msg');
  if (el) el.textContent = t;
}
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ─ イベント委任（inline handler を使わない）─ */
document.addEventListener('click', function(e) {
  var el = e.target;

  /* +追加ボタン */
  if (el.classList.contains('s2-add-btn')) {
    window.s2AddLabel(el.dataset.type);
    return;
  }
  /* ラベル削除×ボタン */
  if (el.classList.contains('s2-chip-remove')) {
    window.s2RemoveLabel(el.dataset.type, parseInt(el.dataset.idx, 10));
    return;
  }
  /* 履歴行クリック → プレビュー */
  var histRow = el.closest('.s2-hist-item');
  if (histRow && !el.classList.contains('s2-dl-btn')) {
    var idx = parseInt(histRow.dataset.idx, 10);
    if (!isNaN(idx) && window._s2HistData && window._s2HistData[idx]) {
      window.s2ShowPreview(window._s2HistData[idx]);
    }
    return;
  }
  /* ダウンロードボタン */
  if (el.classList.contains('s2-dl-btn')) {
    e.stopPropagation();
    window.s2Download(el.dataset.type, decodeURIComponent(el.dataset.label));
    return;
  }
  /* AIラベル提案ボタン */
  if (el.id === 's2BtnSuggest') { s2SuggestLabels(); return; }
  /* 保存済み読込 */
  if (el.id === 's2BtnReload') { window.step2Init(); return; }
  /* SI取得 */
  if (el.id === 's2BtnFetch') { s2FetchAll(); return; }
  /* モジュール提案へ */
  if (el.id === 's2BtnNext') { window.goStep(3); return; }
});

/* Enter でラベル追加 */
document.addEventListener('keypress', function(e) {
  if (e.key === 'Enter' && e.target.classList.contains('s2-label-inp')) {
    window.s2AddLabel(e.target.dataset.type);
  }
});

})();
</script>`;
}

module.exports = { router, getUI };
