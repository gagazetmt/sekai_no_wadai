// launcher/fetchers/x_images.js
// TwitterAPI.io で公式アカウントから画像URLを取得（ダウンロードなし）
// exports: resolveHandle(name), fetchImagesForLabels(labels)

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs   = require('fs');
const path = require('path');

const API_KEY       = process.env.TWITTER_API_IO_KEY;
const BASE_URL      = 'https://api.twitterapi.io';
const ACCOUNT_MAP   = JSON.parse(fs.readFileSync(path.join(__dirname, 'team_x_accounts.json'), 'utf8'));
const TEAMS         = ACCOUNT_MAP.teams || {};

// ── ハンドル解決 ──────────────────────────────────────────
function resolveHandle(name) {
  if (!name) return null;
  // 完全一致
  if (TEAMS[name]) return TEAMS[name].handle;
  // 大文字小文字無視
  const lower = name.toLowerCase();
  const exact = Object.keys(TEAMS).find(k => k.toLowerCase() === lower);
  if (exact) return TEAMS[exact].handle;
  // 部分一致（長いキーから優先）
  const keys = Object.keys(TEAMS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (lower.includes(kl) || kl.includes(lower)) return TEAMS[k].handle;
  }
  return null;
}

// ── ツイートからメディアURL抽出 ───────────────────────────
function extractMediaUrls(tweet) {
  const urls = [];
  const sources = [
    tweet.extendedEntities?.media,
    tweet.extended_entities?.media,
    tweet.entities?.media,
    Array.isArray(tweet.media) ? tweet.media : null,
  ].filter(Boolean);
  for (const arr of sources) {
    for (const m of arr) {
      if ((m.type || '').toLowerCase() !== 'photo') continue;
      const url = m.media_url_https || m.mediaUrlHttps || m.media_url || m.url;
      if (url && !urls.includes(url)) urls.push(url + '?name=large');
    }
  }
  return urls;
}

// ── TwitterAPI.io 検索 ────────────────────────────────────
async function searchTweets(query, queryType = 'Top') {
  if (!API_KEY) { console.warn('  [x_images] TWITTER_API_IO_KEY not set'); return []; }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(BASE_URL + '/twitter/tweet/advanced_search?' + new URLSearchParams({ query, queryType }), {
        headers: { 'X-API-Key': API_KEY },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const tweets = data?.tweets || data?.data?.tweets || data?.data || [];
      return Array.isArray(tweets) ? tweets : [];
    } catch (e) {
      if (attempt === 2) { console.warn(`  [x_images] search failed: ${e.message}`); return []; }
      console.warn(`  [x_images] retry (${attempt}/2): ${e.message}`);
    }
  }
  return [];
}

