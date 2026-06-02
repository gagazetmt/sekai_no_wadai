// scripts/warehouse_revert_scene.js
// scene付きファイル名（andrew-robertson_portrait_001.jpg）を
// フラット連番（andrew-robertson_001.jpg）に戻す

const fs   = require('fs');
const path = require('path');

const STOCK    = path.join(__dirname, '..', 'images_stock', 'players_official');
const IDX_FILE = path.join(__dirname, '..', 'data', 'players_official_index.json');

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(IDX_FILE, 'utf8')); } catch (_) { return { players: {} }; }
}
function saveIndex(idx) { fs.writeFileSync(IDX_FILE, JSON.stringify(idx, null, 2)); }

const idx = loadIndex();

// localPath → indexKey のマップ
const pathToKey = {};
for (const [k, v] of Object.entries(idx.players || {})) {
  if (v.localPath) pathToKey[v.localPath.replace(/\\/g, '/')] = k;
}

let renamed = 0;
const clubs = fs.readdirSync(STOCK).filter(c =>
  fs.statSync(path.join(STOCK, c)).isDirectory()
);

for (const club of clubs) {
  const dir   = path.join(STOCK, club);
  const files = fs.readdirSync(dir).filter(f => /\.(jpg|png)$/i.test(f));

  // 選手スラッグ別にグループ化
  // 命名パターン: {slug}_{scene}_{NNN}.ext または {slug}_{NNN}.ext
  const groups = {};
  for (const f of files) {
    const m = f.match(/^([a-z0-9-]+?)(?:_[a-z]+)?_(\d{3})\.(jpg|png)$/i);
    if (!m) continue;
    const slug = m[1];
    if (!groups[slug]) groups[slug] = [];
    groups[slug].push(f);
  }

  for (const [slug, grpFiles] of Object.entries(groups)) {
    grpFiles.sort(); // 安定ソート（アルファベット順）

    grpFiles.forEach((oldName, i) => {
      const ext     = oldName.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      const newName = `${slug}_${String(i + 1).padStart(3, '0')}.${ext}`;
      if (oldName === newName) return;

      const oldFull = path.join(dir, oldName);
      const newFull = path.join(dir, newName);
      fs.renameSync(oldFull, newFull);

      // インデックス更新
      const root   = path.join(__dirname, '..');
      const relOld = path.relative(root, oldFull).replace(/\\/g, '/');
      const relNew = path.relative(root, newFull).replace(/\\/g, '/');
      const oldKey = pathToKey[relOld];
      if (oldKey && idx.players[oldKey]) {
        const entry  = idx.players[oldKey];
        const newKey = `${slug}_${club}_${String(i + 1).padStart(3, '0')}`;
        idx.players[newKey] = { ...entry, localPath: relNew };
        delete idx.players[oldKey];
        pathToKey[relNew] = newKey;
      }
      console.log(`  ${oldName} → ${newName}`);
      renamed++;
    });
  }
}

saveIndex(idx);
console.log(`\n完了: ${renamed}枚リネーム`);
