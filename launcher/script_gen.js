// launcher/script_gen.js
// 論点 + 素材 → パターン判定 → mod生成 (narration込み)
//
// フォールバック順: DeepSeek → OpenAI → Gemini
// タイムアウト: 各55秒
// facts圧縮: 必要フィールドのみ送信

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PATTERNS, getPattern, validateMods, buildPiecesPattern } = require('./slide_patterns');

const TIMEOUT_MS = 55000;

// ── AI呼び出し ──────────────────────────────────────

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
      console.warn(`  [script_gen] ${name} failed: ${err.message}`);
    }
  }
  throw new Error('All AI providers failed for script generation');
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
      temperature: 0.4,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  return JSON.parse(text);
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
      temperature: 0.4,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
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
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4000 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

// ── facts 圧縮 ───────────────────────────────────────

function compressFacts(facts) {
  if (typeof facts === 'string') return facts.slice(0, 6000);

  const out = {};

  // 記事: タイトル + スニペットだけ（本文は捨てる）
  if (facts.articles?.length) {
    out.articles = facts.articles.slice(0, 5).map(a => ({
      title:   a.title   || '',
      snippet: (a.text   || a.snippet || '').slice(0, 300),
      url:     a.url     || '',
    }));
  }

  // 試合データはそのまま（元々コンパクト）
  if (facts.matchData) out.matchData = facts.matchData;

  // 選手データ: 必要フィールドのみ
  if (facts.playerData) {
    const pd = facts.playerData;
    out.playerData = {
      name:   pd.name,
      team:   pd.team,
      goals:  pd.goals,
      assists: pd.assists,
      rating: pd.rating,
      stats:  pd.stats ? Object.fromEntries(Object.entries(pd.stats).slice(0, 8)) : undefined,
    };
  }

  // コメント: 各ソース上位を多めに渡す（6-9個×複数スライド分の素材確保）
  if (facts.comments) {
    const c = facts.comments;
    // factsForClient 形式（.all が {text,source}[] ）と full facts 形式（.reddit[] 等）を両対応
    if (Array.isArray(c.all) && c.all.length) {
      out._comments = c.all.slice(0, 25).map(x =>
        `[${x.source || '?'}] ${x.text || ''}`
      ).filter(Boolean);
    } else {
      const pick = (arr, n) => Array.isArray(arr) ? arr.slice(0, n).map(x =>
        `[${x.source || '?'}] ${typeof x === 'string' ? x : x.text || ''}`
      ) : [];
      out._comments = [
        ...pick(c.reddit, 10),
        ...pick(c.yahoo,  8),
        ...pick(c.x,      7),
      ].filter(Boolean);
    }
  }

  return JSON.stringify(out, null, 2).slice(0, 8000);
}

// ── パターン判定 ─────────────────────────────────────

function buildPatternCatalog() {
  return Object.entries(PATTERNS).map(([key, p]) => {
    const types = p.slides.map(s => s.type).join(' → ');
    return `- ${key}: ${p.label}（${p.when}）[${types}]`;
  }).join('\n');
}

async function selectPattern(topic, facts) {
  const catalog = buildPatternCatalog();

  const systemPrompt = `あなたはサッカーYouTube動画の構成ディレクターです。
与えられたトピックと素材から、最適な動画パターンを1つ選んでください。

利用可能なパターン:
${catalog}

JSON形式で回答: {"patternKey": "パターン名", "reason": "選定理由（1文）"}`;

  const result = await callAI(systemPrompt, `トピック: ${topic}\n\n素材:\n${compressFacts(facts)}`);
  getPattern(result.patternKey); // 存在確認
  return result;
}

// ── mod生成 ───────────────────────────────────────────

function buildModSpec(pattern) {
  return pattern.slides.map((slot, i) => {
    const fields = slot.required.join(', ');
    const badge = slot.badge ? ` (badge: "${slot.badge}")` : '';
    return `slides[${i}] type="${slot.type}"${badge}: 必須フィールド [${fields}]`;
  }).join('\n');
}

