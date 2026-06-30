// launcher/viewpoints.js
// 収集した素材から 4〜6個の論点を抽出
// 1つの論点 = 1本の動画

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function callAI(systemPrompt, userPrompt) {
  const providers = [
    { name: 'deepseek', fn: () => callDeepSeek(systemPrompt, userPrompt) },
    { name: 'openai',   fn: () => callOpenAI(systemPrompt, userPrompt) },
    { name: 'gemini',   fn: () => callGemini(systemPrompt, userPrompt) },
  ];

  for (const { name, fn } of providers) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      console.warn(`  [viewpoints] ${name} failed: ${err.message}`);
    }
  }
  throw new Error('All AI providers failed');
}

async function callOpenAI(systemPrompt, userPrompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function callGemini(systemPrompt, userPrompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2000 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

async function callDeepSeek(systemPrompt, userPrompt) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function callAnthropic(systemPrompt, userPrompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  const text = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match[0]);
}

const VALID_PATTERNS = [
  'match_result', 'match_preview', 'match_turning_point',
  'player_performance', 'player_season', 'player_comparison', 'player_milestone',
  'transfer_confirmed', 'transfer_rumor', 'contract_extension',
  'tournament_standings', 'tournament_bracket', 'league_race',
  'team_analysis', 'manager_change', 'controversy', 'injury_update',
  'record_breaking', 'retirement', 'japan_nt_callup', 'japan_abroad',
];

async function extractViewpoints(facts) {
  console.log('\n=== Viewpoints: Extracting angles ===\n');

  const factsText = typeof facts === 'string' ? facts :
    JSON.stringify(facts, null, 2).slice(0, 8000);

  const systemPrompt = `あなたはサッカーYouTubeチャンネルの企画ディレクターです。
与えられた素材から、それぞれ独立した動画になる論点を4〜6個抽出してください。

各論点は:
- 1本のショート〜中尺動画（1〜3分）のテーマになれる粒度
- 視聴者の興味を引く切り口
- 素材のデータで裏付けできる内容

suggestedPattern は以下のリストから必ず1つ選ぶこと（リスト外の値は使用禁止）:
${VALID_PATTERNS.join(', ')}

JSON形式で回答:
{
  "viewpoints": [
    {
      "angle": "切り口の要約（10文字以内）",
      "title": "動画タイトル案（30文字以内、YouTube向け）",
      "keyPoints": ["ポイント1", "ポイント2", "ポイント3"],
      "suggestedPattern": "上記リストから選択",
      "priority": 1-5（5が最も速報性・話題性が高い）
    }
  ]
}`;

  const result = await callAI(systemPrompt, `素材:\n${factsText}`);

  const viewpoints = (result.viewpoints || [])
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  console.log(`  ${viewpoints.length} viewpoints extracted:`);
  viewpoints.forEach((v, i) => {
    console.log(`  ${i + 1}. [P${v.priority}] ${v.angle}: ${v.title}`);
  });

  return viewpoints;
}

module.exports = { extractViewpoints };
