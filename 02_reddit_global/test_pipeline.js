// test_pipeline.js
// propose_with_data → fetchAllModuleData → generateScenario の一気通貫テスト
//
// 使い方: node test_pipeline.js [homeTeam] [awayTeam]
// 例:    node test_pipeline.js "Bayern Munich" "Real Madrid"

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { proposeWithData }    = require('./scripts/modules/propose_with_data');
const { fetchAllModuleData } = require('./scripts/modules/fetcher');
const { callAI }             = require('./scripts/ai_client');

const homeTeam = process.argv[2] || 'Bayern Munich';
const awayTeam = process.argv[3] || 'Real Madrid';

// ── sharedData → テキスト変換（generateScenario の sharedContext 用） ──────────
function sharedDataToText(sd) {
  if (!sd) return '';
  const lines = [];
  lines.push(`試合: ${sd.scoreline}（${sd.matchDate} / ${sd.tournament}）`);
  if (sd.goals?.length) {
    lines.push(`得点経緯: ${sd.goals.map(g => `${g.timeStr} ${g.player}（${g.team}）`).join(' → ')}`);
  }
  if (sd.cards?.length) {
    lines.push(`カード: ${sd.cards.map(c => `${c.timeStr} ${c.player}（${c.team}）${c.color}`).join(', ')}`);
  }
  const s = sd.stats || {};
  lines.push([
    `ポゼッション: ${s['Ball possession']?.home ?? '-'}% vs ${s['Ball possession']?.away ?? '-'}%`,
    `シュート: ${s['Total shots']?.home ?? '-'} vs ${s['Total shots']?.away ?? '-'}`,
    `xG: ${s['Expected goals']?.home ?? '-'} vs ${s['Expected goals']?.away ?? '-'}`,
  ].join(' / '));
  if (sd.topPlayers?.length) {
    lines.push('評価点上位: ' + sd.topPlayers.map(p =>
      `${p.name}（${p.team}）${p.rating}${p.goals ? ' ' + p.goals + 'G' : ''}${p.assists ? ' ' + p.assists + 'A' : ''}`
    ).join(', '));
  }
  if (sd.h2hSummary) lines.push(`H2H: ${sd.h2hSummary}`);
  return lines.join('\n');
}

