// サッカー速報コンテンツ生成スクリプト
// Reddit ポストマッチスレッド → Claude → 2分動画スクリプト
// 使い方: node generate_soccer.js [yyyy-mm-dd]

require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();
const TEMP_DIR = path.join(__dirname, "..", "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// JSTで今日の日付を取得
const now = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const today = process.argv[2] || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const OUTPUT_FILE       = path.join(TEMP_DIR, `soccer_content_${today}.json`);
const VIDEO_CONTENT_FILE = path.join(TEMP_DIR, `soccer_video_content_${today}.json`);

// 対象リーグのキーワード（ポストマッチスレッドを絞り込む）
const LEAGUE_KEYWORDS = [
  "Premier League",
  "La Liga",
  "Bundesliga",
  "Ligue 1",
  "Serie A",
  "Champions League",
  "World Cup",
  "FA Cup",
];

// ─── Reddit検索 ──────────────────────────────────────────────────────────────
function searchReddit(subreddit, query) {
  return new Promise((resolve) => {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: "www.reddit.com",
      path: `/r/${subreddit}/search.json?q=${encodedQuery}&sort=new&restrict_sr=true&limit=25&t=week`,
      headers: { "User-Agent": "soccer-news-bot/1.0" },
    };

    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const posts = (json.data?.children || []).map((c) => ({
            title: c.data.title,
            score: c.data.score,
            url: `https://www.reddit.com${c.data.permalink}`,
            permalink: c.data.permalink,
            selftext: c.data.selftext || "",
            numComments: c.data.num_comments,
            subreddit,
          }));
          resolve(posts);
        } catch (e) {
          console.log(`⚠️  ${subreddit}の検索失敗: ${e.message}`);
          resolve([]);
        }
      });
    }).on("error", () => resolve([]));
  });
}

// ─── スレッドのコメントを取得 ─────────────────────────────────────────────────
function fetchThreadComments(permalink) {
  return new Promise((resolve) => {
    const options = {
      hostname: "www.reddit.com",
      path: `${permalink}.json?limit=50&depth=1`,
      headers: { "User-Agent": "soccer-news-bot/1.0" },
    };

    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const comments = (json[1]?.data?.children || [])
            .filter((c) => c.kind === "t1" && c.data.score > 5)
            .sort((a, b) => b.data.score - a.data.score)
            .slice(0, 15)
            .map((c) => `[👍${c.data.score}] ${c.data.body?.slice(0, 200)}`);
          resolve(comments);
        } catch (e) {
          resolve([]);
        }
      });
    }).on("error", () => resolve([]));
  });
}

// ─── ポストマッチスレッドかどうか判定 ────────────────────────────────────────
function isPostMatchThread(title) {
  const lower = title.toLowerCase();
  // 「Post Match Thread」のみ対象（試合前の「Match Thread」は除外）
  const isPost = lower.includes("post match thread") || lower.includes("post-match thread");
  const hasLeague = LEAGUE_KEYWORDS.some((k) => title.includes(k));
  return isPost && hasLeague;
}

