// launcher/narration.js
// ナレーション文生成 + TTS音声合成

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getPattern } = require('./slide_patterns');

// ── VoiceVox スピーカーID ─────────────────────────────
// 青山流星(13), 玄野武宏(11), 白上虎太郎(12): 男性
// 春日部つむぎ(8): 女性
const MAIN_SPEAKER = 13; // 青山流星 – メインナレーション（VoiceVox用）

const COMMENT_SPEAKER_PATTERN = [11, 12, 13, 11, 8, 12, 13, 11, 8];

function getCommentSpeaker(index) {
  return COMMENT_SPEAKER_PATTERN[index % COMMENT_SPEAKER_PATTERN.length];
}

// ── MiniMax TTS ボイスID ──────────────────────────────
// メイン: Japanese_deep_voiced_storyteller_vv1
// コメント男性(4): GenerousIzakayaOwner / DependableWoman / refined_storyteller / LoyalKnight
// コメント女性(1): energetic_anime_girl
const MINIMAX_MAIN_VOICE = 'Japanese_deep_voiced_storyteller_vv1';
const MINIMAX_CMT_VOICES = [
  'Japanese_GenerousIzakayaOwner',         // 男1（元メイン）
  'Japanese_DependableWoman',              // 男2
  'Japanese_refined_storyteller_vv1',      // 男3
  'Japanese_LoyalKnight',                  // 男4
  'Japanese_energetic_anime_girl_vv1',     // 女
];

// ボイス別音量補正（各ボイスの基本音量差を吸収する）
// 実測して調整する。1.0 = API デフォルト、上げたければ 1.2〜1.5 など
const MINIMAX_VOICE_VOL = {
  'Japanese_GenerousIzakayaOwner':        1.0,
  'Japanese_deep_voiced_storyteller_vv1': 1.8,
  'Japanese_DependableWoman':             1.0,
  'Japanese_refined_storyteller_vv1':     1.6,
  'Japanese_LoyalKnight':                 1.0,
  'Japanese_energetic_anime_girl_vv1':    1.4,
};

function getMinimaxCmtVoice(index) {
  return MINIMAX_CMT_VOICES[index % MINIMAX_CMT_VOICES.length];
}

function getMinimaxVol(voiceId) {
  return MINIMAX_VOICE_VOL[voiceId] ?? 1.0;
}

// ── AI呼び出し（ナレーション文生成） ──────────────────

async function callAI(systemPrompt, userPrompt) {
  const providers = [
    { name: 'deepseek', fn: () => callDeepSeek(systemPrompt, userPrompt) },
    { name: 'openai',   fn: () => callOpenAI(systemPrompt, userPrompt) },
  ];
  for (const { name, fn } of providers) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (err) {
      console.warn(`  [narration] ${name} failed: ${err.message}`);
    }
  }
  throw new Error('All AI providers failed');
}

const NARRATION_TIMEOUT = 50000;

async function callDeepSeek(sys, usr) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-chat', temperature: 0.7, max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    }),
    signal: AbortSignal.timeout(NARRATION_TIMEOUT),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const d = await res.json();
  return JSON.parse(d.choices[0].message.content);
}

async function callOpenAI(sys, usr) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    }),
    signal: AbortSignal.timeout(NARRATION_TIMEOUT),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const d = await res.json();
  return JSON.parse(d.choices[0].message.content);
}

// ── ナレーション文生成 ────────────────────────────────

