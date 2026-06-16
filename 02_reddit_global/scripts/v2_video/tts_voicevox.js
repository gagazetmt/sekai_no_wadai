'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { applyJpDict } = require('./jp_dict');
const { callAI } = require('../ai_client');

const API_BASE = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';
const DEFAULT_VOICE = String(process.env.VOICEVOX_MAIN_SPEAKER || '13');
const DEFAULT_MODEL = 'voicevox-engine';
const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';

const MALE_COMMENT_VOICES = [
  { id: '11', label: '玄野武宏（ノーマル）' },
  { id: '12', label: '白上虎太郎（ふつう）' },
  { id: '21', label: '剣崎雌雄（ノーマル）' },
  { id: '27', label: '後鬼（人間ver.）' },
];

const FEMALE_COMMENT_VOICES = [
  { id: '8', label: '春日部つむぎ（ノーマル）' },
];

const PRESET_VOICES = [
  { id: '13', label: '青山龍星（ノーマル・メイン）' },
  ...MALE_COMMENT_VOICES,
  ...FEMALE_COMMENT_VOICES,
];
const PRESET_MODELS = [{ id: DEFAULT_MODEL, label: 'VOICEVOX Engine' }];

let commentVoiceQueue = [];

function randomVoice(pool) {
  return pool[Math.floor(Math.random() * pool.length)].id;
}

function refillCommentVoiceQueue() {
  commentVoiceQueue = [
    ...Array.from({ length: 4 }, () => randomVoice(MALE_COMMENT_VOICES)),
    randomVoice(FEMALE_COMMENT_VOICES),
  ];
  for (let i = commentVoiceQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [commentVoiceQueue[i], commentVoiceQueue[j]] = [commentVoiceQueue[j], commentVoiceQueue[i]];
  }
}

function pickCommentVoice() {
  if (!commentVoiceQueue.length) refillCommentVoiceQueue();
  return commentVoiceQueue.shift();
}

function sanitize(text) {
  return applyJpDict(String(text || ''))
    .replace(/\bW杯\b/gi, 'ワールドカップ')
    .replace(/\bCL\b/g, 'チャンピオンズリーグ')
    .replace(/\bEL\b/g, 'ヨーロッパリーグ')
    .replace(/\bPL\b/g, 'プレミアリーグ')
    .replace(/\bFIFA\b/gi, 'フィファ')
    .replace(/\bUEFA\b/gi, 'ウエファ')
    .replace(/\bVAR\b/g, 'ビデオ判定')
    .replace(/\bPK\b/g, 'ペナルティーキック')
    .replace(/\bGK\b/g, 'ゴールキーパー')
    .replace(/\bDF\b/g, 'ディフェンダー')
    .replace(/\bMF\b/g, 'ミッドフィルダー')
    .replace(/\bFW\b/g, 'フォワード')
    .replace(/\r?\n+/g, '。')
    .trim();
}

const NARRATION_CLEAN_PROMPT = `あなたはVOICEVOX音声合成の前処理専門です。
入力テキストを、VOICEVOXが自然に読み上げられる形に変換してください。

ルール:
- 中黒（・）を除去して固有名詞を一語にする（例: レアル・マドリー→レアルマドリー、リオネル・メッシ→リオネルメッシ）
- 外国人名のスペースを除去（例: ルカ モドリッチ→ルカモドリッチ）
- "" "" 「」 『』 （） などの括弧・引用符を除去（中の内容はそのまま残す）
- …（三点リーダ）、——（ダッシュ）、※ 等の装飾記号を除去または自然な日本語に変換
- 数字+英字の略語はカタカナに（例: 3G→スリージー は不要、そのまま）
- 句読点（、。）と感嘆符（！？）はそのまま残す（VOICEVOXのブレイク制御に必要）
- 意味・内容・語順は一切変えない
- 出力はクリーンテキストのみ。説明や注釈は絶対に付けない`;

async function deepseekNarrationClean(text) {
  if (!text || text.length < 5) return text;
  try {
    const result = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-chat',
      max_tokens: 500,
      label: 'voicevox-narration-clean',
      messages: [{ role: 'user', content: text }],
      system: NARRATION_CLEAN_PROMPT,
    });
    const cleaned = (result || '').trim();
    if (cleaned.length < 3) return text;
    return cleaned;
  } catch (e) {
    console.warn(`⚠️ DeepSeek narration clean 失敗、元テキスト使用: ${e.message}`);
    return text;
  }
}

function convertWavToMp3(wavPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-y', '-loglevel', 'error', '-i', wavPath,
      '-ar', '32000', '-ac', '1', '-b:a', '128k', outputPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', code => code === 0
      ? resolve(outputPath)
      : reject(new Error(`VOICEVOX ffmpeg ${code}: ${stderr.slice(-300)}`)));
  });
}

async function generateVoiceVoxTTS(opts = {}) {
  const sanitized = sanitize(opts.text);
  const text = await deepseekNarrationClean(sanitized);
  const outputPath = opts.outputPath;
  const speaker = Number(opts.voiceId ?? DEFAULT_VOICE);
  if (!text) throw new Error('text is required');
  if (!outputPath) throw new Error('outputPath is required');

  const queryRes = await fetch(
    `${API_BASE}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    { method: 'POST', signal: AbortSignal.timeout(30000) },
  );
  if (!queryRes.ok) throw new Error(`VOICEVOX audio_query: ${queryRes.status}`);
  const query = await queryRes.json();
  query.speedScale = Math.max(0.5, Math.min(2.0, Number(opts.speed) || 1.22));
  query.intonationScale = 1.2;
  query.volumeScale = 1.05;

  const synthesisRes = await fetch(`${API_BASE}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(60000),
  });
  if (!synthesisRes.ok) throw new Error(`VOICEVOX synthesis: ${synthesisRes.status}`);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const wavPath = `${outputPath}.voicevox.wav`;
  fs.writeFileSync(wavPath, Buffer.from(await synthesisRes.arrayBuffer()));
  try {
    await convertWavToMp3(wavPath, outputPath);
  } finally {
    try { fs.unlinkSync(wavPath); } catch (_) {}
  }
  return outputPath;
}

module.exports = {
  generateVoiceVoxTTS,
  pickCommentVoice,
  DEFAULT_VOICE,
  DEFAULT_MODEL,
  PRESET_VOICES,
  PRESET_MODELS,
  MALE_COMMENT_VOICES,
  FEMALE_COMMENT_VOICES,
};
