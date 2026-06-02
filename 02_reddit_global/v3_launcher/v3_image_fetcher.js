// v3_launcher/v3_image_fetcher.js
// V3スライド画像取得 + 自動割当モジュール（改訂版）
//
// 【スライドタイプ別戦略】
//   stats / profile / comparison（選手主役）
//     1. ローカルストック優先（速い・確実）
//     2. 公式X「クラブ名 + 選手名」クエリ → 名前明記ツイート
//     3. 公式X「クラブ名 のみ」取得 → リプ欄名前頻度でスコアアップ
//     4. 汎用X検索「選手名 filter:images」
//     ★ 新規3枚は必ず取得（保険）
//
//   それ以外（opening / insight / history / reaction / ending 等）
//     1. 公式X（最新・高品質）をメイン素材庫
//     2. Wikimedia をサブ（陳腐なため後回し）
//     3. ローカルストック（最終手段）
//
// 【コメント欄スコア】
//   クラブ公式ツイート本文に選手名がなくても
//   conversation_id:TWEET_ID "選手名" のヒット数が多ければ
//   → その画像はその選手のものである確率が高い → スコアボーナス付与

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const TWITTER_BASE = 'https://api.twitterapi.io';
const COMMONS_API  = 'https://commons.wikimedia.org/w/api.php';
const UA_WIKI      = 'soccer-yt-v3-fetcher/1.0 (gagazetmt@gmail.com) axios/1.x';
const IMG_CACHE    = path.join(__dirname, '..', 'images', 'v3_cache');
const TEAM_X_MAP   = path.join(__dirname, '..', 'logos', 'team_x_accounts.json');

// stats/profile/comparison は「選手主役」スライド
const PLAYER_SLIDE_TYPES = new Set(['stats', 'profile', 'comparison']);

// ── トークン節約ゲート ─────────────────────────────────────────────────────
// ストックがこのスコア以上ならXをスキップ（API消費ゼロ）
const STOCK_SKIP_X_THRESHOLD = 80;
// リプ欄スコアはデフォルトOFF（REPLY_SCORE_ENABLED=true で有効化）
// → 有効時は1スライドあたり最大5回追加API消費
const REPLY_SCORE_ENABLED = process.env.REPLY_SCORE_ENABLED === 'true';
// 1動画生成あたりのX API呼び出し上限（超えたらXをスキップ）
const X_CALL_BUDGET = Number(process.env.X_CALL_BUDGET || 12);

// Wikimediaが関連度で負けているか否かを判定する閾値
const STOCK_SKIP_WIKI_THRESHOLD = 75;

if (!fs.existsSync(IMG_CACHE)) fs.mkdirSync(IMG_CACHE, { recursive: true });

// ─── 共通ユーティリティ ────────────────────────────────────────────────────────

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 多点キーワードスコア（0-100）
// 長いキーワードを高ウェイト、フレーズ一致 > 全トークン一致 > 部分一致
function kwScore(keywords, targetText) {
  if (!keywords || !keywords.length || !targetText) return 0;
  const normT  = norm(targetText);
  const wordSet = new Set(normT.split(' ').filter(w => w.length >= 2));
  let totalW = 0, totalS = 0;
  for (const kw of keywords) {
    const nkw    = norm(kw);
    const tokens = nkw.split(' ').filter(w => w.length >= 2);
    const weight = Math.max(1, tokens.length);
    totalW += weight;
    if (!tokens.length) continue;
    if (normT.includes(nkw))                          { totalS += weight * 100; continue; }
    if (tokens.every(t => wordSet.has(t)))            { totalS += weight * 85;  continue; }
    const hits = tokens.filter(t => wordSet.has(t)).length;
    if (hits > 0) totalS += weight * 55 * (hits / tokens.length);
  }
  return totalW > 0 ? Math.min(100, Math.round(totalS / totalW)) : 0;
}

// 配置適合スコア（background→横長 / left→縦長）
function placementFit(w, h, placement) {
  if (!w || !h) return 50;
  const r = w / h;
  return placement === 'background'
    ? (r >= 1.5 ? 85 : r >= 1.2 ? 60 : r >= 1.0 ? 40 : 15)
    : (r <= 0.9 ? 85 : r <= 1.1 ? 65 : r <= 1.3 ? 45 : 25);
}

// twitterAPI.io APIキー確認
function hasXKey() { return Boolean(process.env.TWITTER_API_IO_KEY); }

