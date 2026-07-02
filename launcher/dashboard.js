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
  phaseScout, phaseResearch, phaseRender, phaseMeta,
} = require('./pipeline');
const { listPatterns } = require('./slide_patterns');
const { scoutWithAI, callDeepSeek } = require('./scout');
const { generateModsAuto, generateBrief } = require('./script_gen');
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
      // 脚本生成用の完全版facts（記事本文・matchData全体等）。ダッシュボード再起動後も
      // factsForClient（表示用の軽量版・記事本文なし）にフォールバックしないための保存
      facts: v.facts || null,
      brief: v.brief || null,
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
  // /preview_img — puppeteer でスクリーンショットを撮って JPEG を返す（モバイル対応）
  if (req.url.startsWith('/preview_img')) {
    (async () => {
      try {
        const html = lastPreviewMod ? buildPreviewHTML(lastPreviewMod) : '<body style="background:#060e1c"></body>';
        const puppeteer = require('puppeteer-core');
        const browser = await puppeteer.launch({
          headless: true,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        });
        try {
          const page = await browser.newPage();
          await page.setViewport({ width: 1920, height: 1080 });
          await page.setContent(html, { waitUntil: 'networkidle2', timeout: 12000 });
          const buf = await page.screenshot({ type: 'jpeg', quality: 82 });
          await page.close();
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
          res.end(buf);
        } finally {
          await browser.close();
        }
      } catch (e) {
        console.warn('[preview_img]', e.message);
        res.writeHead(500); res.end();
      }
    })();
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
  brief: null,
  renderResult: null,
};

