// launcher/script_gen.js
// 論点 + 素材 → パターン判定 → mod生成 (narration込み)
//
// フォールバック順: DeepSeek → OpenAI → Gemini
// タイムアウト: 各55秒
// facts圧縮: 必要フィールドのみ送信

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PATTERNS, getPattern, validateMods, buildPiecesPattern, CONTENT_SLIDE_REQUIRED } = require('./slide_patterns');

const TIMEOUT_MS = 55000;

// ── Sonnet 事実確認 ──────────────────────────────────

async function _sonnetFactCheck(mods, facts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.log('  [sonnet] ANTHROPIC_API_KEY なし → スキップ'); return mods; }
  console.log('  [sonnet] ハルシネーション監修開始...');

  const narrations = mods.map((m, i) =>
    `[${i}](${m.type}): ${m.narration || ''}`
  ).join('\n');
  const factsSnippet = compressFacts(facts).slice(0, 3000);

  const prompt = `以下のサッカーYouTube動画脚本のナレーションを事実確認してください。

【実データ(facts)】
${factsSnippet}

【確認対象ナレーション】
${narrations}

チェック項目（優先順）:
1. 選手名・チーム名の正確性
2. スコア・得点数・試合数等の数値（factsに根拠があるか）
3. 「なお〜」「ちなみに〜」の補足文（捏造が最多）
4. 日付・記録（factsに根拠があるか）

ルール:
- factsに根拠のない具体的数値は「詳細は不明」等に差し替え
- 選手名等の固有名詞はfactsの表記に統一
- 問題なければ空配列

JSON形式のみ返答:
{"corrections":[{"i":数字,"from":"元の文（部分）","to":"修正後の文（部分）","why":"理由"}]}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) { console.warn(`  [sonnet] ${res.status}`); return mods; }
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return mods;
    const { corrections } = JSON.parse(m[0]);
    if (!corrections?.length) { console.log('  [sonnet] 修正なし'); return mods; }
    const fixed = mods.map(mod => ({ ...mod }));
    let applied = 0;
    for (const c of corrections) {
      if (c.i >= 0 && c.i < fixed.length && fixed[c.i].narration && c.from && c.to
          && fixed[c.i].narration.includes(c.from)) {
        fixed[c.i].narration = fixed[c.i].narration.replace(c.from, c.to);
        applied++;
        console.log(`  [sonnet] slide[${c.i}] 修正適用: ${c.why}`);
      } else {
        // from がナレーションに部分一致しないと replace は何もしない → 不発を可視化
        console.warn(`  ⚠ [sonnet] slide[${c.i ?? '?'}] 修正を適用できず（原文不一致）: ${c.why || ''} — 指摘箇所を手動確認してください: "${(c.from || '').slice(0, 60)}"`);
      }
    }
    console.log(`  [sonnet] 指摘${corrections.length}件中 ${applied}件適用`);
    return fixed;
  } catch (err) {
    console.warn(`  [sonnet] 失敗: ${err.message}`);
    return mods;
  }
}

// ── 企画書生成 ────────────────────────────────────────

const CONTENT_TYPES_LIST = ['insight', 'stats', 'history', 'matchcard', 'comparison'];

async function generateBrief(topic, facts) {
  console.log('\n=== 企画書生成 ===');
  const compressed = compressFacts(facts);

  const systemPrompt = `あなたはサッカーYouTube動画の企画書を作るディレクターです。
与えられたトピックと素材から、4スライド動画の企画書を生成してください。

【スライド構成】
- OP: 動画タイトル（20〜35文字・YouTube向けキャッチーな見出し）
- スライドA: コンテンツ1枚目（タイプ + 方向性の指示）
- スライドB: コンテンツ2枚目（タイプ + 方向性の指示）
- ED: エンディングのオチコメント（意外な事実・逆説・皮肉）

【コンテンツタイプ選択肢】
- insight: テキスト考察・話題まとめ
- stats: 選手スタッツ比較
- history: キャリア・時系列記録
- matchcard: 試合スコア・データ（スコアデータがある場合のみ）
- comparison: 2人/2チームの対比

【desc の書き方】
- 具体的に何を見せるか・何の角度から切るかを30〜60文字で
- 素材に不足があれば「〜を調べる必要あり」と明記する

