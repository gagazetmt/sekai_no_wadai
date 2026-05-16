// scripts/v2_video/audio_splitter.js
// 全 slide narration を 1 本取り → ASR words から文字数累積で境界決定 → 各 slide に切り出し
//
// 目的:
//   - Gemini TTS の生成揺らぎ（±35% の duration ブレ）を排除
//   - 全 slide で声色・速度・音量を完璧に統一
//   - クォータ消費を 9 → 1 に削減
//
// 旧方式（区切り音「一旦カット」検出）は 2026-05-15 廃止:
//   TTS が反復区切り文を頻繁に省略するため検出失敗 → fallback 連発でクォータ食い尽くし。
//
// 新方式:
//   1. 全 narration を素直に連結（区切り音なし）→ TTS 1 リクエスト
//   2. ASR で words[] (text + timestamps) 取得
//   3. 各 slide の原文文字数比率で ASR words を分配
//   4. 境界は word 間ギャップ最大位置に snap（自然な間で切る）
//   5. 各 slide 内では word timestamps を相対化（字幕同期維持）
//
// ASR provider (env ASR_PROVIDER):
//   openai (既定) — Whisper (verbose_json + word timestamps)。25MB / ≒30分 / 1 リクエスト
//   gemini         — multimodal。長文は 75s ずつ chunk 分割 + 並列マージ (構造上失敗しやすい)
//   いずれにせよ Whisper 失敗時は Gemini にフォールバック

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { generateGeminiTTS } = require('./tts_gemini');
const geminiAsr = require('./gemini_asr');
const openaiAsr = require('./openai_asr');
const { applyJpDict } = require('./jp_dict');

const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
const FFPROBE = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffprobe.exe' : 'ffprobe';

// ASR provider 切替: openai (Whisper, 既定) / gemini (multimodal, 長文で詰まる事故あり)
const ASR_PROVIDER = (process.env.ASR_PROVIDER || 'openai').toLowerCase();

// 目標読み速度（字/秒）。env TTS_TARGET_CPS で上書き可能。
//   2026-05-16: 検証を経て 7.2 → 6.6 に再調整 (相棒判断「7.2 でも早い」)
//   履歴: 10 → 6 (早朝) → 7.2 (聴き比べ後) → 6.6 (最終調整、自然なテンポ感)
const TARGET_CHARS_PER_SEC = parseFloat(process.env.TTS_TARGET_CPS || '6.6');
// 境界 snap マージン: candidate ± この秒数の範囲で最大ギャップを探して snap
const BOUNDARY_MARGIN_SEC = parseFloat(process.env.TTS_BOUNDARY_MARGIN || '1.5');
// 連結時の slide 間デリミタ（TTS に「次の話題」と認識させる軽い区切り、検出には使わない）
const JOIN_DELIM = '\n\n';

// 2026-05-16: 末尾マッチ方式の境界決定パラメータ
//   各 slide の末尾 N 字を「原文 → applyJpDict → kuroshiro → 正規化」しておき、
//   ASR 全文(同正規化)から fuzzy 検索する。 文字数比配分より原文準拠で堅牢。
//   旧 computeBoundaries (文字数比配分 + ギャップ snap) は fallback として残す
const BOUNDARY_TAIL_LEN  = parseInt(process.env.BOUNDARY_TAIL_LEN || '20', 10);
const BOUNDARY_FUZZY_MIN = parseFloat(process.env.BOUNDARY_FUZZY_MIN || '0.85');
const TAIL_FALLBACK_LENS = [20, 15, 10, 7];

// Sanity check: 各 slide の duration が平均 cps からどれだけ乖離してよいか
//   各 slide の duration を「全体平均 cps から逆算した予想 duration」と比較
//   ratio < MIN → 短すぎ (誤マッチで手前の slide が拾われた可能性) → retry
//   ratio > MAX → 長すぎ (採用するが suspect フラグ。 20字偶然一致は稀のため警告のみ)
const BOUNDARY_SANITY_MIN  = parseFloat(process.env.BOUNDARY_SANITY_MIN || '0.5');
const BOUNDARY_SANITY_MAX  = parseFloat(process.env.BOUNDARY_SANITY_MAX || '2.0');
const BOUNDARY_RETRY_LIMIT = parseInt(process.env.BOUNDARY_RETRY_LIMIT || '3', 10);