// ─── Claudeでマッチデータを抽出 ──────────────────────────────────────────────
async function extractMatchData(thread, comments) {
  const prompt = `
以下はRedditのサッカー試合スレッドです。構造化データとして抽出してください。

【スレッドタイトル】
${thread.title}

【スレッド本文】
${thread.selftext.slice(0, 1000) || "（本文なし）"}

【上位コメント（英語）】
${comments.slice(0, 10).join("\n")}

【重要】
- タイトルに「on agg.」「agg.」がある場合は2試合制のノックアウトラウンドです
- 例：「Tottenham 3-2 Atlético [5-7 on agg.]」→ 当日はTottenham勝利、しかし総合でAtlético 7-5で勝ち抜け
- 「who advances」「goes through」「eliminated」「knocked out」などのコメントも参考にしてください
- matchOutcomeは「当日の試合」ではなく「最終的な結果（誰が勝ち抜けたか）」を書いてください

以下のJSON形式のみで出力してください。情報がない項目はnullにしてください。
{
  "homeTeam": "ホームチーム名（英語）",
  "awayTeam": "アウェイチーム名（英語）",
  "homeScore": 数字,
  "awayScore": 数字,
  "league": "リーグ名",
  "isKnockout": true/false,
  "aggregateScore": "総合スコア（例：Tottenham 5-7 Atlético）またはnull",
  "teamThatAdvances": "勝ち抜けたチーム名またはnull",
  "goals": [{"player": "選手名", "team": "チーム名", "minute": "時間（例：23'）", "type": "通常/PK/OG"}],
  "redCards": [{"player": "選手名", "team": "チーム名", "minute": "時間"}],
  "possession": {"home": 数字, "away": 数字},
  "shots": {"home": 数字, "away": 数字},
  "keyMoment": "試合の最重要シーン（英語で50文字以内）",
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
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    console.log(`⚠️  データ抽出失敗: ${e.message}`);
    return null;
  }
}

// ─── Claudeで2分動画スクリプト生成 ───────────────────────────────────────────
async function generateVideoScript(matchData, comments, thread) {
  const goalsText = matchData.goals?.length > 0
    ? matchData.goals.map((g) => `${g.minute} ${g.player}（${g.team}）${g.type !== "通常" ? `【${g.type}】` : ""}`).join("、")
    : "得点なし";

  const redCardsText = matchData.redCards?.length > 0
    ? matchData.redCards.map((r) => `${r.minute} ${r.player}（${r.team}）`).join("、")
    : "なし";

  const topComments = comments.slice(0, 8).join("\n");

  // ノックアウト情報
  const knockoutInfo = matchData.isKnockout && matchData.aggregateScore
    ? `\n2試合制ノックアウト: 総合スコア ${matchData.aggregateScore} → ${matchData.teamThatAdvances ?? "不明"} が勝ち抜け`
    : "";

  const prompt = `
あなたは日本のYouTubeチャンネル「サッカー海外速報」のナレーターです。
以下の試合データと海外ファンの反応をもとに、約2分間（400〜500文字）の日本語ナレーション原稿を作成してください。

【試合データ】
対戦: ${matchData.homeTeam} ${matchData.homeScore} - ${matchData.awayScore} ${matchData.awayTeam}
リーグ: ${matchData.league}${knockoutInfo}
得点: ${goalsText}
退場: ${redCardsText}
ポゼッション: ${matchData.possession?.home ?? "?"}% - ${matchData.possession?.away ?? "?"}%
シュート数: ${matchData.shots?.home ?? "?"} - ${matchData.shots?.away ?? "?"}

【重要な文脈】
${matchData.isKnockout && matchData.aggregateScore
  ? `これは2試合制のノックアウトラウンドです。当日の試合結果だけでなく、総合スコアに基づく最終的な勝ち抜けチームを正確に伝えてください。${matchData.teamThatAdvances ? `${matchData.teamThatAdvances}が次のラウンドに進出。` : ""}`
  : "リーグ戦の1試合です。"
}

【海外ファンの反応（英語）】
${topComments}

【ナレーション構成（この順番で）】
1. 冒頭フック（10秒）：「信じられない結末！」など感情を引く一文
2. 試合結果の速報（20秒）：スコア・リーグ名・試合の大枠
3. 得点シーン解説（40秒）：誰が何分にどんなゴールを決めたか、臨場感を持って
4. 退場・議論になったシーン（20秒）：あれば詳しく、なければ試合の流れを補足
5. 海外ファンの本音（30秒）：コメントを参考に「〇〇という声が殺到」など日本語で紹介
6. まとめ（20秒）：今後の注目点・次節への期待

【絶対に守るルール】
- 自然な日本語の話し言葉で書く
- 感情的・臨場感のある表現を使う
- ハッシュタグ・URLは含めない
- 選手名はできるだけカタカナ表記にする

ナレーション原稿のテキストのみを出力してください。タイトル・見出し・「#」記号・番号は一切つけないこと。
`;


  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content[0].text.trim();
}

// ─── 動画用構造化コンテンツ生成（generate_youtube.js 互換フォーマット） ────────
async function generateVideoContent(matchData, script, rawComments) {
  const goalsText = matchData.goals?.length > 0
    ? matchData.goals.map(g => `${g.minute} ${g.player}（${g.team}）`).join("、")
    : "得点なし";
  const redCardsText = matchData.redCards?.length > 0
    ? matchData.redCards.map(r => `${r.minute} ${r.player}（${r.team}）`).join("、")
    : "なし";
  const knockoutNote = matchData.isKnockout && matchData.aggregateScore
    ? `総合スコア: ${matchData.aggregateScore} → ${matchData.teamThatAdvances ?? ""}が勝ち抜け`
    : "";

  const prompt = `
あなたはYouTubeサッカー速報チャンネルの動画ディレクターです。
以下の試合データとナレーション原稿をもとに、動画の4スライド分の構成データを生成してください。

【試合データ】
対戦: ${matchData.homeTeam} ${matchData.homeScore} - ${matchData.awayScore} ${matchData.awayTeam}
リーグ: ${matchData.league}
得点: ${goalsText}
退場: ${redCardsText}
${knockoutNote}

【ナレーション原稿（参考）】
${script.slice(0, 400)}

【海外コメント（英語・上位10件）】
${rawComments.slice(0, 10).join("\n")}

以下のJSON形式のみで出力してください：
{
  "catchLine1": "動画タイトル（30文字以内・スコアと試合の核心を含む・例：トッテナム3-2アトレティコ｜CL総合逆転ならず）",
  "subtitle": "リーグ名（例：UEFAチャンピオンズリーグ）",
  "label": "【速報】か【衝撃】か【朗報】か【悲報】",
  "slides": [
    {
      "narration": "スライド1のナレーション（50〜80文字・フック＋試合結果速報）",
      "subtitleBox": "字幕テキスト（25文字以内・スコアや試合の核心）",
      "comments": [
        {"user": "海外ファン", "text": "英語コメントを日本語に意訳（20〜28文字）"},
        {"user": "サポーター", "text": "日本語意訳（20〜28文字）"}
      ]
    },
    {
      "narration": "スライド2のナレーション（70〜100文字・得点シーン詳細）",
      "subtitleBox": "得点者と時間（25文字以内）",
      "comments": [
        {"user": "海外ファン", "text": "得点に関する反応（20〜28文字）"},
        {"user": "サポーター", "text": "20〜28文字"}
      ]
    },
    {
      "narration": "スライド3のナレーション（70〜100文字・退場/重要場面/試合の流れ）",
      "subtitleBox": "重要場面の一言（25文字以内）",
      "comments": [
        {"user": "海外ファン", "text": "20〜28文字"},
        {"user": "サポーター", "text": "20〜28文字"}
      ]
    },
    {
      "narration": "スライド4のナレーション（60〜80文字・海外ファンの反応まとめ）",
      "subtitleBox": "海外の反応・まとめ（25文字以内）",
      "comments": [
        {"user": "海外ファン", "text": "20〜28文字"},
        {"user": "サポーター", "text": "20〜28文字"},
        {"user": "現地サポ", "text": "20〜28文字"}
      ]
    }
  ],
  "outro": {
    "finalComment": {"user": "海外ファン", "text": "試合を締める一言（20〜35文字・日本語）"}
  }
}
`;

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1));
}

// ─── メイン処理 ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== サッカー速報コンテンツ生成 (${today}) ===\n`);

  // 既存ファイルチェック
  if (fs.existsSync(OUTPUT_FILE)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
    console.log(`✅ 既存ファイルあり: ${existing.matches?.length ?? 0}試合`);

    // soccer_video_content がない場合だけ生成して終了
    if (!fs.existsSync(VIDEO_CONTENT_FILE)) {
      console.log("   soccer_video_content がないので動画用コンテンツを生成します...");
      const videoPosts = [];
      for (let i = 0; i < existing.matches.length; i++) {
        const r = existing.matches[i];
        process.stdout.write(`   [${i + 1}/${existing.matches.length}] ${r.matchData.homeTeam} vs ${r.matchData.awayTeam}... `);
        try {
          const vc = await generateVideoContent(r.matchData, r.script, r.comments);
          videoPosts.push({ num: i + 1, ...vc });
          console.log("✅");
        } catch (e) {
          console.log(`⚠️ 失敗: ${e.message}`);
        }
        await new Promise(res => setTimeout(res, 500));
      }
      fs.writeFileSync(VIDEO_CONTENT_FILE, JSON.stringify({ date: today, posts: videoPosts }, null, 2), "utf8");
      console.log(`   → ${VIDEO_CONTENT_FILE}`);
    } else {
      console.log("   上書きする場合はファイルを削除して再実行してください");
    }
    return;
  }

  // ポストマッチスレッドを検索
  console.log("① Redditからポストマッチスレッドを検索中...");
  const [soccerPosts, plPosts, soccerPosts2] = await Promise.all([
    searchReddit("soccer", "post match"),
    searchReddit("PremierLeague", "post match"),
    searchReddit("soccer", "Post Match Thread Premier League"),
  ]);

  const allPosts = [...soccerPosts, ...plPosts, ...soccerPosts2];
  const matchThreads = allPosts.filter((p) => isPostMatchThread(p.title));

  // 重複除去（タイトルが同じものを除く）
  const seen = new Set();
  const uniqueThreads = matchThreads.filter((p) => {
    if (seen.has(p.title)) return false;
    seen.add(p.title);
    return true;
  });

  console.log(`   ${uniqueThreads.length}件のポストマッチスレッドを発見`);

  if (uniqueThreads.length === 0) {
    console.log("   本日のポストマッチスレッドが見つかりませんでした");
    console.log("   試合がない日か、まだ試合中の可能性があります");
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ date: today, matches: [] }, null, 2));
    return;
  }

  // 各スレッドを処理
  const results = [];
  for (let i = 0; i < uniqueThreads.length; i++) {
    const thread = uniqueThreads[i];
    console.log(`\n② [${i + 1}/${uniqueThreads.length}] ${thread.title}`);

    // コメント取得
    console.log("   コメント取得中...");
    const comments = await fetchThreadComments(thread.permalink);
    console.log(`   ${comments.length}件のコメントを取得`);

    // マッチデータ抽出
    console.log("   試合データ抽出中...");
    const matchData = await extractMatchData(thread, comments);
    if (!matchData) {
      console.log("   ⚠️  データ抽出失敗、スキップ");
      continue;
    }
    console.log(`   ✅ ${matchData.homeTeam} ${matchData.homeScore}-${matchData.awayScore} ${matchData.awayTeam}`);

    // スクリプト生成
    console.log("   スクリプト生成中...");
    const script = await generateVideoScript(matchData, comments, thread);
    console.log(`   ✅ スクリプト生成完了（${script.length}文字）`);

    results.push({
      threadTitle: thread.title,
      redditUrl: thread.url,
      matchData,
      script,
      comments: comments.slice(0, 10),
    });

    // APIレート制限対策
    await new Promise((r) => setTimeout(r, 1000));
  }

  // soccer_content 保存（スクリプト用）
  const output = { date: today, matches: results };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");

  // soccer_video_content 生成（動画用）
  console.log("\n③ 動画用構造化コンテンツを生成中...");
  const videoPosts = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    process.stdout.write(`   [${i + 1}/${results.length}] ${r.matchData.homeTeam} vs ${r.matchData.awayTeam}... `);
    try {
      const vc = await generateVideoContent(r.matchData, r.script, r.comments);
      videoPosts.push({ num: i + 1, ...vc });
      console.log("✅");
    } catch (e) {
      console.log(`⚠️ 失敗: ${e.message}`);
    }
    await new Promise(res => setTimeout(res, 500));
  }
  const videoOutput = { date: today, posts: videoPosts };
  fs.writeFileSync(VIDEO_CONTENT_FILE, JSON.stringify(videoOutput, null, 2), "utf8");

  console.log(`\n✅ 完了！${results.length}試合分のスクリプトを保存しました`);
  console.log(`   → ${OUTPUT_FILE}`);
  console.log(`   → ${VIDEO_CONTENT_FILE}（動画生成用）`);
  console.log("\n=== 生成されたスクリプト一覧 ===");
  results.forEach((r, i) => {
    console.log(`\n[${i + 1}] ${r.matchData.homeTeam} ${r.matchData.homeScore}-${r.matchData.awayScore} ${r.matchData.awayTeam}`);
    console.log(r.script.slice(0, 100) + "...");
  });
}

main().catch(console.error);
