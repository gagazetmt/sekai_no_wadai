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
const { suggestEntities }          = require('../scripts/modules/stock_match');
const { fetchImagesForLabel }      = require('./step35_routes');
const { createJob, readJob, updateJob } = require('./_job_helper');

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

// suggest-labels の実処理（ジョブ化のためバックグラウンド実行用）
async function _runSuggestLabels(post, onProgress = () => {}) {
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
  if (!phase1) return { entities: [], matches: [], searches: [] };

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

  return {
    entities: merged,
    matches,
    searches,
  };
}

// 🆕 /v3/suggest-labels: ジョブ作成 → jobId 即返却（バックグラウンド実行）
router.post('/v3/suggest-labels', (req, res) => {
  const { post } = req.body;
  if (!post) return res.status(400).json({ error: 'post required' });
  const jobId = createJob('sl', { postId: post.id, kind: 'suggest-labels', step: 'init' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      updateJob(jobId, { status: 'running', step: 'phase1' });
      const result = await _runSuggestLabels(post, (patch) => updateJob(jobId, patch));
      updateJob(jobId, { status: 'done', step: 'merged', result });
    } catch (e) {
      console.error(`[Step2/suggest-labels:${jobId}]`, e);
      updateJob(jobId, { status: 'error', error: e.message });
    }
  });
});

// 🆕 /v3/suggest-labels-status: ジョブ状態取得（フロントポーリング）
router.get('/v3/suggest-labels-status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
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

  // FotMob (player + manager のみ) — クラブごとキャリア & 大会別タイトル
  //   SofaScore の career[] が null のところを補完。Pep の Bayern/Barca 時代等が取れる
  if (role === 'player' || role === 'manager') {
    const { fetchByName } = require('../scripts/modules/fetchers/fotmob_career');
    tasks.push(fetchByName(label).catch(e => ({ ok: false, error: e.message })));
  } else {
    tasks.push(Promise.resolve(null));
  }

  // 🆕 Transfermarkt + Wikipedia 監督戦績（manager のみ・2026-05-08）
  //   FotMob/SofaScore で取れない監督のクラブ別 試合数/PPM/W/D/L 内訳を補完
  //   Transfermarkt: 公式風プロフィール / 今季大会別 W/D/L / 獲得タイトル
  //   Wikipedia:     クラブ別 P/W/D/L/Win% 内訳
  if (role === 'manager') {
    const { searchTransfermarktManager, fetchTransfermarktManager } = require('../scripts/modules/fetchers/transfermarkt_manager');
    const { fetchWikipediaManagerialStats } = require('../scripts/modules/fetchers/wiki_managerial_stats');
    tasks.push(
      (async () => {
        const hit = await searchTransfermarktManager(label).catch(() => null);
        if (!hit) return { ok: false, error: 'tm search miss' };
        return await fetchTransfermarktManager(hit.id, hit.slug).catch(e => ({ ok: false, error: e.message }));
      })()
    );
    tasks.push(fetchWikipediaManagerialStats(label).catch(e => ({ ok: false, error: e.message })));
  } else {
    tasks.push(Promise.resolve(null));
    tasks.push(Promise.resolve(null));
  }

  const [wiki, sofa, fmRes, tm, wikiMgrStats] = await Promise.all(tasks);
  const fotmob = fmRes && fmRes.data ? { ok: true, ...fmRes.data, _matched: fmRes.found } : (fmRes || null);
  return { wiki, sofa, fotmob, tm, wikiMgrStats };
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
      const { wiki, sofa, fotmob, tm, wikiMgrStats } = await _fetchEntity(label, role);
      const items = si.boxes.entity.items;
      const i = items.findIndex(x => x.label === label);
      const next = { label, role, wiki, sofa, fotmob, tm, wikiMgrStats, fetchedAt: now };
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

    // 🆕 画像取得を fire-and-forget でバックグラウンド発火（response は待たない）
    if (box === 'entity' || box === 'match') {
      const imgLabel = box === 'entity' ? `entity:${label}` : `match:${label}`;
      setImmediate(() => {
        fetchImagesForLabel(postId, imgLabel).catch(e =>
          console.warn(`[fetch-label/img:${imgLabel}]`, e.message)
        );
      });
    }

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
          const { wiki, sofa, fotmob, tm, wikiMgrStats } = await _fetchEntity(it.label, it.role);
          results.push({ ...it, wiki, sofa, fotmob, tm, wikiMgrStats, fetchedAt: now });
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
    if (r.box === 'entity') next = { label: r.label, role: r.role, wiki: r.wiki, sofa: r.sofa, fotmob: r.fotmob, tm: r.tm, wikiMgrStats: r.wikiMgrStats, fetchedAt: r.fetchedAt, error: r.error };
    else                    next = { label: r.label, data: r.data,  fetchedAt: r.fetchedAt, error: r.error };
    if (i >= 0) items[i] = next; else items.push(next);
  }
  fs.writeFileSync(siPath(postId), JSON.stringify(si, null, 2));

  console.log(`[Step2 v3] fetch-all 完了: ${results.length}件処理`);

  // 🆕 lineup の選手名 → Wikipedia 経由で日本語カタカナを fire-and-forget で先読み
  //   matchcard render 時には cache hit するように事前準備
  setImmediate(async () => {
    try {
      const { prefetchPlayerNames } = require('../scripts/utilities/fetch_player_jp');
      const names = [];
      for (const r of results) {
        if (r.box !== 'match' || !r.data) continue;
        const lu = r.data.lineup || {};
        ['home', 'away'].forEach(side => {
          (lu[side] || []).forEach(p => {
            if (p?.name) names.push(p.name);
          });
        });
      }
      if (names.length) {
        const stats = await prefetchPlayerNames(names);
        console.log(`[Step2 v3] 選手名カタカナ先読み: hit=${stats.hit} fetched=${stats.fetched} missed=${stats.missed} / total ${stats.total}`);
      }
    } catch (e) {
      console.warn('[Step2 v3] prefetchPlayerNames 失敗:', e.message);
    }
  });

  // 🆕 ラベル毎に画像取得を fire-and-forget で並行発火（response は待たない）
  let imgKicked = 0;
  for (const r of results) {
    if (r.error) continue;
    if (r.box !== 'entity' && r.box !== 'match') continue;
    const imgLabel = r.box === 'entity' ? `entity:${r.label}` : `match:${r.label}`;
    imgKicked++;
    setImmediate(() => {
      fetchImagesForLabel(postId, imgLabel).catch(e =>
        console.warn(`[fetch-all/img:${imgLabel}]`, e.message)
      );
    });
  }
  console.log(`[Step2 v3] 画像取得を ${imgKicked} ラベル分バックグラウンド発火`);

  res.json({ ok: true, count: results.length, imageJobsKicked: imgKicked });
});

