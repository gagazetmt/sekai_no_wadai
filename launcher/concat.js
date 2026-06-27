// launcher/concat.js
// スライド動画 + 音声 → 最終動画に結合

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const BGM_PATH = path.join(__dirname, 'assets', 'bgm.mp3');

// ── スライド動画に音声をミックス ──────────────────────

function muxAudio(videoPath, audioPath, outputPath) {
  // apad: 音声が映像より短い場合に無音パディング。-shortest: 映像長に合わせて切る
  execSync(`ffmpeg -y -i "${videoPath}" -i "${audioPath}" \
    -c:v copy -c:a aac -b:a 128k \
    -map 0:v:0 -map 1:a:0 \
    -af apad -shortest \
    "${outputPath}"`, { stdio: 'pipe' });
  return outputPath;
}

// ── 全スライドを結合 ──────────────────────────────────

function concatVideos(videoPaths, outputPath) {
  const listPath = outputPath.replace(/\.\w+$/, '_list.txt');
  const listContent = videoPaths
    .filter(p => p && fs.existsSync(p))
    .map(p => `file '${p.replace(/\\/g, '/')}'`)
    .join('\n');

  fs.writeFileSync(listPath, listContent);

  execSync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" \
    -c:v copy -c:a copy \
    -avoid_negative_ts make_zero \
    -movflags +faststart \
    "${outputPath}"`, { stdio: 'pipe' });

  // cleanup
  fs.unlinkSync(listPath);

  const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
  console.log(`  Final: ${outputPath} (${size}MB)`);
  return outputPath;
}

// ── メインAPI ─────────────────────────────────────────

function buildFinalVideo(videoFiles, audioFiles, outputDir, finalName = 'final.mp4') {
  console.log('\n=== Concat: Building final video ===\n');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const muxedFiles = [];

  for (let i = 0; i < videoFiles.length; i++) {
    const video = videoFiles[i];
    const audio = audioFiles?.[i];

    if (!video || !fs.existsSync(video)) {
      console.warn(`  [${i}] video missing, skipping`);
      continue;
    }

    if (audio && fs.existsSync(audio)) {
      // 音声ありスライド: mux
      const muxed = path.join(outputDir, `muxed_${i}.mp4`);
      try {
        muxAudio(video, audio, muxed);
        muxedFiles.push(muxed);
        console.log(`  [${i}] muxed: video + audio`);
      } catch (err) {
        console.warn(`  [${i}] mux failed (${err.message}), using video only`);
        muxedFiles.push(video);
      }
    } else {
      // 音声なし: 無音で映像のみ
      const silent = path.join(outputDir, `silent_${i}.mp4`);
      try {
        execSync(`ffmpeg -y -i "${video}" \
          -f lavfi -i anullsrc=r=44100:cl=stereo \
          -c:v copy -c:a aac -shortest \
          "${silent}"`, { stdio: 'pipe' });
        muxedFiles.push(silent);
        console.log(`  [${i}] silent video`);
      } catch {
        muxedFiles.push(video);
      }
    }
  }

  if (!muxedFiles.length) {
    throw new Error('No valid video files to concat');
  }

  const rawPath = path.join(outputDir, '_raw_' + finalName);
  concatVideos(muxedFiles, rawPath);

  // muxed/silent 中間ファイルを削除
  for (const f of muxedFiles) {
    if (f.includes('muxed_') || f.includes('silent_')) {
      try { fs.unlinkSync(f); } catch {}
    }
  }

  // BGM ミックス
  const finalPath = path.join(outputDir, finalName);
  if (fs.existsSync(BGM_PATH)) {
    try {
      execSync(`ffmpeg -y -i "${rawPath}" -stream_loop -1 -i "${BGM_PATH}" \
        -filter_complex "[1:a]volume=0.18[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]" \
        -map 0:v -map "[a]" \
        -c:v copy -c:a aac -b:a 128k \
        -movflags +faststart \
        "${finalPath}"`, { stdio: 'pipe' });
      fs.unlinkSync(rawPath);
      const size = (fs.statSync(finalPath).size / (1024 * 1024)).toFixed(1);
      console.log(`  BGM mixed: ${finalPath} (${size}MB)`);
    } catch (err) {
      console.warn(`  BGM mix failed: ${err.message} — using raw`);
      fs.renameSync(rawPath, finalPath);
    }
  } else {
    fs.renameSync(rawPath, finalPath);
  }

  return finalPath;
}

module.exports = { buildFinalVideo, muxAudio, concatVideos };
