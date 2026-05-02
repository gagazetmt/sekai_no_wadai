// scripts/generate_player_photos_preview.js
// players_official_index.json をもとに、クラブ別プレビュー HTML を生成
//   出力先: images_stock/_preview.html (全クラブ一覧 + クラブ別タブ)
//
// VPS 静的配信経由で http://VPS:3004/images_stock/_preview.html で開ける

const fs   = require('fs');
const path = require('path');

const INDEX_FILE = path.join(__dirname, '..', 'data', 'players_official_index.json');
const STOCK_DIR  = path.join(__dirname, '..', 'images_stock');
const OUT_FILE   = path.join(STOCK_DIR, '_preview.html');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function main() {
  if (!fs.existsSync(INDEX_FILE)) {
    console.error('Index not found:', INDEX_FILE);
    process.exit(1);
  }
  const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const players = Object.values(idx.players || {})
    .filter(p => p.league === 'Premier League');  // 現状は PL のみ

  const byClub = {};
  for (const p of players) {
    if (!byClub[p.club]) byClub[p.club] = [];
    byClub[p.club].push(p);
  }

  const clubKeys = Object.keys(byClub).sort();

  const renderCard = (p) => {
    // index.json の localPath は project root 起点 (images_stock/...)。
    // /images_stock 静的配信に揃えて先頭 "images_stock/" を剥がす
    const rel = p.localPath.replace(/^.*?images_stock\//, '');
    const sizeKB = Math.round((p.sizeBytes || 0) / 1024);
    const sz = (p.photoUrl?.match(/\/(\d+x\d+)\//) || [])[1] || '?';
    return `<div class="card">
      <div class="img-box"><img src="${esc(rel)}" alt="${esc(p.name)}" loading="lazy"></div>
      <div class="name">${esc(p.name)}</div>
      <div class="meta">${sizeKB}KB · ${esc(sz)}</div>
    </div>`;
  };

  const sections = clubKeys.map(club => {
    const items = byClub[club];
    return `<section class="club-section">
      <h2>${esc(club)} <span class="count">${items.length}名</span></h2>
      <div class="grid">${items.map(renderCard).join('')}</div>
    </section>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>選手プロフィール写真プレビュー</title>
<style>
  body { background:#0f1117; color:#e0e0e0; font-family:sans-serif; margin:0; padding:24px; }
  h1 { color:#ff3b3b; font-size:22px; margin-bottom:6px; }
  .summary { color:#7dc8ff; font-size:13px; margin-bottom:24px; }
  .club-section { margin-bottom:36px; }
  .club-section h2 { color:#fcd34d; font-size:18px; border-bottom:2px solid #fcd34d; padding-bottom:6px; margin-bottom:14px; text-transform:uppercase; letter-spacing:2px; }
  .club-section .count { font-size:13px; color:#94a3b8; margin-left:8px; letter-spacing:1px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:14px; }
  .card { background:#1e1e26; border:1px solid #3d3d4d; border-radius:8px; padding:10px; }
  .img-box { width:100%; aspect-ratio:1; background:linear-gradient(135deg,#243353,#0d1830); border-radius:6px; overflow:hidden; display:flex; align-items:center; justify-content:center; }
  .img-box img { max-width:100%; max-height:100%; object-fit:contain; }
  .name { font-size:13px; font-weight:bold; color:#fff; margin-top:8px; line-height:1.3; }
  .meta { font-size:10px; color:#7a8a9a; margin-top:3px; font-family:monospace; }
</style>
</head>
<body>
<h1>⚽ クラブ公式 選手プロフィール写真</h1>
<div class="summary">取得元: premierleague.com / 透明背景 PNG / 計 ${players.length}名 / 更新: ${esc(idx.updatedAt || 'unknown')}</div>
${sections}
</body>
</html>`;

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html);
  console.log(`Wrote: ${OUT_FILE}`);
  console.log(`Players: ${players.length}, Clubs: ${clubKeys.length}`);
  console.log(`URL: http://<vps>:3004/images_stock/_preview.html`);
}

main();
