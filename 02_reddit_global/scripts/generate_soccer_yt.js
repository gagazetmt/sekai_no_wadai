// generate_soccer_yt.js
// サッカー YouTube 横型動画コンテンツ生成
//
// 【フロー】
//   ① Reddit ポストマッチスレッドを検索
//   ② Claude で試合データ抽出（スコア・得点者など）
//   ③ Reddit から試合画像を3枚取得（メイン画像 + S3/S4用）
//   ④ Claude で soccer_yt_content JSON を生成（5スライド新フォーマット）
//   ⑤ temp/soccer_yt_content_YYYY-MM-DD.json に保存
//
// 使い方: node generate_soccer_yt.js [yyyy-mm-dd]
// 例:     node generate_soccer_yt.js 2026-03-21

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { fetchMatchImages } = require("./fetch_match_images");

const client = new Anthropic();

const TEMP_DIR = path.join(__dirname, "..", "temp");
const IMG_DIR  = path.join(__dirname, "..", "images");
[TEMP_DIR, IMG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const today     = process.argv[2] || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const OUTPUT_FILE = path.join(TEMP_DIR, `soccer_yt_content_${today}.json`);

const LEAGUE_KEYWORDS = [
  "Premier League", "La Liga", "Bundesliga", "Ligue 1", "Serie A",
  "Champions League", "Europa League", "Conference League",
  "World Cup", "FA Cup", "Copa del Rey",
];

// ─── Reddit 検索 ───────────────────────────────────────────────────────────────
async function searchReddit(subreddit, query) {
  const url =
    `https://www.reddit.com/r/${subreddit}/search.json?` +
    `q=${encodeURIComponent(query)}&sort=relevance&restrict_sr=true&limit=25&t=month`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "soccer-news-bot/1.0" } });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data?.children || []).map(c => ({
      title:       c.data.title,
      score:       c.data.score,
      url:         `https://www.reddit.com${c.data.permalink}`,
      permalink:   c.data.permalink,
      selftext:    c.data.selftext || "",
      numComments: c.data.num_comments,
      subreddit,
    }));
  } catch (e) {
    console.warn(`⚠️  r/${subreddit} 検索失敗: ${e.message}`);
    return [];
  }
}

