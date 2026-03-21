// test_heatmap.js
// YouTubeハイライト動画のチャプターからゴール・レッドカード瞬間をキャプチャ
//
// 使い方: node test_heatmap.js "Chelsea Arsenal"

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const { execSync } = require("child_process");

const FFMPEG  = "C:\\ffmpeg\\bin\\ffmpeg.exe";
const YTDLP   = path.join(__dirname, "..", "_tools", "yt-dlp.exe");
const OUT_DIR = path.join(__dirname, "..", "images");

// ── yt-dlp.exe を自動ダウンロード ────────────────────────────────────────────
async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) return;
  console.log("[yt-dlp] ダウンロード中...");
  fs.mkdirSync(path.dirname(YTDLP), { recursive: true });
  const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  await new Promise((resolve, reject) => {
    function download(u) {
      https.get(u, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return download(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(YTDLP);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      }).on("error", reject);
    }
    download(url);
  });
  console.log("[yt-dlp] ダウンロード完了！");
}

// ── YouTube検索（Innertube API） ──────────────────────────────────────────────
async function searchYouTube(query) {
  const body = JSON.stringify({
    query,
    context: { client: { clientName: "WEB", clientVersion: "2.20240101" } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.youtube.com",
      path: "/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Mozilla/5.0",
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractVideoIds(searchData) {
  const ids = [];
  const contents = searchData?.contents?.twoColumnSearchResultsRenderer
    ?.primaryContents?.sectionListRenderer?.contents || [];
  for (const section of contents) {
    for (const item of section?.itemSectionRenderer?.contents || []) {
      const id = item?.videoRenderer?.videoId;
      if (id) ids.push({ id, title: item.videoRenderer?.title?.runs?.[0]?.text || "" });
    }
  }
  return ids;
}

// ── yt-dlpでチャプター取得 ────────────────────────────────────────────────────
function getChaptersFromYtDlp(videoId) {
  try {
    const raw = execSync(
      `"${YTDLP}" --dump-json "https://www.youtube.com/watch?v=${videoId}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const json = JSON.parse(raw.trim());
    return json.chapters || null;
  } catch {
    return null;
  }
}

// GOALとRED CARDのチャプターを抽出
function extractKeyChapters(chapters) {
  return chapters.filter(c => {
    const t = c.title.toUpperCase();
    return t.includes("GOAL") || t.includes("RED CARD");
  });
}

// ── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  const searchQuery = (process.argv[2] || "Chelsea") + " highlights";
  console.log(`\n=== YouTubeハイライト ゴール瞬間キャプチャ ===`);
  console.log(`検索: "${searchQuery}"\n`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  await ensureYtDlp();

  // YouTube検索
  console.log("① YouTube検索中...");
  const searchData = await searchYouTube(searchQuery);
  const videos = extractVideoIds(searchData);
  console.log(`   ${videos.length}件ヒット`);
  if (!videos.length) { console.error("動画が見つかりませんでした"); process.exit(1); }

  // チャプター取得（上位5件を試す）
  let keyChapters = [];
  let targetVideo = null;

  for (const video of videos.slice(0, 5)) {
    console.log(`\n② チャプター取得: ${video.title.slice(0, 60)}`);
    const chapters = getChaptersFromYtDlp(video.id);
    if (!chapters) { console.log("   チャプターなし（スキップ）"); continue; }

    keyChapters = extractKeyChapters(chapters);
    if (keyChapters.length > 0) {
      console.log(`   ✅ キーチャプター ${keyChapters.length}件:`);
      keyChapters.forEach(c => console.log(`      ${c.start_time}秒: ${c.title}`));
      targetVideo = video;
      break;
    } else {
      console.log(`   チャプターあり(${chapters.length}件)だがGOAL/RED CARDなし（スキップ）`);
    }
  }

  if (!targetVideo) {
    console.error("\nGOAL/RED CARDチャプターが見つかりませんでした");
    process.exit(1);
  }

  const ytUrl = `https://www.youtube.com/watch?v=${targetVideo.id}`;

  // ファーストゴール・ラストゴール・レッドカードに絞る
  const goals    = keyChapters.filter(c => c.title.toUpperCase().includes("GOAL"));
  const redCards = keyChapters.filter(c => c.title.toUpperCase().includes("RED CARD"));
  const targets  = [
    goals[0]                                    && { chapter: goals[0],                tag: "goal_first" },
    goals.length > 1 && goals[goals.length - 1] && { chapter: goals[goals.length - 1], tag: "goal_last" },
    redCards[0]                                 && { chapter: redCards[0],             tag: "redcard" },
  ].filter(Boolean);

  console.log(`\n   対象: ${targets.map(t => t.tag).join(", ")}`);

  const OFFSETS  = [10, 15, 20, 25, 30];
  const CLIP_SEC = OFFSETS[OFFSETS.length - 1] + 3; // 33秒
  const savedPaths = [];

  console.log(`\n③④ イベントごとにDL＆キャプチャ（各${CLIP_SEC}秒・${targets.length}回）...`);

  for (const { chapter, tag } of targets) {
    const dlStart = Math.max(0, chapter.start_time - 2);
    const dlEnd   = chapter.start_time + CLIP_SEC;
    const tmpMp4  = path.join(OUT_DIR, `_tmp_${tag}_${targetVideo.id}.mp4`);

    console.log(`\n   [${tag}] ${chapter.title}`);
    console.log(`   DL: ${dlStart}〜${dlEnd}秒`);

    try {
      execSync(
        `"${YTDLP}" -f "bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]/bestvideo" --download-sections "*${dlStart}-${dlEnd}" --force-keyframes-at-cuts -o "${tmpMp4}" "${ytUrl}"`,
        { stdio: "pipe" }
      );

      for (let j = 0; j < OFFSETS.length; j++) {
        const ss  = OFFSETS[j] + 2;
        const out = path.join(OUT_DIR, `${tag}_${targetVideo.id}_${j + 1}.jpg`);
        execSync(
          `"${FFMPEG}" -y -i "${tmpMp4}" -ss ${ss} -vframes 1 -q:v 2 "${out}"`,
          { stdio: "pipe" }
        );
        const kb = Math.round(fs.statSync(out).size / 1024);
        console.log(`   ✅ +${OFFSETS[j]}秒 → ${path.basename(out)} (${kb}KB)`);
        savedPaths.push(out);
      }
    } finally {
      for (const ext of ["", ".webm", ".part", ".mp4.webm"]) {
        const f = tmpMp4 + ext;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  }

  console.log(`\n完了！`);
  console.log(`   動画: ${targetVideo.title}`);
  console.log(`   保存: ${savedPaths.length}枚`);
}

main().catch(e => { console.error(`エラー: ${e.message}`); process.exit(1); });
