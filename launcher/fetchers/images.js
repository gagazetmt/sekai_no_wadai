// launcher/fetchers/images.js
// 選手画像取得: 所属クラブ + 代表の公式Xアカウントから検索
// 関連度 × 新しさ順で最適な1枚を選定 → data URI で返す

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { curlGetImage } = require('./_curl_cffi_caller');
const { searchFotMob }  = require('./fotmob_career');

const X_API_KEY = process.env.TWITTER_API_IO_KEY || '';

// ── チーム名 → 公式Xハンドル ──────────────────────────
// FotMob が返す英語チーム名でマッチ（部分一致）

const TEAM_HANDLES = {
  // === 代表チーム ===
  'japan':       ['SAMURAIBLUE_JFA', 'JFA'],
  'brazil':      ['CBF_Futebol'],
  'argentina':   ['Argentina'],
  'france':      ['FrenchTeam'],
  'england':     ['England'],
  'germany':     ['DFB_Team_EN'],
  'spain':       ['SEFutbol'],
  'portugal':    ['selecaoportugal'],
  'italy':       ['Azzurri'],
  'netherlands': ['OnsOranje'],
  'belgium':     ['BelRedDevils'],
  'croatia':     ['HNS_CFF'],
  'uruguay':     ['Uruguay'],
  'colombia':    ['FCFSeleccionCol'],
  'mexico':      ['miseleccionmx'],
  'usa':         ['USMNT'],
  'south korea': ['theKFA'],
  'korea':       ['theKFA'],
  'senegal':     ['FSF_Officiel'],
  'morocco':     ['EnMaroc'],
  'australia':   ['Socceroos'],
  'canada':      ['CanadaSoccerEN'],
  'saudi arabia':['SaudiNT'],
  'nigeria':     ['NGSuperEagles'],
  'wales':       ['Cymru'],
  'poland':      ['LaczyNasPilka'],
  'denmark':     ['DBUfodbold'],
  'chile':       ['LaRoja'],
  'peru':        ['SeleccionPeru'],

  // === プレミアリーグ ===
  'manchester city':  ['ManCity'],
  'man city':         ['ManCity'],
  'arsenal':          ['Arsenal'],
  'liverpool':        ['LFC'],
  'chelsea':          ['ChelseaFC'],
  'manchester united':['ManUtd'],
  'man utd':          ['ManUtd'],
  'tottenham':        ['SpursOfficial'],
  'newcastle':        ['NUFC'],
  'brighton':         ['OfficialBHAFC'],
  'aston villa':      ['AVFCOfficial'],
  'west ham':         ['WestHam'],
  'crystal palace':   ['CPFC'],
  'fulham':           ['FulhamFC'],
  'wolves':           ['Wolves'],
  'wolverhampton':    ['Wolves'],
  'everton':          ['Everton'],
  'bournemouth':      ['AFCBournemouth'],
  'nottingham forest':['NFFC'],
  'brentford':        ['BrentfordFC'],
  'leicester':        ['LCFC'],
  'ipswich':          ['IpswichTown'],

  // === ラ・リーガ ===
  'real madrid':  ['realmadrid'],
  'barcelona':    ['FCBarcelona'],
  'atletico madrid':['atletienglish'],
  'real sociedad':['RealSociedad'],
  'athletic bilbao':['AthleticClub'],
  'athletic club':['AthleticClub'],
  'villarreal':   ['VillarrealCF'],
  'real betis':   ['RealBetis'],
  'sevilla':      ['SevillaFC_ENG'],
  'girona':       ['GironaFC'],
  'valencia':     ['ValenciaCF_en'],

  // === セリエA ===
  'inter':        ['Inter_en'],
  'inter milan':  ['Inter_en'],
  'ac milan':     ['acmilan'],
  'milan':        ['acmilan'],
  'juventus':     ['juventusfcen'],
  'napoli':       ['sscnapoli'],
  'atalanta':     ['Atalanta_BC'],
  'roma':         ['ASRomaEN'],
  'as roma':      ['ASRomaEN'],
  'lazio':        ['OfficialSSLazio'],
  'fiorentina':   ['ACFFiorentina'],

  // === ブンデスリーガ ===
  'bayern munich':  ['FCBayernEN'],
  'bayern':         ['FCBayernEN'],
  'borussia dortmund':['BVB'],
  'dortmund':       ['BVB'],
  'rb leipzig':     ['RBLeipzig_EN'],
  'leipzig':        ['RBLeipzig_EN'],
  'bayer leverkusen':['bayer04_en'],
  'leverkusen':     ['bayer04_en'],
  'eintracht frankfurt':['Eintracht_ENG'],
  'stuttgart':      ['VfB'],
  'wolfsburg':      ['VfLWolfsburg_EN'],
  'freiburg':       ['SCFreiburg'],

  // === リーグ・アン ===
  'psg':            ['PSG_English'],
  'paris saint-germain':['PSG_English'],
  'marseille':      ['OM_English'],
  'lyon':           ['OL_English'],
  'monaco':         ['AS_Monaco_EN'],
  'lille':          ['LOSC_EN'],

  // === その他主要クラブ ===
  'porto':          ['FCPorto'],
  'benfica':        ['SLBenfica'],
  'sporting':       ['Sporting_CP'],
  'ajax':           ['AFCAjax'],
  'psv':            ['PSV'],
  'celtic':         ['CelticFC'],
  'rangers':        ['RangersFC'],
  'galatasaray':    ['GalatasaraySK'],
  'fenerbahce':     ['Fenerbahce'],
  'al hilal':       ['Alhilal_EN'],
  'al nassr':       ['AlNassrFC'],
  'flamengo':       ['Flamengo_en'],

  // === Jリーグ（W杯関連） ===
  'vissel kobe':    ['visselkobe'],
};

