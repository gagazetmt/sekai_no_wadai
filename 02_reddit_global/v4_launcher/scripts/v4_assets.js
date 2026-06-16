'use strict';

const path = require('path');
const fs   = require('fs');

const { fetchWikipediaSafe } = require('../../scripts/modules/fetchers/wikipedia');
const { fetchSofaScorePlayer } = require('../../scripts/modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam } = require('../../scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreManager } = require('../../scripts/modules/fetchers/sofascore_manager');
const { searchFotMob, fetchFotMobCareer } = require('../../scripts/modules/fetchers/fotmob_career');
const { fetchFotMobPlayer } = require('../../scripts/modules/fetchers/fotmob_player');
const { fetchFotMobManager } = require('../../scripts/modules/fetchers/fotmob_manager');
const { searchTransfermarktPlayer } = require('../../scripts/modules/fetchers/transfermarkt_player_games');
const { fetchPlayerInjuries } = require('../../scripts/modules/fetchers/transfermarkt_player_injuries');
const { fetchSofaScoreMatch } = require('../../scripts/modules/fetchers/sofascore_match');
const { fetchFotMobMatch }    = require('../../scripts/modules/fetchers/fotmob_match');
const { curlGetJson } = require('../../scripts/modules/fetchers/_curl_cffi_caller');
const { walkEntity } = require('../../scripts/v2_story/si_walker');
const {
  matchPlayers,
  matchManagers,
  matchClubs,
} = require('../../scripts/modules/stock_match');

const X_API_KEY = process.env.TWITTER_API_IO_KEY || '';

// ── FotMob データ取得（SofaScore 403 代替・選手/監督両対応）───
async function fetchFotMob(item) {
  try {
    if (item.type === 'manager') return _fetchFotMobManagerData(item);
    return _fetchFotMobPlayerData(item);
  } catch (e) {
    return { rows: [], images: [], warning: `FotMob: ${item.entity} 失敗: ${e.message}` };
  }
}

async function _fetchFotMobPlayerData(item) {
  const d = await fetchFotMobPlayer(item.entity);
  if (!d?.ok) {
    // フォールバック: career データのみ
    return _fetchFotMobPlayerCareerOnly(item);
  }
  const rows = [];
  const add = (label, value, key) => {
    if (value != null && value !== '') rows.push({ label, value: String(value), source: 'FotMob', key, entity: item.entity });
  };
  add('選手', d.name, 'name');
  add('所属', d.team, 'team');
  add('リーグ', d.leagueName, 'league');
  add('ポジション', d.position, 'position');
  if (d.age != null) add('年齢', `${d.age}歳`, 'age');
  add('国籍', d.nationality, 'nationality');
  add('市場価値', d.marketValue, 'marketValue');
  // 今季スタッツ
  const ss = d.seasonStats;
  if (ss) {
    if (ss.appearances != null) add('出場', `${ss.appearances}試合`, 'apps');
    if (ss.goals != null) add('ゴール', ss.goals, 'goals');
    if (ss.assists != null) add('アシスト', ss.assists, 'assists');
    if (ss.rating != null) add('平均評定', ss.rating, 'rating');
    if (ss.expectedGoals != null) add('xG', ss.expectedGoals, 'xG');
    if (ss.keyPasses != null) add('キーパス', ss.keyPasses, 'keyPasses');
    if (ss.cleanSheets != null) add('クリーンシート', ss.cleanSheets, 'cleanSheets');
    if (ss.saves != null) add('セーブ', ss.saves, 'saves');
  }
  // 今季スタッツなければキャリア通算
  if (!ss && d.currentClub) {
    const c = d.currentClub;
    if (c.appearances != null) add('通算出場', `${c.appearances}試合`, 'careerApps');
    if (c.goals != null) add('通算ゴール', `${c.goals}G`, 'careerGoals');
    if (c.assists != null) add('通算アシスト', `${c.assists}A`, 'careerAssists');
  }
  // 代表通算
  if (d.nationalTeam?.total?.appearances) {
    add('代表通算試合', d.nationalTeam.total.appearances, 'nationalApps');
  }
  // 顔写真
  const images = d.photo
    ? [{ url: d.photo, source: 'fotmob', role: 'player', name: d.name || item.entity }]
    : [];
  console.log(`[v4_assets] FotMob player ${item.entity} rows=${rows.length}`);
  return { rows, images };
}

async function _fetchFotMobPlayerCareerOnly(item) {
  const hit = await searchFotMob(item.entity, {});
  if (!hit?.id) return { rows: [], images: [], warning: `FotMob: ${item.entity} が見つかりません` };
  const career = await fetchFotMobCareer(hit.id);
  if (!career) return { rows: [], images: [], warning: `FotMob: ${item.entity} キャリア取得失敗` };
  const rows = [];
  const add = (label, value, key) => {
    if (value != null && value !== '') rows.push({ label, value: String(value), source: 'FotMob', key, entity: item.entity });
  };
  add('選手', career.name || item.entity, 'name');
  add('所属', career.primaryTeam?.teamName, 'team');
  add('リーグ', career.mainLeague?.leagueName, 'league');
  const pos = career.positionDescription?.positions?.[0]?.strPosSh?.label;
  add('ポジション', pos, 'position');
  const careerArr = Array.isArray(career.playerCareer) ? career.playerCareer : [];
  const current = careerArr.find(e => e.current) || careerArr[0];
  if (current) {
    if (current.appearances != null) add('通算出場', `${current.appearances}試合`, 'careerApps');
    if (current.goals != null) add('通算ゴール', `${current.goals}G`, 'careerGoals');
    if (current.assists != null) add('通算アシスト', `${current.assists}A`, 'careerAssists');
  }
  const imgUrl = `https://images.fotmob.com/image_resources/playerimages/${hit.id}.png`;
  const images = [{ url: imgUrl, source: 'fotmob', role: 'player', name: career.name || item.entity }];
  console.log(`[v4_assets] FotMob career-only ${item.entity} rows=${rows.length}`);
  return { rows, images };
}

