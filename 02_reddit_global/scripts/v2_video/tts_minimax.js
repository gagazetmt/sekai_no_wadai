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

// ── kuromoji tokenizer（数字+助数詞ペア検出用）の遅延初期化 ──────
//   2026-05-08 数字読み根本解決：形態素境界を尊重して数字と助数詞を確実に分離
//   kuroshiro とは独立にトークン取得（kuroshiro は文字列→文字列 API しか公開してない）
let _kuromojiTokenizerPromise = null;
async function _getKuromojiTokenizer() {
  if (_kuromojiTokenizerPromise) return _kuromojiTokenizerPromise;
  _kuromojiTokenizerPromise = (async () => {
    try {
      const kuromoji = require('kuromoji');
      const dicPath  = path.join(path.dirname(require.resolve('kuromoji')), '..', 'dict');
      return await new Promise((resolve, reject) => {
        kuromoji.builder({ dicPath }).build((err, tokenizer) => {
          if (err) return reject(err);
          console.log('  ✓ kuromoji tokenizer 初期化完了（数字+助数詞ペア検出 ON）');
          resolve(tokenizer);
        });
      });
    } catch (e) {
      console.warn('  ⚠️ kuromoji tokenizer 初期化失敗、regex fallback:', e.message);
      return null;
    }
  })();
  return _kuromojiTokenizerPromise;
}

const API_URL    = 'https://api-uw.minimax.io/v1/t2a_v2';
const MODEL      = process.env.MINIMAX_TTS_MODEL || 'speech-2.8-hd';
// 2026-05-06 voice 最終決定: ⑦ Japanese_GenerousIzakayaOwner をデフォルトに採用
//   視聴者主層 45-54（Jリーグ黎明期世代）と親和性◎、深掘り解説系がメイン用途のため
//   速報系→②、若手特集→⑨ は Step4 UI で動画ごとにオーバーライド可能
const DEFAULT_VOICE = process.env.MINIMAX_DEFAULT_VOICE
  || 'Japanese_GenerousIzakayaOwner';

