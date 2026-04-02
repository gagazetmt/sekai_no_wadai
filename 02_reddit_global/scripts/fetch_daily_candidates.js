// fetch_daily_candidates.js
// 定時実行スクリプト: Reddit + 国内まとめブログから案件取得 → VPS送信
//
// 【実行モード（JST時刻で自動判定）】
//   0:00 → midnight: 本日のベースJSON作成（過去30日との重複除去）
//   6:00〜21:00 → update: 当日JSONにマージ（重複除去）
//
// 【出力ファイル】
//   data/candidates_YYYY-MM-DD.json  ... 当日の積み上げJSON
//   data/seen_history.json           ... 過去案件IDの履歴
//
// 使い方:
//   node scripts/fetch_daily_candidates.js           (時刻自動判定)
//   node scripts/fetch_daily_candidates.js midnight  (強制ミッドナイト)
//   node scripts/fetch_daily_candidates.js update    (強制アップデート)

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const fs            = require("fs");
const path          = require("path");
const { execSync }  = require("child_process");
const { callAI }    = require("./ai_client");

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const DATA_DIR          = path.join(__dirname, "..", "data");
const HISTORY_FILE      = path.join(DATA_DIR, "seen_history.json");
const HISTORY_KEEP_DAYS = 30;
const REDDIT_TOP_N      = 10;
const RSS_TOP_N         = 10;
const MAX_TOTAL_POSTS   = 30;
const COMMENT_LIMIT     = 20;

const VPS_HOST = "root@37.60.224.54";
const VPS_DEST = "/root/sekai_no_wadai/02_reddit_global/temp/";
const SSH_KEY  = path.join(process.env.USERPROFILE || "C:\\Users\\USER", ".ssh", "id_ed25519");

// Reddit プロキシ（.env の REDDIT_PROXY_URL が設定されていれば使用）
const REDDIT_PROXY = process.env.REDDIT_PROXY_URL || null;

// ─── JST ユーティリティ ───────────────────────────────────────────────────────
function jstNow() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const date = jst.toISOString().slice(0, 10);
  const hour = jst.getUTCHours();
  const iso  = jst.toISOString().replace("Z", "+09:00");
  return { date, hour, iso };
}

// ─── Reddit fetch ─────────────────────────────────────────────────────────────
async function redditGet(url) {
  const headers = { "User-Agent": "soccer-news-bot/1.0" };

  // 直接取得を試みる
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (res.ok) return res.json();
  } catch {
    // 直接取得失敗 → プロキシを試みる
  }

  // プロキシ経由フォールバック（REDDIT_PROXY_URL設定時）
  if (REDDIT_PROXY) {
    const encoded = encodeURIComponent(url);
    const proxyUrl = `${REDDIT_PROXY}/fetch?url=${encoded}`;
    const res = await fetch(proxyUrl, { headers, signal: AbortSignal.timeout(10000) });
    if (res.ok) return res.json();
    throw new Error(`Reddit proxy HTTP ${res.status}: ${url}`);
  }

  throw new Error(`Reddit fetch failed (no proxy configured): ${url}`);
}

async function fetchRedditTop() {
  const json = await redditGet("https://www.reddit.com/r/soccer/hot.json?limit=40");
  return (json.data?.children || [])
    .map(c => c.data)
    .filter(p => !p.stickied && p.score > 10)
    .slice(0, REDDIT_TOP_N)
    .map(p => ({
      id:          p.permalink,          // 重複チェックキー
      source:      "reddit",
      title:       p.title,
      titleJa:     "",
      url:         "https://www.reddit.com" + p.permalink,
      permalink:   p.permalink,
      score:       p.score,
      numComments: p.num_comments,
      created_utc: p.created_utc,
      subreddit:   p.subreddit,
      comments:    [],
    }));
}

async function fetchComments(permalink) {
  try {
    const url  = `https://www.reddit.com${permalink}.json?limit=${COMMENT_LIMIT}&sort=top&depth=1`;
    const json = await redditGet(url);
    return (json[1]?.data?.children || [])
      .filter(c => c.kind === "t1" && c.data.body && c.data.body !== "[deleted]")
      .sort((a, b) => b.data.score - a.data.score)
      .slice(0, COMMENT_LIMIT)
      .map(c => ({ body: c.data.body.slice(0, 500), score: c.data.score }));
  } catch {
    return [];
  }
}

