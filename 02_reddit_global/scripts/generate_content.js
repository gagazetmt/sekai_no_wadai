// generate_content.js
// サッカー YouTube コンテンツ生成（A/B 統合版）
//
// thread.type === "post-match" → Script A（試合）
// それ以外                     → Script B（トピック）
//
// 使い方: node scripts/generate_content.js --selected=temp/selected_YYYY-MM-DD.json [YYYY-MM-DD]

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs        = require("fs");
const path      = require("path");
const axios     = require("axios");
const { callAI } = require("./ai_client");
const { fetchMatchImages }         = require("./fetch_match_images");
const { fetchXImages, fetchXComments, fetchOfficialXImages, fetchOfficialXImagesFromQuery } = require("./fetch_x_images");
const { fetchWikimediaImages }     = require("./fetch_wikimedia");

const TEAM_MANAGERS_PATH = path.join(__dirname, "..", "logos", "team_managers.json");
const _teamManagers = (() => {
  try { return JSON.parse(fs.readFileSync(TEAM_MANAGERS_PATH, "utf8")).managers || {}; }
  catch { return {}; }
})();

/** チーム名リストから監督名を返す（重複除去） */
function lookupManagers(teamNames) {
  const seen = new Set();
  const result = [];
  for (const name of teamNames) {
    const mgr = _teamManagers[name];
    if (mgr && !seen.has(mgr)) { seen.add(mgr); result.push(mgr); }
  }
  return result;
}