// ── チーム名の正規化＆ハンドル検索 ──────────────────────

function _normalizeTeam(name) {
  return String(name || '').toLowerCase()
    .replace(/\s*fc\s*$/i, '')
    .replace(/\s*cf\s*$/i, '')
    .trim();
}

function getHandles(teamName) {
  if (!teamName) return [];
  const norm = _normalizeTeam(teamName);
  if (TEAM_HANDLES[norm]) return TEAM_HANDLES[norm];
  for (const [key, handles] of Object.entries(TEAM_HANDLES)) {
    if (norm.includes(key) || key.includes(norm)) return handles;
  }
  return [];
}

// ── TwitterAPI.io で画像付きツイートを検索 ───────────────

function _extractImageUrls(tweet) {
  const urls = [];
  const media = tweet.extendedEntities?.media
    || tweet.entities?.media
    || tweet.media
    || [];
  for (const m of (Array.isArray(media) ? media : [])) {
    if (m.type === 'video' || m.type === 'animated_gif') continue;
    const url = m.media_url_https || m.media_url || m.url;
    if (url && /pbs\.twimg\.com/.test(url)) {
      urls.push(url.replace(/\?.*$/, '') + '?format=jpg&name=large');
    }
  }
  if (!urls.length && tweet.photos) {
    for (const p of tweet.photos) {
      if (p.url) urls.push(p.url);
    }
  }
  return urls;
}