// kuroshiro singleton (再 init を避ける)
let _kuroshiroPromise = null;
async function _getKuroshiro() {
  if (_kuroshiroPromise) return _kuroshiroPromise;
  _kuroshiroPromise = (async () => {
    try {
      const Kuroshiro = require('kuroshiro').default;
      const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
      const k = new Kuroshiro();
      await k.init(new KuromojiAnalyzer());
      return k;
    } catch (e) {
      console.warn('  ⚠️ kuroshiro 初期化失敗 → 文字数比配分 fallback:', e.message);
      return null;
    }
  })();
  return _kuroshiroPromise;
}

/**
 * 複数 slide の narration をまとめて生成し、 個別 mp3 に切り出す
 * @param {Array<{ slideIdx, text, outputPath }>} parts
 * @param {Object} opts
 *   voiceId, styleInstructions, model: TTS パラメータ
 *   keepIndividual: true(既定) で各 slide の個別 mp3 を切り出す。
 *                   false なら combined.mp3 のみ保持、個別 mp3 切り出しスキップ。
 *                   INTEGRATED_AUDIO_MODE 向けの新パス用。
 *   keepCombined  : true なら combined.mp3 を残す（既定: keepIndividual の逆）
 * @returns {Promise<{
 *   parts: Array<{ slideIdx, audioPath?, durationSec, words, text, startAbsSec, endAbsSec }>,
 *   combinedAudioPath: string | null,
 *   totalDurationSec: number,
 *   wordsAbs: Array<{text,start,end}>
 * }>}
 *
 * 後方互換: 戻り値は parts 配列としても iterable. result[i] === result.parts[i]
 *   既存呼び出し側 (for (const r of results)) を壊さないため Proxy.
 */
