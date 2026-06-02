// _test_v3_robertson_images.js
// Robertson の画像をV3フェッチャーで取得し、saved_projects に案件を作る

process.env.REPLY_SCORE_ENABLED = 'true';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs   = require('fs');
const path = require('path');
const { fetchAndAssignSlideImages } = require('./v3_launcher/v3_image_fetcher');

// Robertson の stats / profile / comparison を想定したスライド
const testSlides = [
  {
    no: 1,
    slideType: 'stats',
    imageInstruction: {
      placement: 'left',
      description: 'ロバートソンがリヴァプールのユニフォームでオーバーラップしているシーン',
      searchKeywords: ['Andrew Robertson', 'Liverpool', 'action'],
    },
  },
  {
    no: 2,
    slideType: 'profile',
    imageInstruction: {
      placement: 'left',
      description: 'ロバートソンのポートレート写真',
      searchKeywords: ['Andrew Robertson', 'Liverpool', 'portrait'],
    },
  },
  {
    no: 3,
    slideType: 'comparison',
    imageInstruction: {
      placement: 'left+right',
      left:  { description: 'ロバートソン', searchKeywords: ['Andrew Robertson', 'Liverpool'] },
      right: { description: 'トレント', searchKeywords: ['Trent Alexander-Arnold', 'Liverpool'] },
    },
  },
  {
    no: 4,
    slideType: 'opening',
    imageInstruction: {
      placement: 'background',
      description: 'リヴァプールのスタジアム全景',
      searchKeywords: ['Liverpool', 'Anfield', 'stadium'],
    },
  },
];

async function main() {
  console.log('=== Robertson 画像取得テスト開始 ===');
  console.log('スライド数:', testSlides.length);
  console.log('REPLY_SCORE_ENABLED:', process.env.REPLY_SCORE_ENABLED);
  console.log('');

  const slides = await fetchAndAssignSlideImages(testSlides);

  console.log('\n=== 結果 ===');
  for (const s of slides) {
    console.log(`\n[スライド${s.no}] ${s.slideType}`);
    console.log('  自動割当:', s.images.length ? s.images : '(なし)');
    console.log('  候補数:', (s.imageCandidates || []).length);
    if (s.imageCandidates?.length) {
      s.imageCandidates.slice(0, 3).forEach((c, i) =>
        console.log(`    候補${i+1}: [${c.source}] score=${c.score} ${c.title?.slice(0,40)}`)
      );
    }
  }

  // sharedImagePool を作成（全候補を集約）
  const seen = new Set();
  const pool = slides
    .flatMap(s => s.imageCandidates || [])
    .filter(c => { if (!c.url || seen.has(c.url)) return false; seen.add(c.url); return true; });

  console.log('\n=== sharedImagePool ===');
  console.log('合計候補:', pool.length, '枚');
  pool.forEach((c, i) => console.log(`  [${i+1}] [${c.source}] ${c.url?.slice(0,60)}`));

  // V3 saved_projects.json に Robertson 案件を作成 / 更新
  const SAVED_FILE = path.join(__dirname, 'data', 'saved_projects.json');
  let projects = [];
  try { projects = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')); } catch (_) {}
  if (!Array.isArray(projects)) projects = [];

  const postId = 'v3_robertson_test';
  const idx    = projects.findIndex(p => (p.id || p.postId) === postId);
  const v3Modules = slides.map(s => ({
    type:            s.slideType,
    title:           s.imageInstruction?.description || '',
    images:          s.images || [],
    imageCandidates: s.imageCandidates || [],
    narration:       '',
    dataSlots:       [],
  }));

  const entry  = {
    id:              postId,
    postId:          postId,
    title:           'Robertson テスト案件（V3画像フェッチャー）',
    topic:           'Andrew Robertson Liverpool',
    savedAt:         new Date().toISOString(),
    source:          'custom',
    // トップレベルに置く → currentPlan.sharedImagePool で参照可能
    sharedImagePool: pool,
    v3Modules,
    researchData: {
      sharedImagePool: pool,
      v3Modules,
    },
  };

  if (idx >= 0) projects[idx] = entry;
  else          projects.push(entry);

  if (!fs.existsSync(path.dirname(SAVED_FILE))) {
    fs.mkdirSync(path.dirname(SAVED_FILE), { recursive: true });
  }
  fs.writeFileSync(SAVED_FILE, JSON.stringify(projects, null, 2));
  console.log('\n✅ saved_projects.json に保存しました (id:', postId, ')');
  console.log('V3ランチャーの「保存済み」タブで確認できます');
}

main().catch(e => {
  console.error('❌ エラー:', e.message);
  console.error(e.stack);
  process.exit(1);
});
