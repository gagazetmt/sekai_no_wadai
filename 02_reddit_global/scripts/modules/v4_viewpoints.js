// scripts/modules/v4_viewpoints.js
// 企画ピース生成: ネタブック → 12〜18枚の視点カード
// V4パイプライン用。v4_neta.js の buildNetaBook() 出力をそのまま受け取る
'use strict';

const path = require('path');
const fs   = require('fs');
const { callAI } = require('../ai_client');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const VP_DIR   = path.join(DATA_DIR, 'viewpoints');
if (!fs.existsSync(VP_DIR)) fs.mkdirSync(VP_DIR, { recursive: true });

function _clampScore(v, fallback = 50) {
  const n = Number(v);
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : fallback));
}

function _fallbackHookScore(card) {
  const text = [card.title, card.scriptDir, card.dataPreview, ...(card.bullets || [])].join(' ');
  let score = 45;
  if (card.slideType === 'opening') score += 35;
  if (card.slideType === 'insight') score += 12;
  if (card.slideType === 'comparison') score += 10;
  if (card.slideType === 'profile' || card.slideType === 'history' || card.slideType === 'picture') score += 7;
  if (/[0-9０-９]{2,}|年|億|万|€|£|CL|契約|移籍|退団|噂|水面下|ライバル|会長|レアル|マドリー|バルサ|ハーランド|エムバペ/.test(text)) score += 12;
  if ((card.bullets || []).length >= 4) score += 8;
  if (card.confidence === 'high') score += 6;
  if (card.confidence === 'low') score -= 10;
  return _clampScore(score);
}

function _normalizeSubtype(v) {
  const s = String(v || '').trim();
  const allowed = new Set(['shock','strategy','timeline','rumor','fan','money','profile','none']);
  return allowed.has(s) ? s : 'none';
}

const RECIPE_CATALOG = `
player.profile_basic     → type:profile  | 年齢/国籍/所属/ポジション/市場価値/契約
player.fw_match_stats    → type:stats    | ゴール/アシスト/シュート/xG/ドリブル/評定（FW向け）
player.mf_match_stats    → type:stats    | パス成功率/キーパス/タックル/デュエル/評定（MF向け）
player.df_match_stats    → type:stats    | タックル/インターセプト/クリア/評定（DF向け）
player.gk_match_stats    → type:stats    | セーブ/完封/ゴール阻止/評定（GK向け）
player.season_trend5     → type:history  | 過去5シーズン推移（試合数・G・A）
comparison.player_season → type:comparison | 選手間比較（G/A/評定/xG/キーパス）
team.season_overall      → type:stats    | チーム今季成績（順位/勝点/勝敗/得失点）
match.scoreboard         → type:matchcard | スコア/ゴール/スタッツ/フォーメーション
`.trim();

// ── ネタブック → プロンプト素材の変換 ──
function _buildEntityBlock(book) {
  const rows = book.fetchedData || [];
  if (!rows.length) return '(エンティティデータなし)';

  const byEntity = {};
  for (const row of rows) {
    const e = row.entity || '不明';
    if (!byEntity[e]) byEntity[e] = [];
    byEntity[e].push(row);
  }

  return Object.entries(byEntity).map(([entity, items]) => {
    const slots = items.slice(0, 18)
      .map(r => `${r.label}:${r.value}`)
      .join(' / ');
    const sources = [...new Set(items.map(r => r.source))].join(',');
    return `### ${entity} [${sources}]\nスロット値: ${slots}`;
  }).join('\n\n');
}

function _buildArticleBlock(book) {
  const articles = book.articles || [];
  if (!articles.length) return '(記事なし)';
  return articles.slice(0, 5).map((a, i) =>
    `${i + 1}. [${a.host || '?'}] ${a.title || ''}`
  ).join('\n');
}

