// scripts/v2_video/tts_minimax.js
// MiniMax T2A v2 を呼んで mp3 を生成する薄いラッパ
//
// 使い方:
//   const { generateMiniMaxTTS, splitIntoChunks, sanitizeForTts } = require('./tts_minimax');
//   await generateMiniMaxTTS({ text, outputPath, voiceId, emotion, speed });

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const API_URL    = 'https://api-uw.minimax.io/v1/t2a_v2';
const MODEL      = process.env.MINIMAX_TTS_MODEL || 'speech-02-turbo';
const DEFAULT_VOICE = process.env.MINIMAX_DEFAULT_VOICE
  || 'moss_audio_6e0620ed-3af8-11f1-beb2-9257c801a481';   // master-voice (clone)

const PRESET_VOICES = [
  { id: 'moss_audio_6e0620ed-3af8-11f1-beb2-9257c801a481', label: '🎤 自前クローン (デフォルト)' },
  { id: 'male-qn-qingse',          label: '男性・青涩' },
  { id: 'male-qn-jingying',        label: '男性・精英' },
  { id: 'male-qn-badao',           label: '男性・霸道' },
  { id: 'presenter_male',          label: '男性プレゼンター' },
  { id: 'audiobook_male_1',        label: '男性オーディオブック' },
  { id: 'female-shaonv',           label: '女性・少女' },
  { id: 'female-yujie',            label: '女性・御姉' },
  { id: 'presenter_female',        label: '女性プレゼンター' },
  { id: 'audiobook_female_1',      label: '女性オーディオブック' },
];

const PRESET_MODELS = [
  { id: 'speech-02-turbo', label: 'speech-02-turbo (速い・安い・既定)' },
  { id: 'speech-02-hd',    label: 'speech-02-hd (高音質)' },
  { id: 'speech-2.8-hd',   label: 'speech-2.8-hd (最新HD)' },
  { id: 'speech-2.6-turbo',label: 'speech-2.6-turbo' },
];

// MiniMax で公式に受け付ける感情キー（speech-2.x 系）
// 参考: https://www.minimax.io/api-reference/tts/text-to-speech
const ALLOWED_EMOTIONS = new Set([
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral'
]);

// 日本語ナレ向けの軽サニタイズ（読み崩れ防止）
//  - スコア表記 "3-1" を「さんたいいち」風に
//  - 中点・全角スラッシュ等を整える
//  - 連続空白の正規化
function sanitizeForTts(text) {
  if (!text) return '';
  const numToJa = (n) => {
    const v = parseInt(n, 10);
    const d = ['ぜろ','いち','に','さん','よん','ご','ろく','なな','はち','きゅう'];
    if (v < 10) return d[v];
    if (v === 10) return 'じゅう';
    return 'じゅう' + d[v - 10];
  };
  return String(text)
    // "3-1" / "3−1" / "3ー1" 等のスコア → 「さんたいいち」
    .replace(/(\d+)\s*[-－ー−–—]\s*(\d+)/g, (_m, a, b) =>
      `${numToJa(a)}たい${numToJa(b)}`)
    // 全角・半角の括弧を読みやすく
    .replace(/【([^】]+)】/g, '$1')
    .replace(/〝([^〟]+)〟/g, '$1')
    // 中点除去
    .replace(/[・·]/g, '')
    // 改行 → 全角空白
    .replace(/\r?\n+/g, '　')
    .trim();
}

// ナレーション本文を chunk に分割（最大 ~180文字目安）
//   1) narrationChunks[] が既にあれば優先
//   2) 「。！？」で文末分割 → 短すぎる文は前後に結合
function splitIntoChunks(text, existingChunks) {
  if (Array.isArray(existingChunks) && existingChunks.length) {
    return existingChunks.map(c => String(c || '').trim()).filter(Boolean);
  }
  if (!text) return [];
  const raw = String(text).trim();
  if (raw.length <= 180) return [raw];

  // 文末 (。！？) で分割
  const parts = raw.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean);
  // 短い文は次の文と結合（最大 180文字目安）
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length <= 180) {
      buf += p;
    } else {
      if (buf) out.push(buf);
      buf = p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// MiniMax 呼び出し本体
//  opts: { text, outputPath, voiceId?, emotion?, speed?, vol?, pitch? }
async function generateMiniMaxTTS(opts = {}) {
  const {
    text,
    outputPath,
    voiceId = DEFAULT_VOICE,
    model   = MODEL,
    emotion,
    speed   = 1.0,
    vol     = 1.0,
    pitch   = 0,
  } = opts;
  if (!text)        throw new Error('text is required');
  if (!outputPath)  throw new Error('outputPath is required');

  const apiKey  = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey || !groupId) {
    throw new Error('MINIMAX_API_KEY / MINIMAX_GROUP_ID が未設定');
  }

  const safeText = sanitizeForTts(text);
  if (!safeText) throw new Error('text after sanitize is empty');

  const voiceSetting = {
    voice_id: voiceId,
    speed: Math.max(0.5, Math.min(2.0, Number(speed) || 1.0)),
    vol:   Math.max(0.0, Math.min(2.0, Number(vol)   || 1.0)),
    pitch: Math.max(-12, Math.min(12,  Number(pitch) || 0)),
  };
  // emotion は許容値のみ載せる（無効値は API が弾く）
  const eKey = (emotion || '').toLowerCase();
  if (ALLOWED_EMOTIONS.has(eKey) && eKey !== 'neutral') {
    voiceSetting.emotion = eKey;
  }

  const reqBody = {
    model,
    text: safeText,
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: 32000,
      bitrate:     128000,
      format:      'mp3',
      channel:     1,
    },
    output_format: 'hex',
  };

  const res = await axios.post(`${API_URL}?GroupId=${groupId}`, reqBody, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
  });

  if (!res.data?.data?.audio) {
    throw new Error(`MiniMax API: ${JSON.stringify(res.data?.base_resp || res.data)}`);
  }
  // 出力先ディレクトリを保証
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(res.data.data.audio, 'hex'));
  return outputPath;
}

// mp3 ファイルから duration(秒) を取得 — ffprobe 経由
function probeDurationSec(filePath) {
  const FFPROBE = process.platform === 'win32'
    ? 'C:\\ffmpeg\\bin\\ffprobe.exe'
    : 'ffprobe';
  try {
    const out = require('child_process').execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of default=nw=1:nk=1 "${filePath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const v = parseFloat(String(out).trim());
    return Number.isFinite(v) ? v : 0;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  generateMiniMaxTTS,
  splitIntoChunks,
  sanitizeForTts,
  probeDurationSec,
  DEFAULT_VOICE,
  DEFAULT_MODEL: MODEL,
  PRESET_VOICES,
  PRESET_MODELS,
  ALLOWED_EMOTIONS: Array.from(ALLOWED_EMOTIONS),
};
