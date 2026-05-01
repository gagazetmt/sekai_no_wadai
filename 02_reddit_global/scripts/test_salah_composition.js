// scripts/test_salah_composition.js
// Salah案件で「脚本構成（type / primary / customSlotKeys / scriptDir）」を
// Sonnet vs DeepSeek で比較。narration は出させない。
// 使い方: node -r dotenv/config scripts/test_salah_composition.js

'use strict';

const fs = require('fs');
const path = require('path');
const { walkEntity } = require('./v2_story/si_walker');
const { callAI } = require('./ai_client');

const SI_FILE = path.join(__dirname, '..', 'data', 'si_data',
  '_r_soccer_comments_1sz59bn_liverpool_fc_mohamed_salah_will_play_again_before_.json');

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

function loadEntity(si, label) {
  const it = (si.boxes?.entity?.items || []).find(x => x.label === label);
  if (!it) return null;
  const sofaOk = !!it.sofa?.ok, wikiOk = !!it.wiki?.ok;
  if (!sofaOk && !wikiOk) return null;
  return { role: it.role, label: it.label, data: { ...(sofaOk ? it.sofa : {}), _wiki: wikiOk ? it.wiki : null } };
}
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
    "title": "短い見出し（10〜25文字）",
    "primary": "エンティティラベル（必ず上記リストのラベルそのまま）",
    "secondary": "比較相手ラベル（comparison のみ）",
    "customSlotKeys": ["k1",...],
    "scriptDir": "このスライドで脚本家に何を語らせるか・どのデータをどう編むかを2〜3文で明示"
  }, ...
]

【設計指針】
- ニュースの「サラー復帰」「終盤戦・W杯への影響」を軸に**起承転結**
- type は **必ず3種以上** 含む（insight 連発禁止、stats / history / comparison / reaction を組合せる）
- customSlotKeys は数字データが入る key を優先（label を見て「-」「0」が値の slot は避ける）
- 6枚通して **同じデータ系列を繰り返し引用しない**（例: 同じ "ゴール" を 3 枚で出さない）
- スライドごとに「フック→深掘り→展望」の役割を変える

【JSON 出力ルール】
- 文字列値で半角ダブルクォート禁止、代わりに 『』 を使う
- コードフェンス不要
JSON のみ返答。`;
}

async function _ask(provider, prompt) {
  const t0 = Date.now();
  const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
  const max_tokens = provider === 'deepseek' ? 4000 : 3500;
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
  // type 多様性チェック
  const types = parsed.map(s => s.type);
  const uniqueTypes = [...new Set(types)];
  console.log(`type 構成: ${types.join(' → ')}`);
  console.log(`ユニーク type 数: ${uniqueTypes.length} / ${types.length}\n`);
  parsed.forEach(s => {
    console.log(`[${s.idx}] type=${s.type.padEnd(11)} | ${s.title}`);
    console.log(`    primary=${s.primary}${s.secondary ? ' / secondary=' + s.secondary : ''}`);
    const pool = slotsByEntity[s.primary] || [];
    const map = new Map(pool.map(x => [x.key, x]));
    const validKeys = (s.customSlotKeys || []).map(k => {
      const slot = map.get(k);
      return slot ? `${slot.label}=${slot.value}` : `❌${k}(not found)`;
    });
    console.log(`    引用データ:`);
    validKeys.forEach(v => console.log(`      ${v}`));
    console.log(`    scriptDir: ${s.scriptDir}`);
    console.log('');
  });
}

async function main() {
  const si = JSON.parse(fs.readFileSync(SI_FILE, 'utf8'));
  const salah = loadEntity(si, 'Mohamed Salah');
  const liverpool = loadEntity(si, 'Liverpool FC');
  const slot = loadEntity(si, 'Arne Slot');
  const entities = [salah, liverpool, slot].filter(Boolean);

  const slotsByEntity = {};
  entities.forEach(e => { slotsByEntity[e.label] = walkEntity(e.data, e.role); });
  console.log('Loaded entities:');
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

  fs.writeFileSync(path.join(__dirname, '..', 'data', '_salah_composition_sonnet.json'), sonnet.raw || '');
  fs.writeFileSync(path.join(__dirname, '..', 'data', '_salah_composition_deepseek.json'), deepseek.raw || '');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
