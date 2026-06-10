// routes/chat_routes.js
// ─── サッカー専門チャットパネル ─────────────────────────────────
// ランチャー右下フローティング窓から DeepSeek V4-Flash に質問。
// AI Tool Use (Function Calling) で必要に応じて既存 fetcher を呼んで
// SofaScore / Transfermarkt 等の生データを参照させる。
//
// エンドポイント:
//   POST /api/chat/ask        { messages, currentPostId? } → { text, toolCalls } (非ストリーム・後方互換)
//   POST /api/chat/ask-stream { messages, currentPostId? } → SSE ストリーム
//   GET  /api/chat/ui                                      → 右下フローティング HTML (シェル組込)

const express = require('express');
const router  = express.Router();
const OpenAI  = require('openai');

const fs   = require('fs');
const path = require('path');

const { fetchSofaScorePlayer }    = require('../scripts/modules/fetchers/sofascore_player');
const { searchTransfermarktManager, fetchTransfermarktManager } = require('../scripts/modules/fetchers/transfermarkt_manager');
const { fetchSofaScoreTeam }      = require('../scripts/modules/fetchers/sofascore_team');
const { fetchSofaScoreTournament } = require('../scripts/modules/fetchers/sofascore_tournament');

// ─── データファイルパス ────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, '..', 'data');
const SI_DIR     = path.join(DATA_DIR, 'si_data');
const SAVED_FILE = path.join(DATA_DIR, 'saved_projects.json');

