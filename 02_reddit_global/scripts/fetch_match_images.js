// fetch_match_images.js
// 試合関連画像をXから取得する
//
// 取得戦略:
//   1. X公式チームアカウントの画像ツイート（ホーム・アウェイ各最大4枚 = 合計最大8枚）
//   2. Xキーワード検索で画像ツイート（最大8枚）
//
// チーム名がない場合（RSS/まとめ）は keyword（英語）をキーワード検索に使用

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs    = require("fs");
const path  = require("path");
const https = require("https");
const http  = require("http");

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
  // ─── 代表チーム ───────────────────────────────────────────────────────────────
  // アジア
  "Japan":                 "jfa_samuraiblue",
  "日本":                  "jfa_samuraiblue",
  "日本代表":              "jfa_samuraiblue",
  "South Korea":           "KFA_football",
  "Korea":                 "KFA_football",
  "Australia":             "Socceroos",
  "Saudi Arabia":          "SaudiNT",
  "Iran":                  "TeamMelliIran",
  // ヨーロッパ
  "England":               "England",
  "France":                "equipedefrance",
  "Germany":               "DFB_Team",
  "Spain":                 "SEFutbol",
  "Portugal":              "selecaoportugal",
  "Italy":                 "Azzurri",
  "Netherlands":           "OnsOranje",
  "Belgium":               "BelRedDevils",
  "Croatia":               "HNS_CFF",
  "Switzerland":           "nati_sfv_asf",
  "Austria":               "oefb1904",
  "Serbia":                "fss_rs",
  "Turkey":                "MilliTakimlar",
  "Turkiye":               "MilliTakimlar",
  "Poland":                "LaczyNasPilka",
  "Denmark":               "dbulandshold",
  "Sweden":                "svenskfotboll",
  "Norway":                "nff_landslag",
  "Scotland":              "ScotlandNT",
  "Wales":                 "Cymru",
  "Ukraine":               "uafukraine",
  "Czech Republic":        "ceskareprezentace",
  "Slovakia":              "SFZ_football",
  "Hungary":               "mlsz",
  "Greece":                "EPO_GR",
  // 南米
  "Brazil":                "CBF_Futebol",
  "Argentina":             "Argentina",
  "Uruguay":               "AUFoficial",
  "Colombia":              "FCFSeleccionCol",
  "Chile":                 "LaRoja",
  "Ecuador":               "LaTri",
  "Paraguay":              "Albirroja",
  "Peru":                  "SeleccionPeru",
  "Venezuela":             "VFutbol",
  "Bolivia":               "laverde_fbf",
  // 北中米
  "USA":                   "ussoccer",
  "United States":         "ussoccer",
  "Mexico":                "miseleccionmx",
  "Canada":                "CanadaSoccerEN",
  "Costa Rica":            "fedefutbolcrc",
  "Panama":                "fepafutbol",
  "Honduras":              "FenafuthOficial",
  "Jamaica":               "jff_football",
  // アフリカ
  "Morocco":               "EnMaroc",
  "Senegal":               "Fsfofficielle",
  "Egypt":                 "EFA",
  "Nigeria":               "NGSuperEagles",
  "Cameroon":              "FecafootOfficie",
  "Ivory Coast":           "fif_ci",
  "Ghana":                 "GhanaBlackstars",
  "South Africa":          "Bafana_Bafana",
  "Mali":                  "femafoot",
  "Tunisia":               "FTF1957",
  // 中東
  "Qatar":                 "QFA",
  "Saudi Arabia":          "SaudiNT",
  "UAE":                   "UAEfootball",
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
// homeTeam / awayTeam がある場合 → X公式アカウント + チーム名キーワード検索
// ない場合（RSS/まとめ） → keyword（英語に翻訳済み）でキーワード検索
const LOG_FILE = require("path").join(__dirname, "..", "fetch_images.log");

async function fetchMatchImages({ homeTeam, awayTeam, matchDate, saveDir, prefix, verbose = true, keyword = null }) {
  const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  const log = s => {
    if (verbose) process.stdout.write(s);
    logStream.write(s);
  };
  log(`\n=== fetchMatchImages [${new Date().toISOString()}] home:${homeTeam} away:${awayTeam} keyword:${keyword} ===\n`);

  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  // 試合記事: ±2日 / キーワード記事（移籍・トピック）: ±7日
  const isMatchSearch = !!(homeTeam && awayTeam);
  const daysBefore = isMatchSearch ? 2 : 7;
  const sinceDate = (() => {
    const d = new Date(matchDate); d.setDate(d.getDate() - daysBefore);
    return d.toISOString().slice(0, 10);
  })();
  const untilDate = (() => {
    const d = new Date(matchDate); d.setDate(d.getDate() + 3);
    return d.toISOString().slice(0, 10);
  })();

  const allPaths = [];

  // ── 戦略1: X公式アカウント画像（チーム名がある場合のみ） ─────────────────────
  const homeHandle = TEAM_HANDLES[homeTeam];
  const awayHandle = TEAM_HANDLES[awayTeam];
  for (const handle of [homeHandle, awayHandle].filter(Boolean)) {
    log(`  [X公式 @${handle}]\n`);
    try {
      const data = await twitterSearch(`from:${handle} filter:images since:${sinceDate} until:${untilDate}`, "Latest");
      const urls = extractImageUrls(data.tweets).slice(0, 4);
      log(`    ${urls.length}枚の候補\n`);
      const saved = await downloadImages(urls, saveDir, prefix, allPaths.length + 1, 4, log);
      allPaths.push(...saved);
    } catch (e) {
      log(`    失敗: ${e.message}\n`);
    }
    await sleep(1500);
  }

  // ── 戦略2: Xキーワード画像検索 ───────────────────────────────────────────────
  const xKeyword = (homeTeam && awayTeam)
    ? `"${homeTeam}" "${awayTeam}"`
    : (keyword ? keyword.slice(0, 60) : null);

  if (xKeyword) {
    log(`  [Xキーワード画像: ${xKeyword}]\n`);
    try {
      const query = `${xKeyword} since:${sinceDate} until:${untilDate} -filter:retweets`;
      const data  = await twitterSearch(query, "Top");
      const rawTweets = data.tweets || [];
      const urls  = extractImageUrls(rawTweets).slice(0, 8);
      log(`    ${urls.length}枚の候補\n`);
      const saved = await downloadImages(urls, saveDir, prefix, allPaths.length + 1, 8, log);
      allPaths.push(...saved);
    } catch (e) {
      log(`    失敗: ${e.message}\n`);
    }
  }

  log(`=== 完了: ${allPaths.length}枚取得 ===\n`);
  logStream.end();
  return allPaths;
}

module.exports = { fetchMatchImages };
