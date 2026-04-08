// generate_text_content.js
// ローカルPC定時実行: candidates JSON のテキストコンテンツを AI 生成し VPS に送信
//
// 使い方:
//   node scripts/generate_text_content.js [YYYY-MM-DD] [--top=N]
//   --top=N : 生成対象件数（デフォルト: Reddit上位5 + RSS上位3 = 8件）
//
// 出力:
//   data/content_YYYY-MM-DD.json  ← テキスト全体 + 画像取得メタ情報
//   → SCP で VPS の temp/ に送信
//   → VPS API を呼び出して画像取得を自動開始

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");
const { callAI }   = require("./ai_client");

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, "..", "data");
const VPS_HOST  = "root@37.60.224.54";
const VPS_DEST  = "/root/sekai_no_wadai/02_reddit_global/temp/";
const VPS_API   = "http://100.116.25.91:3003";    // Tailscale IP
const SSH_KEY   = path.join(process.env.USERPROFILE || "C:\\Users\\USER", ".ssh", "id_ed25519");
const CONCURRENCY = 3;

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const dateArg   = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
               || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const topArg    = parseInt((process.argv.find(a => a.startsWith("--top=")) || "--top=8").replace("--top=", ""));

const TEAM_MANAGERS_PATH = path.join(__dirname, "..", "logos", "team_managers.json");
const _teamManagers = (() => {
  try { return JSON.parse(fs.readFileSync(TEAM_MANAGERS_PATH, "utf8")).managers || {}; }
  catch { return {}; }
})();
function lookupManagers(names) {
  const seen = new Set(), result = [];
  for (const n of names) { const m = _teamManagers[n]; if (m && !seen.has(m)) { seen.add(m); result.push(m); } }
  return result;
}

const LEAGUE_KW = ["Premier League","La Liga","Bundesliga","Ligue 1","Serie A",
  "Champions League","Europa League","Conference League","World Cup","FA Cup","Copa del Rey"];
function detectType(title) {
  const lower = title.toLowerCase();
  if ((lower.includes("post match thread")||lower.includes("post-match thread")) && LEAGUE_KW.some(k=>title.includes(k))) return "post-match";
  if (/transfer|signs for|joins|loan deal|contract extension|here we go/i.test(lower)) return "transfer";
  if (/injur|ruled out|muscle|hamstring|knee|ligament/i.test(lower)) return "injury";
  if (/sacked|fired|resign|appointed|new manager|new head coach/i.test(lower)) return "manager";
  return "topic";
}

// ─── X コメント取得 ───────────────────────────────────────────────────────────

