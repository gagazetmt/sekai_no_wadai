'use strict';
// v4_image_selector.js
// 画像セット最適化: Gemini Flash vision でスコアリング → サムネ1枚 + スライド6枚を選定
// プロバイダ: Gemini REST API 直叩き（GEMINI_API_KEY）→ 無料枠が広く Anthropic 残高不要
//
// 出力画像ごとに付与するフィールド:
//   score         : 1〜10 (視覚的インパクト + 動画への適合度)
//   thumbnailGrade: A/B/C (A = サムネ最適)
//   contentType   : player_portrait | player_action | team_group | stadium | celebration | logo | other
//   orientation   : portrait | landscape
//   focalX        : 0〜100  (主被写体の水平位置 %)
//   focalY        : 0〜100  (主被写体の垂直位置 %)
//   offsetX       : focalX - 50  → imageAdjust.offsetX に直接使用
//   offsetY       : focalY - 50  → imageAdjust.offsetY に直接使用

const path = require('path');
const fs   = require('fs');

const BASE_DIR   = path.join(__dirname, '..', '..');  // 02_reddit_global/
const BATCH      = 4;   // Gemini 1バッチあたりの画像数（多すぎると精度低下）
const MAX_IMGS   = 12;  // スコアリング対象の上限
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-flash-lite-latest';  // vision 対応・軽量

// ── 画像を Gemini inline_data（base64）に変換 ────────────────
async function _toGeminiPart(img) {
  const url = String(img.url || img.src || '');
  if (!url) return null;
  let data, mimeType;
  if (url.startsWith('https://')) {
    // 外部 URL → ダウンロードして base64 化
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      data = buf.toString('base64');
      mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    } catch (_) { return null; }
  } else {
    // ローカルパス
    const fullPath = path.join(BASE_DIR, url.replace(/^\//, ''));
    if (!fs.existsSync(fullPath)) return null;
    try {
      data = fs.readFileSync(fullPath).toString('base64');
      mimeType = /\.png$/i.test(url) ? 'image/png' : 'image/jpeg';
    } catch (_) { return null; }
  }
  return { inline_data: { mime_type: mimeType, data } };
}

// ── スコアリングプロンプト ────────────────────────────────────
const SCORE_SCHEMA = `{
  "images": [
    {
      "score": 8.5,
      "thumbnailGrade": "A",
      "contentType": "player_action",
      "orientation": "landscape",
      "focalX": 55,
      "focalY": 35,
      "notes": "迫力あるシュートシーン"
    }
  ]
}`;

function _makePrompt(count, topic, mood) {
  const moodNote = mood === 'funny'
    ? '「笑える/驚き/バズりそう」な画像を高評価。ネタ・リアクション系優先。'
    : '「かっこいい/ドラマチック/一目で伝わる」画像を高評価。迫力・臨場感優先。';
  return `あなたは日本のサッカー YouTube 動画クリエイターです。
案件: "${topic}"

${count}枚の画像を順番に評価してください。
${moodNote}

各画像について JSON で返答: ${SCORE_SCHEMA}

score: 1〜10（小数可）
  10 = 完璧なサムネ候補・一目でクリックしたくなる
  7〜9 = 良質・動画に使える
  4〜6 = 普通・代替がなければ使う
  1〜3 = ぼやけ/無関係/ロゴのみ/文字ばかり → 使わない
thumbnailGrade: A（サムネ最適）| B（スライド用に良い）| C（使えなくはない）
contentType: player_portrait | player_action | team_group | stadium | celebration | logo | text_heavy | other
orientation: portrait（縦長）| landscape（横長）
focalX: 0〜100（被写体の水平位置 %、中央なら 50）
focalY: 0〜100（被写体の垂直位置 %、顔が上部なら 20〜30）
JSONのみ返答。`;
}

// ── Gemini REST API 直叩き ────────────────────────────────────
async function _callGeminiVision(parts, promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 未設定');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [...parts, { text: promptText }],
    }],
    generationConfig: { maxOutputTokens: 700 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 80)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── 1バッチのスコアリング ─────────────────────────────────────
async function _scoreBatch(batch, topic, mood) {
  const parts = [];
  const valid = [];

  // 並列でダウンロード・base64 変換
  const results = await Promise.all(batch.map(img => _toGeminiPart(img).catch(() => null)));
  results.forEach((part, i) => {
    if (part) { parts.push(part); valid.push(batch[i]); }
  });
  if (!valid.length) return [];

  try {
    const raw = await _callGeminiVision(parts, _makePrompt(valid.length, topic, mood));
    const m = raw?.match(/\{[\s\S]*\}/);
    if (!m) return valid.map(img => _defaultScore(img));
    const parsed = JSON.parse(m[0]);
    const scores = Array.isArray(parsed.images) ? parsed.images : [];
    return valid.map((img, i) => {
      const s = scores[i] || {};
      const focalX = Number(s.focalX) || 50;
      const focalY = Number(s.focalY) || 50;
      return {
        ...img,
        score:          Math.max(1, Math.min(10, Number(s.score) || 5)),
        thumbnailGrade: ['A','B','C'].includes(s.thumbnailGrade) ? s.thumbnailGrade : 'C',
        contentType:    s.contentType || 'other',
        orientation:    s.orientation || 'landscape',
        focalX,
        focalY,
        offsetX: focalX - 50,
        offsetY: focalY - 50,
        aiNotes: s.notes || '',
      };
    });
  } catch (e) {
    console.warn('[v4_image_selector] Gemini vision 失敗:', e.message);
    return valid.map(img => _defaultScore(img));
  }
}