async function generateAndSplit(parts, opts = {}) {
  const keepIndividual = opts.keepIndividual !== false;  // 既定 true
  const keepCombined   = opts.keepCombined   ?? !keepIndividual;  // 既定 = !keepIndividual
  if (!parts.length) return _makeResult([], null, 0, []);

  // 1. 各 part の正規化文字数（読み長近似）
  const normalizedLens = parts.map(p => normalizeForCount(p.text || '').length);
  const totalNormChars = normalizedLens.reduce((a, b) => a + b, 0);
  if (totalNormChars === 0) return [];

  // 2. 全文結合（区切り音なし）
  const fullText = parts.map(p => String(p.text || '').trim()).filter(Boolean).join(JOIN_DELIM);

  const baseDir = path.dirname(parts[0].outputPath);
  fs.mkdirSync(baseDir, { recursive: true });

  // 3. raw TTS 生成 (atempo=1.0、 後段で動的調整)
  //    長文 (fullText.length > TTS_CHUNK_CHAR_LIMIT) は 2-3 sub-text に分割して
  //    別 TTS リクエストで生成 → ffmpeg concat で 1 本にまとめる
  //
  //    2026-05-15: Gemini 2.5 Pro TTS は ~1300 tokens (≒1700字) で finishReason: OTHER → 1500 で分割
  //    2026-05-16 朝: 3.1 Flash で 1828 字を 1 リクエスト処理可能と検証 → 99999 (実質無制限)
  //    2026-05-16 夜: 1 リクエスト長文だと後半に音量低下(-55 dB に劣化)、 cps 揺らぎも残る
  //                  → 900 (≒ 4 slide chunk) に再変更。 chunk 切替で音量リセットさせる設計
  //                  4 slide chunk 検証で -16〜-20 dB の安定域に収まることを確認
  const stamp = Date.now();
  const TTS_CHUNK_CHAR_LIMIT = parseInt(process.env.TTS_CHUNK_CHAR_LIMIT || '900', 10);
  const subTexts = fullText.length > TTS_CHUNK_CHAR_LIMIT
    ? _splitLongTextForTTS(fullText, TTS_CHUNK_CHAR_LIMIT)
    : [fullText];
  if (subTexts.length > 1) {
    console.log(`  ✂️ TTS 自動分割: fullText ${fullText.length} 字 → ${subTexts.length} parts (${subTexts.map(s => s.length).join(' / ')} 字)`);
  }

  const rawMp3 = path.join(baseDir, `_combined_raw_${stamp}.mp3`);
  const oldSpeed = process.env.TTS_GEMINI_SPEED;
  process.env.TTS_GEMINI_SPEED = '1.0';
  try {
    if (subTexts.length === 1) {
      await generateGeminiTTS({
        text: subTexts[0],
        voiceId: opts.voiceId,
        model: opts.model,
        styleInstructions: opts.styleInstructions,
        outputPath: rawMp3,
        // 長文では Gemini TTS の生成時間が音声尺と同等 (1500字 ≒ 4 分)
        // env TTS_COMBINED_TIMEOUT_MS で override 可、既定 10 分
        timeoutMs: parseInt(process.env.TTS_COMBINED_TIMEOUT_MS || '600000', 10),
      });
    } else {
      const subRawMp3s = [];
      for (let i = 0; i < subTexts.length; i++) {
        const subPath = path.join(baseDir, `_combined_sub${i}_${stamp}.mp3`);
        await generateGeminiTTS({
          text: subTexts[i],
          voiceId: opts.voiceId,
          model: opts.model,
          styleInstructions: opts.styleInstructions,
          outputPath: subPath,
          timeoutMs: parseInt(process.env.TTS_COMBINED_TIMEOUT_MS || '600000', 10),
        });
        subRawMp3s.push(subPath);
      }
      await ffmpegConcatMp3s(subRawMp3s, rawMp3);
      subRawMp3s.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
    }
  } finally {
    if (oldSpeed != null) process.env.TTS_GEMINI_SPEED = oldSpeed;
    else delete process.env.TTS_GEMINI_SPEED;
  }

  // 4. raw duration → 動的 atempo
  const rawDur = probeDurationSec(rawMp3);
  if (rawDur <= 0) throw new Error('raw audio duration zero');
  const idealDur = totalNormChars / TARGET_CHARS_PER_SEC;
  const atempo = Math.max(0.5, Math.min(2.0, rawDur / idealDur));
  console.log(`  🎵 combined: raw=${rawDur.toFixed(1)}s / chars=${totalNormChars} / target=${idealDur.toFixed(1)}s / atempo=${atempo.toFixed(3)}`);

  // 5. atempo + loudnorm 適用
  const finalMp3 = path.join(baseDir, `_combined_final_${stamp}.mp3`);
  await applyFilters(rawMp3, finalMp3, atempo);

  // 6. ASR
  //    primary: Whisper (1 リクエストで動画全体カバー、25MB 制限内)
  //    fallback: Gemini multimodal (chunk 分割マージ、長文で失敗報告あり)
  const words = await transcribeAuto(finalMp3);
  if (!words.length) throw new Error('ASR returned no words');

  // 7. 境界決定：primary = 末尾マッチ fuzzy (原文準拠で堅牢) / fallback = 文字数比配分
  const totalDur = probeDurationSec(finalMp3);
  let boundaries = null;
  try {
    boundaries = await computeBoundariesByTail(words, parts, totalDur);
  } catch (e) {
    console.warn(`  ⚠️ computeBoundariesByTail 例外 → 文字数比 fallback: ${e.message}`);
    boundaries = null;
  }
  if (boundaries) {
    console.log(`  🎯 境界(末尾マッチ): ${boundaries.map(b => b.toFixed(1) + 's').join(' / ')}`);
  } else {
    boundaries = computeBoundaries(words, normalizedLens, totalDur);
    console.log(`  🎯 境界(文字数比配分 fallback): ${boundaries.map(b => b.toFixed(1) + 's').join(' / ')}`);
  }

  // 8. 各 slide 範囲を確定
  const ranges = parts.map((p, i) => {
    const start = i === 0 ? 0 : boundaries[i - 1];
    const end = i === parts.length - 1 ? totalDur : boundaries[i];
    return { slideIdx: p.slideIdx, start, end, outputPath: p.outputPath, text: p.text };
  });

  // 9. ffmpeg で切り出し (keepIndividual=false なら省略) + 各 slide 内 word timestamps を相対化
  const results = [];
  for (const r of ranges) {
    const durSec = r.end - r.start;
    if (durSec <= 0.2) {
      console.warn(`  ⚠️ slide#${r.slideIdx + 1} duration <= 0.2s, skip`);
      continue;
    }
    let actualDur = durSec;
    let audioPath = null;
    if (keepIndividual) {
      await ffmpegSlice(finalMp3, r.outputPath, r.start, durSec);
      actualDur = probeDurationSec(r.outputPath);
      audioPath = r.outputPath;
    }
    const slideWords = words
      .filter(w => w.start >= r.start && w.end <= r.end)
      .map(w => ({
        text: String(w.text || ''),
        start: Math.max(0, w.start - r.start),
        end: Math.max(0, w.end - r.start),
      }));
    results.push({
      slideIdx: r.slideIdx,
      audioPath,
      durationSec: actualDur,
      words: slideWords,
      text: r.text,
      startAbsSec: r.start,
      endAbsSec: r.end,
    });
  }

  // 10. cleanup
  try { fs.unlinkSync(rawMp3); } catch (_) {}
  let combinedAudioPath = null;
  if (keepCombined) {
    // baseDir に分かりやすい名前で残す
    combinedAudioPath = path.join(baseDir, `_combined_${stamp}.mp3`);
    fs.renameSync(finalMp3, combinedAudioPath);
  } else {
    try { fs.unlinkSync(finalMp3); } catch (_) {}
  }

  return _makeResult(results, combinedAudioPath, totalDur, words);
}