const TEMP_DIR = path.join(__dirname, "..", "temp");
const IMG_DIR  = path.join(__dirname, "..", "images");
[TEMP_DIR, IMG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const today     = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
               || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const OUTPUT_FILE = path.join(TEMP_DIR, `soccer_yt_content_${today}.json`);

// ─── 共通: コメント日本語翻訳 ─────────────────────────────────────────────────
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

// ─── 共通: Reddit スレッド本文＋コメント取得 ──────────────────────────────────
async function fetchThreadFull(permalink) {
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=50&depth=1`;
    const res = await fetch(url, { headers: { "User-Agent": "soccer-news-bot/1.0" } });
    if (!res.ok) return { selftext: "", comments: [] };
    const json = await res.json();
    const selftext = json[0]?.data?.children?.[0]?.data?.selftext || "";
    const comments = (json[1]?.data?.children || [])
      .filter(c => c.kind === "t1" && c.data.score > 4)
      .sort((a, b) => b.data.score - a.data.score)
      .slice(0, 15)
      .map(c => `[👍${c.data.score}] ${c.data.body?.slice(0, 200)}`);
    return { selftext, comments };
  } catch {
    return { selftext: "", comments: [] };
  }
}

// ─── RSS/まとめ記事のOG画像取得 ───────────────────────────────────────────────
async function fetchOgImage(articleUrl, saveDir, prefix) {
  try {
    const res  = await axios.get(articleUrl, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
    const html = res.data;
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!m) return [];
    const imgUrl  = m[1].startsWith("//") ? "https:" + m[1] : m[1];
    const ext     = imgUrl.includes(".png") ? "png" : "jpg";
    const dest    = path.join(saveDir, `${prefix}_og.${ext}`);
    const imgRes  = await axios.get(imgUrl, { responseType: "arraybuffer", timeout: 12000 });
    fs.writeFileSync(dest, imgRes.data);
    const kb = Math.round(fs.statSync(dest).size / 1024);
    console.log(`  OG画像取得: ${path.basename(dest)} (${kb}KB)`);
    return [dest];
  } catch (e) {
    console.log(`  OG画像取得失敗: ${e.message}`);
    return [];
  }
}

// ─── 共通: X 検索クエリ生成 ──────────────────────────────────────────────────
function buildXSearchQuery(thread, matchData = null) {
  if (thread.type === "post-match" && matchData) {
    return `${matchData.homeTeam || ""} ${matchData.awayTeam || ""}`.trim();
  }
  return (thread.title || "")
    .replace(/^\[.*?\]\s*/g, "")
    .replace(/\|.*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// ─── 日本語→英語キーワード翻訳（まとめ/トピック記事の画像検索用） ─────────────
async function translateKeywordToEnglish(text) {
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 80, messages: [{ role: "user", content: `Translate this Japanese soccer news headline to English keywords for Twitter image search. Return only key search terms (max 60 chars, no quotes):\n${text}` }] });
    return raw.trim().slice(0, 60);
  } catch { return text.slice(0, 60); }
}

// ─── 画像検索用キーワード抽出（チーム・選手・監督名を最大3件） ────────────────
async function extractImageKeywords(title) {
  try {
    const raw = await callAI({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      messages: [{ role: "user", content: `Extract up to 3 English proper nouns (team names, player names, manager names) from this soccer news headline for image search. Return a JSON array only, e.g. ["England","Tuchel","Foden"]. No explanation.\n${title}` }],
    });
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr.filter(w => w && w.length >= 2).slice(0, 3) : [];
  } catch { return []; }
}

// ════════════════════════════════════════════════════════════════════════════
// SCRIPT A: 試合（post-match）
// ════════════════════════════════════════════════════════════════════════════

const LEAGUE_KEYWORDS  = [
  "Premier League", "La Liga", "Bundesliga", "Ligue 1", "Serie A",
  "Champions League", "Europa League", "Conference League",
  "World Cup", "FA Cup", "Copa del Rey",
];
const TARGET_LEAGUES   = [39, 140, 135, 78, 61, 2, 3, 848];
const API_FB_BASE      = "https://api-football-v1.p.rapidapi.com/v3";
const API_FB_HEADERS   = {
  "X-RapidAPI-Key":  process.env.API_FOOTBALL_KEY,
  "X-RapidAPI-Host": "api-football-v1.p.rapidapi.com",
};

async function apiFbGet(endpoint, params) {
  const res = await axios.get(`${API_FB_BASE}${endpoint}`, { headers: API_FB_HEADERS, params });
  return res.data.response;
}

function norm(str) { return (str || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function findMatchingFixture(homeTeam, awayTeam, fixtures) {
  const score = (apiName, name) => {
    const a = norm(apiName), b = norm(name);
    if (!a || !b) return 0;
    if (a === b) return 2;
    if (a.includes(b) || b.includes(a)) return 1;
    return 0;
  };
  let best = null, bestScore = -1;
  for (const f of fixtures) {
    const hn = f.teams.home.name, an = f.teams.away.name;
    const s = Math.max(
      score(hn, homeTeam) * 2 + score(an, awayTeam),
      score(hn, awayTeam) + score(an, homeTeam) * 2
    );
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return bestScore >= 3 ? best : null;
}

async function fetchAndCacheFixtureDetails(fixture) {
  const fid       = fixture.fixture.id;
  const cacheFile = path.join(TEMP_DIR, `fixture_${fid}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const [events, lineups, statistics] = await Promise.all([
    apiFbGet("/fixtures/events",     { fixture: fid }),
    apiFbGet("/fixtures/lineups",    { fixture: fid }),
    apiFbGet("/fixtures/statistics", { fixture: fid }),
  ]);
  const cache = { events, lineups, statistics };
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  return cache;
}

function enrichMatchData(matchData, fixture, cache) {
  const homeId = fixture.teams.home.id;
  matchData.homeScore = fixture.goals.home ?? matchData.homeScore;
  matchData.awayScore = fixture.goals.away ?? matchData.awayScore;
  matchData.matchday  = fixture.league.round || matchData.matchday;
  matchData.fixtureId = fixture.fixture.id;
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

async function extractMatchData(thread, comments) {
  const prompt = `
以下はRedditのサッカー試合スレッドです。構造化データとして抽出してください。

【スレッドタイトル】
${thread.title}

【スレッド本文】
${(thread.selftext || "").slice(0, 1000) || "（本文なし）"}

【上位コメント（英語）】
${comments.slice(0, 10).join("\n")}

以下のJSON形式のみで出力してください。スレッドに明記されていない情報は必ずnullにしてください。推測・補完は一切禁止です。
{
  "homeTeam": "ホームチーム名（英語）",
  "awayTeam": "アウェイチーム名（英語）",
  "homeScore": 数字,
  "awayScore": 数字,
  "league": "リーグ名（英語）",
  "leagueJa": "リーグ名（日本語）",
  "matchday": "節・ラウンド情報またはnull",
  "isKnockout": true/false,
  "aggregateScore": "総合スコアまたはnull",
  "teamThatAdvances": "勝ち抜けチーム名またはnull",
  "goals": [{"player": "選手名", "team": "チーム名", "minute": 数字, "type": "通常/PK/OG"}],
  "redCards": [{"player": "選手名", "team": "チーム名", "minute": 数字}],
  "matchMood": "EXCITING/SHOCKING/CONTROVERSIAL/DOMINANT/BORING のいずれか"
}
`;
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: prompt }] });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("JSONが見つかりません");
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn(`  ⚠️  データ抽出失敗: ${e.message}`);
    return null;
  }
}

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

