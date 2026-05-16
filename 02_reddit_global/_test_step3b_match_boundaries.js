// _test_step3b_match_boundaries.js
// 1本撮りパイプライン Step3 本処理: 辞書 + ASR words を突き合わせて境界決定
//
// 入力:
//   - boundary_dict_*.json  (step3a で生成)
//   - words_*.json          (step2 で生成)
//
// 処理:
//   1. ASR words[] を 1 件ずつ applyJpDict + kuroshiro でひらがな化 → 全文連結
//   2. word ごとに「ひらがな全文上での位置」を記録 (segments[])
//   3. 各 module の tail20Hira を全文から検索 (indexOf)
//   4. ヒット位置の word を逆引きして boundary timestamp を取得
//   5. 失敗した module は tail を縮めて再検索 (15字 → 10字)
//
// 出力:
//   _test_step3_out/boundaries_<stamp>.json
//
// 使い方:
//   node _test_step3b_match_boundaries.js                # 既定: 最新の dict と words を自動選択
//   node _test_step3b_match_boundaries.js <dict.json> <words.json>

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { applyJpDict } = require('./scripts/v2_video/jp_dict');

const OUT_DIR = path.join(__dirname, '_test_step3_out');
const STEP2_DIR = path.join(__dirname, '_test_step2_out');

// fallback で縮める時の段階
const TAIL_FALLBACK_LENS = [20, 15, 10, 7];

// fuzzy match の許容類似度 (1.0 = 完全一致, 0.9 = 90% 一致)
//   TTS の生成ブレ + ASR の誤認 を吸収するため、 90% 以上で OK 扱い
const FUZZY_MIN_SIM = parseFloat(process.env.FUZZY_MIN_SIM || '0.85');

let _kuroshiro = null;
async function getKuroshiro() {
  if (_kuroshiro) return _kuroshiro;
  const Kuroshiro = require('kuroshiro').default;
  const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
  const k = new Kuroshiro();
  await k.init(new KuromojiAnalyzer());
  _kuroshiro = k;
  return k;
}

function normalizeForMatch(s) {
  if (!s) return '';
  let t = String(s).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  t = t.replace(/[\s　]/g, '');
  t = t.replace(/[、。「」『』（）()！!？?・…―\-—:：;；,\.]/g, '');
  t = t.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, '');
  return t;
}

function pickLatest(dir, prefix) {
  if (!fs.existsSync(dir)) throw new Error(`dir not found: ${dir}`);
  const cands = fs.readdirSync(dir)
    .filter(n => n.startsWith(prefix) && n.endsWith('.json'))
    .map(n => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!cands.length) throw new Error(`no ${prefix}*.json in ${dir}`);
  return path.join(dir, cands[0].name);
}

// ASR words[] → { segments, fullHira }
//   2026-05-16 改修: word 単位で kuroshiro 変換すると 1 文字漢字が訓読みに倒れる
//     (例: 「原」→「はら」、「動」→「どう」、「力」→「ちから」 → 合成「はらどうちから」)
//   解決策: 全文を 1 度に変換 → 文脈推測で正しい音読みになる ( →「げんどうりょく」)
//   word→hira の char マッピングは「元の char 長 × 全体比率」で近似 (±1-2 字の誤差は許容)
async function buildHiraSegments(words) {
  const k = await getKuroshiro();

  // 全文を 1 度に変換 (文脈付き → 正しい音読み)
  const fullRaw = words.map(w => String(w.text || '')).join('');
  const dictApplied = applyJpDict(fullRaw);
  const fullHiraRaw = await k.convert(dictApplied, { to: 'hiragana' });
  const fullHira = normalizeForMatch(fullHiraRaw);

  // word 境界 → fullHira 上の位置 を比例配分で近似
  const totalRawLen = fullRaw.length || 1;
  const totalHiraLen = fullHira.length;
  const ratio = totalHiraLen / totalRawLen;

  const segments = [];
  let rawCumulative = 0;
  for (let i = 0; i < words.length; i++) {
    const text = String(words[i].text || '');
    const normStart = Math.round(rawCumulative * ratio);
    rawCumulative += text.length;
    const normEnd = Math.round(rawCumulative * ratio);
    segments.push({
      wordIdx: i,
      raw: text,
      charStart: Math.min(normStart, totalHiraLen),
      charEnd: Math.min(normEnd, totalHiraLen),
    });
  }
  return { segments, fullHira };
}

