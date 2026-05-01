// scripts/test_a1_two_models.js
// レシピ撤廃後の si_walker ベースで Sonnet vs DeepSeek 比較テスト
// 使い方: node -r dotenv/config scripts/test_a1_two_models.js

'use strict';

const fs = require('fs');
const path = require('path');
const { walkEntity, buildPairsForCompare } = require('./v2_story/si_walker');
const { callAI } = require('./ai_client');

const SI_FILE = path.join(__dirname, '..', 'data', 'si_data',
  '_r_soccer_comments_1szbgdb_post_match_thread_atlético_madrid_11_arsenal_uefa_.json');

// ─── ニュース骨子（Yahoo記事より）──────────────────────────
const NEWS_CONTEXT = `
【ニュース骨子】Yahoo!ニュース 「【欧州CL】アーセナルのアルテタ監督「腹が立っている」PK取り消しに不満あらわ」

- UEFA Champions League 準決勝1stレグ、エスタディオ・メトロポリターノ（マドリード）
- 4月29日（日本時間30日）開催、観客 68,421人
- アトレティコ・マドリード 1-1 アーセナル（互いにPK）
- 後半33分: VAR確認の結果、エゼ→ハンツコのPK判定が取り消し
- アルテタ監督コメント:「VAR確認後に取り消されたことは非常に腹が立っている。他のケース同様、明らかなPKだった」
- 主審: マケリー
- 第2戦: 5月5日（日本時間6日）、エミレーツ・スタジアム
- アーセナル: CL初優勝を目指す
`.trim();

// ─── エンティティを si_data から引いて walker にかける ──────
function loadEntity(si, label) {
  const it = (si.boxes?.entity?.items || []).find(x => x.label === label);
  if (!it) return null;
  const sofaOk = !!it.sofa?.ok;
  const wikiOk = !!it.wiki?.ok;
  if (!sofaOk && !wikiOk) return null;
  return {
    role: it.role,
    label: it.label,
    data: { ...(sofaOk ? it.sofa : {}), _wiki: wikiOk ? it.wiki : null },
  };
}
function loadMatch(si, homeLabel, awayLabel) {
  const items = si.boxes?.match?.items || [];
  for (const it of items) {
    const d = it.data;
    if (!d?.ok) continue;
    const ht = (d.homeTeam || '').toLowerCase();
    const at = (d.awayTeam || '').toLowerCase();
    if ((ht.includes(homeLabel.toLowerCase()) || homeLabel.toLowerCase().includes(ht))
     && (at.includes(awayLabel.toLowerCase()) || awayLabel.toLowerCase().includes(at))) {
      return { role: 'match', label: it.label, data: d };
    }
  }
  return items[0] ? { role: 'match', label: items[0].label, data: items[0].data } : null;
}

// ─── slot を「key, label, value」の表形式で AI に渡す ────
function slotsTable(slots, isCompare = false) {
  return slots
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map(s => {
      if (isCompare) {
        return `  - ${s.key} | ${s.category} | ${s.label} | left=${s.leftValue} | right=${s.rightValue}`;
      }
      return `  - ${s.key} | ${s.category} | ${s.label} | ${s.value}`;
    })
    .join('\n');
}

// ─── プロンプト構築 ────────────────────────────────────────
function buildPrompt(entities, comparePair) {
  const blocks = [];
  for (const e of entities) {
    const slots = walkEntity(e.data, e.role);
    blocks.push(
`━━━ ${e.label} (role=${e.role}) ━━━ 利用可能 slot ${slots.length} 件:
${slotsTable(slots)}`
    );
  }
  // comparison 用ペア
  if (comparePair) {
    const pairs = buildPairsForCompare(comparePair[0].data, comparePair[1].data, comparePair[0].role);
    blocks.push(
`━━━ 比較 [${comparePair[0].label}] vs [${comparePair[1].label}] (role=${comparePair[0].role}) ━━━ 比較 slot ${pairs.length} 件:
${slotsTable(pairs, true)}`
    );
  }
  return `あなたはサッカー YouTube 動画の脚本家です。

${NEWS_CONTEXT}

以下のデータが取得済みです。各エンティティの「key」を customSlotKeys として参照可能。値はサーバー側で実データから自動充填されます。

${blocks.join('\n\n')}

【タスク】
op / ed / 目次（toc）を除いた **本編 5 スライド** を構成してください。各スライドで以下を JSON で返す:

[
  {
    "idx": 1,
    "type": "stats|profile|comparison|history|reaction|matchcard",
    "title": "短い見出し（10〜25文字）",
    "primary": "エンティティラベル（必須）",
    "secondary": "比較相手ラベル（comparison のみ）",
    "customSlotKeys": ["key1","key2",...] — comparison は5件、その他は6件,
    "narration": "視聴者に語りかける口調・170〜220文字",
    "scriptDir": "このスライドで何を伝えるかの一行要約"
  }, ...
]

【選定ルール】
- ニュースの「PK取り消し論争」「アーセナル CL初優勝挑戦」「アルテタ vs シメオネ采配対決」を軸にスライド構成
- type = matchcard は1枚以下（試合詳細はスタッツ羅列でなくドラマで語るため）
- comparison は最大2枚まで、必ず secondary を指定
- customSlotKeys は **数字データが入ってる key を優先**（例: "overallWinRate" は "61.3%" のような実値が入る）
- 5枚通して **異なる主題・観点を選ぶ**（同じエンティティの similar データを繰り返さない）
- narration は数字や固有名詞をそのまま盛り込む（捏造禁止）

JSON のみ返答（前置き・コメント不要）。
`;
}

