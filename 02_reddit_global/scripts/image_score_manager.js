// scripts/image_score_manager.js
// 動画生成で使われた画像にスコアを加点し、各選手フォルダの上限（20枚）を管理する
//
// score.json の場所: images_stock/players_official/{club-slug}/score.json
// {
//   "andrew-robertson_001.jpg": { "score": 3, "addedAt": "2026-06-01", "lastUsed": "2026-06-02" },
//   "andrew-robertson_002.jpg": { "score": 0, "addedAt": "2026-06-01", "lastUsed": null }
// }
//
// 使い方:
//   const { recordImageUsage } = require('./image_score_manager');
//   await recordImageUsage(['/images_stock/players_official/liverpool/andrew-robertson_001.jpg']);

const fs   = require('fs');
const path = require('path');

const STOCK_ROOT = path.join(__dirname, '..', 'images_stock', 'players_official');
const STOCK_CAP  = 20;   // 1選手フォルダの最大保存枚数
const SCORE_FILE = 'score.json';

// ── score.json 読み書き ──────────────────────────────────────────────────────
function readScores(clubDir) {
  const file = path.join(clubDir, SCORE_FILE);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}
function writeScores(clubDir, scores) {
  fs.writeFileSync(path.join(clubDir, SCORE_FILE), JSON.stringify(scores, null, 2));
}

// ── ローカルパス → 選手フォルダ + ファイル名 に変換 ────────────────────────
// '/images_stock/players_official/andrew-robertson/andrew-robertson_001.jpg'
// → { playerSlug: 'andrew-robertson', filename: '...', playerDir: '...' }
function resolveStockPath(imagePath) {
  if (!imagePath) return null;
  const normalized = imagePath.replace(/\\/g, '/');
  const m = normalized.match(/images_stock\/players_official\/([^/]+)\/([^/]+\.(jpg|png))$/i);
  if (!m) return null;
  return {
    playerSlug: m[1],
    filename:   m[2],
    playerDir:  path.join(STOCK_ROOT, m[1]),
  };
}

// ── 新規画像を score.json に登録（warehouse_recognize から呼ぶ） ─────────────
function registerNewImage(localPath) {
  const info = resolveStockPath(localPath);
  if (!info || !fs.existsSync(info.playerDir)) return;
  const scores = readScores(info.playerDir);
  if (!scores[info.filename]) {
    scores[info.filename] = {
      score:    0,
      addedAt:  new Date().toISOString().slice(0, 10),
      lastUsed: null,
    };
    writeScores(info.playerDir, scores);
  }
}

// ── 動画生成で使われた画像のスコアを +1 ─────────────────────────────────────
// imagePaths: ローカルパス or URL の配列
function recordImageUsage(imagePaths) {
  if (!Array.isArray(imagePaths) || !imagePaths.length) return;
  const today = new Date().toISOString().slice(0, 10);

  // 選手フォルダ別にまとめて処理
  const byPlayer = {};
  for (const p of imagePaths) {
    const info = resolveStockPath(p);
    if (!info) continue;
    if (!byPlayer[info.playerSlug]) byPlayer[info.playerSlug] = { playerDir: info.playerDir, files: [] };
    byPlayer[info.playerSlug].files.push(info.filename);
  }

  for (const { playerDir, files } of Object.values(byPlayer)) {
    if (!fs.existsSync(playerDir)) continue;
    const scores = readScores(playerDir);
    for (const fname of files) {
      if (!scores[fname]) {
        scores[fname] = { score: 0, addedAt: today, lastUsed: null };
      }
      scores[fname].score += 1;
      scores[fname].lastUsed = today;
      console.log(`[score] +1: ${path.basename(playerDir)}/${fname} → ${scores[fname].score}点`);
    }
    writeScores(playerDir, scores);
    pruneClubDir(playerDir, scores);
  }
}

// ── 選手フォルダが上限超えたら低スコア順（同点は古い順）に削除 ──────────────
function pruneClubDir(clubDir, scoresOverride) {
  const scores    = scoresOverride || readScores(clubDir);
  const allImages = fs.readdirSync(clubDir)
    .filter(f => /\.(jpg|png)$/i.test(f));

  if (allImages.length <= STOCK_CAP) return;

  // 選手ごとにグループ分け → それぞれ上限チェック
  const groups = {};
  for (const fname of allImages) {
    const slug = fname.replace(/_\d{3}\.(jpg|png)$/i, '');
    if (!groups[slug]) groups[slug] = [];
    groups[slug].push(fname);
  }

  for (const [slug, files] of Object.entries(groups)) {
    if (files.length <= STOCK_CAP) continue;

    // スコア昇順（低い順）、同点は addedAt 昇順（古い順）でソート
    const sorted = files.sort((a, b) => {
      const sa = scores[a] || { score: 0, addedAt: '0000-00-00' };
      const sb = scores[b] || { score: 0, addedAt: '0000-00-00' };
      if (sa.score !== sb.score) return sa.score - sb.score;
      return sa.addedAt.localeCompare(sb.addedAt);
    });

    const toDelete = sorted.slice(0, files.length - STOCK_CAP);
    for (const fname of toDelete) {
      const filePath = path.join(clubDir, fname);
      fs.unlinkSync(filePath);
      delete scores[fname];
      console.log(`[score] 削除（上限超過）: ${path.basename(clubDir)}/${fname}`);
    }
    writeScores(clubDir, scores);
  }
}

// ── 全クラブフォルダを score.json で初期化（既存ファイルを登録） ─────────────
function initAllScores() {
  const clubs = fs.readdirSync(STOCK_ROOT).filter(c =>
    fs.statSync(path.join(STOCK_ROOT, c)).isDirectory()
  );
  for (const club of clubs) {
    const clubDir = path.join(STOCK_ROOT, club);
    const scores  = readScores(clubDir);
    const images  = fs.readdirSync(clubDir).filter(f => /\.(jpg|png)$/i.test(f));
    let updated   = false;
    for (const fname of images) {
      if (!scores[fname]) {
        scores[fname] = { score: 0, addedAt: new Date().toISOString().slice(0, 10), lastUsed: null };
        updated = true;
      }
    }
    if (updated) { writeScores(clubDir, scores); console.log(`[score] 初期化: ${club} (${images.length}枚)`); }
  }
}

module.exports = { recordImageUsage, registerNewImage, pruneClubDir, initAllScores };

// ── CLI: 初期化 ───────────────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'init') {
    initAllScores();
    console.log('全フォルダの score.json を初期化しました');
  } else {
    console.log('使い方: node scripts/image_score_manager.js init');
  }
}