function _buildCommentBlock(book) {
  const lines = [];
  const c1 = book.comments1;
  const c2 = book.comments2;
  if (Array.isArray(c1) && c1.length) {
    lines.push(`【${book.commentAngle1 || 'コメント①'}】`);
    c1.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  }
  if (Array.isArray(c2) && c2.length) {
    lines.push(`【${book.commentAngle2 || 'コメント②'}】`);
    c2.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  }
  return lines.length ? lines.join('\n') : '';
}

function _buildSupplementBlock(book) {
  const parts = [];
  for (const sfx of ['1', '2']) {
    const type  = book[`supplement${sfx}Type`];
    const title = book[`supplement${sfx}Title`];
    const data  = book[`supplement${sfx}Data`];
    const text  = book[`supplement${sfx}`];
    if (!type && !text) continue;
    const header = `補足${sfx}: ${title || '(見出しなし)'} [型:${type || '?'}]`;
    const body = text ? text.slice(0, 200) : '';
    const dataStr = data ? JSON.stringify(data).slice(0, 200) : '';
    parts.push([header, body, dataStr ? `data: ${dataStr}` : ''].filter(Boolean).join('\n'));
  }
  return parts.length ? parts.join('\n\n') : '(補足なし)';
}

// ── メイン: 企画ピース生成 ──
async function generateViewpoints(book, opts = {}) {
  if (!book || !book.topic) throw new Error('ネタブックが未指定');

  const braveAnswer = opts.braveAnswer || null;
  const hasComments = Boolean(
    (book.comments1 && book.comments1.length) ||
    (book.comments2 && book.comments2.length)
  );

  const entityBlock    = _buildEntityBlock(book);
  const articleBlock    = _buildArticleBlock(book);
  const commentBlock   = _buildCommentBlock(book);
  const supplementBlock = _buildSupplementBlock(book);

  const overviewCatchphrases = Array.isArray(book.overviewData?.catchphrases)
    ? book.overviewData.catchphrases.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '';

  const braveBlock = braveAnswer
    ? `【AI検索要約（BraveAnswer）】\n${String(braveAnswer).slice(0, 1500)}`
    : '';

  const matchDataBlock = (() => {
    const md = book.supplement1Data?.matchData || book.supplement2Data?.matchData || book.supplementData?.matchData;
    if (!md) return '';
    const lines = [`【試合データ】`];
    if (md.scoreline) lines.push(`スコア: ${md.scoreline}`);
    if (md.tournament) lines.push(`大会: ${md.tournament}`);
    if (md.formations) lines.push(`フォーメーション: ${md.formations.home || '?'} vs ${md.formations.away || '?'}`);
    if (md.topPlayers?.length) {
      lines.push('トップ選手: ' + md.topPlayers.map(p => `${p.name}(${p.rating})`).join(', '));
    }
    if (md.goals?.length) {
      lines.push('ゴール: ' + md.goals.map(g => `${g.timeStr} ${g.player}(${g.team})`).join(', '));
    }
    const stats = md.stats || {};
    const statLines = Object.entries(stats).slice(0, 8)
      .map(([k, v]) => `${k}: ${v.home}-${v.away}`);
    if (statLines.length) lines.push('主要スタッツ: ' + statLines.join(' / '));
    return lines.join('\n');
  })();

  const prompt = `あなたはサッカーYouTube動画の構成エキスパートです。
以下の案件データから、ユーザーが企画書に組み込む「企画ピース」を12〜18枚生成してください。

各ピースは独立した1スライドを表します。ユーザーが好きなピースを選んで動画を組み立てます。
だから多様な視点を網羅し、短尺（4〜5枚）でも長尺（8〜10枚）でも使えるように設計する。

【案件タイトル】
${book.title || book.topic}

【概要（ネタブック）】
${book.overview || '(なし)'}

${overviewCatchphrases ? `【キャッチフレーズ（概要の論点）】\n${overviewCatchphrases}\n` : ''}

【ネタブック補足情報】
${supplementBlock}

${braveBlock ? braveBlock + '\n' : ''}
${matchDataBlock ? matchDataBlock + '\n' : ''}

${hasComments ? `【コメント素材（reaction カード用）】\n${commentBlock}\n` : ''}

【取得済みエンティティデータ（これが confidence:high の根拠）】
${entityBlock}

【関連記事】
${articleBlock}

【利用可能レシピ一覧】
${RECIPE_CATALOG}

【生成ルール（厳守）】
1. opening を必ず1枚目に（固定・選択解除不可）
2. ending を必ず最後に（固定・選択解除不可）
3. ${hasComments ? 'コメント素材があるので reaction カードを1〜2枚生成する' : 'コメント素材がないので reaction カードは生成しない'}
4. confidence:
   - high  → FotMob/SofaScore/Transfermarkt/Wikipedia で確認済みのデータ
   - medium → 記事のみ確認（数値データ未確認）
   - low   → 記事にも言及なし・推測
5. stats/profile/timeline/history の recipeKey → 取得済みエンティティデータにある人物のみ指定。それ以外は null
6. 1エンティティに対して複数カードを出してよい（プロフィール・スタッツ・シーズン推移など）
7. insight を出す前に、profile / stats / history / picture で視覚化できないか必ず検討する
8. 人物が中心なら profile を優先する。選手だけでなく会長・代理人・監督も profile 可
8b. timeline と history の使い分け:
    - timeline → 数値の推移・折れ線グラフ系（市場価値推移・順位変動・得点ペースなど）
    - history  → 出来事の時系列・年表（事件経緯・移籍歴・キャリア年表など）
9. 契約条項・市場価値・年齢・所属・契約年数など、人物に紐づく固定情報は profile/stats を優先する
10. insight は「その他」ではない。明確な結論・皮肉・伏線・違和感だけに使う
11. insight は必ず bullets を4〜6個入れる。各 bullet はテロップに使える短い日本語フレーズにする
12. 未確定情報は「報道」「噂」「可能性」と明示する
13. 12〜18枚のうち insight は最大4枚まで
14. scriptDir は30〜60字で具体的な数字・時期・固有名のどれかを含めて書く
15. id は英小文字・アンダースコアのみ
16. 各カードに hookScore を0〜100で付ける
17. hookScore 80以上は冒頭候補、70以上は量産モードで優先。普通の説明カードは50〜65
18. insight には insightSubtype を付ける: shock / strategy / timeline / rumor / fan / money / profile
19. 画面変化のため、insight が続く論点は profile/history/picture に降格できないか再判定する
${matchDataBlock ? '20. 試合データがある場合、matchcard カードを必ず1枚入れる（スコア・ゴール・スタッツ表示用）' : ''}

【出力（JSONのみ。コードブロック・説明文一切不要）】
{
  "briefing": {
    "hookQuestion": "視聴者が最初に抱く疑問・驚き（30〜60字）",
    "angle": "この動画独自の切り口（20〜40字）",
    "answer": "動画を見終えた視聴者に残る結論（30〜60字）",
    "storyPattern": "物語の流れ型（例: 個人の試練→背景の構造→問いかけ）"
  },
  "cards":[
  {"id":"opening","title":"動画冒頭フック","slideType":"opening","mainKey":"opening","secondary":null,"recipeKey":null,"dataSource":"","dataPreview":"","scriptDir":"タイトルで視聴者を掴む","confidence":"high","hookScore":90,"insightSubtype":"none","bullets":[]},
  {"id":"sample_stats","title":"今季スタッツ","slideType":"stats","mainKey":"entity:選手名","secondary":null,"recipeKey":"player.fw_match_stats","dataSource":"fotmob:選手名","dataPreview":"G32 A7 評8.1 出場31試合","scriptDir":"今季G32・A7・評8.1の数字で存在感を可視化","confidence":"high","hookScore":72,"insightSubtype":"none","bullets":[]},
  ...
  {"id":"ending","title":"締め・問いかけ","slideType":"ending","mainKey":"ending","secondary":null,"recipeKey":null,"dataSource":"","dataPreview":"","scriptDir":"視聴者への投げかけと登録誘導","confidence":"high","hookScore":55,"insightSubtype":"none","bullets":[]}
]}`;

  let raw;
  try {
    raw = await callAI({
      forceProvider: 'anthropic',
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      label: 'v4-viewpoints',
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    console.warn(`[v4_viewpoints] Anthropic失敗 (${e.message?.slice(0, 80)}) → DeepSeekフォールバック`);
    raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-chat',
      max_tokens: 8000,
      label: 'v4-viewpoints-fallback',
      messages: [{ role: 'user', content: prompt }],
    });
  }

  let parsed = null;
  try {
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (_) {
    try {
      const cardMatches = [...(raw || '').matchAll(/\{[^{}]*"slideType"[^{}]*\}/g)];
      if (cardMatches.length) {
        parsed = { cards: cardMatches.map(m => { try { return JSON.parse(m[0]); } catch(_) { return null; } }).filter(Boolean) };
      }
    } catch (_2) {}
  }

  if (!parsed?.cards?.length) {
    throw new Error('企画ピース生成失敗: ' + String(raw || '').slice(0, 400));
  }

  const rawBriefing = parsed.briefing || {};
  const briefing = {
    hookQuestion: String(rawBriefing.hookQuestion || '').slice(0, 120),
    angle:        String(rawBriefing.angle        || '').slice(0, 80),
    answer:       String(rawBriefing.answer       || '').slice(0, 120),
    storyPattern: String(rawBriefing.storyPattern || '').slice(0, 80),
  };

  const VALID_TYPES = new Set(['opening','ending','stats','profile','comparison','history',
                                'insight','reaction','timeline','matchcard','ranking','picture']);

  let cards = parsed.cards
    .filter(c => c && c.id && VALID_TYPES.has(c.slideType))
    .map(c => ({
      id:          String(c.id).replace(/[^a-z0-9_]/g, '_').slice(0, 60),
      title:       String(c.title || '').slice(0, 40),
      slideType:   c.slideType,
      mainKey:     String(c.mainKey || '').slice(0, 100),
      secondary:   c.secondary ? String(c.secondary).slice(0, 80) : null,
      recipeKey:   c.recipeKey || null,
      dataSource:  String(c.dataSource || '').slice(0, 80),
      dataPreview: String(c.dataPreview || '').slice(0, 120),
      scriptDir:   String(c.scriptDir || '').slice(0, 120),
      confidence:  ['high','medium','low'].includes(c.confidence) ? c.confidence : 'medium',
      hookScore:   _clampScore(c.hookScore, 0),
      insightSubtype: c.slideType === 'insight' ? _normalizeSubtype(c.insightSubtype) : 'none',
      bullets:     Array.isArray(c.bullets) ? c.bullets.filter(Boolean).slice(0, 6).map(b => String(b).slice(0, 60)) : [],
    }))
    .map(c => ({ ...c, hookScore: c.hookScore > 0 ? c.hookScore : _fallbackHookScore(c) }));

  const openings = cards.filter(c => c.slideType === 'opening');
  const endings  = cards.filter(c => c.slideType === 'ending');
  let middles  = cards.filter(c => c.slideType !== 'opening' && c.slideType !== 'ending');

  const insightSeen = new Set();
  middles = middles
    .sort((a, b) => (b.hookScore || 0) - (a.hookScore || 0))
    .filter(c => {
      if (c.slideType !== 'insight') return true;
      const key = (c.insightSubtype || 'none') + ':' + (c.mainKey || c.title || '');
      if (insightSeen.has(key)) return false;
      insightSeen.add(key);
      return true;
    });

  const visualTypes = new Set(['profile','history','timeline','picture','stats','comparison','matchcard']);
  const insights = middles.filter(c => c.slideType === 'insight').slice(0, 4);
  const visuals  = middles.filter(c => c.slideType !== 'insight' && visualTypes.has(c.slideType));
  const others   = middles.filter(c => c.slideType !== 'insight' && !visualTypes.has(c.slideType));
  middles = [];
  const maxLen = Math.max(insights.length, visuals.length, others.length);
  for (let i = 0; i < maxLen; i++) {
    if (visuals[i]) middles.push(visuals[i]);
    if (insights[i]) middles.push(insights[i]);
    if (others[i]) middles.push(others[i]);
  }

  if (!openings.length) openings.push({
    id:'opening', title:'動画冒頭フック', slideType:'opening', mainKey:'opening',
    secondary:null, recipeKey:null, dataSource:'', dataPreview:'', scriptDir:'タイトルでフック',
    confidence:'high', hookScore:90, insightSubtype:'none', bullets:[],
  });
  if (!endings.length) endings.push({
    id:'ending', title:'締め・問いかけ', slideType:'ending', mainKey:'ending',
    secondary:null, recipeKey:null, dataSource:'', dataPreview:'', scriptDir:'視聴者への投げかけと登録誘導',
    confidence:'high', hookScore:55, insightSubtype:'none', bullets:[],
  });

  const finalCards = [
    { ...openings[0], hookScore: Math.max(openings[0].hookScore || 0, 85) },
    ...middles.slice(0, 16),
    endings[0],
  ];

  const result = { cards: finalCards, briefing };

  // 保存
  const safeId = String(book.topic || '').replace(/[^\w぀-ゟ゠-ヿ一-鿿]+/g, '_').slice(0, 40);
  const fname  = `vp_${safeId}_${Date.now()}.json`;
  const outPath = path.join(VP_DIR, fname);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`[v4_viewpoints] 保存: ${outPath} (${finalCards.length}枚)`);

  return result;
}

