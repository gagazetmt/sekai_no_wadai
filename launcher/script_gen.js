// launcher/script_gen.js
// 論点 + 素材 → パターン判定 → mod生成 (narration込み)
//
// フォールバック順: DeepSeek → OpenAI → Gemini
// タイムアウト: 各55秒
// facts圧縮: 必要フィールドのみ送信

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PATTERNS, getPattern, validateMods, buildPiecesPattern, CONTENT_SLIDE_REQUIRED } = require('./slide_patterns');

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

// matchData から重い data URI（選手写真・チームロゴ）を剥がしたコピーを返す。
// AIへ渡すと無駄なトークン消費＆AIが写真を再生成できないため。実データは別途再注入する。
function _stripMatchMedia(md) {
  if (!md || typeof md !== 'object') return md;
  const clone = JSON.parse(JSON.stringify(md));
  delete clone.homeLogo; delete clone.awayLogo;
  ['home', 'away'].forEach(side => {
    const arr = clone.lineup?.[side];
    if (Array.isArray(arr)) arr.forEach(p => { delete p.photo; });
  });
  return clone;
}

// AI生成後の matchcard mod に、実 facts.matchData（選手写真・フォメ・ロゴ・正確なラインアップ）を再注入する。
// AIが作り直した matchData は写真等を欠落させるため、構造データは実データで上書きする（narration等のAI文は維持）。
function injectRealMatchData(mods, pattern, facts) {
  if (!facts?.matchData?.ok) return;
  pattern.slides.forEach((slot, i) => {
    if (slot.type !== 'matchcard' || !mods[i]) return;
    const md = facts.matchData;
    // 既存の matchData（AI生成）に実データをマージ。実データのある構造フィールドを優先。
    mods[i].matchData = { ...(mods[i].matchData || {}), ...md };
    // フラット化済みの上位フィールドも実データで補正
    const FIELDS = ['homeTeam', 'awayTeam', 'homeScore', 'awayScore', 'goals', 'cards', 'subs', 'stats', 'lineup', 'formations', 'tournament', 'matchDate', 'venue'];
    FIELDS.forEach(f => { if (md[f] !== undefined && md[f] !== null) mods[i][f] = md[f]; });
  });
}

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

  // 試合データ: AIに渡す用は重い画像データURI（選手写真・ロゴ）を剥がして軽量化
  //   実データ（写真付き）は generateMods 側で生成後に matchcard へ再注入する
  if (facts.matchData) out.matchData = _stripMatchMedia(facts.matchData);

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
  try {
    getPattern(result.patternKey); // 存在確認
  } catch (_) {
    console.warn(`  [pattern] 未知パターン "${result.patternKey}" → match_result にフォールバック`);
    result.patternKey = 'match_result';
  }
  return result;
}

// ── 実コメント注入（AI生成ではなく facts.comments.all から直接選ぶ） ────