const PRESET_VOICES = [
  // 採用3候補（2026-04-30 選別 → 2026-05-06 デフォルト確定）
  { id: 'Japanese_GenerousIzakayaOwner', label: '⑦ ベテラン店主・深掘り解説 (デフォルト)' },
  { id: 'Japanese_DominantMan',          label: '② 覇王・速報煽り系' },
  { id: 'Japanese_InnocentBoy',          label: '⑨ 若い少年・若手選手紹介系' },
  // 旧マスタークローン（バックアップ用に保持）
  { id: 'moss_audio_6e0620ed-3af8-11f1-beb2-9257c801a481', label: '🎤 自前クローン (旧デフォルト)' },
  // 中華プリセット（参考用）
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
//   2026-05-07 拡充: 点 / ポイント / % / クリーンシート / クロス / km / kg を追加
const UNIT_KANA = {
  '試合': 'しあい',     'ゴール': 'ゴール',   '得点': 'とくてん',
  '失点': 'しってん',   'アシスト': 'アシスト','キャップ': 'キャップ',
  '歳':   'さい',       '回':     'かい',     '位':   'い',
  '連勝': 'れんしょう', '連敗':   'れんぱい', '連覇': 'れんぱ',
  '周年': 'しゅうねん', 'シーズン':'シーズン','チーム':'チーム',
  '本':   'ほん',       '人':     'にん',     '秒':   'びょう',
  '億':   'おく',       '万':     'まん',     '千':   'せん',
  '度目': 'どめ',       '度':     'ど',       '個':   'こ',
  '点':   'てん',       'ポイント': 'ポイント','%': 'パーセント',
  'パーセント': 'パーセント',
  'km':   'キロメートル','kg':   'キログラム','時間': 'じかん',
  'クリーンシート': 'クリーンシート',
  // 🆕 2026-05-10 (通し検証): サッカー戦績用語
  '節':   'せつ',       // 35節 → さんじゅうごせつ ("ぶし"等の誤読回避)
  '勝':   'しょう',     // 22勝 → にじゅうにしょう ("かち"の誤読回避)
  '敗':   'はい',       // 5敗 → ごはい
  // 注: '分' は「分(draws) vs 分(minutes)」が文脈依存で曖昧なので UNIT_KANA に
  //     登録せず、_processWdlPattern で N勝M分 / N勝M分K敗 のパターン専用処理する
};

// 接頭語: 数字との間に MiniMax 分節事故が起きやすい語
//   形態素境界で「接頭語 → 数字」の遷移を検出したら間に「、」を挿入する
const PREFIX_NUMBERS = new Set([
  '通算','合計','総','累計','歴代','現在','今季','前季','今期','前期',
  '今シーズン','前シーズン','約','およそ','過去','直近',
]);

// kuromoji ベースで数字+助数詞ペアを処理（2026-05-08 根本解決）
//   形態素境界を尊重するため、regex 一括置換で起きていた以下の事故を全て解消：
//     - "通算178試合" の "178" を ひらがな化した後 "試合" との連結で再分節
//     - "2度" のような短い数+助数詞の不安定な読み
//     - 単位無し裸数字での Chinese-style 読み混入
//   注意: 小数点 / N分音便 / スコア "3-1" は呼び出し前段で regex 処理済み前提
async function processNumbersWithKuromoji(text) {
  const tokenizer = await _getKuromojiTokenizer();
  if (!tokenizer) {
    // フォールバック: 旧 regex で数字+単位 + 裸数字を最低限処理
    let s = text;
    s = s.replace(/(通算|合計|総|累計|歴代|現在|今季|前季|今期|前期|今シーズン|前シーズン)\s*(\d)/g, '$1、$2');
    s = s.replace(/(\d+)(試合|ゴール|得点|失点|アシスト|キャップ|歳|回|位|連勝|連敗|連覇|周年|シーズン|チーム|本|人|秒|億|万|千|度目|度|個|点|ポイント|%|パーセント|km|kg|時間|クリーンシート)/g,
      (_m, num, unit) => numToFullJa(num) + (UNIT_KANA[unit] || unit));
    return s.replace(/\d+/g, (m) => numToFullJa(m));
  }

  const tokens = tokenizer.tokenize(text);
  const out = [];

  for (let i = 0; i < tokens.length; i++) {
    const cur     = tokens[i];
    const surface = cur.surface_form;
    const posD    = cur.pos_detail_1;

    // 数字トークン判定（純粋な \d+ のみ。kuromoji の pos_detail_1 が "数"）
    const isNumberToken = posD === '数' && /^\d+$/.test(surface);

    if (isNumberToken) {
      const numKana = numToFullJa(surface);

      // 直前が接頭語？ → 既出力末尾に「、」挿入で MiniMax 再分節事故を防ぐ
      const prev = i > 0 ? tokens[i - 1] : null;
      if (prev && PREFIX_NUMBERS.has(prev.surface_form)) {
        if (out.length > 0 && !out[out.length - 1].endsWith('、')) {
          out[out.length - 1] = out[out.length - 1] + '、';
        }
      }

      // 直後が助数詞 (UNIT_KANA に登録された語) なら確定読みでまとめ出力
      //   "2度" → "にど" のように分節境界を作らず連続音として MiniMax に渡す
      const next = i + 1 < tokens.length ? tokens[i + 1] : null;
      if (next && UNIT_KANA[next.surface_form]) {
        out.push(numKana + UNIT_KANA[next.surface_form]);
        i++;  // 助数詞トークンを消費
      } else {
        out.push(numKana);
      }
    } else if (UNIT_KANA[surface]) {
      // 数字を伴わない助数詞単独 → 確定読みで kuroshiro 誤読を回避
      out.push(UNIT_KANA[surface]);
    } else {
      // 漢字含むその他のトークンはパススルー → 後段の kuroshiro が hiragana 化
      out.push(surface);
    }
  }

  return out.join('');
}

// 日本語ナレ向けサニタイズ（読み崩れ防止 / kuromoji 形態素ベース）
//   0. 全角数字 → 半角
//   1. 英語序数(1st/2nd/3rd等) → カタカナ
//   2. 既存辞書 (jp_dict) を優先適用 — 固有名詞・サッカー専門語
//   3. スコア "3-1" → 「さんたいいち」（kuromoji 前 / "-" が分離されるため）
//   4. 「N分」音便（ぷん/ふん）— kuromoji 前（連結音便が形態素分離で崩れるため）
//   5. 小数 "61.5%" — kuromoji 前（"." が独立トークン化されるため）
//   6. 🆕 kuromoji 形態素ベースで数字+助数詞ペア処理（接頭語読点 / 単独数字 / 助数詞単独 を一気に解決）
//   7. kuroshiro で残った漢字を自動でひらがな化
//   8. 括弧・中点・改行を整形
async function sanitizeForTts(text) {
  if (!text) return '';
  let s = String(text);

  // 0) 全角数字 → 半角（後段の \d+ マッチを通すため）
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

  // 1) 英語序数 (1st, 2nd, 3rd ...)
  s = s.replace(/\b(1st|2nd|3rd|[4-9]th|10th)\b/gi, (m) => ORDINAL_MAP[m.toLowerCase()] || m);

  // 2) 既存辞書を優先適用（固有名詞 / サッカー語彙）
  s = applyJpDict(s);

  // 2.5) 接続語＋カタカナ/英字略語の区切り強化（"その後PSG" → "その後、PSG"）
  //   MiniMax は接続語の直後に読みのない語が来ると連結読みしがち → 読点で分節
  s = s.replace(/(その後|そのあと|だが|しかし|しかも|ただし|そして|やがて)\s*([A-Za-z]|[ァ-ヶー]{2,})/g, '$1、$2');

  // 3) スコア "3-1" → 「さんたいいち」（kuromoji 前 / "-" が分離されるため）
  s = s.replace(/(\d+)\s*[-－ー−–—]\s*(\d+)/g, (_m, a, b) =>
    `${numToJa1(a)}たい${numToJa1(b)}`);

  // 4) 「N分」音便（ぷん/ふん）— kuromoji 前（連結音便が形態素分離で崩れるため）
  s = s.replace(/(\d+)\s*分/g, (_m, n) => numToMinuteJa(n));

  // 5) 小数 "61.5%" / "2.26得点" — kuromoji が "." を独立トークン化するので前段で纏めて処理
  //   単位がある場合は間に読点を入れて MiniMax の連結読み事故を防ぐ
  //   例: "2.26得点" → "にてんにろく、とくてん"（単位前にポーズ入る → 自然な分節）
  s = s.replace(/(\d+)\.(\d+)(試合|ゴール|得点|失点|アシスト|キャップ|歳|回|位|連勝|連敗|連覇|周年|シーズン|チーム|本|人|秒|億|万|千|度目|度|個|点|ポイント|%|パーセント|km|kg|時間|クリーンシート)?/g,
    (_m, intPart, decPart, unit) => {
      const dec = decPart.split('').map(d => numToFullJa(d)).join('');
      const unitKana = unit ? (UNIT_KANA[unit] || unit) : '';
      // 単位有り → "に てん にろく、とくてん" のように単位前にポーズ
      return numToFullJa(intPart) + 'てん' + dec + (unit ? '、' + unitKana : '');
    });

  // 5.5) 🆕 W/D/L パターン優先処理（2026-05-10）
  //   "22勝8分5敗" の "分" はサッカー実況では「わけ」（引き分け の wake）が自然。
  //   kuromoji UNIT_KANA に登録すると「90分(きゅうじゅっぷん)」と衝突するため、
  //   勝/敗 が前後にある時のみ preprocessor で「わけ」確定変換し kuromoji を通さない。
  s = s
    .replace(/(\d+)勝(\d+)分(\d+)敗/g, (_m, w, d, l) =>
      numToFullJa(w) + 'しょう' + numToFullJa(d) + 'わけ' + numToFullJa(l) + 'はい')
    .replace(/(\d+)勝(\d+)分/g, (_m, w, d) =>
      numToFullJa(w) + 'しょう' + numToFullJa(d) + 'わけ')
    .replace(/(\d+)勝(\d+)敗/g, (_m, w, l) =>
      numToFullJa(w) + 'しょう' + numToFullJa(l) + 'はい');

  // 6) 🆕 kuromoji 形態素ベースで数字+助数詞ペア処理（核心 / 2026-05-08）
  //    旧 regex 3本（接頭語読点 / 数字+一般単位 / 裸数字 fallback）を統合
  s = await processNumbersWithKuromoji(s);

  // 7) kuroshiro で残った漢字を ひらがな化（初期化失敗時はスキップ）
  try {
    const k = await _getKuroshiro();
    if (k) {
      s = await k.convert(s, { to: 'hiragana' });
    }
  } catch (e) {
    console.warn('  ⚠️ kuroshiro convert 失敗:', e.message);
  }

  // 8) 括弧・中点・改行整形
  s = s.replace(/【([^】]+)】/g, '$1')
       .replace(/〝([^〟]+)〟/g, '$1')
       .replace(/[・·]/g, '')
       .replace(/\r?\n+/g, '　')
       .trim();
  return s;
}

// ナレーション本文を chunk に分割（最大 ~50文字目安）
//   字幕バーは 1〜2 行 (1920px幅 / 50px font ≈ 25字/行) に収まる必要があるため
//   1チャンク 50字を上限にする。長すぎると subtitle が3行はみ出し or 表示固定化する
//
//   1) narration を必ず使う（接続フレーズや本文が音声から漏れないように）
//      chunkText は字幕表示／スライド内ハイライト用の視覚要素として slides/*.js で使う
//   2) 「。！？!?」で1次分割
//   3) 50字超の文は「、,」で2次分割
//   4) それでも 50字超 → 40字ずつ強制分割
//   5) 短文を次と結合（最大 50文字目安）
const CHUNK_TARGET_LEN = 50;
const CHUNK_HARD_MAX   = 60;
function splitIntoChunks(text, _existingChunks) {
  if (!text) return [];
  const raw = String(text).trim();
  if (raw.length <= CHUNK_TARGET_LEN) return [raw];

  // 1次: 文末 (。！？!?) で分割
  let parts = raw.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);

  // 2次: 各 part が 50字超なら 、で再分割
  parts = parts.flatMap(p =>
    p.length > CHUNK_HARD_MAX
      ? p.split(/(?<=[、,])/).map(s => s.trim()).filter(Boolean)
      : [p]);

  // 3次: それでも 50字超なら 40字ずつ強制分割
  parts = parts.flatMap(p => {
    if (p.length <= CHUNK_HARD_MAX) return [p];
    const out = [];
    for (let i = 0; i < p.length; i += 40) out.push(p.slice(i, i + 40));
    return out;
  });

  // 短文は次と結合（合計 50字以下に収める）
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length <= CHUNK_TARGET_LEN) {
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
// デフォルト読み上げ速度（2026-05-08: 1.0 → 1.03 で 3% アップ、テンポ感UP）
const DEFAULT_SPEED = 1.03;

// 🆕 MiniMax pronunciation_dict（API 側辞書）の構築 / 2026-05-08
//   sanitizeForTts (jp_dict 適用) を通った後の text に対して、追加で API 側で発音矯正したい単語を登録。
//   sanitize で対応しきれない MiniMax 固有の音韻バグを補完する用途。
//   形式: ['元単語/読み', ...] （slash 区切り、検証済）
const PRONUNCIATION_DICT_TONE = [
  // ── MiniMax 固有の音韻バグ対策 ──
  // 「ヴ」音韻同化（"ヴ" → "ブ" になる事故の補強）
  'クヴァラツヘリア/クバラツヘリヤ',
  // 数字+単位の連結読み破綻パターン
  '勝点/かちてん',
  '勝ち点/かちてん',
  // クラブ略称（jp_dict と二重で押さえ）
  'PSG/ピーエスジー',
  // ジョージア人名
  'ハキミ/ハキミ',
  // 助数詞
  '失点/しってん',
  '無失点/むしってん',
];
function _buildPronunciationDict() {
  // 単純に PRONUNCIATION_DICT_TONE を返す。将来的に動的拡張する場合はここで処理
  return PRONUNCIATION_DICT_TONE.slice();
}

async function generateMiniMaxTTS(opts = {}) {
  const {
    text,
    outputPath,
    voiceId = DEFAULT_VOICE,
    model   = MODEL,
    emotion,
    speed   = DEFAULT_SPEED,
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

  // 🆕 MiniMax pronunciation_dict（API 側で発音辞書を適用 / 2026-05-08）
  //   text 内に登録単語が含まれていれば、API 側で発音を置換してから生成する。
  //   jp_dict のテキスト変換と二重適用にならないよう、特に「数字+単位」「固有名詞の難読」だけを登録。
  //   形式: { tone: ['元単語/読み', ...] }（slash 区切り、PoC で動作確認済）
  const pronDict = _buildPronunciationDict();
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
  if (pronDict.length) reqBody.pronunciation_dict = { tone: pronDict };

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
//   - opening: title のみ読み上げ
//   - toc: narration(intro 短い予告) + 各 tocItem.chunkText を順次読み上げ
//   - reaction: narration + comments[] を順次読み上げ
//   - その他: narration を文末分割（chunkText は字幕／視覚ハイライト用なので発話に使わない）
function buildChunksForModule(mod) {
  if (!mod) return [];
  const narr = String(mod.narration || '').trim();
  const itemText = (it) => (typeof it === 'string') ? it : String(it?.chunkText || it?.text || '').trim();

  // opening は **タイトルのみ読み上げ**
  if (mod.type === 'opening') {
    const title = String(mod.title || '').trim();
    return title ? [title] : (narr ? [narr] : []);
  }

  // toc は intro narration のみ読み上げ（アイテム名は intro 内で既に列挙されているため
  //   別途読むと重複してくどい）。アイテムは toc.js の固定間隔リビールで順次表示される
  if (mod.type === 'toc') {
    return narr ? splitIntoChunks(narr) : [];
  }

  // 通常タイプ: narration を文末分割
  let baseChunks = splitIntoChunks(narr);

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
