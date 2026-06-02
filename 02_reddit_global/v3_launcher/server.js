// v3_launcher/server.js
// Standalone V3 prototype launcher. It intentionally does not modify V2.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createArgumentPlan } = require('./v3_story_architect');
const { runTopicResearch, fetchWikiSideStories, aiExpandResearch } = require('./v3_research');
const { generateAIPlan, generateNarration } = require('./v3_planner');
const { factCheckAIPlan, factCheckScript } = require('./v3_fact_checker');
const { synthesizeStepData } = require('./v3_synthesizer');
const { callAI } = require(path.join(__dirname, '..', 'scripts', 'ai_client'));
const costTracker = require(path.join(__dirname, '..', 'scripts', 'cost_tracker'));
const { router: s3Router } = require('../routes/step3_routes');
const { router: s35Router } = require('../routes/step35_routes');
const { router: s4Router, getUI: s4UI } = require('../routes/step4_routes');

const app = express();
const PORT = Number(process.env.V3_LAUNCHER_PORT || 3005);
const UI_VERSION = 'v3-ui-client-js-fixed-yellow';
// Keep prototype output inside v3_launcher so V2 data directories stay untouched.
const DATA_DIR = path.join(__dirname, 'data', 'argument_plans');
const RECIPE_FILE = path.join(__dirname, 'data', 'slide_recipes.json');
const V2_DATA_DIR = path.join(__dirname, '..', 'data');
const V2_SI_DIR = path.join(V2_DATA_DIR, 'si_data');
const V2_SAVED_FILE = path.join(V2_DATA_DIR, 'saved_projects.json');
const JOB_DIR = path.join(V2_DATA_DIR, 'v2_jobs');
const V2_IMAGE_SELECTION_DIR = path.join(V2_DATA_DIR, 'image_selections');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(V2_SI_DIR)) fs.mkdirSync(V2_SI_DIR, { recursive: true });
if (!fs.existsSync(V2_IMAGE_SELECTION_DIR)) fs.mkdirSync(V2_IMAGE_SELECTION_DIR, { recursive: true });

const V3_RECIPE_SLOT_OPTIONS = [
  { key: '', label: '未設定', source: '' },
  { key: 'sofascore.player.apps', label: 'SofaScore: 出場数', source: 'sofascore' },
  { key: 'sofascore.player.goals', label: 'SofaScore: ゴール', source: 'sofascore' },
  { key: 'sofascore.player.assists', label: 'SofaScore: アシスト', source: 'sofascore' },
  { key: 'sofascore.player.rating', label: 'SofaScore: 平均評価', source: 'sofascore' },
  { key: 'sofascore.player.chancesCreated', label: 'SofaScore: チャンスメイク', source: 'sofascore' },
  { key: 'sofascore.player.successfulDribbles', label: 'SofaScore: ドリブル成功数', source: 'sofascore' },
  { key: 'sofascore.player.minutes', label: 'SofaScore: 出場時間', source: 'sofascore' },
  { key: 'sofascore.player.shotsOnTarget', label: 'SofaScore: 枠内シュート', source: 'sofascore' },
  { key: 'sofascore.player.totalShots', label: 'SofaScore: シュート数', source: 'sofascore' },
  { key: 'sofascore.player.xG', label: 'SofaScore: xG', source: 'sofascore' },
  { key: 'sofascore.player.bigChancesCreated', label: 'SofaScore: 決定機創出', source: 'sofascore' },
  { key: 'sofascore.player.keyPasses', label: 'SofaScore: キーパス', source: 'sofascore' },
  { key: 'sofascore.player.passAcc', label: 'SofaScore: パス成功率', source: 'sofascore' },
  { key: 'sofascore.player.tackles', label: 'SofaScore: タックル', source: 'sofascore' },
  { key: 'sofascore.player.interceptions', label: 'SofaScore: インターセプト', source: 'sofascore' },
  { key: 'sofascore.player.clearances', label: 'SofaScore: クリア', source: 'sofascore' },
  { key: 'sofascore.player.duelsWon', label: 'SofaScore: デュエル勝利', source: 'sofascore' },
  { key: 'sofascore.player.saves', label: 'SofaScore: セーブ', source: 'sofascore' },
  { key: 'sofascore.player.cleanSheets', label: 'SofaScore: クリーンシート', source: 'sofascore' },
  { key: 'sofascore.team.position', label: 'SofaScore: 順位', source: 'sofascore' },
  { key: 'sofascore.team.points', label: 'SofaScore: 勝点', source: 'sofascore' },
  { key: 'sofascore.team.wins', label: 'SofaScore: 勝利数', source: 'sofascore' },
  { key: 'sofascore.team.draws', label: 'SofaScore: 引分数', source: 'sofascore' },
  { key: 'sofascore.team.losses', label: 'SofaScore: 敗戦数', source: 'sofascore' },
  { key: 'sofascore.team.goalsFor', label: 'SofaScore: 得点', source: 'sofascore' },
  { key: 'sofascore.team.goalsAgainst', label: 'SofaScore: 失点', source: 'sofascore' },
  { key: 'sofascore.match.homeTeam', label: 'SofaScore: ホームチーム', source: 'sofascore' },
  { key: 'sofascore.match.awayTeam', label: 'SofaScore: アウェイチーム', source: 'sofascore' },
  { key: 'sofascore.match.score', label: 'SofaScore: スコア', source: 'sofascore' },
  { key: 'sofascore.match.date', label: 'SofaScore: 試合日', source: 'sofascore' },
  { key: 'sofascore.match.venue', label: 'SofaScore: 会場', source: 'sofascore' },
  { key: 'transfermarkt.player.marketValue', label: 'Transfermarkt: 市場価値', source: 'transfermarkt' },
  { key: 'transfermarkt.player.marketValuePeak', label: 'Transfermarkt: 最高市場価値', source: 'transfermarkt' },
  { key: 'transfermarkt.player.marketValueChange', label: 'Transfermarkt: 市場価値変動', source: 'transfermarkt' },
  { key: 'transfermarkt.player.contractUntil', label: 'Transfermarkt: 契約満了', source: 'transfermarkt' },
  { key: 'transfermarkt.player.agent', label: 'Transfermarkt: 代理人', source: 'transfermarkt' },
  { key: 'transfermarkt.player.club', label: 'Transfermarkt: 所属クラブ', source: 'transfermarkt' },
  { key: 'transfermarkt.player.number', label: 'Transfermarkt: 背番号', source: 'transfermarkt' },
  { key: 'transfermarkt.player.position', label: 'Transfermarkt: ポジション', source: 'transfermarkt' },
  { key: 'transfermarkt.transfer.fee', label: 'Transfermarkt: 移籍金', source: 'transfermarkt' },
  { key: 'transfermarkt.transfer.fromClub', label: 'Transfermarkt: 移籍元', source: 'transfermarkt' },
  { key: 'transfermarkt.transfer.toClub', label: 'Transfermarkt: 移籍先', source: 'transfermarkt' },
  { key: 'wiki.person.age', label: 'Wiki: 年齢', source: 'wiki' },
  { key: 'wiki.person.birthPlace', label: 'Wiki: 出身地', source: 'wiki' },
  { key: 'wiki.person.nationality', label: 'Wiki: 国籍', source: 'wiki' },
  { key: 'wiki.person.height', label: 'Wiki: 身長', source: 'wiki' },
  { key: 'wiki.player.foot', label: 'Wiki: 利き足', source: 'wiki' },
  { key: 'wiki.player.nationalTeam', label: 'Wiki: 代表チーム', source: 'wiki' },
  { key: 'wiki.player.caps', label: 'Wiki: 代表出場', source: 'wiki' },
  { key: 'wiki.player.nationalGoals', label: 'Wiki: 代表ゴール', source: 'wiki' },
  { key: 'wiki.club.founded', label: 'Wiki: クラブ創設年', source: 'wiki' },
  { key: 'wiki.club.stadium', label: 'Wiki: スタジアム', source: 'wiki' },
  { key: 'wiki.club.manager', label: 'Wiki: 監督', source: 'wiki' },
  { key: 'wiki.manager.currentTeam', label: 'Wiki: 現所属/指揮クラブ', source: 'wiki' },
  { key: 'wiki.manager.career', label: 'Wiki: 監督キャリア', source: 'wiki' },
];

