// launcher/narration.js
// ナレーション文生成 + TTS音声合成
// AI → テキスト生成 → VOICEVOX(ローカル) or Gemini TTS

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');
const { getPattern } = require('./slide_patterns');

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
      model: 'deepseek-chat', temperature: 0.4, max_tokens: 3000,
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
      model: 'gpt-4o-mini', temperature: 0.4, max_tokens: 3000,
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

  // mods に既に narration が入っていればそのまま使う
  const prebuilt = mods.map(m => m.narration || null);
  const allPrebuilt = prebuilt.every(n => n && n.length > 0);
  if (allPrebuilt) {
    console.log('  → Using prebuilt narrations from mods');
    return prebuilt;
  }

  // 必要なスライドだけ AI に送る（重複生成を避ける）
  const needGenIdx = prebuilt.map((n, i) => (!n ? i : -1)).filter(i => i >= 0);
  console.log(`  → Generating narrations for slides: ${needGenIdx.join(', ')}`);

  const slideDescriptions = needGenIdx.map(i => {
    const slot = pattern.slides[i];
    const mod = { ...mods[i] };
    // bgImage 等の大きなフィールドは除く
    delete mod.bgImage; delete mod.leftImage; delete mod.rightImage;
    return `slides[${i}] type="${slot.type}": ${JSON.stringify(mod)}`;
  }).join('\n\n');

  const sys = `あなたはサッカーYouTube動画のナレーター台本を書くAIです。
指定されたスライドに対して、自然で聞き取りやすいナレーション文を生成してください。

ルール:
- 各スライド10〜25秒で読める長さ（50〜120文字）
- openingは短め（3〜5秒、20〜40文字）: 挨拶+タイトルコール
- endingは定型（3〜5秒）: 「チャンネル登録よろしくお願いします」系
- 口語体・YouTubeの語り口調
- 数値やデータはスライドに表示されるのでナレーションでは要点だけ

JSON形式（生成対象スライドのインデックスをキーにする）:
{"narrations": {"0": "slide0のナレーション", "2": "slide2のナレーション", ...}}`;

  const result = await callAI(sys, `パターン: ${patternKey} (${pattern.label})\n\n${slideDescriptions}`);

  const generated = result.narrations || {};
  const final = prebuilt.map((n, i) => n || generated[String(i)] || '');
  return final;
}

// ── VOICEVOX TTS ──────────────────────────────────────

async function voicevoxTTS(text, outputPath, speaker = 3) {
  // VOICEVOX Engine はローカル http://localhost:50021 で起動している前提
  const base = 'http://localhost:50021';

  // Step 1: audio_query
  const qRes = await fetch(`${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, {
    method: 'POST',
  });
  if (!qRes.ok) throw new Error(`VOICEVOX audio_query ${qRes.status}`);
  const query = await qRes.json();

  // 速度調整
  query.speedScale = 1.15;
  query.pitchScale = 0.0;
  query.volumeScale = 1.0;

  // Step 2: synthesis
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

  // Gemini returns raw PCM, need to wrap as WAV or convert via ffmpeg
  const rawPath = outputPath.replace(/\.\w+$/, '.raw');
  fs.writeFileSync(rawPath, Buffer.from(audioB64, 'base64'));

  // Convert to WAV via ffmpeg
  const { execSync } = require('child_process');
  execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPath}" "${outputPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(rawPath);

  return outputPath;
}

// ── メインAPI ─────────────────────────────────────────

async function generateNarration(patternKey, mods, outputDir) {
  console.log('\n=== Narration: Generating audio ===\n');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Step 1: ナレーション文生成
  console.log('  Step 1: Generating narration texts...');
  const narrations = await generateNarrationTexts(patternKey, mods);
  console.log(`  → ${narrations.length} narrations generated`);
  narrations.forEach((n, i) => console.log(`    [${i}] ${n.slice(0, 50)}...`));

  // Step 2: TTS
  console.log('\n  Step 2: Synthesizing audio...');
  const audioFiles = [];

  for (let i = 0; i < narrations.length; i++) {
    const text = narrations[i];
    const outPath = path.join(outputDir, `narration_${i}.wav`);

    try {
      await voicevoxTTS(text, outPath);
      console.log(`    [${i}] VOICEVOX → ${outPath}`);
    } catch (err) {
      console.warn(`    [${i}] VOICEVOX failed (${err.message}), trying Gemini...`);
      try {
        await geminiTTS(text, outPath);
        console.log(`    [${i}] Gemini → ${outPath}`);
      } catch (err2) {
        console.error(`    [${i}] All TTS failed: ${err2.message}`);
        audioFiles.push(null);
        continue;
      }
    }

    audioFiles.push(outPath);
  }

  // 各音声の長さを取得
  const durations = [];
  const { execSync } = require('child_process');
  for (const f of audioFiles) {
    if (!f) { durations.push(10); continue; }
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`,
        { encoding: 'utf8' }
      ).trim();
      durations.push(parseFloat(probe) || 10);
    } catch {
      durations.push(10);
    }
  }

  console.log(`\n  Durations: ${durations.map(d => d.toFixed(1) + 's').join(', ')}`);

  return { narrations, audioFiles, durations };
}

module.exports = { generateNarration, generateNarrationTexts, voicevoxTTS, geminiTTS };
