'use strict';

const { fetchWikipediaSafe } = require('../../scripts/modules/fetchers/wikipedia');
const { fetchSofaScorePlayer } = require('../../scripts/modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam } = require('../../scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreManager } = require('../../scripts/modules/fetchers/sofascore_manager');
const { searchTransfermarktPlayer } = require('../../scripts/modules/fetchers/transfermarkt_player_games');
const { fetchPlayerInjuries } = require('../../scripts/modules/fetchers/transfermarkt_player_injuries');
const { curlGetJson } = require('../../scripts/modules/fetchers/_curl_cffi_caller');
const { walkEntity } = require('../../scripts/v2_story/si_walker');
const {
  matchPlayers,
  matchManagers,
  matchClubs,
} = require('../../scripts/modules/stock_match');

const X_API_KEY = process.env.TWITTER_API_IO_KEY || '';

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
      if (/logo|badge|crest|emblem|seal|icon|flag|coat.of.arm|federation|ffm|confederation/i.test(fname)) continue;
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

function normalizeLabels(book) {
  const entity = String(book?.mainEntity || '').trim();
  const type = inferEntityType(book);
  const explicit = Array.isArray(book?.dataLabels) ? book.dataLabels : [];
  const labels = explicit.map((item) => {
    if (typeof item === 'string') return { source: item, entity, type };
    return {
      source: String(item?.source || item?.provider || '').toLowerCase(),
      entity: String(item?.entity || item?.name || entity).trim(),
      type: item?.type || type,
      label: item?.label || '',
    };
  }).filter(item => item.source && item.entity);

  if (labels.length) return labels.slice(0, 3);
  if (!entity) return [];

  // matchcard: SofaScore team は Cloudflare 403 で不安定のため Wikipedia を使用
  const matchHome = String(book?.supplementData?.homeTeam || '').trim();
  const matchAway = String(book?.supplementData?.awayTeam || '').trim();
  if (book?.supplementType === 'matchcard' && matchHome && matchAway) {
    const keyPlayer = String(book?.keyPlayer || '').trim();
    return [
      { source: 'wikipedia', entity: matchHome, type: 'team' },
      { source: 'wikipedia', entity: matchAway, type: 'team' },
      ...(keyPlayer ? [{ source: 'sofascore', entity: keyPlayer, type: 'player' }] : []),
    ].slice(0, 3);
  }

  // subEntities があれば mainEntity + subEntity[0] の 2 エンティティを割り当て
  const subs = Array.isArray(book?.subEntities)
    ? book.subEntities.map(e => String(e || '').trim()).filter(Boolean).slice(0, 1)
    : [];
  if (subs.length) {
    const subType = inferEntityType({ mainEntity: subs[0] });
    return [
      { source: 'sofascore', entity, type },
      { source: 'sofascore', entity: subs[0], type: subType },
      { source: 'wikipedia', entity, type },
    ];
  }

  const defaults = [
    { source: 'sofascore', entity, type },
    ...(type === 'player' ? [{ source: 'transfermarkt', entity, type }] : []),
    { source: 'wikipedia', entity, type },
  ];
  return defaults.slice(0, 3);
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

  // matchcard: X で試合関連画像を追加取得（英語クエリ）
  if (book?.supplementType === 'matchcard') {
    const rawHome = String(book?.supplementData?.homeTeam || '').trim();
    const rawAway = String(book?.supplementData?.awayTeam || '').trim();
    const xQuery = rawHome && rawAway
      ? `${cleanTeamName(rawHome)} ${cleanTeamName(rawAway)}`
      : String(book.mainEntity || book.topic || '').slice(0, 40);
    if (xQuery) {
      const xImgs = await _fetchXTopicImages(xQuery, 8);
      images.push(...xImgs);
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
      if (image.stockProvider === 'sofascore-profile') return 1;
      if (image.source === 'stock' && Number(image.visionScore || 0) >= 90) return 2;
      if (image.source === 'wikipedia') return 3;
      if (image.source === 'x') return 4;
      return 5;
    };
    return priority(a) - priority(b) ||
      Number(b.visionScore || 0) - Number(a.visionScore || 0);
  }).slice(0, 24);

  return {
    ok: true,
    labels: labels.map(item => ({
      ...item,
      label: item.label || labelTitle(item),
    })),
    dataRows: dataRows.slice(0, 24),
    images: uniqueImages,
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