// チーム名 → @handle 解決
let _teamMap = null;
function resolveHandle(teamName) {
  if (!teamName) return null;
  try {
    if (!_teamMap) _teamMap = JSON.parse(fs.readFileSync(TEAM_X_MAP, 'utf8')).teams || {};
    const lc = teamName.toLowerCase();
    const exact = Object.keys(_teamMap).find(k => k.toLowerCase() === lc);
    if (exact) return _teamMap[exact].handle;
    const keys = Object.keys(_teamMap).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const kl = k.toLowerCase();
      if (lc.includes(kl) || kl.includes(lc)) return _teamMap[k].handle;
    }
  } catch (_) {}
  return null;
}

// ─── X API ヘルパー ──────────────────────────────────────────────────────────

// 1動画生成セッション中のAPI呼び出しカウンター
// fetchAndAssignSlideImages の先頭でリセットされる
let _xCallCount = 0;

async function xSearch(query, queryType = 'Latest', limit = 10, counter = null) {
  if (!hasXKey()) return [];
  const cnt = counter || { n: _xCallCount };
  if (cnt.n >= X_CALL_BUDGET) {
    console.log(`[v3_image_fetcher] X API予算上限(${X_CALL_BUDGET}回)に達したためスキップ: ${query.slice(0, 60)}`);
    return [];
  }
  cnt.n++;
  _xCallCount = cnt.n;
  try {
    const res = await axios.get(TWITTER_BASE + '/twitter/tweet/advanced_search', {
      headers: { 'X-API-Key': process.env.TWITTER_API_IO_KEY },
      params:  { query, queryType },
      timeout: 18000,
    });
    const arr = res.data?.tweets || res.data?.data?.tweets || res.data?.data || [];
    return Array.isArray(arr) ? arr.slice(0, limit) : [];
  } catch (_) {
    return [];
  }
}

// ツイートから画像URLを抽出
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

// ツイートのエンゲージメントスコア（0-20, log scale）
function engScore(tweet) {
  const likes    = tweet.likeCount    || tweet.favorite_count || tweet.likes    || 0;
  const retweets = tweet.retweetCount || tweet.retweet_count  || tweet.retweets || 0;
  const total = likes + retweets;
  return total === 0 ? 0 : Math.min(20, Math.round(Math.log10(total + 1) * 7));
}

// 新しさスコア（0-15）
function recencyScore(tweet) {
  const dateStr = tweet.createdAt || tweet.created_at || tweet.timestamp;
  if (!dateStr) return 5;
  const age = (Date.now() - new Date(dateStr).getTime()) / (1000 * 3600 * 24); // days
  if (age <= 7)  return 15;
  if (age <= 30) return 10;
  if (age <= 90) return 6;
  return 2;
}

// 【核心】コメント欄での選手名頻度スコア（0-20）
// クラブ公式が「無言」で選手写真を上げても
// リプ欄に選手名が多く出れば → 画像はその選手のもの
async function replyNameScore(tweetId, playerName) {
  if (!tweetId || !playerName || !hasXKey()) return 0;
  try {
    // "選手名" が含まれるリプを検索（最新順・上限10件）
    const query   = `conversation_id:${tweetId} "${playerName}"`;
    const replies = await xSearch(query, 'Latest', 10);
    // 1件 = +4点, 上限20点
    return Math.min(20, replies.length * 4);
  } catch (_) {
    return 0;
  }
}

// ─── X 画像ダウンロード ───────────────────────────────────────────────────────

async function downloadX(mediaUrl, destPath) {
  const fullUrl = mediaUrl.includes('?') ? mediaUrl : mediaUrl + '?name=large';
  const res = await axios.get(fullUrl, { responseType: 'arraybuffer', timeout: 14000 });
  fs.writeFileSync(destPath, res.data);
}

// ─── Wikimedia ヘルパー ───────────────────────────────────────────────────────

