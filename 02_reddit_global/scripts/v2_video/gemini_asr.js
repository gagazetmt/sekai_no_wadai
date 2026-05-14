// scripts/v2_video/gemini_asr.js
// Gemini multimodal で音声 → word-level timestamps を取得する
//
// 用途: 1 スライド 1 chunk で TTS 生成した音声を ASR して、
//   字幕や catchphrase の出現タイミングを word 単位で完全同期する
//
// API: gemini-2.5-flash (multimodal) で audio 入力 + JSON 出力
//   料金: input audio $0.075/1M tokens, output text $0.30/1M tokens
//   コスト: 1 chunk ASR ≒ 0.01 円程度（同プロジェクト枠で無視できる）
//
// env:
//   GEMINI_API_KEY(S) - TTS と共通
//   GEMINI_ASR_MODEL  - 任意（既定: gemini-2.5-flash）

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const axios = require('axios');
const fs = require('fs');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const ASR_MODEL = process.env.GEMINI_ASR_MODEL || 'gemini-2.5-flash';

function _getApiKeys() {
  const csv = process.env.GEMINI_API_KEYS;
  if (csv) return csv.split(',').map(k => k.trim()).filter(Boolean);
  if (process.env.GEMINI_API_KEY) return [process.env.GEMINI_API_KEY];
  return [];
}
let _asrKeyIdx = 0;

const PROMPT = [
  'この日本語音声を transcribe して、各単語または短いフレーズの開始時刻と終了時刻を秒単位で返してください。',
  '応答は以下の JSON 配列形式のみ、前置き・説明文・コードブロック等不要:',
  '[{"text": "遠藤航", "start": 0.0, "end": 0.8}, {"text": "の怪我", "start": 0.8, "end": 1.4}, ...]',
  '時刻は実音声でその単語が発音されている範囲を示してください。',
  '可能な限り細かく単語単位で分けてください（理想は 2-5 文字単位）。'
].join('\n');

function _mimeFromExt(filePath) {
  const ext = String(filePath).split('.').pop().toLowerCase();
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'ogg') return 'audio/ogg';
  return 'audio/mpeg';
}

/**
 * 音声ファイルを transcribe + word timestamps 取得
 * @param {string} audioFilePath - mp3 / wav / m4a / ogg 何でも OK
 * @param {object} opts - { apiKey?, model? }
 * @returns {Promise<Array<{text:string, start:number, end:number}>>}
 */
async function transcribeWithTimestamps(audioFilePath, opts = {}) {
  const keys = _getApiKeys();
  const apiKey = opts.apiKey || keys[_asrKeyIdx];
  if (!apiKey) throw new Error('GEMINI_API_KEY(S) が未設定');
  const model = opts.model || ASR_MODEL;

  const audioBuf = fs.readFileSync(audioFilePath);
  const mimeType = _mimeFromExt(audioFilePath);
  const base64 = audioBuf.toString('base64');

  const URL = `${API_BASE}/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: PROMPT },
      ],
    }],
    generationConfig: { temperature: 0 },
  };

  // timeout 180s + 最大 2 回 retry（timeout / JSON not found / JSON parse fail 全てに対応）
  const TIMEOUT_MS = 180000;
  const MAX_RETRIES = 2;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await axios.post(URL, body, { timeout: TIMEOUT_MS, validateStatus: () => true });
    } catch (e) {
      lastErr = e;
      if (/timeout/i.test(e.message) && attempt < MAX_RETRIES) {
        console.warn(`  ⏳ Gemini ASR timeout → retry (${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }
      throw e;
    }

    if (res.status === 429) {
      if (keys.length > 1) _asrKeyIdx = (_asrKeyIdx + 1) % keys.length;
      const err = new Error(`Gemini ASR 429: ${JSON.stringify(res.data).slice(0, 200)}`);
      err.is429 = true;
      throw err;
    }
    if (res.status !== 200) {
      lastErr = new Error(`Gemini ASR ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        console.warn(`  ⏳ Gemini ASR ${res.status} → retry (${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }
      throw lastErr;
    }
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) {
      lastErr = new Error(`Gemini ASR: JSON array not found. raw: ${text.slice(0, 200)}`);
      if (attempt < MAX_RETRIES) {
        console.warn(`  ⏳ Gemini ASR JSON array not found → retry (${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }
      throw lastErr;
    }
    let words = null;
    try {
      words = JSON.parse(m[0]);
    } catch (e) {
      // 1) 修復試行: 末尾切れ JSON を最後の正常 `}` までで閉じて再 parse
      words = _tryRepairJsonArray(m[0]);
      if (words) {
        console.warn(`  🔧 Gemini ASR JSON 修復成功 (${words.length} エントリ採用)`);
      } else {
        lastErr = new Error(`Gemini ASR JSON parse fail: ${e.message}`);
        if (attempt < MAX_RETRIES) {
          console.warn(`  ⏳ Gemini ASR JSON parse fail → retry (${attempt + 1}/${MAX_RETRIES})`);
          continue;
        }
        throw lastErr;
      }
    }
    if (!Array.isArray(words)) {
      lastErr = new Error('Gemini ASR: not an array');
      if (attempt < MAX_RETRIES) {
        console.warn(`  ⏳ Gemini ASR not-array → retry (${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }
      throw lastErr;
    }
    return words
      .filter(w => w && typeof w.text === 'string' && typeof w.start === 'number' && typeof w.end === 'number')
      .map(w => ({ text: w.text, start: w.start, end: w.end }));
  }
  throw lastErr || new Error('Gemini ASR unknown failure');
}

// JSON array が途中切れの場合の修復: 最後の正常な `}` までで切って閉じる
//   例: '[{"a":1},{"b":2},{"c":' → '[{"a":1},{"b":2}]'
function _tryRepairJsonArray(str) {
  if (typeof str !== 'string') return null;
  const lastCurly = str.lastIndexOf('}');
  if (lastCurly < 0) return null;
  // `[` から始まる前提
  const startBracket = str.indexOf('[');
  if (startBracket < 0 || startBracket > lastCurly) return null;
  const candidate = str.slice(startBracket, lastCurly + 1) + ']';
  try {
    const arr = JSON.parse(candidate);
    if (Array.isArray(arr) && arr.length > 0) return arr;
  } catch (_) {}
  return null;
}

module.exports = {
  transcribeWithTimestamps,
  ASR_MODEL,
  getApiKeys: _getApiKeys,
};
