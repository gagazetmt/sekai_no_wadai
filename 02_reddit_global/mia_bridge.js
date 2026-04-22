// mia_bridge.js
// Mia スマホ⇔CLI 独立ブリッジサーバー (Port 3006)
// スマホ(3005)からの指示を、WebSocketで繋がったCLIエージェントにプッシュ送信する

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3006;
app.use(express.json());

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

let cliSocket = null; // 現在接続中のCLIエージェント
let lastReply = null; // 最新の返信

// ── WebSocket: CLIエージェントとの通信 ────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[bridge] CLIエージェントが接続しました');
  cliSocket = ws;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'reply') {
        console.log(`[bridge] CLIからの返信受信: ${data.text.slice(0, 50)}...`);
        lastReply = {
          id: data.id,
          text: data.text,
          timestamp: Date.now()
        };
      }
    } catch (e) {
      console.error('[bridge] メッセージ解析失敗:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[bridge] CLIエージェントが切断されました');
    cliSocket = null;
  });
});

// ── HTTP API: スマホ(3005)からの指示送信 ──────────────────────────────────────
app.post('/api/v2/cli-message', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message が必要です' });

  const msgId = Date.now();
  console.log(`[bridge] スマホから指示受信: ${message}`);

  if (!cliSocket || cliSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'CLIエージェントがオフラインです' });
  }

  // CLIへプッシュ送信
  cliSocket.send(JSON.stringify({
    type: 'instruction',
    id: msgId,
    text: message
  }));

  res.json({ ok: true, id: msgId });
});

// ── HTTP API: 状態確認（スマホ側からのポーリング用） ─────────────────────────
app.get('/api/v2/cli-status', (req, res) => {
  const online = cliSocket !== null && cliSocket.readyState === WebSocket.OPEN;
  res.json({
    reply: lastReply,
    online: online,
    lastSeen: online ? 0 : null
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Mia Bridge Server 起動: http://localhost:${PORT}`);
  console.log(`   スマホ(3005)からのメッセージを待機中...`);
  console.log(`   CLIエージェントの接続を待機中...\n`);
});
