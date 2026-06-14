// v4_launcher/scripts/v4_video.js
// ネタブック → V4動画生成パイプライン
//
// 動画構成（2〜3分 / 4〜6枚）:
//   standard:    opening → picture → supplement → reaction → reaction → ending
//   interleaved: opening → picture → reaction → supplement → reaction → ending
//   rapid:       opening → picture → reaction → reaction → ending
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

const STRUCTURE_PATTERNS = new Set(['standard', 'interleaved', 'rapid']);
const SUPPLEMENT_TYPES = new Set([
  'picture', 'insight', 'stats', 'profile',
  'comparison', 'timeline', 'ranking', 'matchcard',
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
  return true;
}

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

  const title = _cleanText(book.supplementTitle, 'ここがポイント');
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
    base.catchphrases = (phrases.length ? phrases : [book.supplement1, book.supplement2])
      .filter(Boolean)
      .slice(0, 6);
  } else if (type === 'stats' || type === 'profile') {
    base.siBinding = _cleanText(data.entity, book.mainEntity);
    base.dataSlots = data.dataSlots.slice(0, 8);
  } else if (type === 'comparison') {
    base.siBindingLeft = data.leftName;
    base.siBindingRight = data.rightName;
    base.leftImage = imagePath || null;
    base.rightImage = null;
    base.dataSlots = data.dataSlots.slice(0, 7);
  } else if (type === 'timeline') {
    base.subtitle = _cleanText(data.subtitle);
    base.xLabel = _cleanText(data.xLabel);
    base.yLabel = _cleanText(data.yLabel);
    base.invertY = !!data.invertY;
    base.series = data.series.slice(0, 4);
  } else if (type === 'ranking') {
    base.subtitle = _cleanText(data.subtitle);
    base.items = data.items.slice(0, 5);
  } else if (type === 'matchcard') {
    Object.assign(base, {
      homeTeam: data.homeTeam,
      awayTeam: data.awayTeam,
      homeScore: data.homeScore,
      awayScore: data.awayScore,
      matchDate: data.matchDate,
      matchData: data.matchData,
    });
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
  const suppPick     = _pick(2) || (preset[2] ? { path: preset[2], adj: undefined } : overviewPick);
  const images = imagePath ? [imagePath] : [];
  const threadTitle = book.title || book.hook || book.topic;
  const pattern = STRUCTURE_PATTERNS.has(book.structurePattern)
    ? book.structurePattern
    : 'standard';

  let c1 = _comments(book.comments1);
  let c2 = _comments(book.comments2);
  if (!c2.length && c1.length >= 5) {
    const half = Math.ceil(c1.length / 2);
    c2 = c1.slice(half);
    c1 = c1.slice(0, half);
  }

  const opening = {
    type: 'opening',
    title: threadTitle,
    images,
    bgImage:     imagePath || null,
    imageAdjust: imageAdj,
    narration:   threadTitle,
  };
  const overview = {
    type: 'picture',
    title: '何が起きた？',
    images: overviewPick?.path ? [overviewPick.path] : images,
    bgImage:     overviewPick?.path || imagePath || null,
    imageAdjust: overviewPick?.adj,
    narration:   _compactText(book.overview, 190),
  };
  const supplement = pattern === 'rapid' ? null : _buildSupplement(book, suppPick?.path || null);
  if (supplement && suppPick?.adj) supplement.imageAdjust = suppPick.adj;
  const reaction1 = _buildReaction(_cleanText(book.commentAngle1, 'ネットの反応'), c1);
  const reaction2 = _buildReaction(_cleanText(book.commentAngle2, 'さらに反応'), c2);
  // 反応スライド: スタジアム/群衆/祝福系 画像を優先
  const rxImg = slideImgs.find(i => ['stadium','celebration','team_group'].includes(i.contentType))
             || slideImgs[3] || thumb;
  const rxPath = rxImg ? String(rxImg.url || '').replace(/^\//, '') : imagePath;
  const rxAdj  = _imageAdjust(rxImg);
  if (reaction1) { reaction1.bgImage = rxPath; if (rxAdj) reaction1.imageAdjust = rxAdj; }
  if (reaction2) { reaction2.bgImage = rxPath; if (rxAdj) reaction2.imageAdjust = rxAdj; }

  const ending = {
    type:        'ending',
    title:       _cleanText(book.endingPunch, 'この話、まだ動きそうだ。'),
    narration:   _cleanText(book.endingPunch, 'この話、まだ動きそうだ。'),
    bgImage:     imagePath || null,
    imageAdjust: imageAdj,
    endingCta:   { text: '　' },
  };

  const middle = pattern === 'interleaved'
    ? [overview, reaction1, supplement, reaction2]
    : [overview, supplement, reaction1, reaction2];
  const modules = [opening, ...middle.filter(Boolean), ending];

  // 反応が少ない案件でも4枚を下回らないよう、補足を復帰させる。
  if (modules.length < 4 && !supplement) {
    const fallbackSupplement = _buildSupplement(book, imagePath);
    if (fallbackSupplement) modules.splice(2, 0, fallbackSupplement);
  }
  if (modules.length < 4) {
    modules.splice(2, 0, {
      type: 'insight',
      title: '今回の要点',
      narration: _compactText(book.overview, 120),
      bgImage: imagePath || null,
      catchphrases: [_cleanText(book.overview, threadTitle).slice(0, 42)],
    });
  }

  console.log(`[v4_video] 構成=${pattern} / ${modules.length}枚 / ${modules.map(m => m.type).join(' → ')}`);
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

  const result = {
    postId,
    jobId,
    videoPath: videos.length ? path.join(videoDir, videos[0]) : null,
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