async function injectRealComments(mods, pattern, facts, topic) {
  const all = facts?.comments?.all || [];
  if (!all.length) return;

  // 短すぎを除外し、120字で切り捨て（3行=120字が最大表示幅）
  const pool = all
    .filter(c => c.text && c.text.trim().length >= 12)
    .map(c => ({ ...c, text: c.text.trim().slice(0, 120) }));
  if (!pool.length) return;

  // 英語コメントを検出（ひらがな・カタカナ・漢字がほぼない）
  const isEnglish = t => !/[぀-ヿ一-鿿]/.test(t.slice(0, 40));

  // 英語コメントをまとめて翻訳（DeepSeek 1回呼び出し）
  const engIdx = pool.map((c, i) => isEnglish(c.text) ? i : -1).filter(i => i >= 0);
  if (engIdx.length) {
    try {
      const { callDeepSeek } = require('./scout');
      const lines = engIdx.map(i => `${i}: ${pool[i].text}`).join('\n');
      const res = await callDeepSeek(
        '英語コメントを自然な日本語に翻訳してください。内容・意味・トーンを変えず直訳してください。返答は JSON {"translations":{"0":"訳","1":"訳",...}} のみ。',
        lines
      );
      const tr = res.translations || {};
      engIdx.forEach(i => {
        if (tr[String(i)]) pool[i] = { ...pool[i], text: tr[String(i)] };
      });
    } catch (err) { console.warn(`  [comments] 英語翻訳失敗: ${err.message}`); }
  }

  // X コメントをトピックキーワードでフィルタ（Yahoo/Reddit はそのまま通す）
  const topicWords = topic ? topic.split(/[\s　]+/).filter(w => w.length >= 2) : [];
  const filteredPool = topicWords.length
    ? pool.filter(c => {
        if (c.source !== 'x') return true;
        return topicWords.some(w => c.text.includes(w));
      })
    : pool;
  const effectivePool = filteredPool.length >= 4 ? filteredPool : pool; // フォールバック
  const xFiltered = pool.length - effectivePool.length;
  if (xFiltered > 0) console.log(`  [comments] X フィルタ除外: ${xFiltered}件（無関係コメント）`);

  // コンテンツスライドにインターリーブで配布（奇偶 → Yahoo/X が両スライドに均等混在）
  const contentIdxs = pattern.slides
    .map((s, i) => i)
    .filter(i => pattern.slides[i].type !== 'opening' && pattern.slides[i].type !== 'ending');
  const nSlides = contentIdxs.length || 1;
  for (let ci = 0; ci < contentIdxs.length; ci++) {
    const i = contentIdxs[ci];
    const selected = effectivePool.filter((_, idx) => idx % nSlides === ci).slice(0, 20);
    const fallback = selected.length < 4 ? effectivePool.slice(0, Math.min(20, effectivePool.length)) : selected;
    mods[i].comments = fallback.map(c => ({ text: c.text.trim(), source: c.source || 'x' }));
    const yc = fallback.filter(c => c.source === 'yahoo').length;
    const xc = fallback.filter(c => c.source === 'x').length;
    console.log(`  [comments] slide${i}: ${fallback.length}件（yahoo:${yc} x:${xc}）`);
  }
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
- opening narration: title と完全に同じテキストをそのまま設定（TTS がタイトルを読み上げるだけ）
- コンテンツスライド narration: 5ch速報まとめサイト風・丁寧語で150〜200文字。
  構成: ①小見出しフック1文（「〜の記録がこちら」「〜の振る舞いが話題になっています」等）→ ②事実の概要を2〜3文テンポよく → ③「なお、〜の模様です」で意外な補足1文
  口調: 「〜の模様です」「〜とのこと」「なお〜」「〜が話題になっています」等の丁寧なまとめ語り。タメ口NG
  例: 「◯◯の今大会成績がこちら。3試合で2ゴール1アシストと存在感を見せています。なお◯◯はこの試合でも先制点を演出しており、衰えを感じさせない模様です」
- ending narration: 話題に即した秀逸なオチの一言（25〜40文字）。
  【絶対NG】「やっぱ〇〇はやべぇ」「エモい」「すごい」等の感情吐露だけで終わる文。
  【必須】意外な事実・皮肉な対比・逆説・ズレ感でオチをつける。話題のどんでん返し的一言が理想。
  例の型: 「なおこの試合、◯◯のシュート数は0本でした」「ちなみに翌日の現地紙見出しは"奇跡"ではなく"醜聞"でした」「余談ですがこの時◯◯監督のリリースは用意されていた模様です」

【その他フィールド仕様】
- title: スライド見出し（日本語・短く印象的に）
- badge: バッジテキスト（opening/endingのみ。例: 速報、注目、朗報、衝撃）
- catchphrases: insight用。論点の箇条書き配列（3〜5個、各20文字以内）
- siBinding: 英語名（選手名 or チーム名）。画像検索キー。insight/stats/history スライド全てに設定する（例: "Kaoru Mitoma", "Liverpool FC"）
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
- 素材に記載がない第三者の具体的な数値（得点数・試合数・順位等）は絶対に書かない。「○○は今大会△点」のような文は素材に根拠がある場合のみ使用する
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

  // matchcard に実試合データ（選手写真・フォメ・ロゴ）を再注入
  injectRealMatchData(mods, pattern, facts);

  // 実コメントを注入（AIに生成させない）
  await injectRealComments(mods, pattern, facts, topic);

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
    insight:    '- title, narration（200文字程度の概要）, catchphrases（3-5個・各20文字以内）, siBinding（英語名・主要選手orチーム名）',
    matchcard:  '- homeTeam, awayTeam, homeScore, awayScore（必須）, goals[{player,timeStr,isHome}], stats{"Ball possession":{home,away}...}, lineup{home:[{name,pos}],away:[{name,pos}]}, formations{home,away}, tournament, matchDate, venue, narration（200文字程度の概要）',
    stats:      '- title, narration（200文字程度の概要）, siBinding（英語名・画像キー）, dataSlots[{label,value}]（最大6個）',
    comparison: '- title, narration（200文字程度の概要）, siBindingLeft, siBindingRight（英語名）, dataSlots[{label,leftValue,rightValue}]（最大7個）',
    history:    '- title, narration（200文字程度の概要）, historyHero（漢字2-3文字）, dataSlots[{label,value}]（最大6個）',
  };

  const piecesText = selectedViewpoints.map((vp, i) => {
    const t = contentTypes[i];
    return `企画ピース${i + 1}（スライドタイプ: ${t}）:\n  切り口: ${vp.angle}\n  タイトル案: ${vp.title}\n  ポイント:\n${(vp.keyPoints || []).map(p => `    - ${p}`).join('\n')}`;
  }).join('\n\n');

  const systemPrompt = `あなたはサッカーYouTube動画のデータ構成AIです。
選ばれた企画ピース（${count}個）をもとに、${pattern.slides.length}枚のスライドデータをJSON形式で生成してください。

【ナレーション仕様】
- opening narration: title と完全に同じテキストをそのまま設定（TTS がタイトルを読み上げるだけ）
- コンテンツスライド narration: 5ch速報まとめサイト風・丁寧語で150〜200文字。
  構成: ①小見出しフック1文（「〜の記録がこちら」「〜の振る舞いが話題になっています」等）→ ②事実の概要を2〜3文テンポよく → ③「なお、〜の模様です」で意外な補足1文
  口調: 「〜の模様です」「〜とのこと」「なお〜」「〜が話題になっています」等の丁寧なまとめ語り。タメ口NG
  例: 「◯◯の今大会成績がこちら。3試合で2ゴール1アシストと存在感を見せています。なお◯◯はこの試合でも先制点を演出しており、衰えを感じさせない模様です」
- ending narration: 話題に即した秀逸なオチの一言（25〜40文字）。
  【絶対NG】「やっぱ〇〇はやべぇ」「エモい」「すごい」等の感情吐露だけで終わる文。
  【必須】意外な事実・皮肉な対比・逆説・ズレ感でオチをつける。話題のどんでん返し的一言が理想。
  例の型: 「なおこの試合、◯◯のシュート数は0本でした」「ちなみに翌日の現地紙見出しは"奇跡"ではなく"醜聞"でした」「余談ですがこの時◯◯監督のリリースは用意されていた模様です」

【スライド構成】
- slides[0]: opening — title（20〜35文字・YouTubeサムネイルと同レベルのキャッチーな見出し。例: "ロナウドがまさかの落選！ポルトガルに激震走る"）+ badge（推論）+ narration = title と同じテキスト
${selectedViewpoints.map((vp, i) => {
  const t = contentTypes[i];
  return `- slides[${i + 1}]: ${t} — 企画ピース${i + 1}「${vp.angle}」\n  必須フィールド: ${SLIDE_TYPE_SPEC[t] || SLIDE_TYPE_SPEC.insight}`;
}).join('\n')}
- slides[${count + 1}]: ending — title（話題に即したオチの一言・15文字以内）+ narration（上記仕様）

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
  // matchcard に実試合データ（選手写真・フォメ・ロゴ）を再注入
  injectRealMatchData(mods, pattern, facts);

  // 実コメントを注入（AIに生成させない）
  await injectRealComments(mods, pattern, facts, facts?.topic || null);

  const validation = { valid: errors.length === 0, errors };
  if (!validation.valid) console.warn('  [script_gen] Validation warnings:', validation.errors);

  return { patternKey, pattern, mods, validation };
}

// ── 4スライド自動生成（企画ピース工程なし） ────────────
// タイプ選択 + mod生成を1回のAIコールで完結
// 返り値: { patternKey, pattern, mods, validation }

async function generateModsAuto(topic, facts) {
  console.log('\n=== Script Gen: 4スライド自動生成 ===');
  const compressed = compressFacts(facts);

  const SLIDE_TYPE_SPEC = {
    insight:    'title, narration（200文字）, catchphrases（3-5個・各20文字以内）',
    matchcard:  'homeTeam, awayTeam, homeScore, awayScore, goals[{player,timeStr,isHome}], stats{"Ball possession":{home,away},...}, lineup{home:[{name,pos}],away:[{name,pos}]}, formations{home,away}, tournament, matchDate, venue, narration（200文字）',
    stats:      'title, narration（200文字）, siBinding（英語名）, dataSlots[{label,value}]（最大6個）',
    comparison: 'title, narration（200文字）, siBindingLeft, siBindingRight（英語名）, dataSlots[{label,leftValue,rightValue}]（最大7個）',
    history:    'title, narration（200文字）, historyHero（漢字2-3文字）, dataSlots[{label,value}]（最大6個）',
  };

  const systemPrompt = `あなたはサッカーYouTube動画のデータ構成AIです。
