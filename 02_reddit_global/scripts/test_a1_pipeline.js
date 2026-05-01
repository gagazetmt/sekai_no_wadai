// scripts/test_a1_pipeline.js
// Phase1: Sonnet で構成・データ選別・脚本指示
// Phase2: DeepSeek で各スライドの narration 生成
// 使い方: node -r dotenv/config scripts/test_a1_pipeline.js

'use strict';

const fs = require('fs');
const path = require('path');
const { walkEntity, buildPairsForCompare } = require('./v2_story/si_walker');
const { callAI } = require('./ai_client');

const SI_FILE = path.join(__dirname, '..', 'data', 'si_data',
  '_r_soccer_comments_1szbgdb_post_match_thread_atlético_madrid_11_arsenal_uefa_.json');

const NEWS_CONTEXT = `
【ニュース骨子】Yahoo!ニュース「【欧州CL】アーセナルのアルテタ監督「腹が立っている」PK取り消しに不満あらわ」

- UEFA Champions League 準決勝1stレグ、エスタディオ・メトロポリターノ（マドリード）
- 4月29日（日本時間30日）開催、観客 68,421人
- アトレティコ・マドリード 1-1 アーセナル（互いにPK）
- 後半33分: VAR確認の結果、エゼ→ハンツコのPK判定が取り消し
- アルテタ監督コメント:「VAR確認後に取り消されたことは非常に腹が立っている。他のケース同様、明らかなPKだった」
- 主審: マケリー
- 第2戦: 5月5日（日本時間6日）、エミレーツ・スタジアム
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

// ─── Phase 1 prompt: 構造のみ（narration 無し）──────────────
function buildSonnetPrompt(entities, comparePair) {
  const blocks = entities.map(e => {
    const slots = walkEntity(e.data, e.role);
    return `━━━ ${e.label} (role=${e.role}) ━━━ slot ${slots.length} 件:\n${slotsTable(slots)}`;
  });
  if (comparePair) {
    const pairs = buildPairsForCompare(comparePair[0].data, comparePair[1].data, comparePair[0].role);
    blocks.push(`━━━ 比較 [${comparePair[0].label}] vs [${comparePair[1].label}] (role=${comparePair[0].role}) ━━━ slot ${pairs.length} 件:\n${slotsTable(pairs, true)}`);
  }
  return `あなたはサッカー YouTube の **構成プロデューサー**です。
あなたの仕事は **モジュール構成・データ選別・脚本意図の指示** のみ。narration（実際の脚本文）は別の脚本家が後で書くので、書かないでください。

${NEWS_CONTEXT}

${blocks.join('\n\n')}

【タスク】
op / ed / 目次（toc）を除いた **本編 5 スライド** の設計図を JSON で返す:

[
  {
    "idx": 1,
    "type": "stats|profile|comparison|history|reaction|matchcard",
    "title": "短い見出し（10〜25文字）",
    "primary": "エンティティラベル（必ず上記リストのラベルをそのまま）",
    "secondary": "比較相手ラベル（comparison のみ・上記リストのラベルそのまま）",
    "customSlotKeys": ["key1","key2",...] — comparison は5件、その他は6件,
    "scriptDir": "このスライドで脚本家に何を書かせるか — テーマ・トーン・盛り込むべき固有名詞や数字・感情の方向 を3〜5行で明示"
  }, ...
]

【選定ルール】
- ニュースの「PK取り消し論争」「アーセナル CL初優勝挑戦」「アルテタ vs シメオネ」を軸に5枚で物語アーク
- type バランス: matchcard 1枚以下 / comparison 最大2枚
- customSlotKeys は実値が入ってる key を優先
- 5枚通して異なる主題・観点を選ぶ（同じデータの繰り返し禁止）
- **narration フィールドは絶対に返さない**

【JSON 出力の絶対ルール】
- 文字列値の中で引用するときは ASCII の半角ダブルクォート禁止。代わりに 『』 や 「」 を使う
- 改行は \\n でエスケープ。生改行禁止
- バックスラッシュもエスケープ

JSON のみ返答。前置き・コメント不要。コードフェンス（マークダウンの三連バッククォート）も不要。`;
}

// ─── Phase 2 prompt: 1スライドずつ DeepSeek に narration 書かせる ──
function buildDeepSeekPrompt(slide, entitySlots, isCompare) {
  // slide.customSlotKeys に対応する label:value をプロンプトに埋め込む
  const map = new Map(entitySlots.map(s => [s.key, s]));
  const dataLines = (slide.customSlotKeys || []).map(k => {
    const s = map.get(k);
    if (!s) return `  - ${k}: (取得失敗)`;
    if (isCompare) return `  - ${s.label}: ${slide.primary}=${s.leftValue} / ${slide.secondary}=${s.rightValue}`;
    return `  - ${s.label}: ${s.value}`;
  }).join('\n');

  return `あなたはサッカー YouTube の **脚本家**です。プロデューサーから指示が来ました。指示通りに **そのスライド1枚分の narration（語り）** を書いてください。

${NEWS_CONTEXT}

【プロデューサー指示】
- スライド種別: ${slide.type}
- タイトル: ${slide.title}
- 主体: ${slide.primary}${isCompare ? ` vs ${slide.secondary}` : ''}
- 脚本意図 (scriptDir): ${slide.scriptDir}

【表示される実データ（これと矛盾するナレーションは禁止）】
${dataLines}

【脚本ルール】
- 文字数: 170〜220文字（厳守）
- 視聴者に語りかける口調（「〜です」「〜ですね」「〜でしょう」）
- 数字・固有名詞は上記実データから直接拾う
- ニュース文脈の引用が活きる場面は積極的に使う
- 前置き・タイトル復唱・改行不要、本文のみ