// ベース: 生ツイートを返す（GETリクエスト）
async function fetchRawTweets(query, max = 10) {
  const apiKey = process.env.TWITTER_API_IO_KEY;
  if (!apiKey || !query) return [];
  try {
    const params = new URLSearchParams({ query, queryType: "Latest" });
    const res = await fetch(`https://api.twitterapi.io/twitter/tweet/advanced_search?${params}`, {
      method:  "GET",
      headers: { "X-API-Key": apiKey },
      signal:  AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.tweets || data?.data || [];
  } catch { return []; }
}

// ツイート配列 → コメント形式に整形
function cleanTweets(tweets, lang, max) {
  return tweets
    .map(t => ({
      text: (t.text || t.full_text || "").replace(/https?:\/\/\S+/g,"").replace(/@\w+/g,"").replace(/\n+/g," ").trim(),
      user: t.user?.name || t.author?.name || "X user",
      lang,
    }))
    .filter(c => c.text.length > 5)
    .slice(0, max);
}

// キーワード検索（フォールバック用）
async function fetchXComments(query, lang, max = 5) {
  const tweets = await fetchRawTweets(`${query} lang:${lang} -is:retweet`, max * 3);
  return cleanTweets(tweets, lang, max);
}

// ニュースタイプ→参照アカウント辞書
const SOURCE_ACCOUNTS = {
  transfer:     ["FabrizioRomano", "David_Ornstein"],
  manager:      ["FabrizioRomano", "David_Ornstein"],
  injury:       ["FabrizioRomano", "David_Ornstein"],
  "post-match": ["goal", "espnfc", "SkySportsFootball"],
  topic:        ["goal", "espnfc", "SkySportsFootball", "bbcsport"],
};

// メインの新戦略: ソースアカウントのツイート → 返信を取得
// フォールバック: ソースツイートなし or 返信0件 → キーワード検索
async function fetchXCommentsViaAccount(keyword, type, lang, max = 5) {
  const accounts = SOURCE_ACCOUNTS[type] || SOURCE_ACCOUNTS.topic;

  // Step1: 各アカウントのキーワード関連ツイートを検索（英語で検索、言語フィルタなし）
  const fromQuery = accounts.map(a => `from:${a}`).join(" OR ");
  const sourceTweets = await fetchRawTweets(`(${fromQuery}) ${keyword} -is:retweet`, 5);

  if (sourceTweets.length > 0) {
    // Step2: 最初のツイートのconversationから返信を取得
    const tweet = sourceTweets[0];
    const tweetId = tweet.id_str || tweet.id || tweet.tweetId || tweet.tweet_id;
    if (tweetId) {
      const replies = await fetchRawTweets(
        `conversation_id:${tweetId} lang:${lang} -is:retweet`,
        max * 3
      );
      if (replies.length > 0) return cleanTweets(replies, lang, max);
    }
  }

  // フォールバック: キーワード検索
  return fetchXComments(keyword, lang, max);
}

async function detectFanLang(engQuery, imgKeywords) {
  try {
    const prompt = `Soccer news: "${engQuery}"\nTeams: ${(imgKeywords||[]).join(", ")}\nWhich ONE country's fans are most relevant? Return ONLY ISO 639-1 code (en/es/it/de/fr/nl/pt/tr/ar/etc). Default "en". No explanation.`;
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 5,
      messages: [{ role: "user", content: prompt }] });
    const code = raw.trim().slice(0, 2).toLowerCase();
    return /^[a-z]{2}$/.test(code) ? code : "en";
  } catch { return "en"; }
}

// X検索に最適な短いキーワードをDeepSeekに考えさせる
async function generateXQuery(title, serperSnippets) {
  try {
    const ctx = serperSnippets?.length
      ? serperSnippets.map(s => s.title).join(" / ")
      : "";
    const prompt = `Soccer news title: "${title}"${ctx ? `\nContext: ${ctx}` : ""}

Generate ONE short X (Twitter) search keyword to find fan reaction tweets about this news.
Rules:
- Use the most recognizable name (player name, team name, or key term)
- Short enough to return many results (1-4 words max)
- Avoid full sentences or overly specific phrases that return 0 results
Return ONLY the search term. No explanation.

Examples:
"Alternate angles of Dembélé's goal against Toulouse" → "Dembele PSG"
"Leicester City 15 games without win relegated" → "Leicester relegation"
"Canada Soccer offering Italian fans free jersey" → "Canada Italy shirt"`;
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 20,
      messages: [{ role: "user", content: prompt }] });
    const q = raw.trim().replace(/^["']|["']$/g, "").replace(/\n.*/s, "");
    return q.length > 2 ? q : title.slice(0, 40);
  } catch { return title.slice(0, 40); }
}

// Serper検索に最適な短いクエリをAIに考えさせる
async function generateSerperQuery(title) {
  try {
    const prompt = `Soccer news title: "${title}"

Generate a focused Google search query (5-10 words) to find recent news articles about this exact story.
Rules:
- Include player/team names and the key event (transfer, injury, match result, etc.)
- Use English only
- Do NOT include year or generic filler words like "news", "soccer", "football"
Return ONLY the search query. No explanation.

Examples:
"Liverpool have reached a verbal agreement with Bayern Munich for the transfer of Leroy Sane" → "Leroy Sane Liverpool transfer Bayern Munich"
"Real Madrid manager Carlo Ancelotti knee injury ruled out" → "Carlo Ancelotti knee injury Real Madrid"
"PSG defeated Manchester City 3-1 Champions League quarter-final" → "PSG Manchester City Champions League quarter-final"`;
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 30,
      messages: [{ role: "user", content: prompt }] });
    const q = raw.trim().replace(/^["']|["']$/g, "").replace(/\n.*/s, "");
    return q.length > 4 ? q : title.slice(0, 60);
  } catch { return title.slice(0, 60); }
}

