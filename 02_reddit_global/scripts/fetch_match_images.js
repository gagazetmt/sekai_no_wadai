// fetch_match_images.js
// 試合関連画像を複数ソースから取得する
//
// 取得戦略（順番に実行）:
//   0. YouTubeハイライトのチャプターからゴール・レッドカード瞬間をキャプチャ（メイン）
//   1. X公式チームアカウントの画像ツイート（ホーム・アウェイ各最大4枚）
//   2. Xキーワード検索で画像ツイート（最大4枚）
//   3. 1枚も取れなかった場合のみ TheSportsDB チームバナーで代替

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const http    = require("http");
const { execSync } = require("child_process");

const FFMPEG  = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffmpeg.exe" : "ffmpeg";
const YTDLP   = process.platform === "win32"
  ? path.join(__dirname, "..", "_tools", "yt-dlp.exe")
  : "yt-dlp";
const MAX_TOTAL = 20; // 取得上限（YouTube最大15枚 + X補完）

// ─── 公式Xアカウントマッピング ─────────────────────────────────────────────────
const TEAM_HANDLES = {
  // Premier League
  "Arsenal":               "Arsenal",
  "Chelsea":               "ChelseaFC",
  "Manchester City":       "ManCity",
  "Man City":              "ManCity",
  "Manchester United":     "ManUtd",
  "Liverpool":             "LFC",
  "Tottenham":             "SpursOfficial",
  "Tottenham Hotspur":     "SpursOfficial",
  "Newcastle":             "NUFC",
  "Newcastle United":      "NUFC",
  "Aston Villa":           "AVFCOfficial",
  "West Ham":              "WestHam",
  "Nottingham Forest":     "NFFC",
  "Crystal Palace":        "CPFC",
  "Brighton":              "OfficialBHAFC",
  "Brentford":             "BrentfordFC",
  "Fulham":                "FulhamFC",
  "Wolves":                "Wolves",
  "Wolverhampton":         "Wolves",
  "Everton":               "Everton",
  "Leicester":             "LCFC",
  "Leicester City":        "LCFC",
  "Ipswich":               "IpswichTown",
  "Southampton":           "SouthamptonFC",
  // La Liga
  "Real Madrid":           "realmadrid",
  "Barcelona":             "FCBarcelona",
  "Atlético Madrid":       "Atleti",
  "Atletico Madrid":       "Atleti",
  "Sevilla":               "SevillaFC",
  "Valencia":              "valenciacf",
  "Athletic Club":         "AthleticClub",
  "Real Sociedad":         "RealSociedad",
  "Villarreal":            "VillarrealCF",
  "Osasuna":               "Osasuna",
  // Bundesliga
  "Bayern Munich":         "FCBayernEN",
  "Borussia Dortmund":     "BVB",
  "RB Leipzig":            "RBLeipzig_EN",
  "Bayer Leverkusen":      "bayer04fussball",
  "Eintracht Frankfurt":   "eintracht",
  // Serie A
  "Inter Milan":           "Inter",
  "AC Milan":              "acmilan",
  "Juventus":              "juventusen",
  "Napoli":                "sscnapoli",
  "Roma":                  "OfficialASRoma",
  "Lazio":                 "OfficialSSLazio",
  // Ligue 1
  "Paris Saint-Germain":   "PSG_English",
  "PSG":                   "PSG_English",
  "Monaco":                "AS_Monaco_EN",
  "Marseille":             "OM_English",
  // Others
  "Sporting CP":           "SportingCP",
  "Sporting":              "SportingCP",
  "Benfica":               "SLBenfica",
  "Porto":                 "FCPorto",
  "Ajax":                  "AFCAjax",
  "Feyenoord":             "Feyenoord",
  "PSV":                   "PSV",
  "Celtic":                "CelticFC",
  "Rangers":               "RangersFC",
  "Bodø/Glimt":            "FKBodoGlimt",
  "Bodo/Glimt":            "FKBodoGlimt",
};