async function generateNarrationTexts(patternKey, mods) {
  const pattern = getPattern(patternKey);

  // opening は title をそのまま使う（AI生成不要）
  const prebuilt = mods.map((m, i) => {
    const slotType = (pattern.slides[i] || {}).type || m.type;
    if (slotType === 'opening') return m.title || m.narration || '';
    return m.narration || null;
  });

  const allPrebuilt = prebuilt.every(n => n && n.length > 0);
  if (allPrebuilt) {
    console.log('  → Using prebuilt narrations from mods');
    return prebuilt;
  }

  const needGenIdx = prebuilt.map((n, i) => (!n ? i : -1)).filter(i => i >= 0);
  console.log(`  → Generating narrations for slides: ${needGenIdx.join(', ')}`);

  const slideDescriptions = needGenIdx.map(i => {
    const slot = pattern.slides[i];
    const mod = { ...mods[i] };
    delete mod.bgImage; delete mod.leftImage; delete mod.rightImage;
    return `slides[${i}] type="${slot.type}": ${JSON.stringify(mod)}`;
  }).join('\n\n');

  const sys = `あなたはサッカーYouTube動画の台本ライター。5ちゃんねるの実況スレみたいなノリで書く。

ルール:
- 全体テンポよく、短文で畳みかけるスタイル
- 口語体。「〜だよな」「〜じゃん」「〜でしょ」「マジで」「えぐい」「草」「ガチで？」等OK
- 各スライド10〜25秒で読める長さ（60〜130文字）
- コンテンツスライドは「実はこれがやばくて〜」「で、ここがポイントなんだけど〜」みたいな引き込み方
- ending は話題に即したオチの一言（30文字以内）。「やっぱ〇〇はやべぇわ」「これはエモすぎる」みたいな締め。チャンネル登録促しは不要
- 数値やデータはスライドに出るのでナレーションでは要点だけ

JSON形式（生成対象スライドのインデックスをキーにする）:
{"narrations": {"0": "slide0のナレーション", "2": "slide2のナレーション", ...}}`;

  const result = await callAI(sys, `パターン: ${patternKey}\n\n${slideDescriptions}`);

  const generated = result.narrations || {};
  const final = prebuilt.map((n, i) => n || generated[String(i)] || '');
  return final;
}

// ── VOICEVOX TTS ──────────────────────────────────────

