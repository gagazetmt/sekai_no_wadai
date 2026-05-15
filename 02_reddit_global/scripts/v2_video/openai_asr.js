// scripts/v2_video/openai_asr.js
// OpenAI Whisper API で音声 → word-level timestamps を取得する
//
// 用途: combined narration (全 slide 1 本取り音声) を ASR して
//   字幕や catchphrase の出現タイミングを word 単位で完全同期する
//
// API: openai.audio.transcriptions.create
//   model: whisper-1
//   response_format: verbose_json
//   timestamp_granularities: ['word']
//   料金: $0.006 / min (1動画350s で約 ¥5)
//   制限: 25MB / 1 リクエスト (≒ 30 分 mp3 128kbps)
//
// gemini_asr.js と同じ interface (transcribeWithTimestamps) を提供
//
// env:
//   OPENAI_API_KEY  - 必須

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const fs = require('fs');
const OpenAI = require('openai');

const MODEL = process.env.OPENAI_ASR_MODEL || 'whisper-1';
let _client = null;
function _getClient() {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 未設定');
  _client = new OpenAI({ apiKey });
  return _client;
}

/**
 * 音声ファイルを transcribe + word timestamps 取得
 * @param {string} audioFilePath - mp3 / wav / m4a / ogg
 * @param {object} opts - { language? = 'ja', model? }
 * @returns {Promise<Array<{text:string, start:number, end:number}>>}
 *   gemini_asr 互換 (Whisper の word フィールドを text にリネーム)
 */
async function transcribeWithTimestamps(audioFilePath, opts = {}) {
  const language = opts.language || 'ja';
  const model = opts.model || MODEL;
  const client = _getClient();

  const MAX_RETRIES = 2;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await client.audio.transcriptions.create({
        file: fs.createReadStream(audioFilePath),
        model,
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
        language,
      });
      const rawWords = Array.isArray(res.words) ? res.words : [];
      return rawWords
        .filter(w => w && typeof w.start === 'number' && typeof w.end === 'number')
        .map(w => ({
          text: String(w.word || w.text || ''),
          start: w.start,
          end: w.end,
        }));
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      if (status === 429 && attempt < MAX_RETRIES) {
        const waitMs = 5000 + attempt * 10000;
        console.warn(`  ⏳ Whisper 429 → ${waitMs / 1000}s 待機して再試行 (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if ((status === undefined || status >= 500) && attempt < MAX_RETRIES) {
        console.warn(`  ⏳ Whisper ${status || 'connection'} → 5s 待機して再試行 (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Whisper ASR unknown failure');
}

module.exports = {
  transcribeWithTimestamps,
  MODEL,
};
