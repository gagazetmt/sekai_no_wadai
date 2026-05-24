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

// 2026-05-24: 孤立サロゲート (lone surrogate) を除去。
//   wiki 全文 / curated 記事を prompt に流し込む過程で UTF-16 ペアが片割れだけ
//   残ることがあり、DeepSeek の JSON パーサが「unexpected end of hex escape」で
//   400 を返す事象が発生。送信前に � へ置換する。
function _sanitizeForJson(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}
function _sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    if (typeof m.content === "string") return { ...m, content: _sanitizeForJson(m.content) };
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((part) =>
          part && typeof part === "object" && typeof part.text === "string"
            ? { ...part, text: _sanitizeForJson(part.text) }
            : part
        ),
      };
    }
    return m;
  });
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
  const safeMessages = _sanitizeMessages(messages);
  const safeSystem   = _sanitizeForJson(system);
  if (provider === "deepseek") {
    const msgs = safeSystem
      ? [{ role: "system", content: safeSystem }, ...safeMessages]
      : safeMessages;
    const res = await client.chat.completions.create({
      model:      "deepseek-v4-flash",
      max_tokens,
      messages:   msgs,
    });
    return res.choices[0].message.content;
  } else if (provider === "kimi" || provider === "openrouter") {
    // model 未指定 or claude/deepseek 系の指定が来たら kimi にフォールバック
    const useModel = (model && /^moonshotai\//.test(model)) ? model : "moonshotai/kimi-k2.6";
    const msgs = safeSystem
      ? [{ role: "system", content: safeSystem }, ...safeMessages]
      : safeMessages;
    const res = await client.chat.completions.create({
      model:      useModel,
      max_tokens,
      messages:   msgs,
    });
    return res.choices[0].message.content;
  } else {
    // 2026-05-24: max_tokens 24000 で non-streaming だと
    //   「Streaming is required for operations that may take longer than 10 minutes」
    //   を 400 で返されるため、streaming で受けて全文を組み立てて返す。
    const opts = { model, max_tokens, messages: safeMessages };
    if (safeSystem) opts.system = safeSystem;
    const stream = client.messages.stream(opts);
    const finalMessage = await stream.finalMessage();
    const firstText = (finalMessage.content || []).find((b) => b.type === "text");
    return firstText ? firstText.text : "";
  }
}

module.exports = { callAI, PROVIDER };