function _defaultScore(img) {
  // 既存の visionScore があれば流用
  const vs = Number(img.visionScore) || 0;
  const score = vs >= 90 ? 7 : vs >= 70 ? 5 : 4;
  const isPortrait = img.role === 'player' || img.source === 'fotmob';
  return {
    ...img,
    score,
    thumbnailGrade: score >= 7 ? 'B' : 'C',
    contentType: isPortrait ? 'player_portrait' : 'other',
    orientation: isPortrait ? 'portrait' : 'landscape',
    focalX: 50, focalY: isPortrait ? 25 : 50,
    offsetX: 0, offsetY: isPortrait ? -25 : 0,
    aiNotes: '',
  };
}

// ── メイン: 画像リストをスコアリング ─────────────────────────
async function scoreImages(images, context = {}) {
  if (!images?.length) return [];
  const { topic = '', mood = 'cool' } = context;

  // スコアリング対象を優先順で絞る（上限 MAX_IMGS 枚）
  const prioritized = [...images]
    .sort((a, b) => {
      const pri = img => {
        if (img.stockProvider === 'official-index') return 0;
        if (img.source === 'fotmob') return 1;
        if (img.source === 'x') return 2;
        if (img.source === 'wikipedia') return 3;
        if (img.source === 'stock' && Number(img.visionScore || 0) >= 90) return 4;
        return 5;
      };
      return pri(a) - pri(b);
    })
    .slice(0, MAX_IMGS);

  console.log(`[v4_image_selector] ${prioritized.length}枚をスコアリング中...`);
  const scored = [];
  for (let i = 0; i < prioritized.length; i += BATCH) {
    const batch = prioritized.slice(i, i + BATCH);
    const result = await _scoreBatch(batch, topic, mood);
    scored.push(...result);
  }

  // スコアリング外の残り画像にデフォルトスコアを付与
  const scoredUrls = new Set(scored.map(img => img.url));
  for (const img of images) {
    if (!scoredUrls.has(img.url)) {
      scored.push(_defaultScore(img));
    }
  }

  const sorted = scored.sort((a, b) => (b.score || 0) - (a.score || 0));
  console.log(`[v4_image_selector] 完了: top3 scores = ${sorted.slice(0,3).map(i=>i.score.toFixed(1)).join(', ')}`);
  return sorted;
}

// ── 最適画像セットを選定 ─────────────────────────────────────
// 戻り値:
//   thumbnail  : サムネ + OP に使う1枚（A グレード優先、なければ最高スコア）
//   slideImages: スライドに使う最大6枚（多様なコンテンツタイプ優先）
function selectImageSet(scoredImages) {
  if (!scoredImages?.length) return { thumbnail: null, slideImages: [] };

  const sorted = [...scoredImages].sort((a, b) => (b.score || 0) - (a.score || 0));

  // サムネ候補: Aグレードから最高スコア、なければ Bグレード、なければ全体 top
  const gradeA = sorted.filter(img => img.thumbnailGrade === 'A');
  const gradeB = sorted.filter(img => img.thumbnailGrade === 'B');
  const thumbnail = gradeA[0] || gradeB[0] || sorted[0] || null;

  // スライド用: ロゴ・文字画像を除外、コンテンツタイプを多様化して最大6枚
  const EXCLUDE_TYPES = new Set(['logo', 'text_heavy']);
  const usable = sorted.filter(img => !EXCLUDE_TYPES.has(img.contentType) && img.score >= 4);

  const slideImages = [];
  const usedTypes   = new Set();

  // 1周目: 各タイプから1枚ずつ（多様性確保）
  for (const img of usable) {
    if (slideImages.length >= 6) break;
    const t = img.contentType || 'other';
    if (!usedTypes.has(t)) {
      slideImages.push(img);
      usedTypes.add(t);
    }
  }
  // 2周目: スコア順で残りを埋める
  for (const img of usable) {
    if (slideImages.length >= 6) break;
    if (!slideImages.some(s => s.url === img.url)) {
      slideImages.push(img);
    }
  }

  return { thumbnail, slideImages };
}

module.exports = { scoreImages, selectImageSet };
