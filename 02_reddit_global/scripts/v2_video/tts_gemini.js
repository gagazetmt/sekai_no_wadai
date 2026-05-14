// scripts/v2_video/tts_gemini.js
// Google Gemini 3.1 Flash TTS の薄いラッパ
//
// 使い方（tts_minimax.js と互換 API）:
//   const { generateGeminiTTS, splitIntoChunks, buildChunksForModule, probeDurationSec,
//           DEFAULT_VOICE, DEFAULT_MODEL, PRESET_VOICES, PRESET_MODELS } = require('./tts_gemini');
//   await generateGeminiTTS({ text, outputPath: '.../foo.mp3', voiceId, model, styleInstructions });
//
// 採用構成（2026-05-12 決定 / memory/project_voice_selection_2026-04-30.md 末尾参照）:
//   - モデル: gemini-3.1-flash-tts-preview
//   - voice:  Algenib（若手熱血リポーター）
//   - Style Instructions: 「若い20代の熱血サッカーリポーター」プロンプト
//
// 出力:
//   - 内部では Gemini API から L16 PCM 24kHz mono を受け取り、WAV ヘッダ付与 → ffmpeg で mp3 化
//   - outputPath が .wav なら WAV を返す（mp3 変換スキップ）
//
// 環境変数:
//   GEMINI_API_KEY       - 必須
//   GEMINI_TTS_MODEL     - 任意（既定: gemini-3.1-flash-tts-preview）
//   GEMINI_TTS_VOICE     - 任意（既定: Algenib）

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { spawn, execSync } = require('child_process');

// MiniMax 側と同じロジックを流用する箇所（splitIntoChunks / buildChunksForModule / probeDurationSec）
const _minimax = require('./tts_minimax');
const { applyJpDict } = require('./jp_dict');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// 2026-05-13 (再更新): 相棒指示で 3.1 Flash TTS に再戻し（品質優先）。
//   過去経緯: 3.1 Flash → 100 RPD 枯渇 → 2.5 Flash 退避 → 2.5 Pro 切替 → 3.1 Flash 復帰
//   RPD 100 再枯渇時は GEMINI_TTS_MODEL=gemini-2.5-pro-preview-tts で env 切替可能
const MODEL    = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
// 2026-05-13 採用: Zubenelgenubi（男性・カジュアル会話調）
//   日本の商店街の八百屋のおじさん風プロンプトと組合せ、視聴者主層 45-54 に親和
const DEFAULT_VOICE = process.env.GEMINI_TTS_VOICE || 'Zubenelgenubi';

// 採用済みの Style Instructions（2026-05-13 強化版）
//   重低音 + 超テンポ + 感情込めて。八百屋のおじさんの早口熱量を狙う
const DEFAULT_STYLE_INSTRUCTIONS =
  '重低音のしゃがれ声で、超早くテンポ良く読んで。感情をこめて。';