async function searchXImages(playerName, handles, limit = 5) {
  if (!X_API_KEY || !handles.length) return [];

  const results = [];
  for (const handle of handles.slice(0, 2)) {
    try {
      const query = `from:${handle} ${playerName} filter:images -filter:retweets`;
      console.log(`  [images/x] 検索: "${query}"`);
      const res = await fetch(
        'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
        new URLSearchParams({ query, queryType: 'Latest' }),
        { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) { console.warn(`  [images/x] ${handle} → ${res.status}`); continue; }

      const data = await res.json();
      const tweets = data?.data?.tweets || data?.tweets || [];

      for (const t of tweets.slice(0, limit)) {
        const imageUrls = _extractImageUrls(t);
        if (!imageUrls.length) continue;
        const textLower = (t.text || t.full_text || '').toLowerCase();
        const nameLower = playerName.toLowerCase();
        const nameWords = nameLower.split(/\s+/);
        const relevance = nameWords.filter(w => textLower.includes(w)).length / nameWords.length;
        results.push({
          imageUrl: imageUrls[0],
          relevance,
          createdAt: t.created_at || t.createdAt || '',
          handle,
          text: (t.text || '').slice(0, 80),
        });
      }
    } catch (e) {
      console.warn(`  [images/x] ${handle} 失敗: ${e.message}`);
    }
  }

  results.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  return results;
}

// ── 画像ダウンロード → data URI ─────────────────────────

async function downloadAsDataUri(imageUrl) {
  if (!imageUrl) return null;
  try {
    const dataUri = await curlGetImage(imageUrl, {
      referer: 'https://x.com/',
      useProxy: false,
      timeout: 15,
    });
    return dataUri;
  } catch (e) {
    console.warn(`  [images] download failed: ${e.message}`);
    return null;
  }
}

// ── チーム画像: 公式Xの最新画像 ─────────────────────────

async function fetchTeamImage(teamName) {
  const handles = getHandles(teamName);
  if (!handles.length) return null;

  console.log(`  [images/team] ${teamName} → @${handles.join(', @')}`);

  for (const handle of handles.slice(0, 2)) {
    try {
      const query = `from:${handle} filter:images -filter:retweets`;
      const res = await fetch(
        'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
        new URLSearchParams({ query, queryType: 'Latest' }),
        { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const tweets = data?.data?.tweets || data?.tweets || [];
      for (const t of tweets.slice(0, 5)) {
        const urls = _extractImageUrls(t);
        if (!urls.length) continue;
        const dataUri = await downloadAsDataUri(urls[0]);
        if (dataUri) {
          console.log(`  [images/team] ✓ ${teamName} → @${handle}`);
          return dataUri;
        }
      }
    } catch (_) {}
  }
  return null;
}

// ── メイン: 選手名/チーム名 → 最適画像(data URI) ────────

const _cache = new Map();

function _isTeamName(name) {
  return !!getHandles(name).length;
}

async function fetchPlayerImage(name, teamHints = []) {
  if (!name) return null;
  if (_cache.has(name)) return _cache.get(name);

  console.log(`\n  [images] ${name}`);

  // チーム名が直接siBindingに入ってるケース
  if (_isTeamName(name)) {
    const img = await fetchTeamImage(name);
    _cache.set(name, img);
    return img;
  }

  // チームハンドルを集める
  let handles = [];
  for (const team of teamHints) {
    handles.push(...getHandles(team));
  }

  // ヒントが無い or ハンドル見つからない場合、FotMobで軽量検索
  if (!handles.length) {
    try {
      const hit = await searchFotMob(name);
      if (hit) {
        console.log(`  [images] FotMob → team: ${hit.teamName || '?'}`);
        if (hit.teamName) handles.push(...getHandles(hit.teamName));
      }
    } catch (_) {}
  }

  if (!handles.length) {
    console.log(`  [images] ハンドル不明 → スキップ`);
    _cache.set(name, null);
    return null;
  }

  console.log(`  [images] handles: ${handles.join(', ')}`);

  // X検索
  const results = await searchXImages(name, handles);
  if (!results.length) {
    console.log(`  [images] 画像見つからず`);
    _cache.set(name, null);
    return null;
  }

  console.log(`  [images] ${results.length} 候補 → best: @${results[0].handle} (rel=${results[0].relevance.toFixed(2)})`);

  // ベスト画像をダウンロード（失敗時は次の候補）
  for (const r of results.slice(0, 3)) {
    const dataUri = await downloadAsDataUri(r.imageUrl);
    if (dataUri) {
      console.log(`  [images] ✓ ${name} → @${r.handle}`);
      _cache.set(name, dataUri);
      return dataUri;
    }
  }

  console.log(`  [images] ダウンロード全失敗`);
  _cache.set(name, null);
  return null;
}

// ── ギャラリー画像の自動プリセット ───────────────────────
// Step2 で取得済みの facts.xImages（entity = 選手名/チーム名）から、
// mod の siBinding 系と名前マッチする画像を先埋めする。
// 埋まらなかった分だけ後段の X API 検索が走る（API節約 + ユーザー確認済み画像を優先）。

function _normEntity(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // アクセント除去
    .replace(/\s*(fc|cf)\s*$/i, '')
    .trim();
}

function presetImagesFromGallery(mods, facts) {
  const unchecked = new Set(facts?._uncheckedImageUrls || []);
  const pool = (facts?.xImages || []).filter(xi =>
    xi.url && xi.url.startsWith('http') && xi.entity && !unchecked.has(xi.url)
  );
  if (!pool.length) return 0;

  const used = new Set();
  const pickFor = (name) => {
    const key = _normEntity(name);
    if (!key) return null;
    const hit = pool.find(xi => {
      if (used.has(xi.url)) return false;
      const ek = _normEntity(xi.entity);
      return ek === key || ek.includes(key) || key.includes(ek);
    });
    if (!hit) return null;
    used.add(hit.url);
    return hit.url;
  };

  let filled = 0;
  for (const mod of mods) {
    if (mod.siBinding && !mod.bgImage)           { const u = pickFor(mod.siBinding);      if (u) { mod.bgImage    = u; filled++; } }
    if (mod.siBindingLeft && !mod.leftImage)     { const u = pickFor(mod.siBindingLeft);  if (u) { mod.leftImage  = u; filled++; } }
    if (mod.siBindingRight && !mod.rightImage)   { const u = pickFor(mod.siBindingRight); if (u) { mod.rightImage = u; filled++; } }
  }
  if (filled) console.log(`  [images] ギャラリーからプリセット: ${filled}枠`);
  return filled;
}

// ── 全mod画像解決 ───────────────────────────────────────

async function resolveAllImages(mods, facts) {
  console.log('\n=== Image Resolution ===\n');

  // Step2 取得済み画像（ユーザーチェック済み）を siBinding 名でマッチして先埋め
  presetImagesFromGallery(mods, facts);

  // facts からチームヒントを抽出
  const teamHints = [];
  if (facts?.playerData?.team) teamHints.push(facts.playerData.team);
  if (facts?.playerData?.nationalTeam?.teamName) teamHints.push(facts.playerData.nationalTeam.teamName);
  if (facts?.matchData?.homeTeam) teamHints.push(facts.matchData.homeTeam);
  if (facts?.matchData?.awayTeam) teamHints.push(facts.matchData.awayTeam);

  // siBinding ごとに画像取得（重複排除はキャッシュで自動）
  for (const mod of mods) {
    if (mod.siBinding && !mod.bgImage) {
      mod.bgImage = await fetchPlayerImage(mod.siBinding, teamHints);
    }
    if (mod.siBindingLeft && !mod.leftImage) {
      mod.leftImage = await fetchPlayerImage(mod.siBindingLeft, teamHints);
    }
    if (mod.siBindingRight && !mod.rightImage) {
      mod.rightImage = await fetchPlayerImage(mod.siBindingRight, teamHints);
    }
  }

  const filled = mods.filter(m => m.bgImage || m.leftImage || m.rightImage).length;
  console.log(`\n  Images resolved: ${filled}/${mods.length} slides\n`);
}

module.exports = { resolveAllImages, presetImagesFromGallery, fetchPlayerImage, getHandles, TEAM_HANDLES };
