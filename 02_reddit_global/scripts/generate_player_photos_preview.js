// scripts/generate_player_photos_preview.js
// images_stock 配下の全インデックスを読んでプレビュー HTML を生成
//
// 出力:
//   images_stock/_index.html              — リーグ一覧トップページ
//   images_stock/_preview.html            — 全リーグ統合（旧来互換）
//   images_stock/_preview_{league}.html   — リーグ別（クラブ別セクション付き）
//
// 配信: http://VPS:3004/images_stock/_index.html

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const STOCK_DIR = path.join(ROOT, 'images_stock');

const PLAYER_IDX  = path.join(ROOT, 'data', 'players_official_index.json');
const LOGO_IDX    = path.join(ROOT, 'data', 'club_logos_index.json');
const LEGEND_IDX  = path.join(ROOT, 'data', 'legends_index.json');
const MANAGER_IDX = path.join(ROOT, 'data', 'managers_index.json');
const STADIUM_IDX = path.join(ROOT, 'data', 'stadiums_index.json');

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relPath(p) {
  return String(p || '').replace(/^.*?images_stock\//, '');
}

// ──────────────────────────────────────────────
// 共通 CSS
// ──────────────────────────────────────────────
const COMMON_CSS = `
  *{box-sizing:border-box;}
  body{background:#0f1117;color:#e0e0e0;font-family:sans-serif;margin:0;padding:0;}
  header{padding:16px 24px;background:#1a1a26;border-bottom:3px solid #ff3b3b;position:sticky;top:0;z-index:100;}
  header h1{color:#ff3b3b;font-size:18px;margin:0 0 6px 0;}
  .nav a{color:#7dc8ff;margin-right:10px;font-size:12px;text-decoration:none;padding:3px 8px;background:#2a2a35;border-radius:4px;}
  .nav a:hover{background:#3d3d4d;}
  .breadcrumb{font-size:11px;color:#64748b;margin-top:4px;}
  .breadcrumb a{color:#7dc8ff;text-decoration:none;}
  main{padding:20px 24px;}
  .major-section{margin-bottom:44px;}
  .major-section>h2{color:#fcd34d;font-size:18px;border-bottom:2px solid #fcd34d;padding-bottom:6px;margin:0 0 14px 0;}
  .count{font-size:12px;color:#94a3b8;margin-left:6px;font-weight:normal;}
  .league-section{margin-bottom:32px;}
  .league-section>h3{color:#7dc8ff;font-size:15px;margin:0 0 10px 0;text-transform:capitalize;}
  .club-block{background:#1a1a26;border:1px solid #2a3050;border-radius:8px;margin-bottom:10px;padding:6px 12px;}
  .club-block summary{color:#fcd34d;font-weight:bold;font-size:13px;cursor:pointer;padding:5px 0;text-transform:capitalize;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:6px 0 2px;}
  .wide-grid{grid-template-columns:repeat(auto-fill,minmax(260px,1fr));}
  .card{background:#1e1e26;border:1px solid #3d3d4d;border-radius:8px;padding:8px;}
  .img-box{width:100%;aspect-ratio:1;background:linear-gradient(135deg,#243353,#0d1830);border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;}
  .img-box.wide{aspect-ratio:16/9;}
  .img-box.logo-box{background:#2a2a35;padding:12px;}
  .img-box img{max-width:100%;max-height:100%;object-fit:contain;}
  .name{font-size:12px;font-weight:bold;color:#fff;margin-top:6px;line-height:1.3;}
  .meta{font-size:10px;color:#7a8a9a;margin-top:2px;font-family:monospace;}
  .league-card{background:#1a1a26;border:1px solid #2a3050;border-radius:10px;padding:18px;text-decoration:none;color:#e0e0e0;display:block;transition:border-color .2s;}
  .league-card:hover{border-color:#7dc8ff;}
  .league-card h2{color:#fcd34d;margin:0 0 6px;font-size:16px;}
  .league-card .stats{font-size:12px;color:#94a3b8;line-height:1.8;}
  .league-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:16px;}
`;

function makeHeader(title, breadcrumb, navLinks) {
  const navHtml = navLinks.map(([href, label]) =>
    `<a href="${esc(href)}">${esc(label)}</a>`
  ).join('');
  return `<header>
  <h1>⚽ ${esc(title)}</h1>
  <div class="nav">${navHtml}</div>
  ${breadcrumb ? `<div class="breadcrumb">${breadcrumb}</div>` : ''}
</header>`;
}

// ──────────────────────────────────────────────
// カード HTML
// ──────────────────────────────────────────────
function playerCard(p) {
  return `<div class="card">
    <div class="img-box"><img src="${esc(relPath(p.localPath))}" alt="${esc(p.name)}" loading="lazy"></div>
    <div class="name">${esc(p.name)}</div>
    <div class="meta">${Math.round((p.sizeBytes||0)/1024)}KB${p.position ? ' · '+esc(p.position) : ''}</div>
  </div>`;
}

function logoCard(c) {
  return `<div class="card">
    <div class="img-box logo-box"><img src="${esc(relPath(c.localPath))}" alt="${esc(c.clubName)}" loading="lazy"></div>
    <div class="name">${esc(c.clubName)}</div>
    <div class="meta">${esc(c.format||'?')} · ${Math.round((c.sizeBytes||0)/1024)}KB</div>
  </div>`;
}

function managerCard(m) {
  return `<div class="card">
    <div class="img-box"><img src="${esc(relPath(m.localPath))}" alt="${esc(m.name)}" loading="lazy"></div>
    <div class="name">${esc(m.name)}</div>
    <div class="meta">${esc(m.clubName||'?')} · ${Math.round((m.sizeBytes||0)/1024)}KB</div>
  </div>`;
}

function legendCard(L) {
  return `<div class="card">
    <div class="img-box wide"><img src="${esc(relPath(L.localPath))}" alt="${esc(L.name)}" loading="lazy"></div>
    <div class="name">${esc(L.name)}</div>
    <div class="meta">${Math.round((L.sizeBytes||0)/1024)}KB</div>
  </div>`;
}

function stadiumCard(photo, stadiumName) {
  return `<div class="card">
    <div class="img-box wide"><img src="${esc(relPath(photo))}" alt="${esc(stadiumName)}" loading="lazy"></div>
    <div class="meta">${esc(stadiumName)}</div>
  </div>`;
}

// ──────────────────────────────────────────────
// クラブ別選手 <details> ブロック
// ──────────────────────────────────────────────
function clubPlayerBlock(clubKey, players) {
  const cards = players.map(playerCard).join('');
  const label = (players[0]?.clubName || clubKey).replace(/-/g, ' ');
  return `<details class="club-block" open>
    <summary>${esc(label)} <span class="count">${players.length}名</span></summary>
    <div class="grid">${cards}</div>
  </details>`;
}

// ──────────────────────────────────────────────
// リーグ別プレビュー HTML
// ──────────────────────────────────────────────
function buildLeagueHtml(leagueSlug, leagueName, { players, logos, managers, stadiums, legends }) {
  const playersByClub = {};
  for (const p of players) {
    (playersByClub[p.club] = playersByClub[p.club] || []).push(p);
  }

  const playerSection = players.length ? `
  <section id="players" class="major-section">
    <h2>⚽ 選手プロフィール写真 <span class="count">${players.length}名</span></h2>
    ${Object.entries(playersByClub).sort((a,b)=>a[0].localeCompare(b[0])).map(([k,ps]) => clubPlayerBlock(k, ps)).join('')}
  </section>` : '';

  const logoSection = logos.length ? `
  <section id="logos" class="major-section">
    <h2>📛 クラブロゴ・エンブレム <span class="count">${logos.length}クラブ</span></h2>
    <div class="grid">${logos.sort((a,b)=>(a.clubName||'').localeCompare(b.clubName||'')).map(logoCard).join('')}</div>
  </section>` : '';

  const managerSection = managers.length ? `
  <section id="managers" class="major-section">
    <h2>👔 監督 <span class="count">${managers.length}人</span></h2>
    <div class="grid">${managers.sort((a,b)=>(a.clubName||'').localeCompare(b.clubName||'')).map(managerCard).join('')}</div>
  </section>` : '';

  const legendSection = legends.length ? `
  <section id="legends" class="major-section">
    <h2>🏆 レジェンド <span class="count">${legends.length}人</span></h2>
    <div class="grid wide-grid">${legends.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(legendCard).join('')}</div>
  </section>` : '';

  const stadiumSection = stadiums.length ? `
  <section id="stadiums" class="major-section">
    <h2>🏟️ スタジアム <span class="count">${stadiums.length}クラブ</span></h2>
    ${stadiums.sort((a,b)=>(a.clubName||'').localeCompare(b.clubName||'')).map(c =>
      `<details class="club-block" open>
        <summary>${esc(c.clubName)} <span class="count">${esc(c.stadium)} · ${c.photoCount}枚</span></summary>
        <div class="grid wide-grid">${(c.photos||[]).map(p => stadiumCard(p, c.stadium)).join('')}</div>
      </details>`
    ).join('')}
  </section>` : '';

  const navLinks = [];
  if (players.length)  navLinks.push(['#players',  `⚽ 選手(${players.length})`]);
  if (logos.length)    navLinks.push(['#logos',    `📛 ロゴ(${logos.length})`]);
  if (managers.length) navLinks.push(['#managers', `👔 監督(${managers.length})`]);
  if (legends.length)  navLinks.push(['#legends',  `🏆 レジェンド(${legends.length})`]);
  if (stadiums.length) navLinks.push(['#stadiums', '🏟️ スタジアム']);
  navLinks.push(['_index.html', '← トップ']);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${leagueName} — images_stock</title>
<style>${COMMON_CSS}</style>
</head>
<body>
${makeHeader(leagueName, `<a href="_index.html">images_stock</a> &gt; ${esc(leagueName)}`, navLinks)}
<main>
  ${playerSection}${logoSection}${managerSection}${legendSection}${stadiumSection}
</main>
</body>
</html>`;
}

// ──────────────────────────────────────────────
// 全リーグ統合 HTML（旧来互換 _preview.html）
// ──────────────────────────────────────────────
function buildAllLeaguesHtml(playerIdx, logoIdx, legendIdx, managerIdx, stadiumIdx) {
  const players  = Object.values(playerIdx.players || {});
  const logos    = Object.values(logoIdx.clubs || {});
  const legends  = Object.values(legendIdx.inductees || {});
  const managers = Object.values(managerIdx.managers || {});
  const stadiums = Object.values(stadiumIdx.clubs || {}).filter(c => (c.photoCount||0) > 0);

  // リーグ × クラブ 分類
  const byLeagueClub = {};
  for (const p of players) {
    const lg = (p.leagueSlug||p.league||'unknown').replace(/\s+/g,'-').toLowerCase();
    const cl = p.club||'unknown';
    (byLeagueClub[lg] = byLeagueClub[lg]||{})[cl] = (byLeagueClub[lg][cl]||[]);
    byLeagueClub[lg][cl].push(p);
  }

  const playerSection = players.length ? `<section id="players" class="major-section">
    <h2>⚽ 選手プロフィール写真 <span class="count">${players.length}名</span></h2>
    ${Object.entries(byLeagueClub).map(([lg, clubs]) => `
      <div class="league-section">
        <h3>${esc(lg)} <span class="count">${Object.values(clubs).flat().length}名</span></h3>
        ${Object.entries(clubs).sort((a,b)=>a[0].localeCompare(b[0])).map(([k,ps]) => clubPlayerBlock(k, ps)).join('')}
      </div>`).join('')}
  </section>` : '';

  const logoSection = logos.length ? `<section id="logos" class="major-section">
    <h2>📛 クラブロゴ・エンブレム <span class="count">${logos.length}クラブ</span></h2>
    <div class="grid">${logos.sort((a,b)=>(a.clubName||'').localeCompare(b.clubName||'')).map(logoCard).join('')}</div>
  </section>` : '';

  const managerSection = managers.length ? `<section id="managers" class="major-section">
    <h2>👔 監督 <span class="count">${managers.length}人</span></h2>
    <div class="grid">${managers.sort((a,b)=>(a.clubName||'').localeCompare(b.clubName||'')).map(managerCard).join('')}</div>
  </section>` : '';

  const legendSection = legends.length ? `<section id="legends" class="major-section">
    <h2>🏆 Hall of Fame レジェンド <span class="count">${legends.length}人</span></h2>
    <div class="grid wide-grid">${legends.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(legendCard).join('')}</div>
  </section>` : '';

  const stadiumSection = stadiums.length ? `<section id="stadiums" class="major-section">
    <h2>🏟️ スタジアム</h2>
    ${stadiums.sort((a,b)=>(a.clubName||'').localeCompare(b.clubName||'')).map(c =>
      `<details class="club-block" open>
        <summary>${esc(c.clubName)} <span class="count">${esc(c.stadium)} · ${c.photoCount}枚</span></summary>
        <div class="grid wide-grid">${(c.photos||[]).map(p => stadiumCard(p, c.stadium)).join('')}</div>
      </details>`
    ).join('')}
  </section>` : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>images_stock 統合プレビュー</title>
<style>${COMMON_CSS}</style>
</head>
<body>
${makeHeader('images_stock 統合プレビュー', '', [
  ['#players',  `⚽ 選手(${players.length})`],
  ['#logos',    `📛 ロゴ(${logos.length})`],
  ['#managers', `👔 監督(${managers.length})`],
  ['#legends',  `🏆 レジェンド(${legends.length})`],
  ['#stadiums', '🏟️ スタジアム'],
  ['_index.html', '📋 リーグ別'],
])}
<main>
  ${playerSection}${logoSection}${managerSection}${legendSection}${stadiumSection}
</main>
</body>
</html>`;
}

// ──────────────────────────────────────────────
// トップインデックス HTML
// ──────────────────────────────────────────────
function buildIndexHtml(leagueSlugs, playerIdx, logoIdx, managerIdx, stadiumIdx, legendIdx) {
  const allPlayers  = Object.values(playerIdx.players || {});
  const allLogos    = Object.values(logoIdx.clubs || {});
  const allManagers = Object.values(managerIdx.managers || {});
  const allStadiums = Object.values(stadiumIdx.clubs || {});
  const allLegends  = Object.values(legendIdx.inductees || {});

  const LEAGUE_LABELS = {
    'premier-league': 'Premier League 🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    'la-liga':        'La Liga 🇪🇸',
    'bundesliga':     'Bundesliga 🇩🇪',
  };

  const cards = leagueSlugs.map(lg => {
    const lgPlayers  = allPlayers.filter(p  => (p.leagueSlug||p.league||'').replace(/\s+/g,'-').toLowerCase() === lg);
    const lgLogos    = allLogos.filter(c    => (c.leagueSlug||'') === lg);
    const lgManagers = allManagers.filter(m => (m.leagueSlug||'') === lg);
    const lgStadiums = allStadiums.filter(s => (s.leagueSlug||'') === lg && (s.photoCount||0) > 0);
    const label      = LEAGUE_LABELS[lg] || lg;
    return `<a href="_preview_${esc(lg)}.html" class="league-card">
      <h2>${esc(label)}</h2>
      <div class="stats">
        ⚽ 選手写真: ${lgPlayers.length}名<br>
        📛 クラブロゴ: ${lgLogos.length}クラブ<br>
        👔 監督: ${lgManagers.length}人<br>
        🏟️ スタジアム: ${lgStadiums.length}クラブ
      </div>
    </a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>images_stock — リーグ一覧</title>
<style>${COMMON_CSS}</style>
</head>
<body>
${makeHeader('images_stock — リーグ別プレビュー', '', [
  ['_preview.html', '📋 全リーグ統合'],
])}
<main>
  <div style="color:#94a3b8;font-size:13px;margin-bottom:16px;">
    累計: 選手 ${allPlayers.length}名 / ロゴ ${allLogos.length}クラブ / 監督 ${allManagers.length}人 / レジェンド ${allLegends.length}人
  </div>
  <div class="league-grid">${cards}</div>
</main>
</body>
</html>`;
}

// ──────────────────────────────────────────────
// main
// ──────────────────────────────────────────────
function main() {
  const playerIdx  = loadJson(PLAYER_IDX, {});
  const logoIdx    = loadJson(LOGO_IDX, {});
  const legendIdx  = loadJson(LEGEND_IDX, {});
  const managerIdx = loadJson(MANAGER_IDX, {});
  const stadiumIdx = loadJson(STADIUM_IDX, {});

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  const allPlayers  = Object.values(playerIdx.players || {});
  const allLogos    = Object.values(logoIdx.clubs || {});
  const allLegends  = Object.values(legendIdx.inductees || {});
  const allManagers = Object.values(managerIdx.managers || {});
  const allStadiums = Object.values(stadiumIdx.clubs || {});

  // 存在するリーグ slug を収集（固定順）
  const ORDER = ['premier-league', 'la-liga', 'bundesliga'];
  const found = new Set([
    ...allPlayers.map(p  => (p.leagueSlug||p.league||'').replace(/\s+/g,'-').toLowerCase()),
    ...allLogos.map(c    => c.leagueSlug||''),
    ...allManagers.map(m => m.leagueSlug||''),
    ...allStadiums.map(s => s.leagueSlug||''),
  ].filter(Boolean));
  const leagueSlugs = [...ORDER.filter(lg => found.has(lg)), ...[...found].filter(lg => !ORDER.includes(lg))];

  // 1) リーグ別 HTML
  const LEAGUE_NAMES = { 'premier-league': 'Premier League', 'la-liga': 'La Liga', 'bundesliga': 'Bundesliga' };
  for (const lg of leagueSlugs) {
    const lgName     = LEAGUE_NAMES[lg] || lg;
    const lgPlayers  = allPlayers.filter(p  => (p.leagueSlug||p.league||'').replace(/\s+/g,'-').toLowerCase() === lg);
    const lgLogos    = allLogos.filter(c    => (c.leagueSlug||'') === lg);
    const lgManagers = allManagers.filter(m => (m.leagueSlug||'') === lg);
    const lgStadiums = allStadiums.filter(s => (s.leagueSlug||'') === lg && (s.photoCount||0) > 0);
    const lgLegends  = allLegends.filter(L  => (L.leagueSlug||'premier-league') === lg);

    const html    = buildLeagueHtml(lg, lgName, { players: lgPlayers, logos: lgLogos, managers: lgManagers, stadiums: lgStadiums, legends: lgLegends });
    const outPath = path.join(STOCK_DIR, `_preview_${lg}.html`);
    fs.writeFileSync(outPath, html);
    console.log(`Wrote: _preview_${lg}.html  (players=${lgPlayers.length}, logos=${lgLogos.length}, managers=${lgManagers.length})`);
  }

  // 2) 全リーグ統合
  fs.writeFileSync(path.join(STOCK_DIR, '_preview.html'), buildAllLeaguesHtml(playerIdx, logoIdx, legendIdx, managerIdx, stadiumIdx));
  console.log('Wrote: _preview.html');

  // 3) トップインデックス
  fs.writeFileSync(path.join(STOCK_DIR, '_index.html'), buildIndexHtml(leagueSlugs, playerIdx, logoIdx, managerIdx, stadiumIdx, legendIdx));
  console.log('Wrote: _index.html');

  console.log(`\nURL: http://<vps>:3004/images_stock/_index.html`);
}

main();
