// launcher/dashboard.js
// ステップバイステップ操作型ダッシュボード
// node dashboard.js → http://localhost:3456

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const {
  STEPS, RENDER_SUB_STEPS,
  phaseScout, phaseResearch, phasePlan, phaseRender, phaseMeta,
} = require('./pipeline');
const { listPatterns } = require('./slide_patterns');
const { scoutWithAI, callDeepSeek } = require('./scout');
const { generateMods, generateModsForPieces } = require('./script_gen');
const { generateThumbnail } = require('./thumbnail');

// プレビュー用: 実レンダリングと同じスライドビルダー
const { buildInsightHTML }    = require('./slides/insight');
const { buildOpeningHTML }    = require('./slides/opening');
const { buildHistoryHTML }    = require('./slides/history');
const { buildStatsHTML }      = require('./slides/stats');
const { buildMatchcardHTML }  = require('./slides/matchcard');
const { buildComparisonHTML } = require('./slides/comparison');
const { buildEndingHTML }     = require('./slides/ending');
const { injectCommentOverlay } = require('./slides/comments');

const PREVIEW_BUILDERS = {
  opening: buildOpeningHTML, insight: buildInsightHTML, history: buildHistoryHTML,
  stats: buildStatsHTML, matchcard: buildMatchcardHTML, comparison: buildComparisonHTML, ending: buildEndingHTML,
};

// 実ビルダーでスライドHTMLを生成（プレビュー = 本番と同一見た目）
function buildPreviewHTML(mod) {
  const type = mod.type || 'insight';
  const builder = PREVIEW_BUILDERS[type] || buildInsightHTML;
  const m = Object.assign({}, mod, { durationSec: mod.durationSec || 8 });
  let html = builder(m);
  // コメントオーバーレイ（プレビューは簡易タイミングで早めに表示）
  if (type !== 'opening' && type !== 'ending' && Array.isArray(m.comments) && m.comments.length) {
    html = injectCommentOverlay(html, m.comments, 1.0, null, m.durationSec);
  }
  return html;
}

const PORT = 3456;
const SAVED_FILE = path.join(__dirname, 'output', 'saved_topics.json');
const TOPIC_DATA_FILE = path.join(__dirname, 'output', 'topic_data.json');

// ── 永続化 ──────────────────────────────────────────────

function loadSaved() {
  try { return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')); }
  catch (_) { return []; }
}

function saveToDisk(topics) {
  const dir = path.dirname(SAVED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SAVED_FILE, JSON.stringify(topics, null, 2));
}

function loadTopicData() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOPIC_DATA_FILE, 'utf8'));
    const { _activeTopic, _phase, ...topicData } = raw;
    return topicData;
  } catch (_) { return {}; }
}

function saveTopicData() {
  const dir = path.dirname(TOPIC_DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const slim = { _activeTopic: session.activeTopic, _phase: session.phase };
  for (const [k, v] of Object.entries(session.topicData)) {
    slim[k] = {
      summary: v.summary,
      factsForClient: v.factsForClient,
      viewpoints: v.viewpoints || null,
      mods: v.mods || null,
      renderResult: v.renderResult || null,
    };
  }
  fs.writeFileSync(TOPIC_DATA_FILE, JSON.stringify(slim, null, 2));
}

function loadTopicDataWithMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOPIC_DATA_FILE, 'utf8'));
    const { _activeTopic, _phase, ...topicData } = raw;
    return { topicData, activeTopic: _activeTopic || null, phase: _phase || 'idle' };
  } catch (_) { return { topicData: {}, activeTopic: null, phase: 'idle' }; }
}

// ── ギャラリー画像集約（取得元ラベル付き）─────────────
// X公式（ラベルごと）/ 選手 / ロゴ / 記事 を {url, label, group} で返す。
// Step2 のラベル別一覧と Step4 ギャラリーの両方で使う。
function collectGalleryImages(facts) {
  const images = [];
  if (!facts) return images;
  // X公式画像（source = "@ハンドル (team/top)" 等の取得元ラベル）
  (facts.xImages || []).forEach(xi => {
    if (!xi.url || !xi.url.startsWith('http')) return;
    const group = (xi.source || 'X公式').replace(/\s*\(.*\)\s*$/, '');  // top/latest をまとめる
    images.push({ url: xi.url, label: xi.source || 'X公式', group });
  });
  // 選手画像（FotMob/SofaScore — data URI のことあり）
  const playerImg = facts.playerData?.photo || facts.playerData?.imageUrl || null;
  if (playerImg) images.push({ url: playerImg, label: facts.playerData.name || '選手', group: '選手' });
  // チームロゴ
  if (facts.matchData?.homeLogo) images.push({ url: facts.matchData.homeLogo, label: facts.matchData.homeTeam || 'Home', group: 'ロゴ' });
  if (facts.matchData?.awayLogo) images.push({ url: facts.matchData.awayLogo, label: facts.matchData.awayTeam || 'Away', group: 'ロゴ' });
  // 記事サムネイル
  (facts.articles || []).forEach(a => {
    const url = a.imageUrl || a.image || a.thumbnail || null;
    if (url && url.startsWith('http')) images.push({ url, label: (a.title || '').slice(0, 40), group: '記事' });
  });
  // 重複除去
  const seen = new Set();
  return images.filter(img => { if (seen.has(img.url)) return false; seen.add(img.url); return true; });
}