async function _fetchFotMobManagerData(item) {
  const d = await fetchFotMobManager(item.entity);
  if (!d?.ok) return { rows: [], images: [], warning: `FotMob Manager: ${item.entity} 取得失敗` };
  const rows = [];
  const add = (label, value, key) => {
    if (value != null && value !== '') rows.push({ label, value: String(value), source: 'FotMob', key, entity: item.entity });
  };
  add('監督', d.name, 'name');
  add('国籍', d.nationality, 'nationality');
  if (d.age != null) add('年齢', `${d.age}歳`, 'age');
  add('現所属', d.currentTeam, 'currentTeam');
  add('就任', d.currentTeamSince, 'since');
  if (d.overallPerformance) {
    const p = d.overallPerformance;
    add('通算成績', `${p.total}試合 ${p.wins}勝${p.draws}分${p.losses}敗`, 'record');
    if (p.winRate != null) add('勝率', `${p.winRate}%`, 'winRate');
  }
  if (d.trophyCount > 0) add('FotMobタイトル', `${d.trophyCount}回`, 'fmTrophies');
  if (d.trophySummary?.total > 0) add('Wikiタイトル', `${d.trophySummary.total}回`, 'wikiTrophies');
  const images = d.photo
    ? [{ url: d.photo, source: 'fotmob', role: 'manager', name: d.name || item.entity }]
    : [];
  console.log(`[v4_assets] FotMob manager ${item.entity} rows=${rows.length}`);
  return { rows, images };
}

// ── Wikipedia 記事内画像一覧（複数枚）────────────────────────
async function _fetchWikiExtraImages(entityName, maxImages = 8) {
  try {
    const title = encodeURIComponent(String(entityName || '').trim().replace(/ /g, '_'));
    const url = 'https://en.wikipedia.org/w/api.php?action=query&generator=images'
      + `&gimlimit=20&prop=imageinfo&iiprop=url|size|mime&format=json&titles=${title}`;
    const body = await curlGetJson(url, {
      referer: 'https://en.wikipedia.org/',
      headers: { Accept: 'application/json' },
    });
    const pages = Object.values(body?.query?.pages || {});
    const results = [];
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info?.url) continue;
      if (!/\.(jpg|jpeg|png|webp)/i.test(info.url)) continue;
      if ((info.width || 0) < 250 || (info.height || 0) < 180) continue;
      const fname = String(page.title || info.url).toLowerCase();
      // ロゴ・旗・アイコン類を除外
      if (/logo|badge|crest|emblem|seal|icon|flag|coat.of.arm|federation|ffm|confederation|_fed_|_federation/i.test(fname)) continue;
      // 乗り物・建物・非サッカー系を除外
      if (/aircraft|airplane|boeing|airbus|varig|stadium_ext|map_of|location/i.test(fname)) continue;
      // 横長すぎる（バナー画像）を除外
      const w = info.width || 0;
      const h = info.height || 0;
      if (h > 0 && w / h > 4.5) continue;
      results.push({
        url: info.url,
        source: 'wikipedia',
        role: 'article',
        name: String(page.title || '').replace(/^File:/i, '').replace(/\.[^.]+$/, ''),
      });
      if (results.length >= maxImages) break;
    }
    return results;
  } catch (_) { return []; }
}

// ── 公式 X アカウントのハンドル辞書（V3 team_x_accounts.json を共用）────
let _teamXMap = null;
function _lookupXHandle(entityName) {
  if (!_teamXMap) {
    try {
      const mapPath = path.join(__dirname, '..', '..', 'logos', 'team_x_accounts.json');
      _teamXMap = JSON.parse(fs.readFileSync(mapPath, 'utf8')).teams || {};
    } catch (_) { _teamXMap = {}; }
  }
  const key = String(entityName || '')
    .replace(/\s+national\s+(?:football|soccer)?\s*team/gi, '')
    .trim();
  if (!key) return null;
  const kl = key.toLowerCase();
  // 完全一致（大小文字無視）
  const exactKey = Object.keys(_teamXMap).find(k => k.toLowerCase() === kl);
  if (exactKey) return _teamXMap[exactKey].handle || null;
  // 部分一致（長い方優先）
  const partialKey = Object.keys(_teamXMap)
    .sort((a, b) => b.length - a.length)
    .find(k => { const kl2 = k.toLowerCase(); return kl2.includes(kl) || kl.includes(kl2); });
  return partialKey ? _teamXMap[partialKey].handle || null : null;
}