// ─── ユーティリティ ───────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (e) => { fs.unlink(destPath, () => {}); reject(e); });
  });
}

// ─── TwitterAPI.io 検索 ───────────────────────────────────────────────────────
async function twitterSearch(query, queryType = "Latest", retries = 2) {
  const apiKey = process.env.TWITTER_API_IO_KEY;
  if (!apiKey) throw new Error("TWITTER_API_IO_KEY が未設定です");
  const params = new URLSearchParams({ query, queryType, cursor: "" });
  const url = `https://api.twitterapi.io/twitter/tweet/advanced_search?${params}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt);
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (res.status === 429) {
      if (attempt < retries) continue;
      throw new Error("TwitterAPI.io 429: レート制限");
    }
    if (!res.ok) throw new Error(`TwitterAPI.io エラー: ${res.status}`);
    return res.json();
  }
}

function extractImageUrls(tweets) {
  const urls = [];
  for (const tweet of tweets || []) {
    const mediaArr = tweet.extendedEntities?.media || tweet.entities?.media || [];
    for (const m of mediaArr) {
      if (m.type === "photo" && m.media_url_https) urls.push(m.media_url_https);
    }
  }
  return [...new Set(urls)];
}

// ─── YouTube ハイライト取得 ───────────────────────────────────────────────────
async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) return;
  console.log("[yt-dlp] ダウンロード中...");
  fs.mkdirSync(path.dirname(YTDLP), { recursive: true });
  const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  await new Promise((resolve, reject) => {
    function download(u) {
      https.get(u, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return download(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(YTDLP);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      }).on("error", reject);
    }
    download(url);
  });
  console.log("[yt-dlp] ダウンロード完了！");
}

function searchYouTube(query) {
  const body = JSON.stringify({
    query,
    context: { client: { clientName: "WEB", clientVersion: "2.20240101" } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.youtube.com",
      path: "/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Mozilla/5.0",
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractVideoIds(searchData) {
  const ids = [];
  const contents = searchData?.contents?.twoColumnSearchResultsRenderer
    ?.primaryContents?.sectionListRenderer?.contents || [];
  for (const section of contents) {
    for (const item of section?.itemSectionRenderer?.contents || []) {
      const id = item?.videoRenderer?.videoId;
      if (id) ids.push({ id, title: item.videoRenderer?.title?.runs?.[0]?.text || "" });
    }
  }
  return ids;
}

function getChaptersFromYtDlp(videoId) {
  try {
    const raw = execSync(
      `"${YTDLP}" --dump-json "https://www.youtube.com/watch?v=${videoId}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return JSON.parse(raw.trim()).chapters || null;
  } catch {
    return null;
  }
}

function extractKeyChapters(chapters) {
  return chapters.filter(c => {
    const t = c.title.toUpperCase();
    return t.includes("GOAL") || t.includes("RED CARD");
  });
}

