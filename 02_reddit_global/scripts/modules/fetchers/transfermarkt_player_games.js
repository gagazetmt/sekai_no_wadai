// scripts/modules/fetchers/transfermarkt_player_games.js
// Transfermarkt の ceapi/performance-game/{playerId} を叩いて選手の全試合データを取得し、
// コーチID / シーズン / 大会で集計する。
//   ・「監督下の選手成績」(例: ヴィニ→アロンソ下のリーグ戦) のような複合クエリが可能
//   ・他チャンネルが扱えない切り口で差別化要素になる
//
// 使い方:
//   const { searchTransfermarktPlayer, fetchPlayerPerformanceGames, aggregateGames }
//     = require('./transfermarkt_player_games');
//   const hit = await searchTransfermarktPlayer('Kylian Mbappe');
//   const games = await fetchPlayerPerformanceGames(hit.id);
//   const stat = aggregateGames(games, { coachId: '63052', seasonId: 2025, competitionId: 'ES1' });
//
// 仕組み:
//   1. /schnellsuche?query=&Spieler_page=1 で名前 → ID/slug 解決
//   2. Puppeteer + Webshare 経由で /ceapi/performance-game/{id} を fetch
//      (cookie+session 必要なので axios 直叩きでは取れない)
//   3. data.performance[] の各試合を集計関数でフィルタ・合算

// 2026-05-12: Puppeteer から curl-cffi に移行。Webshare 帯域 1/3 に削減
const { curlGet, curlGetJson } = require('./_curl_cffi_caller');

const TM_REFERER = 'https://www.transfermarkt.com/';

// 名前 → 選手 ID/slug 解決
async function searchTransfermarktPlayer(name) {
  if (!name) return null;
  try {
    const url = `https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(name)}&Spieler_page=1`;
    const res = await curlGet(url, { referer: TM_REFERER, headers: { Accept: 'text/html' } });
    if (!res.ok || !res.body) return null;

    // HTML 内の /{slug}/profil/spieler/{id} リンク + 直前の表示名を抽出
    //   anchor の textContent も拾うため tag 構造を素朴に走査
    const html = res.body;
    const re = /<a[^>]+href="\/([\w\-]+)\/profil\/spieler\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
    const hits = [];
    let m;
    while ((m = re.exec(html))) {
      const linkText = m[3].replace(/<[^>]*>/g, '').trim();
      if (linkText) hits.push({ slug: m[1], id: parseInt(m[2], 10), name: linkText });
    }
    if (!hits.length) return null;

    const lc = String(name).toLowerCase();
    const exact = hits.find(h => h.name.toLowerCase() === lc);
    const start = hits.find(h => h.name.toLowerCase().startsWith(lc));
    const incl  = hits.find(h => h.name.toLowerCase().includes(lc));
    const pick  = exact || start || incl || hits[0];
    return { id: pick.id, slug: pick.slug, name: pick.name };
  } catch (e) {
    console.warn('[transfermarkt_player_games] search 例外:', e.message);
    return null;
  }
}

// /ceapi/performance-game/{playerId} を直接叩いて全試合 JSON を取得
//   返却: data.performance[] = 各試合 { gameInformation, clubsInformation, statistics }
async function fetchPlayerPerformanceGames(playerId) {
  if (!playerId) throw new Error('playerId required');
  try {
    const url = `https://www.transfermarkt.com/ceapi/performance-game/${playerId}`;
    const body = await curlGetJson(url, {
      referer: TM_REFERER,
      headers: { Accept: 'application/json, text/plain, */*' },
      timeout: 30,
    });
    if (!body?.success) {
      return { ok: false, error: 'API failed', status: 200, raw: body };
    }
    const performance = body.data?.performance || [];
    return { ok: true, playerId: String(playerId), performance };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status || 0 };
  }
}

// クラブ ID → 名前を tmapi-alpha 経由で解決（一括取得）
//   返却: { '27': 'Bayern Munich', '31': 'Liverpool', ... }
async function resolveClubNames(clubIds) {
  if (!Array.isArray(clubIds) || !clubIds.length) return {};
  const ids = [...new Set(clubIds.map(String).filter(Boolean))];
  try {
    const url = 'https://tmapi-alpha.transfermarkt.technology/clubs?' + ids.map(id => 'ids[]=' + id).join('&');
    const body = await curlGetJson(url, { referer: TM_REFERER });
    if (!body?.success) return {};
    const map = {};
    (body.data || []).forEach(c => {
      if (c.id) map[String(c.id)] = c.baseDetails?.shortName || c.name || '';
    });
    return map;
  } catch (_) {
    return {};
  }
}

