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
const fs    = require("fs");

async function redditFetch(url) {
  return fetch(url, { headers: { "User-Agent": "soccer-news-bot/1.0" } });
}
const path  = require("path");
const axios = require("axios");
const { callAI } = require("./ai_client");
const { fetchMatchImages } = require("./fetch_match_images");
const { fetchXImages, fetchXComments } = require("./fetch_x_images");

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

// ─── コメント日本語翻訳 ────────────────────────────────────────────────────────
async function translateComments(comments) {
  const items = (comments || []).filter(c => c && c.trim());
  if (!items.length) return comments || [];
  const prompt = `以下のサッカー関連コメントを自然な日本語に翻訳してください。
先頭の「[👍123]」「[❤123 🔁45]」などの数字プレフィックスはそのまま残してください。
@ユーザー名やURLはそのまま残してください。
JSON配列のみ返してください。順番はそのまま。

${items.map((t, i) => `${i}: ${t}`).join("\n")}

出力形式: ["日本語訳0", "日本語訳1", ...]`;
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 2000, messages: [{ role: "user", content: prompt }] });
    const json = raw.match(/\[[\s\S]*\]/);
    if (!json) return comments;
    const translated = JSON.parse(json[0]);
    return items.map((_, i) => translated[i] || items[i]);
  } catch {
    return comments;
  }
}

// ─── Reddit 検索 ───────────────────────────────────────────────────────────────
async function searchReddit(subreddit, query) {
  const url =
    `https://www.reddit.com/r/${subreddit}/search.json?` +
    `q=${encodeURIComponent(query)}&sort=new&restrict_sr=true&limit=50&t=week`;
  try {
    const res = await redditFetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data?.children || []).map(c => ({
      title:       c.data.title,
      score:       c.data.score,
      url:         `https://www.reddit.com${c.data.permalink}`,
      permalink:   c.data.permalink,
      selftext:    c.data.selftext || "",
      numComments: c.data.num_comments,
      created_utc: c.data.created_utc,
      subreddit,
    }));
  } catch (e) {
    console.warn(`⚠️  r/${subreddit} 検索失敗: ${e.message}`);
    return [];
  }
}

