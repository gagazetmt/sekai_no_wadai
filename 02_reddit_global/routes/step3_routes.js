// routes/step3_routes.js  (V3 redesign)
// ═══════════════════════════════════════════════════════════
// STEP 3: 構成提案（V3）
//   - 主タグ × 従タグの二重プルダウンでoutlineを構築
//   - 各行に scriptDir
//   - 「✨ 脚本生成」で /api/v3/generate-scenario を呼び、
//     全カードの narration + dataSlots を一括生成
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router   = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const SI_DIR   = path.join(DATA_DIR, 'si_data');

const { listMainTags, getSubTagsForMain, resolveType, parseMainKey } = require('../scripts/v3_tags');
const { callAI } = require('../scripts/ai_client');
const { fetchWikipediaWikitext } = require('../scripts/modules/fetchers/wikipedia');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return fallback; }
}
function siPath(postId)      { return path.join(SI_DIR,   (postId||'unknown').replace(/[/\?%*:|"<>.]/g,'_') + '.json'); }
function modulesPath(postId) { return path.join(DATA_DIR, (postId||'unknown').replace(/[/\?%*:|"<>.]/g,'_') + '_modules.json'); }

// ─── /api/v3/main-tags : メインタグ一覧（プルダウン用）─────
router.get('/v3/main-tags', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.json({ tags: [] });
  const si = safeJson(siPath(postId), {});
  res.json({ tags: listMainTags(si) });
});

// ─── /api/v3/sub-tags : メインに対する従タグ一覧 ─────────
router.get('/v3/sub-tags', (req, res) => {
  const { postId, mainKey } = req.query;
  if (!postId || !mainKey) return res.json({ subs: [] });
  const si = safeJson(siPath(postId), {});
  res.json({ subs: getSubTagsForMain(mainKey, si) });
});

// ─── /api/save-modules : modules.json 書込（既存互換）─────
router.post('/save-modules', (req, res) => {
  const { postId, modules } = req.body;
  if (!postId || !Array.isArray(modules)) return res.status(400).json({ error: 'postId + modules required' });
  try {
    fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── /api/v3/modules : 読み込み（postId別）─────────────
router.get('/v3/modules', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.json({ modules: [] });
  const j = safeJson(modulesPath(postId), { modules: [] });
  res.json(j);
});

// ─── /api/v3/generate-scenario : 全カード一括生成 ──────
// 入力: { postId, modules: [{mainKey, subSource, subValue, type, scriptDir}] }
// 出力: { ok, modules: [...各カードに narration / dataSlots / catchphrases / comments を追加] }
router.post('/v3/generate-scenario', async (req, res) => {
  const { postId, modules: mods, post: postIn } = req.body;
  if (!postId || !Array.isArray(mods) || !mods.length) {
    return res.status(400).json({ error: 'postId + modules[] required' });
  }
  try {
    const si       = safeJson(siPath(postId), { boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } } });
    const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

    // post 情報（タイトル+コメント）はクライアント送ってこれてもwindow.APP.selected経由で来ない可能性がある
    // 必須でないが、付加情報として使う
    const post = postIn || {};
    const titleJa = post.titleJa || post.title || '(案件タイトル不明)';
    const commentsRaw = (post.raw?.comments || [])
      .map(c => c.bodyJa || c.body || '').filter(Boolean).slice(0, 8).join(' / ').slice(0, 1500);

    // ── データソース要約：siData entity/match/search を AIプロンプト用に圧縮 ──
    function _entityBlock(it) {
      const role = it.role;
      const wikiSum = it.wiki?.ok
        ? `wiki:{title:"${it.wiki.title || ''}",extract:"${(it.wiki.extract || '').slice(0, 250)}"}` : 'wiki:×';
      const sofaSum = it.sofa?.ok
        ? `sofa:${JSON.stringify({
            name: it.sofa.name || it.sofa.teamName,
            position: it.sofa.position, team: it.sofa.team,
            league: it.sofa.leagueName, country: it.sofa.country,
            standing: it.sofa.standing, manager: it.sofa.managerName,
            seasonStats: it.sofa.seasonStats, lastMatchStats: it.sofa.lastMatchStats,
            recentAvgRating: it.sofa.recentAvgRating,
            currentTeam: it.sofa.currentTeam,
            overallPerformance: it.sofa.overallPerformance,
            currentTeamStats: it.sofa.currentTeamStats,
          }).slice(0, 700)}` : 'sofa:×';
      return `- "${it.label}" [${role}]\n  ${wikiSum}\n  ${sofaSum}`;
    }
    function _matchBlock(it) {
      if (!it.data?.ok) return `- "${it.label}" : 取得失敗`;
      return `- "${it.label}" : ${JSON.stringify({
        scoreline: it.data.scoreline, date: it.data.matchDate,
        tournament: it.data.tournament, venue: it.data.venue,
        goals: (it.data.goals || []).slice(0, 5),
        topPlayers: (it.data.topPlayers || []).slice(0, 3),
        h2hSummary: it.data.h2hSummary,
      }).slice(0, 700)}`;
    }
    function _searchBlock(it) {
      if (!it.data?.organic) return `- "${it.label}" : 結果なし`;
      const top = it.data.organic.slice(0, 3).map(r => `${r.title}: ${r.snippet?.slice(0,120)||''}`).join(' / ');
      return `- "${it.label}" : ${top.slice(0, 500)}`;
    }
    const entityBlock = (si.boxes.entity.items || []).map(_entityBlock).join('\n') || '(なし)';
    const matchBlock  = (si.boxes.match.items  || []).map(_matchBlock).join('\n')  || '(なし)';
    const searchBlock = (si.boxes.search.items || []).map(_searchBlock).join('\n') || '(なし)';

    // ── outline ブロック化 ──
    const outlineLines = mods.map((m, i) => {
      const tags = `main="${m.mainKey}"` + (m.subSource ? ` sub="${m.subSource}:${m.subValue}"` : '');
      return `${i+1}. type=${m.type || '?'} ${tags}\n   scriptDir: ${m.scriptDir || '(指示なし)'}`;
    }).join('\n');

    // ── プロンプト ──
    const prompt = `あなたはサッカーYouTubeのプロ脚本家です。
以下の outline と取得済み素材から、各カードの本体（narration、データ、キャッチコピー等）を生成してください。

【今日の日付】${todayJst}（JST）
【案件】${titleJa}
${commentsRaw ? `【元コメント抜粋】${commentsRaw}\n` : ''}
━━━ 取得済みデータ ━━━
[entity 一覧]
${entityBlock}

[match 一覧]
${matchBlock}

[search 一覧]
${searchBlock}
━━━━━━━━━━━━━━━━

【outline (${mods.length}枚)】
${outlineLines}

【生成ルール】
各カードに対して必要なフィールドを全部 JSON で返す：

- 全カード共通：
  - "title": 短い見出し（10〜25文字）
  - "narration": 視聴者に語りかける口調の本文（type=opening/ending/insight/reaction は120〜250文字、stats/comparison/history/matchcard は60〜180文字）

- type 別の追加フィールド：
  - opening / ending: 追加なし
  - insight: "catchphrases": [短句×3〜5、各15文字以内、事実+数字を含む]
  - reaction: "comments": [{"text":"...","score":0}×7] — 上記【元コメント抜粋】から面白い7件を選び日本語意訳
  - stats / matchcard / history: "dataSlots": [{"label":"...","value":"..."}×4〜8]
  - comparison: "dataSlots": [{"label":"...","leftValue":"...","rightValue":"..."}×4〜8]

【データ抽出ルール（厳守）】
- mainKey="entity:<名前>" のカードでは、上記 [entity 一覧] の該当エントリを **データソース** として使う
- mainKey="match:<...>" のカードは [match 一覧] を使う
- 一次情報だけで完結しない場合も、保有情報を解析して受け渡す。例: 選手の各チームへの移籍年とゴール数 → wiki.extract や sofa から抽出して並べる
- subValue が "history" → dataSlots は {label:年, value:出来事} の時系列
- subValue が "compare" → dataSlots は左右比較形式
- subValue が "season" / "match" / "profile" → dataSlots は {label, value} の現在系
- subValue が "titles" → dataSlots は獲得トロフィー一覧

【ハルシネーション禁止 — 厳守】
- 値・固有名は必ず上記取得済みデータに明記されているもののみ
- データに無いものは出力しない（推測・記憶からの補完絶対NG）
- あなたの学習データ（2024年〜）は古い。現在の監督・所属はデータからのみ参照
- 前後カードの文脈が自然につながるように構成する

JSON のみ返す（マークダウン不要）：
{"modules":[
  {"title":"...","narration":"...",...type別フィールド},
  ... (${mods.length}枚)
]}`;

    console.log(`[Step3 v3] generate-scenario: ${mods.length}カード / DeepSeek 試行`);

    // DeepSeek 既定 → JSON崩れ時 Sonnet
    async function _ask(provider) {
      const model = provider === 'deepseek' ? 'deepseek-chat' : 'claude-sonnet-4-6';
      return callAI({
        forceProvider: provider,
        model, max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }],
      });
    }
    function _parse(raw) {
      const m = raw && raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }

    let raw, parsed = null, used = 'deepseek';
    try {
      raw    = await _ask('deepseek');
      parsed = _parse(raw);
    } catch (e) { console.warn('[Step3 v3] deepseek 例外:', e.message); }
    if (!parsed?.modules) {
      console.warn('[Step3 v3] deepseek 失敗、Sonnet にフォールバック');
      raw    = await _ask('anthropic');
      parsed = _parse(raw);
      used   = 'sonnet';
    }
    if (!parsed?.modules) return res.status(500).json({ error: '生成失敗（JSON parse fail）' });

    // outline と AI返却をマージ（順序保持）
    const merged = mods.map((src, i) => {
      const ai = parsed.modules[i] || {};
      return {
        ...src,
        title:        ai.title        || src.title        || `スライド${i+1}`,
        narration:    ai.narration    || '',
        dataSlots:    ai.dataSlots    || [],
        catchphrases: ai.catchphrases || [],
        comments:     ai.comments     || [],
      };
    });

    // 永続化
    fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules: merged, savedAt: new Date().toISOString() }, null, 2));

    console.log(`[Step3 v3] 生成完了: ${merged.length}カード / ${used}`);
    res.json({ ok: true, modules: merged, source: used });
  } catch (e) {
    console.error('[Step3 v3] generate-scenario エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── UI ─────────────────────────────────────────────────
function getUI() {
  return `
<div id="step3" class="step-container" style="display:none">
<div style="padding:0 20px 20px;">

  <!-- TOP PANEL -->
  <div class="panel" style="margin-bottom:14px;">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span id="s3Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">案件を選択してください</span>
      <button class="btn btn-sm" id="s3BtnAddRow" style="background:#10b981;color:#fff;">＋ 行追加</button>
      <button class="btn btn-primary" id="s3BtnGenerate" style="font-size:13px;padding:8px 18px;">✨ 脚本生成（一括）</button>
      <button class="btn btn-success" id="s3BtnNext" style="font-size:13px;padding:8px 18px;">→ Step4 (動画生成)</button>
      <span id="s3Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
  </div>

  <!-- OUTLINE TABLE -->
  <div class="panel">
    <div style="font-size:12px;color:var(--c);font-weight:bold;margin-bottom:10px;">📋 アウトライン（主タグ × 従タグ + 脚本指示）</div>
    <div id="s3OutlineList"></div>
  </div>

  <!-- 生成結果プレビュー -->
  <div class="panel" style="margin-top:14px;">
    <div style="font-size:12px;color:#8a9aba;font-weight:bold;margin-bottom:8px;">📋 生成結果プレビュー</div>
    <pre id="s3ModulesPreview" style="max-height:240px;overflow-y:auto;font-size:10px;margin:0">（脚本生成後に表示）</pre>
  </div>
</div>
</div>

<script>
(function() {
  'use strict';

  window.APP = window.APP || {};
  window.APP.s3 = { mainTags: [], subTagsCache: {}, modules: [] };

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _msg(s) { const e = document.getElementById('s3Msg'); if (e) e.innerHTML = s; }

  /* ── 初期化 ── */
  window.step3Init = async function() {
    const post = window.APP.selected;
    document.getElementById('s3Title').textContent = post
      ? (post.titleJa || post.title || '(タイトル不明)').slice(0, 80)
      : '案件を選択してください';
    if (!post?.id) { _renderOutline(); return; }
    try {
      // メインタグ一覧読込
      const t = await fetchJson('/api/v3/main-tags?postId=' + encodeURIComponent(post.id));
      window.APP.s3.mainTags = t.tags || [];
      // 既存modules読込
      const m = await fetchJson('/api/v3/modules?postId=' + encodeURIComponent(post.id));
      window.APP.s3.modules = m.modules || [];
      // 空ならデフォルト3行 (opening / 1空行 / ending)
      if (!window.APP.s3.modules.length) {
        window.APP.s3.modules = [
          { mainKey: 'opening',  subSource: null, subValue: null, type: 'opening', scriptDir: '' },
          { mainKey: '',         subSource: null, subValue: null, type: '',        scriptDir: '' },
          { mainKey: 'ending',   subSource: null, subValue: null, type: 'ending',  scriptDir: '' },
        ];
      }
    } catch (e) {
      console.warn('[Step3] 初期化失敗:', e.message);
    }
    _renderOutline();
    _renderModulesPreview();
  };

  /* ── outline 描画 ── */
  function _renderOutline() {
    const el = document.getElementById('s3OutlineList');
    if (!el) return;
    const mods = window.APP.s3.modules;
    if (!mods.length) {
      el.innerHTML = '<div style="padding:20px;color:#5a6a8a;text-align:center;font-size:12px;">「+ 行追加」で始める</div>';
      return;
    }

    // 各行 HTML
    el.innerHTML = mods.map(function(m, idx) {
      const mainOpts = _buildMainOptions(m.mainKey);
      const subOpts  = _buildSubOptions(m.mainKey, m.subSource, m.subValue);
      return ''
        + '<div class="s3-row" data-idx="' + idx + '" style="display:grid;grid-template-columns:30px 200px 200px 1fr 28px 28px 28px;gap:6px;align-items:start;margin-bottom:6px;padding:8px;background:#0d1220;border-radius:6px;">'
        + '<span style="font-size:10px;color:#8a9aba;text-align:center;padding-top:8px;">#' + (idx+1) + '</span>'
        + '<select class="inp s3-main" data-idx="' + idx + '" style="font-size:11px;padding:5px 6px;" onchange="s3OnMainChange(' + idx + ')">' + mainOpts + '</select>'
        + '<select class="inp s3-sub"  data-idx="' + idx + '" style="font-size:11px;padding:5px 6px;" onchange="s3OnSubChange(' + idx + ')">' + subOpts + '</select>'
        + '<textarea class="inp s3-script" data-idx="' + idx + '" placeholder="脚本指示（このスライドで何を伝えるか具体的に）"'
        + ' style="font-size:11px;padding:5px 8px;min-height:54px;resize:vertical;" oninput="s3OnScriptInput(' + idx + ')">' + _esc(m.scriptDir||'') + '</textarea>'
        + '<button class="btn btn-sm" onclick="s3MoveRow(' + idx + ',-1)" style="background:#475569;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">↑</button>'
        + '<button class="btn btn-sm" onclick="s3MoveRow(' + idx + ',1)"  style="background:#475569;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">↓</button>'
        + '<button class="btn btn-sm" onclick="s3RemoveRow(' + idx + ')"  style="background:#ef4444;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">×</button>'
        + '</div>';
    }).join('');
  }

  function _buildMainOptions(currentKey) {
    const tags = window.APP.s3.mainTags || [];
    const opts = ['<option value="">-- 選択 --</option>'];
    tags.forEach(function(t) {
      opts.push('<option value="' + _esc(t.key) + '"' + (t.key === currentKey ? ' selected' : '') + '>' + _esc(t.label) + '</option>');
    });
    return opts.join('');
  }

  function _buildSubOptions(mainKey, currentSource, currentValue) {
    if (!mainKey) return '<option value="">-- メイン未選択 --</option>';
    const subs = window.APP.s3.subTagsCache[mainKey] || _loadSubsSync(mainKey);
    if (!subs || !subs.length) return '<option value="" selected>(なし)</option>';
    const cur = currentSource && currentValue ? (currentSource + ':' + currentValue) : '';
    return '<option value="">-- 選択 --</option>'
      + subs.map(function(s) {
          const v = s.source + ':' + s.value;
          return '<option value="' + _esc(v) + '"' + (v === cur ? ' selected' : '') + '>'
            + _esc(s.label) + ' [' + _esc(s.source) + '/' + _esc(s.type) + ']</option>';
        }).join('');
  }

  /* 同期キャッシュ参照（無ければ非同期で取得して再描画） */
  function _loadSubsSync(mainKey) {
    const post = window.APP.selected;
    if (!post?.id || !mainKey) return null;
    const cache = window.APP.s3.subTagsCache;
    if (cache[mainKey] !== undefined) return cache[mainKey];
    cache[mainKey] = []; // プレースホルダ（再帰防止）
    fetchJson('/api/v3/sub-tags?postId=' + encodeURIComponent(post.id) + '&mainKey=' + encodeURIComponent(mainKey))
      .then(function(j) {
        cache[mainKey] = j.subs || [];
        _renderOutline();
      })
      .catch(function(){});
    return [];
  }

  /* ── 行操作 ── */
  window.s3OnMainChange = function(idx) {
    _collectInputs();
    const m = window.APP.s3.modules[idx];
    const sel = document.querySelectorAll('.s3-main')[idx];
    m.mainKey = sel.value;
    m.subSource = null;
    m.subValue  = null;
    m.type      = '';  // サブ選択で決まる
    // 固定タグなら type 直接決定
    const t = (window.APP.s3.mainTags || []).find(x => x.key === m.mainKey);
    if (t?.kind === 'fixed') {
      const fixedTypeMap = { opening: 'opening', toc: 'insight', overview: 'insight', reaction: 'reaction', ending: 'ending' };
      m.type = fixedTypeMap[m.mainKey] || '';
    }
    _renderOutline();
  };
  window.s3OnSubChange = function(idx) {
    _collectInputs();
    const m = window.APP.s3.modules[idx];
    const sel = document.querySelectorAll('.s3-sub')[idx];
    const v = sel.value || '';
    if (v) {
      const [source, value] = v.split(':');
      m.subSource = source;
      m.subValue  = value;
      const subs = window.APP.s3.subTagsCache[m.mainKey] || [];
      const hit = subs.find(s => s.source === source && s.value === value);
      m.type = hit?.type || '';
    } else {
      m.subSource = null;
      m.subValue  = null;
    }
  };
  window.s3OnScriptInput = function(idx) {
    const m = window.APP.s3.modules[idx];
    const ta = document.querySelectorAll('.s3-script')[idx];
    m.scriptDir = ta.value;
  };
  window.s3MoveRow = function(idx, delta) {
    _collectInputs();
    const arr = window.APP.s3.modules;
    const ni  = idx + delta;
    if (ni < 0 || ni >= arr.length) return;
    const tmp = arr[idx]; arr[idx] = arr[ni]; arr[ni] = tmp;
    _renderOutline();
  };
  window.s3RemoveRow = function(idx) {
    _collectInputs();
    window.APP.s3.modules.splice(idx, 1);
    _renderOutline();
  };

  function _collectInputs() {
    const ta = document.querySelectorAll('.s3-script');
    ta.forEach(function(el, i) {
      if (window.APP.s3.modules[i]) window.APP.s3.modules[i].scriptDir = el.value;
    });
  }

  /* ── 行追加 ── */
  document.getElementById('s3BtnAddRow').addEventListener('click', function() {
    _collectInputs();
    window.APP.s3.modules.push({ mainKey: '', subSource: null, subValue: null, type: '', scriptDir: '' });
    _renderOutline();
  });

  /* ── 脚本生成 ── */
  document.getElementById('s3BtnGenerate').addEventListener('click', async function() {
    _collectInputs();
    const post = window.APP.selected;
    if (!post?.id) return;
    const mods = window.APP.s3.modules.filter(m => m.mainKey);
    if (!mods.length) { _msg('⚠ 行が空です'); return; }
    _msg('⏳ Sonnet が脚本生成中...');
    try {
      const j = await fetchJson('/api/v3/generate-scenario', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: mods, post }),
      });
      window.APP.s3.modules = j.modules || mods;
      window.APP.modules = window.APP.s3.modules;
      // サーバ保存
      await fetchJson('/api/save-modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: window.APP.s3.modules }),
      });
      _renderOutline();
      _renderModulesPreview();
      _msg('✅ ' + window.APP.s3.modules.length + 'カード生成完了');
    } catch (e) {
      _msg('❌ ' + e.message);
    }
  });

  /* ── Step4 へ ── */
  document.getElementById('s3BtnNext').addEventListener('click', async function() {
    _collectInputs();
    const post = window.APP.selected;
    if (!post?.id) return;
    // 保存してから遷移
    try {
      await fetchJson('/api/save-modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: window.APP.s3.modules }),
      });
    } catch (_) {}
    if (typeof window.goStep === 'function') window.goStep(4);
  });

  function _renderModulesPreview() {
    const el = document.getElementById('s3ModulesPreview');
    if (!el) return;
    const mods = window.APP.s3.modules || [];
    el.textContent = JSON.stringify(mods, null, 2);
  }

})();
</script>`;
}

module.exports = { router, getUI };