// ── フルパイプライン: topic → ネタブック → 企画ピース ──
async function buildViewpointsFromTopic(topicData, opts = {}) {
  const { buildNetaBook } = require('./v4_neta');
  const { fetchBraveAnswer } = require('./fetchers/brave_search_module');

  console.log(`[v4_viewpoints] パイプライン開始: ${topicData.topic}`);

  // ① ネタブック生成（記事取得 + AI生成 + fetchBookAssets 含む）
  const book = await buildNetaBook(topicData, { force: opts.force || false });

  // ② BraveAnswer で追加要約（オプション）
  let braveAnswer = null;
  if (opts.useBraveAnswer !== false) {
    const systemPrompt = `あなたはサッカー専門のアナリストです。以下の検索結果を元に、このトピックを多角的に分析してください。
視点ごとに200字程度のまとめを作ってください。視点は10〜15個提案してください。
各視点には「なぜ重要か」「数字の根拠」「今後の展望」を含めてください。`;

    try {
      const res = await fetchBraveAnswer(
        `${book.mainEntity || topicData.topic} サッカー 最新`,
        'ja',
        { system: systemPrompt, timeout: 45000 }
      );
      if (res.ok && res.answer) {
        braveAnswer = res.answer;
        console.log(`[v4_viewpoints] BraveAnswer: ${res.answer.length}字`);
      }
    } catch (e) {
      console.warn(`[v4_viewpoints] BraveAnswer 失敗（続行）: ${e.message}`);
    }
  }

  // ③ 企画ピース生成
  const result = await generateViewpoints(book, { braveAnswer });
  console.log(`[v4_viewpoints] 完了: ${result.cards.length}枚 | hook: ${result.briefing.hookQuestion.slice(0, 40)}`);

  return { book, viewpoints: result };
}

module.exports = {
  generateViewpoints,
  buildViewpointsFromTopic,
};

// ── CLI テスト ──
if (require.main === module) {
  const topic = process.argv[2] || 'カゼミーロ、インテル・マイアミ移籍決定';
  buildViewpointsFromTopic({ topic }).then(({ book, viewpoints }) => {
    console.log('\n=== 企画ピース ===');
    console.log('ブリーフィング:', JSON.stringify(viewpoints.briefing, null, 2));
    console.log(`\nカード ${viewpoints.cards.length}枚:`);
    for (const c of viewpoints.cards) {
      console.log(`  [${c.hookScore}] ${c.slideType.padEnd(11)} ${c.title} → ${c.scriptDir}`);
    }
  }).catch(console.error);
}
