// fetch_stock_images.js
// 公式Xから画像取得 → Claude Vision でブランディング判定 → stock/ に保存
//
// 使い方:
//   テスト（1チーム）: node scripts/fetch_stock_images.js --team="Manchester United"
//   全チーム:          node scripts/fetch_stock_images.js --all
//   特定リーグのみ:    node scripts/fetch_stock_images.js --league="Premier League"

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs        = require("fs");
const path      = require("path");
const axios     = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const client   = new Anthropic();
const API_KEY  = process.env.TWITTER_API_IO_KEY;
const BASE_URL = "https://api.twitterapi.io";

const STOCK_DIR      = path.join(__dirname, "..", "stock");
const STOCK_INDEX    = path.join(STOCK_DIR, "index.json");
const TEAM_X_MAP     = path.join(__dirname, "..", "logos", "team_x_accounts.json");
const FETCH_LIMIT    = 20;   // 1チームあたり取得する画像の最大枚数
const SAVE_LIMIT     = 5;    // 1チームあたり保存するブランディング画像の枚数
const IMG_EXTS       = [".jpg", ".jpeg", ".png", ".webp"];

// ─── 画像URLを抽出 ────────────────────────────────────────────────────────────
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
      if ((m.type || "").toLowerCase() === "photo") {
        const url = m.media_url_https || m.mediaUrlHttps || m.media_url || m.url;
        if (url && !urls.includes(url)) urls.push(url);
      }
    }
  }
  return urls;
}

// ─── 公式アカウントから画像URLを収集（ダウンロードなし） ────────────────────────
async function fetchOfficialImageUrls(handle, limit = FETCH_LIMIT, stadium = null) {
  const keyword = stadium ? `"${stadium}"` : "(stadium OR atmosphere OR crest OR kit)";
  const res = await axios.get(BASE_URL + "/twitter/tweet/advanced_search", {
    headers: { "X-API-Key": API_KEY },
    params:  { query: `from:${handle} filter:images min_faves:200 ${keyword}`, queryType: "Top" },
    timeout: 15000,
  });
  const tweets = res.data?.tweets || res.data?.data?.tweets || res.data?.data || [];
  // いいね数降順でソート（直近の試合写真より定番ブランディング投稿を優先）
  const sorted = (Array.isArray(tweets) ? [...tweets] : []).sort((a, b) => {
    const likesA = a.favoriteCount ?? a.favorite_count ?? a.likeCount ?? 0;
    const likesB = b.favoriteCount ?? b.favorite_count ?? b.likeCount ?? 0;
    return likesB - likesA;
  });
  const urls = [];
  for (const tweet of sorted) {
    if (urls.length >= limit) break;
    for (const url of extractMediaUrls(tweet)) {
      if (urls.length >= limit) break;
      urls.push(url);
    }
  }
  return urls;
}

// ─── 画像をダウンロードして一時ファイルに保存 ────────────────────────────────
async function downloadTemp(url, tmpPath) {
  const fullUrl = url.includes("?") ? url : url + "?name=small";
  const res = await axios.get(fullUrl, { responseType: "arraybuffer", timeout: 12000 });
  fs.writeFileSync(tmpPath, res.data);
}

// ─── Claude Vision でブランディング画像か判定 ─────────────────────────────────
async function isBrandingImage(imgPath, teamName) {
  const ext  = path.extname(imgPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const b64  = fs.readFileSync(imgPath).toString("base64");

  const msg = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 10,
    messages: [{
      role: "user",
      content: [
        {
          type:   "image",
          source: { type: "base64", media_type: mime, data: b64 },
        },
        {
          type: "text",
          text: `Is this a branding image specifically for ${teamName}? It should show ${teamName}'s own stadium, training ground, club crest/badge, official kit, or supporter atmosphere at their home venue — NOT an opponent's stadium, NOT a generic crowd, NOT a close-up of a player face or in-game action. Answer only "yes" or "no".`,
        },
      ],
    }],
  });
  const usage = msg.usage;
  process.stdout.write(`[in:${usage?.input_tokens} out:${usage?.output_tokens}] `);
  return msg.content[0].text.trim().toLowerCase().startsWith("yes");
}

// ─── チームslugを取得（stock/index.json から） ──────────────────────────────
function getStockSlug(teamName) {
  const { _comment, ...map } = JSON.parse(fs.readFileSync(STOCK_INDEX, "utf8"));
  // 完全一致
  if (map[teamName]) return map[teamName];
  // 大文字小文字無視
  const lower = teamName.toLowerCase();
  const found = Object.keys(map).find(k => k.toLowerCase() === lower);
  return found ? map[found] : null;
}

