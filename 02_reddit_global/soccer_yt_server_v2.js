// soccer_yt_server_v2.js
// v2 サッカー YouTube ランチャー（port 3004）
//
// ★ 現行 v1 (port 3003) には一切手を加えない ★
//
// 【新フロー】
//   STEP1: 日付選択 → 案件一覧
//   STEP2: 案件選択 → DeepSeekがモジュール候補を提案
//   STEP3: モジュール選択（チェック＆並び替え）
//   STEP4: データ取得＋シナリオ生成（DeepSeek）
//   STEP5: シナリオ確認・編集
//   STEP6: 音声生成（OpenAI TTS / VoiceVox）
//   STEP7: 動画生成（ffmpeg）→ YouTube アップロード
//
// 起動: node soccer_yt_server_v2.js
// UI  : http://localhost:3004  (VPS経由: http://100.116.25.91:3004)

require('dotenv').config();
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const { spawn, execSync } = require('child_process');
const { google } = require('googleapis');

const { proposeModules }    = require('./scripts/modules/proposer');
const { fetchAllModuleData } = require('./scripts/modules/fetcher');
const { callAI }             = require('./scripts/ai_client');

const app  = express();
const PORT = 3004;

// ─── パス定義 ─────────────────────────────────────────────────────────────────
const TEMP_DIR    = path.join(__dirname, 'temp');
const IMG_DIR     = path.join(__dirname, 'images');
const SLIDES_DIR  = path.join(__dirname, 'soccer_yt_slides');  // 音声出力（v1と共有）
const LOGOS_DIR   = path.join(__dirname, 'logos');
const VIDEO_DIR   = path.join(__dirname, 'soccer_yt_videos_v2');
const THUMB_DIR   = path.join(__dirname, 'soccer_yt_thumbnails_v2');
const LOG_FILE    = path.join(__dirname, 'soccer_yt_v2.log');
const FFMPEG      = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
const VOICEVOX_URL = 'http://localhost:50021';