// Gemini TTS の prebuilt voices（公式 30 voice 全件、男性声優先で並べる）
// 採用は Algenib (⭐)。性別と特徴は公式ドキュメント由来
const PRESET_VOICES = [
  // ── 男性声 16 種（公式特徴つき）──
  { id: 'Algenib',       label: 'Algenib ⭐ (男性・しゃがれ低音)' },
  { id: 'Puck',          label: 'Puck (男性・明るく元気・公式default)' },
  { id: 'Charon',        label: 'Charon (男性・知的で明瞭な解説調)' },
  { id: 'Fenrir',        label: 'Fenrir (男性・興奮しやすく躍動的)' },
  { id: 'Orus',          label: 'Orus (男性・きっぱり決断的)' },
  { id: 'Achird',        label: 'Achird (男性・フレンドリーで親しみやすい)' },
  { id: 'Algieba',       label: 'Algieba (男性・滑らかで心地よい)' },
  { id: 'Alnilam',       label: 'Alnilam (男性・しっかり力強い)' },
  { id: 'Enceladus',     label: 'Enceladus (男性・息混じりで柔らかい)' },
  { id: 'Iapetus',       label: 'Iapetus (男性・クリアで明瞭)' },
  { id: 'Rasalgethi',    label: 'Rasalgethi (男性・知的でプロフェッショナル)' },
  { id: 'Sadachbia',     label: 'Sadachbia (男性・活発で生き生き)' },
  { id: 'Sadaltager',    label: 'Sadaltager (男性・博識で威厳)' },
  { id: 'Schedar',       label: 'Schedar (男性・落ち着いてバランス◎)' },
  { id: 'Umbriel',       label: 'Umbriel (男性・気さくで穏やか)' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi (男性・カジュアル会話調)' },
  // ── 女性声 14 種（特徴一部のみ判明）──
  { id: 'Achernar',      label: 'Achernar (女性・柔らかく優しい)' },
  { id: 'Kore',          label: 'Kore (女性・しっかり毅然)' },
  { id: 'Leda',          label: 'Leda (女性・若々しい)' },
  { id: 'Sulafat',       label: 'Sulafat (女性・温かみのある)' },
  { id: 'Zephyr',        label: 'Zephyr (女性・明るく軽やか)' },
  { id: 'Aoede',         label: 'Aoede (女性)' },
  { id: 'Autonoe',       label: 'Autonoe (女性)' },
  { id: 'Callirrhoe',    label: 'Callirrhoe (女性)' },
  { id: 'Despina',       label: 'Despina (女性)' },
  { id: 'Erinome',       label: 'Erinome (女性)' },
  { id: 'Gacrux',        label: 'Gacrux (女性)' },
  { id: 'Laomedeia',     label: 'Laomedeia (女性)' },
  { id: 'Pulcherrima',   label: 'Pulcherrima (女性)' },
  { id: 'Vindemiatrix',  label: 'Vindemiatrix (女性)' },
];

const PRESET_MODELS = [
  { id: 'gemini-2.5-pro-preview-tts',   label: 'Gemini 2.5 Pro TTS ⭐ (採用・高品質)' },
  { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS (高速・予備)' },
  { id: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS (クォータ復活後の本命候補)' },
];

const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';

// 🆕 reaction スライドのコメント用ランダム voice ピッカー（2026-05-14）
//   chunk[0] 前置きはメイン voice、chunk[1+] コメントは複数キャラ感のため ランダム voice
//   env:
//     REACTION_VOICES_MALE=v1,v2,...   合格認定男性 voice（未設定なら全男性voice）
//     REACTION_VOICES_FEMALE=v1,v2,... 合格認定女性 voice（未設定なら全女性voice）
//     REACTION_FEMALE_RATIO=0.2        女性 voice 抽選確率（既定 0.2 = 20%）
const MALE_VOICES_DEFAULT = PRESET_VOICES.filter(v => /男性/.test(v.label)).map(v => v.id);
const FEMALE_VOICES_DEFAULT = PRESET_VOICES.filter(v => /女性/.test(v.label)).map(v => v.id);

function _getReactionVoicePools() {
  const maleCSV = process.env.REACTION_VOICES_MALE;
  const femaleCSV = process.env.REACTION_VOICES_FEMALE;
  return {
    male:   maleCSV   ? maleCSV.split(',').map(s => s.trim()).filter(Boolean)   : MALE_VOICES_DEFAULT,
    female: femaleCSV ? femaleCSV.split(',').map(s => s.trim()).filter(Boolean) : FEMALE_VOICES_DEFAULT,
  };
}

function pickReactionVoice() {
  const { male, female } = _getReactionVoicePools();
  const ratio = Number(process.env.REACTION_FEMALE_RATIO || '0.2');
  const isFemale = Math.random() < ratio;
  const pool = (isFemale && female.length) ? female : (male.length ? male : female);
  if (!pool.length) return DEFAULT_VOICE;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 🆕 reaction の comment chunk 専用 styleInstructions (2026-05-14)
//   コメント欄の文章引用 → 感情控えめ + メインより更に高速
//   env REACTION_STYLE_INSTRUCTIONS で上書き可能
const REACTION_STYLE_INSTRUCTIONS_DEFAULT =
  '感情を控えめに、引用文を読むように、超高速で早口に読んで。';
function getReactionStyleInstructions() {
  return process.env.REACTION_STYLE_INSTRUCTIONS || REACTION_STYLE_INSTRUCTIONS_DEFAULT;
}

// 複数 API キー対応（プロジェクト分散でクォータを束ねる・2026-05-13）
//   .env: GEMINI_API_KEYS=key1,key2,key3 (CSV)
//   未設定なら GEMINI_API_KEY を単体使用（後方互換）
//   429 受けたら次のキーに hot swap、render.js の 2 パス機構で再試行される
function _getApiKeys() {
  const csv = process.env.GEMINI_API_KEYS;
  if (csv) return csv.split(',').map(k => k.trim()).filter(Boolean);
  if (process.env.GEMINI_API_KEY) return [process.env.GEMINI_API_KEY];
  return [];
}
let _currentKeyIdx = 0;

// サニタイズ（Gemini は漢字直接読めるので kuroshiro は不要だが、
//   固有名詞の読み崩れ対策で jp_dict は通す。
//   2026-05-13: 「三笘」「冨安」「松木玖琉」「鈴木彩艶」等の特殊読みを矯正）
function sanitizeForTts(text) {
  if (!text) return '';
  return applyJpDict(String(text))
    .replace(/[ -]/g, ' ')
    .replace(/\s*\n+\s*/g, '\n')
    .trim();
}

// PCM (L16) → WAV ヘッダ付加
function _pcmToWav(pcm, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

// WAV Buffer → mp3 ファイル（ffmpeg pipe）
//   2026-05-14: loudnorm filter で音量正規化（YouTube 標準 -16 LUFS 準拠）
//   chunk 間の音量差を排除し「ナレーションが安定しない」問題を解消
//   I=-16 (target LUFS) / TP=-1.5 (true peak ceiling) / LRA=11 (loudness range)
// 🆕 2026-05-14: atempo filter で速度を数値制御
//   env TTS_GEMINI_SPEED=1.10 で 10% 高速化（既定 1.0）
//   Gemini TTS は speed param 非対応のため、後処理で速度統一する
//   atempo は時間引き伸ばし系で、ピッチを変えず再生速度のみ変える（音質保持）
function _wavBufferToMp3File(wavBuf, outPath) {
  return new Promise((resolve, reject) => {
    const speed = parseFloat(process.env.TTS_GEMINI_SPEED || '1.0');
    const clampedSpeed = Math.max(0.5, Math.min(2.0, isFinite(speed) ? speed : 1.0));
    // atempo は 1.0 = 等速。1.0 の時はフィルタ不要（音質劣化ゼロ）
    const audioFilter = clampedSpeed === 1.0
      ? 'loudnorm=I=-16:TP=-1.5:LRA=11'
      : `loudnorm=I=-16:TP=-1.5:LRA=11,atempo=${clampedSpeed.toFixed(3)}`;
    const args = [
      '-y', '-i', 'pipe:0',
      '-af', audioFilter,
      '-codec:a', 'libmp3lame', '-b:a', '128k',
      outPath,
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(outPath);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
    proc.stdin.on('error', reject);
    proc.stdin.end(wavBuf);
  });
}

/**
 * Gemini TTS 呼び出し本体
 * @param {Object} opts
 * @param {string} opts.text                 - 読み上げテキスト（漢字混じり OK）
 * @param {string} opts.outputPath           - 出力先（.mp3 / .wav どちらでも）
 * @param {string} [opts.voiceId]            - 既定 'Algenib'
 * @param {string} [opts.model]              - 既定 'gemini-3.1-flash-tts-preview'
 * @param {string} [opts.styleInstructions]  - Style 指示プロンプト（未指定なら採用済デフォルト）
 * @param {number} [opts.speed]              - 互換用（Gemini は speed 直接サポート無し。styleInstructions で表現）
 * @returns {Promise<string>} outputPath
 */
async function generateGeminiTTS(opts = {}) {
  const {
    text,
    outputPath,
    voiceId = DEFAULT_VOICE,
    model   = MODEL,
    styleInstructions = DEFAULT_STYLE_INSTRUCTIONS,
    timeoutMs = 120000,  // 既定 120s。combined TTS のような長文では 300000 (5分) 等を指定
  } = opts;

  if (!text)        throw new Error('text is required');
  if (!outputPath)  throw new Error('outputPath is required');

  const keys = _getApiKeys();
  if (!keys.length && !opts.apiKey) throw new Error('GEMINI_API_KEY(S) が未設定');

  const safeText = sanitizeForTts(text);
  if (!safeText) throw new Error('text after sanitize is empty');

  // 出力先ディレクトリを保証
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // task 単位で apiKey 指定があればそれを優先（影分身並列で各 chunk が固定キーで叩く）
  // 指定なしは従来通りグローバル _currentKeyIdx 経由（hot swap 後方互換）
  const KEY = opts.apiKey || keys[_currentKeyIdx];
  const url = `${API_BASE}/${model}:generateContent?key=${KEY}`;
  const body = {
    contents: [{
      parts: [{ text: `${styleInstructions}\n\n${safeText}` }],
    }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceId },
        },
      },
    },
  };

  // 1 chunk = 最大 1 リクエストの原則（リトライ削除・2026-05-13）
  //   429 受けたら即諦め + 次のキーに hot swap（render.js の 2 パス機構で再試行）
  //   理由: リトライで RPD クォータを 3 倍速く食う事故への対策
  let res;
  res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (res.status === 429) {
    if (keys.length > 1) {
      const oldIdx = _currentKeyIdx;
      _currentKeyIdx = (_currentKeyIdx + 1) % keys.length;
      console.warn(`  ⏭️  Gemini TTS 429 (key#${oldIdx + 1}) → key#${_currentKeyIdx + 1} へ hot swap`);
    }
    const msg = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const err = new Error(`Gemini TTS 429: ${msg.slice(0, 300)}`);
    err.is429 = true;
    throw err;
  }

  if (res.status !== 200) {
    const msg = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`Gemini TTS API ${res.status}: ${msg.slice(0, 500)}`);
  }

  const parts = res.data?.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find(p => p.inlineData?.mimeType?.startsWith('audio/'));
  if (!audioPart) {
    throw new Error(`Gemini TTS: audio part not found. raw=${JSON.stringify(res.data).slice(0, 300)}`);
  }
  const mime = audioPart.inlineData.mimeType;
  const sampleRate = (mime.match(/rate=(\d+)/) || [, 24000])[1] | 0;
  const pcm = Buffer.from(audioPart.inlineData.data, 'base64');
  const wavBuf = _pcmToWav(pcm, sampleRate);

  if (/\.wav$/i.test(outputPath)) {
    fs.writeFileSync(outputPath, wavBuf);
  } else {
    // mp3 / m4a 等は ffmpeg 経由でエンコード
    await _wavBufferToMp3File(wavBuf, outputPath);
  }
  return outputPath;
}

// chunk 分割は MiniMax と同じロジック流用
const splitIntoChunks      = _minimax.splitIntoChunks;
const buildChunksForModule = _minimax.buildChunksForModule;
const probeDurationSec     = _minimax.probeDurationSec;

module.exports = {
  generateGeminiTTS,
  splitIntoChunks,
  buildChunksForModule,
  probeDurationSec,
  sanitizeForTts,
  getApiKeys: _getApiKeys,  // render.js が chunk → keyIdx 事前付与に使用
  pickReactionVoice,        // reaction の comment chunk ランダム voice 抽選
  getReactionStyleInstructions,  // reaction comment 用 style (感情控えめ + テンポ早め)
  DEFAULT_VOICE,
  DEFAULT_MODEL: MODEL,
  DEFAULT_STYLE_INSTRUCTIONS,
  PRESET_VOICES,
  PRESET_MODELS,
};
