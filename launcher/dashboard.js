// launcher/dashboard.js
// ステップバイステップ操作型ダッシュボード
// node dashboard.js → http://localhost:3456
//
// Flow (ユーザー操作型):
//   1. Client sends {action:'scout'}        → Server returns topics list
//   2. Client sends {action:'research', topicIndex}  → Server returns facts
//   3. Client sends {action:'plan'}         → Server returns viewpoints
//   4. Client sends {action:'render', viewpointIndex, edits?} → Server runs render
//   5. (future) meta

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
const { scoutWithAI } = require('./scout');

const PORT = 3456;

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
  selectedTopic: null,
  facts: null,
  viewpoints: null,
  renderResult: null,
};

function resetSession() {
  session = { phase: 'idle', topics: null, selectedTopic: null, facts: null, viewpoints: null, renderResult: null };
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

async function runResearch(topicIndex) {
  if (!session.topics || !session.topics[topicIndex]) return;
  const topic = session.topics[topicIndex];
  session.selectedTopic = topic.title || topic.text;
  session.phase = 'researching';
  interceptConsole();
  broadcast({ type: 'phase', phase: 'researching', topic: session.selectedTopic });

  try {
    const { facts, summary } = await phaseResearch(session.selectedTopic);
    session.facts = facts;
    session.phase = 'facts_ready';
    broadcast({ type: 'facts_ready', summary, topic: session.selectedTopic });
  } catch (err) {
    broadcast({ type: 'error', detail: err.message });
    session.phase = 'topics_ready';
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

    const videoTopic = vp.title || session.selectedTopic;
    const patternKey = vp.suggestedPattern || 'match_result';

    const emitter = new EventEmitter();
    emitter.on('pipeline', (evt) => broadcast(evt));

    const result = await phaseRender(videoTopic, patternKey, session.facts, emitter);
    session.renderResult = result;

    const meta = await phaseMeta(result);

    session.phase = 'done';
    const videoUrl = `/output/${path.basename(result.outputDir)}/final.mp4`;
    broadcast({
      type: 'done',
      topic: videoTopic,
      patternKey,
      totalDuration: result.totalDuration,
      videoUrl,
    });
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
    selectedTopic: session.selectedTopic,
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
      resetSession();
      runScout();
    }

    if (msg.action === 'research') {
      if (session.phase !== 'topics_ready') {
        ws.send(JSON.stringify({ type: 'error', detail: 'まずscoutを実行してください' }));
        return;
      }
      runResearch(msg.topicIndex);
    }

    if (msg.action === 'plan') {
      if (session.phase !== 'facts_ready') {
        ws.send(JSON.stringify({ type: 'error', detail: 'まずresearchを実行してください' }));
        return;
      }
      runPlan();
    }

    if (msg.action === 'render') {
      if (session.phase !== 'plan_ready') {
        ws.send(JSON.stringify({ type: 'error', detail: '企画ピース未確定' }));
        return;
      }
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
