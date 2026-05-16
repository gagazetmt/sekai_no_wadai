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
const JOB_DIR  = path.join(DATA_DIR, 'v3_jobs');

const { listMainTags, resolveType, parseMainKey, VALID_TYPES } = require('../scripts/v3_tags');
const { callAI } = require('../scripts/ai_client');
const { fetchWikipediaWikitext } = require('../scripts/modules/fetchers/wikipedia');
const { getBindingMeta, buildDataSlotsFromMeta } = require('../scripts/v2_story/binding_meta');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(JOB_DIR))  fs.mkdirSync(JOB_DIR,  { recursive: true });

// ─── ジョブ管理 ─────────────────────────────────────────
//   Step3 一括生成は60-120秒かかる長時間処理のため、
//   ブラウザ←→サーバの長時間TCP接続を避けるべく非同期ジョブ化
function jobPath(jobId) { return path.join(JOB_DIR, jobId + '.json'); }
function writeJob(jobId, data) {
  try { fs.writeFileSync(jobPath(jobId), JSON.stringify(data, null, 2)); }
  catch (_) {}
}
function readJob(jobId) {
  try { return JSON.parse(fs.readFileSync(jobPath(jobId), 'utf8')); }
  catch (_) { return null; }
}

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return fallback; }
}
function siPath(postId)      { return path.join(SI_DIR,   (postId||'unknown').replace(/[/\?%*:|"<>.]/g,'_') + '.json'); }
function modulesPath(postId) { return path.join(DATA_DIR, (postId||'unknown').replace(/[/\?%*:|"<>.]/g,'_') + '_modules.json'); }

// ─── /api/v3/si : si.boxes そのものを返す（Step3.5/Step4 用）──
router.get('/v3/si', (req, res) => {
  const postId = req.query.postId;
  const empty  = { boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } } };
  if (!postId) return res.json(empty);
  res.json(safeJson(siPath(postId), empty));
});

// ─── /api/v3/main-tags : メインタグ一覧（プルダウン用）─────
router.get('/v3/main-tags', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.json({ tags: [] });
  const si = safeJson(siPath(postId), {});
  res.json({ tags: listMainTags(si) });
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

// ─── /api/v3/propose-modules : 案件 + コメント + ニュース から 5〜10 スライド構成を多角視点で提案 ──
// 入力: { postId, count?: 5-10 (default 7) }
// 出力: { ok, modules: [{type, mainKey, secondary?, scriptDir}, ...] }
//   - Sonnet 既定で生成、JSON崩れ時のみ V4-Flash 保険（5/1切替後）
//   - クライアントは返却 outline を Step3 のテーブルに流し込んで微調整 → save-modules
async function _runProposeModules(postId, count, opts = {}) {
  const _sprint = !!opts.sprint;
  const _initialProv = _sprint ? 'deepseek' : 'anthropic';
  const si = safeJson(siPath(postId), { boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } } });

    // カスタム案件判定（Reddit コメントが無い独自テーマ動画）
    const isCustom = String(postId || '').startsWith('custom_');

    // 案件の文脈（saved_projects.json から）
    let titleJa = '(タイトル不明)';
    let titleOrig = '';
    let topComments = '';
    let bodyExcerpt = '';
    let customNote = '';
    try {
      const sp = safeJson(path.join(DATA_DIR, 'saved_projects.json'), []);
      const proj = (Array.isArray(sp) ? sp : []).find(p => p.id === postId);
      if (proj) {
        titleJa = proj.title || titleJa;
        titleOrig = proj.titleOrig || '';
        bodyExcerpt = (proj.raw?.bodyJa || proj.raw?.body || '').slice(0, 600);
        topComments = (proj.raw?.comments || [])
          .slice(0, 5)
          .map(c => '- ' + (c.bodyJa || c.body || '').slice(0, 200))
          .filter(s => s.length > 4)
          .join('\n');
        customNote = String(proj.raw?.customNote || '').slice(0, 500);
      }
    } catch (_) {}

    // si.boxes 整形（generate-scenario と同じ要約方式）
    function _entityBlock(it) {
      const role    = it.role || '?';
      const wikiSum = it.wiki?.ok
        ? `wiki:{title:"${it.wiki.title || ''}",extract:"${(it.wiki.extract || '').slice(0, 200)}"}` : 'wiki:×';
      const sofaSum = it.sofa?.ok
        ? `sofa:${JSON.stringify({
            name: it.sofa.name || it.sofa.teamName,
            position: it.sofa.position, team: it.sofa.team,
            league: it.sofa.leagueName, country: it.sofa.country,
            standing: it.sofa.standing, manager: it.sofa.managerName,
          }).slice(0, 400)}` : 'sofa:×';
      return `- [${role}] "${it.label}"  ${wikiSum}  ${sofaSum}`;
    }
    function _matchBlock(it) {
      if (!it.data?.ok) return `- "${it.label}" : 取得失敗`;
      return `- "${it.label}" : ${JSON.stringify({
        scoreline: it.data.scoreline, date: it.data.matchDate,
        tournament: it.data.tournament, venue: it.data.venue,
        goalsCount: (it.data.goals || []).length,
      }).slice(0, 400)}`;
    }
    function _searchBlock(it) {
      if (!it.data?.organic) return `- "${it.label}" : 結果なし`;
      const top = it.data.organic.slice(0, 3).map(r => `${r.title}: ${(r.snippet||'').slice(0,100)}`).join(' / ');
      return `- "${it.label}" : ${top.slice(0, 400)}`;
    }

    const entityBlock = (si.boxes?.entity?.items || []).map(_entityBlock).join('\n') || '(なし)';
    const matchBlock  = (si.boxes?.match?.items  || []).map(_matchBlock).join('\n')  || '(なし)';
    const searchBlock = (si.boxes?.search?.items || []).map(_searchBlock).join('\n') || '(なし)';

    const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

    const customBanner = isCustom ? `
━━━ ⚠️ カスタム案件モード ━━━
この案件は Reddit コメントが無い**独自テーマ動画**。以下を厳守：
- **reaction 型スライドは絶対に提案しない**（ファンコメント源なし）
- 「ファンコメントの温度感」視点は使用禁止
- 取得済みデータと案件タイトルから多角的な視点で構成すること
${customNote ? `\n【相棒の補足メモ（最重要参考情報）】\n${customNote}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━
` : '';

    const prompt = `あなたはサッカー解説YouTube動画のクリエイティブ・ディレクターです。
以下の案件素材を見て、**多角的な視点**で ${count} 枚のスライド構成（outline）を提案してください。

【今日の日付】${todayJst}（JST）
【案件タイトル】${titleJa}
${titleOrig ? `【原題】${titleOrig}` : ''}
${customBanner}
【案件本文（事実情報の主源）】
${bodyExcerpt || '(なし)'}

${topComments ? `【上位コメント（視聴者の感想・予測・皮肉。事実ではない）】\n${topComments}\n` : ''}

━━━ 【ファクト管理ルール（構成段階・厳守）】━━━
- scriptDir / title に**確定的な事実**を書く時は **【案件本文】と【取得済みデータ】の範囲内** で
- 【案件本文】が**未来形・予定形・推測形**で書いてる事象を、scriptDir で**完了形・確定形に書き換え禁止**
  ❌例: 本文「復帰予定」 → scriptDir「復帰戦のサラーが…」
  ✅例: 本文「復帰予定」 → scriptDir「復帰決定の報を受けて…」
- 上位コメントは「視聴者の興味」を示すヒント。reaction 型スライドで「ファンの声」として紹介する用途のみ。地の文の事実として scriptDir に書かない
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ 取得済みデータ ━━━
[entity 一覧]
${entityBlock}

[match 一覧]
${matchBlock}

[search 一覧（関連ニュース）]
${searchBlock}
━━━━━━━━━━━━━━━━

【視点の引き出し（多角的に組み合わせる）】
動画の視聴維持率を上げるため、以下のような複数の視点を**バランスよく**織り交ぜる：
1. 試合・ニュースそのものの解説 (insight / matchcard)
2. 主役選手・チームの現状スタッツ (stats / profile)
3. 2選手・2チーム・2監督の比較 (comparison)
4. 戦術・監督観点・哲学 (insight / profile)
5. 過去対戦・歴史的背景 (history / comparison)
6. ファンコメントの温度感 (reaction)
7. 次戦・将来への展望 (ending)

【スライド type 一覧】
- opening: 動画冒頭のフック（必ず先頭に1枚）
- insight: 切り口・観点・哲学を語る（catchphrases 主体）
- stats: 数値データ並べる（dataSlots [{label,value}]）
- profile: 基本情報カード（dataSlots [{label,value}]）
- comparison: 2項対比（dataSlots [{label,leftValue,rightValue}]）
- history: 時系列・年表（dataSlots [{label:年, value:出来事}]）★必ず label の YYYY を昇順（古い→新しい）に並べる
- ranking: 順位ランキング（items [{rank,name,value,subtext?}] 1〜5件）★得点王/順位表/アシスト王/MVP候補など"複数主体を順序付けて比較したい時に最適"
- timeline: 折れ線時系列チャート（series [{name,points:[{x,y}]}] 最大4本）★市場価値/順位/得点数などの推移を視覚化したい時に最適。1選手の年次推移でも複数選手の比較でも OK
- reaction: コメント反応（comments[]）
- matchcard: 試合プレビュー / 試合スコア詳細（match data 必須）
- ending: 締め・問いかけ（必ず末尾に1枚）

【構成ルール（厳守）】
- 必ず opening で始まり ending で終わる
- 中身は ${count - 2} 〜 ${count - 2} 枚（合計 ${count} 枚）
- 同じ type を**3連続させない**（変化で飽きさせない）
- 主役 entity は最大3人/チームまで（散漫さ回避）
- データ取得済み（wiki または sofa が ok）の entity / match のみ subject に使う
- ニュース search で言及されているトピックがあれば必ず触れる
- mainKey は以下の形式：
  - "opening" / "ending" （opening と ending のみ）
  - "entity:{ラベル}" （entity 主体スライド）
  - "match:{ラベル}" （試合主体スライド）
  - "matchcard:{ラベル}" （試合プレビュー）
- comparison の場合は "secondary" にも label を入れる
- **history の場合**: 主題が「2チーム/2選手の対戦・対比の歴史」なら **secondary にも label を入れる**
  ・例: クラシコ特集の history → mainKey="entity:Real Madrid" + secondary="FC Barcelona"
  ・secondary を入れると H2H（直接対決）データが AI に渡され、関係ない他チームの試合を拾わなくなる
  ・単独 entity の人生史なら secondary 不要（例: 監督1人のキャリア史）
- scriptDir は 30〜60文字で「何を・どう語るか」を明示

【出力】JSON のみ（マークダウン不要）:
{
  "modules": [
    {"type":"opening","mainKey":"opening","scriptDir":"..."},
    {"type":"matchcard","mainKey":"matchcard:{ラベル}","scriptDir":"..."},
    {"type":"comparison","mainKey":"entity:{ラベル}","secondary":"{別ラベル}","scriptDir":"..."},
    ...
    {"type":"ending","mainKey":"ending","scriptDir":"..."}
  ]
}`;

    const t0 = Date.now();
    // Sonnet 既定（構成・データ選定・脚本指示の質を優先） → JSON崩れ時 v4flash 保険
    // 2026-05-17: max_tokens 3000 → 6000 (7-10 module の構成JSONが3000で切れる事故対策)
    async function _askPropose(provider) {
      const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
      return callAI({ forceProvider: provider, model, max_tokens: 6000, messages: [{ role: 'user', content: prompt }] });
    }
    let raw = '';
    try { raw = await _askPropose(_initialProv); }
    catch (e) { console.warn(`[propose-modules] ${_initialProv} 例外:`, e.message); }
    if ((!raw || !raw.match(/\{[\s\S]*\}/)) && _initialProv !== 'deepseek') {
      console.warn('[propose-modules] sonnet 失敗、v4flash にフォールバック');
      raw = await _askPropose('deepseek');
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    let parsed = null;
    try {
      const m = raw && raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (_) {}

    if (!parsed?.modules || !Array.isArray(parsed.modules) || !parsed.modules.length) {
      // 2026-05-17: _runProposeModules は res を持たない async 関数なので throw に変更
      //   旧コードの res.status(500) が ReferenceError: res is not defined を起こしていた
      throw new Error('AI応答のパースに失敗: ' + (raw || '').slice(0, 200));
    }

    // バリデーション + 正規化
    //   custom 案件は reaction を除外（Reddit コメント源なし）
    const validTypes = new Set(isCustom
      ? ['opening','ending','insight','stats','profile','comparison','history','matchcard']
      : ['opening','ending','insight','stats','profile','comparison','history','reaction','matchcard']);
    const cleaned = parsed.modules
      .filter(m => m && validTypes.has(m.type))
      .map(m => ({
        type:      m.type,
        mainKey:   String(m.mainKey || '').slice(0, 200),
        secondary: m.secondary ? String(m.secondary).slice(0, 80) : null,
        scriptDir: String(m.scriptDir || '').slice(0, 200),
      }));

    // opening / ending の前後保証
    if (!cleaned.length || cleaned[0].type !== 'opening') {
      cleaned.unshift({ type: 'opening', mainKey: 'opening', scriptDir: 'タイトルでフック' });
    }
    if (cleaned[cleaned.length - 1].type !== 'ending') {
      cleaned.push({ type: 'ending', mainKey: 'ending', scriptDir: '視聴者への投げかけと登録誘導' });
    }

    console.log(`[Step3 v3] propose-modules: ${cleaned.length}枚構成を ${elapsed}秒で提案`);

    return {
      ok: true,
      elapsed,
      modules: cleaned,
    };
}

// 🆕 /v3/propose-modules: ジョブ作成 → jobId 即返却
router.post('/v3/propose-modules', express.json(), (req, res) => {
  const { postId, sprint } = req.body || {};
  let count = parseInt(req.body?.count, 10);
  if (!Number.isFinite(count) || count < 5) count = 7;
  if (count > 10) count = 10;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const jobId = 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  writeJob(jobId, { jobId, postId, kind: 'propose-modules', status: 'queued', step: 'init', createdAt: new Date().toISOString() });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      writeJob(jobId, { jobId, postId, status: 'running', step: 'ai-generation', updatedAt: new Date().toISOString() });
      const result = await _runProposeModules(postId, count, { sprint: !!sprint });
      writeJob(jobId, { jobId, postId, status: 'done', step: 'merged', result, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.error(`[Step3/propose-modules:${jobId}]`, e);
      writeJob(jobId, { jobId, postId, status: 'error', error: e.message, updatedAt: new Date().toISOString() });
    }
  });
});

// 🆕 /v3/propose-modules-status: ジョブ状態取得（フロントポーリング）
router.get('/v3/propose-modules-status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});

// ─── /api/v3/generate-scenario : 全カード一括生成（非同期ジョブ起動）──
// 入力: { postId, modules: [{mainKey, type, secondary?, scriptDir}], post }
// 出力: { ok, jobId } 即返却。実処理はバックグラウンドで走行
//   → クライアントは /v3/scenario-status?jobId= を3秒間隔ポーリング
router.post('/v3/generate-scenario', (req, res) => {
  const { postId, modules: mods, post: postIn } = req.body;
  if (!postId || !Array.isArray(mods) || !mods.length) {
    return res.status(400).json({ error: 'postId + modules[] required' });
  }
  const jobId = 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  writeJob(jobId, {
    jobId, postId, status: 'queued', step: 'init',
    modCount: mods.length, createdAt: new Date().toISOString(),
  });
  // 即返却 → 後段は非同期実行（接続切れに耐性）
  res.json({ ok: true, jobId });
  _runScenarioJob(jobId, postId, mods, postIn).catch(e => {
    console.error('[Step3 v3] job例外:', e.message, e.stack);
    writeJob(jobId, {
      jobId, postId, status: 'error', error: e.message,
      finishedAt: new Date().toISOString(),
    });
  });
});

// ─── /api/v3/scenario-status : ジョブ進捗 ──────────────
router.get('/v3/scenario-status', (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const j = readJob(jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});

// ─── 実処理（バックグラウンド実行）─────────────────────
async function _runScenarioJob(jobId, postId, mods, postIn) {
  const updateJob = (patch) => {
    const cur = readJob(jobId) || { jobId, postId };
    writeJob(jobId, { ...cur, ...patch, updatedAt: new Date().toISOString() });
  };
  try {
    const si       = safeJson(siPath(postId), { boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } } });
    const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

    // post 情報（タイトル+コメント）はクライアント送ってこれてもwindow.APP.selected経由で来ない可能性がある
    // 必須でないが、付加情報として使う
    const post = postIn || {};
    const titleJa = post.titleJa || post.title || '(案件タイトル不明)';
    const titleOrigScn = post.titleOrig || post.title || '';
    const bodyExcerptScn = (post.raw?.bodyJa || post.raw?.body || post.selftext || '').slice(0, 800);
    const commentsRaw = (post.raw?.comments || [])
      .map(c => c.bodyJa || c.body || '').filter(Boolean).slice(0, 8).join(' / ').slice(0, 1500);

    // ── データソース要約：siData entity/match/search を AIプロンプト用に圧縮 ──
    function _entityBlock(it) {
      const role = it.role;
      const wikiSum = it.wiki?.ok
        ? `wiki:{title:"${it.wiki.title || ''}",extract:"${(it.wiki.extract || '').slice(0, 250)}"}` : 'wiki:×';
      let sofaSum = 'sofa:×';
      if (it.sofa?.ok) {
        // role 別にAIへ渡すフィールドを最適化
        let payload;
        if (role === 'tournament') {
          // 大会：順位表 + 得点王ランキング（standings は最大10件まで圧縮）
          payload = {
            name: it.sofa.name, country: it.sofa.country,
            seasonYear: it.sofa.seasonYear,
            standings:      Array.isArray(it.sofa.standings)      ? it.sofa.standings.slice(0, 10)     : [],
            relegationRace: it.sofa.relegationRace,
            topScorers:     Array.isArray(it.sofa.topScorers)     ? it.sofa.topScorers.slice(0, 3)     : [],
            topAssists:     Array.isArray(it.sofa.topAssists)     ? it.sofa.topAssists.slice(0, 3)     : [],
          };
        } else if (role === 'team') {
          // チーム：last5（直近実結果）+ recentForm を必ず含める。AIが過去/未来を混同しないため
          //   topPlayers は { goals:[...], assists:[...], rating:[...] } のオブジェクト形式なので
          //   goals 上位3名だけ展開（チーム内得点王として AI が言及できれば十分）
          const topScorers = Array.isArray(it.sofa.topPlayers?.goals)
            ? it.sofa.topPlayers.goals.slice(0, 3)
            : [];
          payload = {
            teamName: it.sofa.teamName, league: it.sofa.leagueName, country: it.sofa.country,
            standing: it.sofa.standing, manager: it.sofa.managerName,
            seasonStats: it.sofa.seasonStats, teamStats: it.sofa.teamStats,
            recentForm: it.sofa.recentForm,                      // "WWLDD" 形式
            last5:      Array.isArray(it.sofa.last5) ? it.sofa.last5.slice(0, 5) : [],
            topScorers,                                          // チーム内得点上位3
            trophySummary: it.sofa.trophySummary,
          };
        } else {
          // player / manager（既存）
          payload = {
            name: it.sofa.name, position: it.sofa.position, team: it.sofa.team,
            league: it.sofa.leagueName, country: it.sofa.country,
            standing: it.sofa.standing, manager: it.sofa.managerName,
            seasonStats: it.sofa.seasonStats, lastMatchStats: it.sofa.lastMatchStats,
            recentAvgRating: it.sofa.recentAvgRating,
            currentTeam: it.sofa.currentTeam,
            overallPerformance: it.sofa.overallPerformance,
            currentTeamStats: it.sofa.currentTeamStats,
          };
        }
        // role別に表示量を可変（tournamentは順位表が太いので増量）
        const cap = role === 'tournament' ? 1500 : role === 'team' ? 1200 : 700;
        sofaSum = `sofa:${JSON.stringify(payload).slice(0, cap)}`;
      }

      // 🆕 監督限定: Transfermarkt + Wikipedia 戦績データを追加（2026-05-08）
      //   主データ = Transfermarkt /stationen/plus/1 (W/D/L/GF/GA/Days/Players 全部入り)
      //   補助 = Wikipedia (タイトル詳細補完用、W/D/L は TM 優先)
      let tmSum = '', wstatsSum = '', tmGamesSum = '';
      if (role === 'manager') {
        if (it.tm?.ok) {
          const tmPayload = {
            coachClubs: (it.tm.coachClubs || []).map(c => ({
              club: c.club, role: c.role,
              from: c.fromDate || c.fromSeason,
              to: c.toExpected ? 'present' : (c.toDate || c.toSeason),
              days: c.daysInCharge,           // 在任日数
              m: c.matches, w: c.w, d: c.d, l: c.l,  // W/D/L 内訳
              gf: c.gf, ga: c.ga,             // 通算得点・失点（推定）
              avgGF: c.avgGoalsFor, avgGA: c.avgGoalsAgainst,  // 1試合平均
              players: c.playersUsed,          // 使用選手数
              ppm: c.ppm,
            })),
            currentSeason: (it.tm.currentSeasonByCompetition || []).map(c => ({
              comp: c.competition, m: c.matches, w: c.w, d: c.d, l: c.l, ppm: c.ppm,
            })),
            currentTotal: it.tm.currentSeasonTotal
              ? { m: it.tm.currentSeasonTotal.matches, w: it.tm.currentSeasonTotal.w, d: it.tm.currentSeasonTotal.d, l: it.tm.currentSeasonTotal.l, ppm: it.tm.currentSeasonTotal.ppm }
              : null,
            trophies: (it.tm.trophies || []).slice(0, 12).map(t => ({
              title: t.title, count: t.count,
              seasons: (t.seasons || []).map(s => `${s.season}@${s.club}`).slice(0, 6),
            })),
          };
          tmSum = `\n  tm:${JSON.stringify(tmPayload).slice(0, 1700)}`;
        }
        // Wikipedia は TM が取れない部分の補助。タイトル詳細や Win% 検証用
        if (it.wikiMgrStats?.ok) {
          const wstats = {
            rows: (it.wikiMgrStats.rows || []).map(r => ({
              team: r.team, from: r.from, to: r.to, p: r.p, w: r.w, d: r.d, l: r.l, winPct: r.winPct,
            })),
            total: it.wikiMgrStats.total || null,
          };
          wstatsSum = `\n  wstats:${JSON.stringify(wstats).slice(0, 600)}`;
        }
      }

      // 🆕 選手限定: Transfermarkt 試合単位の集計データ（2026-05-08）
      //   直近3シーズン × 大会別の出場/G/A + 直近シーズン監督別 top3 + 直近 N 試合の生データ
      if (role === 'player' && it.tmGames?.ok) {
        // 🆕 代表通算（caps/G/A/firstCap/lastCap/大会別） — 重要度高につき先頭配置
        const natl = it.tmGames.national;
        // 🆕 Wiki infobox の A代表正解値（FIFA公式準拠 / U-XX や Olympic を除外したシニア代表エントリ）
        const wikiNatlAll = it.wikiNational || [];
        const wikiNatlSenior = wikiNatlAll.find(n => n.team && !/U\s?\d+|Olympic|Youth/i.test(n.team)) || wikiNatlAll.slice(-1)[0] || null;
        // 🆕 怪我履歴（直近5件 + 進行中フラグ）— W杯選考予測等の重要シグナル
        const injAll = Array.isArray(it.tmGames.injuries) ? it.tmGames.injuries : [];
        const injOngoing = injAll.filter(i => i.isOngoing);
        const injRecent5 = [...injAll].sort((a, b) => (b.fromDate || '').localeCompare(a.fromDate || '')).slice(0, 5);
        const tmgPayload = {
          career: {
            apps: it.tmGames.career?.appearances,
            g: it.tmGames.career?.goals,
            a: it.tmGames.career?.assists,
          },
          // 🆕 Wikipedia infobox の A代表値 — FIFA 公式準拠で正確 / TM aggregateNational より優先して使うこと
          wikiNationalSenior: wikiNatlSenior ? {
            team: wikiNatlSenior.team,
            caps: wikiNatlSenior.caps,
            g:    wikiNatlSenior.goals,
            sinceYear: wikiNatlSenior.years?.start,
          } : null,
          // 🆕 怪我履歴: ongoing (進行中) を最優先、次に直近 5件
          injuries: {
            ongoing: injOngoing.map(i => ({
              part: i.injury, from: i.fromDate, until: i.untilDate,
              days: i.days, missedGames: i.missedGames,
            })),
            recent5: injRecent5.map(i => ({
              part: i.injury, from: i.fromDate, until: i.untilDate,
              days: i.days, missedGames: i.missedGames,
            })),
            total: injAll.length,
          },
          national: (natl && natl.caps > 0) ? {
            caps:     natl.caps,
            g:        natl.goals,
            a:        natl.assists,
            minutes:  natl.minutes,
            firstCap: natl.firstCapDate,
            lastCap:  natl.lastCapDate,
            byComp:   (natl.byCompetition || []).slice(0, 6).map(c => ({
              c: c.competition, apps: c.caps, g: c.goals, a: c.assists,
            })),
          } : null,
          recentByComp: (it.tmGames.recentByCompetition || []).slice(0, 10).map(r => ({
            s: r.season, c: r.competition,
            apps: r.appearances, g: r.goals, a: r.assists,
            tw: r.teamRecord?.w, td: r.teamRecord?.d, tl: r.teamRecord?.l,
          })),
          byCoachLatest: (it.tmGames.byCoachLatest || []).slice(0, 3).map(c => ({
            coachId: c.coachId, season: c.season,
            apps: c.appearances, g: c.goals, a: c.assists,
            tw: c.teamRecord?.w, td: c.teamRecord?.d, tl: c.teamRecord?.l,
          })),
          // 🆕 直近 20 試合の生データ（スコア・対戦相手・G/A・出場分）— history/insight/stats で個別試合を引用できる
          recentGames: (it.tmGames.recentGames || []).slice(0, 20).map(g => ({
            d: g.date, s: g.season, c: g.competition, day: g.gameDay,
            v: g.venue, opp: g.opponent, sc: g.score,
            G: g.G || 0, A: g.A || 0, m: g.minutes || 0,
          })),
        };
        tmGamesSum = `\n  tmGames:${JSON.stringify(tmgPayload).slice(0, 2600)}`;
      }

      return `- "${it.label}" [${role}]\n  ${wikiSum}\n  ${sofaSum}${tmSum}${wstatsSum}${tmGamesSum}`;
    }
    function _matchBlock(it) {
      if (!it.data?.ok) return `- "${it.label}" : 取得失敗`;
      // matchcard ナレーションで使う「得点」「レッドカード退場」を含める
      const redCards = (it.data.cards || [])
        .filter(c => c.color === 'レッド' || c.color === '2枚目イエロー→退場');
      return `- "${it.label}" : ${JSON.stringify({
        scoreline: it.data.scoreline, date: it.data.matchDate,
        tournament: it.data.tournament, venue: it.data.venue,
        goals: (it.data.goals || []).slice(0, 8),
        redCards,                                            // ★退場のみ
        topPlayers: (it.data.topPlayers || []).slice(0, 3),
        h2hSummary: it.data.h2hSummary,
      }).slice(0, 900)}`;
    }
    function _searchBlock(it) {
      if (!it.data?.organic) return `- "${it.label}" : 結果なし`;
      const top = it.data.organic.slice(0, 3).map(r => `${r.title}: ${r.snippet?.slice(0,120)||''}`).join(' / ');
      return `- "${it.label}" : ${top.slice(0, 500)}`;
    }
    const entityBlock = (si.boxes.entity.items || []).map(_entityBlock).join('\n') || '(なし)';
    const matchBlock  = (si.boxes.match.items  || []).map(_matchBlock).join('\n')  || '(なし)';
    const searchBlock = (si.boxes.search.items || []).map(_searchBlock).join('\n') || '(なし)';

    // ── 各カードの type を解決（fixed/matchcard 以外は AI 由来 m.type を採用）──
    mods.forEach(m => {
      m.type = resolveType(m.mainKey, si, m.type);
    });

    // ═══════════════════════════════════════════════════════════
    // 🆕 entity ラベル正規化 + history 対戦史型の H2H プリフェッチ（2026-05-10）
    // ═══════════════════════════════════════════════════════════
    const _entityItems = (si.boxes?.entity?.items || []).filter(x => x?.label);
    function _normForMatch(s) {
      return String(s || '')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
    }
    function _resolveEntityLabel(raw) {
      if (!raw) return raw;
      const t = String(raw).trim();
      const exact = _entityItems.find(x => x.label === t);
      if (exact) return exact.label;
      const tn = _normForMatch(t);
      if (!tn) return raw;
      const ci = _entityItems.find(x => _normForMatch(x.label) === tn);
      if (ci) return ci.label;
      const matches = _entityItems
        .map(x => ({ x, n: _normForMatch(x.label) }))
        .filter(p => p.n && (tn.includes(p.n) || p.n.includes(tn)))
        .sort((a, b) => b.n.length - a.n.length);
      if (matches.length) return matches[0].x.label;
      return raw;
    }

    // mods に対して entity label 正規化 + history secondary 自動補完
    mods.forEach(m => {
      if (!m.mainKey) return;
      if (m.mainKey.startsWith('entity:')) {
        const rawKey = m.mainKey.slice(7);
        const fixed = _resolveEntityLabel(rawKey);
        if (fixed && fixed !== rawKey) m.mainKey = 'entity:' + fixed;
      }
      if (m.secondary) {
        const fixedSec = _resolveEntityLabel(m.secondary);
        if (fixedSec && fixedSec !== m.secondary) m.secondary = fixedSec;
      }
    });

    // history で mainKey=entity:Team で secondary が空 → 同 mods から対戦相手を推測
    function _findOpponentTeam(primaryLabel) {
      const primaryItem = _entityItems.find(x => x.label === primaryLabel);
      if (!primaryItem || primaryItem.role !== 'team') return null;
      // (1) 同 mods の comparison カード（自分とペアの相手）
      for (const c of mods) {
        if (c.type !== 'comparison' || !c.mainKey?.startsWith('entity:') || !c.secondary) continue;
        const left = c.mainKey.slice(7);
        if (left === primaryLabel) {
          const it = _entityItems.find(x => x.label === c.secondary);
          if (it && it.role === 'team') return c.secondary;
        }
        if (c.secondary === primaryLabel) {
          const it = _entityItems.find(x => x.label === left);
          if (it && it.role === 'team') return left;
        }
      }
      // (2) match / matchcard ラベルから対戦相手を取る
      for (const c of mods) {
        const pre = c.mainKey?.startsWith('matchcard:') ? 'matchcard:' :
                    c.mainKey?.startsWith('match:') ? 'match:' : null;
        if (!pre) continue;
        const matchLabel = c.mainKey.slice(pre.length);
        const matchItem = (si.boxes.match?.items || []).find(x => x.label === matchLabel);
        const data = matchItem?.data;
        const home = data?.homeTeam || matchLabel.split(/\s+vs\s+/i)[0]?.trim();
        const away = data?.awayTeam || matchLabel.split(/\s+vs\s+/i)[1]?.trim();
        if (home === primaryLabel && away) {
          const it = _entityItems.find(x => x.label === away);
          if (it && it.role === 'team') return away;
        }
        if (away === primaryLabel && home) {
          const it = _entityItems.find(x => x.label === home);
          if (it && it.role === 'team') return home;
        }
      }
      return null;
    }
    mods.forEach(m => {
      if (m.type !== 'history' || !m.mainKey?.startsWith('entity:') || m.secondary) return;
      const primary = m.mainKey.slice(7);
      const opp = _findOpponentTeam(primary);
      if (opp) {
        m.secondary = opp;
        console.log(`[Step3] history secondary 自動補完: ${primary} vs ${opp}`);
      }
    });

    // history で mainKey=entity:Team + secondary=Team のペアを抽出 → H2H プリフェッチ
    const historyPairs = [];
    mods.forEach(m => {
      if (m.type !== 'history' || !m.mainKey?.startsWith('entity:') || !m.secondary) return;
      const primary = m.mainKey.slice(7);
      const itP = _entityItems.find(x => x.label === primary);
      const itS = _entityItems.find(x => x.label === m.secondary);
      if (itP?.role === 'team' && itS?.role === 'team') {
        const key = `${primary}|${m.secondary}`;
        if (!historyPairs.find(p => p.key === key)) {
          historyPairs.push({ key, primary, secondary: m.secondary });
        }
      }
    });

    const h2hCache = new Map();   // key="primary|secondary" → h2h[]
    if (historyPairs.length) {
      const { fetchRecentH2H } = require('../scripts/modules/fetchers/sofascore_match');
      await Promise.all(historyPairs.map(async p => {
        try {
          const h2h = await fetchRecentH2H(p.primary, p.secondary, 8);
          if (Array.isArray(h2h) && h2h.length) {
            h2hCache.set(p.key, h2h);
            console.log(`[Step3] H2H プリフェッチ: ${p.primary} vs ${p.secondary} → ${h2h.length}試合`);
          } else {
            console.warn(`[Step3] H2H プリフェッチ: ${p.primary} vs ${p.secondary} → 0試合`);
          }
        } catch (e) {
          console.warn(`[Step3] H2H プリフェッチ失敗: ${p.primary} vs ${p.secondary}`, e.message);
        }
      }));
    }

    // AI プロンプト用 H2H ブロック（試合行を AI に見せて narrationChunks の N に揃えさせる）
    let h2hBlock = '';
    if (h2hCache.size) {
      const sections = [];
      for (const [key, h2h] of h2hCache) {
        const [primary, secondary] = key.split('|');
        const lines = h2h.map((e, i) => {
          const d  = e.date || '?';
          const sc = (e.homeScore != null && e.awayScore != null) ? `${e.homeScore}-${e.awayScore}` : '?';
          return `  [${i+1}] ${d}: ${e.homeTeam} ${sc} ${e.awayTeam} (${e.tournament || ''})`;
        }).join('\n');
        sections.push(`[H2H: ${primary} vs ${secondary}（直近${h2h.length}戦・サーバ確定データ）]\n${lines}`);
      }
      h2hBlock = sections.join('\n\n');
    }

    // ── outline ブロック化（idx は 1 始まり = 1..mods.length）──
    const outlineLines = mods.map((m, i) => {
      let tags = `main="${m.mainKey}"`;
      if (m.secondary) tags += ` secondary="${m.secondary}"`;
      return `idx=${i+1}: type=${m.type} ${tags}\n   scriptDir: ${m.scriptDir || '(指示なし)'}`;
    }).join('\n');

    // ── レシピマッチカードのメタを集める（AIに recipeKey または customSlotKeys を選ばせる）──
    //    comparison・stats・profile・history・matchcard 等、availableSlots を持つカード全部
    const bindingMetaByIdx = {};
    mods.forEach((m, i) => {
      const meta = getBindingMeta(m, si);
      if (meta) bindingMetaByIdx[i] = meta;
    });
    const bIdxs = Object.keys(bindingMetaByIdx);
    const bindingSection = bIdxs.length ? (() => {
      const lines = bIdxs.map(idx => {
        const meta = bindingMetaByIdx[idx];
        // walker slot 一覧（priority 上位 25 件に絞って AI 提示量を抑える）
        const topSlots = meta.availableSlots
          .slice()
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .slice(0, 25)
          .map(s => `      - "${s.key}" (p:${s.priority}, ${s.category}): ${s.label}`)
          .join('\n');
        // 利用可能レシピ
        const recipeLines = (meta.recipes || [])
          .map(r => `      - "${r.key}": ${r.label} — ${r.description}`)
          .join('\n');
        const head = meta.isCompare
          ? `カード#${parseInt(idx)+1} [比較] (${meta.subject}: ${meta.primary} vs ${meta.secondary} / aspect=${meta.aspect}):`
          : `カード#${parseInt(idx)+1} [単体] (${meta.subject}: ${meta.primary} / aspect=${meta.aspect}):`;
        return `${head}
    【利用可能レシピ（推奨：これを選ぶと一発で意図が通る）】
${recipeLines || '      (該当レシピなし — customSlotKeys で個別指定)'}
    【生 walker slot (priority 上位25件)】
${topSlots}`;
      }).join('\n\n');
      return `

━━━ 【データ選定 — レシピ または customSlotKeys】━━━
以下のカードは dataSlots を直接書かず、以下のどちらかを返してください：

  ① **"recipeKey": "<レシピキー>"**  ← 推奨：意図とレシピが合致するなら 1 単語で指定
  ② **"customSlotKeys": [k1, k2, ...]** ← レシピで足りない時のみ：生 walker キーを直接選定

サーバ側で recipeKey は walker キーに展開され、実値が dataSlots に充填されます。
**dataSlots フィールドは絶対に返さない**（recipeKey か customSlotKeys のみ）。

${lines}

【選定ルール（厳守）】
- レシピで意図がカバーできる場合は **必ず recipeKey を選ぶ**
- レシピが意図と合わない（or レシピ未提示）場合のみ customSlotKeys で個別指定
  - 比較カード: customSlotKeys は **5つ**
  - 単体カード: customSlotKeys は **6〜8個**
- 同じカード内で recipeKey と customSlotKeys を両方返さない（recipeKey 優先）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    })() : '';

    // ── プロンプト ──
    const prompt = `あなたはサッカーYouTubeのプロ脚本家です。
以下の outline と取得済み素材から、各カードの本体（narration、データ、キャッチコピー等）を生成してください。

【今日の日付】${todayJst}（JST）
【案件タイトル】${titleJa}
${titleOrigScn && titleOrigScn !== titleJa ? `【原題】${titleOrigScn}\n` : ''}${bodyExcerptScn ? `【案件本文（事実情報の主源）】\n${bodyExcerptScn}\n` : ''}${commentsRaw ? `【上位コメント（視聴者の感想・予測・皮肉。事実ではない）】\n${commentsRaw}\n` : ''}

━━━ 【ファクト管理ルール（厳守）】━━━
- narration / title の地の文に書く事実は **【案件本文】と【取得済みデータ】に明記されてるもの限定**
- 【案件本文】が**未来形・予定形・推測形**で書いてる事象を、**確定形・完了形に書き換え禁止**
  ❌例: 本文「サラーは今季中に復帰予定」 → narration「復帰戦のサラー」「復帰した瞬間」
  ✅例: 本文「サラーは今季中に復帰予定」 → narration「サラーが今季中に復帰予定」「復帰が決まった」
- 本文に書かれてない出来事を「起きた」「した」と断定しない
- 上位コメントは reaction 型で「ファンの声」として紹介するのは OK だが、地の文の事実根拠にはしない
- 取得済み sofa/wiki データの数値（過去成績・通算など）は事実として使って OK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ 取得済みデータ ━━━
[entity 一覧]
${entityBlock}

[match 一覧]
${matchBlock}

[search 一覧]
${searchBlock}
${h2hBlock ? `\n[H2H 一覧 — 対戦史型 history カード専用 / サーバ確定データ]\n${h2hBlock}\n` : ''}━━━━━━━━━━━━━━━━

【outline (${mods.length}枚)】
${outlineLines}

【生成ルール】
各カードに対して必要なフィールドを全部 JSON で返す：

- 全カード共通：
  - "idx": **outline の番号（1始まり）と完全一致**。1, 2, 3, ..., ${mods.length} の順で必ず出力
  - "title": 短い見出し（10〜25文字）
  - "narration": 視聴者に語りかける口調の本文 — **35秒前後のボリューム = 220〜280文字目安**
    ※ 例外: type=opening は narration 不要（タイトルだけ読み上げる運用）
    ※ **濃い情報だけ抽出**。前置き・繰り返し・「〜と言われています」等の冗長表現は削除。データに直結する事実と数字で勝負

━━━ 【スライド間接続ルール（重要・必須）】━━━
narration 冒頭は**必ず接続フレーズで始める**。箇条書き読み上げ感を消し、番組MC のような流れを作る：

【役割別の接続パターン】
- 1枚目（opening 直後 or TOC 直後）:
  ✅「まずは世間を騒がしているニュースの概要を見ていきましょう。」
  ✅「では、今回の話題、〜から見ていきましょう。」
- 2枚目以降の中盤:
  ✅「では、〜とはどのような人物なのでしょうか。」
  ✅「〜が直近で監督を務めたクラブ、〜についても見ていきましょう。」
  ✅「続いて、〜の歴史を振り返ります。」
  ✅「ここで、〜の数字を確認しておきましょう。」
- 最終 insight:
  ✅「では本題、〜の核心に迫ります。」
  ✅「最後に、〜を8年間率いてきた偉人〜の功績をおさらいしましょう。」
  ✅「ここまでの流れを踏まえて、〜について考察してみましょう。」

【接続フレーズの作り方】
- 30〜50字。前カードの話題を1秒で受けて、次カードのテーマを宣言
- 直前カードの主語を引き継ぐ／対比する／深掘りする の3パターン
- 助詞は「では」「続いて」「次に」「ここで」「まずは」「最後に」を活用
- ❌ 体言止め列挙「マレスカ。イタリア人監督。〜」← 接続無しは禁止
- ❌ 主語抜け「彼の経歴は〜」← 前カード参照に頼って主語省略は禁止

【全体構造】
narration = [接続フレーズ 30〜50字] + [本題 190〜230字（事実+数字+物語）] = 220〜280字
※ chunkText は本題部分の対応文を1文抜粋する（接続フレーズは含めない）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- type 別の追加フィールド + ナレーション方針：
  - opening:
    - "narration": **空文字 ""** で固定（タイトルのみを TTS で読み上げる運用）
    - "title": 動画タイトル（読み上げ対象なので、視聴者が聞いて分かる短く強い文 12〜25文字推奨）
    - "openingBadge": { "text": "短い煽りラベル(2〜4文字)", "color": "#hex", "textColor": "#hex" }
      候補: {"衝撃","#ef4444","#fff"} {"悲報","#ef4444","#fff"} {"朗報","#10b981","#fff"} {"速報","#f59e0b","#000"} {"独占","#8b5cf6","#fff"}
      ※ 案件のトーンに合わせて選ぶ。指定しない場合はサーバ側で title から自動推論
  - ending:
    - "narration": 視聴者への投げかけや登録誘導を含めて 220〜280 文字
    - "endingCta": { "text": "CTAボタン文言(15文字以内)" }
      候補例: "チャンネル登録お願い" / "次回もお楽しみに" / "コメント教えて" / "高評価お願いします"
      ※ 動画の余韻に合った締めの言葉を選ぶ。指定しない場合は既定 "チャンネル登録 & いいね"
  - toc (目次):
    - "title": ページタイトル（10〜18文字）。例:「今日のラインナップ」「本日の見どころ」「ハキミ怪我の全貌」
    - "tocItems": [{"text":"見出し(8〜18文字)","chunkText":"読み上げ用 8〜15文字"} × 3〜5]
      ・以降の動画構成カードを要約（matchcard/insight/comparison 等の title をベースに簡略化）
      ・ナンバリング不要（サーバー側で①②③付与）
      ・例: {"text":"怪我の経緯","chunkText":"まずは怪我の経緯から。"}
      ・例: {"text":"今季の成績","chunkText":"続いて今季の成績を確認。"}
    - "narration": **150〜200字** の煽り入りオープニング目次案内。3要素必須：
      ① 視聴者への呼びかけ（「みなさんこんにちは」「サッカーファンのみなさん、こんにちは」等）
      ② **タイトルを深掘りした煽り文 80〜120字**：事実 + 背景 + 期待感を1〜2文で凝縮
         （「〜について、にわかに話題にあがっている男、〜」「〜が今、サッカー界を揺るがしています」等）
      ③ 「本日は」+ ラインナップ宣言 + 「膨大なデータから読み取った独自解説をお届けします」等の締め
      ✅ 例:「みなさんこんにちは。プレミアリーグの常勝軍団、マンチェスターシティの監督人事に
            にわかに話題にあがっている男、エンツォ・マレスカ。本日は、マレスカの人物像、
            チェルシーでの指揮、シティの歴史、ペップ退団の核心の4つのラインナップで、
            膨大なデータから読み取った独自解説をお届けします。」
      ❌ NG:「全4章で〜まるごと解説。」← 短すぎ・煽りなし
      ❌ NG: items の chunkText を narration 内で先取りして詠み上げない（重複になる）
  - insight:
    - "catchphrases": [{"text":"短句(15文字以内、事実+数字)","chunkText":"narration の対応文1文(35〜55文字)"} × 3〜6]
      ・**chunkText は narration（凝縮深掘り解説 220〜280字）の対応箇所を抜き出した1文**
      ・例: {"text":"ペップ直系の戦術家","chunkText":"若い頃ペップに師事し戦術哲学を学んだ。"}
      ・各 catchphrase は narration の中の対応する1文（要点）と1対1対応する設計
      ・サーバ側で narrationChunks = catchphrases.map(it => it.chunkText) として導出
    - "narration": 220〜280 字の凝縮された深掘り解説（catchphrases.chunkText の連結+繋ぎで物語化）
  - reaction: "comments": [{"text":"...","score":0}×7] — 上記【元コメント抜粋】から面白い7件を選び日本語意訳。
    "narration": **100〜140字の短い前置き**（2026-05-07 短縮: 旧220〜280字。コメント全件を尺内に収めるため）。
    内容は「ファンの反応を見ていきましょう」程度の煽り + 1〜2件の見どころ予告に留め、コメント本体は narration 内で繰り返さない
  - stats: "dataSlots": [{"label":"...","value":"..."}×**6〜8（必ず6以上）**]。narration はデータの背景や流れを語る（220〜280字）。5個以下は不可・必ず6個以上で密度感のある画面を作る
  - history:
    - **🆕 type=history は2形態：(A) 対戦史型 (secondary あり、両 team) / (B) 単独史型 (それ以外)**
    - 【B 単独史型】（例: 監督1人のキャリア / チーム単独の沿革 / 選手の人生）
      - "dataSlots": [{"label":"年(YYYY)","value":"出来事タイトル","chunkText":"narration の対応文1文(35〜55文字)"} × 4〜8]
        ・**chunkText は narration（220〜280字）の対応する出来事の解説文1文**
        ・例: {"label":"2013","value":"バルサ加入","chunkText":"13歳でラ・マシア入団、メッシの背中を追った日々。"}
        ・**★ dataSlots は必ず label の YYYY を昇順（古い→新しい）に並べる** — 視覚的に物語が左→右に進む
      - "narration": 220〜280 字（dataSlots.chunkText の連結+繋ぎで物語化）
    - 【A 対戦史型】（mainKey=entity:Team + secondary=Team / 例: クラシコ史）
      - **dataSlots は返さない** — サーバが [H2H 一覧] の試合データから自動構築
      - 必須: **"narrationChunks": ["1試合目に対応する文(35〜55字)", ..., N個]**
        ・N は [H2H 一覧] のそのペアに列挙された試合数（[1]〜[N]）と完全一致
        ・各 chunkText は H2H 一覧の対応する試合（同じ番号）の出来事・スコア・大会を踏まえた1文
        ・例 H2H[1] が「2025-01-12: Real Madrid 2-5 FC Barcelona (Supercopa)」なら
          narrationChunks[0] = "スーペルコパ決勝で2-5の屈辱、ヤマルが歴史を変えた一夜。"
      - "narration": 220〜280 字（narrationChunks の連結+繋ぎで物語化）
      - **🚨 厳守: [H2H 一覧] に列挙されてない試合は絶対に narration / narrationChunks に書かない**
        ・他チームとの試合（last5 / recentForm の別相手）は H2H ブロックの外側にあるので一切混ぜない
        ・例: クラシコ history なのに「3-1 vs エスパニョール」「4-3 vs バイエルン」← 全部NG
    - "historyHero": "左パネル下のラベル(2〜8文字)"。例: "軌跡" / "栄光の歩み" / "波乱のキャリア" / "黄金時代" / "指揮人生" / "因縁"
    - "historyMilestoneLabel": "右パネル冒頭のセクション見出し(4〜10文字)"。例: "主な歩み" / "キャリアの節目" / "歴代クラブ" / "直近の対決"
    - 指定しない場合は既定 "軌跡" / "主な歩み" を使用
  - profile: "dataSlots": [{"label":"...","value":"..."}×**6〜7（必ず6以上）**] (data-row、上下に積む列)。5個以下は不可・必ず6個以上で密度感のある画面を作る
    例: 選手プロフィール → ポジション / 年齢 / 国籍 / 所属クラブ / 市場価値 / 背番号 / 利き足 / 身長
    例: チームプロフィール → リーグ / 国 / 創設 / 監督 / スタジアム / 総資産 / 首都 / 主要タイトル数
    ※ homeTeam / awayTeam は別途自動注入されるので dataSlots に含めない
    ※ narration はタイトル内容を事実ベースで概要説明
  - comparison: 通常は "dataSlots": [{"label":"...","leftValue":"...","rightValue":"..."}×4〜7]。
    ただし下記【comparison カード メトリック選定】セクションで指定されたカードでは **dataSlots は返さず、代わりに "customSlotKeys": ["key1","key2","key3","key4","key5"] を返す**。narration は比較の意義を解説。
  - matchcard: 追加フィールド不要（matchData は自動注入）。**narration は試合のドラマを時系列ストーリーで語る**：
    ・上記 [match 一覧] の goals と redCards を参照
    ・例: 「23分、ベリンガムが先制点を叩き込んだ。しかし67分、ヴィニシウスがレッドカードで退場、試合の流れが一変…」
    ・得点者・退場者の名前と分数を必ず織り込み、「点が入った→流れが変わった→決着」の物語構造で
    ・スコアラインだけ羅列するのではなく、試合の起伏を視聴者が追体験できる文章に

【データ抽出ルール（厳守）】
- mainKey="entity:<名前>" のカードでは、上記 [entity 一覧] の該当エントリを **データソース** として使う
- mainKey="match:<...>" のカードは [match 一覧] を使う
- 一次情報だけで完結しない場合も、保有情報を解析して受け渡す。例: 選手の各チームへの移籍年とゴール数 → wiki.extract や sofa から抽出して並べる
- type=comparison の場合: dataSlots は左右比較形式 [{label,leftValue,rightValue}]
  - mainKey="entity:<X>" + secondary="<Y>" の場合：**leftValue=Xの値 / rightValue=Yの値**
  - 両者の wiki + sofa を [entity 一覧] から参照し、同じ指標を左右で揃えること

【ハルシネーション禁止 — 厳守】
- 値・固有名は必ず上記取得済きデータに明記されているもののみ
- データに無いものは出力しない（推測・記憶からの補完絶対NG）
- あなたの学習データ（2024年〜）は古い。現在の監督・所属はデータからのみ参照
- 前後カードの文脈が自然につながるように構成する
- **過去在籍選手の混入厳禁**: 移籍・引退済の有名選手を**絶対に書かない**
  ・例: PSG なら「メッシ・ムバッペ・ネイマール」は出さない（全員退団済）
  ・例: マンU なら「C.ロナウド」は出さない（退団済）
  ・SofaScore の topScorers / topPlayers / 監督として **現在いる**人物のみ言及
- **試合結果の混同厳禁**: チーム entity の sofa.last5 が「**実際に行われた直近の試合結果**」。それ以外の試合（次節予定等）の結果は絶対に書かない
  ・「前節〇〇戦は2-0で勝利」と書くなら、必ず last5[0] の opponent と score に一致すること
  ・データに無い試合結果（例: 5/3予定の試合の結果）を予測・捏造しない
  ・「次節は〇〇戦」と書く場合は「予定」「控える」など未確定であることを明示
- **男女混同厳禁**: match data の得点者やスタッツが**女子試合**のものか**男子試合**のものか明示的に区別
  ・SofaScore match で得点者名が女子選手（例: Karchaoui, 谷川萌々子）→ 女子CL/女子リーグの試合
  ・narration 全体で男女どちらの話かを統一。混在する場合は「男子CL」「女子CL」を明記

JSON のみ返す（マークダウン不要）。**idx は outline の番号 1〜${mods.length} と完全一致**で全カード網羅：
{"modules":[
  {"idx":1,"title":"...","narration":"...",...type別フィールド},
  {"idx":2,"title":"...","narration":"...",...type別フィールド},
  ... (合計 ${mods.length}枚 / idx は 1 から ${mods.length} まで欠番なし)
]}${bindingSection}`;

    console.log(`[Step3 v3] generate-scenario: ${mods.length}カード / Sonnet 既定（5/1切替）`);
    updateJob({ status: 'running', step: 'pass1', message: 'AIが脚本を執筆中...' });

    // Sonnet 既定（構成・データ選定・脚本品質を優先） → JSON崩れ時 v4flash 保険
    async function _ask(provider) {
      const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
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

    let raw, parsed = null, used = 'sonnet';
    try {
      raw    = await _ask('anthropic');
      parsed = _parse(raw);
    } catch (e) { console.warn('[Step3 v3] sonnet 例外:', e.message); }
    if (!parsed?.modules) {
      console.warn('[Step3 v3] sonnet 失敗、v4flash にフォールバック');
      raw    = await _ask('deepseek');
      parsed = _parse(raw);
      used   = 'v4flash';
    }
    if (!parsed?.modules) throw new Error('生成失敗（JSON parse fail）');

    // ── AI 出力を idx (1始まり) でインデックス化（順序ズレ・取りこぼしを防ぐ）──
    // idx 欠落の場合は配列順 (1始まり扱い) にフォールバック
    const aiByIdx = {};
    (parsed.modules || []).forEach((ai, k) => {
      const idx = Number.isFinite(ai?.idx) ? Number(ai.idx) : (k + 1);
      if (!aiByIdx[idx]) aiByIdx[idx] = ai;
    });
    const aiIdxs = Object.keys(aiByIdx).map(Number).sort((a, b) => a - b);
    const expectedIdxs = mods.map((_, i) => i + 1);
    const missing = expectedIdxs.filter(x => !aiByIdx[x]);
    if (missing.length) console.warn(`[Step3 v3] AI出力 idx 欠番:`, missing, '/ 取得した idx:', aiIdxs);

    // outline と AI返却をマージ（idx ベース・順序保持）
    // type はクライアント送信値を信用せず、必ずサーバー側で v3_tags.resolveType で決定
    // matchcard は matchData ベースなので dataSlots を強制的に空にする（AIが誤って返しても無視）
    const merged = mods.map((src, i) => {
      const ai = aiByIdx[i + 1] || {};
      // AI 由来 type を最優先（src.type は propose-modules 由来 = AI 推奨）
      const finalType = resolveType(src.mainKey, si, ai.type || src.type);

      // 🆕 新スキーマ対応：catchphrases / dataSlots / tocItems の各 item は
      //   { ...通常field, chunkText } を持ち得る → narrationChunks はサーバ導出
      // 旧スキーマ（chunks が独立配列）も後方互換で受け入れる
      function normalizeItems(arr, textKeys) {
        // textKeys 例: ['text']  -> string も受ける
        // arr が string[] の場合は { text: s } に正規化
        if (!Array.isArray(arr)) return [];
        return arr.map(it => {
          if (typeof it === 'string') {
            return { [textKeys[0]]: it };
          }
          return it && typeof it === 'object' ? it : null;
        }).filter(Boolean);
      }
      function normalizeDataSlots(arr) {
        if (!Array.isArray(arr)) return [];
        return arr.map(s => (s && typeof s === 'object') ? s : null).filter(Boolean);
      }

      const normCatchphrases = normalizeItems(ai.catchphrases, ['text']);
      const normTocItems     = normalizeItems(ai.tocItems    || ai.catchphrases, ['text']);
      const normDataSlots    = finalType === 'matchcard' ? [] : normalizeDataSlots(ai.dataSlots);

      // narrationChunks 導出（優先順位）:
      //   ① items に chunkText が揃っているなら items.map(.chunkText)（新スキーマ）
      //   ② AI が直接 narrationChunks を返してきた配列があればそれを使用（旧スキーマ）
      //   ③ どちらも無ければ空配列（TTS は narration から自動分割）
      function deriveChunks(items) {
        if (!items.length) return null;
        const chunks = items.map(it => String(it?.chunkText || '').trim());
        const allFilled = chunks.every(c => c.length > 0);
        return allFilled ? chunks : null;
      }
      let narrationChunks = [];
      if (finalType === 'history' || finalType === 'comparison' || finalType === 'profile' || finalType === 'stats') {
        narrationChunks = deriveChunks(normDataSlots) || [];
      } else if (finalType === 'insight') {
        narrationChunks = deriveChunks(normCatchphrases) || [];
      } else if (finalType === 'toc') {
        narrationChunks = deriveChunks(normTocItems) || [];
      }
      // 旧スキーマフォールバック
      if (!narrationChunks.length && Array.isArray(ai.narrationChunks)) {
        narrationChunks = ai.narrationChunks.map(s => String(s || '').trim()).filter(Boolean);
      }

      const out = {
        ...src,
        type:         finalType,
        title:        ai.title        || src.title        || `スライド${i+1}`,
        narration:    ai.narration    || '',
        dataSlots:    normDataSlots,
        catchphrases: normCatchphrases,
        comments:     ai.comments     || [],
        narrationChunks,
      };
      // opening 専用：AI が生成した openingBadge {text,color,textColor} を保存
      if (finalType === 'opening' && ai.openingBadge && typeof ai.openingBadge === 'object') {
        out.openingBadge = {
          text:      String(ai.openingBadge.text      || '').slice(0, 6),
          color:     String(ai.openingBadge.color     || '#f59e0b'),
          textColor: String(ai.openingBadge.textColor || '#000'),
        };
      }
      // ending 専用：AI が生成した endingCta {text} を保存
      if (finalType === 'ending' && ai.endingCta && typeof ai.endingCta === 'object') {
        out.endingCta = {
          text: String(ai.endingCta.text || '').slice(0, 16),
        };
      }
      // toc 専用：AI が生成した tocItems[] を保存（または catchphrases から fallback）
      if (finalType === 'toc') {
        out.tocItems = normTocItems.slice(0, 7);
      }
      // history 専用：AI が生成した historyHero / historyMilestoneLabel を保存
      if (finalType === 'history') {
        if (ai.historyHero            && typeof ai.historyHero            === 'string') out.historyHero            = ai.historyHero.slice(0, 12);
        if (ai.historyMilestoneLabel  && typeof ai.historyMilestoneLabel  === 'string') out.historyMilestoneLabel  = ai.historyMilestoneLabel.slice(0, 14);
      }
      return out;
    });

    // ── 後処理: profile / matchcard / comparison(対match) は match siData から
    //          homeTeam / awayTeam / matchData を自動注入 ──
    //    ※ entity ラベル正規化と history secondary 自動補完は mods 段階で実行済み
    merged.forEach(m => {
      if (!m.mainKey) return;
      // mods 段階で正規化済みだが、AI 出力由来の secondary がここで来る可能性もあるので念のため再正規化
      if (m.secondary) {
        const fixedSec = _resolveEntityLabel(m.secondary);
        if (fixedSec && fixedSec !== m.secondary) m.secondary = fixedSec;
      }
      // entity 系の comparison: siBindingLeft/Right を primary/secondary から
      if (m.type === 'comparison' && m.mainKey.startsWith('entity:') && m.secondary) {
        m.siBindingLeft  = m.mainKey.slice(7);
        m.siBindingRight = m.secondary;
      }
      // mainKey="match:<label>" / "matchcard:<label>" → matchを引く
      const mcPrefix = m.mainKey.startsWith('matchcard:') ? 'matchcard:' : null;
      const mPrefix  = m.mainKey.startsWith('match:') ? 'match:' : mcPrefix;
      if (mPrefix) {
        const matchLabel = m.mainKey.slice(mPrefix.length);
        const matchItem  = (si.boxes.match?.items || []).find(x => x.label === matchLabel);
        const data       = matchItem?.data;
        const parts = matchLabel.split(/\s+vs\s+/i).map(s => s.trim());
        m.homeTeam  = data?.homeTeam  || parts[0] || 'HOME';
        m.awayTeam  = data?.awayTeam  || parts[1] || 'AWAY';
        m.homeLogo  = data?.homeLogo || null;     // profile (試合プレビュー) 用
        m.awayLogo  = data?.awayLogo || null;
        m.homeScore = data?.homeScore;
        m.awayScore = data?.awayScore;
        m.matchDate = data?.matchDate || '';
        m.scoreline = data?.scoreline || '';
        // matchcard はフォーメーション付き matchData オブジェクトを期待（拡張版）
        if (m.type === 'matchcard' && data?.ok) {
          m.matchData = {
            homeTeam:   data.homeTeam,
            awayTeam:   data.awayTeam,
            homeScore:  data.homeScore,
            awayScore:  data.awayScore,
            homeLogo:   data.homeLogo || null,
            awayLogo:   data.awayLogo || null,
            tournament: data.tournament,
            matchDate:  data.matchDate,
            venue:      data.venue,
            attendance: data.attendance,
            scoreline:  data.scoreline,
            goals:      Array.isArray(data.goals) ? data.goals : [],
            cards:      Array.isArray(data.cards) ? data.cards : [],
            subs:       Array.isArray(data.subs)  ? data.subs  : [],
            stats:      data.stats || {},                  // {name:{home,away}}
            formations: data.formations || { home: null, away: null },
            lineup:     data.lineup     || { home: [], away: [] },
            topPlayers: Array.isArray(data.topPlayers) ? data.topPlayers : [],
            h2hSummary: data.h2hSummary || null,
          };
        }
      }
    });

    // ── 🆕 history 対戦史型の dataSlots を H2H 実データから固定構築（2026-05-10 バグ①根本対策）
    //    mods 段階でプリフェッチ済みの h2hCache を使い、dataSlots と narrationChunks を確定。
    //    AI が誤って書いた dataSlots は捨てる（捏造防止の本丸）。chunkText だけ AI から流用。
    merged.forEach(m => {
      if (m.type !== 'history' || !m.mainKey?.startsWith('entity:') || !m.secondary) return;
      const primary = m.mainKey.slice(7);
      const h2h = h2hCache.get(`${primary}|${m.secondary}`);
      if (!h2h?.length) return;   // H2H 取れなかった → AI 出力のまま（単独史型と同じ扱い）

      // AI から chunkText を取り出す（narrationChunks 直接 or dataSlots[i].chunkText）
      const aiChunks = Array.isArray(m.narrationChunks) && m.narrationChunks.length
        ? m.narrationChunks.map(s => String(s || '').trim())
        : (Array.isArray(m.dataSlots) ? m.dataSlots.map(d => String(d?.chunkText || '').trim()) : []);

      // H2H 試合データから dataSlots を構築
      m.dataSlots = h2h.map((e, i) => {
        const d = e.date || '';
        const yyyymm = d.slice(0, 7).replace('-', '/');   // "2025/01"
        const myScore  = e.homeTeam === primary ? e.homeScore : e.awayScore;
        const oppScore = e.homeTeam === primary ? e.awayScore : e.homeScore;
        const result   = (myScore != null && oppScore != null)
          ? (myScore > oppScore ? '○' : myScore < oppScore ? '●' : '△')
          : '';
        const sc = (myScore != null && oppScore != null) ? `${myScore}-${oppScore}` : '?-?';
        const tour = e.tournament ? ` (${String(e.tournament).slice(0, 14)})` : '';
        return {
          label:     yyyymm || `第${i+1}戦`,
          value:     `${result}${sc}${tour}`,
          chunkText: aiChunks[i] || '',
        };
      });
      m.narrationChunks = m.dataSlots.map(d => d.chunkText);
      m._h2hFixed = true;   // 後段の recipe 再構築でこの dataSlots を上書きされないようガード
      console.log(`[Step3] history 対戦史型 dataSlots 固定: ${primary} vs ${m.secondary} → ${m.dataSlots.length}枚（H2H実データ）`);
    });

    // ── 後処理: recipeKey または customSlotKeys → dataSlots を実値で再構築 ──
    //    AI が dataSlots を返してきても上書き（捏造防止の本丸）。
    //    優先: AI の customSlotKeys → recipeKey 展開 → defaultSelection
    const { expandRecipe, hasRecipe } = require('../scripts/v2_story/recipes_curated');
    merged.forEach((m, i) => {
      if (m._h2hFixed) return;   // history 対戦史型は H2H で確定済み
      const meta = bindingMetaByIdx[i];
      if (!meta) return;
      const aiOut = aiByIdx[i + 1] || {};

      // recipeKey が指定されてれば walker キーに展開（customSlotKeys が無いケース優先）
      let keys = Array.isArray(aiOut.customSlotKeys) ? aiOut.customSlotKeys.filter(Boolean) : [];
      if (!keys.length && aiOut.recipeKey && hasRecipe(aiOut.recipeKey)) {
        const expanded = expandRecipe(aiOut.recipeKey, meta.availableSlots);
        if (expanded?.length) {
          keys = expanded;
          m.binding = m.binding || {};
          m.binding.recipeKey = aiOut.recipeKey;  // 編集側で「採用レシピ」として表示
          console.log(`[Step3 v3] card#${i+1} recipe採用: ${aiOut.recipeKey} → ${expanded.length}keys`);
        }
      }
      const validKeys = new Set(meta.availableSlots.map(s => s.key));
      keys = keys.filter(k => validKeys.has(k));
      // 件数の調整：比較=5固定 / 単体（stats/profile他）=6〜8
      const targetMin = meta.isCompare ? 5 : 6;
      const targetMax = meta.isCompare ? 5 : 8;
      if (keys.length < targetMin) {
        const fillers = meta.defaultSelection.filter(k => !keys.includes(k));
        keys = [...keys, ...fillers].slice(0, targetMax);
      } else if (keys.length > targetMax) {
        keys = keys.slice(0, targetMax);
      }
      m.dataSlots = buildDataSlotsFromMeta(meta, keys);
      const recipeKeyHint = m.binding?.recipeKey || (aiOut.recipeKey && hasRecipe(aiOut.recipeKey) ? aiOut.recipeKey : null);
      m.binding = {
        subject:        meta.subject,
        aspect:         meta.aspect,
        primary:        meta.primary,
        secondary:      meta.secondary,
        customSlotKeys: keys,
        ...(recipeKeyHint ? { recipeKey: recipeKeyHint } : {}),
      };
    });

    // ── Pass 2: DeepSeek 自己監修（全カード一括）──
    //   元データと生成結果（narration / dataSlots）を突き合わせ、矛盾を検出して修正版を返させる。
    //   matchcard は dataSlots 不要のため narration のみチェック対象。
    //   失敗時は Pass1 結果をそのまま使う（フェイルセーフ）。
    updateJob({ status: 'running', step: 'pass2', message: 'AIが自己監修中...' });
    let reviewIssues = [];
    let reviewUsed   = false;
    try {
      const modSummaries = merged.map((m, i) => ({
        idx:       i + 1,
        type:      m.type,
        title:     m.title || '',
        mainKey:   m.mainKey || '',
        secondary: m.secondary || null,
        narration: m.narration || '',
        dataSlots: Array.isArray(m.dataSlots) ? m.dataSlots : [],
        narrationChunks: Array.isArray(m.narrationChunks) ? m.narrationChunks : null,
        catchphrases:    Array.isArray(m.catchphrases) ? m.catchphrases : null,
      }));

      const reviewPrompt = `あなたはサッカーYouTube脚本の事実整合性チェッカー。
別のAIが生成した全 ${merged.length} カードの narration / dataSlots を、元データと突き合わせて矛盾があれば指摘・修正してください。

【今日の日付】${todayJst}（JST）
【案件】${titleJa}
━━━ 取得済みデータ ━━━
[entity 一覧]
${entityBlock}

[match 一覧]
${matchBlock}

[search 一覧]
${searchBlock}
━━━━━━━━━━━━━━━━

【生成結果（チェック対象 / 全 ${merged.length} カード）】
${JSON.stringify(modSummaries, null, 2).slice(0, 8000)}

【チェック観点（厳密に）】
1. narration 内の固有数字（順位/ゴール数/試合数/年/勝敗/通算）が元データに辿れるか
2. narration 内の **リーグ名・大会名** が元データの leagueName と一致するか
   ・元データの leagueName が "UEFA Champions League" なのに narration が「リーグ戦◯位」と書いてたら誤り
   ・"Bundesliga" / "Premier League" 等の国内リーグ名と「リーグ戦」が一致してれば正
   ・standing は leagueName が示す競技の順位であることを忘れずに
3. dataSlots の値と narration の説明が同じ事実を指しているか
4. 元データに**明示されていない**数字（CL優勝回数・通算試合数等）を narration や dataSlots が出してないか
   ・H2H ブロックがあれば「直近5試合」等の範囲付き表現になっているか（「全期間 X勝Y敗」と断言NG）
5. 通算値の計算（複数クラブのcaps合計など）が元データから検算できるか
6. 固有名詞（チーム名・選手名）が元データの綴りと一致するか
7. **前後カード間の矛盾**（同じ選手の所属が違う / 同じ試合のスコアが違う等）が無いか

【★時間軸の3層区別 — 致命的エラー防止（厳守）】
データには3つの異なる時間軸のスタッツが存在します。混同・誤帰属は致命的エラー：

(A) lastMatchStats = その1試合限定のスタッツ
    ・tournament フィールドにその試合の大会名が記載される
    ・narration で「今日の試合で N得点」「この試合で N アシスト」のみ使用OK
    ・「今期」「通算」と書くのは誤り

(B) seasonStats = 今シーズンの累積スタッツ（ほぼ国内リーグ限定）
    ・sofa.leagueName が示すリーグ（"LaLiga"/"Premier League"/"Bundesliga"等）の累積
    ・CL/EL/カップ戦の数字は含まれない
    ・narration で「今季N得点」と書くなら必ず leagueName を併記
      ✓「今季ラ・リーガで N 得点」「今季プレミアで N 得点」
      ✗「今季CLで N 得点」（誤り。CL得点は別カテゴリ。修正対象）

(C) 通算/career = 入手不可（選手の場合）
    ・「CL通算 X 試合 N ゴール」「キャリア通算 N ゴール」等は元データに無い
    ・**書いていたら narration から削除**
    ・例外: 監督の overallPerformance は通算データなのでそのまま使ってOK

【★大会名の混同検出】
- 「リーガ」「ラ・リーガ」「La Liga」は全て同一（スペイン1部）
- 「プレミア」「プレミアリーグ」「Premier League」「PL」は全て同一（イングランド1部）
- 異なるリーグ名の混在は誤り：
  ✗「アーセナルは現在リーガでPL首位」（リーガ＝La Liga なので矛盾。修正対象）
  ✓「アーセナルはプレミアリーグで首位」

【★固有名詞の翻字保持 — 致命的事故防止】
元データの英語/スペイン語/スウェーデン語等の綴りを勝手にカタカナ変換しない。
過去事故例（修正必須）：
  ✗ Julián Álvarez → 「ホアン・アルバレス」（Juan ではない。Julián はスペイン語の「フリアン」）
  ✓ Julián Álvarez → 「フリアン・アルバレス」または「ジュリアン・アルバレス」
  ✗ Viktor Gyökeres → 「ヒョイビャー」「ヒョーケレス」（独自変換は禁止）
  ✓ Viktor Gyökeres → 「ヴィクトル・ギョケレス」（標準的な日本語化）
- Wikipedia extract に日本語表記があればそれを優先
- 不明な場合は標準的な日本語表記に留める。当て字・推測カタカナ化は禁止

【修正方針】
- narration の修正は **最小限・ピンポイント**で。文体・前後カードの繋ぎは維持
- dataSlots の修正は数字や固有名の誤りのみ
- 元データに該当が無い数字は「データ未取得」と記すか narration から削除
- 「矛盾なし」のカードは fixed に元の値をそのまま入れる
- matchcard は dataSlots 空のままで OK（変更しない）
- comparison カードの dataSlots はサーバーが実値再構築するので narration のみ修正

【★各 item.chunkText の整合性（致命的事故防止）】
- 各 dataSlots[].chunkText / catchphrases[].chunkText / tocItems[].chunkText も
  narration と同じ厳密性で事実チェックする
- narration を修正したら、対応する items[].chunkText も連動修正する
- narrationChunks 配列はサーバ側で items[].chunkText から導出されるので、
  fixed[].dataSlots / fixed[].catchphrases / fixed[].tocItems を返す際は
  各 item に chunkText を含めること
- 「narration から削除した事実が chunkText に残ってる」が最大の事故源 — 必ず連動修正

【★人物属性帰属チェック（致命的事故防止）】
複数人物が登場する案件では、各人物固有の属性
（生没年・親族・出身地・所属歴・著名な事件）を**他人物に流用していないか** 元データと厳密照合。
特に同じ国籍・近い世代の人物間（例: ブラジル代表内 / 同年代スター同士）は混同しやすい。
過去事故例:
  ✗ カフーの息子の死去エピソードを「ネイマールの history」として narration に記載
  ✓ 元データに該当の根拠がない人物属性は narration / chunks / dataSlots すべてから削除

【出力】JSONのみ（マークダウン不要）。**全 ${merged.length} カード必ず idx 1〜${merged.length} で揃える**:
{
  "issues": [
    { "idx": 1, "where": "narration|dataSlots|narrationChunks", "claim": "問題箇所の引用", "data_says": "元データの該当値（無ければ「無」）", "fix": "修正方針" }
  ],
  "fixed": [
    { "idx": 1, "narration": "...", "dataSlots": [...], "narrationChunks": [...](あれば修正版を返す。なければ省略可) },
    ... (全 ${merged.length} カード)
  ]
}`;

      const reviewRaw = await callAI({
        forceProvider: 'anthropic',
        model: 'claude-sonnet-4-6', max_tokens: 8000,
        messages: [{ role: 'user', content: reviewPrompt }],
      });
      const rm = reviewRaw && reviewRaw.match(/\{[\s\S]*\}/);
      if (rm) {
        const reviewed = JSON.parse(rm[0]);
        if (Array.isArray(reviewed.issues) && Array.isArray(reviewed.fixed)) {
          reviewIssues = reviewed.issues;
          // fixed を idx でインデックス化して merged に反映
          const fixedByIdx = {};
          reviewed.fixed.forEach(f => {
            const idx = Number.isFinite(f?.idx) ? Number(f.idx) : null;
            if (idx) fixedByIdx[idx] = f;
          });
          let appliedCount = 0;
          merged.forEach((m, i) => {
            const f = fixedByIdx[i + 1];
            if (!f) return;
            const narrationChanged = typeof f.narration === 'string' && f.narration.trim() && f.narration !== m.narration;
            // narration 上書き（matchcard を含む全カード）
            if (narrationChanged) {
              m.narration = f.narration;
              appliedCount++;
            }
            // dataSlots 上書き（matchcard は除外、comparison は実値再構築済みなので除外、history 対戦史型は H2H 固定済みなので除外）
            if (Array.isArray(f.dataSlots) && m.type !== 'matchcard' && m.type !== 'comparison' && !m._h2hFixed) {
              const before = JSON.stringify(m.dataSlots);
              const after  = JSON.stringify(f.dataSlots);
              if (before !== after) {
                m.dataSlots = f.dataSlots;
                appliedCount++;
              }
            }
            // catchphrases / tocItems 上書き
            if (Array.isArray(f.catchphrases)) {
              const before = JSON.stringify(m.catchphrases);
              const after  = JSON.stringify(f.catchphrases);
              if (before !== after) {
                m.catchphrases = f.catchphrases;
                appliedCount++;
              }
            }
            if (Array.isArray(f.tocItems)) {
              const before = JSON.stringify(m.tocItems);
              const after  = JSON.stringify(f.tocItems);
              if (before !== after) {
                m.tocItems = f.tocItems;
                appliedCount++;
              }
            }

            // 🆕 narrationChunks の再導出（items.chunkText から）
            //   item ベースで chunks を再構成 → narration 修正 と 整合
            const _deriveChunks = (items, key = 'chunkText') => {
              if (!Array.isArray(items) || !items.length) return null;
              const ch = items.map(it => String(it?.[key] || '').trim());
              return ch.every(c => c.length > 0) ? ch : null;
            };
            let derivedChunks = null;
            if (m.type === 'history' || m.type === 'comparison' || m.type === 'profile' || m.type === 'stats') {
              derivedChunks = _deriveChunks(m.dataSlots);
            } else if (m.type === 'insight') {
              derivedChunks = _deriveChunks(m.catchphrases);
            } else if (m.type === 'toc') {
              derivedChunks = _deriveChunks(m.tocItems);
            }
            if (derivedChunks) {
              const before = JSON.stringify(m.narrationChunks);
              const after  = JSON.stringify(derivedChunks);
              if (before !== after) {
                m.narrationChunks = derivedChunks;
                appliedCount++;
              }
            } else if (narrationChanged && Array.isArray(m.narrationChunks) && m.narrationChunks.length) {
              // narration が変わったが chunkText 経路で再導出できない場合 → クリアして再分割に倒す
              console.warn(`[Step3 v3] #${i+1} narration 修正あり / chunkText 不揃い → narrationChunks クリア`);
              m.narrationChunks = null;
              appliedCount++;
            }
          });
          reviewUsed = appliedCount > 0;
          if (reviewIssues.length > 0) {
            console.log(`[Step3 v3] 自己監修で ${reviewIssues.length} 件の矛盾検出 → ${appliedCount} 箇所修正適用`);
            reviewIssues.slice(0, 10).forEach(iss =>
              console.log(`  - [#${iss.idx} ${iss.where}] "${(iss.claim || '').slice(0, 80)}" → ${(iss.fix || '').slice(0, 80)}`)
            );
          } else {
            console.log('[Step3 v3] 自己監修パス（矛盾なし）');
          }
        }
      }
    } catch (e) {
      console.warn('[Step3 v3] 自己監修例外（Pass1結果を使用）:', e.message);
    }

    // 永続化（内部フラグは出力前に掃除）
    merged.forEach(m => { delete m._h2hFixed; });
    fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules: merged, savedAt: new Date().toISOString() }, null, 2));

    console.log(`[Step3 v3] 生成完了: ${merged.length}カード / ${used}${reviewUsed ? ` / 監修${reviewIssues.length}件` : ''}`);
    updateJob({
      status: 'done', step: 'done', message: '生成完了',
      modules: merged, source: used, reviewed: reviewUsed, reviewIssues,
      finishedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[Step3 v3] _runScenarioJob エラー:', e.message);
    throw e;  // 外側 Promise.catch で error 状態に書き込む
  }
}

