// scripts/test_a1_token_compare.js
// Config A (全 Sonnet) vs Config B (Sonnet 設計 + DeepSeek 脚本) のトークン比較
//
// 各構成で実 API を叩いて usage オブジェクトから input/output token を回収。
// 使い方: node -r dotenv/config scripts/test_a1_token_compare.js

'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { walkEntity, buildPairsForCompare } = require('./v2_story/si_walker');

const SI_FILE = path.join(__dirname, '..', 'data', 'si_data',
  '_r_soccer_comments_1szbgdb_post_match_thread_atlético_madrid_11_arsenal_uefa_.json');

const NEWS_CONTEXT = `
【ニュース骨子】Yahoo!ニュース「【欧州CL】アーセナルのアルテタ監督「腹が立っている」PK取り消しに不満あらわ」
- UEFA Champions League 準決勝1stレグ、エスタディオ・メトロポリターノ、4月29日（日本時間30日）、観客 68,421人
- アトレティコ・マドリード 1-1 アーセナル
- 後半33分: VAR確認の結果、エゼ→ハンツコのPK判定が取り消し
- アルテタ監督:「VAR確認後に取り消されたことは非常に腹が立っている。他のケース同様、明らかなPKだった」
- 主審マケリー / 第2戦5月5日（日本時間6日）エミレーツ・スタジアム
- アーセナル: CL初優勝を目指す
`.trim();

function loadEntity(si, label) {
  const it = (si.boxes?.entity?.items || []).find(x => x.label === label);
  if (!it) return null;
  const sofaOk = !!it.sofa?.ok;
  const wikiOk = !!it.wiki?.ok;
  if (!sofaOk && !wikiOk) return null;
  return { role: it.role, label: it.label, data: { ...(sofaOk ? it.sofa : {}), _wiki: wikiOk ? it.wiki : null } };
}
function loadMatch(si) {
  const items = si.boxes?.match?.items || [];
  return items[0] ? { role: 'match', label: items[0].label, data: items[0].data } : null;
}
function slotsTable(slots, isCompare = false) {
  return slots.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map(s => isCompare
      ? `  - ${s.key} | ${s.category} | ${s.label} | left=${s.leftValue} | right=${s.rightValue}`
      : `  - ${s.key} | ${s.category} | ${s.label} | ${s.value}`)
    .join('\n');
}

function buildPromptA(entities, comparePair) {
  // Config A: 全 Sonnet。skeleton + narration 全部1発で
  const blocks = entities.map(e => `━━━ ${e.label} (role=${e.role}) ━━━ slot ${walkEntity(e.data, e.role).length} 件:\n${slotsTable(walkEntity(e.data, e.role))}`);
  const pairs = buildPairsForCompare(comparePair[0].data, comparePair[1].data, comparePair[0].role);
  blocks.push(`━━━ 比較 [${comparePair[0].label}] vs [${comparePair[1].label}] ━━━ slot ${pairs.length} 件:\n${slotsTable(pairs, true)}`);
  return `あなたはサッカー YouTube 動画の脚本家です。

${NEWS_CONTEXT}

${blocks.join('\n\n')}

【タスク】op/ed/toc を除いた本編 5 スライド を JSON で返す:
[
  {"idx":1,"type":"...","title":"...","primary":"...","secondary":"...?","customSlotKeys":["k1",...],"narration":"170-220字","scriptDir":"このスライドの意図"}, ...
]

【ルール】
- 5枚で起承転結
- type バランス: matchcard 1枚以下 / comparison 最大2枚
- customSlotKeys: comparison は5件、その他6件
- primary は与えたラベルそのまま
- 文字列値で半角ダブルクォート禁止、代わりに 『』 を使う

JSON のみ返答、コードフェンス不要。`;
}