案件・素材から4スライド動画データをワンショットで生成してください。

【スライド構成（固定）】
slides[0]: opening — title（20〜35文字・キャッチーな見出し）+ narration = title と同じ + badge（推論）
slides[1]: コンテンツA（下記タイプから素材に合うものを選択）
slides[2]: コンテンツB（下記タイプから素材に合うものを選択）
slides[3]: ending — title（15文字以内のオチ一言）+ narration（意外な事実・逆説・ズレ感のオチ・25〜40文字）

【コンテンツタイプ選択ルール】
- matchcard: 試合スコア・得点者・選手データが揃っている場合（スコアデータ必須）
- stats: 選手の個人スタッツが中心の場合
- history: キャリア歴史・時系列記録がある場合
- comparison: 2選手/チームを並べて比較する場合
- insight: テキスト考察・話題まとめ（上記が合わない場合のデフォルト）

【各タイプの必須フィールド】
${Object.entries(SLIDE_TYPE_SPEC).map(([t, spec]) => `- ${t}: ${spec}`).join('\n')}

【ナレーション仕様（コンテンツスライド）】
5ch速報まとめサイト風・丁寧語150〜200文字。
①フック1文（「〜の記録がこちら」「〜が話題になっています」）→ ②事実2〜3文 → ③「なお〜の模様です」で意外な補足1文

