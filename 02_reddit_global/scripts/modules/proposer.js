// scripts/modules/proposer.js
// v2: DeepSeekが案件を分析してモジュール候補を3〜6個提案する

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const { callAI }             = require('../ai_client');
const { MODULE_TYPES }       = require('./definitions');

// モジュール一覧テキスト（プロンプト埋め込み用）
const MODULE_LIST_TEXT = Object.values(MODULE_TYPES)
  .map(m => `  - ${m.id}: 「${m.label}」— ${m.description}`)
  .join('\n');

async function proposeModules(post) {
  const title    = post._meta?.threadTitle || post.youtubeTitle || post.catchLine1 || '';
  const type     = post.type || 'topic';
  const overview = (post.overviewNarration || '').slice(0, 500);

  // コメントは reddit / X / slide3 のいずれかから取得
  const redditCmts  = post._rawComments?.reddit || [];
  const xCmts       = post._rawComments?.x       || [];
  const slide3Cmts  = (post.slide3?.comments || []).map(c => c.text || '');
  const allCmts     = [...redditCmts, ...xCmts, ...slide3Cmts];
  const numCmts     = allCmts.length;
  const cmtSample   = allCmts
    .slice(0, 6)
    .map(c => `  - ${(typeof c === 'string' ? c : c.text || '').slice(0, 100)}`)
    .join('\n');

  const prompt = `あなたはサッカーYouTubeチャンネルのコンテンツプランナーです。
以下のニュース案件を分析し、4〜5分の動画に最適なモジュール構成を提案してください。

【案件情報】
タイトル（英）: ${title}
タイプ: ${type}
コメント数: ${numCmts}
概要: ${overview}

【海外コメント抜粋】
${cmtSample || '（なし）'}

【選択できるモジュール一覧】
${MODULE_LIST_TEXT}

【スライド型の選択肢】
各モジュールには以下のスライド型を割り当てること:
- "story"    : ナレーション＋背景画像（テキスト中心の解説）
- "reaction" : コメント吹き出し読み上げ（reddit/SNS反応）
- "insight"  : インサイト解説（調査・分析）
- "stats"    : 数値バーン表示（単一の大きな数字・記録）
- "type1"    : プロフィール型（左に大画像、右にデータ行リスト）→ 選手・監督・クラブ・移籍情報向け
- "type2"    : トピック型（左にデータ行リスト、右に大画像）→ ケガ・話題・汎用的な情報向け

【提案ルール】
1. "news_overview"（ニュース概要）は必ず1番目に含める
2. "reddit_reaction"（海外の反応）は必ず含める
3. トピックの主役が「選手」なら player_* 系、「クラブ」なら club_* 系を優先
4. 合計3〜6モジュール（4〜5分の動画になる量）
5. requiredParams の値は必ず英語で設定すること（絶対に日本語を入れない）
   - 選手名は公式英語表記（例: "Erling Haaland"、"Bukayo Saka"）
   - 日本人選手も英語表記（例: 大迫敬介→"Keisuke Osako"、三笘薫→"Kaoru Mitoma"）
   - クラブ名は正式英語表記（例: "Arsenal F.C."、"Real Madrid"、"Dinamo Zagreb"）
   - searchQuery は英語15語以内
6. 視聴者が「知らなかった！」と感じる情報を含むモジュールを優先
7. slideTypeが "type1" か "type2" の場合は必ず "statsRows" を指定すること
   - statsRowsの各行はlabelのみ記載（valueはSerperが調査して埋める）
   - 行数は内容に応じて2〜8行で自由に決める
   - labelは「何を調べるか」が明確に分かる具体的な日本語で書く

返却はJSONのみ（前後の説明文は不要）:
{
  "topicSummary": "この案件を20字以内で（日本語）",
  "topicType": "player | club | match | transfer | injury | record | other",
  "modules": [
    {
      "id": "モジュールID",
      "slideType": "story | reaction | insight | stats | type1 | type2",
      "reason": "このモジュールを選んだ理由（日本語30字以内）",
      "params": {
        "playerNameEn": "...",
        "searchQuery": "..."
      },
      "statsRows": [
        { "label": "調べる項目名（例: 2022年カタール大会 放映権料）" },
        { "label": "調べる項目名" }
      ]
    }
  ]
}
※ statsRowsはslideTypeがtype1かtype2の時のみ含める`;

  const raw = await callAI({
    model:      'deepseek-chat',
    max_tokens: 1200,
    messages:   [{ role: 'user', content: prompt }],
    system:     'あなたはサッカーYouTubeのコンテンツプランナーです。JSONのみを返します。',
  });

  // JSON を抽出（前後の余分なテキストを除去）
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('モジュール提案JSONが取得できませんでした:\n' + raw.slice(0, 300));

  let result;
  try {
    result = JSON.parse(match[0]);
  } catch (e) {
    throw new Error('モジュール提案JSONのパースに失敗: ' + e.message);
  }

  // モジュール定義情報をマージ
  const enrichedMiddle = (result.modules || [])
    .map(mod => {
      // opening/endingはDeepSeekに提案させない（後で自動付与）
      if (mod.id === 'opening' || mod.id === 'ending') return null;

      const def = MODULE_TYPES[mod.id];
      if (!def) {
        console.warn(`[proposer] 未定義のモジュールID: ${mod.id} をスキップ`);
        return null;
      }

      // reddit_reaction: 実コメントが3件未満なら除外
      if (mod.id === 'reddit_reaction' && redditCmts.length < 3) {
        console.log(`[proposer] reddit_reaction スキップ（実コメント${redditCmts.length}件）`);
        return null;
      }

      // paramsのundefined値をフィルタ（"undefined"文字列も除去）
      const cleanParams = Object.fromEntries(
        Object.entries(mod.params || {}).filter(([, v]) => v && v !== 'undefined')
      );

      const built = {
        ...def,
        reason:   mod.reason   || '',
        params:   cleanParams,
        selected: true,
      };
      if (mod.slideType) built.slideType = mod.slideType;
      if (mod.statsRows?.length) built.statsRows = mod.statsRows;
      return built;
    })
    .filter(Boolean);

  // opening を先頭、ending を末尾に必ず付与
  const openingMod = { ...MODULE_TYPES['opening'], params: {}, selected: true, reason: '固定' };
  const endingMod  = { ...MODULE_TYPES['ending'],  params: {}, selected: true, reason: '固定' };

  return {
    topicSummary:  result.topicSummary || '',
    topicType:     result.topicType    || 'other',
    hasRealReddit: redditCmts.length >= 3,
    modules:       [openingMod, ...enrichedMiddle, endingMod],
  };
}

module.exports = { proposeModules };
