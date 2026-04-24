// routes/step2_routes.js
// ═══════════════════════════════════════════════════════
// STEP 2: SI情報取得（Source Information）
// このファイルのみ編集することで Step2 の挙動・表示を変更できます。
// 他の Step ファイルへの依存: なし
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');

const { callAI }               = require('../scripts/ai_client');
const { fetchWikipediaSafe }   = require('../scripts/modules/fetchers/wikipedia');
const { fetchSofaScorePlayer } = require('../scripts/modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam }   = require('../scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreManager }= require('../scripts/modules/fetchers/sofascore_manager');
const { fetchSofaScoreMatch }  = require('../scripts/modules/fetchers/sofascore_match');
const { fetchSerper }          = require('../scripts/modules/fetchers/serper_module');

const router     = express.Router();
const SI_DIR     = path.join(__dirname, '..', 'data', 'si_data');

// SofaScore 検索結果キャッシュ（メモリ、10分で失効）
const _sfCache = new Map();
const SF_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.sofascore.com/',
  'Origin':          'https://www.sofascore.com',
};

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
  return path.join(SI_DIR, (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '.json');
}

// ─── API ─────────────────────────────────────────────────

// AIキーワード提案（案件選択時に自動呼び出し）
router.post('/suggest-keywords', async (req, res) => {
  const { post } = req.body;
  if (!post) return res.json({ suggestions: [] });
  console.log('[Step2] AIキーワード提案:', post.titleOrig || post.title);
  try {
    const comments = (post.raw?.comments || [])
      .map(c => c.body || '').filter(Boolean).slice(0, 8).join('\n');

    const response = await callAI({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages:   [{ role: 'user', content:
        `Soccer news: identify 5-8 key entities for deep research.
Return ONLY JSON (no markdown): {"suggestions": [{"type": "player"|"team"|"manager"|"match"|"wikipedia"|"news", "word": "English Name"}]}
Title: ${post.titleOrig || post.title}
Comments: ${comments.slice(0, 800)}` }],
    });

    const m = response.match(/\{[\s\S]*\}/);
    res.json(m ? JSON.parse(m[0]) : { suggestions: [] });
  } catch (e) {
    console.error('[Step2] AI提案エラー:', e.message);
    res.json({ suggestions: [] });
  }
});

// SofaScore 全文検索（選手・チーム・監督）
router.post('/search-sofascore', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ candidates: [] });

  const cacheKey = query.toLowerCase().trim();
  const cached   = _sfCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
    console.log('[Step2] SofaScoreキャッシュHIT:', query);
    return res.json({ candidates: cached.data });
  }

  try {
    const r = await axios.get(
      `https://api.sofascore.com/api/v1/search/all?q=${encodeURIComponent(query)}`,
      { headers: SF_HEADERS, timeout: 8000 }
    );
    const candidates = (r.data.results || [])
      .filter(x => ['player', 'team', 'manager'].includes(x.type))
      .slice(0, 8)
      .map(x => ({
        id:   x.entity.id,
        type: x.type,
        name: x.entity.name,
        sub:  x.entity.team?.name || x.entity.category?.name || '',
      }));
    _sfCache.set(cacheKey, { data: candidates, ts: Date.now() });
    res.json({ candidates });
  } catch (e) {
    const code = e.response?.status;
    const msg  = code === 403 ? 'SofaScore: IPブロック(403)。手動追加ボタンを使ってください'
               : code === 429 ? 'SofaScore: レート制限(429)。少し待って再試行してください'
               : e.code === 'ECONNABORTED' ? 'SofaScore: タイムアウト。手動追加ボタンを使ってください'
               : 'SofaScore: ' + e.message;
    console.error('[Step2] SofaScore検索エラー:', msg);
    res.json({ candidates: [], error: msg });
  }
});

// SI情報取得実行（メイン処理）
router.post('/fetch-si', async (req, res) => {
  const { keywords, postId } = req.body;
  if (!keywords?.length) return res.status(400).json({ error: 'keywords required' });
  console.log(`[Step2] SI取得開始: ${keywords.length}件 / postId: ${postId}`);

  const results = {};
  for (const k of keywords) {
    console.log(`  → ${k.type}: ${k.word}`);
    let data = { ok: false, error: '不明なタイプ' };
    try {
      if      (k.type === 'player')    data = await fetchSofaScorePlayer(k.word);
      else if (k.type === 'team')      data = await fetchSofaScoreTeam(k.word);
      else if (k.type === 'manager')   data = await fetchSofaScoreManager(k.word);
      else if (k.type === 'match')     data = await fetchSofaScoreMatch(null, null, k.id);
      else if (k.type === 'wikipedia') data = await fetchWikipediaSafe([k.word, k.word]);
      else if (k.type === 'news') {
        const r = await fetchSerper(k.word, 'news', 'en');
        data = r.organic?.length ? { ok: true, items: r.organic.slice(0, 5) } : { ok: false, error: '結果なし' };
      }
    } catch (e) {
      data = { ok: false, error: e.message };
    }
    data.siType = k.type;
    results[k.word] = data;
  }

  // ファイル保存（既存データとマージ）
  if (postId) {
    try {
      const fp = siPath(postId);
      const existing = safeJson(fp, {});
      fs.writeFileSync(fp, JSON.stringify({ ...existing, ...results }, null, 2));
    } catch (e) {
      console.error('[Step2] SI保存エラー:', e.message);
    }
  }

  res.json({ ok: true, data: results });
});