async function fetchYouTubeHighlightImages({ homeTeam, awayTeam, saveDir, prefix, log }) {
  const OFFSETS  = [10, 15, 20, 25, 30];
  const CLIP_SEC = OFFSETS[OFFSETS.length - 1] + 3; // 33秒
  const savedPaths = [];

  await ensureYtDlp();

  const searchQuery = `${homeTeam} ${awayTeam} highlights`;
  log(`  [YouTube: "${searchQuery}"]\n`);

  const searchData = await searchYouTube(searchQuery);
  const videos = extractVideoIds(searchData);
  log(`    ${videos.length}件ヒット\n`);
  if (!videos.length) return savedPaths;

  let keyChapters = [];
  let targetVideo = null;
  for (const video of videos.slice(0, 5)) {
    log(`    チャプター確認: ${video.title.slice(0, 50)}\n`);
    const chapters = getChaptersFromYtDlp(video.id);
    if (!chapters) { log(`      チャプターなし\n`); continue; }
    keyChapters = extractKeyChapters(chapters);
    if (keyChapters.length > 0) {
      log(`      ✅ GOAL/RED CARD ${keyChapters.length}件\n`);
      targetVideo = video;
      break;
    }
    log(`      GOAL/RED CARDなし（スキップ）\n`);
  }

  if (!targetVideo) {
    log(`    GOAL/RED CARDチャプターが見つかりませんでした\n`);
    return savedPaths;
  }

  const ytUrl  = `https://www.youtube.com/watch?v=${targetVideo.id}`;
  const goals    = keyChapters.filter(c => c.title.toUpperCase().includes("GOAL"));
  const redCards = keyChapters.filter(c => c.title.toUpperCase().includes("RED CARD"));
  const targets  = [
    goals[0]                                    && { chapter: goals[0],                tag: "goal_first" },
    goals.length > 1 && goals[goals.length - 1] && { chapter: goals[goals.length - 1], tag: "goal_last"  },
    redCards[0]                                 && { chapter: redCards[0],             tag: "redcard"    },
  ].filter(Boolean);

  log(`    対象: ${targets.map(t => t.tag).join(", ")}\n`);

  for (const { chapter, tag } of targets) {
    const dlStart  = Math.max(0, chapter.start_time - 2);
    const dlEnd    = chapter.start_time + CLIP_SEC;
    const videoOut = path.join(saveDir, `${prefix}_${tag}.mp4`); // 動画は保持
    log(`    [${tag}] DL: ${dlStart}〜${dlEnd}秒\n`);
    try {
      execSync(
        `"${YTDLP}" -f "bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]/bestvideo" --download-sections "*${dlStart}-${dlEnd}" --force-keyframes-at-cuts -o "${videoOut}" "${ytUrl}"`,
        { stdio: "pipe" }
      );
      for (let j = 0; j < OFFSETS.length; j++) {
        const ss  = OFFSETS[j] + 2;
        const out = path.join(saveDir, `${prefix}_${tag}_${j + 1}.jpg`);
        execSync(
          `"${FFMPEG}" -y -i "${videoOut}" -ss ${ss} -vframes 1 -q:v 2 "${out}"`,
          { stdio: "pipe" }
        );
        const kb = Math.round(fs.statSync(out).size / 1024);
        savedPaths.push(out);
        log(`      ✅ +${OFFSETS[j]}秒 → ${path.basename(out)} (${kb}KB)\n`);
      }
    } catch (e) {
      log(`      フレーム抽出失敗: ${e.message.slice(0, 80)}\n`);
    }
  }

  return savedPaths;
}

