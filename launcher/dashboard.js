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
const { generateMods } = require('./script_gen');

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
  try { return JSON.parse(fs.readFileSync(TOPIC_DATA_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function saveTopicData() {
  const dir = path.dirname(TOPIC_DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const slim = {};
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

// ── HTTP サーバー ────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'web', 'index.html')));
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
  topicData: loadTopicData(),
  factsCache: {},
  activeTopic: null,
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
function buildLabels(facts) {
  const ex = facts.extracted || null;
  let labels = (ex?.labels && Array.isArray(ex.labels) && ex.labels.length > 0)
    ? ex.labels
    : [];

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
      labels: buildLabels(facts),
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

  broadcast({ type: 'phase', phase: 'rendering', topic: videoTopic, patternKey });

  try {
    if (!session.facts) session.facts = session.factsCache[session.activeTopic] || null;

    const emitter = new EventEmitter();
    emitter.on('pipeline', (evt) => broadcast(evt));

    const result = await phaseRender(videoTopic, patternKey, session.facts, emitter, prebuiltMods);
    session.renderResult = result;
    await phaseMeta(result);

    session.phase = 'done';
    const videoUrl = `/output/${path.basename(result.outputDir)}/final.mp4`;

    if (session.activeTopic && session.topicData[session.activeTopic]) {
      session.topicData[session.activeTopic].renderResult = { videoUrl, totalDuration: result.totalDuration, patternKey, topic: videoTopic };
      session.topicData[session.activeTopic].mods = result.mods;
      saveTopicData();
    }

    broadcast({ type: 'done', topic: videoTopic, patternKey, totalDuration: result.totalDuration, videoUrl, mods: result.mods });
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
      if (!session.facts) {
        broadcast({ type: 'error', detail: '情報収集データがありません。先に情報収集を実行してください。' });
        return;
      }
      runPlan();
    }

    if (msg.action === 'render') {
      if (!session.viewpoints || !session.viewpoints.length) {
        broadcast({ type: 'error', detail: '企画ピースがありません。先にStep 3を実行してください。' });
        return;
      }
      runRender(msg.viewpointIndex, msg.edits);
    }

    if (msg.action === 'generate_script') {
      if (!session.activeTopic) return;
      if (!session.facts) session.facts = session.factsCache[session.activeTopic] || null;
      // サーバー再起動後 factsCache は空なので topicData から facts を再構築
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
      const vp = session.viewpoints[msg.viewpointIndex != null ? msg.viewpointIndex : 0];
      if (!vp) return;
      const videoTopic = (msg.edits && msg.edits.title) || vp.title || session.activeTopic;
      const patternKey = (msg.edits && msg.edits.suggestedPattern) || vp.suggestedPattern || 'match_result';
      interceptConsole();
      broadcast({ type: 'phase', phase: 'generating_script' });
      try {
        const mods = await generateMods(patternKey, videoTopic, session.facts);
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
      if (!session.viewpoints || !session.viewpoints.length) {
        broadcast({ type: 'error', detail: '企画データがありません。Step 3 を先に実行してください。' });
        return;
      }
      if (session.activeTopic && session.topicData[session.activeTopic]) {
        session.topicData[session.activeTopic].mods = msg.mods;
        saveTopicData();
      }
      runRender(msg.viewpointIndex || 0, msg.edits, msg.mods);
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
        const xImages = await fetchImagesForLabels(labels);
        // factsCache / topicData を更新
        if (session.facts) session.facts.xImages = xImages;
        if (session.activeTopic && session.topicData[session.activeTopic]) {
          session.topicData[session.activeTopic].factsForClient.xImagesCount = xImages.length;
          session.topicData[session.activeTopic].factsForClient.labels = labels;
        }
        // ギャラリーに直接送る
        const images = xImages.map(xi => ({ url: xi.url, label: xi.source || 'X公式' }));
        broadcast({ type: 'gallery_images', images });
        broadcast({ type: 'x_images_ready', count: xImages.length });
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', detail: 'X画像取得失敗: ' + err.message }));
      }
    }

    if (msg.action === 'get_gallery_images') {
      const images = [];
      const facts = session.facts;
      if (facts) {
        // X公式画像（ラベルベース・最優先で先頭に）
        (facts.xImages || []).forEach(xi => {
          if (xi.url && xi.url.startsWith('http')) {
            images.push({ url: xi.url, label: xi.source || 'X公式' });
          }
        });
        // 選手画像（FotMob）
        if (facts.playerData?.imageUrl) {
          images.push({ url: facts.playerData.imageUrl, label: facts.playerData.name || '選手' });
        }
        // チームロゴ（FotMob）
        if (facts.matchData?.homeLogo) images.push({ url: facts.matchData.homeLogo, label: facts.matchData.homeTeam || 'Home' });
        if (facts.matchData?.awayLogo) images.push({ url: facts.matchData.awayLogo, label: facts.matchData.awayTeam || 'Away' });
        // 記事サムネイル（最後・補完用）
        (facts.articles || []).forEach(a => {
          const url = a.imageUrl || a.image || a.thumbnail || null;
          if (url && url.startsWith('http')) {
            images.push({ url, label: (a.title || '').slice(0, 40) });
          }
        });
      }
      // 重複除去
      const seen = new Set();
      const unique = images.filter(img => { if (seen.has(img.url)) return false; seen.add(img.url); return true; });
      ws.send(JSON.stringify({ type: 'gallery_images', images: unique }));
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