// ── HTTP サーバー ────────────────────────────────────

// プレビュー用: 最後にリクエストされた mod をここに保持
let lastPreviewMod = null;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    // no-cache: スマホSafari等が古いHTMLを掴み続けるのを防ぐ
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(fs.readFileSync(path.join(__dirname, 'web', 'index.html')));
    return;
  }
  // /preview — iframe が直接 GET して HTML を受け取る（srcdoc を使わない）
  if (req.url.startsWith('/preview')) {
    try {
      const html = lastPreviewMod ? buildPreviewHTML(lastPreviewMod) : '<body style="background:#060e1c;color:#fff;padding:40px;font-size:32px">プレビューなし</body>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<body style="background:#1a0000;color:#f88;padding:40px;font-size:28px">エラー: ${e.message}</body>`);
    }
    return;
  }
  if (req.url === '/mia.jpg') {
    const imgPath = path.join(__dirname, 'web', 'mia.jpg');
    if (fs.existsSync(imgPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(imgPath).pipe(res);
      return;
    }
  }
  if (req.url.startsWith('/output/')) {
    let decodedUrl; try { decodedUrl = decodeURIComponent(req.url); } catch (_) { decodedUrl = req.url; }
    const filePath = path.join(__dirname, decodedUrl);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const types = { '.mp4': 'video/mp4', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
      const contentType = types[ext] || 'application/octet-stream';
      const stat = fs.statSync(filePath);
      const total = stat.size;
      const range = req.headers.range;
      if (range && ext === '.mp4') {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end = endStr ? parseInt(endStr, 10) : total - 1;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Length': total,
        });
        fs.createReadStream(filePath).pipe(res);
      }
      return;
    }
  }
  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket ────────────────────────────────────────

