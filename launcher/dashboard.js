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

const PORT = 3456;
const SAVED_FILE = path.join(__dirname, 'output', 'saved_topics.json');

// ── 保存済みトピック永続化 ──────────────────────────────

function loadSaved() {
  try { return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')); }
  catch (_) { return []; }
}

function saveToDisk(topics) {
  const dir = path.dirname(SAVED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SAVED_FILE, JSON.stringify(topics, null, 2));
}

// ── HTTP サーバー ────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'web', 'index.html')));
    return;
  }
  if (req.url.startsWith('/output/')) {
    const filePath = path.join(__dirname, req.url);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const types = { '.mp4': 'video/mp4', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
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

let session = {
  phase: 'idle',
  topics: null,
  savedTopics: loadSaved(),
  activeTopic: null,
  facts: null,
  viewpoints: null,
  renderResult: null,
};

function resetSession() {
  session = {
    phase: 'idle', topics: null,
    savedTopics: session.savedTopics,
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
      `サッカーのニューストピックから、関連するチーム名と選手名を英語で抽出してください。
選手名はフルネーム（例: Lionel Messi, Takefusa Kubo）で返してください。
該当しない場合はnullを返してください。
JSON形式: {"homeTeam": "Japan" or null, "awayTeam": "Sweden" or null, "playerName": "Lionel Messi" or null, "searchQuery": "英語での検索クエリ（トピック全体を反映）"}`,
      topicTitle
    );
    console.log(`  [analyze] teams: ${result.homeTeam || '—'} vs ${result.awayTeam || '—'}, player: ${result.playerName || '—'}`);
    return result;
  } catch (err) {
    console.warn(`  [analyze] failed: ${err.message}`);
    return {};
  }
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
    session.phase = 'facts_ready';

    const factsForClient = {
      topic: facts.topic,
      articles: (facts.articles || []).map(a => ({ title: a.title, url: a.url, textLen: (a.text || '').length })),
      matchData: facts.matchData ? { ok: true, scoreline: facts.matchData.scoreline } : null,
      playerData: facts.playerData ? { ok: true, name: facts.playerData.name, team: facts.playerData.team } : null,
      comments: {
        reddit: (facts.comments?.reddit || []).length,
        yahoo: (facts.comments?.yahoo || []).length,
        x: (facts.comments?.x || []).length,
        total: (facts.comments?.all || []).length,
        samples: (facts.comments?.all || []).slice(0, 5).map(c => typeof c === 'string' ? c : c.text),
      },
    };
    broadcast({ type: 'facts_ready', summary, facts: factsForClient, topic: topicTitle });
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
    broadcast({ type: 'plan_ready', viewpoints, patterns: listPatterns() });
  } catch (err) {
    broadcast({ type: 'error', detail: err.message });
    session.phase = 'facts_ready';
  } finally {
    restoreConsole();
  }
}

// ── Step 4: Render ───────────────────────────────────

async function runRender(viewpointIndex, edits) {
  if (session.phase !== 'plan_ready') return;
  session.phase = 'rendering';
  interceptConsole();
  broadcast({ type: 'phase', phase: 'rendering' });

  try {
    const vp = { ...session.viewpoints[viewpointIndex || 0] };
    if (edits) {
      if (edits.title) vp.title = edits.title;
      if (edits.suggestedPattern) vp.suggestedPattern = edits.suggestedPattern;
    }

    const videoTopic = vp.title || session.activeTopic;
    const patternKey = vp.suggestedPattern || 'match_result';

    const emitter = new EventEmitter();
    emitter.on('pipeline', (evt) => broadcast(evt));

    const result = await phaseRender(videoTopic, patternKey, session.facts, emitter);
    session.renderResult = result;
    const meta = await phaseMeta(result);

    session.phase = 'done';
    const videoUrl = `/output/${path.basename(result.outputDir)}/final.mp4`;
    broadcast({ type: 'done', topic: videoTopic, patternKey, totalDuration: result.totalDuration, videoUrl });
  } catch (err) {
    broadcast({ type: 'error', detail: err.message });
    session.phase = 'plan_ready';
  } finally {
    restoreConsole();
  }
}

// ── WebSocket 接続 ───────────────────────────────────

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'hello',
    phase: session.phase,
    topics: session.topics,
    savedTopics: session.savedTopics,
    activeTopic: session.activeTopic,
    viewpoints: session.phase === 'plan_ready' ? session.viewpoints : null,
    patterns: session.phase === 'plan_ready' ? listPatterns() : null,
    steps: STEPS,
    renderSubSteps: RENDER_SUB_STEPS,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.action === 'scout') {
      if (session.phase !== 'idle' && session.phase !== 'done' && session.phase !== 'topics_ready') {
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
      broadcast({ type: 'saved_topics', savedTopics: session.savedTopics });
    }

    if (msg.action === 'remove_saved') {
      const idx = msg.index;
      if (idx >= 0 && idx < session.savedTopics.length) {
        session.savedTopics.splice(idx, 1);
        saveToDisk(session.savedTopics);
        broadcast({ type: 'saved_topics', savedTopics: session.savedTopics });
      }
    }

    if (msg.action === 'activate') {
      const topic = session.savedTopics[msg.index];
      if (!topic) return;
      runResearch(topic.title);
    }

    if (msg.action === 'plan') {
      if (session.phase !== 'facts_ready') return;
      runPlan();
    }

    if (msg.action === 'render') {
      if (session.phase !== 'plan_ready') return;
      runRender(msg.viewpointIndex, msg.edits);
    }

    if (msg.action === 'reset') {
      resetSession();
      broadcast({ type: 'reset' });
    }
  });
});

// ── 起動 ─────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n  ⚽ Dashboard: http://localhost:${PORT}\n`);
});
