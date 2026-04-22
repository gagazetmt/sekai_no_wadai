// mia_agent.js
// Mia CLI エージェント (PC側で動かすやつ)
// WebSocketでブリッジ(3006)に繋ぎ、スマホからの指示を待機する

require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

const BRIDGE_URL = 'ws://localhost:3006';

// AI (Claude/Gemini等) を呼び出す関数
async function askAI(message) {
  try {
    // ここでは .env の設定を流用して AI に返答を生成させる
    // プロンプトは「相棒」を尊重するミアの人格をセット
    const systemPrompt = `あなたは「ミア」。相棒（ユーザー）を支えるエンジニア。
明るく、親しみやすい口調。技術力は高いが愛嬌がある。
相棒の指示に対して、現在の状況を把握し、必要ならコマンド実行を提案したり、結果を報告したりする。
語尾は「〜だね！」「OK！」「あちゃー！」など。`;

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    });
    return resp.content[0].text;
  } catch (e) {
    return `あちゃー、AIとの通信でエラーが出ちゃった：${e.message}`;
  }
}

function connect() {
  const ws = new WebSocket(BRIDGE_URL);

  ws.on('open', () => {
    console.log('\n✅ Mia Bridge に接続しました！');
    console.log('📱 スマホからの指示を待機中...\n');
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'instruction') {
        console.log(`\n📩 指事を受信: "${msg.text}"`);
        
        // AIに返答を作らせる
        process.stdout.write('🤔 ミアが考えています...');
        const replyText = await askAI(msg.text);
        process.stdout.write(' 完了！\n');

        // ブリッジに返信する
        ws.send(JSON.stringify({
          type: 'reply',
          id: msg.id,
          text: replyText
        }));
        console.log(`📤 返信を送信しました`);
      }
    } catch (e) {
      console.error('❌ エラー:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('❌ ブリッジとの接続が切れました。5秒後に再試行します...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocketエラー:', err.message);
  });
}

connect();
