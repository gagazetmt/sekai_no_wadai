// fetch_daily_candidates.js
// 定時実行スクリプト: Reddit + 国内まとめブログから案件取得 → VPS送信
//
// 【動作】
//   毎回: 36時間以内の新着スレを取得 → 過去7日(168h)既出IDを除外 → Reddit4+RSS4を選定
//   当日のJSONに追記（added_at降順=新しい順）→ VPS送信
//
// 【出力ファイル】
//   data/candidates_YYYY-MM-DD.json  ... 当日の積み上げJSON（added_at降順）
//   data/seen_history.json           ... 過去7日の既出ID履歴
//
// 使い方:
//   node scripts/fetch_daily_candidates.js

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const fs            = require("fs");
const path          = require("path");
const { execSync }  = require("child_process");
const { callAI }    = require("./ai_client");

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const DATA_DIR          = path.join(__dirname, "..", "data");
const HISTORY_FILE      = path.join(DATA_DIR, "seen_history.json");
const HISTORY_KEEP_DAYS = 7;    // 168時間（7日）分の既出IDを保持
const REDDIT_FETCH_N    = 50;   // Reddit APIから取得する最大件数（dedup候補）
const RSS_FETCH_N       = 20;   // RSSから取得する最大件数（dedup候補）
const REDDIT_SELECT_N   = 4;    // 1回の実行でJSONに追加するReddit件数
const RSS_SELECT_N      = 4;    // 1回の実行でJSONに追加するRSS件数
const REDDIT_MAX_HOURS  = 24;   // Reddit取得対象の最大経過時間
const JAPAN_SELECT_N    = 2;    // 1回の実行でJSONに追加するJapanスレ件数（通常Redditとは別枠）
const JAPAN_MIN_SCORE   = 50;   // Japanスレの最低スコア（過疎スレ除外）
const JAPAN_MIN_COMMENTS = 20;  // Japanスレの最低コメント数（過疎スレ除外）
const RSS_MAX_HOURS     = 48;   // RSS取得対象の最大経過時間
const FRESH_WINDOWS     = [4, 8, 12, 24]; // Reddit ウォーターフォール時間窓（h）
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
  const json = await redditGet("https://www.reddit.com/r/soccer/rising.json?limit=100");
  const nowSec = Date.now() / 1000;
  return (json.data?.children || [])
    .map(c => c.data)
    .filter(p => !p.stickied && p.score > 5 && (nowSec - p.created_utc) < REDDIT_MAX_HOURS * 3600)
    .slice(0, REDDIT_FETCH_N)
    .map(p => {
      const hoursOld = (nowSec - p.created_utc) / 3600;
      return {
        id:          p.permalink,
        source:      "reddit",
        title:       p.title,
        titleJa:     "",
        url:         "https://www.reddit.com" + p.permalink,
        permalink:   p.permalink,
        score:       p.score,
        velocity:    Math.round(p.score / Math.max(hoursOld, 0.5)), // upvotes/h
        hoursOld:    Math.round(hoursOld * 10) / 10,
        numComments: p.num_comments,
        created_utc: p.created_utc,
        subreddit:   p.subreddit,
        comments:    [],
      };
    });
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

// ─── Japan関連スレ取得 ────────────────────────────────────────────────────────
// /r/soccer の rising から "Japan" を含むタイトルを抽出（品質フィルタ付き）
async function fetchJapanThreads() {
  try {
    // rising は現在進行中の盛り上がりを反映するため rising を使用
    const json = await redditGet("https://www.reddit.com/r/soccer/rising.json?limit=100");
    const nowSec = Date.now() / 1000;
    return (json.data?.children || [])
      .map(c => c.data)
      .filter(p =>
        !p.stickied &&
        /\bjapan\b/i.test(p.title) &&          // タイトルに "Japan" を含む
        p.score       >= JAPAN_MIN_SCORE &&      // スコア50以上
        p.num_comments >= JAPAN_MIN_COMMENTS &&  // コメント20件以上
        (nowSec - p.created_utc) < REDDIT_MAX_HOURS * 3600  // 24h以内
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, JAPAN_SELECT_N)
      .map(p => {
        const hoursOld = (nowSec - p.created_utc) / 3600;
        return {
          id:          p.permalink,
          source:      "reddit",
          type:        "topic",
          title:       p.title,
          titleJa:     "",
          url:         "https://www.reddit.com" + p.permalink,
          permalink:   p.permalink,
          score:       p.score,
          velocity:    Math.round(p.score / Math.max(hoursOld, 0.5)),
          hoursOld:    Math.round(hoursOld * 10) / 10,
          numComments: p.num_comments,
          created_utc: p.created_utc,
          subreddit:   p.subreddit,
          isJapanThread: true,
          comments:    [],
        };
      });
  } catch (e) {
    console.warn(`⚠️  Japanスレ取得失敗: ${e.message}`);
    return [];
  }
}