[TEMP_DIR, VIDEO_DIR, THUMB_DIR, SLIDES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── YouTube OAuth2 ────────────────────────────────────────────────────────
const YT_TOKEN_PATH = path.join(__dirname, '.youtube_tokens.json');
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${PORT}/auth/youtube/callback`
);
if (fs.existsSync(YT_TOKEN_PATH)) {
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync(YT_TOKEN_PATH, 'utf8')));
}
oauth2Client.on('tokens', tokens => {
  const merged = fs.existsSync(YT_TOKEN_PATH)
    ? { ...JSON.parse(fs.readFileSync(YT_TOKEN_PATH, 'utf8')), ...tokens }
    : tokens;
  fs.writeFileSync(YT_TOKEN_PATH, JSON.stringify(merged, null, 2));
});

app.use(express.json({ limit: '10mb' }));
app.use('/images',  express.static(IMG_DIR));
app.use('/narrations', express.static(SLIDES_DIR));
app.use('/video-files', express.static(VIDEO_DIR));

// ─── ジョブ管理 ───────────────────────────────────────────────────────────────
let ttsJob   = { running: false, results: [], done: false, error: null };
let videoJob = { running: false, log: [], done: false, exitCode: null };

// ─── ログ ─────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ─── ユーティリティ ───────────────────────────────────────────────────────────
function imgBase64(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return { b64: null, mime: null };
  const ext  = path.extname(imgPath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { b64: fs.readFileSync(imgPath).toString('base64'), mime };
}

// ─── v2シナリオJSON パス ─────────────────────────────────────────────────────
function scenarioPath(date, postId) {
  return path.join(TEMP_DIR, `v2_scenario_${date}_${postId}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// シナリオ生成（DeepSeekがモジュールデータからナレーション台本を作成）
// ═══════════════════════════════════════════════════════════════════════════════
async function generateScenario(post, modulesWithData) {
  // モジュールデータをプロンプト用テキストに変換
  const moduleTexts = modulesWithData.map((mod, i) => {
    const d = mod.fetchedData || {};
    let dataText = '';

    if (mod.id === 'news_overview') {
      dataText = `既存概要文:\n${d.text || '（なし）'}`;
    } else if (mod.id === 'reddit_reaction') {
      dataText = `海外コメント:\n${(d.comments || []).map(c => `  ・${c}`).join('\n') || '（なし）'}`;
    } else if (d.extract) {
      // Wikipedia
      dataText = `Wikipedia要約 (${d.title || ''}):\n${d.extract.slice(0, 500)}`;
    } else if (d.wiki && d.serper) {
      // Wikipedia + Serper 組み合わせ
      dataText = `Wikipedia (${d.wiki.title || ''}):\n${(d.wiki.extract || '').slice(0, 300)}\n` +
        `検索結果:\n${(d.serper.organic || []).slice(0, 3).map(r => `  ・${r.title}: ${r.snippet}`).join('\n')}`;
    } else if (d.summary) {
      // カスタム調査モジュール（英語+日本語検索結果）
      dataText = `調査テーマ「${d.query || mod.params?.customQuery || ''}」の検索結果:\n${d.summary}`;
    } else if (d.organic) {
      // Serper のみ
      dataText = `検索結果 (${mod.params?.searchQuery || mod.params?.customQuery || ''}):\n` +
        (d.organic || []).slice(0, 4).map(r => `  ・${r.title}: ${r.snippet}`).join('\n');
    } else if (d.name) {
      // SofaScore 選手
      const s = d.seasonStats || {};
      dataText = `選手データ (${d.name} / ${d.team || '不明'}):\n` +
        `  出場: ${s.appearances ?? '?'}, ゴール: ${s.goals ?? '?'}, アシスト: ${s.assists ?? '?'}, 評価点: ${s.rating ?? '?'}\n` +
        `  国籍: ${d.nationality || '不明'}, 身長: ${d.height ? d.height + 'cm' : '不明'}`;
    } else if (!d.ok) {
      dataText = `（データ取得失敗: ${d.error || '不明'}）`;
    } else {
      dataText = `（データなし）`;
    }

    return `【モジュール${i + 1}: ${mod.label}】\n${dataText}`;
  }).join('\n\n');

  const originalTitle = post._meta?.threadTitle || post.youtubeTitle || post.catchLine1 || '';

  const prompt = `あなたは日本のサッカーYouTubeチャンネル「速報!サッカーニュース」のナレーターです。
以下の案件情報とモジュールデータをもとに、4〜5分の動画ナレーション台本を作成してください。

【元の案件タイトル（英語）】
${originalTitle}

${moduleTexts}

【出力形式】JSONのみ（コメント不要）:
{
  "youtubeTitle": "（70字以内・日本語・SEO意識・例：【驚愕】ハーランド今季○ゴール！驚きの真実とは）",
  "hashtagsText": "#サッカー #プレミアリーグ #○○（主要5個スペース区切り）",
  "outroTelop": "（エンディングの一言テロップ・30字以内）",
  "modules": [
    {
      "id": "モジュールID",
      "narration": "（そのモジュールのナレーション文。150〜350字。自然な日本語。）",
      "keyPoints": ["箇条書きポイント（表示用・2〜4個）"],
      "imageQuery": "（英語の画像検索クエリ・10語以内）"
    }
  ]
}

【ナレーション指示】
- トーン: ニュースキャスターが少し砕けた感じ（堅すぎず、崩れすぎず）
- 各モジュールは自然な流れでつながるように書く
- 数字・固有名詞（選手名・クラブ名）は正確に
- 「ということで」「それでは」等の繋ぎ言葉で各モジュールを滑らかにつなぐ
- 視聴者が「へー！」と思える具体的な情報を必ず盛り込む`;

  const raw = await callAI({
    model:      'deepseek-chat',
    max_tokens: 4000,
    messages:   [{ role: 'user', content: prompt }],
    system:     'プロのサッカーYouTubeナレーター兼台本作家です。JSONのみを返します。',
  });

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('シナリオJSONが取得できませんでした');

  const scenario = JSON.parse(m[0]);

  // IDと元データをシナリオにマージ
  scenario.modules = (scenario.modules || []).map((sm, i) => {
    const orig = modulesWithData.find(mod => mod.id === sm.id) || modulesWithData[i] || {};
    return {
      id:          sm.id          || orig.id,
      label:       orig.label     || sm.id,
      icon:        orig.icon      || '📌',
      narration:   sm.narration   || '',
      keyPoints:   sm.keyPoints   || [],
      imageQuery:  sm.imageQuery  || '',
      imagePath:   orig.fetchedData?.thumbnail || null,
      fetchedData: orig.fetchedData || {},
    };
  });

  return scenario;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OpenAI TTS でナレーション音声生成
// ═══════════════════════════════════════════════════════════════════════════════
async function generateTTSForScenario(scenario, date, postId) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const results = [];
  const prefix  = `${date}_${postId}`;
  const slideDir = path.join(SLIDES_DIR, `${date}_v2_${postId}`);
  if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

  for (let i = 0; i < scenario.modules.length; i++) {
    const mod = scenario.modules[i];
    const text = (mod.narration || '').trim();
    if (!text) { results.push({ index: i, file: null, skipped: true }); continue; }

    const outFile = path.join(slideDir, `narr_${i}.mp3`);
    try {
      const mp3 = await client.audio.speech.create({
        model:  process.env.TTS_MODEL  || 'tts-1-hd',
        voice:  process.env.TTS_VOICE  || 'alloy',
        input:  text,
        speed:  parseFloat(process.env.TTS_SPEED || '1.0'),
      });
      const buf = Buffer.from(await mp3.arrayBuffer());
      fs.writeFileSync(outFile, buf);
      log(`TTS [${i}] ${path.basename(outFile)} (${buf.length} bytes)`);
      results.push({ index: i, file: outFile, bytes: buf.length });
    } catch (e) {
      log(`TTS ERROR [${i}]: ${e.message}`);
      results.push({ index: i, file: null, error: e.message });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API エンドポイント
// ═══════════════════════════════════════════════════════════════════════════════

// ── コンテンツ一覧取得 ─────────────────────────────────────────────────────────
app.get('/api/v2/content', (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: '?date=YYYY-MM-DD が必要です' });

  const file = path.join(TEMP_DIR, `soccer_yt_content_${date}.json`);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: `${path.basename(file)} が見つかりません` });
  }

  const data  = JSON.parse(fs.readFileSync(file, 'utf8'));
  const posts = (data.posts || []).map((p, i) => {
    const id = String(p.num || i + 1);
    return {
      index:        i,
      id,
      title:        p.youtubeTitle || p.catchLine1 || p._meta?.threadTitle || `案件 ${i + 1}`,
      type:         p.type || 'topic',
      score:        0,
      hasScenario:  fs.existsSync(scenarioPath(date, id)),
      mainImageUrl: p.mainImagePath ? `/images/${path.basename(p.mainImagePath)}` : null,
    };
  });

  res.json({ date, posts });
});

