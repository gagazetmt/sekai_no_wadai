// launcher/tts_preprocess.js
// MiniMax TTS 向けテキスト前処理（漢字→ひらがな変換）
//   kuroshiro + kuromoji で全漢字をひらがな化し、カタコト読みを解消する
//   初回呼び出し時のみ初期化（遅延ロード）

const { applyJpDict } = require('./jp_dict');

// ── kuroshiro 遅延初期化 ──────────────────────────────
let _kuroshiroPromise = null;
async function _getKuroshiro() {
  if (_kuroshiroPromise) return _kuroshiroPromise;
  _kuroshiroPromise = (async () => {
    try {
      const Kuroshiro = require('kuroshiro').default;
      const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
      const k = new Kuroshiro();
      await k.init(new KuromojiAnalyzer());
      console.log('  ✓ kuroshiro 初期化完了（漢字→ひらがな ON）');
      return k;
    } catch (e) {
      console.warn('  ⚠ kuroshiro 初期化失敗、テキストそのまま送信:', e.message);
      return null;
    }
  })();
  return _kuroshiroPromise;
}

// ── kuromoji tokenizer 遅延初期化 ────────────────────
let _kuromojiPromise = null;
async function _getKuromoji() {
  if (_kuromojiPromise) return _kuromojiPromise;
  _kuromojiPromise = (async () => {
    try {
      const kuromoji = require('kuromoji');
      const path = require('path');
      const dicPath = path.join(path.dirname(require.resolve('kuromoji')), '..', 'dict');
      return await new Promise((resolve, reject) => {
        kuromoji.builder({ dicPath }).build((err, t) => err ? reject(err) : resolve(t));
      });
    } catch (e) {
      console.warn('  ⚠ kuromoji 初期化失敗:', e.message);
      return null;
    }
  })();
  return _kuromojiPromise;
}

// ── 数字読み変換 ──────────────────────────────────────
function numToFullJa(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return 'ゼロ';
  const ones = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
  const h = (v) => v === 1 ? 'ひゃく' : v === 3 ? 'さんびゃく' : v === 6 ? 'ろっぴゃく' : v === 8 ? 'はっぴゃく' : ones[v] + 'ひゃく';
  const k = (v) => v === 1 ? 'せん' : v === 3 ? 'さんぜん' : v === 8 ? 'はっせん' : ones[v] + 'せん';
  if (n < 10)    return ones[n];
  if (n < 100)   { const t = Math.floor(n / 10), o = n % 10; return (t === 1 ? 'じゅう' : ones[t] + 'じゅう') + (o ? ones[o] : ''); }
  if (n < 1000)  { const hv = Math.floor(n / 100); return h(hv) + (n % 100 ? numToFullJa(n % 100) : ''); }
  if (n < 10000) { const kv = Math.floor(n / 1000); return k(kv) + (n % 1000 ? numToFullJa(n % 1000) : ''); }
  return String(n);
}

function numToJa1(n) {
  const v = parseInt(n, 10);
  const d = ['ゼロ', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
  return v < 10 ? (d[v] || String(v)) : numToFullJa(v);
}

function numToMinuteJa(nStr) {
  const v = parseInt(nStr, 10);
  if (!Number.isFinite(v) || v < 0) return nStr + 'うん';
  if (v === 0) return 'ぜろうん';
  const ONES = { 1:'いっぷん', 2:'にうん', 3:'さんぷん', 4:'よんぷん', 5:'ごうん', 6:'ろっぷん', 7:'ななうん', 8:'はっぷん', 9:'きゅううん' };
  const tens = Math.floor(v / 10), unit = v % 10;
  const tensOnes = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
  let tensPart = tens > 0 ? (tens === 1 ? 'じゅう' : tensOnes[tens] + 'じゅう') : '';
  if (tens > 0 && unit === 0) return tensPart.replace(/じゅう$/, 'じゅっぷん');
  return tensPart + (ONES[unit] || numToFullJa(unit) + 'うん');
}

// 数字+単位の確定読みテーブル
const UNIT_KANA = {
  '試合':'しあい', '得点':'とくてん', '失点':'しってん', 'アシスト':'アシスト',
  'キャップ':'キャップ', '歳':'さい', '回':'かい', '位':'い',
  '連勝':'れんしょう', '連敗':'れんぱい', '連覇':'れんぱ',
  '周年':'しゅうねん', '本':'ほん', '人':'にん', '秒':'びょう',
  '億':'おく', '万':'まん', '千':'せん', '度目':'どめ', '度':'ど', '個':'こ',
  '点':'てん', '%':'パーセント', 'km':'キロメートル', 'kg':'キログラム',
  '時間':'じかん', '節':'せつ', '勝':'しょう', '敗':'はい',
};

const PREFIX_PAUSE = new Set([
  '通算','合計','総','累計','歴代','現在','今季','前季','今期','前期',
  '今シーズン','前シーズン','約','およそ','過去','直近',
]);

const ORDINAL_MAP = {
  '1st':'ファースト', '2nd':'セカンド', '3rd':'サード',
  '4th':'フォース', '5th':'フィフス', '6th':'シックス',
  '7th':'セブンス', '8th':'エイス', '9th':'ナインス', '10th':'テンス',
};

// kuromoji で数字+助数詞ペア処理
async function _processNumbers(text) {
  const tokenizer = await _getKuromoji();
  if (!tokenizer) {
    // フォールバック
    return text
      .replace(/(通算|合計|総|累計|歴代|現在|今季|前季)\s*(\d)/g, '$1、$2')
      .replace(/(\d+)(試合|得点|失点|アシスト|キャップ|歳|回|位|連勝|連敗|連覇|周年|本|人|秒|億|万|千|度目|度|個|点|%|km|kg|時間|節|勝|敗)/g,
        (_, n, u) => numToFullJa(n) + (UNIT_KANA[u] || u))
      .replace(/\d+/g, m => numToFullJa(m));
  }
  const tokens = tokenizer.tokenize(text);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const surface = cur.surface_form;
    const isNum = cur.pos_detail_1 === '数' && /^\d+$/.test(surface);
    if (isNum) {
      if (i > 0 && PREFIX_PAUSE.has(tokens[i - 1].surface_form) && out.length && !out[out.length - 1].endsWith('、')) {
        out[out.length - 1] += '、';
      }
      const next = tokens[i + 1];
      if (next && UNIT_KANA[next.surface_form]) {
        out.push(numToFullJa(surface) + UNIT_KANA[next.surface_form]);
        i++;
      } else {
        out.push(numToFullJa(surface));
      }
    } else if (UNIT_KANA[surface]) {
      out.push(UNIT_KANA[surface]);
    } else {
      out.push(surface);
    }
  }
  return out.join('');
}