// ─── calciomatome 記事スクレイピング ─────────────────────────────────────────────
// t_b クラス: [0]=試合データ/本文、[1]〜=5chコメント（Shift-JIS decode）
async function scrapeCalciomatome(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { selftext: "", comments: [] };
    const buf  = await res.arrayBuffer();
    const html = new TextDecoder("shift_jis").decode(buf);

    const blocks = [...html.matchAll(/<[^>]+class="t_b[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, "").replace(/&gt;/g, "＞").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim())
      .filter(t => t.length > 5);

    const selftext = blocks[0] || "";
    const comments = blocks.slice(1, 16).map((text, i) => ({ body: text, score: 15 - i }));
    return { selftext, comments };
  } catch {
    return { selftext: "", comments: [] };
  }
}

// ─── RSS fetch ─────────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: "calciomatome", url: "https://www.calciomatome.net/index20.rdf" },
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
      if (now - created_utc > RSS_MAX_HOURS * 3600) continue; // 鮮度フィルター（48h）
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
        selftext:    "",
        comments:    [],
      });
    }

    // calciomatome は記事ページから本文・コメントをスクレイピング
    if (name === "calciomatome") {
      for (const item of items) {
        const { selftext, comments } = await scrapeCalciomatome(item.url);
        item.selftext    = selftext;
        item.comments    = comments;
        item.numComments = comments.length;
        await new Promise(r => setTimeout(r, 300)); // レートリミット対策
      }
    }

    return items.sort((a, b) => b.created_utc - a.created_utc).slice(0, RSS_FETCH_N);
  } catch (e) {
    console.warn(`⚠️  RSS取得失敗 [${name}]: ${e.message}`);
    return [];
  }
}