// 戻り値を「parts 配列としても iterable」「{parts, combinedAudioPath, ...} としても展開可」
//   既存呼出 (for (const r of result)) を壊さない後方互換
function _makeResult(parts, combinedAudioPath, totalDurationSec, wordsAbs) {
  Object.defineProperty(parts, 'parts', { value: parts, enumerable: false });
  Object.defineProperty(parts, 'combinedAudioPath', { value: combinedAudioPath, enumerable: false });
  Object.defineProperty(parts, 'totalDurationSec', { value: totalDurationSec, enumerable: false });
  Object.defineProperty(parts, 'wordsAbs', { value: wordsAbs, enumerable: false });
  return parts;
}

// fuzzy match 用の正規化 (両側を揃えて比較)
//   カタカナ→ひらがな + 空白・句読点除去
function normalizeForMatch(s) {
  if (!s) return '';
  let t = String(s).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  t = t.replace(/[\s　]/g, '');
  t = t.replace(/[、。「」『』（）()！!？?・…―\-—:：;；,\.]/g, '');
  t = t.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, '');
  return t;
}

// Levenshtein 距離 → 類似度 [0, 1]
function _levenshteinSim(a, b) {
  if (a === b) return 1.0;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
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
  return 1 - prev[n] / Math.max(m, n);
}

// fullHira から needle に最も近い window 位置を fuzzy 検索
function _fuzzyFind(fullHira, needle, fromPos, minSim) {
  if (!needle) return null;
  const exact = fullHira.indexOf(needle, fromPos);
  if (exact >= 0) return { pos: exact, similarity: 1.0, matched: needle };
  const L = needle.length;
  const start = Math.max(0, fromPos);
  const end = fullHira.length - L;
  let bestSim = 0, bestPos = -1, bestWindow = '';
  for (let i = start; i <= end; i++) {
    const window = fullHira.slice(i, i + L);
    const sim = _levenshteinSim(needle, window);
    if (sim > bestSim) {
      bestSim = sim;
      bestPos = i;
      bestWindow = window;
      if (sim >= 1.0) break;
    }
  }
  return bestSim >= minSim ? { pos: bestPos, similarity: bestSim, matched: bestWindow } : null;
}