// ─── UI ─────────────────────────────────────────────────
function getUI() {
  return `
<style>
/* Step3 outline 行のレイアウト（PC + スマホ対応）*/
#s3OutlineList .s3-row {
  display: grid;
  grid-template-columns: 30px 200px 160px 180px 1fr 28px 28px 28px;
  gap: 6px;
  align-items: start;
  margin-bottom: 6px;
  padding: 8px;
  background: #0d1220;
  border-radius: 6px;
}
/* タブレット〜スマホ: 主タグ・タイプ・従タグを 1段目、脚本指示を 2段目（全幅）に */
@media (max-width: 900px) {
  #s3OutlineList .s3-row {
    grid-template-columns: 28px 1fr 1fr 28px 28px 28px;
    grid-template-rows: auto auto auto;
    row-gap: 4px;
  }
  #s3OutlineList .s3-row > span:first-child { grid-row: 1; grid-column: 1; }
  #s3OutlineList .s3-row .s3-main { grid-row: 1; grid-column: 2 / 4; }
  #s3OutlineList .s3-row .s3-type { grid-row: 2; grid-column: 2 / 3; }
  #s3OutlineList .s3-row .s3-secondary,
  #s3OutlineList .s3-row > span:nth-child(4) { grid-row: 2; grid-column: 3 / 4; }
  #s3OutlineList .s3-row .s3-script { grid-row: 3; grid-column: 1 / -1; min-height: 80px; }
  #s3OutlineList .s3-row > button { grid-row: 1; }
  #s3OutlineList .s3-row > button:nth-of-type(1) { grid-column: 4; }
  #s3OutlineList .s3-row > button:nth-of-type(2) { grid-column: 5; }
  #s3OutlineList .s3-row > button:nth-of-type(3) { grid-column: 6; }
}
</style>
<div id="step3" class="step-container" style="display:none">
<div style="padding:0 20px 20px;">

  <!-- TOP PANEL -->
  <div class="panel" style="margin-bottom:14px;">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span id="s3Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">案件を選択してください</span>
      <button class="btn btn-sm" id="s3BtnAddRow" style="background:#10b981;color:#fff;">＋ 行追加</button>
      <button class="btn btn-sm" id="s3BtnPropose" style="background:#a855f7;color:#fff;">✨ 構成おまかせ</button>
      <button class="btn btn-primary" id="s3BtnGenerate" style="font-size:13px;padding:8px 18px;">✨ 脚本生成（一括）</button>
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
  window.APP.s3 = { mainTags: [], modules: [] };

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
      // 空ならデフォルト4行 (opening / toc / 1空行 / ending)
      if (!window.APP.s3.modules.length) {
        window.APP.s3.modules = [
          { mainKey: 'opening', secondary: null, type: 'opening', scriptDir: '' },
          { mainKey: 'toc',     secondary: null, type: 'toc',     scriptDir: '本日の動画構成を3〜5項目で目次として提示' },
          { mainKey: '',        secondary: null, type: '',        scriptDir: '' },
          { mainKey: 'ending',  secondary: null, type: 'ending',  scriptDir: '' },
        ];
      } else {
        // ── 既存案件: opening 直後に toc が無ければ自動挿入 ──
        const mods = window.APP.s3.modules;
        const openingIdx = mods.findIndex(m => m.mainKey === 'opening');
        const hasToc = mods.some(m => m.mainKey === 'toc');
        if (openingIdx >= 0 && !hasToc) {
          mods.splice(openingIdx + 1, 0, {
            mainKey: 'toc', secondary: null,
            type: 'toc', scriptDir: '本日の動画構成を3〜5項目で目次として提示',
          });
          console.log('[Step3] 目次スライドを自動挿入 (opening 直後)');
        }
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
      const mainOpts   = _buildMainOptions(m.mainKey);
      const typeOpts   = _buildTypeOptions(m);
      const typeLocked = _isTypeLocked(m);
      const showSec    = _needsSecondary(m);
      const secCol     = showSec
        ? '<select class="inp s3-secondary" data-idx="' + idx + '" style="font-size:11px;padding:5px 6px;" onchange="s3OnSecondaryChange(' + idx + ')">' + _buildSecondaryOptions(m.mainKey, m.secondary || '') + '</select>'
        : '<span style="font-size:10px;color:#3a4560;align-self:center;text-align:center;">—</span>';
      return ''
        + '<div class="s3-row" data-idx="' + idx + '">'
        + '<span style="font-size:10px;color:#8a9aba;text-align:center;padding-top:8px;">#' + (idx+1) + '</span>'
        + '<select class="inp s3-main" data-idx="' + idx + '" style="font-size:11px;padding:5px 6px;" onchange="s3OnMainChange(' + idx + ')">' + mainOpts + '</select>'
        + '<select class="inp s3-type" data-idx="' + idx + '"' + (typeLocked ? ' disabled' : '')
        + ' style="font-size:11px;padding:5px 6px;' + (typeLocked ? 'color:#5a6a8a;background:#0a0d18;' : '') + '" onchange="s3OnTypeChange(' + idx + ')">' + typeOpts + '</select>'
        + secCol
        + '<textarea class="inp s3-script" data-idx="' + idx + '" placeholder="脚本指示（このスライドで何を伝えるか具体的に）"'
        + ' style="font-size:11px;padding:5px 8px;min-height:54px;resize:vertical;" oninput="s3OnScriptInput(' + idx + ')">' + _esc(m.scriptDir||'') + '</textarea>'
        + '<button class="btn btn-sm" onclick="s3MoveRow(' + idx + ',-1)" style="background:#475569;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">↑</button>'
        + '<button class="btn btn-sm" onclick="s3MoveRow(' + idx + ',1)"  style="background:#475569;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">↓</button>'
        + '<button class="btn btn-sm" onclick="s3RemoveRow(' + idx + ')"  style="background:#ef4444;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">×</button>'
        + '</div>';
    }).join('');
  }

  /* mainKey から type が一意に決まる場合は type select を disable */
  function _isTypeLocked(m) {
    if (!m?.mainKey) return false;
    const FIXED = { opening: 'opening', toc: 'toc', overview: 'insight', reaction: 'reaction', ending: 'ending' };
    if (FIXED[m.mainKey]) return true;
    if (typeof m.mainKey === 'string' && m.mainKey.startsWith('matchcard:')) return true;
    return false;
  }

  function _buildTypeOptions(m) {
    const TYPES = ['insight','stats','profile','comparison','history','reaction','matchcard'];
    const FIXED = { opening: 'opening', toc: 'toc', overview: 'insight', reaction: 'reaction', ending: 'ending' };
    let cur = m.type || '';
    if (FIXED[m.mainKey]) cur = FIXED[m.mainKey];
    if (typeof m.mainKey === 'string' && m.mainKey.startsWith('matchcard:')) cur = 'matchcard';
    // ロック時は1択のみ
    if (_isTypeLocked(m)) {
      return '<option value="' + _esc(cur) + '" selected>' + _esc(cur) + '</option>';
    }
    let opts = '<option value="">-- type 選択 --</option>';
    opts += TYPES.map(t => '<option value="' + t + '"' + (t === cur ? ' selected' : '') + '>' + t + '</option>').join('');
    return opts;
  }

  /* secondary 表示判定: comparison型 かつ entity 主タグ */
  function _needsSecondary(m) {
    return m && m.type === 'comparison' && typeof m.mainKey === 'string' && m.mainKey.startsWith('entity:');
  }

  function _buildSecondaryOptions(mainKey, currentLabel) {
    const tags = window.APP.s3.mainTags || [];
    const cands = tags.filter(function(t) { return t.kind === 'entity' && t.key !== mainKey; });
    const opts = ['<option value="">-- 比較対象 --</option>'];
    cands.forEach(function(t) {
      const v = t.key.slice(7);  // 'entity:' を剥がす
      opts.push('<option value="' + _esc(v) + '"' + (v === currentLabel ? ' selected' : '') + '>' + _esc(t.label) + '</option>');
    });
    return opts.join('');
  }

  function _buildMainOptions(currentKey) {
    const tags = window.APP.s3.mainTags || [];
    const opts = ['<option value="">-- 選択 --</option>'];
    tags.forEach(function(t) {
      opts.push('<option value="' + _esc(t.key) + '"' + (t.key === currentKey ? ' selected' : '') + '>' + _esc(t.label) + '</option>');
    });
    return opts.join('');
  }

  /* ── 行操作 ── */
  window.s3OnMainChange = function(idx) {
    _collectInputs();
    const m = window.APP.s3.modules[idx];
    const sel = document.querySelectorAll('.s3-main')[idx];
    m.mainKey   = sel.value;
    m.secondary = null;
    m.type      = '';
    // 固定タグ / matchcard なら type 直接決定（type select はロック表示）
    const FIXED = { opening: 'opening', toc: 'toc', overview: 'insight', reaction: 'reaction', ending: 'ending' };
    if (FIXED[m.mainKey]) m.type = FIXED[m.mainKey];
    else if (typeof m.mainKey === 'string' && m.mainKey.startsWith('matchcard:')) m.type = 'matchcard';
    _renderOutline();
  };
  window.s3OnTypeChange = function(idx) {
    _collectInputs();
    const m = window.APP.s3.modules[idx];
    const sel = document.querySelectorAll('.s3-type')[idx];
    m.type = sel.value || '';
    if (m.type !== 'comparison') m.secondary = null;
    _renderOutline();
  };
  window.s3OnSecondaryChange = function(idx) {
    _collectInputs();
    const m = window.APP.s3.modules[idx];
    const sel = document.querySelector('.s3-secondary[data-idx="' + idx + '"]');
    if (sel) m.secondary = sel.value || null;
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
    window.APP.s3.modules.push({ mainKey: '', secondary: null, type: '', scriptDir: '' });
    _renderOutline();
  });

  /* ── 構成おまかせ（Sonnet 既定 + v4flash 保険で 5〜10 スライド多角構成を提案）── */
  // 🆕 propose-modules ジョブ管理（タブ閉じても継続）
  function _proposeJobKey(postId) { return 's3_propose_' + postId; }
  function _saveProposeJob(postId, jobId) { try { localStorage.setItem(_proposeJobKey(postId), jobId); } catch (_) {} }
  function _clearProposeJob(postId) { try { localStorage.removeItem(_proposeJobKey(postId)); } catch (_) {} }
  function _readProposeJob(postId) { try { return localStorage.getItem(_proposeJobKey(postId)); } catch (_) { return null; } }

  async function _pollProposeJob(jobId, post, btn, origLabel) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 提案中...（タブ閉じてもOK）'; }
    let tries = 0;
    while (tries < 200) {
      tries++;
      await new Promise(r => setTimeout(r, 3000));
      try {
        const j = await fetchJson('/api/v3/propose-modules-status?jobId=' + encodeURIComponent(jobId));
        if (!j || j.status === 'error') {
          _clearProposeJob(post.id);
          _msg('❌ ' + (j?.error || 'ジョブ失敗'));
          break;
        }
        if (j.status === 'done') {
          _clearProposeJob(post.id);
          const r = j.result || {};
          if (!Array.isArray(r.modules) || !r.modules.length) {
            _msg('❌ 提案 API が空応答');
            break;
          }
          window.APP.s3.modules = r.modules.map(m => ({
            mainKey:   m.mainKey   || '',
            secondary: m.secondary || null,
            type:      m.type      || '',
            scriptDir: m.scriptDir || '',
          }));
          _renderOutline();
          _msg('✅ ' + r.modules.length + ' 枚構成を提案しました（' + r.elapsed + '秒）。各行を確認・編集してから「✨ 脚本生成」へ');
          break;
        }
        _msg('⏳ Sonnet が多角構成を提案中... (' + (tries * 3) + 's)');
      } catch (e) {
        if (String(e.message).includes('404')) {
          _clearProposeJob(post.id);
          _msg('❌ ジョブ消失');
          break;
        }
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = origLabel || '✨ 構成おまかせ'; }
  }

  document.getElementById('s3BtnPropose')?.addEventListener('click', async function() {
    const post = window.APP.selected;
    if (!post?.id) { alert('案件が選択されていません'); return; }
    const hasContent = (window.APP.s3.modules || []).some(m => m && m.mainKey && m.mainKey !== 'opening' && m.mainKey !== 'ending');
    if (hasContent) {
      if (!confirm('既存のアウトラインを AI 提案で上書きします。よろしいですか？')) return;
    }
    const btn = this;
    const orig = btn.textContent;
    _msg('🤖 ジョブ起動中...');
    try {
      const r = await fetchJson('/api/v3/propose-modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, count: 7, sprint: localStorage.getItem('v2_sprint_mode') === '1' }),
      });
      const jobId = r && r.jobId;
      if (!jobId) throw new Error('jobId 受信失敗');
      _saveProposeJob(post.id, jobId);
      await _pollProposeJob(jobId, post, btn, orig);
      return;
    } catch (e) {
      console.error('[Step3] propose 失敗:', e);
      _msg('❌ 提案失敗: ' + e.message);
      alert('構成提案に失敗しました: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  /* ── 脚本生成（非同期ジョブ + ポーリング）── */
  //   サーバー側で60〜120秒かかるためバックグラウンドジョブ化。
  //   jobId を localStorage に保存し、タブ切替・リロード後でも再開可能。
  function _jobKey(postId) { return 'scenarioJob:' + postId; }
  function _saveJob(postId, jobId) {
    try { localStorage.setItem(_jobKey(postId), jobId); } catch (_) {}
  }
  function _clearJob(postId) {
    try { localStorage.removeItem(_jobKey(postId)); } catch (_) {}
  }
  function _readJob(postId) {
    try { return localStorage.getItem(_jobKey(postId)); } catch (_) { return null; }
  }

  // ジョブ完了待ち（最大15分・3秒間隔ポーリング）
  async function _pollScenarioJob(jobId, post, btn, origLabel) {
    const maxTries = 300;  // 3秒×300=15分
    for (let i = 0; i < maxTries; i++) {
      await new Promise(r => setTimeout(r, 3000));
      let j;
      try {
        j = await fetchJson('/api/v3/scenario-status?jobId=' + encodeURIComponent(jobId));
      } catch (e) {
        // ネットワーク一時エラーは無視して継続
        _msg('⏳ 接続再試行中... (' + (i+1) + ')');
        continue;
      }
      if (j.status === 'done') {
        window.APP.s3.modules = j.modules || window.APP.s3.modules;
        window.APP.modules = window.APP.s3.modules;
        try {
          await fetchJson('/api/save-modules', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId: post.id, modules: window.APP.s3.modules }),
          });
        } catch (_) {}
        _renderOutline();
        _renderModulesPreview();
        let suffix = '';
        if (j.reviewed && Array.isArray(j.reviewIssues) && j.reviewIssues.length) {
          suffix = ' / 🔍 自己監修で ' + j.reviewIssues.length + ' 件修正';
        } else if (Array.isArray(j.reviewIssues) && j.reviewIssues.length === 0) {
          suffix = ' / 🔍 監修OK';
        }
        _msg('✅ ' + window.APP.s3.modules.length + 'カード生成完了' + suffix);
        _clearJob(post.id);
        btn.disabled = false; btn.style.opacity = '1'; btn.textContent = origLabel;
        return;
      }
      if (j.status === 'error') {
        _msg('❌ 生成失敗: ' + (j.error || '不明'));
        _clearJob(post.id);
        btn.disabled = false; btn.style.opacity = '1'; btn.textContent = origLabel;
        return;
      }
      // running / queued
      const stepLabel = ({
        init:  '初期化中',
        pass1: 'AIが脚本を執筆中（30〜60秒）',
        pass2: 'AIが自己監修中（30〜60秒）',
      })[j.step] || (j.message || '処理中');
      _msg('⏳ ' + stepLabel + '... 経過 ' + ((i+1)*3) + '秒');
    }
    _msg('❌ タイムアウト（15分超過）。サーバーログ確認してね');
    _clearJob(post.id);
    btn.disabled = false; btn.style.opacity = '1'; btn.textContent = origLabel;
  }

  document.getElementById('s3BtnGenerate').addEventListener('click', async function() {
    const btn = this;
    if (btn.disabled) return;  // 連打防止
    _collectInputs();
    const post = window.APP.selected;
    if (!post?.id) return;
    const mods = window.APP.s3.modules.filter(m => m.mainKey);
    if (!mods.length) { _msg('⚠ 行が空です'); return; }
    btn.disabled = true;
    btn.style.opacity = '0.5';
    const origLabel = btn.textContent;
    btn.textContent = '⏳ 生成中...';
    _msg('⏳ ジョブ起動中...');
    let jobId;
    try {
      const j = await fetchJson('/api/v3/generate-scenario', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: mods, post }),
      });
      jobId = j.jobId;
      if (!jobId) throw new Error('jobId 受信失敗');
      _saveJob(post.id, jobId);
      _msg('⏳ ジョブ起動: ' + jobId.slice(0, 18) + '...');
    } catch (e) {
      _msg('❌ ジョブ起動失敗: ' + e.message);
      btn.disabled = false; btn.style.opacity = '1'; btn.textContent = origLabel;
      return;
    }
    // バックグラウンドポーリング（タブ閉じてもlocalStorageに jobId 残る）
    _pollScenarioJob(jobId, post, btn, origLabel);
  });

  // ページ読込時、進行中ジョブがあれば自動再開
  window.addEventListener('load', () => {
    setTimeout(() => {
      const post = window.APP.selected;
      if (!post?.id) return;
      const jobId = _readJob(post.id);
      if (!jobId) return;
      const btn = document.getElementById('s3BtnGenerate');
      if (!btn) return;
      btn.disabled = true; btn.style.opacity = '0.5';
      const origLabel = btn.textContent;
      btn.textContent = '⏳ 生成中...';
      _msg('🔄 進行中ジョブを再開: ' + jobId.slice(0, 18) + '...');
      _pollScenarioJob(jobId, post, btn, origLabel);
    }, 500);
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