【注意】
- 素材の実データのみ使用。数値・事実の捏造禁止
- 素材に記載がない第三者の具体的な数値（得点数・試合数等）は絶対に生成しない
- 全4枚を必ず生成

JSON: {"contentTypes": ["typeA", "typeB"], "mods": [slide0, slide1, slide2, slide3]}`;

  const result = await callAI(systemPrompt, `トピック: ${topic}\n\n素材:\n${compressed}`);

  const validTypes = Object.keys(CONTENT_SLIDE_REQUIRED);
  const contentTypes = (result.contentTypes || [])
    .filter(t => validTypes.includes(t)).slice(0, 2);
  while (contentTypes.length < 2) contentTypes.push('insight');

  console.log(`  コンテンツタイプ: ${contentTypes.join(' + ')}`);

  const pattern = buildPiecesPattern(contentTypes);

  if (!result.mods || !Array.isArray(result.mods) || result.mods.length < 4) {
    throw new Error(`mods 不足: ${result.mods?.length ?? 0}枚`);
  }
  const mods = result.mods.slice(0, 4);

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

  injectRealMatchData(mods, pattern, facts);
  await injectRealComments(mods, pattern, facts, topic);

  const errors = [];
  pattern.slides.forEach((slot, i) => {
    const mod = mods[i];
    if (!mod) { errors.push(`slides[${i}]: mod なし`); return; }
    for (const field of slot.required) {
      if (mod[field] === undefined || mod[field] === null)
        errors.push(`slides[${i}] (${slot.type}): "${field}" 未設定`);
    }
  });
  const validation = { valid: errors.length === 0, errors };
  if (!validation.valid) console.warn('  [script_gen] Validation warnings:', validation.errors);

  return { patternKey: 'pieces_2', pattern, mods, validation };
}

module.exports = { generateModsAuto, generateMods, generateModsForPieces };