function _safeId(s) { return String(s || '').replace(/[\/\?%*:|"<>\.]/g, '_'); }

// 現案件の si_data からキャッシュ参照
function _loadSi(postId) {
  if (!postId) return null;
  const file = path.join(SI_DIR, _safeId(postId) + '.json');
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// saved_projects.json から案件情報を取得
function _loadProject(postId) {
  if (!postId) return null;
  try {
    const list = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
    return Array.isArray(list) ? list.find(p => p.id === postId) || null : null;
  } catch { return null; }
}

const _TOOL_TO_ROLE = {
  search_player:     'player',
  search_manager:    'manager',
  search_team:       'team',
  search_tournament: 'tournament',
};
function _findEntityInSi(si, name, toolName) {
  if (!si?.boxes?.entity?.items || !name) return null;
  const target = String(name).toLowerCase().trim();
  const expectedRole = _TOOL_TO_ROLE[toolName];
  return si.boxes.entity.items.find(it => {
    const lbl = String(it.label || '').toLowerCase().trim();
    const nameMatch = lbl === target || lbl.includes(target) || target.includes(lbl);
    if (!nameMatch) return false;
    if (!expectedRole) return true;
    return it.role === expectedRole;
  }) || null;
}

let _deepseek = null;
function getDeepseek() {
  if (!_deepseek) {
    _deepseek = new OpenAI({
      apiKey:  process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com',
    });
  }
  return _deepseek;
}

let _braveAnswers = null;
function getBraveAnswers() {
  if (!_braveAnswers) {
    _braveAnswers = new OpenAI({
      apiKey:  process.env.BRAVE_ANSWERS_API_KEY,
      baseURL: 'https://api.search.brave.com/res/v1',
    });
  }
  return _braveAnswers;
}

const BASE_SYSTEM_PROMPT = `あなたはサッカー専門アシスタント兼ランチャー操作エージェント「リサーチミア」。
役割①: 案件選定や原稿編集の合間に最新かつ正確なデータを即時提供する。
役割②: ランチャーのスライド編集・記事検索を直接操作できるエージェントとして機能する。

━━━ 🔥 ツール使用ルール (絶対遵守) ━━━

【ツール選択ルール（必ず守る）】

■ 内部データ×スライド操作 → SofaScore/TM + ランチャーツール
  - 選手スタッツ・成績数値 → search_player
  - 監督データ → search_manager
  - クラブ情報 → search_team
  - リーグ順位・得点王 → search_tournament
  - スライド確認 → get_slides
  - スライド書き換え → get_slides で確認後 → update_slide

■ 最新ニュース・速報（深掘り不要） → web_search
  - 「〇〇の試合結果は？」「最新移籍情報」「W杯の組み合わせ」など

■ 調査・分析・根拠が必要な質問 → research_answers
  - 「〇〇の戦術的弱点を調べて」「なぜ〇〇なのか分析して」
  - 「記事を読んで〇〇について教えて」「〇〇を深掘りして」
  - 記事の中身まで読んでBraveが回答を生成するので精度が高い

【禁止事項】
- 数値(試合数/ゴール/勝率/順位)を学習データだけで回答 → 必ず tool 呼ぶ
- tool 取得失敗時のみ推定し、必ず「(取得失敗のため推定値)」と明示

【出力】日本語で簡潔。数字は表 or 箇条書き。スライド操作後は何を変更したか明示。`;

// 現在の案件情報をシステムプロンプトに注入して返す
function buildSystemPrompt(currentPostId) {
  let prompt = BASE_SYSTEM_PROMPT;
  const proj = _loadProject(currentPostId);
  if (proj) {
    const note = String(proj.raw?.customNote || '').trim();
    prompt += `\n\n━━━ 📋 現在の作業案件 ━━━\n案件ID: ${proj.id}\nタイトル: ${proj.title}`;
    if (note) prompt += `\n説明・補足メモ:\n${note}`;
  }
  return prompt;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_player',
      description: '選手の詳細データを取得。プロフィール / 現シーズン統計 / 通算キャリア / 移籍履歴 / 代表成績を返す。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '選手名（英語推奨。例: Jude Bellingham, Kaoru Mitoma）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_manager',
      description: '監督のキャリアデータを取得。クラブ別 W/D/L・PPM・在任日数・獲得タイトル・今季成績を返す。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '監督名（英語推奨。例: Carlo Ancelotti, Mikel Arteta）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_team',
      description: 'クラブの現状データを取得。順位 / 直近5試合 / シーズン統計 / トップスコアラー等を返す。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'クラブ名（英語推奨。例: Chelsea, Real Madrid）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_tournament',
      description: '大会の現シーズンデータを取得。全チーム順位表 / 得点王ランキング / アシスト王ランキングを返す。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '大会名（英語推奨。例: Premier League, LaLiga, Champions League）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Braveで素早くウェブ検索。試合結果・最新ニュース・移籍速報など深掘り不要な情報取得に使う。スニペット形式で返す。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '検索クエリ（日本語または英語）' },
          count: { type: 'number', description: '取得件数（デフォルト5・最大10）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research_answers',
      description: 'Brave Answers APIで深い調査。記事を熟読して根拠付きの回答を生成する。戦術分析・選手評価・背景調査など「なぜ？」「どうして？」系の質問に使う。web_searchより精度が高い。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '調査したい内容（日本語または英語）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_slides',
      description: '現在の案件のスライド一覧を取得。スライド番号・タイプ・タイトル・ナレーション冒頭・データスロットを返す。スライド編集前に必ず呼ぶ。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_slide',
      description: '指定スライドのフィールドを書き換える。title / narration / dataSlots を変更できる。実行後はStep4で確認を促す。',
      parameters: {
        type: 'object',
        properties: {
          slideIdx: { type: 'number', description: 'スライドのインデックス（0始まり）' },
          field:    { type: 'string', description: '変更フィールド: title / narration / dataSlots' },
          value:    { description: '新しい値。dataSlots は [{label, value}] 形式の配列' },
        },
        required: ['slideIdx', 'field', 'value'],
      },
    },
  },
];

// ─── tool 実行 ────────────────────────────────────────────────
async function executeTool(name, args, currentPostId, currentSlideIdx) {

  /* ── ランチャー操作ツール ── */
  if (name === 'web_search') {
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) return { error: 'BRAVE_API_KEY が .env に未設定です。' };
    const count = Math.min(Number(args.count) || 5, 10);
    try {
      const url = 'https://api.search.brave.com/res/v1/web/search?q='
        + encodeURIComponent(args.query || '') + '&count=' + count;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
      });
      const data = await resp.json();
      const results = (data.web?.results || []).map(r => ({
        title: r.title, url: r.url, snippet: r.description,
      }));
      return { query: args.query, results };
    } catch (e) {
      return { error: 'Brave検索失敗: ' + e.message };
    }
  }

  if (name === 'research_answers') {
    const apiKey = process.env.BRAVE_ANSWERS_API_KEY;
    if (!apiKey) return { error: 'BRAVE_ANSWERS_API_KEY が .env に未設定です。' };
    try {
      const client = getBraveAnswers();
      const resp = await client.chat.completions.create({
        model: 'brave',
        messages: [{ role: 'user', content: args.query || '' }],
        // @ts-ignore
        extra_body: { enable_citations: true, enable_research: true },
      });
      const answer = resp.choices?.[0]?.message?.content || '(回答なし)';
      return { query: args.query, answer };
    } catch (e) {
      return { error: 'Brave Answers失敗: ' + e.message };
    }
  }

  if (name === 'get_slides') {
    const pid = currentPostId;
    if (!pid) return { error: '案件が選択されていません' };
    const file = path.join(DATA_DIR, _safeId(pid) + '_modules.json');
    if (!fs.existsSync(file)) return { error: 'スライドデータがありません（Step3を先に実行してください）' };
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const modules = data.modules || [];
      return {
        total: modules.length,
        currentSlideIdx: currentSlideIdx ?? null,
        slides: modules.map((m, i) => ({
          idx: i,
          type: m.type,
          title: m.title || '',
          narration_head: (m.narration || '').slice(0, 80) + (m.narration?.length > 80 ? '…' : ''),
          dataSlots: m.dataSlots || [],
        })),
      };
    } catch (e) {
      return { error: 'ファイル読み込み失敗: ' + e.message };
    }
  }

  if (name === 'update_slide') {
    const pid = currentPostId;
    if (!pid) return { error: '案件が選択されていません' };
    const file = path.join(DATA_DIR, _safeId(pid) + '_modules.json');
    if (!fs.existsSync(file)) return { error: 'スライドデータがありません' };
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const modules = data.modules || [];
      const idx = Number(args.slideIdx);
      if (!modules[idx]) return { error: `スライド${idx}は存在しません（全${modules.length}枚）` };
      const field = args.field;
      if (!['title', 'narration', 'dataSlots'].includes(field)) {
        return { error: `変更できるフィールドは title / narration / dataSlots のみです` };
      }
      modules[idx][field] = args.value;
      data.modules = modules;
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return { ok: true, message: `スライド${idx}（${modules[idx].type}）の${field}を更新しました。Step4を開いて確認してください。` };
    } catch (e) {
      return { error: '書き込み失敗: ' + e.message };
    }
  }

  /* ── 既存の検索ツール ── */
  const q = String(args?.name || '').trim();
  if (!q) return { error: 'name は必須' };

  // cache check (現案件 si_data)
  if (currentPostId) {
    const si = _loadSi(currentPostId);
    const cached = _findEntityInSi(si, q, name);
    if (cached) {
      console.log(`[chat] cache HIT ${name}(${q}) ← si_data/${currentPostId}`);
      return { _source: 'cache (現案件 si_data から / fetcher 不使用)', ...cached };
    }
    console.log(`[chat] cache MISS ${name}(${q}) → fetcher へ`);
  }

  switch (name) {
    case 'search_player':
      return await fetchSofaScorePlayer(q);
    case 'search_manager': {
      const hit = await searchTransfermarktManager(q);
      if (!hit) return { error: `manager not found: ${q}` };
      return await fetchTransfermarktManager(hit.id, hit.slug);
    }
    case 'search_team':
      return await fetchSofaScoreTeam(q);
    case 'search_tournament':
      return await fetchSofaScoreTournament(q);
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// 大きすぎる tool 結果は AI に渡す前に切る（DeepSeek 128k context 内に収める）
const TOOL_RESULT_MAX_CHARS = 30000;
function safeStringify(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch { s = String(obj); }
  if (s.length > TOOL_RESULT_MAX_CHARS) {
    s = s.slice(0, TOOL_RESULT_MAX_CHARS) + `\n...[truncated, total ${s.length} chars]`;
  }
  return s;
}

const MAX_ITER = 5;

// ─── POST /api/chat/ask（後方互換・非ストリーム）─────────────────
router.post('/chat/ask', async (req, res) => {
  const t0 = Date.now();
  try {
    const { messages: userMessages, currentPostId, currentSlideIdx } = req.body;
    if (!Array.isArray(userMessages) || userMessages.length === 0) {
      return res.status(400).json({ error: 'messages 配列が必須' });
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt(currentPostId) },
      ...userMessages.map(m => ({ role: m.role, content: String(m.content || '') })),
    ];

    const client = getDeepseek();
    const toolCallsLog = [];
    let finalText = '';

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const response = await client.chat.completions.create({
        model:       'deepseek-v4-flash',
        messages,
        tools:       TOOLS,
        tool_choice: 'auto',
        max_tokens:  2000,
      });

      const msg = response.choices?.[0]?.message;
      if (!msg) {
        finalText = '(AI 応答なし)';
        break;
      }
      messages.push(msg);

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        finalText = msg.content || '';
        break;
      }

      const results = await Promise.all(toolCalls.map(async tc => {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
        const tool = tc.function?.name || 'unknown';
        console.log(`[chat] iter=${iter} tool=${tool} args=${JSON.stringify(args)}`);
        toolCallsLog.push({ tool, args });
        let result;
        try {
          result = await executeTool(tool, args, currentPostId, currentSlideIdx);
        } catch (e) {
          console.warn(`[chat] tool error: ${e.message}`);
          result = { error: e.message };
        }
        return { tool_call_id: tc.id, content: safeStringify(result) };
      }));

      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content });
      }
    }

    const elapsedMs = Date.now() - t0;
    console.log(`[chat] done in ${elapsedMs}ms, ${toolCallsLog.length} tool calls`);
    res.json({ text: finalText, toolCalls: toolCallsLog, elapsedMs });
  } catch (e) {
    console.error('[chat/ask] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/chat/ask-stream（SSEストリーミング）────────────────
// SSE プロトコル:
//   data: {"text":"..."}         → テキストチャンク（逐次）
//   data: {"tool":"name"}        → ツール呼び出し中通知
//   data: {"done":true,"toolCalls":[...]} → 完了
//   data: {"error":"..."}        → エラー
router.post('/chat/ask-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (obj) => {
    if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n');
  };

  try {
    const { messages: userMessages, currentPostId, currentSlideIdx } = req.body;
    if (!Array.isArray(userMessages) || userMessages.length === 0) {
      send({ error: 'messages 配列が必須' });
      return res.end();
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt(currentPostId) },
      ...userMessages.map(m => ({ role: m.role, content: String(m.content || '') })),
    ];

    const client = getDeepseek();
    const toolCallsLog = [];

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const stream = await client.chat.completions.create({
        model:       'deepseek-v4-flash',
        messages,
        tools:       TOOLS,
        tool_choice: 'auto',
        max_tokens:  2000,
        stream:      true,
      });

      // ストリームを受け取りながらツール呼び出しを収集
      const pendingToolCalls = [];
      let contentBuffer = '';

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // テキストチャンク → 即送信
        if (delta.content) {
          contentBuffer += delta.content;
          send({ text: delta.content });
        }

        // ツール呼び出しデルタを蓄積
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls[idx]) {
              pendingToolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) pendingToolCalls[idx].id += tc.id;
            if (tc.function?.name)      pendingToolCalls[idx].function.name      += tc.function.name;
            if (tc.function?.arguments) pendingToolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }

      const validToolCalls = pendingToolCalls.filter(Boolean);

      // ツール呼び出しなし → ストリーミング完了
      if (validToolCalls.length === 0) break;

      // アシスタントメッセージをコンテキストに追加
      messages.push({
        role: 'assistant',
        content: contentBuffer || null,
        tool_calls: validToolCalls,
      });

      // ツール通知を送りながら並列実行
      send({ tool: validToolCalls.map(t => t.function.name).join(', ') });

      const results = await Promise.all(validToolCalls.map(async tc => {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
        const tool = tc.function?.name || 'unknown';
        console.log(`[chat-stream] iter=${iter} tool=${tool} args=${JSON.stringify(args)}`);
        toolCallsLog.push({ tool, args });
        let result;
        try {
          result = await executeTool(tool, args, currentPostId, currentSlideIdx);
        } catch (e) {
          result = { error: e.message };
        }
        return { tool_call_id: tc.id, content: safeStringify(result) };
      }));

      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content });
      }
    }

    send({ done: true, toolCalls: toolCallsLog });
  } catch (e) {
    console.error('[chat/ask-stream] error:', e);
    send({ error: e.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// ─── getUI: シェル組み込み用 HTML/CSS/JS ───────────────────────
// 右下フローティングボタン → 展開でチャットパネル
// 履歴は localStorage に保持（タブ閉じても残る）
function getUI() {
  return `
<!-- ═══ チャット窓 (リサーチミア) ═══ -->
<style>
.chat-fab {
  position: fixed; bottom: 10px; right: 10px; z-index: 9998;
  width: 60px; height: 60px; border-radius: 50%;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff; font-size: 28px; cursor: pointer;
  box-shadow: 0 6px 16px rgba(99,102,241,0.45);
  display: flex; align-items: center; justify-content: center;
  border: none; transition: transform 0.15s;
}
.chat-fab:hover { transform: scale(1.08); }
.chat-panel {
  position: fixed; bottom: 10px; right: 10px; z-index: 9999;
  width: 400px; height: 560px;
  max-width: calc(100vw - 20px);
  max-height: calc(100vh - 20px);
  max-height: calc(100dvh - 20px);
  background: #1f2937; border: 1px solid #374151; border-radius: 12px;
  display: none; flex-direction: column;
  box-shadow: 0 12px 32px rgba(0,0,0,0.4);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.chat-panel.open { display: flex; }
.chat-header {
  padding: 12px 16px; background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff; border-radius: 12px 12px 0 0; font-weight: 600;
  display: flex; align-items: center; justify-content: space-between;
}
.chat-header-title { font-size: 14px; }
.chat-header-btns { display: flex; gap: 8px; }
.chat-header-btn {
  background: rgba(255,255,255,0.18); color: #fff; border: none;
  width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
  font-size: 16px; display: flex; align-items: center; justify-content: center;
}
.chat-header-btn:hover { background: rgba(255,255,255,0.3); }
.chat-messages {
  flex: 1; overflow-y: auto; padding: 12px;
  display: flex; flex-direction: column; gap: 10px;
  background: #111827;
}
.chat-msg {
  padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5;
  max-width: 85%; word-wrap: break-word; word-break: break-word;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.chat-msg-user {
  background: #6366f1; color: #fff; align-self: flex-end;
  border-bottom-right-radius: 2px;
}
.chat-msg-asst {
  background: #374151; color: #f3f4f6; align-self: flex-start;
  border-bottom-left-radius: 2px;
}
.chat-msg-tool {
  background: #1e3a5f; color: #93c5fd; align-self: flex-start;
  font-size: 11px; font-family: ui-monospace, monospace;
  padding: 6px 10px; border-radius: 6px; opacity: 0.85;
  max-width: 95%; word-break: break-word; overflow-x: auto;
}
.chat-input-wrap {
  padding: 10px; background: #1f2937; border-top: 1px solid #374151;
  border-radius: 0 0 12px 12px;
}
.chat-input {
  width: 100%; background: #111827; color: #f3f4f6; border: 1px solid #374151;
  border-radius: 8px; padding: 10px; font-size: 13px; resize: none;
  font-family: inherit; outline: none; box-sizing: border-box;
}
.chat-input:focus { border-color: #6366f1; }
.chat-input-row { display: flex; gap: 8px; margin-top: 8px; }
.chat-send-btn {
  flex: 1; background: #6366f1; color: #fff; border: none;
  padding: 8px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px;
}
.chat-send-btn:hover { background: #4f46e5; }
.chat-send-btn:disabled { background: #4b5563; cursor: not-allowed; }
.chat-clear-btn {
  background: transparent; color: #9ca3af; border: 1px solid #4b5563;
  padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 12px;
}
.chat-clear-btn:hover { background: #374151; color: #fff; }
.chat-loading { color: #9ca3af; font-size: 12px; padding: 4px 8px; }
.chat-empty {
  color: #6b7280; font-size: 12px; text-align: center; padding: 40px 20px;
  line-height: 1.6;
}

@media (max-width: 480px) {
  .chat-fab {
    bottom: 10px; right: 10px;
    width: 52px; height: 52px; font-size: 24px;
  }
  .chat-panel {
    bottom: 10px; right: 10px; left: 10px;
    top: auto;
    width: calc(100vw - 20px);
    max-width: calc(100vw - 20px);
    height: 340px;
    max-height: 340px;
    overflow-x: hidden;
  }
  .chat-msg { max-width: 92%; font-size: 14px; }
  .chat-input { font-size: 14px; }
}
</style>

<button class="chat-fab" id="chatFab" title="リサーチミアに聞く">💬</button>

<div class="chat-panel" id="chatPanel">
  <div class="chat-header">
    <div class="chat-header-title">💬 リサーチミア</div>
    <div class="chat-header-btns">
      <button class="chat-header-btn" id="chatClearBtn" title="履歴クリア">🗑</button>
      <button class="chat-header-btn" id="chatCloseBtn" title="閉じる">×</button>
    </div>
  </div>
  <div class="chat-messages" id="chatMessages"></div>
  <div class="chat-input-wrap">
    <textarea class="chat-input" id="chatInput" rows="2" placeholder="例: アンチェロッティのレアル時代の成績は？  (Enter で送信 / Shift+Enter で改行)"></textarea>
    <div class="chat-input-row">
      <button class="chat-send-btn" id="chatSendBtn">送信</button>
    </div>
  </div>
</div>

<script>
(function() {
  const STORAGE_KEY = 'soccer_yt_chat_history_v1';
  const fab     = document.getElementById('chatFab');
  const panel   = document.getElementById('chatPanel');
  const closeBtn = document.getElementById('chatCloseBtn');
  const clearBtn = document.getElementById('chatClearBtn');
  const sendBtn  = document.getElementById('chatSendBtn');
  const input    = document.getElementById('chatInput');
  const msgsEl   = document.getElementById('chatMessages');

  let history = loadHistory();
  let busy = false;
  render();

  fab.addEventListener('click', () => {
    panel.classList.toggle('open');
    fab.style.display = panel.classList.contains('open') ? 'none' : 'flex';
    if (panel.classList.contains('open')) input.focus();
  });
  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    fab.style.display = 'flex';
  });
  clearBtn.addEventListener('click', () => {
    if (confirm('チャット履歴をクリアする？')) {
      history = [];
      saveHistory();
      render();
    }
  });
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  async function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;

    history.push({ role: 'user', content: text });
    saveHistory();
    input.value = '';
    busy = true; sendBtn.disabled = true;

    // 空のアシスタントバブルを先に追加（ストリーミング受け取り先）
    const asstIdx = history.length;
    history.push({ role: 'assistant', content: '' });
    render();

    const _curPostId   = (window.APP && window.APP.selected && window.APP.selected.id) || null;
    const _curSlideIdx = (window.APP && window.APP.s4 && typeof window.APP.s4.activeTab === 'number')
      ? window.APP.s4.activeTab : null;

    try {
      const response = await fetch('/api/chat/ask-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.slice(0, asstIdx).slice(-20),
          currentPostId:   _curPostId,
          currentSlideIdx: _curSlideIdx,
        }),
      });

      if (!response.ok) {
        history[asstIdx].content = '⚠️ サーバーエラー: ' + response.status;
        render();
        return;
      }

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let toolNames = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE の行を処理
        const lines = buf.split('\\n');
        buf = lines.pop(); // 未完行を次回に持ち越し

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }

          if (data.text) {
            history[asstIdx].content += data.text;
            updateLastMsg(history[asstIdx].content);
          }
          if (data.tool) {
            toolNames = toolNames.concat(data.tool.split(', '));
            showToolStatus(toolNames);
          }
          if (data.done) {
            if (data.toolCalls && data.toolCalls.length) {
              const uniq = [...new Set(data.toolCalls.map(t => t.tool))];
              history[asstIdx].content += '\\n\\n_📡 ツール使用: ' + uniq.join(', ') + '_';
              updateLastMsg(history[asstIdx].content);
            }
          }
          if (data.error) {
            history[asstIdx].content = '⚠️ ' + data.error;
            updateLastMsg(history[asstIdx].content);
          }
        }
      }

    } catch (e) {
      history[asstIdx].content = '⚠️ 通信エラー: ' + e.message;
      updateLastMsg(history[asstIdx].content);
    } finally {
      busy = false; sendBtn.disabled = false;
      saveHistory();
      removeToolStatus();
      render(); // 最終状態で全再描画（履歴確定）
    }
  }

  // 最後のアシスタントバブルを DOM 直接更新（全再描画せずに済む）
  function updateLastMsg(content) {
    const el = msgsEl.querySelector('.chat-msg-asst:last-of-type');
    if (el) {
      el.textContent = content;
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  }

  // ツール実行中インジケーター
  function showToolStatus(names) {
    let el = document.getElementById('chatToolStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chatToolStatus';
      el.className = 'chat-loading';
      msgsEl.appendChild(el);
    }
    el.textContent = '🔧 ' + names.join(', ') + ' を実行中…';
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function removeToolStatus() {
    const el = document.getElementById('chatToolStatus');
    if (el) el.remove();
  }

  function render() {
    if (history.length === 0) {
      msgsEl.innerHTML = '<div class="chat-empty">【データ取得】選手・監督・チーム・大会の成績を即調査<br>【ウェブ検索】最新ニュース・W杯情報をBraveで検索<br>【スライド操作】「このスライドのナレーション書き換えて」など直接編集可</div>';
      return;
    }
    msgsEl.innerHTML = history.map(m => {
      const cls = m.role === 'user' ? 'chat-msg-user' : 'chat-msg-asst';
      return '<div class="chat-msg ' + cls + '">' + escapeHtml(m.content) + '</div>';
    }).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch (_) {}
  }
})();
</script>
`;
}

module.exports = { router, getUI };