JSON形式で返答:
{
  "op_title": "タイトル（20〜35文字）",
  "slide_a_type": "タイプ名",
  "slide_a_desc": "スライドAの方向性指示（30〜60文字）",
  "slide_b_type": "タイプ名",
  "slide_b_desc": "スライドBの方向性指示（30〜60文字）",
  "ed_comment": "EDのオチコメント（15文字以内）",
  "needs_search": "追加で調べたい内容（不要なら空文字）"
}`;

  const result = await callAI(systemPrompt, `トピック: ${topic}\n\n素材:\n${compressed}`);

  // バリデーション
  if (!result.op_title) result.op_title = topic;
  if (!CONTENT_TYPES_LIST.includes(result.slide_a_type)) result.slide_a_type = 'insight';
  if (!CONTENT_TYPES_LIST.includes(result.slide_b_type)) result.slide_b_type = 'stats';
  if (!result.slide_a_desc) result.slide_a_desc = '';
  if (!result.slide_b_desc) result.slide_b_desc = '';
  if (!result.ed_comment) result.ed_comment = '';

  console.log(`  企画書: "${result.op_title}" [${result.slide_a_type}+${result.slide_b_type}]`);
  if (result.needs_search) console.log(`  追加検索: ${result.needs_search}`);
  return result;
}

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
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek: empty response content');
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
      max_tokens: 8000,
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
    // 取り違え検知: AIが選んだ試合と Step2 で取得した matchData のチームが食い違っていないか
    const _n = s => String(s || '').toLowerCase().trim();
    const aiTeams = [mods[i].homeTeam, mods[i].awayTeam, mods[i].matchData?.homeTeam, mods[i].matchData?.awayTeam]
      .filter(Boolean).map(_n);
    const realTeams = [md.homeTeam, md.awayTeam].filter(Boolean).map(_n);
    if (aiTeams.length && realTeams.length &&
        !realTeams.some(rt => aiTeams.some(at => at.includes(rt) || rt.includes(at)))) {
      console.warn(`  ⚠ [matchcard] 試合取り違えの可能性: 脚本は「${mods[i].homeTeam || '?'} vs ${mods[i].awayTeam || '?'}」/ 取得データは「${md.homeTeam} vs ${md.awayTeam}」→ カードは取得データで上書きされます。ナレーションと矛盾していないか Step4 で確認してください`);
    }
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
  // matchStats: グローバル選手検索が名前不一致等で失敗した場合、facts.matchData.playerStats
  // (試合に出た全選手の攻守データ)から名前引きした結果（dashboard.js findPlayerInMatchData）。
  // 通常の season stats(pd.stats)が無くてもこちらだけは載っていることがあるため両方渡す。
  if (facts.playerData) {
    const pd = facts.playerData;
    out.playerData = {
      name:   pd.name,
      team:   pd.team,
      goals:  pd.goals,
      assists: pd.assists,
      rating: pd.rating,
      stats:  pd.stats ? Object.fromEntries(Object.entries(pd.stats).slice(0, 8)) : undefined,
      matchStats: pd.matchStats ? Object.fromEntries(Object.entries(pd.matchStats).slice(0, 10)) : undefined,
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

  // 予算超過時はフィールド単位で削る（文字数で切るとJSONが壊れてAIに渡るため）
  const BUDGET = 8000;
  let json = JSON.stringify(out, null, 2);
  const trims = [
    () => { if (out._comments && out._comments.length > 8) { out._comments = out._comments.slice(0, 8); return true; } return false; },
    () => { if (out.articles && out.articles.length > 3) { out.articles = out.articles.slice(0, 3); return true; } return false; },
    () => { if (out.articles?.some(a => (a.snippet || '').length > 120)) { out.articles.forEach(a => { a.snippet = (a.snippet || '').slice(0, 120); }); return true; } return false; },
    () => { if (out.matchData?.lineup) { delete out.matchData.lineup; return true; } return false; },  // 実lineupは生成後に再注入される
    () => { if (out.matchData?.stats)  { delete out.matchData.stats;  return true; } return false; },
    () => { if (out._comments && out._comments.length > 4) { out._comments = out._comments.slice(0, 4); return true; } return false; },
  ];
  for (const trim of trims) {
    if (json.length <= BUDGET) break;
    if (trim()) json = JSON.stringify(out, null, 2);
  }
  if (json.length > BUDGET) json = JSON.stringify(out); // インデント除去で最後の圧縮
  return json;
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
  ※matchcard選定: 記事に複数の試合が出てくる場合は、トピックが直接言及している・最も最近（またはこれから）の試合を選ぶ。過去の予選・関係のない試合を拾うな。例：「クロップ監督就任」ならドイツの次戦(W杯本番)を選ぶ。「エクアドル戦」は予選の話であり、トピックの核心でない場合は使わない。
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

async function generateModsAuto(topic, facts, brief = null) {
  console.log('\n=== Script Gen: 4スライド自動生成 ===');

  // 企画書から追加検索が必要な場合は BraveSearch を走らせる
  if (brief?.needs_search) {
    try {
      const { braveSearch } = require('./scout');
      console.log(`  [brief] 追加検索: "${brief.needs_search}"`);
      const extra = await braveSearch(brief.needs_search, 3);
      if (!facts.articles) facts.articles = [];
      extra.forEach(r => {
        if (!facts.articles.some(a => a.url === r.url)) {
          facts.articles.push({ title: r.title, snippet: r.snippet || r.description || '', url: r.url });
        }
      });
    } catch (err) { console.warn(`  [brief] 追加検索失敗: ${err.message}`); }
  }

  const compressed = compressFacts(facts);

  const SLIDE_TYPE_SPEC = {
    insight:    'title, narration（200文字）, catchphrases（3-5個・各20文字以内）, siBinding（英語名・画像検索キー）',
    matchcard:  'homeTeam, awayTeam, homeScore, awayScore, goals[{player,timeStr,isHome}], stats{"Ball possession":{home,away},...}, lineup{home:[{name,pos}],away:[{name,pos}]}, formations{home,away}, tournament, matchDate, venue, narration（200文字）',
    stats:      'title, narration（200文字）, siBinding（英語名）, dataSlots[{label,value}]（最大6個）',
    comparison: 'title, narration（200文字）, siBindingLeft, siBindingRight（英語名）, dataSlots[{label,leftValue,rightValue}]（最大7個）',
    history:    'title, narration（200文字）, historyHero（漢字2-3文字）, siBinding（英語名・画像検索キー）, dataSlots[{label,value}]（最大6個）',
  };

  const systemPrompt = `あなたはサッカーYouTube動画のデータ構成AIです。
