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
//   const text = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [...], label: "step名" });

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
const costTracker = require("./cost_tracker");

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
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
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
 * @param {{ model, max_tokens, messages, system?, forceProvider?, label? }} opts
 *   forceProvider: "deepseek" | "anthropic" | "kimi" | "gemini" — env無視して特定providerを使う
 *   label: コスト計測ログに表示するラベル（例: "①query_gen", "③entity_expand"）
 * @returns {Promise<string>}
 */
async function callAI({ model, max_tokens, messages, system, forceProvider, label }) {
  const provider = (forceProvider || PROVIDER).toLowerCase();
  const client   = getClient(provider);
  const safeMessages = _sanitizeMessages(messages);
  const safeSystem   = _sanitizeForJson(system);

  if (provider === "deepseek") {
    const msgs = safeSystem
      ? [{ role: "system", content: safeSystem }, ...safeMessages]
      : safeMessages;
    // model 引数が deepseek- で始まる場合はそのまま使う（deepseek-chat 等の切り替え用）
    const dsModel = (model && /^deepseek-/.test(model)) ? model : "deepseek-v4-flash";
    const res = await client.chat.completions.create({
      model:      dsModel,
      max_tokens,
      messages:   msgs,
    });
    costTracker.record({
      label: label || "deepseek",
      provider: "deepseek",
      inputTokens:  res.usage?.prompt_tokens     || 0,
      outputTokens: res.usage?.completion_tokens || 0,
    });
    return res.choices[0].message.content;

  } else if (provider === "gemini") {
    // Google Generative Language API 直叩き (OpenRouter マージンなし)
    const axios = require("axios");
    const useModel = (model && /^gemini-/.test(model)) ? model : (process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const contents = safeMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: typeof m.content === "string" ? m.content : (m.content?.[0]?.text || "") }],
    }));
    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: max_tokens,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },  // 思考トークンがoutputを食い潰すバグ対策
      },
    };
    if (safeSystem) body.system_instruction = { parts: [{ text: safeSystem }] };
    const res = await axios.post(url, body, { headers: { "Content-Type": "application/json" } });
    costTracker.record({
      label: label || "gemini",
      provider: "gemini",
      inputTokens:  res.data?.usageMetadata?.promptTokenCount     || 0,
      outputTokens: res.data?.usageMetadata?.candidatesTokenCount || 0,
    });
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  } else if (provider === "kimi" || provider === "openrouter") {
    // model 未指定 or claude/deepseek 系の指定が来たら .env の KIMI_MODEL を使う
    //   2026-05-24: k2.6 は reasoning モデルで 1 スライド 150s かかるため、 既定を
    //   軽量・半額の k2.5 にダウングレード。 必要なら .env で再上書き可能。
    const defaultKimi = process.env.KIMI_MODEL || "moonshotai/kimi-k2.5";
    const useModel = (model && /^moonshotai\//.test(model)) ? model : defaultKimi;
    const msgs = safeSystem
      ? [{ role: "system", content: safeSystem }, ...safeMessages]
      : safeMessages;
    const reqBody = {
      model:      useModel,
      max_tokens,
      messages:   msgs,
    };
    // 2026-05-24: OpenRouter Provider Routing を env で強制指定可能に。
    //   KIMI_PROVIDER_ORDER=Groq → Groq の LPU で reasoning 抜きの k2-0905 が爆速 (2.8s/7k入力)
    //   カンマ区切りで複数指定可。 KIMI_ALLOW_FALLBACKS=0 で他 provider への落ち禁止。
    const orderEnv = process.env.KIMI_PROVIDER_ORDER;
    if (orderEnv) {
      const order = orderEnv.split(",").map(s => s.trim()).filter(Boolean);
      if (order.length) {
        reqBody.provider = {
          order,
          allow_fallbacks: process.env.KIMI_ALLOW_FALLBACKS !== "0",
        };
      }
    }
    const res = await client.chat.completions.create(reqBody);
    costTracker.record({
      label: label || "kimi",
      provider: "kimi",
      inputTokens:  res.usage?.prompt_tokens     || 0,
      outputTokens: res.usage?.completion_tokens || 0,
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
    costTracker.record({
      label: label || "anthropic",
      provider: "anthropic",
      inputTokens:  finalMessage.usage?.input_tokens  || 0,
      outputTokens: finalMessage.usage?.output_tokens || 0,
    });
    const firstText = (finalMessage.content || []).find((b) => b.type === "text");
    return firstText ? firstText.text : "";
  }
}

// 2026-05-24: sprint パラメータ (boolean | 'kimi' | 'deepseek' | 'sprint') から
//   provider / model / fallback を解決する共通ヘルパ。
//   step2/3/4/6 の各バックエンドが同じパターンで Kimi 経路を扱えるよう統一する。
function resolveSprintMode(sprint) {
  const mode = (typeof sprint === "string") ? sprint.toLowerCase() : (sprint ? "deepseek" : "sonnet");
  if (mode === "kimi") {
    return {
      mode: "kimi",
      provider: "kimi",
      model: process.env.KIMI_MODEL || "moonshotai/kimi-k2.5",
      fallbackProvider: "anthropic",
      fallbackModel: "claude-sonnet-4-6",
      label: "kimi",
      fallbackLabel: "kimi-fallback-sonnet",
    };
  }
  if (mode === "deepseek" || mode === "sprint") {
    return {
      mode: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      fallbackProvider: "anthropic",
      fallbackModel: "claude-sonnet-4-6",
      label: "v4flash-sprint",
      fallbackLabel: "sonnet-fallback",
    };
  }
  return {
    mode: "sonnet",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    fallbackProvider: "deepseek",
    fallbackModel: "deepseek-v4-flash",
    label: "sonnet",
    fallbackLabel: "v4flash-fallback",
  };
}

module.exports = { callAI, PROVIDER, resolveSprintMode };