// Levenshtein 距離 → 類似度 [0, 1]
//   1.0 = 完全一致, 0.0 = 完全不一致
function levenshteinSim(a, b) {
  if (a === b) return 1.0;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  // 行 2 本だけで持つ省メモリ版
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  const dist = prev[n];
  return 1 - dist / Math.max(m, n);
}

// fullHira から needle に最も近い window 位置を探す (fuzzy)
//   fromPos 以降の位置のみ対象 (順序保証)
//   minSim 未満なら null を返す
function fuzzyFind(fullHira, needle, fromPos, minSim) {
  if (!needle) return null;
  const exact = fullHira.indexOf(needle, fromPos);
  if (exact >= 0) return { pos: exact, similarity: 1.0, matched: needle, diagBest: { sim: 1.0, window: needle, pos: exact } };
  const L = needle.length;
  const start = Math.max(0, fromPos);
  const end = fullHira.length - L;
  let bestSim = 0, bestPos = -1, bestWindow = '';
  for (let i = start; i <= end; i++) {
    const window = fullHira.slice(i, i + L);
    const sim = levenshteinSim(needle, window);
    if (sim > bestSim) {
      bestSim = sim;
      bestPos = i;
      bestWindow = window;
      if (sim >= 1.0) break;
    }
  }
  const diagBest = { sim: bestSim, window: bestWindow, pos: bestPos };
  return bestSim >= minSim
    ? { pos: bestPos, similarity: bestSim, matched: bestWindow, diagBest }
    : { diagBest };  // 不採用でも診断情報を残す
}

