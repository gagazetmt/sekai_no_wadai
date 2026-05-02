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

// ── kuroshiro 形態素解析器（漢字→ひらがな）の遅延初期化 ─────────
//   起動時にロードすると render プロセス起動が3〜5秒遅れるので、
//   初回 sanitizeForTts() 呼出時にだけ初期化（Promise キャッシュ）
let _kuroshiroPromise = null;
async function _getKuroshiro() {
  if (_kuroshiroPromise) return _kuroshiroPromise;
  _kuroshiroPromise = (async () => {
    try {
      const Kuroshiro = require('kuroshiro').default;
      const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
      const k = new Kuroshiro();
      await k.init(new KuromojiAnalyzer());
      console.log('  ✓ kuroshiro 初期化完了（漢字→ひらがな自動変換 ON）');
      return k;
    } catch (e) {
      console.warn('  ⚠️ kuroshiro 初期化失敗、辞書のみで継続:', e.message);
      return null;  // null なら辞書のみ
    }
  })();
  return _kuroshiroPromise;
}

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

// 「分」専用 - 音便（ぷん/うん）を考慮した正確な読み生成
//   1分=いっぷん / 27分=にじゅうななうん / 40分=よんじゅっぷん など
//
// 【MiniMax制約対応】
//   MiniMax の Japanese voice モデルは「ふ」が「ぶ」に音韻同化する不具合あり。
//   2/5/7/9分 の本来「ふん」読みは MiniMax で「ぶん」になるため「うん」で代用。
//   実音検証で「うん」が「ふん」に最も近く聞こえる音として採択（2026-04-29）
function numToMinuteJa(nStr) {
  const v = parseInt(nStr, 10);
  if (!Number.isFinite(v) || v < 0) return nStr + 'うん';
  if (v === 0) return 'ぜろうん';
  if (v >= 100) return numToFullJa(v) + 'うん';

  const ONES = {
    1: 'いっぷん',  2: 'にうん',     3: 'さんぷん',
    4: 'よんぷん',  5: 'ごうん',     6: 'ろっぷん',
    7: 'ななうん',  8: 'はっぷん',   9: 'きゅううん',
  };
  const tensDigit = Math.floor(v / 10);
  const onesDigit = v % 10;

  // 十の位読み
  let tensPart = '';
  if (tensDigit > 0) {
    if (tensDigit === 1) tensPart = 'じゅう';
    else {
      const tensOnes = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
      tensPart = tensOnes[tensDigit] + 'じゅう';
    }
    // 一の位ゼロ → "じゅっぷん" に音便
    if (onesDigit === 0) return tensPart.replace(/じゅう$/, 'じゅっぷん');
  }
  return tensPart + ONES[onesDigit];
}

// 英語序数（1st, 2nd, 3rd, ...）→ カタカナ
//   "1stレグ" → "ファーストレグ"
const ORDINAL_MAP = {
  '1st': 'ファースト',  '2nd': 'セカンド',  '3rd': 'サード',
  '4th': 'フォース',    '5th': 'フィフス',  '6th': 'シックス',
  '7th': 'セブンス',    '8th': 'エイス',    '9th': 'ナインス',
  '10th': 'テンス',
};

// 数字+単位 の単位読み（kuroshiro が「歳→とし」みたいに迷う漢字を確定読みで固める）
//   ここで読みを与えることで kuroshiro 段階で再変換されない
const UNIT_KANA = {
  '試合': 'しあい',     'ゴール': 'ゴール',   '得点': 'とくてん',
  '失点': 'しってん',   'アシスト': 'アシスト','キャップ': 'キャップ',
  '歳':   'さい',       '回':     'かい',     '位':   'い',
  '連勝': 'れんしょう', '連敗':   'れんぱい', '連覇': 'れんぱ',
  '周年': 'しゅうねん', 'シーズン':'シーズン','チーム':'チーム',
  '本':   'ほん',       '人':     'にん',     '秒':   'びょう',
  '億':   'おく',       '万':     'まん',     '千':   'せん',
  '度目': 'どめ',       '度':     'ど',       '個':   'こ',
};

