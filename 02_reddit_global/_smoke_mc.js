// 一時 smoke test: Man City vs Southampton の matchcard HTML を生成
require('dotenv').config();
(async () => {
  const { fetchSofaScoreMatch } = require('./scripts/modules/fetchers/sofascore_match');
  const { buildMatchcardHTML }  = require('./scripts/v2_video/slides/matchcard');
  const fs = require('fs');

  console.log('fetching SofaScore: Manchester City vs Southampton ...');
  const data = await fetchSofaScoreMatch('Manchester City', 'Southampton');
  console.log('ok=' + data.ok);
  if (!data.ok) { console.log('error:', data.error); process.exit(1); }
  console.log('score      :', data.scoreline);
  console.log('date       :', data.matchDate);
  console.log('venue      :', data.venue);
  console.log('goals      :', (data.goals || []).length);
  console.log('cards      :', (data.cards || []).length);
  console.log('subs       :', (data.subs  || []).length);
  console.log('lineup H/A :', (data.lineup?.home || []).length, '/', (data.lineup?.away || []).length);
  console.log('formations :', JSON.stringify(data.formations));

  const html = buildMatchcardHTML({
    type: 'matchcard',
    narration: 'シティが今朝、サウサンプトンと激突。フォーメーションとスタッツで全容をお届け。',
    matchData: data,
  });
  fs.writeFileSync('logs/matchcenter_smoke.html', html);
  console.log('\nsaved: logs/matchcenter_smoke.html (' + html.length + ' bytes)');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