// ─── RSS fetch ─────────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: "calciomatome", url: "https://www.calciomatome.net/index20.rdf" },
  { name: "soccer-king",  url: "https://www.soccer-king.jp/feed" },
];

function extractXml(body, tag) {
  const m = body.match(new RegExp(`<${tag}[\\s>][^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`, "i"))
         || body.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`, "i"));
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

async function fetchRss({ name, url }) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "soccer-news-bot/1.0" } });
    if (!res.ok) return [];
    const xml  = await res.text();
    const now  = Date.now() / 1000;
    const items = [];
    for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const title   = extractXml(body, "title");
      const rawLink = extractXml(body, "link");
      const link    = rawLink || (body.match(/<link[^>]+href="([^"]+)"/) || [])[1];
      const pubDate = extractXml(body, "pubDate") || extractXml(body, "dc:date");
      if (!title || !link) continue;
      const created_utc = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : now;
      if (now - created_utc > 4 * 86400) continue; // 4日以上前はスキップ
      items.push({
        id:          link,              // 重複チェックキー
        source:      "rss",
        feedName:    name,
        title,
        titleJa:     title,
        url:         link,
        permalink:   null,
        score:       0,
        numComments: 0,
        created_utc,
        comments:    [],
      });
    }
    return items.sort((a, b) => b.created_utc - a.created_utc).slice(0, RSS_TOP_N);
  } catch (e) {
    console.warn(`⚠️  RSS取得失敗 [${name}]: ${e.message}`);
    return [];
  }
}

async function fetchAllRss() {
  const results = await Promise.all(RSS_FEEDS.map(fetchRss));
  const seen = new Set();
  return results.flat()
    .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .sort((a, b) => b.created_utc - a.created_utc)
    .slice(0, RSS_TOP_N);
}

// ─── タイトル翻訳（Reddit のみ）────────────────────────────────────────────────
async function translateTitles(posts) {
  const targets = posts.filter(p => p.source === "reddit" && !p.titleJa);
  if (!targets.length) return posts;

  const prompt = `以下のサッカー関連Redditスレッドタイトルを日本語に翻訳してください。
チーム名・選手名はカタカナ（例：アーセナル、マンシティ）。スコア（例：3-1）はそのまま。
JSON配列のみ返してください。順番はそのまま。

${targets.map((p, i) => `${i}: ${p.title}`).join("\n")}

出力: ["日本語タイトル0", "日本語タイトル1", ...]`;

  try {
    const raw  = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 1500, messages: [{ role: "user", content: prompt }] });
    const m    = raw.match(/\[[\s\S]*\]/);
    if (!m) return posts;
    const translated = JSON.parse(m[0]);
    const map  = new Map(targets.map((p, i) => [p.id, translated[i] || p.title]));
    return posts.map(p => ({ ...p, titleJa: map.get(p.id) || p.titleJa || p.title }));
  } catch {
    return posts.map(p => ({ ...p, titleJa: p.titleJa || p.title }));
  }
}

// ─── 履歴管理 ─────────────────────────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch { return { seen: {} }; }
  // フォーマット: { seen: { "YYYY-MM-DD": ["id1", "id2", ...] } }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// 過去 HISTORY_KEEP_DAYS 日分の既出IDセットを返す（古い日付エントリを削除しながら）
function getSeenSet(history) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - HISTORY_KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const d of Object.keys(history.seen)) {
    if (d < cutoffStr) delete history.seen[d];
  }
  return new Set(Object.values(history.seen).flat());
}

function recordToHistory(history, date, ids) {
  if (!history.seen[date]) history.seen[date] = [];
  history.seen[date] = [...new Set([...history.seen[date], ...ids])];
}

// ─── 当日 JSON 管理 ───────────────────────────────────────────────────────────
function dailyFile(date) {
  return path.join(DATA_DIR, `candidates_${date}.json`);
}

function loadDaily(date) {
  try { return JSON.parse(fs.readFileSync(dailyFile(date), "utf8")); }
  catch { return null; }
}

function saveDaily(date, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(dailyFile(date), JSON.stringify(data, null, 2));
  console.log(`💾 Saved: candidates_${date}.json (${data.posts.length} posts)`);
}

// ─── VPS 送信 ─────────────────────────────────────────────────────────────────
function sendToVps(date) {
  const localFile = dailyFile(date);
  // Windowsの scp コマンドでSCP転送
  const cmd = `scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${localFile}" "${VPS_HOST}:${VPS_DEST}"`;
  try {
    execSync(cmd, { stdio: "inherit", timeout: 30000 });
    console.log(`📤 VPS送信完了: candidates_${date}.json`);
  } catch (e) {
    console.error(`❌ VPS送信失敗: ${e.message}`);
    console.error(`   手動送信: ${cmd}`);
  }
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  const { date, hour, iso } = jstNow();

  // 実行モード判定（引数 > 時刻自動判定）
  const modeArg = process.argv[2];
  const isMidnight = modeArg === "midnight" || (!modeArg && hour === 0);
  const mode = isMidnight ? "midnight" : "update";

  console.log(`\n🕐 ${iso} | Mode: ${mode} | Date: ${date}`);
  console.log("─".repeat(50));

  // ① Reddit top15 + RSS top15 を並列取得
  console.log(`📡 Fetching Reddit top${REDDIT_TOP_N} + RSS top${RSS_TOP_N}...`);
  let [redditPosts, rssPosts] = await Promise.all([
    fetchRedditTop().catch(e => { console.warn(`⚠️ Reddit取得失敗: ${e.message}`); return []; }),
    fetchAllRss(),
  ]);

  // ② Reddit 各スレッドのコメント上位20件を並列取得
  console.log(`💬 Fetching comments (${COMMENT_LIMIT}/post × ${redditPosts.length} posts)...`);
  redditPosts = await Promise.all(
    redditPosts.map(async p => ({
      ...p,
      comments: await fetchComments(p.permalink),
    }))
  );

  // ③ タイトル翻訳（Reddit のみ）
  console.log("🌐 Translating Reddit titles...");
  const allFetched = await translateTitles([...redditPosts, ...rssPosts]);

  // ── ソート & 上限30件ヘルパー ──
  const finalizePosts = (pArr) => {
    return pArr
      .sort((a, b) => (b.score - a.score) || (b.created_utc - a.created_utc))
      .slice(0, MAX_TOTAL_POSTS);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  if (isMidnight) {
    // ── midnight モード: 新しい本日ベースJSONを作成 ──────────────────────────
    const history = loadHistory();
    const seenSet = getSeenSet(history);

    let newPosts = allFetched.filter(p => !seenSet.has(p.id));
    console.log(`🔍 History dedup: ${allFetched.length} → ${newPosts.length} posts`);

    // 上限30件に絞る
    newPosts = finalizePosts(newPosts);

    const todayData = {
      date,
      mode:         "midnight",
      created_at:   iso,
      last_updated: iso,
      posts:        newPosts.map(p => ({ ...p, added_at: iso })),
    };

    // 当日分のIDを履歴に追加
    recordToHistory(history, date, newPosts.map(p => p.id));
    saveHistory(history);
    console.log(`📚 History updated: ${Object.keys(history.seen).length} days tracked`);

    saveDaily(date, todayData);
    sendToVps(date);

  } else {
    // ── update モード: 当日JSONにマージ ──────────────────────────────────────
    const existing = loadDaily(date);

    if (!existing) {
      // 当日のベースJSONがない場合
      console.warn("⚠️  当日ベースJSONが見つかりません。今回取得分で新規作成します。");
      const todayData = {
        date,
        mode:         "update-fallback",
        created_at:   iso,
        last_updated: iso,
        posts:        finalizePosts(allFetched).map(p => ({ ...p, added_at: iso })),
      };
      saveDaily(date, todayData);
      sendToVps(date);
      return;
    }

    // 既存ポストと新規ポストをマージして重複除去
    const existingMap = new Map(existing.posts.map(p => [p.id, p]));
    allFetched.forEach(p => {
      if (!existingMap.has(p.id)) {
        existingMap.set(p.id, { ...p, added_at: iso });
      }
    });

    // ソート & 上限30件
    const mergedPosts = finalizePosts(Array.from(existingMap.values()));
    const newCount    = mergedPosts.filter(p => !existing.posts.some(ep => ep.id === p.id)).length;

    console.log(`🔀 Merge & Trim: Total ${mergedPosts.length} posts (Added ${newCount} new)`);

    existing.last_updated = iso;
    existing.posts        = mergedPosts;
    saveDaily(date, existing);
    sendToVps(date);
  }

  console.log("✅ Done.\n");
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

main().catch(e => {
  console.error(`❌ Fatal error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