// SI履歴一覧取得（タイトルとタイプのみ・軽量）
router.get('/si-history', (req, res) => {
  const fp   = siPath(req.query.postId);
  const data = safeJson(fp, {});
  res.json({
    items: Object.keys(data).map(k => ({
      key:    k,
      siType: data[k].siType || 'unknown',
      ok:     data[k].ok !== false,
    })),
  });
});

// SI詳細取得（プレビュー用）
router.get('/si-detail', (req, res) => {
  const fp  = siPath(req.query.postId);
  const key = req.query.key;
  const all = safeJson(fp, {});
  if (!key || !all[key]) return res.status(404).json({ error: 'not found' });
  res.json(all[key]);
});

// SI JSONダウンロード
router.get('/si-download', (req, res) => {
  const fp  = siPath(req.query.postId);
  const key = req.query.key;
  const all = safeJson(fp, {});
  if (!key || !all[key]) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(key)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(all[key], null, 2));
});

// ─── UI（このファイルを触るだけで Step2 表示が変わる）──────

function getUI() {
  return /* html */`
<div id="step2" class="step-container" style="display:none;">

  <!-- 現在の案件タイトル -->
  <div id="s2Title" style="font-size:16px;font-weight:900;color:var(--c);margin-bottom:15px;padding:15px 20px 0;"></div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:0 20px;">

    <!-- 左カラム: 検索 + ラベル -->
    <div>
      <div class="panel" style="margin-bottom:15px;">
        <div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:8px;">🔍 SofaScore検索</div>
        <div style="display:flex;gap:6px;">
          <input type="text" id="s2SearchInput" class="inp" style="flex:1;" placeholder="選手・チーム・監督名..." onkeypress="if(event.key==='Enter')s2Search()">
          <button class="btn btn-primary" onclick="s2Search()">検索</button>
        </div>
        <div id="s2Candidates" style="display:none;background:#0d1220;border:1px solid var(--border);border-radius:6px;margin-top:6px;max-height:160px;overflow-y:auto;"></div>
      </div>

      <div class="panel" style="margin-bottom:15px;">
        <div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:8px;">📌 手動追加</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <input type="text" id="s2QuickWord" class="inp" style="flex:1;min-width:120px;" placeholder="名前 / キーワード..." onkeypress="if(event.key==='Enter')s2QuickAdd('player')">
          <button class="btn btn-sm" onclick="s2QuickAdd('player')" style="background:#1a6ef5;color:#fff;">👤 選手</button>
          <button class="btn btn-sm" onclick="s2QuickAdd('team')"   style="background:#10b981;color:#fff;">🏟️ チーム</button>
          <button class="btn btn-sm" onclick="s2QuickAdd('news')">📰 NEWS</button>
          <button class="btn btn-sm" onclick="s2QuickAdd('wikipedia')">📖 WIKI</button>
        </div>
      </div>

      <div class="panel">
        <div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:8px;">🏷️ 取得キーワード</div>
        <div id="s2Labels" style="display:flex;flex-wrap:wrap;gap:6px;min-height:50px;padding:6px;background:#0d1220;border-radius:6px;"></div>
        <button class="btn btn-success" style="width:100%;margin-top:12px;" onclick="s2FetchSI()">⬇️ SI情報取得実行</button>
      </div>
    </div>

    <!-- 右カラム: プレビュー + 履歴 -->
    <div style="display:flex;flex-direction:column;">
      <div class="panel" style="flex:1;margin-bottom:15px;">
        <div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:8px;">🔍 データプレビュー</div>
        <pre id="s2Preview" style="height:220px;overflow-y:auto;font-size:11px;">案件を選択して SI を取得してね</pre>
      </div>
      <div class="panel">
        <div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:8px;">📂 取得済みデータ一覧</div>
        <div id="s2History" style="max-height:180px;overflow-y:auto;"></div>
      </div>
    </div>

  </div>

  <!-- モジュール提案へ -->
  <div style="padding:20px;">
    <button class="btn btn-primary" style="width:100%;padding:14px;font-size:14px;" onclick="window.goStep(3)">
      ✨ モジュール構成提案へ →
    </button>
  </div>

</div>

<script>
(function() {
  /* === Step2 スコープ（他 Step に干渉しない） === */

  const TYPE_COLOR = {
    player: '#1a6ef5', team: '#10b981', manager: '#f59e0b',
    match: '#8b5cf6', wikipedia: '#6b7280', news: '#ef4444',
  };

  window.step2Init = function() {
    const sel = window.APP.selected;
    if (!sel) return;
    document.getElementById('s2Title').textContent = sel.title || '案件名不明';

    /* AI キーワード提案を非同期で実行 */
    document.getElementById('s2Preview').textContent = '⏳ AI がキーワードを提案中...';
    fetch('/api/suggest-keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post: sel }),
    }).then(r => r.json()).then(d => {
      if (d.suggestions?.length) {
        /* wiki/sofascore の重複防止を考慮して追加 */
        d.suggestions.forEach(s => s2AddLabel(s.type, s.word, null, true));
        document.getElementById('s2Preview').textContent = 'AIキーワード ' + d.suggestions.length + ' 件を自動追加しました。\\n確認・追加後に「SI情報取得実行」を押してください。';
      } else {
        document.getElementById('s2Preview').textContent = 'キーワードを手動で追加してください。';
      }
    }).catch(() => {
      document.getElementById('s2Preview').textContent = 'AI提案に失敗しました。手動で追加してください。';
    });

    /* 既存SI履歴を読み込む */
    s2LoadHistory();
  };

  /* SofaScore 検索 */
  window.s2Search = async function() {
    const q = document.getElementById('s2SearchInput').value.trim();
    if (!q) return;
    const box = document.getElementById('s2Candidates');
    box.style.display = 'block';
    box.innerHTML = '<div style="padding:8px;color:#8a9aba;font-size:12px;">⏳ 検索中...</div>';
    try {
      const d = await fetchJson('/api/search-sofascore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      if (!d.candidates?.length) {
        const errMsg = d.error || '見つかりませんでした';
        const col = d.error ? '#ef4444' : '#8a9aba';
        box.innerHTML = '<div style="padding:8px;color:' + col + ';font-size:12px;">' + _s2Esc(errMsg) + '<br><span style="font-size:10px;color:#6a7a9a;">→ 下の手動追加ボタンで直接入力できます</span></div>';
        return;
      }
      box.innerHTML = d.candidates.map((c, i) =>
        '<div class="cand-row" onclick="_s2PickCand(' + i + ')" data-idx="' + i + '">'
        + '<span style="background:' + (TYPE_COLOR[c.type]||'#555') + ';color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;">' + c.type.toUpperCase() + '</span> '
        + _s2Esc(c.name)
        + (c.sub ? '<span style="color:#8a9aba;font-size:10px;margin-left:4px;">(' + _s2Esc(c.sub) + ')</span>' : '')
        + '</div>'
      ).join('');
      window._s2CandidateCache = d.candidates;
    } catch(e) {
      box.innerHTML = '<div style="padding:8px;color:#ef4444;font-size:12px;">検索エラー: ' + e.message + '</div>';
    }
  };

  window._s2PickCand = function(i) {
    const c = window._s2CandidateCache[i];
    if (!c) return;
    s2AddLabel(c.type, c.name, c.id);
    document.getElementById('s2Candidates').style.display = 'none';
    document.getElementById('s2SearchInput').value = '';
  };

  /* クイック追加（NEWS / WIKI） */
  window.s2QuickAdd = function(type) {
    const w = document.getElementById('s2QuickWord').value.trim();
    if (!w) return alert('キーワードを入力してください');
    s2AddLabel(type, w);
    document.getElementById('s2QuickWord').value = '';
  };

  /* ラベル追加（重複チェック付き） */
  window.s2AddLabel = function(type, word, id, silent) {
    if (!word) return;
    /* wikipedia / sofascore 系は同一ワードを重複追加しない */
    const isUniqueType = ['wikipedia', 'player', 'team', 'manager', 'match'].includes(type);
    if (isUniqueType && window.APP.keywords.find(k => k.word === word)) {
      if (!silent) alert('"' + word + '" は既に追加されています');
      return;
    }
    window.APP.keywords.push({ type, word, id: id || null });
    s2RenderLabels();
  };

  function s2RenderLabels() {
    document.getElementById('s2Labels').innerHTML = window.APP.keywords.map((k, i) =>
      '<div class="label-item" style="background:' + (TYPE_COLOR[k.type]||'#555') + ';">'
      + '<span style="background:rgba(0,0,0,0.3);padding:0 4px;border-radius:3px;font-size:9px;">' + k.type.toUpperCase() + '</span>'
      + ' ' + _s2Esc(k.word)
      + ' <span onclick="s2RemoveLabel(' + i + ')" style="cursor:pointer;opacity:0.7;">×</span>'
      + '</div>'
    ).join('') || '<span style="color:#5a6a8a;font-size:12px;">キーワードを追加してください</span>';
  }

  window.s2RemoveLabel = function(i) {
    window.APP.keywords.splice(i, 1);
    s2RenderLabels();
  };

  /* SI情報取得実行 */
  window.s2FetchSI = async function() {
    if (!window.APP.keywords.length) return alert('キーワードがありません');
    const pre = document.getElementById('s2Preview');
    pre.textContent = '⏳ SI情報を取得中...\\n(' + window.APP.keywords.length + '件)';
    try {
      const d = await fetchJson('/api/fetch-si', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: window.APP.keywords,
          postId:   window.APP.selected?.id,
        }),
      });
      window.APP.siData = d.data || {};
      const ok  = Object.values(window.APP.siData).filter(v => v.ok !== false).length;
      const all = Object.keys(window.APP.siData).length;
      pre.textContent = '✅ 取得完了: ' + ok + '/' + all + ' 件成功\\n左の履歴から確認できます。';
      window.APP.keywords = [];
      s2RenderLabels();
      s2LoadHistory();
    } catch(e) {
      pre.textContent = '❌ 取得失敗: ' + e.message;
    }
  };

  /* SI履歴読み込み */
  function s2LoadHistory() {
    const id = window.APP.selected?.id;
    if (!id) return;
    fetch('/api/si-history?postId=' + encodeURIComponent(id))
      .then(r => r.json()).then(s2RenderHistory).catch(() => {});
  }

  function s2RenderHistory(d) {
    const items = d.items || [];
    document.getElementById('s2History').innerHTML = items.length
      ? items.map((item, i) => {
          const col   = TYPE_COLOR[item.siType] || '#555';
          const dot   = item.ok ? '🟢' : '🔴';
          const dlUrl = '/api/si-download?postId='
                        + encodeURIComponent(window.APP.selected?.id||'')
                        + '&key=' + encodeURIComponent(item.key);
          return '<div class="si-hist-row">'
            + '<span style="background:' + col + ';color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">' + (item.siType||'?').toUpperCase() + '</span>'
            + ' ' + dot + ' <span style="flex:1;cursor:pointer;" onclick="_s2Preview(' + i + ')">' + _s2Esc(item.key) + '</span>'
            + '<a href="' + dlUrl + '" download title="JSONダウンロード" style="color:#8a9aba;text-decoration:none;margin-left:6px;">⬇️</a>'
            + '</div>';
        }).join('')
      : '<div style="padding:10px;font-size:11px;color:#5a6a8a;">取得済みデータはありません</div>';
    window._s2HistItems = items;
  }

  window._s2Preview = async function(i) {
    const item = window._s2HistItems?.[i];
    if (!item) return;
    try {
      const d = await fetchJson('/api/si-detail?postId='
        + encodeURIComponent(window.APP.selected?.id||'')
        + '&key=' + encodeURIComponent(item.key));
      document.getElementById('s2Preview').textContent = _s2Format(d);
    } catch(e) {
      document.getElementById('s2Preview').textContent = '取得失敗: ' + e.message;
    }
  };

  function _s2Format(d) {
    if (!d) return '(データなし)';
    if (d.siType === 'player' && d.name)
      return '【選手】' + d.name + '\\n位置: ' + (d.position||'?')
        + ' / 年齢: ' + (d.age||'?') + ' / 所属: ' + (d.team||'?')
        + '\\n直近レーティング: ' + (d.recentAvgRating||'?')
        + '\\n今シーズン: ' + (d.seasonStats?.goals||0) + 'G ' + (d.seasonStats?.assists||0) + 'A'
        + ' (' + (d.leagueName||'?') + ')';
    if (d.siType === 'team' && d.teamName)
      return '【チーム】' + d.teamName + '\\nリーグ: ' + (d.leagueName||'?')
        + ' / 順位: ' + (d.standing?.position||'?') + '位'
        + '\\n直近5試合: ' + (d.last5?.map(m=>m.result).join(' ')||'なし');
    return JSON.stringify(d, null, 2).slice(0, 2000);
  }

  function _s2Esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

})();
</script>`;
}

module.exports = { router, getUI };
