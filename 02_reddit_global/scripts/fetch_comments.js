// fetch_comments.js
// コメント取得モジュール（YouTube動画用）
//
// 対応ソース:
//   reddit  : Reddit 公開 JSON API（APIキー不要）
//   x       : TwitterAPI.io 経由（TWITTER_API_IO_KEY 必要）
//   local   : ローカルの JSON ファイルを読み込む（5ch/Yahoo取得済みデータ）
//
// 使い方（CLI）:
//   node fetch_comments.js --source reddit --subreddit soccer --query "chelsea" --count 30
//   node fetch_comments.js --source x      --query "チェルシー" --count 30
//   node fetch_comments.js --source local  --file ./my_comments.json
//   node fetch_comments.js --source local  --file ./my_comments.json --topic "チェルシーの奇跡"
//
// 出力: JSON 配列を stdout に出力
//   [ { "user": "名前", "text": "コメント本文" }, ... ]
//
// ─── コメント JSON フォーマット（local ソース用） ──────────────────────────
// [
//   { "user": "名無しさん", "text": "ポールティアニーで草" },
//   { "user": "匿名",       "text": "これはもうAIであってくれよ" }
// ]

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

// ─── Reddit 取得 ──────────────────────────────────────────────────────────
// ※ Reddit の公開 JSON API はキー不要。日本語コメントが欲しい場合は
//    r/japanews / r/soccer 等を指定してください。
async function fetchFromReddit({ subreddit = "soccer", query, count = 100 }) {
  if (!query) throw new Error("--query が必要です");

  console.error(`[Reddit] r/${subreddit} で "${query}" を検索中...`);

  // Step1: 関連スレッドを検索
  const searchUrl = `https://www.reddit.com/r/${subreddit}/search.json?` +
    `q=${encodeURIComponent(query)}&sort=hot&limit=10&restrict_sr=1`;

  const searchRes = await fetch(searchUrl, {
    headers: { "User-Agent": "yt-comment-fetcher/1.0" },
  });
  if (!searchRes.ok) throw new Error(`Reddit search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();

  const posts = searchData?.data?.children || [];
  if (!posts.length) {
    console.error("[Reddit] スレッドが見つかりませんでした");
    return [];
  }

  // Step2: 上位スレッドからコメントを取得
  const rawComments = [];
  for (const post of posts.slice(0, 3)) {
    const postId  = post.data.id;
    const postSub = post.data.subreddit;
    const commUrl = `https://www.reddit.com/r/${postSub}/comments/${postId}.json?limit=100`;

    try {
      const commRes = await fetch(commUrl, {
        headers: { "User-Agent": "yt-comment-fetcher/1.0" },
      });
      if (!commRes.ok) continue;
      const commData = await commRes.json();
      const comments = commData?.[1]?.data?.children || [];

      for (const c of comments) {
        const body = c?.data?.body;
        const author = c?.data?.author;
        if (!body || body === "[deleted]" || !author) continue;
        // 英語コメントを日本語チャンネル向けに使う場合は翻訳ステップを追加可能
        rawComments.push({ user: author, text: body.trim() });
      }
    } catch (err) {
      console.error(`[Reddit] コメント取得失敗: ${err.message}`);
    }
  }

  console.error(`[Reddit] ${rawComments.length}件取得完了`);
  return rawComments;
}

// ─── X (Twitter) 取得 ─────────────────────────────────────────────────────
// 外部スクレイピング API (TwitterAPI.io) を使用
// 公式 Twitter API は高コストのため外部 API を推奨
// 参考: https://twitterapi.io/
async function fetchFromX({ query, count = 100 }) {
  if (!query) throw new Error("--query が必要です");

  const API_KEY = process.env.TWITTER_API_IO_KEY;
  if (!API_KEY) {
    console.error("[X] TWITTER_API_IO_KEY が .env に未設定です");
    console.error("    https://twitterapi.io で取得後、.env に追加してください");
    console.error("    TWITTER_API_IO_KEY=your_key_here");
    return [];
  }

  console.error(`[X] "${query}" のツイートを取得中...`);

  // TwitterAPI.io の検索エンドポイント（仕様は要確認）
  const res = await fetch("https://api.twitterapi.io/twitter/tweet/advanced_search", {
    method: "POST",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `${query} lang:ja -is:retweet`,
      max_results: count,
    }),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`TwitterAPI.io エラー: ${res.status} ${msg}`);
  }

  const data = await res.json();
  const tweets = data?.tweets || data?.data || [];

  const rawComments = tweets.map(t => ({
    user: t.user?.name || t.author?.name || "匿名",
    text: (t.text || t.full_text || "")
      .replace(/https?:\/\/\S+/g, "")   // URL除去
      .replace(/@\w+/g, "")             // メンション除去
      .replace(/\n+/g, " ")
      .trim(),
  })).filter(c => c.text.length > 0);

  console.error(`[X] ${rawComments.length}件取得完了`);
  return rawComments;
}

