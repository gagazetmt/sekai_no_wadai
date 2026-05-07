// scripts/fetch_sofa_logos.js
// SofaScore からクラブロゴを統一フォーマット (PNG) で一括取得
//   全リーグで同じ仕組み・同じ品質・同じサイズに揃える（リーグ別に CDN/形式がバラバラだった
//   問題を解消する）
//
// 使い方:
//   node fetch_sofa_logos.js premier-league
//   node fetch_sofa_logos.js ligue-1
//   node fetch_sofa_logos.js all   # 全リーグ
//
// 仕組み:
//   1. クラブマスタ（_pl_clubs.js / _seriea_clubs.js 等）から club name を取得
//   2. SofaScore search で team ID を解決（既存 _sofa_common.apiGet 経由）
//   3. apiGetImage('/team/{id}/image') でロゴ取得（curl-cffi + Webshare 経由）
//   4. images_stock/club_logos/{leagueSlug}/{clubKey}.png に保存
//   5. data/club_logos_index.json を更新（既存 PL/LaLiga エントリと共存）

const fs   = require('fs');
const path = require('path');
const { apiGet, apiGetImage } = require('./modules/fetchers/_sofa_common');

const ROOT       = path.join(__dirname, '..');
const STOCK_BASE = path.join(ROOT, 'images_stock', 'club_logos');
const INDEX_FILE = path.join(ROOT, 'data', 'club_logos_index.json');

// リーグマスタ + SofaScore unique-tournament ID（standings 経由で team_id 一覧取得用）
//   /search/all がブロックされてるため、tournament 公式エンドポイントから team_id 解決
const LEAGUES = {
  'premier-league':  { name: 'Premier League',          tournId: 17,  clubs: require('./_pl_clubs').PL_CLUBS },
  'la-liga':         { name: 'LaLiga',                  tournId: 8,   clubs: require('./_laliga_clubs').LALIGA_CLUBS },
  'bundesliga':      { name: 'Bundesliga',              tournId: 35,  clubs: require('./_bundesliga_clubs').BUNDESLIGA_CLUBS },
  'serie-a':         { name: 'Serie A',                 tournId: 23,  clubs: require('./_seriea_clubs').SERIEA_CLUBS },
  'ligue-1':         { name: 'Ligue 1',                 tournId: 34,  clubs: require('./_ligue1_clubs').LIGUE1_CLUBS },
  'eredivisie':      { name: 'Eredivisie',              tournId: 37,  clubs: require('./_eredivisie_clubs').EREDIVISIE_CLUBS },
  'liga-portugal':   { name: 'Liga Portugal',           tournId: 238, clubs: require('./_liga_portugal_clubs').LIGA_PORTUGAL_CLUBS },
  'scottish-prem':   { name: 'Scottish Premiership',    tournId: 36,  clubs: require('./_scottish_clubs').SCOTTISH_CLUBS },
};

const SLEEP_MS = 350;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeName(s) { return String(s || '').toLowerCase().replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, ''); }

// data:image/<type>;base64,<base64> → { ext, buf }
function dataUriToBuffer(dataUri) {
  const m = String(dataUri || '').match(/^data:image\/([\w+]+);base64,([\s\S]+)$/i);
  if (!m) return null;
  const ext = m[1].toLowerCase().includes('png') ? '.png'
            : m[1].toLowerCase().includes('webp') ? '.webp'
            : m[1].toLowerCase().includes('svg')  ? '.svg'
            : '.jpg';
  return { ext, buf: Buffer.from(m[2], 'base64') };
}

// 🆕 unique-tournament の standings から全チームの id+name を一括取得
//   /search/all がブロックされてるための代替経路
async function _resolveTeamIdsFromTournament(tournId) {
  try {
    // 最新シーズン取得
    const seasons = await apiGet(`/unique-tournament/${tournId}/seasons`);
    const latest = (seasons?.seasons || [])[0];
    if (!latest?.id) return {};
    // standings.rows から team 一覧
    const standings = await apiGet(`/unique-tournament/${tournId}/season/${latest.id}/standings/total`);
    const rows = (standings?.standings || [])[0]?.rows || [];
    const map = {};
    rows.forEach(r => {
      const t = r.team;
      if (!t?.id || !t.name) return;
      const nameLc = String(t.name).toLowerCase();
      map[nameLc] = t.id;
      // 短縮名 / 別名も登録（exact match 漏れ防止）
      if (t.shortName) map[String(t.shortName).toLowerCase()] = t.id;
      if (t.nameCode)  map[String(t.nameCode).toLowerCase()]  = t.id;
    });
    return map;
  } catch (e) {
    console.warn(`  ⚠️ standings 取得失敗 (tournId ${tournId}): ${e.message.slice(0, 80)}`);
    return {};
  }
}