// ── 公式 X アカウントから最新画像を取得 ──────────────────────
async function _fetchXOfficialImages(handle, maxImages = 6) {
  if (!X_API_KEY || !handle) return [];
  try {
    const q = `from:${handle} has:images -is:retweet`;
    const res = await fetch(
      'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
      new URLSearchParams({ query: q, queryType: 'Latest' }),
      { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(10000) },
    );
    const data = await res.json();
    const tweets = data?.data?.tweets || data?.tweets || [];
    const images = [];
    for (const t of tweets.slice(0, 30)) {
      const mediaList = [
        ...(Array.isArray(t.extendedEntities?.media) ? t.extendedEntities.media : []),
        ...(Array.isArray(t.extended_entities?.media) ? t.extended_entities.media : []),
        ...(Array.isArray(t.entities?.media) ? t.entities.media : []),
      ];
      for (const m of mediaList) {
        const url = m?.media_url_https || m?.url || m?.media_url || '';
        if (url && /\.(jpg|jpeg|png|webp)/i.test(url)) {
          images.push({ url, source: 'x_official', role: 'official', name: `@${handle}` });
          if (images.length >= maxImages) break;
        }
      }
      if (images.length >= maxImages) break;
    }
    if (images.length) console.log(`[v4_assets] X公式@${handle}: ${images.length}件`);
    return images;
  } catch (e) {
    console.warn(`[v4_assets] X公式@${handle} 失敗:`, e.message);
    return [];
  }
}