function resetSession() {
  session = {
    phase: 'idle', topics: null,
    savedTopics: session.savedTopics,
    topicData: session.topicData,
    factsCache: session.factsCache,
    activeTopic: null, facts: null, brief: null, renderResult: null,
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
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Scout timeout (90s)')), 90000)
    );
    const topics = await Promise.race([scoutWithAI(), timeout]);
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
  "searchQuery": "英語3〜5語。固有名詞（選手名・チーム名）＋イベントワード1語で構成。冠詞・前置詞を省く。例: Mbappe France World Cup final / Vinicius VAR Brazil protest / Mitoma Japan penalty",
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
      text: (translatedTexts[i] || c.text).slice(0, 120),
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

    session.topicData[topicTitle] = { summary, factsForClient, facts };
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

// ── facts 取り違えガード ─────────────────────────────
// facts は session.facts / factsCache / topicData.factsForClient の3箇所にあり、
// 案件切替時に別トピックの facts で生成が走る事故を検知する
function factsTopicMismatch() {
  const ft = session.facts?.topic;
  return !!(ft && session.activeTopic && ft !== session.activeTopic);
}

function factsMismatchDetail() {
  return `facts の取り違えを検知しました: facts="${session.facts?.topic}" / 選択中="${session.activeTopic}"。案件を開き直してください`;
}

// ── Step 3: Render ───────────────────────────────────

async function runRender(prebuiltMods = null) {
  session.phase = 'rendering';
  interceptConsole();

  const videoTopic = session.activeTopic;
  session.renderingTopic = videoTopic;

  broadcast({ type: 'phase', phase: 'rendering', topic: videoTopic });

  try {
    if (!session.facts) session.facts = session.factsCache[session.activeTopic] || null;
    if (!session.facts) {
      const td = session.topicData[session.activeTopic];
      if (td?.facts) session.facts = td.facts;
      else if (td?.factsForClient) session.facts = td.factsForClient;
    }
    if (factsTopicMismatch()) throw new Error(factsMismatchDetail());
    // ギャラリーでチェック解除された画像は自動プリセット対象外にする
    if (session.facts) session.facts._uncheckedImageUrls = session.uncheckedImageUrls || [];

    const emitter = new EventEmitter();
    emitter.on('pipeline', (evt) => broadcast(evt));

    const result = await phaseRender(videoTopic, session.facts, emitter, prebuiltMods);
    session.renderResult = result;
    const meta = await phaseMeta(result);

    session.phase = 'done';
    const patternKey = result.patternKey || 'pieces_2';
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
    session.phase = 'facts_ready';
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
    activeBrief: activeData ? (activeData.brief || null) : null,
    activeRenderResult: activeData && activeData.renderResult ? activeData.renderResult : null,
    activeMods: activeData && activeData.mods ? activeData.mods : null,
    renderingTopic: session.phase === 'rendering' ? session.renderingTopic : null,
    patterns: listPatterns(),
    steps: STEPS,
    renderSubSteps: RENDER_SUB_STEPS,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.action === 'scout') {
      const scoutOk = ['idle','done','topics_ready','facts_ready','script_ready'];
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
        session.brief = cached.brief || null;
        session.phase = cached.mods ? 'script_ready' : 'facts_ready';
        // 旧キャッシュに labels がない場合は再構築して保存
        if (!cached.factsForClient.labels) {
          cached.factsForClient.labels = buildLabels(cached.factsForClient);
          saveTopicData();
        }
        broadcast({ type: 'facts_ready', summary: cached.summary, facts: cached.factsForClient, topic: topic.title });
        if (cached.renderResult) broadcast({ type: 'done', ...cached.renderResult, mods: cached.mods || null });
        else if (cached.mods) broadcast({ type: 'script_ready', mods: cached.mods, topic: topic.title });
      } else {
        runResearch(topic.title);
      }
    }

    if (msg.action === 'render') {
      if (Array.isArray(msg.uncheckedImages)) session.uncheckedImageUrls = msg.uncheckedImages;
      const cachedMods = session.topicData[session.activeTopic]?.mods;
      if (msg.mods || cachedMods) {
        runRender(msg.mods || cachedMods);
      } else {
        runRender();
      }
    }

    if (msg.action === 'generate_script') {
      if (!session.activeTopic) return;
      if (!session.facts) session.facts = session.factsCache[session.activeTopic] || null;
      if (!session.facts) {
        const td = session.topicData[session.activeTopic];
        if (td?.facts) session.facts = td.facts;
        else if (td?.factsForClient) session.facts = td.factsForClient;
      }
      if (!session.facts) {
        ws.send(JSON.stringify({ type: 'error', detail: '情報収集データがありません。先に Step 2 を実行してください。' }));
        return;
      }
      if (factsTopicMismatch()) {
        ws.send(JSON.stringify({ type: 'error', detail: factsMismatchDetail() }));
        return;
      }
      interceptConsole();
      broadcast({ type: 'phase', phase: 'generating_script' });
      try {
        const result = await generateModsAuto(session.activeTopic, session.facts, session.brief || null);
        const { mods, patternKey } = result;
        if (session.topicData[session.activeTopic]) {
          session.topicData[session.activeTopic].mods = mods;
          saveTopicData();
        }
        broadcast({ type: 'script_ready', mods, topic: session.activeTopic, patternKey, validation: result.validation || null });
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
      if (Array.isArray(msg.uncheckedImages)) session.uncheckedImageUrls = msg.uncheckedImages;
      const mods = msg.mods;
      if (session.activeTopic && session.topicData[session.activeTopic] && mods) {
        session.topicData[session.activeTopic].mods = mods;
        saveTopicData();
      }
      runRender(mods || null);
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
      const { fetchMatch, fetchPlayer, fetchTeam, findPlayerInMatchData } = require('./research');
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
          // 試合の話題なら、選手データ取得前に試合データを確保しておく（今試合のスタッツを拾うため）
          // クリック順（先に選手→後で試合）でも matchStats が取れるように、未取得ならここで先読みする
          if (!session.facts.matchData?.ok) {
            const allLabels = (session.activeTopic && session.topicData[session.activeTopic]?.factsForClient?.labels) || [];
            const matchLabel = allLabels.find(l => l.type === 'match' && l.homeTeam && l.awayTeam);
            if (matchLabel) {
              try {
                const md = await fetchMatch(matchLabel.homeTeam, matchLabel.awayTeam);
                if (md.ok) {
                  session.facts.matchData = md;
                  out.matchData = { ok: true, scoreline: md.scoreline, homeTeam: md.homeTeam, awayTeam: md.awayTeam, tournament: md.tournament };
                  if (md.homeLogo) out.images.push({ url: md.homeLogo, label: md.homeTeam || 'Home', group: 'ロゴ' });
                  if (md.awayLogo) out.images.push({ url: md.awayLogo, label: md.awayTeam || 'Away', group: 'ロゴ' });
                  if (session.topicData[session.activeTopic]) session.topicData[session.activeTopic].factsForClient.matchData = out.matchData;
                }
              } catch (err) { console.warn(`  [fetch_label_data] 試合データ先読み失敗: ${err.message}`); }
            }
          }
          let pd = await fetchPlayer(label.name);
          if (!pd.ok) {
            // グローバル選手検索が失敗(表記ゆれ・マイナー選手等)しても、
            // 試合データに出場記録があれば追加APIコールなしでそこから拾える
            const fromMatch = findPlayerInMatchData(session.facts.matchData, label.name);
            if (fromMatch) pd = fromMatch;
          }
          if (pd.ok) {
            session.facts.playerData = pd;
            let matchStats = pd.matchStats || null;
            const mdFull = session.facts.matchData;
            if (!matchStats && mdFull?.playerStats && pd.playerId) { const ps = mdFull.playerStats[String(pd.playerId)]; if (ps) matchStats = ps.stats; }
            if (mdFull?.ok && !matchStats) console.warn(`  [fetch_label_data] ${pd.name}: 試合データはあるが本人のplayerStatsが見つからず（出場なし or ID不一致）`);
            out.playerData = {
              ok: true, playerId: pd.playerId, name: pd.name, position: pd.position, age: pd.age,
              nationality: pd.nationality, team: pd.team, leagueName: pd.leagueName, marketValue: pd.marketValue,
              marketValueHistory: pd.marketValueHistory || [], seasonStats: pd.seasonStats, nationalTeam: pd.nationalTeam,
              recentAvgRating: pd.recentAvgRating, matchStats, fromMatchData: pd.fromMatchData || false,
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

    // Step4 matchcard: チーム名手入力 → FotMob から試合データ取得
    if (msg.action === 'fetch_match_for_slide') {
      const { slideIdx, homeTeam, awayTeam } = msg;
      if (!homeTeam || !awayTeam) {
        ws.send(JSON.stringify({ type: 'match_data_for_slide', slideIdx, error: 'ホームとアウェイ両方入力してください' }));
        return;
      }
      broadcast({ type: 'phase', phase: 'fetching_data' });
      try {
        const { fetchMatch } = require('./research');
        const result = await fetchMatch(homeTeam, awayTeam);
        if (session.mods && session.mods[slideIdx] != null) {
          session.mods[slideIdx].matchData = result;
          if (result.homeScore != null) session.mods[slideIdx].homeScore = result.homeScore;
          if (result.awayScore != null) session.mods[slideIdx].awayScore = result.awayScore;
          if (result.homeTeam)          session.mods[slideIdx].homeTeam  = result.homeTeam;
          if (result.awayTeam)          session.mods[slideIdx].awayTeam  = result.awayTeam;
          saveTopicData();
        }
        if (result.ok) {
          broadcast({ type: 'match_data_for_slide', slideIdx, matchData: result });
        } else {
          broadcast({ type: 'match_data_for_slide', slideIdx, error: result.error || '試合データが見つかりませんでした', matchData: result });
        }
      } catch (err) {
        console.warn('[fetch_match_for_slide]', err.message);
        ws.send(JSON.stringify({ type: 'match_data_for_slide', slideIdx, error: err.message }));
      }
      broadcast({ type: 'phase', phase: 'idle' });
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
      const { fetchMatch, fetchPlayer, fetchTeam, findPlayerInMatchData } = require('./research');
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
          let pd = await fetchPlayer(playerName);
          if (!pd.ok) {
            // グローバル選手検索が失敗しても、試合データに出場記録があればそこから拾える
            const fromMatch = findPlayerInMatchData(session.facts?.matchData, playerName);
            if (fromMatch) pd = fromMatch;
          }
          if (pd.ok) {
            if (!session.facts) session.facts = {};
            session.facts.playerData = pd;
            // 今試合スタッツを matchData.playerStats から紐付け
            let matchStats = pd.matchStats || null;
            const mdFull = session.facts.matchData;
            if (!matchStats && mdFull?.playerStats && pd.playerId) {
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
              fromMatchData: pd.fromMatchData || false,
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

    if (msg.action === 'search_players') {
      try {
        const { searchPlayers } = require('./player_db');
        const results = searchPlayers(msg.q || '', 12);
        ws.send(JSON.stringify({ type: 'player_search_results', results }));
      } catch (_) {
        ws.send(JSON.stringify({ type: 'player_search_results', results: [] }));
      }
    }

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

    // ── 企画書生成 ──────────────────────────────────────
    if (msg.action === 'generate_brief') {
      if (!session.activeTopic) return;
      if (!session.facts) session.facts = session.factsCache[session.activeTopic] || null;
      if (!session.facts) {
        const td = session.topicData[session.activeTopic];
        if (td?.facts) session.facts = td.facts;
        else if (td?.factsForClient) session.facts = td.factsForClient;
      }
      if (!session.facts) {
        ws.send(JSON.stringify({ type: 'error', detail: '情報収集データがありません。先に Step 2 を実行してください。' }));
        return;
      }
      if (factsTopicMismatch()) {
        ws.send(JSON.stringify({ type: 'error', detail: factsMismatchDetail() }));
        return;
      }
      interceptConsole();
      broadcast({ type: 'phase', phase: 'generating_brief' });
      try {
        const brief = await generateBrief(session.activeTopic, session.facts);
        session.brief = brief;
        if (session.topicData[session.activeTopic]) {
          session.topicData[session.activeTopic].brief = brief;
          saveTopicData();
        }
        broadcast({ type: 'brief_ready', brief, topic: session.activeTopic });
      } catch (err) {
        broadcast({ type: 'error', detail: err.message });
      } finally {
        restoreConsole();
      }
    }

    // ── 企画書保存（ユーザー編集後）──────────────────────
    if (msg.action === 'save_brief') {
      if (!session.activeTopic || !msg.brief) return;
      session.brief = msg.brief;
      if (session.topicData[session.activeTopic]) {
        session.topicData[session.activeTopic].brief = msg.brief;
        saveTopicData();
      }
      ws.send(JSON.stringify({ type: 'brief_saved' }));
    }

    // ── 外部画像URLをギャラリーに追加 ──────────────────
    if (msg.action === 'add_external_image') {
      const url = (msg.url || '').trim();
      if (!url.startsWith('http')) {
        ws.send(JSON.stringify({ type: 'error', detail: '有効なURLを入力してください (http...)' }));
        return;
      }
      if (!session.facts) session.facts = {};
      if (!session.facts.xImages) session.facts.xImages = [];
      const alreadyExists = session.facts.xImages.some(xi => xi.url === url);
      if (!alreadyExists) {
        session.facts.xImages.push({ url, source: msg.label || '外部追加', manual: true });
        if (session.activeTopic && session.topicData[session.activeTopic]) {
          session.topicData[session.activeTopic].factsForClient.xImagesCount = session.facts.xImages.length;
          saveTopicData();
        }
      }
      ws.send(JSON.stringify({ type: 'gallery_images', images: collectGalleryImages(session.facts) }));
    }
  });
});

// ── 起動 ─────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ⚽ Dashboard:`);
  console.log(`    ローカル  : http://localhost:${PORT}`);
  console.log(`    Tailscale : http://100.115.192.114:${PORT}\n`);
});