// クラブ名 → team_id（事前取得した map から、完全一致 → 部分一致で）
function _findTeamId(clubName, teamMap) {
  if (!clubName || !teamMap) return null;
  const lc = String(clubName).toLowerCase();
  if (teamMap[lc]) return teamMap[lc];
  // 部分一致
  for (const k of Object.keys(teamMap)) {
    if (k.includes(lc) || lc.includes(k)) return teamMap[k];
  }
  return null;
}

async function _fetchOneClub(leagueSlug, leagueName, clubKey, clubMeta, teamMap) {
  const stockDir = path.join(STOCK_BASE, leagueSlug);
  fs.mkdirSync(stockDir, { recursive: true });
  const clubName = clubMeta.name || clubKey;

  // SofaScore team ID を解決
  //   1. クラブマスタに sofaTeamId があれば最優先
  //   2. tournament standings 経由の teamMap から名前で引く
  //   3. それでもダメなら諦め
  let sofaTeamId = clubMeta.sofaTeamId || null;
  if (!sofaTeamId && teamMap) {
    sofaTeamId = _findTeamId(clubName, teamMap)
              || _findTeamId(clubMeta.searchName, teamMap)
              || _findTeamId(clubKey, teamMap);
  }
  if (!sofaTeamId) return { ok: false, reason: 'team-id 解決失敗（standings に該当なし）' };

  // ロゴ取得
  let dataUri;
  try {
    dataUri = await apiGetImage(`/team/${sofaTeamId}/image`);
  } catch (e) {
    return { ok: false, reason: 'image API: ' + e.message.slice(0, 60) };
  }
  const conv = dataUriToBuffer(dataUri);
  if (!conv) return { ok: false, reason: 'invalid data uri' };

  const outPath = path.join(stockDir, `${clubKey}${conv.ext}`);
  fs.writeFileSync(outPath, conv.buf);
  return {
    ok: true,
    sofaTeamId,
    localPath: path.relative(ROOT, outPath).replace(/\\/g, '/'),
    sizeBytes: conv.buf.length,
    format: conv.ext.slice(1),
  };
}

async function _fetchLeague(leagueSlug) {
  const lg = LEAGUES[leagueSlug];
  if (!lg) { console.error('未知のリーグ:', leagueSlug); return null; }
  console.log(`\n━━━ ${lg.name} (${leagueSlug}) ロゴ取得開始`);

  // 🆕 standings 経由で全チーム team_id 一覧を一括取得（search 不要）
  let teamMap = {};
  if (lg.tournId) {
    teamMap = await _resolveTeamIdsFromTournament(lg.tournId);
    console.log(`  📋 standings から ${Object.keys(teamMap).length} チームの team_id を解決`);
    await sleep(SLEEP_MS);
  }

  // 既存 index 読み込み
  let index = { updatedAt: null, total: 0, clubs: {} };
  try {
    if (fs.existsSync(INDEX_FILE)) index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (_) {}
  if (!index.clubs) index.clubs = {};

  let ok = 0, fail = 0;
  for (const [clubKey, clubMeta] of Object.entries(lg.clubs)) {
    const r = await _fetchOneClub(leagueSlug, lg.name, clubKey, clubMeta, teamMap);
    await sleep(SLEEP_MS);
    if (!r.ok) {
      console.warn(`  ❌ ${clubMeta.name || clubKey}: ${r.reason}`);
      fail++; continue;
    }
    const kb = (r.sizeBytes / 1024).toFixed(1);
    console.log(`  ✅ ${(clubMeta.name || clubKey).padEnd(28)} → ${clubKey}.${r.format} (${kb}KB / sofa#${r.sofaTeamId})`);
    // index 更新（leagueSlug:clubKey キー）
    index.clubs[`${leagueSlug}:${clubKey}`] = {
      league:      lg.name,
      leagueSlug,
      clubKey,
      clubName:    clubMeta.name || clubKey,
      sofaTeamId:  r.sofaTeamId,
      logoUrl:     `https://api.sofascore.com/api/v1/team/${r.sofaTeamId}/image`,
      format:      r.format,
      localPath:   r.localPath,
      sizeBytes:   r.sizeBytes,
      source:      'sofascore',
    };
    ok++;
  }

  // index 書き出し
  index.updatedAt = new Date().toISOString();
  index.total     = Object.keys(index.clubs).length;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`\n[${leagueSlug}] 完了: ${ok}成功 / ${fail}失敗 / 計 ${index.total} クラブ`);
  return { ok, fail };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node fetch_sofa_logos.js <league|all>\nLeagues:', Object.keys(LEAGUES).join(', '));
    process.exit(1);
  }
  const targets = arg === 'all' ? Object.keys(LEAGUES) : [arg];
  for (const lg of targets) {
    if (!LEAGUES[lg]) { console.warn('skip 未知:', lg); continue; }
    await _fetchLeague(lg);
  }
  console.log('\n🎉 全リーグ処理完了');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { _fetchLeague, _fetchOneClub };
