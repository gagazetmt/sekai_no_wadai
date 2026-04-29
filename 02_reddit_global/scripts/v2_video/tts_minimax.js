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
const { applyJpDict } = require('./jp_dict');

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

// 数字 → ひらがな読み（0〜9999 までカバー）
//   29 → "にじゅうきゅう"
//   100 → "ひゃく"
//   3000 → "さんぜん"
function numToFullJa(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return 'ゼロ';
  const ones  = ['', 'いち','に','さん','よん','ご','ろく','なな','はち','きゅう'];
  const ten100 = (h) => h === 1 ? 'ひゃく' : h === 3 ? 'さんびゃく' : h === 6 ? 'ろっぴゃく' : h === 8 ? 'はっぴゃく' : ones[h] + 'ひゃく';
  const ten1000 = (k) => k === 1 ? 'せん' : k === 3 ? 'さんぜん' : k === 8 ? 'はっせん' : ones[k] + 'せん';
  if (n < 10) return ones[n];
  if (n < 100) {
    const t = Math.floor(n / 10), o = n % 10;
    const tStr = t === 1 ? 'じゅう' : ones[t] + 'じゅう';
    return tStr + (o ? ones[o] : '');
  }
  if (n < 1000) {
    const h = Math.floor(n / 100), rest = n % 100;
    return ten100(h) + (rest ? numToFullJa(rest) : '');
  }
  if (n < 10000) {
    const k = Math.floor(n / 1000), rest = n % 1000;
    return ten1000(k) + (rest ? numToFullJa(rest) : '');
  }
  return String(n);
}

// 1桁用（スコア "3-1" 等で従来から使ってる "ふた/みっつ" 系の短縮形は使わない）
function numToJa1(n) {
  const v = parseInt(n, 10);
  const d = ['ゼロ','いち','に','さん','よん','ご','ろく','なな','はち','きゅう'];
  if (v < 10) return d[v] || String(v);
  return numToFullJa(v);
}

// 日本語ナレ向けの軽サニタイズ（読み崩れ防止）
//  - スコア表記 "3-1" を「さんたいいち」風に
//  - "29試合" のような 数字+カウンター を「にじゅうきゅうしあい」風にカタカナ化
//    （TTSが「ふたじゅうきゅう」のような誤読を出す問題への対策）
//  - 中点・全角スラッシュ等を整える
//  - 連続空白の正規化
function sanitizeForTts(text) {
  if (!text) return '';
  // 辞書置換 → スコア → 数字+単位 → 括弧/中点/改行の順
  return applyJpDict(String(text))
    // "3-1" / "3−1" / "3ー1" 等のスコア → 「さんたいいち」
    .replace(/(\d+)\s*[-－ー−–—]\s*(\d+)/g, (_m, a, b) =>
      `${numToJa1(a)}たい${numToJa1(b)}`)
    // 数字+カウンター → カタカナ読み（よく出る単位を網羅）
    .replace(/(\d+)(試合|ゴール|得点|失点|アシスト|キャップ|歳|回|位|連勝|連敗|連覇|周年|シーズン|チーム|本|人|分|秒|億|万|千|度|度目|個)/g,
      (_m, num, unit) => numToFullJa(num) + unit)
    // 全角・半角の括弧を読みやすく
    .replace(/【([^】]+)】/g, '$1')
    .replace(/〝([^〟]+)〟/g, '$1')
    // 中点除去
    .replace(/[・·]/g, '')
    // 改行 → 全角空白
    .replace(/\r?\n+/g, '　')
    .trim();
}

// ナレーション本文を chunk に分割（最大 ~100文字目安）
//   1) narrationChunks[] が既にあれば優先（AI による意味整合分割）
//   2) 「。！？」で文末分割 → 短すぎる文は前後に結合（最大 100文字）
//   ※ 旧 180文字 bundle だと 1 chunk が 30秒近くになり字幕が長時間切替らないため縮小
function splitIntoChunks(text, existingChunks) {
  if (Array.isArray(existingChunks) && existingChunks.length) {
    return existingChunks.map(c => String(c || '').trim()).filter(Boolean);
  }
  if (!text) return [];
  const raw = String(text).trim();
  if (raw.length <= 100) return [raw];

  // 文末 (。！？) で分割
  const parts = raw.split(/(?<=[。！？])/).map(s => s.trim()).filter(Boolean);
  // 短い文は次の文と結合（最大 100文字目安）
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length <= 100) {
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

// モジュールタイプを考慮してTTSチャンクを構築する。
//   - reaction: narration の冒頭 + comments[] を順次音声化（コメントも読み上げる）
//   - insight / history: chunkAware（narrationを文末分割）
//   - その他: narration を1つのチャンクに
function buildChunksForModule(mod) {
  if (!mod) return [];
  const chunkAware = ['insight', 'reaction', 'history'].includes(mod.type);
  const baseChunks = chunkAware
    ? splitIntoChunks(mod.narration, mod.narrationChunks)
    : [String(mod.narration || '').trim()].filter(Boolean);

  if (mod.type === 'reaction') {
    const commentChunks = (Array.isArray(mod.comments) ? mod.comments : [])
      .map(c => String(c?.text || '').trim())
      .filter(Boolean)
      .slice(0, 7);
    return [...baseChunks, ...commentChunks];
  }
  return baseChunks;
}

module.exports = {
  generateMiniMaxTTS,
  splitIntoChunks,
  buildChunksForModule,
  sanitizeForTts,
  probeDurationSec,
  DEFAULT_VOICE,
  DEFAULT_MODEL: MODEL,
  PRESET_VOICES,
  PRESET_MODELS,
  ALLOWED_EMOTIONS: Array.from(ALLOWED_EMOTIONS),
};