// ── 案件詳細取得 ───────────────────────────────────────────────────────────────
app.get('/api/v2/post', (req, res) => {
  const { date, id } = req.query;
  if (!date || !id) return res.status(400).json({ error: '?date= と ?id= が必要です' });

  const file = path.join(TEMP_DIR, `soccer_yt_content_${date}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'コンテンツファイルなし' });

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const post = (data.posts || []).find((p, i) => String(p.num || i + 1) === String(id));
  if (!post) return res.status(404).json({ error: `id=${id} が見つかりません` });

  res.json({ post });
});

// ── モジュール提案 ─────────────────────────────────────────────────────────────
app.post('/api/v2/propose', async (req, res) => {
  const { post } = req.body;
  if (!post) return res.status(400).json({ error: 'post が必要です' });

  try {
    log(`モジュール提案開始: ${post._imgMeta?.title || post.redditTitle || '不明'}`);
    const result = await proposeModules(post);
    log(`モジュール提案完了: ${result.modules.length}個`);
    res.json(result);
  } catch (e) {
    log(`モジュール提案エラー: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── データ取得 + シナリオ生成 ──────────────────────────────────────────────────
app.post('/api/v2/generate', async (req, res) => {
  const { post, modules, date } = req.body;
  if (!post || !modules) return res.status(400).json({ error: 'post と modules が必要です' });

  try {
    log(`データ取得開始: ${modules.length}モジュール`);
    const modulesWithData = await fetchAllModuleData(modules, post);
    log(`データ取得完了。シナリオ生成開始...`);

    const scenario = await generateScenario(post, modulesWithData);
    log(`シナリオ生成完了: ${scenario.youtubeTitle}`);

    // v2 シナリオとして保存
    const postId = String(post.num || '1');
    const sPath  = scenarioPath(date, postId);
    const toSave = {
      ...scenario,
      _meta: {
        date,
        postId,
        originalTitle: post._meta?.threadTitle || post.youtubeTitle || post.catchLine1 || '',
        generatedAt:   new Date().toISOString(),
        mainImagePath: post.mainImagePath || null,
      },
    };
    fs.writeFileSync(sPath, JSON.stringify(toSave, null, 2));
    log(`シナリオ保存: ${path.basename(sPath)}`);

    res.json({ scenario: toSave });
  } catch (e) {
    log(`シナリオ生成エラー: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── シナリオ保存（手動編集後） ─────────────────────────────────────────────────
app.post('/api/v2/save-scenario', (req, res) => {
  const { scenario, date, postId } = req.body;
  if (!scenario || !date || !postId) return res.status(400).json({ error: 'パラメータ不足' });

  try {
    const sPath = scenarioPath(date, postId);
    fs.writeFileSync(sPath, JSON.stringify(scenario, null, 2));
    res.json({ ok: true, saved: path.basename(sPath) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── シナリオ読み込み ────────────────────────────────────────────────────────────
app.get('/api/v2/scenario', (req, res) => {
  const { date, postId } = req.query;
  if (!date || !postId) return res.status(400).json({ error: 'パラメータ不足' });

  const sPath = scenarioPath(date, postId);
  if (!fs.existsSync(sPath)) return res.status(404).json({ error: 'シナリオなし' });

  res.json(JSON.parse(fs.readFileSync(sPath, 'utf8')));
});

// ── TTS 音声生成 ──────────────────────────────────────────────────────────────
app.post('/api/v2/tts', async (req, res) => {
  const { date, postId } = req.body;
  if (!date || !postId) return res.status(400).json({ error: 'パラメータ不足' });

  if (ttsJob.running) return res.status(409).json({ error: 'TTS実行中です' });

  const sPath = scenarioPath(date, postId);
  if (!fs.existsSync(sPath)) return res.status(404).json({ error: 'シナリオなし。先にシナリオ生成してください' });

  const scenario = JSON.parse(fs.readFileSync(sPath, 'utf8'));

  ttsJob = { running: true, results: [], done: false, error: null };
  res.json({ ok: true, message: 'TTS開始' });

  try {
    const results = await generateTTSForScenario(scenario, date, postId);
    ttsJob = { running: false, results, done: true, error: null };
    log(`TTS完了: ${results.filter(r => r.file).length}/${results.length} 成功`);
  } catch (e) {
    ttsJob = { running: false, results: [], done: true, error: e.message };
    log(`TTS失敗: ${e.message}`);
  }
});

app.get('/api/v2/tts-status', (_, res) => res.json(ttsJob));

// ── 動画生成 ─────────────────────────────────────────────────────────────────
app.post('/api/v2/video', (req, res) => {
  const { date, postId } = req.body;
  if (!date || !postId) return res.status(400).json({ error: 'パラメータ不足' });

  if (videoJob.running) return res.status(409).json({ error: '動画生成実行中です' });

  const sPath = scenarioPath(date, postId);
  if (!fs.existsSync(sPath)) return res.status(404).json({ error: 'シナリオなし' });

  videoJob = { running: true, log: [], done: false, exitCode: null };
  res.json({ ok: true, message: '動画生成開始' });

  const child = spawn('node', [
    path.join(__dirname, 'scripts', 'generate_soccer_yt_video_v2.js'),
    date, postId,
  ], { env: { ...process.env, PORT: String(PORT) } });

  child.stdout.on('data', d => {
    const line = d.toString().trim();
    videoJob.log.push(line);
    log(`[video] ${line}`);
  });
  child.stderr.on('data', d => {
    const line = d.toString().trim();
    videoJob.log.push(`ERR: ${line}`);
    log(`[video ERR] ${line}`);
  });
  child.on('close', code => {
    videoJob = { ...videoJob, running: false, done: true, exitCode: code };
    log(`動画生成終了 (code=${code})`);
  });
});

app.get('/api/v2/video-status', (_, res) => res.json(videoJob));

// ── 生成済み動画一覧 ──────────────────────────────────────────────────────────
app.get('/api/v2/videos', (req, res) => {
  const date = req.query.date || '';
  const files = fs.existsSync(VIDEO_DIR)
    ? fs.readdirSync(VIDEO_DIR)
        .filter(f => f.endsWith('.mp4') && (!date || f.startsWith(date)))
        .map(f => ({ name: f, url: `/video-files/${f}` }))
    : [];
  res.json(files);
});

// ═══════════════════════════════════════════════════════════════════════════════
// メイン UI（SPA）
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>サッカーYT v2 ランチャー</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#0f1117;color:#e0e0e0;min-height:100vh}
.header{background:linear-gradient(135deg,#1a2040,#0d1220);padding:16px 24px;border-bottom:1px solid #2a3050;display:flex;align-items:center;gap:12px}
.header h1{font-size:20px;font-weight:900;color:#5eb3ff}
.badge{background:#1a4a8a;color:#7dc8ff;font-size:12px;padding:3px 10px;border-radius:12px;font-weight:700}
.main{max-width:1100px;margin:0 auto;padding:24px 16px}

/* ステップナビ */
.steps{display:flex;gap:0;margin-bottom:28px;background:#161b2e;border-radius:12px;padding:12px 16px;overflow-x:auto}
.step{flex:1;min-width:80px;text-align:center;padding:8px 4px;position:relative;cursor:default}
.step-num{width:28px;height:28px;border-radius:50%;background:#2a3050;color:#667;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;margin:0 auto 6px}
.step-label{font-size:11px;color:#667;line-height:1.3}
.step.active .step-num{background:#1a6ef5;color:#fff}
.step.active .step-label{color:#7dc8ff}
.step.done .step-num{background:#1a8a4a;color:#fff}
.step.done .step-label{color:#5ed4a0}

/* パネル */
.panel{background:#161b2e;border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid #2a3050}
.panel-title{font-size:15px;font-weight:700;color:#9bb5e0;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.panel-title .icon{font-size:18px}

/* 入力・ボタン */
input[type=date],input[type=text],select{background:#0f1420;border:1px solid #2a3050;color:#e0e0e0;border-radius:8px;padding:8px 12px;font-size:14px;outline:none}
input[type=date]:focus,input[type=text]:focus{border-color:#1a6ef5}
.btn{padding:10px 20px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;border:none;transition:all 0.2s}
.btn-primary{background:#1a6ef5;color:#fff}
.btn-primary:hover{background:#2a7eff}
.btn-primary:disabled{background:#1a3060;color:#567;cursor:not-allowed}
.btn-success{background:#1a8a4a;color:#fff}
.btn-success:hover{background:#2aa060}
.btn-danger{background:#8a1a1a;color:#fff}
.btn-danger:hover{background:#a02a2a}
.btn-ghost{background:#1e2540;color:#9bb5e0;border:1px solid #2a3050}
.btn-ghost:hover{background:#252d50}

/* 案件リスト */
.post-list{display:flex;flex-direction:column;gap:8px}
.post-item{background:#1e2540;border:1px solid #2a3050;border-radius:8px;padding:12px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;transition:all 0.15s}
.post-item:hover{border-color:#1a6ef5;background:#1e2d50}
.post-item.selected{border-color:#1a6ef5;background:#152040}
.post-type{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;flex-shrink:0}
.type-post-match{background:#1a4a1a;color:#5ed4a0}
.type-transfer{background:#4a3a1a;color:#e0b060}
.type-topic{background:#1a2a4a;color:#7dc8ff}
.type-injury{background:#4a1a1a;color:#e06060}
.post-title{font-size:13px;color:#c0d0e0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.post-done{font-size:11px;color:#5ed4a0;flex-shrink:0}

/* モジュールカード */
.module-grid{display:flex;flex-direction:column;gap:8px}
.module-card{background:#1e2540;border:2px solid #2a3050;border-radius:10px;padding:12px 16px;display:flex;align-items:flex-start;gap:12px;transition:all 0.15s;cursor:pointer}
.module-card:hover{border-color:#3a4570}
.module-card.selected{border-color:#1a6ef5;background:#152040}
.module-card.always{border-color:#1a4a8a;opacity:0.9;cursor:default}
.module-icon{font-size:24px;flex-shrink:0;width:32px;text-align:center}
.module-info{flex:1}
.module-label{font-size:14px;font-weight:700;color:#c0d0e0;margin-bottom:3px}
.module-desc{font-size:12px;color:#7080a0}
.module-reason{font-size:11px;color:#5eb3a0;margin-top:4px;font-style:italic}
.module-source{font-size:10px;color:#4a5a70;margin-top:2px}
.module-check{width:20px;height:20px;flex-shrink:0;accent-color:#1a6ef5}
.module-order{width:24px;text-align:center;color:#4a5a70;font-size:12px;font-weight:700;flex-shrink:0}
.move-btn{background:none;border:none;color:#4a5a80;cursor:pointer;font-size:16px;padding:2px;line-height:1}
.move-btn:hover{color:#9bb5e0}

/* シナリオ */
.scenario-module{background:#1a2035;border:1px solid #2a3050;border-radius:10px;padding:16px;margin-bottom:12px}
.scenario-mod-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.scenario-mod-icon{font-size:20px}
.scenario-mod-label{font-size:14px;font-weight:700;color:#7dc8ff}
.narration-edit{width:100%;background:#0f1420;border:1px solid #2a3050;border-radius:6px;color:#d0e0f0;font-size:13px;padding:10px;resize:vertical;min-height:80px;font-family:inherit;line-height:1.6}
.narration-edit:focus{border-color:#1a6ef5;outline:none}
.key-points{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
.key-point{background:#1a2a40;border:1px solid #2a4060;border-radius:6px;padding:4px 10px;font-size:11px;color:#8ab0d0}

/* ステータス */
.status-box{background:#0a1020;border:1px solid #1a2a40;border-radius:8px;padding:12px 16px;font-size:13px;color:#8090b0;max-height:200px;overflow-y:auto;white-space:pre-wrap}
.status-ok{color:#5ed4a0}
.status-err{color:#e06060}
.loading{display:inline-block;animation:spin 1s linear infinite;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}

.row{display:flex;gap:10px;align-items:center}
.spacer{flex:1}
.tag{font-size:11px;padding:2px 8px;border-radius:10px}
.tag-blue{background:#1a3a60;color:#7dc8ff}

/* タイトル入力 */
.yt-title-box{width:100%;font-size:16px;font-weight:700;padding:10px 14px}
</style>
</head>
<body>
<div class="header">
  <h1>⚽ サッカーYT ランチャー</h1>
  <span class="badge">v2 BETA</span>
  <span style="font-size:12px;color:#4a5a80;margin-left:auto">port ${PORT} | 現行v1は port 3003 で稼働中</span>
</div>

<div class="main">
  <!-- ステップナビ -->
  <div class="steps" id="stepNav">
    <div class="step active" id="sNav0"><div class="step-num">1</div><div class="step-label">案件選択</div></div>
    <div class="step" id="sNav1"><div class="step-num">2</div><div class="step-label">モジュール選択</div></div>
    <div class="step" id="sNav2"><div class="step-num">3</div><div class="step-label">シナリオ生成</div></div>
    <div class="step" id="sNav3"><div class="step-num">4</div><div class="step-label">確認・編集</div></div>
    <div class="step" id="sNav4"><div class="step-num">5</div><div class="step-label">音声・動画</div></div>
  </div>

  <!-- ───── STEP 1: 案件選択 ───── -->
  <div id="step1">
    <div class="panel">
      <div class="panel-title"><span class="icon">📅</span>日付選択</div>
      <div class="row">
        <input type="date" id="dateInput" value="">
        <button class="btn btn-primary" onclick="loadContent()">読み込む</button>
      </div>
    </div>
    <div class="panel" id="postListPanel" style="display:none">
      <div class="panel-title"><span class="icon">📋</span>案件一覧 <span id="postCount" class="tag tag-blue">0件</span></div>
      <div class="post-list" id="postList"></div>
    </div>
  </div>

  <!-- ───── STEP 2: モジュール選択 ───── -->
  <div id="step2" style="display:none">
    <div class="panel">
      <div class="panel-title"><span class="icon">🎯</span>選択中の案件</div>
      <div id="selectedPostInfo" style="font-size:14px;color:#9bb5e0"></div>
    </div>
    <div class="panel">
      <div class="panel-title"><span class="icon">🧩</span>モジュール候補 <span id="moduleStatus" style="font-size:12px;color:#667;margin-left:8px"></span></div>
      <div id="moduleStatusMsg" style="font-size:13px;color:#8090b0;margin-bottom:10px"></div>
      <div class="module-grid" id="moduleGrid"></div>
      <!-- カスタムモジュール追加 -->
      <div id="customModuleArea" style="display:none;margin-top:16px;padding:14px;background:#1a1f35;border:1px dashed #3a4570;border-radius:10px">
        <div style="font-size:13px;color:#9bb5e0;margin-bottom:8px">🔍 カスタムモジュールを追加</div>
        <div style="font-size:12px;color:#6070a0;margin-bottom:10px">調べたいテーマを日本語か英語で入力 → Serper+DeepSeekが記事を探してシナリオに組み込みます</div>
        <div class="row" style="gap:8px">
          <input type="text" id="customQueryInput" style="flex:1;font-size:13px;padding:8px 12px"
                 placeholder="例: Jリーグの海外展開戦略　/　Stadium food culture Japan">
          <button class="btn btn-ghost" onclick="addCustomModule()" style="white-space:nowrap">＋ 追加</button>
        </div>
      </div>

      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" id="proposeBtn" onclick="proposeModules()">
          🤖 モジュール候補を提案
        </button>
        <button class="btn btn-ghost" id="addCustomBtn" style="display:none" onclick="toggleCustomArea()">
          🔍 カスタムモジュールを追加
        </button>
        <button class="btn btn-success" id="generateBtn" style="display:none" onclick="goToGenerate()">
          ✨ 選択した構成でシナリオ生成 →
        </button>
        <button class="btn btn-ghost" onclick="goStep(1)">← 案件選択に戻る</button>
      </div>
    </div>
  </div>

  <!-- ───── STEP 3: シナリオ生成中 ───── -->
  <div id="step3" style="display:none">
    <div class="panel">
      <div class="panel-title"><span class="icon">⚙️</span>データ取得・シナリオ生成中</div>
      <div id="generateStatus" class="status-box">準備中...</div>
    </div>
  </div>

  <!-- ───── STEP 4: シナリオ確認・編集 ───── -->
  <div id="step4" style="display:none">
    <div class="panel">
      <div class="panel-title"><span class="icon">📝</span>タイトル・ハッシュタグ</div>
      <input type="text" id="ytTitle" class="yt-title-box" placeholder="YouTube タイトル">
      <div style="margin-top:8px">
        <input type="text" id="ytHashtags" style="width:100%;font-size:13px;padding:8px 12px" placeholder="#ハッシュタグ">
      </div>
    </div>
    <div id="scenarioModules"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-success" onclick="saveAndProceed()">保存して次へ →</button>
      <button class="btn btn-ghost" onclick="regenerateScenario()">🔄 シナリオ再生成</button>
      <button class="btn btn-ghost" onclick="goStep(2)">← モジュール選択に戻る</button>
    </div>
  </div>

  <!-- ───── STEP 5: 音声・動画生成 ───── -->
  <div id="step5" style="display:none">
    <div class="panel">
      <div class="panel-title"><span class="icon">🎙</span>音声生成 (OpenAI TTS)</div>
      <button class="btn btn-primary" id="ttsBtn" onclick="startTTS()">🎙 音声生成開始</button>
      <div id="ttsStatus" class="status-box" style="margin-top:10px;display:none"></div>
    </div>
    <div class="panel">
      <div class="panel-title"><span class="icon">🎬</span>動画生成</div>
      <button class="btn btn-success" id="videoBtn" onclick="startVideo()" disabled>🎬 動画生成開始</button>
      <div id="videoStatus" class="status-box" style="margin-top:10px;display:none"></div>
    </div>
    <div class="panel" id="videoResultPanel" style="display:none">
      <div class="panel-title"><span class="icon">✅</span>生成完了</div>
      <div id="videoResult"></div>
    </div>
    <button class="btn btn-ghost" onclick="goStep(4)" style="margin-top:10px">← 編集に戻る</button>
  </div>
</div>

<script>
// ─── 状態管理 ───────────────────────────────────────────────────────────────
let state = {
  date: '',
  posts: [],
  selectedPost: null,
  proposedModules: null,   // { topicSummary, topicType, modules[] }
  scenario: null,
  currentStep: 1,
};

// ─── 今日の日付をセット ─────────────────────────────────────────────────────
const today = new Date();
const jst   = new Date(today.getTime() + 9*3600*1000);
document.getElementById('dateInput').value = jst.toISOString().slice(0,10);

// ─── ステップ切り替え ───────────────────────────────────────────────────────
function goStep(n) {
  [1,2,3,4,5].forEach(i => {
    document.getElementById('step'+i).style.display = i===n ? '' : 'none';
  });
  [0,1,2,3,4].forEach(i => {
    const el = document.getElementById('sNav'+i);
    el.className = 'step' + (i+1===n ? ' active' : (i+1<n ? ' done' : ''));
  });
  state.currentStep = n;
}

// ─── STEP1: コンテンツ読み込み ──────────────────────────────────────────────
async function loadContent() {
  const date = document.getElementById('dateInput').value;
  if (!date) return alert('日付を選択してください');
  state.date = date;

  const res  = await fetch(\`/api/v2/content?date=\${date}\`);
  if (!res.ok) {
    const err = await res.json();
    return alert('エラー: ' + err.error);
  }
  const data = await res.json();
  state.posts = data.posts;

  const list = document.getElementById('postList');
  list.innerHTML = data.posts.map(p => \`
    <div class="post-item" onclick="selectPost('\${p.id}')" id="pi_\${p.id}">
      <span class="post-type type-\${p.type}">\${typeLabel(p.type)}</span>
      <span class="post-title">\${esc(p.title)}</span>
      \${p.hasScenario ? '<span class="post-done">✅ 生成済み</span>' : ''}
    </div>
  \`).join('');

  document.getElementById('postCount').textContent = data.posts.length + '件';
  document.getElementById('postListPanel').style.display = '';
}

function typeLabel(t) {
  return {
    'post-match': '試合', 'transfer': '移籍', 'injury': '負傷',
    'manager': '監督', 'topic': 'トピック'
  }[t] || t;
}

// ─── STEP1 → STEP2: 案件選択 ────────────────────────────────────────────────
async function selectPost(postId) {
  document.querySelectorAll('.post-item').forEach(el => el.classList.remove('selected'));
  document.getElementById('pi_' + postId)?.classList.add('selected');

  const res  = await fetch(\`/api/v2/post?date=\${state.date}&id=\${postId}\`);
  const data = await res.json();
  state.selectedPost = data.post;

  document.getElementById('selectedPostInfo').innerHTML =
    \`<strong>\${esc(state.selectedPost.youtubeTitle || state.selectedPost.catchLine1 || '（タイトルなし）')}</strong>
     <span class="tag tag-blue" style="margin-left:8px">\${state.selectedPost.type || 'topic'}</span>\`;

  // モジュールグリッドをリセット
  document.getElementById('moduleGrid').innerHTML = '';
  document.getElementById('generateBtn').style.display = 'none';
  document.getElementById('moduleStatusMsg').textContent = '「モジュール候補を提案」ボタンを押すと、DeepSeekが最適なモジュールを提案します。';
  state.proposedModules = null;

  goStep(2);
}

// ─── STEP2: モジュール提案 ──────────────────────────────────────────────────
async function proposeModules() {
  if (!state.selectedPost) return;
  const btn = document.getElementById('proposeBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 提案中...';
  document.getElementById('moduleStatusMsg').textContent = 'DeepSeekが案件を分析中...';

  try {
    const res  = await fetch('/api/v2/propose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ post: state.selectedPost }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.proposedModules = data;

    renderModuleCards(data.modules);
    const hasReddit = data.hasRealReddit ? '' : '（Redditコメントなし → 海外の反応モジュールは除外）';
    document.getElementById('moduleStatusMsg').textContent =
      \`\${data.topicSummary} (\${data.topicType}) \${hasReddit}\`;
    document.getElementById('generateBtn').style.display = '';
    document.getElementById('addCustomBtn').style.display = '';
  } catch (e) {
    document.getElementById('moduleStatusMsg').textContent = 'エラー: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 再提案';
  }
}

function renderModuleCards(modules) {
  const grid = document.getElementById('moduleGrid');
  grid.innerHTML = modules.map((mod, i) => \`
    <div class="module-card \${mod.alwaysInclude ? 'always selected' : (mod.selected ? 'selected' : '')}"
         id="mc_\${i}" onclick="toggleModule(\${i})">
      <input type="checkbox" class="module-check" id="chk_\${i}"
             \${mod.selected ? 'checked' : ''}
             \${mod.alwaysInclude ? 'disabled' : ''}
             onclick="event.stopPropagation();toggleModule(\${i})">
      <div class="module-icon">\${mod.icon || '📌'}</div>
      <div class="module-info">
        <div class="module-label">\${esc(mod.label)}</div>
        <div class="module-desc">\${esc(mod.description || '')}</div>
        \${mod.reason ? \`<div class="module-reason">💡 \${esc(mod.reason)}</div>\` : ''}
        <div class="module-source">データ: \${esc(mod.dataSource || '')}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:2px">
        <button class="move-btn" onclick="event.stopPropagation();moveModule(\${i},-1)">▲</button>
        <div class="module-order">\${i+1}</div>
        <button class="move-btn" onclick="event.stopPropagation();moveModule(\${i},+1)">▼</button>
      </div>
    </div>
  \`).join('');
}

function toggleCustomArea() {
  const area = document.getElementById('customModuleArea');
  area.style.display = area.style.display === 'none' ? '' : 'none';
  if (area.style.display !== 'none') {
    document.getElementById('customQueryInput').focus();
  }
}

function addCustomModule() {
  const query = document.getElementById('customQueryInput').value.trim();
  if (!query) return;
  if (!state.proposedModules) return;

  // カスタムモジュールを追加
  state.proposedModules.modules.push({
    id:          'custom_research',
    label:       query,           // 入力テキストをそのままラベルに
    description: 'カスタム調査モジュール',
    icon:        '🔍',
    dataSource:  'serper',
    reason:      'ユーザー指定テーマ',
    params:      { customQuery: query },
    selected:    true,
  });

  document.getElementById('customQueryInput').value = '';
  document.getElementById('customModuleArea').style.display = 'none';
  renderModuleCards(state.proposedModules.modules);
}

function toggleModule(i) {
  const mods = state.proposedModules.modules;
  if (mods[i].alwaysInclude) return;
  mods[i].selected = !mods[i].selected;
  renderModuleCards(mods);
}

function moveModule(i, dir) {
  const mods = state.proposedModules.modules;
  const j = i + dir;
  if (j < 0 || j >= mods.length) return;
  [mods[i], mods[j]] = [mods[j], mods[i]];
  renderModuleCards(mods);
}

// ─── STEP2 → STEP3: シナリオ生成 ────────────────────────────────────────────
async function goToGenerate() {
  const selected = state.proposedModules.modules.filter(m => m.selected !== false);
  if (selected.length === 0) return alert('最低1つモジュールを選択してください');

  goStep(3);
  const statusEl = document.getElementById('generateStatus');
  statusEl.textContent = \`📡 \${selected.length}個のモジュールのデータを取得中...\\n\\n\`;

  try {
    const res = await fetch('/api/v2/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post:    state.selectedPost,
        modules: selected,
        date:    state.date,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.scenario = data.scenario;

    statusEl.textContent += '✅ シナリオ生成完了！\\n' + data.scenario.youtubeTitle;
    setTimeout(() => renderScenario(data.scenario), 800);
  } catch (e) {
    statusEl.textContent += '\\n❌ エラー: ' + e.message;
  }
}

// ─── STEP4: シナリオ表示 ────────────────────────────────────────────────────
function renderScenario(scenario) {
  document.getElementById('ytTitle').value     = scenario.youtubeTitle || '';
  document.getElementById('ytHashtags').value  = scenario.hashtagsText || '';

  const container = document.getElementById('scenarioModules');
  container.innerHTML = (scenario.modules || []).map((mod, i) => \`
    <div class="scenario-module">
      <div class="scenario-mod-header">
        <span class="scenario-mod-icon">\${esc(mod.icon || '📌')}</span>
        <span class="scenario-mod-label">【\${i+1}】\${esc(mod.label || mod.id)}</span>
      </div>
      <textarea class="narration-edit" id="narr_\${i}" rows="4">\${esc(mod.narration || '')}</textarea>
      \${mod.keyPoints?.length ? \`
        <div class="key-points">
          \${mod.keyPoints.map(kp => \`<span class="key-point">\${esc(kp)}</span>\`).join('')}
        </div>
      \` : ''}
    </div>
  \`).join('');

  goStep(4);
}

function saveAndProceed() {
  if (!state.scenario) return;
  // UIの編集をシナリオに反映
  state.scenario.youtubeTitle = document.getElementById('ytTitle').value;
  state.scenario.hashtagsText = document.getElementById('ytHashtags').value;
  state.scenario.modules.forEach((mod, i) => {
    const el = document.getElementById('narr_' + i);
    if (el) mod.narration = el.value;
  });

  const postId = state.selectedPost.id;
  fetch('/api/v2/save-scenario', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: state.scenario, date: state.date, postId }),
  }).then(() => goStep(5));
}

async function regenerateScenario() {
  if (!confirm('シナリオを再生成します。現在の編集内容は失われます。よろしいですか？')) return;
  await goToGenerate();
}

// ─── STEP5: 音声・動画生成 ──────────────────────────────────────────────────
async function startTTS() {
  const btn = document.getElementById('ttsBtn');
  btn.disabled = true;
  const statusEl = document.getElementById('ttsStatus');
  statusEl.style.display = '';
  statusEl.textContent = '⏳ 音声生成中...';

  const postId = state.selectedPost.id;
  await fetch('/api/v2/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: state.date, postId }),
  });

  // ポーリング
  const poll = setInterval(async () => {
    const r = await fetch('/api/v2/tts-status').then(r => r.json());
    if (r.done) {
      clearInterval(poll);
      const ok = r.results.filter(x => x.file).length;
      statusEl.textContent = r.error
        ? '❌ エラー: ' + r.error
        : \`✅ 完了: \${ok}/\${r.results.length} 件成功\`;
      btn.disabled = false;
      document.getElementById('videoBtn').disabled = false;
    } else {
      statusEl.textContent = '⏳ 生成中... (' + r.results.length + ' 件完了)';
    }
  }, 1500);
}

async function startVideo() {
  const btn = document.getElementById('videoBtn');
  btn.disabled = true;
  const statusEl = document.getElementById('videoStatus');
  statusEl.style.display = '';
  statusEl.textContent = '⏳ 動画生成中...';

  const postId = state.selectedPost.id;
  await fetch('/api/v2/video', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: state.date, postId }),
  });

  const poll = setInterval(async () => {
    const r = await fetch('/api/v2/video-status').then(r => r.json());
    statusEl.textContent = r.log.slice(-10).join('\\n');
    if (r.done) {
      clearInterval(poll);
      if (r.exitCode === 0) {
        statusEl.textContent += '\\n✅ 動画生成完了！';
        loadVideoResult();
      } else {
        statusEl.textContent += \`\\n❌ 終了コード: \${r.exitCode}\`;
      }
      btn.disabled = false;
    }
  }, 2000);
}

async function loadVideoResult() {
  const res  = await fetch(\`/api/v2/videos?date=\${state.date}\`);
  const list = await res.json();
  const panel = document.getElementById('videoResultPanel');
  const result = document.getElementById('videoResult');
  if (list.length) {
    panel.style.display = '';
    result.innerHTML = list.map(v =>
      \`<div style="margin-bottom:8px">
        <a href="\${v.url}" target="_blank" style="color:#5eb3ff">\${v.name}</a>
       </div>\`
    ).join('');
  }
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body></html>`));

// ─── 起動 ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`v2 ランチャー起動: http://localhost:${PORT}`);
  log(`v1 (port 3003) は独立稼働中`);
});
