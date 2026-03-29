// fetch_match_center.js
// SofaScore (非公式API) → match_center_wide.html にデータ注入 → PNG保存
// Usage: node scripts/fetch_match_center.js [YYYY-MM-DD] [tournament_ids]
//   tournament_ids: SofaScore uniqueTournament ID カンマ区切り
//   default: 17=PL, 8=LaLiga, 23=SerieA, 35=Bundesliga, 34=Ligue1
// Example: node scripts/fetch_match_center.js 2026-03-24 17,8

const axios     = require("axios");
const puppeteer = require("puppeteer");
const fs        = require("fs");
const path      = require("path");

const ROOT     = path.join(__dirname, "..");
const MC_DIR   = path.join(ROOT, "match_center");
const TEMP_DIR = path.join(ROOT, "temp");
const TEMPLATE = path.join(ROOT, "match_center_wide.html");

const BASE_URL = "https://api.sofascore.com/api/v1";
const HEADERS  = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://www.sofascore.com/",
  "Origin":          "https://www.sofascore.com",
};

// SofaScore uniqueTournament IDs
// 17=PL, 8=LaLiga, 23=SerieA, 35=Bundesliga, 34=Ligue1, 7=UCL
const DEFAULT_TOURNAMENT_IDS = [17, 8, 23, 35, 34];