// ─── Serper検索 ───────────────────────────────────────────────────────────────
async function searchSerper(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method:  "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body:    JSON.stringify({ q: query, tbs: "qdr:w", num: 5, hl: "en" }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.organic || []).slice(0, 3).map(r => ({
      title:   r.title   || "",
      snippet: r.snippet || "",
      date:    r.date    || "",
      link:    r.link    || "",
    }));
  } catch { return []; }
}

// ─── AI ヘルパー ──────────────────────────────────────────────────────────────
async function translateKeywordToEnglish(text) {
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 80,
      messages: [{ role: "user", content: `Extract ONLY the 2 most essential English proper nouns (Player name, Manager name, or Team name) for image search from this headline. 
Ignore quotes, sentences, and adjectives. Return ONLY the keywords separated by a single space.
Headline: ${text}` }] });
    return raw.trim().slice(0, 60).replace(/["']/g, "");
  } catch { return text.slice(0, 60); }
}

async function extractImageKeywords(title, snippets = []) {
  const ctx = snippets.length > 0
    ? `\nContext from recent articles:\n${snippets.map(s => s.title + ": " + s.snippet).join("\n")}` : "";
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 80,
      messages: [{ role: "user", content: `Extract up to 3 English proper nouns (team names, player names, manager names) for image search. Prioritize names found in the context. Return a JSON array only, e.g. ["Chelsea","De Zerbi","Enzo"]. No explanation.\nHeadline: ${title}${ctx}` }] });
    const m = raw.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter(w => w && w.length >= 2).slice(0, 3) : [];
  } catch { return []; }
}

async function extractPlayerNames(title, snippets = []) {
  const ctx = snippets.length > 0
    ? `\nContext: ${snippets.map(s => s.snippet).join(" ").slice(0, 400)}` : "";
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 80,
      messages: [{ role: "user", content: `Extract soccer player names only (not teams/countries/managers). Prioritize names found in the context. Return English names as a JSON array, max 3. E.g. ["Junya Ito","Erling Haaland"]. If none, return [].\nHeadline: ${title}${ctx}` }] });
    const m = raw.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter(w => w && w.length >= 2).slice(0, 3) : [];
  } catch { return []; }
}

async function extractMatchData(thread, comments) {
  const prompt = `以下はRedditのサッカー試合スレッドです。構造化データとして抽出してください。
【スレッドタイトル】${thread.title}
【スレッド本文】${(thread.selftext||"").slice(0,1000)||"（本文なし）"}
【上位コメント（英語）】${comments.slice(0,10).join("\n")}
以下のJSON形式のみで出力してください。明記されていない情報は必ずnullにしてください。
{"homeTeam":"","awayTeam":"","homeScore":0,"awayScore":0,"league":"","leagueJa":"","matchday":null,"isKnockout":false,"aggregateScore":null,"teamThatAdvances":null,"goals":[{"player":"","team":"","minute":0,"type":"通常"}],"redCards":[{"player":"","team":"","minute":0}],"matchMood":"EXCITING"}`;
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: prompt }] });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("JSON not found");
    return JSON.parse(m[0]);
  } catch { return null; }
}

async function translateComments(comments) {
  const items = (comments||[]).filter(c=>c&&c.trim());
  if (!items.length) return comments||[];
  const prompt = `以下のサッカー関連コメントを自然な日本語に翻訳してください。先頭の「[👍123]」などのプレフィックスはそのまま残してください。JSON配列のみ返してください。
${items.map((t,i)=>`${i}: ${t}`).join("\n")}
出力形式: ["日本語訳0", "日本語訳1", ...]`;
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 2000, messages: [{ role: "user", content: prompt }] });
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return comments;
    const translated = JSON.parse(m[0]);
    return items.map((_,i) => translated[i] || items[i]);
  } catch { return comments; }
}

