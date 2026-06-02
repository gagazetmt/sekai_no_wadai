// scripts/warehouse_fetch.js
// クラブ公式X から画像を warehouse/pending/ にダウンロード
//
// 2クエリ戦略:
//   ① from:{handle} {shortName} filter:images   → 名前直撃 20枚
//   ③ from:{handle} filter:images since:30日前  → 直近いいね上位 20枚
//
// 使い方（モジュール）:
//   const { fetchToWarehouse } = require('./warehouse_fetch');
//   await fetchToWarehouse({ playerName: 'Andrew Robertson', clubName: 'Liverpool' });
//
// 使い方（CLI）:
//   node scripts/warehouse_fetch.js "Andrew Robertson" "Liverpool"

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const PENDING_DIR  = path.join(__dirname, '..', 'images', 'warehouse', 'pending');
const TWITTER_BASE = 'https://api.twitterapi.io';
const TEAM_X_MAP   = path.join(__dirname, '..', 'logos', 'team_x_accounts.json');

[PENDING_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── チーム名 → Xハンドル ─────────────────────────────────────────────────────
function resolveHandle(clubName) {
  try {
    const map   = JSON.parse(fs.readFileSync(TEAM_X_MAP, 'utf8'));
    const teams = map.teams || {};
    const lc    = (clubName || '').toLowerCase();
    const exact = Object.keys(teams).find(k => k.toLowerCase() === lc);
    if (exact) return { handle: teams[exact].handle, league: teams[exact].league || '' };
    const keys  = Object.keys(teams).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const kl = k.toLowerCase();
      if (lc.includes(kl) || kl.includes(lc)) return { handle: teams[k].handle, league: teams[k].league || '' };
    }
  } catch (_) {}
  return { handle: null, league: '' };
}

// ── YYYY-MM-DD (N日前) ────────────────────────────────────────────────────────
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// ── X API 検索 ────────────────────────────────────────────────────────────────
async function xSearch(query, queryType, limit) {
  if (!process.env.TWITTER_API_IO_KEY) { console.warn('[warehouse_fetch] TWITTER_API_IO_KEY 未設定'); return []; }
  try {
    const res = await axios.get(TWITTER_BASE + '/twitter/tweet/advanced_search', {
      headers: { 'X-API-Key': process.env.TWITTER_API_IO_KEY },
      params:  { query, queryType },
      timeout: 20000,
    });
    const arr = res.data?.tweets || res.data?.data?.tweets || res.data?.data || [];
    return Array.isArray(arr) ? arr.slice(0, limit) : [];
  } catch (e) {
    console.warn(`[warehouse_fetch] xSearch error: ${e.message}`);
    return [];
  }
}

// ── ツイートから画像URLを抽出 ────────────────────────────────────────────────
function extractMedia(tweet) {
  const sources = [
    tweet.extendedEntities?.media,
    tweet.extended_entities?.media,
    tweet.entities?.media,
    Array.isArray(tweet.media) ? tweet.media : null,
  ].filter(Boolean);
  const urls = [];
  for (const arr of sources) {
    for (const m of arr) {
      if ((m.type || '').toLowerCase() !== 'photo') continue;
      const url = m.media_url_https || m.mediaUrlHttps || m.media_url || m.url;
      if (url && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

// ── 画像DL ────────────────────────────────────────────────────────────────────
async function downloadOne(url, dest) {
  const fullUrl = url.includes('?') ? url : url + '?name=large';
  const res = await axios.get(fullUrl, { responseType: 'arraybuffer', timeout: 14000 });
  fs.writeFileSync(dest, res.data);
}

// ── メイン ────────────────────────────────────────────────────────────────────
// returns: 保存したローカルパス[]
async function fetchToWarehouse({ playerName, clubName, handle: overrideHandle } = {}) {
  const { handle, league } = overrideHandle
    ? { handle: overrideHandle, league: '' }
    : resolveHandle(clubName);

  if (!handle) {
    console.warn(`[warehouse_fetch] "${clubName}" のXハンドルが見つかりません`);
    return [];
  }

  // 短い名前（姓のみ）: "Andrew Robertson" → "Robertson"
  const shortName = (playerName || '').trim().split(/\s+/).pop();
  const since30   = daysAgo(30);

  const queries = [
    // ① 名前直撃
    { q: `from:${handle} ${shortName} filter:images -filter:retweets`,          type: 'Latest', limit: 20, label: 'name_search' },
    // ③ 直近30日いいね上位
    { q: `from:${handle} filter:images -filter:retweets since:${since30}`,       type: 'Top',    limit: 20, label: 'recent_top'  },
  ];

  const saved    = [];
  const seenUrls = new Set();

  for (const { q, type, limit, label } of queries) {
    console.log(`[warehouse_fetch] 検索: ${q.slice(0, 70)}`);
    const tweets = await xSearch(q, type, limit);

    for (const tweet of tweets) {
      for (const url of extractMedia(tweet)) {
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);

        const tweetId = tweet.id || tweet.id_str || `${Date.now()}`;
        const ext     = url.includes('.png') ? 'png' : 'jpg';
        const fname   = `${handle}_${tweetId}.${ext}`;
        const dest    = path.join(PENDING_DIR, fname);

        // 既DL済みはスキップ
        if (fs.existsSync(dest)) { saved.push(dest); continue; }

        try {
          await downloadOne(url, dest);
          // メタデータを {fname}.json に保存
          const meta = {
            originalUrl:     url,
            tweetId,
            tweetDate:       tweet.createdAt || tweet.created_at || '',
            tweetText:       (tweet.text || tweet.full_text || '').slice(0, 200),
            engagementScore: (tweet.likeCount || tweet.favorite_count || 0)
                           + (tweet.retweetCount || tweet.retweet_count || 0),
            searchLabel:     label,
            handle,
            playerHint:      playerName || '',
            clubHint:        clubName   || '',
            leagueHint:      league,
            downloadedAt:    new Date().toISOString(),
          };
          fs.writeFileSync(dest.replace(/\.(jpg|png)$/, '.json'), JSON.stringify(meta, null, 2));
          saved.push(dest);
          console.log(`  → DL: ${fname}`);
        } catch (e) {
          console.warn(`  → DL失敗: ${e.message}`);
        }
      }
    }
  }

  console.log(`[warehouse_fetch] 完了: ${playerName} (${handle}) → ${saved.length}枚`);
  return saved;
}

module.exports = { fetchToWarehouse, resolveHandle };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [,, playerName, clubName] = process.argv;
  if (!playerName || !clubName) {
    console.error('使い方: node scripts/warehouse_fetch.js "選手名" "クラブ名"');
    process.exit(1);
  }
  fetchToWarehouse({ playerName, clubName })
    .then(paths => { console.log(`完了: ${paths.length}枚`); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}