// Jリーグ関連タイトルを弾くフィルター
// ※地名略称を含む（例: 仙台=ベガルタ仙台、水戸=水戸ホーリーホック）
// ※東京・大阪・横浜・神戸・福岡・広島など主要都市は誤検知防止のためフル/固有名のみ
const J_LEAGUE_KEYWORDS = [
  // リーグ・スポンサー表記
  "明治安田", "百年構想", "Jリーグ", "J1リーグ", "J2リーグ", "J3リーグ",
  // ── J1 ──────────────────────────────────────────────────────────────────
  "鹿島", "アントラーズ",                       // 鹿島アントラーズ
  "柏レイソル", "レイソル",                      // 柏レイソル
  "FC東京", "東京ヴェルディ", "東京V", "ヴェルディ", // 誤検知防止: 東京単体は除外
  "フロンターレ",                                // 川崎フロンターレ
  "マリノス", "横浜FM", "横浜FC",                // 横浜FMと横浜FC（横浜単体は除外）
  "湘南", "ベルマーレ",                          // 湘南ベルマーレ
  "清水エスパルス", "エスパルス",                // 清水エスパルス（清水単体は除外）
  "名古屋グランパス", "グランパス",              // 名古屋グランパス（名古屋単体は除外）
  "ガンバ", "G大阪",                             // ガンバ大阪（大阪単体は除外）
  "セレッソ", "C大阪",                           // セレッソ大阪（大阪単体は除外）
  "ヴィッセル",                                  // ヴィッセル神戸（神戸単体は除外）
  "サンフレッチェ",                              // サンフレッチェ広島（広島単体は除外）
  "アビスパ",                                    // アビスパ福岡（福岡単体は除外）
  "サガン", "鳥栖",                              // サガン鳥栖
  "コンサドーレ",                                // 北海道コンサドーレ札幌
  "浦和", "レッズ",                              // 浦和レッズ
  "アルビレックス",                              // アルビレックス新潟
  "ジュビロ", "磐田",                            // ジュビロ磐田
  "京都サンガ", "サンガ",                        // 京都サンガ（京都単体は除外）
  "ゼルビア", "FC町田",                          // FC町田ゼルビア
  // ── J2 ──────────────────────────────────────────────────────────────────
  "ベガルタ", "仙台",                            // ベガルタ仙台
  "モンテディオ", "山形",                        // モンテディオ山形
  "いわきFC",                                    // いわきFC
  "ホーリーホック", "水戸",                      // 水戸ホーリーホック
  "栃木SC", "栃木",                              // 栃木SC
  "ザスパ", "群馬",                              // ザスパ群馬
  "アルディージャ", "大宮",                      // 大宮アルディージャ
  "ジェフ",                                      // ジェフユナイテッド千葉（千葉単体は除外）
  "ファジアーノ", "岡山",                        // ファジアーノ岡山
  "レノファ",                                    // レノファ山口
  "Ｖ・ファーレン", "Vファーレン", "ファーレン長崎",  // V・ファーレン長崎
  "ヴォルティス", "徳島",                        // 徳島ヴォルティス
  "愛媛FC", "愛媛",                              // 愛媛FC
  "ロアッソ",                                    // ロアッソ熊本（熊本単体は除外）
  "トリニータ", "大分",                          // 大分トリニータ
  "藤枝MYFC", "藤枝",                            // 藤枝MYFC
  "ツエーゲン", "金沢",                          // ツエーゲン金沢
  "ヴァンフォーレ", "甲府",                      // ヴァンフォーレ甲府
  "松本山雅",                                    // 松本山雅FC
  "ブラウブリッツ", "秋田",                      // ブラウブリッツ秋田
  "鹿児島ユナイテッド", "鹿児島",                // 鹿児島ユナイテッドFC
  "FC琉球", "琉球",                              // FC琉球
  "相模原",                                      // SC相模原
  // ── J3 ──────────────────────────────────────────────────────────────────
  "ギラヴァンツ", "北九州",                      // ギラヴァンツ北九州
  "テゲバジャーロ",                              // テゲバジャーロ宮崎
  "パルセイロ",                                  // AC長野パルセイロ
  "カターレ", "富山",                            // カターレ富山
  "ガイナーレ", "鳥取",                          // ガイナーレ鳥取
  "奈良クラブ",                                  // 奈良クラブ
  "アスルクラロ", "沼津",                        // アスルクラロ沼津
  "いわてグルージャ", "盛岡",                    // いわてグルージャ盛岡
  "福島ユナイテッド", "福島",                    // 福島ユナイテッドFC
  "Y.S.C.C", "YSCC",                            // Y.S.C.C.横浜
  "ヴェルスパ大分",                              // ヴェルスパ大分
  "高知ユナイテッド", "高知",                    // 高知ユナイテッドSC
  "FC大阪",                                      // FC大阪（大阪単体は除外）
];
const J_LEAGUE_FILTER = new RegExp(J_LEAGUE_KEYWORDS.join("|"));