// 試合コンテンツ生成プロンプト（generate_content.js と同一）
async function generateMatchContent(matchData, comments, thread, xComments=[]) {
  const goalsText = matchData.goals?.length > 0
    ? matchData.goals.map(g=>`${g.minute}分 ${g.player}（${g.team}）${g.type!=="通常"?`【${g.type}】`:""}`).join("、")
    : "得点なし";
  const knockoutNote = matchData.isKnockout && matchData.aggregateScore
    ? `\n2試合制ノックアウト: 総合スコア ${matchData.aggregateScore}（${matchData.teamThatAdvances??""}が勝ち抜け）` : "";
  const d = new Date(dateArg+"T00:00:00Z");
  const jstDateStr = `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日`;
  const prompt = `あなたはサッカーニュース動画のコンテンツライターです。以下のデータをもとに、視聴者が冒頭10秒で離脱できない動画コンテンツを設計してください。
━━━━━━━━━━━━━━━━━━━━━━━━━
【スレッドタイトル（最重要・この事件を動画化する）】${thread.title}
━━━━━━━━━━━━━━━━━━━━━━━━━
【コンテンツタイプ】post-match（試合後）
【絶対ルール】スレッドタイトルと試合データに存在しない人名・チーム名は絶対に使わない。架空の数字・記録は使わない。監督名・選手名・所属クラブはスレッドまたは試合データに明記されている場合のみ使用し、記載のない情報は推測・補完しないこと。
【トーン指定（10段階中6）】NHKニュースを10、5chスレを0とする。基本はニュース解説口調を維持すること。ただし「これは注目ですね」「驚きの一戦でした」程度の軽い感嘆は自然に入れてよい。キャラクターを前面に出したり友達に話しかける感覚にはしないこと。ニュースキャスターが少しだけ砕けた感じ。
【制作ルール】- ナレーション中に「Reddit」は絶対に使わず「海外サッカー掲示板」と表現。- 大会名・日付・スコア・主要得点者と分数を必ず盛り込む。- コメント意訳は「笑い・驚き・共感」のどれかを持たせる。- コメントは必ず7件全て日本語で書くこと（英語のまま残さない）。- ナレーション・字幕・コメント全ての文章は日本語で書くこと。英語の選手名・チーム名・大会名はカタカナ表記にすること（例: Salah→サラー, Champions League→チャンピオンズリーグ）。
【試合データ】日付:${jstDateStr} 対戦:${matchData.homeTeam}vs${matchData.awayTeam} スコア:${matchData.homeScore}-${matchData.awayScore} 大会:${matchData.leagueJa||matchData.league}${knockoutNote} 得点:${goalsText} 退場:${matchData.redCards?.length>0?matchData.redCards.map(r=>`${r.minute}分 ${r.player}`).join("、"):"なし"} ムード:${matchData.matchMood||"EXCITING"}
【海外ファンの反応（Reddit）】${comments.slice(0,15).join("\n")}${xComments.length>0?`\n【X海外ファンの反応】\n${xComments.slice(0,15).join("\n")}`:""}
以下のJSON形式のみで出力してください：{"catchLine1":"サムネイル兼タイトル文（30文字以内）","label":"【速報】か【衝撃】か【朗報】か【悲報】","badge":"サブバッジ（8文字以内）","sourceAuthor":"情報元","sourceText":"核心テキスト（日本語・2〜4行）","overviewNarration":"S2ナレーション（80〜120文字・大会名・日付・スコア・得点者分数を必ず含む）","overviewTelop":"S2テロップ（25文字以内）","slide3":{"topicTag":"S3タグ（12文字以内・※で始まる）","highlightIdx":0,"narration":"S3ナレーション（60〜90文字）","subtitleBox":"S3字幕（20文字以内）","comments":[{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目（日本語60〜80文字）"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"}]},"slide4":{"topicTag":"S4タグ（12文字以内・※で始まる・S3と別角度）","highlightIdx":0,"narration":"S4ナレーション（60〜90文字）","subtitleBox":"S4字幕（20文字以内）","comments":[{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"}]},"outroNarration":"S5ナレーション（20〜40文字）","outroTelop":"S5テロップ（18〜28文字・登録呼びかけ厳禁）","youtubeTitle":"YouTubeタイトル（SEO重視・40〜55文字）","hashtagsText":"ハッシュタグ（8〜10個・#サッカー #海外の反応 含む）"}`;
  const raw = await callAI({ model: "claude-sonnet-4-6", max_tokens: 2200, messages: [{ role: "user", content: prompt }] });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON not found");
  return JSON.parse(m[0]);
}

