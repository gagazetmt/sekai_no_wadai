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

async function upload({ videoPath, thumbPath, title, description, tags, privacyStatus = 'public', categoryId = '17' }) {
  init();
  if (!isAuthenticated()) throw new Error('YouTube未認証');
  if (!fs.existsSync(videoPath)) throw new Error('動画ファイル無し: ' + videoPath);

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const tagArr = Array.isArray(tags) ? tags : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);

  const fileSize = fs.statSync(videoPath).size;
  console.log(`[YouTube] アップロード開始: ${path.basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

  const response = await youtube.videos.insert({
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

  const videoId = response.data.id;
  console.log(`[YouTube] 動画完了: https://youtu.be/${videoId}`);

  let thumbSet = false;
  if (thumbPath && fs.existsSync(thumbPath)) {
    try {
      const ext = path.extname(thumbPath).slice(1).toLowerCase();
      const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
      await youtube.thumbnails.set({
        videoId,
        media: { mimeType, body: fs.createReadStream(thumbPath) },
      });
      thumbSet = true;
      console.log('[YouTube] サムネイル設定完了');
    } catch (tErr) {
      console.warn('[YouTube] サムネ設定失敗（動画は投稿済み）:', tErr.message);
    }
  }

  return { videoId, url: `https://youtu.be/${videoId}`, thumbSet };
}

module.exports = { getAuthUrl, handleCallback, isAuthenticated, upload };
