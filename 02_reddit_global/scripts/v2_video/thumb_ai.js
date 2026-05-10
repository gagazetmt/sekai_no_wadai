// thumb_ai.js
// ═══════════════════════════════════════════════════════════
// サムネイル AI 生成パイプライン
//   1. classifyTheme()  : 動画情報 → 題材タイプ分類（DeepSeek）
//   2. buildPrompt()    : リネカパターン + DeepSeek で英語プロンプト生成
//   3. generateThumb()  : Imagen 4 で画像 N 枚並列生成（provider 抽象化）
//
// 環境変数:
//   GEMINI_API_KEY        - Google AI Studio の API キー（必須）
//   GEMINI_IMAGE_MODEL    - Imagen モデル名（任意・既定: imagen-4.0-generate-preview-06-06）
//   FAL_API_KEY           - fal.ai キー（将来 Seedream / Flux 切替時に使用）
// ═══════════════════════════════════════════════════════════

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { callAI } = require('../ai_client');

// ─── ファイルパス ──────────────────────────────────
const LINEKA_DIR        = path.join(__dirname, '_lineka_thumb');
const SYSTEM_BASE_FILE  = path.join(LINEKA_DIR, '_system_base.txt');
const CLASSIFIER_FILE   = path.join(LINEKA_DIR, '_classifier.txt');
const TEXT_EXTRACT_FILE = path.join(LINEKA_DIR, '_text_extractor.txt');
const PATTERN_DIR       = path.join(LINEKA_DIR, 'patterns');

const VALID_THEMES = [
  'rivalry', 'transfer', 'manager_change', 'injury',
  'legend', 'season_summary', 'preview', 'review', 'default',
];

// ─── 環境変数 ─────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const IMAGEN_MODEL   = process.env.GEMINI_IMAGE_MODEL
                    || 'imagen-4.0-generate-preview-06-06';

// ─── キャッシュ（パターンファイル読み込みは1回だけ）─
const _patternCache = {};
function _readPattern(name) {
  if (_patternCache[name]) return _patternCache[name];
  const file = name === '__base__'           ? SYSTEM_BASE_FILE
             : name === '__classifier__'     ? CLASSIFIER_FILE
             : name === '__text_extractor__' ? TEXT_EXTRACT_FILE
             : path.join(PATTERN_DIR, `${name}.txt`);
  _patternCache[name] = fs.readFileSync(file, 'utf8');
  return _patternCache[name];
}

// ═══════════════════════════════════════════════════
// 1. 題材分類
// ═══════════════════════════════════════════════════
/**
 * 動画情報から題材タイプを分類
 * @param {Object} input
 * @param {string} input.title - 動画タイトル
 * @param {Array<string>} [input.entities] - 主要エンティティ（選手/監督/チーム）
 * @param {string} [input.summary] - 補足情報
 * @returns {Promise<{theme, confidence, reasoning}>}
 */
async function classifyTheme(input) {
  const system = _readPattern('__classifier__');
  const userMsg = [
    `動画タイトル: ${input.title || ''}`,
    `主要エンティティ: ${(input.entities || []).join(', ')}`,
    input.summary ? `補足: ${input.summary}` : null,
  ].filter(Boolean).join('\n');

  const text = await callAI({
    forceProvider: 'deepseek',
    max_tokens: 2000,  // V4-Flash の reasoning トークンに食われないよう余裕を持たせる
    system,
    messages: [{ role: 'user', content: userMsg }],
  });

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { theme: 'default', confidence: 0, reasoning: '(parse failed): ' + (text || '').slice(0, 80) };
  try {
    const parsed = JSON.parse(m[0]);
    if (!VALID_THEMES.includes(parsed.theme)) parsed.theme = 'default';
    return {
      theme: parsed.theme,
      confidence: parsed.confidence || 0,
      reasoning: parsed.reasoning || '',
    };
  } catch (_) {
    return { theme: 'default', confidence: 0, reasoning: '(json error)' };
  }
}

// ═══════════════════════════════════════════════════
// 1.5 オープニングからサムネテキスト抽出
// ═══════════════════════════════════════════════════
/**
 * オープニングスライドの title + narration から、
 * サムネ内焼き込み用の topText / bottomText 短文を抽出
 * @param {{openingTitle, openingNarration}} input
 * @returns {Promise<{topText, bottomText, error?}>}
 */
async function extractThumbText(input) {
  const system = _readPattern('__text_extractor__');
  const userMsg = [
    'オープニングスライド情報:',
    `タイトル: ${input.openingTitle || ''}`,
    `ナレーション: ${input.openingNarration || ''}`,
    '',
    'この内容からサムネイル用の topText（上端煽り）と bottomText（下端結論）を抽出してください。',
  ].join('\n');

  const text = await callAI({
    forceProvider: 'deepseek',
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: userMsg }],
  });

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { topText: '', bottomText: '', error: '(parse failed): ' + (text || '').slice(0, 80) };
  try {
    const parsed = JSON.parse(m[0]);
    return {
      topText:    String(parsed.topText    || '').slice(0, 24),  // safety cap
      bottomText: String(parsed.bottomText || '').slice(0, 30),
    };
  } catch (_) {
    return { topText: '', bottomText: '', error: '(json error)' };
  }
}