async function fetchAllRss() {
  const results = await Promise.all(RSS_FEEDS.map(fetchRss));
  const seen = new Set();
  return results.flat()
    .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .filter(p => !J_LEAGUE_FILTER.test(p.title || ""))
    .sort((a, b) => b.created_utc - a.created_utc)
    .slice(0, RSS_FETCH_N);
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
  const { date, iso } = jstNow();

  console.log(`\n🕐 ${iso} | Date: ${date}`);
  console.log("─".repeat(50));

  // ① Reddit × REDDIT_FETCH_N + RSS × RSS_FETCH_N + Japanスレ を並列取得
  console.log(`📡 Fetching Reddit rising(up to ${REDDIT_FETCH_N}, ${REDDIT_MAX_HOURS}h) + RSS(up to ${RSS_FETCH_N}, ${RSS_MAX_HOURS}h) + Japan threads...`);
  let [redditPosts, rssPosts, japanRaw] = await Promise.all([
    fetchRedditTop().catch(e => { console.warn(`⚠️ Reddit取得失敗: ${e.message}`); return []; }),
    fetchAllRss(),
    fetchJapanThreads(),
  ]);

  // ② 過去7日(168h)の既出IDを取得してフィルター
  const history = loadHistory();
  const seenSet = getSeenSet(history);

  const newRedditAll = redditPosts.filter(p => !seenSet.has(p.id));
  const newRssAll    = rssPosts.filter(p => !seenSet.has(p.id));
  const newJapanAll  = japanRaw.filter(p => !seenSet.has(p.id));

  console.log(`🔍 Dedup(7days): Reddit ${redditPosts.length}→${newRedditAll.length}, RSS ${rssPosts.length}→${newRssAll.length}, Japan ${japanRaw.length}→${newJapanAll.length}`);

  // ③ 選定: Reddit=ウォーターフォール鮮度(velocity降順) + RSS=新着順
  const nowSec = Date.now() / 1000;
  let selectedReddit = [];
  for (const maxH of FRESH_WINDOWS) {
    const fresh = newRedditAll.filter(p => (nowSec - p.created_utc) <= maxH * 3600);
    console.log(`  Reddit ${maxH}h以内: ${fresh.length}件`);
    if (fresh.length >= REDDIT_SELECT_N) {
      selectedReddit = fresh
        .sort((a, b) => (b.velocity || b.score) - (a.velocity || a.score))
        .slice(0, REDDIT_SELECT_N);
      console.log(`  → ${maxH}h窓で${REDDIT_SELECT_N}件選定（velocity降順）`);
      break;
    }
  }
  if (selectedReddit.length === 0) {
    selectedReddit = newRedditAll
      .sort((a, b) => (b.velocity || b.score) - (a.velocity || a.score))
      .slice(0, REDDIT_SELECT_N);
    console.log(`  → フォールバック: 全期間から${selectedReddit.length}件選定`);
  }

  const selectedRss = newRssAll
    .sort((a, b) => b.created_utc - a.created_utc)
    .slice(0, RSS_SELECT_N);

  // Japanスレはスコア降順で最大JAPAN_SELECT_N件（dedup済み）
  const selectedJapan = newJapanAll
    .sort((a, b) => b.score - a.score)
    .slice(0, JAPAN_SELECT_N);

  if (selectedJapan.length) {
    console.log(`🇯🇵 Japanスレ選定: ${selectedJapan.length}件 (スコア≥${JAPAN_MIN_SCORE} / コメント≥${JAPAN_MIN_COMMENTS})`);
    selectedJapan.forEach(p => console.log(`   → [▲${p.score}] ${p.title}`));
  }

  const selected = [...selectedReddit, ...selectedRss, ...selectedJapan];

  if (selected.length === 0) {
    console.log("⏭ 新規ネタなし（全て既出）、スキップ");
    return;
  }

  console.log(`✅ 選定: Reddit ${selectedReddit.length}件 + RSS ${selectedRss.length}件 + Japan ${selectedJapan.length}件 = 計${selected.length}件`);

  // ④ Reddit コメント取得（選定分のみ）
  const selectedRedditWithComments = await Promise.all(
    selected.filter(p => p.source === "reddit").map(async p => ({
      ...p,
      comments: await fetchComments(p.permalink),
    }))
  );
  const selectedRssItems = selected.filter(p => p.source !== "reddit");
  const selectedWithComments = [...selectedRedditWithComments, ...selectedRssItems];

  // ⑤ タイトル翻訳（Reddit のみ）
  console.log("🌐 Translating Reddit titles...");
  const translated = await translateTitles(selectedWithComments);

  // ⑥ added_at を付与（同一バッチ内はscore降順が維持されるようにする）
  const postsWithTime = translated.map(p => ({ ...p, added_at: iso }));

  // ⑦ seen_history に追加
  recordToHistory(history, date, postsWithTime.map(p => p.id));
  saveHistory(history);
  console.log(`📚 History updated: ${Object.keys(history.seen).length} days tracked`);

  // ⑧ 既存の当日JSONに追記（新しいバッチを先頭に）
  const existing = loadDaily(date);
  const existingPosts = existing?.posts || [];

  // 既存JSONに同じIDがあれば除外（二重追加防止）
  const existingIds = new Set(existingPosts.map(p => p.id));
  const trulyNew = postsWithTime.filter(p => !existingIds.has(p.id));

  // 新しいバッチ先頭 + 既存（added_at降順、同一バッチ内はscore降順）
  const allPosts = [...trulyNew, ...existingPosts].sort((a, b) => {
    const ta = a.added_at ? new Date(a.added_at).getTime() : 0;
    const tb = b.added_at ? new Date(b.added_at).getTime() : 0;
    if (tb !== ta) return tb - ta;                          // 新しいバッチが上
    return (b.score || 0) - (a.score || 0);                // 同バッチ内はscore降順
  });

  const todayData = {
    date,
    created_at:   existing?.created_at || iso,
    last_updated: iso,
    posts:        allPosts,
  };

  saveDaily(date, todayData);
  sendToVps(date);

  console.log("✅ Done.\n");
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

main().catch(e => {
  console.error(`❌ Fatal error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