// 試合配列を集計（フィルタ条件で絞り込んでから合算）
//   options: {
//     coachId?:        '63052' or [...]    (自チームのコーチIDで絞る)
//     seasonId?:       2025 or [2024,2025]  (シーズン ID = 開幕年)
//     competitionId?:  'ES1' or ['ES1','CL'] (大会コード)
//     clubId?:         '418'                (クラブIDで絞る = 移籍前後を分離)
//     onlyOfficial?:   true                 (officialフラグの数値を優先)
//   }
function aggregateGames(performance, options = {}) {
  if (!Array.isArray(performance)) return null;
  const { coachId, seasonId, competitionId, clubId, onlyOfficial = false } = options;
  const arr = (v) => v == null ? null : (Array.isArray(v) ? v.map(String) : [String(v)]);
  const fCoach = arr(coachId);
  const fSeason = arr(seasonId);
  const fComp = arr(competitionId);
  const fClub = arr(clubId);

  const filtered = performance.filter(g => {
    const gi = g.gameInformation || {};
    const ci = g.clubsInformation?.club || {};
    if (fCoach && !fCoach.includes(String(ci.coachId)))      return false;
    if (fSeason && !fSeason.includes(String(gi.seasonId)))   return false;
    if (fComp && !fComp.includes(String(gi.competitionId)))  return false;
    if (fClub && !fClub.includes(String(ci.clubId)))         return false;
    return true;
  });

  let appearances = 0, starts = 0, minutes = 0;
  let goals = 0, assists = 0;
  let yc = 0, yc2 = 0, rc = 0;
  const teamWins = { w: 0, d: 0, l: 0 };
  const seasonsSet = new Set(), compsSet = new Set(), clubsSet = new Set();

  for (const g of filtered) {
    const gi = g.gameInformation || {};
    const ci = g.clubsInformation?.club || {};
    const st = g.statistics || {};
    const gen = st.generalStatistics || {};
    const goal = st.goalStatistics || {};
    const card = st.cardStatistics || {};
    const time = st.playingTimeStatistics || {};

    seasonsSet.add(gi.seasonId);
    compsSet.add(gi.competitionId);
    clubsSet.add(ci.clubId);

    // 出場判定: 出場分数があれば出場
    const minutesPlayed = Number(time.playedMinutes) || 0;
    if (minutesPlayed > 0) {
      appearances++;
      minutes += minutesPlayed;
      if (gen.participationState === 'inFromStart' || gen.participationState === 'starter') starts++;
    }
    // ゴール・アシスト
    const gs = onlyOfficial ? goal.goalsScoredTotalOfficial : goal.goalsScoredTotal;
    if (gs != null) goals += Number(gs) || 0;
    const ag = onlyOfficial ? goal.assistsOfficial : goal.assists;
    if (ag != null) assists += Number(ag) || 0;
    // カード
    if (card.yellowCardNet) yc++;
    if (card.yellowCardGross && !card.yellowCardNet) yc2++;
    // チーム勝敗（自チーム視点で得失点を比較）
    const gf = Number(ci.goalsTotal);
    const ga = Number(ci.opponentGoalsTotal);
    if (Number.isFinite(gf) && Number.isFinite(ga)) {
      if (gf > ga) teamWins.w++;
      else if (gf === ga) teamWins.d++;
      else teamWins.l++;
    }
  }

  return {
    matchesCounted: filtered.length,
    appearances,
    starts,
    minutes,
    goals,
    assists,
    yellowCards: yc,
    secondYellow: yc2,
    redCards: rc,
    teamRecord: teamWins,         // 該当試合での自チーム W/D/L
    seasonsCovered: [...seasonsSet].filter(Boolean).sort(),
    competitionsCovered: [...compsSet].filter(Boolean).sort(),
    clubsCovered: [...clubsSet].filter(Boolean).sort(),
    filters: { coachId: fCoach, seasonId: fSeason, competitionId: fComp, clubId: fClub },
  };
}