const TYPE_LABEL_MAP = { transfer:"移籍情報", injury:"負傷情報", manager:"監督情報", finance:"財政・制裁", topic:"注目トピック" };
async function generateTopicContent(topicData, comments, thread, xComments=[], serperSnippets=[]) {
  const typeLabel = TYPE_LABEL_MAP[thread.type] || "注目トピック";
  const serperSection = serperSnippets.length > 0
    ? `\n【参考記事（Google検索・過去7日）】以下のスニペットに記載された情報のみ補足として使用してよい。記載のない事実（スコア・日付・人名・移籍先等）は絶対に推測・補完しないこと。\n${serperSnippets.map((s,i)=>`[${i+1}] ${s.date?`(${s.date}) `:""}${s.title}\n${s.snippet}`).join("\n")}`
    : "";
  const prompt = `あなたはサッカーニュース動画のコンテンツライターです。以下のデータをもとに、視聴者が冒頭10秒で離脱できない動画コンテンツを設計してください。
━━━━━━━━━━━━━━━━━━━━━━━━━
【スレッドタイトル】${thread.title}
━━━━━━━━━━━━━━━━━━━━━━━━━
【コンテンツタイプ】${typeLabel}
【絶対ルール】存在しない人名・チーム名・数字は使わない。監督名・選手名・所属クラブはスレッドまたは提供データに明記されている場合のみ使用し、記載のない情報は推測・補完しないこと。
【トーン指定（10段階中6）】NHKニュースを10、5chスレを0とする。基本はニュース解説口調を維持すること。ただし「これは注目ですね」「驚きの展開です」程度の軽い感嘆は自然に入れてよい。キャラクターを前面に出したり友達に話しかける感覚にはしないこと。ニュースキャスターが少しだけ砕けた感じ。
【制作ルール】- 「Reddit」→「海外サッカー掲示板」。- コメント意訳は「笑い・驚き・共感」のどれか。- コメントは必ず7件全て日本語で書くこと（英語のまま残さない）。- ナレーション・字幕・コメント全ての文章は日本語で書くこと。英語の選手名・チーム名・大会名はカタカナ表記にすること（例: Salah→サラー, Champions League→チャンピオンズリーグ）。
【スレッド本文】${(topicData.selftext||"").slice(0,800)||"（本文なし）"}${serperSection}
【海外ファンの反応（Reddit）】${comments.slice(0,15).join("\n")}${xComments.length>0?`\n【X海外ファンの反応】\n${xComments.slice(0,15).join("\n")}`:""}
以下のJSON形式のみで出力してください：{"catchLine1":"サムネイル兼タイトル文（30文字以内）","label":"【速報】か【衝撃】か【朗報】か【悲報】","badge":"サブバッジ（8文字以内）","sourceAuthor":"情報元","sourceText":"核心テキスト（日本語・2〜4行）","overviewNarration":"S2ナレーション（80〜120文字）","overviewTelop":"S2テロップ（25文字以内・誰が・何をしたか）","slide3":{"topicTag":"S3タグ（12文字以内・※で始まる）","highlightIdx":0,"narration":"S3ナレーション（60〜90文字）","subtitleBox":"S3字幕（20文字以内）","comments":[{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目（日本語60〜80文字）"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"}]},"slide4":{"topicTag":"S4タグ（12文字以内・※で始まる・S3と別角度）","highlightIdx":0,"narration":"S4ナレーション（60〜90文字）","subtitleBox":"S4字幕（20文字以内）","comments":[{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"}]},"outroNarration":"S5ナレーション（20〜40文字）","outroTelop":"S5テロップ（18〜28文字・登録呼びかけ厳禁）","youtubeTitle":"YouTubeタイトル（SEO重視・40〜55文字）","hashtagsText":"ハッシュタグ（8〜10個・#サッカー #海外の反応 含む）"}`;
  const raw = await callAI({ model: "claude-sonnet-4-6", max_tokens: 2200, messages: [{ role: "user", content: prompt }] });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON not found");
  return JSON.parse(m[0]);
}

