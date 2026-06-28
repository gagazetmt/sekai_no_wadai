// launcher/whisper.js
// Whisper API でナレーション音声 → 単語タイムスタンプ取得
// 字幕チャンク生成 + 正確なナレーション終了時刻を返す

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const CHARS_PER_CHUNK = 18;

// ── Whisper API 呼び出し ─────────────────────────────

async function transcribeAudio(audioPath) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  if (!fs.existsSync(audioPath)) throw new Error(`File not found: ${audioPath}`);

  const { Blob } = require('buffer');
  const audioData = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath).slice(1) || 'wav';

  const form = new FormData();
  form.append('file', new Blob([audioData]), `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', 'ja');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper API ${res.status}: ${errText}`);
  }

  return await res.json();
}

// ── 単語 → 字幕チャンク変換 ──────────────────────────

function buildSubtitleChunks(words, charsPerChunk = CHARS_PER_CHUNK) {
  if (!words?.length) return [];

  const chunks = [];
  let currentText = '';
  let currentStart = words[0].start;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const wordText = (w.word || w.text || '').trim();
    if (!wordText) continue;

    if (currentText.length + wordText.length > charsPerChunk && currentText.length > 0) {
      chunks.push({
        text: currentText.trim(),
        start: currentStart,
        end: words[i - 1]?.end || w.start,
      });
      currentText = wordText;
      currentStart = w.start;
    } else {
      currentText += wordText;
    }
  }

  if (currentText.trim()) {
    chunks.push({
      text: currentText.trim(),
      start: currentStart,
      end: words[words.length - 1]?.end || currentStart + 1,
    });
  }

  return chunks;
}

// ── 全ナレーション一括処理 ────────────────────────────

async function whisperAll(audioFiles, leadPad = 0) {
  console.log('\n=== Whisper: Transcribing narrations ===\n');

  const results = [];

  for (let i = 0; i < audioFiles.length; i++) {
    const audioPath = audioFiles[i];

    if (!audioPath || !fs.existsSync(audioPath)) {
      console.log(`  [${i}] スキップ（音声なし）`);
      results.push({ chunks: [], narrationEndSec: 0, words: [] });
      continue;
    }

    try {
      console.log(`  [${i}] Whisper...`);
      const data = await transcribeAudio(audioPath);
      const words = data.words || [];

      const lastEnd = words.length ? words[words.length - 1].end : 0;
      const narrationEndSec = lastEnd;  // audio は t=0 スタート。leadPad offset 不要

      const chunks = buildSubtitleChunks(words);

      // チャンクの時刻に leadPad を加算
      for (const c of chunks) {
        c.start += leadPad;
        c.end   += leadPad;
      }

      const segments = data.segments || [];
      console.log(`  [${i}] → ${words.length}語 / ${segments.length}セグ / ${chunks.length}チャンク / 終了${narrationEndSec.toFixed(1)}s`);
      results.push({ chunks, narrationEndSec, words, segments });
    } catch (err) {
      console.warn(`  [${i}] Whisper失敗: ${err.message}`);
      results.push({ chunks: [], narrationEndSec: 0, words: [] });
    }
  }

  return results;
}

module.exports = { transcribeAudio, buildSubtitleChunks, whisperAll };