/**
 * 末尾マッチ方式の境界決定（2026-05-16 採用）
 *   1. ASR words[] を **全文連結** して kuroshiro でひらがな化 (文脈付き → 漢字 1 文字も正しい音読み)
 *   2. 各 slide の原文末尾 BOUNDARY_TAIL_LEN 字も同じ正規化
 *   3. fuzzy 検索 (Levenshtein 類似度 >= BOUNDARY_FUZZY_MIN) でヒット位置の word.end を境界に
 *   4. 1 slide でも失敗したら null を返し、 呼び出し側で computeBoundaries (文字数比配分) に fallback
 *
 *   旧 computeBoundaries との違い:
 *     - 文字数比配分は ASR の漢字読み崩れ (例: 「原動力」を ASR が「げんどうりょく」と聞き取れず) で
 *       累積カウントがズレる ⇒ 境界位置が想定より N 秒ずれる
 *     - 末尾マッチは原文の固有テキストを直接探すので、 ASR 誤認の影響が局所化される
 *
 * @returns {Promise<Array<number>|null>} 境界 timestamps （成功時）/ null (失敗で fallback 要)
 */
async function computeBoundariesByTail(words, parts, totalDur) {
  const k = await _getKuroshiro();
  if (!k) return null;  // kuroshiro 失敗 → fallback

  const n = parts.length;
  if (n <= 1) return [];

  // 1. ASR 全文ひらがな化
  const asrFullRaw = words.map(w => String(w.text || '')).join('');
  const asrDict    = applyJpDict(asrFullRaw);
  const asrHiraRaw = await k.convert(asrDict, { to: 'hiragana' });
  const fullHira   = normalizeForMatch(asrHiraRaw);

  // 2. word 境界 → fullHira 上の位置 を比例配分で近似
  //    (連続漢字の正しい音読み化を優先するため、 word 単位の正確な char マッピングは犠牲)
  //    精度: ±1-2 字 (tail20 マッチには十分)
  const ratio = fullHira.length / Math.max(asrFullRaw.length, 1);
  const segments = [];
  let rawCum = 0;
  for (let i = 0; i < words.length; i++) {
    const text = String(words[i].text || '');
    const ns = Math.round(rawCum * ratio);
    rawCum += text.length;
    const ne = Math.round(rawCum * ratio);
    segments.push({ wordIdx: i, charStart: Math.min(ns, fullHira.length), charEnd: Math.min(ne, fullHira.length) });
  }
  const findWord = charPos => {
    for (const s of segments) if (s.charStart < charPos && charPos <= s.charEnd) return s;
    for (let i = segments.length - 1; i >= 0; i--) if (segments[i].charEnd <= charPos) return segments[i];
    return segments[segments.length - 1];
  };

  // 3. 各 slide の末尾正規化 + fuzzy 検索 (sanity check + retry 付き)
  //    Sanity check: actualDur / expectedDur で異常な長さを検知
  //      短すぎ (< MIN) → 次の候補位置から再 fuzzy (最大 RETRY_LIMIT 回)
  //      長すぎ (> MAX) → 採用 + suspect フラグ (20 字偶然一致は稀)
  const partsCharLens = parts.map(p => String(p.text || '').length);
  const totalPartsChars = partsCharLens.reduce((a, b) => a + b, 0);
  const avgCps = totalPartsChars / Math.max(totalDur, 0.001);

  const boundaries = [];
  let searchFromPos = 0;
  let prevTs = 0;  // 前 slide の境界 (i=0 では 0)

  for (let i = 0; i < n - 1; i++) {
    const partText = String(parts[i].text || '');
    const partDict = applyJpDict(partText);
    const partHiraRaw = await k.convert(partDict, { to: 'hiragana' });
    const partHira = normalizeForMatch(partHiraRaw);
    const tail = partHira.slice(-BOUNDARY_TAIL_LEN);
    const expectedDur = partsCharLens[i] / avgCps;

    let accepted = null;
    for (const len of TAIL_FALLBACK_LENS) {
      const t = tail.slice(-len);
      if (t.length < len) continue;
      let retryFromPos = searchFromPos;
      for (let attempt = 0; attempt < BOUNDARY_RETRY_LIMIT; attempt++) {
        const r = _fuzzyFind(fullHira, t, retryFromPos, BOUNDARY_FUZZY_MIN);
        if (!r || r.pos == null) break;  // この tail 長では候補なし → 次の短い tail へ

        const matchEnd = r.pos + t.length;
        const seg = findWord(matchEnd);
        const ts = words[seg.wordIdx].end;
        const actualDur = ts - prevTs;
        const ratio = actualDur / Math.max(expectedDur, 0.001);

        if (ratio < BOUNDARY_SANITY_MIN) {
          // 短すぎ → 次の候補位置から再検索
          console.log(`     [sanity] slide#${i + 1} tail${len} pos=${r.pos} ratio=${ratio.toFixed(2)} < ${BOUNDARY_SANITY_MIN} (短すぎ) → retry`);
          retryFromPos = r.pos + 1;
          continue;
        }
        // OK or 長すぎ (採用): どちらも accept
        accepted = { ...r, usedLen: len, usedTail: t, ts, seg, ratio, suspect: ratio > BOUNDARY_SANITY_MAX, attempt };
        break;
      }
      if (accepted) break;
    }

    if (!accepted) {
      console.warn(`  ⚠️ slide#${i + 1} 境界 fuzzy 失敗 (全 tail 全 retry 範囲外) → 文字数比配分 fallback`);
      return null;
    }

    const simTag = accepted.similarity >= 1.0 ? 'exact' : `${(accepted.similarity * 100).toFixed(0)}%`;
    const flag = accepted.suspect ? ` ⚠️ ratio=${accepted.ratio.toFixed(2)} (長すぎ suspect)` : '';
    const retryTag = accepted.attempt > 0 ? ` retry${accepted.attempt + 1}` : '';
    console.log(`  ✓ slide#${i + 1} 境界: ${accepted.ts.toFixed(2)}s (tail${accepted.usedLen} ${simTag}${retryTag}, ratio=${accepted.ratio.toFixed(2)})${flag}`);
    boundaries.push(accepted.ts);
    searchFromPos = accepted.pos + accepted.usedTail.length;
    prevTs = accepted.ts;
  }
  return boundaries;
}