async function _ask(provider, prompt) {
  const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
  const t0 = Date.now();
  const raw = await callAI({
    forceProvider: provider,
    model, max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }],
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  return { raw, elapsed };
}
function _parse(raw) {
  const m = raw && raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// 結果を「型・データ型：データ値」形式で表示
function renderResult(label, parsed, allSlotsByEntity, allPairsByCompareKey, elapsed) {
  console.log(`\n${'═'.repeat(60)}\n${label} (${elapsed}秒)\n${'═'.repeat(60)}`);
  if (!Array.isArray(parsed)) { console.log('❌ JSON parse 失敗'); return; }
  parsed.forEach(s => {
    console.log(`\n[${s.idx}] type=${s.type} | title=「${s.title}」`);
    console.log(`    primary=${s.primary}${s.secondary ? ' / secondary=' + s.secondary : ''}`);
    console.log(`    scriptDir: ${s.scriptDir || '-'}`);
    const isCompare = s.type === 'comparison';
    const pool = isCompare
      ? (allPairsByCompareKey[`${s.primary}|${s.secondary}`] || [])
      : (allSlotsByEntity[s.primary] || []);
    const map = new Map(pool.map(x => [x.key, x]));
    (s.customSlotKeys || []).forEach(k => {
      const slot = map.get(k);
      if (!slot) { console.log(`    ✗ ${k} (not found)`); return; }
      if (isCompare) console.log(`    ${slot.label.padEnd(20)} : left=${slot.leftValue}  vs  right=${slot.rightValue}`);
      else           console.log(`    ${slot.label.padEnd(20)} : ${slot.value}`);
    });
    console.log(`    narration: ${s.narration?.slice(0, 120)}...`);
  });
}

async function main() {
  const si = JSON.parse(fs.readFileSync(SI_FILE, 'utf8'));
  const arteta   = loadEntity(si, 'Mikel Arteta');
  const simeone  = loadEntity(si, 'simeone');
  const atletico = loadEntity(si, 'Atlético Madrid');
  const arsenal  = loadEntity(si, 'Arsenal');
  const match    = loadMatch(si, 'Atlético Madrid', 'Arsenal');

  const entities = [arteta, simeone, atletico, arsenal, match].filter(Boolean);
  console.log(`Loaded entities: ${entities.map(e => `${e.label}(${e.role})`).join(', ')}`);

  // walker 全件
  const allSlotsByEntity = {};
  for (const e of entities) {
    allSlotsByEntity[e.label] = walkEntity(e.data, e.role);
    console.log(`  ${e.label}: ${allSlotsByEntity[e.label].length} slots`);
  }
  // 比較ペア用
  const allPairsByCompareKey = {};
  if (atletico && arsenal) {
    allPairsByCompareKey[`${atletico.label}|${arsenal.label}`] = buildPairsForCompare(atletico.data, arsenal.data, 'team');
    allPairsByCompareKey[`${arsenal.label}|${atletico.label}`] = buildPairsForCompare(arsenal.data, atletico.data, 'team');
  }
  if (arteta && simeone) {
    allPairsByCompareKey[`${arteta.label}|${simeone.label}`] = buildPairsForCompare(arteta.data, simeone.data, 'manager');
    allPairsByCompareKey[`${simeone.label}|${arteta.label}`] = buildPairsForCompare(simeone.data, arteta.data, 'manager');
  }

  const prompt = buildPrompt(entities, [atletico, arsenal]);
  console.log(`\nプロンプト長: ${prompt.length} 文字`);

  // 2 モデル実行
  console.log('\n両モデル実行中...');
  const [sonnet, deepseek] = await Promise.all([
    _ask('anthropic', prompt).catch(e => ({ raw: '', elapsed: '0', error: e.message })),
    _ask('deepseek',  prompt).catch(e => ({ raw: '', elapsed: '0', error: e.message })),
  ]);

  if (sonnet.error)   console.log('Sonnet エラー:',   sonnet.error);
  if (deepseek.error) console.log('DeepSeek エラー:', deepseek.error);

  const sonnetParsed   = _parse(sonnet.raw);
  const deepseekParsed = _parse(deepseek.raw);

  renderResult('Sonnet 4.6',     sonnetParsed,   allSlotsByEntity, allPairsByCompareKey, sonnet.elapsed);
  renderResult('DeepSeek V4-Flash', deepseekParsed, allSlotsByEntity, allPairsByCompareKey, deepseek.elapsed);

  // 生 raw も保存（デバッグ用）
  fs.writeFileSync(path.join(__dirname, '..', 'data', '_a1_test_sonnet.json'),   sonnet.raw   || '');
  fs.writeFileSync(path.join(__dirname, '..', 'data', '_a1_test_deepseek.json'), deepseek.raw || '');
  console.log('\n生レスポンス: data/_a1_test_{sonnet,deepseek}.json');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