function buildPromptB1(entities, comparePair) {
  // Config B Phase 1: Sonnet skeleton（narration 無し）
  const blocks = entities.map(e => `━━━ ${e.label} (role=${e.role}) ━━━ slot ${walkEntity(e.data, e.role).length} 件:\n${slotsTable(walkEntity(e.data, e.role))}`);
  const pairs = buildPairsForCompare(comparePair[0].data, comparePair[1].data, comparePair[0].role);
  blocks.push(`━━━ 比較 [${comparePair[0].label}] vs [${comparePair[1].label}] ━━━ slot ${pairs.length} 件:\n${slotsTable(pairs, true)}`);
  return `あなたはサッカー YouTube の構成プロデューサーです。narration（実脚本）は別の脚本家が書くので返さないでください。

${NEWS_CONTEXT}

${blocks.join('\n\n')}

【タスク】op/ed/toc を除いた本編 5 スライド の設計図を JSON で返す:
[
  {"idx":1,"type":"...","title":"...","primary":"...","secondary":"...?","customSlotKeys":["k1",...],"scriptDir":"このスライドで脚本家に何を書かせるか — テーマ・トーン・盛り込むべき固有名詞や数字を3〜5行で明示"}, ...
]

【ルール】
- 5枚で起承転結 / type バランス: matchcard 1枚以下 / comparison 最大2枚
- customSlotKeys: comparison は5件、その他6件
- primary は与えたラベルそのまま
- narration は絶対に返さない
- 文字列値で半角ダブルクォート禁止、代わりに 『』 を使う

JSON のみ。コードフェンス不要。`;
}

function buildPromptB2(slide, slots, isCompare) {
  const map = new Map(slots.map(s => [s.key, s]));
  const lines = (slide.customSlotKeys || []).map(k => {
    const s = map.get(k);
    if (!s) return `  - ${k}: (取得失敗)`;
    if (isCompare) return `  - ${s.label}: ${slide.primary}=${s.leftValue} / ${slide.secondary}=${s.rightValue}`;
    return `  - ${s.label}: ${s.value}`;
  }).join('\n');
  return `サッカー YouTube の脚本家として、このスライド1枚分の narration を書いてください。

${NEWS_CONTEXT}

【プロデューサー指示】
- 種別: ${slide.type} / タイトル: ${slide.title}
- 主体: ${slide.primary}${isCompare ? ` vs ${slide.secondary}` : ''}
- scriptDir: ${slide.scriptDir}

【表示される実データ（矛盾禁止）】
${lines}

【ルール】170〜220字 / 視聴者に語りかける口調 / 数字・固有名詞は実データから / 本文のみ。`;
}

const ant = new Anthropic();
const ds  = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });

async function callSonnet(prompt, max_tokens = 6000) {
  const r = await ant.messages.create({
    model: 'claude-sonnet-4-6', max_tokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return { text: r.content[0].text, input: r.usage.input_tokens, output: r.usage.output_tokens };
}
async function callDeepSeek(prompt, max_tokens = 2500) {
  const r = await ds.chat.completions.create({
    model: 'deepseek-v4-flash', max_tokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return { text: r.choices[0].message.content, input: r.usage.prompt_tokens, output: r.usage.completion_tokens };
}
function parseJson(raw) {
  const m = raw && raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// 単価（2026-04 時点・参考値）
//   Anthropic Sonnet 4.6:  input $3 / MTok, output $15 / MTok
//   DeepSeek V4-Flash:     input $0.27 / MTok, output $1.10 / MTok（cache miss想定）
function cost(provider, input, output) {
  if (provider === 'sonnet')   return input / 1e6 * 3      + output / 1e6 * 15;
  if (provider === 'deepseek') return input / 1e6 * 0.27   + output / 1e6 * 1.10;
  return 0;
}

async function main() {
  const si = JSON.parse(fs.readFileSync(SI_FILE, 'utf8'));
  const arteta   = loadEntity(si, 'Mikel Arteta');
  const simeone  = loadEntity(si, 'simeone');
  const atletico = loadEntity(si, 'Atlético Madrid');
  const arsenal  = loadEntity(si, 'Arsenal');
  const match    = loadMatch(si);
  const entities = [arteta, simeone, atletico, arsenal, match].filter(Boolean);

  const slotsByEntity = {};
  entities.forEach(e => { slotsByEntity[e.label] = walkEntity(e.data, e.role); });
  const compareSlots = {
    [`${atletico.label}|${arsenal.label}`]: buildPairsForCompare(atletico.data, arsenal.data, 'team'),
    [`${arsenal.label}|${atletico.label}`]: buildPairsForCompare(arsenal.data, atletico.data, 'team'),
    [`${arteta.label}|${simeone.label}`]:   buildPairsForCompare(arteta.data, simeone.data, 'manager'),
    [`${simeone.label}|${arteta.label}`]:   buildPairsForCompare(simeone.data, arteta.data, 'manager'),
  };

  // ─ Config A: 全 Sonnet ─
  console.log('═══ Config A: 全 Sonnet（1ショット）═══');
  const promptA = buildPromptA(entities, [atletico, arsenal]);
  console.log(`プロンプト長: ${promptA.length} 文字`);
  const t0a = Date.now();
  const a = await callSonnet(promptA, 8000);
  const ta = ((Date.now() - t0a) / 1000).toFixed(1);
  const aCost = cost('sonnet', a.input, a.output);
  console.log(`  Sonnet: input=${a.input} tok / output=${a.output} tok / ${ta}秒 / $${aCost.toFixed(4)}`);
  console.log(`  Total: input=${a.input} / output=${a.output} / cost=$${aCost.toFixed(4)}`);

  // ─ Config B: Sonnet 設計 + DeepSeek 脚本 ─
  console.log('\n═══ Config B: Sonnet 設計 + DeepSeek 脚本 ═══');
  const promptB1 = buildPromptB1(entities, [atletico, arsenal]);
  console.log(`Phase 1 プロンプト長: ${promptB1.length} 文字`);
  const t0b1 = Date.now();
  const b1 = await callSonnet(promptB1, 4000);
  const tb1 = ((Date.now() - t0b1) / 1000).toFixed(1);
  const b1Cost = cost('sonnet', b1.input, b1.output);
  console.log(`  Phase 1 Sonnet: input=${b1.input} / output=${b1.output} / ${tb1}秒 / $${b1Cost.toFixed(4)}`);

  const skeleton = parseJson(b1.text);
  if (!skeleton) { console.log('Phase 1 JSON parse 失敗'); console.log(b1.text.slice(0, 500)); return; }

  const t0b2 = Date.now();
  const b2tasks = skeleton.map(slide => {
    const isCompare = slide.type === 'comparison' && !!slide.secondary;
    const pool = isCompare
      ? (compareSlots[`${slide.primary}|${slide.secondary}`] || [])
      : (slotsByEntity[slide.primary] || []);
    const p = buildPromptB2(slide, pool, isCompare);
    return callDeepSeek(p, 1500).then(r => ({ slide, r, plen: p.length }));
  });
  const b2res = await Promise.all(b2tasks);
  const tb2 = ((Date.now() - t0b2) / 1000).toFixed(1);
  let b2InputTotal = 0, b2OutputTotal = 0;
  b2res.forEach((x, i) => {
    b2InputTotal  += x.r.input;
    b2OutputTotal += x.r.output;
    console.log(`  Phase 2 [${i+1}] ${x.slide.type}: input=${x.r.input} / output=${x.r.output} / promptLen=${x.plen} / textLen=${x.r.text.trim().length}`);
  });
  const b2Cost = cost('deepseek', b2InputTotal, b2OutputTotal);
  const bTotalCost = b1Cost + b2Cost;
  console.log(`  Phase 2 合計: input=${b2InputTotal} / output=${b2OutputTotal} / ${tb2}秒 / $${b2Cost.toFixed(4)}`);
  console.log(`  Total: input=${b1.input + b2InputTotal} / output=${b1.output + b2OutputTotal} / cost=$${bTotalCost.toFixed(4)}`);

  console.log('\n═══ 比較サマリ ═══');
  console.log(`Config A (全 Sonnet)         : input ${a.input.toString().padStart(6)} tok / output ${a.output.toString().padStart(5)} tok / total $${aCost.toFixed(4)}`);
  console.log(`Config B (Sonnet+DeepSeek)   : input ${(b1.input + b2InputTotal).toString().padStart(6)} tok / output ${(b1.output + b2OutputTotal).toString().padStart(5)} tok / total $${bTotalCost.toFixed(4)}`);
  const inDiff  = ((b1.input + b2InputTotal) / a.input * 100 - 100).toFixed(0);
  const outDiff = ((b1.output + b2OutputTotal) / a.output * 100 - 100).toFixed(0);
  const costDiff = (bTotalCost / aCost * 100 - 100).toFixed(0);
  console.log(`差分: input ${inDiff}% / output ${outDiff}% / cost ${costDiff}%`);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
