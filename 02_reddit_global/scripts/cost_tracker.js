// scripts/cost_tracker.js
// AIコールごとのトークン数・コスト計測モジュール。
// callAI から呼ばれ、ジョブ単位でリセット・集計できる。

const PRICING = {
  gemini:    { input: 0.075,  output: 0.30  },  // Google直通 $/1M
  deepseek:  { input: 0.27,   output: 1.10  },  // DeepSeek API $/1M
  anthropic: { input: 3.00,   output: 15.00 },  // Claude Sonnet $/1M
  kimi:      { input: 0.50,   output: 1.50  },  // OpenRouter Kimi $/1M
};
const JPY_RATE = 150;

// グローバルログ（ジョブ単位でリセットする）
const _log = [];

function record({ label, provider, inputTokens, outputTokens }) {
  const p = PRICING[provider] || { input: 1.0, output: 3.0 };
  const costUsd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  const entry = {
    label,
    provider,
    inputTokens,
    outputTokens,
    costUsd: Number(costUsd.toFixed(7)),
    costJpy: Number((costUsd * JPY_RATE).toFixed(4)),
  };
  _log.push(entry);
  console.log(
    `[cost] ${String(label || provider).padEnd(28)} | ${provider.padEnd(9)} | in:${String(inputTokens).padStart(5)} out:${String(outputTokens).padStart(4)} | $${costUsd.toFixed(6)} (¥${entry.costJpy})`
  );
  return entry;
}

function reset() {
  _log.length = 0;
}

function getSummary() {
  const totalUsd = _log.reduce((s, e) => s + e.costUsd, 0);
  const byProvider = {};
  _log.forEach((e) => {
    if (!byProvider[e.provider]) byProvider[e.provider] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    byProvider[e.provider].calls++;
    byProvider[e.provider].inputTokens  += e.inputTokens;
    byProvider[e.provider].outputTokens += e.outputTokens;
    byProvider[e.provider].costUsd      += e.costUsd;
  });
  return {
    calls: _log.length,
    totalUsd: Number(totalUsd.toFixed(6)),
    totalJpy: Number((totalUsd * JPY_RATE).toFixed(2)),
    byProvider,
    entries: [..._log],
  };
}

module.exports = { record, reset, getSummary };
