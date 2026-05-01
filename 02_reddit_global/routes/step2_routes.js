// routes/step2_routes.js  (V3 redesign)
// ═══════════════════════════════════════════════════════════
// STEP 2: SI情報取得（V3：3ボックス制）
//   - entity: 固有名ラベル {label, role: player|manager|team|tournament}
//             → Wikipedia + SofaScore 両方を並列取得
//   - match : チーム×チーム → SofaScore Match
//   - search: ニュース検索ワード → Serper
// 役割タグはラベル名に [選手][監督][チーム][大会] 形式で含む
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const { callAI }                = require('../scripts/ai_client');
const { fetchWikipediaSafe }    = require('../scripts/modules/fetchers/wikipedia');
const { fetchSofaScorePlayer }     = require('../scripts/modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam }       = require('../scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreManager }    = require('../scripts/modules/fetchers/sofascore_manager');
const { fetchSofaScoreMatch }      = require('../scripts/modules/fetchers/sofascore_match');
const { fetchSofaScoreTournament } = require('../scripts/modules/fetchers/sofascore_tournament');
const { fetchSerper }              = require('../scripts/modules/fetchers/serper_module');

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
    version:   'v3',
    boxes: {
      entity: { items: [] },  // [{label, role, wiki, sofa, fetchedAt, error}]
      match:  { items: [] },  // [{label, data, fetchedAt, error}]
      search: { items: [] },  // [{label, data, fetchedAt, error}]
    },
  };
}

// 役割の表示suffix
const ROLE_SUFFIX = { player: '選手', manager: '監督', team: 'チーム', tournament: '大会' };

// 既存siDataがv2形式ならv3スケルトンに移行（旧フィールドは捨てる）
function ensureV3(siData, postId) {
  if (siData?.version === 'v3') return siData;
  return emptySiData(postId);
}

// ─── /v3/si-data : 取得 ─────────────────────────────────
router.get('/si-data', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  let si = safeJson(siPath(postId), null);
  if (!si) si = emptySiData(postId);
  else     si = ensureV3(si, postId);
  res.json(si);
});

