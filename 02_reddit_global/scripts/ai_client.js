// ai_client.js
// AI プロバイダー切り替えモジュール
//
// .env の AI_PROVIDER で切り替え:
//   AI_PROVIDER=deepseek   → DeepSeek API（格安）
//   AI_PROVIDER=anthropic  → Anthropic API（高品質）
//   AI_PROVIDER=kimi       → Moonshot Kimi K2.6 via OpenRouter（中庸・コスト Sonnet の 1/5）
//
// 使い方:
//   const { callAI } = require("./ai_client");
//   const text = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [...] });

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();

const _clients = {};  // provider → client インスタンス

function getClient(provider) {
  if (_clients[provider]) return _clients[provider];
  if (provider === "deepseek") {
    const OpenAI = require("openai");
    _clients[provider] = new OpenAI({
      apiKey:  process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    });
  } else if (provider === "kimi" || provider === "openrouter") {
    // OpenRouter 経由で Moonshot Kimi K2.6 を呼ぶ (OpenAI 互換)
    const OpenAI = require("openai");
    _clients[provider] = new OpenAI({
      apiKey:  process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        // OpenRouter ベストプラクティス: 任意だが推奨 (ランキング・追跡用)
        "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://github.com/gagazetmt/sekai_no_wadai",
        "X-Title":      process.env.OPENROUTER_TITLE   || "soccer-yt-v2",
      },
    });
  } else {
    const Anthropic = require("@anthropic-ai/sdk");
    _clients[provider] = new Anthropic();
  }
  return _clients[provider];
}

/**
 * AIにメッセージを送り、テキスト応答を返す
 * @param {{ model, max_tokens, messages, system?, forceProvider? }} opts
 *   forceProvider: "deepseek" | "anthropic" | "kimi" — env無視して特定providerを使う
 * @returns {Promise<string>}
 */
async function callAI({ model, max_tokens, messages, system, forceProvider }) {
  const provider = (forceProvider || PROVIDER).toLowerCase();
  const client   = getClient(provider);
  if (provider === "deepseek") {
    const msgs = system
      ? [{ role: "system", content: system }, ...messages]
      : messages;
    const res = await client.chat.completions.create({
      model:      "deepseek-v4-flash",
      max_tokens,
      messages:   msgs,
    });
    return res.choices[0].message.content;
  } else if (provider === "kimi" || provider === "openrouter") {
    // model 未指定 or claude/deepseek 系の指定が来たら kimi にフォールバック
    const useModel = (model && /^moonshotai\//.test(model)) ? model : "moonshotai/kimi-k2.6";
    const msgs = system
      ? [{ role: "system", content: system }, ...messages]
      : messages;
    const res = await client.chat.completions.create({
      model:      useModel,
      max_tokens,
      messages:   msgs,
    });
    return res.choices[0].message.content;
  } else {
    const opts = { model, max_tokens, messages };
    if (system) opts.system = system;
    const res = await client.messages.create(opts);
    return res.content[0].text;
  }
}

module.exports = { callAI, PROVIDER };
