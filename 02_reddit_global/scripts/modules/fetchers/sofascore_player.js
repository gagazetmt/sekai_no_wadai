// scripts/modules/fetchers/sofascore_player.js
// SofaScore 非公式API で選手スタッツを取得
//  ① /search/all/         → playerId
//  ② /player/{id}         → 基本情報・市場価値・契約
//  ③ /player/{id}/events/last/0 → 直近5試合 + 今試合スタッツ
//  ④ /player/{id}/statistics    → 全シーズンスタッツ（→ 今季 + シーズン履歴）
//  ⑤ /player/{id}/national-team-statistics → 代表チーム成績
//  ⑥ /player/{id}/transfer-history          → 移籍履歴

const { apiGet } = require('./_sofa_common');
const { callAI } = require('../../ai_client');
const fs   = require('fs');
const path = require('path');

// ─── 選手名インデックス（build_player_name_index.js で生成）─────
const _INDEX_PATH = path.join(__dirname, '..', '..', '..', 'data', 'player_name_index.json');
let _nameIndex = null;
function _loadIndex() {
  if (_nameIndex) return _nameIndex;
  try {
    const raw = JSON.parse(fs.readFileSync(_INDEX_PATH, 'utf8'));
    _nameIndex = raw.players || {};
  } catch (_) {
    _nameIndex = {};
  }
  return _nameIndex;
}

function _normKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// インデックスから sofaId を引く
//   優先順: ①フルネーム完全一致 → ②姓のみ一意一致 → ③部分一致
function lookupPlayerIndex(name) {
  const idx = _loadIndex();
  if (!Object.keys(idx).length) return null;
  const key = _normKey(name);

  // ① フルネーム完全一致
  if (idx[key]) return idx[key];

  const parts = key.split(' ').filter(p => p.length >= 3);

  // ② 姓（最後の単語）がインデックスキーとして一意に存在する場合
  //    "Andrew Robertson" → "robertson" → Andy Robertson（表記ゆれ吸収）
  //    複数選手が同じ姓なら曖昧なのでスキップ
  const lastName = parts[parts.length - 1];
  if (lastName && idx[lastName]) return idx[lastName];

  // ③ 各単語を個別キーとして検索（"Vinicius Junior" → "vinicius" がヒット等）
  for (const part of parts) {
    if (part && idx[part]) return idx[part];
  }

  // ④ エントリの実名に全単語が含まれる（表記に差異がある場合の最終手段）
  if (parts.length >= 2) {
    const hit = Object.values(idx).find(entry => {
      const entryKey = _normKey(entry.name);
      return parts.every(p => entryKey.includes(p));
    });
    if (hit) return hit;
  }
  return null;
}

// 日本語文字が含まれるか
function hasJapanese(str) {
  return /[　-鿿＀-￯]/.test(str);
}

