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
const { RECIPES, getRecipe }   = require('../scripts/v2_story/recipes');
const { buildModuleFromBinding } = require('../scripts/v2_story/builder');

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
function outlinePath(postId) { return path.join(DATA_DIR, (postId||'unknown').replace(/[\/\?%*:|"<>\.]/g,'_') + '_outline.json'); }

// ─── SI データサマリー（AI プロンプト用に圧縮）─────────────
// 取得済みSIデータから、AIが読みやすい形の「ラベル → 主要フィールド」マップを作る
function buildSiSummary(siData) {
  const summary = {};
  if (!siData?.boxes) return summary;

  Object.entries(siData.boxes).forEach(([boxType, box]) => {
    (box.fetched || []).forEach(f => {
      const d = f.data;
      if (!d || d.ok === false) return;
      const label = f.label;

      if (boxType === 'sofascore_player') {
        summary[label] = {
          type: 'player',
          position:     d.position,
          team:         d.team,
          age:          d.age,
          nationality:  d.nationality,
          height:       d.height,
          preferredFoot:d.preferredFoot,
          marketValue:  d.marketValue,
          league:       d.leagueName,
          goals:        d.seasonStats?.goals,
          assists:      d.seasonStats?.assists,
          appearances:  d.seasonStats?.appearances,
          rating:       d.seasonStats?.rating,
          minutes:      d.seasonStats?.minutesPlayed,
          xG:           d.seasonStats?.expectedGoals,
          keyPasses:    d.seasonStats?.keyPasses,
          lastMatchRating: d.lastMatchStats?.rating,
          last5Results: (d.last5Matches || []).slice(0, 5).map(m => (m.rating || '?') + ' vs ' + m.opponent),
        };
      } else if (boxType === 'sofascore_team') {
        summary[label] = {
          type:     'team',
          league:   d.leagueName,
          country:  d.country,
          founded:  d.founded,
          manager:  d.managerName,
          position: d.standing?.position,
          played:   d.standing?.played,
          wins:     d.standing?.wins,
          draws:    d.standing?.draws,
          losses:   d.standing?.losses,
          gf:       d.standing?.goalsFor,
          ga:       d.standing?.goalsAgainst,
          points:   d.standing?.points,
          marketValue: d.marketValue,
          last5:    (d.last5 || []).map(m => m.result + ':' + m.opponent).join(','),
        };
      } else if (boxType === 'sofascore_manager') {
        summary[label] = {
          type:        'manager',
          nationality: d.nationality,
          age:         d.age,
          formation:   d.preferredFormation,
          currentTeam: d.currentTeam,
          since:       d.currentTeamSince,
          overallWinRate: d.overallPerformance?.winRate,
          totalMatches:   d.overallPerformance?.total,
          currentTeamW:   d.currentTeamStats?.wins,
          currentTeamD:   d.currentTeamStats?.draws,
          currentTeamL:   d.currentTeamStats?.losses,
        };
      } else if (boxType === 'sofascore_match') {
        summary[label] = {
          type:       'match',
          scoreline:  d.scoreline,
          date:       d.matchDate,
          tournament: d.tournament,
          venue:      d.venue,
          goals:      (d.goals || []).slice(0, 5).map(g => g.timeStr + ' ' + g.player).join('; '),
          topPlayers: (d.topPlayers || []).slice(0, 3).map(p => p.name + ':' + p.rating).join(','),
          h2h:        d.h2hSummary,
        };
      } else if (boxType === 'wikipedia') {
        summary[label] = {
          type:   'wiki',
          title:  d.title,
          extract: (d.extract || '').slice(0, 250),
        };
      } else if (boxType === 'news') {
        const top = (d.organic || []).slice(0, 2);
        summary[label] = {
          type: 'news',
          headlines: top.map(r => r.title).join(' | '),
        };
      }
    });
  });
  return summary;
}

// レシピをプロンプト用に短く整形（A判定優先。各セルの利用可能スロットkey一覧）
function formatRecipesForPrompt() {
  const lines = [];
  const groups = { A: [], B: [] };  // C は今回プロンプトに含めない（情報量過多回避）
  Object.entries(RECIPES).forEach(([key, r]) => {
    if (groups[r.priority]) groups[r.priority].push([key, r]);
  });
  function buildLine(key, r) {
    let line = `- ${key}（${r.label}）`;
    if (r.populates === 'dataSlots' && r.availableSlots?.length) {
      const keys = r.availableSlots.map(s => s.key).join('/');
      line += ` slots:[${keys}]`;
      if (r.defaultSelection?.length) {
        line += ` default:[${r.defaultSelection.join(',')}]`;
      }
    }
    if (r.populates === 'matchData') line += ` ※customSlotKeys不要（自動）`;
    if (r.historyShape)              line += ` ※customSlotKeys不要（Wikiから自動）`;
    if (r.populates === 'comments')  line += ` ※commentsをAIが埋める`;
    if (r.populates === 'catchphrases') line += ` ※catchphrasesをAIが埋める`;
    if (r.requiresSecondary)         line += ` ※secondary必須`;
    return line;
  }
  ['A', 'B'].forEach(p => {
    if (groups[p].length) {
      lines.push(`【優先度${p}】`);
      groups[p].forEach(([key, r]) => lines.push(buildLine(key, r)));
    }
  });
  return lines.join('\n');
}

// 投稿コメントから reaction 用候補を抽出（英語→Claude翻訳は重いので素のまま7件）
function pickRawComments(post, n = 10) {
  const comments = (post.raw?.comments || [])
    .filter(c => c && (c.body || c.bodyJa))
    .slice(0, n * 2) // 余裕をもって
    .map(c => ({
      text:   c.bodyJa || c.body || '',
      score:  c.score || 0,
    }))
    .filter(c => c.text.length >= 8 && c.text.length <= 280) // 短すぎ/長すぎ除外
    .slice(0, n);
  return comments;
}

// ─── API ─────────────────────────────────────────────────

// 全体構成（outline）取得 — 既存ファイルがあれば返す
router.get('/propose-outline', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.json({ outline: null });
  const cached = safeJson(outlinePath(postId), null);
  res.json({ outline: cached?.outline || null });
});

// 全体構成（outline）保存 — ユーザー編集後の永続化
router.post('/propose-outline/save', (req, res) => {
  const { postId, outline } = req.body;
  if (!postId || !Array.isArray(outline)) {
    return res.status(400).json({ error: 'postId + outline[] required' });
  }
  try {
    fs.writeFileSync(outlinePath(postId), JSON.stringify({ postId, outline, savedAt: new Date().toISOString() }, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 全体構成（outline）AI提案（Claude Haiku 軽量）
router.post('/propose-outline', async (req, res) => {
  const { post, postId, siDataIn, force } = req.body;
  if (!post) return res.status(400).json({ error: 'post required' });

  // forceでなければキャッシュを返す
  if (!force) {
    const cached = safeJson(outlinePath(postId), null);
    if (cached?.outline?.length) {
      console.log('[Step3] outline キャッシュヒット:', postId);
      return res.json({ outline: cached.outline, cached: true });
    }
  }
  console.log('[Step3] outline 提案:', post.title || post.titleOrig);

  let siData = siDataIn || {};
  if (postId && !Object.keys(siData).length) siData = safeJson(siPath(postId), {});

  const commentsRaw = (post.raw?.comments || [])
    .map(c => c.bodyJa || c.body || '').filter(Boolean).slice(0, 6).join(' / ');
  const siSummary     = buildSiSummary(siData);
  const siLabels      = Object.keys(siSummary);
  const siSummaryText = siLabels.length
    ? JSON.stringify(siSummary, null, 0).slice(0, 2500)
    : '(なし)';

  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  const prompt = `あなたはサッカーYouTube動画の構成作家です。
以下の案件と取得済み素材から、動画スライド構成（outline）を**8枚**提案してください。
**この段階ではスライドの「型」は決めません。話の流れ・各スライドが伝えたい内容だけ。**

【今日の日付】${todayJst}（JST）
【案件】${post.title || post.titleOrig}
【元コメント抜粋】${commentsRaw || '(なし)'}

【取得済みSI実データ（${todayJst}時点の最新値）】
${siSummaryText}

【取得済みSIラベル一覧】${siLabels.length ? siLabels.join(' / ') : '(なし)'}

【ハルシネーション防止 — 厳守】
- **あなたの学習データは古い**（2024年〜2025年初頭まで）。サッカー界は監督交代・移籍・成績変動が激しい。
- **「現在の監督」「現所属」「今季成績」「直近の出来事」などは上記【取得済みSI実データ】からのみ参照**。
- データに無い人物・チーム・試合・移籍話は **絶対に言及しない**（例: 「アンチェロッティ監督が…」とか勝手に書かない。データに無ければそのトピック自体使わない）。
- 確証のない過去の出来事を含めるくらいなら、別の角度（コメントの反応・試合の数字・スタッツ）に振る。

【ルール】
1. 1枚目はオープニング（フック）、最後はエンディング（締めくくり）
2. 各スライドは title（短い見出し）と direction（30〜60文字。「何を伝えるか」を具体的に）の2要素
3. 流れに緩急をつける（事実紹介→深掘り→対比→反応→まとめ など）
4. SI実データから引ける情報を優先的に活用する案を含める

JSONのみ返す。例：
{"outline": [
  {"title":"オープニング","direction":"ベジェリンの劇的ゴールをキャッチーに伝えて視聴者を掴む"},
  {"title":"概要","direction":"試合のスコア、ベジェリンの活躍を簡潔に説明"},
  {"title":"基本情報","direction":"ベジェリンの選手プロフィール（ポジション・年齢・所属）"},
  {"title":"今期成績","direction":"ベジェリンの今シーズンのスタッツを数字で紹介"},
  {"title":"来歴","direction":"ベジェリンのキャリア年表 - 印象的な移籍やシーズン"},
  {"title":"対決","direction":"対戦相手の左SBとベジェリンを並べて比較"},
  {"title":"海外の反応","direction":"Redditでの海外ファンの興奮コメントを紹介"},
  {"title":"エンディング","direction":"今後の展望と視聴者への問いかけで締める"}
]}`;

  try {
    const raw    = await callAI({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
    const m      = raw.match(/\{[\s\S]*\}/);
    if (!m) { console.error('[Step3] outline JSONパース失敗:', raw.slice(0,200)); return res.status(500).json({ error: 'JSONパース失敗' }); }
    const parsed = JSON.parse(m[0]);
    const outline = (parsed.outline || []).filter(x => x?.title || x?.direction);
    if (!outline.length) return res.status(500).json({ error: 'outline 空' });

    // 永続化
    try {
      fs.writeFileSync(outlinePath(postId), JSON.stringify({ postId, outline, savedAt: new Date().toISOString() }, null, 2));
    } catch (_) {}

    res.json({ outline });
  } catch (e) {
    console.error('[Step3] outline エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// モジュール構成提案（Claude Sonnet）
router.post('/propose-modules', async (req, res) => {
  const { post, postId, siDataIn, outline } = req.body;
  if (!post) return res.status(400).json({ error: 'post required' });
  console.log('[Step3] モジュール提案:', post.title || post.titleOrig, outline?.length ? `(outline: ${outline.length}枚)` : '');

  let siData = siDataIn || {};
  if (postId && !Object.keys(siData).length) siData = safeJson(siPath(postId), {});

  const commentsRaw = (post.raw?.comments || [])
    .map(c => c.bodyJa || c.body || '').filter(Boolean).slice(0, 10).join(' / ');

  // SI データサマリーをJSON化（AIが各ラベルのフィールドを引用できるように）
  const siSummary     = buildSiSummary(siData);
  const siSummaryText = Object.keys(siSummary).length
    ? JSON.stringify(siSummary, null, 0).slice(0, 3500)
    : '(なし)';

  // reaction 用の投稿コメント候補（AIに翻訳/選定させる素材）
  const rawComments = pickRawComments(post, 12);

  // 取得済みSIラベルだけを別枠で抜き出して提示（primary/secondary に使えるラベル一覧）
  const siLabels = Object.keys(siSummary);

  // outline があれば AI に渡す（指定枚数・各スライドの方向性を強制）
  const outlineText = (Array.isArray(outline) && outline.length)
    ? outline.map((o, i) => `${i + 1}. ${o.title || ''} — ${o.direction || ''}`).join('\n')
    : '';

  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  const prompt = `あなたはプロのサッカーYouTubeチャンネルの脚本家です。
${outlineText
  ? `以下の【全体構成（outline）】の各スライドに、type/binding/データ充填を肉付けしてください。スライド枚数・順序・方向性は outline に厳密に従う。`
  : `以下の案件・コメント・SI情報をもとに、スライド構成を6〜9枚で提案してください。`}

【今日の日付】${todayJst}（JST）
【案件（日本語）】${post.title || post.titleOrig}
【案件（原文）】${post.titleOrig || ''}
【元コメント（翻訳前または日本語）】${commentsRaw || '(なし)'}
${outlineText ? `\n【全体構成（outline）】\n${outlineText}\n` : ''}
【取得済みSI実データ（${todayJst}時点の最新値）】
${siSummaryText}

【取得済みSIラベル一覧】（primary/secondary に使えるラベル）
${siLabels.length ? siLabels.join(' / ') : '(なし)'}

【ハルシネーション防止 — 厳守】
- **あなたの学習データは古い**（2024年〜2025年初頭まで）。現在の監督・所属・成績はあなたの記憶と異なる可能性が高い。
- **「現在の監督」「現所属クラブ」「今季成績」「直近の試合結果」などは上記【SI実データ】からのみ参照**。
- データに無い人物・チーム・試合・移籍話は **絶対に言及しない**。catchphrases / scriptDir / title すべてに適用。
- 例：データに「Real Madrid 監督=Xabi Alonso」とあれば Xabi Alonso と書く。データに無ければ「現監督」等の曖昧表現または別角度に振る。アンチェロッティ等の過去の名前を勝手に書かない。

【絶対ルール】
1. 1枚目は opening、最後は ending（固定）
2. 全モジュールに **type** と **scriptDir** と **binding** を必ず記入
3. type: opening / insight / stats / reaction / comparison / history / matchcard / matchcenter / ending
   - **multi-variety!! 同じ type を連続させない / opening と ending 以外は重複OKだがバリエーション豊富に**
4. binding は { subject, aspect, primary, secondary?, customSlotKeys? } の形式
   - subject: player / team / manager / match / transfer / tournament / generic
   - aspect: 下記【主題.観点 一覧】から選ぶ（subject ごとに使える観点が決まる）
   - primary: 取得済みSIラベルから選ぶ（generic は null 可）
   - secondary: 対比型（comparison系）でのみ使う2つ目のラベル
   - customSlotKeys: dataSlots 系で表示したいスロットkey配列（4個推奨）。省略時は default
5. opening/ending/insight/reaction は binding={"subject":"generic","aspect":"free","primary":null}
6. insight モジュールは catchphrases（3〜5個）必須
7. reaction モジュールは comments（7個、日本語訳済み）必須
8. dataSlots / matchData などのデータ値は **コード側で自動充填** されるので、AIは値を埋めなくてよい（binding と customSlotKeys だけ正しく指定）

【主題.観点 一覧】
${formatRecipesForPrompt()}

【catchphrases / comments の形式】（insight / reaction のみ手動）
- catchphrases: ["18歳でCL8得点","ドルトムントで80ゴール","3年連続得点王"]
- comments: [{"text":"...","score":0},...7件]
  → 上の【元コメント】から面白い7件を選定し日本語に意訳

JSONのみ返すこと（説明・マークダウン不要）。以下は例：
{"modules": [
  {"type":"opening","title":"衝撃！ハーランドの偉業","scriptDir":"...","reason":"視聴者を掴む",
   "binding":{"subject":"generic","aspect":"free","primary":null}},
  {"type":"insight","title":"HAALANDの偉業","scriptDir":"...","reason":"...",
   "binding":{"subject":"generic","aspect":"free","primary":null},
   "catchphrases":["18歳でCL8得点","ドルトムントで80ゴール","3年連続得点王"]},
  {"type":"stats","title":"今期スタッツ","scriptDir":"...","reason":"...",
   "binding":{"subject":"player","aspect":"careerStats","primary":"Erling Haaland",
              "customSlotKeys":["goals","assists","rating","xG"]}},
  {"type":"comparison","title":"マドリー vs バルサ H2H","scriptDir":"...","reason":"...",
   "binding":{"subject":"team","aspect":"h2h","primary":"Real Madrid",
              "secondary":"Barcelona","customSlotKeys":["wins","draws","losses","lastResult"]}},
  {"type":"matchcenter","title":"試合詳細","scriptDir":"...","reason":"...",
   "binding":{"subject":"match","aspect":"matchStats","primary":"Real Madrid vs Barcelona"}},
  {"type":"reaction","title":"海外の声","scriptDir":"...","reason":"...",
   "binding":{"subject":"generic","aspect":"free","primary":null},
   "comments":[{"text":"...","score":0}]},
  {"type":"ending","title":"まとめ","scriptDir":"...","reason":"...",
   "binding":{"subject":"generic","aspect":"free","primary":null}}
]}`;

  try {
    const raw    = await callAI({ model: 'claude-sonnet-4-6', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] });
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

    // type → デフォルトbinding 推測（後方互換：旧AIが type のみで返してきた場合）
    function inferBindingFromType(mod) {
      const t = mod.type;
      if (['opening','ending','insight','reaction'].includes(t)) {
        return { subject: 'generic', aspect: 'free', primary: null };
      }
      // siBinding ベースの旧形式から推測
      const single = mod.siBinding;
      const left   = mod.siBindingLeft;
      const right  = mod.siBindingRight;
      const aspectByType = {
        profile:    'profile',
        stats:      'careerStats',
        history:    'history',
        comparison: 'careerStats',
        matchcard:  'matchStats',
        matchcenter:'matchStats',
      };
      const subjectGuess = (lbl) => {
        if (!lbl) return 'generic';
        for (const subj of ['player', 'team', 'manager', 'match']) {
          const box = ({ player:'sofascore_player', team:'sofascore_team', manager:'sofascore_manager', match:'sofascore_match' })[subj];
          if (siData?.boxes?.[box]?.fetched?.some(f => f.label === lbl)) return subj;
        }
        return 'player';
      };
      return {
        subject:   subjectGuess(single || left),
        aspect:    aspectByType[t] || 'free',
        primary:   single || left || null,
        secondary: right || null,
      };
    }

    // 各モジュールに binding がある場合はビルダーで自動充填
    // binding 無しはレガシー（AIが直接 dataSlots を記入したケース）として尊重
    let buildOk = 0, buildSkip = 0, buildFail = 0;
    const VALID_TYPES = new Set(['opening','insight','stats','reaction','profile','comparison','history','matchcard','matchcenter','ending']);
    for (let mi = 0; mi < mods.length; mi++) {
      const mod = mods[mi];

      // scriptDir が無ければ補完
      if (!mod.scriptDir || !mod.scriptDir.trim()) {
        mod.scriptDir = defaultScriptDir[mod.type] || '';
      }

      // binding 無しなら type から推測（できる範囲で）
      if (!mod.binding || !mod.binding.subject) {
        mod.binding = inferBindingFromType(mod);
      }

      // type が無効/未定義の場合の fallback
      if (!mod.type || !VALID_TYPES.has(mod.type)) {
        // generic.free 系は位置で推測
        if (mod.binding?.subject === 'generic') {
          if (mi === 0) mod.type = 'opening';
          else if (mi === mods.length - 1) mod.type = 'ending';
          else if (Array.isArray(mod.comments) && mod.comments.length) mod.type = 'reaction';
          else mod.type = 'insight';
        }
        // binding 系は recipe.template から後で確定（builderで上書きされる）
      }

      // generic.free（opening/ending/insight/reaction）はビルダー実行不要
      if (mod.binding.subject === 'generic' && mod.binding.aspect === 'free') {
        buildSkip++;
        continue;
      }

      // ビルダー実行（dataSlots / matchData 自動充填）
      try {
        const r = await buildModuleFromBinding(mod.binding, { siData });
        if (r.ok) {
          // 既存フィールドを保持しつつ、ビルダー出力で上書き
          // type/dataSlots/matchData/siBinding* はビルダー側を優先
          mod.type      = r.module.type;
          if (r.module.dataSlots)    mod.dataSlots    = r.module.dataSlots;
          if (r.module.matchData)    mod.matchData    = r.module.matchData;
          if (r.module.catchphrases) mod.catchphrases = mod.catchphrases?.length ? mod.catchphrases : r.module.catchphrases;
          if (r.module.siBinding)      mod.siBinding      = r.module.siBinding;
          if (r.module.siBindingLeft)  mod.siBindingLeft  = r.module.siBindingLeft;
          if (r.module.siBindingRight) mod.siBindingRight = r.module.siBindingRight;
          if (r.module.homeTeam)  mod.homeTeam  = r.module.homeTeam;
          if (r.module.awayTeam)  mod.awayTeam  = r.module.awayTeam;
          if (r.module.homeScore !== undefined) mod.homeScore = r.module.homeScore;
          if (r.module.awayScore !== undefined) mod.awayScore = r.module.awayScore;
          if (r.module.matchDate) mod.matchDate = r.module.matchDate;
          buildOk++;
        } else {
          console.warn(`[Step3] build失敗 "${mod.title}":`, r.error);
          buildFail++;
        }
      } catch (e) {
        console.warn(`[Step3] build例外 "${mod.title}":`, e.message);
        buildFail++;
      }
    }
    console.log(`[Step3] ビルダー実行: 成功${buildOk} / スキップ${buildSkip} / 失敗${buildFail}`);

    // 各モジュールの fallback：必須フィールドが空ならミニマム補完
    mods.forEach(mod => {
      if (mod.type === 'insight' && !mod.catchphrases?.length) {
        mod.catchphrases = [(mod.title || 'キャッチコピー1'), 'キャッチコピー2', 'キャッチコピー3'];
      }
      if (mod.type === 'reaction' && !mod.comments?.length) {
        mod.comments = rawComments.slice(0, 7);
      }
      // dataSlots がまだ無い stats/profile/matchcard は最小4枠で埋める
      if (['stats','profile','matchcard'].includes(mod.type) && (!mod.dataSlots || mod.dataSlots.length < 4)) {
        const existing = Array.isArray(mod.dataSlots) ? mod.dataSlots : [];
        while (existing.length < 4) existing.push({ label: 'ITEM' + (existing.length + 1), value: '-' });
        mod.dataSlots = existing.slice(0, 4);
      }
      if (mod.type === 'comparison' && (!mod.dataSlots || mod.dataSlots.length < 4)) {
        const existing = Array.isArray(mod.dataSlots) ? mod.dataSlots : [];
        while (existing.length < 4) existing.push({ label: 'ITEM' + (existing.length + 1), leftValue: '-', rightValue: '-' });
        mod.dataSlots = existing.slice(0, 4);
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
        binding:   { subject: 'generic', aspect: 'free', primary: null },
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
        binding:   { subject: 'generic', aspect: 'free', primary: null },
        siBinding: null,
      });
    }

    parsed.modules = mods;
    console.log('[Step3] 提案成功:', mods.length, '件');
    res.json(parsed);
  } catch (e) {
    console.error('[Step3] エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// モジュール1件のデータバインドのみ再生成（dataSlots / catchphrases / comments）
router.post('/populate-module', async (req, res) => {
  const { post, postId, siDataIn, module: mod } = req.body;
  if (!post || !mod) return res.status(400).json({ error: 'post + module required' });

  let siData = siDataIn || {};
  if (postId && !Object.keys(siData).length) siData = safeJson(siPath(postId), {});
  const siSummary = buildSiSummary(siData);
  const siSummaryText = Object.keys(siSummary).length
    ? JSON.stringify(siSummary, null, 0).slice(0, 3000)
    : '(なし)';

  const type = mod.type;
  const rawComments = pickRawComments(post, 12);

  let askSpec = '';
  if (['stats','profile','matchcard'].includes(type)) {
    askSpec = `この "${type}" スライドの dataSlots（4個）を生成してください。
siBinding="${mod.siBinding || 'なし'}" のデータから適切なラベルと値を抽出。
JSONのみ: {"dataSlots":[{"label":"GOALS","value":"24"},{"label":"...","value":"..."},...4個]}`;
  } else if (type === 'comparison') {
    askSpec = `この "comparison" スライドの dataSlots（4行）と2者の siBinding を生成。
適切な2者を siBindingLeft と siBindingRight で指定し、対比可能な項目を4行作る。
JSONのみ: {"siBindingLeft":"選手A","siBindingRight":"選手B","dataSlots":[{"label":"GOALS","leftValue":"24","rightValue":"18"},...4行]}`;
  } else if (type === 'insight') {
    askSpec = `この "insight" スライドのキャッチコピー（3〜5個）を生成。
siBinding="${mod.siBinding || 'なし'}" の情報や案件の衝撃的事実を短く強く書く。
JSONのみ: {"catchphrases":["短い衝撃コピー1","コピー2","コピー3"]}`;
  } else if (type === 'reaction') {
    askSpec = `この "reaction" スライドの視聴者共感用コメント（7個）を生成。
以下の元コメントから面白い7件を選定し、必要なら日本語に意訳：
${JSON.stringify(rawComments, null, 0)}
JSONのみ: {"comments":[{"text":"...","score":0},...7件]}`;
  } else if (type === 'matchcenter') {
    return res.json({ /* matchcenterは自動解決 */ ok: true, note: 'matchcenter は siBinding の sofascore_match データから自動展開されます' });
  } else {
    return res.json({ ok: true, note: `${type} にはデータバインドがありません` });
  }

  const prompt = `スライドタイトル: 「${mod.title}」
タイプ: ${type}
脚本指示: ${mod.scriptDir || '(なし)'}

【案件】${post.title || post.titleOrig}
【取得済みSIデータ】${siSummaryText}

${askSpec}`;

  try {
    const raw = await callAI({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'JSONパース失敗' });
    const parsed = JSON.parse(m[0]);
    console.log('[Step3] populate-module:', type, mod.title.slice(0, 30));
    res.json({ ok: true, ...parsed });
  } catch (e) {
    console.error('[Step3] populate-module エラー:', e.message);
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

  <!-- 全体構成（outline）パネル：modules 未生成時のみ表示 -->
  <div id="s3OutlinePanel" class="panel" style="display:none;margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font-size:13px;color:var(--c);font-weight:bold;">📋 全体構成（outline）— 話の流れだけ決める</span>
      <span id="s3OutlineMsg" style="font-size:11px;color:#8a9aba;"></span>
    </div>
    <div id="s3OutlineList"></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
      <button class="btn btn-sm" onclick="s3OutlineAddRow()" style="background:#10b981;color:#fff;">＋ スライド追加</button>
      <button class="btn btn-sm" onclick="s3OutlineRegen()" style="background:#64748b;color:#fff;">🔄 outline再提案</button>
      <button class="btn btn-primary" onclick="s3ProposeFromOutline()" style="margin-left:auto;font-size:13px;padding:8px 18px;">
        ✨ この目次でモジュール詳細を提案
      </button>
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
      🎬 モジュール確定 &#x2192; Step4 へ
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
    reaction:'コメント反応', comparison:'対比',
    history:'時系列ヒストリー', matchcard:'試合プレビュー',
    matchcenter:'試合詳細', ending:'エンディング',
  };
  // profile は stats と中身同じのため UI から削除（既存モジュールは render側で stats扱い）
  const ALL_TYPES = ['opening','insight','stats','reaction','comparison','history','matchcard','matchcenter','ending'];

  /* SIデータ（サーバーから取得）*/
  window.APP = window.APP || {};
  window.APP.s3SiData = {};
  window.APP.s3 = window.APP.s3 || { recipesByKey: {} };

  /* ── レシピ読込（Step4と共通）── */
  function _s3LoadRecipes() {
    var post = window.APP.selected;
    var url  = '/api/v2/recipes' + (post && post.id ? '?postId=' + encodeURIComponent(post.id) : '');
    return fetchJson(url)
      .then(function(j) {
        var rbk = {};
        (j.recipes || []).forEach(function(r) { rbk[r.key] = r; });
        window.APP.s3.recipesByKey = rbk;
      })
      .catch(function(e) { console.warn('[Step3] recipes読込失敗', e); });
  }

  window.step3Init = function() {
    var postId = window.APP.selected && window.APP.selected.id;
    if (!postId) { s3RenderTabs(); s3RenderEditor(); _s3HideOutline(); return; }
    /* サーバーからSIデータ + レシピを取得してからレンダリング */
    Promise.all([
      fetchJson('/api/si-data?postId=' + encodeURIComponent(postId))
        .then(function(d) { window.APP.s3SiData = d || {}; })
        .catch(function() {}),
      _s3LoadRecipes(),
    ]).then(function() {
      s3RenderTabs();
      s3RenderEditor();
      s3LoadImages();
      _s3FetchEvalSlots(window.APP.activeTab || 0);
      // modules が空なら outline を取得 or 自動生成
      if (!(window.APP.modules || []).length) _s3InitOutline();
      else _s3HideOutline();
    });
  };

  /* ── outline 取得・表示・編集 ── */
  function _s3HideOutline() {
    var el = document.getElementById('s3OutlinePanel');
    if (el) el.style.display = 'none';
  }
  function _s3ShowOutline() {
    var el = document.getElementById('s3OutlinePanel');
    if (el) el.style.display = '';
  }

  async function _s3InitOutline() {
    var postId = window.APP.selected?.id;
    if (!postId) return;
    _s3ShowOutline();
    _s3SetOutlineMsg('⏳ 既存outline確認中...');
    try {
      // 既存があれば読み込み
      var got = await fetchJson('/api/propose-outline?postId=' + encodeURIComponent(postId));
      if (Array.isArray(got.outline) && got.outline.length) {
        window.APP.s3.outline = got.outline;
        _s3RenderOutline();
        _s3SetOutlineMsg('💾 既存outline読込（' + got.outline.length + '枚）');
        return;
      }
      // 無ければ自動生成
      _s3SetOutlineMsg('⏳ Haiku が話の流れを構築中...');
      var d = await fetchJson('/api/propose-outline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post: window.APP.selected, postId: postId, siDataIn: window.APP.s3SiData || {} }),
      });
      window.APP.s3.outline = d.outline || [];
      _s3RenderOutline();
      _s3SetOutlineMsg('✅ outline 生成完了（' + window.APP.s3.outline.length + '枚）');
    } catch (e) {
      _s3SetOutlineMsg('❌ outline生成失敗: ' + e.message);
      window.APP.s3.outline = [];
      _s3RenderOutline();
    }
  }

  function _s3SetOutlineMsg(s) {
    var el = document.getElementById('s3OutlineMsg');
    if (el) el.innerHTML = s;
  }

  function _s3RenderOutline() {
    var el = document.getElementById('s3OutlineList');
    if (!el) return;
    var ol = window.APP.s3.outline || [];
    if (!ol.length) {
      el.innerHTML = '<div style="padding:14px;color:#8a9aba;font-size:12px;text-align:center;">空。「+ スライド追加」または「🔄 outline再提案」で開始</div>';
      return;
    }
    el.innerHTML = ol.map(function(o, idx) {
      return '<div style="display:grid;grid-template-columns:24px 200px 1fr 28px 28px 28px;gap:6px;margin-bottom:6px;align-items:center;">'
        + '<span style="font-size:10px;color:#8a9aba;text-align:center;">#' + (idx+1) + '</span>'
        + '<input class="inp s3-ol-title" data-idx="' + idx + '" placeholder="タイトル" style="font-size:12px;padding:5px 8px;" value="' + _e(o.title || '') + '">'
        + '<input class="inp s3-ol-direction" data-idx="' + idx + '" placeholder="方向性（何を伝えるか）" style="font-size:12px;padding:5px 8px;" value="' + _e(o.direction || '') + '">'
        + '<button class="btn btn-sm" data-idx="' + idx + '" onclick="s3OutlineMove(' + idx + ',-1)" style="background:#475569;color:#fff;padding:4px 6px;">↑</button>'
        + '<button class="btn btn-sm" data-idx="' + idx + '" onclick="s3OutlineMove(' + idx + ',1)" style="background:#475569;color:#fff;padding:4px 6px;">↓</button>'
        + '<button class="btn btn-sm" data-idx="' + idx + '" onclick="s3OutlineRemove(' + idx + ')" style="background:#ef4444;color:#fff;padding:4px 6px;">×</button>'
        + '</div>';
    }).join('');
  }

  // outline 入力編集を APP に反映してから永続化
  function _s3CollectOutline() {
    var titles = document.querySelectorAll('.s3-ol-title');
    var dirs   = document.querySelectorAll('.s3-ol-direction');
    var ol = [];
    for (var i = 0; i < titles.length; i++) {
      ol.push({
        title:     titles[i].value || '',
        direction: dirs[i] ? (dirs[i].value || '') : '',
      });
    }
    window.APP.s3.outline = ol;
    return ol;
  }

  async function _s3SaveOutline() {
    var ol = _s3CollectOutline();
    var postId = window.APP.selected?.id;
    if (!postId) return;
    try {
      await fetchJson('/api/propose-outline/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: postId, outline: ol }),
      });
    } catch (_) {}
  }

  window.s3OutlineAddRow = function() {
    _s3CollectOutline();
    window.APP.s3.outline = window.APP.s3.outline || [];
    window.APP.s3.outline.push({ title: '', direction: '' });
    _s3RenderOutline();
  };
  window.s3OutlineRemove = function(idx) {
    _s3CollectOutline();
    window.APP.s3.outline.splice(idx, 1);
    _s3RenderOutline();
  };
  window.s3OutlineMove = function(idx, delta) {
    _s3CollectOutline();
    var ol = window.APP.s3.outline;
    var ni = idx + delta;
    if (ni < 0 || ni >= ol.length) return;
    var tmp = ol[idx]; ol[idx] = ol[ni]; ol[ni] = tmp;
    _s3RenderOutline();
  };
  window.s3OutlineRegen = async function() {
    var postId = window.APP.selected?.id;
    if (!postId) return;
    if (!confirm('現在のoutlineを破棄して再生成しますか？')) return;
    _s3SetOutlineMsg('⏳ Haiku が再構築中...');
    try {
      var d = await fetchJson('/api/propose-outline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post: window.APP.selected, postId: postId, siDataIn: window.APP.s3SiData || {}, force: true }),
      });
      window.APP.s3.outline = d.outline || [];
      _s3RenderOutline();
      _s3SetOutlineMsg('✅ outline 再生成（' + window.APP.s3.outline.length + '枚）');
    } catch (e) {
      _s3SetOutlineMsg('❌ ' + e.message);
    }
  };

  window.s3ProposeFromOutline = async function() {
    var ol = _s3CollectOutline();
    if (!ol.length) return alert('outline が空です');
    await _s3SaveOutline();
    _s3Msg('⏳ Sonnet がoutlineを肉付け中...');
    document.getElementById('s3Editor').innerHTML = '<div style="color:var(--c);padding:20px;">⏳ 詳細生成中（型・binding・データ充填）...</div>';
    try {
      var d = await fetchJson('/api/propose-modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post: window.APP.selected,
          postId: window.APP.selected?.id,
          siDataIn: window.APP.s3SiData || {},
          outline: ol,
        }),
      });
      window.APP.modules   = d.modules || [];
      window.APP.activeTab = 0;
      _s3HideOutline();
      s3RenderTabs();
      s3RenderEditor();
      _s3Msg('✅ ' + window.APP.modules.length + ' スライド詳細生成完了');
    } catch (e) {
      _s3Msg('❌ 詳細生成失敗: ' + e.message);
    }
  };

  /* ── eval slots を背景取得（プルダウン「label：値」表示用）── */
  async function _s3FetchEvalSlots(idx) {
    var m    = (window.APP.modules || [])[idx];
    var post = window.APP.selected;
    if (!m || !post || !post.id) return;
    if (!m.binding || !m.binding.subject || !m.binding.aspect) return;
    if (m.binding.subject === 'generic') return;
    if (Array.isArray(m._evalSlots) && m._evalSlots.length) return;
    try {
      var r = await fetch('/api/v2/rebuild-module', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postId:   post.id,
          idx:      idx,
          binding:  m.binding,
          persist:  false,
          evalOnly: true,
        }),
      });
      var j = await r.json();
      if (!j.ok) return;
      m._evalSlots = j.evaluatedSlots || [];
      if (window.APP.activeTab === idx) s3RenderEditor();
    } catch (_) { /* silent */ }
  }
  window._s3FetchEvalSlots = _s3FetchEvalSlots;

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
      _s3HideOutline();
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
    _s3FetchEvalSlots(i);
  };

  /* ── レシピの availableSlots を取得 ── */
  function _s3GetAvailableSlots(m) {
    var b = m && m.binding;
    if (!b || !b.subject || !b.aspect) return [];
    var r = (window.APP.s3.recipesByKey || {})[b.subject + '.' + b.aspect];
    return (r && r.availableSlots) || [];
  }

  /* ── プルダウン選択肢を「label：値」表示で生成 ── */
  function _s3SlotKeyOptions(m, currentKey) {
    var slots = _s3GetAvailableSlots(m);
    if (!slots.length) return '';
    var evalSlots = m._evalSlots || [];
    var evalByKey = {};
    evalSlots.forEach(function(es) { evalByKey[es.key] = es; });
    var html = '';
    slots.forEach(function(s) {
      var ev = evalByKey[s.key];
      var display = s.label;
      if (ev) {
        if (ev.value !== undefined && ev.value !== '-') display = s.label + '：' + ev.value;
        else if (ev.leftValue !== undefined) display = s.label + '：' + ev.leftValue + ' vs ' + ev.rightValue;
      }
      html += '<option value="' + _e(s.key) + '"' + (s.key === currentKey ? ' selected' : '') + '>'
        + _e(display) + '</option>';
    });
    html += '<option value=""' + (!currentKey ? ' selected' : '') + '>(カスタム)</option>';
    return html;
  }

  /* ── SIバインド対象から引けるフィールド定義 ──
     各 box type でプルダウンに並ぶ { path, label } のリスト
     path は siData のネスト参照キー（ドット区切り、配列は数値インデックスもOK） */
  const FIELD_MAP = {
    sofascore_player: [
      { path: 'seasonStats.goals',         label: '今季ゴール' },
      { path: 'seasonStats.assists',       label: '今季アシスト' },
      { path: 'seasonStats.appearances',   label: '出場試合' },
      { path: 'seasonStats.rating',        label: 'レーティング' },
      { path: 'seasonStats.minutesPlayed', label: '出場分' },
      { path: 'seasonStats.expectedGoals', label: 'xG' },
      { path: 'seasonStats.keyPasses',     label: 'キーパス' },
      { path: 'seasonStats.yellowCards',   label: 'イエロー' },
      { path: 'seasonStats.redCards',      label: 'レッド' },
      { path: 'recentAvgRating',           label: '直近平均レート' },
      { path: 'lastMatchStats.rating',     label: '直近試合rating' },
      { path: 'lastMatchStats.score',      label: '直近試合スコア' },
      { path: 'lastMatchStats.opponent',   label: '直近対戦相手' },
      { path: 'marketValue',               label: '市場価値' },
      { path: 'position',                  label: 'ポジション' },
      { path: 'team',                      label: '所属チーム' },
      { path: 'nationality',               label: '国籍' },
      { path: 'age',                       label: '年齢' },
      { path: 'height',                    label: '身長' },
      { path: 'weight',                    label: '体重' },
      { path: 'shirtNumber',               label: '背番号' },
      { path: 'preferredFoot',             label: '利き足' },
      { path: 'contractUntil',             label: '契約期限' },
      { path: 'leagueName',                label: 'リーグ' },
    ],
    sofascore_team: [
      { path: 'standing.position',      label: '順位' },
      { path: 'standing.played',        label: '試合数' },
      { path: 'standing.wins',          label: '勝利' },
      { path: 'standing.draws',         label: '引分' },
      { path: 'standing.losses',        label: '敗戦' },
      { path: 'standing.goalsFor',      label: '得点' },
      { path: 'standing.goalsAgainst',  label: '失点' },
      { path: 'standing.points',        label: '勝ち点' },
      { path: 'managerName',            label: '監督' },
      { path: 'leagueName',             label: 'リーグ' },
      { path: 'seasonYear',             label: 'シーズン' },
      { path: 'country',                label: '国' },
      { path: 'venue',                  label: '本拠地' },
      { path: 'founded',                label: '創設年' },
      { path: 'marketValue',            label: 'クラブ総市場価値' },
    ],
    sofascore_manager: [
      { path: 'currentTeam',                     label: '現チーム' },
      { path: 'currentTeamSince',                label: '現チーム就任' },
      { path: 'nationality',                     label: '国籍' },
      { path: 'age',                             label: '年齢' },
      { path: 'preferredFormation',              label: 'フォーメーション' },
      { path: 'overallPerformance.total',        label: '通算試合数' },
      { path: 'overallPerformance.wins',         label: '通算勝利' },
      { path: 'overallPerformance.draws',        label: '通算引分' },
      { path: 'overallPerformance.losses',       label: '通算敗戦' },
      { path: 'overallPerformance.winRate',      label: '通算勝率(%)' },
      { path: 'overallPerformance.goalsScored',  label: '通算得点' },
      { path: 'overallPerformance.goalsConceded',label: '通算失点' },
      { path: 'currentTeamStats.wins',           label: '現チーム勝利' },
      { path: 'currentTeamStats.draws',          label: '現チーム引分' },
      { path: 'currentTeamStats.losses',         label: '現チーム敗戦' },
      { path: 'currentTeamStats.winRate',        label: '現チーム勝率(%)' },
    ],
    sofascore_match: [
      { path: 'scoreline',  label: 'スコア' },
      { path: 'matchDate',  label: '試合日' },
      { path: 'tournament', label: '大会' },
      { path: 'venue',      label: '会場' },
      { path: 'attendance', label: '観客数' },
      { path: 'h2hSummary', label: 'H2H通算' },
    ],
    wikipedia: [
      { path: 'title',   label: '記事タイトル' },
      { path: 'extract', label: '要約' },
    ],
  };

  /* siData から box+label 指定で生データを取り出す */
  function _s3GetSiItem(siLabel) {
    var s3si = window.APP.s3SiData || {};
    if (!s3si.boxes) return null;
    for (var boxType in s3si.boxes) {
      var box = s3si.boxes[boxType];
      var found = (box.fetched || []).find(function(f) { return f.label === siLabel; });
      if (found) return { boxType: boxType, data: found.data };
    }
    return null;
  }

  /* ネストパス文字列 (e.g. 'seasonStats.goals') で値を取り出す */
  function _s3GetByPath(obj, path) {
    if (!obj || !path) return null;
    return path.split('.').reduce(function(o, k) {
      if (o == null) return null;
      if (Array.isArray(o) && /^\d+$/.test(k)) return o[parseInt(k, 10)];
      return o[k];
    }, obj);
  }

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
      + '<select id="s3TypeSel" class="inp" style="width:100%;" onchange="s3OnTypeChange()">' + typeOpts + '</select>'
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

      /* データバインド（タイプ別）*/
      + _s3DataBindHtml(m, siItems)

      /* AI制作意図 */
      + '<div style="background:#0d1220;border-radius:8px;padding:12px;margin-bottom:10px;">'
      + '<div style="font-size:10px;color:#8a9aba;margin-bottom:4px;">&#x1F4A1; AI制作意図</div>'
      + '<div style="font-size:12px;color:#c0cce0;line-height:1.6;">' + _e(m.reason||'') + '</div>'
      + '</div>'

      /* 位置表示 */
      + '<div style="font-size:10px;color:#5a6a8a;">スライド ' + (i+1) + ' / ' + mods.length + '</div>';

    // 現在表示中タブの eval slots を背景で取得（プルダウン「label：値」用）
    if (typeof _s3FetchEvalSlots === 'function') _s3FetchEvalSlots(i);
  }

  /* ── データバインドUI生成（タイプ別） ── */
  function _s3DataBindHtml(m, siItems) {
    const type = m.type;
    if (!['stats','profile','matchcard','comparison','insight','reaction','matchcenter'].includes(type)) {
      return ''; // opening/ending/history は不要
    }

    const header =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '<span style="font-size:11px;color:var(--c);font-weight:bold;">&#x1F3AF; データバインド</span>'
      + '<button class="btn btn-sm" onclick="s3PopulateModule()">&#x21BB; データ再生成</button>'
      + '</div>';

    const wrap = (inner) =>
      '<div style="background:#0d1220;border-radius:8px;padding:12px;margin-bottom:14px;">'
      + header + inner + '</div>';

    if (type === 'matchcenter') {
      return wrap(
        '<div style="font-size:11px;color:#8a9aba;line-height:1.5;">'
        + 'siBinding で指定した sofascore_match ラベルから自動展開されます（スコア・得点・スタッツ・ラインアップ）。<br>'
        + '現在のバインド: <span style="color:#fff;font-weight:bold;">' + _e(m.siBinding || '(未設定)') + '</span>'
        + '</div>'
      );
    }

    if (type === 'stats' || type === 'profile' || type === 'matchcard') {
      const slots = Array.isArray(m.dataSlots) ? m.dataSlots : [];
      if (!slots.length) {
        for (let k = 0; k < 4; k++) slots.push({ label: '', value: '' });
      }
      m.dataSlots = slots;

      // ── 新レシピシステム判定 ──
      const newAvailable = _s3GetAvailableSlots(m);
      const useNewSystem = newAvailable.length > 0
        && m.binding && m.binding.subject && m.binding.subject !== 'generic';

      if (useNewSystem) {
        // 「label：値」プルダウンUI（Step4と同じ）
        const hint = '<div style="font-size:11px;color:#10b981;margin-bottom:8px;">'
          + '&#x1F3AF; binding: <b>' + _e(m.binding.subject) + '.' + _e(m.binding.aspect) + '</b>'
          + (m.binding.primary ? ' / ' + _e(m.binding.primary) : '')
          + '</div>';
        const rows = m.dataSlots.map(function(s, idx) {
          const slotKey = s.slotKey || '';
          return '<div style="display:grid;grid-template-columns:30px 160px 1fr 30px;gap:6px;margin-bottom:6px;align-items:center;">'
            + '<span style="font-size:10px;color:#8a9aba;text-align:center;">#' + (idx+1) + '</span>'
            + '<select class="inp s3-slot-key" data-idx="' + idx + '" style="font-size:11px;padding:4px 6px;">'
            + _s3SlotKeyOptions(m, slotKey)
            + '</select>'
            + '<input class="inp s3-slot-value" data-idx="' + idx + '" placeholder="値"'
            + ' style="font-size:12px;padding:5px 8px;" value="' + _e(s.value || '') + '">'
            + '<button class="btn btn-sm s3-slot-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 8px;">&#xD7;</button>'
            + '</div>';
        }).join('');
        const addBtn = '<button class="btn btn-sm" style="background:#10b981;color:#fff;margin-top:4px;" onclick="s3AddSlot()">+ 行追加</button>'
          + '<button class="btn btn-sm" style="background:#a855f7;color:#fff;margin-top:4px;margin-left:6px;" onclick="s3FillFromScriptDir()" title="脚本指示の内容に応じてWikipediaからデータ抽出">&#x2728; scriptDirから取得</button>';
        return wrap(hint + rows + addBtn);
      }

      // ── 旧UI（binding 無 or generic.free 等）──
      let fieldDefs = [];
      const bindItem = m.siBinding ? _s3GetSiItem(m.siBinding) : null;
      if (bindItem && FIELD_MAP[bindItem.boxType]) {
        fieldDefs = FIELD_MAP[bindItem.boxType];
      }

      const fieldDropdown = bindItem
        ? '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:10px;">'
          + '<select class="inp" id="s3FieldSel" style="font-size:12px;padding:5px;">'
          + '<option value="">データ型を選択...</option>'
          + fieldDefs.map(f => '<option value="' + _e(f.path) + '">' + _e(f.label) + '</option>').join('')
          + '</select>'
          + '<button class="btn btn-sm" onclick="s3SetFieldRow()" style="background:#10b981;color:#fff;">&#x1F3AF; データセット</button>'
          + '</div>'
        : '<div style="font-size:11px;color:#5a6a8a;margin-bottom:10px;">上の「SIデータバインド」を選択するとデータ型プルダウンが使えます。空行の手動入力も可能。</div>';

      const rows = m.dataSlots.map((s, idx) => {
        const merged = (s.label && s.value) ? (s.label + '：' + s.value) : (s.merged || '');
        return '<div style="display:grid;grid-template-columns:30px 1fr 30px;gap:6px;margin-bottom:6px;align-items:center;">'
          + '<span style="font-size:10px;color:#8a9aba;text-align:center;">#' + (idx+1) + '</span>'
          + '<input class="inp s3-slot-merged" data-idx="' + idx + '" placeholder="例: 今季ゴール：28" style="font-size:13px;padding:5px 10px;" value="' + _e(merged) + '">'
          + '<button class="btn btn-sm s3-slot-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 8px;">&#xD7;</button>'
          + '</div>';
      }).join('');
      const addBtn = '<button class="btn btn-sm" style="background:#64748b;color:#fff;margin-top:4px;" onclick="s3AddSlot()">+ 空行追加（手動入力用）</button>';
      return wrap(fieldDropdown + rows + addBtn);
    }

    if (type === 'comparison') {
      const slots = Array.isArray(m.dataSlots) ? m.dataSlots : [];
      if (!slots.length) {
        for (let k = 0; k < 4; k++) slots.push({ label: '', leftValue: '', rightValue: '' });
      }
      m.dataSlots = slots;

      const siOptsL = ['<option value="">(左: 未選択)</option>']
        .concat(siItems.map(it =>
          '<option value="' + _e(it.key) + '"' + (m.siBindingLeft===it.key?' selected':'') + '>' + _e(it.label) + '</option>'
        )).join('');
      const siOptsR = ['<option value="">(右: 未選択)</option>']
        .concat(siItems.map(it =>
          '<option value="' + _e(it.key) + '"' + (m.siBindingRight===it.key?' selected':'') + '>' + _e(it.label) + '</option>'
        )).join('');

      // データ型プルダウン候補（左バインドの box type から引く）
      let fieldOpts = '<option value="">(先に左SIを選択)</option>';
      if (m.siBindingLeft) {
        const leftItem = _s3GetSiItem(m.siBindingLeft);
        if (leftItem && FIELD_MAP[leftItem.boxType]) {
          fieldOpts = '<option value="">データ型を選択...</option>'
            + FIELD_MAP[leftItem.boxType].map(f =>
                '<option value="' + _e(f.path) + '">' + _e(f.label) + '</option>'
              ).join('');
        }
      }

      const topRow =
        '<div style="margin-bottom:10px;">'
        // 対比対象 左/右
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">'
        + '<select class="inp" id="s3BindLeft"  style="font-size:11px;padding:5px;color:#93c5fd;">' + siOptsL + '</select>'
        + '<select class="inp" id="s3BindRight" style="font-size:11px;padding:5px;color:#fca5a5;">' + siOptsR + '</select>'
        + '</div>'
        // データ型プルダウン + セットボタン
        + '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;">'
        + '<select class="inp" id="s3CmpFieldSel" style="font-size:12px;padding:5px;">' + fieldOpts + '</select>'
        + '<button class="btn btn-sm" onclick="s3SetCmpRow()" style="background:#10b981;color:#fff;">&#x1F3AF; データセット</button>'
        + '</div>'
        + '</div>';

      const rows = m.dataSlots.map((s, idx) =>
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 30px;gap:6px;margin-bottom:6px;align-items:center;">'
        + '<input class="inp s3-cmp-label" data-idx="' + idx + '" placeholder="LABEL" style="font-size:12px;padding:4px 8px;" value="' + _e(s.label || '') + '">'
        + '<input class="inp s3-cmp-left"  data-idx="' + idx + '" placeholder="左"    style="font-size:12px;padding:4px 8px;color:#93c5fd;" value="' + _e(s.leftValue || '') + '">'
        + '<input class="inp s3-cmp-right" data-idx="' + idx + '" placeholder="右"    style="font-size:12px;padding:4px 8px;color:#fca5a5;" value="' + _e(s.rightValue || '') + '">'
        + '<button class="btn btn-sm s3-cmp-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 8px;">&#xD7;</button>'
        + '</div>'
      ).join('');
      const addBtn = '<button class="btn btn-sm" style="background:#64748b;color:#fff;margin-top:4px;" onclick="s3AddCmpSlot()">+ 空行追加（手動入力用）</button>';
      return wrap(topRow + rows + addBtn);
    }

    if (type === 'insight') {
      const phrases = Array.isArray(m.catchphrases) ? m.catchphrases : [];
      if (!phrases.length) phrases.push('', '', '');
      m.catchphrases = phrases;
      const rows = m.catchphrases.map((p, idx) =>
        '<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">'
        + '<span style="width:22px;font-size:10px;color:#8a9aba;">' + (idx+1) + '.</span>'
        + '<input class="inp s3-phrase" data-idx="' + idx + '" placeholder="キャッチコピー' + (idx+1) + '" style="flex:1;font-size:13px;padding:5px 10px;" value="' + _e(p) + '">'
        + '<button class="btn btn-sm" style="background:#ef4444;color:#fff;" onclick="s3RemovePhrase(' + idx + ')">&#xD7;</button>'
        + '</div>'
      ).join('');
      const addBtn = '<button class="btn btn-sm" style="background:#10b981;color:#fff;margin-top:4px;" onclick="s3AddPhrase()">+ キャッチコピー追加</button>';
      return wrap(rows + addBtn);
    }

    if (type === 'reaction') {
      const coms = Array.isArray(m.comments) ? m.comments : [];
      if (!coms.length) { for (let k = 0; k < 7; k++) coms.push({ text: '', score: 0 }); }
      m.comments = coms;
      const rows = m.comments.map((c, idx) =>
        '<div style="display:grid;grid-template-columns:22px 1fr 70px 30px;gap:6px;margin-bottom:6px;align-items:center;">'
        + '<span style="font-size:10px;color:#8a9aba;text-align:center;">' + (idx+1) + '.</span>'
        + '<input class="inp s3-cmt-text"  data-idx="' + idx + '" placeholder="コメント" style="font-size:12px;padding:4px 8px;" value="' + _e(c.text || '') + '">'
        + '<input type="number" class="inp s3-cmt-score" data-idx="' + idx + '" placeholder="score" style="font-size:11px;padding:4px 8px;" value="' + (c.score || 0) + '">'
        + '<button class="btn btn-sm s3-cmt-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 8px;">&#xD7;</button>'
        + '</div>'
      ).join('');
      const addBtn = '<button class="btn btn-sm" style="background:#10b981;color:#fff;margin-top:4px;" onclick="s3AddComment()">+ コメント追加</button>';
      return wrap(rows + addBtn);
    }

    return '';
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

    // ── データバインド系の入力を DOM から収集 ──
    const type = m.type;
    if (['stats','profile','matchcard'].includes(type)) {
      // 新システム（slotKey + value）が表示中ならそちらを優先
      const newKeys   = document.querySelectorAll('.s3-slot-key');
      const newValues = document.querySelectorAll('.s3-slot-value');
      if (newKeys.length) {
        const recipeSlots = _s3GetAvailableSlots(m);
        const labelByKey  = {};
        recipeSlots.forEach(rs => { labelByKey[rs.key] = rs.label; });
        const slots = [];
        for (let j = 0; j < newKeys.length; j++) {
          const k = newKeys[j].value || '';
          slots.push({
            slotKey: k || undefined,
            label:   labelByKey[k] || '',
            value:   newValues[j]?.value || '',
          });
        }
        m.dataSlots = slots;
        // customSlotKeys を binding にも反映（再取得時の整合性）
        const keys = slots.map(s => s.slotKey).filter(Boolean);
        if (keys.length && m.binding) m.binding.customSlotKeys = keys;
      } else {
        // 旧UI: 「ラベル：値」1カラム形式を保存時に分解
        const merged = document.querySelectorAll('.s3-slot-merged');
        const slots = [];
        merged.forEach(el => {
          const raw = el.value || '';
          const parts = raw.split(/[:：]/);
          const label = (parts[0] || '').trim();
          const value = parts.slice(1).join(':').trim();
          slots.push({ label, value, merged: raw });
        });
        m.dataSlots = slots;
      }
    } else if (type === 'comparison') {
      const labels = document.querySelectorAll('.s3-cmp-label');
      const lefts  = document.querySelectorAll('.s3-cmp-left');
      const rights = document.querySelectorAll('.s3-cmp-right');
      const slots = [];
      for (let j = 0; j < labels.length; j++) {
        slots.push({
          label:      labels[j]?.value || '',
          leftValue:  lefts[j]?.value  || '',
          rightValue: rights[j]?.value || '',
        });
      }
      m.dataSlots = slots;
      const bL = document.getElementById('s3BindLeft');
      const bR = document.getElementById('s3BindRight');
      if (bL) m.siBindingLeft  = bL.value || null;
      if (bR) m.siBindingRight = bR.value || null;
    } else if (type === 'insight') {
      const inputs = document.querySelectorAll('.s3-phrase');
      m.catchphrases = Array.from(inputs).map(el => el.value);
    } else if (type === 'reaction') {
      const texts  = document.querySelectorAll('.s3-cmt-text');
      const scores = document.querySelectorAll('.s3-cmt-score');
      const coms = [];
      for (let j = 0; j < texts.length; j++) {
        coms.push({
          text:  texts[j]?.value || '',
          score: Number(scores[j]?.value) || 0,
        });
      }
      m.comments = coms;
    }
  }

  /* stats/profile/matchcard: スロット追加/削除 */
  window.s3AddSlot = function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    if (!Array.isArray(m.dataSlots)) m.dataSlots = [];
    m.dataSlots.push({ label: '', value: '', merged: '' });
    s3RenderEditor();
  };

  /* stats/profile/matchcard: データセットボタン（データ型選択 → 値自動取得）*/
  window.s3SetFieldRow = function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    const fieldSel = document.getElementById('s3FieldSel');
    const fieldPath = fieldSel?.value;
    if (!fieldPath) { _s3Msg('データ型を選んでください'); return; }

    const bindItem = m.siBinding ? _s3GetSiItem(m.siBinding) : null;
    if (!bindItem) { _s3Msg('先にSIバインドを選んでください'); return; }

    const fmap = FIELD_MAP[bindItem.boxType] || [];
    const fieldDef = fmap.find(f => f.path === fieldPath);
    const label = fieldDef ? fieldDef.label : fieldPath;

    const val = _s3GetByPath(bindItem.data, fieldPath);
    const valStr = (val == null ? '-' : String(val));

    const newSlot = {
      label: label,
      value: valStr,
      merged: label + '：' + valStr,
    };

    if (!Array.isArray(m.dataSlots)) m.dataSlots = [];
    // 空スロットがあればそこに挿入、なければ末尾追加
    const emptyIdx = m.dataSlots.findIndex(s => !s.label && !s.value && !s.merged);
    if (emptyIdx >= 0) m.dataSlots[emptyIdx] = newSlot;
    else m.dataSlots.push(newSlot);

    s3RenderEditor();
    _s3Msg('&#x2705; ' + label + '：' + valStr + ' をセットしました');
  };

  /* SIバインド変更時にデータ型プルダウン更新 */
  document.addEventListener('change', function(e) {
    if (e.target.id === 's3SiBind') {
      _s3SaveCurrent();
      s3RenderEditor();
    }
  });
  /* comparison: 行追加/削除 */
  window.s3AddCmpSlot = function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    if (!Array.isArray(m.dataSlots)) m.dataSlots = [];
    m.dataSlots.push({ label: '', leftValue: '', rightValue: '' });
    s3RenderEditor();
  };

  /* comparison: データセットボタン（データ型選択 → 両側の値自動取得）*/
  window.s3SetCmpRow = function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    const fieldSel = document.getElementById('s3CmpFieldSel');
    const fieldPath = fieldSel?.value;
    if (!fieldPath) { _s3Msg('データ型を選んでください'); return; }

    const leftKey = m.siBindingLeft;
    const rightKey = m.siBindingRight;
    if (!leftKey || !rightKey) { _s3Msg('左右のSIバインドを両方選んでください'); return; }

    const leftItem  = _s3GetSiItem(leftKey);
    const rightItem = _s3GetSiItem(rightKey);
    if (!leftItem || !rightItem) { _s3Msg('SIデータが見つかりません'); return; }

    // ラベル名（日本語）を FIELD_MAP から取得
    const fmap = FIELD_MAP[leftItem.boxType] || [];
    const fieldDef = fmap.find(f => f.path === fieldPath);
    const label = fieldDef ? fieldDef.label : fieldPath;

    const lv = _s3GetByPath(leftItem.data,  fieldPath);
    const rv = _s3GetByPath(rightItem.data, fieldPath);

    const newRow = {
      label: label,
      leftValue:  (lv == null ? '-' : String(lv)),
      rightValue: (rv == null ? '-' : String(rv)),
    };

    if (!Array.isArray(m.dataSlots)) m.dataSlots = [];
    // 空行があればそこに挿入、なければ末尾追加
    const emptyIdx = m.dataSlots.findIndex(s => !s.label && !s.leftValue && !s.rightValue);
    if (emptyIdx >= 0) m.dataSlots[emptyIdx] = newRow;
    else m.dataSlots.push(newRow);

    s3RenderEditor();
    _s3Msg('&#x2705; ' + label + ' をセットしました');
  };

  /* comparison: 左右SIバインド変更時にフィールドプルダウンを更新 */
  document.addEventListener('change', function(e) {
    if (e.target.id === 's3BindLeft' || e.target.id === 's3BindRight') {
      _s3SaveCurrent();
      s3RenderEditor();
    }
  });

  /* タイプ変更時：エディタを再描画して該当UI（dataSlots/catchphrases等）に切替 */
  window.s3OnTypeChange = function() {
    _s3SaveCurrent();
    s3RenderEditor();
  };

  /* scriptDir駆動 dataSlots自動充填（Wikipedia実データから抽出） */
  window.s3FillFromScriptDir = async function() {
    _s3SaveCurrent();
    const i = window.APP.activeTab;
    const m = window.APP.modules?.[i];
    const post = window.APP.selected;
    if (!m || !post?.id) return;
    if (!m.scriptDir || !m.scriptDir.trim()) {
      _s3Msg('&#x26A0; 脚本指示が空です');
      return;
    }
    _s3Msg('&#x2728; モジュール保存 → Wikipedia → AI抽出 中...');
    try {
      // endpoint がディスク読込なので先に save
      await fetchJson('/api/save-modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: window.APP.modules }),
      });
      const j = await fetchJson('/api/v2/fill-slots-from-scriptdir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, idx: i, scriptDir: m.scriptDir }),
      });
      if (!j.ok) {
        _s3Msg('&#x274C; 失敗: ' + (j.error || ''));
        return;
      }
      m.dataSlots = j.dataSlots;
      _s3Msg('&#x2705; ' + j.dataSlots.length + 'スロット充填 (' + j.source + ' / ' + j.wikiTitle + ')');
      s3RenderEditor();
    } catch (e) {
      _s3Msg('&#x274C; エラー: ' + e.message);
    }
  };

  /* outline 編集の自動保存（debounce 1.5s） */
  let _s3OutlineSaveTimer = null;
  document.addEventListener('input', function(e) {
    if (!e.target.classList) return;
    if (e.target.classList.contains('s3-ol-title') || e.target.classList.contains('s3-ol-direction')) {
      clearTimeout(_s3OutlineSaveTimer);
      _s3OutlineSaveTimer = setTimeout(_s3SaveOutline, 1500);
    }
  });

  /* slotKey 変更時：選択 slot の評価値を value 入力に自動転記 ── */
  document.addEventListener('change', function(e) {
    if (e.target.classList && e.target.classList.contains('s3-slot-key')) {
      const idx = parseInt(e.target.dataset.idx, 10);
      const newKey = e.target.value;
      const m = window.APP.modules?.[window.APP.activeTab];
      if (!m || !newKey) return;
      const ev = (m._evalSlots || []).find(function(s) { return s.key === newKey; });
      if (!ev) return;
      if (ev.value !== undefined) {
        const valEl = document.querySelector('.s3-slot-value[data-idx="' + idx + '"]');
        if (valEl) valEl.value = ev.value;
      }
      _s3SaveCurrent();
    }
  });
  /* reaction: コメント追加 */
  window.s3AddComment = function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    if (!Array.isArray(m.comments)) m.comments = [];
    m.comments.push({ text: '', score: 0 });
    s3RenderEditor();
  };

  /* insight: キャッチコピー行追加/削除 */
  window.s3AddPhrase = function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    if (!Array.isArray(m.catchphrases)) m.catchphrases = [];
    m.catchphrases.push('');
    s3RenderEditor();
  };
  window.s3RemovePhrase = function(idx) {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m || !Array.isArray(m.catchphrases)) return;
    if (m.catchphrases.length > 1) m.catchphrases.splice(idx, 1);
    s3RenderEditor();
  };

  /* スロット削除（stats/profile/matchcard/comparison/reaction 共通）*/
  document.addEventListener('click', function(e) {
    const t = e.target;
    if (!t.classList) return;
    const idx = parseInt(t.dataset.idx, 10);
    if (isNaN(idx)) return;
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;

    if (t.classList.contains('s3-slot-remove')) {
      _s3SaveCurrent();
      if (Array.isArray(m.dataSlots) && m.dataSlots.length > 1) {
        m.dataSlots.splice(idx, 1);
        s3RenderEditor();
      }
    } else if (t.classList.contains('s3-cmp-remove')) {
      _s3SaveCurrent();
      if (Array.isArray(m.dataSlots) && m.dataSlots.length > 1) {
        m.dataSlots.splice(idx, 1);
        s3RenderEditor();
      }
    } else if (t.classList.contains('s3-cmt-remove')) {
      _s3SaveCurrent();
      if (Array.isArray(m.comments) && m.comments.length > 1) {
        m.comments.splice(idx, 1);
        s3RenderEditor();
      }
    }
  });

  /* データバインドのみ再生成（populate-module 呼び出し） */
  window.s3PopulateModule = async function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    _s3Msg('&#x1F504; ' + m.title + ' のデータを再生成中...');
    try {
      const d = await fetchJson('/api/populate-module', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post:     window.APP.selected,
          postId:   window.APP.selected?.id,
          siDataIn: window.APP.s3SiData || {},
          module:   m,
        }),
      });
      if (d.ok === false) { _s3Msg('&#x274C; ' + (d.error || '失敗')); return; }
      if (d.note) { _s3Msg(d.note); return; }
      if (d.dataSlots)       m.dataSlots       = d.dataSlots;
      if (d.catchphrases)    m.catchphrases    = d.catchphrases;
      if (d.comments)        m.comments        = d.comments;
      if (d.siBindingLeft)   m.siBindingLeft   = d.siBindingLeft;
      if (d.siBindingRight)  m.siBindingRight  = d.siBindingRight;
      s3RenderEditor();
      _s3Msg('&#x2705; データ更新完了');
    } catch (e) {
      _s3Msg('&#x274C; エラー: ' + e.message);
    }
  };

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
    btn.textContent = '⏳ 保存中...';
    _s3Msg('モジュールを保存中...');

    try {
      /* モジュール保存 */
      await fetchJson('/api/save-modules', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId, modules: window.APP.modules }),
      });

      /* 画像取得は Step4 完了後に「裏」として別途実装するため、ここでは行わない */
      _s3Msg('✅ モジュール確定！ Step4 へ遷移します...');

      /* Step4 に遷移（window.APP.modules は既に保持済み → step4Init が引き継ぐ）*/
      setTimeout(function() { window.goStep(4); }, 300);
    } catch(e) {
      _s3Msg('❌ 失敗: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🎬 モジュール確定 → Step4 へ';
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