// ひらがな全文の charPos から対応する word を探す
//   charPos は (matchStart + tail.length) = マッチ末尾の次の位置
//   この位置を含む / 直前に終わる word を返す
function findWordAtCharPos(segments, charPos) {
  // charPos に内包する seg (charStart < charPos <= charEnd)
  for (const s of segments) {
    if (s.charStart < charPos && charPos <= s.charEnd) return s;
  }
  // 万一外れた場合は直前の seg
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].charEnd <= charPos) return segments[i];
  }
  return segments[segments.length - 1];
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dictPath  = path.resolve(process.argv[2] || pickLatest(OUT_DIR, 'boundary_dict_'));
  const wordsPath = path.resolve(process.argv[3] || pickLatest(STEP2_DIR, 'words_'));

  const dict  = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
  const words = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));

  console.log(`📂 dict : ${path.basename(dictPath)}`);
  console.log(`📂 words: ${path.basename(wordsPath)} (${words.length} words)`);
  console.log(`⏳ ASR words をひらがな化中...`);

  const t0 = Date.now();
  const { segments, fullHira } = await buildHiraSegments(words);
  console.log(`✓ ${segments.length} segments / fullHira ${fullHira.length} 字 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 各 module の末尾を検索 → 境界決定
  const activeModules = dict.modules.filter(m => !m.skip);
  // 境界は activeModules.length - 1 個（最後の module の終わりは音声末尾そのもの）
  const boundaries = [];
  let searchFromPos = 0;  // 前の module 境界より後を探す（順序保証）

  console.log(`🔍 fuzzy match (min_sim=${FUZZY_MIN_SIM})`);
  for (let i = 0; i < activeModules.length - 1; i++) {
    const m = activeModules[i];
    const tail20 = m.tail20Hira || '';
    let bestResult = null;  // { pos, similarity, matched, usedLen, usedTail }

    // 20 → 15 → 10 → 7 字で fallback
    //   長いほうから探して見つかったら採用 (長いほど誤マッチしにくい)
    const diagLog = [];
    for (const len of TAIL_FALLBACK_LENS) {
      const tail = tail20.slice(-len);
      if (tail.length < len) continue;
      const r = fuzzyFind(fullHira, tail, searchFromPos, FUZZY_MIN_SIM);
      diagLog.push({ len, tail, bestSim: r?.diagBest?.sim ?? 0, bestWindow: r?.diagBest?.window || '' });
      if (r && r.pos != null) {
        bestResult = { ...r, usedLen: len, usedTail: tail };
        break;
      }
    }
    // 採用された len より長い tail で「不採用だった best sim」を診断ログ出力
    if (bestResult) {
      const adoptedLen = bestResult.usedLen;
      const rejectedLongerThan = diagLog.filter(d => d.len > adoptedLen);
      if (rejectedLongerThan.length > 0) {
        rejectedLongerThan.forEach(d => {
          console.log(`     [diag] tail${d.len} 不採用 (best ${(d.bestSim * 100).toFixed(0)}%): "${d.tail}" vs "${d.bestWindow}"`);
        });
      }
    }

    if (!bestResult) {
      console.log(`  ✗ m${m.idx} (${m.type}): NO MATCH (tail20="${tail20}")`);
      boundaries.push({
        fromModuleIdx: m.idx,
        toModuleIdx: activeModules[i + 1].idx,
        matched: false,
        tail20: tail20,
        ts: null,
      });
      continue;
    }

    const matchEnd = bestResult.pos + bestResult.usedTail.length;
    const seg = findWordAtCharPos(segments, matchEnd);
    const ts = words[seg.wordIdx].end;
    const simPct = (bestResult.similarity * 100).toFixed(0);
    const exact = bestResult.similarity >= 1.0 ? 'exact' : `${simPct}%`;

    console.log(`  ✓ m${m.idx} (${m.type}): ${ts.toFixed(2)}s @ word[${seg.wordIdx}]="${seg.raw}" (tail${bestResult.usedLen} ${exact})`);
    if (bestResult.similarity < 1.0) {
      console.log(`     needle : "${bestResult.usedTail}"`);
      console.log(`     matched: "${bestResult.matched}"`);
    }

    boundaries.push({
      fromModuleIdx: m.idx,
      fromModuleType: m.type,
      toModuleIdx: activeModules[i + 1].idx,
      toModuleType: activeModules[i + 1].type,
      matched: true,
      tail20: tail20,
      usedTailLen: bestResult.usedLen,
      usedTail: bestResult.usedTail,
      matchedSubstring: bestResult.matched,
      similarity: +bestResult.similarity.toFixed(3),
      matchCharPos: bestResult.pos,
      matchedWordIdx: seg.wordIdx,
      matchedWordText: seg.raw,
      ts,
    });

    searchFromPos = matchEnd;
  }

  // 全体 span (確認用)
  const firstWordTs = words[0].start;
  const lastWordTs = words[words.length - 1].end;

  console.log(`\n📊 結果まとめ`);
  console.log(`   全体: ${firstWordTs.toFixed(2)}s 〜 ${lastWordTs.toFixed(2)}s`);
  const matched = boundaries.filter(b => b.matched).length;
  console.log(`   マッチ率: ${matched}/${boundaries.length}`);

  if (matched === boundaries.length) {
    // 各 module の duration を計算して表示
    const moduleDurs = [];
    let prevTs = 0;
    for (let i = 0; i < activeModules.length; i++) {
      const startTs = i === 0 ? 0 : boundaries[i - 1].ts;
      const endTs   = i === activeModules.length - 1 ? lastWordTs : boundaries[i].ts;
      const dur = endTs - startTs;
      moduleDurs.push({ idx: activeModules[i].idx, type: activeModules[i].type, startTs, endTs, dur });
      console.log(`   m${activeModules[i].idx} (${activeModules[i].type.padEnd(10)}): ${startTs.toFixed(2)}s 〜 ${endTs.toFixed(2)}s (${dur.toFixed(2)}s)`);
    }
  }

  const stamp = Date.now();
  const outPath = path.join(OUT_DIR, `boundaries_${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    stamp,
    dictPath,
    wordsPath,
    totalSpanSec: lastWordTs - firstWordTs,
    activeModules: activeModules.map(m => ({ idx: m.idx, type: m.type })),
    matchRate: `${matched}/${boundaries.length}`,
    boundaries,
  }, null, 2), 'utf8');
  console.log(`\n📝 boundaries: ${outPath}`);
}

main().catch(e => {
  console.error('✗ 失敗:', e.message);
  console.error(e.stack);
  process.exit(1);
});
