// scripts/warehouse_recognize.js
// warehouse/pending/ の画像を Gemini Flash Vision で認識
// → 選手名でリネームして images_stock/players_official/{club-slug}/ に格納
// → players_official_index.json に追記
//
// 使い方（モジュール）:
//   const { runRecognition } = require('./warehouse_recognize');
//   const results = await runRecognition();
//
// 使い方（CLI）:
//   node scripts/warehouse_recognize.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs          = require('fs');
const path        = require('path');
const axios       = require('axios');
const costTracker = require('./cost_tracker');

const PENDING_DIR  = path.join(__dirname, '..', 'images', 'warehouse', 'pending');
const REJECTED_DIR = path.join(__dirname, '..', 'images', 'warehouse', 'rejected');
const STOCK_DIR    = path.join(__dirname, '..', 'images_stock', 'players_official');
const LEAGUES_DIR  = path.join(__dirname, '..', 'images_stock', 'leagues');
const CLUBS_DIR    = path.join(__dirname, '..', 'images_stock', 'clubs');
const INDEX_FILE   = path.join(__dirname, '..', 'data', 'players_official_index.json');
const LEAGUES_INDEX_FILE = path.join(__dirname, '..', 'data', 'leagues_index.json');
const CLUBS_INDEX_FILE   = path.join(__dirname, '..', 'data', 'clubs_index.json');

[LEAGUES_DIR, CLUBS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const CONFIDENCE_THRESHOLD = 0.75;  // これ未満はrejected
const GEMINI_MODEL         = 'gemini-2.5-flash';
const CONCURRENCY          = 3;     // Gemini同時リクエスト数
const STOCK_CAP            = 20;    // 1選手フォルダの最大画像枚数（スコア管理で超過分削除）

[REJECTED_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── 文字列→スラッグ ──────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 40);
}

// ── インデックス読み書き ──────────────────────────────────────────────────────
function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch (_) { return { players: {} }; }
}
function saveIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}
function loadSubIndex(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}
function saveSubIndex(file, idx) { fs.writeFileSync(file, JSON.stringify(idx, null, 2)); }


// ── Gemini Flash Vision で認識 ────────────────────────────────────────────────
async function recognizeImage(imagePath, meta = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 未設定');

  const imgBuf  = fs.readFileSync(imagePath);
  const base64  = imgBuf.toString('base64');
  const mime    = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const hint    = meta.playerHint
    ? `ヒント: ${meta.playerHint}（所属: ${meta.clubHint || '不明'}）が写っている可能性があります。`
    : '';

  const prompt = `これはサッカー関連のXアカウントの投稿画像です。${hint}
以下のJSONのみを返してください（説明・コードブロック不要）:
{
  "category": "player（選手が主役） / league（リーグのロゴ・トロフィー・表彰式） / club（クラブロゴ・スタジアム・チーム集合写真） / other",
  "player": "categoryがplayerの時: 最も目立つ選手のフルネーム（英語）。それ以外はnull",
  "entity": "categoryがleague/clubの時: リーグ名またはクラブ名（英語）。それ以外はnull",
  "contentType": "player→ portrait/play/goal/celebration/sadness/training/other | league→logo/trophy/ceremony/other | club→logo/stadium/squad/other",
  "confidence": 0.0〜1.0（判別の確信度）
}`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mime, data: base64 } },
      ],
    }],
    generationConfig: {
      temperature:    0.1,
      maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 },  // 思考トークンがoutputを食うのを防止
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res  = await axios.post(url, body, { timeout: 25000 });
  const raw  = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // コスト計測
  const usage = res.data?.usageMetadata || {};
  costTracker.record({
    label:        'warehouse_recognize',
    provider:     'gemini',
    inputTokens:  usage.promptTokenCount     || 0,
    outputTokens: usage.candidatesTokenCount || 0,
  });

  // コードブロック除去 → JSONオブジェクト抽出（greedy で完全なオブジェクトを取る）
  let jsonStr = raw;
  const blockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) jsonStr = blockMatch[1].trim();
  const m = jsonStr.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`JSONが見つかりません: ${raw.slice(0, 120)}`);
  return JSON.parse(m[0]);
}

