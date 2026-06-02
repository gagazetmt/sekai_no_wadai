// scripts/migrate_stock_to_player_folders.js
// クラブフォルダ構造 → 選手フォルダ構造に移行
//
// Before: images_stock/players_official/{club-slug}/{player-slug}_{NNN}.jpg
// After:  images_stock/players_official/{player-slug}/{player-slug}_{NNN}.jpg
//
// 命名パターンが不明なファイルは _legacy/ に退避

const fs   = require('fs');
const path = require('path');

const STOCK_ROOT = path.join(__dirname, '..', 'images_stock', 'players_official');
const IDX_FILE   = path.join(__dirname, '..', 'data', 'players_official_index.json');
const LEGACY_DIR = path.join(STOCK_ROOT, '_legacy');

if (!fs.existsSync(LEGACY_DIR)) fs.mkdirSync(LEGACY_DIR, { recursive: true });

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(IDX_FILE, 'utf8')); } catch (_) { return { players: {} }; }
}
function saveIndex(idx) { fs.writeFileSync(IDX_FILE, JSON.stringify(idx, null, 2)); }

const idx = loadIndex();

// localPath → indexKey マップ
const pathToKey = {};
for (const [k, v] of Object.entries(idx.players || {})) {
  if (v.localPath) pathToKey[v.localPath.replace(/\\/g, '/')] = k;
}

let moved = 0, legacy = 0;

const clubs = fs.readdirSync(STOCK_ROOT).filter(c => {
  if (c.startsWith('_')) return false;
  return fs.statSync(path.join(STOCK_ROOT, c)).isDirectory();
});

for (const club of clubs) {
  const clubDir  = path.join(STOCK_ROOT, club);
  const files    = fs.readdirSync(clubDir).filter(f => /\.(jpg|png)$/i.test(f));
  const scoreRaw = (() => { try { return JSON.parse(fs.readFileSync(path.join(clubDir, 'score.json'), 'utf8')); } catch(_){return {};} })();

  for (const fname of files) {
    const oldFull = path.join(clubDir, fname);

    // 選手スラッグを抽出: {player-slug}_{NNN}.jpg
    const m = fname.match(/^([a-z][a-z0-9-]+)_(\d{3})\.(jpg|png)$/i);
    if (!m) {
      // 命名不明 → _legacy/
      const dest = path.join(LEGACY_DIR, `${club}_${fname}`);
      fs.renameSync(oldFull, dest);
      console.log(`  LEGACY: ${club}/${fname} → _legacy/`);
      legacy++;
      continue;
    }

    const playerSlug = m[1];
    const ext        = m[3].toLowerCase();
    const playerDir  = path.join(STOCK_ROOT, playerSlug);
    if (!fs.existsSync(playerDir)) fs.mkdirSync(playerDir, { recursive: true });

    // 選手フォルダ内の既存枚数で連番
    const existing = fs.readdirSync(playerDir).filter(f => /\.(jpg|png)$/i.test(f)).length;
    const num      = String(existing + 1).padStart(3, '0');
    const newName  = `${playerSlug}_${num}.${ext}`;
    const newFull  = path.join(playerDir, newName);

    fs.renameSync(oldFull, newFull);
    console.log(`  MOVE: ${club}/${fname} → ${playerSlug}/${newName}`);

    // score.json を選手フォルダに分割
    const playerScorePath = path.join(playerDir, 'score.json');
    const playerScores    = (() => { try { return JSON.parse(fs.readFileSync(playerScorePath, 'utf8')); } catch(_){return {};} })();
    const oldScore        = scoreRaw[fname] || { score: 0, addedAt: new Date().toISOString().slice(0, 10), lastUsed: null };
    playerScores[newName] = oldScore;
    fs.writeFileSync(playerScorePath, JSON.stringify(playerScores, null, 2));

    // インデックス更新
    const root   = path.join(__dirname, '..');
    const relOld = path.relative(root, oldFull).replace(/\\/g, '/');
    const relNew = path.relative(root, newFull).replace(/\\/g, '/');
    const oldKey = pathToKey[relOld];
    const newKey = `${playerSlug}_${num}`;
    const entry  = oldKey ? idx.players[oldKey] : null;
    if (entry) {
      idx.players[newKey] = { ...entry, localPath: relNew, club: playerSlug };
      delete idx.players[oldKey];
    } else {
      idx.players[newKey] = {
        name: playerSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        slug: playerSlug, club: playerSlug, league: '',
        localPath: relNew, sizeBytes: fs.statSync(newFull).size,
        addedAt: new Date().toISOString().slice(0, 10), source: 'migrated',
      };
    }
    moved++;
  }

  // クラブフォルダが空になったら削除
  const remaining = fs.readdirSync(clubDir).filter(f => /\.(jpg|png)$/i.test(f));
  if (!remaining.length) {
    try { fs.rmSync(clubDir, { recursive: true }); console.log(`  RMDIR: ${club}/`); }
    catch (_) {}
  }
}

saveIndex(idx);
console.log(`\n完了: ${moved}枚移行 / ${legacy}枚 → _legacy/`);
