// scripts/v2_video/tts_engine.js
// TTS provider 抽象化レイヤ。tts_minimax と tts_gemini を統一インターフェースで呼べる。
//
// 既定 provider:
//   process.env.TTS_PROVIDER が 'minimax' なら MiniMax、それ以外（未設定含む）は 'gemini'
//   2026-05-12 大転換で Gemini 3.1 Flash TTS が採用。MiniMax は保険として保持
//
// 使い方:
//   const tts = require('./tts_engine');
//   await tts.generate({ provider: 'gemini', text, outputPath, voiceId, model, ... });
//   const defaults = tts.getDefaults('gemini'); // { voice, model, presetVoices, presetModels, ... }
//   const chunks   = tts.buildChunksForModule(mod);
//   const dur      = tts.probeDurationSec(file);

const _gemini  = require('./tts_gemini');
const _minimax = require('./tts_minimax');

const DEFAULT_PROVIDER = (process.env.TTS_PROVIDER || 'gemini').toLowerCase();

const PRESET_PROVIDERS = [
  { id: 'gemini',  label: 'Gemini 3.1 Flash TTS (採用・若手熱血リポーター)' },
  { id: 'minimax', label: 'MiniMax speech-2.8-hd (保険・ベテラン店主)' },
];

function _normalize(provider) {
  const p = String(provider || DEFAULT_PROVIDER).toLowerCase();
  if (p === 'minimax') return 'minimax';
  return 'gemini';
}

function getEngine(provider) {
  return _normalize(provider) === 'minimax' ? _minimax : _gemini;
}

/**
 * 統一 generate 呼び出し。
 * @param {Object} opts
 * @param {string} [opts.provider]          - 'gemini' / 'minimax'。省略時は環境変数 or 'gemini'
 * @param {string} opts.text                - 読み上げテキスト
 * @param {string} opts.outputPath          - 出力先（mp3 / wav）
 * @param {string} [opts.voiceId]           - voice ID（provider に依存）
 * @param {string} [opts.model]             - モデル名（provider に依存）
 * @param {string} [opts.styleInstructions] - Gemini 用 Style Instructions（任意）
 * @param {string} [opts.emotion]           - MiniMax 用 emotion（任意）
 * @param {number} [opts.speed]             - 速度（両 provider 共通だが Gemini は実質無視）
 * @param {number} [opts.vol]               - MiniMax 用 vol
 * @param {number} [opts.pitch]             - MiniMax 用 pitch
 */
async function generate(opts = {}) {
  const provider = _normalize(opts.provider);
  if (provider === 'minimax') {
    return _minimax.generateMiniMaxTTS({
      text: opts.text,
      outputPath: opts.outputPath,
      voiceId: opts.voiceId,
      model:   opts.model,
      emotion: opts.emotion,
      speed:   opts.speed,
      vol:     opts.vol,
      pitch:   opts.pitch,
    });
  }
  return _gemini.generateGeminiTTS({
    text: opts.text,
    outputPath: opts.outputPath,
    voiceId: opts.voiceId,
    model:   opts.model,
    styleInstructions: opts.styleInstructions,
    speed:   opts.speed,
    apiKey:  opts.apiKey,   // task 単位で API キー指定可（影分身並列）
  });
}

/**
 * provider のデフォルト/プリセット情報を返す。
 * Step4 UI が provider 切替時にこれを叩いて voice/model リストを差し替える想定。
 */
function getDefaults(provider) {
  const p = _normalize(provider);
  const eng = getEngine(p);
  const base = {
    provider: p,
    voice:    eng.DEFAULT_VOICE,
    model:    eng.DEFAULT_MODEL,
    presetVoices: eng.PRESET_VOICES || [],
    presetModels: eng.PRESET_MODELS || [],
  };
  if (p === 'minimax') {
    base.emotions = ['(なし)', ...(_minimax.ALLOWED_EMOTIONS || [])];
    base.supports = { emotion: true, speed: true, vol: true, pitch: true, styleInstructions: false };
  } else {
    base.styleInstructions = _gemini.DEFAULT_STYLE_INSTRUCTIONS;
    base.supports = { emotion: false, speed: false, vol: false, pitch: false, styleInstructions: true };
  }
  return base;
}

// chunk 分割・尺取得は両 provider 共通（MiniMax 実装を流用）
const splitIntoChunks      = _minimax.splitIntoChunks;
const buildChunksForModule = _minimax.buildChunksForModule;
const probeDurationSec     = _minimax.probeDurationSec;

module.exports = {
  generate,
  getEngine,
  getDefaults,
  splitIntoChunks,
  buildChunksForModule,
  probeDurationSec,
  DEFAULT_PROVIDER,
  PRESET_PROVIDERS,
};