/**
 * 原文文字数 + ASR words[] から各 slide の境界 timestamp を決定
 *   累積文字数比率を ASR の累積文字数に当てはめ、対応 word の end を candidate に
 *   candidate ± BOUNDARY_MARGIN_SEC の範囲で最大ギャップ中央に snap（自然な切れ目）
 *
 *   2026-05-16: 文字数比方式は ASR 誤認に弱い。 computeBoundariesByTail が primary。
 *   ここは fuzzy 失敗時の fallback として残置。
 *
 * @param {Array<{text, start, end}>} words ASR words（時刻順）
 * @param {Array<number>} normLens 各 slide の正規化文字数
 * @param {number} totalDur 全体 duration
 * @returns {Array<number>} 境界 timestamps（長さ = slides 数 - 1）
 */
function computeBoundaries(words, normLens, totalDur) {
  const n = normLens.length;
  if (n <= 1) return [];

  const wordNormLens = words.map(w => normalizeForCount(w.text || '').length);
  const totalAsrChars = wordNormLens.reduce((a, b) => a + b, 0);
  const totalNorm = normLens.reduce((a, b) => a + b, 0);

  // ASR テキスト無い → 時間比配分 fallback
  if (totalAsrChars === 0) {
    const boundaries = [];
    let cum = 0;
    for (let i = 0; i < n - 1; i++) {
      cum += normLens[i];
      boundaries.push(totalDur * cum / totalNorm);
    }
    return boundaries;
  }

  const boundaries = [];
  let wordIdx = 0;
  let accAsr = 0;
  let cumNorm = 0;

  for (let i = 0; i < n - 1; i++) {
    cumNorm += normLens[i];
    const targetAsrChars = totalAsrChars * (cumNorm / totalNorm);

    while (wordIdx < words.length && accAsr + wordNormLens[wordIdx] < targetAsrChars) {
      accAsr += wordNormLens[wordIdx];
      wordIdx++;
    }
    const candidateTime = (words[wordIdx] && words[wordIdx].end) || totalDur;

    const snappedTime = snapToNearestGap(words, candidateTime, BOUNDARY_MARGIN_SEC);
    boundaries.push(snappedTime);

    // wordIdx を snap 後の位置に合わせる（次 slide で同じ word を二重消化しない）
    while (wordIdx < words.length && words[wordIdx].end <= snappedTime) {
      accAsr += wordNormLens[wordIdx];
      wordIdx++;
    }
  }
  return boundaries;
}