async function voicevoxTTS(text, outputPath, speaker = MAIN_SPEAKER) {
  const base = 'http://localhost:50021';

  const qRes = await fetch(`${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, {
    method: 'POST',
  });
  if (!qRes.ok) throw new Error(`VOICEVOX audio_query ${qRes.status}`);
  const query = await qRes.json();

  query.speedScale = 1.15;
  query.pitchScale = 0.0;
  query.volumeScale = 1.0;

  const sRes = await fetch(`${base}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!sRes.ok) throw new Error(`VOICEVOX synthesis ${sRes.status}`);

  const buffer = Buffer.from(await sRes.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

// ── MiniMax TTS ──────────────────────────────────────

const { sanitizeForTts } = require('./tts_preprocess');

async function minimaxTTS(text, outputPath, voiceId = MINIMAX_MAIN_VOICE) {
  const key     = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!key || !groupId) throw new Error('No MINIMAX_API_KEY or MINIMAX_GROUP_ID');

  if (!text) throw new Error('text is empty');

  const res = await fetch(`https://api.minimax.io/v1/t2a_v2?GroupId=${groupId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'speech-01-hd',
      text,
      stream: false,
      language_boost: 'Japanese',
      voice_setting: {
        voice_id: voiceId,
        speed: 1.18,
        vol: getMinimaxVol(voiceId),
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MiniMax TTS ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  if (data.base_resp?.status_code !== 0) {
    throw new Error(`MiniMax TTS error: ${data.base_resp?.status_msg}`);
  }

  // audio_file は hex エンコードされた mp3
  const audioHex = data.data?.audio || data.audio_file;
  if (!audioHex) throw new Error('MiniMax TTS: no audio in response');

  const mp3Path = outputPath.replace(/\.wav$/, '.mp3');
  fs.writeFileSync(mp3Path, Buffer.from(audioHex, 'hex'));

  // mp3 → wav に変換（後続の ffmpeg concat が wav 前提のため）
  execSync(`ffmpeg -y -i "${mp3Path}" "${outputPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(mp3Path);

  return outputPath;
}

// ── Gemini TTS（フォールバック） ──────────────────────

async function geminiTTS(text, outputPath) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('No GEMINI_API_KEY');

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini TTS ${res.status}`);
  const data = await res.json();
  const audioB64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!audioB64) throw new Error('Gemini TTS: no audio data');

  const rawPath = outputPath.replace(/\.\w+$/, '.raw');
  fs.writeFileSync(rawPath, Buffer.from(audioB64, 'base64'));
  execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPath}" "${outputPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(rawPath);

  return outputPath;
}

// ── TTS ディスパッチ（VoiceVox → MiniMax → Gemini） ──

async function synthesize(text, outPath, speaker = MAIN_SPEAKER, minimaxVoice = MINIMAX_MAIN_VOICE) {
  // 1. MiniMax（メイン）
  try {
    await minimaxTTS(text, outPath, minimaxVoice);
    console.log(`    → MiniMax (${minimaxVoice})`);
    return outPath;
  } catch (err) {
    console.warn(`    MiniMax failed (${err.message}), trying VoiceVox...`);
  }

  // 2. VoiceVox（MiniMax が落ちているときのフォールバック）
  try {
    await voicevoxTTS(text, outPath, speaker);
    console.log(`    → VoiceVox (speaker=${speaker})`);
    return outPath;
  } catch (err) {
    console.warn(`    VoiceVox failed (${err.message}), trying Gemini...`);
  }

  // 3. Gemini（最終フォールバック）
  await geminiTTS(text, outPath);
  console.log(`    → Gemini TTS`);
  return outPath;
}

// ── 同時実行数制限ヘルパー ────────────────────────────

function makeSemaphore(n) {
  let active = 0;
  const queue = [];
  return fn => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve(fn()).then(resolve, reject).finally(() => {
        active--;
        if (queue.length) queue.shift()();
      });
    };
    active < n ? run() : queue.push(run);
  });
}

// ── コメント音声生成 ──────────────────────────────────

async function generateCommentAudio(comments, outputDir, slideIndex) {
  if (!comments || !comments.length) return { audioFile: null, duration: 0 };

  const validComments = comments.slice(0, 8).filter(c => c.text && c.text.length > 0);
  if (!validComments.length) return { audioFile: null, duration: 0 };

  // コメント TTS を並列実行（同時最大4）
  const limit = makeSemaphore(4);
  const rawResults = await Promise.all(validComments.map((c, i) => limit(async () => {
    const outPath = path.join(outputDir, `cmt_${slideIndex}_${i}.wav`);
    try {
      await synthesize(c.text, outPath, getCommentSpeaker(i), getMinimaxCmtVoice(i));
      let dur = 1.5;
      try {
        const probe = execSync(
          `ffprobe -v error -show_entries format=duration -of csv=p=0 "${outPath}"`,
          { encoding: 'utf8' }
        ).trim();
        dur = parseFloat(probe) || 1.5;
      } catch {}
      return { index: i, path: outPath, durationSec: dur, ok: true };
    } catch (err) {
      console.warn(`    [comment TTS] slide${slideIndex}[${i}] failed: ${err.message}`);
      return { index: i, ok: false };
    }
  })));

  const succeeded = rawResults.filter(r => r.ok);
  if (!succeeded.length) return { audioFile: null, duration: 0, perComment: [] };

  const parts = succeeded.map(r => r.path);
  const perComment = succeeded.map(r => ({ index: r.index, durationSec: r.durationSec }));

  if (!parts.length) return { audioFile: null, duration: 0, perComment: [] };

  // 0.3秒無音パッドを生成
  const padPath = path.join(outputDir, `_cmt_pad_${slideIndex}.wav`);
  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t 0.3 "${padPath}"`, { stdio: 'pipe' });

  // concat リスト作成
  const listPath = path.join(outputDir, `_cmt_list_${slideIndex}.txt`);
  const entries = [];
  for (const p of parts) {
    entries.push(`file '${p.replace(/\\/g, '/')}'`);
    entries.push(`file '${padPath.replace(/\\/g, '/')}'`);
  }
  fs.writeFileSync(listPath, entries.join('\n'));

  const combinedPath = path.join(outputDir, `cmt_combined_${slideIndex}.wav`);
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" "${combinedPath}"`, { stdio: 'pipe' });

  const probe = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${combinedPath}"`,
    { encoding: 'utf8' }
  ).trim();
  const duration = parseFloat(probe) || 0;

  console.log(`    [comment TTS] slide${slideIndex}: ${parts.length}コメント / ${duration.toFixed(1)}s`);
  return { audioFile: combinedPath, duration, perComment };
}

