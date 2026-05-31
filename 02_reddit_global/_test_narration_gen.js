// ナレーション生成テスト: DeepSeek脚本構成 → DeepSeek / Sonnet 両モデルでナレーション生成
// VPS上で実行: node _test_narration_gen.js
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const { prefetchEntities }   = require('./scripts/modules/fetchers/entity_prefetcher');
const { walkEntity }         = require('./scripts/v2_story/si_walker');
const { synthesizeStepData } = require('./v3_launcher/v3_synthesizer');
const { generateNarration }  = require('./v3_launcher/v3_planner');

const topic = 'ロバートソンがトッテナム移籍でhere we go!2年連続17位の苦境を救えるか';

// ── DeepSeekが前回生成した脚本構成（確定版） ──────────────────────────
const deepseekScriptSlides = [
  {
    no: 1, slideType: 'opening', headline: 'チャンピオンズリーグ覇者が17位のトッテナムへ',
    keyPoints: [
      'ファブリツィオ・ロマーノがHere We Goと報じた衝撃',
      'ユヴェントスのハイジャックを退けてトッテナムを選んだ理由',
      '2年連続17位のクラブに32歳レジェンドが行く意味',
    ],
    dataNeeds: [
      'Andrew Robertson: リヴァプールでCL優勝含む9タイトル',
      'Tottenham Hotspur: 2年連続17位（今季勝点41）',
      '移籍専門家ロマーノ「Here We Go」の引用',
    ],
    estimatedSec: 45,
  },
  {
    no: 2, slideType: 'insight', headline: '1月に起きた「未完の移籍」',
    keyPoints: [
      '1月の移籍市場でロバートソンとトッテナムが合意寸前に',
      'リヴァプールがツィミカスをローマから呼び戻せず撤回',
      '「もしあの時移籍していれば…」というIFの物語',
    ],
    dataNeeds: [
      'リヴァプール: 今季5位、左SB層の薄さ',
      'ツィミカス: レンタル先ローマからの復帰失敗',
    ],
    estimatedSec: 50,
  },
  {
    no: 3, slideType: 'stats', headline: '残留争いとデゼルビのラブコール',
    keyPoints: [
      'トッテナムは最終節でエヴァートンに1-0勝利し残留',
      'デゼルビ監督が自らロバートソン獲得を強く希望',
      'チームにリーダー不在・精神的脆さが課題',
    ],
    dataNeeds: [
      'Tottenham Hotspur: 最終節エヴァートン1-0、残留決定',
      'Tottenham Hotspur: 2年連続17位 勝点41 得失点差-9',
      'Roberto De Zerbi 監督就任',
    ],
    estimatedSec: 60,
  },
  {
    no: 4, slideType: 'profile', headline: 'スーパーマーケット店員から世界一へ',
    keyPoints: [
      '10代でスーパーマーケットで働きながらサッカーを続けた苦労',
      'ハル・シティから800万ポンドでリヴァプールへ移籍',
      'バルセロナ移籍の噂も断ったリヴァプールへの義理',
    ],
    dataNeeds: [
      'Andrew Robertson: ハル・シティからリヴァプールへ移籍金800万ポンド',
      'Andrew Robertson: リヴァプール378試合14ゴール69アシスト',
    ],
    estimatedSec: 55,
  },
  {
    no: 5, slideType: 'stats', headline: 'トッテナムに足りない「勝者のDNA」',
    keyPoints: [
      'スコットランド代表主将としてのリーダーシップ',
      'トッテナムには精神的脆さとリーダー不足が指摘される',
      'ロバートソンがキャプテンに就任する可能性',
    ],
    dataNeeds: [
      'Andrew Robertson: リヴァプール378試合、9タイトル',
      'Tottenham Hotspur: 今季勝点41、得失点差-9',
    ],
    estimatedSec: 55,
  },
  {
    no: 6, slideType: 'insight', headline: 'W杯と左SB争い、チームの基準引き上げ',
    keyPoints: [
      '28年ぶりW杯出場のスコットランド代表をロバートソンが率いる',
      'ウドジェとの左SBポジション争いの活性化',
      'チーム全体の基準を引き上げる存在に',
    ],
    dataNeeds: [
      'Scotland: 28年ぶりW杯出場',
      'Tottenham Hotspur: 今季失点57（守備の課題）',
    ],
    estimatedSec: 50,
  },
  {
    no: 7, slideType: 'ending', headline: '再建の「第一手」か、希望的観測か',
    keyPoints: [
      'フリー移籍で1人のベテランを獲る意義',
      'ロバートソン一人で成績を劇的に改善できるわけではない',
      '視聴者に問いかける：この移籍をどう評価する？',
    ],
    dataNeeds: [
      'Andrew Robertson: フリー移籍（移籍金0）市場価値€11M',
      'Tottenham Hotspur: メディカルチェック予定、正式発表待ち',
    ],
    estimatedSec: 40,
  },
];