narration の本文だけ返してください。`;
}

async function _ask(provider, model, prompt, max = 6000) {
  const t0 = Date.now();
  const raw = await callAI({ forceProvider: provider, model, max_tokens: max, messages: [{ role: 'user', content: prompt }] });
  return { raw, elapsed: ((Date.now() - t0) / 1000).toFixed(1) };
}
function _parseJson(raw) {
  const m = raw && raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

async function main() {
  const si = JSON.parse(fs.readFileSync(SI_FILE, 'utf8'));
  const arteta   = loadEntity(si, 'Mikel Arteta');
  const simeone  = loadEntity(si, 'simeone');
  const atletico = loadEntity(si, 'Atlético Madrid');
  const arsenal  = loadEntity(si, 'Arsenal');
  const match    = loadMatch(si);
  const entities = [arteta, simeone, atletico, arsenal, match].filter(Boolean);

  // walker output を全件用意
  const slotsByEntity = {};
  entities.forEach(e => { slotsByEntity[e.label] = walkEntity(e.data, e.role); });
  const compareSlots = {
    [`${atletico.label}|${arsenal.label}`]: buildPairsForCompare(atletico.data, arsenal.data, 'team'),
    [`${arsenal.label}|${atletico.label}`]: buildPairsForCompare(arsenal.data, atletico.data, 'team'),
    [`${arteta.label}|${simeone.label}`]:   buildPairsForCompare(arteta.data, simeone.data, 'manager'),
    [`${simeone.label}|${arteta.label}`]:   buildPairsForCompare(simeone.data, arteta.data, 'manager'),
  };

  // ─ Phase 1: Sonnet 構成 ─
  console.log('═══ Phase 1: Sonnet 構成設計 ═══');
  const sonnetPrompt = buildSonnetPrompt(entities, [atletico, arsenal]);
  const s1 = await _ask('anthropic', 'claude-sonnet-4-6', sonnetPrompt, 4000);
  console.log(`Sonnet 設計完了 ${s1.elapsed}秒`);
  fs.writeFileSync(path.join(__dirname, '..', 'data', '_a1_pipeline_sonnet.json'), s1.raw);
  const skeleton = _parseJson(s1.raw);
  if (!skeleton) { console.log('❌ Sonnet JSON parse 失敗'); console.log(s1.raw.slice(0, 500)); return; }

  console.log(`\n【Sonnet が組んだ構成】(${skeleton.length}枚)`);
  skeleton.forEach(s => {
    console.log(`\n[${s.idx}] type=${s.type} | ${s.title}`);
    console.log(`  primary=${s.primary}${s.secondary ? ' / secondary=' + s.secondary : ''}`);
    console.log(`  customSlotKeys: ${(s.customSlotKeys || []).join(', ')}`);
    console.log(`  scriptDir: ${s.scriptDir}`);
  });

  // ─ Phase 2: DeepSeek 各スライド narration ─
  console.log('\n═══ Phase 2: DeepSeek narration 生成（並列）═══');
  const t0 = Date.now();
  const tasks = skeleton.map(slide => {
    const isCompare = slide.type === 'comparison' && !!slide.secondary;
    const pool = isCompare
      ? (compareSlots[`${slide.primary}|${slide.secondary}`] || [])
      : (slotsByEntity[slide.primary] || []);
    const prompt = buildDeepSeekPrompt(slide, pool, isCompare);
    return _ask('deepseek', 'deepseek-v4-flash', prompt, 2500).then(r => ({ slide, raw: r.raw, narration: r.raw.trim(), elapsed: r.elapsed }));
  });
  const results = await Promise.all(tasks);
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`DeepSeek 5枚分完了 (並列で ${totalElapsed}秒, 各${results.map(r=>r.elapsed).join('/')}秒)`);

  // ─ 完成形を表示 ─
  console.log('\n═══ 完成: Sonnet 設計 × DeepSeek 脚本 ═══');
  results.forEach(r => {
    console.log(`\n[${r.slide.idx}] ${r.slide.type} | ${r.slide.title}`);
    console.log(`  primary: ${r.slide.primary}${r.slide.secondary ? ' / secondary: ' + r.slide.secondary : ''}`);
    const isCompare = r.slide.type === 'comparison' && !!r.slide.secondary;
    const pool = isCompare
      ? (compareSlots[`${r.slide.primary}|${r.slide.secondary}`] || [])
      : (slotsByEntity[r.slide.primary] || []);
    const m = new Map(pool.map(x => [x.key, x]));
    (r.slide.customSlotKeys || []).forEach(k => {
      const s = m.get(k);
      if (!s) console.log(`    ✗ ${k} (not found)`);
      else if (isCompare) console.log(`    ${(s.label+'').padEnd(20)} : left=${s.leftValue}  vs  right=${s.rightValue}`);
      else                console.log(`    ${(s.label+'').padEnd(20)} : ${s.value}`);
    });
    console.log(`  📜 narration (${r.narration.length}文字, raw=${r.raw.length}):`);
    console.log(`     ${r.narration || '(空)'}`);
    if (r.narration.length === 0 && r.raw.length > 0) console.log(`  RAW dump: ${r.raw.slice(0, 300)}`);
  });

  // ─ コスト見積 ─
  const tot = parseFloat(s1.elapsed) + parseFloat(totalElapsed);
  console.log(`\n総時間: ${tot.toFixed(1)}秒（Sonnet ${s1.elapsed}s + DeepSeek 並列 ${totalElapsed}s）`);
  fs.writeFileSync(path.join(__dirname, '..', 'data', '_a1_pipeline_final.json'), JSON.stringify(results, null, 2));
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
