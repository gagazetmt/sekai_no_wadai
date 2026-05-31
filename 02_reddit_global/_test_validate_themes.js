// スライドテーマごとのバリデータ判定テスト
// VPS上で実行する: node _test_validate_themes.js
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const BASE = __dirname;
const { prefetchEntities }   = require(BASE + '/scripts/modules/fetchers/entity_prefetcher');
const { walkEntity }         = require(BASE + '/scripts/v2_story/si_walker');
const { _validateSlideTypes } = require(BASE + '/v3_launcher/v3_planner');

function buildFetchedData(prefetched) {
  return Object.values(prefetched).filter(e => e.data).map(e => {
    const role = e.type === 'manager' ? 'manager' : e.type === 'team' ? 'team' : 'player';
    const slots = walkEntity(e.data, role).slice(0, 30).map(s => ({ label: s.label, value: s.value }));
    return { type: e.type, nameEn: e.nameEn, ok: true, slots };
  });
}

const entities = [
  { type: 'player',  nameEn: 'Andrew Robertson' },
  { type: 'team',    nameEn: 'Tottenham Hotspur' },
  { type: 'player',  nameEn: 'Destiny Udogie' },
  { type: 'manager', nameEn: 'Roberto De Zerbi' },
];

const themes = [
  {
    label: '① ロバートソンの今季の活躍',
    slide: {
      no: 2, slideType: 'stats',
      headline: 'Robertson今季スタッツ', theme: '今季活躍',
      keyPoints: ['今季ゴール数', 'アシスト数', '出場試合数', '評価点'],
      dataNeeds: ['Andrew Robertson ゴール / アシスト / 出場数'],
    },
  },
  {
    label: '② トッテナムの低迷状況',
    slide: {
      no: 2, slideType: 'stats',
      headline: 'Tottenham 2年連続17位の実態', theme: '低迷状況',
      keyPoints: ['今季勝点', '勝敗数', '得失点差', '失点数'],
      dataNeeds: ['Tottenham Hotspur 勝点 / 勝敗 / 得失点差'],
    },
  },
  {
    label: '③ Robertson vs Udogie 左SB比較',
    slide: {
      no: 2, slideType: 'comparison',
      headline: 'Robertson vs Udogie 左SB対決', theme: '左SB比較',
      keyPoints: ['アシスト数比較', '出場数比較', '評価点比較', '走行距離比較'],
      dataNeeds: ['Andrew Robertson アシスト / 出場数', 'Destiny Udogie アシスト / 出場数'],
    },
  },
  {
    label: '④ デゼルビの監督歴',
    slide: {
      no: 2, slideType: 'history',
      headline: 'デゼルビ監督キャリア', theme: '監督歴',
      keyPoints: ['SASSUOLO時代 2018-2021', 'ブライトン時代 2022-2023', 'マルセイユ時代 2023-2024', 'トッテナム就任 2025'],
      dataNeeds: ['Roberto De Zerbi 通算勝率 / 在籍クラブ'],
    },
  },
  {
    label: '⑤ Robertson市場価値推移',
    slide: {
      no: 2, slideType: 'timeline',
      headline: 'Robertson市場価値の変遷', theme: '市場価値推移',
      keyPoints: ['2017年移籍時800万ポンド', '2020年ピーク時65Mユーロ', '2024年15Mユーロ', '2026年現在11Mユーロ'],
      dataNeeds: ['Andrew Robertson 市場価値推移 2017-2026'],
    },
  },
];

(async () => {
  console.log('▶ エンティティ取得中...\n');
  const prefetched = await prefetchEntities(entities);
  const fetchedData = buildFetchedData(prefetched);

  console.log('取得完了:');
  fetchedData.forEach(d => {
    const labels = d.slots.slice(0, 5).map(s => s.label).join(' / ');
    console.log(`  ${d.nameEn.padEnd(22)} slots=${String(d.slots.length).padStart(2)}  [${labels}]`);
  });
  console.log('');

  const SEP = '─'.repeat(60);
  for (const { label, slide } of themes) {
    const mockSlides = [
      { no: 1, slideType: 'opening', headline: 'op', theme: '', keyPoints: [], dataNeeds: [] },
      slide,
      { no: 7, slideType: 'ending',  headline: 'ed', theme: '', keyPoints: [], dataNeeds: [] },
    ];
    const { slides, demotions } = _validateSlideTypes(mockSlides, fetchedData);
    const result   = slides[1];
    const demotion = demotions.find(d => d.no === 2);

    console.log(SEP);
    console.log(label);
    if (demotion) {
      console.log(`   結果: ❌ ${demotion.from.toUpperCase()} → ${demotion.to.toUpperCase()}`);
      console.log(`   理由: ${demotion.reason}`);
    } else {
      console.log(`   結果: ✅ ${result.slideType.toUpperCase()} 通過`);
    }

    // comparison の場合: どのエンティティが照合できたか詳細表示
    if (slide.slideType === 'comparison') {
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const text = [slide.headline, ...(slide.keyPoints || []), ...(slide.dataNeeds || [])].join(' ');
      const matched = fetchedData.filter(d => norm(text).includes(norm(d.nameEn)));
      console.log(`   照合エンティティ: ${matched.length}個 → ${matched.map(d => d.nameEn + '(' + d.slots.length + 'slots)').join(', ') || 'なし'}`);
      if (matched.length >= 2) {
        const sets = matched.map(e => new Set(e.slots.map(s => norm(s.label))));
        const shared = [...sets[0]].filter(l => sets.every(set => set.has(l)));
        console.log(`   共通ラベル: ${shared.length > 0 ? shared.slice(0, 6).join(', ') : 'なし → 異質比較'}`);
      }
    }
    console.log('');
  }
  console.log(SEP);
})().catch(e => console.error('ERROR:', e.message));
