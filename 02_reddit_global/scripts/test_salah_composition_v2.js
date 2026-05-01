// scripts/test_salah_composition_v2.js
// データ拡張後の Salah で composition テスト再走
// (シーズン履歴 / 代表 / 移籍 が AI の構成判断にどう効くか確認)
// 使い方: node -r dotenv/config scripts/test_salah_composition_v2.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { walkEntity } = require('./v2_story/si_walker');
const { callAI }     = require('./ai_client');
const { fetchSofaScorePlayer }  = require('./modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam }    = require('./modules/fetchers/sofascore_team');
const { fetchSofaScoreManager } = require('./modules/fetchers/sofascore_manager');

const NEWS_CONTEXT = `
【案件】[Liverpool FC] モハメド・サラー、今季中に再びピッチに立つ
- サラーは負傷から復帰、エジプト代表 W杯予選 → 戻った
- アンフィールドで20分の出場、3チャンス創出
- リヴァプール終盤戦への合流確定
- W杯シーズンに向けた重要トピック

【上位コメント】
- 「アベンジャーズ／ドゥームズデイで復活してきそう」
- 「リヴァプールらしさ全開」
- 「エジプトサッカー協会が『今季終了後』と発表したのは変だった」
`.trim();

function slotsTable(slots) {
  return slots.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map(s => `  - ${s.key} | ${s.category} | ${s.label} | ${s.value}`).join('\n');
}

function buildPrompt(entities) {
  const blocks = entities.map(e => {
    const slots = walkEntity(e.data, e.role);
    return `━━━ ${e.label} (role=${e.role}) ━━━ slot ${slots.length} 件:\n${slotsTable(slots)}`;
  });
  return `あなたはサッカー YouTube 動画の構成プロデューサー。脚本そのものは別の脚本家が書きます。
あなたの仕事は **どのスライドを並べるか・各スライドで何を伝えるか・どのデータを引用するか** を設計すること。narration は書かない。

${NEWS_CONTEXT}

${blocks.join('\n\n')}

【タスク】
opening / 目次 / ending を除いた **本編 6 スライド** の設計図を JSON で返す:

[
  {
    "idx": 1,
    "type": "insight|stats|profile|comparison|history|reaction",
    "title": "10〜25文字の見出し",
    "primary": "**必ず上記リストのエンティティラベル**（『Mohamed Salah』『Liverpool FC』『Arne Slot』のいずれか） — 説明文や数字ではなくラベル文字列をそのまま",
    "secondary": "比較相手ラベル（comparison のみ・同じくラベル文字列）",
    "customSlotKeys": ["walker のキー文字列の配列", "comparison は 5 件、その他は 6 件"],
    "scriptDir": "何を語らせるか・どのデータをどう編むか 2〜3文（ここに固有名詞や数字を含めてOK）"
  },
  ...
]

【設計指針】
- ニュースの「サラー復帰」「終盤戦・W杯への影響」を軸に**起承転結**
- type は **必ず3種以上** 含む（insight 連発禁止、stats / history / comparison / reaction を組合せる）
- customSlotKeys は数字データが入る key を優先
- 6枚通して **同じデータ系列を繰り返し引用しない**
- スライドごとに「フック→深掘り→展望」の役割を変える
- **過去シーズンの推移** や **代表/移籍履歴** が活きるなら積極的に使う

【JSON 出力ルール】
- 文字列値で半角ダブルクォート禁止、代わりに 『』 を使う
- コードフェンス不要

JSON のみ返答。`;
}

async function _ask(provider, prompt) {
  const t0 = Date.now();
  const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
  const max_tokens = provider === 'deepseek' ? 4500 : 4000;
  const raw = await callAI({ forceProvider: provider, model, max_tokens, messages: [{ role: 'user', content: prompt }] });
  return { raw, elapsed: ((Date.now() - t0) / 1000).toFixed(1) };
}
function parseJson(raw) {
  const m = raw && raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function render(label, parsed, slotsByEntity, elapsed) {
  console.log(`\n${'═'.repeat(70)}\n${label} (${elapsed}秒)\n${'═'.repeat(70)}`);
  if (!Array.isArray(parsed)) { console.log('❌ JSON parse 失敗'); return; }
  const types = parsed.map(s => s.type);
  console.log(`type 構成: ${types.join(' → ')}`);
  console.log(`ユニーク type 数: ${new Set(types).size} / ${types.length}\n`);
  parsed.forEach(s => {
    console.log(`[${s.idx}] type=${s.type.padEnd(11)} | ${s.title}`);
    console.log(`    primary=${s.primary}${s.secondary ? ' / secondary=' + s.secondary : ''}`);
    const pool = slotsByEntity[s.primary] || [];
    const map = new Map(pool.map(x => [x.key, x]));
    console.log(`    引用データ:`);
    (s.customSlotKeys || []).forEach(k => {
      const slot = map.get(k);
      console.log(`      ${slot ? slot.label + '=' + slot.value : '❌' + k + '(not found)'}`);
    });
    console.log(`    scriptDir: ${s.scriptDir}`);
    console.log('');
  });
}

async function main() {
  console.log('Fetching latest data for Salah / Liverpool FC / Arne Slot ...');
  const t0 = Date.now();
  const [salahSofa, livSofa, slotSofa] = await Promise.all([
    fetchSofaScorePlayer('Mohamed Salah'),
    fetchSofaScoreTeam('Liverpool FC'),
    fetchSofaScoreManager('Arne Slot'),
  ]);
  console.log(`fetched in ${((Date.now()-t0)/1000).toFixed(1)}秒`);

  const entities = [
    { label: 'Mohamed Salah', role: 'player',  data: { ...salahSofa, _wiki: null } },
    { label: 'Liverpool FC',  role: 'team',    data: { ...livSofa,   _wiki: null } },
    { label: 'Arne Slot',     role: 'manager', data: { ...slotSofa,  _wiki: null } },
  ];

  const slotsByEntity = {};
  entities.forEach(e => { slotsByEntity[e.label] = walkEntity(e.data, e.role); });
  console.log('\nWalker results:');
  entities.forEach(e => console.log(`  ${e.label}(${e.role}): ${slotsByEntity[e.label].length} slots`));

  const prompt = buildPrompt(entities);
  console.log(`\nプロンプト長: ${prompt.length} 文字`);

  console.log('\n両モデル並列実行中...');
  const [sonnet, deepseek] = await Promise.all([
    _ask('anthropic', prompt).catch(e => ({ raw: '', elapsed: '0', error: e.message })),
    _ask('deepseek', prompt).catch(e => ({ raw: '', elapsed: '0', error: e.message })),
  ]);

  if (sonnet.error)   console.log('Sonnet エラー:',   sonnet.error);
  if (deepseek.error) console.log('DeepSeek エラー:', deepseek.error);

  render('Sonnet 4.6',     parseJson(sonnet.raw),   slotsByEntity, sonnet.elapsed);
  render('DeepSeek V4-Flash', parseJson(deepseek.raw), slotsByEntity, deepseek.elapsed);

  fs.writeFileSync(path.join(__dirname, '..', 'data', '_salah_composition_v2_sonnet.json'),   sonnet.raw   || '');
  fs.writeFileSync(path.join(__dirname, '..', 'data', '_salah_composition_v2_deepseek.json'), deepseek.raw || '');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
