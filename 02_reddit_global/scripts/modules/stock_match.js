// scripts/modules/stock_match.js
// images_stock の indices からラベル一致する画像を引いてくる
//
// 取得対象:
//   players_official_index.json — 選手画像
//   club_logos_index.json       — チームロゴ
//   managers_index.json         — 監督画像
//   stadiums_index.json         — スタジアム写真
//   legends_index.json          — レジェンド (PL Hall of Fame)
//
// ラベル → 画像のマッピング:
//   { type: 'player',  entity: 'Vinicius Junior' } → players index で fuzzy 検索
//   { type: 'team',    entity: 'Real Madrid' }     → logos / stadiums を引く
//   { type: 'manager', entity: 'Carlo Ancelotti' } → managers
//   { type: 'matchcard', entity: 'A vs B' }        → 両チームの logo + stadium

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const STOCK_DIR_FROM_REPO = 'images_stock'; // image URL の起点

// 文字列正規化（マッチ用）: 小文字化 + アクセント記号除去 + 記号除去
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // diacritics 除去
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 1単語以上が一致するかどうかのスコア
function matchScore(target, query) {
  const t = normalize(target);
  const q = normalize(query);
  if (!t || !q) return 0;
  if (t === q) return 100;
  if (t.includes(q) || q.includes(t)) return 80;
  // トークン分割で一致数カウント
  const tt = new Set(t.split(' '));
  const qq = q.split(' ').filter(w => w.length >= 2);
  if (!qq.length) return 0;
  const hits = qq.filter(w => tt.has(w)).length;
  return Math.round((hits / qq.length) * 70);
}

function loadIndex(filename) {
  const file = path.join(DATA_DIR, filename);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw;
  } catch (_) { return {}; }
}

// localPath を URL (/images_stock/...) に変換
function pathToUrl(localPath) {
  if (!localPath) return null;
  // localPath は "images_stock/players_official/..." 形式
  // express で /images_stock を images_stock ディレクトリに静的配信してる前提
  const cleaned = String(localPath).replace(/\\/g, '/').replace(/^.*?(images_stock\/)/, '$1');
  return '/' + cleaned;
}

function readImageScore(localPath) {
  if (!localPath) return {};
  try {
    const cleaned = String(localPath).replace(/\\/g, '/').replace(/^.*?(images_stock\/players_official\/)/, '$1');
    const m = cleaned.match(/^images_stock\/players_official\/([^/]+)\/([^/]+)$/);
    if (!m) return {};
    const scorePath = path.join(ROOT, 'images_stock', 'players_official', m[1], 'score.json');
    if (!fs.existsSync(scorePath)) return {};
    const scores = JSON.parse(fs.readFileSync(scorePath, 'utf8'));
    return scores[m[2]] || {};
  } catch (_) {
    return {};
  }
}

// === 個別マッチャー ===

function matchPlayers(query, opts = {}) {
  const { limit = 5, leagueSlug = null, threshold = 60 } = opts;
  const idx = loadIndex('players_official_index.json');
  const players = Object.values(idx.players || {});
  const scored = [];
  for (const p of players) {
    if (leagueSlug && p.leagueSlug !== leagueSlug) continue;
    const score = matchScore(p.name, query);
    if (score >= threshold) scored.push({ score, item: p });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const bs = readImageScore(b.item.localPath);
    const as = readImageScore(a.item.localPath);
    const bv = Number(bs.visionScore || 0);
    const av = Number(as.visionScore || 0);
    if (bv !== av) return bv - av;
    return Number(bs.score || 0) - Number(as.score || 0);
  });
  return scored.slice(0, limit).map(s => ({
    ...(() => {
      const imageScore = readImageScore(s.item.localPath);
      return {
        usageScore: Number(imageScore.score || 0),
        visionScore: Number(imageScore.visionScore || 0),
        confidence: imageScore.confidence ?? null,
      };
    })(),
    source: 'stock',
    role: 'player',
    score: s.score,
    name: s.item.name,
    league: s.item.league,
    club: s.item.club,
    url: pathToUrl(s.item.localPath),
    sizeBytes: s.item.sizeBytes,
  }));
}