// ─── Local JSON 読み込み ──────────────────────────────────────────────────
// 5ch / Yahoo / その他でローカル取得済みのコメントを渡す
// フォーマット: [{ "user": "...", "text": "..." }, ...]
// または文字列配列: ["コメント1", "コメント2", ...]
function fetchFromLocal({ file }) {
  if (!file) throw new Error("--file が必要です");
  if (!fs.existsSync(file)) throw new Error(`ファイルが見つかりません: ${file}`);

  console.error(`[Local] ${file} を読み込み中...`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));

  // 文字列配列 → オブジェクト配列に変換
  const comments = Array.isArray(data)
    ? data.map(item =>
        typeof item === "string"
          ? { user: "匿名", text: item }
          : item
      )
    : [];

  console.error(`[Local] ${comments.length}件読み込み完了`);
  return comments;
}

// ─── Claude フィルタリング ────────────────────────────────────────────────
// 「毒気はあるが規約違反ではない」20〜30文字のコメントを厳選
async function filterWithClaude(rawComments, { topic = "", targetCount = 10, maxChars = 30, minChars = 8 }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[Claude] ANTHROPIC_API_KEY 未設定 → 長さフィルタのみ適用");
    return lengthFilter(rawComments, minChars, maxChars).slice(0, targetCount);
  }

  const client = new Anthropic();

  // 長さで事前フィルタ（Claude への入力を絞る）
  const preFiltered = rawComments.filter(c =>
    c.text.length >= 4 && c.text.length <= 100
  ).slice(0, 200); // 最大200件をClaudeに渡す

  if (!preFiltered.length) return [];

  const commentList = preFiltered.map((c, i) =>
    `${i}: [${c.user}] ${c.text}`
  ).join("\n");

  const prompt = `以下はSNSやネット掲示板のコメント一覧です。
テーマ：「${topic || "ニュース動画"}」

【選別条件】
1. 日本語で書かれている（英語は除外）
2. ${minChars}〜${maxChars}文字程度（長すぎず短すぎず）
3. 面白い・共感できる・毒気があるが、ヘイトスピーチや個人攻撃ではない
4. 動画コメント欄に表示して視聴者が「わかる！」と思えるもの
5. テーマと関連がある

最も適した${targetCount}件を選び、以下の JSON 形式のみで返してください。
説明文は不要です。JSONのみ出力してください。
[
  { "user": "ユーザー名", "text": "コメント本文" }
]

コメント一覧:
${commentList}`;

  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const content = res.content[0]?.text || "";
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("JSON が見つかりません");

    const filtered = JSON.parse(jsonMatch[0]);
    console.error(`[Claude] ${rawComments.length}件 → ${filtered.length}件に絞り込み完了`);
    return filtered;
  } catch (err) {
    console.error(`[Claude] フィルタリング失敗: ${err.message}`);
    // フォールバック: 長さフィルタのみ
    return lengthFilter(rawComments, minChars, maxChars).slice(0, targetCount);
  }
}

// 長さベースのシンプルフィルタ（Claudeなし時のフォールバック）
function lengthFilter(comments, min, max) {
  return comments.filter(c => c.text.length >= min && c.text.length <= max);
}

// ─── メイン（CLI実行時） ──────────────────────────────────────────────────
async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, "");
    const val = process.argv[i + 1];
    if (key) args[key] = val;
  }

  const source = args.source;
  if (!source) {
    console.error("使い方: node fetch_comments.js --source [reddit|x|local] [オプション]");
    process.exit(1);
  }

  let rawComments = [];
  try {
    if (source === "reddit") {
      rawComments = await fetchFromReddit({
        subreddit: args.subreddit || "soccer",
        query:     args.query,
        count:     parseInt(args.count || "100"),
      });
    } else if (source === "x") {
      rawComments = await fetchFromX({
        query: args.query,
        count: parseInt(args.count || "100"),
      });
    } else if (source === "local") {
      rawComments = fetchFromLocal({ file: args.file });
    } else {
      throw new Error(`未対応のソース: ${source}`);
    }

    const filtered = await filterWithClaude(rawComments, {
      topic:       args.topic || args.query || "",
      targetCount: parseInt(args.target || "10"),
      maxChars:    parseInt(args.maxchars || "30"),
      minChars:    parseInt(args.minchars || "8"),
    });

    // stdout に JSON 出力（youtube_server.js が受け取る）
    process.stdout.write(JSON.stringify(filtered, null, 2));
  } catch (err) {
    console.error(`[Error] ${err.message}`);
    process.stdout.write("[]");
    process.exit(1);
  }
}

// CLI として実行された場合のみ main() を呼ぶ
if (require.main === module) main();

// programmatic API としてもエクスポート
module.exports = { fetchFromReddit, fetchFromX, fetchFromLocal, filterWithClaude };