// ─── /v3/si-data : 上書き保存（手動編集後）─────────────
router.post('/si-data', (req, res) => {
  const { postId, siData } = req.body;
  if (!postId || !siData) return res.status(400).json({ error: 'postId + siData required' });
  try {
    const v3 = ensureV3(siData, postId);
    fs.writeFileSync(siPath(postId), JSON.stringify(v3, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── /v3/suggest-labels : AIラベル提案（3ボックス分） ─────
// ─── AI ラベル提案ヘルパ ───────────────────────────────────
function _parseEntities(raw) {
  const m = raw && raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// 名前で重複排除 + フルネームフィルタ
//   player/manager は「複数単語のフルネーム」必須（"Kane" 単体は除外）
//   team/tournament は1単語OK
function _dedupeEntities(...lists) {
  const seen = new Set();
  const out = [];
  lists.flat().forEach(e => {
    if (!e?.name || !e?.role) return;
    const name = String(e.name).trim();
    const role = String(e.role).trim();
    // player/manager は単語数 >= 2 必須（フルネームフィルタ）
    if ((role === 'player' || role === 'manager') && name.split(/\s+/).filter(Boolean).length < 2) {
      return; // 1単語だけ（"Kane" "Jamie" 等）は除外
    }
    const key = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, role });
  });
  return out;
}

router.post('/v3/suggest-labels', async (req, res) => {
  const { post } = req.body;
  if (!post) return res.status(400).json({ error: 'post required' });

  const title    = post.titleOrig || post.title || '';
  const titleJa  = post.titleJa   || '';
  const selftext = (post.selftext || post.raw?.selftext || '').slice(0, 2000);
  const commentsArr = (post.raw?.comments || []).map(c => c.body || '').filter(Boolean);
  const comments = commentsArr
    .slice(0, 15)
    .map(c => c.replace(/\n+/g, ' ').slice(0, 180))
    .join('\n')
    .slice(0, 2500);

  console.log('[Step2 v3] AIラベル提案 2段プロセス:', (titleJa || title).slice(0, 60));

  // ── Phase 1: 軽量ラベル提案（DeepSeek、チーム・大会・検索クエリ中心）──
  const phase1Prompt = `あなたはサッカーニュース解析の専門家です。以下の案件から、SI取得用ラベルを3カテゴリで提案してください。

【案件 (英語原文)】 ${title}
${titleJa ? `【案件 (日本語訳)】 ${titleJa}\n` : ''}${selftext ? `\n【本文】\n${selftext}\n` : ''}
【元コメント抜粋】
${comments || '(なし)'}

【ルール】
- entities: 案件に**直接関係する**チーム・大会・選手・監督のみ最大8件
  - role は "player" / "manager" / "team" / "tournament"
  - 公式英語表記
  - **必ずフルネーム**（"Kane" だけ NG → "Harry Kane"）
  - **以下は除外**:
    ・解説者・アナリスト（例: Thierry Henry, Jamie Carragher, Micah Richards, Gary Lineker, Rio Ferdinand）
    ・他チーム監督の比較言及（例: コメで "Simeone and Arteta would..." → Simeone/Arteta は除外）
    ・過去の選手の比較言及（例: "Like Messi vs Ronaldo days" → メッシ/ロナウドは除外）
  - 推測しない（タイトル・本文・コメントに登場し、かつ案件のテーマに直接関係するもののみ）
- matches: 試合があれば「HomeTeam vs AwayTeam」最大2件
- searches: ニュース検索キーワード（英語、選手名検索に使えるもの）最大3件
  - **試合関連なら必ず "scorers" "goals" "key players" "match report" 等の選手名抽出キーワードを含める**
    ・例OK: "PSG Bayern Munich semifinal goals scorers"
    ・例OK: "PSG Bayern match report goals players"
    ・例NG: "PSG Bayern 5-4 semifinal" （スコアだけだと総括記事に偏り選手名出ない）

JSONのみ:
{
  "entities": [{"name":"...","role":"..."}],
  "matches": ["..."],
  "searches": ["..."]
}`;

  // Sonnet 既定（label 厳密性・JSON 安定性を優先） → JSON parse 失敗時 v4flash 保険
  async function _askPhase1(provider) {
    const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
    return callAI({ forceProvider: provider, model, max_tokens: 1500, messages: [{ role: 'user', content: phase1Prompt }] });
  }
  let phase1 = null;
  try {
    const raw = await _askPhase1('anthropic');
    phase1 = _parseEntities(raw);
    if (!phase1) console.warn('[Step2 phase1] sonnet JSON parse 失敗 / raw=' + (raw||'').slice(0, 200));
  } catch (e) { console.warn('[Step2 phase1] sonnet 例外:', e.message); }
  if (!phase1) {
    console.warn('[Step2 phase1] sonnet 失敗、v4flash にフォールバック');
    try {
      const raw = await _askPhase1('deepseek');
      phase1 = _parseEntities(raw);
      if (!phase1) console.warn('[Step2 phase1] v4flash も JSON parse 失敗 / raw=' + (raw||'').slice(0, 200));
    } catch (e) { console.warn('[Step2 phase1] v4flash 例外:', e.message); }
  }
  if (!phase1) return res.json({ entities: [], matches: [], searches: [] });

  const phase1Entities = Array.isArray(phase1.entities) ? phase1.entities : [];
  const matches  = Array.isArray(phase1.matches)  ? phase1.matches.filter(Boolean)  : [];
  const searches = Array.isArray(phase1.searches) ? phase1.searches.filter(Boolean) : [];
  console.log(`  Phase1: entities ${phase1Entities.length} / matches ${matches.length} / searches ${searches.length}`);

  // ── Phase 2: 検索でニュース取得 → 追加選手抽出（DeepSeek）──
  //   最大2クエリを並列で叩いて結果をマージ。1クエリだと当たり外れが大きいため
  let newsContext = '';
  if (searches.length) {
    const queriesToTry = searches.slice(0, 2);
    try {
      const newsResults = await Promise.all(queriesToTry.map(q =>
        fetchSerper(q).catch(e => ({ ok: false, error: e.message }))
      ));
      const allOrganic = [];
      newsResults.forEach((news, i) => {
        if (news?.organic?.length) {
          console.log(`  Serper: "${queriesToTry[i]}" → ${news.organic.length}件`);
          allOrganic.push(...news.organic);
        }
      });
      if (allOrganic.length) {
        // タイトル重複排除
        const seen = new Set();
        const dedup = allOrganic.filter(r => {
          const k = (r.title || '').trim().toLowerCase();
          if (!k || seen.has(k)) return false;
          seen.add(k); return true;
        });
        newsContext = dedup.slice(0, 12)
          .map(r => `- ${r.title || ''}: ${(r.snippet || '').slice(0, 220)}`)
          .join('\n')
          .slice(0, 3500);
      }
    } catch (e) { console.warn('[Step2 phase2-news] エラー:', e.message); }
  }

  let phase2Entities = [];
  if (newsContext) {
    const phase2Prompt = `以下のニュース見出しに登場する**追加の選手・監督名**を抽出してください。

【既存 entities（重複させない）】
${phase1Entities.map(e => `- ${e.name} [${e.role}]`).join('\n') || '(なし)'}

【ニュース見出し+概要】
${newsContext}

【案件タイトル】 ${titleJa || title}

【ルール】
- ニュース見出し・概要に **明示的に書かれてる人名** だけを entity 化（捏造禁止）
- **試合に直接関係する人物のみ抽出**:
  ・OK: 試合に出場した選手 / 試合のチーム監督 / 得点者・主役選手
  ・NG: 解説者・アナリスト・コメンテーター
       例: Thierry Henry / Jamie Carragher / Micah Richards / Gary Lineker / Rio Ferdinand / Peter Drury
  ・NG: 他チーム監督・他チーム選手の比較言及（例: "Like Simeone's Atletico" → Simeone は除外）
  ・NG: 記者・ジャーナリストの名前
- **公式英語フルネーム必須**:
  ・OK: "Harry Kane", "Khvicha Kvaratskhelia", "Ousmane Dembélé", "Désiré Doué"
  ・NG: "Kane" 単体, "Jamie" 単体, "Micah" 単体（ファーストネームだけ NG）
  ・NG: 苗字だけしか分からない人物は除外
- role は "player" または "manager"
- チーム・大会は不要（既存に含まれる）
- 最大 8件の追加。既存と重複しないもののみ
- 見出しに人名が無ければ空配列でOK

JSONのみ:
{"entities": [{"name":"...","role":"..."}]}`;

    // Sonnet 既定 → v4flash 保険
    async function _askPhase2(provider) {
      const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
      return callAI({ forceProvider: provider, model, max_tokens: 1200, messages: [{ role: 'user', content: phase2Prompt }] });
    }
    try {
      const raw = await _askPhase2('anthropic');
      const p2 = _parseEntities(raw);
      if (Array.isArray(p2?.entities)) {
        phase2Entities = p2.entities;
        console.log(`  Phase2: 追加 entities ${phase2Entities.length}件 (sonnet)`);
      } else {
        console.warn('[Step2 phase2-ai] sonnet JSON parse 失敗、v4flash にフォールバック');
        const raw2 = await _askPhase2('deepseek');
        const p2b = _parseEntities(raw2);
        if (Array.isArray(p2b?.entities)) {
          phase2Entities = p2b.entities;
          console.log(`  Phase2: 追加 entities ${phase2Entities.length}件 (v4flash fb)`);
        }
      }
    } catch (e) { console.warn('[Step2 phase2-ai] 例外:', e.message); }
  }

  // ── マージ・重複排除 ───────────────────────────────────
  const merged = _dedupeEntities(phase1Entities, phase2Entities);
  console.log(`  マージ後 entities: ${merged.length}件 (P1=${phase1Entities.length} + P2=${phase2Entities.length} - 重複)`);

  res.json({
    entities: merged,
    matches,
    searches,
  });
});

// ─── 個別 fetcher（box種別 + label）─────────────────────
async function _fetchEntity(label, role) {
  // Wiki + Sofa 並列取得（roleごとに sofa fetcher を選択）
  const sofaFetcher = ({
    player:     fetchSofaScorePlayer,
    manager:    fetchSofaScoreManager,
    team:       fetchSofaScoreTeam,
    tournament: fetchSofaScoreTournament,
  })[role];

  const tasks = [
    fetchWikipediaSafe(label).catch(e => ({ ok: false, error: e.message })),
  ];
  if (sofaFetcher) tasks.push(sofaFetcher(label).catch(e => ({ ok: false, error: e.message })));
  else             tasks.push(Promise.resolve(null));

  const [wiki, sofa] = await Promise.all(tasks);
  return { wiki, sofa };
}

async function _fetchMatch(label) {
  const parts = label.split(/\s+vs\s+/i).map(s => s.trim());
  if (parts.length < 2 || !parts[1]) return { ok: false, error: '"HomeTeam vs AwayTeam" 形式で入力' };
  return await fetchSofaScoreMatch(parts[0], parts[1]);
}

// ─── /v3/fetch-label : 1件取得 ───────────────────────────
router.post('/v3/fetch-label', async (req, res) => {
  const { postId, box, label, role } = req.body;
  if (!postId || !box || !label) return res.status(400).json({ error: 'postId + box + label required' });

  let si = safeJson(siPath(postId), null);
  if (!si || si.version !== 'v3') si = emptySiData(postId);

  const now = new Date().toISOString();
  try {
    if (box === 'entity') {
      if (!role) return res.status(400).json({ error: 'role required for entity' });
      const { wiki, sofa } = await _fetchEntity(label, role);
      const items = si.boxes.entity.items;
      const i = items.findIndex(x => x.label === label);
      const next = { label, role, wiki, sofa, fetchedAt: now };
      if (i >= 0) items[i] = next; else items.push(next);
    }
    else if (box === 'match') {
      const data = await _fetchMatch(label);
      const items = si.boxes.match.items;
      const i = items.findIndex(x => x.label === label);
      const next = { label, data, fetchedAt: now };
      if (i >= 0) items[i] = next; else items.push(next);
    }
    else if (box === 'search') {
      const data = await fetchSerper(label).catch(e => ({ ok: false, error: e.message }));
      const items = si.boxes.search.items;
      const i = items.findIndex(x => x.label === label);
      const next = { label, data, fetchedAt: now };
      if (i >= 0) items[i] = next; else items.push(next);
    }
    else {
      return res.status(400).json({ error: '不明な box: ' + box });
    }

    fs.writeFileSync(siPath(postId), JSON.stringify(si, null, 2));
    res.json({ ok: true });
  } catch (e) {
    console.error(`[Step2 v3] fetch-label "${box}/${label}" エラー:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v3/fetch-all : 未取得の全ラベルを並列取得 ─────────
router.post('/v3/fetch-all', async (req, res) => {
  const { postId, items } = req.body;  // items: [{box, label, role?}, ...]
  if (!postId || !Array.isArray(items)) return res.status(400).json({ error: 'postId + items[] required' });

  let si = safeJson(siPath(postId), null);
  if (!si || si.version !== 'v3') si = emptySiData(postId);

  const now = new Date().toISOString();
  console.log(`[Step2 v3] fetch-all 開始: ${items.length}件`);

  // 並列取得（サーバー負荷も考えて 4 並列まで）
  const results = [];
  const queue = items.slice();
  async function _worker() {
    while (queue.length) {
      const it = queue.shift();
      try {
        if (it.box === 'entity') {
          const { wiki, sofa } = await _fetchEntity(it.label, it.role);
          results.push({ ...it, wiki, sofa, fetchedAt: now });
        } else if (it.box === 'match') {
          const data = await _fetchMatch(it.label);
          results.push({ ...it, data, fetchedAt: now });
        } else if (it.box === 'search') {
          const data = await fetchSerper(it.label).catch(e => ({ ok: false, error: e.message }));
          results.push({ ...it, data, fetchedAt: now });
        }
      } catch (e) {
        results.push({ ...it, error: e.message, fetchedAt: now });
      }
    }
  }
  await Promise.all([_worker(), _worker(), _worker(), _worker()]);

  // si に反映（同じラベルがあれば置換）
  for (const r of results) {
    const items = si.boxes[r.box].items;
    const i = items.findIndex(x => x.label === r.label);
    let next;
    if (r.box === 'entity') next = { label: r.label, role: r.role, wiki: r.wiki, sofa: r.sofa, fetchedAt: r.fetchedAt, error: r.error };
    else                    next = { label: r.label, data: r.data,  fetchedAt: r.fetchedAt, error: r.error };
    if (i >= 0) items[i] = next; else items.push(next);
  }
  fs.writeFileSync(siPath(postId), JSON.stringify(si, null, 2));

  console.log(`[Step2 v3] fetch-all 完了: ${results.length}件処理`);
  res.json({ ok: true, count: results.length });
});

// ─── /v3/remove-label : 1件削除 ─────────────────────────
router.post('/v3/remove-label', (req, res) => {
  const { postId, box, label } = req.body;
  if (!postId || !box || !label) return res.status(400).json({ error: 'postId + box + label required' });
  const si = safeJson(siPath(postId), null);
  if (!si || si.version !== 'v3') return res.json({ ok: true });
  si.boxes[box].items = (si.boxes[box].items || []).filter(x => x.label !== label);
  fs.writeFileSync(siPath(postId), JSON.stringify(si, null, 2));
  res.json({ ok: true });
});

// ─── UI ─────────────────────────────────────────────────
function getUI() {
  return `
<div id="step2" class="step-container" style="display:none">

  <!-- TOP PANEL -->
  <div class="panel" style="margin-bottom:12px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span id="s2Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">案件を選択してください</span>
      <button class="btn btn-primary" id="s2BtnSuggest">&#x1F916; AIラベル提案</button>
      <button class="btn btn-success" id="s2BtnFetchAll">&#x1F4E1; 未取得を全部取得</button>
      <span id="s2Msg" style="font-size:12px;color:#8a9aba"></span>
    </div>
  </div>

  <!-- 3ボックス -->
  <div id="s2Boxes" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;align-items:flex-start;margin-bottom:14px;">
    <!-- 左: entity -->
    <div class="panel">
      <div style="font-size:12px;font-weight:bold;color:#10b981;margin-bottom:8px">&#x1F464; 固有名（選手・監督・チーム・大会）</div>
      <div id="s2BoxEntity"></div>
      <div style="display:grid;grid-template-columns:1fr 80px 28px;gap:4px;margin-top:6px;">
        <input class="inp" id="s2NewEntityName" placeholder="名前" style="font-size:11px;padding:4px 6px;">
        <select class="inp" id="s2NewEntityRole" style="font-size:11px;padding:4px 6px;">
          <option value="player">選手</option>
          <option value="manager">監督</option>
          <option value="team">チーム</option>
          <option value="tournament">大会</option>
        </select>
        <button class="btn btn-sm" id="s2BtnAddEntity" style="background:#10b981;color:#fff;padding:4px 6px;">+</button>
      </div>
    </div>

    <!-- 中央: match -->
    <div class="panel">
      <div style="font-size:12px;font-weight:bold;color:#ef4444;margin-bottom:8px">&#x26BD; 試合（HomeTeam vs AwayTeam）</div>
      <div id="s2BoxMatch"></div>
      <div style="display:grid;grid-template-columns:1fr 28px;gap:4px;margin-top:6px;">
        <input class="inp" id="s2NewMatchLabel" placeholder="例: Real Madrid vs Real Betis" style="font-size:11px;padding:4px 6px;">
        <button class="btn btn-sm" id="s2BtnAddMatch" style="background:#ef4444;color:#fff;padding:4px 6px;">+</button>
      </div>
    </div>

    <!-- 右: search -->
    <div class="panel">
      <div style="font-size:12px;font-weight:bold;color:#0ea5e9;margin-bottom:8px">&#x1F50D; ニュース検索ワード</div>
      <div id="s2BoxSearch"></div>
      <div style="display:grid;grid-template-columns:1fr 28px;gap:4px;margin-top:6px;">
        <input class="inp" id="s2NewSearchLabel" placeholder="例: Bellerin late equalizer" style="font-size:11px;padding:4px 6px;">
        <button class="btn btn-sm" id="s2BtnAddSearch" style="background:#0ea5e9;color:#fff;padding:4px 6px;">+</button>
      </div>
    </div>
  </div>

  <!-- プレビュー -->
  <div class="panel" style="margin-bottom:12px;">
    <div style="font-size:11px;font-weight:bold;color:#8a9aba;margin-bottom:6px">&#x1F4CB; プレビュー</div>
    <pre id="s2Preview" style="max-height:240px;overflow-y:auto;font-size:10px;margin:0">（取得済みラベルをクリックして確認）</pre>
  </div>

  <button class="btn btn-success" id="s2BtnNext" style="width:100%;padding:13px;font-size:14px;font-weight:bold">
    &#x1F3AC; モジュール提案へ &#x2192;
  </button>
</div>

<script>
(function() {
  'use strict';

  const ROLE_SUFFIX = { player: '選手', manager: '監督', team: 'チーム', tournament: '大会' };
  const ROLE_COLOR  = { player: '#10b981', manager: '#f59e0b', team: '#8b5cf6', tournament: '#6366f1' };

  window.APP = window.APP || {};
  window.APP.s2 = { siData: null };

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _msg(s) { const e = document.getElementById('s2Msg'); if (e) e.innerHTML = s; }

  /* ── 初期化 ── */
  window.step2Init = async function() {
    const post = window.APP.selected;
    document.getElementById('s2Title').textContent = post
      ? (post.titleJa || post.title || '(タイトル不明)').slice(0, 80)
      : '案件を選択してください';
    if (!post?.id) { _renderBoxes(); return; }
    try {
      const si = await fetchJson('/api/si-data?postId=' + encodeURIComponent(post.id));
      window.APP.s2.siData = si;
    } catch (_) {
      window.APP.s2.siData = _emptySi(post.id);
    }
    _renderBoxes();
  };

  function _emptySi(postId) {
    return { postId, version: 'v3', boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } } };
  }

  /* ── ボックス描画 ── */
  function _renderBoxes() {
    const si = window.APP.s2.siData;
    if (!si) return;
    document.getElementById('s2BoxEntity').innerHTML = _renderEntityList(si.boxes.entity.items || []);
    document.getElementById('s2BoxMatch').innerHTML  = _renderMatchOrSearch('match',  si.boxes.match.items  || []);
    document.getElementById('s2BoxSearch').innerHTML = _renderMatchOrSearch('search', si.boxes.search.items || []);
  }

  function _renderEntityList(items) {
    if (!items.length) return '<div style="font-size:11px;color:#3a4a6a;padding:8px;text-align:center;">なし</div>';
    return items.map(function(it) {
      const role = it.role || 'player';
      const status = _statusBadge(it);
      return '<div class="s2-row" data-box="entity" data-label="' + _esc(it.label) + '"'
        + ' style="display:grid;grid-template-columns:1fr auto 24px 24px;gap:4px;padding:5px 6px;border-bottom:1px solid #1a2540;align-items:center;cursor:pointer;font-size:11px;"'
        + ' onclick="s2Preview(\\'entity\\',\\'' + _esc(it.label).replace(/'/g, "\\\\'") + '\\')">'
        + '<span><span style="color:' + ROLE_COLOR[role] + ';font-weight:bold;">' + _esc(it.label) + '</span>'
        + ' <span style="font-size:9px;color:#94a3b8;">[' + (ROLE_SUFFIX[role] || role) + ']</span></span>'
        + status
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2Refetch(\\'entity\\',\\'' + _esc(it.label).replace(/'/g, "\\\\'") + '\\',\\'' + role + '\\')" title="再取得" style="padding:2px 4px;background:#3b82f6;color:#fff;font-size:9px;">↻</button>'
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2Remove(\\'entity\\',\\'' + _esc(it.label).replace(/'/g, "\\\\'") + '\\')" style="padding:2px 4px;background:#ef4444;color:#fff;font-size:9px;">×</button>'
        + '</div>';
    }).join('');
  }

  function _renderMatchOrSearch(box, items) {
    if (!items.length) return '<div style="font-size:11px;color:#3a4a6a;padding:8px;text-align:center;">なし</div>';
    return items.map(function(it) {
      const status = _statusBadge(it);
      return '<div class="s2-row" data-box="' + box + '" data-label="' + _esc(it.label) + '"'
        + ' style="display:grid;grid-template-columns:1fr auto 24px 24px;gap:4px;padding:5px 6px;border-bottom:1px solid #1a2540;align-items:center;cursor:pointer;font-size:11px;"'
        + ' onclick="s2Preview(\\'' + box + '\\',\\'' + _esc(it.label).replace(/'/g, "\\\\'") + '\\')">'
        + '<span style="color:#e0e0e0;">' + _esc(it.label) + '</span>'
        + status
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2Refetch(\\'' + box + '\\',\\'' + _esc(it.label).replace(/'/g, "\\\\'") + '\\')" title="再取得" style="padding:2px 4px;background:#3b82f6;color:#fff;font-size:9px;">↻</button>'
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2Remove(\\'' + box + '\\',\\'' + _esc(it.label).replace(/'/g, "\\\\'") + '\\')" style="padding:2px 4px;background:#ef4444;color:#fff;font-size:9px;">×</button>'
        + '</div>';
    }).join('');
  }

  function _statusBadge(it) {
    if (!it.fetchedAt) return '<span style="font-size:9px;color:#5a6a8a;padding:1px 4px;border-radius:3px;background:#1a2540;">未取得</span>';
    if (it.error) return '<span style="font-size:9px;color:#fff;padding:1px 4px;border-radius:3px;background:#ef4444;">失敗</span>';
    // entity判定: wiki または sofa が ok:true なら成功
    if (it.wiki !== undefined || it.sofa !== undefined) {
      const wikiOk = it.wiki?.ok;
      const sofaOk = it.sofa?.ok;
      if (wikiOk && sofaOk) return '<span style="font-size:9px;color:#fff;padding:1px 4px;border-radius:3px;background:#10b981;">W+S</span>';
      if (wikiOk) return '<span style="font-size:9px;color:#fff;padding:1px 4px;border-radius:3px;background:#6366f1;">W</span>';
      if (sofaOk) return '<span style="font-size:9px;color:#fff;padding:1px 4px;border-radius:3px;background:#10b981;">S</span>';
      return '<span style="font-size:9px;color:#fff;padding:1px 4px;border-radius:3px;background:#ef4444;">×</span>';
    }
    // match/search
    if (it.data?.ok) return '<span style="font-size:9px;color:#fff;padding:1px 4px;border-radius:3px;background:#10b981;">OK</span>';
    return '<span style="font-size:9px;color:#fff;padding:1px 4px;border-radius:3px;background:#ef4444;">×</span>';
  }

  /* ── プレビュー ── */
  window.s2Preview = function(box, label) {
    const si = window.APP.s2.siData;
    const it = (si.boxes[box].items || []).find(x => x.label === label);
    if (!it) return;
    document.getElementById('s2Preview').textContent = JSON.stringify(it, null, 2);
  };

  /* ── 1件削除 ── */
  window.s2Remove = async function(box, label) {
    const post = window.APP.selected;
    if (!post?.id) return;
    if (!confirm('「' + label + '」を削除しますか？')) return;
    await fetchJson('/api/v3/remove-label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: post.id, box, label }),
    });
    // ローカル反映
    const items = window.APP.s2.siData.boxes[box].items;
    const i = items.findIndex(x => x.label === label);
    if (i >= 0) items.splice(i, 1);
    _renderBoxes();
  };

  /* ── 1件 (再)取得 ── */
  window.s2Refetch = async function(box, label, role) {
    const post = window.APP.selected;
    if (!post?.id) return;
    _msg('⏳ ' + label + ' 取得中...');
    try {
      await fetchJson('/api/v3/fetch-label', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, box, label, role }),
      });
      // 取得後、サーバから再読込してマージ
      const si = await fetchJson('/api/si-data?postId=' + encodeURIComponent(post.id));
      window.APP.s2.siData = si;
      _renderBoxes();
      _msg('✅ ' + label);
    } catch (e) {
      _msg('❌ ' + e.message);
    }
  };

  /* ── 全部取得 ── */
  document.addEventListener('click', async function(e) {
    if (e.target.id === 's2BtnFetchAll') {
      const post = window.APP.selected;
      if (!post?.id) return;
      const si = window.APP.s2.siData;
      const items = [];
      ['entity','match','search'].forEach(function(box) {
        (si.boxes[box].items || []).forEach(function(it) {
          if (!it.fetchedAt || it.error) {
            const obj = { box, label: it.label };
            if (box === 'entity') obj.role = it.role;
            items.push(obj);
          }
        });
      });
      if (!items.length) { _msg('未取得なし'); return; }
      _msg('⏳ ' + items.length + '件並列取得中...');
      try {
        await fetchJson('/api/v3/fetch-all', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postId: post.id, items }),
        });
        const fresh = await fetchJson('/api/si-data?postId=' + encodeURIComponent(post.id));
        window.APP.s2.siData = fresh;
        _renderBoxes();
        _msg('✅ ' + items.length + '件取得完了');
      } catch (e) {
        _msg('❌ ' + e.message);
      }
    }
  });

  /* ── AI ラベル提案 ── */
  document.getElementById('s2BtnSuggest').addEventListener('click', async function() {
    const post = window.APP.selected;
    if (!post?.id) return;
    _msg('⏳ AI ラベル提案中...');
    try {
      const j = await fetchJson('/api/v3/suggest-labels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post }),
      });
      // 既存に追加マージ（重複は除外）
      const si = window.APP.s2.siData;
      (j.entities || []).forEach(function(e) {
        if (!si.boxes.entity.items.find(x => x.label === e.name)) {
          si.boxes.entity.items.push({ label: e.name, role: e.role });
        }
      });
      (j.matches || []).forEach(function(m) {
        if (!si.boxes.match.items.find(x => x.label === m)) {
          si.boxes.match.items.push({ label: m });
        }
      });
      (j.searches || []).forEach(function(s) {
        if (!si.boxes.search.items.find(x => x.label === s)) {
          si.boxes.search.items.push({ label: s });
        }
      });
      // サーバに保存
      await fetchJson('/api/si-data', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, siData: si }),
      });
      _renderBoxes();
      _msg('✅ ' + (j.entities?.length || 0) + '+' + (j.matches?.length || 0) + '+' + (j.searches?.length || 0) + ' 件追加');
    } catch (e) {
      _msg('❌ ' + e.message);
    }
  });

  /* ── 手動追加（entity）── */
  document.getElementById('s2BtnAddEntity').addEventListener('click', function() {
    const name = document.getElementById('s2NewEntityName').value.trim();
    const role = document.getElementById('s2NewEntityRole').value;
    if (!name) return;
    const si = window.APP.s2.siData;
    if (!si.boxes.entity.items.find(x => x.label === name)) {
      si.boxes.entity.items.push({ label: name, role });
    }
    document.getElementById('s2NewEntityName').value = '';
    _persistAndRender();
  });
  document.getElementById('s2BtnAddMatch').addEventListener('click', function() {
    const lbl = document.getElementById('s2NewMatchLabel').value.trim();
    if (!lbl) return;
    const si = window.APP.s2.siData;
    if (!si.boxes.match.items.find(x => x.label === lbl)) {
      si.boxes.match.items.push({ label: lbl });
    }
    document.getElementById('s2NewMatchLabel').value = '';
    _persistAndRender();
  });
  document.getElementById('s2BtnAddSearch').addEventListener('click', function() {
    const lbl = document.getElementById('s2NewSearchLabel').value.trim();
    if (!lbl) return;
    const si = window.APP.s2.siData;
    if (!si.boxes.search.items.find(x => x.label === lbl)) {
      si.boxes.search.items.push({ label: lbl });
    }
    document.getElementById('s2NewSearchLabel').value = '';
    _persistAndRender();
  });

  async function _persistAndRender() {
    const post = window.APP.selected;
    if (!post?.id) return;
    await fetchJson('/api/si-data', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: post.id, siData: window.APP.s2.siData }),
    });
    _renderBoxes();
  }

  /* ── Step3 へ ── */
  document.getElementById('s2BtnNext').addEventListener('click', function() {
    if (typeof window.goStep === 'function') window.goStep(3);
  });

})();
</script>`;
}

module.exports = { router, getUI };