// ─── SCP & VPS API 呼び出し ───────────────────────────────────────────────────
function scpToVps(localFile) {
  const cmd = `scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${localFile}" "${VPS_HOST}:${VPS_DEST}"`;
  execSync(cmd, { stdio: "inherit", timeout: 30000 });
  console.log(`📤 VPS送信完了: ${path.basename(localFile)}`);
}

async function triggerVpsImageFetch(date) {
  try {
    const res = await fetch(`${VPS_API}/api/soccer-yt/start-image-fetch`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ date }),
      signal:  AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (json.ok) console.log(`🖼  VPS画像取得ジョブ開始: ${date}`);
    else         console.warn(`⚠️  VPS画像取得トリガー失敗: ${json.error || "不明"}`);
  } catch (e) {
    console.warn(`⚠️  VPS API呼び出し失敗（Tailscale未接続？）: ${e.message}`);
    console.warn(`   手動起動: curl -X POST ${VPS_API}/api/soccer-yt/start-image-fetch -H 'Content-Type: application/json' -d '{"date":"${date}"}'`);
  }
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  const candidatesFile = path.join(DATA_DIR, `candidates_${dateArg}.json`);
  if (!fs.existsSync(candidatesFile)) {
    console.error(`❌ candidates_${dateArg}.json が見つかりません。先に fetch_daily_candidates.js を実行してください。`);
    process.exit(1);
  }

  const candidatesData = JSON.parse(fs.readFileSync(candidatesFile, "utf8"));
  const allPosts = (candidatesData.posts || []).map(p => ({ ...p, type: p.type || detectType(p.title||"") }));

  // 過去168時間（7日分）の content JSON を確認してスキップ対象を把握
  const existingTitles = new Set();
  for (let d = 0; d < 7; d++) {
    const checkDate = new Date(Date.now() + jstOffset - d * 86400000).toISOString().slice(0, 10);
    const f = path.join(DATA_DIR, `content_${checkDate}.json`);
    if (fs.existsSync(f)) {
      try {
        const data = JSON.parse(fs.readFileSync(f, "utf8"));
        for (const p of data.posts || []) {
          if (p._meta?.title) existingTitles.add(p._meta.title);
        }
      } catch { /* 読み取り失敗は無視 */ }
    }
  }
  const contentFile = path.join(DATA_DIR, `content_${dateArg}.json`);
  // 当日JSONのマージ用（今回生成分 + 既存分を合わせる）
  const existingContent = fs.existsSync(contentFile) ? JSON.parse(fs.readFileSync(contentFile, "utf8")) : { posts: [] };

  // 生成対象: Reddit上位4件(score降順) + RSS上位4件(recency降順)
  const REDDIT_LIMIT = 4;
  const RSS_LIMIT    = 4;

  const redditCandidates = allPosts
    .filter(p => p.source === "reddit" && !existingTitles.has(p.title))
    .sort((a, b) => b.score - a.score)
    .slice(0, REDDIT_LIMIT);

  const rssCandidates = allPosts
    .filter(p => p.source === "rss" && !existingTitles.has(p.title))
    .sort((a, b) => b.created_utc - a.created_utc)
    .slice(0, RSS_LIMIT);

  const targets = [...redditCandidates, ...rssCandidates].slice(0, topArg);

  const jst = new Date(Date.now() + jstOffset);
  console.log(`\n📝 テキストコンテンツ生成 (${dateArg}) — ${jst.toISOString().replace("Z","+09:00").slice(11,16)} JST`);
  console.log(`対象: ${targets.length}件 (Reddit${redditCandidates.length} + RSS${rssCandidates.length}) / 168h済みスキップ: ${existingTitles.size}件`);
  console.log("─".repeat(50));

  const newPosts = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (post, j) => {
      const num = i + j + 1;
      const isMatch = post.type === "post-match";
      console.log(`▶ [${num}/${targets.length}] [${post.type}] ${post.title.slice(0, 60)}`);

      // 事前取得済みコメントを文字列配列に変換
      const rawComments = (post.comments || []).map(c => `[👍${c.score||0}] ${c.body||""}`);
      const selftext = post.selftext || "";

      let matchData      = null;
      let ytContent      = null;
      let xSearchQuery   = "";
      let wikiWords      = [];
      let serperSnippets = [];
      let xJaComments    = [];
      let xOtherComments = [];
      let fanLang        = "en";

      if (isMatch) {
        // 試合データ抽出
        process.stdout.write(`  [${num}] 試合データ抽出... `);
        matchData = await extractMatchData({ title: post.title, selftext }, rawComments);
        if (!matchData) { console.log("⚠️ 失敗"); return null; }
        console.log(`✅ ${matchData.homeTeam} ${matchData.homeScore}-${matchData.awayScore} ${matchData.awayTeam}`);

        xSearchQuery = `${matchData.homeTeam} ${matchData.awayTeam}`.trim();
        const managers = lookupManagers([matchData.homeTeam, matchData.awayTeam]);
        wikiWords = [matchData.homeTeam, matchData.awayTeam, ...managers];

        const xComments = [];
        process.stdout.write(`  [${num}] コンテンツ生成... `);
        ytContent = await generateMatchContent(matchData, rawComments, post, xComments);
        console.log("✅");
      } else {
        // ① engQuery を先に取得
        const rawQuery = post.title.replace(/^\[.*?\]\s*/g,"").slice(0, 80);
        const needsTranslation = /[\u3040-\u30ff\u4e00-\u9fff]/.test(rawQuery);
        const engQuery = needsTranslation ? await translateKeywordToEnglish(rawQuery) : rawQuery;
        xSearchQuery = engQuery;

        // ② Serper検索（スニペット取得）
        const serperQuery = await generateSerperQuery(engQuery);
        process.stdout.write(`  [${num}] Serper検索 "${serperQuery.slice(0,40)}"... `);
        serperSnippets = await searchSerper(serperQuery);
        console.log(serperSnippets.length > 0 ? `✅ ${serperSnippets.length}件` : "⚠️ 0件");

        // ③ スニペット込みでキーワード抽出（精度向上）
        const [imgKeywords, playerNames] = await Promise.all([
          extractImageKeywords(post.title, serperSnippets),
          extractPlayerNames(post.title, serperSnippets),
        ]);
        const managers = lookupManagers(imgKeywords);
        wikiWords = [
          ...managers.filter(m => !imgKeywords.some(k => m.toLowerCase().includes(k.toLowerCase()))),
          ...playerNames,
        ].filter(Boolean);

        const xComments = [];
        process.stdout.write(`  [${num}] コンテンツ生成... `);
        ytContent = await generateTopicContent({ selftext }, rawComments, post, xComments, serperSnippets);
        console.log("✅");
      }

      // コメント翻訳
      const redditJa = await translateComments(rawComments);

      return {
        num,
        type:              post.type,
        catchLine1:        ytContent.catchLine1,
        label:             ytContent.label,
        badge:             ytContent.badge,
        sourceAuthor:      ytContent.sourceAuthor,
        sourceText:        ytContent.sourceText,
        overviewNarration: ytContent.overviewNarration,
        overviewTelop:     ytContent.overviewTelop,
        slide3:            ytContent.slide3,
        slide4:            ytContent.slide4,
        outroNarration:    ytContent.outroNarration,
        outroTelop:        ytContent.outroTelop,
        youtubeTitle:      ytContent.youtubeTitle,
        hashtagsText:      ytContent.hashtagsText,
        matchResult:       matchData ? {
          homeTeam:    matchData.homeTeam,
          awayTeam:    matchData.awayTeam,
          homeScore:   matchData.homeScore ?? 0,
          awayScore:   matchData.awayScore ?? 0,
          competition: matchData.leagueJa || matchData.league || "",
          matchday:    matchData.matchday || "",
          date:        dateArg,
          scorers:     (matchData.goals||[]).map(g=>({
            team: g.team===matchData.homeTeam?"home":"away", player: g.player, minute: g.minute||0
          })),
        } : null,
        // 画像取得ゼロ（VPS が埋める）
        imagePaths:      [],
        mainImagePath:   null,
        slide2ImagePath: null,
        slide3ImagePath: null,
        slide4ImagePath: null,
        slide5ImagePath: null,
        // VPS 画像取得指示
        _imgMeta: {
          title:       post.title,
          type:        post.type,
          source:      post.source,
          permalink:   post.permalink || null,
          url:         post.url || null,
          xSearchQuery,
          wikiWords,
          serperSnippets,
          matchData:   matchData || null,
          imgFetched:  false,
        },
        _rawComments:   { reddit: rawComments, x: [] },
        _rawCommentsJa: { reddit: redditJa,    x: [] },
        _commentPool: [
          ...rawComments.map(c => ({ text: c.replace(/^\[👍\d+\]\s*/,""), source: "reddit" })),
          ...(post.comments||[]).filter(c=>c.body).map(c => ({ text: c.body, source: "rss" })),
          ...xJaComments.map(c   => ({ text: c.text, user: c.user, source: "x_japan" })),
          ...xOtherComments.map(c => ({ text: c.text, user: c.user, source: `x_other_${fanLang}` })),
        ],
        _meta: {
          threadTitle: post.title,
          redditUrl:   post.url || (post.permalink ? `https://www.reddit.com${post.permalink}` : ""),
          threadType:  post.type,
        },
      };
    }));

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) newPosts.push(r.value);
      if (r.status === "rejected") console.warn(`⚠️ エラー: ${r.reason?.message}`);
    }
  }

  newPosts.sort((a, b) => a.num - b.num);

  // 既存コンテンツとマージ（同一タイトルは新規で上書き）
  const newTitles  = new Set(newPosts.map(p => p._meta?.threadTitle));
  const deduped    = existingContent.posts.filter(p => !newTitles.has(p._meta?.threadTitle));

  // 固有ID付与（MMDD + 3桁連番。既存IDは保持、新規のみ採番）
  const mmdd = dateArg.replace(/-/g, "").slice(4); // "0407"
  const existingCounters = deduped
    .filter(p => p.id && String(p.id).startsWith(mmdd))
    .map(p => parseInt(String(p.id).slice(4), 10));
  let nextCounter = existingCounters.length > 0 ? Math.max(...existingCounters) + 1 : 1;
  const taggedNewPosts = newPosts.map(p => ({ ...p, id: mmdd + String(nextCounter++).padStart(3, "0") }));

  const merged     = [...taggedNewPosts, ...deduped].map((p, i) => ({ ...p, num: i + 1 }));

  const outputData = {
    date:         dateArg,
    generated_at: new Date(Date.now() + jstOffset).toISOString().replace("Z","+09:00"),
    posts:        merged,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(contentFile, JSON.stringify(outputData, null, 2));
  console.log(`\n💾 保存: content_${dateArg}.json (${merged.length}件 / 今回生成${newPosts.length}件)`);

  // VPS に SCP 送信
  try {
    scpToVps(contentFile);
  } catch (e) {
    console.error(`❌ SCP失敗: ${e.message}`);
    return;
  }

  // VPS 画像取得ジョブを起動
  await triggerVpsImageFetch(dateArg);
  console.log("✅ Done.\n");
}

main().catch(e => { console.error(`❌ Fatal: ${e.message}`); process.exit(1); });
