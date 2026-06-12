// v4_launcher/scripts/v4_video.js
// ネタブック → V4動画生成パイプライン
//
// 動画構成（120秒前後）:
//   1. v4_picture: フック + 概要       （約25秒）
//   2. v4_picture: 補足シナリオ①      （約25秒）
//   3. v4_picture: 補足シナリオ②      （約25秒）
//   4. v4_reaction: ネット民の反応     （約40秒）
//
// render.js を子プロセスで呼び出し。V3インフラ（TTS/ffmpeg/BGM）をフル再利用。
'use strict';

const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { matchPlayers, matchManagers, matchClubs } = require('../../scripts/modules/stock_match');

const BASE_DIR     = path.join(__dirname, '..', '..');  // 02_reddit_global/
const DATA_DIR     = path.join(BASE_DIR, 'data');
const MODULES_DIR  = DATA_DIR;  // <postId>_modules.json と同じ場所
const SI_DIR       = path.join(DATA_DIR, 'si_data');
const RENDER_JS    = path.join(BASE_DIR, 'scripts', 'v2_video', 'render.js');
const JOBS_DIR     = path.join(DATA_DIR, 'v2_jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

function safeId(s) { return String(s||'').replace(/[^\w]/g, '_').slice(0, 40); }

// ── 画像を entity 名から自動検索 ─────────────────────────────
function _findImage(entityName) {
  if (!entityName) return null;
  const hits = matchPlayers(entityName, { limit: 1 });
  if (hits.length) return path.join(BASE_DIR, hits[0].url.replace(/^\//, ''));
  const mgr = matchManagers(entityName, { limit: 1 });
  if (mgr.length) return path.join(BASE_DIR, mgr[0].url.replace(/^\//, ''));
  const club = matchClubs(entityName, { limit: 1 });
  if (club.length) return path.join(BASE_DIR, club[0].url.replace(/^\//, ''));
  return null;
}

// ── ネタブック → modules.json ─────────────────────────────────
function buildModules(book) {
  const imagePath = _findImage(book.mainEntity);
  const images = imagePath ? [imagePath] : [];

  return [
    // スライド1: フック + 概要
    {
      type: 'v4_picture',
      orientation: 'vertical',
      title: book.hook || book.topic,
      images,
      narration: book.overview,
    },
    // スライド2: 補足シナリオ①
    {
      type: 'v4_picture',
      orientation: 'vertical',
      title: '実は...',
      images,
      narration: book.scenario1,
    },
    // スライド3: 補足シナリオ②
    {
      type: 'v4_picture',
      orientation: 'vertical',
      title: 'ちなみに...',
      images,
      narration: book.scenario2,
    },
    // スライド4: リアクション
    {
      type: 'v4_reaction',
      title: 'ネット民の反応',
      comments: book.reactions || [],
      narration: 'みなさんの反応はこちらです',
    },
  ];
}

// ── render.js 子プロセス実行 ──────────────────────────────────
function _runRender(postId, jobId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [RENDER_JS, postId, jobId], {
      cwd: BASE_DIR,
      env: { ...process.env },
    });
    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('render exit ' + code)));
  });
}

// ── ジョブ管理 ────────────────────────────────────────────────
function _writeJob(jobId, data) {
  fs.writeFileSync(path.join(JOBS_DIR, jobId + '.json'), JSON.stringify(data, null, 2));
}

// ── メイン: 動画生成 ──────────────────────────────────────────
async function generateV4Video(book) {
  const postId = 'v4_' + safeId(book.topic) + '_' + Date.now();
  const jobId  = 'v4job_' + Date.now();

  console.log('[v4_video] 開始:', postId);

  // si_data: エンティティなし（V4はシンプルなのでデータバインドなし）
  const siData = {
    postId, version: 'v3', createdAt: new Date().toISOString(),
    boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } },
  };
  fs.writeFileSync(path.join(SI_DIR, postId + '.json'), JSON.stringify(siData, null, 2));

  // saved_projects に案件登録
  const savedFile = path.join(DATA_DIR, 'saved_projects.json');
  const saved = fs.existsSync(savedFile)
    ? JSON.parse(fs.readFileSync(savedFile, 'utf8'))
    : [];
  saved.unshift({
    id: postId,
    title: book.topic,
    titleOrig: book.topic,
    createdAt: new Date().toISOString(),
    source: 'v4',
    raw: { selftext: book.overview || '', comments: [] },
  });
  fs.writeFileSync(savedFile, JSON.stringify(saved, null, 2));

  // modules.json 生成
  const modules = buildModules(book);
  fs.writeFileSync(
    path.join(MODULES_DIR, postId + '_modules.json'),
    JSON.stringify({ postId, modules, savedAt: new Date().toISOString(), source: 'v4' }, null, 2)
  );

  // ジョブ初期化
  _writeJob(jobId, { jobId, status: 'running', postId, createdAt: new Date().toISOString() });

  // render.js 実行
  await _runRender(postId, jobId);

  // 出力ファイルを確認
  const videoDir = path.join(DATA_DIR, 'v2_videos');
  const videos = fs.existsSync(videoDir)
    ? fs.readdirSync(videoDir).filter(f => f.startsWith(postId) && f.endsWith('.mp4'))
    : [];

  const result = {
    postId,
    jobId,
    videoPath: videos.length ? path.join(videoDir, videos[0]) : null,
    modules: modules.length,
    book,
  };
  console.log('[v4_video] 完了:', result.videoPath || '(ファイル未確認)');
  return result;
}

module.exports = { generateV4Video };

// ── CLIテスト ─────────────────────────────────────────────────
if (require.main === module) {
  const sampleBook = {
    topic: 'コナテ、リバプールとの契約延長を拒否',
    hook:  'えっこれマジ？リバポ大ピンチwwww',
    overview:  'イブラヒマ・コナテがリバプールとの契約延長交渉を断り、マドリー移籍へ向けて動き出したと現地報道。',
    scenario1: 'ちなみにコナテ、今季プレミアで対人デュエル勝率78%と欧州CB全体トップ5に入ってたんですよね。',
    scenario2: 'それでリバポ側が提示したのが週給18万ポンド。マドリーの半分以下だったらしいですwww',
    mainEntity: 'Ibrahima Konate',
    reactions: [
      { text: 'マドリーが欲しいなら普通行くやろwwww', score: 3200 },
      { text: '交渉決裂してて笑う', score: 1800 },
      { text: 'コナテいい選手なのに惜しいな', score: 950 },
      { text: 'リバポのCB誰なるんやろ', score: 720 },
      { text: 'まあ選手の人生だしな', score: 430 },
    ],
  };
  generateV4Video(sampleBook).catch(console.error);
}