// ═══════════════════════════════════════════════════
// 2. プロンプト生成（リネカパターン + DeepSeek）
// ═══════════════════════════════════════════════════
/**
 * リネカパターン仕様を system に流し、DeepSeek で英語プロンプト生成
 * @param {Object} input
 * @param {string} input.title         - 動画タイトル
 * @param {Array<string>} [input.entities]   - 主要エンティティ
 * @param {string} [input.summary]     - 補足情報
 * @param {string} [input.topText]     - 上端煽り文（日本語）
 * @param {string} [input.bottomText]  - 下端結論文（日本語）
 * @param {string} theme               - 題材タイプ
 * @returns {Promise<string>} 英語プロンプト1本
 */
async function buildPrompt(input, theme) {
  const safeTheme = VALID_THEMES.includes(theme) ? theme : 'default';
  const base    = _readPattern('__base__');
  const pattern = _readPattern(safeTheme);
  const system  = `${base}\n\n${'─'.repeat(40)}\n以下、今回の題材タイプ別パターン指示：\n${'─'.repeat(40)}\n\n${pattern}`;

  const userMsg = [
    '【動画情報】',
    `タイトル: ${input.title || ''}`,
    `主要エンティティ: ${(input.entities || []).join(', ')}`,
    input.summary ? `補足: ${input.summary}` : null,
    '',
    '【日本語テキスト指定】',
    `上端煽り文: ${input.topText || ''}`,
    `下端結論文: ${input.bottomText || ''}`,
    '',
    `題材タイプ: ${safeTheme}`,
    '',
    'このパターン指示に従って、Imagen 4 用の英語プロンプトを 1 本生成してください。説明や前置きは絶対に書かず、英語プロンプト本体のみ返答してください。',
  ].filter(s => s !== null).join('\n');

  const text = await callAI({
    forceProvider: 'deepseek',
    max_tokens: 4000,  // V4-Flash の reasoning + 英語プロンプト本体（長め）の余裕
    system,
    messages: [{ role: 'user', content: userMsg }],
  });

  // DeepSeek が前置きを書いてしまった場合に "Photorealistic" 以降だけ抽出
  const cleaned = text.trim();
  const idx = cleaned.indexOf('Photorealistic');
  return idx > 0 ? cleaned.slice(idx) : cleaned;
}

// ═══════════════════════════════════════════════════
// 3. 画像生成（provider 抽象化）
// ═══════════════════════════════════════════════════
/**
 * Imagen 4 (Gemini API) で画像生成
 */
async function _generateImagen4({ prompt, count, aspectRatio, outputDir }) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${GEMINI_API_KEY}`;
  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: count,
      aspectRatio,
      personGeneration: 'ALLOW_ADULT',
    },
  };

  let res;
  try {
    res = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 90000,
      validateStatus: () => true,
    });
  } catch (e) {
    throw new Error(`Imagen 4 network error: ${e.message}`);
  }

  if (res.status !== 200) {
    const errMsg = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`Imagen 4 API ${res.status}: ${errMsg.slice(0, 500)}`);
  }

  const predictions = (res.data && res.data.predictions) || [];
  if (predictions.length === 0) {
    throw new Error(`Imagen 4: 生成結果なし。raw=${JSON.stringify(res.data).slice(0, 300)}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const ts = Date.now();
  const results = [];

  predictions.forEach((p, i) => {
    if (!p.bytesBase64Encoded) return;
    const filename = `imagen4_${ts}_${i}.png`;
    const fullPath = path.join(outputDir, filename);
    fs.writeFileSync(fullPath, Buffer.from(p.bytesBase64Encoded, 'base64'));
    results.push({
      file: filename,
      path: fullPath,
      provider: 'imagen4',
      model: IMAGEN_MODEL,
    });
  });

  return results;
}

/**
 * fal.ai 経由で生成（Seedream / Flux など）— 将来実装
 */
async function _generateFal(_opts) {
  throw new Error('fal.ai integration not yet implemented');
}

/**
 * メインエントリ：provider 抽象化された画像生成
 * @param {Object} opts
 * @param {string} [opts.provider='imagen4']  - 'imagen4' / 'fal/seedream' / 'fal/flux-pro'
 * @param {string} opts.prompt                - 英語プロンプト本体
 * @param {number} [opts.count=5]             - 生成枚数
 * @param {string} [opts.aspectRatio='16:9']  - アスペクト比
 * @param {string} opts.outputDir             - 保存先ディレクトリ（自動作成）
 * @returns {Promise<Array<{file, path, provider, model}>>}
 */
async function generateThumb(opts) {
  const {
    provider    = 'imagen4',
    prompt,
    count       = 5,
    aspectRatio = '16:9',
    outputDir,
  } = opts;

  if (!prompt)    throw new Error('prompt required');
  if (!outputDir) throw new Error('outputDir required');

  switch (provider) {
    case 'imagen4':
      return await _generateImagen4({ prompt, count, aspectRatio, outputDir });
    case 'fal/seedream':
    case 'fal/flux-pro':
    case 'fal/flux-ultra':
      return await _generateFal({ provider, prompt, count, aspectRatio, outputDir });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ═══════════════════════════════════════════════════
// 公開 API
// ═══════════════════════════════════════════════════
module.exports = {
  classifyTheme,
  extractThumbText,
  buildPrompt,
  generateThumb,
  VALID_THEMES,
};
