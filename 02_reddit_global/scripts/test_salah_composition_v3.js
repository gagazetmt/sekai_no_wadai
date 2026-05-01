// scripts/test_salah_composition_v3.js
// Step B: curated recipes 層を AI に提示する composition テスト
// 使い方: node -r dotenv/config scripts/test_salah_composition_v3.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { walkEntity } = require('./v2_story/si_walker');
const { applicableRecipes, expandRecipe, hasRecipe } = require('./v2_story/recipes_curated');
const { callAI }     = require('./ai_client');
const { fetchSofaScorePlayer }  = require('./modules/fetchers/sofascore_player');
const { fetchSofaScoreTeam }    = require('./modules/fetchers/sofascore_team');
const { fetchSofaScoreManager } = require('./modules/fetchers/sofascore_manager');

const NEWS_CONTEXT = `
【案件】[Liverpool FC] モハメド・サラー、今季中に再びピッチに立つ予定
- サラーは負傷から復帰見込み（記事は「予定」「見込み」と書いている）
- 当該記事の発表前にエジプト代表チームが「今季終了後」と公表したが、それと矛盾
- リヴァプール終盤戦・W杯シーズンに向けた重要トピック

【上位コメント（視聴者の感想・予測。事実ではない）】
- 「アベンジャーズ／ドゥームズデイで復活してきそう」
- 「リヴァプールらしさ全開」（皮肉）
- 「エジプトサッカー協会の発表は変だった」
`.trim();

function buildPrompt(entities) {
  const blocks = entities.map(e => {
    const slots = walkEntity(e.data, e.role);
    const top = slots.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 25);
    const slotsLines = top.map(s => `      - "${s.key}" (p:${s.priority}, ${s.category}): ${s.label} = ${s.value}`).join('\n');
    const recipes = applicableRecipes(slots, e.role, false);
    const recipeLines = recipes.map(r => `      - "${r.key}": ${r.label} — ${r.description}`).join('\n');
    return `━━━ ${e.label} (role=${e.role}) ━━━ slot ${slots.length} 件:
    【利用可能レシピ】
${recipeLines || '      (なし)'}
    【生 walker slot (priority 上位25件)】
${slotsLines}`;
  });
  return `あなたはサッカー YouTube 動画の構成プロデューサー。

${NEWS_CONTEXT}

${blocks.join('\n\n')}

━━━ 【ファクト管理ルール（厳守）】━━━
- 案件本文に「予定」「見込み」と書かれてる事象を、scriptDir で「復帰戦」「復帰した」と完了形に書かない
- 上位コメントは reaction 型でファンの声として紹介する用途のみ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【タスク】
opening / 目次 / ending を除いた **本編 6 スライド** の設計図を JSON で返す:

[
  {
    "idx": 1,
    "type": "insight|stats|profile|comparison|history|reaction",
    "title": "10〜25文字の見出し",
    "primary": "**必ず上記リストのエンティティラベル**（『Mohamed Salah』『Liverpool FC』『Arne Slot』のいずれか）",
    "secondary": "比較相手ラベル（comparison のみ）",
    "recipeKey": "<上記レシピキー>",   ← 推奨：レシピが意図と合う場合
    // または
    "customSlotKeys": [...],          ← レシピが合わない場合のみ
    "scriptDir": "何を語らせるか・どのデータをどう編むか 2〜3文"
  },
  ...
]

【設計指針】
- ニュースの「サラー復帰見込み」「終盤戦・W杯影響」を軸に**起承転結**
- type は **必ず3種以上** 含む（insight 連発禁止）
- 6枚通して同じデータ系列を繰り返さない
- **recipeKey を優先的に使う**（意図と合致するレシピがあるなら 1 単語で指定）
- recipeKey と customSlotKeys は **どちらか片方** だけ返す（recipeKey が優先）

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
  console.log(`ユニーク type 数: ${new Set(types).size} / ${types.length}`);
  const recipeUsed = parsed.filter(s => s.recipeKey).length;
  console.log(`recipeKey 採用: ${recipeUsed} / ${parsed.length} スライド\n`);
  parsed.forEach(s => {
    console.log(`[${s.idx}] type=${s.type.padEnd(11)} | ${s.title}`);
    console.log(`    primary=${s.primary}${s.secondary ? ' / secondary=' + s.secondary : ''}`);
    const pool = slotsByEntity[s.primary] || [];
    let keys = [];
    let recipeMark = '';
    if (s.recipeKey && hasRecipe(s.recipeKey)) {
      keys = expandRecipe(s.recipeKey, pool) || [];
      recipeMark = ` [recipe: ${s.recipeKey} → ${keys.length}keys]`;
    } else if (Array.isArray(s.customSlotKeys)) {
      keys = s.customSlotKeys;
      recipeMark = ' [custom slots]';
    }
    console.log(`    引用データ${recipeMark}:`);
    const map = new Map(pool.map(x => [x.key, x]));
    keys.forEach(k => {
      const slot = map.get(k);
      console.log(`      ${slot ? slot.label + '=' + slot.value : '❌' + k + '(not found)'}`);
    });
    console.log(`    scriptDir: ${s.scriptDir}`);
    console.log('');
  });
}

async function main() {
  console.log('Fetching latest data ...');
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
  console.log('Walker results:');
  entities.forEach(e => console.log(`  ${e.label}(${e.role}): ${slotsByEntity[e.label].length} slots / ${applicableRecipes(slotsByEntity[e.label], e.role, false).length} recipes`));

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

  fs.writeFileSync(path.join(__dirname, '..', 'data', '_salah_composition_v3_sonnet.json'),   sonnet.raw   || '');
  fs.writeFileSync(path.join(__dirname, '..', 'data', '_salah_composition_v3_deepseek.json'), deepseek.raw || '');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