// 🆕 代表試合を集計（isNationalGame=true でフィルタ）
//   返却: caps / goals / assists / avgGrade(Kicker式 1.0=神/6.0=最低) / firstCapDate / byCompetition / etc
//   Transfermarkt 1ファイルで「日本代表通算 試合・G・A・平均評価・初選出・大会別」全部取れる強力 API
function aggregateNationalGames(performance) {
  if (!Array.isArray(performance)) return null;
  const natl = performance.filter(g => g.gameInformation?.isNationalGame);
  if (!natl.length) {
    return { caps: 0, goals: 0, assists: 0, avgGrade: null, firstCapDate: null, lastCapDate: null, byCompetition: [], matchesCounted: 0 };
  }
  let caps = 0, starts = 0, minutes = 0;
  let goals = 0, assists = 0, yc = 0;
  let gradeSum = 0, gradedCount = 0;
  let firstDate = null, lastDate = null;
  const byCompMap = {};
  for (const g of natl) {
    const gi = g.gameInformation || {};
    const st = g.statistics || {};
    const gen = st.generalStatistics || {};
    const goal = st.goalStatistics || {};
    const time = st.playingTimeStatistics || {};
    const card = st.cardStatistics || {};
    const minutesPlayed = Number(time.playedMinutes) || 0;
    if (minutesPlayed > 0) {
      caps++;
      minutes += minutesPlayed;
      if (gen.participationState === 'inFromStart' || gen.participationState === 'starter') starts++;
    }
    const gs = goal.goalsScoredTotal;
    if (gs != null) goals += Number(gs) || 0;
    const ag = goal.assists;
    if (ag != null) assists += Number(ag) || 0;
    if (card.yellowCardNet) yc++;
    if (gen.grade != null) {
      const grade = Number(gen.grade);
      if (Number.isFinite(grade) && grade > 0) {
        gradeSum += grade;
        gradedCount++;
      }
    }
    const dStr = gi.date?.dateTimeUTC;
    if (dStr) {
      if (!firstDate || dStr < firstDate) firstDate = dStr;
      if (!lastDate  || dStr > lastDate)  lastDate  = dStr;
    }
    const comp = gi.competitionId || 'UNKNOWN';
    if (!byCompMap[comp]) byCompMap[comp] = { competition: comp, caps: 0, goals: 0, assists: 0 };
    if (minutesPlayed > 0) byCompMap[comp].caps++;
    if (gs != null) byCompMap[comp].goals += Number(gs) || 0;
    if (ag != null) byCompMap[comp].assists += Number(ag) || 0;
  }
  const avgGrade = gradedCount > 0 ? +(gradeSum / gradedCount).toFixed(2) : null;
  return {
    caps,
    starts,
    minutes,
    goals,
    assists,
    yellowCards: yc,
    avgGrade,
    avgGradeNote: 'Kicker式・1.0(神)〜6.0(最低)',
    firstCapDate: firstDate ? firstDate.slice(0, 10) : null,
    lastCapDate:  lastDate  ? lastDate.slice(0, 10)  : null,
    byCompetition: Object.values(byCompMap).sort((a, b) => b.caps - a.caps),
    matchesCounted: natl.length,
  };
}

// 監督下の成績を取得する高レベル API
//   coachIds で複数監督渡せば、同じ選手の監督別比較表を一発生成
async function fetchPlayerStatsUnderCoaches(playerId, coachIds, options = {}) {
  const data = await fetchPlayerPerformanceGames(playerId);
  if (!data.ok) return data;
  const ids = Array.isArray(coachIds) ? coachIds : [coachIds];
  const result = { ok: true, playerId, totalGames: data.performance.length, byCoach: {} };
  for (const cid of ids) {
    result.byCoach[cid] = aggregateGames(data.performance, { ...options, coachId: cid });
  }
  return result;
}