async function generateMatchContent(matchData, comments, thread, xComments = []) {
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

  const prompt = `
あなたは「リネカ」——20代前半、欧州サッカーに人生を捧げたクリエイティブ・ディレクターです。
Reddit・Xの海外リアクションをリアルタイムで追い、「現地の温度感」を日本語に落とし込むプロ。
以下のデータをもとに、視聴者が冒頭10秒で離脱できない動画コンテンツを設計してください。

━━━━━━━━━━━━━━━━━━━━━━━━━
【スレッドタイトル（最重要・この事件を動画化する）】
${thread.title}
━━━━━━━━━━━━━━━━━━━━━━━━━

【コンテンツタイプ】post-match（試合後）

【絶対ルール】
スレッドタイトルと試合データに存在しない人名・チーム名は絶対に使わない。
架空の数字・記録・対戦成績は使わない。JSONに存在しないデータには触れない。

【リネカの制作哲学】
- ナレーションは「元気なニュースキャスター」口調。事実ベース・テンポよく・体言止め多用。
- ナレーション中に「Reddit」という単語は絶対に使わず、必ず「海外サッカー掲示板」と表現すること。
- ナレーションには必ず「大会名・日付・スコア・主要得点者と分数」を盛り込む。
- コメント意訳は「笑い・驚き・共感」のどれかを持たせる。人格攻撃NG。
- サムネ文字はスマホ縮小表示で0.5秒で刺さるパワーワードのみ。

【試合データ】
日付: ${jstDateStr}
対戦: ${matchData.homeTeam}（ホーム）vs ${matchData.awayTeam}（アウェイ）
スコア: ${matchData.homeScore ?? "—"} - ${matchData.awayScore ?? "—"}
大会: ${matchData.leagueJa || matchData.league || "—"}${knockoutNote}
得点: ${goalsText}
退場: ${matchData.redCards?.length > 0 ? matchData.redCards.map(r => `${r.minute}分 ${r.player}`).join("、") : "なし"}
試合ムード: ${matchData.matchMood || "EXCITING"}

【海外ファンの反応（Reddit）】
${comments.slice(0, 15).join("\n")}
${xComments.length > 0 ? `\n【X（Twitter）海外ファンの反応】\n${xComments.slice(0, 15).join("\n")}` : ""}
${thread.jpNewsTitle ? `\n【日本語ニュースの視点（${thread.jpNewsSource || "国内メディア"}）】\nタイトル: ${thread.jpNewsTitle}\n要約: ${thread.jpNewsDescription || ""}` : ""}

以下のJSON形式のみで出力してください：
{
  "catchLine1": "サムネイル兼タイトル文（30文字以内・スコアより『事件』を売る）",
  "label": "【速報】か【衝撃】か【朗報】か【悲報】",
  "badge": "サムネのサブバッジ（8文字以内）",
  "sourceAuthor": "情報元メディア・記者名",
  "sourceText": "試合の核心を切り取ったソーステキスト（日本語・2〜4行・改行で読みやすく）",
  "overviewNarration": "S2ナレーション（80〜120文字・ニュースキャスター口調・大会名・日付・スコア・得点者と分数を必ず含む）",
  "overviewTelop": "S2テロップ（25文字以内・スコア＋一言）",
  "slide3": {
    "topicTag": "S3右上タグ（12文字以内・※で始まる）",
    "highlightIdx": 0,
    "narration": "S3ナレーション（60〜90文字）",
    "subtitleBox": "S3字幕（20文字以内）",
    "comments": [
      {"user": "英語圏っぽい名前", "text": "22〜28文字の意訳"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"}
    ]
  },
  "slide4": {
    "topicTag": "S4右上タグ（12文字以内・※で始まる・S3と別角度）",
    "highlightIdx": 0,
    "narration": "S4ナレーション（60〜90文字）",
    "subtitleBox": "S4字幕（20文字以内）",
    "comments": [
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"}
    ]
  },
  "outroNarration": "S5ナレーション（20〜40文字・次も見たくなる余韻）",
  "outroTelop": "S5テロップ（18〜28文字・登録呼びかけ厳禁・この案件で一番笑えるor刺さるツッコミ一言・例：『まあそりゃそうだよな』『いや待って本当に？』）",
  "youtubeTitle": "YouTubeタイトル（SEO重視・40〜55文字）",
  "hashtagsText": "ハッシュタグ（スペース区切り・8〜10個・必ず#サッカー #海外の反応 含む）"
}
`;

  const raw = await callAI({ model: "claude-sonnet-4-6", max_tokens: 2200, messages: [{ role: "user", content: prompt }] });
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("JSONが見つかりません");
  return JSON.parse(jsonMatch[0]);
}