const wss = new WebSocket.Server({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ── セッション状態 ───────────────────────────────────

const _savedMeta = loadTopicDataWithMeta();
let session = {
  phase: _savedMeta.phase === 'done' ? 'done' : 'idle',
  topics: null,
  savedTopics: loadSaved(),
  topicData: _savedMeta.topicData,
  factsCache: {},
  activeTopic: _savedMeta.activeTopic,
  facts: null,
  viewpoints: null,
  renderResult: null,
};

function resetSession() {
  session = {
    phase: 'idle', topics: null,
    savedTopics: session.savedTopics,
    topicData: session.topicData,
    factsCache: session.factsCache,
    activeTopic: null, facts: null, viewpoints: null, renderResult: null,
  };
}

// ── console インターセプト ────────────────────────────

let origLog, origWarn, origErr;

function interceptConsole() {
  origLog  = console.log;
  origWarn = console.warn;
  origErr  = console.error;
  const wrap = (level, orig) => (...args) => {
    orig.apply(console, args);
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    broadcast({ type: 'log', level, text });
  };
  console.log   = wrap('info',  origLog);
  console.warn  = wrap('warn',  origWarn);
  console.error = wrap('error', origErr);
}

function restoreConsole() {
  if (origLog)  console.log   = origLog;
  if (origWarn) console.warn  = origWarn;
  if (origErr)  console.error = origErr;
}

// ── Step 1: Scout ────────────────────────────────────

async function runScout() {
  session.phase = 'scouting';
  interceptConsole();
  broadcast({ type: 'phase', phase: 'scouting' });

  try {
    const topics = await scoutWithAI();
    session.topics = topics;
    session.phase = 'topics_ready';
    broadcast({ type: 'topics_ready', topics });
  } catch (err) {
    broadcast({ type: 'error', detail: err.message });
    session.phase = 'idle';
  } finally {
    restoreConsole();
  }
}

// ── Step 2: Research ─────────────────────────────────

async function analyzeTopic(topicTitle) {
  try {
    const result = await callDeepSeek(
      `サッカーのニューストピックから必要な情報を英語で抽出してください。
選手名はフルネーム（例: Lionel Messi, Takefusa Kubo）、チーム名は英語で。
JSON形式:
{
  "homeTeam": "Japan" or null,
  "awayTeam": "Sweden" or null,
  "playerName": "Lionel Messi" or null,
  "searchQuery": "3〜4語の検索キーワード（英語。例: Vinicius VAR Brazil protest）",
  "labels": [
    {"type": "player", "name": "Vinícius Júnior", "team": "Real Madrid", "nationalTeam": "Brazil"},
    {"type": "team", "name": "Brazil"},
    {"type": "team", "name": "Colombia"}
  ]
}
labelsルール: 3〜5個。記事がなくてもトピック名から推測して生成する。
topicTypeが試合なら type:"match" を含める（homeTeam/awayTeam必須）。
type:"team" のname は英語チーム名。type:"player" は英語名・所属(team)・代表(nationalTeam or null)。`,
      topicTitle
    );
    console.log(`  [analyze] teams: ${result.homeTeam || '—'} vs ${result.awayTeam || '—'}, player: ${result.playerName || '—'}, labels: ${(result.labels || []).length}件`);
    return result;
  } catch (err) {
    console.warn(`  [analyze] failed: ${err.message}`);
    return {};
  }
}

async function translateComments(samples) {
  if (!samples.length) return [];
  const numbered = samples.map((c, i) => `${i}. ${c}`).join('\n');
  try {
    const result = await callDeepSeek(
      `以下のサッカー関連コメントを処理してください:
- 英語コメント → 面白く自然な日本語に意訳（ネットの口語調OK、元のニュアンスは保つ）
- 日本語で120文字以上のコメント → 要点を80文字以内に短縮
- 短い日本語コメント → そのまま
元の件数と同じ数だけ、同じ順序で返してください。
JSON: {"comments": ["コメント1", "コメント2", ...]}`,
      numbered
    );
    return result.comments || samples;
  } catch (err) {
    console.warn(`  [translate] failed: ${err.message}`);
    return samples;
  }
}

// DeepSeek が返した labels を使いつつ、空なら extracted 情報からフォールバック生成
function buildLabels(facts, fallbackLabels = []) {
  const ex = facts.extracted || null;
  let labels = (ex?.labels && Array.isArray(ex.labels) && ex.labels.length > 0)
    ? ex.labels
    : (fallbackLabels.length > 0 ? fallbackLabels : []);

  if (!labels.length && ex) {
    // フォールバック: homeTeam/awayTeam/playerName から最低限のラベルを作る
    if (ex.homeTeam && ex.awayTeam) {
      labels.push({ type: 'match', homeTeam: ex.homeTeam, awayTeam: ex.awayTeam, matchDate: ex.matchDate || null, competition: ex.competition || null });
      labels.push({ type: 'team', name: ex.homeTeam });
      labels.push({ type: 'team', name: ex.awayTeam });
    }
    if (ex.playerName) {
      labels.push({ type: 'player', name: ex.playerName, team: ex.homeTeam || null, nationalTeam: null });
    }
  }

  // FotMob取得済みデータからも補完（matchData / playerData）
  if (facts.matchData?.ok && !labels.some(l => l.type === 'match')) {
    labels.unshift({ type: 'match', homeTeam: facts.matchData.homeTeam, awayTeam: facts.matchData.awayTeam, matchDate: facts.matchData.matchDate || null, competition: facts.matchData.tournament || null });
  }
  if (facts.playerData?.ok && !labels.some(l => l.type === 'player')) {
    labels.push({ type: 'player', name: facts.playerData.name, team: facts.playerData.team || null, nationalTeam: null });
  }

  // 最終フォールバック: ex も matchData も取れなかった場合、トピック名から推定
  if (!labels.length && facts.topic) {
    const t = facts.topic;
    const vsM = t.match(/(.+?)\s+(?:vs?\.?|対|×)\s+(.+)/i);
    if (vsM) {
      labels.push({ type: 'match', homeTeam: vsM[1].trim(), awayTeam: vsM[2].trim(), matchDate: null, competition: null });
    } else {
      // 選手/チームとして登録（ユーザーが後で編集できる）
      labels.push({ type: 'player', name: t.replace(/【.*?】/g, '').trim().slice(0, 60), team: null, nationalTeam: null });
    }
  }

  return labels;
}

async function runResearch(topicTitle) {
  session.activeTopic = topicTitle;
  session.facts = null;
  session.viewpoints = null;
  session.phase = 'researching';
  interceptConsole();
  broadcast({ type: 'phase', phase: 'researching', topic: topicTitle });

  try {
    const analysis = await analyzeTopic(topicTitle);
    const { facts, summary } = await phaseResearch(topicTitle, {
      homeTeam: analysis.homeTeam || null,
      awayTeam: analysis.awayTeam || null,
      playerName: analysis.playerName || null,
      searchQuery: analysis.searchQuery || null,
    });
    session.facts = facts;
    session.factsCache[topicTitle] = facts;

    // ソース情報を保持しながらサンプル収集（最大10件×3ソース=30件）
    const rawWithSrc = [];
    for (const src of ['reddit', 'yahoo', 'x']) {
      (facts.comments?.[src] || []).slice(0, 10).forEach(c => {
        rawWithSrc.push({ text: typeof c === 'string' ? c : c.text, source: src });
      });
    }

    console.log(`  [translate] ${rawWithSrc.length}件のコメントを処理中...`);
    const translatedTexts = await translateComments(rawWithSrc.map(c => c.text));
    // 翻訳テキストと元のソースを再合成
    const allComments = rawWithSrc.map((c, i) => ({
      text: (translatedTexts[i] || c.text).slice(0, 50),
      source: c.source,
    }));
    const processed = allComments.map(c => c.text);  // 後方互換

    const factsForClient = {
      topic: facts.topic,
      articles: (facts.articles || []).map(a => ({ title: a.title, url: a.url, textLen: (a.text || '').length })),
      matchData: facts.matchData ? { ok: true, scoreline: facts.matchData.scoreline } : null,
      playerData: facts.playerData ? { ok: true, name: facts.playerData.name, team: facts.playerData.team } : null,
      extracted: facts.extracted || null,
      labels: buildLabels(facts, analysis.labels || []),
      xImagesCount: (facts.xImages || []).length,
      comments: {
        reddit: (facts.comments?.reddit || []).length,
        yahoo: (facts.comments?.yahoo || []).length,
        x: (facts.comments?.x || []).length,
        total: (facts.comments?.all || []).length,
        samples: processed,
        all: allComments,  // {text, source} 配列 → コメント倉庫で使用
      },
    };

    session.topicData[topicTitle] = { summary, factsForClient };
    saveTopicData();

    session.phase = 'facts_ready';
    broadcast({ type: 'facts_ready', summary, facts: factsForClient, topic: topicTitle });
    broadcast({ type: 'saved_topics', savedTopics: session.savedTopics, researchedTopics: Object.keys(session.topicData) });
  } catch (err) {
    broadcast({ type: 'error', detail: err.message });
    session.phase = 'idle';
  } finally {
    restoreConsole();
  }
}

// ── Step 3: Plan ─────────────────────────────────────

async function runPlan() {
  if (!session.facts) return;
  session.phase = 'planning';
  interceptConsole();
  broadcast({ type: 'phase', phase: 'planning' });

  try {
    const viewpoints = await phasePlan(session.facts);
    session.viewpoints = viewpoints;
    session.phase = 'plan_ready';

    if (session.activeTopic && session.topicData[session.activeTopic]) {
      session.topicData[session.activeTopic].viewpoints = viewpoints;
      saveTopicData();
    }

    broadcast({ type: 'plan_ready', viewpoints, patterns: listPatterns() });
  } catch (err) {
    broadcast({ type: 'error', detail: err.message });
    session.phase = 'facts_ready';
  } finally {
    restoreConsole();
  }
}

// ── Step 4: Render ───────────────────────────────────

async function runRender(viewpointIndex, edits, prebuiltMods = null) {
  if (!session.viewpoints) return;
  session.phase = 'rendering';
  interceptConsole();

  const vp = { ...session.viewpoints[viewpointIndex || 0] };

  if (edits) {
    if (edits.title) vp.title = edits.title;
    if (edits.suggestedPattern) vp.suggestedPattern = edits.suggestedPattern;
  }
  const videoTopic = vp.title || session.activeTopic;
  const patternKey = vp.suggestedPattern || 'match_result';
  session.renderingTopic = videoTopic;
  session.renderingPatternKey = patternKey;

  broadcast({ type: 'phase', phase: 'rendering', topic: videoTopic, patternKey });

  try {
    if (!session.facts) session.facts = session.factsCache[session.activeTopic] || null;

    const emitter = new EventEmitter();
    emitter.on('pipeline', (evt) => broadcast(evt));

    const result = await phaseRender(videoTopic, patternKey, session.facts, emitter, prebuiltMods);
    session.renderResult = result;
    const meta = await phaseMeta(result);

    session.phase = 'done';
    const videoUrl = `/output/${path.basename(result.outputDir)}/final.mp4`;
    const thumbnailUrl = result.thumbnailPath ? `/output/${path.basename(result.outputDir)}/thumbnail.jpg` : null;

    if (session.activeTopic && session.topicData[session.activeTopic]) {
      session.topicData[session.activeTopic].renderResult = { videoUrl, thumbnailUrl, outputDir: result.outputDir, totalDuration: result.totalDuration, patternKey, topic: videoTopic, meta };
      session.topicData[session.activeTopic].mods = result.mods;
      saveTopicData();
    }

    broadcast({ type: 'done', topic: videoTopic, patternKey, totalDuration: result.totalDuration, videoUrl, thumbnailUrl, meta, mods: result.mods });
  } catch (err) {
    broadcast({ type: 'error', detail: err.message });
    session.phase = 'plan_ready';
  } finally {
    restoreConsole();
  }
}

// pieces_N 用レンダー（prebuiltMods 必須）
async function runRenderWithMods(patternKey, videoTopic, prebuiltMods) {
  if (!prebuiltMods || !prebuiltMods.length) {
    broadcast({ type: 'error', detail: 'mods がありません。先に脚本を生成してください。' });
    return;
  }
  session.phase = 'rendering';
  session.renderingTopic = videoTopic;
  session.renderingPatternKey = patternKey;
  interceptConsole();
  broadcast({ type: 'phase', phase: 'rendering', topic: videoTopic, patternKey });
  try {
    if (!session.facts) {
      const td = session.topicData[session.activeTopic];
      session.facts = session.factsCache[session.activeTopic] || td?.factsForClient || null;
    }
    const emitter = new EventEmitter();
    emitter.on('pipeline', (evt) => broadcast(evt));
    const result = await phaseRender(videoTopic, patternKey, session.facts, emitter, prebuiltMods);
    session.renderResult = result;
    const meta = await phaseMeta(result);
    session.phase = 'done';
    const videoUrl = `/output/${path.basename(result.outputDir)}/final.mp4`;
    const thumbnailUrl = result.thumbnailPath ? `/output/${path.basename(result.outputDir)}/thumbnail.jpg` : null;
    if (session.activeTopic && session.topicData[session.activeTopic]) {
      session.topicData[session.activeTopic].renderResult = { videoUrl, thumbnailUrl, outputDir: result.outputDir, totalDuration: result.totalDuration, patternKey, topic: videoTopic, meta };
      session.topicData[session.activeTopic].mods = result.mods;
      saveTopicData();
    }
    broadcast({ type: 'done', topic: videoTopic, patternKey, totalDuration: result.totalDuration, videoUrl, thumbnailUrl, meta, mods: result.mods });
  } catch (err) {
    broadcast({ type: 'error', detail: err.message });
    session.phase = 'plan_ready';
  } finally {
    restoreConsole();
  }
}

// ── WebSocket 接続 ───────────────────────────────────

wss.on('connection', (ws) => {
  const activeData = session.activeTopic ? session.topicData[session.activeTopic] : null;
  ws.send(JSON.stringify({
    type: 'hello',
    phase: session.phase,
    topics: session.topics,
    savedTopics: session.savedTopics,
    researchedTopics: Object.keys(session.topicData),
    activeTopic: session.activeTopic,
    activeFacts: activeData ? activeData.factsForClient : null,
    activeSummary: activeData ? activeData.summary : null,
    activeViewpoints: activeData && activeData.viewpoints ? activeData.viewpoints : null,
    activeRenderResult: activeData && activeData.renderResult ? activeData.renderResult : null,
    activeMods: activeData && activeData.mods ? activeData.mods : null,
    renderingTopic: session.phase === 'rendering' ? session.renderingTopic : null,
    renderingPatternKey: session.phase === 'rendering' ? session.renderingPatternKey : null,
    patterns: listPatterns(),
    steps: STEPS,
    renderSubSteps: RENDER_SUB_STEPS,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.action === 'scout') {
      const scoutOk = ['idle','done','topics_ready','facts_ready','plan_ready','script_ready'];
      if (!scoutOk.includes(session.phase)) {
        ws.send(JSON.stringify({ type: 'error', detail: '処理中です' }));
        return;
      }
      session.topics = null;
      session.phase = 'idle';
      runScout();
    }

    if (msg.action === 'save_topics') {
      const indices = msg.indices || [];
      if (!session.topics) return;
      const newTopics = indices
        .map(i => session.topics[i])
        .filter(Boolean)
        .filter(t => !session.savedTopics.some(s => s.title === t.title));
      session.savedTopics.push(...newTopics);
      saveToDisk(session.savedTopics);
      broadcast({ type: 'saved_topics', savedTopics: session.savedTopics, researchedTopics: Object.keys(session.topicData) });
    }

    if (msg.action === 'remove_saved') {
      const idx = msg.index;
      if (idx >= 0 && idx < session.savedTopics.length) {
        session.savedTopics.splice(idx, 1);
        saveToDisk(session.savedTopics);
        broadcast({ type: 'saved_topics', savedTopics: session.savedTopics, researchedTopics: Object.keys(session.topicData) });
      }
    }

    if (msg.action === 'activate') {
      const topic = session.savedTopics[msg.index];
      if (!topic) return;
      const cached = session.topicData[topic.title];
      if (cached) {
        session.activeTopic = topic.title;
        session.facts = session.factsCache[topic.title] || null;
        session.viewpoints = cached.viewpoints || null;
        session.phase = cached.viewpoints ? 'plan_ready' : 'facts_ready';
        // 旧キャッシュに labels がない場合は再構築して保存
        if (!cached.factsForClient.labels) {
          cached.factsForClient.labels = buildLabels(cached.factsForClient);
          saveTopicData();
        }
        broadcast({ type: 'facts_ready', summary: cached.summary, facts: cached.factsForClient, topic: topic.title });
        if (cached.viewpoints) broadcast({ type: 'plan_ready', viewpoints: cached.viewpoints, patterns: listPatterns() });
        if (cached.renderResult) broadcast({ type: 'done', ...cached.renderResult, mods: cached.mods || null });
        else if (cached.mods) broadcast({ type: 'script_ready', mods: cached.mods, topic: topic.title });
      } else {
        runResearch(topic.title);
      }
    }

    if (msg.action === 'plan') {
      if (!session.activeTopic) return;
      if (!msg.force) {
        const cached = session.topicData[session.activeTopic];
        if (cached && cached.viewpoints) {
          session.viewpoints = cached.viewpoints;
          session.phase = 'plan_ready';
          broadcast({ type: 'plan_ready', viewpoints: cached.viewpoints, patterns: listPatterns() });
          return;
        }
      }
      if (!session.facts) session.facts = session.factsCache[session.activeTopic] || null;
      // サーバー再起動後は factsCache が空 → topicData の factsForClient で代替
      if (!session.facts) {
        const td = session.topicData[session.activeTopic];
        if (td?.factsForClient) session.facts = td.factsForClient;
      }
      if (!session.facts) {
        broadcast({ type: 'error', detail: '情報収集データがありません。先に情報収集を実行してください。' });
        return;
      }
      runPlan();
    }

    if (msg.action === 'render') {
      const cachedMods = session.topicData[session.activeTopic]?.mods;
      const isPieces = msg.patternKey?.startsWith('pieces_') || cachedMods?.some(m => m.type);
      if (isPieces) {
        const prebuiltMods = msg.mods || cachedMods;
        const patternKey   = msg.patternKey || `pieces_${(prebuiltMods?.length || 3) - 2}`;
        const videoTopic   = msg.topic || session.activeTopic;
        runRenderWithMods(patternKey, videoTopic, prebuiltMods);
      } else {
        if (!session.viewpoints || !session.viewpoints.length) {
          broadcast({ type: 'error', detail: '企画ピースがありません。先にStep 3を実行してください。' });
          return;
        }
        runRender(msg.viewpointIndex, msg.edits);
      }
    }

    if (msg.action === 'generate_script') {
      if (!session.activeTopic) return;
      if (!session.facts) session.facts = session.factsCache[session.activeTopic] || null;
      if (!session.facts) {
        const td = session.topicData[session.activeTopic];
        if (td?.factsForClient) session.facts = td.factsForClient;
      }
      if (!session.facts) {
        ws.send(JSON.stringify({ type: 'error', detail: '情報収集データがありません。先に Step 2 を実行してください。' }));
        return;
      }
      // viewpoints も topicData から復元
      if (!session.viewpoints && session.activeTopic && session.topicData[session.activeTopic]) {
        session.viewpoints = session.topicData[session.activeTopic].viewpoints || null;
      }
      if (!session.viewpoints || !session.viewpoints.length) {
        ws.send(JSON.stringify({ type: 'error', detail: '企画ピースがありません。先に Step 3 を実行してください。' }));
        return;
      }
      interceptConsole();
      broadcast({ type: 'phase', phase: 'generating_script' });
      try {
        let patternKey, mods, videoTopic;

        if (msg.selectedViewpoints && msg.selectedViewpoints.length) {
          // 企画ピース選択モード（pieces_1 or pieces_2）
          const result = await generateModsForPieces(msg.selectedViewpoints, session.facts);
          patternKey = result.patternKey;
          mods       = result.mods;
          videoTopic = msg.selectedViewpoints[0].title || session.activeTopic;
        } else {
          // 従来モード（viewpointIndex 指定）
          const vp = session.viewpoints[msg.viewpointIndex != null ? msg.viewpointIndex : 0];
          if (!vp) return;
          videoTopic = (msg.edits && msg.edits.title) || vp.title || session.activeTopic;
          patternKey = (msg.edits && msg.edits.suggestedPattern) || vp.suggestedPattern || 'match_result';
          mods = await generateMods(patternKey, videoTopic, session.facts);
        }

        if (session.topicData[session.activeTopic]) {
          session.topicData[session.activeTopic].mods = mods;
          saveTopicData();
        }
        broadcast({ type: 'script_ready', mods, topic: videoTopic, patternKey });
      } catch (err) {
        broadcast({ type: 'error', detail: err.message });
      } finally {
        restoreConsole();
      }
    }

    if (msg.action === 'update_mods') {
      if (!session.activeTopic) return;
      if (!session.topicData[session.activeTopic]) session.topicData[session.activeTopic] = {};
      session.topicData[session.activeTopic].mods = msg.mods;
      saveTopicData();
      ws.send(JSON.stringify({ type: 'mods_saved' }));
    }

    if (msg.action === 're_render') {
      const mods = msg.mods;
      if (session.activeTopic && session.topicData[session.activeTopic] && mods) {
        session.topicData[session.activeTopic].mods = mods;
        saveTopicData();
      }
      // mods に type が入っていれば pieces フロー
      if (mods && mods.some(m => m.type)) {
        const patternKey = `pieces_${(mods.length || 3) - 2}`;
        const videoTopic = msg.topic || session.activeTopic;
        runRenderWithMods(patternKey, videoTopic, mods);
      } else {
        if (!session.viewpoints || !session.viewpoints.length) {
          broadcast({ type: 'error', detail: '企画データがありません。Step 3 を先に実行してください。' });
          return;
        }
        runRender(msg.viewpointIndex || 0, msg.edits, mods);
      }
    }

    // ラベルを使ってX公式画像を再取得（Step2から呼ばれる）
    if (msg.action === 'fetch_x_images') {
      const labels = msg.labels || [];
      if (!labels.length) {
        ws.send(JSON.stringify({ type: 'gallery_images', images: [] }));
        return;
      }
      try {
        broadcast({ type: 'phase', phase: 'fetching_x_images' });
        const { fetchImagesForLabels } = require('./fetchers/x_images');
        const TIMEOUT_MS = 25000;
        const xImages = await Promise.race([
          fetchImagesForLabels(labels),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
        ]);
        // factsCache / topicData を更新
        if (!session.facts) session.facts = {};
        session.facts.xImages = xImages;
        if (session.activeTopic && session.topicData[session.activeTopic]) {
          session.topicData[session.activeTopic].factsForClient.xImagesCount = xImages.length;
          session.topicData[session.activeTopic].factsForClient.labels = labels;
        }
        // 取得元ラベル付きで全画像（X + 選手 + ロゴ + 記事）を送る
        broadcast({ type: 'gallery_images', images: collectGalleryImages(session.facts) });
        broadcast({ type: 'x_images_ready', count: xImages.length });
      } catch (err) {
        // タイムアウト or エラーでも gallery_images を返してブロック解除
        broadcast({ type: 'gallery_images', images: [] });
        broadcast({ type: 'x_images_ready', count: 0 });
        console.warn(`  [fetch_x_images] ${err.message}`);
      }
    }

    // ── V3式: 単一ラベルのデータ取得（ラベルカードの「データ取得」ボタン）──
    if (msg.action === 'fetch_label_data') {
      const label = msg.label;
      const labelKey = msg.labelKey;
      if (!label) { ws.send(JSON.stringify({ type: 'label_data_ready', labelKey, error: 'no label' })); return; }
      broadcast({ type: 'phase', phase: 'fetching_data' });
      const { fetchMatch, fetchPlayer, fetchTeam } = require('./research');
      const out = { type: 'label_data_ready', labelKey, matchData: null, playerData: null, teamData: null, images: [] };
      try {
        if (!session.facts) session.facts = {};
        if (label.type === 'match' && label.homeTeam && label.awayTeam) {
          const md = await fetchMatch(label.homeTeam, label.awayTeam);
          if (md.ok) {
            session.facts.matchData = md;
            out.matchData = { ok: true, scoreline: md.scoreline, homeTeam: md.homeTeam, awayTeam: md.awayTeam, tournament: md.tournament };
            if (md.homeLogo) out.images.push({ url: md.homeLogo, label: md.homeTeam || 'Home', group: 'ロゴ' });
            if (md.awayLogo) out.images.push({ url: md.awayLogo, label: md.awayTeam || 'Away', group: 'ロゴ' });
          } else out.matchData = { ok: false, error: md.error };
        } else if (label.type === 'player' && label.name) {
          const pd = await fetchPlayer(label.name);
          if (pd.ok) {
            session.facts.playerData = pd;
            let matchStats = null;
            const mdFull = session.facts.matchData;
            if (mdFull?.playerStats && pd.playerId) { const ps = mdFull.playerStats[String(pd.playerId)]; if (ps) matchStats = ps.stats; }
            out.playerData = {
              ok: true, playerId: pd.playerId, name: pd.name, position: pd.position, age: pd.age,
              nationality: pd.nationality, team: pd.team, leagueName: pd.leagueName, marketValue: pd.marketValue,
              marketValueHistory: pd.marketValueHistory || [], seasonStats: pd.seasonStats, nationalTeam: pd.nationalTeam,
              recentAvgRating: pd.recentAvgRating, matchStats,
            };
            if (pd.photo) out.images.push({ url: pd.photo, label: pd.name || '選手', group: '選手' });
          } else out.playerData = { ok: false, error: pd.error };
        } else if (label.type === 'team' && label.name) {
          const td = await fetchTeam(label.name);
          out.teamData = td;
          if (td && td.ok) {
            session.facts.teamData = session.facts.teamData || [];
            const idx = session.facts.teamData.findIndex(t => t.name === td.name);
            if (idx >= 0) session.facts.teamData[idx] = td; else session.facts.teamData.push(td);
            const logo = td.logo || td.teamLogo || td.crest || null;
            if (logo) out.images.push({ url: logo, label: td.name || 'Team', group: 'ロゴ' });
          }
        } else {
          out.error = 'このラベルはデータ取得に対応していません';
        }
        // factsForClient へ反映
        if (session.activeTopic && session.topicData[session.activeTopic]) {
          const fc = session.topicData[session.activeTopic].factsForClient;
          if (out.matchData)  fc.matchData  = out.matchData;
          if (out.playerData) fc.playerData = out.playerData;
          saveTopicData();
        }
      } catch (err) {
        out.error = err.message;
      }
      ws.send(JSON.stringify(out));
    }

    // ── V3式: 単一ラベルの画像取得（ラベルカードの「画像取得」ボタン）──
    if (msg.action === 'fetch_label_images') {
      const label = msg.label;
      const labelKey = msg.labelKey;
      if (!label) { ws.send(JSON.stringify({ type: 'label_images_ready', labelKey, images: [] })); return; }
      broadcast({ type: 'phase', phase: 'fetching_x_images' });
      try {
        const { fetchImagesForLabels } = require('./fetchers/x_images');
        const TIMEOUT_MS = 25000;
        const xImages = await Promise.race([
          fetchImagesForLabels([label]),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
        ]);
        if (!session.facts) session.facts = {};
        // facts.xImages へマージ（重複除去）
        const existing = session.facts.xImages || [];
        const seen = new Set(existing.map(x => x.url));
        xImages.forEach(xi => { if (!seen.has(xi.url)) { existing.push(xi); seen.add(xi.url); } });
        session.facts.xImages = existing;
        if (session.activeTopic && session.topicData[session.activeTopic]) {
          session.topicData[session.activeTopic].factsForClient.xImagesCount = existing.length;
          saveTopicData();
        }
        const images = xImages
          .filter(xi => xi.url && xi.url.startsWith('http'))
          .map(xi => ({ url: xi.url, label: xi.source || 'X公式', group: (xi.source || 'X公式').replace(/\s*\(.*\)\s*$/, '') }));
        ws.send(JSON.stringify({ type: 'label_images_ready', labelKey, images }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'label_images_ready', labelKey, images: [], error: err.message }));
        console.warn(`  [fetch_label_images] ${err.message}`);
      }
    }

    // ラベルに基づいて試合/選手データを取得（Step2 データ取得ボタンから呼ばれる）
    if (msg.action === 'fetch_data') {
      const labels = msg.labels || [];
      const matchLabel  = labels.find(l => l.type === 'match');
      const playerLabel = labels.find(l => l.type === 'player');
      const homeTeam  = matchLabel?.homeTeam || null;
      const awayTeam  = matchLabel?.awayTeam || null;
      const playerName = playerLabel?.name || null;

      const teamLabels = labels.filter(l => l.type === 'team');

      if (!homeTeam && !awayTeam && !playerName && !teamLabels.length) {
        ws.send(JSON.stringify({ type: 'data_ready', matchData: null, playerData: null, teamData: [], error: 'ラベルにチーム名・選手名がありません' }));
        return;
      }

      broadcast({ type: 'phase', phase: 'fetching_data' });
      const { fetchMatch, fetchPlayer, fetchTeam } = require('./research');
      const result = { matchData: null, playerData: null, teamData: [] };

      if (homeTeam && awayTeam) {
        try {
          const md = await fetchMatch(homeTeam, awayTeam);
          if (md.ok) {
            if (!session.facts) session.facts = {};
            session.facts.matchData = md;
            result.matchData = { ok: true, scoreline: md.scoreline, homeTeam: md.homeTeam, awayTeam: md.awayTeam, tournament: md.tournament };
          } else {
            result.matchData = { ok: false, error: md.error };
          }
        } catch (err) {
          result.matchData = { ok: false, error: err.message };
        }
      }

      if (playerName) {
        try {
          const pd = await fetchPlayer(playerName);
          if (pd.ok) {
            if (!session.facts) session.facts = {};
            session.facts.playerData = pd;
            // 今試合スタッツを matchData.playerStats から紐付け
            let matchStats = null;
            const mdFull = session.facts.matchData;
            if (mdFull?.playerStats && pd.playerId) {
              const key = String(pd.playerId);
              const ps = mdFull.playerStats[key];
              if (ps) matchStats = ps.stats;
            }
            result.playerData = {
              ok: true,
              playerId: pd.playerId,
              name: pd.name,
              position: pd.position,
              age: pd.age,
              nationality: pd.nationality,
              team: pd.team,
              leagueName: pd.leagueName,
              seasonYear: pd.seasonYear,
              marketValue: pd.marketValue,
              marketValueHistory: pd.marketValueHistory || [],
              seasonStats: pd.seasonStats,
              nationalTeam: pd.nationalTeam,
              recentAvgRating: pd.recentAvgRating,
              last5Matches: pd.last5Matches,
              currentClub: pd.currentClub,
              playerCareer: pd.playerCareer,
              photo: pd.photo,
              matchStats,
            };
          } else {
            result.playerData = { ok: false, error: pd.error };
          }
        } catch (err) {
          result.playerData = { ok: false, error: err.message };
        }
      }

      if (teamLabels.length) {
        const teamResults = await Promise.all(teamLabels.map(async (tl) => {
          try {
            return await fetchTeam(tl.name);
          } catch (err) {
            return { ok: false, name: tl.name, error: err.message };
          }
        }));
        result.teamData = teamResults;
        if (!session.facts) session.facts = {};
        session.facts.teamData = teamResults;
      }

      // factsForClient を更新して topicData に保存
      if (session.activeTopic && session.topicData[session.activeTopic]) {
        const fc = session.topicData[session.activeTopic].factsForClient;
        if (result.matchData)  fc.matchData  = result.matchData;
        if (result.playerData) fc.playerData = result.playerData;
        if (result.teamData.length) fc.teamData = result.teamData;
        saveTopicData();
      }

      broadcast({ type: 'data_ready', ...result });
    }

    if (msg.action === 'get_gallery_images') {
      ws.send(JSON.stringify({ type: 'gallery_images', images: collectGalleryImages(session.facts) }));
    }

    // スライドプレビュー: mod を保存して ready を返す（HTML は /preview エンドポイントで返す）
    if (msg.action === 'preview_slide') {
      lastPreviewMod = msg.mod || {};
      ws.send(JSON.stringify({ type: 'preview_ready', reqId: msg.reqId || null }));
    }

    if (msg.action === 'reset') {
      resetSession();
      broadcast({ type: 'reset' });
    }

    // サムネイル再生成
    if (msg.action === 'regen_thumbnail') {
      // session.renderResult がなければ topicData から outputDir を復元
      const rr = session.renderResult
        || (session.activeTopic && session.topicData[session.activeTopic]?.renderResult)
        || null;
      if (!rr || !rr.outputDir) {
        ws.send(JSON.stringify({ type: 'thumbnail_error', detail: '動画フォルダが見つかりません。再レンダリングしてください。' }));
        return;
      }
      // outputDir が絶対パスでない場合（旧データ対策）
      const outputDir = path.isAbsolute(rr.outputDir) ? rr.outputDir : path.join(__dirname, rr.outputDir);
      if (!fs.existsSync(outputDir)) {
        ws.send(JSON.stringify({ type: 'thumbnail_error', detail: `出力フォルダが存在しません: ${outputDir}` }));
        return;
      }
      try {
        const thumbPath = path.join(outputDir, 'thumbnail.jpg');
        await generateThumbnail({
          title: msg.title || rr.topic || session.activeTopic || '',
          badge: msg.badge || '速報',
          bgImageUrl: msg.bgImageUrl || null,
          outputPath: thumbPath,
        });
        const thumbnailUrl = `/output/${path.basename(outputDir)}/thumbnail.jpg`;
        const thumbnailUrlBusted = thumbnailUrl + '?t=' + Date.now();
        if (session.activeTopic && session.topicData[session.activeTopic]?.renderResult) {
          session.topicData[session.activeTopic].renderResult.thumbnailUrl = thumbnailUrl;
          saveTopicData();
        }
        broadcast({ type: 'thumbnail_ready', thumbnailUrl: thumbnailUrlBusted });
      } catch (e) {
        broadcast({ type: 'thumbnail_error', detail: e.message });
      }
    }

    // 投稿メタデータ生成
    if (msg.action === 'generate_meta') {
      const rr = session.renderResult
        || (session.activeTopic && session.topicData[session.activeTopic]?.renderResult)
        || null;
      const topic = rr?.topic || session.activeTopic || '';
      const mods = session.topicData[session.activeTopic]?.mods || [];
      try {
        const meta = await phaseMeta({ topic, mods });
        if (session.activeTopic && session.topicData[session.activeTopic]?.renderResult) {
          session.topicData[session.activeTopic].renderResult.meta = meta;
          saveTopicData();
        }
        broadcast({ type: 'meta_ready', meta });
      } catch (e) {
        broadcast({ type: 'meta_error', detail: e.message });
      }
    }
  });
});

// ── 起動 ─────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  ⚽ Dashboard: http://localhost:${PORT}\n`);
});
