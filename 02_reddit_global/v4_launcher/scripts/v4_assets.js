'use strict';

const path = require('path');
const fs   = require('fs');

const { fetchWikipediaSafe } = require('../../scripts/modules/fetchers/wikipedia');
const { fetchSofaScorePlayer } = require('../../scripts/modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam } = require('../../scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreManager } = require('../../scripts/modules/fetchers/sofascore_manager');
const { searchFotMob, fetchFotMobCareer } = require('../../scripts/modules/fetchers/fotmob_career');
const { searchTransfermarktPlayer } = require('../../scripts/modules/fetchers/transfermarkt_player_games');
const { fetchPlayerInjuries } = require('../../scripts/modules/fetchers/transfermarkt_player_injuries');
const { fetchSofaScoreMatch } = require('../../scripts/modules/fetchers/sofascore_match');
const { curlGetJson } = require('../../scripts/modules/fetchers/_curl_cffi_caller');
const { walkEntity } = require('../../scripts/v2_story/si_walker');
const {
  matchPlayers,
  matchManagers,
  matchClubs,
} = require('../../scripts/modules/stock_match');

const X_API_KEY = process.env.TWITTER_API_IO_KEY || '';

// ── FotMob 選手データ取得（SofaScore 403 代替）───────────────
async function fetchFotMob(item) {
  try {
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
    add('シーズン', career.mainLeague?.season, 'season');
    if (career.birthDate?.utcTime) {
      const age = Math.floor((Date.now() - new Date(career.birthDate.utcTime)) / (365.25 * 24 * 3600 * 1000));
      add('年齢', `${age}歳`, 'age');
    }
    const pos = career.positionDescription?.positions?.[0]?.strPosSh?.label;
    add('ポジション', pos, 'position');
    // playerCareer からキャリア通算（直近クラブ優先）
    const careerArr = Array.isArray(career.playerCareer)
      ? career.playerCareer
      : (career.playerCareer?.careerItems?.senior?.teamEntries || []);
    const current = careerArr.find(e => e.current) || careerArr[0];
    if (current) {
      if (current.appearances != null) add('通算出場', `${current.appearances}試合`, 'careerApps');
      if (current.goals != null)       add('通算ゴール', `${current.goals}G`, 'careerGoals');
      if (current.assists != null)     add('通算アシスト', `${current.assists}A`, 'careerAssists');
    }
    // FotMob 選手画像（ID がわかれば確実に存在する）
    const imgUrl = `https://images.fotmob.com/image_resources/playerimages/${hit.id}.png`;
    const images = [{ url: imgUrl, source: 'fotmob', role: 'player', name: career.name || item.entity }];
    console.log(`[v4_assets] FotMob ${item.entity} rows=${rows.length}`);
    return { rows, images };
  } catch (e) {
    return { rows: [], images: [], warning: `FotMob: ${item.entity} 失敗: ${e.message}` };
  }
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
  for (const al of assetLabels) {
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
  const keyManagerLabel  = keyManager   ? [{ source: 'sofascore', entity: keyManager,   type: 'manager' }] : [];
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

  // matchcard: SofaScore から正確な試合データを取得
  if (book?.supplementType === 'matchcard') {
    const rawHome = String(book?.supplementData?.homeTeam || '').trim();
    const rawAway = String(book?.supplementData?.awayTeam || '').trim();
    if (rawHome && rawAway) {
      try {
        console.log(`[v4/assets] SofaScore Match: ${rawHome} vs ${rawAway}`);
        const matchResult = await fetchSofaScoreMatch(rawHome, rawAway);
        if (matchResult?.ok) {
          if (!book.supplementData) book.supplementData = {};
          book.supplementData.homeTeam  = matchResult.homeTeam  || rawHome;
          book.supplementData.awayTeam  = matchResult.awayTeam  || rawAway;
          book.supplementData.homeScore = matchResult.homeScore ?? book.supplementData.homeScore;
          book.supplementData.awayScore = matchResult.awayScore ?? book.supplementData.awayScore;
          book.supplementData.matchDate = matchResult.matchDate || book.supplementData.matchDate;
          book.supplementData.matchData = {
            tournament: matchResult.tournament,
            venue:      matchResult.venue,
            scoreline:  matchResult.scoreline,
            goals:      matchResult.goals,
            cards:      matchResult.cards,
            stats:      matchResult.stats,
            topPlayers: matchResult.topPlayers,
            formations: matchResult.formations,
            h2hSummary: matchResult.h2hSummary,
          };
          if (matchResult.homeLogo) {
            images.push({ url: matchResult.homeLogo, source: 'sofascore-logo', name: rawHome + ' logo', role: 'team_logo' });
          }
          if (matchResult.awayLogo) {
            images.push({ url: matchResult.awayLogo, source: 'sofascore-logo', name: rawAway + ' logo', role: 'team_logo' });
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
          console.log(`[v4/assets] SofaScore Match OK: ${matchResult.scoreline}`);
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
  const assetLabels = Array.isArray(book?.assetLabels) ? book.assetLabels : [];
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
  if (book?.supplementType === 'matchcard') {
    const rawHome = String(book?.supplementData?.homeTeam || '').trim();
    const rawAway = String(book?.supplementData?.awayTeam || '').trim();
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

module.exports = {
  fetchBookAssets,
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
