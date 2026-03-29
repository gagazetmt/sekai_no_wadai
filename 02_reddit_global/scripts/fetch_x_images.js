// fetch_x_images.js
// TwitterAPI.io で検索 → 画像付きツイート上位5件をダウンロード
// Module export: fetchXImages(keyword, prefix) → Promise<string[]>
// CLI:           node scripts/fetch_x_images.js "keyword" "prefix"

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const IMG_DIR  = path.join(__dirname, "..", "images");
const API_KEY  = process.env.TWITTER_API_IO_KEY;
const BASE_URL = "https://api.twitterapi.io";

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

// ── メディアURL抽出（レスポンス構造の違いを吸収） ──
function extractMediaUrls(tweet) {
  const urls = [];
  const sources = [
    tweet.extendedEntities?.media,
    tweet.extended_entities?.media,
    tweet.entities?.media,
    Array.isArray(tweet.media) ? tweet.media : null,
  ].filter(Boolean);

  for (const arr of sources) {
    for (const m of arr) {
      const type = (m.type || "").toLowerCase();
      if (type === "photo") {
        const url = m.media_url_https || m.mediaUrlHttps || m.media_url || m.url;
        if (url && !urls.includes(url)) urls.push(url);
      }
    }
  }
  return urls;
}

// ── 画像ダウンロード ──
async function downloadImage(url, filePath) {
  // Twitter画像は ?name=large で高解像度取得
  const fullUrl = url.includes("?") ? url : url + "?name=large";
  const res = await axios.get(fullUrl, { responseType: "arraybuffer", timeout: 12000 });
  fs.writeFileSync(filePath, res.data);
}

// ── メイン処理 ──
async function fetchXImages(keyword, prefix, limit = 10, queryType = "Latest") {
  if (!API_KEY)  { console.warn("TWITTER_API_IO_KEY not set"); return []; }
  if (!keyword)  return [];

  let tweets = [];
  try {
    const res = await axios.get(BASE_URL + "/twitter/tweet/advanced_search", {
      headers: { "X-API-Key": API_KEY },
      params:  { query: keyword, queryType },
      timeout: 12000,
    });
    // レスポンス構造の違いを吸収
    tweets = res.data?.tweets || res.data?.data?.tweets || res.data?.data || [];
    if (!Array.isArray(tweets)) tweets = [];
  } catch (e) {
    console.warn("TwitterAPI.io error:", e.message);
    return [];
  }


  const imagePaths = [];
  for (const tweet of tweets) {
    if (imagePaths.length >= limit) break;
    const mediaUrls = extractMediaUrls(tweet);
    for (const url of mediaUrls) {
      if (imagePaths.length >= limit) break;
      try {
        const ext      = url.includes(".png") ? "png" : "jpg";
        const fileName = prefix + "_x" + (imagePaths.length + 1) + "." + ext;
        const filePath = path.join(IMG_DIR, fileName);
        await downloadImage(url, filePath);
        imagePaths.push(filePath);
      } catch { /* skip */ }
    }
  }

  return imagePaths;
}

// ── X コメント取得（テキストのみ・上位20件） ──────────────────────────────────
async function fetchXComments(keyword, limit = 20) {
  if (!API_KEY)  { console.warn("TWITTER_API_IO_KEY not set"); return []; }
  if (!keyword)  return [];

  let tweets = [];
  try {
    const res = await axios.get(BASE_URL + "/twitter/tweet/advanced_search", {
      headers: { "X-API-Key": API_KEY },
      params:  { query: keyword, queryType: "Top" },
      timeout: 15000,
    });
    tweets = res.data?.tweets || res.data?.data?.tweets || res.data?.data || [];
    if (!Array.isArray(tweets)) tweets = [];
  } catch (e) {
    console.warn("TwitterAPI.io fetchXComments error:", e.message);
    return [];
  }

  return tweets
    .filter(t => {
      const text      = t.text || t.full_text || t.content || "";
      const followers = t.author?.followers || t.author?.followersCount
                     || t.user?.followers_count || t.followersCount || 0;
      // フォロワー100〜5000人に絞る（公式・報道アカウント排除）
      if (followers < 100 || followers > 5000) return false;
      // 日本語テキストのみ（英語メインは除外）
      if (!/[\u3040-\u9FFF]/.test(text)) return false;
      return text.length > 10;
    })
    .sort((a, b) => {
      const engA = (a.likeCount || a.favorite_count || a.likes || 0)
                 + (a.retweetCount || a.retweet_count || a.retweets || 0);
      const engB = (b.likeCount || b.favorite_count || b.likes || 0)
                 + (b.retweetCount || b.retweet_count || b.retweets || 0);
      return engB - engA;
    })
    .slice(0, limit)
    .map(t => {
      // テキストのみ返す（ユーザー名・いいね数は不要）
      return (t.text || t.full_text || t.content || "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    })
    .filter(t => t.length > 5);
}

// ── クラブ公式アカウントから画像取得 ────────────────────────────────────────
const TEAM_X_MAP_PATH = require("path").join(__dirname, "..", "logos", "team_x_accounts.json");

function resolveTeamHandle(teamName) {
  try {
    const map  = JSON.parse(fs.readFileSync(TEAM_X_MAP_PATH, "utf8"));
    const teams = map.teams || {};
    // 完全一致
    if (teams[teamName]) return teams[teamName].handle;
    // 大文字小文字無視の部分一致
    const lower = (teamName || "").toLowerCase();
    const found = Object.keys(teams).find(k => k.toLowerCase() === lower);
    if (found) return teams[found].handle;
    return null;
  } catch { return null; }
}

async function fetchOfficialXImages(teamName, prefix, limit = 7) {
  const handle = resolveTeamHandle(teamName);
  if (!handle) return [];
  return fetchXImages(`from:${handle} filter:images -filter:retweets`, prefix, limit, "Top");
}

// クエリ文字列からチーム名を検出して公式画像を取得（SCRIPT B用）
async function fetchOfficialXImagesFromQuery(query, prefix, limit = 5) {
  try {
    const map   = JSON.parse(fs.readFileSync(TEAM_X_MAP_PATH, "utf8"));
    const teams = map.teams || {};
    const lower = query.toLowerCase();
    const matched = Object.keys(teams).filter(name => lower.includes(name.toLowerCase()));
    // 重複ハンドルを除去して最大2チーム
    const seen = new Set();
    const targets = matched.filter(name => {
      const h = teams[name].handle;
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    }).slice(0, 2);
    if (!targets.length) return [];
    const results = await Promise.all(
      targets.map((name, i) => fetchOfficialXImages(name, `${prefix}_nt${i}`, limit))
    );
    return results.flat();
  } catch { return []; }
}

module.exports = { fetchXImages, fetchXComments, fetchOfficialXImages, fetchOfficialXImagesFromQuery };

// ── CLI実行 ──
if (require.main === module) {
  const keyword = process.argv[2] || "";
  const prefix  = process.argv[3] || "x_img";
  fetchXImages(keyword, prefix)
    .then(paths => { process.stdout.write(JSON.stringify(paths)); })
    .catch(e   => { process.stderr.write(e.message); process.stdout.write("[]"); });
}
