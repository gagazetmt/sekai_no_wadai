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
const { getRecipe, findEntity, buildDataSlotsFromRecipe } = require('../scripts/v2_story/recipes');

// comparison カードの recipe メタ情報を取得（player/team/manager 自動判別）
function getComparisonMeta(mod, siData) {
  if (mod.type !== 'comparison') return null;
  if (!mod.mainKey?.startsWith('entity:') || !mod.secondary) return null;

  const primary   = mod.mainKey.slice(7);
  const secondary = mod.secondary;
  const items = siData?.boxes?.entity?.items || [];
  const findRole = (label) => items.find(it => it.label === label)?.role || null;
  const r1 = findRole(primary);
  const r2 = findRole(secondary);

  let subject, aspect;
  if (r1 === 'player'  && r2 === 'player')  { subject = 'player';  aspect = 'compareCareerStats'; }
  else if (r1 === 'team'    && r2 === 'team')    { subject = 'team';    aspect = 'compareSeasonStats'; }
  else if (r1 === 'manager' && r2 === 'manager') { subject = 'manager'; aspect = 'compareCareer'; }
  else return null;

  const recipe = getRecipe(subject, aspect);
  if (!recipe?.availableSlots?.length) return null;

  const primaryData   = findEntity(siData, subject, primary);
  const secondaryData = findEntity(siData, subject, secondary);
  if (!primaryData || !secondaryData) return null;

  return {
    subject, aspect, recipe,
    primary, secondary, primaryData, secondaryData,
    availableSlots: recipe.availableSlots.map(s => ({
      key: s.key, label: s.label,
      category: s.category || '-',
      priority: s.priority || 0,
    })),
    defaultSelection: recipe.defaultSelection || [],
  };
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

    // ── 各カードの type をサーバー側で先に解決（クライアント送信値は信用しない）──
    mods.forEach(m => {
      m.type = resolveType(m.mainKey, m.subSource, m.subValue, si) || m.type || 'insight';
    });

    // ── outline ブロック化（idx は 1 始まり = 1..mods.length）──
    const outlineLines = mods.map((m, i) => {
      let tags = `main="${m.mainKey}"` + (m.subSource ? ` sub="${m.subSource}:${m.subValue}"` : '');
      if (m.secondary) tags += ` secondary="${m.secondary}"`;
      return `idx=${i+1}: type=${m.type} ${tags}\n   scriptDir: ${m.scriptDir || '(指示なし)'}`;
    }).join('\n');

    // ── comparison カードのメタを集める（AIに customSlotKeys を選ばせる） ──
    const comparisonMetaByIdx = {};
    mods.forEach((m, i) => {
      const meta = getComparisonMeta(m, si);
      if (meta) comparisonMetaByIdx[i] = meta;
    });
    const compIdxs = Object.keys(comparisonMetaByIdx);
    const comparisonSection = compIdxs.length ? (() => {
      const lines = compIdxs.map(idx => {
        const meta = comparisonMetaByIdx[idx];
        const slots = meta.availableSlots
          .slice()
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .map(s => `    - "${s.key}" (priority:${s.priority}, ${s.category}): ${s.label}`)
          .join('\n');
        return `カード#${parseInt(idx)+1} (${meta.subject}: ${meta.primary} vs ${meta.secondary} / aspect=${meta.aspect}):\n${slots}`;
      }).join('\n\n');
      return `

━━━ 【comparison カード メトリック選定】━━━
以下の comparison カードでは、dataSlots ではなく **customSlotKeys**（5キーの配列）を返してください。
値はサーバー側で実データから自動充填されるので、AI は keys 選定のみ。

${lines}

【選定ルール（厳守）】
- customSlotKeys は **5つ**（厳密に5）
- priority 9以上から **最低3つ**含める
- 残り2つは文脈（scriptDir, narration の意図）に応じて選ぶ — priority 低くてもOK
- カテゴリは**複数にまたがる**よう分散（例: 攻撃3 + 守備1 + 評価1）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    })() : '';

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
  - "idx": **outline の番号（1始まり）と完全一致**。1, 2, 3, ..., ${mods.length} の順で必ず出力
  - "title": 短い見出し（10〜25文字）
  - "narration": 視聴者に語りかける口調の本文 — **40秒前後のボリューム = 250〜320文字目安**
    ※ 例外: type=opening は narration="" 空文字（タイトル表示のみで読み上げなし）
    ※ データやニュース文脈を活用し、試合の流れや背景を「さらっと説明」する密度で書く

- type 別の追加フィールド + ナレーション方針：
  - opening: 追加なし。**"narration": "" を必ず空文字で返す**
  - ending: 視聴者への投げかけや登録誘導を含めて250〜320文字
  - insight: "catchphrases": [短句×3〜5、各15文字以内、事実+数字を含む]。narration は深掘り解説
  - reaction: "comments": [{"text":"...","score":0}×7] — 上記【元コメント抜粋】から面白い7件を選び日本語意訳。narration は反応の前置き
  - stats / history: "dataSlots": [{"label":"...","value":"..."}×4〜8]。narration はデータの背景や流れを語る
  - profile: "dataSlots": **必ず4個** [{"label":"...","value":"..."}]
    例: [{"label":"大会","value":"ラ・リーガ第32節"},{"label":"会場","value":"ベニート・ビジャマリン"},{"label":"日付","value":"2026-04-24"},{"label":"スコア","value":"1-1"}]
    候補: 大会 / 会場 / 日付 / スコア / 主役選手 / 得点者 / 観客数 / レフェリー / 結果
    ※ homeTeam / awayTeam は別途自動注入されるので dataSlots に含めない
    ※ narration はタイトル内容を事実ベースで概要説明（試合がいつ・どこで・どんな大会だったか等）
  - comparison: 通常は "dataSlots": [{"label":"...","leftValue":"...","rightValue":"..."}×4〜8]。
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
- subValue が "history" → dataSlots は {label:年, value:出来事} の時系列
- subValue が "compare" → dataSlots は左右比較形式 [{label,leftValue,rightValue}]
  - mainKey="entity:<X>" + secondary="<Y>" の場合：**leftValue=Xの値 / rightValue=Yの値**
  - 両者の wiki + sofa を [entity 一覧] から参照し、同じ指標を左右で揃えること
- subValue が "season" / "match" / "profile" → dataSlots は {label, value} の現在系
- subValue が "titles" → dataSlots は獲得トロフィー一覧

【ハルシネーション禁止 — 厳守】
- 値・固有名は必ず上記取得済みデータに明記されているもののみ
- データに無いものは出力しない（推測・記憶からの補完絶対NG）
- あなたの学習データ（2024年〜）は古い。現在の監督・所属はデータからのみ参照
- 前後カードの文脈が自然につながるように構成する

JSON のみ返す（マークダウン不要）。**idx は outline の番号 1〜${mods.length} と完全一致**で全カード網羅：
{"modules":[
  {"idx":1,"title":"...","narration":"...",...type別フィールド},
  {"idx":2,"title":"...","narration":"...",...type別フィールド},
  ... (合計 ${mods.length}枚 / idx は 1 から ${mods.length} まで欠番なし)
]}${comparisonSection}`;

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
      const resolvedType = resolveType(src.mainKey, src.subSource, src.subValue, si);
      const finalType = resolvedType || src.type || 'insight';
      return {
        ...src,
        type:         finalType,
        title:        ai.title        || src.title        || `スライド${i+1}`,
        narration:    ai.narration    || '',
        dataSlots:    finalType === 'matchcard' ? [] : (ai.dataSlots || []),
        catchphrases: ai.catchphrases || [],
        comments:     ai.comments     || [],
      };
    });

    // ── 後処理: profile / matchcard / comparison(対match) は match siData から
    //          homeTeam / awayTeam / matchData を自動注入 ──
    merged.forEach(m => {
      if (!m.mainKey) return;
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

    // ── 後処理: comparison カードの customSlotKeys → dataSlots を実値で再構築 ──
    merged.forEach((m, i) => {
      const meta = comparisonMetaByIdx[i];
      if (!meta) return;
      const aiOut = aiByIdx[i + 1] || {};
      let keys = Array.isArray(aiOut.customSlotKeys) ? aiOut.customSlotKeys.filter(Boolean) : [];
      // AI が無効キーや件数違いを返したら defaultSelection で補完
      const validKeys = new Set(meta.recipe.availableSlots.map(s => s.key));
      keys = keys.filter(k => validKeys.has(k));
      if (keys.length < 5) {
        const fillers = meta.defaultSelection.filter(k => !keys.includes(k));
        keys = [...keys, ...fillers].slice(0, 5);
      } else if (keys.length > 5) {
        keys = keys.slice(0, 5);
      }
      m.dataSlots = buildDataSlotsFromRecipe(
        meta.recipe, meta.primaryData, meta.secondaryData, keys, {}
      );
      m.binding = {
        subject:        meta.subject,
        aspect:         meta.aspect,
        primary:        meta.primary,
        secondary:      meta.secondary,
        customSlotKeys: keys,
      };
    });

    // ── Pass 2: DeepSeek 自己監修（全カード一括）──
    //   元データと生成結果（narration / dataSlots）を突き合わせ、矛盾を検出して修正版を返させる。
    //   matchcard は dataSlots 不要のため narration のみチェック対象。
    //   失敗時は Pass1 結果をそのまま使う（フェイルセーフ）。
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

【修正方針】
- narration の修正は **最小限・ピンポイント**で。文体・前後カードの繋ぎは維持
- dataSlots の修正は数字や固有名の誤りのみ
- 元データに該当が無い数字は「データ未取得」と記すか narration から削除
- 「矛盾なし」のカードは fixed に元の値をそのまま入れる
- matchcard は dataSlots 空のままで OK（変更しない）
- comparison カードの dataSlots はサーバーが実値再構築するので narration のみ修正

【出力】JSONのみ（マークダウン不要）。**全 ${merged.length} カード必ず idx 1〜${merged.length} で揃える**:
{
  "issues": [
    { "idx": 1, "where": "narration|dataSlots", "claim": "問題箇所の引用", "data_says": "元データの該当値（無ければ「無」）", "fix": "修正方針" }
  ],
  "fixed": [
    { "idx": 1, "narration": "...", "dataSlots": [...] },
    ... (全 ${merged.length} カード)
  ]
}`;

      const reviewRaw = await callAI({
        forceProvider: 'deepseek',
        model: 'deepseek-chat', max_tokens: 8000,
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
            // narration 上書き（matchcard を含む全カード）
            if (typeof f.narration === 'string' && f.narration.trim() && f.narration !== m.narration) {
              m.narration = f.narration;
              appliedCount++;
            }
            // dataSlots 上書き（matchcard は除外、comparison は実値再構築済みなので除外）
            if (Array.isArray(f.dataSlots) && m.type !== 'matchcard' && m.type !== 'comparison') {
              const before = JSON.stringify(m.dataSlots);
              const after  = JSON.stringify(f.dataSlots);
              if (before !== after) {
                m.dataSlots = f.dataSlots;
                appliedCount++;
              }
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

    // 永続化
    fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules: merged, savedAt: new Date().toISOString() }, null, 2));

    console.log(`[Step3 v3] 生成完了: ${merged.length}カード / ${used}${reviewUsed ? ` / 監修${reviewIssues.length}件` : ''}`);
    res.json({ ok: true, modules: merged, source: used, reviewed: reviewUsed, reviewIssues });
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
          { mainKey: 'opening',  subSource: null, subValue: null, secondary: null, type: 'opening', scriptDir: '' },
          { mainKey: '',         subSource: null, subValue: null, secondary: null, type: '',        scriptDir: '' },
          { mainKey: 'ending',   subSource: null, subValue: null, secondary: null, type: 'ending',  scriptDir: '' },
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
      const mainOpts   = _buildMainOptions(m.mainKey);
      const subOpts    = _buildSubOptions(m.mainKey, m.subSource, m.subValue);
      const showSec    = _needsSecondary(m);
      const secCol     = showSec
        ? '<select class="inp s3-secondary" data-idx="' + idx + '" style="font-size:11px;padding:5px 6px;" onchange="s3OnSecondaryChange(' + idx + ')">' + _buildSecondaryOptions(m.mainKey, m.secondary || '') + '</select>'
        : '<span style="font-size:10px;color:#3a4560;align-self:center;text-align:center;">—</span>';
      return ''
        + '<div class="s3-row" data-idx="' + idx + '" style="display:grid;grid-template-columns:30px 200px 200px 180px 1fr 28px 28px 28px;gap:6px;align-items:start;margin-bottom:6px;padding:8px;background:#0d1220;border-radius:6px;">'
        + '<span style="font-size:10px;color:#8a9aba;text-align:center;padding-top:8px;">#' + (idx+1) + '</span>'
        + '<select class="inp s3-main" data-idx="' + idx + '" style="font-size:11px;padding:5px 6px;" onchange="s3OnMainChange(' + idx + ')">' + mainOpts + '</select>'
        + '<select class="inp s3-sub"  data-idx="' + idx + '" style="font-size:11px;padding:5px 6px;" onchange="s3OnSubChange(' + idx + ')">' + subOpts + '</select>'
        + secCol
        + '<textarea class="inp s3-script" data-idx="' + idx + '" placeholder="脚本指示（このスライドで何を伝えるか具体的に）"'
        + ' style="font-size:11px;padding:5px 8px;min-height:54px;resize:vertical;" oninput="s3OnScriptInput(' + idx + ')">' + _esc(m.scriptDir||'') + '</textarea>'
        + '<button class="btn btn-sm" onclick="s3MoveRow(' + idx + ',-1)" style="background:#475569;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">↑</button>'
        + '<button class="btn btn-sm" onclick="s3MoveRow(' + idx + ',1)"  style="background:#475569;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">↓</button>'
        + '<button class="btn btn-sm" onclick="s3RemoveRow(' + idx + ')"  style="background:#ef4444;color:#fff;padding:4px 6px;font-size:11px;height:fit-content;">×</button>'
        + '</div>';
    }).join('');
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
    m.mainKey   = sel.value;
    m.subSource = null;
    m.subValue  = null;
    m.secondary = null;
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
      m.type      = '';
    }
    // comparison以外になったらsecondaryクリア
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
    window.APP.s3.modules.push({ mainKey: '', subSource: null, subValue: null, secondary: null, type: '', scriptDir: '' });
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
      let suffix = '';
      if (j.reviewed && Array.isArray(j.reviewIssues) && j.reviewIssues.length) {
        suffix = ' / 🔍 自己監修で ' + j.reviewIssues.length + ' 件修正';
      } else if (Array.isArray(j.reviewIssues) && j.reviewIssues.length === 0) {
        suffix = ' / 🔍 監修OK';
      }
      _msg('✅ ' + window.APP.s3.modules.length + 'カード生成完了' + suffix);
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
