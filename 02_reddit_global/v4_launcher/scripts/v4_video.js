// v4_launcher/scripts/v4_video.js
// ネタブック → V4動画生成パイプライン
//
// 動画構成（2〜3分 / 4〜7枚）:
//   comment_heavy: opening → overview → supp1 → reaction1 → supp2 → reaction2 → ending（基本）
//   info_heavy:    opening → overview → supp1 → supp2 → reaction1 → reaction2 → ending
//   supp1/supp2 は省略可能。旧 standard/interleaved/rapid も後方互換で動作
//
// V3既存スライドと render.js（TTS/ffmpeg/BGM）を再利用する。
'use strict';

const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { matchPlayers, matchManagers, matchClubs } = require('../../scripts/modules/stock_match');

const BASE_DIR     = path.join(__dirname, '..', '..');  // 02_reddit_global/
const DATA_DIR     = path.join(BASE_DIR, 'data');
const MODULES_DIR  = DATA_DIR;  // <postId>_modules.json と同じ場所
const SI_DIR       = path.join(DATA_DIR, 'si_data');
const RENDER_JS    = path.join(BASE_DIR, 'scripts', 'v2_video', 'render.js');
const JOBS_DIR     = path.join(DATA_DIR, 'v2_jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

function safeId(s) { return String(s||'').replace(/[^\w]/g, '_').slice(0, 40); }

// ── 画像を entity 名から自動検索 ─────────────────────────────
//   ⚠️ imgDataUri は '/' 始まりを Web URL とみなして素通しするため、
//   プロジェクトルート相対パス（先頭スラッシュなし）で返す → base64 化される
function _findImage(entityName) {
  if (!entityName) return null;
  const hits = matchPlayers(entityName, { limit: 1 });
  if (hits.length) return hits[0].url.replace(/^\//, '');
  const mgr = matchManagers(entityName, { limit: 1 });
  if (mgr.length) return mgr[0].url.replace(/^\//, '');
  const club = matchClubs(entityName, { limit: 1 });
  if (club.length) return club[0].url.replace(/^\//, '');
  return null;
}

function _selectedImage(book) {
  const selected = Array.isArray(book?.selectedImages)
    ? book.selectedImages.find(Boolean)
    : null;
  return selected ? String(selected).replace(/^\//, '') : null;
}

function _imagePreset(book) {
  const selected = Array.isArray(book?.selectedImages) ? book.selectedImages : [];
  const assets = Array.isArray(book?.assetImages) ? book.assetImages.map(image => image?.url) : [];
  const paths = [...selected, ...assets]
    .filter(Boolean)
    .map(value => String(value).replace(/^\//, ''));
  return [...new Set(paths)].slice(0, 3);
}

const LAYOUT_TYPES = new Set(['info_heavy', 'comment_heavy']);
const STRUCTURE_PATTERNS = new Set(['standard', 'interleaved', 'rapid']);
const SUPPLEMENT_TYPES = new Set([
  'picture', 'insight', 'stats', 'profile',
  'comparison', 'timeline', 'ranking', 'matchcard', 'history',
]);

function _cleanText(v, fallback = '') {
  const s = String(v || '').trim();
  return s || fallback;
}

function _compactText(value, maxChars) {
  const text = _cleanText(value).replace(/\s+/g, ' ');
  if (Array.from(text).length <= maxChars) return text;
  const sentences = text.split(/(?<=[。！？!?])/).filter(Boolean);
  let out = '';
  for (const sentence of sentences) {
    if (Array.from(out + sentence).length > maxChars) break;
    out += sentence;
  }
  if (out) return out.trim();
  return Array.from(text).slice(0, maxChars).join('').replace(/[、,\s]+$/, '') + '。';
}

function _comments(v) {
  return Array.isArray(v) ? v.map(x => _cleanText(x)).filter(Boolean) : [];
}

function _hasStructuredData(type, data) {
  if (!data || typeof data !== 'object') return false;
  if (type === 'stats' || type === 'profile') {
    return Array.isArray(data.dataSlots) && data.dataSlots.some(x => x?.label && x?.value);
  }
  if (type === 'comparison') {
    return !!(data.leftName && data.rightName &&
      Array.isArray(data.dataSlots) &&
      data.dataSlots.some(x => x?.label && x?.leftValue != null && x?.rightValue != null));
  }
  if (type === 'timeline') {
    return Array.isArray(data.series) &&
      data.series.some(s => Array.isArray(s?.points) && s.points.length >= 2);
  }
  if (type === 'ranking') {
    return Array.isArray(data.items) && data.items.some(x => x?.name && x?.value);
  }
  if (type === 'matchcard') {
    return !!(data.homeTeam && data.awayTeam);
  }
  if (type === 'history') {
    return Array.isArray(data.events) && data.events.length >= 2;
  }
  return true;
}

// 個別補足スライドを構築（sfxNum: 1 or 2）
function _buildSupplementSlide(book, sfxNum, imagePath) {
  const typeKey = `supplement${sfxNum}Type`;
  const dataKey = `supplement${sfxNum}Data`;
  const titleKey = `supplement${sfxNum}Title`;
  const narrationKey = `supplement${sfxNum}`;

  const narration = _compactText(book[narrationKey], 150);
  if (!narration) return null;

  const data = (book[dataKey] && typeof book[dataKey] === 'object') ? book[dataKey] : {};
  let type = SUPPLEMENT_TYPES.has(book[typeKey]) ? book[typeKey] : 'picture';
  if (!_hasStructuredData(type, data)) {
    console.warn(`[v4_video] supplement${sfxNum} ${type} → insight に降格（データ不足）`);
    type = 'insight';
  }

  const title = _cleanText(book[titleKey], 'ここがポイント');
  return _assembleSupplementSlide(type, title, narration, data, book, imagePath);
}

// 旧形式互換: supplement1+supplement2 を結合して1枚の補足スライド
function _buildSupplement(book, imagePath) {
  const narration = _compactText(
    [book.supplement1, book.supplement2].filter(Boolean).join(' '),
    150,
  );
  if (!narration) return null;

  const data = book.supplementData && typeof book.supplementData === 'object'
    ? book.supplementData
    : {};
  let type = SUPPLEMENT_TYPES.has(book.supplementType) ? book.supplementType : 'picture';
  if (!_hasStructuredData(type, data)) {
    console.warn(`[v4_video] ${type} は表示データ不足のため insight に降格`);
    type = 'insight';
  }

  const title = _cleanText(book.supplementTitle || book.supplement1Title, 'ここがポイント');
  return _assembleSupplementSlide(type, title, narration, data, book, imagePath);
}

function _assembleSupplementSlide(type, title, narration, data, book, imagePath) {
  const base = {
    type,
    title,
    narration,
    images: imagePath ? [imagePath] : [],
    bgImage: imagePath || null,
  };

  if (type === 'insight') {
    const phrases = Array.isArray(data.catchphrases)
      ? data.catchphrases.map(x => _cleanText(typeof x === 'string' ? x : x?.text)).filter(Boolean)
      : [];
    base.catchphrases = (phrases.length ? phrases : [narration])
      .filter(Boolean)
      .slice(0, 6);
  } else if (type === 'stats' || type === 'profile') {
    base.siBinding = _cleanText(data.entity, book.mainEntity);
    base.dataSlots = (data.dataSlots || []).slice(0, 8);
  } else if (type === 'comparison') {
    base.siBindingLeft = data.leftName;
    base.siBindingRight = data.rightName;
    base.leftImage = imagePath || null;
    base.rightImage = null;
    base.dataSlots = (data.dataSlots || []).slice(0, 7);
  } else if (type === 'timeline') {
    base.subtitle = _cleanText(data.subtitle);
    base.xLabel = _cleanText(data.xLabel);
    base.yLabel = _cleanText(data.yLabel);
    base.invertY = !!data.invertY;
    base.series = (data.series || []).slice(0, 4);
  } else if (type === 'ranking') {
    base.subtitle = _cleanText(data.subtitle);
    base.items = (data.items || []).slice(0, 5);
  } else if (type === 'matchcard') {
    Object.assign(base, {
      homeTeam: data.homeTeam,
      awayTeam: data.awayTeam,
      homeScore: data.homeScore,
      awayScore: data.awayScore,
      matchDate: data.matchDate,
      matchData: data.matchData,
    });
  } else if (type === 'history') {
    base.events = (data.events || []).slice(0, 6).map(e => ({
      date: _cleanText(e.date),
      title: _cleanText(e.title),
      detail: _cleanText(e.detail),
    }));
  }

  return base;
}

function _buildReaction(title, comments) {
  if (!comments.length) return null;
  return {
    type: 'reaction',
    title,
    comments: comments.slice(0, 4).map((text, i) => ({
      text: _compactText(text, 36),
      score: 100 - i * 10,
    })),
    narration: '',
  };
}

// ── imageAdjust を画像メタから生成 ───────────────────────────
function _imageAdjust(img) {
  if (!img || (img.offsetX === undefined && img.offsetY === undefined)) return undefined;
  return {
    zoom:    img.zoom    || 1.15,  // デフォルトは少し寄り
    offsetX: img.offsetX || 0,
    offsetY: img.offsetY || 0,
  };
}

// ── ネタブック → modules.json ─────────────────────────────────
function buildModules(book) {
  // スコアリング済み画像セットを優先。未スコアなら従来フォールバック。
  const slideImgs = Array.isArray(book.slideImages) ? book.slideImages : [];
  const thumb     = book.thumbnail || null;
  const _pick = (idx) => {
    const img = slideImgs[idx] || thumb;
    return img ? { path: String(img.url || '').replace(/^\//, ''), adj: _imageAdjust(img) } : null;
  };

  // スコアリング済みがなければ従来方式
  const preset = _imagePreset(book);
  const fallbackImage = _selectedImage(book) || _findImage(book.mainEntity);
  if (!preset.length && fallbackImage) preset.push(fallbackImage);

  const thumbPick    = thumb ? { path: String(thumb.url || '').replace(/^\//, ''), adj: _imageAdjust(thumb) } : null;
  const imagePath    = thumbPick?.path || preset[0] || null;
  const imageAdj     = thumbPick?.adj  || undefined;
  const overviewPick = _pick(1) || (preset[1] ? { path: preset[1], adj: undefined } : thumbPick);
  const supp1Pick    = _pick(2) || (preset[2] ? { path: preset[2], adj: undefined } : overviewPick);
  const supp2Pick    = _pick(3) || (preset[3] ? { path: preset[3], adj: undefined } : supp1Pick);
  const suppPick     = supp1Pick;
  const images = imagePath ? [imagePath] : [];
  const threadTitle = book.title || book.hook || book.topic;

  // 新レイアウト: layoutType (info_heavy / comment_heavy)
  // 旧互換: structurePattern (standard / interleaved / rapid)
  const layout = LAYOUT_TYPES.has(book.layoutType)
    ? book.layoutType
    : (book.structurePattern === 'interleaved' ? 'comment_heavy'
       : book.structurePattern === 'rapid' ? 'comment_heavy'
       : 'info_heavy');

  // ── コメント収集・分配 ──
  const allComments = [..._comments(book.comments1), ..._comments(book.comments2)];
  const commentAngles = [
    _cleanText(book.commentAngle1, 'これに対する反応がこちらです。'),
    _cleanText(book.commentAngle2, 'さらにこんな声も。'),
    'こんな意見も届いています。',
  ];

  const opening = {
    type: 'opening',
    title: threadTitle,
    images,
    bgImage:     imagePath || null,
    imageAdjust: imageAdj,
    narration:   threadTitle,
  };

  // ── 概要スライド（独立） ──
  const ovType = book.overviewType === 'insight' ? 'insight' : 'picture';
  const overviewSlide = {
    type: ovType,
    title: '何が起きた？',
    images: overviewPick?.path ? [overviewPick.path] : images,
    bgImage:     overviewPick?.path || imagePath || null,
    imageAdjust: overviewPick?.adj,
    narration:   _compactText(book.overview, 190),
  };
  if (ovType === 'insight') {
    const ovData = book.overviewData || {};
    const phrases = Array.isArray(ovData.catchphrases)
      ? ovData.catchphrases.map(x => _cleanText(typeof x === 'string' ? x : x?.text)).filter(Boolean)
      : [];
    overviewSlide.catchphrases = phrases.length >= 2 ? phrases.slice(0, 6) : [_compactText(book.overview, 42)];
  }

  // ── 補足スライド（それぞれ独立） ──
  let supp1 = null;
  let supp2 = null;
  if (book.supplement1Type || book.supplement2Type) {
    supp1 = _buildSupplementSlide(book, 1, supp1Pick?.path || null);
    supp2 = _buildSupplementSlide(book, 2, supp2Pick?.path || null);
  } else {
    supp1 = _buildSupplement(book, supp1Pick?.path || null);
  }
  if (supp1 && supp1Pick?.adj) supp1.imageAdjust = supp1Pick.adj;
  if (supp2 && supp2Pick?.adj) supp2.imageAdjust = supp2Pick.adj;

  // 補足2: ナレーションが短すぎる場合は省略
  if (supp2 && (supp2.narration || '').length < 30) supp2 = null;

  // ── コメント分配 ──
  const contentSlides = [overviewSlide, supp1, supp2].filter(Boolean);
  const commentsPerSlide = Math.ceil(allComments.length / Math.max(contentSlides.length, 1));
  contentSlides.forEach((slide, i) => {
    const start = i * commentsPerSlide;
    const chunk = allComments.slice(start, start + commentsPerSlide).slice(0, 8);
    if (chunk.length) {
      slide.overlayComments = chunk.map((text, ci) => ({
        text: _compactText(text, 36),
        score: 100 - ci * 10,
      }));
      slide.commentTransition = commentAngles[i] || commentAngles[0];
    }
  });

  const ending = {
    type:          'ending',
    title:         _cleanText(book.endingPunch, 'この話、まだ動きそうだ。'),
    narration:     _cleanText(book.endingPunch, 'この話、まだ動きそうだ。'),
    bgImage:       imagePath || null,
    imageAdjust:   imageAdj,
    endingCta:     { text: '　' },
    nextTopic:     _cleanText(book.endingPunch, ''),
    commentPrompt: 'あなたの予想をコメントで！',
    endingPause:   4,
  };

  // ── 固定構成: op → content1(+comments) → [content2(+comments)] → ed ──
  const modules = [opening, ...contentSlides, ending];

  // 3枚を下回らないよう安全弁（opening + content1 + ending = 最低3枚）
  if (modules.length < 3) {
    modules.splice(1, 0, {
      type: 'insight',
      title: '今回の要点',
      narration: _compactText(book.overview, 120),
      bgImage: imagePath || null,
      catchphrases: [_cleanText(book.overview, threadTitle).slice(0, 42)],
    });
  }

  console.log(`[v4_video] ${modules.length}枚 / ${modules.map(m => m.type).join(' → ')} / comments: ${allComments.length}件分配`);
  return modules;
}

// ── render.js 子プロセス実行 ──────────────────────────────────
function _runRender(postId, jobId, { customTts = false } = {}) {
  return new Promise((resolve, reject) => {
    const tempoEnv = {
      TTS_TARGET_CPS: process.env.V4_TTS_TARGET_CPS || '9.0',
      TTS_PROVIDER: 'voicevox',
      AUDIO_MODE: 'legacy',
      TTS_COMBINED_MODE: '0',
    };
    const proc = spawn('node', [RENDER_JS, postId, jobId], {
      cwd: BASE_DIR,
      env: customTts
        ? { ...process.env, ...tempoEnv, AUDIO_MODE: 'legacy', TTS_COMBINED_MODE: '0' }
        : { ...process.env, ...tempoEnv },
    });
    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('render exit ' + code)));
  });
}

// ── ジョブ管理 ────────────────────────────────────────────────
function _writeJob(jobId, data) {
  fs.writeFileSync(path.join(JOBS_DIR, jobId + '.json'), JSON.stringify(data, null, 2));
}

// ── メイン: 動画生成 ──────────────────────────────────────────
async function generateV4Video(book, providedModules = null) {
  const postId = 'v4_' + safeId(book.topic) + '_' + Date.now();
  const jobId  = 'v4job_' + Date.now();

  console.log('[v4_video] 開始:', postId);

  // si_data: エンティティなし（V4はシンプルなのでデータバインドなし）
  const siData = {
    postId, version: 'v3', createdAt: new Date().toISOString(),
    boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } },
  };
  fs.writeFileSync(path.join(SI_DIR, postId + '.json'), JSON.stringify(siData, null, 2));

  // saved_projects に案件登録
  const savedFile = path.join(DATA_DIR, 'saved_projects.json');
  const saved = fs.existsSync(savedFile)
    ? JSON.parse(fs.readFileSync(savedFile, 'utf8'))
    : [];
  saved.unshift({
    id: postId,
    title: book.topic,
    titleOrig: book.topic,
    createdAt: new Date().toISOString(),
    source: 'v4',
    raw: { selftext: book.overview || '', comments: [] },
  });
  fs.writeFileSync(savedFile, JSON.stringify(saved, null, 2));

  // modules.json 生成
  const modules = Array.isArray(providedModules) && providedModules.length
    ? JSON.parse(JSON.stringify(providedModules))
    : buildModules(book);
  fs.writeFileSync(
    path.join(MODULES_DIR, postId + '_modules.json'),
    JSON.stringify({
      postId,
      modules,
      savedAt: new Date().toISOString(),
      source: 'v4',
      disableToc: true,
    }, null, 2)
  );

  // ジョブ初期化
  _writeJob(jobId, { jobId, status: 'running', postId, createdAt: new Date().toISOString() });

  // render.js 実行
  const customTts = modules.some(module => module?.tts?.provider || module?.tts?.voiceId);
  await _runRender(postId, jobId, { customTts });

  // 出力ファイルを確認
  // render.js は postId.replace(/[\/\?%*:|"<>\.]/g,'_').slice(-20) でファイル名を作る
  const shortId = postId.replace(/[/\\?%*:|"<>.]/g, '_').slice(-20);
  const videoDir = path.join(DATA_DIR, 'v2_videos');
  const videos = fs.existsSync(videoDir)
    ? fs.readdirSync(videoDir).filter(f => f.startsWith(shortId) && f.endsWith('.mp4'))
    : [];

  // サムネ自動生成
  let thumbPath = null;
  try {
    const { generateV4Thumb } = require('./v4_thumb_gen');
    const thumbOut = path.join(videoDir, shortId + '_thumb.png');
    const thumbImage = book.thumbnail?.url || (Array.isArray(book.slideImages) && book.slideImages[0]?.url) || '';
    await generateV4Thumb({
      bgImage:     thumbImage,
      line1:       book.thumbLine1 || book.title || '',
      line2:       book.thumbLine2 || '',
      label1:      book.thumbLabel1 || '',
      label2:      book.thumbLabel2 || '',
      accentColor: '#FFD700',
      bgBrightness: 0.85,
      titleSize:   92,
      outputPath:  thumbOut,
    });
    thumbPath = thumbOut;
    console.log('[v4_video] サムネ生成:', thumbOut);
  } catch (e) {
    console.warn('[v4_video] サムネ生成スキップ:', e.message);
  }

  const result = {
    postId,
    jobId,
    videoPath: videos.length ? path.join(videoDir, videos[0]) : null,
    thumbPath,
    modules: modules.length,
    book,
  };
  console.log('[v4_video] 完了:', result.videoPath || '(ファイル未確認)');
  return result;
}

module.exports = { buildModules, generateV4Video };

// ── CLIテスト ─────────────────────────────────────────────────
if (require.main === module) {
  const sampleBook = {
    topic: 'コナテ、リバプールとの契約延長を拒否',
    hook:  'えっこれマジ？リバポ大ピンチwwww',
    overview:  'イブラヒマ・コナテがリバプールとの契約延長交渉を断り、マドリー移籍へ向けて動き出したと現地報道。',
    scenario1: 'ちなみにコナテ、今季プレミアで対人デュエル勝率78%と欧州CB全体トップ5に入ってたんですよね。',
    scenario2: 'それでリバポ側が提示したのが週給18万ポンド。マドリーの半分以下だったらしいですwww',
    mainEntity: 'Ibrahima Konate',
    reactions: [
      { text: 'マドリーが欲しいなら普通行くやろwwww', score: 3200 },
      { text: '交渉決裂してて笑う', score: 1800 },
      { text: 'コナテいい選手なのに惜しいな', score: 950 },
      { text: 'リバポのCB誰なるんやろ', score: 720 },
      { text: 'まあ選手の人生だしな', score: 430 },
    ],
  };
  generateV4Video(sampleBook).catch(console.error);
}
