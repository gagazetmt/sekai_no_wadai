// scripts/modules/propose_with_data.js
// 原点回帰：制限を全て解除し、シンプルな JSON 形式で Claude 4.6 とやり取りする

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const { fetchSofaScoreMatch } = require('./fetchers/sofascore_match');
const { MODULE_TYPES } = require('./definitions');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function collectMatchData(homeTeam, awayTeam) {
  const matchResult = await fetchSofaScoreMatch(homeTeam, awayTeam);
  if (!matchResult.ok) throw new Error('試合が見つかりません');
  const matchId = matchResult.matchId;

  const [statsData, lineupData] = await Promise.all([
    axios.get(`https://api.sofascore.com/api/v1/event/${matchId}/statistics`).catch(() => null),
    axios.get(`https://api.sofascore.com/api/v1/event/${matchId}/lineups`).catch(() => null),
  ]);

  const stats = {};
  if (statsData?.data?.statistics?.[0]?.groups) {
    statsData.data.statistics[0].groups.forEach(g => {
      if (g.statisticsItems) {
        g.statisticsItems.forEach(s => { stats[s.name] = { home: s.homeValue, away: s.awayValue }; });
      }
    });
  }

  const topPlayers = [...(lineupData?.data?.home?.players || []), ...(lineupData?.data?.away?.players || [])]
    .filter(p => !p.substitute && p.statistics?.rating)
    .sort((a, b) => (b.statistics.rating - a.statistics.rating))
    .slice(0, 3)
    .map(p => ({ name: p.player?.name, rating: p.statistics.rating?.toFixed(2) }));

  return { matchResult, stats, topPlayers };
}

async function proposeWithData({ homeTeam, awayTeam }) {
  console.log(`[propose_with_data] データ収集: ${homeTeam} vs ${awayTeam}`);
  const { matchResult, stats, topPlayers } = await collectMatchData(homeTeam, awayTeam);

  const prompt = `以下のサッカー試合データを分析し、YouTube動画の構成案（5〜6スライド）を提案してください。
返答は必ず純粋な JSON 形式のみで行ってください。

試合: ${matchResult.scoreline}
注目選手: ${topPlayers.map(p => p.name).join(', ')}

【スライド型の選択肢】
type1: 選手1人の紹介（左画像・右スタッツ）
type2: トピック（移籍・ケガ・汎用。右画像・左データ）
type3: 選手の驚異的な記録・今季通算（カード形式で強調）
type4: 選手/チーム同士の対比（左右に対比）
reaction: Redditの反応
stats: 試合スタッツ・戦術ボード

【出力JSONフォーマット】
{
  "topicSummary": "20字以内の概要",
  "keyAngle": "最大の見どころ（フック）",
  "modules": [
    {
      "id": "モジュールID",
      "slideType": "type1 | type2 | type3 | type4 | reaction | stats",
      "scriptDirection": "ナレーションの方向性や強調するポイント（日本語）",
      "params": { "playerNameEn": "英語名" }
    }
  ]
}`;

  console.log('[propose_with_data] Claude 4.6 に依頼中...');
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSONを取得できませんでした');
  
  const result = JSON.parse(match[0].replace(/[\x00-\x1F]/g, ""));
  result.modules = [{ ...MODULE_TYPES['opening'], scriptDirection: 'タイトルコール' }, ...result.modules, { ...MODULE_TYPES['ending'], scriptDirection: 'エンディング' }];
  result.matchData = { scoreline: matchResult.scoreline, homeTeam, awayTeam };
  return result;
}

async function proposeWithClaude(post) {
  const title = post._meta?.threadTitle || post.youtubeTitle || '';
  const prompt = `以下のサッカーニュースのYouTube構成案を JSON 形式で提案してください。
タイトル: ${title}

【スライド型】
type1: プロフ, type2: 話題, type3: 記録強調, type4: 対比, reaction: 反応, insight: 解説

【JSONフォーマット】
{
  "topicSummary": "20字以内",
  "keyAngle": "フック",
  "modules": [
    {
      "id": "ID",
      "slideType": "type1 | type2 | type3 | type4 | reaction | insight",
      "scriptDirection": "指示",
      "params": { "playerNameEn": "Name" }
    }
  ]
}`;

  console.log('[proposeWithClaude] Claude 4.6 に依頼中...');
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSONを取得できませんでした');

  const result = JSON.parse(match[0].replace(/[\x00-\x1F]/g, ""));
  const enriched = (result.modules || []).map(mod => {
    const def = MODULE_TYPES[mod.id];
    return def ? { ...def, ...mod, selected: true } : null;
  }).filter(Boolean);

  return {
    topicSummary: result.topicSummary || '',
    keyAngle:     result.keyAngle     || '',
    modules:      [{ ...MODULE_TYPES['opening'], scriptDirection: '開始' }, ...enriched, { ...MODULE_TYPES['ending'], scriptDirection: '終了' }],
  };
}

module.exports = { proposeWithData, proposeWithClaude };