// ════════════════════════════════════════════════════════════════════════════
// SCRIPT B: トピック（transfer / injury / manager / topic）
// ════════════════════════════════════════════════════════════════════════════

const TYPE_LABEL_MAP = {
  transfer: "移籍情報",
  injury:   "負傷情報",
  manager:  "監督情報",
  finance:  "財政・制裁",
  topic:    "注目トピック",
};

async function generateTopicContent(topicData, comments, thread, xComments = []) {
  const typeLabel = TYPE_LABEL_MAP[thread.type] || "注目トピック";

  const prompt = `
あなたは「リネカ」——20代前半、欧州サッカーに人生を捧げたクリエイティブ・ディレクターです。
Reddit・Xの海外リアクションをリアルタイムで追い、「現地の温度感」を日本語に落とし込むプロ。
以下のデータをもとに、視聴者が冒頭10秒で離脱できない動画コンテンツを設計してください。

━━━━━━━━━━━━━━━━━━━━━━━━━
【スレッドタイトル（最重要・この話題を動画化する）】
${thread.title}
━━━━━━━━━━━━━━━━━━━━━━━━━

【コンテンツタイプ】${typeLabel}

【絶対ルール】
スレッドタイトルと以下のデータに存在しない人名・チーム名・数字は絶対に使わない。
架空の記録・詳細は使わない。データにない情報には触れない。

【リネカの制作哲学】
- ナレーションは「元気なニュースキャスター」口調。事実ベース・テンポよく・体言止め多用。
- ナレーション中に「Reddit」という単語は絶対に使わず、必ず「海外サッカー掲示板」と表現すること。
- コメント意訳は「笑い・驚き・共感」のどれかを持たせる。人格攻撃NG。
- サムネ文字はスマホ縮小表示で0.5秒で刺さるパワーワードのみ。
- overviewTelop はスコアではなく「誰が・何をした」が即わかる内容にする。

【トピックデータ】
タイプ: ${typeLabel}
スレッドタイトル: ${thread.title}
${thread.jpNewsTitle ? `日本語ニュースタイトル（${thread.jpNewsSource || "国内メディア"}）: ${thread.jpNewsTitle}\n要約: ${thread.jpNewsDescription || ""}` : ""}

【スレッド本文】
${(topicData.selftext || "").slice(0, 800) || "（本文なし）"}

【海外ファンの反応（Reddit）】
${comments.slice(0, 15).join("\n")}
${xComments.length > 0 ? `\n【X（Twitter）海外ファンの反応】\n${xComments.slice(0, 15).join("\n")}` : ""}

以下のJSON形式のみで出力してください：
{
  "catchLine1": "サムネイル兼タイトル文（30文字以内・スマホで0.5秒で目が止まるパワーワード）",
  "label": "【速報】か【衝撃】か【朗報】か【悲報】",
  "badge": "サムネのサブバッジ（8文字以内・例：電撃移籍 / 退団確定 / 解任速報）",
  "sourceAuthor": "情報元メディア・記者名（例：Fabrizio Romano / Sky Sports）",
  "sourceText": "トピックの核心を切り取ったソーステキスト（日本語・2〜4行・改行で読みやすく）",
  "overviewNarration": "S2ナレーション（80〜120文字・ニュースキャスター口調・何が起きたかを事実ベースで伝える）",
  "overviewTelop": "S2テロップ（25文字以内・誰が・何をしたかが即わかる一言）",
  "slide3": {
    "topicTag": "S3右上タグ（12文字以内・※で始まる・ファンの反応の切り口）",
    "highlightIdx": 0,
    "narration": "S3ナレーション（60〜90文字・海外反応の温度感を伝える）",
    "subtitleBox": "S3字幕（20文字以内）",
    "comments": [
      {"user": "英語圏っぽい名前", "text": "22〜28文字の意訳"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"}
    ]
  },
  "slide4": {
    "topicTag": "S4右上タグ（12文字以内・※で始まる・S3と別角度の切り口）",
    "highlightIdx": 0,
    "narration": "S4ナレーション（60〜90文字）",
    "subtitleBox": "S4字幕（20文字以内）",
    "comments": [
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"},
      {"user": "英語圏っぽい名前", "text": "1行目テキスト\\n2行目テキスト（\\nで改行・合計60〜80文字の2段構成）"},
      {"user": "英語圏っぽい名前", "text": "22〜28文字"}
    ]
  },
  "outroNarration": "S5ナレーション（20〜40文字・次も見たくなる余韻）",
  "outroTelop": "S5テロップ（18〜28文字・登録呼びかけ厳禁・この案件で一番笑えるor刺さるツッコミ一言・例：『まあそりゃそうだよな』『いや待って本当に？』）",
  "youtubeTitle": "YouTubeタイトル（SEO重視・40〜55文字）",
  "hashtagsText": "ハッシュタグ（スペース区切り・8〜10個・必ず#サッカー #海外の反応 含む）"
}
`;

  const raw = await callAI({ model: "claude-sonnet-4-6", max_tokens: 2200, messages: [{ role: "user", content: prompt }] });
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("JSONが見つかりません");
  return JSON.parse(jsonMatch[0]);
}