// ── メイン: テキストを TTS 向けに正規化 ───────────────
async function sanitizeForTts(text) {
  if (!text) return '';
  let s = String(text);

  // 0) 全角数字 → 半角
  s = s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

  // 1) 英語序数
  s = s.replace(/\b(1st|2nd|3rd|[4-9]th|10th)\b/gi, m => ORDINAL_MAP[m.toLowerCase()] || m);

  // 2) jp_dict（固有名詞・サッカー語彙）
  s = applyJpDict(s);

  // 2.5) 接続語+カタカナ/英字の区切り
  s = s.replace(/(その後|そのあと|だが|しかし|しかも|ただし|そして|やがて)\s*([A-Za-z]|[ァ-ヶー]{2,})/g, '$1、$2');

  // 3) スコア "3-1" → "さんたいいち"
  s = s.replace(/(\d+)\s*[-－ー−–—]\s*(\d+)/g, (_, a, b) => `${numToJa1(a)}たい${numToJa1(b)}`);

  // 4) N分の音便
  s = s.replace(/(\d+)\s*分/g, (_, n) => numToMinuteJa(n));

  // 5) 小数+単位
  s = s.replace(/(\d+)\.(\d+)(試合|得点|失点|アシスト|キャップ|歳|回|位|連勝|連敗|連覇|周年|本|人|秒|億|万|千|度目|度|個|点|%|km|kg|時間)?/g,
    (_, intP, decP, unit) => {
      const dec = decP.split('').map(d => numToFullJa(d)).join('');
      const unitKana = unit ? (UNIT_KANA[unit] || unit) : '';
      return numToFullJa(intP) + 'てん' + dec + (unit ? '、' + unitKana : '');
    });

  // 5.5) 勝敗表記
  s = s
    .replace(/(\d+)勝(\d+)分(\d+)敗/g, (_, w, d, l) => numToFullJa(w) + 'しょう' + numToFullJa(d) + 'わけ' + numToFullJa(l) + 'はい')
    .replace(/(\d+)勝(\d+)分/g, (_, w, d) => numToFullJa(w) + 'しょう' + numToFullJa(d) + 'わけ')
    .replace(/(\d+)勝(\d+)敗/g, (_, w, l) => numToFullJa(w) + 'しょう' + numToFullJa(l) + 'はい');

  // 6) kuromoji で数字+助数詞ペア処理
  s = await _processNumbers(s);

  // 7) kuroshiro で残り漢字をひらがな化
  try {
    const k = await _getKuroshiro();
    if (k) s = await k.convert(s, { to: 'hiragana' });
  } catch (e) {
    console.warn('  ⚠ kuroshiro convert 失敗:', e.message);
  }

  // 8) 括弧・中点・改行整形
  s = s.replace(/【([^】]+)】/g, '$1')
       .replace(/[・·]/g, '')
       .replace(/\r?\n+/g, '　')
       .trim();

  return s;
}

module.exports = { sanitizeForTts };