// 日本語名 → 英語名を Claude haiku で翻訳
async function translateToEnglish(jaName) {
  try {
    const raw = await callAI({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages:   [{ role: 'user', content: `Soccer player name in Japanese: "${jaName}". Return only the official English name (e.g. "Kaoru Mitoma"). No explanation.` }],
    });
    return raw.trim().replace(/^["']|["']$/g, '');
  } catch { return null; }
}

async function buildSearchCandidates(name) {
  const candidates = [name];
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1) candidates.push(parts[parts.length - 1]);
  if (hasJapanese(name)) {
    const en = await translateToEnglish(name);
    if (en && !candidates.includes(en)) candidates.unshift(en);
  }
  return [...new Set(candidates)];
}

// 検索のみ: playerエンティティ（ID・name等）を返す
// 複数ヒット時は市場価値順で優先（同名の低リーグ選手・フリーエージェントを自然に弾く）
async function searchPlayer(name) {
  const candidates = await buildSearchCandidates(name);
  for (const q of candidates) {
    try {
      const data = await apiGet(`/search/all/?q=${encodeURIComponent(q)}`);
      const players = (data.results || []).filter(r =>
        r.type === 'player' && (r.entity?.sport?.id === 1 || !r.entity?.sport)
      );
      if (!players.length) continue;

      // 1件のみ → そのまま返す
      if (players.length === 1) {
        console.log(`[SofaScore Player] "${q}" → ${players[0].entity.name}`);
        return players[0].entity;
      }

      // 複数ヒット → 上位3件の市場価値を並列取得して最大値の選手を選ぶ
      const top3 = players.slice(0, 3);
      const details = await Promise.allSettled(
        top3.map(p => apiGet(`/player/${p.entity.id}`))
      );
      let best = players[0].entity;
      let bestMV = -1;
      details.forEach((r, i) => {
        const mv = r.status === 'fulfilled'
          ? (r.value?.player?.proposedMarketValue || 0)
          : 0;
        if (mv > bestMV) { bestMV = mv; best = players[i].entity; }
      });
      const mvStr = bestMV > 0 ? ` mv:€${(bestMV / 1e6).toFixed(0)}M` : ' mv:不明';
      console.log(`[SofaScore Player] "${q}" → ${best.name}${mvStr} (${players.length}件中1位)`);
      return best;
    } catch (_) {}
  }
  return null;
}

// ポジション別スタッツ抽出
function buildPositionStats(position, st) {
  if (!st) return null;
  const pos = (position || '').toUpperCase();
  if (pos === 'G') return {
    saves:          st.saves ?? null,
    cleanSheets:    st.cleanSheet ?? null,
    goalsConceded:  st.goalsConceded ?? null,
    savedFromBox:   st.savedShotsFromInsideTheBox ?? null,
    goalsPrevented: st.goalsPrevented ?? null,
  };
  if (pos === 'D') return {
    tackles:        st.tackles ?? null,
    interceptions:  st.interceptions ?? null,
    clearances:     st.clearances ?? null,
    duelsWon:       st.duelsWon ?? null,
    aerialDuelsWon: st.aerialDuelsWon ?? null,
    blockedShots:   st.blockedShots ?? null,
  };
  if (pos === 'M') return {
    keyPasses:          st.keyPasses ?? null,
    successfulDribbles: st.successfulDribbles ?? null,
    bigChancesCreated:  st.bigChancesCreated ?? null,
    tackles:            st.tackles ?? null,
    interceptions:      st.interceptions ?? null,
    accuratePassesPct:  st.accuratePassesPercentage ?? null,
  };
  return {
    shotsOnTarget:      st.shotsOnTarget ?? null,
    bigChancesMissed:   st.bigChancesMissed ?? null,
    bigChancesCreated:  st.bigChancesCreated ?? null,
    successfulDribbles: st.successfulDribbles ?? null,
    expectedGoals:      st.expectedGoals ? parseFloat(Number(st.expectedGoals).toFixed(2)) : null,
  };
}

// 1試合の選手スタッツを扱いやすい形に整形
function formatMatchStats(e, playerId) {
  const isHome   = e.homeTeam?.id && e.awayTeam?.id
    ? (e.playerStatistics?.team === 'home' || (e.homeTeam?.players || []).some(p => p.player?.id === playerId))
    : null;
  const homeScore = e.homeScore?.display ?? e.homeScore?.normaltime ?? null;
  const awayScore = e.awayScore?.display ?? e.awayScore?.normaltime ?? null;
  const myScore   = isHome === true ? homeScore : (isHome === false ? awayScore : null);
  const oppScore  = isHome === true ? awayScore : (isHome === false ? homeScore : null);
  const opp       = isHome === true ? e.awayTeam?.name : (isHome === false ? e.homeTeam?.name : (e.awayTeam?.name || e.homeTeam?.name));
  const st = e.playerStatistics || {};

  return {
    date:          e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().slice(0, 10) : null,
    tournament:    e.tournament?.name || null,
    opponent:      opp || null,
    score:         (myScore != null && oppScore != null) ? `${myScore}-${oppScore}` : `${homeScore ?? '?'}-${awayScore ?? '?'}`,
    rating:        st.rating != null ? parseFloat(Number(st.rating).toFixed(2)) : null,
    goals:         st.goals ?? null,
    assists:       st.goalAssist ?? null,
    minutesPlayed: st.minutesPlayed ?? null,
    shots:         st.totalShots ?? null,
    shotsOnTarget: st.onTargetScoringAttempt ?? null,
    keyPasses:     st.keyPass ?? null,
    passes:        st.totalPass ?? null,
    accuratePassesPct: st.totalPass ? Math.round((st.accuratePass ?? 0) / st.totalPass * 100) : null,
    dribbles:      st.totalContest ?? null,
    dribblesWon:   st.wonContest ?? null,
    touches:       st.touches ?? null,
    expectedGoals: st.expectedGoals ? parseFloat(Number(st.expectedGoals).toFixed(2)) : null,
  };
}

async function fetchSofaScorePlayer(playerNameEn) {
  if (!playerNameEn) return { ok: false, error: '選手名が未指定' };

  try {
    // ① インデックス照合（IDが確定すれば /search/all をスキップ）
    let playerId = null;
    let player   = null;
    const cached = lookupPlayerIndex(playerNameEn);
    if (cached?.sofaId) {
      playerId = cached.sofaId;
      player   = { id: playerId, name: cached.name };
      console.log(`[SofaScore Player] "${playerNameEn}" → index hit: ${cached.name} (id=${playerId})`);
    } else {
      // インデックスにない場合のみ従来の /search/all を使う
      player = await searchPlayer(playerNameEn);
      if (!player) return { ok: false, error: `SofaScore に "${playerNameEn}" が見つかりません` };
      playerId = player.id;
    }

    // ②③④⑤⑥ 並列取得（detail / events / statistics / nat / transfer）─────
    const [pdRaw, evRaw, statsRaw, natRaw, trnRaw] = await Promise.all([
      apiGet(`/player/${playerId}`).catch(e => ({ __err: e })),
      apiGet(`/player/${playerId}/events/last/0`).catch(e => ({ __err: e })),
      apiGet(`/player/${playerId}/statistics`).catch(e => ({ __err: e })),
      apiGet(`/player/${playerId}/national-team-statistics`).catch(e => ({ __err: e })),
      apiGet(`/player/${playerId}/transfer-history`).catch(e => ({ __err: e })),
    ]);

    // ② 詳細情報（市場価値・契約）
    // api.sofascore.com が 403 の場合は www.sofascore.com/player/{slug}/{id} の
    // __NEXT_DATA__ からフォールバック取得（Webshare IP ブロック対策）
    let playerDetail = pdRaw?.__err ? {} : (pdRaw.player || {});
    if (pdRaw?.__err || (!playerDetail.team && !playerDetail.proposedMarketValue)) {
      try {
        const { fetchPlayerPage } = require('./_sofa_via_puppeteer');
        const pageProps = await fetchPlayerPage(playerId, player.name || playerNameEn);
        const pp = pageProps?.player;
        if (pp) {
          playerDetail = {
            name: pp.name,
            position: pp.position,
            team: pp.team,
            country: pp.country,
            dateOfBirthTimestamp: pp.dateOfBirthTimestamp,
            proposedMarketValue: pp.proposedMarketValueRaw?.value || null,
            proposedMarketValueRaw: pp.proposedMarketValueRaw,
          };
          console.log(`[SofaScore Player] ${playerNameEn} → page fallback 成功: ${pp.name} (${pp.team?.name})`);
        }
      } catch (_) {}
    }
    const marketValue = playerDetail.proposedMarketValue || null;
    const contractUntil = playerDetail.contractUntilTimestamp
      ? new Date(playerDetail.contractUntilTimestamp * 1000).toISOString().slice(0, 7)
      : null;
    const marketValueStr = marketValue
      ? (marketValue >= 1_000_000
          ? `€${(marketValue / 1_000_000).toFixed(0)}M`
          : `€${(marketValue / 1_000).toFixed(0)}K`)
      : null;

    // ③ 直近試合（2026-04 API変更対応）
    // events/last/0 は playerStatistics を含まなくなったため、
    // 各試合の per-event statistics エンドポイントを別途叩いて補完する
    let last5Matches = [];
    let lastMatchStats = null;
    let recentAvgRating = null;
    if (!evRaw?.__err) {
      const events = (evRaw.events || []);
      // events は chronological（末尾が最新）。直近5件を新→旧で取得
      const recent5 = events.slice(-5).reverse();
      const psResults = await Promise.all(
        recent5.map(e =>
          apiGet(`/event/${e.id}/player/${playerId}/statistics`).catch(() => null)
        )
      );
      last5Matches = recent5
        .map((e, i) => {
          const ps = psResults[i]?.statistics;
          if (!ps) return null;
          return formatMatchStats({ ...e, playerStatistics: ps }, playerId);
        })
        .filter(Boolean);
      lastMatchStats = last5Matches[0] || null;
      const ratings = last5Matches
        .map(m => m.rating)
        .filter(r => r != null && r > 0);
      recentAvgRating = ratings.length
        ? parseFloat((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2))
        : null;
    }

    // ④ シーズン統計（全シーズン → 最新年の国内リーグ優先）
    let seasonStats = null;
    let leagueName  = null;
    let seasonYear  = null;
    let uclStats    = null;
    if (!statsRaw?.__err) {
      const statsData   = statsRaw;
      const allSeasons  = statsData.seasons || [];
      // 出場0のシーズン（次季の空エントリ等）を除外した上で最新年を探す
      const meaningfulSeasons = allSeasons.filter(s => (s.statistics?.appearances || 0) > 0);
      const latestYear  = meaningfulSeasons[0]?.year;
      const currentList = latestYear
        ? meaningfulSeasons.filter(s => s.year === latestYear)
        : meaningfulSeasons;
      const DOMESTIC = [17, 8, 23, 35, 34, 37, 44]; // PL, LaLiga, SerieA, Bundesliga, Ligue1, Eredivisie, Süper Lig
      const UCL      = [7];
      let preferred = null;
      for (const tid of [...DOMESTIC, ...UCL]) {
        preferred = currentList.find(s => s.uniqueTournament?.id === tid);
        if (preferred) break;
      }
      preferred = preferred || currentList[0] || meaningfulSeasons[0];
      const uclEntry = currentList.find(s => UCL.includes(s.uniqueTournament?.id));
      uclStats = (uclEntry && uclEntry.uniqueTournament?.id !== preferred?.uniqueTournament?.id)
        ? {
            leagueName:  uclEntry.uniqueTournament?.name,
            appearances: uclEntry.statistics?.appearances,
            goals:       uclEntry.statistics?.goals,
            assists:     uclEntry.statistics?.assists,
            rating:      uclEntry.statistics?.rating ? parseFloat(Number(uclEntry.statistics.rating).toFixed(2)) : null,
          }
        : null;
      if (preferred) {
        leagueName  = preferred.uniqueTournament?.name;
        seasonYear  = preferred.year;
        seasonStats = preferred.statistics || null;
      }
    }

    // ④' シーズン履歴: 全シーズン × 大会（出場0は除外、新→旧でソート）────
    let seasonHistory = [];
    if (!statsRaw?.__err) {
      const allSeasons = statsRaw.seasons || [];
      seasonHistory = allSeasons
        .filter(s => (s.statistics?.appearances || 0) > 0 && s.uniqueTournament?.name)
        .map(s => {
          // seasonStats と同じ全フィールドを取得（省略なし）
          const st = s.statistics || {};
          const _f  = (v) => v != null ? Number(v) : null;
          const _pf = (v, d = 2) => v != null ? parseFloat(Number(v).toFixed(d)) : null;
          const stats = {
            appearances:        _f(st.appearances),
            goals:              _f(st.goals),
            assists:            _f(st.assists),
            rating:             _pf(st.rating),
            minutesPlayed:      _f(st.minutesPlayed),
            expectedGoals:      _pf(st.expectedGoals),
            keyPasses:          _f(st.keyPasses),
            bigChancesCreated:  _f(st.bigChancesCreated),
            successfulDribbles: _f(st.successfulDribbles),
            totalShots:         _f(st.totalShots),
            shotsOnTarget:      _f(st.shotsOnTarget),
            yellowCards:        _f(st.yellowCards),
            redCards:           _f(st.redCards),
            cleanSheets:        _f(st.cleanSheet),
            saves:              _f(st.saves),
            // 今季スタッツと同じ項目を追加
            tackles:            _f(st.tackles),
            interceptions:      _f(st.interceptions),
            aerialDuelsWon:     _f(st.aerialDuelsWon),
            aerialDuelsTotal:   _f(st.aerialDuels),
            totalDuelsWon:      _f(st.totalDuelsWon),
            groundDuelsWon:     _f(st.groundDuelsWon),
            accuratePasses:     _f(st.accuratePasses),
            totalPasses:        _f(st.totalPasses),
            accurateLongBalls:  _f(st.accurateLongBalls),
            chancesCreated:     _f(st.chancesCreated ?? st.bigChancesCreated),
            goalConversion:     _pf(st.goalConversionPercentage, 1),
            cleanSheetPercentage: _pf(st.cleanSheetPercentage, 1),
          };
          return {
            seasonName:     s.season?.year || s.year,
            seasonId:       s.season?.id,
            tournamentName: s.uniqueTournament?.name,
            tournamentId:   s.uniqueTournament?.id,
            teamName:       s.team?.name,
            teamId:         s.team?.id,
            stats,
          };
        })
        .sort((a, b) => {
          // 新しい順（year は "24/25" や 2024 形式）
          const ay = String(a.seasonName || '').slice(0, 4);
          const by = String(b.seasonName || '').slice(0, 4);
          return by.localeCompare(ay);
        });
    }

    // ⑤ 代表チーム成績 ────────────────────────────────────
    let nationalTeam = null;
    if (!natRaw?.__err) {
      const stats = Array.isArray(natRaw.statistics) ? natRaw.statistics : [];
      // 通算（appearances 多い順で代表エントリ）
      const total = stats.reduce((a, s) => ({
        appearances:    (a.appearances || 0) + (s.appearances || 0),
        goals:          (a.goals       || 0) + (s.goals       || 0),
        assists:        (a.assists     || 0) + (s.assists     || 0),
      }), { appearances: 0, goals: 0, assists: 0 });
      nationalTeam = {
        teamName: natRaw.team?.name || stats[0]?.team?.name || null,
        // 大会別エントリ（W杯/AFCONなど）
        tournaments: stats.map(s => ({
          tournamentName: s.tournament?.name || s.uniqueTournament?.name || null,
          appearances:    s.appearances ?? null,
          goals:          s.goals ?? null,
          assists:        s.assists ?? null,
        })),
        // 通算
        total,
      };
    }

    // ⑥ 移籍履歴 ─────────────────────────────────────────
    let transferHistory = [];
    if (!trnRaw?.__err) {
      const arr = Array.isArray(trnRaw.transferHistory) ? trnRaw.transferHistory : [];
      transferHistory = arr.map(t => ({
        from:        t.transferFrom?.name || null,
        to:          t.transferTo?.name || null,
        type:        t.type,             // 1: full, 2: loan, ...
        fee:         t.transferFee || null,    // {value, currency}
        feeStr:      t.transferFeeDescription || null,  // "€80M" など
        date:        t.transferDateTimestamp
          ? new Date(t.transferDateTimestamp * 1000).toISOString().slice(0, 10)
          : null,
      })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }

    const position      = playerDetail.position || player.position || '';
    const positionStats = buildPositionStats(position, seasonStats);

    return {
      ok:            true,
      playerId,
      name:          player.name,
      position,
      team:          player.team?.name || playerDetail.team?.name,
      nationality:   player.country?.name || playerDetail.country?.name,
      dateOfBirth:   playerDetail.dateOfBirth,
      age:           playerDetail.dateOfBirthTimestamp
        ? Math.floor((Date.now() - playerDetail.dateOfBirthTimestamp * 1000) / (365.25 * 24 * 3600 * 1000))
        : null,
      height:        playerDetail.height,
      weight:        playerDetail.weight || null,
      shirtNumber:   playerDetail.jerseyNumber ?? playerDetail.shirtNumber ?? null,
      preferredFoot: playerDetail.preferredFoot,
      marketValue:   marketValueStr,
      contractUntil,
      leagueName,
      seasonYear,
      seasonStats: seasonStats ? {
        appearances:        seasonStats.appearances,
        goals:              seasonStats.goals,
        assists:            seasonStats.assists,
        rating:             seasonStats.rating ? parseFloat(Number(seasonStats.rating).toFixed(2)) : null,
        minutesPlayed:      seasonStats.minutesPlayed,
        yellowCards:        seasonStats.yellowCards,
        redCards:           seasonStats.redCards,
        expectedGoals:      seasonStats.expectedGoals ? parseFloat(Number(seasonStats.expectedGoals).toFixed(2)) : null,
        keyPasses:          seasonStats.keyPasses,
        bigChancesCreated:  seasonStats.bigChancesCreated ?? null,
        bigChancesMissed:   seasonStats.bigChancesMissed ?? null,
        successfulDribbles: seasonStats.successfulDribbles ?? null,
        totalShots:         seasonStats.totalShots ?? seasonStats.shotsOnTarget ?? null,
        shotsOnTarget:      seasonStats.shotsOnTarget ?? null,
        accuratePassesPct:  seasonStats.accuratePassesPercentage ?? null,
        tackles:            seasonStats.tackles ?? null,
        interceptions:      seasonStats.interceptions ?? null,
        cleanSheets:        seasonStats.cleanSheet ?? null,
        saves:              seasonStats.saves ?? null,
      } : null,
      positionStats,
      uclStats,
      recentAvgRating,
      last5Matches,
      lastMatchStats,
      seasonHistory,
      nationalTeam,
      transferHistory,
    };
  } catch (e) {
    if (e.response?.status === 403) {
      return { ok: false, error: 'SofaScore: IPブロック(403)。プロキシ設定が必要です' };
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScorePlayer, searchPlayer };