// ════════════════════════════════════════════════════════════════════════════
// メイン
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  const selectedArg = process.argv.find(a => a.startsWith("--selected="));
  if (!selectedArg) {
    console.error("使い方: node scripts/generate_content.js --selected=temp/selected_YYYY-MM-DD.json");
    process.exit(1);
  }

  const selectedFile = selectedArg.replace("--selected=", "");
  if (!fs.existsSync(selectedFile)) {
    console.error(`ファイルが見つかりません: ${selectedFile}`);
    process.exit(1);
  }

  const selectedData = JSON.parse(fs.readFileSync(selectedFile, "utf8"));
  const threads = selectedData.threads || [];

  console.log(`\n=== コンテンツ生成 (${today}) ===`);
  console.log(`対象: ${threads.length}件\n`);

  // 既存ファイルがあれば既存postsを引き継いでマージ
  let existingPosts = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      existingPosts = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8")).posts || [];
      console.log(`既存データ ${existingPosts.length}件をマージします\n`);
    } catch { existingPosts = []; }
  }

  // API-Football 全試合取得（post-match スレッドがある場合のみ）
  const hasMatchThread = threads.some(t => t.type === "post-match");
  let allApiFixtures = [];
  if (hasMatchThread && process.env.API_FOOTBALL_KEY) {
    const dateObj = new Date(today);
    const season  = dateObj.getMonth() >= 6 ? dateObj.getFullYear() : dateObj.getFullYear() - 1;
    console.log(`API-Football: ${today} の試合データ取得中...`);
    const results = await Promise.all(
      TARGET_LEAGUES.map(lid => apiFbGet("/fixtures", { date: today, league: lid, season }).catch(() => []))
    );
    allApiFixtures = results.flat();
    console.log(`  ${allApiFixtures.length}試合取得\n`);
  }

  const CONCURRENCY = 3;
  const posts = [];

  async function processThread(thread, i) {
    const num    = existingPosts.length + i + 1;
    const isMatch = thread.type === "post-match";
    const typeTag = isMatch ? "[試合]" : `[${TYPE_LABEL_MAP[thread.type] || thread.type}]`;

    console.log(`▶ [${num}/${threads.length}] ${typeTag} ${thread.title}`);

    // ── 共通: スレッド本文・コメント取得 ──
    process.stdout.write(`  [${num}] コメント取得中... `);
    const threadData = await fetchThreadFull(thread.permalink);
    const selftext   = thread.selftext || threadData.selftext;
    const comments   = threadData.comments;
    thread.selftext  = selftext;
    console.log(`${comments.length}件`);

    // スレッド投稿日 → JST 日付文字列
    const threadJst    = thread.created_utc
      ? new Date(thread.created_utc * 1000 + 9 * 3600000)
      : new Date(today + "T00:00:00Z");
    const matchDateStr = `${threadJst.getUTCFullYear()}年${threadJst.getUTCMonth() + 1}月${threadJst.getUTCDate()}日`;

    const imagePrefix = `${today}_${num}`;
    let imagePaths    = [];
    let xComments     = [];
    let ytContent, matchResult;
    let stockLookupText = "";

    // ════════ SCRIPT A: 試合 ════════
    if (isMatch) {
      // 試合データ抽出
      process.stdout.write(`  [${num}] 試合データ抽出中... `);
      const matchData = await extractMatchData(thread, comments);
      if (!matchData) { console.log("  ⚠️ 失敗、スキップ"); return null; }
      matchData.matchDateStr = matchDateStr;
      matchData.contentType  = "post-match";
      console.log(`✅ ${matchData.homeTeam} ${matchData.homeScore}-${matchData.awayScore} ${matchData.awayTeam}`);

      // API-Football で正確データに上書き
      if (allApiFixtures.length) {
        const apiFixture = findMatchingFixture(matchData.homeTeam, matchData.awayTeam, allApiFixtures);
        if (apiFixture) {
          process.stdout.write(`  [${num}] API-Football 照合中... `);
          try {
            const cache = await fetchAndCacheFixtureDetails(apiFixture);
            enrichMatchData(matchData, apiFixture, cache);
            console.log(`✅ スコア: ${matchData.homeScore}-${matchData.awayScore}  得点: ${matchData.goals.length}件`);
          } catch (e) { console.warn(`  ⚠️ ${e.message}`); }
        } else {
          console.log(`  [${num}] API-Football: 対応試合なし`);
        }
      }

      // 画像取得（fetchMatchImages + X画像）
      console.log(`  [${num}] 画像取得中...`);
      try {
        imagePaths = await fetchMatchImages({
          homeTeam: matchData.homeTeam, awayTeam: matchData.awayTeam,
          matchDate: today, saveDir: IMG_DIR, prefix: imagePrefix,
          verbose: true, redditPermalink: thread.permalink || null,
        });
        console.log(`  [${num}] 画像取得完了: ${imagePaths.length}枚`);
      } catch (e) { console.warn(`  ⚠️ 画像取得失敗: ${e.message}`); }

      // X 画像（公式2チーム + キーワード）+ コメント を全並列
      if (process.env.TWITTER_API_IO_KEY) {
        const xQuery = buildXSearchQuery(thread, matchData);
        process.stdout.write(`  [${num}] X取得中（公式×2 + キーワード + コメント）... `);
        try {
          const [homeOfficialPaths, awayOfficialPaths, xPaths, xCmts] = await Promise.all([
            fetchOfficialXImages(matchData.homeTeam, `${imagePrefix}_home`),
            fetchOfficialXImages(matchData.awayTeam, `${imagePrefix}_away`),
            fetchXImages(xQuery, imagePrefix),
            fetchXComments(xQuery, 20),
          ]);
          imagePaths.push(...homeOfficialPaths, ...awayOfficialPaths, ...xPaths);
          xComments = xCmts;
          console.log(`公式H:${homeOfficialPaths.length} A:${awayOfficialPaths.length} KW:${xPaths.length}枚 / Xコメント${xCmts.length}件`);
        } catch (e) { console.log(`  ⚠️ ${e.message}`); }
      }

      // Wikimedia画像（homeTeam + awayTeam + 各監督）
      const matchManagers = lookupManagers([matchData.homeTeam, matchData.awayTeam]);
      const matchWikiWords = [matchData.homeTeam, matchData.awayTeam, ...matchManagers];
      process.stdout.write(`  [${num}] Wikimedia取得中 [${matchWikiWords.join(", ")}]... `);
      const matchWikiResults = await Promise.all(
        matchWikiWords.map((w, i) => fetchWikimediaImages(w, `${imagePrefix}_wm${i}`))
      );
      const matchWikiPaths = matchWikiResults.flat();
      imagePaths.push(...matchWikiPaths);
      console.log(`${matchWikiPaths.length}枚`);

      // コンテンツ生成
      process.stdout.write(`  [${num}] コンテンツ生成中... `);
      try {
        ytContent   = await generateMatchContent(matchData, comments, thread, xComments);
        matchResult = buildMatchResult(matchData);
        console.log("✅");
      } catch (e) { console.warn(`  ⚠️ 失敗: ${e.message}`); return null; }

    // ════════ SCRIPT B: トピック ════════
    } else {
      // ① RSS/まとめ記事はOG画像を最優先で取得
      if (thread.source === "rss" && thread.url) {
        process.stdout.write(`  [${num}] OG画像取得中... `);
        const ogPaths = await fetchOgImage(thread.url, IMG_DIR, imagePrefix);
        imagePaths.push(...ogPaths);
      }

      // ② キーワード抽出（AI）+ X画像取得
      const rawQuery = buildXSearchQuery(thread);
      const needsTranslation = /[\u3040-\u30ff\u4e00-\u9fff]/.test(rawQuery);

      // 翻訳 + エンティティ抽出を並列実行
      process.stdout.write(`  [${num}] キーワード抽出中... `);
      const [xImgQuery, imgKeywords] = await Promise.all([
        needsTranslation ? translateKeywordToEnglish(rawQuery) : Promise.resolve(rawQuery),
        extractImageKeywords(thread.title),
      ]);
      console.log(`"${xImgQuery}" / entities: [${imgKeywords.join(", ")}]`);

      if (process.env.TWITTER_API_IO_KEY) {
        // X公式はentitiesで検索（チーム名ヒット率UP）、KW画像はxImgQueryで
        const officialQuery = imgKeywords.length ? imgKeywords.join(" ") : xImgQuery;
        process.stdout.write(`  [${num}] X取得中 [${xImgQuery.slice(0, 30)}]... `);
        try {
          const [xPaths, xCmts, ntPaths] = await Promise.all([
            fetchXImages(xImgQuery + " filter:images -filter:retweets", imagePrefix, 10, "Top"),
            fetchXComments(rawQuery, 20),
            fetchOfficialXImagesFromQuery(officialQuery, imagePrefix),
          ]);
          xComments = xCmts;
          imagePaths.push(...ntPaths, ...xPaths);
          console.log(`公式${ntPaths.length}枚 / KW画像${xPaths.length}枚 / Xコメント${xCmts.length}件`);
        } catch (e) { console.log(`  ⚠️ ${e.message}`); }
      }

      // ③ Wikimedia画像（entities + チームの監督名）
      const baseWords = imgKeywords.length
        ? imgKeywords
        : xImgQuery.split(/\s+/).filter(w => w.length >= 3).slice(0, 2);
      const topicManagers = lookupManagers(imgKeywords);
      // 既にkeywordsに監督名が含まれている場合は重複スキップ
      const newManagers = topicManagers.filter(m => !baseWords.some(w => m.toLowerCase().includes(w.toLowerCase())));
      const wikiWords = [...baseWords, ...newManagers];
      if (wikiWords.length > 0) {
        process.stdout.write(`  [${num}] Wikimedia取得中 [${wikiWords.join(", ")}]... `);
        const wikiResults = await Promise.all(
          wikiWords.map((w, i) => fetchWikimediaImages(w, `${imagePrefix}_wt${i}`))
        );
        const wikiPaths = wikiResults.flat();
        imagePaths.push(...wikiPaths);
        console.log(`${wikiPaths.length}枚`);
      }

      const topicData = { selftext };

      // コンテンツ生成
      process.stdout.write(`  [${num}] コンテンツ生成中... `);
      try {
        ytContent   = await generateTopicContent(topicData, comments, thread, xComments);
        matchResult = null;
        console.log("✅");
      } catch (e) { console.warn(`  ⚠️ 失敗: ${e.message}`); return null; }
    }

    // 画像をスライドに割り当て
    const mainImagePath   = imagePaths[0] || null;
    const slide3ImagePath = imagePaths[1] || null;
    const slide4ImagePath = imagePaths[2] || null;

    const [redditJa, xJa] = await Promise.all([
      translateComments(comments),
      translateComments(xComments),
    ]);

    console.log();
    return {
      num,
      type:             thread.type,
      catchLine1:       ytContent.catchLine1,
      label:            ytContent.label,
      badge:            ytContent.badge,
      sourceAuthor:     ytContent.sourceAuthor,
      sourceText:       ytContent.sourceText,
      imagePaths,
      mainImagePath,
      slide3ImagePath,
      slide4ImagePath,
      matchResult,
      overviewNarration: ytContent.overviewNarration,
      overviewTelop:     ytContent.overviewTelop,
      slide3:            ytContent.slide3,
      slide4:            ytContent.slide4,
      outroNarration:    ytContent.outroNarration,
      outroTelop:        ytContent.outroTelop,
      youtubeTitle:      ytContent.youtubeTitle,
      hashtagsText:      ytContent.hashtagsText,
      _meta: {
        threadTitle: thread.title,
        redditUrl:   thread.url || `https://www.reddit.com${thread.permalink}`,
        threadType:  thread.type,
      },
      _rawComments:   { reddit: comments,   x: xComments },
      _rawCommentsJa: { reddit: redditJa,   x: xJa },
    };
  }

  for (let i = 0; i < threads.length; i += CONCURRENCY) {
    const batch   = threads.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((t, j) => processThread(t, i + j)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) posts.push(r.value);
      if (r.status === "rejected") console.warn(`⚠️ スレッド処理エラー: ${r.reason?.message}`);
    }
  }
  posts.sort((a, b) => a.num - b.num);

  // 保存（新規を先頭にマージ）
  const mergedPosts = [...posts, ...existingPosts];
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ date: today, posts: mergedPosts }, null, 2), "utf8");

  console.log(`✅ 完了！${posts.length}件を保存`);
  console.log(`   → ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error(`\n❌ エラー: ${err.message}`);
  process.exit(1);
});
