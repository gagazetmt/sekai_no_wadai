// scripts/build_player_name_index.js
// SofaScore の主要5リーグ全チームのロスターから
// 選手名インデックスを一括構築する（一回実行すればほぼ永続利用可能）
//
// 出力: data/player_name_index.json
//   {
//     "vinicius junior": { sofaId: 350002, name: "Vinicius Junior", team: "Real Madrid", league: "La Liga" },
//     "vinicius":        { sofaId: 350002, ... },
//     "junior":          { sofaId: 350002, ... },
//     ...
//   }
//
// 使い方:
//   node scripts/build_player_name_index.js
//   → 完了後 data/player_name_index.json が生成される

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs   = require('fs');
const path = require('path');
const { apiGet } = require('./modules/fetchers/_sofa_common');

const OUT_FILE = path.join(__dirname, '..', 'data', 'player_name_index.json');

// 主要リーグ: [uniqueTournamentId, 名前]
const LEAGUES = [
  [17, 'Premier League'],
  [8,  'La Liga'],
  [23, 'Serie A'],
  [35, 'Bundesliga'],
  [34, 'Ligue 1'],
];

// W杯2026出場国（48カ国）— SofaScore のチーム名で検索
const WC_TEAMS = [
  // UEFA (16)
  'Germany', 'France', 'Spain', 'England', 'Portugal', 'Netherlands',
  'Belgium', 'Italy', 'Croatia', 'Denmark', 'Austria', 'Switzerland',
  'Poland', 'Serbia', 'Turkey', 'Scotland',
  // CONMEBOL (6)
  'Brazil', 'Argentina', 'Uruguay', 'Colombia', 'Ecuador', 'Venezuela',
  // CONCACAF (6)
  'United States', 'Mexico', 'Canada', 'Panama', 'Costa Rica', 'Honduras',
  // CAF (9)
  'Morocco', 'Senegal', 'Egypt', 'Nigeria', 'Ivory Coast', 'South Africa',
  'Algeria', 'Cameroon', 'Mali',
  // AFC (8)
  'Japan', 'South Korea', 'Iran', 'Saudi Arabia', 'Australia',
  'Uzbekistan', 'Iraq', 'Jordan',
  // OFC (1)
  'New Zealand',
  // 大陸間PO 2枠（暫定）
  'Ukraine', 'Slovakia',
];

// 文字列正規化（ルックアップキー用）
// アクセント除去 + 小文字 + 余分スペース除去
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // diacritics除去（é→e, ñ→n など）
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 現在のシーズンIDをリーグIDから取得
async function getCurrentSeasonId(tournamentId) {
  try {
    const data = await apiGet(`/unique-tournament/${tournamentId}/seasons`);
    const seasons = data?.seasons || [];
    // 最新シーズン（先頭）
    return seasons[0]?.id || null;
  } catch (e) {
    console.warn(`  [warn] season取得失敗 tournament=${tournamentId}: ${e.message}`);
    return null;
  }
}