// ─── スレッドのコメント取得 ────────────────────────────────────────────────────
async function fetchThreadComments(permalink) {
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=50&depth=1`;
    const res = await fetch(url, { headers: { "User-Agent": "soccer-news-bot/1.0" } });
    if (!res.ok) return [];
    const json = await res.json();
    return (json[1]?.data?.children || [])
      .filter(c => c.kind === "t1" && c.data.score > 5)
      .sort((a, b) => b.data.score - a.data.score)
      .slice(0, 15)
      .map(c => `[👍${c.data.score}] ${c.data.body?.slice(0, 200)}`);
  } catch {
    return [];
  }
}

// ─── ポストマッチスレッド判定 ─────────────────────────────────────────────────
function isPostMatchThread(title) {
  const lower = title.toLowerCase();
  const isPost = lower.includes("post match thread") || lower.includes("post-match thread");
  const hasLeague = LEAGUE_KEYWORDS.some(k => title.includes(k));
  // Konferenz（複数試合まとめ）・2部リーグは除外
  const isKonferenz = lower.includes("konferenz") || lower.includes("simulcast") || lower.includes("2. bundesliga");
  return isPost && hasLeague && !isKonferenz;
}

// ─── Claude: 試合データ抽出 ────────────────────────────────────────────────────
async function extractMatchData(thread, comments) {
  const prompt = `
以下はRedditのサッカー試合スレッドです。構造化データとして抽出してください。

【スレッドタイトル】
${thread.title}

【スレッド本文】
${thread.selftext.slice(0, 1000) || "（本文なし）"}

【上位コメント（英語）】
${comments.slice(0, 10).join("\n")}

以下のJSON形式のみで出力してください。情報がない項目はnullにしてください。
{
  "homeTeam": "ホームチーム名（英語）",
  "awayTeam": "アウェイチーム名（英語）",
  "homeScore": 数字,
  "awayScore": 数字,
  "league": "リーグ名（英語）",
  "leagueJa": "リーグ名（日本語・例：プレミアリーグ）",
  "matchday": "節・ラウンド情報（例：第28節 / ラウンド16 / 決勝）またはnull",
  "isKnockout": true/false,
  "aggregateScore": "2試合制の総合スコア（例：Chelsea 5-7 Arsenal）またはnull",
  "teamThatAdvances": "勝ち抜けチーム名またはnull",
  "goals": [
    {"player": "選手名（英語）", "team": "チーム名（homeTeam/awayTeamと同じ表記）", "minute": 数字, "type": "通常/PK/OG"}
  ],
  "redCards": [{"player": "選手名", "team": "チーム名", "minute": 数字}],
  "matchMood": "EXCITING/SHOCKING/CONTROVERSIAL/DOMINANT/BORING のいずれか"
}
`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("JSONが見つかりません");
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn(`⚠️  データ抽出失敗: ${e.message}`);
    return null;
  }
}

// ─── matchResult オブジェクト構築（generate_soccer_yt_video.js 用） ───────────
function buildMatchResult(matchData) {
  const scorers = (matchData.goals || []).map(g => ({
    team:   g.team === matchData.homeTeam ? "home" : "away",
    player: g.player,
    minute: typeof g.minute === "number" ? g.minute : parseInt(String(g.minute).replace(/\D/g, "")) || 0,
  }));

  return {
    homeTeam:    matchData.homeTeam,
    awayTeam:    matchData.awayTeam,
    homeScore:   matchData.homeScore ?? 0,
    awayScore:   matchData.awayScore ?? 0,
    competition: matchData.leagueJa || matchData.league || "",
    matchday:    matchData.matchday || "",
    date:        today,
    scorers,
  };
}

// ─── Claude: 5スライド用コンテンツ生成 ────────────────────────────────────────
async function generateYtContent(matchData, comments) {
  const goalsText = matchData.goals?.length > 0
    ? matchData.goals.map(g => `${g.minute}分 ${g.player}（${g.team}）${g.type !== "通常" ? `【${g.type}】` : ""}`).join("、")
    : "得点なし";

  const knockoutNote = matchData.isKnockout && matchData.aggregateScore
    ? `\n2試合制ノックアウト: 総合スコア ${matchData.aggregateScore}（${matchData.teamThatAdvances ?? ""}が勝ち抜け）`
    : "";

  // 日本時間表記（試合日）
  const jstDateStr = (() => {
    const d = new Date(today);
    return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（JST）`;
  })();

  const prompt = `
あなたは「リネカ」——20代前半、欧州サッカーに人生を捧げたクリエイティブ・ディレクターです。
Reddit・Xの海外リアクションをリアルタイムで追い、「現地の温度感」を日本語に落とし込むプロ。
以下の試合データと海外コメントをもとに、視聴者が冒頭10秒で離脱できない動画コンテンツを設計してください。

【リネカの制作哲学】
- ナレーションは「隣で一緒に観戦している友達」の口調。体言止め多用、リズム重視
- ナレーションには必ず「大会名・日付・スコア・主要得点者と分数」の事実を盛り込む
- サムネ文字はスマホ縮小表示で0.5秒で刺さるパワーワードのみ
- コメント意訳は「笑い・驚き・共感」のどれかを持たせる。選手や監督への人格攻撃はしない
- 熱量は情熱・感動・驚きで表現する（侮辱や中傷は使わない）
- 締めは「笑い」か「絶望への共感」か「驚きの余韻」で終わらせ、次の動画へ引き込む

【試合データ】
日付: ${jstDateStr}
対戦: ${matchData.homeTeam}（ホーム）vs ${matchData.awayTeam}（アウェイ）
スコア: ${matchData.homeScore} - ${matchData.awayScore}
大会: ${matchData.leagueJa || matchData.league}${knockoutNote}
得点: ${goalsText}
退場: ${matchData.redCards?.length > 0 ? matchData.redCards.map(r => `${r.minute}分 ${r.player}`).join("、") : "なし"}
試合ムード: ${matchData.matchMood || "EXCITING"}

【海外ファンの反応（英語・上位コメント）】
${comments.slice(0, 12).join("\n")}

以下のJSON形式のみで出力してください：
{
  "catchLine1": "サムネイル兼タイトル文（30文字以内・スコアより『事件』を売る・スマホで0.5秒で目が止まるパワーワード必須・例：『古巣ハーヴァーツに刺された夜』『チェルシー、また崩壊』）",
  "label": "【速報】か【衝撃】か【朗報】か【悲報】（試合の感情温度に合わせる）",
  "badge": "サムネのサブバッジ（8文字以内・衝撃ワード・例：完全崩壊 / 歴史的惨敗 / 神展開 / 退団フラグ）",

  "sourceAuthor": "情報元メディア・記者名（例：Fabrizio Romano / Sky Sports / The Athletic / BBC Sport）",
  "sourceText": "試合の核心を切り取ったソーステキスト（日本語・2〜4行・記者や選手の言葉風・改行で読みやすく・例：\nハーヴァーツ、古巣撃破弾。\n\nチェルシーのスタンフォードブリッジが\n静まり返った78分——\n彼は笑っていた。",

  "overviewNarration": "S2読み上げナレーション（80〜120文字・セナ口調・体言止め多用・『試合で一番ヤバかった瞬間』を核心に据える・例：『パーマーが先制するも、サカに同点、そして78分——古巣から来たあの男が、静寂を作り出した。チェルシー、また負けた。』）",
  "overviewTelop": "S2テロップ（25文字以内・スコア＋一言で試合の空気を伝える・例：『Chelsea 1-2 Arsenal｜古巣に刺された夜』）",

  "slide3": {
    "topicTag": "S3右上タグ（12文字以内・※で始まる・海外反応の切り口・例：※守備崩壊への怒り / ※得点者への歓喜）",
    "highlightIdx": 0,
    "narration": "S3ナレーション（60〜90文字・Redditの熱狂を体感させる・笑いか怒りか絶望の温度感を再現・例：『Redditが燃えてる。「また守備が崩壊した」「何億使ってんだ」——チェルシーサポの怒りが止まらない。』）",
    "subtitleBox": "S3字幕（20文字以内・ナレーションの核心ワード）",
    "comments": [
      {"user": "海外ファン名（英語圏っぽい名前）", "text": "笑いか驚きか共感のある意訳（22〜28文字・体言止めOK・例：『また守備が崩壊した件について』・人格攻撃NG）"},
      {"user": "海外ファン名", "text": "22〜28文字"},
      {"user": "海外ファン名", "text": "22〜28文字"},
      {"user": "海外ファン名", "text": "22〜28文字"}
    ]
  },

  "slide4": {
    "topicTag": "S4右上タグ（12文字以内・※で始まる・S3と別角度の切り口・例：※移籍市場への影響 / ※監督解任論）",
    "highlightIdx": 0,
    "narration": "S4ナレーション（60〜90文字・S3と逆サイドの感情・例えばS3が怒りならS4は歓喜・笑い・皮肉で）",
    "subtitleBox": "S4字幕（20文字以内）",
    "comments": [
      {"user": "海外ファン名", "text": "22〜28文字"},
      {"user": "海外ファン名", "text": "22〜28文字"},
      {"user": "海外ファン名", "text": "22〜28文字"},
      {"user": "海外ファン名", "text": "22〜28文字"}
    ]
  },

  "outroNarration": "S5ナレーション（20〜40文字・オチの一言・笑いか諦めか共感で締める・例：『チェルシー、何億使っても勝てないのはなんで？』）",
  "outroTelop": "S5テロップ（18〜28文字・視聴者が思わず笑うか頷く一言・例：『まあ、無理ないですわ』）"
}
`;

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("JSONが見つかりません");
  return JSON.parse(jsonMatch[0]);
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== サッカー YouTube コンテンツ生成 (${today}) ===\n`);

  // 既存ファイルチェック
  if (fs.existsSync(OUTPUT_FILE)) {
    console.log(`✅ ${OUTPUT_FILE} は既に存在します`);
    console.log("   上書きする場合はファイルを削除してから再実行してください");
    return;
  }

  // ① ポストマッチスレッドを検索
  console.log("① Reddit からポストマッチスレッドを検索中...");
  const [soccerPosts, plPosts] = await Promise.all([
    searchReddit("soccer", "post match thread"),
    searchReddit("PremierLeague", "post match thread"),
  ]);

  const allPosts     = [...soccerPosts, ...plPosts];
  const matchThreads = allPosts.filter(p => isPostMatchThread(p.title));

  // 重複除去
  const seen = new Set();
  const uniqueThreads = matchThreads.filter(p => {
    if (seen.has(p.title)) return false;
    seen.add(p.title);
    return true;
  });

  console.log(`   ${uniqueThreads.length}件のポストマッチスレッドを発見\n`);

  if (uniqueThreads.length === 0) {
    console.log("   本日のポストマッチスレッドが見つかりませんでした");
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ date: today, posts: [] }, null, 2));
    return;
  }

  // ② 各スレッドを処理
  const posts = [];

  for (let i = 0; i < uniqueThreads.length; i++) {
    const thread = uniqueThreads[i];
    const num    = i + 1;
    console.log(`▶ [${num}/${uniqueThreads.length}] ${thread.title}`);

    // コメント取得
    process.stdout.write("  コメント取得中... ");
    const comments = await fetchThreadComments(thread.permalink);
    console.log(`${comments.length}件`);

    // 試合データ抽出
    process.stdout.write("  試合データ抽出中... ");
    const matchData = await extractMatchData(thread, comments);
    if (!matchData) { console.log("⚠️ 失敗、スキップ"); continue; }
    console.log(`✅ ${matchData.homeTeam} ${matchData.homeScore}-${matchData.awayScore} ${matchData.awayTeam}`);

    // ③ 複数ソースから試合画像を5〜7枚取得（X公式・Xキーワード・Reddit・動画フレーム）
    console.log("  画像取得中...");
    const imagePrefix = `${today}_${num}`;
    let imagePaths = [];
    try {
      imagePaths = await fetchMatchImages({
        homeTeam:  matchData.homeTeam,
        awayTeam:  matchData.awayTeam,
        matchDate: today,
        saveDir:   IMG_DIR,
        prefix:    imagePrefix,
        verbose:   true,
      });
      console.log(`  画像取得完了: ${imagePaths.length}枚`);
    } catch (e) {
      console.warn(`⚠️ 画像取得失敗: ${e.message}`);
    }

    // ④ コンテンツ生成（5スライドフォーマット）
    process.stdout.write("  コンテンツ生成中... ");
    let ytContent;
    try {
      ytContent = await generateYtContent(matchData, comments);
      console.log("✅");
    } catch (e) {
      console.warn(`⚠️ 失敗: ${e.message}`);
      continue;
    }

    // 画像パスを設定（先頭3枚をスライドに割り当て・全枚数をimagePaths[]に保存）
    const mainImagePath   = imagePaths[0] || null;
    const slide3ImagePath = imagePaths[1] || null;
    const slide4ImagePath = imagePaths[2] || null;

    posts.push({
      num,
      catchLine1:       ytContent.catchLine1,
      label:            ytContent.label,
      badge:            ytContent.badge,
      sourceAuthor:     ytContent.sourceAuthor,
      sourceText:       ytContent.sourceText,
      imagePaths,       // 全取得画像（ランチャーで選択可能）
      mainImagePath,
      slide3ImagePath,
      slide4ImagePath,
      matchResult:      buildMatchResult(matchData),
      overviewNarration: ytContent.overviewNarration,
      overviewTelop:     ytContent.overviewTelop,
      slide3:            ytContent.slide3,
      slide4:            ytContent.slide4,
      outroNarration:    ytContent.outroNarration,
      outroTelop:        ytContent.outroTelop,
      // デバッグ用（動画生成には不要）
      _meta: {
        threadTitle: thread.title,
        redditUrl:   thread.url,
        matchMood:   matchData.matchMood,
      },
    });

    await new Promise(r => setTimeout(r, 800)); // APIレート制限対策
    console.log();
  }

  // ⑤ 保存
  const output = { date: today, posts };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");

  console.log(`\n✅ 完了！${posts.length}試合分を保存`);
  console.log(`   → ${OUTPUT_FILE}`);
  console.log("\n次のステップ:");
  console.log(`   node generate_soccer_yt_video.js ${today}`);
}

main().catch(err => {
  console.error(`\n❌ エラー: ${err.message}`);
  process.exit(1);
});
