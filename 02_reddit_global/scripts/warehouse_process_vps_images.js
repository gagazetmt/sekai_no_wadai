// scripts/warehouse_process_vps_images.js
// VPS の images/ ディレクトリにある旧V1/V2画像を
// warehouse/pending/ にコピーして Gemini 認識 → 選手フォルダに格納
//
// 使い方（VPS上で）:
//   node scripts/warehouse_process_vps_images.js
//   node scripts/warehouse_process_vps_images.js --dry-run   # コピーせず枚数確認のみ

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs   = require('fs');
const path = require('path');

const IMG_DIR     = path.join(__dirname, '..', 'images');
const PENDING_DIR = path.join(__dirname, '..', 'images', 'warehouse', 'pending');
const DRY_RUN     = process.argv.includes('--dry-run');

if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });

// 処理対象: images/*.jpg / *.png（サブフォルダ除く）
// 除外: v3_cache / warehouse / common 等のサブフォルダ、テスト用ファイル
const candidates = fs.readdirSync(IMG_DIR).filter(f => {
  if (!fs.statSync(path.join(IMG_DIR, f)).isFile()) return false;
  if (!/\.(jpg|png|jpeg|webp)$/i.test(f)) return false;
  // V1/V2 の命名パターン: YYYY-MM-DD_N_xxx.jpg / testxxx 除外
  if (/^test/i.test(f)) return false;
  if (/^cli/i.test(f)) return false;
  return true;
});

console.log(`対象: ${candidates.length}枚`);
if (DRY_RUN) {
  console.log('-- dry-run モード（コピーのみ確認）--');
  candidates.slice(0, 20).forEach(f => console.log(' ', f));
  if (candidates.length > 20) console.log(`  ...他 ${candidates.length - 20}枚`);
  process.exit(0);
}

// pending/ にコピー（既存はスキップ）
let copied = 0, skipped = 0;
for (const f of candidates) {
  const dest = path.join(PENDING_DIR, f);
  if (fs.existsSync(dest)) { skipped++; continue; }
  fs.copyFileSync(path.join(IMG_DIR, f), dest);
  copied++;
}
console.log(`コピー完了: ${copied}枚 / スキップ（既存）: ${skipped}枚`);
console.log('');
console.log('次のコマンドで認識を実行:');
console.log('  node scripts/warehouse_recognize.js');