if (!fs.existsSync(MC_DIR))   fs.mkdirSync(MC_DIR,   { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const dateArg       = process.argv[2] || new Date().toISOString().slice(0, 10);
const tournamentIds = process.argv[3]
  ? process.argv[3].split(",").map(Number)
  : DEFAULT_TOURNAMENT_IDS;

// ─── API ────────────────────────────────────────────────────────────────────

async function apiGet(endpoint) {
  const res = await axios.get(`${BASE_URL}${endpoint}`, { headers: HEADERS, timeout: 10000 });
  return res.data;
}

// ─── ヘルパー ────────────────────────────────────────────────────────────────

function abbr(name) {
  const words = name.replace(/[^a-zA-Z0-9 ]/g, "").trim().split(/\s+/);
  if (words.length >= 3) return (words[0][0] + words[1][0] + words[2][0]).toUpperCase();
  if (words.length === 2) return (words[0].slice(0, 2) + words[1][0]).toUpperCase();
  return name.slice(0, 3).toUpperCase();
}

function posFromLetter(letter) {
  return { G: "goalkeeper", D: "defender", M: "midfielder", F: "forward", A: "forward" }[letter] || "midfielder";
}

function formatKickoff(timestamp) {
  const d   = new Date(timestamp * 1000);
  const jst = new Date(d.getTime() + 9 * 3600000);
  const days = ["日","月","火","水","木","金","土"];
  const dow  = days[jst.getUTCDay()];
  const mm   = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(jst.getUTCDate()).padStart(2, "0");
  const hh   = String(jst.getUTCHours()).padStart(2, "0");
  const min  = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${jst.getUTCFullYear()}年${mm}月${dd}日（${dow}）${hh}:${min} JST`;
}

function statusLabel(event) {
  const type = event.status?.type;
  const code = event.status?.code;
  if (type === "finished")   return "試合終了";
  if (type === "inprogress") {
    if (code === 31) return "前半";
    if (code === 32) return "ハーフタイム";
    if (code === 33) return "後半";
    if (code === 34 || code === 35) return "延長";
    if (code === 36 || code === 37) return "PK戦";
    return "試合中";
  }
  if (type === "notstarted") return "未開始";
  if (type === "postponed")  return "延期";
  if (type === "canceled")   return "中止";
  return event.status?.description || "不明";
}

function lastName(fullName) {
  if (!fullName) return "?";
  const parts = fullName.trim().split(" ");
  return parts[parts.length - 1];
}

function parseStatVal(v) {
  if (v === null || v === undefined) return 0;
  return parseFloat(String(v).replace("%", "").replace(",", "")) || 0;
}

function findStat(groups, name) {
  for (const g of groups) {
    const item = (g.statisticsItems || []).find(i => i.name === name);
    if (item) return item;
  }
  return null;
}

// ─── 1試合処理 ───────────────────────────────────────────────────────────────

async function processEvent(event) {
  const eid     = event.id;
  const outPath = path.join(MC_DIR, `${dateArg}_${eid}.png`);

  const homeName = event.homeTeam.name;
  const awayName = event.awayTeam.name;
  console.log(`  ${homeName} vs ${awayName} (id:${eid})`);

  // キャッシュ（試合終了分のみ保存）
  const cacheFile = path.join(TEMP_DIR, `sofascore_${eid}.json`);
  let incidents, lineupData, statsRaw;
  const isLiveOrFinished = ["finished", "inprogress"].includes(event.status?.type);

  if (fs.existsSync(cacheFile)) {
    console.log(`    キャッシュ使用: sofascore_${eid}.json`);
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    incidents  = cache.incidents;
    lineupData = cache.lineups;
    statsRaw   = cache.statistics;
  } else if (isLiveOrFinished) {
    [
      { incidents },
      lineupData,
      { statistics: statsRaw },
    ] = await Promise.all([
      apiGet(`/event/${eid}/incidents`),
      apiGet(`/event/${eid}/lineups`),
      apiGet(`/event/${eid}/statistics`),
    ]);
    // 終了試合のみキャッシュ保存
    if (event.status?.type === "finished") {
      fs.writeFileSync(cacheFile, JSON.stringify({ incidents, lineups: lineupData, statistics: statsRaw }, null, 2));
    }
  } else {
    incidents  = [];
    lineupData = {};
    statsRaw   = [];
  }

  // ── イベント解析（ゴール・カード・交代） ──
  const goals = { home: [], away: [] };
  const reds  = { home: [], away: [] };
  const subs  = { home: [], away: [] };

  for (const inc of (incidents || [])) {
    const side = inc.isHome ? "home" : "away";
    const min  = String(inc.time) + (inc.addedTime ? `+${inc.addedTime}` : "") + "'";

    if (inc.incidentType === "goal") {
      if (inc.incidentClass === "cancelledGoal") continue;
      if (inc.incidentClass === "ownGoal") {
        // オウンゴール → 相手チームに加算
        const opp = side === "home" ? "away" : "home";
        goals[opp].push(`${lastName(inc.player?.name)} ${min} (OG)`);
      } else {
        goals[side].push(`${lastName(inc.player?.name)} ${min}`);
      }
    } else if (inc.incidentType === "card") {
      if (inc.incidentClass === "red" || inc.incidentClass === "yellowRed") {
        reds[side].push(`${lastName(inc.player?.name)} ${min}`);
      }
    } else if (inc.incidentType === "substitution") {
      subs[side].push(`${lastName(inc.playerOut?.name)}→${lastName(inc.playerIn?.name)} ${min}`);
    }
  }

  // ── matchData 構築 ──
  const st         = statusLabel(event);
  const elapsed    = event.time?.played ? ` · ${event.time.played}'` : "";
  const scoreTime  = `${st}${elapsed}`;
  const homeScore  = event.homeScore?.current ?? 0;
  const awayScore  = event.awayScore?.current ?? 0;
  const round      = event.roundInfo?.round ? ` · 第${event.roundInfo.round}節` : "";

  const matchData = {
    league:    `${event.tournament?.name}${round}`,
    kickoff:   formatKickoff(event.startTimestamp),
    status:    st,
    scoreTime,
    home: { abbr: abbr(homeName), name: homeName, score: homeScore, goals: goals.home, reds: reds.home, subs: subs.home },
    away: { abbr: abbr(awayName), name: awayName, score: awayScore, goals: goals.away, reds: reds.away, subs: subs.away },
  };

  // ── lineups 構築 ──
  const lineups = { HOME: [], AWAY: [] };
  if (lineupData?.home?.players) {
    lineups.HOME = lineupData.home.players
      .filter(p => p.substitute === false)
      .map(p => ({
        name: lastName(p.player.name),
        pos:  posFromLetter(p.player?.position || p.position),
      }));
  }
  if (lineupData?.away?.players) {
    lineups.AWAY = lineupData.away.players
      .filter(p => p.substitute === false)
      .map(p => ({
        name: lastName(p.player.name),
        pos:  posFromLetter(p.player?.position || p.position),
      }));
  }

  // ── statsData 構築 ──
  let statsData = [
    { label: "ポゼッション", hv: 50, av: 50, unit: "%" },
    { label: "シュート",     hv: 0,  av: 0 },
    { label: "枠内シュート", hv: 0,  av: 0 },
    { label: "コーナー",     hv: 0,  av: 0 },
    { label: "ファウル",     hv: 0,  av: 0 },
    { label: "イエロー",     hv: 0,  av: 0 },
  ];

  const allGroups = (statsRaw || []).find(s => s.period === "ALL")?.groups || [];
  if (allGroups.length) {
    const possession    = findStat(allGroups, "Ball possession");
    const totalShots    = findStat(allGroups, "Total shots");
    const shotsOnTarget = findStat(allGroups, "Shots on target");
    const cornerKicks   = findStat(allGroups, "Corner kicks");
    const fouls         = findStat(allGroups, "Total fouls committed") || findStat(allGroups, "Fouls");
    const yellowCards   = findStat(allGroups, "Yellow cards");
    statsData = [
      { label: "ポゼッション", hv: parseStatVal(possession?.home),    av: parseStatVal(possession?.away),    unit: "%" },
      { label: "シュート",     hv: parseStatVal(totalShots?.home),    av: parseStatVal(totalShots?.away) },
      { label: "枠内シュート", hv: parseStatVal(shotsOnTarget?.home), av: parseStatVal(shotsOnTarget?.away) },
      { label: "コーナー",     hv: parseStatVal(cornerKicks?.home),   av: parseStatVal(cornerKicks?.away) },
      { label: "ファウル",     hv: parseStatVal(fouls?.home),         av: parseStatVal(fouls?.away) },
      { label: "イエロー",     hv: parseStatVal(yellowCards?.home),   av: parseStatVal(yellowCards?.away) },
    ];
  }

  // ── HTML 注入 ──
  let html = fs.readFileSync(TEMPLATE, "utf8");
  html = html.replace(
    /const matchData = \{[\s\S]*?\n\};/,
    `const matchData = ${JSON.stringify(matchData, null, 4)};`
  );
  html = html.replace(
    /const lineups = \{[\s\S]*?\n\};/,
    `const lineups = ${JSON.stringify(lineups, null, 4)};`
  );
  html = html.replace(
    /const statsData = \[[\s\S]*?\n\];/,
    `const statsData = ${JSON.stringify(statsData, null, 4)};`
  );

  // ── Puppeteer でスクリーンショット ──
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page    = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setContent(html, { waitUntil: "networkidle2", timeout: 15000 });
  await page.screenshot({ path: outPath });
  await browser.close();

  console.log(`    -> ${path.basename(outPath)}`);
  return {
    fixtureId: eid,   // server.js の fixtureId 参照に合わせる
    eventId:   eid,
    home:      homeName,
    away:      awayName,
    score:     `${homeScore}:${awayScore}`,
    league:    event.tournament?.name,
    status:    st,
    file:      outPath,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Match Center / SofaScore] ${dateArg}  tournaments: ${tournamentIds.join(",")}`);

  const data      = await apiGet(`/sport/football/scheduled-events/${dateArg}`);
  const allEvents = data.events || [];

  // 対象リーグでフィルタ
  const filtered = allEvents.filter(e =>
    tournamentIds.includes(e.tournament?.uniqueTournament?.id)
  );

  console.log(`  全試合: ${allEvents.length}件 -> フィルタ後: ${filtered.length}件`);
  if (!filtered.length) { console.log("対象試合なし"); return; }

  const results = [];
  for (const event of filtered) {
    try {
      const r = await processEvent(event);
      results.push(r);
    } catch (e) {
      console.error(`  ERROR event ${event.id}: ${e.message}`);
    }
  }

  const indexPath = path.join(TEMP_DIR, `match_center_${dateArg}.json`);
  fs.writeFileSync(indexPath, JSON.stringify({ date: dateArg, matches: results }, null, 2));

  console.log(`\n完了: ${results.length}件  ->  ${MC_DIR}`);
  console.log(`インデックス: ${indexPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
