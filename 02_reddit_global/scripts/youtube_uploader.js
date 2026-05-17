// scripts/youtube_uploader.js
// YouTube Data API v3 投稿モジュール
//   - V1 (soccer_yt_server.js) の実装をモジュール化したもの
//   - .youtube_tokens.json と .env (YOUTUBE_CLIENT_ID/SECRET/REDIRECT_URI) を共有
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ROOT = path.join(__dirname, '..');
const TOKEN_PATH = path.join(ROOT, '.youtube_tokens.json');

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3004/api/v5/youtube-callback'
);

let initialized = false;
function init() {
  if (initialized) return;
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
    } catch (e) {
      console.warn('[YouTube] token 読込失敗:', e.message);
    }
  }
  oauth2Client.on('tokens', tokens => {
    let merged = tokens;
    if (fs.existsSync(TOKEN_PATH)) {
      try {
        merged = { ...JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')), ...tokens };
      } catch (_) {}
    }
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });
  initialized = true;
}

function getAuthUrl() {
  init();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
    ],
    prompt: 'consent',
  });
}

async function handleCallback(code) {
  init();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  return tokens;
}

function isAuthenticated() {
  init();
  return fs.existsSync(TOKEN_PATH) && !!oauth2Client.credentials.access_token;
}

// 2026-05-17: refresh token 失効 (invalid_grant) を検出したら token ファイルを退避し、
//   isAuthenticated() が false を返すようにする → UI で再認証ボタン表示
function _invalidateTokenOnAuthError(err) {
  const msg = String(err?.message || err);
  if (msg.includes('invalid_grant') || msg.includes('invalid_token')) {
    try {
      if (fs.existsSync(TOKEN_PATH)) {
        const deadPath = TOKEN_PATH + '.dead_' + Date.now();
        fs.renameSync(TOKEN_PATH, deadPath);
        console.warn('[YouTube] token 失効検出 → 退避:', path.basename(deadPath));
      }
      oauth2Client.setCredentials({});
    } catch (_) {}
  }
}

async function upload({ videoPath, thumbPath, title, description, tags, privacyStatus = 'public', categoryId = '17' }) {
  init();
  if (!isAuthenticated()) throw new Error('YouTube未認証');
  if (!fs.existsSync(videoPath)) throw new Error('動画ファイル無し: ' + videoPath);

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const tagArr = Array.isArray(tags) ? tags : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);

  const fileSize = fs.statSync(videoPath).size;
  console.log(`[YouTube] アップロード開始: ${path.basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

  let response;
  try {
    response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: title || '（タイトルなし）',
          description: description || '',
          tags: tagArr,
          categoryId,
          defaultLanguage: 'ja',
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: fs.createReadStream(videoPath) },
    });
  } catch (e) {
    _invalidateTokenOnAuthError(e);
    if (String(e?.message || '').includes('invalid_grant')) {
      throw new Error('YouTube認証期限切れ → 再認証してください (token退避済)');
    }
    throw e;
  }

  const videoId = response.data.id;
  console.log(`[YouTube] 動画完了: https://youtu.be/${videoId}`);

  /* サムネ設定（2026-05-18 #6 修正）: ログ可視化 + 2MB 超 sharp 圧縮 + thumbReason 返却
     これまで「ファイル無 / API失敗」を warn で握りつぶしてたため、相棒側で原因が見えなかった。
     thumbReason を返して step6 UI で明示できるようにする。 */
  let thumbSet = false;
  let thumbReason = null;
  if (!thumbPath) {
    thumbReason = 'noPath';
    console.log('[YouTube] thumbnail: 指定無し（自動生成サムネのまま）');
  } else if (!fs.existsSync(thumbPath)) {
    thumbReason = 'notFound';
    console.error('[YouTube] サムネファイル無: ' + thumbPath);
  } else {
    try {
      const origSize = fs.statSync(thumbPath).size;
      const origMB = origSize / 1024 / 1024;
      console.log(`[YouTube] thumbnail: path=${thumbPath} size=${origMB.toFixed(2)}MB`);

      // YouTube サムネ制限: 2MB。 1.9MB 超なら sharp で jpeg 圧縮（quality 段階下げ）
      let uploadPath = thumbPath;
      let tempPath = null;
      if (origMB > 1.9) {
        const sharp = require('sharp');
        tempPath = thumbPath.replace(/(\.[^.]+)$/, '_yt.jpg');
        let quality = 90, outBuf = null;
        while (quality >= 50) {
          outBuf = await sharp(thumbPath).jpeg({ quality }).toBuffer();
          if (outBuf.length < 1.9 * 1024 * 1024) break;
          quality -= 10;
        }
        fs.writeFileSync(tempPath, outBuf);
        uploadPath = tempPath;
        console.log(`[YouTube] サムネ圧縮: ${origMB.toFixed(2)}MB → ${(outBuf.length/1024/1024).toFixed(2)}MB (quality=${quality})`);
      }

      const ext = path.extname(uploadPath).slice(1).toLowerCase();
      const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
      await youtube.thumbnails.set({
        videoId,
        media: { mimeType, body: fs.createReadStream(uploadPath) },
      });
      thumbSet = true;
      console.log('[YouTube] サムネイル設定完了');

      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
    } catch (tErr) {
      thumbReason = 'apiError';
      console.error('[YouTube] サムネ設定失敗（動画は投稿済み）:', tErr.message);
      if (tErr.errors) console.error('  詳細:', JSON.stringify(tErr.errors));
      if (tErr.code)   console.error('  code:', tErr.code);
    }
  }

  return { videoId, url: `https://youtu.be/${videoId}`, thumbSet, thumbReason };
}

module.exports = { getAuthUrl, handleCallback, isAuthenticated, upload };