/**
 * target ± margin の範囲で word 間ギャップが最大の位置に snap
 * 該当ギャップが無ければ target をそのまま返す
 */
function snapToNearestGap(words, target, margin) {
  let bestPos = target;
  let bestGap = -1;
  for (let i = 1; i < words.length; i++) {
    const gapStart = words[i - 1].end;
    const gapEnd = words[i].start;
    if (gapEnd <= gapStart) continue;
    const gapCenter = (gapStart + gapEnd) / 2;
    if (Math.abs(gapCenter - target) <= margin) {
      const gapSize = gapEnd - gapStart;
      if (gapSize > bestGap) {
        bestGap = gapSize;
        bestPos = gapCenter;
      }
    }
  }
  return bestPos;
}

/**
 * 文字数カウント用の正規化（原文と ASR を同じスケールで比較するため）
 *   - 空白・改行・タブ除去
 *   - 句読点・記号類除去（ASR が出力しない要素を原文から除く）
 *   - 絵文字除去
 *   ※数字・英字略語の読み展開ズレは BOUNDARY_MARGIN_SEC で吸収する前提
 */
function normalizeForCount(s) {
  if (!s) return '';
  let t = String(s).replace(/[\s　]/g, '');
  t = t.replace(/[、。「」『』（）()！!？?・…―\-—:：;；,\.]/g, '');
  t = t.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, '');
  return t;
}

// 長文を文末で 2-3 分割: 各 part が limit 以下になるまで再帰的に半割
//   文末 (。 ！ ？) を優先、無ければ 読点 (、) で半割、それも無ければ強制半割
function _splitLongTextForTTS(text, limit) {
  if (!text || text.length <= limit) return [text].filter(Boolean);
  // 中央付近で文末を探す (まず後半、次に前半)
  const mid = Math.floor(text.length / 2);
  let splitPos = -1;
  const isStrongBreak = c => c === '。' || c === '！' || c === '？';
  const isSoftBreak   = c => c === '、';
  // 後半中央以降で強い区切り
  for (let i = mid; i < Math.min(text.length, limit); i++) {
    if (isStrongBreak(text[i])) { splitPos = i + 1; break; }
  }
  // 前半中央以前で強い区切り
  if (splitPos < 0) {
    for (let i = mid - 1; i > 0; i--) {
      if (isStrongBreak(text[i])) { splitPos = i + 1; break; }
    }
  }
  // 強い区切り無ければ 読点
  if (splitPos < 0) {
    for (let i = mid; i < Math.min(text.length, limit); i++) {
      if (isSoftBreak(text[i])) { splitPos = i + 1; break; }
    }
  }
  // それでも無ければ強制半割
  if (splitPos < 0) splitPos = mid;

  const left  = text.slice(0, splitPos).trim();
  const right = text.slice(splitPos).trim();
  return [..._splitLongTextForTTS(left, limit), ..._splitLongTextForTTS(right, limit)];
}