// ─── 1チームの処理 ──────────────────────────────────────────────────────────
async function processTeam(teamName, handle, stadium = null) {
  const slug = getStockSlug(teamName);
  if (!slug) {
    console.log(`  ⚠️  stock/index.json にスラグなし: ${teamName} → スキップ`);
    return { saved: 0 };
  }

  const saveDir = path.join(STOCK_DIR, slug);
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  // 既に十分な画像がある場合はスキップ
  const existing = fs.readdirSync(saveDir).filter(f => IMG_EXTS.includes(path.extname(f).toLowerCase()));
  if (existing.length >= SAVE_LIMIT) {
    console.log(`  ✅ スキップ（既に${existing.length}枚）`);
    return { saved: 0 };
  }
  const needed = SAVE_LIMIT - existing.length;

  // 画像URL取得
  process.stdout.write(`  X取得中 @${handle}... `);
  let urls;
  try {
    urls = await fetchOfficialImageUrls(handle, FETCH_LIMIT, stadium);
    console.log(`${urls.length}枚のURL取得`);
  } catch (e) {
    console.log(`失敗: ${e.message}`);
    return { saved: 0 };
  }

  // Vision判定 → 保存
  let saved = 0;
  const TMP  = path.join(STOCK_DIR, "_tmp");
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

  for (let i = 0; i < urls.length && saved < needed; i++) {
    const tmpPath = path.join(TMP, `tmp_${Date.now()}.jpg`);
    try {
      await downloadTemp(urls[i], tmpPath);
      process.stdout.write(`    [${i + 1}/${urls.length}] Vision判定... `);
      const ok = await isBrandingImage(tmpPath, teamName);
      if (ok) {
        const num      = existing.length + saved + 1;
        const destName = String(num).padStart(2, "0") + ".jpg";
        fs.renameSync(tmpPath, path.join(saveDir, destName));
        saved++;
        console.log(`✅ ブランディング → ${destName}`);
      } else {
        fs.unlinkSync(tmpPath);
        console.log(`❌ 対象外`);
      }
    } catch (e) {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      console.log(`エラー: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // tmpフォルダ掃除
  try { fs.rmdirSync(TMP); } catch {}

  return { saved };
}

// ─── メイン ─────────────────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) { console.error("TWITTER_API_IO_KEY が設定されていません"); process.exit(1); }

  const teamArg   = process.argv.find(a => a.startsWith("--team="))?.replace("--team=", "");
  const leagueArg = process.argv.find(a => a.startsWith("--league="))?.replace("--league=", "");
  const doAll     = process.argv.includes("--all");

  const { teams } = JSON.parse(fs.readFileSync(TEAM_X_MAP, "utf8"));

  let targets = [];
  if (teamArg) {
    const entry = teams[teamArg];
    if (!entry) { console.error(`チームが見つかりません: ${teamArg}`); process.exit(1); }
    targets = [{ name: teamArg, handle: entry.handle, stadium: entry.stadium || null }];
  } else if (leagueArg) {
    targets = Object.entries(teams)
      .filter(([, v]) => v.league === leagueArg)
      .map(([name, v]) => ({ name, handle: v.handle, stadium: v.stadium || null }));
  } else if (doAll) {
    // 重複handle除去
    const seen = new Set();
    targets = Object.entries(teams)
      .filter(([, v]) => { if (seen.has(v.handle)) return false; seen.add(v.handle); return true; })
      .map(([name, v]) => ({ name, handle: v.handle, stadium: v.stadium || null }));
  } else {
    console.error("使い方:\n  --team=\"Manchester United\"\n  --league=\"Premier League\"\n  --all");
    process.exit(1);
  }

  console.log(`\n=== ストック素材収集 (${targets.length}チーム) ===\n`);
  let totalSaved = 0;

  for (let i = 0; i < targets.length; i++) {
    const { name, handle, stadium } = targets[i];
    console.log(`[${i + 1}/${targets.length}] ${name} (@${handle})${stadium ? ` [${stadium}]` : ""}`);
    const { saved } = await processTeam(name, handle, stadium);
    totalSaved += saved;
    console.log(`  → ${saved}枚保存\n`);
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n✅ 完了！合計 ${totalSaved}枚保存`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
