// scripts/build_flags_index.js
// images_stock/flags/ 配下のファイルから data/flags_index.json を生成
//   ファイル名: {iso2}.{svg|png|jpg} (既存ストック)
//   index 形式: { updatedAt, total, flags: { 'jp': { iso2, localPath, sizeBytes, format } } }

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const FLAGS_DIR  = path.join(ROOT, 'images_stock', 'flags');
const INDEX_FILE = path.join(ROOT, 'data', 'flags_index.json');

function main() {
  if (!fs.existsSync(FLAGS_DIR)) {
    console.error('flags ディレクトリが見つかりません:', FLAGS_DIR);
    process.exit(1);
  }
  const files = fs.readdirSync(FLAGS_DIR).filter(f => /\.(svg|png|jpg|jpeg|webp)$/i.test(f));
  const flags = {};
  for (const f of files) {
    const m = f.match(/^([\w-]+)\.(svg|png|jpg|jpeg|webp)$/i);
    if (!m) continue;
    const iso2 = m[1].toLowerCase();
    const ext  = m[2].toLowerCase();
    const abs  = path.join(FLAGS_DIR, f);
    let size = 0;
    try { size = fs.statSync(abs).size; } catch (_) {}
    flags[iso2] = {
      iso2,
      format:    ext,
      localPath: path.relative(ROOT, abs).replace(/\\/g, '/'),
      sizeBytes: size,
    };
  }
  const out = {
    updatedAt: new Date().toISOString(),
    total: Object.keys(flags).length,
    flags,
  };
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(out, null, 2));
  console.log(`✅ flags_index.json 生成完了: ${out.total} 国`);
  // 主要国のサンプル表示
  ['jp', 'fr', 'es', 'de', 'it', 'gb', 'br', 'ar'].forEach(c => {
    const e = flags[c];
    if (e) console.log(`  ${c}: ${e.localPath} (${(e.sizeBytes/1024).toFixed(1)}KB)`);
  });
}

if (require.main === module) main();