// 複数の mp3 を ffmpeg concat demuxer で 1 本にまとめる (同じ codec/sample rate 前提)
function ffmpegConcatMp3s(srcMp3s, outMp3) {
  return new Promise((resolve, reject) => {
    const baseDir = path.dirname(outMp3);
    const listFile = path.join(baseDir, `_concat_list_${Date.now()}.txt`);
    fs.writeFileSync(listFile, srcMp3s.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-codec:a', 'libmp3lame', '-b:a', '128k',
      outMp3,
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => { try { fs.unlinkSync(listFile); } catch (_) {}; reject(e); });
    proc.on('close', code => {
      try { fs.unlinkSync(listFile); } catch (_) {}
      if (code === 0) resolve(outMp3);
      else reject(new Error(`ffmpeg concat exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// atempo + loudnorm 一括適用
function applyFilters(srcMp3, outMp3, atempo) {
  return new Promise((resolve, reject) => {
    const af = atempo === 1.0
      ? 'loudnorm=I=-16:TP=-1.5:LRA=11'
      : `loudnorm=I=-16:TP=-1.5:LRA=11,atempo=${atempo.toFixed(3)}`;
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', srcMp3, '-af', af, '-codec:a', 'libmp3lame', '-b:a', '128k', outMp3];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(outMp3);
      else reject(new Error(`ffmpeg apply exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// 時間範囲切り出し
function ffmpegSlice(srcMp3, outMp3, startSec, durSec) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', srcMp3,
      '-ss', startSec.toFixed(3),
      '-t', durSec.toFixed(3),
      '-codec:a', 'libmp3lame', '-b:a', '128k',
      outMp3,
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(outMp3);
      else reject(new Error(`ffmpeg slice exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// ASR 実行: primary (Whisper) → 失敗時 fallback (Gemini chunked)
async function transcribeAuto(mp3Path) {
  if (ASR_PROVIDER === 'gemini') {
    return await transcribeGeminiChunked(mp3Path);
  }
  // openai (Whisper) を先に試す。25MB 内なら 1 リクエストで完走
  try {
    const t0 = Date.now();
    const words = await openaiAsr.transcribeWithTimestamps(mp3Path);
    console.log(`  🎙️ Whisper ASR: ${words.length} words (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (words.length > 0) return words;
    console.warn('  ⚠️ Whisper ASR: words 空 → Gemini fallback');
  } catch (e) {
    console.warn(`  ⚠️ Whisper ASR 失敗 → Gemini fallback: ${e.message.slice(0, 150)}`);
  }
  return await transcribeGeminiChunked(mp3Path);
}

// Gemini multimodal ASR: 長文は 75s ずつ分割 → 並列 → offset 加算マージ
async function transcribeGeminiChunked(mp3Path, chunkSec = 75) {
  const totalDur = probeDurationSec(mp3Path);
  if (totalDur <= chunkSec * 1.2) {
    return await geminiAsr.transcribeWithTimestamps(mp3Path);
  }
  const nChunks = Math.ceil(totalDur / chunkSec);
  console.log(`  🔪 Gemini ASR 分割: ${totalDur.toFixed(1)}s → ${nChunks} chunks (${chunkSec}s each, 並列実行)`);
  const baseDir = path.dirname(mp3Path);
  const stamp = Date.now();
  const tmpFiles = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * chunkSec;
    const dur = Math.min(chunkSec, totalDur - start);
    const tmpPath = path.join(baseDir, `_asr_chunk_${i}_${stamp}.mp3`);
    await ffmpegSlice(mp3Path, tmpPath, start, dur);
    tmpFiles.push({ path: tmpPath, offset: start });
  }
  const PAR = 2;
  const results = new Array(tmpFiles.length).fill([]);
  let nextIdx = 0;
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tmpFiles.length) return;
      const f = tmpFiles[idx];
      try {
        const w = await geminiAsr.transcribeWithTimestamps(f.path);
        results[idx] = w.map(ww => ({
          text: ww.text,
          start: (Number(ww.start) || 0) + f.offset,
          end: (Number(ww.end) || 0) + f.offset,
        }));
      } catch (e) {
        console.warn(`  ⚠️ Gemini ASR chunk#${idx + 1}/${tmpFiles.length} 失敗 (offset=${f.offset}s): ${e.message.slice(0, 100)}`);
      }
    }
  }));
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f.path); } catch (_) {}
  }
  const merged = results.flat().filter(w => w && typeof w.start === 'number').sort((a, b) => a.start - b.start);
  console.log(`  🔪 Gemini ASR 分割完了: ${merged.length} words 取得`);
  return merged;
}

function probeDurationSec(filePath) {
  try {
    const out = execSync(`${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${filePath}"`).toString().trim();
    return parseFloat(out) || 0;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  generateAndSplit,
  // 内部関数は test 用に export
  _computeBoundaries: computeBoundaries,
  _computeBoundariesByTail: computeBoundariesByTail,
  _normalizeForCount: normalizeForCount,
  _splitLongTextForTTS,
  _ffmpegConcatMp3s: ffmpegConcatMp3s,
  _probeDurationSec: probeDurationSec,
};