// 日本語ナレ向けサニタイズ（読み崩れ防止 / ハイブリッド構成）
//   1. 英語序数(1st/2nd/3rd等) → カタカナ
//   2. 既存辞書 (jp_dict) を優先適用 — 固有名詞・サッカー専門語
//   3. スコア "3-1" → 「さんたいいち」
//   4. 数字+特殊単位（分は音便ぷん/ふん）
//   5. 数字+一般単位（試合・ゴール 等）
//   6. kuroshiro で残った漢字を自動でひらがな化
//   7. 括弧・中点・改行を整形
async function sanitizeForTts(text) {
  if (!text) return '';
  let s = String(text);

  // 1) 英語序数 (1st, 2nd, 3rd ...)
  s = s.replace(/\b(1st|2nd|3rd|[4-9]th|10th)\b/gi, (m) => ORDINAL_MAP[m.toLowerCase()] || m);

  // 2) 既存辞書を優先適用（固有名詞 / サッカー語彙）
  s = applyJpDict(s);

  // 3) スコア "3-1" → 「さんたいいち」
  s = s.replace(/(\d+)\s*[-－ー−–—]\s*(\d+)/g, (_m, a, b) =>
    `${numToJa1(a)}たい${numToJa1(b)}`);

  // 4) 「N分」音便（ぷん/ふん）— 一般単位処理より先にやる
  s = s.replace(/(\d+)\s*分/g, (_m, n) => numToMinuteJa(n));

  // 5) 数字+一般単位（単位もひらがな読みに置換、kuroshiro での誤読防止）
  s = s.replace(/(\d+)(試合|ゴール|得点|失点|アシスト|キャップ|歳|回|位|連勝|連敗|連覇|周年|シーズン|チーム|本|人|秒|億|万|千|度目|度|個)/g,
    (_m, num, unit) => numToFullJa(num) + (UNIT_KANA[unit] || unit));

  // 6) kuroshiro で残った漢字を ひらがな化（初期化失敗時はスキップ）
  try {
    const k = await _getKuroshiro();
    if (k) {
      s = await k.convert(s, { to: 'hiragana' });
    }
  } catch (e) {
    // 変換失敗してもサニタイズは続行
    console.warn('  ⚠️ kuroshiro convert 失敗:', e.message);
  }

  // 7) 括弧・中点・改行整形
  s = s.replace(/【([^】]+)】/g, '$1')
       .replace(/〝([^〟]+)〟/g, '$1')
       .replace(/[・·]/g, '')
       .replace(/\r?\n+/g, '　')
       .trim();
  return s;
}

// ナレーション本文を chunk に分割（最大 ~80文字目安）
//   1) narrationChunks[] が既にあれば優先（AI による意味整合分割）
//   2) 「。！？!?」で1次分割
//   3) 「。」が無い長文は「、,」で2次分割（読点で切る）
//   4) それでも長い1チャンクは 60文字ずつ強制分割
//   5) 短すぎる文は次と結合（最大 80文字）
//   ※ 字幕バーの切替が動くよう、AI が句点を入れない長文でも必ず複数チャンクに割る
function splitIntoChunks(text, existingChunks) {
  if (Array.isArray(existingChunks) && existingChunks.length) {
    return existingChunks.map(c => String(c || '').trim()).filter(Boolean);
  }
  if (!text) return [];
  const raw = String(text).trim();
  if (raw.length <= 80) return [raw];

  // 1次: 文末 (。！？!?) で分割
  let parts = raw.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);

  // 2次: 1個しか取れず & まだ長い → 読点で再分割
  if (parts.length === 1 && parts[0].length > 80) {
    parts = parts[0].split(/(?<=[、,])/).map(s => s.trim()).filter(Boolean);
  }

  // 3次: それでも 1個 & 長い → 60文字ずつ強制分割
  if (parts.length === 1 && parts[0].length > 80) {
    const t = parts[0];
    parts = [];
    for (let i = 0; i < t.length; i += 60) parts.push(t.slice(i, i + 60));
  }

  // 短い文は次の文と結合（最大 80文字目安）
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length <= 80) {
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

  const safeText = await sanitizeForTts(text);
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

  // ── rate limit 対策: 失敗時に backoff リトライ（最大3回）──
  //   MiniMax の RPM 制限（1分あたり呼出数）に瞬間的に引っかかった時用
  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(`${API_URL}?GroupId=${groupId}`, reqBody, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      });

      if (!res.data?.data?.audio) {
        const respMsg = JSON.stringify(res.data?.base_resp || res.data);
        // rate limit (1002) ならリトライ対象、それ以外は即 throw
        if (/1002|rate limit/i.test(respMsg) && attempt < MAX_RETRIES) {
          const waitMs = 65000 + attempt * 30000;  // 65s, 95s, 125s（RPM ウィンドウを跨ぐ）
          console.warn(`  ⏳ MiniMax rate limit (attempt ${attempt + 1}/${MAX_RETRIES + 1}) → ${waitMs/1000}s 待機して再試行`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`MiniMax API: ${respMsg}`);
      }
      // 出力先ディレクトリを保証
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(res.data.data.audio, 'hex'));
      return outputPath;
    } catch (e) {
      lastErr = e;
      // ネットワーク系の一過性エラーも軽くリトライ（短いバックオフ）
      const isTransient = /ECONNRESET|ETIMEDOUT|socket hang up/i.test(e.message || '');
      if (isTransient && attempt < MAX_RETRIES) {
        const waitMs = 3000 + attempt * 5000;
        console.warn(`  ⏳ TTS 一過性エラー (${e.message?.slice(0, 60)}) → ${waitMs/1000}s 待機して再試行`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('MiniMax TTS unknown failure');
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
//   - 全タイプで narration を文末分割（字幕が遷移するように）
//   - insight / history: AI が指定した narrationChunks があればそれを優先
//   - reaction: 上記 + comments[] を順次音声化（コメントも読み上げる）
//   - opening: ナレーション短いので1チャンクのまま（無分割）
function buildChunksForModule(mod) {
  if (!mod) return [];
  const narr = String(mod.narration || '').trim();

  // opening は短い煽り（〜80字）なので分割不要
  let baseChunks;
  if (mod.type === 'opening') {
    baseChunks = narr ? [narr] : [];
  } else {
    // 全タイプで文末分割。narrationChunks があれば優先
    baseChunks = splitIntoChunks(narr, mod.narrationChunks);
  }

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