async function generateMods(patternKey, topic, facts) {
  const pattern = getPattern(patternKey);
  const modSpec  = buildModSpec(pattern);
  const compressed = compressFacts(facts);

  const systemPrompt = `あなたはサッカーYouTube動画のデータ構成AIです。
与えられたトピック・素材・スライド仕様に基づいて、各スライドのmodデータをJSON形式で生成してください。

【ナレーション仕様】
- opening narration: タイトルコールのみ。「〇〇が〇〇した件について見ていきましょう」程度の短い導入（30文字以内）
- コンテンツスライド narration: 話題の概要を口語体で200文字程度にまとめる。事実ベースで視聴者が「へぇ」となる内容
- ending narration: オチの一言のみ。「やっぱ〇〇はすごいな」「これはエモい」程度の締め（30文字以内）

【コメント仕様（opening/ending以外の全スライドに必須）】
- 7〜9個
- 形式: [{text:"日本語", source:"x"|"reddit"|"yahoo"}, ...]
- 1コメント40〜120文字を優先（短すぎず、読んで面白いもの）
- 素材の_commentsから使う。英文コメントは内容を踏まえた面白い日本語意訳（直訳NG）
- 不足時は視聴者が書きそうなリアルな反応を生成（source:"x"）
- 必ず7個以上生成すること

【その他フィールド仕様】
- title: スライド見出し（日本語・短く印象的に）
- badge: バッジテキスト（opening/endingのみ。例: 速報、注目、朗報、衝撃）
- catchphrases: insight用。論点の箇条書き配列（3〜5個、各20文字以内）
- siBinding: stats/history用。英語名（選手名 or チーム名）。画像検索キー
- siBindingLeft / siBindingRight: comparison用。左右対象の英語名
- dataSlots: データ配列
  - stats用: [{label:"項目名", value:"値"}, ...] 最大6個
  - history用: [{label:"年や時期", value:"出来事"}, ...] 最大6個
  - comparison用: [{label:"比較項目", leftValue:"左", rightValue:"右"}, ...] 最大7個
- historyHero: history左側の大きなテキスト（漢字2〜3文字）
- matchData: matchcard用の試合データ
  - homeTeam, awayTeam, homeScore, awayScore (必須)
  - tournament, matchDate, venue
  - goals: [{player, timeStr, isHome}, ...]
  - cards: [{player, timeStr, cardType, isHome}, ...]
  - stats: {"Ball possession": {home:55, away:45}, ...}
  - lineup: {home:[{name,pos},...], away:[{name,pos},...]}
  - formations: {home:"4-3-3", away:"4-2-3-1"}
- bgImage: null（後工程で設定）
- leftImage / rightImage: null（comparison用、後工程）

【注意】
- 素材の実データを優先。推測で事実を捏造しない
- 日本語で表現。選手名英語表記は siBinding 系のみ
- 必ず全スライド分を生成する（${pattern.slides.length}個）`;

  const userPrompt = `トピック: ${topic}

素材:
${compressed}

生成するスライド構成:
${modSpec}

以下のJSON形式で返してください:
{"mods": [slide0のmod, slide1のmod, ..., slide${pattern.slides.length - 1}のmod]}`;

  const result = await callAI(systemPrompt, userPrompt);

  if (!result.mods || !Array.isArray(result.mods)) {
    throw new Error('AI response missing "mods" array');
  }

  // スライド数不足はエラー、超過は切り捨て
  if (result.mods.length < pattern.slides.length) {
    throw new Error(`Expected ${pattern.slides.length} mods, got ${result.mods.length}`);
  }
  const mods = result.mods.slice(0, pattern.slides.length);

  // matchcard の matchData フィールドをフラット化
  pattern.slides.forEach((slot, i) => {
    if (slot.type === 'matchcard' && mods[i].matchData) {
      const md = mods[i].matchData;
      for (const field of slot.required) {
        if (mods[i][field] === undefined && md[field] !== undefined) {
          mods[i][field] = md[field];
        }
      }
    }
    // スライドタイプ・後工程画像フィールドを注入
    mods[i].type       = slot.type;
    mods[i].bgImage    = null;
    mods[i].leftImage  = null;
    mods[i].rightImage = null;
  });

  const validation = validateMods(patternKey, mods);
  if (!validation.valid) {
    console.warn('  [script_gen] Validation warnings:', validation.errors);
  }

  return mods;
}

// ── 企画ピース用 mod 生成 ────────────────────────────
// selectedViewpoints: [{angle, title, keyPoints, suggestedPattern, priority}, ...]