// ── ハンドル × オプション → 画像URL配列 ─────────────────
// opts: { keyword, since, until, sortBy: 'engagement'|'recency' }
async function fetchImagesFromHandle(handle, opts = {}) {
  if (!handle) return [];
  let query = `from:${handle} filter:images -filter:retweets`;
  if (opts.keyword) query += ` "${opts.keyword}"`;
  if (opts.since)   query += ` since:${opts.since}`;
  if (opts.until)   query += ` until:${opts.until}`;

  const queryType = opts.sortBy === 'recency' ? 'Latest' : 'Top';
  const tweets    = await searchTweets(query, queryType);

  // ソート
  if (opts.sortBy === 'recency') {
    tweets.sort((a, b) => {
      const tA = new Date(a.createdAt || a.created_at || 0).getTime();
      const tB = new Date(b.createdAt || b.created_at || 0).getTime();
      return tB - tA;
    });
  } else {
    tweets.sort((a, b) => {
      const eng = t => (t.likeCount || t.favorite_count || t.likes || 0) + (t.retweetCount || t.retweet_count || t.retweets || 0);
      return eng(b) - eng(a);
    });
  }

  const limit = opts.limit || 10;
  const urls  = [];
  const seen  = new Set();
  for (const tw of tweets) {
    if (urls.length >= limit) break;
    for (const url of extractMediaUrls(tw)) {
      if (urls.length >= limit) break;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

// ── ラベル配列 → 画像URL一覧 ─────────────────────────────
// label: { type: 'match'|'team'|'player', name?, homeTeam?, awayTeam?, matchDate?, team? }
// 戻り値: [{ url, source, label }]
async function fetchImagesForLabels(labels, opts = {}) {
  if (!API_KEY || !labels?.length) return [];

  const PER_LABEL      = opts.perLabel      || 8;   // 関連度上位 件数
  const PER_LABEL_NEW  = opts.perLabelNew   || 7;   // 最新 件数
  const results        = [];
  const seenUrls       = new Set();

  function addImages(urls, source) {
    for (const url of urls) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      results.push({ url, source });
    }
  }

  for (const label of labels) {
    if (label.type === 'match') {
      // home + away それぞれの公式アカウントから試合前後の画像
      const teams = [
        { name: label.homeTeam, prefix: 'home' },
        { name: label.awayTeam, prefix: 'away' },
      ].filter(t => t.name);

      for (const t of teams) {
        const handle = resolveHandle(t.name);
        if (!handle) { console.log(`  [x_images] no handle for: ${t.name}`); continue; }

        // 試合日前後の窓
        let since, until;
        if (label.matchDate) {
          const ko = new Date(label.matchDate);
          since = new Date(ko.getTime() - 2 * 86400000).toISOString().slice(0, 10);
          until = new Date(ko.getTime() + 2 * 86400000).toISOString().slice(0, 10);
        }

        // 関連度上位
        const top = await fetchImagesFromHandle(handle, { since, until, sortBy: 'engagement', limit: PER_LABEL });
        addImages(top, `@${handle} (match/top)`);

        // 最新
        const latest = await fetchImagesFromHandle(handle, { since, until, sortBy: 'recency', limit: PER_LABEL_NEW });
        addImages(latest, `@${handle} (match/latest)`);
      }

    } else if (label.type === 'team') {
      const handle = resolveHandle(label.name);
      if (!handle) { console.log(`  [x_images] no handle for team: ${label.name}`); continue; }

      // 最新15件を優先取得、エンゲージメント上位5件をボーナスで追加
      const latest = await fetchImagesFromHandle(handle, { sortBy: 'recency',    limit: 15 });
      const top    = await fetchImagesFromHandle(handle, { sortBy: 'engagement', limit: 5  });
      addImages(latest, `@${handle} (team/latest)`);
      addImages(top,    `@${handle} (team/top)`);

    } else if (label.type === 'player') {
      // 所属クラブの公式アカウントから選手名を含む投稿
      const handle = resolveHandle(label.team);
      if (handle && label.name) {
        const top    = await fetchImagesFromHandle(handle, { keyword: label.name, sortBy: 'engagement', limit: PER_LABEL });
        const latest = await fetchImagesFromHandle(handle, { keyword: label.name, sortBy: 'recency',    limit: PER_LABEL_NEW });
        addImages(top,    `@${handle} (player=${label.name}/top)`);
        addImages(latest, `@${handle} (player=${label.name}/latest)`);
      }
      // 代表チームからも取得
      if (label.nationalTeam) {
        const ntHandle = resolveHandle(label.nationalTeam);
        if (ntHandle) {
          const ntTop = await fetchImagesFromHandle(ntHandle, { keyword: label.name, sortBy: 'engagement', limit: 5 });
          addImages(ntTop, `@${ntHandle} (player=${label.name}/nt)`);
        }
      }
      // クラブが不明 or 取得0件の場合: 選手名で直接検索 → 最新15件
      if (label.name) {
        const beforeCount = results.length;
        const direct = await searchTweets(`"${label.name}" filter:images -filter:retweets`, 'Latest');
        direct.sort((a, b) => new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0));
        const directUrls = [];
        const directSeen = new Set();
        for (const tw of direct) {
          if (directUrls.length >= 15) break;
          for (const url of extractMediaUrls(tw)) {
            if (directUrls.length >= 15) break;
            if (!directSeen.has(url)) { directSeen.add(url); directUrls.push(url); }
          }
        }
        addImages(directUrls, `X検索:${label.name}`);
        console.log(`  [x_images] player direct search "${label.name}": ${results.length - beforeCount}件追加`);
      }
    }
  }

  console.log(`  [x_images] total: ${results.length} images from ${labels.length} labels`);
  return results;
}

module.exports = { resolveHandle, fetchImagesForLabels };