案件・素材から4スライド動画データをワンショットで生成してください。

【4枚構成（固定・出力キーは必ず "mods"）】
1枚目(OP): opening — title（20〜35文字・キャッチーな見出し）+ narration = title と同じ + badge（推論）
2枚目(コンテンツA): 下記タイプから素材に合うものを選択
3枚目(コンテンツB): 下記タイプから素材に合うものを選択
4枚目(ED): ending — title（15文字以内のオチ一言）+ narration（意外な事実・逆説・ズレ感のオチ・25〜40文字）

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

【出力形式（厳守）】
トップレベルのキーは必ず "contentTypes" と "mods" の2つのみ。"slides" というキー名は使わないこと。
JSON: {"contentTypes": ["typeA", "typeB"], "mods": [1枚目, 2枚目, 3枚目, 4枚目]}`;

  // 手持ち画像インベントリ: siBinding を画像がある対象に寄せさせる（背景真っ黒スライド防止）
  const imgEntities = [...new Set((facts?.xImages || []).map(x => x.entity).filter(Boolean))];
  const inventorySection = imgEntities.length ? `

【手持ち画像あり（siBinding はなるべくこの中から選ぶ。画像がない対象を選ぶと背景なしスライドになる）】
${imgEntities.join(' / ')}` : '';

  // 企画書がある場合は「最優先指示」としてユーザープロンプト冒頭に置く（末尾追記より遵守率が高い）
  const briefSection = brief ? `【企画書 = 最優先指示。以下の指示に沿って各スライドを作ること】
- 1枚目(OP): title は必ずこの通り →「${brief.op_title}」
- 2枚目(スライドA): タイプ=${brief.slide_a_type}。内容指示:「${brief.slide_a_desc}」← このスライドの主題はこの指示。素材から指示に合う情報だけを選んで構成する
- 3枚目(スライドB): タイプ=${brief.slide_b_type}。内容指示:「${brief.slide_b_desc}」← 同上。スライドAと内容を重複させない
- 4枚目(ED): オチの方向性:「${brief.ed_comment}」← この方向性でnarrationを25〜40文字に肉付けする
- contentTypes は必ず ["${brief.slide_a_type}", "${brief.slide_b_type}"]