// ─── /v3/entity-suggest : 入力中ラベルのタイプアヘッド候補
//   query string: q=<入力> & role=<player|manager|team|all>
//   使い回し: stock_match.suggestEntities() で local indices からマッチ
router.get('/v3/entity-suggest', (req, res) => {
  try {
    const q    = String(req.query.q    || '').trim();
    const role = String(req.query.role || 'all');
    if (!q) return res.json({ ok: true, suggestions: [] });
    const suggestions = suggestEntities(q, { role, limit: 12, threshold: 30 });
    res.json({ ok: true, query: q, role, suggestions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      <div style="position:relative;display:grid;grid-template-columns:1fr 80px 28px;gap:4px;margin-top:6px;">
        <input class="inp" id="s2NewEntityName" placeholder="名前（入力すると候補表示）" style="font-size:11px;padding:4px 6px;" autocomplete="off">
        <select class="inp" id="s2NewEntityRole" style="font-size:11px;padding:4px 6px;">
          <option value="player">選手</option>
          <option value="manager">監督</option>
          <option value="team">チーム</option>
          <option value="tournament">大会</option>
        </select>
        <button class="btn btn-sm" id="s2BtnAddEntity" style="background:#10b981;color:#fff;padding:4px 6px;">+</button>
        <div id="s2EntitySuggest" style="display:none;position:absolute;top:30px;left:0;right:108px;z-index:50;background:#1a1a26;border:1px solid #3d3d4d;border-radius:6px;max-height:240px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.4);"></div>
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
    // 🆕 進行中の AI 提案ジョブがあれば再開
    const pendingJob = _readSuggestJob(post.id);
    if (pendingJob) {
      const btn = document.getElementById('s2BtnSuggest');
      _msg('🔄 進行中の AI 提案ジョブを再開: ' + pendingJob);
      _pollSuggestJob(pendingJob, post, btn);
    }
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
      const escLabel = _esc(it.label).replace(/'/g, "\\\\'");
      return '<div class="s2-row-wrap" data-box="entity" data-label="' + _esc(it.label) + '" style="border-bottom:1px solid #1a2540;">'
        + '<div class="s2-row" style="display:grid;grid-template-columns:1fr auto 24px 24px 24px;gap:4px;padding:5px 6px;align-items:center;cursor:pointer;font-size:11px;"'
        + ' onclick="s2Preview(\\'entity\\',\\'' + escLabel + '\\')">'
        + '<span><span style="color:' + ROLE_COLOR[role] + ';font-weight:bold;">' + _esc(it.label) + '</span>'
        + ' <span style="font-size:9px;color:#94a3b8;">[' + (ROLE_SUFFIX[role] || role) + ']</span></span>'
        + status
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2ToggleImages(this,\\'entity\\',\\'' + escLabel + '\\')" title="画像候補" style="padding:2px 4px;background:#a855f7;color:#fff;font-size:10px;">🖼</button>'
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2Refetch(\\'entity\\',\\'' + escLabel + '\\',\\'' + role + '\\')" title="再取得" style="padding:2px 4px;background:#3b82f6;color:#fff;font-size:9px;">↻</button>'
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2Remove(\\'entity\\',\\'' + escLabel + '\\')" style="padding:2px 4px;background:#ef4444;color:#fff;font-size:9px;">×</button>'
        + '</div>'
        + '<div class="s2-images" style="display:none;padding:6px;background:#0f1117;border-top:1px solid #1a2540;"></div>'
        + '</div>';
    }).join('');
  }

  function _renderMatchOrSearch(box, items) {
    if (!items.length) return '<div style="font-size:11px;color:#3a4a6a;padding:8px;text-align:center;">なし</div>';
    return items.map(function(it) {
      const status = _statusBadge(it);
      const escLabel = _esc(it.label).replace(/'/g, "\\\\'");
      const showImgBtn = (box === 'match'); // search は画像なし
      return '<div class="s2-row-wrap" data-box="' + box + '" data-label="' + _esc(it.label) + '" style="border-bottom:1px solid #1a2540;">'
        + '<div class="s2-row" style="display:grid;grid-template-columns:1fr auto ' + (showImgBtn ? '24px ' : '') + '24px 24px;gap:4px;padding:5px 6px;align-items:center;cursor:pointer;font-size:11px;"'
        + ' onclick="s2Preview(\\'' + box + '\\',\\'' + escLabel + '\\')">'
        + '<span style="color:#e0e0e0;">' + _esc(it.label) + '</span>'
        + status
        + (showImgBtn
            ? '<button class="btn btn-sm" onclick="event.stopPropagation();s2ToggleImages(this,\\'match\\',\\'' + escLabel + '\\')" title="画像候補" style="padding:2px 4px;background:#a855f7;color:#fff;font-size:10px;">🖼</button>'
            : '')
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2Refetch(\\'' + box + '\\',\\'' + escLabel + '\\')" title="再取得" style="padding:2px 4px;background:#3b82f6;color:#fff;font-size:9px;">↻</button>'
        + '<button class="btn btn-sm" onclick="event.stopPropagation();s2Remove(\\'' + box + '\\',\\'' + escLabel + '\\')" style="padding:2px 4px;background:#ef4444;color:#fff;font-size:9px;">×</button>'
        + '</div>'
        + (showImgBtn ? '<div class="s2-images" style="display:none;padding:6px;background:#0f1117;border-top:1px solid #1a2540;"></div>' : '')
        + '</div>';
    }).join('');
  }

  /* ── 🖼 画像候補展開（lazy load + 選択状態保存） ── */
  // s2.imageCache: { "<label>": { images, selection } }
  window.APP.s2.imageCache = window.APP.s2.imageCache || {};

  window.s2ToggleImages = async function(btn, box, rawLabel) {
    const wrap = btn.closest('.s2-row-wrap');
    if (!wrap) return;
    const imgsDiv = wrap.querySelector('.s2-images');
    if (!imgsDiv) return;
    if (imgsDiv.style.display !== 'none') {
      imgsDiv.style.display = 'none';
      return;
    }
    imgsDiv.style.display = 'block';
    const post = window.APP.selected;
    if (!post?.id) { imgsDiv.innerHTML = '<div style="color:#94a3b8;font-size:10px;">案件未選択</div>'; return; }
    const fullLabel = box + ':' + rawLabel;
    imgsDiv.innerHTML = '<div style="color:#94a3b8;font-size:10px;">⏳ 画像読込...</div>';
    try {
      const cache = window.APP.s2.imageCache[fullLabel];
      let payload;
      if (cache) payload = cache;
      else {
        // 既に Step2 の fetch-all/fetch-label で発火済の可能性高いが、未取得なら今呼ぶ
        const [imgRes, selRes] = await Promise.all([
          fetchJson('/api/v35/fetch-images', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId: post.id, label: fullLabel }),
          }),
          fetchJson('/api/v35/get-selection?postId=' + encodeURIComponent(post.id))
            .catch(() => ({ selections: {} })),
        ]);
        const selection = (selRes.selections || {})[fullLabel] || [];
        payload = { images: imgRes.images || {}, selection };
        window.APP.s2.imageCache[fullLabel] = payload;
      }
      _renderImageGrid(imgsDiv, fullLabel, payload);
    } catch (e) {
      imgsDiv.innerHTML = '<div style="color:#ef4444;font-size:10px;">❌ ' + _esc(e.message) + '</div>';
    }
  };

  function _renderImageGrid(container, fullLabel, payload) {
    const images = payload.images || {};
    const selSet = new Set(payload.selection || []);
    const groups = [
      { key: 'stock',          title: '🎁 ストック (公式素材)', color: '#10b981' },
      { key: 'x_by_name',      title: '📷 X 名前',           color: '#3b82f6' },
      { key: 'x_by_time',      title: '📷 X 時間 (Home)',     color: '#3b82f6' },
      { key: 'x_by_time_away', title: '📷 X 時間 (Away)',     color: '#3b82f6' },
      { key: 'wikimedia',      title: '🌐 Wikimedia',          color: '#8b5cf6' },
    ];
    let html = '';
    let totalCount = 0;
    for (const g of groups) {
      const arr = (images[g.key] || []).filter(Boolean);
      if (!arr.length) continue;
      totalCount += arr.length;
      html += '<div style="margin-bottom:6px;">'
        + '<div style="font-size:10px;font-weight:bold;color:' + g.color + ';margin-bottom:3px;">' + g.title + ' (' + arr.length + ')</div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:4px;">'
        + arr.map(function(url) {
          const isSelected = selSet.has(url);
          return '<div class="s2-img-cell' + (isSelected ? ' selected' : '') + '" data-url="' + _esc(url) + '" '
            + 'style="aspect-ratio:1;background:#1a1a26;border:2px solid ' + (isSelected ? '#10b981' : '#3d3d4d') + ';border-radius:4px;overflow:hidden;cursor:pointer;display:flex;align-items:center;justify-content:center;">'
            + '<img src="' + _esc(url) + '" loading="lazy" style="max-width:100%;max-height:100%;object-fit:contain;">'
            + '</div>';
        }).join('')
        + '</div></div>';
    }
    if (!totalCount) {
      html = '<div style="color:#94a3b8;font-size:10px;">画像候補なし（取得失敗 or 該当なし）</div>';
    } else {
      html = '<div style="font-size:10px;color:#94a3b8;margin-bottom:4px;">クリックで選択/解除（自動保存）/ 選択中: <span class="s2-sel-count" style="color:#10b981">' + selSet.size + '</span> 枚</div>' + html;
    }
    container.innerHTML = html;
    // クリックハンドラ
    container.querySelectorAll('.s2-img-cell').forEach(function(cell) {
      cell.addEventListener('click', function() {
        const url = cell.getAttribute('data-url');
        const cache = window.APP.s2.imageCache[fullLabel] || { selection: [] };
        const set = new Set(cache.selection || []);
        if (set.has(url)) set.delete(url); else set.add(url);
        cache.selection = Array.from(set);
        window.APP.s2.imageCache[fullLabel] = cache;
        // 視覚更新
        cell.classList.toggle('selected');
        cell.style.borderColor = set.has(url) ? '#10b981' : '#3d3d4d';
        const cnt = container.querySelector('.s2-sel-count');
        if (cnt) cnt.textContent = set.size;
        // サーバ保存（fire-and-forget）
        _saveImageSelection(fullLabel, cache.selection);
      });
    });
  }

  let _saveSelTimer = null;
  let _saveSelPending = {};
  async function _saveImageSelection(label, urls) {
    const post = window.APP.selected;
    if (!post?.id) return;
    _saveSelPending[label] = urls;
    if (_saveSelTimer) clearTimeout(_saveSelTimer);
    _saveSelTimer = setTimeout(async () => {
      const toSave = _saveSelPending;
      _saveSelPending = {};
      try {
        // 既存選択を読んでマージ（他ラベルを上書きしないため）
        const cur = await fetchJson('/api/v35/get-selection?postId=' + encodeURIComponent(post.id))
          .catch(() => ({ selections: {} }));
        const merged = Object.assign({}, cur.selections || {}, toSave);
        await fetchJson('/api/v35/save-selection', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postId: post.id, selections: merged }),
        });
      } catch (e) {
        console.warn('[s2/save-selection]', e.message);
      }
    }, 500);
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

  /* ── AI ラベル提案（ジョブ化対応・タブ閉じても継続）── */
  function _suggestJobKey(postId) { return 's2_suggest_' + postId; }
  function _saveSuggestJob(postId, jobId) { try { localStorage.setItem(_suggestJobKey(postId), jobId); } catch (_) {} }
  function _clearSuggestJob(postId)    { try { localStorage.removeItem(_suggestJobKey(postId)); } catch (_) {} }
  function _readSuggestJob(postId)     { try { return localStorage.getItem(_suggestJobKey(postId)); } catch (_) { return null; } }

  async function _applySuggestResult(post, result) {
    // 🐛 race condition fix（2026-05-06）:
    //   旧実装は window.APP.s2.siData（= 現在画面表示中の案件 siData）を使ってた。
    //   ユーザーが Job 中に別案件に切り替えると、別案件の siData に suggest 結果を
    //   merge して post.id（= 元案件）のファイルに書き込んでしまい、案件間でラベル
    //   ＋データが混ざる事故が発生していた。
    //   → 必ずサーバーから post.id 用の si-data を fresh fetch してマージする。
    let si;
    try {
      si = await fetchJson('/api/si-data?postId=' + encodeURIComponent(post.id));
    } catch (_) {
      si = _emptySi(post.id);
    }
    if (!si.boxes) si.boxes = { entity: { items: [] }, match: { items: [] }, search: { items: [] } };

    (result.entities || []).forEach(function(e) {
      if (!si.boxes.entity.items.find(x => x.label === e.name)) {
        si.boxes.entity.items.push({ label: e.name, role: e.role });
      }
    });
    (result.matches || []).forEach(function(m) {
      if (!si.boxes.match.items.find(x => x.label === m)) {
        si.boxes.match.items.push({ label: m });
      }
    });
    (result.searches || []).forEach(function(s) {
      if (!si.boxes.search.items.find(x => x.label === s)) {
        si.boxes.search.items.push({ label: s });
      }
    });
    await fetchJson('/api/si-data', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: post.id, siData: si }),
    });
    // ユーザーが今もこの案件を見てる時だけ画面更新。別案件に切替済なら触らない
    if (window.APP.selected?.id === post.id) {
      window.APP.s2.siData = si;
      _renderBoxes();
    }
    const total = (result.entities?.length || 0) + (result.matches?.length || 0) + (result.searches?.length || 0);
    _msg('✅ ' + total + ' 件追加 (entities ' + (result.entities?.length||0) + ' / matches ' + (result.matches?.length||0) + ' / searches ' + (result.searches?.length||0) + ')');
  }

  async function _pollSuggestJob(jobId, post, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ AI 提案中...（タブ閉じても継続）'; }
    const interval = 3000;
    let tries = 0;
    while (tries < 200) {
      tries++;
      await new Promise(r => setTimeout(r, interval));
      try {
        const j = await fetchJson('/api/v3/suggest-labels-status?jobId=' + encodeURIComponent(jobId));
        if (!j || j.status === 'error') {
          _clearSuggestJob(post.id);
          _msg('❌ ' + (j?.error || 'ジョブ失敗'));
          break;
        }
        if (j.status === 'done') {
          _clearSuggestJob(post.id);
          await _applySuggestResult(post, j.result || {});
          break;
        }
        // running の場合は継続
        _msg('⏳ AI ラベル提案中...(' + (tries * interval / 1000) + 's)');
      } catch (e) {
        if (String(e.message).includes('404')) {
          _clearSuggestJob(post.id);
          _msg('❌ ジョブ消失');
          break;
        }
        // 一時的なネットワークエラーは継続
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = '🤖 AIラベル提案'; }
  }

  document.getElementById('s2BtnSuggest').addEventListener('click', async function() {
    const post = window.APP.selected;
    if (!post?.id) return;
    const btn = this;
    _msg('⏳ AI ラベル提案ジョブ起動中...');
    try {
      const j = await fetchJson('/api/v3/suggest-labels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post }),
      });
      const jobId = j && j.jobId;
      if (!jobId) throw new Error('jobId 受信失敗');
      _saveSuggestJob(post.id, jobId);
      await _pollSuggestJob(jobId, post, btn);
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
    document.getElementById('s2EntitySuggest').style.display = 'none';
    _persistAndRender();
  });

  /* ── タイプアヘッド: stock indices から候補表示 ── */
  (function setupEntityTypeahead() {
    const input = document.getElementById('s2NewEntityName');
    const roleSel = document.getElementById('s2NewEntityRole');
    const dd = document.getElementById('s2EntitySuggest');
    if (!input || !dd) return;

    let timer = null;
    let lastQuery = '';

    function close() { dd.style.display = 'none'; dd.innerHTML = ''; }
    function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function _roleColor(r) {
      return r === 'player'  ? '#10b981'
           : r === 'manager' ? '#a855f7'
           : r === 'team'    ? '#f59e0b'
                             : '#94a3b8';
    }
    function _roleJa(r) {
      return r === 'player' ? '選手' : r === 'manager' ? '監督' : r === 'team' ? 'チーム' : r;
    }

    async function fetchSuggestions(q) {
      const role = roleSel.value || 'all';
      // role が tournament の場合は all で検索（DB に大会名は無いので空 OK）
      const searchRole = (role === 'player' || role === 'manager' || role === 'team') ? role : 'all';
      try {
        const url = '/api/v3/entity-suggest?q=' + encodeURIComponent(q) + '&role=' + searchRole;
        const r = await fetchJson(url);
        return (r && r.suggestions) || [];
      } catch (_) { return []; }
    }

    function render(suggestions) {
      if (!suggestions.length) { close(); return; }
      const html = suggestions.map((s, i) => {
        const meta = [s.league, s.club].filter(Boolean).join(' · ');
        return ''
          + '<div class="s2-suggest-item" data-i="' + i + '" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid #2a2a35;display:flex;align-items:center;gap:8px;">'
          + '  <span style="display:inline-block;min-width:32px;font-size:9px;font-weight:bold;padding:1px 4px;border-radius:3px;background:' + _roleColor(s.role) + ';color:#fff;text-align:center">' + _esc(_roleJa(s.role)) + '</span>'
          + '  <span style="font-size:12px;font-weight:bold;color:#e0e0e0">' + _esc(s.label) + '</span>'
          + '  <span style="flex:1"></span>'
          + '  <span style="font-size:10px;color:#7a8a9a">' + _esc(meta) + '</span>'
          + '</div>';
      }).join('');
      dd.innerHTML = html;
      dd.style.display = 'block';
      // クリックハンドラ（イベント委任）
      dd.querySelectorAll('.s2-suggest-item').forEach((el) => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const i = Number(el.getAttribute('data-i'));
          const s = suggestions[i];
          input.value = s.label;
          if (s.role === 'player' || s.role === 'manager' || s.role === 'team') {
            roleSel.value = s.role;
          }
          close();
          input.focus();
        });
      });
    }

    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q === lastQuery) return;
      lastQuery = q;
      if (timer) clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        const sugs = await fetchSuggestions(q);
        render(sugs);
      }, 200);
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2 && dd.innerHTML) dd.style.display = 'block';
    });
    roleSel.addEventListener('change', () => {
      // role 変更時に再検索
      lastQuery = '';
      input.dispatchEvent(new Event('input'));
    });
  })();
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