// ─── TheSportsDB フォールバック ───────────────────────────────────────────────
async function fetchSportsDbBanner(teamName) {
  try {
    const res  = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(teamName)}`);
    const data = await res.json();
    const team = data?.teams?.[0];
    return team?.strTeamBanner || team?.strTeamFanart1 || team?.strStadiumThumb || null;
  } catch { return null; }
}

// ─── 画像URLリストをダウンロードして保存 ─────────────────────────────────────
async function downloadImages(urls, saveDir, prefix, startIdx, maxCount, log) {
  const saved = [];
  for (const url of urls.slice(0, maxCount)) {
    if (saved.length >= maxCount) break;
    const ext  = url.includes(".png") ? "png" : "jpg";
    const dest = path.join(saveDir, `${prefix}_${startIdx + saved.length}.${ext}`);
    try {
      await downloadFile(url, dest);
      const kb = Math.round(fs.statSync(dest).size / 1024);
      saved.push(dest);
      log(`    ✅ ${path.basename(dest)} (${kb}KB)\n`);
    } catch (e) {
      log(`    ⚠️ DL失敗: ${e.message}\n`);
    }
  }
  return saved;
}

// ─── メイン: fetchMatchImages ─────────────────────────────────────────────────
// returns: string[] 取得できた画像パスの配列（最大MAX_TOTAL枚・nullなし）
async function fetchMatchImages({ homeTeam, awayTeam, matchDate, saveDir, prefix, verbose = true }) {
  const log = verbose ? s => process.stdout.write(s) : () => {};

  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  const sinceDate = (() => {
    const d = new Date(matchDate); d.setDate(d.getDate() - 2);
    return d.toISOString().slice(0, 10);
  })();
  const untilDate = (() => {
    const d = new Date(matchDate); d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  })();

  const allPaths = []; // 全取得済みパス

  // ── 戦略0: YouTubeハイライト（メイン） ───────────────────────────────────────
  try {
    const ytPaths = await fetchYouTubeHighlightImages({ homeTeam, awayTeam, saveDir, prefix, log });
    allPaths.push(...ytPaths);
  } catch (e) {
    log(`  [YouTube] 失敗: ${e.message}\n`);
  }

  // ── 戦略1: X公式アカウント画像 ───────────────────────────────────────────────
  const homeHandle = TEAM_HANDLES[homeTeam];
  const awayHandle = TEAM_HANDLES[awayTeam];
  for (const handle of [homeHandle, awayHandle].filter(Boolean)) {
    if (allPaths.length >= MAX_TOTAL) break;
    log(`  [X公式 @${handle}]\n`);
    try {
      const data = await twitterSearch(`from:${handle} filter:images since:${sinceDate} until:${untilDate}`, "Latest");
      const urls = extractImageUrls(data.tweets).slice(0, 4);
      log(`    ${urls.length}枚の候補\n`);
      const saved = await downloadImages(urls, saveDir, prefix, allPaths.length + 1, MAX_TOTAL - allPaths.length, log);
      allPaths.push(...saved);
    } catch (e) {
      log(`    失敗: ${e.message}\n`);
    }
    await sleep(1500);
  }

  // ── 戦略2: Xキーワード画像検索 ───────────────────────────────────────────────
  if (allPaths.length < MAX_TOTAL) {
    log(`  [Xキーワード画像: "${homeTeam}" "${awayTeam}"]\n`);
    try {
      const query = `"${homeTeam}" "${awayTeam}" filter:images since:${sinceDate} until:${untilDate} -filter:retweets`;
      const data  = await twitterSearch(query, "Top");
      const urls  = extractImageUrls(data.tweets).slice(0, 4);
      log(`    ${urls.length}枚の候補\n`);
      const saved = await downloadImages(urls, saveDir, prefix, allPaths.length + 1, MAX_TOTAL - allPaths.length, log);
      allPaths.push(...saved);
    } catch (e) {
      log(`    失敗: ${e.message}\n`);
    }
    await sleep(1500);
  }

  // ── 戦略3: TheSportsDB フォールバック（1枚も取れなかった時のみ） ──────────────
  if (allPaths.length === 0) {
    log(`  [TheSportsDB フォールバック]\n`);
    const bannerUrl = await fetchSportsDbBanner(homeTeam) || await fetchSportsDbBanner(awayTeam);
    if (bannerUrl) {
      const dest = path.join(saveDir, `${prefix}_1.jpg`);
      try {
        await downloadFile(bannerUrl, dest);
        allPaths.push(dest);
        log(`    ✅ ${path.basename(dest)}\n`);
      } catch (e) {
        log(`    失敗: ${e.message}\n`);
      }
    }
  }

  return allPaths; // null なし・取得できた分だけ返す
}

module.exports = { fetchMatchImages };

// ─── 単独実行テスト ──────────────────────────────────────────────────────────
if (require.main === module) {
  const homeTeam  = process.argv[2] || "Arsenal";
  const awayTeam  = process.argv[3] || "Chelsea";
  const matchDate = process.argv[4] || new Date().toISOString().slice(0, 10);
  const saveDir   = path.join(__dirname, "..", "images");
  const prefix    = `test_${matchDate}_${Date.now()}`;

  console.log(`\n[テスト] ${homeTeam} vs ${awayTeam} (${matchDate})\n`);
  fetchMatchImages({ homeTeam, awayTeam, matchDate, saveDir, prefix, verbose: true })
    .then(paths => {
      console.log(`\n取得結果: ${paths.length}枚`);
      paths.forEach((p, i) => console.log(`  ${i + 1}: ${p}`));
    })
    .catch(console.error);
}