async function wikiSearch(query, limit = 8) {
  try {
    const res = await axios.get(COMMONS_API, {
      params: {
        action: 'query', generator: 'search',
        gsrsearch: query, gsrnamespace: 6, gsrlimit: Math.max(limit * 2, 10),
        prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata',
        iiurlwidth: 1280, format: 'json',
      },
      headers: { 'User-Agent': UA_WIKI },
      timeout: 10000,
    });
    return Object.values(res.data?.query?.pages || {})
      .map(p => {
        const ii = p.imageinfo?.[0];
        if (!ii) return null;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(ii.mime || '')) return null;
        if ((ii.width || 0) < 400 || (ii.height || 0) < 300) return null;
        const meta  = ii.extmetadata || {};
        const desc  = (meta.ImageDescription?.value || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 200);
        const tags  = (meta.Categories?.value || '')
          .split('|').map(c => c.trim())
          .filter(c => c.length >= 3 && !/^\d{4}$/.test(c) && !/^files/i.test(c))
          .slice(0, 12);
        return {
          source: 'wikimedia',
          thumbUrl: ii.thumburl || ii.url, fullUrl: ii.url,
          width: ii.width || 0, height: ii.height || 0,
          title: (p.title || '').replace(/^File:/, '').replace(/\.[^.]+$/, ''),
          description: desc, tags, query,
        };
      })
      .filter(Boolean)
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

async function downloadWiki(cand, filenameBase) {
  const ext  = cand.thumbUrl?.includes('.png') ? 'png' : 'jpg';
  const safe = filenameBase.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
  const dest = path.join(IMG_CACHE, `${safe}.${ext}`);
  try {
    const res = await axios.get(cand.thumbUrl, {
      responseType: 'arraybuffer', timeout: 14000,
      headers: { 'User-Agent': UA_WIKI },
    });
    fs.writeFileSync(dest, res.data);
    return '/images/v3_cache/' + path.basename(dest);
  } catch (_) {
    return null;
  }
}

// ─── ローカルストック ─────────────────────────────────────────────────────────

function searchStock(keywords, slideType) {
  let sm;
  try { sm = require(path.join(__dirname, '..', 'scripts', 'modules', 'stock_match')); }
  catch (_) { return []; }

  const query = keywords.join(' ');
  // slideTypeで検索タイプを最適化
  const typePrio =
    slideType === 'profile'    ? ['player', 'manager', 'team', 'stadium'] :
    slideType === 'stats'      ? ['player', 'team', 'manager']            :
    slideType === 'comparison' ? ['player', 'manager', 'team']            :
    slideType === 'matchcard'  ? ['team', 'stadium', 'player']            :
    ['player', 'team', 'manager', 'stadium'];

  const seen = new Set();
  const out  = [];
  for (const type of typePrio) {
    for (const h of sm.findStockMatches({ type, entity: query })) {
      if (!h.url || seen.has(h.url)) continue;
      seen.add(h.url);
      out.push({
        source: 'stock', url: h.url,
        stockScore: h.score, width: 0, height: 0,
        title: h.name || '', description: '',
        tags: [h.role, h.name, h.club, h.league].filter(Boolean),
      });
    }
  }
  return out;
}

// ─── X 候補生成（ツイートを画像候補に変換）──────────────────────────────────
// tweet + mediaUrl → candidate オブジェクト
function tweetToCandidate(tweet, mediaUrl, keywords, extraTags = []) {
  const text  = tweet.text || tweet.full_text || tweet.content || '';
  const nameInText = kwScore(keywords, text);
  return {
    source:      'official_x',
    url:         null,          // ダウンロード後に設定
    rawUrl:      mediaUrl,
    width:       0, height:     0,
    title:       text.slice(0, 80),
    description: text,
    tags:        [...extraTags, ...((tweet.entities?.hashtags || []).map(h => h.tag || h.text || ''))],
    tweetId:     tweet.id || tweet.id_str || '',
    tweetDate:   tweet.createdAt || tweet.created_at || '',
    _eng:        engScore(tweet),
    _recency:    recencyScore(tweet),
    _nameInText: nameInText,    // 本文に選手名あり (0-100)
    _replyBonus: 0,             // 後でリプ欄スコアを加算
  };
}

// ─── 選手主役スライド（stats/profile/comparison）向け取得 ────────────────────
// 戦略:
//   A. ストック（優先・即時）
//      → スコア >= STOCK_SKIP_X_THRESHOLD ならXをスキップ（API消費ゼロ）
//   B. 公式X「from:handle "選手名" filter:images」（名前明記）  ← 1回
//   C. 公式Xキャッシュ × リプ欄スコア（REPLY_SCORE_ENABLED=true 時のみ）
//   D. 汎用X「選手名 filter:images」（B+Cで3枚未満の保険）     ← 1回
//   ★ X合計: 通常2回 / リプ有効時 最大7回

async function fetchPlayerFocused(keywords, slideNo, _sessionCache) {
  const playerName = keywords[0] || '';
  const teamName   = keywords.find(k => k !== playerName && k.length > 2) || '';
  const handle     = resolveHandle(teamName);

  const stockCands = searchStock(keywords, 'profile');
  const bestStock  = stockCands.length ? Math.max(...stockCands.map(c => c.stockScore || 0)) : 0;

  // ── ゲート: ストックが十分ならXをスキップ ────────────────────────────
  if (bestStock >= STOCK_SKIP_X_THRESHOLD || !hasXKey()) {
    if (bestStock >= STOCK_SKIP_X_THRESHOLD) {
      console.log(`[v3_image_fetcher] ストック高スコア(${bestStock})→Xスキップ: ${playerName}`);
    }
    return { stockCands, xCands: [] };
  }

  const xCands   = [];
  const seenUrls = new Set();

  // ── B: 公式X × 選手名明記（1回）─────────────────────────────────────
  if (handle) {
    const qByName = `from:${handle} "${playerName}" filter:images -filter:retweets`;
    const tweets  = await xSearch(qByName, 'Top', 8);
    for (const tweet of tweets) {
      for (const mu of extractMedia(tweet)) {
        if (seenUrls.has(mu)) continue;
        seenUrls.add(mu);
        xCands.push(tweetToCandidate(tweet, mu, keywords));
      }
    }
  }

  // ── C: リプ欄スコア（REPLY_SCORE_ENABLED=true 時のみ・最大5回追加）──
  if (REPLY_SCORE_ENABLED && handle && xCands.length < 3) {
    // キャッシュ済みならAPIを叩かない
    const cacheKey = `official_${handle}`;
    if (!_sessionCache[cacheKey]) {
      const q = `from:${handle} filter:images -filter:retweets`;
      _sessionCache[cacheKey] = await xSearch(q, 'Top', 12);
    }
    const allTweets = _sessionCache[cacheKey];
    const nameless  = allTweets
      .filter(t => !norm(t.text || '').includes(norm(playerName)))
      .slice(0, 5);
    const replyScores = await Promise.all(
      nameless.map(t => replyNameScore(t.id || t.id_str, playerName))
    );
    for (let i = 0; i < nameless.length; i++) {
      if (replyScores[i] < 4) continue;
      for (const mu of extractMedia(nameless[i])) {
        if (seenUrls.has(mu)) continue;
        seenUrls.add(mu);
        const cand = tweetToCandidate(nameless[i], mu, keywords);
        cand._replyBonus = replyScores[i];
        xCands.push(cand);
      }
    }
  }

  // ── D: 汎用X検索（保険・3枚未満の時だけ・1回）──────────────────────
  if (xCands.length < 3 && playerName) {
    const q    = `"${playerName}" filter:images -is:reply -filter:retweets`;
    const twts = await xSearch(q, 'Latest', 10);
    for (const tweet of twts) {
      if (xCands.length >= 8) break;
      for (const mu of extractMedia(tweet)) {
        if (seenUrls.has(mu)) continue;
        seenUrls.add(mu);
        xCands.push(tweetToCandidate(tweet, mu, keywords));
      }
    }
  }

  return { stockCands, xCands };
}

// ─── 文脈スライド（opening/insight/history/reaction/ending等）向け取得 ────────
// 戦略:
//   1. 公式X（最新・最高品質）をメイン
//   2. Wikimedia（サブ・陳腐ぎみなので後回し）
//   3. ストック（最終手段）

async function fetchContextFocused(keywords, slideType, slideNo, _sessionCache) {
  const query    = keywords.slice(0, 3).join(' ');
  const xCands   = [];
  const seenUrls = new Set();

  if (hasXKey()) {
    // 汎用X検索（最新画像・1回）
    const q1     = `${query} filter:images -is:reply -filter:retweets`;
    const tweets = await xSearch(q1, 'Latest', 12);
    for (const tweet of tweets) {
      if (xCands.length >= 10) break;
      for (const mu of extractMedia(tweet)) {
        if (seenUrls.has(mu)) continue;
        seenUrls.add(mu);
        xCands.push(tweetToCandidate(tweet, mu, keywords));
      }
    }

    // 公式アカウント（キャッシュ済みなら0回・なければ1回）
    const handle = resolveHandle(keywords.find(k => k.length > 3) || '');
    if (handle && xCands.length < 5) {
      const cacheKey = `official_${handle}`;
      if (!_sessionCache[cacheKey]) {
        const q2 = `from:${handle} filter:images -filter:retweets`;
        _sessionCache[cacheKey] = await xSearch(q2, 'Top', 12);
      }
      for (const tweet of _sessionCache[cacheKey]) {
        if (xCands.length >= 10) break;
        for (const mu of extractMedia(tweet)) {
          if (seenUrls.has(mu)) continue;
          seenUrls.add(mu);
          xCands.push(tweetToCandidate(tweet, mu, keywords));
        }
      }
    }
  }

  // Wikimedia（Xが少ない時だけ・サブ）
  const wikiCands = [];
  if (xCands.length < 4) {
    const wikiMeta = await wikiSearch(keywords.slice(0, 2).join(' '), 6);
    wikiCands.push(...wikiMeta);
  }

  // ストック（最終手段）
  const stockCands = xCands.length < 3 ? searchStock(keywords, slideType) : [];

  return { xCands, wikiCands, stockCands };
}

// ─── 候補の総合スコア計算 ─────────────────────────────────────────────────────
function computeScore(cand, keywords, descWords, placement) {
  const allText = [cand.title, cand.description, ...(cand.tags || [])].join(' ');
  const kw      = kwScore(keywords, allText);
  const desc    = kwScore(descWords, allText);
  const fit     = placementFit(cand.width, cand.height, placement);

  if (cand.source === 'stock') {
    return Math.round(kw * 0.45 + (cand.stockScore || 0) * 0.30 + fit * 0.15 + desc * 0.10);
  }
  if (cand.source === 'official_x') {
    const nameTxt = cand._nameInText  || 0;
    const reply   = cand._replyBonus  || 0;
    const eng     = cand._eng         || 0;
    const rec     = cand._recency     || 0;
    return Math.round(
      kw      * 0.30 +
      nameTxt * 0.25 + // 本文に選手名あり → 重視
      reply   * 0.20 + // リプ欄名前頻度ボーナス
      fit     * 0.10 +
      eng     * 0.10 +
      rec     * 0.05
    );
  }
  // wikimedia
  return Math.round(kw * 0.50 + desc * 0.20 + fit * 0.20 + 10 * 0.10);
}

// ─── 画像DL（X or Wiki）─────────────────────────────────────────────────────
async function downloadCandidate(cand, filenameBase) {
  if (cand.source === 'stock') return cand.url; // ストックはDL不要

  if (cand.source === 'official_x') {
    const rawUrl = cand.rawUrl;
    if (!rawUrl) return null;
    const fullUrl = rawUrl.includes('?') ? rawUrl : rawUrl + '?name=large';
    const ext    = rawUrl.includes('.png') ? 'png' : 'jpg';
    const dest   = path.join(IMG_CACHE, filenameBase.slice(0, 60).replace(/[^a-z0-9_-]/gi, '_') + '.' + ext);
    try {
      const res = await axios.get(fullUrl, { responseType: 'arraybuffer', timeout: 14000 });
      fs.writeFileSync(dest, res.data);
      return '/images/v3_cache/' + path.basename(dest);
    } catch (_) { return null; }
  }

  if (cand.source === 'wikimedia') {
    return downloadWiki(cand, filenameBase);
  }

  return null;
}

// ─── ベスト候補を1枚選んでDL → URL返却 ─────────────────────────────────────
async function pickAndDownload(candidates, keywords, descWords, placement, slideNo, suffix, usedUrls) {
  const scored = candidates
    .map(c => ({ ...c, _score: computeScore(c, keywords, descWords, placement) }))
    .sort((a, b) => b._score - a._score);

  for (const cand of scored) {
    // ストックはURLが確定済み
    if (cand.source === 'stock') {
      if (!cand.url || usedUrls.has(cand.url)) continue;
      return { url: cand.url, cand };
    }
    // X / Wiki はDL
    const base   = `v3s${slideNo}${suffix}_${norm((keywords[0] || 'img')).split(' ').slice(0, 2).join('_')}`;
    const dlUrl  = await downloadCandidate(cand, base + '_' + String(usedUrls.size));
    if (!dlUrl || usedUrls.has(dlUrl)) continue;
    return { url: dlUrl, cand: { ...cand, url: dlUrl } };
  }
  return { url: null, cand: null };
}

// ─── メインエクスポート ───────────────────────────────────────────────────────
// slides: { no, slideType, imageInstruction }[]
// 返り値: slides に images[], imageCandidates[] を付与

async function fetchAndAssignSlideImages(slides, _opts = {}) {
  // セッション開始: APIカウンターリセット + 公式アカウントのツイートキャッシュ初期化
  _xCallCount = 0;
  const sessionCache = {}; // { 'official_LFC': [tweets...], ... }

  const usedUrls = new Set();
  const result   = [];

  // 全スライドを並列で候補フェッチ（IO待ち最小化）
  const BATCH = 4;
  const fetchTasks = slides.map(slide => async () => {
    const inst      = slide.imageInstruction || {};
    const placement = inst.placement || 'background';
    const isPlayer  = PLAYER_SLIDE_TYPES.has(slide.slideType);

    if (placement === 'left+right') {
      const leftKw  = inst.left?.searchKeywords  || [];
      const rightKw = inst.right?.searchKeywords || [];
      const [lData, rData] = await Promise.all([
        isPlayer
          ? fetchPlayerFocused(leftKw,  slide.no, sessionCache)
          : fetchContextFocused(leftKw,  slide.slideType, slide.no, sessionCache),
        isPlayer
          ? fetchPlayerFocused(rightKw, slide.no, sessionCache)
          : fetchContextFocused(rightKw, slide.slideType, slide.no, sessionCache),
      ]);
      return { slide, placement, isPlayer, isComparison: true, leftKw, rightKw, lData, rData };
    }

    const keywords = inst.searchKeywords || [];
    const data = isPlayer
      ? await fetchPlayerFocused(keywords, slide.no, sessionCache)
      : await fetchContextFocused(keywords, slide.slideType, slide.no, sessionCache);
    return { slide, placement, isPlayer, isComparison: false, keywords, data,
      descWords: (inst.description || '').split(/\s+/).filter(w => w.length >= 3).slice(0, 8) };
  });

  // バッチ並列実行
  const allFetched = [];
  for (let i = 0; i < fetchTasks.length; i += BATCH) {
    const batch = fetchTasks.slice(i, i + BATCH).map(t => t());
    allFetched.push(...await Promise.all(batch));
  }

  // 割当（順番に処理してURL重複を防ぐ）
  for (const task of allFetched) {
    const { slide, placement, isPlayer } = task;

    if (task.isComparison) {
      // left+right はそれぞれ独立して割当
      const allLeft  = buildCandPool(task.lData, isPlayer);
      const allRight = buildCandPool(task.rData, isPlayer);
      const { url: lUrl } = await pickAndDownload(allLeft,  task.leftKw,  [], 'left',  slide.no, 'L', usedUrls);
      if (lUrl) usedUrls.add(lUrl);
      const { url: rUrl } = await pickAndDownload(allRight, task.rightKw, [], 'right', slide.no, 'R', usedUrls);
      if (rUrl) usedUrls.add(rUrl);
      result.push({ ...slide, images: [lUrl, rUrl].filter(Boolean), imageCandidates: [] });
      continue;
    }

    const { keywords, data, descWords } = task;
    const allCands = buildCandPool(data, isPlayer);
    const { url, cand } = await pickAndDownload(allCands, keywords, descWords, placement, slide.no, '', usedUrls);
    if (url) usedUrls.add(url);

    // 候補一覧（UI用・スコア上位8件）
    const scored = allCands
      .map(c => ({ ...c, _score: computeScore(c, keywords, descWords, placement) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);

    const imageCandidates = await buildCandidateList(scored, slide.no, keywords, usedUrls);

    result.push({
      ...slide,
      images: url ? [url] : [],
      imageCandidates,
    });
  }

  return result;
}

// 候補プールを作成（isPlayerか否かでソース優先順を変える）
function buildCandPool(data, isPlayer) {
  if (isPlayer) {
    // 選手主役: ストック最優先、次にX、Wikiはあれば
    return [
      ...(data.stockCands || []),
      ...(data.xCands     || []),
      ...(data.wikiCands  || []),
    ];
  }
  // 文脈: X最優先、Wikiサブ、ストック最後
  return [
    ...(data.xCands     || []),
    ...(data.wikiCands  || []),
    ...(data.stockCands || []),
  ];
}

// UI表示用の候補リスト（X/WikiはURLだけ・DL不要）
async function buildCandidateList(scored, slideNo, keywords, usedUrls) {
  const list = [];
  for (const cand of scored) {
    const rawUrl = cand.url || cand.rawUrl || cand.thumbUrl || cand.fullUrl || '';
    if (!rawUrl) continue;
    list.push({
      url:    rawUrl,
      score:  cand._score || 0,
      source: cand.source || 'unknown',
      title:  cand.title  || '',
      tags:   cand.tags   || [],
    });
  }
  return list;
}

module.exports = { fetchAndAssignSlideImages, kwScore };