// リーグの全チームIDを順位表から取得
async function getTeamIds(tournamentId, seasonId) {
  try {
    const data = await apiGet(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`);
    const rows = data?.standings?.[0]?.rows || [];
    return rows.map(r => ({ id: r.team?.id, name: r.team?.name })).filter(t => t.id);
  } catch (e) {
    console.warn(`  [warn] standings取得失敗: ${e.message}`);
    return [];
  }
}

// チームのロスターを取得
async function getSquad(teamId) {
  try {
    const data = await apiGet(`/team/${teamId}/players`);
    return data?.players || [];
  } catch (e) {
    return [];
  }
}

// 1エントリを lookup テーブルに登録（複数キーで）
function registerPlayer(lookup, player, teamName, leagueName) {
  const sofaId  = player.player?.id   || player.id;
  const rawName = player.player?.name || player.name;
  if (!sofaId || !rawName) return;

  const entry = { sofaId, name: rawName, team: teamName, league: leagueName };

  // フルネーム（正規化済み）
  const fullKey = norm(rawName);
  if (fullKey.length >= 3) lookup[fullKey] = entry;

  // 各単語（3文字以上のもの）
  const parts = fullKey.split(' ').filter(p => p.length >= 3);
  for (const part of parts) {
    // すでに別の選手でより優先度高い登録があれば上書きしない
    if (!lookup[part]) lookup[part] = entry;
  }

  // 姓のみ（最後の単語）
  const lastName = parts[parts.length - 1];
  if (lastName && lastName.length >= 3 && !lookup[lastName]) {
    lookup[lastName] = entry;
  }

  // 名のみ（最初の単語、4文字以上のみ）
  const firstName = parts[0];
  if (firstName && firstName.length >= 4 && !lookup[firstName]) {
    lookup[firstName] = entry;
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== SofaScore 選手名インデックス ビルド開始 ===\n');
  const lookup = {};
  let totalPlayers = 0;

  for (const [tournamentId, leagueName] of LEAGUES) {
    console.log(`\n[${leagueName}]`);

    const seasonId = await getCurrentSeasonId(tournamentId);
    if (!seasonId) { console.log('  → シーズンID取得失敗、スキップ'); continue; }
    console.log(`  season=${seasonId}`);
    await sleep(300);

    const teams = await getTeamIds(tournamentId, seasonId);
    console.log(`  チーム数: ${teams.length}`);
    await sleep(300);

    for (const team of teams) {
      process.stdout.write(`  ${team.name} ... `);
      const squad = await getSquad(team.id);
      squad.forEach(p => registerPlayer(lookup, p, team.name, leagueName));
      console.log(`${squad.length}人`);
      totalPlayers += squad.length;
      await sleep(200); // API レート制限対策
    }
  }

  // ── W杯出場国の代表ロスター ─────────────────────────────
  console.log('\n[W杯2026出場国 代表ロスター]');
  for (const countryName of WC_TEAMS) {
    process.stdout.write(`  ${countryName} ... `);
    try {
      // SofaScore で代表チームを検索
      const searchData = await apiGet(`/search/all/?q=${encodeURIComponent(countryName + ' national')}`);
      const teams = (searchData.results || []).filter(r =>
        r.type === 'team' &&
        r.entity?.sport?.id === 1 &&
        r.entity?.type === 'national'
      );
      const team = teams[0]?.entity || null;
      if (!team?.id) {
        // national フィルタなしで再試行
        const teams2 = (searchData.results || []).filter(r =>
          r.type === 'team' && r.entity?.sport?.id === 1
        );
        const t2 = teams2.find(r => {
          const n = (r.entity?.name || '').toLowerCase();
          return n.includes(countryName.toLowerCase()) || countryName.toLowerCase().includes(n.split(' ')[0]);
        });
        if (!t2?.entity?.id) { console.log('チーム見つからず、スキップ'); await sleep(200); continue; }
        const squad2 = await getSquad(t2.entity.id);
        squad2.forEach(p => registerPlayer(lookup, p, countryName, 'International'));
        console.log(`${squad2.length}人 (${t2.entity.name})`);
        totalPlayers += squad2.length;
      } else {
        const squad = await getSquad(team.id);
        squad.forEach(p => registerPlayer(lookup, p, countryName, 'International'));
        console.log(`${squad.length}人`);
        totalPlayers += squad.length;
      }
    } catch (e) {
      console.log(`エラー: ${e.message}`);
    }
    await sleep(250);
  }

  const result = {
    _meta: {
      builtAt:      new Date().toISOString(),
      totalEntries: Object.keys(lookup).length,
      totalPlayers,
      leagues:      [...LEAGUES.map(([, n]) => n), 'W杯2026出場国'],
    },
    players: lookup,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  console.log(`\n=== 完了 ===`);
  console.log(`選手数:      ${totalPlayers}`);
  console.log(`ルックアップキー数: ${Object.keys(lookup).length}`);
  console.log(`出力先:      ${OUT_FILE}`);
}

main().catch(e => {
  console.error('ビルド失敗:', e.message);
  process.exit(1);
});
