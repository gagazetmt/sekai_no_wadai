// scripts/warehouse_rename_existing.js
// 旧命名（andrew-robertson_001.jpg）を新命名（andrew-robertson_portrait_001.jpg）に一括変換
// インデックスの scene フィールドを参照してリネーム
// 実行: node scripts/warehouse_rename_existing.js

const fs   = require('fs');
const path = require('path');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'players_official');
const INDEX_FILE = path.join(__dirname, '..', 'data', 'players_official_index.json');
const VALID_SCENES = ['portrait', 'play', 'goal', 'celebration', 'sadness', 'training', 'other'];

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch (_) { return { players: {} }; }
}
function saveIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

// 旧形式かどうか: {slug}_{NNN}.{ext}（scene部分がない）
function isOldFormat(filename) {
  return /^[a-z0-9-]+_\d{3}\.(jpg|png)$/i.test(filename)
    && !VALID_SCENES.some(s => filename.includes('_' + s + '_'));
}

async function main() {
  const idx = loadIndex();
  // localPath → index key のマップ
  const pathToKey = {};
  for (const [key, entry] of Object.entries(idx.players || {})) {
    if (entry.localPath) pathToKey[entry.localPath.replace(/\\/g, '/')] = key;
  }

  let renamed = 0;
  let skipped = 0;

  // 全クラブフォルダをスキャン
  const clubs = fs.readdirSync(STOCK_DIR).filter(c =>
    fs.statSync(path.join(STOCK_DIR, c)).isDirectory()
  );

  for (const club of clubs) {
    const clubDir = path.join(STOCK_DIR, club);
    const files   = fs.readdirSync(clubDir).filter(isOldFormat);
    if (!files.length) continue;

    // シーンカウンター（新命名での連番管理）
    const sceneCounters = {};

    for (const file of files.sort()) {
      const oldPath    = path.join(clubDir, file);
      const relOldPath = path.relative(path.join(__dirname, '..'), oldPath).replace(/\\/g, '/');
      const indexKey   = pathToKey[relOldPath];
      const entry      = indexKey ? idx.players[indexKey] : null;

      // インデックスから scene を取得、なければ 'other'
      const scene = (entry?.scene && VALID_SCENES.includes(entry.scene))
        ? entry.scene
        : 'other';

      // 新命名の連番
      const sceneKey = `${club}_${entry?.slug || file.replace(/_\d+\.\w+$/, '')}_${scene}`;
      sceneCounters[sceneKey] = (sceneCounters[sceneKey] || 0) + 1;
      const num = String(sceneCounters[sceneKey]).padStart(3, '0');

      const playerSlug = entry?.slug || file.replace(/_\d+\.\w+$/, '');
      const ext        = file.endsWith('.png') ? 'png' : 'jpg';
      const newName    = `${playerSlug}_${scene}_${num}.${ext}`;
      const newPath    = path.join(clubDir, newName);

      if (fs.existsSync(newPath)) {
        console.log(`  SKIP（既存）: ${newName}`);
        skipped++;
        continue;
      }

      fs.renameSync(oldPath, newPath);
      console.log(`  RENAME: ${file} → ${newName}`);

      // インデックス更新
      if (indexKey && entry) {
        const newRelPath = path.relative(path.join(__dirname, '..'), newPath).replace(/\\/g, '/');
        const newKey     = `${playerSlug}_${club}_${scene}_${num}`;
        idx.players[newKey] = { ...entry, localPath: newRelPath, scene };
        delete idx.players[indexKey];
        pathToKey[newRelPath] = newKey;
      }
      renamed++;
    }
  }

  saveIndex(idx);
  console.log(`\n完了: ${renamed}枚リネーム / ${skipped}枚スキップ`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