const V3_RECIPE_DEFAULTS = [
  { category: '選手', id: 'PLAYER_SEASON_CURRENT', title: '今期成績', slideType: 'stats', dataSlots: ['sofascore.player.apps', 'sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.rating', 'sofascore.player.chancesCreated', 'sofascore.player.successfulDribbles', 'transfermarkt.player.club', 'wiki.player.nationalTeam'], note: '今季の活躍を数字で見せる基本スライド', priority: '高', status: '採用候補' },
  { category: '選手', id: 'PLAYER_SEASON_PREVIOUS', title: '前期成績', slideType: 'stats', dataSlots: ['sofascore.player.apps', 'sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.rating', 'sofascore.player.chancesCreated', 'sofascore.player.successfulDribbles', 'transfermarkt.player.club', ''], note: '前年からの伸びや落差を作る比較素材', priority: '高', status: '採用候補' },
  { category: '選手', id: 'PLAYER_SEASON_CAREER_HIGH', title: 'キャリアハイ成績', slideType: 'stats', dataSlots: ['sofascore.player.apps', 'sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.rating', 'transfermarkt.player.club', 'transfermarkt.player.marketValuePeak', 'wiki.player.nationalTeam', ''], note: 'ピーク時との距離感を伝える', priority: '高', status: '採用候補' },
  { category: '選手', id: 'PLAYER_MARKET_VALUE_TIMELINE', title: '市場価格推移', slideType: 'timeline', dataSlots: ['transfermarkt.player.marketValue', 'transfermarkt.player.marketValuePeak', 'transfermarkt.player.marketValueChange', 'transfermarkt.player.contractUntil', 'transfermarkt.player.club', 'transfermarkt.player.position', '', ''], note: '評価の上昇/下落を時系列で見せる', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_NATIONAL_TOTAL', title: '代表通算成績', slideType: 'stats', dataSlots: ['wiki.player.nationalTeam', 'wiki.player.caps', 'wiki.player.nationalGoals', 'wiki.person.nationality', 'wiki.person.age', 'sofascore.player.rating', '', ''], note: '代表での格や物語を補強する', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_CURRENT_CLUB_TOTAL', title: 'クラブ通算成績', slideType: 'stats', dataSlots: ['transfermarkt.player.club', 'sofascore.player.apps', 'sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.rating', 'transfermarkt.player.marketValue', '', ''], note: '現クラブでどれだけ積み上げたかを見せる', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_ALL_CLUB_TOTAL', title: '全クラブ通算成績', slideType: 'stats', dataSlots: ['sofascore.player.apps', 'sofascore.player.goals', 'sofascore.player.assists', 'transfermarkt.player.club', 'transfermarkt.player.marketValuePeak', 'wiki.person.nationality', '', ''], note: 'キャリア全体の重みを一枚で示す', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_COMPARE_CURRENT_PREVIOUS', title: '比較-今季VS前期', slideType: 'comparison', dataSlots: ['sofascore.player.apps', 'sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.rating', 'sofascore.player.chancesCreated', 'sofascore.player.successfulDribbles', '', ''], note: '成長/低下を視覚的に比較する', priority: '高', status: '採用候補' },
  { category: '選手', id: 'PLAYER_COMPARE_CURRENT_CAREER_HIGH', title: '比較-今季VSキャリアハイ', slideType: 'comparison', dataSlots: ['sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.rating', 'transfermarkt.player.marketValue', 'transfermarkt.player.marketValuePeak', '', '', ''], note: '今がピーク級か復活途上かを見せる', priority: '高', status: '採用候補' },
  { category: '選手', id: 'PLAYER_PROFILE_BASIC', title: '基本情報', slideType: 'profile', dataSlots: ['wiki.person.age', 'wiki.person.birthPlace', 'wiki.person.nationality', 'wiki.player.foot', 'transfermarkt.player.marketValue', 'transfermarkt.player.number', 'transfermarkt.player.position', 'transfermarkt.player.club'], note: 'プロフィールの基本情報を一枚で整理する', priority: '高', status: '採用候補' },
  { category: '選手', id: 'PLAYER_CONTRACT_STATUS', title: '契約状況', slideType: 'profile', dataSlots: ['transfermarkt.player.contractUntil', 'transfermarkt.player.agent', 'transfermarkt.player.marketValue', 'transfermarkt.player.club', 'transfermarkt.player.position', '', '', ''], note: '移籍話題や更新交渉の前提を整理する', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_ATTACK_OUTPUT', title: '攻撃貢献', slideType: 'stats', dataSlots: ['sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.chancesCreated', 'sofascore.player.keyPasses', 'sofascore.player.shotsOnTarget', 'sofascore.player.bigChancesCreated', '', ''], note: 'ゴール以外の攻撃関与まで見せる', priority: '高', status: '採用候補' },
  { category: '選手', id: 'PLAYER_CREATION_PROFILE', title: 'チャンスメイク型', slideType: 'stats', dataSlots: ['sofascore.player.chancesCreated', 'sofascore.player.bigChancesCreated', 'sofascore.player.keyPasses', 'sofascore.player.assists', 'sofascore.player.rating', '', '', ''], note: '創造性やラストパスを主役にする', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_DRIBBLE_PROFILE', title: 'ドリブル突破力', slideType: 'stats', dataSlots: ['sofascore.player.successfulDribbles', 'sofascore.player.rating', 'sofascore.player.chancesCreated', 'sofascore.player.goals', 'sofascore.player.assists', '', '', ''], note: '突破力がテーマの選手用', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_DEFENSIVE_WORK', title: '守備貢献', slideType: 'stats', dataSlots: ['sofascore.player.tackles', 'sofascore.player.interceptions', 'sofascore.player.rating', 'sofascore.player.minutes', 'transfermarkt.player.position', '', '', ''], note: '守備やハードワークを見せる', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_PLAYTIME_TREND', title: '出場時間推移', slideType: 'timeline', dataSlots: ['sofascore.player.apps', 'sofascore.player.minutes', 'sofascore.player.rating', 'transfermarkt.player.club', 'transfermarkt.player.position', '', '', ''], note: '序列の上昇/低下を扱う', priority: '中', status: '採用候補' },
  { category: '選手', id: 'PLAYER_VALUE_VS_OUTPUT', title: '市場価値VS成績', slideType: 'comparison', dataSlots: ['transfermarkt.player.marketValue', 'transfermarkt.player.marketValueChange', 'sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.rating', 'sofascore.player.apps', '', ''], note: '価格と実績が釣り合うかを見せる', priority: '高', status: '採用候補' },
  { category: 'チーム', id: 'TEAM_LEAGUE_STANDING', title: 'リーグ順位', slideType: 'stats', dataSlots: ['sofascore.team.position', 'sofascore.team.points', 'sofascore.team.wins', 'sofascore.team.draws', 'sofascore.team.losses', 'sofascore.team.goalsFor', 'sofascore.team.goalsAgainst', 'wiki.club.manager'], note: 'チーム企画の基本順位スライド', priority: '高', status: '採用候補' },
  { category: 'チーム', id: 'TEAM_ATTACK_DEFENSE_BALANCE', title: '得点と失点', slideType: 'comparison', dataSlots: ['sofascore.team.goalsFor', 'sofascore.team.goalsAgainst', 'sofascore.team.position', 'sofascore.team.points', 'sofascore.team.wins', 'sofascore.team.losses', '', ''], note: '攻守バランスの説明に使う', priority: '高', status: '採用候補' },
  { category: 'チーム', id: 'TEAM_FORM_BASIC', title: '今季の勝敗', slideType: 'stats', dataSlots: ['sofascore.team.wins', 'sofascore.team.draws', 'sofascore.team.losses', 'sofascore.team.points', 'sofascore.team.position', 'sofascore.team.goalsFor', 'sofascore.team.goalsAgainst', ''], note: '好調/不調の根拠を見せる', priority: '高', status: '採用候補' },
  { category: 'チーム', id: 'TEAM_PROFILE_BASIC', title: 'クラブ基本情報', slideType: 'profile', dataSlots: ['wiki.club.founded', 'wiki.club.stadium', 'wiki.club.manager', 'sofascore.team.position', 'sofascore.team.points', '', '', ''], note: 'クラブ紹介の基本情報', priority: '中', status: '採用候補' },
  { category: 'チーム', id: 'TEAM_MANAGER_CONTEXT', title: '監督体制', slideType: 'profile', dataSlots: ['wiki.club.manager', 'wiki.manager.career', 'wiki.manager.currentTeam', 'sofascore.team.position', 'sofascore.team.points', '', '', ''], note: '監督交代や体制評価の前提', priority: '中', status: '採用候補' },
  { category: 'チーム', id: 'TEAM_HISTORICAL_CONTEXT', title: 'クラブの背景', slideType: 'history', dataSlots: ['wiki.club.founded', 'wiki.club.stadium', 'wiki.club.manager', '', '', '', '', ''], note: '歴史や背景を数字少なめで扱う', priority: '低', status: '採用候補' },
  { category: '監督', id: 'MANAGER_PROFILE_BASIC', title: '監督プロフィール', slideType: 'profile', dataSlots: ['wiki.person.age', 'wiki.person.nationality', 'wiki.manager.currentTeam', 'wiki.manager.career', 'wiki.club.manager', '', '', ''], note: '監督紹介の基本', priority: '高', status: '採用候補' },
  { category: '監督', id: 'MANAGER_CURRENT_TEAM_RECORD', title: '現チーム成績', slideType: 'stats', dataSlots: ['wiki.manager.currentTeam', 'sofascore.team.position', 'sofascore.team.points', 'sofascore.team.wins', 'sofascore.team.draws', 'sofascore.team.losses', 'sofascore.team.goalsFor', 'sofascore.team.goalsAgainst'], note: '現体制の結果を見る', priority: '高', status: '採用候補' },
  { category: '監督', id: 'MANAGER_TACTICAL_EFFECT', title: '攻守改善', slideType: 'comparison', dataSlots: ['sofascore.team.goalsFor', 'sofascore.team.goalsAgainst', 'sofascore.team.position', 'sofascore.team.points', 'wiki.manager.currentTeam', '', '', ''], note: '就任後の変化や戦術効果を扱う', priority: '中', status: '採用候補' },
  { category: '監督', id: 'MANAGER_CAREER_PATH', title: '監督キャリア', slideType: 'timeline', dataSlots: ['wiki.manager.career', 'wiki.manager.currentTeam', 'wiki.person.nationality', 'wiki.person.age', '', '', '', ''], note: 'キャリアの流れを説明する', priority: '中', status: '採用候補' },
  { category: '試合', id: 'MATCH_CARD_BASIC', title: 'マッチカード', slideType: 'matchcard', dataSlots: ['sofascore.match.homeTeam', 'sofascore.match.awayTeam', 'sofascore.match.date', 'sofascore.match.venue', 'sofascore.match.score', '', '', ''], note: '試合企画の基本カード', priority: '高', status: '採用候補' },
  { category: '試合', id: 'MATCH_RESULT_CARD', title: '試合結果', slideType: 'matchcard', dataSlots: ['sofascore.match.homeTeam', 'sofascore.match.awayTeam', 'sofascore.match.score', 'sofascore.match.date', 'sofascore.match.venue', '', '', ''], note: '結果速報や試合後動画用', priority: '高', status: '採用候補' },
  { category: '試合', id: 'MATCH_TEAM_CONTEXT', title: '試合前の順位状況', slideType: 'comparison', dataSlots: ['sofascore.match.homeTeam', 'sofascore.match.awayTeam', 'sofascore.team.position', 'sofascore.team.points', 'sofascore.team.goalsFor', 'sofascore.team.goalsAgainst', '', ''], note: '対戦前の立ち位置を見せる', priority: '中', status: '採用候補' },
  { category: '移籍', id: 'TRANSFER_PROFILE', title: '移籍プロフィール', slideType: 'profile', dataSlots: ['transfermarkt.transfer.fromClub', 'transfermarkt.transfer.toClub', 'transfermarkt.transfer.fee', 'transfermarkt.player.marketValue', 'transfermarkt.player.contractUntil', 'transfermarkt.player.position', 'wiki.person.age', 'wiki.person.nationality'], note: '移籍ニュースの基本情報', priority: '高', status: '採用候補' },
  { category: '移籍', id: 'TRANSFER_VALUE_CHECK', title: '移籍金と市場価値', slideType: 'comparison', dataSlots: ['transfermarkt.transfer.fee', 'transfermarkt.player.marketValue', 'transfermarkt.player.marketValuePeak', 'transfermarkt.player.marketValueChange', 'sofascore.player.rating', '', '', ''], note: '高い/安いの判断材料', priority: '高', status: '採用候補' },
  { category: '移籍', id: 'TRANSFER_FIT_CURRENT_CLUB', title: '移籍先フィット', slideType: 'insight', dataSlots: ['transfermarkt.transfer.toClub', 'transfermarkt.player.position', 'sofascore.player.goals', 'sofascore.player.assists', 'sofascore.player.rating', 'wiki.person.age', '', ''], note: '移籍先で何が期待されるかを説明する', priority: '中', status: '採用候補' },
];

app.use((_, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use('/api', s3Router);
app.use('/api', s35Router);
app.use('/api', s4Router);
app.use('/images', express.static(path.join(__dirname, '..', 'images')));
app.use('/images_stock', express.static(path.join(__dirname, '..', 'images_stock')));
app.use('/v2_videos', express.static(path.join(__dirname, '..', 'data', 'v2_videos')));
app.use('/v2_thumbs', express.static(path.join(__dirname, '..', 'data', 'v2_thumbs')));
app.use('/bgm', express.static(path.join(__dirname, '..', 'bgm')));

function safeId(value) {
  return String(value || 'untitled')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'untitled';
}

function safeFileId(value) {
  return String(value || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function normalizeRecipe(recipe, index) {
  const allowedSlots = new Set(V3_RECIPE_SLOT_OPTIONS.map((item) => item.key));
  const dataSlots = Array.isArray(recipe?.dataSlots) ? recipe.dataSlots : [];
  return {
    category: String(recipe?.category || '選手').slice(0, 20),
    id: safeId(recipe?.id || `${recipe?.category || 'recipe'}_${index + 1}`).toUpperCase(),
    title: String(recipe?.title || '').slice(0, 80),
    slideType: String(recipe?.slideType || 'stats').slice(0, 24),
    dataSlots: Array.from({ length: 8 }, (_, i) => {
      const key = String(dataSlots[i] || '');
      return allowedSlots.has(key) ? key : '';
    }),
    note: String(recipe?.note || '').slice(0, 240),
    aiLabel: String(recipe?.aiLabel || recipe?.note || recipe?.title || '').slice(0, 120),
    useWhen: String(recipe?.useWhen || recipe?.note || '').slice(0, 240),
    claim: String(recipe?.claim || '').slice(0, 240),
    positionFit: String(recipe?.positionFit || '').slice(0, 120),
    priority: String(recipe?.priority || '中').slice(0, 12),
    status: String(recipe?.status || '採用候補').slice(0, 20),
  };
}

function readV3Recipes() {
  const data = readJson(RECIPE_FILE, null);
  if (Array.isArray(data?.recipes)) {
    return {
      version: data.version || 1,
      updatedAt: data.updatedAt || null,
      recipes: data.recipes.map(normalizeRecipe),
    };
  }
  return {
    version: 1,
    updatedAt: null,
    recipes: V3_RECIPE_DEFAULTS.map(normalizeRecipe),
  };
}

function writeV3Recipes(recipes) {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    recipes: recipes.map(normalizeRecipe),
  };
  fs.mkdirSync(path.dirname(RECIPE_FILE), { recursive: true });
  fs.writeFileSync(RECIPE_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

function compactSearchTopicServer(title, memo) {
  const raw = String(title || memo || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\[\]【】「」『』"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const latin = raw.match(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+){0,3}/g) || [];
  const usefulLatin = latin
    .filter((w) => !/^(reddit|thread|comments?|news|latest|the|and|for|with|from|about)$/i.test(w))
    .slice(0, 4)
    .join(' ');
  if (usefulLatin) return usefulLatin.split(/\s+/).slice(0, 10).join(' ');
  return raw
    .replace(/[、。！？!?].*$/, '')
    .split(/\s+/)
    .slice(0, 10)
    .join(' ')
    .slice(0, 72) || raw.slice(0, 72);
}

function serverArticleDigest(articles) {
  const full = (articles || []).filter((item) => /^full_text/.test(item.fetchStatus || ''));
  const pool = full.length ? full : (articles || []);
  const merged = pool.map((item) => [item.title, item.text].join('。')).join(' ');
  const pick = (patterns) => {
    const sentences = String(merged || '')
      .replace(/\s+/g, ' ')
      .split(/(?<=[。.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 30 && s.length <= 220);
    for (const pattern of patterns) {
      const hit = sentences.find((s) => pattern.test(s));
      if (hit) return hit;
    }
    return sentences[0] || '';
  };
  return {
    bullets: [
      { label: '出来事の概要', text: pick([/qualif|予選|World Cup|W杯|出場|result|結果|score/i]) },
      { label: '主な論点', text: pick([/transfer|移籍|contract|契約|manager|監督|squad|代表|lineup/i]) },
      { label: '裏話・人物', text: pick([/coach|manager|player|選手|監督|comment|said|コメント/i]) },
      { label: '企画化の材料', text: pick([/historic|history|first|初|record|記録|upset|快挙/i]) },
    ],
    fullTextCount: full.length,
    articleCount: (articles || []).length,
  };
}

function selectFetchedDataForPlan(labels, plan) {
  const needText = [
    plan?.topic,
    plan?.centralQuestion,
    plan?.thesis,
    ...(plan?.autopilotPlan?.briefing?.dataPlan || []).map((x) => x.need || x),
    ...(plan?.researchDesign?.tasks || []).map((x) => [x.need, x.expectedOutput, x.query].join(' ')),
  ].join(' ').toLowerCase();
  return (labels || []).map((item) => {
    let score = item.ok ? 2 : -2;
    const nameParts = String(item.nameEn || '').toLowerCase().split(/\s+/).filter((p) => p.length >= 3);
    const nameHit = nameParts.some((p) => needText.includes(p));
    if (nameHit) score += 5;
    if (Array.isArray(item.slots) && item.slots.length) score += 2;
    if (/ゴール|アシスト|評価|出場|クラブ|年齢|順位|勝点|得点|失点|状態|評価額/.test((item.labels || []).join(' '))) score += 2;
    if (item.type === 'team' && /順位|勝点|得点|失点/.test((item.labels || []).join(' '))) score += 1;
    return { ...item, relevanceScore: score, selected: item.ok && nameHit && score >= 7 };
  }).sort((a, b) => Number(b.selected) - Number(a.selected) || b.relevanceScore - a.relevanceScore);
}

function buildFetchedMemoBlock(fetchedData) {
  const usable = (fetchedData || []).filter((d) => d.ok && d.selected);
  const standby = (fetchedData || []).filter((d) => d.ok && !d.selected);
  const failed = (fetchedData || []).filter((d) => !d.ok);
  const line = (d) => {
    const slotStr = (Array.isArray(d.slots) && d.slots.length)
      ? d.slots.map((s) => `${s.label}: ${s.value}`).join(' / ')
      : d.summary;
    return `${d.nameEn} (${d.type || 'entity'}): ${slotStr}`;
  };
  return [
    usable.length ? `[採用候補データ（企画書・構成で優先使用）]\n${usable.map(line).join('\n')}` : '',
    standby.length ? `[補欠データ（必要なら使用）]\n${standby.slice(0, 4).map(line).join('\n')}` : '',
    failed.length ? `[取得失敗・未確認データ（断定禁止）]\n${failed.map(line).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildServerAcquiredDataSummary(research, wikiStories, fetchedData) {
  const articles = research?.learningCorpus || [];
  return {
    queryLabels: research?.queryLabels || [],
    queries: research?.queries || [],
    articleDigest: (research?.summary?.materialBulletsJa?.length)
      ? { bullets: research.summary.materialBulletsJa, fullTextCount: research.summary.fullTextCount || 0, articleCount: articles.length }
      : serverArticleDigest(articles),
    webSources: articles.slice(0, 8).map((item) => ({
      title: item.titleJa || item.title || item.host || 'article',
      url: item.url || '',
      host: item.host || '',
      fetchStatus: item.fetchStatus || '',
    })),
    structuredData: (wikiStories?.results || []).slice(0, 4).map((item) => ({
      label: item.entity + ' - Wiki小話候補',
      source: 'Wikipedia',
      value: (item.sideStoryCandidates || []).map((x) => x.text).join(' ').slice(0, 220),
      status: 'side_story',
    })),
    entities: (fetchedData || []).map((d) => d.nameEn).filter(Boolean).slice(0, 12),
    labelCandidates: [
      ...(research?.labelCandidates || []),
      ...(wikiStories?.results || []).map((x) => ({ name: x.entity, type: 'wiki' })).filter((x) => x.name),
      ...(fetchedData || []).map((d) => ({ name: d.nameEn, type: d.type || 'entity' })).filter((x) => x.name),
    ].filter(Boolean).slice(0, 16),
    costSummary: research?.costSummary || null,
  };
}

function mergeAutopilotPlanServer(base, aiPlan) {
  if (!aiPlan) return base || {};
  const selectedIdx = aiPlan.themeProposal?.selected || 0;
  const selectedCandidate = (aiPlan.themeProposal?.candidates || [])[selectedIdx] || {};
  return {
    ...(base || {}),
    aiGenerated: !!aiPlan.aiGenerated,
    aiFallback: !!aiPlan.fallback,
    articleCount: aiPlan.articleCount || 0,
    themeProposal: {
      ...(base?.themeProposal || {}),
      hookQuestion: selectedCandidate.hookQuestion || '',
      answer: selectedCandidate.answer || '',
      angle: selectedCandidate.angle || '',
      storyPattern: selectedCandidate.storyPattern || '',
      candidates: aiPlan.themeProposal?.candidates || [],
      selected: selectedIdx,
      selectedReason: aiPlan.themeProposal?.selectedReason || '',
      rejectedReasons: aiPlan.themeProposal?.rejectedReasons || [],
      dataPlan: (selectedCandidate.dataNeeds || []).map((need, i) => ({ no: i + 1, need })),
    },
    briefing: {
      ...(base?.briefing || {}),
      purpose: aiPlan.briefing?.purpose || '',
      coreMessage: aiPlan.briefing?.coreMessage || '',
      storyPattern: selectedCandidate.storyPattern || aiPlan.briefing?.storyPattern || '',
      chapters: aiPlan.briefing?.chapters || [],
      slideOutline: selectedCandidate.slideOutline || aiPlan.briefing?.slideOutline || [],
      videoLengthType: selectedCandidate.videoLengthType || '',
      targetMinutes: selectedCandidate.targetMinutes || '',
      dataPlan: (aiPlan.briefing?.chapters || [])
        .flatMap((ch) => (ch.dataNeeds || []).map((need) => ({ need })))
        .slice(0, 8),
      riskChecklist: aiPlan.briefing?.riskChecklist || [],
    },
    scriptStructure: base?.scriptStructure || [],
    scriptDraft: base?.scriptDraft || [],
    mustCheck: (aiPlan.missingData || []).map((need) => ({ need, query: '', sourcePriority: [] })),
    publishGates: aiPlan.publishGates?.length ? aiPlan.publishGates : (base?.publishGates || []),
  };
}

function attachSelectedDataToPlan(plan, fetchedData) {
  const selected = (fetchedData || []).filter((d) => d.ok);
  const draft = plan?.autopilotPlan?.scriptDraft;
  if (!selected.length || !Array.isArray(draft) || !draft.length) return plan;
  const dataItems = [];
  selected.forEach((d) => {
    if (Array.isArray(d.slots) && d.slots.length) {
      d.slots.slice(0, 4).forEach((slot) => {
        dataItems.push({
          label: `${d.nameEn} ${slot.label}`,
          value: slot.value,
          sourceTitle: d.sourceTitle || 'SofaScore/TM',
          sourceUrl: d.sourceUrl || '',
          confidence: d.confidence || (d.relevanceScore >= 6 ? 'medium' : 'low'),
          reason: `取得済みデータ候補 score=${d.relevanceScore}`,
        });
      });
    } else if (d.summary) {
      dataItems.push({
        label: d.nameEn,
        value: d.summary,
        sourceTitle: d.sourceTitle || 'SofaScore/TM',
        sourceUrl: d.sourceUrl || '',
        confidence: d.confidence || 'low',
        reason: `取得済みデータ候補 score=${d.relevanceScore}`,
      });
    }
  });
  if (!dataItems.length) return plan;
  const scoreSlide = (slide, index, data) => {
    if (index === 0 || index === draft.length - 1) return -10;
    const text = [slide.role, slide.title, slide.narration, ...(slide.dataNeeds || [])].join(' ').toLowerCase();
    const label = String(data.label || '').toLowerCase();
    const nameParts = label.split(/\s+/).filter((p) => p.length >= 3);
    const nameMatch = nameParts.some((p) => text.includes(p));
    const semanticRules = [
      [/ゴール|得点|goal/i, /ゴール|得点|goal/i],
      [/アシスト|assist/i, /アシスト|assist/i],
      [/評価|rating/i, /評価|rating/i],
      [/出場|appearance|試合/i, /出場|appearance|試合/i],
      [/クラブ|所属|team|club/i, /クラブ|所属|team|club/i],
      [/年齢|age/i, /年齢|age/i],
      [/順位|勝点|勝|分|負|得点|失点|standing|points/i, /順位|勝点|勝|分|負|得点|失点|standing|points/i],
      [/状態|負傷|injury/i, /状態|負傷|injury/i],
      [/市場価値|評価額|market/i, /市場価値|評価額|market/i],
    ];
    const semanticMatch = semanticRules.some(function(pair) { return pair[0].test(text) && pair[1].test(label); });
    let score = 0;
    if (!nameMatch) return -10;
    if (/stats|evidence|data|profile|数字|データ|成績|選手|クラブ|得点|アシスト|評価|順位|勝点/i.test(text)) score += 2;
    if (nameMatch) score += 5;
    if (semanticMatch) score += 1;
    return score;
  };
  dataItems.forEach((data) => {
    let best = { index: -1, score: -10 };
    draft.forEach((slide, index) => {
      const score = scoreSlide(slide, index, data);
      if (score > best.score) best = { index, score };
    });
    if (best.index < 0 || best.score < 5) return;
    const targetIndex = best.index;
    draft[targetIndex].selectedData = [
      ...(draft[targetIndex].selectedData || []),
      data,
    ].slice(0, 6);
  });
  const structure = plan?.autopilotPlan?.scriptStructure;
  const outline = plan?.autopilotPlan?.briefing?.slideOutline;
  [structure, outline].forEach((rows) => {
    if (!Array.isArray(rows)) return;
    rows.forEach((row, index) => {
      const source = draft[index]?.selectedData || [];
      if (!source.length) return;
      row.selectedData = [
        ...(Array.isArray(row.selectedData) ? row.selectedData : []),
        ...source,
      ].slice(0, 6);
    });
  });
  return plan;
}

function makeV2PostId(title) {
  const now = new Date(Date.now() + 9 * 3600_000);
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hms = now.toISOString().slice(11, 19).replace(/:/g, '');
  const slug = safeId(title).toLowerCase().replace(/_/g, '').slice(0, 18) || Math.random().toString(36).slice(2, 8);
  const rand = Math.random().toString(36).slice(2, 6);
  return `v3_${ymd}_${hms}_${slug}_${rand}`;
}

function normalizeV2Type(role, type, index, total) {
  if (index === 0) return 'opening';
  if (index === total - 1) return 'ending';
  if (['history', 'comparison', 'stats', 'profile', 'insight'].includes(type)) return type;
  if (role === 'answer') return 'insight';
  if (role === 'contrast') return 'comparison';
  return 'insight';
}

function buildV2ModulesFromPlan(plan) {
  if (Array.isArray(plan?.v3Modules) && plan.v3Modules.length) {
    return plan.v3Modules;
  }
  const auto = plan?.autopilotPlan || {};
  const script = Array.isArray(auto.scriptDraft) && auto.scriptDraft.length
    ? auto.scriptDraft
    : (Array.isArray(plan?.slidePlan) ? plan.slidePlan.map((slide, index) => ({
      slideNo: index + 1,
      title: slide.headline,
      role: slide.role,
      narration: slide.claim,
      dataNeeds: (slide.dataSlots || []).map((slot) => slot.label),
    })) : []);
  const slideById = new Map((plan?.slidePlan || []).map((slide) => [slide.id, slide]));

  return script.map((item, index) => {
    const slide = slideById.get(item.slideId) || (plan?.slidePlan || [])[index] || {};
    const dataNeeds = Array.isArray(item.dataNeeds) ? item.dataNeeds : [];
    const dataSlots = dataNeeds.slice(0, 5).map((need) => ({
      label: String(need || '').slice(0, 60),
      value: '',
    }));
    return {
      mainKey: index === 0 ? 'opening' : (index === script.length - 1 ? 'ending' : `v3:${slide.id || item.slideNo || index + 1}`),
      subSource: 'v3',
      subValue: item.role || slide.role || '',
      secondary: null,
      type: normalizeV2Type(item.role || slide.role, slide.slideType, index, script.length),
      scriptDir: '',
      title: String(item.title || slide.headline || `Slide ${index + 1}`).slice(0, 80),
      narration: String(item.narration || slide.claim || '').trim(),
      dataSlots,
      catchphrases: [],
      comments: [],
      v3Meta: {
        slideId: item.slideId || slide.id || '',
        role: item.role || slide.role || '',
        visualIntent: item.visual || slide.visualIntent || '',
        caution: item.caution || '',
      },
    };
  });
}

function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildV3SiForV2Editor({ postId, plan, fetchedData, acquiredData, research, selectedProject }) {
  const entityItems = [];
  const seen = new Set();
  const pushEntity = (item = {}) => {
    const label = item.nameEn || item.name || item.label || '';
    if (!label || seen.has(label)) return;
    seen.add(label);
    entityItems.push({
      label,
      role: item.type || item.role || 'entity',
      ok: item.ok !== false,
      summary: item.summary || '',
      slots: Array.isArray(item.slots) ? item.slots : [],
      source: item.source || 'v3',
      v3Selected: !!item.selected,
      raw: item.raw || null,
    });
  };
  (fetchedData || []).forEach(pushEntity);
  const selectedData = plan?.autopilotPlan?.selectedData || plan?.selectedData || [];
  selectedData.forEach(pushEntity);

  const searchItems = [];
  (research?.learningCorpus || []).slice(0, 24).forEach((article, index) => {
    searchItems.push({
      label: article.titleJa || article.title || article.host || `article_${index + 1}`,
      url: article.url || '',
      host: article.host || '',
      score: article.score || 0,
      fetchStatus: article.fetchStatus || '',
      text: String(article.text || '').slice(0, 900),
    });
  });

  return {
    postId,
    version: 'v3_to_v2_editor',
    savedAt: new Date().toISOString(),
    boxes: {
      entity: { items: entityItems },
      match: { items: [] },
      search: { items: searchItems },
    },
    v3Export: {
      topic: plan?.topic || selectedProject?.title || '',
      centralQuestion: plan?.centralQuestion || '',
      thesis: plan?.thesis || '',
      researchDesign: plan?.researchDesign || null,
      autopilotPlan: plan?.autopilotPlan || null,
      synthesis: plan?.synthesis || null,
      acquiredData: acquiredData || null,
      fetchedData: fetchedData || [],
      sourceProject: selectedProject || null,
    },
  };
}

function writeV3ImageSelectionsForV2Editor(postId, imageSelections, modules) {
  const selections = {};
  if (imageSelections && typeof imageSelections === 'object') {
    Object.entries(imageSelections).forEach(([key, value]) => {
      if (Array.isArray(value) && value.length) selections[key] = value;
    });
  }
  (modules || []).forEach((module) => {
    const key = module.mainKey || module.title || module.type || '';
    if (!key || !Array.isArray(module.images) || !module.images.length) return;
    selections[key] = Array.from(new Set([...(selections[key] || []), ...module.images]));
  });
  const file = path.join(V2_IMAGE_SELECTION_DIR, `${safeFileId(postId)}.json`);
  fs.writeFileSync(file, JSON.stringify({ postId, selections, savedAt: new Date().toISOString(), source: 'v3_launcher' }, null, 2));
  return { file, count: Object.keys(selections).length };
}

app.get('/api/v3/health', (_, res) => {
  res.json({ ok: true, name: 'v3-launcher-prototype', port: PORT });
});

app.get('/api/v3/recipe-slot-options', (_, res) => {
  res.json({ options: V3_RECIPE_SLOT_OPTIONS });
});

app.get('/api/v3/recipes', (_, res) => {
  res.json(readV3Recipes());
});

app.post('/api/v3/recipes', (req, res) => {
  try {
    const recipes = Array.isArray(req.body?.recipes) ? req.body.recipes : [];
    if (!recipes.length) return res.status(400).json({ success: false, error: 'recipes is required' });
    const saved = writeV3Recipes(recipes);
    res.json({ success: true, count: saved.recipes.length, updatedAt: saved.updatedAt, file: RECIPE_FILE });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/v3/content', (req, res) => {
  const d = req.query.date;
  if (!d) return res.status(400).json({ error: 'date is required' });
  const file = path.join(V2_DATA_DIR, `stories_${String(d).replace(/-/g, '_')}.json`);
  const data = readJson(file, { posts: [] });
  const posts = (data.posts || []).map((p, i) => ({
    idx: i,
    id: p.id || String(i),
    title: p.titleJa || p.title || '(タイトル不明)',
    titleOrig: p.title || '',
    addedAt: p.added_at || p.addedAt || (p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null),
    source: p.source || 'reddit',
    score: p.score || 0,
    raw: p,
  }));
  res.json({ posts });
});

app.get('/api/v3/saved-projects', (_, res) => {
  const saved = readJson(V2_SAVED_FILE, []);
  res.json(Array.isArray(saved) ? saved : []);
});

app.post('/api/v3/saved-projects', (req, res) => {
  try {
    const projects = Array.isArray(req.body?.projects) ? req.body.projects : [];
    fs.writeFileSync(V2_SAVED_FILE, JSON.stringify(projects, null, 2));
    res.json({ ok: true, count: projects.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v3/argument-plan', (req, res) => {
  try {
    const plan = createArgumentPlan(req.body || {});
    res.json({ success: true, plan });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/argument-plan/save', (req, res) => {
  try {
    const plan = req.body?.plan;
    if (!plan) return res.status(400).json({ success: false, error: 'plan is required' });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeId(plan.topic)}`;
    const filePath = path.join(DATA_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(plan, null, 2));
    res.json({ success: true, id, filePath });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/research/topic', async (req, res) => {
  try {
    const { topic, memo } = req.body || {};
    const result = await runTopicResearch(req.body || {});

    // AI reads initial articles → generates follow-up queries + identifies entities
    const expanded = await aiExpandResearch(topic, memo, result.learningCorpus).catch((e) => {
      console.warn('[research/topic] aiExpandResearch error:', e.message);
      return { followUpQueries: [], entities: [] };
    });
    result.labelCandidates = (expanded.entities || [])
      .filter((e) => e && e.nameEn)
      .map((e) => ({ name: e.nameEn, type: e.type || 'entity' }));

    // Run follow-up queries as snippet-only entries (no full article fetch — saves Jina credits)
    if (expanded.followUpQueries.length) {
      const { fetchSerper } = require(path.join(__dirname, '..', 'scripts', 'modules', 'fetchers', 'serper_module'));
      const startIdx = result.learningCorpus.length + 1;
      for (let qi = 0; qi < expanded.followUpQueries.length; qi++) {
        const q = expanded.followUpQueries[qi];
        try {
          const serper = await fetchSerper(q, 'v3_followup', 'en', null);
          (serper.organic || []).slice(0, 3).forEach((item, j) => {
            const snippet = `${item.title || ''}\n${item.snippet || ''}`.trim();
            if (!snippet) return;
            result.learningCorpus.push({
              index: startIdx + qi * 3 + j,
              title: item.title || '',
              url: item.link || '',
              host: (() => { try { return new URL(item.link).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })(),
              fetchStatus: 'followup_snippet',
              score: 0.6,
              usableFor: ['fact_check', 'rule_check'],
              text: snippet.slice(0, 400),
            });
          });
          console.log(`[research/topic] follow-up "${q}" → ${(serper.organic || []).length} results`);
        } catch (qe) {
          console.warn('[research/topic] follow-up query failed:', qe.message);
        }
      }
    }

    res.json({ success: true, result, aiEntities: expanded.entities, followUpQueries: expanded.followUpQueries });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/research/wiki-side-stories', async (req, res) => {
  try {
    const result = await fetchWikiSideStories(req.body || {});
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/analyze', async (req, res) => {
  try {
    const { topic, memo, researchCorpus, wikiStories, fetchedData } = req.body || {};
    const result = await generateAIPlan(topic, memo, researchCorpus, wikiStories, fetchedData || []);
    res.json({ success: true, result });
  } catch (error) {
    console.error('[v3/analyze]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const proposalJobs = new Map();

function compactResearchForSave(research) {
  return research ? {
    ok: research.ok,
    topic: research.topic,
    queryLabels: research.queryLabels || [],
    labelCandidates: research.labelCandidates || [],
    queries: research.queries,
    summary: research.summary,
    learningCorpus: (research.learningCorpus || []).map((c) => ({
      index: c.index,
      title: c.title,
      titleJa: c.titleJa,
      url: c.url,
      host: c.host,
      fetchStatus: c.fetchStatus,
      score: c.score,
      usableFor: c.usableFor,
      text: (c.text || '').slice(0, 300),
    })),
  } : null;
}

function saveProposalResultToProject(projectId, payload, lastStage, error = '') {
  try {
    if (!projectId) return;
    const saved = readJson(V2_SAVED_FILE, []);
    if (!Array.isArray(saved)) return;
    const idx = saved.findIndex((p) => p.id === projectId);
    if (idx < 0) return;
    const prev = saved[idx].researchData || {};
    saved[idx] = {
      ...saved[idx],
      researchData: {
        ...prev,
        plan: payload.plan || prev.plan || null,
        research: payload.research ? compactResearchForSave(payload.research) : (prev.research || null),
        wikiStories: payload.wikiStories || prev.wikiStories || null,
        aiPlan: payload.aiPlan || prev.aiPlan || null,
        acquiredData: payload.acquiredData || prev.acquiredData || null,
        fetchedData: payload.fetchedData || prev.fetchedData || null,
        jobStatus: {
          jobId: payload.jobId || prev.jobStatus?.jobId || '',
          lastStage,
          error,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(V2_SAVED_FILE, JSON.stringify(saved, null, 2));
  } catch (saveError) {
    console.warn('[proposal-job] save progress failed:', saveError.message);
  }
}

async function appendFollowUpSnippets(result, expanded) {
  const followUpQueries = expanded.followUpQueries || [];
  if (!followUpQueries.length) return;
  const { fetchSerper } = require(path.join(__dirname, '..', 'scripts', 'modules', 'fetchers', 'serper_module'));
  const startIdx = (result.learningCorpus || []).length + 1;
  for (let qi = 0; qi < followUpQueries.length; qi++) {
    const q = followUpQueries[qi];
    try {
      const serper = await fetchSerper(q, 'v3_followup', 'en', null);
      (serper.organic || []).slice(0, 3).forEach((item, j) => {
        const snippet = `${item.title || ''}\n${item.snippet || ''}`.trim();
        if (!snippet) return;
        result.learningCorpus.push({
          index: startIdx + qi * 3 + j,
          title: item.title || '',
          url: item.link || '',
          host: (() => { try { return new URL(item.link).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })(),
          fetchStatus: 'followup_snippet',
          score: 0.6,
          usableFor: ['fact_check', 'rule_check'],
          text: snippet.slice(0, 400),
        });
      });
    } catch (error) {
      console.warn('[proposal-job] follow-up query failed:', error.message);
    }
  }
}

async function runProposalJob(jobId, input) {
  const job = proposalJobs.get(jobId);
  const setStage = (stage, message, partial = {}) => {
    Object.assign(job, { stage, message, updatedAt: new Date().toISOString(), ...partial });
    saveProposalResultToProject(input.selectedProjectId, { ...partial, jobId }, stage);
  };
  costTracker.reset();
  try {
    let plan = input.plan || createArgumentPlan({ topic: input.title, memo: input.memo, sourceType: input.sourceType });
    const searchTopic = compactSearchTopicServer(input.title, input.memo);
    const base = { topic: searchTopic || input.title, memo: input.memo || '', plan };

    setStage('query', 'Step2-1 検索クエリ作成中...', { plan });
    const research = await runTopicResearch(base);
    setStage('articles', 'Step2-2 ニュース記事取得中...', { plan, research });
    const expanded = await aiExpandResearch(base.topic, base.memo, research.learningCorpus).catch((error) => {
      console.warn('[proposal-job] aiExpandResearch failed:', error.message);
      return { followUpQueries: [], entities: [] };
    });
    research.labelCandidates = (expanded.labels || expanded.entities || [])
      .filter((e) => e && e.nameEn)
      .map((e) => ({
        name: e.nameEn,
        nameJa: e.nameJa || '',
        type: e.type || 'entity',
        role: e.role || '',
        dataNeeded: e.dataNeeded !== false,
        reason: e.reason || '',
      }));
    setStage('labels', 'Step2-3 本筋ラベル作成中...', { plan, research });

    let wikiStories = { ok: true, results: [], entityCount: 0, warning: '' };
    try {
      wikiStories = await fetchWikiSideStories({ ...base, learningCorpus: research.learningCorpus || [] });
    } catch (error) {
      wikiStories = { ok: false, results: [], entityCount: 0, warning: error.message };
    }
    setStage('prefetch', 'Step2-4 SofaScore / Transfermarkt / Wiki データ取得中...', { plan, research, wikiStories });

    let prefetch = { success: true, labels: [], warnings: [] };
    try {
      prefetch = await runAutoPrefetchCore({
        topic: input.title,
        memo: input.memo,
        learningCorpus: research.learningCorpus || [],
        wikiResults: wikiStories.results || [],
        aiEntities: expanded.entities || [],
      });
    } catch (error) {
      prefetch = { success: false, labels: [], warnings: [error.message] };
    }
    const fetchedData = selectFetchedDataForPlan(prefetch.labels || [], plan);
    const acquiredData = buildServerAcquiredDataSummary(research, wikiStories, fetchedData);
    setStage('analyze', 'Step2-5 取得結果から企画書A/B/C作成中...', {
      plan,
      research,
      wikiStories,
      fetchedData,
      acquiredData,
    });

    const memoBlock = buildFetchedMemoBlock(fetchedData);
    const rawMemo = [input.memo || '', memoBlock].filter(Boolean).join('\n\n');
    const { enrichedMemo } = await synthesizeStepData({
      topic: input.title,
      rawMemo,
      research,
      wikiStories,
      fetchedData: (fetchedData || []).filter((d) => d.ok),
    }).catch((e) => {
      console.warn('[proposal-job] synthesize skipped:', e.message);
      return { enrichedMemo: rawMemo };
    });
    let aiPlan;
    try {
      aiPlan = await generateAIPlan(input.title, enrichedMemo, research, wikiStories, fetchedData || []);
      aiPlan = await factCheckAIPlan(aiPlan).catch((e) => {
        console.warn('[proposal-job] factCheck skipped:', e.message);
        return aiPlan;
      });
      plan = { ...plan, autopilotPlan: mergeAutopilotPlanServer(plan.autopilotPlan, aiPlan) };
      plan = attachSelectedDataToPlan(plan, fetchedData);
    } catch (error) {
      aiPlan = {
        ok: false,
        aiGenerated: false,
        fallback: true,
        error: error.message,
        missingData: ['AI企画書生成の再実行'],
        publishGates: ['AI分析失敗のため公開前に人間確認する'],
      };
      plan = {
        ...plan,
        autopilotPlan: {
          ...(plan.autopilotPlan || {}),
          aiGenerated: false,
          aiFallback: true,
          aiFallbackReason: error.message,
          mustCheck: [{ need: 'AI企画書生成の再実行', query: '', sourcePriority: [] }],
        },
      };
    }
    const costSummary = costTracker.getSummary();
    research.costSummary = costSummary;
    acquiredData.costSummary = costSummary;
    console.log(`[cost] ━━ ジョブ合計: ${costSummary.calls}コール | $${costSummary.totalUsd} (¥${costSummary.totalJpy}) ━━`);
    const result = { plan, research, wikiStories, aiPlan, fetchedData, acquiredData, prefetchWarnings: prefetch.warnings || [], costSummary };
    Object.assign(job, {
      status: 'done',
      stage: 'done',
      message: 'Step2-5 完了',
      result,
      updatedAt: new Date().toISOString(),
    });
    saveProposalResultToProject(input.selectedProjectId, { ...result, jobId }, 'done');
  } catch (error) {
    Object.assign(job, {
      status: 'error',
      stage: 'error',
      message: error.message,
      error: error.message,
      updatedAt: new Date().toISOString(),
    });
    saveProposalResultToProject(input.selectedProjectId, { plan: input.plan, jobId }, 'error', error.message);
  }
}

app.post('/api/v3/proposal-job/start', (req, res) => {
  const body = req.body || {};
  const jobId = `v3job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  proposalJobs.set(jobId, {
    id: jobId,
    status: 'running',
    stage: 'queued',
    message: '開始待ち',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  setImmediate(() => runProposalJob(jobId, body));
  res.json({ success: true, jobId });
});

app.get('/api/v3/proposal-job/:jobId', (req, res) => {
  const job = proposalJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'job not found' });
  res.json({ success: true, job });
});

// ── auto-prefetch: 記事から entity 抽出 → SofaScore で構造化データを自動取得 ──
// Japanese katakana/kanji → English lookup for common soccer figures
const JP_ENTITY_MAP = [
  // Players
  ['ジョアン', 'player', 'João Pedro'], ['ネイマール', 'player', 'Neymar'],
  ['ヴィニシウス', 'player', 'Vinicius Junior'], ['ヴィニ', 'player', 'Vinicius Junior'],
  ['ロドリゴ', 'player', 'Rodrygo'], ['ムバッペ', 'player', 'Kylian Mbappe'], ['エムバペ', 'player', 'Kylian Mbappe'],
  ['ハーランド', 'player', 'Erling Haaland'], ['ベリンガム', 'player', 'Jude Bellingham'],
  ['ヤマル', 'player', 'Lamine Yamal'], ['ペドリ', 'player', 'Pedri'], ['フェルミン', 'player', 'Fermin Lopez'],
  ['サラー', 'player', 'Mohamed Salah'], ['ヌニェス', 'player', 'Darwin Nunez'],
  ['デブライネ', 'player', 'Kevin De Bruyne'], ['ロドリ', 'player', 'Rodri'],
  ['モドリッチ', 'player', 'Luka Modric'], ['クロース', 'player', 'Toni Kroos'],
  ['ケイン', 'player', 'Harry Kane'], ['サカ', 'player', 'Bukayo Saka'],
  ['ラッシュフォード', 'player', 'Marcus Rashford'], ['フォーデン', 'player', 'Phil Foden'],
  ['グリーズマン', 'player', 'Antoine Griezmann'], ['ジルー', 'player', 'Olivier Giroud'],
  ['デンベレ', 'player', 'Ousmane Dembele'], ['テュラム', 'player', 'Marcus Thuram'],
  ['ラウタロ', 'player', 'Lautaro Martinez'], ['ルカク', 'player', 'Romelu Lukaku'],
  ['ディバラ', 'player', 'Paulo Dybala'], ['メッシ', 'player', 'Lionel Messi'],
  ['ロナウド', 'player', 'Cristiano Ronaldo'], ['レバンドフスキ', 'player', 'Robert Lewandowski'],
  ['フィルミーノ', 'player', 'Roberto Firmino'], ['ガクポ', 'player', 'Cody Gakpo'],
  ['守田', 'player', 'Hidemasa Morita'], ['鎌田', 'player', 'Daichi Kamada'],
  ['久保', 'player', 'Takefusa Kubo'], ['三笘', 'player', 'Kaoru Mitoma'],
  ['遠藤', 'player', 'Wataru Endo'], ['南野', 'player', 'Takumi Minamino'],
  // Managers
  ['アンチェロッティ', 'manager', 'Carlo Ancelotti'], ['グアルディオラ', 'manager', 'Pep Guardiola'],
  ['クロップ', 'manager', 'Jurgen Klopp'], ['モウリーニョ', 'manager', 'Jose Mourinho'],
  ['アロンソ', 'manager', 'Xabi Alonso'], ['デラフエンテ', 'manager', 'Luis de la Fuente'],
  ['エンリケ', 'manager', 'Luis Enrique'], ['テンハグ', 'manager', 'Erik ten Hag'],
  // Teams
  ['マドリー', 'team', 'Real Madrid'], ['レアル', 'team', 'Real Madrid'],
  ['バルサ', 'team', 'FC Barcelona'], ['バルセロナ', 'team', 'FC Barcelona'],
  ['バイエルン', 'team', 'Bayern Munich'], ['ドルトムント', 'team', 'Borussia Dortmund'],
  ['チェルシー', 'team', 'Chelsea'], ['アーセナル', 'team', 'Arsenal'],
  ['リバプール', 'team', 'Liverpool'], ['マンチェスター', 'team', 'Manchester City'],
  ['トッテナム', 'team', 'Tottenham Hotspur'], ['ニューカッスル', 'team', 'Newcastle United'],
  ['ユベントス', 'team', 'Juventus'], ['インテル', 'team', 'Inter Milan'],
  ['ミラン', 'team', 'AC Milan'], ['ナポリ', 'team', 'Napoli'],
  ['ブライトン', 'team', 'Brighton'], ['アストン', 'team', 'Aston Villa'],
  ['スペイン代表', 'team', 'Spain'],
  ['ブラジル代表', 'team', 'Brazil'],
  ['フランス代表', 'team', 'France'],
  ['ドイツ代表', 'team', 'Germany'],
  ['イングランド代表', 'team', 'England'],
  ['アルゼンチン代表', 'team', 'Argentina'],
  ['日本代表', 'team', 'Japan'],
  ['オランダ代表', 'team', 'Netherlands'],
  ['ポルトガル代表', 'team', 'Portugal'],
];

function extractEntitiesV3(topic, memo, learningCorpus, wikiResults) {
  const entities = [];
  const seen = new Set();
  const TEAM_RE = /\b(fc|cf|sc|united|city|athletic|real|chelsea|arsenal|liverpool|barcelona|madrid|juventus|national|inter|ac milan|as roma|psv|ajax|dortmund)\b/i;
  const STOP = new Set(['Reddit','World','Cup','League','Premier','Serie','Bundesliga','Ligue','English','Spanish','Italian','French','German','European','Champion','Europa','Super','Final','Season','Soccer','Football','Players',
    'MVP','VAR','SNS','TV','BBC','ESPN','Sky','God','His','Her','The','This','That','News','Also','After','Before','More','Most','All','Last','Injured','Official','Report','Reports']);
  const jpText = `${topic || ''} ${memo || ''}`;
  function add(type, nameEn) {
    const clean = String(nameEn || '').trim();
    const first = clean.split(/\s+/)[0];
    if (STOP.has(first) || STOP.has(clean)) return;
    const k = clean.toLowerCase();
    if (!k || k.length < 3 || seen.has(k)) return;
    if (/^[A-Z]{2,5}$/.test(first)) return;
    seen.add(k);
    entities.push({ type, nameEn: clean });
  }
  // Japanese katakana/kanji → English (highest priority, covers topic/memo)
  JP_ENTITY_MAP.forEach(([jp, type, en]) => {
    if (jpText.includes(jp)) add(type, en);
  });
  // Wiki entity results (e.g. from pickWikiEntities post-research)
  (wikiResults || []).forEach(w => {
    const isTeam = TEAM_RE.test(w.entity) || /national football team|fc |cf |sc /i.test(w.entity);
    add(isTeam ? 'team' : 'player', w.entity);
  });
  // Latin proper nouns from article titles / topic / memo
  const allText = [topic, memo, ...(learningCorpus || []).slice(0, 6).map(x => x.title || '')].join(' ');
  const propNouns = allText.match(/[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-Þà-öø-þ'.-]{1,}(?:\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-Þà-öø-þ'.-]{1,}){0,2}/g) || [];
  propNouns.forEach(name => {
    if (name.length < 3 || STOP.has(name.split(' ')[0])) return;
    add(TEAM_RE.test(name) ? 'team' : 'player', name);
  });
  return entities.slice(0, 6);
}

function _parseLabelsToSlots(labels, type) {
  const result = [];
  for (const lbl of labels) {
    let m;
    if (type === 'player') {
      if ((m = lbl.match(/^G(\d+)$/)))        { result.push({ label: 'ゴール',   value: m[1] }); continue; }
      if ((m = lbl.match(/^A(\d+)$/)))        { result.push({ label: 'アシスト', value: m[1] }); continue; }
      if ((m = lbl.match(/^評(\d+\.?\d*)$/))) { result.push({ label: '評価',     value: m[1] }); continue; }
      if ((m = lbl.match(/^出(\d+)$/)))       { result.push({ label: '出場',     value: m[1] }); continue; }
      if ((m = lbl.match(/^@(.+)$/)))         { result.push({ label: 'クラブ',   value: m[1] }); continue; }
      if ((m = lbl.match(/^(\d+)歳$/)))       { result.push({ label: '年齢',     value: lbl  }); continue; }
      if ((m = lbl.match(/^\$(.+)$/)))        { result.push({ label: '評価額',   value: m[1] }); continue; }
      if (/^負傷/.test(lbl)) {
        const inner = lbl.replace(/^負傷(中|歴)[:：]?/, '')
          .replace(/\((\d{4})-(\d{2})-(\d{2})迄\)/, (_, _y, mo, d) => `${parseInt(mo)}/${d}迄`);
        result.push({ label: '状態', value: inner || lbl }); continue;
      }
    } else {
      if ((m = lbl.match(/^(\d+)位$/))) { result.push({ label: '順位', value: lbl  }); continue; }
      if ((m = lbl.match(/^(\d+)W$/))) { result.push({ label: '勝',   value: m[1] }); continue; }
      if ((m = lbl.match(/^(\d+)D$/))) { result.push({ label: '分',   value: m[1] }); continue; }
      if ((m = lbl.match(/^(\d+)L$/))) { result.push({ label: '負',   value: m[1] }); continue; }
      if ((m = lbl.match(/^得(\d+)$/)))  { result.push({ label: '得点', value: m[1] }); continue; }
      if ((m = lbl.match(/^失(\d+)$/)))  { result.push({ label: '失点', value: m[1] }); continue; }
      if ((m = lbl.match(/^(\d+)pt$/)))  { result.push({ label: '勝点', value: m[1] }); continue; }
    }
    result.push({ label: lbl, value: '-' });
  }
  return result;
}

function buildDataLabelsV3(prefetched, tmMap = {}) {
  return Object.values(prefetched || {}).map(e => {
    const tm = e.type === 'player' ? (tmMap[e.nameEn.toLowerCase()] || null) : null;
    const sourceTitle = tm ? 'SofaScore + Transfermarkt' : 'SofaScore';
    const fetchedAt = new Date().toISOString();
    const tmLabels = [];
    if (tm?.injuries?.length) {
      const ongoing = tm.injuries.find(i => i.isOngoing);
      if (ongoing) tmLabels.push('負傷中:' + (ongoing.injury || '不明') + (ongoing.untilDate ? '(' + ongoing.untilDate + '迄)' : ''));
      else tmLabels.push('負傷歴' + tm.injuries.length + '件');
    }
    if (!e.data) {
      if (tmLabels.length) {
        const slots = _parseLabelsToSlots(tmLabels, e.type);
        return { type: e.type, nameEn: e.nameEn, ok: true, summary: tmLabels.join(' / '), labels: tmLabels, slots, sourceTitle: 'Transfermarkt', sourceUrl: '', fetchedAt, confidence: 'medium' };
      }
      return { type: e.type, nameEn: e.nameEn, ok: false, summary: '取得失敗', labels: [], slots: [], sourceTitle, sourceUrl: '', fetchedAt, confidence: 'none' };
    }
    const labels = [];
    if (e.type === 'player') {
      const ss = e.data.seasonStats || {};
      if (ss.goals != null)        labels.push('G' + ss.goals);
      if (ss.assists != null)      labels.push('A' + ss.assists);
      if (ss.rating != null)       labels.push('評' + ss.rating);
      if (ss.appearances != null)  labels.push('出' + ss.appearances);
      if (e.data.team)             labels.push('@' + e.data.team);
      if (e.data.age)              labels.push(e.data.age + '歳');
      if (e.data.marketValue)      labels.push('$' + e.data.marketValue);
      labels.push(...tmLabels);
    } else {
      const st = e.data.standing || {};
      if (st.position != null)     labels.push(st.position + '位');
      if (st.wins != null)         labels.push(st.wins + 'W');
      if (st.draws != null)        labels.push(st.draws + 'D');
      if (st.losses != null)       labels.push(st.losses + 'L');
      if (st.points != null)       labels.push(st.points + 'pt');
      if (st.goalsFor != null)     labels.push('得' + st.goalsFor);
      if (st.goalsAgainst != null) labels.push('失' + st.goalsAgainst);
    }
    const slots = _parseLabelsToSlots(labels, e.type);
    return { type: e.type, nameEn: e.nameEn, ok: true, summary: labels.join(' / ') || '取得OK', labels, slots, sourceTitle, sourceUrl: '', fetchedAt, confidence: slots.length ? 'medium' : 'low' };
  });
}

async function runAutoPrefetchCore({ topic = '', memo = '', learningCorpus = [], wikiResults = [], aiEntities = [] } = {}) {
  const { prefetchEntities } = require(path.join(__dirname, '..', 'scripts', 'modules', 'fetchers', 'entity_prefetcher'));
  const { searchTransfermarktPlayer } = require(path.join(__dirname, '..', 'scripts', 'modules', 'fetchers', 'transfermarkt_player_games'));
  const { fetchPlayerInjuries } = require(path.join(__dirname, '..', 'scripts', 'modules', 'fetchers', 'transfermarkt_player_injuries'));

  const normalizeEntityName = (e) => {
    let name = String(e.nameEn || '').trim();
    name = name.replace(/\s+national(?:\s+football)?\s+team$/i, '').trim();
    return { type: e.type || 'player', nameEn: name };
  };
  const isUsefulEntity = (e) => {
    const name = String(e.nameEn || '').trim();
    if (!name || name.length < 3) return false;
    if (e.dataNeeded === false) return false;
    if (/^(last|injured|official|report|reports|news|god|sns|mvp|var|tv)$/i.test(name)) return false;
    if (/^(jesus|wikipedia|reddit)$/i.test(name)) return false;
    if (/\b(everything|gets|analyzed|turned|into|drama|these|days|reminded|some|idiot|asked|posted|anything|basically|said|goodbye)\b/i.test(name)) return false;
    if (/^[A-Z]{2,5}$/.test(name)) return false;
    return true;
  };
  const aiMapped = (Array.isArray(aiEntities) ? aiEntities : [])
    .filter((e) => e && e.nameEn)
    .map(normalizeEntityName)
    .filter(isUsefulEntity);
  const regexExtracted = extractEntitiesV3(topic, memo, learningCorpus, wikiResults);
  const seen = new Set(aiMapped.map((e) => e.nameEn.toLowerCase()));
  const merged = [...aiMapped, ...regexExtracted.filter((e) => !seen.has(e.nameEn.toLowerCase()))];
  const entities = merged
    .filter((e) => ['player', 'team', 'manager', 'entity'].includes(e.type))
    .slice(0, 6);
  if (!entities.length) return { success: true, entities: [], labels: [], note: 'no entities found' };

  const [prefetchResult, tmResult] = await Promise.allSettled([
    prefetchEntities(entities),
    (async () => {
      const map = {};
      await Promise.all(entities.filter(e => e.type === 'player').map(async e => {
        try {
          const hit = await searchTransfermarktPlayer(e.nameEn);
          if (!hit) return;
          const result = await fetchPlayerInjuries(hit.id, hit.slug);
          if (result.ok) map[e.nameEn.toLowerCase()] = result;
        } catch (_) {}
      }));
      return map;
    })(),
  ]);
  const prefetched = prefetchResult.status === 'fulfilled' ? prefetchResult.value : {};
  const tmMap = tmResult.status === 'fulfilled' ? tmResult.value : {};
  const warnings = [];
  if (prefetchResult.status === 'rejected') warnings.push('SofaScore: ' + prefetchResult.reason.message);
  if (tmResult.status === 'rejected') warnings.push('Transfermarkt: ' + tmResult.reason.message);
  return { success: true, entities, labels: buildDataLabelsV3(prefetched, tmMap), warnings };
}

app.post('/api/v3/auto-prefetch', async (req, res) => {
  try {
    res.json(await runAutoPrefetchCore(req.body || {}));
  } catch (error) {
    console.error('[v3/auto-prefetch]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v3/generate-script', async (req, res) => {
  try {
    const { topic, aiBriefing, slideOutline, fetchedData, researchSnippets, wikiSnippets, publishGates, factCheckFlags } = req.body || {};
    if (!topic) return res.status(400).json({ success: false, error: 'topic is required' });

    const slideCount = (slideOutline || []).length || 6;

    // スライド構成リスト
    const slideList = (slideOutline || []).slice(0, 12).map((item, i) => {
      const needs = (item.dataNeeds || []).join('、') || 'なし';
      const selected = (item.selectedData || [])
        .filter((d) => d.value || d.sourceUrl)
        .map((d) => `${d.label || 'data'}: ${d.value || d.sourceUrl}`)
        .join(' / ');
      return `${item.no || i + 1}. [${item.slideType || 'insight'}] ${item.headline || ''} — ${item.point || ''} (必要データ: ${needs}${selected ? ` / 割当済み: ${selected}` : ''})`;
    }).join('\n');

    const perSlideDataBlock = (slideOutline || []).slice(0, 12).map((item, i) => {
      const data = (item.selectedData || [])
        .filter((d) => d.value || d.sourceUrl)
        .map((d) => `- ${d.label || 'data'}: ${d.value || d.sourceUrl}${d.sourceTitle ? ` (${d.sourceTitle})` : ''}`)
        .join('\n');
      return `Slide ${item.no || i + 1}: ${item.headline || ''}\n${data || '- 割当済みデータなし'}`;
    }).join('\n\n');

    // SofaScore/TM 数値データ（具体的なスロット値まで展開）
    const dataBlock = (fetchedData || []).filter((d) => d.ok).slice(0, 6).map((d) => {
      const slots = (d.slots || []).filter((s) => s.value).map((s) => `${s.label}: ${s.value}`).join(' / ');
      return `${d.nameEn}(${d.type}): ${slots || d.summary || ''}`;
    }).join('\n') || 'なし';

    // 断定禁止・要確認リスト
    const warningLines = [
      ...((publishGates || []).slice(0, 5)),
      ...((factCheckFlags || []).slice(0, 3).map((f) => `[要確認 ${f.source || ''}] ${f.issue || ''}`)),
    ];
    const warningBlock = warningLines.length ? warningLines.join('\n') : 'なし';

    const systemPrompt = `あなたはサッカーYouTube動画の脚本ライターです。
調査記事・取得データ・企画書の内容を最大限に活かして、各スライドのナレーション本文を生成してください。
出力は純粋なJSONのみ。コードブロック不要。

【絶対ルール】
- narrationは各スライド250〜350文字（目安30〜50秒。openingは200字以上のフック文、endingは200字以上のまとめ）
- 口語・話し言葉（「です・ます」調）
- 取得済みデータの数値（ゴール数・試合数・順位等）を必ず使う
- スライド構成の「割当済み」データを、その同じスライドのナレーションへ必ず入れる
- 割当済みデータがあるスライドでは、最低1つの具体値を本文に入れる
- 割当済みデータがないスライドでは、取得済みデータ一覧から無関係な数字を混ぜない
- 企画書のheadline/pointから外れた別テーマの脚本にしない
- history/context/timeline系スライドは過去の経緯・背景・年表を語る。今季スタッツを箇条書きで並べない
- stats/profile/comparison/ranking/matchcard系スライドだけ、数値データを主役にする
- 調査記事の具体的な情報（発言・経緯・背景）を積極的に引用
- 断定禁止リストの内容は断定せず「〜とも言われています」「〜の可能性があります」表現にする
- 推測・未確認情報を断定しない`;

    const userPrompt = `## トピック
${topic}

## 動画の約束・核心メッセージ
${aiBriefing?.purpose || 'なし'}
${aiBriefing?.coreMessage ? '結論: ' + aiBriefing.coreMessage : ''}
${aiBriefing?.rawText ? '\n## 企画書本文（この内容を最優先で反映）\n' + String(aiBriefing.rawText).slice(0, 6000) : ''}
${aiBriefing?.scriptInstructions ? '\n## 脚本指示\n' + aiBriefing.scriptInstructions : ''}

## スライド構成（${slideCount}枚）
${slideList}

## スライド別の割当済みデータ（同じSlide番号のnarration内で使う）
${perSlideDataBlock}

## 取得済みデータ（SofaScore / Transfermarkt — 数値は積極的に使う）
${dataBlock}

## 調査記事（事実の根拠として使う）
${researchSnippets || 'なし'}

## Wikiデータ（背景・経歴・小話）
${wikiSnippets || 'なし'}

## 断定禁止・要確認事項
${warningBlock}

## 出力JSON
{"slides": [{"slideNo": 1, "narration": "ナレーション本文"}]}`;

    const raw = await callAI({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 4000,
      forceProvider: 'deepseek',
    });

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) {
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (_) {}
    }
    if (!parsed?.slides) {
      return res.json({ success: false, error: 'AI応答のJSONパース失敗', raw: String(raw || '').slice(0, 300) });
    }
    const { slides: checkedSlides, flags: scriptFlags } = await factCheckScript(parsed.slides).catch(() => ({ slides: parsed.slides, flags: [] }));
    res.json({ success: true, slides: checkedSlides, factCheckFlags: scriptFlags });
  } catch (error) {
    console.error('[v3/generate-script]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── /api/v3/boost-image-score : 宝箱ドロップ → 最高スコア+1 ──────────────
app.post('/api/v3/boost-image-score', (req, res) => {
  try {
    const { imageUrl } = req.body || {};
    if (!imageUrl) return res.status(400).json({ ok: false, error: 'imageUrl が必要です' });

    const { recordImageUsage } = require(path.join(__dirname, '..', 'scripts', 'image_score_manager'));

    // 対象ファイルの score.json を読んで現在の最高スコアを取得
    const stockRoot = path.join(__dirname, '..', 'images_stock', 'players_official');
    const m = String(imageUrl).replace(/\\/g, '/').match(/players_official\/([^/]+)\/([^/]+\.(jpg|png))$/i);
    if (!m) return res.status(400).json({ ok: false, error: 'ストック画像のURLではありません' });

    const playerSlug = m[1];
    const filename   = m[2];
    const clubDir    = path.join(stockRoot, playerSlug);   // 選手フォルダ
    const scorePath  = path.join(clubDir, 'score.json');

    let scores = {};
    try { scores = JSON.parse(fs.readFileSync(scorePath, 'utf8')); } catch (_) {}

    const maxScore = Object.values(scores).reduce((mx, v) => Math.max(mx, v.score || 0), 0);
    const newScore = maxScore + 1;

    if (!scores[filename]) {
      scores[filename] = { score: newScore, addedAt: new Date().toISOString().slice(0, 10), lastUsed: null };
    } else {
      scores[filename].score    = newScore;
      scores[filename].lastUsed = new Date().toISOString().slice(0, 10);
    }
    fs.writeFileSync(scorePath, JSON.stringify(scores, null, 2));
    console.log(`[boost] ${playerSlug}/${filename} → ${newScore}点（max+1）`);
    res.json({ ok: true, newScore, filename, player: playerSlug });
  } catch (e) {
    console.error('[boost-image-score]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/v3/images/stock', (req, res) => {
  try {
    const { findStockMatches } = require(path.join(__dirname, '..', 'scripts', 'modules', 'stock_match'));
    const q    = String(req.query.q    || '').trim();
    const type = String(req.query.type || 'player').toLowerCase();
    if (!q) return res.json({ ok: true, images: [] });
    const matches = findStockMatches({ type, entity: q, teamName: q });
    res.json({ ok: true, images: matches.slice(0, 24).map((m) => ({ url: m.url, role: m.role, name: m.name, score: m.score })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, images: [] });
  }
});

// ─── /api/v3/generate-narration : V3ナレーション生成 + 画像自動解決 ──────
// generateNarration (v3_planner) を呼び、imageInstruction → images[] を解決して返す。
// export-v2 なしに V3 内部で完結するナレーション生成エンドポイント。
app.post('/api/v3/generate-narration', async (req, res) => {
  try {
    const { topic, v3Modules, enrichedMemo, fetchedData, provider = 'deepseek' } = req.body || {};
    if (!topic || !Array.isArray(v3Modules) || !v3Modules.length) {
      return res.status(400).json({ ok: false, error: 'topic と v3Modules が必要です' });
    }
    // v3Modules → generateNarration 用のスライド形式に変換
    const scriptSlides = v3Modules.map((m, i) => ({
      no: i + 1,
      slideType: m.type || 'insight',
      headline: m.title || ('Slide ' + (i + 1)),
      keyPoints: (m.dataSlots || []).map((s) => s.label).filter(Boolean),
      dataNeeds: (m.dataSlots || []).filter((s) => s.value).map((s) => `${s.label}: ${s.value}`),
      estimatedSec: 45,
    }));
    const result = await generateNarration(topic, scriptSlides, enrichedMemo, fetchedData, { provider });
    if (!result.ok) return res.json({ ok: false, error: result.error });

    // imageInstruction → images[] 解決（v3_image_fetcher: ストック→Wikimedia多ソース）
    let slides;
    try {
      const { fetchAndAssignSlideImages } = require('./v3_image_fetcher');
      slides = await fetchAndAssignSlideImages(result.slides || []);
    } catch (e) {
      console.warn('[v3/generate-narration] image fetch error:', e.message);
      slides = (result.slides || []).map(s => ({ ...s, images: [], imageCandidates: [] }));
    }
    // ナレーション内容のファクトチェック（フラグのみ、修正なし）
    const { slides: checked, flags } = await factCheckScript(slides).catch(() => ({ slides, flags: [] }));
    res.json({ ok: true, slides: checked, factCheckFlags: flags });
  } catch (e) {
    console.error('[v3/generate-narration]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── /api/v3/fetch-slide-images : スライド画像のみリフレッシュ ──────────────
// ナレーション再生成なしに、imageInstruction からの画像取得だけを再実行する。
// slides[].imageCandidates も返すので UI の候補ギャラリーに使える。
app.post('/api/v3/fetch-slide-images', async (req, res) => {
  try {
    const { slides } = req.body || {};
    if (!Array.isArray(slides) || !slides.length) {
      return res.status(400).json({ ok: false, error: 'slides が必要です' });
    }
    const { fetchAndAssignSlideImages } = require('./v3_image_fetcher');
    const updated = await fetchAndAssignSlideImages(slides);
    res.json({ ok: true, slides: updated });
  } catch (e) {
    console.error('[v3/fetch-slide-images]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── /api/v3/generate-video : V3直接動画生成（export-v2 不要） ──────────
// modules.json を V2 データディレクトリに書き込み render.js を直接起動する。
// V2 の saved_projects には書かない。V3 専用プロジェクトリスト (v3_projects.json) に保存。
app.post('/api/v3/generate-video', (req, res) => {
  try {
    const { modules, topic, memo = '' } = req.body || {};
    if (!Array.isArray(modules) || !modules.length) {
      return res.status(400).json({ ok: false, error: 'modules が必要です' });
    }

    // 使用画像のスコアを加点（ストック管理）
    try {
      const { recordImageUsage } = require(path.join(__dirname, '..', 'scripts', 'image_score_manager'));
      const usedImages = modules.flatMap(m => Array.isArray(m.images) ? m.images : []).filter(Boolean);
      if (usedImages.length) recordImageUsage(usedImages);
    } catch (_) {}

    const postId = 'v3_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    // modules.json を V2 データディレクトリに書き込む（render.js 共通パス）
    if (!fs.existsSync(V2_DATA_DIR)) fs.mkdirSync(V2_DATA_DIR, { recursive: true });
    const modulesFile = path.join(V2_DATA_DIR, `${safeFileId(postId)}_modules.json`);
    fs.writeFileSync(modulesFile, JSON.stringify({ postId, modules, savedAt: now, source: 'v3_launcher' }, null, 2));
    // V3 専用プロジェクトリストに保存
    const V3_PROJECTS_FILE = path.join(__dirname, 'data', 'v3_projects.json');
    let projects = [];
    try { projects = JSON.parse(fs.readFileSync(V3_PROJECTS_FILE, 'utf8')); } catch (_) {}
    if (!Array.isArray(projects)) projects = [];
    projects.push({ postId, topic: String(topic || '').slice(0, 100), memo: String(memo || '').slice(0, 300), createdAt: now, status: 'pending' });
    fs.writeFileSync(V3_PROJECTS_FILE, JSON.stringify(projects, null, 2));
    // render.js をサブプロセスで起動
    if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR, { recursive: true });
    const jobId = 'v3job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const jp = path.join(JOB_DIR, jobId + '.json');
    fs.writeFileSync(jp, JSON.stringify({ jobId, postId, status: 'queued', createdAt: now }, null, 2));
    const renderScript = path.join(__dirname, '..', 'scripts', 'v2_video', 'render.js');
    const logFd = fs.openSync(path.join(JOB_DIR, jobId + '.log'), 'a');
    const proc = spawn('node', [renderScript, postId, jobId], {
      detached: true, stdio: ['ignore', logFd, logFd],
      cwd: path.join(__dirname, '..'),
    });
    proc.unref();
    console.log(`[v3/generate-video] job 起動: ${jobId} (postId: ${postId})`);
    res.json({ ok: true, jobId, postId });
  } catch (e) {
    console.error('[v3/generate-video]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/v3/export-v2', (req, res) => {
  try {
    const {
      plan,
      sourceType = 'custom',
      memo = '',
      postId: existingPostId = '',
      imageSelections = {},
      fetchedData = [],
      acquiredData = null,
      research = null,
      selectedProject = null,
    } = req.body || {};
    if (!plan) return res.status(400).json({ success: false, error: 'plan is required' });

    const postId = existingPostId || makeV2PostId(plan.topic || plan.title);
    const now = new Date().toISOString();
    const modules = buildV2ModulesFromPlan(plan);
    if (!modules.length) return res.status(400).json({ success: false, error: 'scriptDraft or slidePlan is empty' });

    const project = {
      id: postId,
      title: plan.topic || plan.title || 'V3 draft',
      titleOrig: '',
      addedAt: now,
      source: `v3_${sourceType}`,
      score: 0,
      raw: {
        id: postId,
        title: plan.topic || plan.title || 'V3 draft',
        source: `v3_${sourceType}`,
        isCustom: true,
        customNote: String(memo || plan.viewerPromise || '').slice(0, 1000),
        v3: {
          exportedAt: now,
          centralQuestion: plan.centralQuestion || '',
          thesis: plan.thesis || '',
          publishGates: plan.autopilotPlan?.publishGates || [],
        },
        addedAt: now,
      },
    };

    const saved = readJson(V2_SAVED_FILE, []);
    const list = Array.isArray(saved) ? saved : [];
    const existingIdx = list.findIndex((item) => item && item.id === postId);
    if (existingIdx >= 0) list[existingIdx] = { ...list[existingIdx], ...project, updatedAt: now };
    else list.push(project);
    fs.writeFileSync(V2_SAVED_FILE, JSON.stringify(list, null, 2));

    const modulesFile = path.join(V2_DATA_DIR, `${safeFileId(postId)}_modules.json`);
    fs.writeFileSync(modulesFile, JSON.stringify({ postId, modules, savedAt: now, source: 'v3_launcher' }, null, 2));

    const siFile = path.join(V2_SI_DIR, `${safeFileId(postId)}.json`);
    const siPayload = buildV3SiForV2Editor({ postId, plan, fetchedData, acquiredData, research, selectedProject });
    fs.writeFileSync(siFile, JSON.stringify(siPayload, null, 2));

    const imageSelection = writeV3ImageSelectionsForV2Editor(postId, imageSelections, modules);

    res.json({
      success: true,
      postId,
      project,
      modulesFile,
      siFile,
      imageSelection,
      moduleCount: modules.length,
      editorUrl: `/v3-editor?postId=${encodeURIComponent(postId)}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/v3/argument-plans', (_, res) => {
  const items = fs.readdirSync(DATA_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 50)
    .map((name) => {
      const filePath = path.join(DATA_DIR, name);
      try {
        const plan = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
          id: name.replace(/\.json$/, ''),
          file: name,
          topic: plan.topic,
          centralQuestion: plan.centralQuestion,
          thesis: plan.thesis,
          createdAt: plan.createdAt,
        };
      } catch (_) {
        return { id: name, file: name, topic: 'parse error' };
      }
    });
  res.json({ items });
});

app.get('/v3-editor', (req, res) => {
  const postId = String(req.query.postId || '').trim();
  const embedded = String(req.query.embedded || '') === '1';
  if (!postId) return res.status(400).send('postId required');
  const saved = readJson(V2_SAVED_FILE, []);
  const project = (Array.isArray(saved) ? saved : []).find((item) => item && item.id === postId) || {
    id: postId,
    title: 'V3 draft',
    source: 'v3_editor',
    raw: { id: postId, title: 'V3 draft', source: 'v3_editor' },
  };
  const projectJson = JSON.stringify(project).replace(/</g, '\\u003c');
  res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V3 + V2編集 - ${escHtml(project.title || project.id)}</title>
<style>
:root {
  --c:#f2b84b; --bg:#0b0d12; --panel:#151922; --border:#303846;
  --text:#eef2f7; --muted:#94a3b8; --success:#10b981;
}
*, *::before, *::after { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:"Yu Gothic","Noto Sans JP",system-ui,sans-serif; }
.v3-editor-header { position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 14px; background:#111827; border-bottom:3px solid var(--c); }
.v3-editor-header h1 { margin:0; color:var(--c); font-size:16px; font-weight:900; }
.v3-editor-header span { color:var(--muted); font-size:12px; }
.v3-editor-header a, .v3-editor-header button { min-height:32px; padding:6px 10px; border-radius:6px; border:1px solid #7c5c22; background:#201804; color:var(--c); font-weight:900; text-decoration:none; cursor:pointer; }
.step-container { padding:12px 14px; }
.panel { background:var(--panel); border-radius:8px; padding:14px; margin-bottom:14px; border:1px solid var(--border); }
.btn { padding:8px 14px; border-radius:7px; cursor:pointer; border:none; font-weight:bold; font-size:12px; transition:opacity .15s; }
.btn:hover { opacity:.86; }
.btn-primary { background:var(--c); color:#111827; }
.btn-success { background:var(--success); color:#fff; }
.btn-sm { background:#1e2a4a; color:var(--text); font-size:11px; padding:5px 10px; }
.inp, input, textarea, select { background:#0d1220; color:var(--text); border:1px solid var(--border); border-radius:6px; }
textarea { width:100%; }
.v3-hidden-editor-control { display:none !important; }
body.embedded-v3-editor .v3-editor-header { display:none; }
body.embedded-v3-editor .step-container { padding:8px; }
body.embedded-v3-editor .s3-tab { min-height:54px !important; padding-top:8px !important; padding-bottom:8px !important; }
body.embedded-v3-editor [style*="max-height:340px"] { max-height:none !important; }
pre { background:#0d1220; padding:12px; border-radius:8px; font-size:11px; overflow-x:auto; color:#9bb5e0; white-space:pre-wrap; border:1px solid #1a2540; word-break:break-all; }
a { color:#7dc8ff; }
@media (max-width: 900px) {
  [style*="grid-template-columns:1fr 1fr"] { grid-template-columns:1fr !important; }
  .step-container { padding:8px; }
}
</style>
</head>
<body class="${embedded ? 'embedded-v3-editor' : ''}">
<div class="v3-editor-header">
  <h1>V3資産 + V2編集モード</h1>
  <span>${escHtml(project.title || project.id)} / ${escHtml(postId)}</span>
  <a href="/">V3へ戻る</a>
  <button type="button" onclick="window.step4Init && window.step4Init()">再読込</button>
</div>
${s4UI()}
<script>
window.APP = window.APP || {};
window.APP.selected = ${projectJson};
window.APP.saved = [window.APP.selected];
window.fetchJson = window.fetchJson || async function(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
};
function hideV3EditorBlock(el, styleNeedle) {
  if (!el) return;
  var block = el;
  for (var i = 0; block && i < 8; i += 1, block = block.parentElement) {
    var style = block.getAttribute && (block.getAttribute('style') || '');
    if (styleNeedle && style.indexOf(styleNeedle) >= 0) {
      block.classList.add('v3-hidden-editor-control');
      return;
    }
  }
}
function trimV3EditorControls() {
  document.querySelectorAll('.s4-fill-prompt,.s4-fill-research-prompt,.s4-fill-go,.s4-fill-status,.s4-fill-incremental,.s4-fill-webresearch').forEach(function(el) {
    hideV3EditorBlock(el, 'border:1px solid #6366f1');
  });
  document.querySelectorAll('.s4-tts-status,[onclick^="s4Tts"],[onclick*="s4Tts"]').forEach(function(el) {
    hideV3EditorBlock(el, 'border:1px solid #4c1d95');
  });
  document.querySelectorAll('.s4-tts-play-chunk').forEach(function(el) {
    el.classList.add('v3-hidden-editor-control');
  });
}
var v3BindOpenSignature = '';
function expandV3BindData() {
  var s4 = window.APP && window.APP.s4;
  if (!s4 || !s4.recipeSlotsByIdx) return;
  var signature = JSON.stringify(Object.keys(s4.recipeSlotsByIdx).map(function(idx) {
    var data = s4.recipeSlotsByIdx[idx] || {};
    return [idx, (data.categories || []).map(function(cat) { return cat.name; }).join('|')].join(':');
  }));
  var changed = false;
  Object.keys(s4.recipeSlotsByIdx).forEach(function(idx) {
    var data = s4.recipeSlotsByIdx[idx] || {};
    if (!Array.isArray(data.categories) || !data.categories.length) return;
    var map = s4.openCategoriesByIdx[idx] || {};
    data.categories.forEach(function(cat) {
      if (cat && cat.name && map[cat.name] !== true) {
        map[cat.name] = true;
        changed = true;
      }
    });
    s4.openCategoriesByIdx[idx] = map;
  });
  document.querySelectorAll('[style*="max-height:340px"]').forEach(function(el) {
    el.style.maxHeight = 'none';
  });
  if (changed && signature !== v3BindOpenSignature && typeof window.s4Switch === 'function') {
    v3BindOpenSignature = signature;
    window.s4Switch(s4.activeTab || 0);
  } else {
    v3BindOpenSignature = signature;
  }
}
function polishV3EmbeddedEditor() {
  trimV3EditorControls();
  expandV3BindData();
}
document.addEventListener('DOMContentLoaded', function() {
  var step = document.getElementById('step4');
  if (step) step.style.display = 'block';
  if (window.step4Init) window.step4Init();
  polishV3EmbeddedEditor();
  setTimeout(polishV3EmbeddedEditor, 250);
  setTimeout(polishV3EmbeddedEditor, 800);
  setTimeout(polishV3EmbeddedEditor, 1600);
  var root = document.getElementById('step4') || document.body;
  new MutationObserver(polishV3EmbeddedEditor).observe(root, { childList:true, subtree:true });
});
</script>
</body>
</html>`);
});

app.get('/case-fetch', (_, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V3 案件取得</title>
<style>
body { margin:0; background:#0b0d12; color:#eef2f7; font-family:"Yu Gothic","Noto Sans JP",sans-serif; }
header { padding:14px 16px; border-bottom:4px solid #f2b84b; background:#111827; }
h1 { margin:0; color:#f2b84b; font-size:18px; }
.badge { display:inline-block; margin-top:6px; padding:3px 8px; background:#f2b84b; color:#111827; border-radius:999px; font-size:11px; font-weight:900; }
main { padding:12px; }
.panel { border:1px solid #303846; background:#151922; border-radius:8px; padding:12px; margin-bottom:12px; }
.row { display:grid; grid-template-columns:1fr auto; gap:8px; }
input, button { min-height:42px; border-radius:6px; border:1px solid #303846; font:inherit; }
input { background:#0a0d12; color:#eef2f7; padding:0 10px; }
button { background:#f2b84b; color:#111827; font-weight:900; padding:0 12px; }
.item { padding:10px; border:1px solid #303846; border-radius:6px; margin-top:8px; background:#0a0d12; line-height:1.45; }
.item b { color:#f2b84b; }
.muted { color:#94a3b8; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>V3 案件取得</h1>
  <span class="badge">standalone-case-fetch-yellow</span>
</header>
<main>
  <div class="panel">
    <div class="row">
      <input id="date" type="date">
      <button id="loadBtn" type="button">案件取得</button>
    </div>
    <p class="muted">既存V3トップ画面から完全に切り離した確認用ページです。</p>
  </div>
  <div id="list" class="panel">日付を選んで案件取得を押してください。</div>
</main>
<script>
function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
  });
}
document.getElementById('date').value = today();
document.getElementById('loadBtn').addEventListener('click', async function() {
  const box = document.getElementById('list');
  box.textContent = '読込中...';
  try {
    const d = document.getElementById('date').value;
    const res = await fetch('/api/v3/content?date=' + encodeURIComponent(d));
    const data = await res.json();
    const posts = data.posts || [];
    box.innerHTML = '<b>取得 ' + posts.length + '件</b>' + (posts.length ? posts.map(function(p) {
      return '<div class="item"><b>' + esc(p.title) + '</b><div class="muted">' + esc((p.source || '') + ' / score ' + (p.score || 0) + ' / ' + (p.addedAt || '')) + '</div></div>';
    }).join('') : '<p class="muted">この日付の案件はありません。</p>');
  } catch (error) {
    box.innerHTML = '<b>取得失敗</b><p>' + esc(error.message || error) + '</p>';
  }
});
</script>
</body>
</html>`);
});

app.get('/recipes', (_, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V3 Recipe Launcher</title>
<style>
:root {
  --bg: #0b0d12;
  --panel: #151922;
  --panel2: #1d2430;
  --line: #303846;
  --text: #eef2f7;
  --muted: #94a3b8;
  --gold: #f2b84b;
  --blue: #60a5fa;
  --green: #22c55e;
  --red: #ef4444;
}
* { box-sizing: border-box; }
html, body { max-width: 100%; overflow-x: hidden; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif;
}
header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  background: #111827;
  border-bottom: 3px solid var(--gold);
}
h1 { margin: 0; color: var(--gold); font-size: 18px; }
.tag { color: var(--muted); font-size: 12px; line-height: 1.4; }
a { color: var(--gold); font-weight: 800; text-decoration: none; white-space: nowrap; }
main {
  display: grid;
  grid-template-columns: minmax(240px, 34%) minmax(0, 1fr);
  gap: 12px;
  padding: 12px;
}
.panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 12px;
  min-width: 0;
}
.toolbar, .editor-actions, .list-actions, .meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.toolbar { margin-bottom: 10px; }
button {
  min-height: 40px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--gold);
  color: #111827;
  font: inherit;
  font-weight: 900;
  padding: 0 12px;
  cursor: pointer;
}
button.secondary { background: var(--panel2); color: var(--text); }
button.danger { background: #38171c; color: #fecaca; border-color: #7f1d1d; }
button:disabled { opacity: .55; cursor: wait; }
.status {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #0a0d12;
  font-size: 12px;
  line-height: 1.4;
}
.hint {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
}
.saved-list {
  display: grid;
  gap: 8px;
  max-height: calc(100vh - 190px);
  overflow: auto;
  padding-right: 2px;
}
.saved-card {
  width: 100%;
  min-height: 0;
  display: block;
  text-align: left;
  background: #0a0d12;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
}
.saved-card.active {
  border-color: var(--gold);
  box-shadow: 0 0 0 1px rgba(242,184,75,.28) inset;
}
.saved-card strong {
  display: block;
  font-size: 14px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.saved-card small {
  display: block;
  margin-top: 5px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  border: 1px solid #334155;
  border-radius: 999px;
  padding: 2px 8px;
  background: #0f172a;
  color: #dbeafe;
  font-size: 11px;
  font-weight: 800;
}
.category-pills {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.category-pills button {
  width: 100%;
  padding: 0 4px;
  background: #0f172a;
  color: var(--text);
  border-color: #334155;
  font-size: 13px;
}
.category-pills button.active {
  background: var(--gold);
  color: #111827;
  border-color: var(--gold);
}
label {
  display: grid;
  gap: 6px;
  margin-top: 12px;
  color: #dbeafe;
  font-size: 12px;
  font-weight: 900;
}
input, select, textarea {
  width: 100%;
  min-height: 42px;
  border: 1px solid #334155;
  border-radius: 6px;
  background: #0f172a;
  color: var(--text);
  font: inherit;
  font-size: 15px;
  padding: 9px 10px;
}
textarea { min-height: 72px; resize: vertical; line-height: 1.5; }
.slot-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}
.quick-panel {
  margin-top: 12px;
  display: grid;
  gap: 10px;
}
.preset-grid, .metric-chip-grid, .selected-metric-list {
  display: grid;
  gap: 8px;
}
.preset-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.preset-grid button {
  min-height: 38px;
  padding: 0 8px;
  background: #12213a;
  color: #dbeafe;
  border-color: #1d4ed8;
  font-size: 12px;
}
.metric-filter-row {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.metric-filter-row button {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 0 10px;
  background: #0f172a;
  color: var(--text);
  border-color: #334155;
  font-size: 12px;
}
.metric-filter-row button.active {
  background: var(--gold);
  color: #111827;
  border-color: var(--gold);
}
.metric-chip-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  max-height: 260px;
  overflow: auto;
  padding-right: 2px;
}
.metric-chip {
  min-height: 44px;
  padding: 7px 9px;
  background: #0a0d12;
  color: var(--text);
  border-color: #334155;
  text-align: left;
  font-size: 12px;
  line-height: 1.35;
}
.metric-chip.selected {
  border-color: var(--green);
  box-shadow: 0 0 0 1px rgba(34,197,94,.25) inset;
  color: #bbf7d0;
}
.selected-metric-list {
  grid-template-columns: 1fr;
}
.selected-metric {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  border: 1px solid #334155;
  border-radius: 8px;
  background: #0a0d12;
  padding: 7px;
}
.selected-metric b {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.selected-metric small {
  display: block;
  color: var(--muted);
  font-size: 10px;
  margin-top: 2px;
}
.mini-btn {
  min-height: 30px;
  padding: 0 8px;
  font-size: 12px;
  background: #172033;
  color: var(--text);
}
.section-title {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #dbeafe;
  font-size: 12px;
  font-weight: 900;
}
.slot-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px;
  background: #0a0d12;
}
.slot-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 42px;
  border-radius: 6px;
  background: #111827;
  color: var(--gold);
  font-weight: 900;
}
.source {
  display: inline-flex;
  margin-top: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  background: #0b1220;
  color: var(--blue);
  font-size: 10px;
  border: 1px solid #1e3a8a;
}
.editor-empty {
  border: 1px dashed #475569;
  border-radius: 8px;
  padding: 18px;
  color: var(--muted);
  line-height: 1.6;
  background: #0a0d12;
}
.meta-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: end;
}
@media (max-width: 860px) {
  header { align-items: flex-start; flex-direction: column; padding: 12px; }
  main { grid-template-columns: 1fr; padding: 10px; }
  .toolbar, .editor-actions, .list-actions { align-items: stretch; }
  .toolbar button, .toolbar .status, .editor-actions button, .list-actions button { width: 100%; justify-content: center; }
  .saved-list { max-height: 260px; }
  .category-pills { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .meta-row { grid-template-columns: 1fr; }
  .editor-actions {
    position: sticky;
    bottom: 0;
    z-index: 15;
    margin: 0 -12px -12px;
    padding: 8px 12px;
    background: rgba(17,24,39,.96);
    border-top: 1px solid var(--line);
  }
  .preset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric-chip-grid { grid-template-columns: 1fr; max-height: none; }
}
</style>
</head>
<body>
<header>
  <div>
    <h1>V3 Recipe Launcher</h1>
    <div class="tag">保存済みから選んで、スマホで縦に編集するページ</div>
  </div>
  <a href="/">V3本体へ戻る</a>
</header>
<main>
  <section class="panel">
    <div class="toolbar">
      <button type="button" onclick="newRecipe()">新規作成</button>
      <button class="secondary" type="button" onclick="reloadRecipes()">再読み込み</button>
      <span class="status" id="status">読み込み中...</span>
    </div>
    <p class="hint">保存済み一覧。選ぶと右/下の編集フォームに開くよ。</p>
    <div class="saved-list" id="recipeList"></div>
  </section>
  <section class="panel">
    <div class="editor-actions">
      <button id="saveBtn" type="button" onclick="saveRecipes()">送信して保存</button>
      <button class="secondary" type="button" onclick="duplicateRecipe()">複製</button>
      <button class="danger" type="button" onclick="deleteActiveRecipe()">削除</button>
    </div>
    <div id="editor"></div>
  </section>
</main>
<script>
var slotOptions = [];
var recipes = [];
var activeIndex = -1;
var categories = ['選手', 'チーム', '監督', '試合', '移籍'];
var slideTypes = ['opening', 'stats', 'profile', 'comparison', 'history', 'timeline', 'ranking', 'reaction', 'matchcard', 'picture', 'insight', 'ending'];
var priorities = ['高', '中', '低'];
var statuses = ['採用', '採用候補', '要修正', '保留', '削除候補'];
var metricFilter = 'all';
var metricFilters = [
  { key: 'all', label: '全部' },
  { key: 'player', label: '選手' },
  { key: 'attack', label: '攻撃' },
  { key: 'creation', label: '創造' },
  { key: 'defense', label: '守備' },
  { key: 'team', label: 'チーム' },
  { key: 'match', label: '試合' },
  { key: 'market', label: '市場/契約' },
  { key: 'wiki', label: 'Wiki' }
];
var metricPresets = [
  { label: '今季基本', category: '選手', slideType: 'stats', slots: ['sofascore.player.apps','sofascore.player.rating','sofascore.player.goals','sofascore.player.assists'] },
  { label: 'FW/得点型', category: '選手', slideType: 'stats', slots: ['sofascore.player.apps','sofascore.player.goals','sofascore.player.assists','sofascore.player.totalShots','sofascore.player.shotsOnTarget','sofascore.player.xG','sofascore.player.rating'] },
  { label: 'MF/創造型', category: '選手', slideType: 'stats', slots: ['sofascore.player.apps','sofascore.player.assists','sofascore.player.chancesCreated','sofascore.player.bigChancesCreated','sofascore.player.keyPasses','sofascore.player.passAcc','sofascore.player.rating'] },
  { label: 'WG/突破型', category: '選手', slideType: 'stats', slots: ['sofascore.player.apps','sofascore.player.successfulDribbles','sofascore.player.chancesCreated','sofascore.player.goals','sofascore.player.assists','sofascore.player.rating'] },
  { label: 'DF/守備型', category: '選手', slideType: 'stats', slots: ['sofascore.player.apps','sofascore.player.tackles','sofascore.player.interceptions','sofascore.player.clearances','sofascore.player.duelsWon','sofascore.player.passAcc','sofascore.player.rating'] },
  { label: 'GK型', category: '選手', slideType: 'stats', slots: ['sofascore.player.apps','sofascore.player.saves','sofascore.player.cleanSheets','sofascore.player.rating','sofascore.player.minutes'] },
  { label: 'プロフィール', category: '選手', slideType: 'profile', slots: ['wiki.person.age','wiki.person.nationality','transfermarkt.player.club','transfermarkt.player.position','transfermarkt.player.marketValue','transfermarkt.player.contractUntil'] },
  { label: 'チーム今季', category: 'チーム', slideType: 'stats', slots: ['sofascore.team.position','sofascore.team.points','sofascore.team.wins','sofascore.team.draws','sofascore.team.losses','sofascore.team.goalsFor','sofascore.team.goalsAgainst'] },
  { label: '試合カード', category: '試合', slideType: 'matchcard', slots: ['sofascore.match.homeTeam','sofascore.match.awayTeam','sofascore.match.score','sofascore.match.date','sofascore.match.venue'] },
  { label: '移籍/価値', category: '移籍', slideType: 'comparison', slots: ['transfermarkt.transfer.fee','transfermarkt.player.marketValue','transfermarkt.player.marketValuePeak','transfermarkt.player.marketValueChange','transfermarkt.player.contractUntil','transfermarkt.player.position'] }
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function setStatus(text, ok) {
  var el = document.getElementById('status');
  el.textContent = text;
  el.style.color = ok === false ? '#fecaca' : (ok === true ? '#bbf7d0' : '#94a3b8');
}
function optionHtml(items, selected) {
  return items.map(function(item) {
    return '<option value="' + esc(item) + '"' + (item === selected ? ' selected' : '') + '>' + esc(item) + '</option>';
  }).join('');
}
function slotOptionHtml(selected) {
  return slotOptions.map(function(item) {
    var value = item.key || '';
    return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(item.label || value || '未設定') + '</option>';
  }).join('');
}
function slotSource(key) {
  var hit = slotOptions.find(function(item) { return item.key === key; });
  return hit && hit.source ? hit.source : '';
}
function slotLabel(key) {
  var hit = slotOptions.find(function(item) { return item.key === key; });
  return hit ? (hit.label || hit.key || '未設定') : (key || '未設定');
}
function compactSlotLabel(key) {
  return slotLabel(key).replace(/^SofaScore: /, '').replace(/^Transfermarkt: /, '').replace(/^Wiki: /, '');
}
function metricTags(item) {
  var hay = [item.key, item.label, item.source].join(' ').toLowerCase();
  var tags = ['all'];
  if (/player|選手/.test(hay)) tags.push('player');
  if (/goals|assists|shots|xg|ゴール|アシスト|シュート/.test(hay)) tags.push('attack');
  if (/chances|keypasses|dribbles|passacc|チャンス|キーパス|ドリブル|パス/.test(hay)) tags.push('creation');
  if (/tackles|interceptions|clearances|duels|saves|cleansheets|タックル|インターセプト|クリア|デュエル|セーブ|クリーン/.test(hay)) tags.push('defense');
  if (/team|club|順位|勝点|勝利|引分|敗戦|得点|失点|クラブ/.test(hay)) tags.push('team');
  if (/match|home|away|score|date|venue|試合|ホーム|アウェイ|スコア|会場/.test(hay)) tags.push('match');
  if (/transfermarkt|market|contract|fee|agent|市場|契約|移籍|代理人/.test(hay)) tags.push('market');
  if (/wiki|年齢|国籍|代表|監督|創設|スタジアム/.test(hay)) tags.push('wiki');
  return tags;
}
function normalizeRecipe(recipe) {
  recipe = recipe || {};
  var slots = Array.isArray(recipe.dataSlots) ? recipe.dataSlots : [];
  return {
    category: recipe.category || '選手',
    id: recipe.id || '',
    title: recipe.title || '',
    slideType: recipe.slideType || 'stats',
    dataSlots: Array.from({ length: 8 }, function(_, i) { return slots[i] || ''; }),
    note: recipe.note || '',
    aiLabel: recipe.aiLabel || recipe.note || recipe.title || '',
    useWhen: recipe.useWhen || recipe.note || '',
    claim: recipe.claim || '',
    positionFit: recipe.positionFit || '',
    priority: recipe.priority || '中',
    status: recipe.status || '採用候補'
  };
}
function currentRecipe() {
  if (activeIndex < 0 || !recipes[activeIndex]) return null;
  recipes[activeIndex] = normalizeRecipe(recipes[activeIndex]);
  return recipes[activeIndex];
}
function selectRecipe(index) {
  activeIndex = index;
  renderAll();
}
function renderList() {
  var list = document.getElementById('recipeList');
  if (!recipes.length) {
    list.innerHTML = '<div class="editor-empty">保存済みレシピはまだないよ。新規作成から始めてね。</div>';
    return;
  }
  list.innerHTML = recipes.map(function(recipe, index) {
    var r = normalizeRecipe(recipe);
    var title = r.title || '(無題レシピ)';
    return '<button type="button" class="saved-card' + (index === activeIndex ? ' active' : '') + '" onclick="selectRecipe(' + index + ')">' +
      '<span class="pill">' + esc(r.category) + '</span> <span class="pill">' + esc(r.slideType) + '</span>' +
      '<strong>' + esc(title) + '</strong>' +
      '<small>' + esc(r.aiLabel || r.note || 'AIラベル未設定') + '</small>' +
      '<small>' + esc(r.id || 'ID未設定') + ' / ' + esc(r.status || '') + ' / データ ' + r.dataSlots.filter(Boolean).length + '件</small>' +
      '</button>';
  }).join('');
}
function renderPresetButtons() {
  return '<div class="preset-grid">' + metricPresets.map(function(preset, index) {
    return '<button type="button" onclick="applyPreset(' + index + ')">' + esc(preset.label) + '</button>';
  }).join('') + '</div>';
}
function renderMetricFilters() {
  return '<div class="metric-filter-row">' + metricFilters.map(function(filter) {
    return '<button type="button" class="' + (metricFilter === filter.key ? 'active' : '') + '" onclick="setMetricFilter(\\'' + esc(filter.key) + '\\')">' + esc(filter.label) + '</button>';
  }).join('') + '</div>';
}
function renderMetricChips(recipe) {
  var selected = new Set((recipe.dataSlots || []).filter(Boolean));
  var items = slotOptions
    .filter(function(item) { return item.key; })
    .filter(function(item) { return metricFilter === 'all' || metricTags(item).includes(metricFilter); });
  return '<div class="metric-chip-grid">' + items.map(function(item) {
    var isSelected = selected.has(item.key);
    return '<button type="button" class="metric-chip' + (isSelected ? ' selected' : '') + '" onclick="toggleMetric(\\'' + esc(item.key) + '\\')">' +
      '<b>' + esc(compactSlotLabel(item.key)) + '</b><br><small>' + esc(item.source || '') + '</small>' +
    '</button>';
  }).join('') + '</div>';
}
function renderSelectedMetrics(recipe) {
  var slots = (recipe.dataSlots || []).filter(Boolean);
  if (!slots.length) return '<div class="editor-empty">まだデータ未選択。プリセットか下のチップから選んでね。</div>';
  return '<div class="selected-metric-list">' + slots.map(function(key, index) {
    return '<div class="selected-metric">' +
      '<span class="slot-no" style="width:28px;height:32px;">' + (index + 1) + '</span>' +
      '<div><b>' + esc(compactSlotLabel(key)) + '</b><small>' + esc(key) + '</small></div>' +
      '<div style="display:flex;gap:4px;">' +
        '<button type="button" class="mini-btn" onclick="moveMetric(' + index + ', -1)">↑</button>' +
        '<button type="button" class="mini-btn danger" onclick="removeMetric(' + index + ')">×</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}
function renderEditor() {
  var editor = document.getElementById('editor');
  var r = currentRecipe();
  if (!r) {
    editor.innerHTML = '<div class="editor-empty">保存済み一覧から選ぶか、新規作成を押してね。</div>';
    return;
  }
  var categoryButtons = categories.map(function(category) {
    return '<button type="button" class="' + (r.category === category ? 'active' : '') + '" onclick="setCategory(\\'' + esc(category) + '\\')">' + esc(category) + '</button>';
  }).join('');
  var slotRows = r.dataSlots.map(function(slot, i) {
    var source = slotSource(slot);
    return '<div class="slot-row">' +
      '<div class="slot-no">' + (i + 1) + '</div>' +
      '<div><select data-slot="' + i + '" onchange="setSlot(this)">' + slotOptionHtml(slot) + '</select>' +
      (source ? '<span class="source">' + esc(source) + '</span>' : '') + '</div>' +
      '</div>';
  }).join('');
  editor.innerHTML =
    '<label>カテゴリ</label>' +
    '<div class="category-pills">' + categoryButtons + '</div>' +
    '<label>タイトル<input value="' + esc(r.title) + '" oninput="setField(\\'title\\', this.value)" placeholder="例: 今期成績"></label>' +
    '<label>AIラベル<textarea oninput="setField(\\'aiLabel\\', this.value)" placeholder="AIが一瞬でわかる説明。例: 今季の出場・評価・得点関与で、選手の現在地を数字で説明する">' + esc(r.aiLabel) + '</textarea></label>' +
    '<label>使う場面<textarea oninput="setField(\\'useWhen\\', this.value)" placeholder="例: 今季評価、移籍先フィット、代表選考、復活/衰えを語るとき">' + esc(r.useWhen) + '</textarea></label>' +
    '<label>このレシピが述べること<textarea oninput="setField(\\'claim\\', this.value)" placeholder="例: ただの印象ではなく、出場数・平均評価・得点関与で現在の価値を示す">' + esc(r.claim) + '</textarea></label>' +
    '<label>ポジション適性<input value="' + esc(r.positionFit) + '" oninput="setField(\\'positionFit\\', this.value)" placeholder="例: FW/WG/AM向け、CB/SB向け、GK向け"></label>' +
    '<label>スライド型<select onchange="setField(\\'slideType\\', this.value)">' + optionHtml(slideTypes, r.slideType) + '</select></label>' +
    '<div class="section-title"><span>データ選択</span><button type="button" class="secondary mini-btn" onclick="clearMetrics()">クリア</button></div>' +
    '<div class="quick-panel">' +
      '<div><label style="margin-top:0;">プリセット</label>' + renderPresetButtons() + '</div>' +
      '<div><label>選択済みデータ（順番も保存）</label>' + renderSelectedMetrics(r) + '</div>' +
      '<div><label>データ候補</label>' + renderMetricFilters() + renderMetricChips(r) + '</div>' +
    '</div>' +
    '<details style="margin-top:12px;"><summary class="section-title" style="cursor:pointer;">詳細: 8枠プルダウンで微調整</summary>' +
    '<div class="slot-list">' + slotRows + '</div>' +
    '</details>' +
    '<div class="meta-row">' +
      '<label>レシピID<input value="' + esc(r.id) + '" oninput="setField(\\'id\\', this.value)" placeholder="PLAYER_SEASON_CURRENT"></label>' +
      '<label>優先度<select onchange="setField(\\'priority\\', this.value)">' + optionHtml(priorities, r.priority) + '</select></label>' +
      '<label>ステータス<select onchange="setField(\\'status\\', this.value)">' + optionHtml(statuses, r.status) + '</select></label>' +
    '</div>' +
    '<label>用途メモ<textarea oninput="setField(\\'note\\', this.value)" placeholder="このレシピを使う場面">' + esc(r.note) + '</textarea></label>';
}
function renderAll() {
  renderList();
  renderEditor();
}
function setCategory(category) {
  var r = currentRecipe();
  if (!r) return;
  r.category = category;
  renderAll();
}
function setField(field, value) {
  var r = currentRecipe();
  if (!r) return;
  r[field] = value;
  renderList();
}
function setSlot(el) {
  var r = currentRecipe();
  if (!r) return;
  var slotIndex = Number(el.dataset.slot);
  r.dataSlots[slotIndex] = el.value;
  renderEditor();
}
function compactSlots(slots) {
  return Array.from(new Set((slots || []).filter(Boolean))).slice(0, 8);
}
function setMetricFilter(filter) {
  metricFilter = filter || 'all';
  renderEditor();
}
function toggleMetric(key) {
  var r = currentRecipe();
  if (!r || !key) return;
  var slots = compactSlots(r.dataSlots);
  if (slots.includes(key)) {
    slots = slots.filter(function(x) { return x !== key; });
  } else if (slots.length < 8) {
    slots.push(key);
  } else {
    setStatus('データは最大8件まで。不要なものを外してね。', false);
    return;
  }
  r.dataSlots = Array.from({ length: 8 }, function(_, i) { return slots[i] || ''; });
  renderEditor();
}
function removeMetric(index) {
  var r = currentRecipe();
  if (!r) return;
  var slots = compactSlots(r.dataSlots);
  slots.splice(index, 1);
  r.dataSlots = Array.from({ length: 8 }, function(_, i) { return slots[i] || ''; });
  renderEditor();
}
function moveMetric(index, delta) {
  var r = currentRecipe();
  if (!r) return;
  var slots = compactSlots(r.dataSlots);
  var next = index + delta;
  if (next < 0 || next >= slots.length) return;
  var tmp = slots[index];
  slots[index] = slots[next];
  slots[next] = tmp;
  r.dataSlots = Array.from({ length: 8 }, function(_, i) { return slots[i] || ''; });
  renderEditor();
}
function clearMetrics() {
  var r = currentRecipe();
  if (!r) return;
  r.dataSlots = Array(8).fill('');
  renderEditor();
}
function applyPreset(index) {
  var r = currentRecipe();
  var preset = metricPresets[index];
  if (!r || !preset) return;
  r.category = preset.category || r.category;
  r.slideType = preset.slideType || r.slideType;
  r.dataSlots = Array.from({ length: 8 }, function(_, i) { return preset.slots[i] || ''; });
  if (!r.title) r.title = preset.label;
  if (!r.aiLabel) r.aiLabel = preset.label + 'を説明するデータセット';
  if (!r.useWhen) r.useWhen = preset.label + 'を扱うスライドで使う';
  renderAll();
  setStatus('プリセット適用: ' + preset.label, true);
}
function newRecipe() {
  recipes.unshift(normalizeRecipe({
    category: '選手',
    id: '',
    title: '',
    slideType: 'stats',
    dataSlots: Array(8).fill(''),
    aiLabel: '',
    useWhen: '',
    claim: '',
    positionFit: '',
    priority: '中',
    status: '採用候補'
  }));
  activeIndex = 0;
  renderAll();
  setStatus('新規レシピを開いたよ。保存すると保存済みに入るよ', true);
}
function duplicateRecipe() {
  var r = currentRecipe();
  if (!r) return;
  var copy = normalizeRecipe(JSON.parse(JSON.stringify(r)));
  copy.id = copy.id ? copy.id + '_COPY' : '';
  copy.title = copy.title ? copy.title + ' コピー' : '';
  recipes.splice(activeIndex + 1, 0, copy);
  activeIndex += 1;
  renderAll();
  setStatus('複製したよ。保存すると反映されるよ', true);
}
function deleteActiveRecipe() {
  if (activeIndex < 0 || !recipes[activeIndex]) return;
  recipes.splice(activeIndex, 1);
  if (activeIndex >= recipes.length) activeIndex = recipes.length - 1;
  renderAll();
  setStatus('削除したよ。保存すると反映されるよ', null);
}
async function reloadRecipes() {
  setStatus('読み込み中...', null);
  try {
    var slotRes = await fetch('/api/v3/recipe-slot-options');
    var slotData = await slotRes.json();
    slotOptions = slotData.options || [];
    var recipeRes = await fetch('/api/v3/recipes');
    var recipeData = await recipeRes.json();
    recipes = (recipeData.recipes || []).map(normalizeRecipe);
    activeIndex = recipes.length ? 0 : -1;
    renderAll();
    setStatus('読み込み完了: 保存済み ' + recipes.length + '件', true);
  } catch (error) {
    setStatus('読み込み失敗: ' + (error.message || error), false);
  }
}
async function saveRecipes() {
  var btn = document.getElementById('saveBtn');
  btn.disabled = true;
  setStatus('保存中...', null);
  try {
    var payload = { recipes: recipes.map(normalizeRecipe).filter(function(r) { return r.title || r.id; }) };
    var res = await fetch('/api/v3/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload)
    });
    var data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || '保存に失敗した');
    recipes = payload.recipes;
    if (activeIndex >= recipes.length) activeIndex = recipes.length - 1;
    renderAll();
    setStatus('保存完了: ' + data.count + '件 / ' + data.updatedAt, true);
  } catch (error) {
    setStatus('保存失敗: ' + (error.message || error), false);
  } finally {
    btn.disabled = false;
  }
}
reloadRecipes();
</script>
</body>
</html>`);
});

app.get('/', (_, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V3 Story Architect</title>
<style>
:root {
  --bg: #0b0d12;
  --panel: #151922;
  --panel2: #1d2430;
  --line: #303846;
  --text: #eef2f7;
  --muted: #94a3b8;
  --gold: #f2b84b;
  --red: #ef4444;
  --green: #22c55e;
  --blue: #60a5fa;
}
* { box-sizing: border-box; }
html { overflow-x: hidden; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif;
  height: 100vh;
  overflow: hidden;
}
header {
  height: 62px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 22px;
  border-bottom: 3px solid var(--gold);
  background: #111827;
  flex-shrink: 0;
}
h1 { font-size: 18px; margin: 0; color: var(--gold); }
.tag { color: var(--muted); font-size: 12px; }
.version-badge {
  display: inline-flex;
  margin-top: 6px;
  color: #111827;
  background: var(--gold);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 900;
}
main {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  height: calc(100vh - 106px);
  min-height: 0;
  min-width: 0;
}
main.full-workspace {
  grid-template-columns: minmax(0, 1fr);
}
main.full-workspace aside {
  display: none;
}
aside {
  border-right: 1px solid var(--line);
  background: #0d1220;
  padding: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.workspace {
  padding: 0;
  overflow: auto;
  min-width: 0;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
  margin: 0 0 14px;
}
.step-container { padding: 16px 18px; }
.sidebar-head {
  padding: 12px 14px;
  color: var(--gold);
  background: #111827;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: .04em;
}
.sidebar-body {
  flex: 1;
  overflow: auto;
  padding: 10px;
}
.sidebar-footer {
  border-top: 1px solid var(--line);
  padding: 10px;
  background: #0a0d12;
}
.sidebar-footer button {
  width: 100%;
}
.sidebar-hint {
  margin-top: 8px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}
.brief-side-panel,
.case-input-side-panel {
  display: none;
}
.saved-lead-item {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 10px;
  margin-bottom: 7px;
  cursor: pointer;
  font-size: 11px;
  line-height: 1.35;
  word-break: break-word;
}
.saved-lead-item:hover {
  border-color: var(--muted);
}
.saved-lead-item.active {
  border-color: var(--gold);
  border-left: 4px solid var(--gold);
  background: #1b2230;
}
.saved-lead-item b {
  display: block;
  color: var(--text);
  margin-bottom: 5px;
}
.saved-lead-item span {
  display: block;
  color: var(--muted);
}
.label {
  display: block;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  margin-bottom: 8px;
}
input, textarea {
  width: 100%;
  background: #0a0d12;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  font: inherit;
  font-size: 13px;
}
select {
  width: 100%;
  background: #0a0d12;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  font: inherit;
  font-size: 13px;
}
textarea { min-height: 170px; resize: vertical; line-height: 1.55; }
button {
  border: 0;
  border-radius: 6px;
  background: var(--gold);
  color: #111827;
  padding: 10px 12px;
  font-weight: 900;
  cursor: pointer;
  min-width: 0;
  overflow-wrap: anywhere;
}
button.secondary { background: #263142; color: var(--text); border: 1px solid var(--line); }
button:disabled { opacity: .55; cursor: wait; }
.btnrow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.summary h2, .summary p { margin: 0; }
.summary h2 { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.summary p { font-size: 15px; line-height: 1.5; }
.toc {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.toc span {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-left: 4px solid var(--gold);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
}
.human-brief {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.mobile-brief {
  display: none;
}
.mobile-inline-result {
  display: none;
}
.brief-editor {
  display: grid;
  gap: 10px;
}
.brief-editor textarea {
  min-height: 72px;
}
.brief-editor .short {
  min-height: 52px;
}
.brief-card {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
}
.brief-card.wide { grid-column: 1 / -1; }
.brief-card h2 {
  margin: 0 0 8px;
  color: var(--gold);
  font-size: 13px;
}
.brief-card p {
  margin: 0;
  color: #e5e7eb;
  font-size: 15px;
  line-height: 1.55;
}
.view-tabs {
  display: flex;
  gap: 0;
  margin: 0;
  min-width: 0;
  background: #0d1220;
  border-bottom: 1px solid var(--line);
  height: 44px;
  position: relative;
  z-index: 20;
}
.view-tab {
  flex: 1;
  background: transparent;
  color: var(--text);
  border: 0;
  border-right: 1px solid #1e293b;
  border-radius: 0;
  min-height: 44px;
  font-size: 12px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: rgba(242,184,75,.22);
}
.view-tab.active {
  background: var(--panel);
  color: var(--gold);
  border-bottom: 3px solid var(--gold);
}
.view-panel { display: block; }
.custom-case-panel {
  display: none;
  margin-bottom: 10px;
}
.custom-case-panel.open {
  display: block;
}
.custom-case-panel textarea {
  min-height: 96px;
}
.selected-case-box {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-left: 4px solid var(--gold);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 12px;
}
.proposal-hook-text {
  font-size: 15px;
  font-weight: 700;
  color: #facc15;
  margin: 6px 0 4px;
  line-height: 1.45;
}
.proposal-hook-text::before { content: '「'; }
.proposal-hook-text::after  { content: '」'; }
.proposal-divider {
  border: none;
  border-top: 1px solid var(--line);
  margin: 10px 0;
}
.proposal-meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 4px 0 8px;
}
.proposal-meta-grid .label { font-size: 10px; }
.proposal-meta-grid p { margin: 2px 0 0; font-size: 13px; line-height: 1.4; }
@media (max-width: 720px) { .proposal-meta-grid { grid-template-columns: 1fr; } }
.selected-case-box h2 {
  margin: 0 0 8px;
  color: var(--gold);
  font-size: 18px;
}
.selected-case-box pre {
  max-height: 220px;
  margin: 10px 0 0;
}
.research-flow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.research-action-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}
.research-action-inline {
  text-align: center;
  padding: 4px 0 10px;
}
.research-step {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}
.research-heading {
  margin: 10px 0 5px;
  color: var(--gold);
  font-size: 15px;
  font-weight: 900;
}
.evidence-section {
  margin-top: 8px;
}
.evidence-list {
  display: grid;
  gap: 5px;
}
.evidence-item {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 9px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.35;
}
.evidence-item b {
  color: var(--gold);
}
.briefing-paper {
  background: #101827;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 11px;
  margin-top: 8px;
}
.briefing-paper.selected {
  border: 2px solid var(--green);
}
.briefing-paper h2 {
  margin: 0 0 7px;
  color: var(--gold);
  font-size: 16px;
}
.briefing-paper h3 {
  margin: 9px 0 4px;
  color: #dbeafe;
  font-size: 12px;
}
.briefing-paper p,
.briefing-paper li {
  color: var(--text);
  line-height: 1.38;
  font-size: 12px;
  margin-top: 0;
}
.proposal-paper-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.proposal-paper-grid .briefing-paper {
  margin-top: 0;
}
.chapter-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.chapter-seed {
  border-left: 4px solid var(--blue);
  background: #111827;
  padding: 10px;
  border-radius: 6px;
}
.chapter-seed b { color: var(--text); font-size: 13px; }
.chapter-seed span { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.45; }
.argument-boxes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.argument-box {
  background: #0b1220;
  border: 1px solid #334155;
  border-left: 6px solid var(--blue);
  border-radius: 8px;
  padding: 12px;
}
.argument-box .arg-label {
  display: inline-flex;
  align-items: center;
  background: rgba(96, 165, 250, .18);
  color: #bfdbfe;
  border: 1px solid rgba(96, 165, 250, .45);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 900;
  margin-bottom: 8px;
}
.argument-box h3 {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--text);
}
.argument-box p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.beat {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 12px;
  padding: 12px;
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-bottom: 10px;
}
.role {
  color: #111827;
  background: var(--blue);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 900;
  text-transform: uppercase;
}
.beat h3 { margin: 0 0 8px; font-size: 15px; }
.beat p { margin: 0 0 8px; color: #cbd5e1; line-height: 1.5; font-size: 13px; }
.slide-list {
  display: grid;
  gap: 8px;
}
.slide-row {
  display: grid;
  grid-template-columns: 54px 1fr;
  gap: 10px;
  align-items: start;
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
}
.slide-no {
  color: #111827;
  background: var(--gold);
  border-radius: 5px;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 900;
}
.slide-row h3 { margin: 0 0 5px; font-size: 14px; }
.slide-row p { margin: 0 0 7px; color: #cbd5e1; font-size: 12px; line-height: 1.45; }
.slide-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 7px;
}
.meta-pill {
  border: 1px solid var(--line);
  background: #111827;
  color: #dbeafe;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}
.meta-pill.new { color: #fde68a; border-color: rgba(242,184,75,.55); }
.data-reqs {
  display: grid;
  gap: 6px;
}
.data-req {
  border: 1px solid var(--line);
  background: #111827;
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  line-height: 1.45;
}
.data-req b { color: var(--text); }
.data-req span { display: block; color: var(--muted); margin-top: 3px; }
.autopilot-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr);
  gap: 10px;
}
.autopilot-card {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.autopilot-card h2 {
  margin: 0 0 8px;
  color: var(--gold);
  font-size: 13px;
}
.autopilot-card p {
  margin: 0;
  color: #e5e7eb;
  font-size: 12px;
  line-height: 1.35;
}
.script-list {
  display: grid;
  gap: 10px;
}
.script-card {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-left: 5px solid var(--gold);
  border-radius: 8px;
  padding: 12px;
}
.script-card h3 {
  margin: 0 0 7px;
  font-size: 14px;
}
.script-card p {
  margin: 0 0 7px;
  color: #dbeafe;
  font-size: 13px;
  line-height: 1.55;
}
.step5-layout { display: grid; grid-template-columns: 55fr 45fr; gap: 12px; margin-top: 8px; }
.step5-left { display: flex; flex-direction: column; gap: 10px; }
.step5-right { display: flex; flex-direction: column; gap: 10px; }
.step5-left .panel:has(#v3TtsProvider) { display: none; }
.slot-edit-row { display: grid; grid-template-columns: 1fr 1.6fr; gap: 6px; align-items: center; margin-bottom: 5px; }
.slot-edit-label { font-size: 12px; color: var(--muted); padding: 5px 8px; background: #0a0d12; border: 1px solid var(--line); border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gallery-search-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 6px; margin-bottom: 8px; }
.stock-chest { font-size: 18px; cursor: grab; padding: 3px 6px; border-radius: 4px; border: 2px dashed var(--line); transition: border-color .15s, background .15s; user-select: none; }
.stock-chest.drag-over { border-color: var(--gold); background: rgba(212,175,55,.15); }
.stock-img-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(58px, 1fr)); gap: 5px; max-height: 140px; overflow-y: auto; }
.stock-img-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; border: 2px solid transparent; cursor: pointer; background: #0a0d12; }
.stock-img-thumb:hover { border-color: var(--muted); }
.stock-img-thumb.selected { border-color: var(--gold); }
.tts-row { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; margin-top: 8px; }
.video-progress-bar { height: 8px; background: #1d2430; border-radius: 4px; overflow: hidden; margin: 8px 0; }
.video-progress-fill { height: 100%; background: var(--gold); border-radius: 4px; transition: width 0.4s; }
@media (max-width: 720px) { .step5-layout { grid-template-columns: 1fr; } }
.pipeline-steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.workflow-nav {
  display: grid;
  gap: 8px;
}
.workflow-step-btn {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 8px;
  align-items: center;
  width: 100%;
  text-align: left;
  background: #0a0d12;
  color: var(--text);
  border: 1px solid var(--line);
  padding: 9px;
}
.workflow-step-btn.active {
  border-color: var(--gold);
  background: #1b2230;
}
.workflow-step-btn.done .step-no {
  background: var(--green);
}
.step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  background: #263142;
  color: #fff;
  font-size: 12px;
  font-weight: 900;
}
.step-text b {
  display: block;
  font-size: 12px;
}
.step-text span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  margin-top: 2px;
  line-height: 1.3;
}
.task-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.task-status {
  margin-top: 10px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.pipeline-step {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
}
.pipeline-step b {
  display: block;
  color: var(--gold);
  font-size: 12px;
  margin-bottom: 4px;
}
.pipeline-step span {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
}
.flow-list {
  display: grid;
  gap: 5px;
}
.flow-item {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 9px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.flow-item b { color: var(--gold); }
.flow-item p {
  margin: 3px 0 0;
  color: #dbeafe;
  font-size: 12px;
  line-height: 1.35;
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  border: 1px solid var(--line);
  background: #0a0d12;
  color: #cbd5e1;
  border-radius: 999px;
  padding: 3px 7px;
  font-size: 10px;
}
.source-url {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.risk { color: #fecaca; border-color: rgba(239,68,68,.45); }
.research {
  background: #0a0d12;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  font-size: 11px;
  color: #cbd5e1;
  line-height: 1.45;
}
.research b { color: var(--gold); }
.empty {
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 28px;
  text-align: center;
}
pre {
  white-space: pre-wrap;
  background: #07090d;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  overflow: auto;
  font-size: 12px;
  max-height: 420px;
}
.case-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.case-toolbar input[type="date"] {
  width: 170px;
}
.case-toolbar .case-spacer {
  flex: 1;
}
.case-editor-grid {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 10px;
}
.case-editor-grid textarea {
  min-height: 130px;
}
.case-list {
  margin-top: 10px;
  max-height: calc(100vh - 360px);
  min-height: 260px;
  overflow: auto;
}
.case-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 9px 12px;
  cursor: pointer;
  border-bottom: 1px solid #1a2540;
  background: #0a0d12;
  font-size: 13px;
  line-height: 1.4;
}
.case-row:hover { background: #111827; }
.case-row.selected { background: #1b2230; }
.case-row input[type="checkbox"] { flex-shrink: 0; width: auto; height: auto; }
.case-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.time-group {
  margin-bottom: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: #0a0d12;
}
.time-summary {
  background: #1d2430;
  padding: 9px 14px;
  cursor: pointer;
  color: var(--blue);
  font-size: 12px;
  font-weight: 900;
}
.time-summary:hover { background: #253044; }
.time-content { display: none; }
.time-group.open .time-content { display: block; }
.src-badge {
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 900;
  flex-shrink: 0;
}
.badge-reddit { background: #ff4500; color: #fff; }
.badge-5ch { background: #ff9900; color: #111827; }
.badge-custom { background: var(--gold); color: #111827; }
.case-count {
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
}
.brief-textarea { min-height: 420px; font-size: 14px; line-height: 1.65; }
.editor-layout {
  display: grid;
  grid-template-columns: minmax(300px, 520px) minmax(0, 1fr);
  gap: 12px;
}
.slide-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.slide-tab {
  background: #263142;
  color: var(--text);
  border: 1px solid var(--line);
  padding: 7px 10px;
  font-size: 12px;
}
.slide-tab.active { background: var(--gold); color: #111827; }
.data-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 34px;
  gap: 6px;
  margin-bottom: 6px;
}
.preview-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: #000;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.preview-wrap iframe {
  position: absolute;
  inset: 0;
  width: 1920px;
  height: 1080px;
  border: 0;
  transform-origin: top left;
}
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}
.gallery-thumb {
  height: 68px;
  border: 2px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: #000;
  cursor: pointer;
}
.gallery-thumb.selected { border-color: var(--gold); }
.gallery-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
@media (max-width: 900px) {
  main { grid-template-columns: 210px minmax(0, 1fr); }
  .summary-grid { grid-template-columns: 1fr; }
  .human-brief { grid-template-columns: 1fr; }
  .chapter-list { grid-template-columns: 1fr; }
  .beat { grid-template-columns: 1fr; }
  .editor-layout { grid-template-columns: 1fr; }
  .case-toolbar { grid-template-columns: 1fr 1fr; }
  .case-editor-grid { grid-template-columns: 1fr; }
}
/* hidden state storage — input[type=hidden] なので追加CSSは不要 */

/* compact selected-case badge on step2+ */
.case-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: #111827;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  min-height: 0;
  flex-shrink: 0;
}
.case-badge b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.case-badge.empty-badge { color: var(--muted); font-style: italic; }

/* collapsed proposal card (unselected) */
.briefing-paper--compact {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.briefing-paper--compact h2 { margin: 0 0 4px; font-size: 13px; color: var(--muted); }
.briefing-paper--compact p { margin: 0; font-size: 13px; line-height: 1.4; }
.briefing-paper--compact .task-actions { margin-top: 10px; }

/* topic panel in step1 workspace */
.topic-panel-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  align-items: center;
}
.topic-panel-grid label { font-size: 12px; color: var(--muted); white-space: nowrap; }
.topic-panel-grid select,
.topic-panel-grid input { margin: 0; }

/* hamburger + drawer */
.hamburger-btn {
  display: none;
  background: none;
  border: none;
  color: var(--gold);
  font-size: 22px;
  cursor: pointer;
  padding: 4px 8px;
  min-height: unset;
  line-height: 1;
}
.sidebar-overlay { display: none; }
.sidebar-overlay.active {
  display: block;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,.55);
  z-index: 199;
}
body.drawer-is-open #savedDrawer {
  display: flex !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 85vw !important;
  max-width: 320px !important;
  height: 100dvh !important;
  z-index: 10000 !important;
  visibility: visible !important;
  opacity: 1 !important;
  transform: translateX(0) !important;
  -webkit-transform: translateX(0) !important;
  pointer-events: auto !important;
}
body.drawer-is-open #sidebarOverlay {
  display: block !important;
  z-index: 9999 !important;
}
.drawer-close {
  display: none;
  background: transparent;
  color: var(--text);
  border: 1px solid var(--line);
  min-height: 34px;
  padding: 6px 9px;
}

@media (max-width: 720px) {
  body { height: auto; min-height: 100vh; overflow: auto; }
  header {
    height: auto;
    align-items: center;
    flex-direction: row;
    justify-content: space-between;
    flex-wrap: wrap;
    padding: 10px 14px;
    gap: 4px;
  }
  h1 { font-size: 16px; }
  .tag { font-size: 11px; }
  .hamburger-btn {
    display: inline-flex;
    position: relative;
    z-index: 220;
    min-width: 42px;
    min-height: 42px;
    align-items: center;
    justify-content: center;
    touch-action: manipulation;
  }
  main { display: block; height: auto; }
  /* iOS Safari fix: never use display:none on aside — textarea inside kills all touch events.
     Use transform off-screen + pointer-events:none instead. */
  main.full-workspace aside { display: -webkit-flex; display: flex; }
  aside {
    display: -webkit-flex;
    display: flex;
    -webkit-flex-direction: column;
    flex-direction: column;
    position: fixed;
    top: 0; left: 0;
    width: 85vw; max-width: 300px;
    height: 100%;
    z-index: 200;
    background: #0d1220;
    border-right: 1px solid var(--line);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    -webkit-transform: translateX(-110%);
    transform: translateX(-110%);
    pointer-events: none;
    -webkit-transition: -webkit-transform 0.22s ease;
    transition: transform 0.22s ease;
  }
  aside.drawer-open {
    -webkit-transform: translateX(0);
    transform: translateX(0) !important;
    pointer-events: auto !important;
    box-shadow: 10px 0 28px rgba(0,0,0,.42);
  }
  .drawer-close { display: inline-flex; }
  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .workspace { padding: 0; }
  .step-container { padding: 10px; }
  .panel { padding: 10px; margin-bottom: 10px; border-radius: 6px; }
  textarea { min-height: 120px; }
  .btnrow { grid-template-columns: 1fr; }
  button { min-height: 42px; }
  .mobile-brief {
    display: block;
    border: 2px solid var(--gold);
    background: #111827;
  }
  .mobile-inline-result {
    display: block;
  }
  .mobile-brief h2 {
    margin: 0 0 6px;
    color: var(--gold);
    font-size: 13px;
  }
  .mobile-brief p {
    margin: 0 0 10px;
    line-height: 1.55;
    font-size: 14px;
  }
  .mobile-brief ol {
    margin: 0;
    padding-left: 18px;
    color: #dbeafe;
    font-size: 13px;
    line-height: 1.5;
  }
  .brief-card p { font-size: 14px; }
  .chapter-seed { padding: 8px; }
  .argument-boxes { grid-template-columns: 1fr; }
  .argument-box { padding: 12px; border-left-width: 5px; }
  .argument-box .arg-label { font-size: 12px; }
  .argument-box h3 { font-size: 15px; }
  .argument-box p { font-size: 13px; }
  .beat { padding: 10px; gap: 8px; }
  .view-tabs {
    position: sticky;
    top: 0;
    z-index: 180;
    height: 48px;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
    touch-action: auto;
    pointer-events: auto;
  }
  .view-tab {
    flex: 0 0 118px;
    min-height: 48px;
    scroll-snap-align: start;
    pointer-events: auto;
  }
  .autopilot-grid { grid-template-columns: 1fr; }
  .proposal-paper-grid { grid-template-columns: 1fr; }
  .research-flow { grid-template-columns: 1fr; }
  .pipeline-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .case-toolbar { grid-template-columns: 1fr; }
  .case-row { grid-template-columns: 24px 56px minmax(0, 1fr); }
  .data-row { grid-template-columns: 1fr; }
  .brief-textarea { min-height: 320px; }
}
</style>
</head>
<body>
<header>
  <div style="display:flex;align-items:center;gap:10px;">
    <button id="hamburgerBtn" class="hamburger-btn" type="button" onclick="openSidebar()" aria-label="保存済み案件">☰</button>
    <div>
      <h1>V3 Story Architect</h1>
      <span class="version-badge">${UI_VERSION}</span>
    </div>
  </div>
  <div class="tag">V2 preserved / argumentPlan prototype / port ${PORT}</div>
</header>
<div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>
<nav class="view-tabs" id="stepTabs">
  <button class="view-tab" type="button" data-view="case" onclick="setResultView('case')">1 案件取得</button>
  <button class="view-tab" type="button" data-view="saved" onclick="setResultView('saved')">2 保存済み</button>
  <button class="view-tab" type="button" data-view="proposal" onclick="setResultView('proposal')">3 企画提案</button>
  <button class="view-tab" type="button" data-view="briefing" onclick="setResultView('briefing')">4 企画書</button>
  <button class="view-tab" type="button" data-view="script" onclick="setResultView('script')">5 スライド編集</button>
  <button class="view-tab" type="button" data-view="export" onclick="setResultView('export')">6 動画生成</button>
</nav>
<main>
  <aside id="savedDrawer" aria-hidden="true">
    <div class="sidebar-head"><span>保存済み案件</span><button class="drawer-close" type="button" onclick="closeSidebar()">閉じる</button></div>
    <div class="sidebar-body">
    <input type="hidden" id="sourceType" value="custom">
    <input type="hidden" id="title" value="">
    <input type="hidden" id="memo" value="">
      <div id="savedPlans" class="empty">未読込</div>
    </div>
    <div class="sidebar-footer">
      <button onclick="setResultView('saved')">2 保存済み案件</button>
      <div class="sidebar-hint">案件を選んで「2 保存済み」タブから企画提案へ進みます。</div>
    </div>
  </aside>
  <section class="workspace">
    <div id="output">
      <div class="step-container">
        <div class="panel">
          <span class="label">案件取得</span>
          <div class="task-status">画面初期化中。表示が切り替わらない場合も、この画面が見えていればV3本体は配信されています。</div>
        </div>
      </div>
    </div>
  </section>
</main>
<script>
window.addEventListener('error', function(event) {
  var box = document.getElementById('output');
  if (!box) return;
  box.innerHTML = '<div class="step-container"><div class="panel" style="border:2px solid #ef4444;"><span class="label">画面エラー</span><pre>' +
    String((event && (event.message || event.error)) || 'unknown error').replace(/[&<>"]/g, function(c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];
    }) + '</pre></div></div>';
});
let currentPlan = null;
let currentResearch = null;
let currentWikiStories = null;
let currentAIPlan = null;
let currentAcquiredData = null;
let currentFetchedData = null;
let savedProjects = [];
let loadedCases = [];
let selectedProject = null;
let selectedCaseIds = new Set();
let activeSlideIdx = 0;
let imageSelections = {};
let activeView = 'case';
let v2EditorEmbedLoading = false;
let v2EditorEmbedKey = '';
const V3_STATE_KEY = 'v3_launcher_working_state';
let stepStatus = {
  case: false,
  saved: false,
  proposal: false,
  briefing: false,
  structure: false,
  script: false,
  export: false,
};

function clearStep2WorkState(opts = {}) {
  if (!opts.keepPlan) currentPlan = null;
  currentResearch = null;
  currentWikiStories = null;
  currentAIPlan = null;
  currentAcquiredData = null;
  currentFetchedData = null;
  activeSlideIdx = 0;
  imageSelections = {};
  stepStatus.proposal = false;
  stepStatus.briefing = false;
  stepStatus.structure = false;
  stepStatus.script = false;
  stepStatus.export = false;
  if (!opts.skipPersist) persistV3State();
}

function persistV3State() {
  try {
    localStorage.setItem(V3_STATE_KEY, JSON.stringify({
      currentPlan,
      currentResearch,
      currentWikiStories,
      currentAIPlan,
      currentAcquiredData,
      currentFetchedData,
      selectedProject,
      activeView,
      activeSlideIdx,
      title: document.getElementById('title')?.value || '',
      memo: document.getElementById('memo')?.value || '',
      sourceType: document.getElementById('sourceType')?.value || 'custom',
    }));
  } catch (_) {}
}

function restoreV3State() {
  try {
    const raw = localStorage.getItem(V3_STATE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    currentPlan = state.currentPlan || null;
    currentResearch = state.currentResearch || null;
    currentWikiStories = state.currentWikiStories || null;
    currentAIPlan = state.currentAIPlan || null;
    currentAcquiredData = state.currentAcquiredData || null;
    currentFetchedData = state.currentFetchedData || null;
    selectedProject = state.selectedProject || null;
    activeView = state.activeView || 'case';
    activeSlideIdx = state.activeSlideIdx || 0;
    if (state.title && document.getElementById('title')) document.getElementById('title').value = state.title;
    if (state.memo && document.getElementById('memo')) document.getElementById('memo').value = state.memo;
    if (state.sourceType && document.getElementById('sourceType')) document.getElementById('sourceType').value = state.sourceType;
  } catch (_) {}
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function todayLocalDate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function applyProjectToInputs(project) {
  if (!project) return;
  selectedProject = project;
  const title = document.getElementById('title');
  const memo = document.getElementById('memo');
  const source = document.getElementById('sourceType');
  if (title) title.value = project.title || project.titleJa || project.raw?.title || '';
  if (source) source.value = project.source === '5ch' ? '5ch' : (project.source === 'reddit' ? 'reddit' : 'custom');
  if (memo) {
    const raw = project.raw || {};
    memo.value = [
      raw.selftext || raw.body || raw.customNote || '',
      Array.isArray(raw.comments) ? raw.comments.slice(0, 8).map((c) => c.body || c.text || c).join('\\n') : '',
    ].filter(Boolean).join('\\n\\n').trim();
  }
}

function projectMemoText(project) {
  const raw = project?.raw || {};
  return [
    raw.selftext || raw.body || raw.customNote || '',
    Array.isArray(raw.comments) ? raw.comments.slice(0, 8).map((c) => c.body || c.text || c).join('\\n') : '',
  ].filter(Boolean).join('\\n\\n').trim();
}

function toggleCustomCasePanel() {
  document.getElementById('customCasePanel')?.classList.toggle('open');
}

function setSidebarOpen(isOpen) {
  const aside = document.getElementById('savedDrawer') || document.querySelector('aside');
  const overlay = document.getElementById('sidebarOverlay');
  if (!aside || !overlay) return;
  document.body.classList.toggle('drawer-is-open', isOpen);
  aside.classList.toggle('drawer-open', isOpen);
  aside.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  aside.style.display = 'flex';
  aside.style.transform = isOpen ? 'translateX(0)' : 'translateX(-110%)';
  aside.style.webkitTransform = isOpen ? 'translateX(0)' : 'translateX(-110%)';
  aside.style.pointerEvents = isOpen ? 'auto' : 'none';
  aside.style.position = 'fixed';
  aside.style.zIndex = isOpen ? '10000' : '';
  aside.style.visibility = isOpen ? 'visible' : '';
  aside.style.opacity = isOpen ? '1' : '';
  overlay.classList.toggle('active', isOpen);
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

function openSidebar() {
  setSidebarOpen(true);
}

function closeSidebar() {
  setSidebarOpen(false);
}

function toggleSidebar() {
  const aside = document.getElementById('savedDrawer') || document.querySelector('aside');
  setSidebarOpen(!aside?.classList.contains('drawer-open'));
}

function bindHamburgerMenu() {
  const btn = document.getElementById('hamburgerBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSidebar();
  }, { passive: false });
  btn.addEventListener('touchend', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSidebar();
  }, { passive: false });
}

window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.toggleSidebar = toggleSidebar;

function bindCaseInputReset() {
  ['title', 'memo', 'sourceType'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.resetBound === '1') return;
    el.dataset.resetBound = '1';
    el.addEventListener(id === 'sourceType' ? 'change' : 'input', () => {
      if (!currentPlan && !currentResearch && !currentFetchedData && !currentAcquiredData) return;
      selectedProject = null;
      clearStep2WorkState({ skipPersist: true });
      activeView = 'case';
      persistV3State();
    });
  });
}

async function persistSavedProjects() {
  const res = await fetch('/api/v3/saved-projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: savedProjects }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '保存失敗');
  return data;
}

async function saveCustomCase() {
  const title = document.getElementById('customCaseTitle')?.value.trim();
  const memo = document.getElementById('customCaseMemo')?.value.trim();
  if (!title) return alert('カスタム案件名を入れてください');
  const now = new Date().toISOString();
  const id = 'custom_' + Date.now();
  const item = {
    id,
    title,
    titleOrig: title,
    addedAt: now,
    source: 'custom',
    score: 0,
    raw: { id, title, source: 'custom', isCustom: true, customNote: memo || '', addedAt: now },
  };
  savedProjects.push(item);
  try {
    await persistSavedProjects();
    applyProjectToInputs(item);
    selectedProject = item;
    clearStep2WorkState({ skipPersist: true });
    document.getElementById('customCaseTitle').value = '';
    document.getElementById('customCaseMemo').value = '';
    activeView = 'saved';
    await loadSaved();
    renderPlan(currentPlan);
  } catch (error) {
    alert(error.message);
  }
}

async function loadCases() {
  const date = document.getElementById('caseDate')?.value || todayLocalDate();
  const box = document.getElementById('caseList');
  if (box) box.innerHTML = '<div class="empty">読込中...</div>';
  try {
    const res = await fetch('/api/v3/content?date=' + encodeURIComponent(date));
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    loadedCases = data.posts || [];
    selectedCaseIds = new Set();
    renderPlan(currentPlan);
  } catch (error) {
    if (box) box.innerHTML = '<div class="empty">案件読込失敗: ' + esc(error.message) + '</div>';
  }
}

function toggleCase(id) {
  if (selectedCaseIds.has(id)) selectedCaseIds.delete(id);
  else selectedCaseIds.add(id);
  renderPlan(currentPlan);
}

function toggleCaseIndex(index) {
  const item = loadedCases[index];
  if (item?.id) toggleCase(item.id);
}

function toggleCaseGroup(el) {
  const group = el?.closest('.time-group');
  if (!group) return;
  group.classList.toggle('open');
}

async function saveSelectedCases() {
  const picked = loadedCases.filter((p) => selectedCaseIds.has(p.id));
  if (!picked.length) return alert('保存する案件を選んでください');
  const byId = new Map(savedProjects.map((p) => [p.id, p]));
  picked.forEach((p) => byId.set(p.id, p));
  savedProjects = Array.from(byId.values());
  await persistSavedProjects();
  applyProjectToInputs(picked[0]);
  selectedCaseIds = new Set();
  currentPlan = null;
  currentResearch = null;
  currentWikiStories = null;
  currentAIPlan = null;
  currentAcquiredData = null;
  currentFetchedData = null;
  imageSelections = {};
  activeView = 'saved';
  await loadSaved();
  renderPlan(currentPlan);
}

function selectSavedProject(index) {
  const project = savedProjects[index];
  if (!project) return;
  applyProjectToInputs(project);
  // 調査済みデータがあれば復元、なければクリア
  const r = project.researchData || {};
  currentPlan = r.plan || null;
  currentResearch = r.research || null;
  currentWikiStories = r.wikiStories || null;
  currentAIPlan = r.aiPlan || null;
  currentAcquiredData = r.acquiredData || null;
  currentFetchedData = r.fetchedData || null;
  renderPlan(currentPlan);
  loadSaved();
  closeSidebar();
}

async function saveResearchToProject() {
  if (!selectedProject) return;
  const idx = savedProjects.findIndex(function(p) { return p.id === selectedProject.id; });
  if (idx < 0) return;
  // learningCorpus は記事本文が重いので先頭300文字に圧縮して保存
  const compactResearch = currentResearch ? {
    ok: currentResearch.ok,
    topic: currentResearch.topic,
    queries: currentResearch.queries,
    summary: currentResearch.summary,
    learningCorpus: (currentResearch.learningCorpus || []).map(function(c) {
      return { index: c.index, title: c.title, url: c.url, host: c.host,
               fetchStatus: c.fetchStatus, score: c.score, usableFor: c.usableFor,
               text: (c.text || '').slice(0, 300) };
    }),
  } : null;
  savedProjects[idx] = Object.assign({}, savedProjects[idx], {
    researchData: {
      plan: currentPlan,
      research: compactResearch,
      wikiStories: currentWikiStories,
      aiPlan: currentAIPlan,
      acquiredData: currentAcquiredData,
      fetchedData: currentFetchedData,
    },
  });
  selectedProject = savedProjects[idx];
  try { await persistSavedProjects(); } catch (_) {}
}

async function goToProposalFromSidebar() {
  if (!selectedProject) return alert('先に左の保存済み案件を選んでください');
  activeView = 'proposal';
  renderPlan(currentPlan);
}

function markStepDone(view) {
  stepStatus[view] = true;
  if (view === 'proposal') {
    stepStatus.briefing = true;
    stepStatus.structure = true;
    stepStatus.script = true;
  }
}

function readBriefEditor() {
  return {
    core: document.getElementById('briefCore')?.value || '',
    answer: document.getElementById('briefAnswer')?.value || '',
    points: document.getElementById('briefPoints')?.value || '',
    cautions: document.getElementById('briefCautions')?.value || '',
  };
}

function fillBriefEditor(plan) {
  const brief = plan.humanBrief || {};
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el && !el.value.trim()) el.value = value || '';
  };
  set('briefCore', brief.core || plan.centralQuestion || '');
  set('briefAnswer', brief.answer || plan.thesis || '');
  set('briefPoints', (brief.structure || []).map((x, i) => '論点' + (i + 1) + ': ' + (x.point || x.label || '')).join('\\n'));
  set('briefCautions', (brief.cautions || plan.globalRiskChecks || []).join('\\n'));
}

async function generatePlan(opts = {}) {
  const shouldScroll = opts.scroll !== false;
  const btn = document.getElementById('generateBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '設計中...';
  }
  try {
    const res = await fetch('/api/v3/argument-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: document.getElementById('title').value,
        memo: document.getElementById('memo').value,
        sourceType: document.getElementById('sourceType').value,
        brief: readBriefEditor(),
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'failed');
    currentPlan = data.plan;
    markStepDone('case');
    fillBriefEditor(currentPlan);
    renderPlan(currentPlan);
    const target = document.getElementById('resultTop');
    if (shouldScroll) target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    document.getElementById('output').innerHTML = '<div class="empty">生成失敗: ' + esc(error.message) + '</div>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '設計する';
    }
  }
}

async function savePlan() {
  if (!currentPlan) return alert('先に設計してね');
  const res = await fetch('/api/v3/argument-plan/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: currentPlan }),
  });
  const data = await res.json();
  if (!data.success) return alert(data.error || '保存失敗');
  await loadSaved();
  alert('保存したよ: ' + data.id);
}

async function runResearch() {
  const btn = document.getElementById('researchBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'リサーチ中...';
  }
  try {
    if (!currentPlan) await generatePlan({ scroll: false });
    const baseBody = {
      topic: document.getElementById('title').value,
      memo: document.getElementById('memo').value,
      plan: currentPlan,
    };
    const topicRes = await fetch('/api/v3/research/topic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseBody),
    });
    const topicData = await topicRes.json();
    if (!topicData.success) throw new Error(topicData.error || 'topic research failed');
    currentResearch = topicData.result;
    const wikiRes = await fetch('/api/v3/research/wiki-side-stories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, learningCorpus: currentResearch.learningCorpus || [] }),
    });
    const wikiData = await wikiRes.json();
    if (!wikiData.success) throw new Error(wikiData.error || 'wiki research failed');
    currentWikiStories = wikiData.result;
    bindResearchCandidates();
    markStepDone('research');
    if (currentPlan) renderPlan(currentPlan);
    else renderResearchOnly();
    activeView = 'proposal';
    if (currentPlan) renderPlan(currentPlan);
  } catch (error) {
    alert('リサーチ失敗: ' + error.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'リサーチ';
    }
  }
}

function saveScriptNarration(slideIdx) {
  const el = document.getElementById('v3ScriptNarration');
  if (!el) return;
  const val = el.value;
  const draft = currentPlan?.autopilotPlan?.scriptDraft;
  if (draft?.[slideIdx]) draft[slideIdx].narration = val;
  if (currentPlan?.v3Modules?.[slideIdx]) currentPlan.v3Modules[slideIdx].narration = val;
  persistV3State();
}

function saveDataSlotDirect(slotIdx, value) {
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m?.dataSlots?.[slotIdx]) return;
  m.dataSlots[slotIdx].value = value;
  persistV3State();
}

// ① スライド型・タイトル保存
function saveV3SlideType(type) {
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m) return;
  m.type = type;
  persistV3State();
  setTimeout(() => reloadV3Preview(), 100);
}
function saveV3SlideTitle(val) {
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m) return;
  m.title = val;
  const s = currentPlan?.autopilotPlan?.scriptDraft?.[activeSlideIdx];
  if (s) s.title = val;
  persistV3State();
}

// ③ TTS ボイス一覧を読み込んで select を更新
async function loadV3TtsVoices() {
  try {
    const data = await fetch('/api/v2/tts-presets').then((r) => r.json());
    const provider = document.getElementById('v3TtsProvider')?.value || 'gemini';
    const voiceSel = document.getElementById('v3TtsVoice');
    const modelEl  = document.getElementById('v3TtsModel');
    if (voiceSel && data.voices) {
      voiceSel.innerHTML = data.voices.map((v) => '<option value="' + v.id + '">' + v.label + '</option>').join('');
    }
    if (modelEl) {
      const modelLabel = data.models?.[0]?.id || data.model || provider;
      modelEl.textContent = 'model: ' + modelLabel + ' / voice: ' + (data.voices?.[0]?.id || '—');
    }
  } catch (_) {}
}

// ④ 取得済みデータをスロットに自動バインド
function autoFillV3DataSlots(entityName) {
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m?.dataSlots?.length || !(currentFetchedData || []).length) return;
  const sources = entityName
    ? (currentFetchedData || []).filter((d) => d.ok && d.nameEn === entityName)
    : (currentFetchedData || []).filter((d) => d.ok);
  m.dataSlots.forEach((slot) => {
    if (slot.value) return;
    const label = String(slot.label || '').toLowerCase();
    for (const entity of sources) {
      const hit = (entity.slots || []).find((s) => String(s.label || '').toLowerCase() === label && s.value);
      if (hit) { slot.value = String(hit.value); break; }
    }
  });
  persistV3State();
  renderPlan(currentPlan);
}

// ④ TTS試聴
async function runV3TTSPreview() {
  const narration = document.getElementById('v3ScriptNarration')?.value?.trim();
  const statusEl = document.getElementById('v3TtsStatus');
  const audioEl = document.getElementById('v3TtsAudio');
  if (!narration) { if (statusEl) statusEl.textContent = 'ナレーションを入力してください'; return; }
  if (statusEl) statusEl.textContent = '生成中...';
  if (audioEl) audioEl.style.display = 'none';
  try {
    const res = await fetch('/api/v2/tts-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: narration,
        provider: document.getElementById('v3TtsProvider')?.value || 'gemini',
        speed: parseFloat(document.getElementById('v3TtsSpeed')?.value || '1.0'),
      }),
    });
    const data = await res.json();
    if (!data.ok && !data.jobId) throw new Error(data.error || 'TTS失敗');
    // ポーリング
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await fetch('/api/v2/tts-preview-status?jobId=' + encodeURIComponent(data.jobId)).then((r) => r.json());
      if (st.status === 'done' && st.result?.base64) {
        const binary = atob(st.result.base64);
        const bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
        const blob = new Blob([bytes], { type: st.result.mime || 'audio/mpeg' });
        if (audioEl) { audioEl.src = URL.createObjectURL(blob); audioEl.style.display = ''; audioEl.play().catch(() => {}); }
        if (statusEl) statusEl.textContent = '再生中';
        return;
      }
      if (st.status === 'error') throw new Error(st.error || 'TTS生成エラー');
      if (statusEl) statusEl.textContent = '生成中... (' + (i + 1) + ')';
    }
    throw new Error('TTS タイムアウト');
  } catch (e) {
    if (statusEl) statusEl.textContent = '失敗: ' + e.message;
  }
}

// 動画生成
let _v3VideoJobId = null;
let _v3VideoPoller = null;

async function startV3VideoGeneration() {
  const btn = document.getElementById('v3GenVideoBtn');
  const status = document.getElementById('v3GenVideoStatus');
  const bar = document.getElementById('v3ProgressBar');
  const fill = document.getElementById('v3ProgressFill');
  if (!currentPlan) { if (status) status.textContent = 'プランがありません'; return; }
  const modules = currentPlan.v3Modules;
  if (!Array.isArray(modules) || !modules.length) {
    if (status) status.textContent = 'スライドがありません。まず脚本を生成してください';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '準備中...'; }
  if (bar) bar.style.display = '';
  if (fill) fill.style.width = '5%';
  try {
    if (status) status.textContent = '動画生成ジョブを起動中...';
    const genRes = await fetch('/api/v3/generate-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modules,
        topic: currentPlan.topic || document.getElementById('title')?.value || '',
        memo: document.getElementById('memo')?.value || '',
      }),
    });
    const genData = await genRes.json();
    if (!genData.ok) throw new Error(genData.error || '動画生成起動失敗');
    _v3VideoJobId = genData.jobId;
    if (fill) fill.style.width = '20%';
    if (status) status.textContent = 'レンダリング中... (jobId: ' + genData.jobId + ')';
    if (_v3VideoPoller) clearInterval(_v3VideoPoller);
    _v3VideoPoller = setInterval(() => pollV3VideoStatus(genData.postId), 3000);
  } catch (e) {
    if (status) status.textContent = '失敗: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = '動画生成スタート'; }
  }
}

async function pollV3VideoStatus(postId) {
  if (!_v3VideoJobId) return;
  try {
    const st = await fetch('/api/v2/video-status?jobId=' + encodeURIComponent(_v3VideoJobId)).then((r) => r.json());
    const fill = document.getElementById('v3ProgressFill');
    const status = document.getElementById('v3GenVideoStatus');
    const btn = document.getElementById('v3GenVideoBtn');
    const progress = st.progress || 0;
    if (fill) fill.style.width = Math.max(20, Math.round(progress * 100)) + '%';
    if (st.status === 'done') {
      clearInterval(_v3VideoPoller);
      if (fill) fill.style.width = '100%';
      if (status) status.textContent = '動画生成完了！';
      if (btn) { btn.disabled = false; btn.textContent = '再生成'; }
      // 動画プレイヤー表示
      const resultEl = document.getElementById('v3VideoResult');
      if (resultEl) {
        const videoUrl = st.outputVideo
          ? '/' + String(st.outputVideo).replace(/^\\/+/, '')
          : '';
        resultEl.innerHTML =
          '<div class="panel">' +
            '<label class="label" style="margin-bottom:8px;">完成動画</label>' +
            (videoUrl
              ? '<video controls style="width:100%;border-radius:6px;background:#000;" src="' + esc(videoUrl) + '"></video>'
              : '<div class="task-status">動画は生成済みです。ファイル一覧を再読込してください。</div>') +
            '<div class="task-actions" style="margin-top:8px;">' +
              (videoUrl ? '<a href="' + esc(videoUrl) + '" download class="button" style="display:inline-flex;align-items:center;padding:8px 14px;background:var(--gold);color:#111827;border-radius:6px;font-weight:900;text-decoration:none;">ダウンロード</a>' : '') +
            '</div>' +
          '</div>';
      }
    } else if (st.status === 'error') {
      clearInterval(_v3VideoPoller);
      if (status) status.textContent = 'エラー: ' + (st.error || '不明');
      if (btn) { btn.disabled = false; btn.textContent = '動画生成スタート'; }
    } else {
      if (status) status.textContent = 'レンダリング中... ' + (st.step || '') + ' ' + (progress ? Math.round(progress * 100) + '%' : '');
    }
  } catch (_) {}
}

async function searchV3StockImages() {
  const q = document.getElementById('v3ImgSearchInput')?.value?.trim();
  const type = document.getElementById('v3ImgTypeSelect')?.value || 'player';
  const grid = document.getElementById('v3StockImgGrid');
  if (!q) { if (grid) grid.innerHTML = '<span style="color:var(--muted);font-size:12px;">検索ワードを入力</span>'; return; }
  if (grid) grid.innerHTML = '<span style="color:var(--muted);font-size:12px;">検索中...</span>';
  try {
    const res = await fetch('/api/v3/images/stock?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(type));
    const data = await res.json();
    renderV3StockGallery(data.images || []);
  } catch (e) {
    if (grid) grid.innerHTML = '<span style="color:#fca5a5;font-size:12px;">' + esc(e.message) + '</span>';
  }
}

function renderV3StockGallery(images) {
  const grid = document.getElementById('v3StockImgGrid');
  if (!grid) return;
  if (!images.length) { grid.innerHTML = '<span style="color:var(--muted);font-size:12px;">画像なし</span>'; return; }
  const selectedImgs = Array.isArray(currentPlan?.v3Modules?.[activeSlideIdx]?.images) ? currentPlan.v3Modules[activeSlideIdx].images : [];
  grid.innerHTML = images.map((img) => {
    const url   = img.url || img;
    const title = img.title || img.name || img.role || '';
    const score = img.score || 0;
    const src   = img.source || 'stock';
    const badge = src === 'wikimedia' ? 'W' : src === 'official_x' ? 'X' : '';
    const tip   = esc((badge ? '[' + badge + '] ' : '') + title + (score ? ' (' + score + ')' : ''));
    const safeUrl = esc(url).replace(/'/g, '&#39;');
    return '<img class="stock-img-thumb' + (selectedImgs.includes(url) ? ' selected' : '') + '" src="' + esc(url) + '" title="' + tip + '" draggable="true" ondragstart="onDragStartImg(event,\\'' + safeUrl + '\\')" onclick="toggleV3Image(\\'' + safeUrl + '\\')" loading="lazy">';
  }).join('');
}

function onDragStartImg(event, url) {
  event.dataTransfer.setData('text/plain', url);
  event.dataTransfer.effectAllowed = 'copy';
}

async function onDropToChest(event) {
  event.preventDefault();
  const chest = document.getElementById('v3StockChest');
  if (chest) chest.classList.remove('drag-over');
  const url = event.dataTransfer.getData('text/plain');
  if (!url) return;
  try {
    const res  = await fetch('/api/v3/boost-image-score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: url }) });
    const data = await res.json();
    if (data.ok) {
      if (chest) { chest.textContent = '✨'; setTimeout(() => { chest.textContent = '🪙'; }, 1200); }
      console.log('[chest] スコア更新:', url, '→', data.newScore, '点');
    } else {
      console.warn('[chest] 失敗:', data.error);
    }
  } catch (e) {
    console.warn('[chest] エラー:', e.message);
  }
}

async function runAIScriptGeneration() {
  const btn = document.getElementById('aiScriptBtn');
  const status = document.getElementById('aiScriptStatus');
  if (btn) { btn.disabled = true; btn.textContent = 'AI生成中...'; }
  if (status) status.textContent = 'DeepSeekが脚本を生成中です...';
  try {
    if (!currentPlan) { if (status) status.textContent = '先に企画書を作ってください'; return; }
    rebuildV3ModulesFromBriefing();
    bindFetchedDataToV3Modules();
    const res = await fetch('/api/v3/generate-narration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: currentPlan.topic || document.getElementById('title')?.value || '',
        v3Modules: currentPlan.v3Modules,
        enrichedMemo: currentPlan.synthesis?.enrichedMemo || currentPlan.autopilotPlan?.briefing?.coreMessage || '',
        fetchedData: currentFetchedData || [],
        provider: 'deepseek',
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'AI脚本生成失敗');
    const aiSlides = data.slides || [];
    currentPlan.autopilotPlan = currentPlan.autopilotPlan || {};
    // ファクトチェックフラグを保存
    if (data.factCheckFlags?.length) {
      currentPlan.autopilotPlan.factCheckFlags = data.factCheckFlags;
      console.warn('[v3] factCheckFlags:', data.factCheckFlags.length + '件');
    }
    currentPlan.v3Modules = currentPlan.v3Modules.map((m, i) => {
      const ai = aiSlides.find((s) => s.no === (i + 1)) || aiSlides[i] || {};
      const images = (ai.images || []).length ? ai.images : (m.images || []);
      return {
        ...m,
        narration: ai.narration || m.narration || '',
        images,
        imageCandidates: ai.imageCandidates || m.imageCandidates || [],
        v3Meta: {
          ...(m.v3Meta || {}),
          imageInstruction: ai.imageInstruction || m.v3Meta?.imageInstruction,
          caution: ai.caution || m.v3Meta?.caution || '',
        },
      };
    });
    // 全スライドの画像候補を1つの共有ギャラリーに集約（URL重複除去）
    const _seen = new Set();
    currentPlan.sharedImagePool = (currentPlan.v3Modules || [])
      .flatMap(m => m.imageCandidates || [])
      .filter(c => { if (!c.url || _seen.has(c.url)) return false; _seen.add(c.url); return true; });

    currentPlan.autopilotPlan.scriptDraft = currentPlan.v3Modules.map((m, i) => {
      const ai = aiSlides.find((s) => s.no === (i + 1)) || aiSlides[i] || {};
      return {
        slideNo: i + 1,
        title: m.title || '',
        role: m.v3Meta?.role || m.subValue || m.type || '',
        narration: ai.narration || m.narration || '',
        dataNeeds: (m.dataSlots || []).map((s) => s.label).filter(Boolean),
        selectedData: (m.dataSlots || []).filter((s) => s.value || s.sourceUrl).map((s) => ({
          label: s.label || '', value: s.value || '', sourceTitle: s.sourceTitle || '', sourceUrl: s.sourceUrl || '',
        })),
        caution: ai.caution || '',
      };
    });
    markStepDone('script');
    activeSlideIdx = 0;
    activeView = 'script';
    renderPlan(currentPlan);
    setTimeout(() => reloadV3Preview(), 50);
    const flagWarn = data.factCheckFlags?.length ? ' ⚠ ファクトチェックフラグ ' + data.factCheckFlags.length + '件' : '';
    if (status) status.textContent = aiSlides.length + '枚分の脚本を生成しました。各スライドを確認・編集してください。' + flagWarn;
  } catch (error) {
    if (status) status.textContent = '生成失敗: ' + error.message;
    alert('AI脚本生成失敗: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'AI脚本を再生成'; }
  }
}

function step2ProgressLabel(stage, fallback) {
  const map = {
    queued: ['0/5', '準備中'],
    query: ['1/5', '検索クエリを作成'],
    articles: ['2/5', 'ニュース記事を取得'],
    labels: ['3/5', '本筋ラベルを作成'],
    prefetch: ['4/5', '無料データを取得'],
    analyze: ['5/5', '企画書A/B/Cを作成'],
    done: ['5/5', '完了'],
    error: ['停止', 'エラー'],
  };
  const item = map[stage] || ['', fallback || '調査中'];
  return (item[0] ? item[0] + ' ' : '') + item[1];
}

function setProposalRunStatus(stage, detail) {
  const el = document.getElementById('proposalRunStatus');
  if (!el) return;
  const main = step2ProgressLabel(stage, detail);
  el.innerHTML = '<b>' + esc(main) + '</b>' + (detail ? '<br><span style="font-size:12px;color:var(--muted);">' + esc(detail) + '</span>' : '');
}

function runProposalWithGapInstructions() {
  const extra = document.getElementById('gapResearchInstruction')?.value || '';
  return runProposal(extra);
}

async function runProposal(extraInstruction = '') {
  const btn = document.getElementById('proposalStepBtn');
  if (btn) { btn.disabled = true; btn.textContent = '調査中...'; }
  clearStep2WorkState({ keepPlan: true, skipPersist: true });
  currentAcquiredData = null;
  setProposalRunStatus('queued', 'サーバー側ジョブを開始中...');
  try {
    if (!currentPlan) await generatePlan({ scroll: false });
    const startRes = await fetch('/api/v3/proposal-job/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: document.getElementById('title').value,
        memo: [
          document.getElementById('memo').value,
          String(extraInstruction || '').trim() ? '追加指示: ' + String(extraInstruction || '').trim() : '',
        ].filter(Boolean).join('\\n\\n'),
        sourceType: document.getElementById('sourceType')?.value || 'custom',
        plan: currentPlan,
        selectedProjectId: selectedProject?.id || '',
      }),
    });
    const startData = await startRes.json();
    if (!startData.success) throw new Error(startData.error || 'proposal job start failed');
    const jobId = startData.jobId;
    activeView = 'proposal';
    renderPlan(currentPlan);
    setProposalRunStatus('queued', 'サーバー側ジョブを開始しました。');
    let lastMessage = '';
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      let jobData;
      try {
        const pollRes = await fetch('/api/v3/proposal-job/' + encodeURIComponent(jobId));
        jobData = await pollRes.json();
      } catch (pollError) {
        setProposalRunStatus('queued', (lastMessage || 'サーバー側で調査継続中...') + '（接続復帰待ち）');
        continue;
      }
      if (!jobData.success) throw new Error(jobData.error || 'proposal job not found');
      const job = jobData.job || {};
      lastMessage = job.message || job.stage || '';
      setProposalRunStatus(job.stage || 'queued', lastMessage || 'サーバー側で調査中...');
      if (job.status === 'done') {
        const result = job.result || {};
        currentPlan = result.plan || currentPlan;
        currentResearch = result.research || null;
        currentWikiStories = result.wikiStories || null;
        currentAIPlan = result.aiPlan || null;
        currentFetchedData = result.fetchedData || [];
        currentAcquiredData = result.acquiredData || buildAcquiredDataSummary();
        break;
      }
      if (job.status === 'error') throw new Error(job.error || job.message || 'proposal job failed');
    }
    markStepDone('proposal');
    activeView = 'proposal';
    renderPlan(currentPlan);
    setProposalRunStatus('done', '記事 ' + (currentResearch?.learningCorpus?.length || 0) + '件＋データ ' + (currentFetchedData || []).filter(function(d){return d.ok;}).length + '件で企画書A/B/Cを生成しました。');
    await loadSaved();
  } catch (error) {
    setProposalRunStatus('error', error.message);
    alert('企画提案失敗: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '調査'; }
  }
}

function tokenizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 40);
}

function bindResearchCandidates() {
  const tasks = currentPlan?.researchDesign?.tasks || [];
  const articles = currentResearch?.learningCorpus || [];
  if (!tasks.length || !articles.length) return;

  tasks.forEach((task) => {
    const terms = tokenizeForMatch([task.need, task.query, task.expectedOutput].join(' '));
    let best = null;
    articles.forEach((article) => {
      const hay = [article.title, article.host, article.text].join(' ').toLowerCase();
      const hits = terms.filter((term) => hay.includes(term)).length;
      const score = hits + Number(article.score || 0);
      if (!best || score > best.score) best = { article, score, hits };
    });
    if (!best || best.hits === 0) return;
    task.valueCandidate = String(best.article.text || '').slice(0, 260);
    task.sourceUrl = best.article.url || '';
    task.sourceTitle = best.article.title || '';
    task.confidence = best.hits >= 4 ? 'medium' : 'low';
    task.status = 'candidate_bound';
  });
}

function inferEntityLabels() {
  const text = [
    document.getElementById('title')?.value || '',
    document.getElementById('memo')?.value || '',
    ...(currentResearch?.learningCorpus || []).slice(0, 4).map((x) => x.title || ''),
  ].join(' ');
  const matches = text.match(/[A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+){0,3}|[ァ-ヶー]{3,}|[一-龯]{2,}/g) || [];
  const stop = new Set([
    'Reddit', 'Step', 'VPS', 'AI', 'Web', 'Wiki', 'SofaScore', 'Transfermarkt',
    '杯出場国', '出場国', '北米予選', '予選', '種子島', '人口', '背景', '本件',
    '検索', '記事', '調査', '企画', '作成', '取得',
  ]);
  return Array.from(new Set(matches.map((x) => x.trim()).filter((x) => x.length >= 3 && !stop.has(x)))).slice(0, 8);
}

function compactSearchTopic(title, memo) {
  const raw = String(title || memo || '')
    .replace(/https?:\\/\\/\\S+/g, ' ')
    .replace(/[\[\]【】「」『』"“”]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const latin = raw.match(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+(?:\\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+){0,3}/g) || [];
  const usefulLatin = latin
    .filter(function(w) { return !/^(reddit|thread|comments?|news|latest|the|and|for|with|from|about)$/i.test(w); })
    .slice(0, 4)
    .join(' ');
  if (usefulLatin) return usefulLatin.split(/\\s+/).slice(0, 10).join(' ');
  return raw
    .replace(/[、。！？!?].*$/, '')
    .split(/\\s+/)
    .slice(0, 10)
    .join(' ')
    .slice(0, 72) || raw.slice(0, 72);
}

function sentencePick(text, patterns, fallback = '') {
  const sentences = String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[。.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 220);
  for (const pattern of patterns) {
    const hit = sentences.find((s) => pattern.test(s));
    if (hit) return hit;
  }
  return fallback || sentences[0] || '';
}

function buildArticleDigest(articles) {
  const full = articles.filter((item) => /^full_text/.test(item.fetchStatus || ''));
  const pool = full.length ? full : articles;
  const merged = pool.map((item) => [item.title, item.text].join('。')).join(' ');
  return {
    bullets: [
      { label: '出来事の概要', text: sentencePick(merged, [/qualif|予選|World Cup|W杯|出場|result|結果|score/i], '') },
      { label: '主な論点', text: sentencePick(merged, [/transfer|移籍|contract|契約|manager|監督|squad|代表|lineup/i], '') },
      { label: '裏話・人物', text: sentencePick(merged, [/coach|manager|player|選手|監督|comment|said|コメント/i], '') },
      { label: '企画化の材料', text: sentencePick(merged, [/historic|history|first|初|record|記録|upset|快挙/i], '') },
    ],
    fullTextCount: full.length,
    articleCount: articles.length,
  };
}

function buildAcquiredDataSummary() {
  const articles = currentResearch?.learningCorpus || [];
  const tasks = currentPlan?.researchDesign?.tasks || [];
  const boundTasks = tasks.filter((task) => task.status === 'candidate_bound' || task.sourceUrl || task.valueCandidate);
  const wikiResults = currentWikiStories?.results || [];
  const entities = inferEntityLabels();
  const structured = [];
  wikiResults.slice(0, 4).forEach((item) => {
    structured.push({
      label: item.entity + ' - Wiki小話候補',
      source: 'Wikipedia',
      value: (item.sideStoryCandidates || []).map((x) => x.text).join(' ').slice(0, 220),
      status: 'side_story',
    });
  });
  return {
    queryLabels: currentResearch?.queryLabels || [],
    queries: currentResearch?.queries || tasks.map((task) => task.query).filter(Boolean).slice(0, 6),
    articleDigest: (currentResearch?.summary?.materialBulletsJa?.length)
      ? { bullets: currentResearch.summary.materialBulletsJa, fullTextCount: currentResearch.summary.fullTextCount || 0, articleCount: articles.length }
      : buildArticleDigest(articles),
    webSources: articles.slice(0, 8).map((item) => ({
      title: item.titleJa || item.title || item.host || 'article',
      titleJa: item.titleJa || '',
      url: item.url || '',
      host: item.host || '',
      fetchStatus: item.fetchStatus || '',
    })),
    structuredData: structured.slice(0, 12),
    entities,
    labelCandidates: [
      ...(currentResearch?.labelCandidates || []),
      ...entities.map((name) => ({ name, type: 'entity' })),
      ...wikiResults.map((x) => ({ name: x.entity, type: 'wiki' })).filter((x) => x.name),
    ].filter(Boolean).slice(0, 16),
    costSummary: currentResearch?.costSummary || null,
  };
}

async function runAnalysis(opts = {}) {
  if (!currentResearch && !opts.allowEmptyCorpus) {
    alert('先にStep2「企画提案を作る」を実行してね。AI分析はリサーチ済み材料を使います。');
    activeView = 'proposal';
    if (currentPlan) renderPlan(currentPlan);
    return;
  }
  const btn = document.getElementById('analyzeBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'AI分析中...'; }
  try {
    const res = await fetch('/api/v3/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: document.getElementById('title').value,
        memo: document.getElementById('memo').value,
        researchCorpus: currentResearch,
        wikiStories: currentWikiStories,
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'AI analysis failed');
    currentAIPlan = data.result;
    if (currentPlan) {
      currentPlan.autopilotPlan = buildMergedAutopilotPlan(currentPlan.autopilotPlan, currentAIPlan);
    }
    markStepDone('proposal');
    activeView = 'proposal';
    if (currentPlan) renderPlan(currentPlan);
  } catch (error) {
    alert('AI分析失敗: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'AIで再分析'; }
  }
}

async function exportToV2() {
  if (!currentPlan) await generatePlan({ scroll: false });
  collectV3SlideInputs();
  const btn = document.getElementById('exportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'V2保存中...'; }
  try {
    const res = await fetch('/api/v3/export-v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: currentPlan,
        sourceType: document.getElementById('sourceType').value,
        memo: document.getElementById('memo').value,
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'export failed');
    markStepDone('export');
    alert('V2へ渡したよ: ' + data.postId + '\\nV2ランチャーの保存済み案件から開けます。');
  } catch (error) {
    alert('V2連携失敗: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'V2へ渡す'; }
  }
}

async function saveV3ToV2EditorProject() {
  if (!currentPlan) await generatePlan({ scroll: false });
  collectV3SlideInputs();
  const existingPostId = currentPlan.v2EditorPostId || selectedProject?.v2EditorPostId || '';
  const res = await fetch('/api/v3/export-v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan: currentPlan,
      postId: existingPostId,
      sourceType: document.getElementById('sourceType').value,
      memo: document.getElementById('memo').value,
      imageSelections,
      fetchedData: currentFetchedData || [],
      acquiredData: currentAcquiredData || null,
      research: currentResearch || null,
      selectedProject,
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'export failed');
  currentPlan.v2EditorPostId = data.postId;
  if (selectedProject) selectedProject.v2EditorPostId = data.postId;
  markStepDone('export');
  persistV3State();
  return data;
}

async function openV2EditorFromV3(opts = {}) {
  const btn = document.getElementById('v2EditorBtn');
  const primaryBtn = document.getElementById('v2EditorBtnPrimary');
  const original = btn ? btn.textContent : '';
  const primaryOriginal = primaryBtn ? primaryBtn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'V2編集準備中...'; }
  if (primaryBtn) { primaryBtn.disabled = true; primaryBtn.textContent = 'V2編集準備中...'; }
  try {
    const data = await saveV3ToV2EditorProject();
    window.location.href = data.editorUrl || ('/v3-editor?postId=' + encodeURIComponent(data.postId));
  } catch (error) {
    if (opts.auto) {
      const status = document.getElementById('v2EditorAutoStatus') || document.getElementById('aiScriptStatus');
      if (status) status.textContent = 'V2級編集モードの自動起動に失敗しました: ' + error.message;
    } else {
      alert('V2級編集を開けませんでした: ' + error.message);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original || 'V2級編集で開く'; }
    if (primaryBtn) { primaryBtn.disabled = false; primaryBtn.textContent = primaryOriginal || 'V2級編集を開く'; }
  }
}

async function loadV2EditorIntoV3(opts = {}) {
  const frame = document.getElementById('v3EmbeddedV2Editor');
  const status = document.getElementById('v3EmbeddedV2Status') || document.getElementById('v2EditorAutoStatus') || document.getElementById('aiScriptStatus');
  const btn = document.getElementById('v2EditorBtnPrimary') || document.getElementById('v2EditorBtn');
  const original = btn ? btn.textContent : '';
  if (!frame) {
    return openV2EditorFromV3(opts);
  }
  if (btn) { btn.disabled = true; btn.textContent = 'V2級編集を準備中...'; }
  if (status) status.textContent = 'V3内にV2級編集機能を読み込み中...';
  try {
    const data = await saveV3ToV2EditorProject();
    const url = (data.editorUrl || ('/v3-editor?postId=' + encodeURIComponent(data.postId))) + '&embedded=1';
    frame.src = url;
    frame.style.display = 'block';
    const link = document.getElementById('v3EmbeddedV2Separate');
    if (link) link.href = data.editorUrl || url;
    if (status) status.textContent = 'V3内蔵のV2級編集機能を読み込みました。';
  } catch (error) {
    if (status) status.textContent = 'V2級編集機能の読み込みに失敗しました: ' + error.message;
    if (!opts.auto) alert('V2級編集機能を読み込めませんでした: ' + error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original || 'V2級編集を読み込む'; }
  }
}

function getV3EditableSlideCount(plan) {
  const modules = Array.isArray(plan?.v3Modules) ? plan.v3Modules.length : 0;
  const draft = Array.isArray(plan?.autopilotPlan?.scriptDraft) ? plan.autopilotPlan.scriptDraft.length : 0;
  return modules || draft;
}

function maybeLoadV2EditorInV3() {
  if (activeView !== 'script' || v2EditorEmbedLoading || !getV3EditableSlideCount(currentPlan)) return;
  if (!document.getElementById('v3EmbeddedV2Editor')) return;
  const key = [
    currentPlan?.v2EditorPostId || '',
    selectedProject?.id || '',
    currentPlan?.topic || '',
    getV3EditableSlideCount(currentPlan),
  ].join('|');
  if (v2EditorEmbedKey === key) return;
  v2EditorEmbedKey = key;
  v2EditorEmbedLoading = true;
  setTimeout(async function() {
    try {
      await loadV2EditorIntoV3({ auto: true });
    } finally {
      v2EditorEmbedLoading = false;
    }
  }, 120);
}

function buildMergedAutopilotPlan(base, aiPlan) {
  if (!aiPlan) return base;
  const selectedIdx = aiPlan.themeProposal?.selected || 0;
  const selectedCandidate = (aiPlan.themeProposal?.candidates || [])[selectedIdx] || {};
  return {
    ...base,
    aiGenerated: true,
    articleCount: aiPlan.articleCount || 0,
    themeProposal: {
      ...base?.themeProposal,
      hookQuestion: selectedCandidate.hookQuestion || '',
      answer: selectedCandidate.answer || '',
      angle: selectedCandidate.angle || '',
      storyPattern: selectedCandidate.storyPattern || '',
      candidates: aiPlan.themeProposal?.candidates || [],
      selected: selectedIdx,
      selectedReason: aiPlan.themeProposal?.selectedReason || '',
      rejectedReasons: aiPlan.themeProposal?.rejectedReasons || [],
      dataPlan: (selectedCandidate.dataNeeds || []).map((need, i) => ({ no: i + 1, need })),
    },
    briefing: {
      ...base?.briefing,
      purpose: aiPlan.briefing?.purpose || '',
      coreMessage: aiPlan.briefing?.coreMessage || '',
      storyPattern: selectedCandidate.storyPattern || aiPlan.briefing?.storyPattern || '',
      chapters: aiPlan.briefing?.chapters || [],
      slideOutline: selectedCandidate.slideOutline || aiPlan.briefing?.slideOutline || [],
      videoLengthType: selectedCandidate.videoLengthType || '',
      targetMinutes: selectedCandidate.targetMinutes || '',
      dataPlan: (aiPlan.briefing?.chapters || [])
        .flatMap((ch) => (ch.dataNeeds || []).map((need) => ({ need })))
        .slice(0, 8),
      riskChecklist: aiPlan.briefing?.riskChecklist || [],
    },
    scriptStructure: base?.scriptStructure || [],
    scriptDraft: base?.scriptDraft || [],
    mustCheck: (aiPlan.missingData || []).map((need) => ({ need, query: '', sourcePriority: [] })),
    publishGates: aiPlan.publishGates?.length ? aiPlan.publishGates : (base?.publishGates || []),
  };
}

function buildFallbackAutopilotPlan(base, reason) {
  const topic = document.getElementById('title')?.value || currentPlan?.topic || '';
  const tasks = currentPlan?.researchDesign?.tasks || [];
  const dataNeeds = tasks.map((task) => task.need || task.expectedOutput || task.query).filter(Boolean).slice(0, 6);
  const queries = currentResearch?.queries || [];
  const candidates = [
    {
      angle: topic + ' の背景を分解する',
      hookQuestion: topic + ' の本質は何か？',
      answer: '取得データをもとに、表面的な見方を超えた背景と構造を説明する。',
      dataNeeds,
      risk: '事実確認・数字の出典を固定する。',
    },
    {
      angle: 'データで見る ' + topic,
      hookQuestion: topic + '、数字は何を示しているか？',
      answer: 'スタッツと文脈を組み合わせ、なぜこの結果が起きたかを具体的に示す。',
      dataNeeds,
      risk: '統計の前提・対象期間を明示する。',
    },
    {
      angle: topic + ' の今後を読む',
      hookQuestion: topic + ' から、何が変わるのか？',
      answer: '過去のデータと現状分析を軸に、今後への影響を視聴者に分かりやすく伝える。',
      dataNeeds: queries.length ? queries : dataNeeds,
      risk: '将来予測は推測と明示する。',
    },
  ];
  return {
    ...base,
    aiGenerated: false,
    aiFallback: true,
    aiFallbackReason: reason || '',
    themeProposal: {
      ...(base?.themeProposal || {}),
      candidates,
      selected: 0,
      selectedReason: 'AI分析が完了しない場合の暫定案。Webリサーチ材料をもとに次工程で精査する。',
      rejectedReasons: [],
    },
    briefing: {
      ...(base?.briefing || {}),
      purpose: topic + 'を、事実とデータで説明する。',
      coreMessage: 'この話題の違和感を、取得データで裏付けながら視聴者に届ける。',
      chapters: [
        { no: 1, role: 'hook', claim: 'まず何が起きているかを提示する。' },
        { no: 2, role: 'context', claim: 'ニュースの背景と前提条件を整理する。' },
        { no: 3, role: 'data', claim: '確認できた記事・数字・関係者情報を並べる。' },
        { no: 4, role: 'answer', claim: '視聴者が納得できる答えにまとめる。' },
      ],
      dataPlan: dataNeeds.map((need) => ({ need })),
      riskChecklist: ['事実と推測を明確に区別する', '数字・日付は出典付きで固定する', '断定は裏付けのある情報のみ'],
    },
    mustCheck: dataNeeds.map((need) => ({ need, query: '', sourcePriority: [] })),
  };
}

function selectThemeCandidate(index) {
  if (!currentPlan?.autopilotPlan?.themeProposal) return;
  const proposal = currentPlan.autopilotPlan.themeProposal;
  const candidates = proposal.candidates || [];
  const selected = candidates[index];
  if (!selected) return;
  proposal.selected = index;
  proposal.hookQuestion = selected.hookQuestion || proposal.hookQuestion || '';
  proposal.answer = selected.answer || proposal.answer || '';
  proposal.angle = selected.angle || proposal.angle || '';
  proposal.storyPattern = selected.storyPattern || proposal.storyPattern || '';
  proposal.dataPlan = (selected.dataNeeds || []).map((need, i) => ({ no: i + 1, need }));
  const briefing = currentPlan.autopilotPlan.briefing || (currentPlan.autopilotPlan.briefing = {});
  if (Array.isArray(selected.slideOutline) && selected.slideOutline.length) briefing.slideOutline = selected.slideOutline;
  briefing.storyPattern = selected.storyPattern || briefing.storyPattern || '';
  briefing.videoLengthType = selected.videoLengthType || briefing.videoLengthType || '';
  briefing.targetMinutes = selected.targetMinutes || briefing.targetMinutes || '';
  activeView = 'proposal';
  renderPlan(currentPlan);
}

async function runWikiSideStories() {
  const btn = document.getElementById('wikiBtn');
  btn.disabled = true;
  btn.textContent = '取得中...';
  try {
    const res = await fetch('/api/v3/research/wiki-side-stories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: document.getElementById('title').value,
        memo: document.getElementById('memo').value,
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'failed');
    currentWikiStories = data.result;
    if (currentPlan) renderPlan(currentPlan);
    else renderResearchOnly();
  } catch (error) {
    alert('Wiki小話取得失敗: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '小話Wiki';
  }
}

async function loadSaved() {
  const res = await fetch('/api/v3/saved-projects');
  const data = await res.json();
  savedProjects = Array.isArray(data) ? data : [];
  const box = document.getElementById('savedPlans');
  if (box) {
    if (!savedProjects.length) {
      box.className = 'empty';
      box.textContent = '保存済みなし';
    } else {
      box.className = 'saved-list';
      box.innerHTML = savedProjects.slice().reverse().slice(0, 30).map((item, revIndex) => {
        const index = savedProjects.length - 1 - revIndex;
        const active = selectedProject?.id && selectedProject.id === item.id;
        return '<div class="saved-lead-item' + (active ? ' active' : '') + '" onclick="selectSavedProject(' + index + ')">' +
        '<b>' + esc(item.title || item.titleJa || item.id) + '</b><br>' +
        '<span>' + esc(item.source || '') + ' / score ' + esc(item.score || 0) + '</span>' +
        '<span>' + esc(item.addedAt || '') + '</span>' +
        '</div>';
      }).join('');
    }
  }
  if (activeView === 'saved') renderPlan(currentPlan);
}

function renderPlan(plan) {
  document.getElementById('output').innerHTML = renderResultTabs(plan);
  updateWorkspaceChrome();
  document.querySelectorAll('.view-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === activeView);
  });
  syncProxyInputs();
  persistV3State();
  if (activeView === 'script') {
    setTimeout(() => reloadV3Preview(), 50);
    maybeLoadV2EditorInV3();
  }
}

function syncProxyInputs() {
  const title = document.getElementById('title')?.value || '';
  const memo = document.getElementById('memo')?.value || '';
  const sourceType = document.getElementById('sourceType')?.value || 'custom';
  const pt = document.getElementById('proxyTitle');
  const pm = document.getElementById('proxyMemo');
  const ps = document.getElementById('proxySourceType');
  if (pt) pt.value = title;
  if (pm) pm.value = memo;
  if (ps) ps.value = sourceType;
}

function syncProxySourceType(el) {
  const target = document.getElementById('sourceType');
  if (target) target.value = el?.value || 'custom';
}

function syncProxyTitle(el) {
  const target = document.getElementById('title');
  if (target) target.value = el?.value || '';
}

function syncProxyMemo(el) {
  const target = document.getElementById('memo');
  if (target) target.value = el?.value || '';
}

function updateWorkspaceChrome() {
  document.querySelector('main')?.classList.add('full-workspace');
}

function setResultView(view) {
  if (activeView === 'structure' && view !== 'structure') collectV3SlideInputs();
  if (activeView === 'briefing' && view !== 'briefing') updateBriefingFromEditor();
  closeSidebar();
  activeView = view;
  renderPlan(currentPlan);
  if (view === 'saved') loadSaved();
  if (view === 'script') {
    // ③ TTS ボイス一覧読み込み
    setTimeout(loadV3TtsVoices, 100);
    // ⑤ 画像ギャラリー: AI割当候補があればそのまま表示、なければ検索
    setTimeout(() => {
      const pool = currentPlan?.sharedImagePool;
      if (Array.isArray(pool) && pool.length) {
        renderV3StockGallery(pool);
      } else {
        const inp = document.getElementById('v3ImgSearchInput');
        if (inp?.value) searchV3StockImages();
      }
    }, 200);
  }
}

function renderScriptView(plan) {
  const auto = plan.autopilotPlan || {};
  const script = auto.scriptDraft || [];
  const modules = plan.v3Modules || [];
  // modules があれば scriptDraft がなくてもスライドエディターを表示
  const slides = modules.length ? modules : script.map((s, i) => ({
    type: s.role || 'insight', title: s.title || '', narration: s.narration || '',
    dataSlots: (s.dataNeeds || []).map((l) => ({ label: l, value: '' })), images: [],
  }));

  const caseTitle = selectedProject?.title || selectedProject?.titleJa || plan.topic || document.getElementById('title')?.value || '未選択';
  const caseSource = selectedProject?.source || document.getElementById('sourceType')?.value || 'custom';
  const caseId = selectedProject?.id || selectedProject?.raw?.id || '';
  const caseBanner = '<div class="panel" style="padding:10px 12px;margin-bottom:10px;border-color:var(--gold);background:#14110a;">' +
    '<div style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;">' +
      '<span style="background:var(--gold);color:#111827;font-weight:900;font-size:11px;padding:3px 8px;border-radius:4px;flex-shrink:0;">編集中の案件</span>' +
      '<b style="font-size:14px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 240px;">' + esc(caseTitle) + '</b>' +
      '<span style="font-size:11px;color:var(--muted);flex-shrink:0;">' + esc(caseSource) + (caseId ? ' / ' + esc(caseId) : '') + '</span>' +
      '<button class="secondary" style="margin-left:auto;flex-shrink:0;font-size:11px;min-height:28px;padding:0 8px;" onclick="setResultView(\\'saved\\')">案件を確認</button>' +
    '</div>' +
  '</div>';

  if (!slides.length) {
    const slideCount = (auto.briefing?.slideOutline || auto.briefing?.chapters || []).length || 0;
    return '<span class="label">5 スライド編集</span>' +
      caseBanner +
      '<div class="panel" style="text-align:center;padding:24px 16px;">' +
        '<div style="font-size:15px;font-weight:700;margin-bottom:8px;">まず企画書からスライドを生成します（' + (slideCount || '?') + '枚）</div>' +
        '<div style="color:var(--muted);font-size:13px;margin-bottom:18px;">AI脚本生成を押すとナレーション・データ・画像が編集できるようになります</div>' +
        '<div class="task-actions" style="justify-content:center;">' +
          '<button id="aiScriptBtn" onclick="runAIScriptGeneration()">AI脚本生成</button>' +
          '<button class="secondary" onclick="setResultView(\\'briefing\\')">← 企画書に戻る</button>' +
        '</div>' +
        '<div id="aiScriptStatus" class="task-status" style="margin-top:10px;"></div>' +
      '</div>';
  }

  return caseBanner +
    '<iframe id="v3EmbeddedV2Editor" title="V3内蔵 V2級編集機能" style="display:block;width:100%;height:calc(100vh - 130px);min-height:780px;border:1px solid var(--line);border-radius:8px;background:#0b0d12;"></iframe>';

  const total = slides.length;
  const active = Math.max(0, Math.min(activeSlideIdx, total - 1));
  const m = slides[active] || {};
  const s = script[active] || {};
  const narration = m.narration || s.narration || '';
  const title = m.title || s.title || '';
  const slideType = m.type || s.role || 'insight';
  const ALL_TYPES = ['opening','insight','stats','profile','comparison','history','reaction','ranking','timeline','matchcard','picture','ending'];

  // ① スライドタブ
  const tabBar = '<div class="slide-tabs" style="margin:8px 0;">' +
    slides.map((sl, i) =>
      '<button class="slide-tab' + (i === active ? ' active' : '') + '" onclick="switchV3ScriptSlide(' + i + ')">' +
        esc((i + 1) + ' ' + (sl.type || 'slide')) +
      '</button>'
    ).join('') +
  '</div>';

  // ③ データスロット
  const slots = m.dataSlots || [];
  const slotRows = slots.length
    ? slots.map((slot, i) =>
        '<div class="slot-edit-row">' +
          '<span class="slot-edit-label" title="' + esc(slot.label || '') + '">' + esc(slot.label || '—') + '</span>' +
          '<input style="font-size:12px;padding:5px 8px;" placeholder="値" value="' + esc(slot.value || '') + '" oninput="saveDataSlotDirect(' + i + ', this.value)">' +
        '</div>'
      ).join('')
    : '<span style="color:var(--muted);font-size:12px;">データスロットなし</span>';

  // ④ 取得済みデータ表示（バインド用）
  const fetchedOk = (currentFetchedData || []).filter((d) => d.ok);
  const fetchedBanner = fetchedOk.length
    ? '<div style="margin-bottom:8px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">' +
          '<span style="font-size:11px;color:var(--muted);">取得済みデータ（クリックで自動入力）</span>' +
          '<button class="secondary" onclick="autoFillV3DataSlots()" style="font-size:11px;padding:3px 8px;">一括バインド</button>' +
        '</div>' +
        fetchedOk.map((d) => {
          const slots2 = (d.slots || []).map((sl) => sl.label + ': ' + sl.value).join(' / ');
          return '<span class="chip" style="cursor:pointer;font-size:11px;background:#0f2a1a;border-color:#22c55e;color:#bbf7d0;" onclick="autoFillV3DataSlots(\\'' + esc(d.nameEn).replace(/'/g,'&#39;') + '\\')" title="' + esc(slots2) + '">' + esc(d.nameEn) + '</span>';
        }).join('') +
      '</div>'
    : '';

  // 選択済み画像
  const selectedImgs = Array.isArray(m.images) ? m.images : [];
  const selectedImgHtml = selectedImgs.length
    ? selectedImgs.map((src) => '<img src="' + esc(src) + '" style="width:44px;height:44px;object-fit:cover;border-radius:4px;border:2px solid var(--gold);" onclick="toggleV3Image(\\'' + esc(src).replace(/'/g,'&#39;') + '\\')" title="クリックで解除">').join('')
    : '';

  const initQ = esc((plan.topic || title || '').split(/[\s「」【】]/)[0] || '');

  const v2EditorLead =
    '<div class="panel" style="border-color:var(--gold);background:#14110a;margin-bottom:10px;">' +
      '<div style="display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;">' +
        '<div style="min-width:220px;flex:1;">' +
          '<div style="font-weight:900;color:var(--gold);font-size:14px;margin-bottom:3px;">V2級編集モード</div>' +
          '<div style="font-size:12px;color:var(--muted);line-height:1.5;">画像調整・数値編集・プレビュー確認までV2ベースで編集できます。個別TTS試聴とスライドおまかせAIはV3側では非表示にしています。</div>' +
        '</div>' +
        '<button id="v2EditorBtnPrimary" onclick="openV2EditorFromV3()" style="font-size:13px;padding:8px 14px;">V2級編集を開く</button>' +
      '</div>' +
    '</div>';

  return caseBanner +
    v2EditorLead +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">' +
      '<span class="label" style="margin:0;">スライド編集 — ' + (active + 1) + ' / ' + total + '</span>' +
      '<div style="display:flex;gap:6px;">' +
        '<button id="aiScriptBtn" class="secondary" onclick="runAIScriptGeneration()" style="font-size:12px;padding:5px 10px;">AI脚本再生成</button>' +
        '<button id="v2EditorBtn" class="secondary" onclick="openV2EditorFromV3()" style="font-size:12px;padding:5px 10px;">V2級編集で開く</button>' +
        '<button onclick="setResultView(\\'export\\')" style="font-size:12px;padding:5px 10px;">動画生成へ →</button>' +
      '</div>' +
    '</div>' +
    '<div id="aiScriptStatus" class="task-status"></div>' +

    tabBar +

    '<div class="step5-layout">' +

    // ── 左カラム ──
    '<div class="step5-left">' +

      // ① スライド型セレクト + タイトル
      '<div class="panel" style="padding:10px 12px;">' +
        '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center;">' +
          '<select id="v3Step5SlideType" style="font-size:12px;padding:5px 8px;" onchange="saveV3SlideType(this.value)">' +
            ALL_TYPES.map((t) => '<option value="' + t + '"' + (t === slideType ? ' selected' : '') + '>' + t + '</option>').join('') +
          '</select>' +
          '<input id="v3Step5Title" style="font-size:13px;font-weight:700;padding:5px 8px;" value="' + esc(title) + '" oninput="saveV3SlideTitle(this.value)" placeholder="スライドタイトル">' +
        '</div>' +
      '</div>' +

      // ② ナレーション編集
      '<div class="panel">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">' +
          '<label class="label" style="margin:0;">② ナレーション</label>' +
          '<span style="font-size:11px;color:var(--muted);" id="v3NarrationCount">' + narration.length + '字</span>' +
        '</div>' +
        '<textarea id="v3ScriptNarration" style="min-height:140px;line-height:1.65;font-size:13px;" oninput="saveScriptNarration(' + active + ');document.getElementById(\\'v3NarrationCount\\').textContent=this.value.length+\\'字\\'">' + esc(narration) + '</textarea>' +
        (s.caution ? '<p style="color:#fecaca;font-size:12px;margin-top:4px;">⚠ ' + esc(s.caution) + '</p>' : '') +
      '</div>' +

      // ④ TTS試聴
      '<div class="panel">' +
        '<label class="label" style="margin-bottom:6px;">④ TTS試聴</label>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr auto auto;gap:6px;align-items:center;">' +
          '<select id="v3TtsProvider" style="font-size:12px;padding:5px 6px;" onchange="loadV3TtsVoices()">' +
            '<option value="gemini">Gemini</option>' +
            '<option value="minimax">MiniMax</option>' +
          '</select>' +
          '<select id="v3TtsVoice" style="font-size:12px;padding:5px 6px;"></select>' +
          '<input id="v3TtsSpeed" type="number" min="0.5" max="2.0" step="0.1" value="1.0" style="width:56px;font-size:12px;padding:5px 4px;" title="速度">' +
          '<button onclick="runV3TTSPreview()" style="padding:5px 10px;white-space:nowrap;">▶ 試聴</button>' +
        '</div>' +
        '<span id="v3TtsModel" style="font-size:10px;color:var(--muted);display:block;margin-top:3px;">読込中...</span>' +
        '<span id="v3TtsStatus" style="font-size:12px;color:var(--muted);display:block;margin-top:4px;"></span>' +
        '<audio id="v3TtsAudio" controls style="width:100%;margin-top:6px;display:none;height:32px;"></audio>' +
      '</div>' +

      // ③ データバインド
      '<div class="panel">' +
        '<label class="label" style="margin-bottom:6px;">③ データバインド</label>' +
        fetchedBanner +
        '<div id="v3Step5DataSlots">' + slotRows + '</div>' +
      '</div>' +
    '</div>' +

    // ── 右カラム: ⑤プレビュー + ⑤画像ギャラリー ──
    '<div class="step5-right">' +
      '<div class="panel">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<label class="label" style="margin:0;">⑤ プレビュー</label>' +
          '<button class="secondary" onclick="reloadV3Preview()" style="font-size:11px;padding:3px 8px;">更新</button>' +
        '</div>' +
        '<div class="preview-wrap" id="v3PreviewWrap"><iframe id="v3PreviewFrame" scrolling="no"></iframe></div>' +
        '<span style="color:var(--muted);font-size:11px;display:block;margin-top:4px;">' + esc(slideType) + ' | ' + (active + 1) + '/' + total + '枚</span>' +
      '</div>' +

      '<div class="panel">' +
        '<label class="label" style="margin-bottom:6px;">⑤ 画像ギャラリー</label>' +
        '<div class="gallery-search-row">' +
          '<input id="v3ImgSearchInput" placeholder="選手名・チーム名" value="' + initQ + '" onkeydown="if(event.key===\\'Enter\\')searchV3StockImages()">' +
          '<select id="v3ImgTypeSelect" style="padding:5px 6px;font-size:12px;">' +
            ['player','team','manager'].map((t) => '<option value="' + t + '">' + t + '</option>').join('') +
          '</select>' +
          '<button class="secondary" onclick="searchV3StockImages()" style="padding:5px 8px;">検索</button>' +
          '<div id="v3StockChest" class="stock-chest" title="ここにドロップ → 最高スコア+1で永続保存" ondragover="event.preventDefault();this.classList.add(\\'drag-over\\')" ondragleave="this.classList.remove(\\'drag-over\\')" ondrop="onDropToChest(event)">🪙</div>' +
        '</div>' +
        '<div id="v3StockImgGrid" class="stock-img-grid"><span style="color:var(--muted);font-size:12px;">検索中...</span></div>' +
        (selectedImgHtml ? '<label class="label" style="margin-top:8px;margin-bottom:4px;">選択中（クリックで解除）</label><div style="display:flex;gap:5px;flex-wrap:wrap;">' + selectedImgHtml + '</div>' : '') +
      '</div>' +
    '</div>' +

    '</div>';
}

function renderPipelineSteps() {
  const steps = [
    ['1', '案件', '入力または保存案件を選ぶ'],
    ['2', '保存済み', '過去案件を再開'],
    ['3', '企画提案', 'リサーチ→スライド型つき複数案'],
    ['4', '企画書', 'テーマ・流れ・スライド型ラフ'],
    ['5', '脚本生成', 'ナレーションとプレビュー確認'],
    ['6', '動画生成', 'ナレーション確認後にレンダリング'],
  ];
  return '<div class="pipeline-steps">' + steps.map((s) =>
    '<div class="pipeline-step"><b>' + esc(s[0] + '. ' + s[1]) + '</b><span>' + esc(s[2]) + '</span></div>'
  ).join('') + '</div>';
}

function renderStructureView(plan) {
  if (!Array.isArray(plan.v3Modules) || !plan.v3Modules.length) {
    plan.v3Modules = makeModulesFromCurrentPlan();
  }
  const modules = plan.v3Modules || [];
  const active = Math.max(0, Math.min(activeSlideIdx, modules.length - 1));
  const m = modules[active] || {};
  const dataRows = (m.dataSlots || []).map((slot, i) => (
    '<div class="data-row">' +
      '<input class="v3-data-label" data-idx="' + i + '" value="' + esc(slot.label || '') + '" placeholder="使うデータ" oninput="collectV3SlideInputs()">' +
      '<input class="v3-data-value" data-idx="' + i + '" value="' + esc(slot.value || slot.sourceUrl || '') + '" placeholder="値 / ソースURL" oninput="collectV3SlideInputs()">' +
      '<button class="secondary" onclick="deleteV3DataSlot(' + i + ')">×</button>' +
    '</div>'
  )).join('');
  const pool = Object.values(imageSelections || {}).flat();
  const selectedImgs = Array.isArray(m.images) ? m.images : [];
  const strFetchedOk = (currentFetchedData || []).filter(function(d) { return d.ok; });
  const fetchedBanner = strFetchedOk.length
    ? '<div class="panel" style="margin-bottom:8px;padding:8px 10px;">' +
        '<span class="label" style="font-size:11px;">取得済みデータ（SofaScore / TM）— スロット値に参照</span>' +
        '<div class="chips" style="margin-top:4px;">' +
          strFetchedOk.map(function(d) { return '<span class="chip" style="background:#0f2a1a;border-color:#22c55e;color:#bbf7d0;">' + esc(d.nameEn) + ': ' + esc(d.summary) + '</span>'; }).join('') +
        '</div>' +
      '</div>'
    : '';
  return fetchedBanner + '<span class="label">構成。使うスライド、使うデータとソース、画像をここで編集</span>' +
    '<div class="slide-tabs">' + modules.map((item, i) => (
      '<button class="slide-tab' + (i === active ? ' active' : '') + '" onclick="switchV3Slide(' + i + ')">' + esc((i + 1) + ' ' + (item.type || 'slide')) + '</button>'
    )).join('') + '</div>' +
    '<div class="editor-layout">' +
      '<div class="panel">' +
        '<label class="label">使うスライド</label>' +
        '<select id="v3SlideType" onchange="collectV3SlideInputs()">' +
          ['opening','insight','stats','profile','reaction','comparison','history','matchcard','ranking','timeline','picture','ending'].map((type) => '<option value="' + type + '"' + (m.type === type ? ' selected' : '') + '>' + type + '</option>').join('') +
        '</select>' +
        '<label class="label" style="margin-top:10px;">タイトル</label>' +
        '<input id="v3SlideTitle" value="' + esc(m.title || '') + '" oninput="collectV3SlideInputs()">' +
        '<label class="label" style="margin-top:10px;">このスライドで言うこと</label>' +
        '<textarea id="v3SlideNarration" oninput="collectV3SlideInputs()">' + esc(m.scriptDir || m.narration || '') + '</textarea>' +
        '<label class="label" style="margin-top:10px;">使うデータ / ソース</label>' +
        '<div id="v3DataRows">' + (dataRows || '<div class="empty">データ未設定</div>') + '</div>' +
        '<button class="secondary" onclick="addV3DataSlot()">データ行を追加</button>' +
        '<label class="label" style="margin-top:14px;">画像ギャラリー</label>' +
        '<input id="v3ImageUpload" type="file" accept="image/*" onchange="uploadV3Image()" style="display:none;">' +
        '<div class="task-actions"><button class="secondary" onclick="document.getElementById(\\'v3ImageUpload\\').click()">画像アップロード</button></div>' +
        '<div class="gallery-grid">' +
          (pool.length ? pool.map((src) => (
            '<div class="gallery-thumb' + (selectedImgs.includes(src) ? ' selected' : '') + '" onclick="toggleV3Image(\\'' + esc(src).replace(/'/g, '&#39;') + '\\')"><img src="' + esc(src) + '"></div>'
          )).join('') : '<div class="empty">画像未登録。アップロードすると共有ギャラリーに入ります。</div>') +
        '</div>' +
      '</div>' +
      '<div class="panel">' +
        '<div class="task-actions"><button onclick="generateScriptFromStructure()">この構成で脚本生成</button><button class="secondary" onclick="setResultView(\\'script\\')">脚本生成へ</button></div>' +
        '<div class="task-status">Step4では構成・スライド型・使うデータを決めます。プレビュー確認はStep5脚本で行います。</div>' +
        '<div class="panel" style="margin-top:12px;">' + renderStructureSourceList(plan) + '</div>' +
      '</div>' +
    '</div>';
}

function renderStructureSourceList(plan) {
  const modules = plan.v3Modules || [];
  return '<span class="label">明示データ・ソース一覧</span>' +
    '<div class="flow-list">' + modules.map((m, i) => (
      '<div class="flow-item"><b>' + esc((i + 1) + '. ' + (m.title || m.type || 'slide')) + '</b>' +
      '<p>slide: ' + esc(m.type || '') + '</p>' +
      '<div class="chips">' + (m.dataSlots || []).map((s) => '<span class="chip">' + esc((s.label || '') + (s.value ? ': ' + s.value : '') + (s.sourceUrl ? ' / ' + s.sourceUrl : '')) + '</span>').join('') + '</div>' +
      '</div>'
    )).join('') + '</div>';
}

function collectV3SlideInputs() {
  if (!currentPlan?.v3Modules?.length) return;
  if (!document.getElementById('v3SlideType') && !document.getElementById('v3SlideTitle')) return;
  const m = currentPlan.v3Modules[activeSlideIdx];
  if (!m) return;
  m.type = document.getElementById('v3SlideType')?.value || m.type;
  m.title = document.getElementById('v3SlideTitle')?.value || '';
  const textValue = document.getElementById('v3SlideNarration')?.value || '';
  if (activeView === 'structure') m.scriptDir = textValue;
  else m.narration = textValue;
  const labels = Array.from(document.querySelectorAll('.v3-data-label'));
  m.dataSlots = labels.map((el) => {
    const i = Number(el.dataset.idx);
    const value = document.querySelector('.v3-data-value[data-idx="' + i + '"]')?.value || '';
    return { label: el.value || '', value, sourceUrl: /^https?:/.test(value) ? value : '' };
  }).filter((slot) => slot.label || slot.value);
}

function switchV3Slide(index) {
  collectV3SlideInputs();
  activeSlideIdx = index;
  activeView = 'structure';
  renderPlan(currentPlan);
}

function switchV3ScriptSlide(index) {
  saveScriptNarration(activeSlideIdx);
  activeSlideIdx = index;
  activeView = 'script';
  renderPlan(currentPlan);
  // ⑤ 画像ギャラリー: AI割当候補があればそのまま表示、なければ検索
  setTimeout(() => {
    const m = currentPlan?.v3Modules?.[activeSlideIdx];
    if (Array.isArray(m?.imageCandidates) && m.imageCandidates.length) {
      renderV3StockGallery(m.imageCandidates);
    } else {
      const inp = document.getElementById('v3ImgSearchInput');
      if (inp?.value) searchV3StockImages();
    }
  }, 80);
}

function addV3DataSlot() {
  collectV3SlideInputs();
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m) return;
  m.dataSlots = m.dataSlots || [];
  m.dataSlots.push({ label: '', value: '' });
  renderPlan(currentPlan);
}

function deleteV3DataSlot(index) {
  collectV3SlideInputs();
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m) return;
  m.dataSlots.splice(index, 1);
  renderPlan(currentPlan);
}

function toggleV3Image(src) {
  collectV3SlideInputs();
  const m = currentPlan?.v3Modules?.[activeSlideIdx];
  if (!m) return;
  m.images = Array.isArray(m.images) ? m.images : [];
  if (m.images.includes(src)) m.images = m.images.filter((x) => x !== src);
  else m.images.push(src);
  renderPlan(currentPlan);
  if (activeView === 'script') setTimeout(() => reloadV3Preview(), 50);
}

async function uploadV3Image() {
  const input = document.getElementById('v3ImageUpload');
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const postId = selectedProject?.id || currentPlan?.topic || 'v3_manual';
    const res = await fetch('/api/v35/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, label: '__v3_manual__', filename: file.name, dataUrl: reader.result }),
    });
    const data = await res.json();
    if (!data.ok) return alert(data.error || 'アップロード失敗');
    imageSelections.__v3_manual__ = imageSelections.__v3_manual__ || [];
    imageSelections.__v3_manual__.push(data.url);
    toggleV3Image(data.url);
  };
  reader.readAsDataURL(file);
}

let v3PreviewTimer = null;
function scheduleV3Preview() {
  clearTimeout(v3PreviewTimer);
  v3PreviewTimer = setTimeout(reloadV3Preview, 350);
}

async function reloadV3Preview() {
  collectV3SlideInputs();
  let m = currentPlan?.v3Modules?.[activeSlideIdx];
  // ⑥ v3Modules がなければ scriptDraft から仮モジュールを作る
  if (!m) {
    const s = currentPlan?.autopilotPlan?.scriptDraft?.[activeSlideIdx];
    if (s) m = { type: s.role || 'insight', title: s.title || '', narration: s.narration || '', dataSlots: [], images: [] };
  }
  const frame = document.getElementById('v3PreviewFrame');
  const wrap = document.getElementById('v3PreviewWrap');
  if (!m || !frame || !wrap) return;
  const res = await fetch('/api/v2/preview-slide-inline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module: m }),
  });
  const html = await res.text();
  const blob = new Blob([html], { type: 'text/html' });
  frame.src = URL.createObjectURL(blob);
  frame.style.transform = 'scale(' + ((wrap.clientWidth || 1) / 1920) + ')';
}

function renderResearchOnly() {
  document.getElementById('output').innerHTML = renderResearchPanels() || '<div class="empty">まだリサーチ結果がない。</div>';
}

function renderResearchPanels() {
  let html = '';
  if (currentResearch) {
    html += '<div class="panel"><span class="label">案件リサーチ: 3クエリ → 各3〜5件選抜 → 本文fetch</span>' +
      '<div class="summary-grid">' +
        '<div><h2>Serper推定消費</h2><p>' + esc(currentResearch.serperCreditsEstimated) + ' credits</p></div>' +
        '<div><h2>選抜URL</h2><p>' + esc(currentResearch.summary.selectedUrlCount) + '件 / full text ' + esc(currentResearch.summary.fullTextCount) + '件</p></div>' +
        '<div><h2>検索クエリ</h2><p>' + esc(currentResearch.queries.join(' / ')) + '</p></div>' +
      '</div>' +
      currentResearch.learningCorpus.map((item) => (
        '<div class="research" style="margin-top:10px;">' +
          '<b>[' + esc(item.index) + '] ' + esc(item.title) + '</b><br>' +
          esc(item.host) + ' / score ' + esc(item.score) + ' / ' + esc(item.fetchStatus) + ' / ' + esc(item.usableFor.join(', ')) + '<br>' +
          '<span style="color:var(--muted)">' + esc(item.url) + '</span><br>' +
          esc(String(item.text || '').slice(0, 600)) +
        '</div>'
      )).join('') +
    '</div>';
  }
  if (currentWikiStories) {
    html += '<div class="panel"><span class="label">小話Wiki候補: 主要人物/クラブを最大4件だけ</span>' +
      '<pre>' + esc(JSON.stringify(currentWikiStories, null, 2)) + '</pre>' +
    '</div>';
  }
  return html;
}

function researchStatusLabel() {
  if (currentResearch && currentWikiStories) return '完了: Web / Wiki / side story候補まで取得';
  if (currentResearch) return 'Webリサーチ済み。Wiki候補は未取得';
  return '未実行。まず案件を選んでリサーチ';
}

function researchReadSummary() {
  return {
    webCount: currentResearch?.summary?.selectedUrlCount || 0,
    fullTextCount: currentResearch?.summary?.fullTextCount || 0,
    queries: currentResearch?.queries || [],
    wikiCount: currentWikiStories?.entityCount || 0,
  };
}

function renderSourceSamples() {
  const articles = currentResearch?.learningCorpus || [];
  const wiki = currentWikiStories?.results || [];
  if (!articles.length && !wiki.length) {
    return '<div class="empty">まだ読んだ材料はありません。左の「リサーチ」を押すと、ニュース記事とWiki小話候補をまとめて読みます。</div>';
  }
  return '<div class="flow-list">' +
    articles.slice(0, 6).map((item) => (
      '<div class="flow-item"><b>' + esc(item.title || item.host || 'article') + '</b>' +
      '<p>' + esc((item.host || '') + ' / ' + (item.fetchStatus || '') + ' / score ' + (item.score || '')) + '</p>' +
      '<p>' + esc(String(item.text || '').slice(0, 220)) + '</p></div>'
    )).join('') +
    wiki.slice(0, 4).map((item) => (
      '<div class="flow-item"><b>Wiki: ' + esc(item.entity) + '</b>' +
      '<p>' + esc((item.sideStoryCandidates || []).map((x) => x.text).join(' ').slice(0, 260)) + '</p></div>'
    )).join('') +
  '</div>';
}

function renderCasePickerPanel() {
  const today = document.getElementById('caseDate')?.value || todayLocalDate();
  const groups = {};
  loadedCases.forEach((p, i) => {
    let t = '不明';
    const at = p.addedAt || '';
    if (at.includes('T')) t = at.split('T')[1].slice(0, 5);
    else if (at.includes(':')) t = at.slice(0, 5);
    if (!groups[t]) groups[t] = [];
    groups[t].push({ p, i });
  });
  const caseRows = loadedCases.length ? Object.keys(groups).sort().reverse().map((t) => {
    const rows = groups[t].map(({ p, i }) => {
      const selected = selectedCaseIds.has(p.id);
      const source = String(p.source || 'custom').toLowerCase();
      const badgeClass = source === '5ch' ? 'badge-5ch' : (source === 'reddit' ? 'badge-reddit' : 'badge-custom');
      const badgeLabel = source === '5ch' ? '5ch' : (source === 'reddit' ? 'Reddit' : source);
      return '<div class="case-row' + (selected ? ' selected' : '') + '" onclick="toggleCaseIndex(' + i + ')">' +
        '<input type="checkbox" ' + (selected ? 'checked ' : '') + 'onclick="event.stopPropagation();toggleCaseIndex(' + i + ')">' +
        '<span class="src-badge ' + badgeClass + '">' + esc(badgeLabel) + '</span>' +
        '<span class="case-title">' + esc(p.title || '') + '</span>' +
      '</div>';
    }).join('');
    return '<div class="time-group">' +
      '<div class="time-summary" onclick="toggleCaseGroup(this)">' + esc(t) + ' 取得分 (' + groups[t].length + '件)</div>' +
      '<div class="time-content">' + rows + '</div>' +
    '</div>';
  }).join('') : '<div class="empty">日付を選んで「案件取得」を押してください。</div>';

  return '<div class="panel">' +
      '<span class="label">案件取得</span>' +
      '<div class="case-toolbar">' +
        '<input id="caseDate" type="date" value="' + esc(today) + '">' +
        '<button type="button" onclick="loadCases()">案件取得</button>' +
        '<button class="secondary" type="button" onclick="saveSelectedCases()">選択を保存</button>' +
        '<span class="case-spacer"></span>' +
        '<span class="case-count">' + esc(loadedCases.length) + '件 / 選択 ' + esc(selectedCaseIds.size) + '件</span>' +
      '</div>' +
      '<div id="caseList" class="case-list">' + caseRows + '</div>' +
    '</div>';
}

async function deleteSavedProject(index) {
  const item = savedProjects[index];
  if (!item) return;
  if (!confirm('"' + (item.title || item.id) + '" を削除しますか？')) return;
  savedProjects = savedProjects.filter(function(_, i) { return i !== index; });
  if (selectedProject?.id === item.id) {
    selectedProject = null;
    const t = document.getElementById('title');
    const m = document.getElementById('memo');
    const s = document.getElementById('sourceType');
    if (t) t.value = '';
    if (m) m.value = '';
    if (s) s.value = 'custom';
  }
  await persistSavedProjects();
  await loadSaved();
  renderPlan(currentPlan);
}

function goToProposal() {
  if (!selectedProject && !document.getElementById('title')?.value) return alert('先に案件を選んでください');
  activeView = 'proposal';
  renderPlan(currentPlan);
}

function renderSavedView(plan) {
  plan = plan || {};
  const selectedTitle = document.getElementById('title')?.value || selectedProject?.title || '';
  const selectedSource = document.getElementById('sourceType')?.value || selectedProject?.source || 'custom';

  if (!savedProjects.length) {
    return '<div class="panel">' +
      '<span class="label">保存済み案件</span>' +
      '<div class="empty">保存済み案件がありません。Step1で案件を取得・保存してください。</div>' +
      '<div class="task-actions"><button class="secondary" onclick="setResultView(\\'case\\')">← 1 案件取得へ</button></div>' +
    '</div>';
  }

  const listHtml = savedProjects.slice().reverse().slice(0, 50).map(function(item, revIndex) {
    const index = savedProjects.length - 1 - revIndex;
    const active = selectedProject?.id && selectedProject.id === item.id;
    const source = String(item.source || 'custom').toLowerCase();
    const badgeClass = source === '5ch' ? 'badge-5ch' : (source === 'reddit' ? 'badge-reddit' : 'badge-custom');
    const badgeLabel = source === '5ch' ? '5ch' : (source === 'reddit' ? 'Reddit' : 'カスタム');
    const dateStr = (item.addedAt || '').slice(0, 10);
    return '<div class="case-row' + (active ? ' selected' : '') + '" style="align-items:center;">' +
      '<span class="src-badge ' + badgeClass + '" style="flex-shrink:0;cursor:pointer;" onclick="selectSavedProject(' + index + ')">' + esc(badgeLabel) + '</span>' +
      '<span class="case-title" style="cursor:pointer;" onclick="selectSavedProject(' + index + ')">' + esc(item.title || item.id) + '</span>' +
      '<span style="color:var(--muted);font-size:11px;flex-shrink:0;cursor:pointer;" onclick="selectSavedProject(' + index + ')">' + esc(dateStr) + '</span>' +
      '<button class="secondary" style="flex-shrink:0;min-height:26px;padding:0 7px;font-size:11px;margin-left:4px;" onclick="event.stopPropagation();deleteSavedProject(' + index + ')">削除</button>' +
    '</div>';
  }).join('');

  return '<div class="panel">' +
    '<span class="label">保存済み案件 — ' + savedProjects.length + '件</span>' +
    '<div class="case-list" style="max-height:calc(100vh - 360px);min-height:180px;">' + listHtml + '</div>' +
    '<div class="task-actions" style="margin-top:12px;">' +
      '<button ' + (!selectedTitle ? 'disabled ' : '') + 'onclick="goToProposal()">3 企画提案へ進む →</button>' +
      '<button class="secondary" onclick="setResultView(\\'case\\')">← 1 案件取得</button>' +
    '</div>' +
  '</div>';
}

function renderCaseFetchView() {
  return '<div class="panel">' +
      '<span class="label">Step0 案件取得画面</span>' +
      '<div class="task-status">Reddit / 5ch の取得済み候補を日付で読み込み、使う案件を保存します。</div>' +
    '</div>' +
    renderCasePickerPanel();
}

function renderCaseView(plan) {
  plan = plan || {};
  return renderCasePickerPanel() +
    '<div class="panel">' +
      '<span class="label">カスタム案件入力</span>' +
      '<input id="customCaseTitle" placeholder="例: 久保建英、移籍報道の温度感" style="margin-bottom:8px;">' +
      '<label class="label" style="margin-top:8px;">概要・気になる点</label>' +
      '<textarea id="customCaseMemo" style="min-height:72px;" placeholder="記事URL、相棒メモ、見たい切り口を短く書く"></textarea>' +
      '<div class="task-actions">' +
        '<button onclick="saveCustomCase()">保存</button>' +
        '<button class="secondary" onclick="setResultView(\\'saved\\')">2 保存済み →</button>' +
      '</div>' +
    '</div>';
}

function renderSelectedCaseBox() {
  const title = document.getElementById('title')?.value || selectedProject?.title || selectedProject?.titleJa || '';
  const source = document.getElementById('sourceType')?.value || selectedProject?.source || '';
  if (!title) {
    return '<div class="case-badge empty-badge">案件未選択 — Step1で案件を選んでください</div>';
  }
  return '<div class="case-badge">' +
    '<span class="chip">' + esc(source || 'custom') + '</span>' +
    '<b>' + esc(title) + '</b>' +
  '</div>';
}

function renderResearchActionPanel() {
  return '<div class="research-action-inline">' +
    '<div class="research-action-row">' +
      '<button id="proposalStepBtn" onclick="runProposal()">調査</button>' +
    '</div>' +
    '<div class="research-flow"><span class="research-step">1/5 検索クエリを作成 → 2/5 記事取得 → 3/5 ラベル作成 → 4/5 無料データ取得 → 5/5 企画書A/B/C</span></div>' +
    '<div id="proposalRunStatus" class="task-status">調査を押すと、今どの段階かをここに表示します。</div>' +
  '</div>';
}

function labelTypeJa(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'player') return '選手';
  if (t === 'manager') return '監督';
  if (t === 'team' || t === 'club') return 'チーム';
  if (t === 'match') return '試合';
  if (t === 'wiki') return 'Wiki';
  return '関連';
}

function renderLabelCandidateChips(labels) {
  const seen = new Set();
  const list = (labels || []).map(function(item) {
    if (typeof item === 'string') return { name: item, type: 'entity' };
    return { name: item.name || item.nameEn || item.label || '', type: item.type || 'entity' };
  }).filter(function(item) {
    const key = String(item.name || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
  if (!list.length) return '<span class="chip">候補なし</span>';
  return list.map(function(item) {
    return '<span class="chip">' + esc(item.name) + ' <b style="color:#f2b84b;">[' + esc(labelTypeJa(item.type)) + ']</b></span>';
  }).join('');
}

function renderStep2CostMeta(costSummary) {
  const aiCost = costSummary ? ('AI実績: ' + (costSummary.calls || 0) + '回 / $' + (costSummary.totalUsd || 0) + ' / 約' + (costSummary.totalJpy || 0) + '円') : 'AI実績: 実行後に集計';
  const rows = [
    ['Step2-1', 'AI + Serper', 'Geminiで検索ラベル作成 / Serper 3検索', '低〜中', '現状GeminiでOK', 'Serper検索のみ。webshare圧迫ほぼなし'],
    ['Step2-2', '記事取得 + AI整形', 'Serper結果 + 記事本文fetch + Geminiで日本語タイトル化', '低', '現状GeminiでOK', '本文fetchで軽〜中。大量取得はしない'],
    ['Step2-3', 'AI', 'Geminiで本筋ラベル抽出', '低', '現状GeminiでOK', 'webshareなし'],
    ['Step2-4', '無料データ取得', 'SofaScore / Transfermarkt / Wiki', 'Serperなし', 'AIなし', 'SofaScore/TM取得で中。対象数を絞る'],
    ['Step2-5', 'AI', 'DeepSeekで企画書A/B/C生成', '中', '重い時はGemini 2.5系も検討', 'webshareなし'],
  ];
  return '<div class="evidence-item" style="background:#0d1220;">' +
    '<b>実行コスト / AI / 帯域メモ</b><p style="margin:4px 0 8px;color:var(--muted);font-size:12px;">' + esc(aiCost) + '</p>' +
    rows.map(function(row) {
      return '<div style="display:grid;grid-template-columns:70px 1fr;gap:6px;border-top:1px solid var(--line);padding:6px 0;font-size:11px;line-height:1.45;">' +
        '<b style="color:#f2b84b;">' + esc(row[0]) + '</b>' +
        '<div>' + esc(row[1]) + ' / ' + esc(row[2]) + '<br><span style="color:var(--muted);">コスト: ' + esc(row[3]) + ' / AI変更: ' + esc(row[4]) + ' / 帯域: ' + esc(row[5]) + '</span></div>' +
      '</div>';
    }).join('') +
  '</div>';
}

function renderFetchedDataCards(items) {
  const ok = (items || []).filter(function(d) { return d && d.ok; });
  if (!ok.length) return '<div class="evidence-item"><span class="chip">取得データなし</span></div>';
  return ok.map(function(d) {
    const slots = (d.slots || []).slice(0, 10);
    return '<div class="evidence-item">' +
      '<b>' + esc(d.nameEn || '') + ' <span class="chip">' + esc(labelTypeJa(d.type)) + '</span></b>' +
      '<div class="chips" style="margin-top:6px;">' +
        (slots.length ? slots.map(function(s) {
          return '<span class="chip">' + esc(s.label || '') + ': ' + esc(s.value || '-') + '</span>';
        }).join('') : '<span class="chip">' + esc(d.summary || '取得OK') + '</span>') +
      '</div>' +
      '<div class="source-url">' + esc(d.sourceTitle || '') + '</div>' +
    '</div>';
  }).join('');
}

function renderAcquiredDataView() {
  const data = currentAcquiredData || buildAcquiredDataSummary();
  const hasAny = (data.queries || []).length || (data.webSources || []).length || (data.structuredData || []).length;
  if (!hasAny) {
    return '<div class="panel evidence-section"><span class="label">調査で得た材料</span><div class="empty">まだ調査していません。「調査」を押すと、検索クエリ・Web記事・取得データ候補をここに明示します。</div></div>';
  }
  const fetchedOk = (currentFetchedData || []).filter(d => d.ok);
  const fetchedFail = (currentFetchedData || []).filter(d => !d.ok);
  const fetchedBlock = '' && currentFetchedData
    ? '<div class="panel" style="margin-bottom:10px;">' +
        '<span class="label">SofaScore取得済みデータ</span>' +
        (fetchedOk.length
          ? '<div class="chips" style="margin-top:6px;">' +
              fetchedOk.map(d => '<span class="chip" style="background:#0f2a1a;border-color:#22c55e;color:#bbf7d0;">' + esc(d.nameEn) + ': ' + esc(d.summary) + '</span>').join('') +
            '</div>'
          : '') +
        (fetchedFail.length
          ? '<div class="chips" style="margin-top:4px;">' +
              fetchedFail.map(d => '<span class="chip" style="background:#2a0f0f;border-color:#ef4444;color:#fca5a5;">' + esc(d.nameEn) + ' 取得失敗</span>').join('') +
            '</div>'
          : '') +
        (fetchedOk.length === 0 && fetchedFail.length === 0
          ? '<div class="task-status">SofaScore対象エンティティが検出されませんでした。</div>'
          : '') +
      '</div>'
    : '';
  const summary = 'Web ' + (data.webSources || []).length + '件 / 本文取得 ' + (data.webSources || []).filter((s) => s.fetchStatus === 'full_text' || s.fetchStatus === 'full_text_reader').length + '件 / 関連候補 ' + (data.entities || []).length + '件';
  return '<div class="panel evidence-section">' +
    '<details>' +
    '<summary class="label" style="cursor:pointer;user-select:none;">調査で得た材料 — ' + esc(summary) + '</summary>' +
    '<div class="evidence-list">' + renderStep2CostMeta(data.costSummary) + '</div>' +
    '<h3 class="research-heading">Step2-1 検索クエリ作成</h3>' +
    '<div class="evidence-list">' +
      '<div class="evidence-item">' +
        ((data.queryLabels || []).length ? '<b>案件ラベル</b><div class="chips" style="margin:6px 0;">' + (data.queryLabels || []).map((q) => '<span class="chip">' + esc(q) + '</span>').join('') + '</div>' : '') +
        '<b>検索クエリ</b><div class="chips" style="margin-top:6px;">' + (data.queries || []).map((q) => '<span class="chip">' + esc(q) + '</span>').join('') + '</div>' +
      '</div>' +
    '</div>' +
    '<h3 class="research-heading">Step2-2 ニュースhit一覧</h3>' +
    '<div class="evidence-list">' + (data.webSources || []).map((item) =>
      '<div class="evidence-item"><b>' + esc(item.title) + '</b><div class="chips"><span class="chip">' + esc(item.host || 'source') + '</span><span class="chip">' + esc(item.fetchStatus || 'snippet') + '</span></div><div class="source-url">' + esc(item.url) + '</div></div>'
    ).join('') + '</div>' +
    '<h3 class="research-heading">Step2-3 本筋ラベル候補</h3>' +
    '<div class="evidence-list">' +
      '<div class="evidence-item"><div class="chips">' + renderLabelCandidateChips(data.labelCandidates || data.entities || []) + '</div></div>' +
    '</div>' +
    '<h3 class="research-heading">Step2-4 無料データ取得結果</h3>' +
    '<div class="evidence-list">' +
      renderFetchedDataCards(fetchedOk) +
      (fetchedFail.length ? '<div class="evidence-item"><div class="chips">' + fetchedFail.map(d => '<span class="chip" style="border-color:#ef4444;color:#fca5a5;">' + esc(d.nameEn) + ' 取得失敗</span>').join('') + '</div></div>' : '') +
    '</div>' +
    '<h3 class="research-heading">Step2-5 企画書A/B/Cの材料</h3>' +
    '<div class="evidence-list">' + ((data.articleDigest?.bullets || []).map((item) =>
      '<div class="evidence-item"><b>' + esc(item.label) + '</b><p>' + esc(item.text || '') + '</p></div>'
    ).join('')) + '</div>' +
    '</details>' +
  '</div>';
}


function fallbackCandidateSlideOutline(topic, count) {
  const base = [
    { slideType: 'opening', headline: '何が起きたのか', point: topic + 'の違和感を冒頭で提示する。', dataNeeds: [] },
    { slideType: 'simple', headline: 'ニュース概要', point: '確認できた事実を短く整理する。', dataNeeds: [] },
    { slideType: 'insight', headline: 'なぜ重要なのか', point: 'この話題が視聴者に関係する理由を説明する。', dataNeeds: [] },
    { slideType: 'stats', headline: '数字で確認', point: '取得済みデータで主張を補強する。', dataNeeds: [] },
    { slideType: 'history', headline: '背景と経緯', point: '過去の流れや人間ドラマを足して文脈を作る。', dataNeeds: [] },
    { slideType: 'reaction', headline: '海外反応', point: 'Redditや海外ファンの反応で温度感を入れる。', dataNeeds: [] },
    { slideType: 'insight', headline: '最終論点', point: 'ここまでの材料を一つの見方にまとめる。', dataNeeds: [] },
    { slideType: 'ending', headline: '結論', point: '冒頭の問いに答え、コメントしたくなる形で締める。', dataNeeds: [] },
  ];
  return base.slice(0, Math.max(4, Math.min(count || 6, base.length))).map((item, index, arr) => ({
    ...item,
    no: index + 1,
    slideType: index === 0 ? 'opening' : (index === arr.length - 1 ? 'ending' : item.slideType),
  }));
}

function fallbackProposalCandidates(plan, defaultNeeds) {
  const topic = plan.topic || document.getElementById('title')?.value || 'この案件';
  return [
    {
      angle: topic + ' の背景を分解する',
      hookQuestion: topic + ' の本質は何か？',
      answer: '取得データをもとに、表面的な見方を超えた背景と構造を説明する。',
      storyPattern: 'ニュース解説型',
      dataNeeds: defaultNeeds,
      risk: '事実確認・数字の出典を固定する。',
    },
    {
      angle: 'データで見る ' + topic,
      hookQuestion: topic + '、数字は何を示しているか？',
      answer: 'スタッツと文脈を組み合わせ、なぜこの結果が起きたかを具体的に示す。',
      storyPattern: 'データ検証型',
      dataNeeds: defaultNeeds,
      risk: '統計の前提・対象期間を明示する。',
    },
    {
      angle: topic + ' の今後を読む',
      hookQuestion: topic + ' から、何が変わるのか？',
      answer: '過去のデータと現状分析を軸に、今後への影響を視聴者に分かりやすく伝える。',
      storyPattern: '選手深掘り型',
      dataNeeds: defaultNeeds,
      risk: '将来予測は推測と明示する。',
    },
  ].map((item, index) => {
    const meta = [
      { videoLengthType: 'short', targetMinutes: '1.5-2.5', recommendedSlideCount: 4 },
      { videoLengthType: 'standard', targetMinutes: '3-4', recommendedSlideCount: 6 },
      { videoLengthType: 'long', targetMinutes: '5-6', recommendedSlideCount: 8 },
    ][index] || {};
    return { ...item, ...meta, title: topic, slideOutline: fallbackCandidateSlideOutline(topic, meta.recommendedSlideCount) };
  });
}

function renderProposalPapers(plan) {
  const auto = plan.autopilotPlan || {};
  if (!auto.aiGenerated && !auto.aiFallback) {
    return '<div class="panel"><span class="label">4. 企画書A / B / C生成</span>' +
      '<div class="task-status">「調査」ボタンを押すと、企画書A / B / C が表示されます。</div></div>';
  }
  const proposal = auto.themeProposal || {};
  let candidates = proposal.candidates || [];
  const selectedIdx = proposal.selected || 0;
  const briefing = auto.briefing || {};
  const chapters = briefing.chapters || [];
  const summary = researchReadSummary();
  const basisText = auto.aiGenerated
    ? 'Web ' + summary.webCount + '件・本文 ' + summary.fullTextCount + '件・Wiki ' + summary.wikiCount + '件を読んで生成'
    : '調査後、ここに企画書A/B/Cを表示します。';
  const fallbackPurpose = briefing.purpose || plan.viewerPromise || 'この話題の違和感を、事実とデータで説明する。';
  const fallbackChapters = chapters.length ? chapters : [
    { role: 'hook', claim: plan.centralQuestion || 'まず何が異常なのかを提示する。' },
    { role: 'context', claim: 'ニュースの背景と前提条件を整理する。' },
    { role: 'data', claim: '確認できた記事・数字・関係者情報を並べる。' },
    { role: 'answer', claim: '視聴者が納得できる答えにまとめる。' },
  ];
  const defaultNeeds = (briefing.dataPlan || plan.researchDesign?.tasks || [])
    .map((x) => x.need || x.expectedOutput || x.query || x)
    .filter(Boolean)
    .slice(0, 8);
  const fallbackCandidates = fallbackProposalCandidates(plan, defaultNeeds);
  candidates = [0, 1, 2].map((i) => {
    const c = candidates[i] || {};
    const hasCore = c.angle || c.title || c.hookQuestion || c.hook || c.answer;
    return hasCore ? { ...fallbackCandidates[i], ...c } : fallbackCandidates[i];
  });

  return '<div class="panel">' +
    '<span class="label">企画提案 A / B / C</span>' +
    '<div class="task-status">' + esc(basisText) + '</div>' +
    '<div class="proposal-paper-grid">' +
      candidates.slice(0, 3).map(function(c, i) {
        const letter = String.fromCharCode(65 + i);
        const isSelected = i === selectedIdx;
        const dataNeeds = (c.dataNeeds && c.dataNeeds.length ? c.dataNeeds : defaultNeeds);
        const angle = c.angle || c.title || c.hookQuestion || plan.angle || plan.topic || '調査結果から切り口を作る';
        const hook = c.hookQuestion || c.hook || plan.centralQuestion || plan.topic || 'この話題の本質は何か？';
        const answer = c.answer || briefing.coreMessage || plan.thesis || '取得データをもとに仮説を検証する。';
        const lengthText = (c.videoLengthType || 'standard') + ' / ' + (c.targetMinutes || '3-4') + '分 / ' + (c.recommendedSlideCount || (Array.isArray(c.slideOutline) ? c.slideOutline.length : 6)) + '枚目安';
        const storyPattern = c.storyPattern || briefing.storyPattern || proposal.storyPattern || 'ニュース解説型';
        if (!isSelected) {
          return '<div class="briefing-paper briefing-paper--compact">' +
            '<h2>企画書' + letter + '</h2>' +
            '<p class="proposal-hook-text">' + esc(hook) + '</p>' +
            '<hr class="proposal-divider">' +
            '<div class="proposal-meta-grid">' +
              '<div><span class="label">切り口</span><p>' + esc(angle) + '</p></div>' +
              '<div><span class="label">仮の答え</span><p>' + esc(answer) + '</p></div>' +
              '<div><span class="label">構成タイプ</span><p>' + esc(storyPattern) + '</p></div>' +
              '<div><span class="label">尺 / 枚数</span><p>' + esc(lengthText) + '</p></div>' +
            '</div>' +
            (c.risk ? '<p style="color:#fca5a5;font-size:12px;margin-top:6px;">⚠ ' + esc(c.risk) + '</p>' : '') +
            '<div class="task-actions"><button onclick="selectThemeCandidate(' + i + ')">この企画書を採用</button></div>' +
          '</div>';
        }
        const outline = Array.isArray(c.slideOutline) && c.slideOutline.length ? c.slideOutline : fallbackChapters.map((item, idx) => ({ no: idx + 1, slideType: item.slideType || item.role || 'insight', headline: item.headline || item.role || '', point: item.claim || '' }));
        const slideTypeBadge = (type) => {
          const colors = { opening: '#2563eb', history: '#7c3aed', comparison: '#0891b2', stats: '#b45309', profile: '#065f46', insight: '#1e40af', ending: '#374151' };
          return '<span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:900;background:' + (colors[type] || '#374151') + ';color:#fff;margin-right:4px;">' + esc(type || 'insight') + '</span>';
        };
        return '<div class="briefing-paper selected">' +
          '<span class="label" style="font-size:10px;color:var(--muted);">採用中: 企画' + letter + '</span>' +
          '<p class="proposal-hook-text">' + esc(hook) + '</p>' +
          '<hr class="proposal-divider">' +
          '<div class="proposal-meta-grid">' +
            '<div><span class="label">切り口</span><p>' + esc(angle) + '</p></div>' +
            '<div><span class="label">仮の答え</span><p>' + esc(answer) + '</p></div>' +
            '<div><span class="label">構成タイプ</span><p>' + esc(storyPattern) + '</p></div>' +
            '<div><span class="label">尺 / 枚数</span><p>' + esc(lengthText) + '</p></div>' +
          '</div>' +
          '<hr class="proposal-divider">' +
          '<span class="label">スライド構成案（' + outline.length + '枚）</span>' +
          '<div class="slide-list" style="margin:6px 0 10px;gap:4px;">' +
            outline.slice(0, 12).map((item) => (
              '<div style="display:grid;grid-template-columns:auto 1fr;gap:6px;align-items:start;background:#0a0d12;border:1px solid var(--line);border-radius:6px;padding:7px 9px;">' +
                '<div>' + slideTypeBadge(item.slideType || item.role) + '</div>' +
                '<div><div style="font-size:12px;font-weight:700;color:var(--text);">' + esc(item.headline || item.role || '') + '</div>' +
                (item.point ? '<div style="font-size:11px;color:var(--muted);margin-top:2px;">' + esc(String(item.point).slice(0, 80)) + '</div>' : '') +
                ((item.dataNeeds || []).length ? '<div class="chips" style="margin-top:3px;">' + (item.dataNeeds || []).slice(0, 3).map(d => '<span class="chip" style="font-size:9px;">' + esc(d) + '</span>').join('') + '</div>' : '') +
                '</div>' +
              '</div>'
            )).join('') +
          '</div>' +
          '<span class="label">必要データ</span><div class="chips" style="margin:4px 0 10px;">' +
            dataNeeds.slice(0, 8).map((x) => {
              const need = x.need || x;
              const hit = (currentFetchedData || []).some(d => d.ok && d.nameEn.toLowerCase().split(' ').some(p => String(need).toLowerCase().includes(p)));
              return '<span class="chip" style="' + (hit ? 'border-color:#22c55e;color:#bbf7d0;' : '') + '">' + (hit ? '✅ ' : '❓ ') + esc(need) + '</span>';
            }).join('') +
          '</div>' +
          (c.risk ? '<span class="label" style="color:#f87171;">注意点</span><p style="color:#fecaca;margin:4px 0 10px;font-size:13px;">' + esc(c.risk) + '</p>' : '') +
          '<div class="task-actions"><button disabled>採用中</button><button class="secondary" onclick="setResultView(\\'briefing\\')">企画書を確認 →</button></div>' +
        '</div>';
      }).join('') +
    '</div>' +
    (proposal.selectedReason ? '<div class="task-status">採用理由: ' + esc(proposal.selectedReason) + '</div>' : '') +
  '</div>';
}

function renderProposalView(plan) {
  plan = plan || {};
  let html = renderSelectedCaseBox();
  html += renderResearchActionPanel();
  html += renderAcquiredDataView();
  html += renderProposalPapers(plan);
  html += renderProposalDataGapGate(plan);
  return html;
}

function renderProposalDataGapGate(plan) {
  const auto = plan?.autopilotPlan || {};
  if (!auto.aiGenerated && !auto.aiFallback) return '';
  const missing = (auto.mustCheck || []).map((x) => x.need || x).filter(Boolean).slice(0, 8);
  const gates = (auto.publishGates || []).filter(Boolean).slice(0, 8);
  const fetched = (currentFetchedData || []).filter((d) => d.ok).slice(0, 8);
  return '<div class="panel">' +
    '<span class="label">STEP2-6 不足データ確認</span>' +
    '<div class="task-status">企画書タブへ進む前に、採用案で足りない材料を確認します。必要ならSTEP2-4の無料データ取得から再調査します。</div>' +
    '<div class="proposal-meta-grid">' +
      '<div><span class="label">不足データ</span><div class="chips">' +
        (missing.length ? missing.map((x) => '<span class="chip">' + esc(x) + '</span>').join('') : '<span class="chip" style="border-color:#22c55e;color:#bbf7d0;">大きな不足なし</span>') +
      '</div></div>' +
      '<div><span class="label">公開前チェック</span><div class="chips">' +
        (gates.length ? gates.map((x) => '<span class="chip">' + esc(x) + '</span>').join('') : '<span class="chip" style="border-color:#22c55e;color:#bbf7d0;">追加チェックなし</span>') +
      '</div></div>' +
      '<div><span class="label">取得済み無料データ</span><div class="chips">' +
        (fetched.length ? fetched.map((d) => '<span class="chip" style="border-color:#22c55e;color:#bbf7d0;">' + esc(d.nameEn || d.label || '') + '</span>').join('') : '<span class="chip">未取得</span>') +
      '</div></div>' +
    '</div>' +
    '<label class="label" style="margin-top:10px;">追加指示</label>' +
    '<textarea id="gapResearchInstruction" style="min-height:72px;margin-top:6px;" placeholder="例: 落選したフォーデンとパーマーの今季成績・代表実績・落選理由を優先して再調査"></textarea>' +
    '<div class="task-actions">' +
      '<button class="secondary" onclick="runProposalWithGapInstructions()">不足データを再調査</button>' +
      '<button onclick="setResultView(\\'briefing\\')">STEP3 企画書へ</button>' +
    '</div>' +
  '</div>';
}


function renderBoundResearchCards(plan) {
  const bound = (plan.researchDesign?.tasks || [])
    .filter((task) => task.status === 'candidate_bound')
    .slice(0, 6);
  if (!bound.length) return '';
  return '<div class="autopilot-card" style="grid-column:1/-1;"><h2>仮バインド済みの確認候補</h2>' +
    '<div class="flow-list">' +
      bound.map(function(task) {
        return '<div class="flow-item"><b>' + esc(task.need) + '</b>' +
          '<p>' + esc(task.sourceTitle || task.sourceUrl || '') + '</p>' +
          '<p>' + esc(String(task.valueCandidate || '').slice(0, 180)) + '</p>' +
          '<div class="chips"><span class="chip">' + esc(task.confidence) + '</span><span class="chip">' + esc(task.sourceUrl || '') + '</span></div>' +
        '</div>';
      }).join('') +
    '</div></div>';
}


function formatBriefingText(plan) {
  const briefing = plan.autopilotPlan?.briefing || {};
  const proposal = plan.autopilotPlan?.themeProposal || {};
  const selected = (proposal.candidates || [])[proposal.selected || 0] || {};
  const chapters = briefing.chapters || [];
  const dataPlan = briefing.dataPlan || [];
  const slideOutline = briefing.slideOutline || buildBriefingSlideOutline(plan);
  const risks = briefing.riskChecklist || [];
  const storyPattern = briefing.storyPattern || selected.storyPattern || proposal.storyPattern || '';
  const blocks = [
    '【動画のテーマ】',
    selected.angle || proposal.angle || plan.topic || '',
    '',
    '【構成タイプ】',
    storyPattern,
    '',
    '【動画の約束】',
    briefing.purpose || plan.viewerPromise || '',
    '',
    '【中心メッセージ】',
    briefing.coreMessage || plan.thesis || '',
    '',
    '【全体の流れ】',
    chapters.map((item) => (item.no || '') + '. ' + (item.role || '') + ' - ' + (item.claim || '')).join('\\n') || '',
    '',
    '【スライド構成】',
    slideOutline.map((item) => {
      const data = (item.dataNeeds || []).length ? ' / データ: ' + item.dataNeeds.join('、') : '';
      const check = item.productionCheck ? ' / 確認: ' + item.productionCheck : '';
      return (item.no || '') + '. [' + (item.slideType || 'insight') + '] ' + (item.headline || '') + ' - ' + (item.point || '') + data + check;
    }).join('\\n') || '',
    '',
    '【使うデータ】',
    dataPlan.map((x) => '- ' + (x.need || x)).join('\\n') || '',
    '',
    '【脚本指示】',
    briefing.scriptInstructions || '企画提案の採用案から外れない。断定できない数字は言い切らない。熱量は上げるが、根拠のない煽りは入れない。',
    '',
    '【注意点】',
    risks.map((x) => '- ' + x).join('\\n') || '',
  ];
  const generated = blocks.join('\\n').trim();
  if (!briefing.rawText) return generated;

  const raw = String(briefing.rawText || '').trim();
  const hasSection = (text, name) => new RegExp('【' + name + '】').test(text);
  const sectionText = (name) => {
    const m = generated.match(new RegExp('【' + name + '】([\\\\s\\\\S]*?)(?=\\\\n【|$)'));
    return m ? '【' + name + '】\\n' + m[1].trim() : '';
  };
  const missingSections = ['動画のテーマ', '構成タイプ', 'スライド構成', '脚本指示']
    .filter((name) => !hasSection(raw, name))
    .map(sectionText)
    .filter(Boolean);
  return missingSections.length ? raw + '\\n\\n' + missingSections.join('\\n\\n') : raw;
}

function buildBriefingSlideOutline(plan) {
  const briefing = plan.autopilotPlan?.briefing || {};
  const chapters = briefing.chapters || [];
  const dataPlan = briefing.dataPlan || [];
  const total = chapters.length || 6;
  return (chapters.length ? chapters : [{ no: 1, role: 'hook', claim: plan.centralQuestion || plan.topic || 'Opening', dataNeeds: [] }]).map((item, index) => {
    const needs = Array.isArray(item.dataNeeds) && item.dataNeeds.length
      ? item.dataNeeds
      : dataPlan.slice(index, index + 1).map((x) => x.need || x).filter(Boolean);
    const type = item.slideType || chooseV3ModuleType({
      role: item.role,
      headline: item.headline || item.title || item.role,
      point: item.point || item.claim,
      claim: item.claim,
    }, index, total, needs);
    return {
      no: item.no || index + 1,
      role: item.role || 'chapter',
      headline: item.headline || item.title || item.role || ('Slide ' + (index + 1)),
      point: item.point || item.claim || '',
      slideType: type,
      dataNeeds: needs,
    };
  });
}

function updateBriefingFromEditor() {
  if (!currentPlan) return;
  const el = document.getElementById('briefingText');
  const rawText = el ? el.value : formatBriefingText(currentPlan);
  const auto = currentPlan.autopilotPlan || (currentPlan.autopilotPlan = {});
  const briefing = auto.briefing || (auto.briefing = {});
  briefing.rawText = rawText;
  const section = (name) => {
    const m = rawText.match(new RegExp('【' + name + '】([\\s\\S]*?)(?=\\r?\\n【|$)'));
    return m ? m[1].replace(/^\\r?\\n/, '').trim() : '';
  };
  briefing.theme = section('動画のテーマ') || briefing.theme || '';
  briefing.storyPattern = section('構成タイプ') || briefing.storyPattern || '';
  briefing.purpose = section('動画の約束') || briefing.purpose || '';
  briefing.coreMessage = section('中心メッセージ') || briefing.coreMessage || '';
  const flow = section('全体の流れ');
  if (flow) {
    const flowLines = flow.split(/\\r?\\n+/).map(l => l.trim()).filter(Boolean);
    if (flowLines.length) {
      briefing.chapters = flowLines.map((line, i) => {
        const clean = line.replace(/^[-・\\d.\\s]+/, '').trim();
        const parts = clean.split(/\\s+-\\s+/);
        return { no: i + 1, role: parts[0] || 'chapter', claim: parts.slice(1).join(' - ') || clean };
      }).filter((x) => x.claim || x.role);
    }
  }
  const data = section('使うデータ');
  if (data) {
    const dataLines = data.split(/\\r?\\n+/).map(l => l.replace(/^[-・\\s]+/, '').trim()).filter(Boolean);
    if (dataLines.length) briefing.dataPlan = dataLines.map(need => ({ need }));
  }
  const slides = section('スライド構成');
  if (slides) {
    const slideLines = slides.split(/\\r?\\n+/).map(l => l.trim()).filter(Boolean);
    if (slideLines.length) {
      briefing.slideOutline = slideLines.map((line, i) => {
        const m = line.match(/^(\\d+)[.)、]?\\s*(?:\\[([^\\]]+)\\])?\\s*([\\s\\S]*?)$/);
        const body = (m ? m[3] : line).trim();
        const dashIdx = body.indexOf(' - ');
        const headline = dashIdx >= 0 ? body.slice(0, dashIdx).trim() : body;
        const rest = dashIdx >= 0 ? body.slice(dashIdx + 3).trim() : '';
        const dataMarker = rest.indexOf(' / データ:');
        const checkMarker = rest.indexOf(' / 確認:');
        const firstMarker = [dataMarker, checkMarker].filter((x) => x >= 0).sort((a, b) => a - b)[0];
        const point = firstMarker >= 0 ? rest.slice(0, firstMarker).trim() : rest;
        const dataNeeds = dataMarker >= 0
          ? rest.slice(dataMarker + 7, checkMarker >= 0 ? checkMarker : undefined).split(/[、,]/).map(x => x.trim()).filter(Boolean)
          : [];
        const productionCheck = checkMarker >= 0 ? rest.slice(checkMarker + 6).trim() : '';
        return {
          no: m ? Number(m[1]) : i + 1,
          slideType: (m && m[2]) || '',
          headline: headline || ('Slide ' + (i + 1)),
          point,
          dataNeeds,
          productionCheck,
        };
      });
    }
  } else {
    briefing.slideOutline = buildBriefingSlideOutline(currentPlan);
  }
  briefing.scriptInstructions = section('脚本指示') || briefing.scriptInstructions || '';
}

function chooseV3ModuleType(item, index, total, needs) {
  if (index === 0) return 'opening';
  if (index === total - 1) return 'ending';
  const text = [
    item.role,
    item.slideType,
    item.type,
    item.title,
    item.headline,
    item.point,
    item.claim,
    ...(Array.isArray(needs) ? needs : []),
  ].join(' ');
  if (/history|context|過去|昔|年表|経緯|来歴|移籍|2010|W杯/i.test(text)) return 'history';
  if (/contrast|comparison|vs|比較|対比|一方|バルサ|マドリー|Barcelona|Real Madrid/i.test(text)) return 'comparison';
  if (/profile|人物|選手|監督|プロフィール|経歴|年齢|所属|クラブ/i.test(text)) return 'profile';
  if (/stats|evidence|data|人数|数値|得点|ゴール|アシスト|評価|順位|勝点|市場価値|出場|リスト|一覧/i.test(text)) return 'stats';
  return 'insight';
}

function normalizeV3ProductionType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'simple') return 'insight';
  const allowed = new Set(['opening','insight','stats','profile','reaction','comparison','history','matchcard','ranking','timeline','picture','ending','universal']);
  return allowed.has(t) ? t : 'insight';
}

function allowsV3StatData(type) {
  return ['stats', 'profile', 'comparison', 'ranking', 'matchcard'].includes(String(type || '').toLowerCase());
}

function makeModulesFromCurrentPlan() {
  if (!currentPlan) return [];
  const auto = currentPlan.autopilotPlan || {};
  const structure = Array.isArray(auto.scriptStructure) ? auto.scriptStructure : [];
  const slideOutline = auto.briefing?.slideOutline || [];
  const chapters = auto.briefing?.chapters || [];
  const sourceTasks = currentPlan.researchDesign?.tasks || [];
  const rows = (structure.length ? structure : (slideOutline.length ? slideOutline : chapters)).map((item, index) => ({
    slideNo: item.no || index + 1,
    role: item.role || 'chapter',
    title: item.headline || item.title || item.role || 'Slide ' + (index + 1),
    point: item.point || item.claim || '',
    narration: '',
    dataNeeds: item.dataNeeds || [],
    selectedData: item.selectedData || auto.scriptDraft?.[index]?.selectedData || [],
    slideType: item.slideType || item.type || '',
  }));
  if (!rows.length) {
    rows.push({
      slideNo: 1,
      role: 'opening',
      title: currentPlan.topic || document.getElementById('title')?.value || 'Opening',
      point: auto.briefing?.coreMessage || currentPlan.thesis || '',
      narration: '',
      dataNeeds: (auto.briefing?.dataPlan || []).map((x) => x.need).slice(0, 3),
    });
  }
  const total = rows.length;
  return rows.map((item, index) => {
    const needs = Array.isArray(item.dataNeeds) ? item.dataNeeds : [];
    const conceptualType = item.slideType || chooseV3ModuleType(item, index, total, needs);
    const type = normalizeV3ProductionType(conceptualType);
    const allowStatData = allowsV3StatData(type);
    const title = item.title || item.headline || 'Slide ' + (index + 1);
    const narration = item.narration || item.point || item.claim || '';
    // For stats/profile slides: try to resolve structured {label,value} slots from SofaScore data first
    var selectedData = allowStatData && Array.isArray(item.selectedData) ? item.selectedData : [];
    var resolvedSlots = (!selectedData.length && (type === 'stats' || type === 'profile')) ? resolveStatsSlots(title, narration, needs) : null;
    var dataSlots;
    if (selectedData.length) {
      dataSlots = selectedData.slice(0, 6).map(function(s) {
        return { label: s.label || '', value: s.value || '', sourceUrl: s.sourceUrl || '', sourceTitle: s.sourceTitle || 'SofaScore/TM' };
      });
    } else if (resolvedSlots) {
      dataSlots = resolvedSlots.map(function(s) {
        return { label: (s.sourceName ? s.sourceName + ' ' : '') + s.label, value: s.value, sourceUrl: s.sourceUrl || '', sourceTitle: s.sourceTitle || 'SofaScore/TM' };
      });
    } else {
      dataSlots = needs.slice(0, 6).map((need) => {
        const task = sourceTasks.find((t) => [t.need, t.expectedOutput, t.query].join(' ').includes(need));
        const value = allowStatData ? resolveFetchedValue(need, title, narration) : '';
        return { label: need, value, sourceUrl: task?.sourceUrl || '', sourceTitle: task?.sourceTitle || '' };
      });
    }
    return {
      mainKey: index === 0 ? 'opening' : (index === total - 1 ? 'ending' : 'v3:slide' + (index + 1)),
      subSource: 'v3',
      subValue: item.role || '',
      secondary: null,
      type,
      scriptDir: item.point || item.claim || '',
      title,
      narration,
      dataSlots,
      images: [],
      catchphrases: [],
      comments: [],
      v3Meta: { role: item.role || '', source: 'v3_editor', conceptualSlideType: conceptualType, productionCheck: item.productionCheck || '' },
    };
  });
}

function buildStructureFromBriefing() {
  updateBriefingFromEditor();
  if (!currentPlan) return;
  currentPlan.v3Modules = makeModulesFromCurrentPlan();
  currentPlan.autopilotPlan = currentPlan.autopilotPlan || {};
  currentPlan.autopilotPlan.scriptStructure = currentPlan.v3Modules.map((m, i) => ({
    no: i + 1,
    headline: m.title,
    point: m.scriptDir || m.narration,
    slideType: m.type,
    dataNeeds: (m.dataSlots || []).map((s) => s.label),
    sources: (m.dataSlots || []).map((s) => s.sourceUrl || s.sourceTitle).filter(Boolean),
  }));
  currentPlan.autopilotPlan.scriptDraft = [];
  activeSlideIdx = 0;
  markStepDone('structure');
  activeView = 'structure';
  renderPlan(currentPlan);
}

function confirmBriefingAndGoScript() {
  updateBriefingFromEditor();
  if (!currentPlan) return alert('先に企画提案を実行してください');
  currentPlan.v3Modules = makeModulesFromCurrentPlan();
  currentPlan.autopilotPlan = currentPlan.autopilotPlan || {};
  currentPlan.autopilotPlan.scriptStructure = currentPlan.v3Modules.map((m, i) => ({
    no: i + 1,
    headline: m.title,
    point: m.scriptDir || m.narration,
    slideType: m.type,
    dataNeeds: (m.dataSlots || []).map((s) => s.label),
    sources: (m.dataSlots || []).map((s) => s.sourceUrl || s.sourceTitle).filter(Boolean),
  }));
  currentPlan.autopilotPlan.scriptDraft = [];
  activeSlideIdx = 0;
  markStepDone('structure');
  generateScriptFromStructure();
}

function generateScriptFromBriefing() {
  updateBriefingFromEditor();
  if (!currentPlan) return alert('先に企画書を作ってください');
  currentPlan.v3Modules = makeModulesFromCurrentPlan();
  currentPlan.autopilotPlan = currentPlan.autopilotPlan || {};
  currentPlan.autopilotPlan.scriptStructure = currentPlan.v3Modules.map((m, i) => ({
    no: i + 1,
    headline: m.title,
    point: m.scriptDir || m.narration,
    slideType: m.type,
    dataNeeds: (m.dataSlots || []).map((s) => s.label),
    sources: (m.dataSlots || []).map((s) => s.sourceUrl || s.sourceTitle).filter(Boolean),
  }));
  currentPlan.autopilotPlan.scriptDraft = [];
  activeSlideIdx = 0;
  markStepDone('structure');
  generateScriptFromStructure();
}

function draftNarrationFromModule(module, index, total) {
  const title = module.title || '';
  const point = module.scriptDir || '';
  const data = (module.dataSlots || [])
    .filter((slot) => slot.label || slot.value)
    .slice(0, 3)
    .map((slot) => slot.value ? slot.label + 'は' + slot.value : slot.label)
    .join('、');
  const dataText = data ? 'ここで見るデータは、' + data + 'です。' : '';
  if (index === 0) {
    return 'まず注目したいのは「' + title + '」です。' + (point ? point + '。' : '') + dataText;
  }
  if (index === total - 1 || module.type === 'ending') {
    return '結論です。' + (point ? point + '。' : '') + '確認できた材料だけに絞ると、この話題の見え方はかなり変わります。';
  }
  if (module.type === 'comparison') {
    return (point || title) + '。' + dataText + 'この差を並べると、単なる印象論ではなく構造の違いが見えてきます。';
  }
  if (module.type === 'stats') {
    return (point || title) + '。' + dataText + '数字で見ると、このニュースの違和感がかなりはっきりします。';
  }
  if (module.type === 'profile') {
    return (point || title) + '。' + dataText + '人物やクラブの背景を押さえると、話の熱量が一段上がります。';
  }
  return (point || title) + '。' + dataText + 'ここは次の結論につなげるための大事な一枚です。';
}

function generateScriptFromStructure() {
  if (!currentPlan) return alert('先に企画書を作ってください');
  collectV3SlideInputs();
  if (!Array.isArray(currentPlan.v3Modules) || !currentPlan.v3Modules.length) {
    currentPlan.v3Modules = makeModulesFromCurrentPlan();
  }
  const total = currentPlan.v3Modules.length;
  currentPlan.v3Modules = currentPlan.v3Modules.map((module, index) => {
    const narration = module.narration && module.narration.trim()
      ? module.narration.trim()
      : draftNarrationFromModule(module, index, total);
    return { ...module, narration };
  });
  currentPlan.autopilotPlan = currentPlan.autopilotPlan || {};
  currentPlan.autopilotPlan.scriptDraft = currentPlan.v3Modules.map((module, index) => ({
    slideNo: index + 1,
    title: module.title || 'Slide ' + (index + 1),
    role: module.v3Meta?.role || module.subValue || module.type || '',
    narration: module.narration || '',
    dataNeeds: (module.dataSlots || []).map((slot) => slot.label).filter(Boolean),
    selectedData: (module.dataSlots || []).filter((slot) => slot.value || slot.sourceUrl).map((slot) => ({
      label: slot.label || '',
      value: slot.value || '',
      sourceTitle: slot.sourceTitle || '',
      sourceUrl: slot.sourceUrl || '',
      confidence: 'draft',
      reason: 'Step4企画書で選定済み',
    })),
    caution: '',
  }));
  markStepDone('script');
  activeView = 'script';
  renderPlan(currentPlan);
}

function asciiNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[à-åæ]/g, 'a').replace(/[è-ë]/g, 'e')
    .replace(/[ì-ï]/g, 'i').replace(/[ò-ö]/g, 'o')
    .replace(/[ù-ü]/g, 'u').replace(/ñ/g, 'n').replace(/ç/g, 'c');
}
function resolveFetchedValue(label, title, narration) {
  var hay = asciiNorm([label, title, narration].join(' '));
  for (var _i = 0; _i < (currentFetchedData || []).length; _i++) {
    var d = currentFetchedData[_i];
    if (!d.ok) continue;
    var parts = asciiNorm(d.nameEn).split(' ').filter(function(p) { return p.length >= 3; });
    if (parts.some(function(p) { return hay.includes(p); })) return d.summary;
  }
  return '';
}
function resolveStatsSlots(title, narration, needs) {
  var hayArr = [title, narration].concat(Array.isArray(needs) ? needs : []);
  var hay = asciiNorm(hayArr.join(' '));
  for (var _i = 0; _i < (currentFetchedData || []).length; _i++) {
    var d = currentFetchedData[_i];
    if (!d.ok || !Array.isArray(d.slots) || !d.slots.length) continue;
    var parts = asciiNorm(d.nameEn).split(' ').filter(function(p) { return p.length >= 3; });
    if (parts.some(function(p) { return hay.includes(p); })) {
      return d.slots.map(function(s) { return { ...s, sourceName: d.nameEn, sourceTitle: d.sourceTitle || 'SofaScore/TM', sourceUrl: d.sourceUrl || '' }; });
    }
  }
  return null;
}
function dataStatusChip(need) {
  var hay = asciiNorm(String(need || ''));
  var hit = (currentFetchedData || []).some(function(d) {
    if (!d.ok) return false;
    return asciiNorm(d.nameEn).split(' ').filter(function(p) { return p.length >= 3; })
      .some(function(p) { return hay.includes(p); });
  });
  return '<span class="chip" style="' + (hit ? 'border-color:#22c55e;color:#bbf7d0;' : 'border-color:#ef4444;color:#fca5a5;') + '">' + (hit ? '✅ ' : '❓ ') + esc(need) + '</span>';
}

function v3Tokens(text) {
  const stop = new Set(['the','and','for','with','from','that','this','about','news','latest','reddit','thread','video','slide']);
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !stop.has(w))
    .slice(0, 80);
}

function makeFetchedDataItems() {
  const items = [];
  (currentFetchedData || []).filter((d) => d && d.ok).forEach((d) => {
    const base = {
      entity: d.nameEn || '',
      type: d.type || '',
      sourceTitle: d.sourceTitle || 'SofaScore/TM',
      sourceUrl: d.sourceUrl || '',
      summary: d.summary || '',
      confidence: d.confidence || (d.relevanceScore >= 6 ? 'medium' : 'low'),
    };
    if (Array.isArray(d.slots) && d.slots.length) {
      d.slots.filter((s) => s.value).forEach((slot) => {
        items.push({
          ...base,
          label: [d.nameEn, slot.label].filter(Boolean).join(' '),
          value: String(slot.value || ''),
          matchText: [d.nameEn, d.type, slot.label, slot.value, d.summary, ...(d.labels || [])].join(' '),
        });
      });
    } else if (d.summary) {
      items.push({
        ...base,
        label: d.nameEn || d.type || 'data',
        value: d.summary,
        matchText: [d.nameEn, d.type, d.summary, ...(d.labels || [])].join(' '),
      });
    }
  });
  return items;
}

function scoreDataForModule(data, module, index, total) {
  if (!allowsV3StatData(module.type)) return -20;
  const moduleText = [
    module.type,
    module.subValue,
    module.title,
    module.scriptDir,
    module.narration,
    module.v3Meta?.role,
    ...(module.dataSlots || []).map((s) => s.label || ''),
  ].join(' ');
  const moduleTextLower = moduleText.toLowerCase();
  const dataTextLower = [data.entity, data.label, data.value, data.summary, data.matchText].join(' ').toLowerCase();
  const moduleTokens = new Set(v3Tokens(moduleText));
  const entityTokens = v3Tokens(data.entity);
  const labelTokens = v3Tokens(data.label);
  let score = 0;
  entityTokens.forEach((t) => { if (moduleTokens.has(t)) score += 5; });
  labelTokens.forEach((t) => { if (moduleTokens.has(t)) score += 2; });
  [data.entity, data.label].filter((x) => String(x || '').length >= 2).forEach((x) => {
    const needle = String(x).toLowerCase();
    if (moduleTextLower.includes(needle)) score += 4;
  });
  (module.dataSlots || []).forEach((slot) => {
    const label = String(slot.label || '').toLowerCase();
    if (label.length >= 2 && dataTextLower.includes(label)) score += 4;
  });
  if (/goal|goals|assist|rating|appearance|market|順位|勝点|ゴール|アシスト|評価|出場/i.test(moduleText + ' ' + dataTextLower)) {
    score += 1;
  }
  if (/stats|profile|comparison|ranking|matchcard/i.test(module.type || '')) score += 1;
  if ((index === 0 || index === total - 1) && score < 5) score -= 3;
  return score;
}

function bindFetchedDataToV3Modules() {
  if (!currentPlan) return [];
  if (!Array.isArray(currentPlan.v3Modules) || !currentPlan.v3Modules.length) {
    currentPlan.v3Modules = makeModulesFromCurrentPlan();
  }
  const dataItems = makeFetchedDataItems();
  if (!dataItems.length) return currentPlan.v3Modules || [];
  const total = currentPlan.v3Modules.length;
  currentPlan.v3Modules = currentPlan.v3Modules.map((module, index) => {
    if (!allowsV3StatData(module.type)) {
      const keptSlots = (Array.isArray(module.dataSlots) ? module.dataSlots : [])
        .filter((slot) => slot.sourceUrl && !/SofaScore|Transfermarkt|TM/i.test(slot.sourceTitle || ''));
      return {
        ...module,
        dataSlots: keptSlots,
        v3Meta: {
          ...(module.v3Meta || {}),
          selectedData: [],
        },
      };
    }
    const slots = Array.isArray(module.dataSlots) ? module.dataSlots.map((s) => ({ ...s })) : [];
    const picked = [];

    slots.forEach((slot) => {
      if (slot.value) {
        picked.push({ label: slot.label || '', value: slot.value || '', sourceTitle: slot.sourceTitle || '', sourceUrl: slot.sourceUrl || '', confidence: slot.confidence || 'manual' });
        return;
      }
      const slotProbe = { ...module, dataSlots: [{ label: slot.label || '' }] };
      const best = dataItems
        .map((data) => ({ data, score: scoreDataForModule(data, slotProbe, index, total) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 4) {
        slot.label = slot.label || best.data.label;
        slot.value = best.data.value;
        slot.sourceTitle = best.data.sourceTitle;
        slot.sourceUrl = best.data.sourceUrl;
        slot.confidence = best.data.confidence;
        picked.push({ label: slot.label, value: slot.value, sourceTitle: slot.sourceTitle, sourceUrl: slot.sourceUrl, confidence: slot.confidence });
      }
    });

    const existingKeys = new Set(slots.map((s) => [s.label, s.value].join('::')));
    dataItems
      .map((data) => ({ data, score: scoreDataForModule(data, module, index, total) }))
      .filter((x) => x.score >= 5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .forEach(({ data }) => {
        const key = [data.label, data.value].join('::');
        if (existingKeys.has(key) || slots.length >= 6) return;
        existingKeys.add(key);
        const slot = {
          label: data.label,
          value: data.value,
          sourceTitle: data.sourceTitle,
          sourceUrl: data.sourceUrl,
          confidence: data.confidence,
        };
        slots.push(slot);
        picked.push(slot);
      });

    return {
      ...module,
      dataSlots: slots,
      v3Meta: {
        ...(module.v3Meta || {}),
        selectedData: picked.slice(0, 6),
      },
    };
  });
  return currentPlan.v3Modules;
}

function buildAISlideOutlineFromModules(modules) {
  return (modules || []).map((m, i) => ({
    no: i + 1,
    slideType: m.type || 'insight',
    headline: m.title || ('Slide ' + (i + 1)),
    point: m.scriptDir || m.narration || '',
    dataNeeds: (m.dataSlots || []).map((s) => s.label).filter(Boolean),
    selectedData: (m.dataSlots || []).filter((s) => s.value || s.sourceUrl).map((s) => ({
      label: s.label || '',
      value: s.value || '',
      sourceTitle: s.sourceTitle || '',
      sourceUrl: s.sourceUrl || '',
      confidence: s.confidence || '',
    })),
  }));
}

function rebuildV3ModulesFromBriefing() {
  if (!currentPlan) return [];
  updateBriefingFromEditor();
  currentPlan.autopilotPlan = currentPlan.autopilotPlan || {};
  currentPlan.autopilotPlan.scriptStructure = [];
  currentPlan.autopilotPlan.scriptDraft = [];
  const previous = Array.isArray(currentPlan.v3Modules) ? currentPlan.v3Modules : [];
  const previousByNo = new Map(previous.map((m, i) => [String(i + 1), m]));
  const previousByTitle = new Map(previous.map((m) => [String(m.title || '').trim().toLowerCase(), m]).filter(([k]) => k));
  const next = makeModulesFromCurrentPlan();
  currentPlan.v3Modules = next.map((module, index) => {
    const prev = previousByNo.get(String(index + 1)) || previousByTitle.get(String(module.title || '').trim().toLowerCase()) || {};
    const prevSlots = Array.isArray(prev.dataSlots) ? prev.dataSlots : [];
    const prevByLabel = new Map(prevSlots.map((slot) => [String(slot.label || '').trim().toLowerCase(), slot]).filter(([k]) => k));
    const moduleSlots = Array.isArray(module.dataSlots) ? module.dataSlots : [];
    const sameTitle = String(prev.title || '').trim().toLowerCase() === String(module.title || '').trim().toLowerCase();
    const mergedSlots = moduleSlots.length
      ? moduleSlots.map((slot) => {
        const prevSlot = prevByLabel.get(String(slot.label || '').trim().toLowerCase()) || {};
        return {
          ...prevSlot,
          ...slot,
          value: slot.value || prevSlot.value || '',
          sourceTitle: slot.sourceTitle || prevSlot.sourceTitle || '',
          sourceUrl: slot.sourceUrl || prevSlot.sourceUrl || '',
          confidence: slot.confidence || prevSlot.confidence || '',
        };
      })
      : (sameTitle ? prevSlots : []);
    return {
      ...prev,
      ...module,
      images: Array.isArray(prev.images) ? prev.images : (module.images || []),
      narration: '',
      dataSlots: mergedSlots,
      v3Meta: {
        ...(prev.v3Meta || {}),
        ...(module.v3Meta || {}),
      },
    };
  });
  return currentPlan.v3Modules;
}

function renderBriefingPipelineView(plan) {
  const briefing = plan.autopilotPlan?.briefing || {};
  const proposal = plan.autopilotPlan?.themeProposal || {};
  const selectedIdx = proposal.selected || 0;
  const selectedLetter = String.fromCharCode(65 + selectedIdx);
  const selectedCandidate = (proposal.candidates || [])[selectedIdx] || {};
  const selectedAngle = selectedCandidate.angle || selectedCandidate.hookQuestion || proposal.angle || '';
  const adoptedBanner = selectedAngle
    ? '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#1b2230;border:2px solid var(--gold);border-radius:8px;margin-bottom:12px;">' +
        '<span style="background:var(--gold);color:#111827;font-weight:900;font-size:12px;padding:3px 10px;border-radius:4px;flex-shrink:0;">採用: 企画' + selectedLetter + '</span>' +
        '<span style="font-size:13px;color:var(--text);line-height:1.4;">' + esc(selectedAngle) + '</span>' +
        '<button class="secondary" style="margin-left:auto;flex-shrink:0;font-size:11px;min-height:28px;padding:0 8px;" onclick="setResultView(\\'proposal\\')">← 企画提案に戻る</button>' +
      '</div>'
    : '';
  const chapters = briefing.chapters || [];
  const fetchedOk = (currentFetchedData || []).filter(d => d.ok);
  const fetchedPanel = fetchedOk.length
    ? '<div class="panel" style="margin-bottom:10px;">' +
        '<span class="label">取得済みデータ（SofaScore / TM）</span>' +
        '<div class="chips" style="margin-top:6px;">' +
          fetchedOk.map(d => '<span class="chip" style="background:#0f2a1a;border-color:#22c55e;color:#bbf7d0;">' + esc(d.nameEn) + ': ' + esc(d.summary) + '</span>').join('') +
        '</div>' +
      '</div>'
    : '';
  const slideOutline = briefing.slideOutline || buildBriefingSlideOutline(plan);
  const slideTypeBadge4 = (type) => {
    const colors = { opening: '#2563eb', history: '#7c3aed', comparison: '#0891b2', stats: '#b45309', profile: '#065f46', insight: '#1e40af', ending: '#374151' };
    return '<span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:900;background:' + (colors[type] || '#374151') + ';color:#fff;">' + esc(type || 'insight') + '</span>';
  };
  return adoptedBanner + fetchedPanel +
    '<span class="label">企画書。採用テーマとスライド型ラフを確認・編集する段階</span>' +
    '<textarea id="briefingText" class="brief-textarea" oninput="updateBriefingFromEditor()">' + esc(formatBriefingText(plan)) + '</textarea>' +
    '<div class="task-actions">' +
      '<button onclick="confirmBriefingAndGoScript()">制作仕様を確定して脚本生成へ →</button>' +
      '<button class="secondary" onclick="updateBriefingFromEditor();renderPlan(currentPlan)">企画書を反映</button>' +
    '</div>' +
    '<div class="autopilot-grid" style="margin-top:14px;">' +
      '<div class="autopilot-card"><h2>構成タイプ</h2><p>' + esc(briefing.storyPattern || selectedCandidate.storyPattern || proposal.storyPattern || 'ニュース解説型') + '</p></div>' +
      '<div class="autopilot-card"><h2>動画の約束</h2><p>' + esc(briefing.purpose || plan.viewerPromise || '') + '</p></div>' +
      '<div class="autopilot-card"><h2>中心メッセージ</h2><p>' + esc(briefing.coreMessage || plan.thesis || '') + '</p></div>' +
      (slideOutline.length
        ? '<div class="autopilot-card" style="grid-column:1/-1;"><h2>スライド構成（' + slideOutline.length + '枚）</h2>' +
            '<div class="slide-list" style="gap:5px;margin-top:6px;">' +
              slideOutline.slice(0, 10).map((item) => {
                const needs = item.dataNeeds || [];
                return '<div style="display:grid;grid-template-columns:auto auto 1fr;gap:6px;align-items:start;background:#0a0d12;border:1px solid var(--line);border-radius:6px;padding:8px 10px;">' +
                  '<span style="color:var(--muted);font-size:11px;min-width:18px;">' + esc(item.no || '') + '</span>' +
                  slideTypeBadge4(item.slideType || item.role) +
                  '<div><div style="font-size:13px;font-weight:700;">' + esc(item.headline || '') + '</div>' +
                  (item.point ? '<div style="font-size:11px;color:var(--muted);margin-top:2px;">' + esc(String(item.point).slice(0, 100)) + '</div>' : '') +
                  (needs.length ? '<div class="chips" style="margin-top:4px;">' + needs.slice(0, 4).map(dataStatusChip).join('') + '</div>' : '') +
                  '</div>' +
                '</div>';
              }).join('') +
            '</div></div>'
        : '') +
      '<div class="autopilot-card" style="grid-column:1/-1;"><h2>使うデータ <span style="font-size:11px;font-weight:400;color:var(--muted);">✅取得済 ❓未確認</span></h2><div class="chips">' +
        (briefing.dataPlan || []).slice(0, 10).map((x) => dataStatusChip(x.need || x)).join('') +
      '</div></div>' +
    '</div>';
}

function renderResultTabs(plan) {
  plan = plan || {};
  const panels = {
    case: renderCaseView,
    saved: renderSavedView,
    proposal: renderProposalView,
    briefing: renderBriefingPipelineView,
    structure: renderStructureView,
    script: renderScriptView,
    export: renderExportView,
  };
  const renderActive = panels[activeView] || panels.case;
  return '<div id="resultTop">' +
    '<div class="step-container view-panel" data-view="' + esc(activeView) + '">' + renderActive(plan) + '</div>' +
  '</div>';
}

function renderExportView(plan) {
  const modules = plan.v3Modules || [];
  const script = plan.autopilotPlan?.scriptDraft || [];
  const slideCount = modules.length || script.length;
  return '<span class="label">6 動画生成 — スライド確認後に動画を生成します</span>' +
    '<div class="panel" style="margin-bottom:12px;">' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;">' +
        '<div style="text-align:center;padding:10px;background:#0a0d12;border-radius:6px;border:1px solid var(--line);">' +
          '<div style="font-size:22px;font-weight:900;color:var(--gold);">' + esc(String(slideCount)) + '</div>' +
          '<div style="font-size:11px;color:var(--muted);">スライド数</div>' +
        '</div>' +
        '<div style="text-align:center;padding:10px;background:#0a0d12;border-radius:6px;border:1px solid var(--line);">' +
          '<div style="font-size:22px;font-weight:900;color:var(--gold);">' + esc(String(modules.filter((m) => (m.narration || '').length > 0).length)) + '</div>' +
          '<div style="font-size:11px;color:var(--muted);">ナレーション済み</div>' +
        '</div>' +
        '<div style="text-align:center;padding:10px;background:#0a0d12;border-radius:6px;border:1px solid var(--line);">' +
          '<div style="font-size:22px;font-weight:900;color:var(--gold);">' + esc(String(modules.filter((m) => (m.images || []).length > 0).length)) + '</div>' +
          '<div style="font-size:11px;color:var(--muted);">画像設定済み</div>' +
        '</div>' +
      '</div>' +
      '<div class="task-actions">' +
        '<button id="v2EditorBtn" class="secondary" onclick="setResultView(\\'script\\')">V3内蔵編集へ戻る</button>' +
        '<button id="v3GenVideoBtn" onclick="startV3VideoGeneration()">動画生成スタート</button>' +
        '<button class="secondary" onclick="setResultView(\\'script\\')">← スライド編集に戻る</button>' +
      '</div>' +
      '<div id="v3GenVideoStatus" class="task-status" style="margin-top:8px;"></div>' +
      '<div class="video-progress-bar" id="v3ProgressBar" style="display:none;"><div class="video-progress-fill" id="v3ProgressFill" style="width:0%;"></div></div>' +
    '</div>' +
    '<div id="v3VideoResult"></div>';
}

function tidyControls() {
  const briefPanel = document.querySelector('.brief-editor')?.closest('.panel');
  if (briefPanel) briefPanel.style.display = 'none';
  const legacy = document.querySelector('.legacy-actions');
  if (legacy) legacy.style.display = 'none';
}

try {
  tidyControls();
  loadSaved();
  restoreV3State();
  activeView = 'case';
  renderPlan(currentPlan);
  bindHamburgerMenu();
  bindCaseInputReset();
} catch (error) {
  window.dispatchEvent(new ErrorEvent('error', { message: error.message || String(error), error: error }));
}
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`V3 Story Architect running: http://localhost:${PORT}`);
});