// step2 から呼ぶ用の "default" サマリー: 直近3シーズン × クラブ × 大会別 + 通算 + 監督別 top3 + 直近 N 試合
//   AI プロンプトに渡すには JSON 全部は大きすぎるので、要点だけ集計して保存
async function fetchPlayerSummary(playerId, opts = {}) {
  const data = await fetchPlayerPerformanceGames(playerId);
  if (!data.ok) return data;
  const perf = data.performance || [];

  // シーズン降順 (新しい順) でユニーク化
  const seasons = [...new Set(perf.map(g => g.gameInformation?.seasonId).filter(Boolean))].sort((a, b) => b - a);
  const recent3 = seasons.slice(0, 3);

  // 直近3シーズン × 大会別の小集計
  const recentByCompetition = [];
  for (const s of recent3) {
    const seasonGames = perf.filter(g => g.gameInformation?.seasonId === s);
    const comps = [...new Set(seasonGames.map(g => g.gameInformation?.competitionId).filter(Boolean))];
    for (const c of comps) {
      const agg = aggregateGames(perf, { seasonId: s, competitionId: c });
      if (agg.appearances > 0 || agg.matchesCounted > 0) {
        recentByCompetition.push({
          season: s, competition: c,
          ...agg,
        });
      }
    }
  }

  // 直近シーズンの監督別 top3（出場試合数で上位）
  const latestSeason = seasons[0];
  const latestGames = perf.filter(g => g.gameInformation?.seasonId === latestSeason);
  const coachCount = {};
  for (const g of latestGames) {
    const cid = g.clubsInformation?.club?.coachId;
    if (cid) coachCount[cid] = (coachCount[cid] || 0) + 1;
  }
  const topCoaches = Object.entries(coachCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cid]) => cid);

  const byCoachLatest = topCoaches.map(cid => ({
    coachId: cid,
    season: latestSeason,
    ...aggregateGames(perf, { coachId: cid, seasonId: latestSeason }),
  }));

  // 通算（全試合）
  const career = aggregateGames(perf);

  // 🆕 直近 N 試合の生データ（試合スコア・対戦相手・ゴール・アシスト・出場分）
  //   history スライドで「直近 N 試合の対戦相手+スコア+G+A」を時系列で見せる用途
  //   日付降順で N 件、対戦相手 club ID は全件解決して name にマッピング
  const recentLimit = opts.recentLimit || 30;
  const sortedByDate = perf
    .filter(g => g.gameInformation?.date?.dateTimeUTC)
    .sort((a, b) => new Date(b.gameInformation.date.dateTimeUTC) - new Date(a.gameInformation.date.dateTimeUTC));
  const recentSlice = sortedByDate.slice(0, recentLimit);

  // 対戦相手と自チームの club ID を集めて一括解決
  const allClubIds = new Set();
  recentSlice.forEach(g => {
    const ci = g.clubsInformation || {};
    if (ci.opponent?.clubId) allClubIds.add(String(ci.opponent.clubId));
    if (ci.club?.clubId) allClubIds.add(String(ci.club.clubId));
  });
  const clubNameMap = await resolveClubNames([...allClubIds]);

  const recentGames = recentSlice.map(g => {
    const gi = g.gameInformation || {};
    const ci = g.clubsInformation || {};
    const st = g.statistics || {};
    return {
      date: (gi.date?.dateTimeUTC || '').slice(0, 10),
      season: gi.seasonId,
      competition: gi.competitionId,
      gameDay: gi.gameDay,
      venue: ci.club?.venue,                                           // home / away
      myClubId: String(ci.club?.clubId || ''),
      myClub: clubNameMap[String(ci.club?.clubId)] || '',
      coachId: String(ci.club?.coachId || ''),
      opponentClubId: String(ci.opponent?.clubId || ''),
      opponent: clubNameMap[String(ci.opponent?.clubId)] || '',
      opponentCoachId: String(ci.opponent?.coachId || ''),
      goalsFor: ci.club?.goalsTotal,
      goalsAgainst: ci.club?.opponentGoalsTotal,
      score: `${ci.club?.goalsTotal ?? '?'}-${ci.club?.opponentGoalsTotal ?? '?'}`,
      G: st.goalStatistics?.goalsScoredTotal,
      A: st.goalStatistics?.assists,
      minutes: st.playingTimeStatistics?.playedMinutes,
      isCaptain: st.generalStatistics?.isCaptain || false,
      yellowCard: st.cardStatistics?.yellowCardNet || 0,
    };
  });

  // 🆕 代表通算（isNationalGame=true でフィルタ）
  const national = aggregateNationalGames(perf);

  return {
    ok: true,
    playerId: String(playerId),
    totalGames: perf.length,
    seasonsCovered: seasons,
    career,
    recentByCompetition,    // 直近3シーズン x 大会別
    byCoachLatest,          // 直近シーズンの監督別 top3
    recentGames,            // 🆕 直近 N 試合の生データ（スコア+対戦相手+G+A、対戦相手名解決済）
    national,               // 🆕 代表通算（caps/G/A/avgGrade/firstCapDate/byCompetition）
  };
}

module.exports = {
  searchTransfermarktPlayer,
  fetchPlayerPerformanceGames,
  aggregateGames,
  aggregateNationalGames,
  fetchPlayerStatsUnderCoaches,
  fetchPlayerSummary,
  resolveClubNames,
};