// ── メインAPI ─────────────────────────────────────────

async function generateNarration(patternKey, mods, outputDir) {
  console.log('\n=== Narration: Generating audio ===\n');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const pattern = getPattern(patternKey);

  // Step 1: ナレーション文生成
  console.log('  Step 1: Generating narration texts...');
  const narrations = await generateNarrationTexts(patternKey, mods);
  console.log(`  → ${narrations.length} narrations generated`);
  narrations.forEach((n, i) => console.log(`    [${i}] ${(n || '').slice(0, 50)}...`));

  // narration テキストを mod に保存（メタ生成等で参照）
  narrations.forEach((n, i) => { if (mods[i]) mods[i].narration = n; });

  // Step 2: TTS（全スライド並列、同時最大4）
  console.log('\n  Step 2: Synthesizing audio (parallel)...');
  const slideLimit = makeSemaphore(4);

  const slideResults = await Promise.all(narrations.map((text, i) => slideLimit(async () => {
    const slotType = (pattern.slides[i] || {}).type || mods[i]?.type || 'insight';
    const isBookend = slotType === 'opening' || slotType === 'ending';
    const narPath = path.join(outputDir, `narration_${i}.wav`);

    // ナレーション TTS
    try {
      if (!text) throw new Error('empty text');
      await synthesize(text, narPath, MAIN_SPEAKER);
      console.log(`    [${i}] narration → ${path.basename(narPath)}`);
    } catch (err) {
      console.error(`    [${i}] narration TTS failed: ${err.message}`);
      return { i, audioFile: null, narDur: 10, cmtDur: 0 };
    }

    // 尺を計測
    let narDur = 10;
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${narPath}"`,
        { encoding: 'utf8' }
      ).trim();
      narDur = parseFloat(probe) || 10;
    } catch {}

    // コメント TTS（bookend 以外）
    let combinedAudioPath = narPath;
    let cmtDur = 0;

    if (!isBookend && mods[i]?.comments?.length) {
      const cmtResult = await generateCommentAudio(mods[i].comments, outputDir, i);
      cmtDur = cmtResult.duration;

      mods[i].commentTiming = {
        narrationDurSec: narDur,
        narToCmtPauseSec: 0.2,
        cmtGapSec: 0.3,
        perComment: (cmtResult.perComment || []).map(pc => ({ index: pc.index, durationSec: pc.durationSec })),
      };

      if (cmtResult.audioFile) {
        const pausePath = path.join(outputDir, `_nar_pad_${i}.wav`);
        execSync(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t 0.2 "${pausePath}"`, { stdio: 'pipe' });

        const mergeList = path.join(outputDir, `_merge_list_${i}.txt`);
        fs.writeFileSync(mergeList, [
          `file '${narPath.replace(/\\/g, '/')}'`,
          `file '${pausePath.replace(/\\/g, '/')}'`,
          `file '${cmtResult.audioFile.replace(/\\/g, '/')}'`,
        ].join('\n'));

        const mergedPath = path.join(outputDir, `audio_${i}.wav`);
        execSync(`ffmpeg -y -f concat -safe 0 -i "${mergeList}" "${mergedPath}"`, { stdio: 'pipe' });
        combinedAudioPath = mergedPath;
        console.log(`    [${i}] combined (nar ${narDur.toFixed(1)}s + cmt ${cmtDur.toFixed(1)}s)`);
      }
    }

    return { i, audioFile: combinedAudioPath, narDur, cmtDur };
  })));

  // インデックス順に整列
  slideResults.sort((a, b) => a.i - b.i);
  const audioFiles        = slideResults.map(r => r.audioFile);
  const narrationDurations = slideResults.map(r => r.narDur);
  const commentDurations  = slideResults.map(r => r.cmtDur);

  const durations = narrationDurations;
  console.log(`\n  Narration durations: ${durations.map(d => d.toFixed(1) + 's').join(', ')}`);
  console.log(`  Comment durations:   ${commentDurations.map(d => d.toFixed(1) + 's').join(', ')}`);

  return { narrations, audioFiles, durations, commentDurations };
}

module.exports = { generateNarration, generateNarrationTexts, voicevoxTTS, geminiTTS };