// ── generateScenario（server から抜き出したロジック） ────────────────────────
async function generateScenario(post, modulesWithData, sharedContext = '') {
  const moduleTexts = modulesWithData.map((mod, i) => {
    const d = mod.fetchedData || {};
    let dataText = '';

    if (mod.id === 'opening' || mod.id === 'ending') {
      dataText = '（固定スライド）';
    } else if (mod.id === 'news_overview') {
      dataText = `既存概要文:\n${d.text || '（なし）'}`;
    } else if (mod.id === 'reddit_reaction') {
      dataText = `海外コメント:\n${(d.comments || []).map(c => `  ・${c}`).join('\n') || '（なし）'}`;
    } else if (d.extract) {
      dataText = `Wikipedia要約 (${d.title || ''}):\n${d.extract.slice(0, 500)}`;
    } else if (d.scoreline) {
      dataText = d.summary || `スコア: ${d.scoreline}`;
    } else if (d.name) {
      const s  = d.seasonStats    || {};
      const ps = d.positionStats  || {};
      dataText = `選手データ (${d.name} / ${d.team || '?'} / ${d.leagueName || ''}):\n` +
        `  出場: ${s.appearances ?? '?'}, G: ${s.goals ?? '?'}, A: ${s.assists ?? '?'}, 評価: ${s.rating ?? '?'}\n` +
        `  市場価値: ${d.marketValue || '?'}, 契約: ${d.contractUntil || '?'}` +
        (d.recentAvgRating ? `\n  直近平均評価: ${d.recentAvgRating}（${d.recentMatchCount}試合）` : '') +
        (d.uclStats ? `\n  CL: 出場${d.uclStats.appearances} G${d.uclStats.goals} A${d.uclStats.assists} 評価${d.uclStats.rating}` : '') +
        (Object.keys(ps).length ? `\n  ポジ特化: ${Object.entries(ps).filter(([,v]) => v != null).map(([k,v]) => `${k}:${v}`).join(', ')}` : '');
    } else if (d.organic) {
      dataText = (d.organic || []).slice(0, 4).map(r => `  ・${r.title}: ${r.snippet}`).join('\n');
      if (d.articleContent) dataText += `\n\n【記事本文】\n${d.articleContent.slice(0, 800)}`;
    } else if (!d.ok) {
      dataText = `（データ取得失敗: ${d.error || '不明'}）`;
    } else {
      dataText = '（データなし）';
    }

    const scriptHint = (mod.scriptDirection || mod.scriptNote)
      ? `\n脚本指示: ${mod.scriptDirection || mod.scriptNote}` : '';
    return `【モジュール${i + 1}: ${mod.label}】\n${dataText}${scriptHint}`;
  }).join('\n\n');

  const moduleIdList = modulesWithData.map((m, i) => `${i + 1}. id="${m.id}" label="${m.label}"`).join('\n');

  const prompt = `あなたはサッカーの速報ニュースを詳細なデータと共に提供するYouTubeチャンネル「速報!サッカーニュース」の専属脚本家です。
SofaScore・Wikipedia・最新ニュース記事から取得した裏付けデータを最大限に活用し、視聴者が「数字で納得できる」データ多用型の脚本を書いてください。

【今回の案件】
${homeTeam} vs ${awayTeam}

【モジュール構成（この順番・このIDで必ず全${modulesWithData.length}個出力すること）】
${moduleIdList}

${sharedContext ? `━━━━━━━━━━━━━━━━ 共有情報プール（全モジュール共通） ━━━━━━━━━━━━━━━━
${sharedContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

` : ''}━━━━━━━━━━━━━━━━ 取得済みデータ ━━━━━━━━━━━━━━━━
${moduleTexts}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【出力形式】JSONのみ:
{
  "youtubeTitle": "（70字以内・日本語・数字やインパクトワード入り）",
  "hashtagsText": "#サッカー #○○ （主要5個）",
  "modules": [
    {
      "id": "モジュールID",
      "narration": "ナレーション本文",
      "catchLine": "（openingのみ）",
      "telop": "（endingのみ）",
      "keyPoints": ["箇条書き2〜4個"],
      "imageQuery": "英語画像検索クエリ（10語以内）"
    }
  ]
}

【脚本ルール】
- opening: 30〜80字。煽り系の掴み
- 通常モジュール: 200〜400字。SofaScoreの数字・スコア・得点者・分数など具体的データを必ず入れる
- reddit_reaction: コメントを3〜5個引用し、海外ファンの温度感をそのまま届ける
- ending: 50〜100字。チャンネル登録・高評価訴求

【データ活用ルール（最重要）】
- 「脚本指示」がある場合、その方向性・感情・強調点を最優先で反映する
- 取得済みデータにある数字・名前・日付をそのままナレーションに入れる
- データにない数字・記録は絶対に作らない（ハルシネーション禁止）`;

  const raw = await callAI({
    model:      'deepseek-v4-flash',
    max_tokens: 3000,
    messages:   [{ role: 'user', content: prompt }],
    system:     'あなたはサッカーYouTubeの専属脚本家です。JSONのみを返します。',
  });

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSONが取れません: ' + raw.slice(0, 300));
  return JSON.parse(m[0]);
}

// ── メイン ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`テスト開始: ${homeTeam} vs ${awayTeam}`);
  console.log('='.repeat(60));

  // STEP1: propose_with_data（ミア：SofaScoreデータ取得＋Claude判断）
  console.log('\n[STEP1] SofaScoreデータ取得＋モジュール提案 (Claude)...');
  const proposed = await proposeWithData({ homeTeam, awayTeam, topic: `${homeTeam} vs ${awayTeam}` });
  console.log(`  → topicSummary: ${proposed.topicSummary}`);
  console.log(`  → keyAngle: ${proposed.keyAngle}`);
  console.log(`  → モジュール数: ${proposed.modules.length}`);
  proposed.modules.forEach(m => console.log(`     [${m.id}] ${m.scriptDirection || ''}`));

  // STEP2: fetchAllModuleData（各モジュールのデータを並列取得）
  console.log('\n[STEP2] モジュールデータ取得中...');
  const post = { _meta: { homeTeam, awayTeam }, _rawComments: { reddit: [], x: [] } };
  const modulesWithData = await fetchAllModuleData(proposed.modules, post);
  console.log(`  → 取得完了 (${modulesWithData.filter(m => m.fetchedData?.ok !== false).length}/${modulesWithData.length} 成功)`);

  // STEP3: sharedData → テキスト変換
  const sharedContext = sharedDataToText(proposed.sharedData);
  console.log('\n[STEP3] 共有データプール:');
  console.log(sharedContext.split('\n').map(l => '  ' + l).join('\n'));

  // STEP4: generateScenario（DeepSeek：脚本生成）
  console.log('\n[STEP4] シナリオ生成中 (DeepSeek)...');
  const scenario = await generateScenario(post, modulesWithData, sharedContext);

  // 結果表示
  console.log('\n' + '='.repeat(60));
  console.log(`YouTube タイトル: ${scenario.youtubeTitle}`);
  console.log(`ハッシュタグ: ${scenario.hashtagsText}`);
  console.log('='.repeat(60));
  scenario.modules?.forEach((mod, i) => {
    console.log(`\n【${i + 1}. ${mod.id}】`);
    if (mod.catchLine) console.log(`  キャッチライン: ${mod.catchLine}`);
    if (mod.narration) console.log(`  ナレーション:\n  ${mod.narration.replace(/\n/g, '\n  ')}`);
    if (mod.keyPoints?.length) console.log(`  keyPoints: ${mod.keyPoints.join(' / ')}`);
    if (mod.telop) console.log(`  テロップ: ${mod.telop}`);
  });

  // JSON保存
  const outPath = require('path').join(__dirname, 'temp', `test_scenario_${homeTeam.replace(/ /g,'_')}_vs_${awayTeam.replace(/ /g,'_')}.json`);
  require('fs').writeFileSync(outPath, JSON.stringify({ proposed, scenario }, null, 2));
  console.log(`\n\n✅ 完全なJSONを保存: ${outPath}`);
})().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