function matchClubs(query, opts = {}) {
  const { kinds = ['logo', 'stadium'], limit = 6, threshold = 60 } = opts;
  const out = [];
  if (kinds.includes('logo')) {
    const idx = loadIndex('club_logos_index.json');
    for (const c of Object.values(idx.clubs || {})) {
      const score = matchScore(c.clubName, query);
      if (score >= threshold) {
        out.push({ source: 'stock', role: 'team_logo', score, name: c.clubName, league: c.league, url: pathToUrl(c.localPath) });
      }
    }
  }
  if (kinds.includes('stadium')) {
    const idx = loadIndex('stadiums_index.json');
    for (const c of Object.values(idx.clubs || {})) {
      const score = matchScore(c.clubName, query);
      if (score >= threshold) {
        for (const photo of (c.photos || []).slice(0, 3)) {
          out.push({ source: 'stock', role: 'stadium', score, name: c.stadium, club: c.clubName, league: c.league, url: pathToUrl(photo) });
        }
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function matchManagers(query, opts = {}) {
  const { limit = 3, threshold = 60 } = opts;
  const idx = loadIndex('managers_index.json');
  const out = [];
  for (const m of Object.values(idx.managers || {})) {
    const score = matchScore(m.name, query);
    if (score >= threshold) {
      out.push({ source: 'stock', role: 'manager', score, name: m.name, club: m.clubName, league: m.league, url: pathToUrl(m.localPath) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function matchLegends(query, opts = {}) {
  const { limit = 3, threshold = 60 } = opts;
  const idx = loadIndex('legends_index.json');
  const legends = idx.legends || {};
  const out = [];
  for (const l of Object.values(legends)) {
    const score = matchScore(l.name, query);
    if (score >= threshold) {
      out.push({ source: 'stock', role: 'legend', score, name: l.name, club: l.club, url: pathToUrl(l.localPath) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// === メイン ===
// label の type に応じて適切なマッチャーを呼ぶ
function findStockMatches({ type, entity, teamName, teamNameAway, limit = 20 }) {
  const out = [];
  if (!entity && !teamName) return out;

  const t = (type || '').toLowerCase();

  if (t === 'player' || t === 'entity') {
    if (entity) out.push(...matchPlayers(entity, { limit }));
    if (entity) out.push(...matchLegends(entity, { limit: Math.min(limit, 8) }));
  }
  if (t === 'manager') {
    if (entity) out.push(...matchManagers(entity, { limit }));
  }
  if (t === 'team') {
    if (entity) out.push(...matchClubs(entity, { kinds: ['logo', 'stadium'], limit }));
  }
  if (t === 'stadium') {
    if (entity) out.push(...matchClubs(entity, { kinds: ['stadium'], limit }));
  }
  if (t === 'match' || t === 'matchcard') {
    if (teamName)     out.push(...matchClubs(teamName,     { kinds: ['logo', 'stadium'], limit: Math.max(8, Math.ceil(limit / 2)) }));
    if (teamNameAway) out.push(...matchClubs(teamNameAway, { kinds: ['logo', 'stadium'], limit: Math.max(8, Math.ceil(limit / 2)) }));
  }

  // role/url 重複除外
  const seenUrls = new Set();
  return out.filter(m => {
    if (!m.url || seenUrls.has(m.url)) return false;
    seenUrls.add(m.url);
    return true;
  }).slice(0, limit);
}

// === タイプアヘッド用: 軽量サジェスト ===
// query: ユーザー入力（一部一致 OK、最低 1 文字）
// role:  'player' | 'manager' | 'team' | 'all'（フィルタ）
// 返り値: [{ label, role, league, club, score }] 最大 limit 件
function suggestEntities(query, opts = {}) {
  const { role = 'all', limit = 10, threshold = 30 } = opts;
  const q = String(query || '').trim();
  if (!q) return [];

  const out = [];
  const wantAll  = role === 'all';
  const wantPlay = wantAll || role === 'player';
  const wantTeam = wantAll || role === 'team';
  const wantMgr  = wantAll || role === 'manager';

  if (wantPlay) {
    const pIdx = loadIndex('players_official_index.json');
    for (const p of Object.values(pIdx.players || {})) {
      const score = matchScore(p.name, q);
      if (score >= threshold) {
        out.push({ label: p.name, role: 'player', league: p.league, club: p.club, score });
      }
    }
    const lIdx = loadIndex('legends_index.json');
    for (const l of Object.values(lIdx.legends || {})) {
      const score = matchScore(l.name, q);
      if (score >= threshold) {
        out.push({ label: l.name, role: 'player', league: l.league || 'Legend', club: l.club || '', score });
      }
    }
  }
  if (wantTeam) {
    const cIdx = loadIndex('club_logos_index.json');
    for (const c of Object.values(cIdx.clubs || {})) {
      const score = matchScore(c.clubName, q);
      if (score >= threshold) {
        out.push({ label: c.clubName, role: 'team', league: c.league, club: c.clubName, score });
      }
    }
  }
  if (wantMgr) {
    const mIdx = loadIndex('managers_index.json');
    for (const m of Object.values(mIdx.managers || {})) {
      const score = matchScore(m.name, q);
      if (score >= threshold) {
        out.push({ label: m.name, role: 'manager', league: m.league, club: m.clubName, score });
      }
    }
  }

  // 重複除外（label + role）
  const seen = new Set();
  const dedup = [];
  for (const item of out) {
    const k = `${item.role}:${item.label}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(item);
  }

  dedup.sort((a, b) => b.score - a.score);
  return dedup.slice(0, limit);
}

module.exports = {
  findStockMatches,
  matchPlayers,
  matchClubs,
  matchManagers,
  matchLegends,
  suggestEntities,
  normalize,
  matchScore,
};