// ── 1枚処理 ──────────────────────────────────────────────────────────────────
async function processOne(imagePath) {
  const fname    = path.basename(imagePath);
  const metaPath = imagePath.replace(/\.(jpg|png)$/i, '.json');
  const meta     = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    : {};

  // ── 認識 ─────────────────────────────────────────────────────────────────
  let rec;
  try {
    rec = await recognizeImage(imagePath, meta);
  } catch (e) {
    console.warn(`  [recognize] 認識エラー ${fname}: ${e.message}`);
    moveToRejected(imagePath, metaPath);
    return null;
  }

  const { category, player, entity, contentType, confidence } = rec;
  const conf     = Number(confidence) || 0;
  const cat      = (category || 'other').toLowerCase();
  const mainName = cat === 'player' ? player : entity;
  console.log(`  [recognize] ${fname} → [${cat}] "${mainName || 'null'}" type=${contentType} conf=${conf.toFixed(2)}`);

  if (!mainName || conf < CONFIDENCE_THRESHOLD) {
    moveToRejected(imagePath, metaPath);
    return null;
  }

  const entitySlug = slugify(mainName);
  const ext        = /\.png$/i.test(fname) ? 'png' : 'jpg';

  // ── カテゴリ別フォルダ・インデックス振り分け ──────────────────────────────
  let targetDir, prefix, indexFile, indexData, indexKey;

  if (cat === 'league') {
    targetDir = path.join(LEAGUES_DIR, entitySlug);
    prefix    = contentType || 'other';           // logo / trophy / ceremony / other
    indexFile = LEAGUES_INDEX_FILE;
    indexData = loadSubIndex(indexFile);
  } else if (cat === 'club') {
    targetDir = path.join(CLUBS_DIR, entitySlug);
    prefix    = contentType || 'other';           // logo / stadium / squad / other
    indexFile = CLUBS_INDEX_FILE;
    indexData = loadSubIndex(indexFile);
  } else {
    // player（デフォルト）
    targetDir = path.join(STOCK_DIR, entitySlug);
    prefix    = entitySlug;
    indexFile = INDEX_FILE;
    indexData = loadIndex();
    indexData = indexData; // players プロパティを直接使う
  }

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  // 連番（同フォルダ内の同prefixで始まるファイル数）
  const existing = fs.readdirSync(targetDir)
    .filter(f => f.startsWith(prefix + '_') && /\.(jpg|png)$/i.test(f)).length;
  const num     = String(existing + 1).padStart(3, '0');
  const newName = `${prefix}_${num}.${ext}`;
  const newPath = path.join(targetDir, newName);

  fs.renameSync(imagePath, newPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

  const localPath = path.relative(path.join(__dirname, '..'), newPath).replace(/\\/g, '/');
  const entry = {
    name: mainName, slug: entitySlug, category: cat,
    contentType: contentType || 'other', confidence: conf,
    localPath, sizeBytes: fs.statSync(newPath).size,
    addedAt: new Date().toISOString().slice(0, 10), source: 'warehouse',
  };

  // インデックス保存
  if (cat === 'player') {
    const idx = loadIndex();
    const clubSlug = slugify(meta.clubHint || meta.handle || '');
    indexKey = `${entitySlug}_${num}`;
    idx.players[indexKey] = { ...entry, club: clubSlug, league: slugify(meta.leagueHint || '') };
    saveIndex(idx);
    try { const { registerNewImage } = require('./image_score_manager'); registerNewImage(localPath); } catch (_) {}
  } else {
    indexKey = `${entitySlug}_${prefix}_${num}`;
    indexData[indexKey] = entry;
    saveSubIndex(indexFile, indexData);
  }

  console.log(`  → [${cat}] 保存: ${localPath}`);
  return { category: cat, name: mainName, contentType: contentType || 'other', confidence: conf, localPath };
}

function moveToRejected(imagePath, metaPath) {
  const rejected = path.join(REJECTED_DIR, path.basename(imagePath));
  try { fs.renameSync(imagePath, rejected); } catch (_) {}
  if (metaPath && fs.existsSync(metaPath)) {
    try { fs.renameSync(metaPath, path.join(REJECTED_DIR, path.basename(metaPath))); } catch (_) {}
  }
}

// ── メイン ────────────────────────────────────────────────────────────────────
async function runRecognition() {
  const pending = fs.readdirSync(PENDING_DIR)
    .filter(f => /\.(jpg|png)$/i.test(f))
    .map(f => path.join(PENDING_DIR, f));

  if (!pending.length) {
    console.log('[warehouse_recognize] pending に画像なし');
    return [];
  }
  console.log(`[warehouse_recognize] 認識開始: ${pending.length}枚`);

  const results = [];
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY).map(p => processOne(p).catch(e => {
      console.warn(`  processOne error: ${e.message}`);
      return null;
    }));
    const batch_results = await Promise.all(batch);
    results.push(...batch_results.filter(Boolean));
    console.log(`  進捗: ${Math.min(i + CONCURRENCY, pending.length)}/${pending.length}枚完了`);
  }

  const adopted  = results.length;
  const rejected = pending.length - adopted;
  const summary  = costTracker.getSummary();
  console.log(`[warehouse_recognize] 完了: 採用${adopted}枚 / 却下${rejected}枚`);
  console.log(`[cost] Gemini Vision: ${summary.calls}回 | $${summary.totalUsd.toFixed(4)} (¥${summary.totalJpy})`);
  return results;
}

module.exports = { runRecognition, processOne };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  runRecognition()
    .then(r => { console.log(`採用: ${r.length}枚`); r.forEach(x => console.log(' ', x.localPath)); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}
