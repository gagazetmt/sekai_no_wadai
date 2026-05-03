// scripts/generate_player_photos_preview.js
// images_stock 配下の全インデックス（選手 / ロゴ / レジェンド）を読んで
// 統合プレビュー HTML を生成
//   出力: images_stock/_preview.html
//   配信: http://VPS:3004/images_stock/_preview.html

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STOCK_DIR = path.join(ROOT, 'images_stock');
const OUT_FILE  = path.join(STOCK_DIR, '_preview.html');

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

// localPath ("images_stock/.../foo.png") を /images_stock 配信用の相対パス ("...../foo.png") に
function relPath(p) {
  return String(p || '').replace(/^.*?images_stock\//, '');
}

function renderPlayerSection(idx) {
  const players = Object.values(idx.players || {});
  if (!players.length) return '';

  const byLeagueClub = {};
  for (const p of players) {
    const lg = (p.league || 'Unknown').replace(/\s+/g, '-').toLowerCase();
    const cl = p.club || 'unknown';
    byLeagueClub[lg] = byLeagueClub[lg] || {};
    byLeagueClub[lg][cl] = byLeagueClub[lg][cl] || [];
    byLeagueClub[lg][cl].push(p);
  }

  const sections = Object.entries(byLeagueClub).map(([lg, clubs]) => {
    const clubBlocks = Object.entries(clubs).sort((a, b) => a[0].localeCompare(b[0])).map(([club, list]) => {
      const cards = list.map(p => `
        <div class="card">
          <div class="img-box"><img src="${esc(relPath(p.localPath))}" alt="${esc(p.name)}" loading="lazy"></div>
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${Math.round((p.sizeBytes||0)/1024)}KB · ${esc((p.photoUrl||'').match(/\/(\d+x\d+)\//)?.[1] || '?')}</div>
        </div>`).join('');
      return `<details class="club-block" open>
        <summary>${esc(club)} <span class="count">${list.length}名</span></summary>
        <div class="grid">${cards}</div>
      </details>`;
    }).join('');
    return `<section class="league-section">
      <h3>${esc(lg)} <span class="count">${Object.keys(clubs).length}クラブ / ${players.filter(p => (p.league||'').replace(/\s+/g,'-').toLowerCase()===lg).length}名</span></h3>
      ${clubBlocks}
    </section>`;
  }).join('');

  return `<section id="players" class="major-section">
    <h2>⚽ 選手プロフィール写真 <span class="count">${players.length}名</span></h2>
    ${sections}
  </section>`;
}

function renderLogoSection(idx) {
  const clubs = Object.values(idx.clubs || {});
  if (!clubs.length) return '';

  const cards = clubs.sort((a, b) => (a.clubName || '').localeCompare(b.clubName || '')).map(c => `
    <div class="card logo-card">
      <div class="img-box logo-box"><img src="${esc(relPath(c.localPath))}" alt="${esc(c.clubName)}" loading="lazy"></div>
      <div class="name">${esc(c.clubName)}</div>
      <div class="meta">${esc(c.format || '?')} · ${Math.round((c.sizeBytes||0)/1024)}KB</div>
    </div>`).join('');

  return `<section id="logos" class="major-section">
    <h2>📛 クラブロゴ・エンブレム <span class="count">${clubs.length}クラブ</span></h2>
    <div class="grid">${cards}</div>
  </section>`;
}

function renderLegendSection(idx) {
  const inductees = Object.values(idx.inductees || {});
  if (!inductees.length) return '';

  const cards = inductees.sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(L => `
    <div class="card legend-card">
      <div class="img-box wide"><img src="${esc(relPath(L.localPath))}" alt="${esc(L.name)}" loading="lazy"></div>
      <div class="name">${esc(L.name)}</div>
      <div class="meta">${Math.round((L.sizeBytes||0)/1024)}KB</div>
    </div>`).join('');

  return `<section id="legends" class="major-section">
    <h2>🏆 Hall of Fame レジェンド <span class="count">${inductees.length}人</span></h2>
    <div class="grid wide-grid">${cards}</div>
  </section>`;
}

function renderManagerSection(idx) {
  const managers = Object.values(idx.managers || {});
  if (!managers.length) return '';

  const cards = managers.sort((a, b) => (a.clubName || '').localeCompare(b.clubName || '')).map(m => `
    <div class="card">
      <div class="img-box"><img src="${esc(relPath(m.localPath))}" alt="${esc(m.name)}" loading="lazy"></div>
      <div class="name">${esc(m.name)}</div>
      <div class="meta">${esc(m.clubName || '?')} · ${Math.round((m.sizeBytes||0)/1024)}KB</div>
    </div>`).join('');

  return `<section id="managers" class="major-section">
    <h2>👔 監督 <span class="count">${managers.length}人</span></h2>
    <div class="grid">${cards}</div>
  </section>`;
}

function renderStadiumSection(idx) {
  const clubs = Object.values(idx.clubs || {}).filter(c => (c.photoCount || 0) > 0);
  if (!clubs.length) return '';

  const sections = clubs.sort((a, b) => (a.clubName || '').localeCompare(b.clubName || '')).map(c => {
    const cards = (c.photos || []).map(p => `
      <div class="card">
        <div class="img-box wide"><img src="${esc(relPath(p))}" alt="${esc(c.stadium)}" loading="lazy"></div>
        <div class="meta">${esc(c.stadium)}</div>
      </div>`).join('');
    return `<details class="club-block" open>
      <summary>${esc(c.clubName)} <span class="count">${esc(c.stadium)} · ${c.photoCount}枚</span></summary>
      <div class="grid wide-grid">${cards}</div>
    </details>`;
  }).join('');

  const totalPhotos = clubs.reduce((s, c) => s + (c.photoCount || 0), 0);
  return `<section id="stadiums" class="major-section">
    <h2>🏟️ スタジアム <span class="count">${clubs.length}クラブ / ${totalPhotos}枚</span></h2>
    ${sections}
  </section>`;
}

function main() {
  const playerIdx  = loadJson(PLAYER_IDX, {});
  const logoIdx    = loadJson(LOGO_IDX, {});
  const legendIdx  = loadJson(LEGEND_IDX, {});
  const managerIdx = loadJson(MANAGER_IDX, {});
  const stadiumIdx = loadJson(STADIUM_IDX, {});

  const playerCount  = Object.keys(playerIdx.players || {}).length;
  const logoCount    = Object.keys(logoIdx.clubs || {}).length;
  const legendCount  = Object.keys(legendIdx.inductees || {}).length;
  const managerCount = Object.keys(managerIdx.managers || {}).length;
  const stadiumCount = Object.values(stadiumIdx.clubs || {}).filter(c => (c.photoCount || 0) > 0).length;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>images_stock プレビュー</title>
<style>
  body { background:#0f1117; color:#e0e0e0; font-family:sans-serif; margin:0; padding:0; }
  header { padding:20px 24px; background:#1a1a26; border-bottom:3px solid #ff3b3b; position:sticky; top:0; z-index:100; }
  header h1 { color:#ff3b3b; font-size:20px; margin:0 0 8px 0; }
  header .nav a { color:#7dc8ff; margin-right:14px; font-size:13px; text-decoration:none; padding:4px 10px; background:#2a2a35; border-radius:4px; }
  header .nav a:hover { background:#3d3d4d; }
  header .summary { color:#94a3b8; font-size:12px; margin-top:6px; }
  main { padding:24px; }
  .major-section { margin-bottom:48px; }
  .major-section h2 { color:#fcd34d; font-size:20px; border-bottom:2px solid #fcd34d; padding-bottom:8px; margin:0 0 18px 0; }
  .major-section .count { font-size:13px; color:#94a3b8; margin-left:8px; letter-spacing:1px; font-weight:normal; }
  .league-section { margin-bottom:36px; }
  .league-section h3 { color:#7dc8ff; font-size:16px; margin:0 0 12px 0; text-transform:capitalize; }
  .club-block { background:#1a1a26; border:1px solid #2a3050; border-radius:8px; margin-bottom:12px; padding:8px 14px; }
  .club-block summary { color:#fcd34d; font-weight:bold; font-size:14px; cursor:pointer; padding:6px 0; text-transform:capitalize; }
  .club-block .count { color:#94a3b8; font-weight:normal; margin-left:6px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:12px; padding:8px 0 4px; }
  .wide-grid { grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); }
  .card { background:#1e1e26; border:1px solid #3d3d4d; border-radius:8px; padding:10px; }
  .img-box { width:100%; aspect-ratio:1; background:linear-gradient(135deg,#243353,#0d1830); border-radius:6px; overflow:hidden; display:flex; align-items:center; justify-content:center; }
  .img-box.wide { aspect-ratio:16/9; }
  .img-box.logo-box { background:#2a2a35; padding:14px; }
  .img-box img { max-width:100%; max-height:100%; object-fit:contain; }
  .name { font-size:13px; font-weight:bold; color:#fff; margin-top:8px; line-height:1.3; }
  .meta { font-size:10px; color:#7a8a9a; margin-top:3px; font-family:monospace; }
</style>
</head>
<body>
<header>
  <h1>⚽ images_stock プレビュー</h1>
  <div class="nav">
    <a href="#players">⚽ 選手 (${playerCount})</a>
    <a href="#logos">📛 ロゴ (${logoCount})</a>
    <a href="#managers">👔 監督 (${managerCount})</a>
    <a href="#legends">🏆 レジェンド (${legendCount})</a>
    <a href="#stadiums">🏟️ スタジアム (${stadiumCount})</a>
  </div>
  <div class="summary">取得元: PL公式CDN (選手/ロゴ/レジェンド) + SofaScore (監督) + Wikimedia (スタジアム)</div>
</header>
<main>
  ${renderPlayerSection(playerIdx)}
  ${renderLogoSection(logoIdx)}
  ${renderManagerSection(managerIdx)}
  ${renderLegendSection(legendIdx)}
  ${renderStadiumSection(stadiumIdx)}
</main>
</body>
</html>`;

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html);
  console.log(`Wrote: ${OUT_FILE}`);
  console.log(`  Players: ${playerCount}, Logos: ${logoCount}, Legends: ${legendCount}`);
  console.log(`URL: http://<vps>:3004/images_stock/_preview.html`);
}

main();
