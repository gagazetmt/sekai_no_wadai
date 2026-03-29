// ai_client.js
// AI プロバイダー切り替えモジュール
//
// .env の AI_PROVIDER で切り替え:
//   AI_PROVIDER=deepseek   → DeepSeek API（格安）
//   AI_PROVIDER=anthropic  → Anthropic API（高品質）
//
// 使い方:
//   const { callAI } = require("./ai_client");
//   const text = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [...] });

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();

let _client = null;

function getClient() {
  if (_client) return _client;
  if (PROVIDER === "deepseek") {
    const OpenAI = require("openai");
    _client = new OpenAI({
      apiKey:  process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    });
  } else {
    const Anthropic = require("@anthropic-ai/sdk");
    _client = new Anthropic();
  }
  return _client;
}

/**
 * AIにメッセージを送り、テキスト応答を返す
 * @param {{ model: string, max_tokens: number, messages: Array }} opts
 * @returns {Promise<string>}
 */
async function callAI({ model, max_tokens, messages }) {
  const client = getClient();
  if (PROVIDER === "deepseek") {
    const res = await client.chat.completions.create({
      model:      "deepseek-chat",
      max_tokens,
      messages,
    });
    return res.choices[0].message.content;
  } else {
    const res = await client.messages.create({ model, max_tokens, messages });
    return res.content[0].text;
  }
}

module.exports = { callAI, PROVIDER };