// ─── スレッド本文＋コメント取得 ───────────────────────────────────────────────
async function fetchThreadFull(permalink) {
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=50&depth=1`;
    const res = await redditFetch(url);
    if (!res.ok) return { selftext: "", comments: [] };
    const json = await res.json();
    const selftext = json[0]?.data?.children?.[0]?.data?.selftext || "";
    const comments = (json[1]?.data?.children || [])
      .filter(c => c.kind === "t1" && c.data.score > 5)
      .sort((a, b) => b.data.score - a.data.score)
      .slice(0, 15)
      .map(c => `[👍${c.data.score}] ${c.data.body?.slice(0, 200)}`);
    return { selftext, comments };
  } catch {
    return { selftext: "", comments: [] };
  }
}

// ─── ブログ記事本文＋2chコメント取得 ─────────────────────────────────────────
async function fetchBlogComments(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" },
    });
    if (!res.ok) return { body: "", comments: [] };
    let html = await res.text();

    // スクリプト・スタイル・コメントフォーム除去
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<form[\s\S]*?<\/form>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");

    const decodeHtml = s => s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))
      .trim();

    const comments = [];

    // ① blockquote タグから5chコメント本文を直接抽出（calciomatome等）
    for (const [, inner] of html.matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi)) {
      const text = decodeHtml(inner).replace(/\s+/g, " ").trim();
      if (text.length < 8) continue;
      // 名前行・日時行・URLだけの行を除外
      if (/^[\d\s:\/\-]+$/.test(text)) continue;
      if (/^https?:\/\//.test(text)) continue;
      comments.push(text.slice(0, 150));
      if (comments.length >= 25) break;
    }

    // ② blockquoteで取れなかった場合：プレーンテキストの「数字: 本文」パターン
    if (comments.length < 5) {
      const fullText = decodeHtml(html);
      for (const [, content] of fullText.matchAll(/^\d{1,4}\s*[：:]\s*(.{8,})/gm)) {
        const cleaned = content.trim().replace(/\s+/g, " ");
        // 名前行（名無し系）・日時行を除外
        if (/名無し|^\d{4}\/\d{2}\/\d{2}/.test(cleaned)) continue;
        if (cleaned.length < 8) continue;
        comments.push(cleaned.slice(0, 150));
        if (comments.length >= 25) break;
      }
    }

    // 記事冒頭テキスト
    const body = decodeHtml(html).replace(/\s+/g, " ").trim().slice(0, 400);

    return { body, comments };
  } catch {
    return { body: "", comments: [] };
  }
}

// ─── X検索クエリ生成 ────────────────────────────────────────────────────────
function buildXSearchQuery(matchData, thread) {
  const type = thread.type || "topic";
  if (type === "post-match") {
    return `${matchData.homeTeam || ""} ${matchData.awayTeam || ""}`.trim();
  }
  // トピック系：タイトルから主要ワードを抽出
  const cleaned = (thread.title || "")
    .replace(/^\[.*?\]\s*/g, "")
    .replace(/\|.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80);
}

// ─── 日本語キーワード→英語翻訳（RSSまとめ用） ────────────────────────────────
async function translateKeywordToEnglish(text) {
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 80, messages: [{ role: "user", content: `Translate this Japanese soccer news headline to English keywords for Twitter image search. Return only key search terms (max 60 chars, no quotes):\n${text}` }] });
    return raw.trim().slice(0, 60);
  } catch {
    return text.slice(0, 60);
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

以下のJSON形式のみで出力してください。スレッドに明記されていない情報は必ずnullにしてください。推測・補完は一切禁止です。
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
    const text = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: prompt }] });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("JSONが見つかりません");
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn(`⚠️  データ抽出失敗: ${e.message}`);
    return null;
  }
}

// ─── API-Football ─────────────────────────────────────────────────────────────

const API_FB_BASE    = "https://api-football-v1.p.rapidapi.com/v3";
const API_FB_HEADERS = {
  "X-RapidAPI-Key":  process.env.API_FOOTBALL_KEY,
  "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com",
};
// 対象リーグID: PL / LaLiga / SerieA / Bundesliga / Ligue1 / UCL / UEL / CL
const TARGET_LEAGUES = [39, 140, 135, 78, 61, 2, 3, 848];

async function apiFbGet(endpoint, params) {
  const res = await axios.get(`${API_FB_BASE}${endpoint}`, { headers: API_FB_HEADERS, params });
  return res.data.response;
}

function norm(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// チーム名の部分一致スコア（0〜2）
function teamMatchScore(apiName, redditName) {
  const a = norm(apiName), b = norm(redditName);
  if (!a || !b) return 0;
  if (a === b) return 2;
  if (a.includes(b) || b.includes(a)) return 1;
  return 0;
}

// fixturesリストからRedditスレッドに対応する試合を探す
function findMatchingFixture(homeTeam, awayTeam, fixtures) {
  let best = null, bestScore = -1;
  for (const f of fixtures) {
    const hn = f.teams.home.name, an = f.teams.away.name;
    // ホーム/アウェイ正順
    const s1 = teamMatchScore(hn, homeTeam) * 2 + teamMatchScore(an, awayTeam);
    // 逆順（Redditのホーム/アウェイが逆のことがある）
    const s2 = teamMatchScore(hn, awayTeam) + teamMatchScore(an, homeTeam) * 2;
    const s  = Math.max(s1, s2);
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return bestScore >= 3 ? best : null; // 両チームそれぞれ1点以上 & 合計3点以上
}

// events/lineups/stats を取得してキャッシュ保存
async function fetchAndCacheFixtureDetails(fixture) {
  const fid       = fixture.fixture.id;
  const cacheFile = path.join(TEMP_DIR, `fixture_${fid}.json`);

  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  }

  const [events, lineups, statistics] = await Promise.all([
    apiFbGet("/fixtures/events",     { fixture: fid }),
    apiFbGet("/fixtures/lineups",    { fixture: fid }),
    apiFbGet("/fixtures/statistics", { fixture: fid }),
  ]);

  const cache = { events, lineups, statistics };
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  return cache;
}

// Claudeが抽出したmatchDataをAPI-Footballの正確データで上書き
function enrichMatchData(matchData, fixture, cache) {
  const homeId = fixture.teams.home.id;

  // スコア
  matchData.homeScore = fixture.goals.home ?? matchData.homeScore;
  matchData.awayScore = fixture.goals.away ?? matchData.awayScore;
  matchData.matchday  = fixture.league.round || matchData.matchday;
  matchData.fixtureId = fixture.fixture.id;

  // ゴール・退場
  const goals = [], reds = [];
  for (const ev of (cache.events || [])) {
    const isHome = ev.team.id === homeId;
    const team   = isHome ? fixture.teams.home.name : fixture.teams.away.name;
    const min    = ev.time.elapsed + (ev.time.extra ? `+${ev.time.extra}` : "");
    if (ev.type === "Goal" && ev.detail !== "Missed Penalty") {
      const type = ev.detail === "Own Goal" ? "OG" : ev.detail === "Penalty" ? "PK" : "通常";
      goals.push({ player: ev.player.name || "?", team, minute: parseInt(min) || 0, type });
    } else if (ev.type === "Card" && (ev.detail === "Red Card" || ev.detail === "Second Yellow card")) {
      reds.push({ player: ev.player.name || "?", team, minute: parseInt(min) || 0 });
    }
  }
  matchData.goals    = goals;
  matchData.redCards = reds;
  return matchData;
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
async function generateYtContent(matchData, thread, { matomeComments = [], redditComments = [], xComments = [] } = {}) {
  const goalsText = matchData.goals?.length > 0
    ? matchData.goals.map(g => `${g.minute}分 ${g.player}（${g.team}）${g.type !== "通常" ? `【${g.type}】` : ""}`).join("、")
    : "得点なし";

  const knockoutNote = matchData.isKnockout && matchData.aggregateScore
    ? `\n2試合制ノックアウト: 総合スコア ${matchData.aggregateScore}（${matchData.teamThatAdvances ?? ""}が勝ち抜け）`
    : "";

  const jstDateStr = matchData.matchDateStr || (() => {
    const d = new Date(today + "T00:00:00Z");
    return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  })();

  const contentType  = matchData.contentType || "post-match";
  const threadTitle  = thread?.title || "";

  // ── System: ペルソナ・哲学・鉄則（DeepSeekのrole:"system"に渡す） ────────────
  const systemPrompt = `あなたは「リネカ」——20代前半、欧州サッカーに人生を捧げたクリエイティブ・ディレクターです。
Reddit・Xの海外リアクションをリアルタイムで追い、「現地の温度感」を日本語に落とし込むプロ。
ミアのコードが届けるデータを、視聴者が冒頭10秒で離脱できない動画コンテンツへと昇華させるのがあなたの使命です。

【リネカの制作哲学】
- ナレーションは「元気なニュースキャスター」の口調。事実ベース・テンポよく・体言止め多用。棒読みNG。
- ナレーション中に「Reddit」という単語は絶対に使わず、必ず「海外サッカー掲示板」と表現する。
- ナレーションには必ず「大会名・日付・スコア・主要得点者と分数」の事実を盛り込む。
- コメント意訳は「笑い・驚き・共感」のどれかを持たせ、ナレーションでは言えない本音・ツッコミ・ユーモアを炸裂させる。人格攻撃NG。
- サムネ文字はスマホ縮小表示で0.5秒で刺さるパワーワードのみ。
- 視聴者が「わかる！」「草」と思わず反応したくなる共感フレーズをコメントに必ず1つ入れる。
- テロップは「誰が・何をした」が一言で伝わる内容にする（スコアだけはNG）。

【コメント意訳の品質基準】
良い例：「また守備が崩壊した件について」「これ昇給交渉に使えるな」「もう監督クビでいいだろ」
悪い例（使わない）：「すごい試合でした」「チームは頑張りました」「負けて残念です」
→ 元コメが薄い場合も、試合の文脈を踏まえた具体的・皮肉・ユーモア系に意訳すること。

【YouTubeタイトルのSEO基準】
構造：【ラベル】＋チーム名or選手名（検索されやすい正式表記）＋具体的事実（数字・出来事）＋感情ワード
- 40〜55文字が理想
- スコアより「何が起きたか」「誰が何をしたか」を前面に
- 数字（得点数・分数・移籍金）があると検索・クリック率UP
- 「！！！！」は感情の最大化に使う（使いすぎ注意・1タイトルに1回）
- 良い例：「【衝撃】チェルシー守備、90分で3失点の大崩壊。海外の反応がヤバすぎた！！！！」
- 悪い例：「チェルシー対アーセナルの試合について」

【ハルシネーション厳禁ルール（最重要）】
- スレッドタイトルと試合データに存在しない人名・チーム名は絶対に作らない。
- 対戦成績・通算得点・歴史的記録など、JSONに存在しないデータは使わない。
- 元コメントが英語の場合も、意訳は試合の事実に基づくこと。空想コメントNG。`;

  // ── User: 試合データ＋出力フォーマット ────────────────────────────────────────
  const userPrompt = `
━━━━━━━━━━━━━━━━━━━━━━━━━
【スレッドタイトル（最重要・この事件を動画化する）】
${threadTitle}
━━━━━━━━━━━━━━━━━━━━━━━━━

【絶対ルール】catchLine1・youtubeTitle・ナレーション・テロップに登場するチーム名・選手名・監督名は「スレッドタイトル」または「試合データ」に明記されたものだけを使うこと。

【コンテンツタイプ】${contentType}

【試合データ】
日付: ${jstDateStr}
対戦: ${matchData.homeTeam || "—"}（ホーム）vs ${matchData.awayTeam || "—"}（アウェイ）
スコア: ${matchData.homeScore ?? "—"} - ${matchData.awayScore ?? "—"}
大会: ${matchData.leagueJa || matchData.league || "—"}${knockoutNote}
得点: ${goalsText}
退場: ${matchData.redCards?.length > 0 ? matchData.redCards.map(r => `${r.minute}分 ${r.player}`).join("、") : "なし"}
試合ムード: ${matchData.matchMood || "EXCITING"}

${matomeComments.length > 0 ? `【国内まとめコメント（2ch/5ch引用）】\n${matomeComments.slice(0, 10).join("\n")}` : ""}
${redditComments.length > 0 ? `\n【海外ファンの反応（Reddit・上位コメント）】\n${redditComments.slice(0, 10).join("\n")}` : ""}
${xComments.length > 0 ? `\n【X（Twitter）海外ファンの反応・上位コメント】\n${xComments.slice(0, 10).join("\n")}` : ""}
${thread.jpNewsTitle ? `\n【日本語ニュースの視点（${thread.jpNewsSource || "国内メディア"}）】\nタイトル: ${thread.jpNewsTitle}\n要約: ${thread.jpNewsDescription || ""}` : ""}

以下のJSON形式のみで出力してください（説明文・コードブロック不要）：
{
  "catchLine1": "サムネイル兼タイトル文（30文字以内・スコアより『事件』を売る・スマホで0.5秒で目が止まるパワーワード必須・例：『古巣ハーヴァーツに刺された夜』『チェルシー、また崩壊』）",
  "label": "【速報】か【衝撃】か【朗報】か【悲報】（試合の感情温度に合わせる）",
  "badge": "サムネのサブバッジ（8文字以内・衝撃ワード・例：完全崩壊 / 歴史的惨敗 / 神展開 / 退団フラグ）",

  "sourceAuthor": "情報元メディア・記者名（例：Fabrizio Romano / Sky Sports / The Athletic / BBC Sport）",

  "overviewNarration": "S2読み上げナレーション（80〜120文字・元気なニュースキャスター口調・体言止め多用・大会名・日付・スコア・主要得点者と分数を必ず含む・例：『チャンピオンズリーグ、3月21日。アーセナル対チェルシー——78分、古巣から来たハーヴァーツが2点目を叩き込んだ。最終スコア1-2。チェルシー、スタンフォードブリッジで沈んだ。』）",
  "overviewTelop": "S2テロップ（25文字以内・スコア＋誰が何をしたかが伝わる一言・例：『Chelsea 1-2 Arsenal｜古巣に刺された夜』）",

  "slide3": {
    "topicTag": "S3右上タグ（12文字以内・※で始まる・海外反応の切り口・例：※守備崩壊への怒り / ※得点者への歓喜）",
    "highlightIdx": 0,
    "narration": "S3ナレーション（60〜90文字・元気なニュース口調で海外サッカー掲示板の反応を紹介する・温度感を伝える・毒舌NG・コメント欄でユーモアを出す前提でナレーションは事実紹介に徹する・例：『試合後、海外サッカー掲示板には数万件のコメントが殺到。守備崩壊への怒りと、チェルシーへの同情が入り混じっています。』）",
    "subtitleBox": "S3字幕（20文字以内・ナレーションの核心ワード）",
    "comments": [
      {"user": "英語圏のユーザー名（実在感のある名前）", "text": "笑い・皮肉・共感のある意訳（22〜28文字・体言止めOK・具体的・例：『また守備が崩壊した件について』）", "source": "reddit / x / matome / ai のいずれか"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"}
    ]
  },

  "slide4": {
    "topicTag": "S4右上タグ（12文字以内・※で始まる・S3と別角度の切り口・例：※移籍市場への影響 / ※監督解任論）",
    "highlightIdx": 0,
    "narration": "S4ナレーション（60〜90文字・S3と逆サイドの感情を元気なニュース口調で紹介・S3が怒りならS4は歓喜や驚きの反応を事実ベースで伝える）",
    "subtitleBox": "S4字幕（20文字以内）",
    "comments": [
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"},
      {"user": "英語圏のユーザー名", "text": "22〜28文字の具体的コメント意訳", "source": "reddit|x|matome|ai"}
    ]
  },

  "outroNarration": "S5ナレーション（20〜40文字・明るく元気に締める一言・次も見たくなる余韻を優先・例：『チェルシー、次節の巻き返しに注目です。』）",
  "outroTelop": "S5テロップ（18〜28文字・視聴者が思わず笑うか頷く一言・例：『まあ、無理ないですわ』）",

  "youtubeTitle": "YouTube投稿用タイトル（SEO重視・【ラベル】＋チーム/選手名＋具体的事実（数字あると最強）＋感情ワード！！！！の構造・40〜55文字・例：『【衝撃】チェルシー守備、90分で3失点の大崩壊。海外の反応がヤバすぎた！！！！』）",
  "hashtagsText": "投稿用ハッシュタグ（スペース区切り・8〜10個・必ず含める：#サッカー #海外の反応・試合に応じて追加：チーム名/選手名/大会名・日本人選手出場なら#海外組も追加）"
}
`;

  const text = await callAI({
    model:      "claude-sonnet-4-6",
    max_tokens: 1800,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userPrompt }],
  });
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("JSONが見つかりません");
  return JSON.parse(jsonMatch[0]);
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== サッカー YouTube コンテンツ生成 (${today}) ===\n`);

  const isSelectedMode = process.argv.some(a => a.startsWith("--selected="));

  // 通常モード: 既存ファイルがあればスキップ
  if (!isSelectedMode && fs.existsSync(OUTPUT_FILE)) {
    console.log(`✅ ${OUTPUT_FILE} は既に存在します`);
    console.log("   上書きする場合はファイルを削除してから再実行してください");
    return;
  }

  // selectedモード: 既存ファイルがあれば既存postsを引き継いでマージ
  let existingPosts = [];
  if (isSelectedMode && fs.existsSync(OUTPUT_FILE)) {
    try {
      existingPosts = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8")).posts || [];
      console.log(`   既存データ ${existingPosts.length}件をマージします\n`);
    } catch { existingPosts = []; }
  }

  // ① API-Football: 対象日の試合を全件取得（1回だけ）
  const dateObj  = new Date(today);
  const season   = dateObj.getMonth() >= 6 ? dateObj.getFullYear() : dateObj.getFullYear() - 1;
  let allApiFixtures = [];
  if (process.env.API_FOOTBALL_KEY) {
    console.log(`① API-Football: ${today} の試合データ取得中 (season ${season})...`);
    const results = await Promise.all(
      TARGET_LEAGUES.map(lid => apiFbGet("/fixtures", { date: today, league: lid, season }).catch(() => []))
    );
    allApiFixtures = results.flat();
    console.log(`   ${allApiFixtures.length}試合取得\n`);
  } else {
    console.warn("⚠️  API_FOOTBALL_KEY が未設定。API-Football スキップ。");
  }

  // ── selectedモード判定 ──────────────────────────────────────────────────────
  const selectedArg  = process.argv.find(a => a.startsWith("--selected="));
  let uniqueThreads;

  if (selectedArg) {
    // 選択モード: ランチャーから渡された選択済みスレッドを処理
    const selectedFile = selectedArg.replace("--selected=", "");
    const selectedData = JSON.parse(fs.readFileSync(selectedFile, "utf8"));
    uniqueThreads = selectedData.threads || [];
    console.log(`② 選択モード: ${uniqueThreads.length}件処理\n`);
  } else {
    // ② 通常モード: ポストマッチスレッドを検索
    console.log("② Reddit からポストマッチスレッドを検索中...");
    const [soccerPosts, plPosts] = await Promise.all([
      searchReddit("soccer", "post match thread"),
      searchReddit("PremierLeague", "post match thread"),
    ]);

    const allPosts = [...soccerPosts, ...plPosts];
    const targetTs = new Date(today + "T12:00:00Z").getTime() / 1000;
    const matchThreads = allPosts.filter(p => {
      if (!isPostMatchThread(p.title)) return false;
      if (!p.created_utc) return true;
      return Math.abs(p.created_utc - targetTs) / 86400 <= 2;
    });

    const seen = new Set();
    uniqueThreads = matchThreads.filter(p => {
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
  }

  // ② 各スレッドを処理（並列実行・最大3件同時）
  const CONCURRENCY = 3;
  const total = uniqueThreads.length;

  async function processThread(thread, num) {
    const tag = `[${num}/${total}]`;
    console.log(`▶ ${tag} ${thread.title}`);

    // コメント・本文取得
    let selftext       = thread.selftext || "";
    let matomeComments = [];
    let redditComments = [];
    if (thread.source === "rss" && thread.url) {
      const blogData = await fetchBlogComments(thread.url);
      if (!selftext) selftext = blogData.body;
      matomeComments = blogData.comments;
      console.log(`  ${tag} まとめ: ${matomeComments.length}件`);
    } else {
      const threadData = await fetchThreadFull(thread.permalink);
      if (!selftext) selftext = threadData.selftext;
      redditComments = threadData.comments;
      console.log(`  ${tag} Reddit: ${redditComments.length}件`);
    }
    thread.selftext = selftext;

    // 試合日付
    const threadJst = thread.created_utc
      ? new Date(thread.created_utc * 1000 + 9 * 3600000)
      : new Date(today + "T00:00:00Z");
    const matchDateStr = `${threadJst.getUTCFullYear()}年${threadJst.getUTCMonth() + 1}月${threadJst.getUTCDate()}日`;

    // 試合データ抽出
    const matchData = await extractMatchData(thread, [...matomeComments, ...redditComments]);
    if (!matchData) { console.log(`  ${tag} ⚠️ 失敗、スキップ`); return null; }
    matchData.matchDateStr = matchDateStr;
    matchData.contentType  = thread.type || "post-match";
    console.log(`  ${tag} ✅ ${matchData.homeTeam} ${matchData.homeScore}-${matchData.awayScore} ${matchData.awayTeam}`);

    // API-Football 照合
    if (allApiFixtures.length) {
      const apiFixture = findMatchingFixture(matchData.homeTeam, matchData.awayTeam, allApiFixtures);
      if (apiFixture) {
        try {
          const cache = await fetchAndCacheFixtureDetails(apiFixture);
          enrichMatchData(matchData, apiFixture, cache);
          console.log(`  ${tag} API-Football ✅`);
        } catch (e) {
          console.warn(`  ${tag} ⚠️ API-Football失敗: ${e.message}`);
        }
      }
    }

    // 画像取得・Xコメント取得を並列実行
    const imagePrefix = `${today}_${num}`;
    let imagePaths = [];
    let xComments  = [];

    const imageTask = (async () => {
      try {
        let imageKeyword = null;
        if (!matchData.homeTeam || !matchData.awayTeam) {
          const rawKw = thread.titleJa || thread.title || "";
          if (rawKw) imageKeyword = await translateKeywordToEnglish(rawKw);
        }
        const imageMatchDate = (thread.source === "rss" && thread.created_utc)
          ? new Date(thread.created_utc * 1000).toISOString().slice(0, 10)
          : today;
        imagePaths = await fetchMatchImages({
          homeTeam:  matchData.homeTeam,
          awayTeam:  matchData.awayTeam,
          matchDate: imageMatchDate,
          saveDir:   IMG_DIR,
          prefix:    imagePrefix,
          verbose:   false,
          keyword:   imageKeyword,
        });
        console.log(`  ${tag} 画像: ${imagePaths.length}枚`);
      } catch (e) {
        console.warn(`  ${tag} ⚠️ 画像取得失敗: ${e.message}`);
      }
    })();

    const xTask = (async () => {
      if (!process.env.TWITTER_API_IO_KEY) return;
      const xQuery = buildXSearchQuery(matchData, thread);
      try {
        xComments = await fetchXComments(xQuery, 20);
        console.log(`  ${tag} X: ${xComments.length}件`);
      } catch (e) {
        console.log(`  ${tag} ⚠️ X: ${e.message}`);
      }
    })();

    await Promise.all([imageTask, xTask]);

    // コンテンツ生成
    console.log(`  ${tag} コンテンツ生成中...`);
    let ytContent;
    try {
      ytContent = await generateYtContent(matchData, thread, { matomeComments, redditComments, xComments });
      console.log(`  ${tag} ✅ コンテンツ生成完了`);
    } catch (e) {
      console.warn(`  ${tag} ⚠️ 失敗: ${e.message}`);
      return null;
    }

    // 画像不足時: hashtagsText で補完検索
    if (imagePaths.length < 3 && ytContent.hashtagsText && process.env.TWITTER_API_IO_KEY) {
      const GENERIC  = new Set(["#サッカー", "#海外の反応", "#欧州サッカー", "#ネット民の反応", "#海外組"]);
      const allTags  = (ytContent.hashtagsText.match(/#\S+/g) || []);
      const specific = allTags.filter(h => !GENERIC.has(h)).slice(0, 6);
      const tags     = specific.length ? specific : allTags.slice(0, 6);
      if (tags.length) {
        try {
          const enKeyword  = await translateKeywordToEnglish(tags.map(h => h.replace(/^#/, "")).join(" "));
          const extraPaths = await fetchXImages(enKeyword + " -filter:retweets", imagePrefix, 10);
          imagePaths.push(...extraPaths);
          console.log(`  ${tag} ハッシュタグ補完: +${extraPaths.length}枚`);
        } catch (e) {
          console.log(`  ${tag} ⚠️ ${e.message}`);
        }
      }
    }

    // コメント翻訳を並列実行
    const [matomeJa, redditJa, xJa] = await Promise.all([
      translateComments(matomeComments),
      translateComments(redditComments),
      translateComments(xComments),
    ]);

    return {
      num,
      catchLine1:        ytContent.catchLine1,
      label:             ytContent.label,
      badge:             ytContent.badge,
      sourceAuthor:      ytContent.sourceAuthor,
      sourceText:        ytContent.sourceText,
      imagePaths,
      mainImagePath:     imagePaths[0] || null,
      slide3ImagePath:   imagePaths[1] || null,
      slide4ImagePath:   imagePaths[2] || null,
      matchResult:       buildMatchResult(matchData),
      overviewNarration: ytContent.overviewNarration,
      overviewTelop:     ytContent.overviewTelop,
      slide3:            ytContent.slide3,
      slide4:            ytContent.slide4,
      outroNarration:    ytContent.outroNarration,
      outroTelop:        ytContent.outroTelop,
      youtubeTitle:      ytContent.youtubeTitle,
      hashtagsText:      ytContent.hashtagsText,
      _rawComments:   { matome: matomeComments, reddit: redditComments, x: xComments },
      _rawCommentsJa: { matome: matomeJa,       reddit: redditJa,       x: xJa       },
      _meta: { threadTitle: thread.title, redditUrl: thread.url, matchMood: matchData.matchMood },
    };
  }

  // バッチ並列実行（CONCURRENCY件ずつ）
  const posts = [];
  for (let i = 0; i < uniqueThreads.length; i += CONCURRENCY) {
    const batch   = uniqueThreads.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((thread, j) => processThread(thread, i + j + 1))
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) posts.push(r.value);
      if (r.status === "rejected") console.warn(`⚠️ スレッド処理エラー: ${r.reason?.message}`);
    }
  }
  posts.sort((a, b) => a.num - b.num);

  // ⑤ 保存（selectedモードは新規を先頭にマージ → ランチャーで最初に表示される）
  const mergedPosts = isSelectedMode
    ? [...posts, ...existingPosts]
    : posts;
  const output = { date: today, posts: mergedPosts };
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