// selectedViewpoints: [{angle, title, keyPoints, slideType?, ...}, ...]
// slideType は 'insight'|'matchcard'|'stats'|'comparison'|'history'
async function generateModsForPieces(selectedViewpoints, facts) {
  const count = selectedViewpoints.length;
  if (count < 1 || count > 2) throw new Error('selectedViewpoints は1〜2個');

  const contentTypes = selectedViewpoints.map(vp => vp.slideType || 'insight');
  const pattern = buildPiecesPattern(contentTypes);
  const patternKey = `pieces_${count}`;

  const compressed = compressFacts(facts);

  const SLIDE_TYPE_SPEC = {
    insight:    '- title, narration（200文字程度の概要）, catchphrases（3-5個・各20文字以内）, comments（7-9個・各40-120文字）',
    matchcard:  '- homeTeam, awayTeam, homeScore, awayScore（必須）, goals[{player,timeStr,isHome}], stats{"Ball possession":{home,away}...}, lineup{home:[{name,pos}],away:[{name,pos}]}, formations{home,away}, tournament, matchDate, venue, narration（200文字程度の概要）',
    stats:      '- title, narration（200文字程度の概要）, siBinding（英語名・画像キー）, dataSlots[{label,value}]（最大6個）, comments（7-9個・各40-120文字）',
    comparison: '- title, narration（200文字程度の概要）, siBindingLeft, siBindingRight（英語名）, dataSlots[{label,leftValue,rightValue}]（最大7個）, comments（7-9個・各40-120文字）',
    history:    '- title, narration（200文字程度の概要）, historyHero（漢字2-3文字）, dataSlots[{label,value}]（最大6個）, comments（7-9個・各40-120文字）',
  };

  const piecesText = selectedViewpoints.map((vp, i) => {
    const t = contentTypes[i];
    return `企画ピース${i + 1}（スライドタイプ: ${t}）:\n  切り口: ${vp.angle}\n  タイトル案: ${vp.title}\n  ポイント:\n${(vp.keyPoints || []).map(p => `    - ${p}`).join('\n')}`;
  }).join('\n\n');

  const systemPrompt = `あなたはサッカーYouTube動画のデータ構成AIです。
選ばれた企画ピース（${count}個）をもとに、${pattern.slides.length}枚のスライドデータをJSON形式で生成してください。

【ナレーション仕様】
- opening narration: タイトルコールのみ。「〇〇について見ていきましょう」程度の短い導入（30文字以内）
- コンテンツスライド narration: 話題の概要を口語体で200文字程度にまとめる。事実ベースで視聴者が「へぇ」となる内容
- ending narration: オチの一言のみ。「やっぱ〇〇はすごいな」「これはエモい」程度の締め（30文字以内）

【コメント仕様（opening/ending以外のスライドに必須）】
- 7〜9個
- 形式: [{text:"日本語", source:"x"|"reddit"|"yahoo"}, ...]
- 1コメント40〜120文字を優先（短すぎず、読んで面白いもの）
- 素材の_commentsから使う。英文コメントは内容を踏まえた面白い日本語意訳（直訳NG）
- 不足時は視聴者が書きそうなリアルな反応を生成（source:"x"）
- 必ず7個以上生成すること

【スライド構成】
- slides[0]: opening — title（10文字以内・インパクト重視）+ badge="速報"固定 + narration（上記仕様）
${selectedViewpoints.map((vp, i) => {
  const t = contentTypes[i];
  return `- slides[${i + 1}]: ${t} — 企画ピース${i + 1}「${vp.angle}」\n  必須フィールド: ${SLIDE_TYPE_SPEC[t] || SLIDE_TYPE_SPEC.insight}`;
}).join('\n')}
- slides[${count + 1}]: ending — title（「チャンネル登録」等）+ narration（上記仕様）

【共通注意】
- 素材の実データを優先。事実の捏造禁止
- 全${pattern.slides.length}枚分を必ず生成`;

  const userPrompt = `選択された企画ピース:\n${piecesText}\n\n素材:\n${compressed}\n\nJSON形式で返してください:\n{"mods": [slide0, ${selectedViewpoints.map((_, i) => `slide${i + 1}`).join(', ')}, slide${count + 1}]}`;

  const result = await callAI(systemPrompt, userPrompt);
  if (!result.mods || !Array.isArray(result.mods)) throw new Error('AI response missing "mods" array');
  if (result.mods.length < pattern.slides.length) throw new Error(`Expected ${pattern.slides.length} mods, got ${result.mods.length}`);

  const mods = result.mods.slice(0, pattern.slides.length);

  // スライドタイプ注入 + matchcard フラット化 + 後工程フィールド初期化
  pattern.slides.forEach((slot, i) => {
    mods[i].type = slot.type;
    if (slot.type === 'matchcard' && mods[i]?.matchData) {
      const md = mods[i].matchData;
      for (const field of slot.required) {
        if (mods[i][field] === undefined && md[field] !== undefined) mods[i][field] = md[field];
      }
    }
    mods[i].bgImage = null; mods[i].leftImage = null; mods[i].rightImage = null;
  });

  // 動的パターンは validateMods がキー検索するので直接検証
  const errors = [];
  pattern.slides.forEach((slot, i) => {
    const mod = mods[i];
    if (!mod) { errors.push(`slides[${i}]: mod なし`); return; }
    for (const field of slot.required) {
      if (mod[field] === undefined || mod[field] === null) errors.push(`slides[${i}] (${slot.type}): "${field}" 未設定`);
    }
  });
  const validation = { valid: errors.length === 0, errors };
  if (!validation.valid) console.warn('  [script_gen] Validation warnings:', validation.errors);

  return { patternKey, pattern, mods, validation };
}

// ── メインAPI ─────────────────────────────────────────

async function generateScript(topic, facts) {
  console.log(`\n=== Script Generation ===`);
  console.log(`  Topic: ${topic}\n`);

  console.log('  Step 1: Selecting pattern...');
  const { patternKey, reason } = await selectPattern(topic, facts);
  console.log(`  → ${patternKey} (${PATTERNS[patternKey].label})`);
  console.log(`  → Reason: ${reason}\n`);

  console.log('  Step 2: Generating mods...');
  const mods = await generateMods(patternKey, topic, facts);
  console.log(`  → ${mods.length} mods generated\n`);

  const validation = validateMods(patternKey, mods);
  if (validation.valid) {
    console.log('  ✓ All required fields present');
  } else {
    console.log('  ✗ Missing fields:');
    validation.errors.forEach(e => console.log(`    - ${e}`));
  }

  return { patternKey, mods, validation };
}

module.exports = { generateScript, selectPattern, generateMods, generateModsForPieces };