` : '';

  // AIが指示に反して "mods" の代わりに別キー（slides等）で返すことがあるため、
  // "narration" or "title" を持つオブジェクト4つ以上の配列ならキー名を問わず救済する
  function extractModsArray(result) {
    if (Array.isArray(result?.mods) && result.mods.length >= 4) return result.mods;
    for (const [key, val] of Object.entries(result || {})) {
      if (key === 'mods' || !Array.isArray(val) || val.length < 4) continue;
      const looksLikeSlides = val.every(v => v && typeof v === 'object' && ('narration' in v || 'title' in v));
      if (looksLikeSlides) {
        console.warn(`  ⚠ [script_gen] AIが "mods" ではなく "${key}" キーで返答 → 救済`);
        return val;
      }
    }
    return null;
  }

  let result = await callAI(
    systemPrompt + inventorySection,
    `${briefSection}トピック: ${topic}\n\n素材:\n${compressed}`
  );
  let resultMods = extractModsArray(result);

  // 1回だけリトライ: キー名不一致で救済もできなかった場合、矯正指示を追記して再生成
  if (!resultMods) {
    console.warn(`  ⚠ [script_gen] mods 抽出失敗（返答キー: ${Object.keys(result || {}).join(',')}）→ 矯正リトライ`);
    result = await callAI(
      systemPrompt + inventorySection,
      `${briefSection}トピック: ${topic}\n\n素材:\n${compressed}\n\n【重要】前回の出力形式が誤っていました。必ずトップレベルキー "mods"（4要素の配列）で返してください。"slides" 等の別名は禁止です。`
    );
    resultMods = extractModsArray(result);
  }

  const validTypes = Object.keys(CONTENT_SLIDE_REQUIRED);
  // 企画書がある場合はタイプを強制（AIが無視することがあるため）
  const contentTypes = brief
    ? [brief.slide_a_type, brief.slide_b_type].filter(t => validTypes.includes(t))
    : (result.contentTypes || (resultMods || []).map(m => m.type)).filter(t => validTypes.includes(t)).slice(0, 2);
  while (contentTypes.length < 2) contentTypes.push('insight');

  console.log(`  コンテンツタイプ: ${contentTypes.join(' + ')}`);

  const pattern = buildPiecesPattern(contentTypes);

  if (!resultMods || !Array.isArray(resultMods) || resultMods.length < 4) {
    throw new Error(`mods 不足: ${resultMods?.length ?? 0}枚`);
  }
  const mods = resultMods.slice(0, 4);

  // 企画書のOPタイトルはコード側で強制（AIが微妙に書き換えるのを防ぐ。opening narration = title）
  if (brief?.op_title) {
    if (mods[0].title !== brief.op_title) console.log(`  [brief] OPタイトルを企画書通りに強制: "${brief.op_title}"`);
    mods[0].title = brief.op_title;
    mods[0].narration = brief.op_title;
  }

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

  // siBinding フォールバック: AIが未設定の insight/stats/history に画像キーを補完
  // （siBinding がないと画像プリセットもX API検索も走らず背景なしスライドになる）
  const fallbackBinding = facts?.playerData?.name || facts?.extracted?.playerName
    || (facts?.xImages || []).map(x => x.entity).find(Boolean) || null;
  if (fallbackBinding) {
    mods.forEach((m, i) => {
      if (['insight', 'stats', 'history'].includes(m.type) && !m.siBinding) {
        m.siBinding = fallbackBinding;
        console.log(`  [script_gen] slide${i} siBinding 未設定 → "${fallbackBinding}" で補完`);
      }
    });
  }

  injectRealMatchData(mods, pattern, facts);
  await injectRealComments(mods, pattern, facts, topic);

  // Sonnet によるハルシネーション監修
  const checkedMods = await _sonnetFactCheck(mods, facts);
  const finalMods = checkedMods;

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

  return { patternKey: 'pieces_2', pattern, mods: finalMods, validation };
}

module.exports = { generateModsAuto, generateMods, generateModsForPieces, generateBrief };