function buildFetchedData(prefetched) {
  return Object.values(prefetched).filter(e => e.data).map(e => {
    const role = e.type === 'manager' ? 'manager' : e.type === 'team' ? 'team' : 'player';
    const slots = walkEntity(e.data, role).slice(0, 30).map(s => ({ label: s.label, value: s.value }));
    return { type: e.type, nameEn: e.nameEn, ok: true, slots };
  });
}

function printImageInstruction(img) {
  if (!img) return;
  if (img.placement === 'left+right') {
    console.log(`  🖼  配置: 左右`);
    if (img.left)  console.log(`       左: ${img.left.description}  キーワード: ${(img.left.searchKeywords||[]).join(', ')}`);
    if (img.right) console.log(`       右: ${img.right.description}  キーワード: ${(img.right.searchKeywords||[]).join(', ')}`);
  } else {
    console.log(`  🖼  配置: ${img.placement || '?'}  ${img.description || ''}`);
    if ((img.searchKeywords||[]).length) console.log(`       キーワード: ${img.searchKeywords.join(', ')}`);
  }
}

function printResult(label, r, elapsed) {
  const SEP = '━'.repeat(60);
  console.log(`\n${SEP}`);
  if (!r.ok) { console.log(`【${label}】❌ ${elapsed}s — ${r.error}`); return; }
  console.log(`【${label}】✅ ${elapsed}s`);
  console.log('');
  (r.slides || []).forEach(s => {
    console.log(`${'─'.repeat(50)}`);
    console.log(`[${s.no}] ${(s.slideType || '').toUpperCase().padEnd(12)} | ${s.headline}`);
    console.log('');
    console.log('【ナレーション】');
    console.log(s.narration || '（なし）');
    console.log(`  ※ ${(s.narration||'').length}文字`);
    console.log('');
    if ((s.displayText || []).length) {
      console.log('【画面テキスト】');
      (s.displayText || []).forEach(t => console.log(`  • ${t}`));
      console.log('');
    }
    if ((s.dataDisplay || []).length) {
      console.log('【表示データ】');
      (s.dataDisplay || []).forEach(d => console.log(`  📊 ${d}`));
      console.log('');
    }
    if (s.imageInstruction) {
      console.log('【画像指示】');
      printImageInstruction(s.imageInstruction);
      console.log('');
    }
  });
}

(async () => {
  console.log('▶ エンティティ取得中...');
  const prefetched = await prefetchEntities([
    { type: 'player',  nameEn: 'Andrew Robertson' },
    { type: 'team',    nameEn: 'Tottenham Hotspur' },
    { type: 'manager', nameEn: 'Roberto De Zerbi' },
    { type: 'team',    nameEn: 'Liverpool' },
  ]);
  const fetchedData = buildFetchedData(prefetched);
  fetchedData.forEach(d => console.log(`  ${d.nameEn}: ${d.slots.length}slots`));

  const { enrichedMemo } = await synthesizeStepData({
    topic, rawMemo: '', fetchedData,
    research: { learningCorpus: [] }, wikiStories: null,
  });

  console.log('\n▶ ナレーション生成（DeepSeek Chat）...\n');
  const t0 = Date.now();

  const dsResult = await generateNarration(topic, deepseekScriptSlides, enrichedMemo, fetchedData, {
    provider: 'deepseek', model: 'deepseek-chat', label: 'narration_deepseek', maxTokens: 10000,
  }).then(r => ({ r, elapsed: ((Date.now() - t0) / 1000).toFixed(1) }));

  printResult('DeepSeek Chat ナレーション＋画像指示', dsResult.r, dsResult.elapsed);

  console.log(`\n並列実行合計: ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
})().catch(e => console.error('ERROR:', e.message, e.stack));