// ── 公式 X アカウントからトピック関連画像（関連度高い15件）────
async function _fetchXRelevantImages(handle, topicKeyword, maxImages = 15) {
  if (!X_API_KEY || !handle || !topicKeyword) return [];
  try {
    const keyword = String(topicKeyword).slice(0, 30).replace(/"/g, '');
    const q = `from:${handle} ${keyword} has:images -is:retweet`;
    const res = await fetch(
      'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
      new URLSearchParams({ query: q, queryType: 'Top' }),
      { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(10000) },
    );
    const data = await res.json();
    const tweets = data?.data?.tweets || data?.tweets || [];
    const images = [];
    for (const t of tweets.slice(0, 40)) {
      const mediaList = [
        ...(Array.isArray(t.extendedEntities?.media) ? t.extendedEntities.media : []),
        ...(Array.isArray(t.extended_entities?.media) ? t.extended_entities.media : []),
        ...(Array.isArray(t.entities?.media) ? t.entities.media : []),
      ];
      for (const m of mediaList) {
        const url = m?.media_url_https || m?.url || m?.media_url || '';
        if (url && /\.(jpg|jpeg|png|webp)/i.test(url)) {
          images.push({ url, source: 'x_official_relevant', role: 'relevant', name: `@${handle}` });
          if (images.length >= maxImages) break;
        }
      }
      if (images.length >= maxImages) break;
    }
    if (images.length) console.log(`[v4_assets] X関連@${handle}: ${images.length}件`);
    return images;
  } catch (e) {
    console.warn(`[v4_assets] X関連@${handle} 失敗:`, e.message);
    return [];
  }
}

// ── X 試合/トピック関連画像（twitterAPI.io）──────────────────
async function _fetchXTopicImages(topic, maxImages = 6) {
  if (!X_API_KEY) return [];
  try {
    const q = `"${topic.slice(0, 40)}" has:images -is:retweet lang:en`;
    const res = await fetch(
      'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
      new URLSearchParams({ query: q, queryType: 'Latest' }),
      { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(10000) },
    );
    const data = await res.json();
    const tweets = data?.data?.tweets || data?.tweets || [];
    const images = [];
    for (const t of tweets.slice(0, 30)) {
      // media フィールドのバリエーション
      const mediaList = [
        ...(Array.isArray(t.extendedEntities?.media) ? t.extendedEntities.media : []),
        ...(Array.isArray(t.extended_entities?.media) ? t.extended_entities.media : []),
        ...(Array.isArray(t.entities?.media) ? t.entities.media : []),
        ...(Array.isArray(t.media) ? t.media : []),
      ];
      for (const m of mediaList) {
        const url = m?.media_url_https || m?.url || m?.media_url || '';
        if (url && /\.(jpg|jpeg|png|webp)/i.test(url)) {
          images.push({ url, source: 'x', role: 'match', name: t.user?.name || 'X' });
          if (images.length >= maxImages) break;
        }
      }
      if (images.length >= maxImages) break;
    }
    if (images.length) console.log(`[v4_assets] X画像取得: ${images.length}件`);
    return images;
  } catch (e) {
    console.warn('[v4_assets] X画像取得失敗:', e.message);
    return [];
  }
}

// "Morocco national football team" → "Morocco"
function cleanTeamName(name) {
  return String(name || '')
    .replace(/\s+national\s+(?:football|soccer|futsal|beach\s+soccer)?\s*team\b/gi, '')
    .replace(/\s+FC$|\s+CF$|\s+SC$/i, '')
    .trim();
}

function inferEntityType(book) {
  const explicit = book?.entityType || book?.supplementData?.entityType;
  if (['player', 'team', 'manager'].includes(explicit)) return explicit;
  const entity = String(book?.mainEntity || '').trim();
  if (!entity) return 'entity';
  if (matchPlayers(entity, { limit: 1, threshold: 75 }).length) return 'player';
  if (matchManagers(entity, { limit: 1, threshold: 75 }).length) return 'manager';
  if (matchClubs(entity, { limit: 1, threshold: 75 }).length) return 'team';
  if (/\b(fc|cf|sc|united|city|athletic|real|club|national team)\b/i.test(entity)) return 'team';
  return 'player';
}

function _labelsFromAssetLabels(assetLabels) {
  const labels = [];
  const seen = new Set();
  for (const al of assetLabels.slice(0, 3)) {
    const name = String(al.name || '').trim();
    const t = String(al.type || 'player').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    if (t === 'player') {
      labels.push(
        { source: 'sofascore',     entity: name, type: 'player', team: al.team || null },
        { source: 'fotmob',        entity: name, type: 'player', team: al.team || null },
        { source: 'transfermarkt', entity: name, type: 'player', team: al.team || null },
        { source: 'wikipedia',     entity: name, type: 'player', team: al.team || null },
      );
    } else if (t === 'manager') {
      labels.push(
        { source: 'sofascore', entity: name, type: 'manager', team: al.team || null },
        { source: 'fotmob',    entity: name, type: 'manager', team: al.team || null },
        { source: 'wikipedia', entity: name, type: 'manager', team: al.team || null },
      );
    } else {
      // team / nationalTeam
      labels.push(
        { source: 'wikipedia', entity: name, type: 'team', league: al.league || null },
      );
    }
  }
  return labels;
}

function normalizeLabels(book) {
  // assetLabels（リネカ提案）があればそちらを優先使用
  if (Array.isArray(book?.assetLabels) && book.assetLabels.length) {
    console.log(`[v4_assets] assetLabels 使用: ${book.assetLabels.length}件`);
    return _labelsFromAssetLabels(book.assetLabels);
  }

  const entity = String(book?.mainEntity || '').trim();
  const type = inferEntityType(book);
  if (!entity) return [];

  const keyPlayer    = String(book?.keyPlayer    || '').trim();
  const keyManager   = String(book?.keyManager   || '').trim();
  const otherPlayers = (Array.isArray(book?.otherPlayers) ? book.otherPlayers : [])
    .map(p => String(p || '').trim()).filter(Boolean).slice(0, 2);

  const keyPlayerLabels = keyPlayer ? [
    { source: 'fotmob',        entity: keyPlayer, type: 'player' },
    { source: 'transfermarkt', entity: keyPlayer, type: 'player' },
  ] : [];
  const keyManagerLabel  = keyManager   ? [
    { source: 'sofascore', entity: keyManager, type: 'manager' },
    { source: 'fotmob',    entity: keyManager, type: 'manager' },
  ] : [];
  const otherPlayerLabels = otherPlayers.map(p => ({ source: 'fotmob', entity: p, type: 'player' }));

  const matchHome = String(book?.supplementData?.homeTeam || '').trim();
  const matchAway = String(book?.supplementData?.awayTeam || '').trim();
  if (matchHome && matchAway) {
    return [
      { source: 'wikipedia', entity: matchHome, type: 'team' },
      { source: 'wikipedia', entity: matchAway, type: 'team' },
      ...keyPlayerLabels,
      ...keyManagerLabel,
      ...otherPlayerLabels,
    ];
  }

  const subs = Array.isArray(book?.subEntities)
    ? book.subEntities.map(e => String(e || '').trim()).filter(Boolean).slice(0, 1)
    : [];
  if (subs.length) {
    const subType = inferEntityType({ mainEntity: subs[0] });
    const mainSource = type === 'player' ? 'sofascore' : 'wikipedia';
    const subSource  = subType === 'player' ? 'sofascore' : 'wikipedia';
    return [
      { source: mainSource, entity, type },
      { source: subSource,  entity: subs[0], type: subType },
      ...keyPlayerLabels,
      ...keyManagerLabel,
      ...otherPlayerLabels,
    ];
  }

  if (type === 'player') {
    return [
      { source: 'sofascore',     entity, type },
      { source: 'fotmob',        entity, type },
      { source: 'transfermarkt', entity, type },
      { source: 'wikipedia',     entity, type },
    ];
  }
  return [
    { source: 'wikipedia', entity, type },
    ...keyPlayerLabels,
    ...keyManagerLabel,
    ...otherPlayerLabels,
  ];
}

function labelTitle(item) {
  const names = {
    sofascore: 'SofaScore',
    transfermarkt: 'Transfermarkt',
    wikipedia: 'Wikipedia',
  };
  return `${names[item.source] || item.source}: ${item.entity}`;
}

function stockImages(entity) {
  return [
    ...matchPlayers(entity, { limit: 6, threshold: 82 }),
    ...matchManagers(entity, { limit: 3, threshold: 82 }),
    ...matchClubs(entity, { limit: 4, threshold: 78 }),
  ];
}

async function fetchSofa(item) {
  let role = item.type;
  let d;
  if (role === 'team') d = await fetchSofaScoreTeam(item.entity);
  else if (role === 'manager') d = await fetchSofaScoreManager(item.entity);
  else {
    role = 'player';
    d = await fetchSofaScorePlayer(item.entity);
  }
  if (!d?.ok) return { rows: [], warning: `SofaScore: ${item.entity} を取得できませんでした` };
  const ss = d.seasonStats || {};
  const nt = d.nationalTeam?.total || {};
  const directRows = role === 'player' ? [
    ['選手', d.name || item.entity, 'name'],
    ['SofaScore ID', d.playerId, 'playerId'],
    ['所属', d.team, 'team'],
    ['ポジション', d.position, 'position'],
    ['年齢', d.age != null ? `${d.age}歳` : null, 'age'],
    ['国籍', d.nationality, 'nationality'],
    ['市場価値', d.marketValue, 'marketValue'],
    ['出場', ss.appearances != null ? `${ss.appearances}試合` : null, 'apps'],
    ['ゴール', ss.goals, 'goals'],
    ['アシスト', ss.assists, 'assists'],
    ['平均評定', ss.rating, 'rating'],
    ['代表通算試合', nt.appearances, 'nationalApps'],
  ] : role === 'team' ? [
    ['順位', d.standing?.position != null ? `${d.standing.position}位` : null, 'position'],
    ['勝点', d.standing?.points, 'points'],
    ['勝利', d.standing?.wins, 'wins'],
    ['引分', d.standing?.draws, 'draws'],
    ['敗戦', d.standing?.losses, 'losses'],
    ['得点', d.standing?.goalsFor, 'goalsFor'],
    ['失点', d.standing?.goalsAgainst, 'goalsAgainst'],
    ['監督', d.managerName, 'manager'],
  ] : [];
  const walkedRows = walkEntity(d, role)
    .filter(slot => slot?.label && slot?.value != null && slot.value !== '')
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
    .map(slot => ({
      label: slot.label,
      value: String(slot.value),
      source: 'SofaScore',
      key: slot.key || '',
      entity: item.entity,
    }));
  const direct = directRows
    .filter(([, value]) => value != null && value !== '' && value !== '-')
    .map(([label, value, key]) => ({
      label,
      value: String(value),
      source: 'SofaScore',
      key,
      entity: item.entity,
    }));
  const seen = new Set();
  const rows = [...direct, ...walkedRows].filter(row => {
    const key = `${row.label}:${row.value}`;
    if (seen.has(key) || row.value === '-') return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
  console.log(`[v4_assets] SofaScore ${role}:${item.entity} rows=${rows.length}`);
  return { rows };
}

function inferRoleFromData(data) {
  if (data?.seasonStats || data?.player) return 'player';
  if (data?.standing || data?.team) return 'team';
  if (data?.manager || data?.managerInfo) return 'manager';
  return 'generic';
}

async function fetchTransfermarkt(item) {
  if (item.type !== 'player' && item.type !== 'entity') {
    return { rows: [], warning: `Transfermarkt: ${item.entity} は選手ラベルではありません` };
  }
  const hit = await searchTransfermarktPlayer(item.entity);
  if (!hit) return { rows: [], warning: `Transfermarkt: ${item.entity} を取得できませんでした` };
  const rows = [
    { label: '選手', value: hit.name || item.entity, source: 'Transfermarkt', key: 'playerName', entity: item.entity },
    { label: '選手ID', value: String(hit.id), source: 'Transfermarkt', key: 'playerId', entity: item.entity },
  ];
  const injuries = await fetchPlayerInjuries(hit.id, hit.slug);
  if (injuries.ok) {
    const ongoing = injuries.injuries.find(injury => injury.isOngoing);
    if (ongoing) {
      rows.push({
        label: '負傷状況',
        value: `${ongoing.injury || '負傷'}${ongoing.untilDate ? ` / ${ongoing.untilDate}まで` : ''}`,
        source: 'Transfermarkt',
        key: 'currentInjury',
        entity: item.entity,
      });
    }
    rows.push({
      label: '負傷履歴',
      value: `${injuries.injuries.length}件`,
      source: 'Transfermarkt',
      key: 'injuryCount',
      entity: item.entity,
    });
  }
  return { rows };
}

async function fetchWiki(item) {
  let wiki = await fetchWikipediaSafe([item.entity]);
  if (!wiki.ok) {
    try {
      const title = encodeURIComponent(item.entity.trim().replace(/ /g, '_'));
      const url = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageimages%7Cinfo'
        + `&exintro=1&explaintext=1&inprop=url&pithumbsize=800&redirects=1&titles=${title}&format=json`;
      const body = await curlGetJson(url, {
        referer: 'https://en.wikipedia.org/',
        headers: { Accept: 'application/json' },
      });
      const page = Object.values(body?.query?.pages || {})[0];
      if (page && !page.missing) {
        wiki = {
          ok: true,
          title: page.title || item.entity,
          description: '',
          extract: page.extract || '',
          thumbnail: page.thumbnail?.source || null,
          url: page.fullurl || '',
        };
      }
    } catch (_) {}
  }
  if (!wiki.ok) return { rows: [], images: [], warning: `Wikipedia: ${item.entity} を取得できませんでした` };
  const rows = [
    wiki.description && { label: '人物・クラブ概要', value: wiki.description, source: 'Wikipedia', key: 'description', entity: item.entity },
    wiki.extract && { label: 'Wikipedia要約', value: String(wiki.extract).slice(0, 220), source: 'Wikipedia', key: 'extract', entity: item.entity },
    wiki.url && { label: 'Wikipedia', value: wiki.url, source: 'Wikipedia', key: 'url', entity: item.entity },
  ].filter(Boolean);
  const images = [];
  if (wiki.thumbnail) {
    images.push({ source: 'wikipedia', role: item.type, name: wiki.title || item.entity, url: wiki.thumbnail });
  }
  // 記事内の追加画像も取得（2〜6枚）
  const extraImgs = await _fetchWikiExtraImages(item.entity, 6);
  for (const img of extraImgs) {
    if (!images.find(i => i.url === img.url)) images.push(img);
  }
  return { rows, images };
}

async function fetchBookAssets(book) {
  const labels = normalizeLabels(book);
  const tasks = labels.map(async (item) => {
    if (item.source === 'fotmob') return fetchFotMob(item);
    if (item.source.includes('sofa')) return fetchSofa({ ...item, source: 'sofascore' });
    if (item.source.includes('transfer') || item.source === 'tm') {
      return fetchTransfermarkt({ ...item, source: 'transfermarkt' });
    }
    if (item.source.includes('wiki')) return fetchWiki({ ...item, source: 'wikipedia' });
    return { rows: [], images: [], warning: `未対応ラベル: ${item.source}` };
  });
  const settled = await Promise.allSettled(tasks);
  const dataRows = [];
  const images = [];
  const warnings = [];
  settled.forEach((result) => {
    if (result.status === 'rejected') {
      warnings.push(result.reason?.message || 'データ取得失敗');
      return;
    }
    dataRows.push(...(result.value.rows || []));
    images.push(...(result.value.images || []));
    if (result.value.warning) warnings.push(result.value.warning);
  });

  const entities = [...new Set(labels.map(item => item.entity).filter(Boolean))];
  entities.forEach(entity => images.push(...stockImages(entity)));

  // matchcard: 試合データを取得（supplement1Type/supplement2Type/旧supplementType いずれかが matchcard）
  const matchcardSfx = book?.supplement1Type === 'matchcard' ? '1'
    : book?.supplement2Type === 'matchcard' ? '2'
    : book?.supplementType === 'matchcard' ? '' : null;
  if (matchcardSfx !== null) {
    const dataKey = matchcardSfx ? `supplement${matchcardSfx}Data` : 'supplementData';
    let rawHome = String(book?.[dataKey]?.homeTeam || book?.supplementData?.homeTeam || '').trim();
    let rawAway = String(book?.[dataKey]?.awayTeam || book?.supplementData?.awayTeam || '').trim();
    // フォールバック: supplementData が空なら assetLabels/topic から抽出
    if (!rawHome || !rawAway) {
      const teamLabels = (Array.isArray(book?.assetLabels) ? book.assetLabels : [])
        .filter(l => l.type === 'team' || l.type === 'nationalTeam')
        .map(l => String(l.name || '').trim())
        .filter(Boolean);
      if (teamLabels.length >= 2) {
        if (!rawHome) rawHome = teamLabels[0];
        if (!rawAway) rawAway = teamLabels[1];
      } else {
        const topic = String(book?.topic || '');
        const vsMatch = topic.match(/(.+?)\s*(?:vs\.?|VS\.?|ー|対)\s*(.+)/);
        if (vsMatch) {
          if (!rawHome) rawHome = vsMatch[1].trim();
          if (!rawAway) rawAway = vsMatch[2].trim();
        }
      }
      if (rawHome || rawAway) {
        console.log(`[v4/assets] matchcard fallback: ${rawHome} vs ${rawAway}`);
      }
    }
    if (rawHome && rawAway) {
      try {
        console.log(`[v4/assets] Match data: ${rawHome} vs ${rawAway}`);
        let matchResult = await fetchSofaScoreMatch(rawHome, rawAway);
        if (!matchResult?.ok) {
          console.log(`[v4/assets] SofaScore失敗 → FotMob fallback`);
          matchResult = await fetchFotMobMatch(rawHome, rawAway);
        }
        if (matchResult?.ok) {
          // 新フィールド（supplement1Data / supplement2Data）と旧フィールド（supplementData）両方に書き込む
          const targetData = matchcardSfx ? `supplement${matchcardSfx}Data` : 'supplementData';
          if (!book[targetData]) book[targetData] = {};
          const sd = book[targetData];
          sd.homeTeam  = matchResult.homeTeam  || rawHome;
          sd.awayTeam  = matchResult.awayTeam  || rawAway;
          sd.homeScore = matchResult.homeScore ?? sd.homeScore;
          sd.awayScore = matchResult.awayScore ?? sd.awayScore;
          sd.matchDate = matchResult.matchDate || sd.matchDate;
          sd.matchData = {
            tournament: matchResult.tournament,
            venue:      matchResult.venue,
            scoreline:  matchResult.scoreline,
            homeScore:  matchResult.homeScore,
            awayScore:  matchResult.awayScore,
            goals:      matchResult.goals,
            cards:      matchResult.cards,
            subs:       matchResult.subs || [],
            stats:      matchResult.stats,
            topPlayers: matchResult.topPlayers,
            formations: matchResult.formations,
            lineup:     matchResult.lineup || { home: [], away: [] },
            homeLogo:   matchResult.homeLogo || null,
            awayLogo:   matchResult.awayLogo || null,
            h2hSummary: matchResult.h2hSummary,
          };
          const logoSource = matchResult._source === 'fotmob' ? 'fotmob-logo' : 'sofascore-logo';
          if (matchResult.homeLogo) {
            images.push({ url: matchResult.homeLogo, source: logoSource, name: rawHome + ' logo', role: 'team_logo' });
          }
          if (matchResult.awayLogo) {
            images.push({ url: matchResult.awayLogo, source: logoSource, name: rawAway + ' logo', role: 'team_logo' });
          }
          // 試合スタッツをデータ行にも追加
          if (matchResult.stats) {
            const statKeys = ['Ball possession', 'Total shots', 'Shots on target', 'Corner kicks', 'Fouls', 'Offsides'];
            for (const key of statKeys) {
              if (matchResult.stats[key]) {
                dataRows.push({
                  label: key, value: `${matchResult.stats[key].home} - ${matchResult.stats[key].away}`,
                  source: 'SofaScore', key: 'matchStat', entity: `${rawHome} vs ${rawAway}`,
                });
              }
            }
          }
          if (matchResult.topPlayers?.length) {
            matchResult.topPlayers.forEach(p => {
              dataRows.push({
                label: `${p.name} (${p.team})`, value: `評価 ${p.rating}`,
                source: 'SofaScore', key: 'topPlayer', entity: p.name,
              });
            });
          }
          // 後方互換: supplementData にも同期
          if (matchcardSfx && targetData !== 'supplementData') {
            book.supplementData = { ...sd };
          }
          // supplement2 が stats の場合、試合パフォーマンスデータで上書き
          if (book.supplement2Type === 'stats' && matchResult.topPlayers?.length) {
            const keyPlayer = book.keyPlayer || matchResult.topPlayers[0]?.name;
            const playerLineup = [...(matchResult.lineup?.home || []), ...(matchResult.lineup?.away || [])];
            const kp = playerLineup.find(p => p.name === keyPlayer);
            const kpGoals = (matchResult.goals || []).filter(g => g.player === keyPlayer);
            const slots = [];
            if (kp?.rating)  slots.push({ label: '試合評価', value: String(kp.rating) });
            if (kpGoals.length) slots.push({ label: 'ゴール', value: kpGoals.map(g => g.timeStr).join(', ') });
            if (kp?.pos)     slots.push({ label: 'ポジション', value: kp.pos });
            // チーム全体のスタッツも追加
            const statMap = matchResult.stats || {};
            if (statMap['Ball possession']) slots.push({ label: 'ポゼッション', value: `${statMap['Ball possession'].home} - ${statMap['Ball possession'].away}` });
            if (statMap['Total shots'])     slots.push({ label: 'シュート', value: `${statMap['Total shots'].home} - ${statMap['Total shots'].away}` });
            if (statMap['Shots on target']) slots.push({ label: '枠内シュート', value: `${statMap['Shots on target'].home} - ${statMap['Shots on target'].away}` });
            // トップ選手一覧
            for (const tp of matchResult.topPlayers.slice(0, 3)) {
              slots.push({ label: tp.name, value: `評価 ${tp.rating}` });
            }
            book.supplement2Data = {
              entity: keyPlayer || book.supplement2Data?.entity,
              dataSlots: slots.slice(0, 8),
            };
            book.supplement2Title = book.supplement2Title || `${keyPlayer} 試合パフォーマンス`;
            console.log(`[v4/assets] supplement2 stats → 試合パフォーマンスに上書き (${slots.length}項目)`);
          }
          console.log(`[v4/assets] Match OK: ${matchResult.scoreline} → ${targetData}`);
        } else {
          console.warn(`[v4/assets] SofaScore Match: ${matchResult?.error || '取得失敗'}`);
        }
      } catch (e) {
        console.warn(`[v4/assets] SofaScore Match error: ${e.message}`);
      }
    }
  }

  // assetLabels + mainEntity + subEntities から X 公式画像を取得
  const fetchedXHandles = new Set();
  const topicKeyword = String(book?.mainEntity || book?.topic || '').slice(0, 30);

  // assetLabels があれば、各ラベルの team/name から公式X画像を広範囲取得
  const assetLabels = Array.isArray(book?.assetLabels) ? book.assetLabels.slice(0, 3) : [];
  const xHandleTargets = new Set();
  for (const al of assetLabels) {
    const name = String(al.name || '').trim();
    const team = String(al.team || '').trim();
    if (team) {
      const h = _lookupXHandle(cleanTeamName(team) || team);
      if (h) xHandleTargets.add(h);
    }
    if (al.type === 'team' || al.type === 'nationalTeam') {
      const h = _lookupXHandle(cleanTeamName(name) || name);
      if (h) xHandleTargets.add(h);
    }
  }
  // 従来の mainEntity + subEntities からもハンドル探索
  const legacyTargets = [
    String(book?.mainEntity || '').trim(),
    ...(Array.isArray(book?.subEntities) ? book.subEntities.map(e => String(e || '').trim()).filter(Boolean) : []),
  ].filter(Boolean).slice(0, 3);
  for (const entityStr of legacyTargets) {
    const h = _lookupXHandle(cleanTeamName(entityStr) || entityStr);
    if (h) xHandleTargets.add(h);
  }

  // 各ハンドルから最新15件 + 関連度高い15件を並列取得
  await Promise.all([...xHandleTargets].map(async (handle) => {
    if (fetchedXHandles.has(handle)) return;
    fetchedXHandles.add(handle);
    const [latest, relevant] = await Promise.all([
      _fetchXOfficialImages(handle, 15),
      _fetchXRelevantImages(handle, topicKeyword, 15),
    ]);
    images.push(...latest, ...relevant);
  }));

  // matchcard: 両チームの公式X画像（未取得分）を追加取得
  const isMatchcard = book?.supplement1Type === 'matchcard' || book?.supplement2Type === 'matchcard' || book?.supplementType === 'matchcard';
  if (isMatchcard) {
    const mcData = book?.supplement1Data || book?.supplement2Data || book?.supplementData || {};
    const rawHome = String(mcData.homeTeam || '').trim();
    const rawAway = String(mcData.awayTeam || '').trim();
    const homeHandle = _lookupXHandle(cleanTeamName(rawHome) || rawHome);
    const awayHandle = _lookupXHandle(cleanTeamName(rawAway) || rawAway);
    const officialImgs = await Promise.all([
      homeHandle && !fetchedXHandles.has(homeHandle) ? _fetchXOfficialImages(homeHandle, 15) : [],
      awayHandle && !fetchedXHandles.has(awayHandle) ? _fetchXOfficialImages(awayHandle, 15) : [],
    ]);
    images.push(...officialImgs.flat());
  }

  // X トピック画像補完（全スライド種別）
  {
    const mainRaw = String(book?.mainEntity || book?.topic || '').trim();
    const subRaw  = Array.isArray(book?.subEntities) && book.subEntities[0]
      ? String(book.subEntities[0]).trim() : '';
    const matchHomeRaw = String(book?.supplementData?.homeTeam || '').trim();
    const matchAwayRaw = String(book?.supplementData?.awayTeam || '').trim();
    const xQuery = (matchHomeRaw && matchAwayRaw)
      ? `${cleanTeamName(matchHomeRaw)} ${cleanTeamName(matchAwayRaw)}`
      : [cleanTeamName(mainRaw) || mainRaw, cleanTeamName(subRaw) || subRaw].filter(Boolean).join(' ');
    if (xQuery) {
      const topicImgs = await _fetchXTopicImages(xQuery.slice(0, 50), 10);
      images.push(...topicImgs);
    }
  }

  const seen = new Set();
  const uniqueImages = images.filter((image) => {
    if (!image?.url || seen.has(image.url)) return false;
    seen.add(image.url);
    return true;
  }).sort((a, b) => {
    const priority = image => {
      if (image.stockProvider === 'official-index') return 0;
      if (image.source === 'fotmob') return 1;
      if (image.source === 'x_official_relevant') return 1.5;
      if (image.source === 'x_official') return 2;
      if (image.stockProvider === 'sofascore-profile') return 3;
      if (image.source === 'stock' && Number(image.visionScore || 0) >= 90) return 4;
      if (image.source === 'wikipedia') return 5;
      if (image.source === 'x') return 6;
      return 7;
    };
    return priority(a) - priority(b) ||
      Number(b.visionScore || 0) - Number(a.visionScore || 0);
  }).slice(0, 40);

  // ── 画像スコアリング + 最適セット選定 ──────────────────────
  let scoredImages = uniqueImages;
  let thumbnail    = uniqueImages[0] || null;
  let slideImages  = uniqueImages.slice(0, 6);

  if (uniqueImages.length) {
    try {
      const { scoreImages, selectImageSet } = require('./v4_image_selector');
      const mood = String(book?.topic || '').match(/www|草|ww|笑|爆笑|バカ|バズ|笑える|面白/) ? 'funny' : 'cool';
      scoredImages = await scoreImages(uniqueImages, { topic: book?.topic || '', mood });
      const selected = selectImageSet(scoredImages);
      thumbnail   = selected.thumbnail   || thumbnail;
      slideImages = selected.slideImages.length ? selected.slideImages : slideImages;
    } catch (e) {
      console.warn('[v4_assets] 画像スコアリング失敗（フォールバック）:', e.message);
    }
  }

  return {
    ok: true,
    labels: labels.map(item => ({
      ...item,
      label: item.label || labelTitle(item),
    })),
    dataRows:    dataRows.slice(0, 24),
    images:      scoredImages,
    thumbnail,
    slideImages,
    warnings,
  };
}

async function fetchSingleLabel(assetLabel, book) {
  const labels = _labelsFromAssetLabels([assetLabel]);
  const tasks = labels.map(async (item) => {
    if (item.source === 'fotmob') return fetchFotMob(item);
    if (item.source.includes('sofa')) return fetchSofa({ ...item, source: 'sofascore' });
    if (item.source.includes('transfer') || item.source === 'tm') {
      return fetchTransfermarkt({ ...item, source: 'transfermarkt' });
    }
    if (item.source.includes('wiki')) return fetchWiki({ ...item, source: 'wikipedia' });
    return { rows: [], images: [], warning: `未対応: ${item.source}` };
  });
  const settled = await Promise.allSettled(tasks);
  const dataRows = [];
  const images = [];
  const warnings = [];
  settled.forEach((r) => {
    if (r.status === 'rejected') { warnings.push(r.reason?.message || '取得失敗'); return; }
    dataRows.push(...(r.value.rows || []));
    images.push(...(r.value.images || []));
    if (r.value.warning) warnings.push(r.value.warning);
  });

  const name = String(assetLabel.name || '').trim();
  images.push(...stockImages(name));

  const handle = assetLabel.type === 'team' || assetLabel.type === 'nationalTeam'
    ? _lookupXHandle(cleanTeamName(name) || name)
    : (assetLabel.team ? _lookupXHandle(cleanTeamName(assetLabel.team) || assetLabel.team) : null);
  if (handle) {
    const topicKeyword = String(book?.mainEntity || book?.topic || '').slice(0, 30);
    const [latest, relevant] = await Promise.all([
      _fetchXOfficialImages(handle, 15),
      _fetchXRelevantImages(handle, topicKeyword, 15),
    ]);
    images.push(...latest, ...relevant);
  }

  const seen = new Set();
  const uniqueImages = images.filter(img => {
    if (!img?.url || seen.has(img.url)) return false;
    seen.add(img.url);
    return true;
  });

  return { ok: true, label: name, dataRows, images: uniqueImages, warnings };
}

module.exports = {
  fetchBookAssets,
  fetchSingleLabel,
  inferEntityType,
  normalizeLabels,
};

if (require.main === module) {
  const mainEntity = process.argv.slice(2).join(' ').trim();
  fetchBookAssets({ mainEntity }).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
