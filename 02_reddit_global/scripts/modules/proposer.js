// scripts/modules/proposer.js
// 案件タイトルと概要から、最適な構成（モジュール一覧）をDeepSeekに提案させる

const { callAI } = require('../ai_client');

async function proposeModules(post) {
  const title    = post._meta?.threadTitle || post.youtubeTitle || post.catchLine1 || '';
  const overview = (post.overviewNarration || '').slice(0, 400);

  const prompt = `あなたはサッカーYouTubeチャンネル「速報!サッカーニュース」の構成ディレクターです。
以下のサッカーニュース案件を分析し、視聴者が最も興味を引くような4〜6個のスライド構成（モジュール）を提案してください。

案件タイトル: ${title}
ニュース概要: ${overview}

【モジュールIDの一覧（用途に合わせて選択）】
- "news_overview": ニュースの全体概要（必須・1番目）
- "player_profile": 選手の基本プロフィール（来歴・国籍・身長・市場価値等）
- "player_stats": 選手の今季詳細成績（ゴール・アシスト・評価点等）
- "player_comparison": 選手同士の成績比較
- "club_profile": クラブの基本情報（歴史・本拠地・タイトル数等）
- "club_current_season": クラブの今季成績（順位・直近勝敗・得失点等）
- "manager_profile": 監督の情報（戦術・経歴・勝率等）
- "tactical_analysis": 戦術分析（フォーメーション・xG・ポゼッション等）
- "transfer_news": 移籍決定ニュース（移籍金・契約年数等）
- "transfer_rumor": 移籍の噂（可能性・競合クラブ・市場価値等）
- "injury_news": 選手のケガ・離脱情報（部位・離脱期間・復帰予定等）
- "reddit_reaction": 海外掲示板（Reddit）の反応（必須）
- "custom_research": 上記にない独自の調査（クエリ指定）

【スライド型の選択肢】
各モジュールには以下のスライド型を割り当てること:
- "reaction" : リアクション（コメント吹き出し読み上げ）→ reddit/SNS/5ch反応モジュール
- "insight"  : インサイト解説（調査・分析・深掘り・テキスト説明系全般）→ news_overviewにも使用
- "stats"    : スタッツ＋フォーメーション（試合データ・戦術ボード）→ 試合系モジュール必須
- "type1"    : プロフィール型（左に大画像・右にデータ行リスト）→ 選手・監督プロフィール向け
- "type2"    : トピック型（左にデータ行リスト・右に大画像）→ クラブ・移籍・ケガ・汎用情報向け
- "type3"    : プロフィールV2（カードグリッド形式。最初の項目が強調される）→ 特に強調したい記録や多項目のスタッツがある場合
- "type4"    : 対比型（左右の数値を比較するレイアウト）→ 選手同士やチーム同士の成績比較向け
※ "simple" は廃止。テキスト系はすべて "insight" を使うこと。

【paramsのキー一覧（★★必ず正しいキー名を使うこと★★）】
- playerNameEn  : 選手名（英語・必ず1人だけ）例 "Erling Haaland" ※複数人は別モジュールに分ける
- clubNameEn    : クラブ名（英語）例 "Real Madrid", "FC Barcelona"
- clubName      : SofaScore用クラブ名（英語、clubNameEnと同じ値でOK）
- homeTeam      : ホームチーム名（英語）例 "Arsenal"
- awayTeam      : アウェイチーム名（英語）例 "Chelsea"
- managerName   : 監督名（英語）例 "Pep Guardiola"
- rivalClubNameEn: ライバルクラブ名（英語）
- leagueName    : リーグ名（英語）例 "Premier League"
- searchQuery   : 検索クエリ（英語15語以内）
- customQuery   : カスタム調査クエリ（英語15語以内）

【提案ルール】
1. "news_overview"（ニュース概要）は必ず1番目に含める。slideType は "insight"
2. "reddit_reaction"（海外の反応）は必ず含める
3. topicTypeが "match" の場合、必ず "stats" slideTypeのモジュール（match_stats等）を含める
4. 必ず主役（選手・クラブ・監督）を掘り下げるモジュールを1つ以上含める
   - 選手が主役 → player_profile か player_stats（slideType: "type1" or "type3"）
   - クラブが主役 → club_current_season か club_profile（slideType: "type2"）
   - 監督が主役 → manager_profile（slideType: "type1"）
5. 合計4〜6モジュール（4〜5分の動画になる量）
6. ★★★paramsの値は全て英語★★★（絶対に日本語・カタカナを入れない）
   - 選手名は公式英語表記（例: "Erling Haaland"、"Bukayo Saka"）
   - クラブ名は正式英語表記（例: "Arsenal"、"Real Madrid"）
7. 視聴者が「知らなかった！」と感じる情報を含むモジュールを優先
8. slideTypeが "type1", "type2", "type3", "type4" の場合、statsRowsは不要（システムが自動入力する）

返却はJSONのみ（前後の説明文は不要）:
{
  "topicSummary": "この案件を20字以内で（日本語）",
  "topicType": "player | club | match | transfer | injury | record | other",
  "entities": [
    {"type": "player", "nameEn": "登場する選手の英語名"},
    {"type": "team",   "nameEn": "登場するクラブの英語名"}
  ],
  "modules": [
    {
      "id": "モジュールID",
      "slideType": "reaction | insight | stats | type1 | type2 | type3 | type4",
      "reason": "このモジュールを選んだ理由（日本語30字以内）",
      "params": {
        "playerNameEn": "Erling Haaland"
      }
    }
  ]
}
※ entities: type は "player" か "team" のみ（監督・大会は不要）。最大5件。SofaScoreで検索できる固有名詞のみ。英語必須`;

  const raw = await callAI({
    model:      'deepseek-chat',
    max_tokens: 2000,
    messages:   [{ role: 'user', content: prompt }],
    system:     'サッカー専門のYouTubeディレクターです。JSONのみを返します。',
  });

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI提案のJSON取得失敗');
  const result = JSON.parse(m[0]);
  
  // opening / ending を強制追加
  result.modules.unshift({ id: 'opening', slideType: 'opening', reason: 'タイトルコール' });
  result.modules.push({ id: 'ending', slideType: 'ending', reason: 'エンディング' });

  return result;
}

module.exports = { proposeModules };
