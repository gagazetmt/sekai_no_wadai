// v3_launcher/v3_planner.js
// AI-powered editorial planning layer for V3.
// Takes the research corpus and generates a full autopilot plan via DeepSeek.

const path = require('path');
const { callAI } = require(path.join(__dirname, '..', 'scripts', 'ai_client'));

const ARTICLE_CHAR_LIMIT = 6500;
const MAX_ARTICLES = 15;
const MAX_WIKI_ENTRIES = 3;
const WIKI_CANDIDATE_CHAR_LIMIT = 400;
const MAX_FETCHED_ENTITIES = 8;
const MAX_FETCHED_SLOTS = 14;

function buildResearchSummary(researchCorpus, wikiStories) {
  const raw = researchCorpus?.learningCorpus || [];

  // ① 300文字未満を除外（ツイート・YouTube説明文等のノイズ）
  // ② スコア降順でソート（高品質記事を優先）
  // ③ 同一ドメインは2件まで（同アカウント連投対策）
  const domainCount = {};
  const articles = raw
    .filter(item => (item.text || '').length >= 300)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .filter(item => {
      const d = item.host || 'unknown';
      domainCount[d] = (domainCount[d] || 0) + 1;
      return domainCount[d] <= 2;
    })
    .slice(0, MAX_ARTICLES);

  const wikiResults = (wikiStories?.results || []).slice(0, MAX_WIKI_ENTRIES);

  const articleText = articles
    .map((item, i) => {
      const text = String(item.text || '').slice(0, ARTICLE_CHAR_LIMIT);
      return `[記事${i + 1}] ${item.title || ''} (${item.host || ''})\n${text}`;
    })
    .join('\n\n---\n\n');

  const wikiText = wikiResults
    .map((w) => {
      const body = (w.sideStoryCandidates || [])
        .map((c) => String(c.text || ''))
        .join('\n')
        .slice(0, WIKI_CANDIDATE_CHAR_LIMIT);
      return `[Wiki: ${w.entity}]\n${body}`;
    })
    .join('\n\n');

  return {
    articleText: articleText || '（記事なし）',
    wikiText: wikiText || '',
    articleCount: articles.length,
    wikiCount: wikiResults.length,
  };
}

function buildFetchedDataSummary(fetchedData) {
  const rows = (fetchedData || [])
    .filter((d) => d && d.ok)
    .slice(0, MAX_FETCHED_ENTITIES)
    .map((d, i) => {
      const slots = Array.isArray(d.slots)
        ? d.slots
            .filter((s) => s && (s.label || s.value))
            .slice(0, MAX_FETCHED_SLOTS)
            .map((s) => `- ${s.label || 'data'}: ${s.value || ''}`)
            .join('\n')
        : '';
      const labels = Array.isArray(d.labels) && d.labels.length
        ? `\n使えるラベル: ${d.labels.slice(0, 10).join(' / ')}`
        : '';
      const source = d.sourceTitle || d.sourceUrl
        ? `\n出典: ${d.sourceTitle || ''}${d.sourceUrl ? ` ${d.sourceUrl}` : ''}`
        : '';
      return `[取得データ${i + 1}] ${d.nameEn || d.name || d.label || 'entity'} (${d.type || 'entity'})\n${slots || d.summary || '値なし'}${labels}${source}`;
    });
  const failed = (fetchedData || [])
    .filter((d) => d && !d.ok)
    .slice(0, 6)
    .map((d) => `- ${d.nameEn || d.name || d.label || 'unknown'} (${d.type || 'entity'})`);
  return {
    fetchedDataText: rows.length ? rows.join('\n\n---\n\n') : '（取得済み構造化データなし）',
    failedDataText: failed.length ? failed.join('\n') : '',
    fetchedDataCount: rows.length,
    failedDataCount: failed.length,
  };
}

function buildSystemPrompt() {
  return `あなたはサッカー専門YouTube編集長AIです。
リサーチ記事を読み、以下の手順で動画企画を立ててください。最終出力は純粋なJSONのみです。

【手順】
1. 読んだ記事から確認できた事実を把握する
2. このトピックで動画にできる切り口を3案考え、各案の根拠・必要データ・スライド構成・リスクを整理する
3. 最もフックが強く、かつデータで支えられる1案を選ぶ
4. 選んだ案でのブリーフ（動画の約束・論点4〜6個・注意事項）を固める

【slideTypeの選択肢】
- opening: 冒頭フック・問い提示
- simple: ニュース概要・事実整理
- history: 過去の経緯・比較軸の設定
- comparison: データ対比・クラブ/選手比較
- stats: 数字・スタッツ・順位・市場価値
- profile: 選手/監督のプロフィール・背景
- insight: 考察・解釈・論点まとめ
- reaction: Reddit/海外反応・ファンの温度感
- ending: 結論・視聴者へのメッセージ

【絶対ルール】
- 確認できていない事実を断定しない
- 選手名・クラブ名・年号は記事の根拠があるものだけ使う
- 相棒メモの「取得済みデータ（企画書・脚本構成で優先使用）」にある数値・所属・年齢・負傷情報は、themeProposal と briefing の dataNeeds に優先的に反映する
- 「取得済み構造化データ」にある具体値は、企画案・slideOutline・dataNeedsで優先使用する
- stats/profile/comparison系スライドを提案する場合は、取得済み構造化データ内のエンティティ名とラベル名をdataNeedsに入れる
- 取得済み構造化データにない数字は、必要データまたはmissingDataに回し、断定しない
- 相棒メモの「取得失敗・未確認データ」にある対象は、断定せず missingData または publishGates に回す
- 結論はJSON形式のみ。コードブロックや前置き文は不要
- JSONを途中で切らない。長文よりも完結したJSONを優先する
- この段階では脚本構成・ナレーション草稿・完成台本を書かない
- 相棒メモに「取得済みデータ」がある場合、そのラベル名（ゴール/アシスト/評価/クラブ/年齢等）をdataNeeds に入れること
- candidates は必ず3案出力する（A/B/C案として提示するため）
- candidates A/B/C は短尺・標準・長尺の提案に分け、videoLengthType / targetMinutes / recommendedSlideCount を必ず入れる
- 各 candidate の slideOutline は案件の材料量に応じて4〜8枚で可変にする。historyに今季スタッツを羅列せず、simple/stats/profile/history/comparison/reactionを役割で分ける
- 企画提案段階で storyPattern と slideOutline[].slideType を必ず出す。後工程は企画を作り直すのではなく、制作可能なスライド仕様へ確定する
- comparison スライドで選手同士を比較する場合、必ず同じ詳細ポジション（RSB同士/LSB同士/CB同士/ST同士/CM同士など）の選手を選ぶこと。RSB（右SB）とLSB（左SB）は守備の役割が異なり比較として不自然なため使わない。ポジションが確認できない場合は comparison を避けて insight にする
- comparison の比較対象は、記事・ニュースで実際に言及された選手を優先すること。記事に登場しない選手を無断で比較対象に追加しない`;
}

function buildUserPrompt(topic, memo, researchSummary, fetchedSummary = {}) {
  const { articleText, wikiText, articleCount, wikiCount } = researchSummary;
  const { fetchedDataText, failedDataText, fetchedDataCount, failedDataCount } = fetchedSummary;

  return `## 案件トピック
${topic}

## 相棒メモ（重要な方向性・注意点）
${memo || 'なし'}

## 読んだ記事（${articleCount}件）
${articleText}
${wikiText ? `\n## Wikiデータ（${wikiCount}件）\n${wikiText}` : ''}

## 取得済み構造化データ（SofaScore / Transfermarkt等・${fetchedDataCount || 0}件）
${fetchedDataText || '（取得済み構造化データなし）'}
${failedDataText ? `\n## 取得失敗・未確認データ（${failedDataCount || 0}件・断定禁止）\n${failedDataText}` : ''}

## 出力してほしいJSON（\`\`\`不要）
{
  "themeProposal": {
    "candidates": [
      {
        "hookQuestion": "フックとなる問い",
        "answer": "仮の答え",
        "angle": "動画の切り口・約束",
        "storyPattern": "ニュース解説型 / 比較型 / 炎上反応型 / 選手深掘り型 など",
        "videoLengthType": "short / standard / long",
        "targetMinutes": "1.5-2.5 / 3-4 / 5-6",
        "recommendedSlideCount": 4,
        "dataNeeds": ["必要なデータ1"],
        "risk": "この案のリスクを短く",
        "slideOutline": [
          {"no": 1, "slideType": "opening", "headline": "スライドタイトル", "point": "このスライドで言うこと", "dataNeeds": []}
        ]
      }
    ],
    "selected": 0,
    "selectedReason": "選んだ理由（読んだ記事ベースで具体的に）",
    "rejectedReasons": ["案Bを棄却した理由", "案Cを棄却した理由"]
  },
  "briefing": {
    "purpose": "この動画で視聴者に届ける約束（一文）",
    "coreMessage": "一文で言える結論",
    "chapters": [
      {"no": 1, "role": "hook", "slideType": "opening", "claim": "主張", "dataNeeds": ["選手名 のゴール数など取得済みラベル名"]}
    ],
    "riskChecklist": ["確認すべき事実1"]
  },
  "missingData": ["記事から確認できなかった重要なデータ"],
  "publishGates": ["公開前に確認すべき条件"]
}`;
}

// JSON文字列値内の制御文字を全てエスケープ（Sonnetが改行・タブ等を入れる問題対策）
// \n / \r だけでなく 0x00-0x1F 全制御文字を対象にする
function _fixLiteralNewlines(s) {
  let inString = false, escaped = false, result = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped)    { escaped = false; result += c; continue; }
    if (c === '\\') { escaped = true;  result += c; continue; }
    if (c === '"')  { inString = !inString; result += c; continue; }
    if (inString) {
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        switch (c) {
          case '\n': result += '\\n'; continue;
          case '\r': result += '\\r'; continue;
          case '\t': result += '\\t'; continue;
          default:   result += `\\u${code.toString(16).padStart(4, '0')}`; continue;
        }
      }
    }
    result += c;
  }
  return result;
}

function _jsonErrorPos(s) {
  try { JSON.parse(s); } catch (e) {
    const m = e.message.match(/position\s+(\d+)/i);
    if (m) {
      const pos = parseInt(m[1]);
      return `pos=${pos}: ...${JSON.stringify(s.slice(Math.max(0, pos - 40), pos + 40))}...`;
    }
    return e.message;
  }
  return null;
}

function extractJSON(raw) {
  const s = String(raw || '').trim();
  // ① 直接パース
  try { return JSON.parse(s); } catch (_) {}
  // ② 全制御文字エスケープしてパース
  const fixed = _fixLiteralNewlines(s);
  try { return JSON.parse(fixed); } catch (_) {}
  // ③ コードブロック除去
  const blockMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) {
    try { return JSON.parse(blockMatch[1].trim()); } catch (_) {}
    try { return JSON.parse(_fixLiteralNewlines(blockMatch[1].trim())); } catch (_) {}
  }
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(_fixLiteralNewlines(objMatch[0])); } catch (_) {}
    try { return JSON.parse(objMatch[0]); } catch (_) {}
  }
  // 全失敗時: エラー位置をログ出力して null を返す
  const diag = _jsonErrorPos(fixed) || _jsonErrorPos(s);
  if (diag) console.warn(`[extractJSON] parse failure detail: ${diag}`);
  return null;
}

function buildNarrationRepairPrompt(raw, slideCount) {
  return `The following response was meant to be JSON for a soccer video script, but it is invalid JSON.
Repair it into valid JSON only.

Rules:
- Output JSON only. No markdown.
- Keep the same meaning and Japanese text as much as possible.
- The root object must be {"slides":[...]}.
- slides must contain ${slideCount || 'the same number of'} items if possible.
- Every slide must have: no, slideType, headline, narration, displayText, dataDisplay, imageInstruction, estimatedSec.
- Escape all double quotes inside string values, or replace decorative quotes with Japanese corner quotes 「」.
- Do not truncate the JSON.

Broken response:
${String(raw || '').slice(0, 12000)}`;
}

function normalizeCandidateMeta(candidate, index, articleCount) {
  const count = Array.isArray(candidate?.slideOutline) ? candidate.slideOutline.length : 0;
  const profiles = [
    { videoLengthType: 'short', targetMinutes: '1.5-2.5', fallbackSlides: articleCount >= 4 ? 5 : 4 },
    { videoLengthType: 'standard', targetMinutes: '3-4', fallbackSlides: articleCount >= 4 ? 6 : 5 },
    { videoLengthType: 'long', targetMinutes: '5-6', fallbackSlides: articleCount >= 5 ? 8 : 7 },
  ];
  const profile = profiles[index] || profiles[1];
  return {
    ...candidate,
    videoLengthType: candidate?.videoLengthType || profile.videoLengthType,
    targetMinutes: candidate?.targetMinutes || profile.targetMinutes,
    recommendedSlideCount: candidate?.recommendedSlideCount || count || profile.fallbackSlides,
  };
}

function normalizeAIPlanShape(parsed, articleCount) {
  const proposal = parsed.themeProposal || {};
  const candidates = Array.isArray(proposal.candidates) ? proposal.candidates : [];
  parsed.themeProposal = {
    ...proposal,
    candidates: [0, 1, 2].map((i) => normalizeCandidateMeta(candidates[i] || {}, i, articleCount)),
  };
  return parsed;
}

function buildCompactRepairPrompt(topic, memo, raw) {
  return `前回のJSONが途中で切れました。今度は必ず完結した短いJSONだけを返してください。

topic: ${topic}
memo: ${memo || 'なし'}

前回出力の冒頭:
${String(raw || '').slice(0, 1200)}

必須条件:
- candidatesは3件（短尺・標準・長尺。各案にslideOutline 4〜8枚を材料量に応じて含める）
- briefing.chaptersは4〜6件（各chapterにslideTypeを入れる）
- 文字数を抑える
- 脚本構成とナレーション草稿は書かない
- JSON以外の文章は禁止

{
  "themeProposal": {"candidates": [{"videoLengthType": "short", "targetMinutes": "1.5-2.5", "recommendedSlideCount": 4, "slideOutline": []}, {"videoLengthType": "standard", "targetMinutes": "3-4", "recommendedSlideCount": 6, "slideOutline": []}, {"videoLengthType": "long", "targetMinutes": "5-6", "recommendedSlideCount": 8, "slideOutline": []}], "selected": 0, "selectedReason": "", "rejectedReasons": []},
  "briefing": {"purpose": "", "coreMessage": "", "chapters": [], "riskChecklist": []},
  "missingData": [],
  "publishGates": []
}`;
}

function buildFallbackAIPlan(topic, researchSummary, reason) {
  const core = `${topic}で、視聴者が本当に見るべきポイントは何か？`;
  const answer = 'リサーチ材料を確認しながら、話題の違和感をデータで分解する。';
  const slides = [
    ['hook', '何が起きているのか', 'まず話題の違和感を一言で提示します。'],
    ['context', 'なぜ今重要なのか', 'このニュースが今注目されている背景を整理します。'],
    ['evidence', '確認すべきデータ', '記事と公式情報で確認できる数字だけを使います。'],
    ['contrast', '過去との違い', '昔の状況と現在を比較して変化を見せます。'],
    ['counterpoint', '言い切れない点', '反論や例外を先に処理して信頼感を作ります。'],
    ['answer', '結論', '確認済みの範囲で、冒頭の問いに答えます。'],
  ];
  return {
    ok: true,
    aiGenerated: false,
    fallback: true,
    fallbackReason: reason,
    topic,
    articleCount: researchSummary.articleCount,
    themeProposal: {
      candidates: [
        { hookQuestion: core, answer, angle: '違和感をデータで整理する', storyPattern: 'データ検証型', videoLengthType: 'short', targetMinutes: '1.5-2.5', recommendedSlideCount: 4, dataNeeds: ['一次情報または信頼できる記事'], risk: '未確認情報を断定しない', slideOutline: _normalizeSlideOutline([], 4) },
        { hookQuestion: `${topic}の背景にある構造は何か？`, answer: '単発ニュースではなく構造変化として見る。', angle: '背景解説型', storyPattern: 'ニュース解説型', videoLengthType: 'standard', targetMinutes: '3-4', recommendedSlideCount: 6, dataNeeds: ['時系列'], risk: '話を広げすぎない', slideOutline: _normalizeSlideOutline([], 6) },
        { hookQuestion: `${topic}を長尺で深掘るなら何を足すべきか？`, answer: '背景・比較・反論を分け、取得済みデータで納得感を積む。', angle: '深掘り型', storyPattern: '選手深掘り型', videoLengthType: 'long', targetMinutes: '5-6', recommendedSlideCount: 8, dataNeeds: ['比較データ', 'プロフィール', '時系列'], risk: '材料不足なら短縮する', slideOutline: _normalizeSlideOutline([], 8) },
      ],
      selected: 0,
      selectedReason: 'AIのJSONが崩れたため、破綻しにくい安全な構成にフォールバック。',
      rejectedReasons: ['背景解説型はフックが弱くなりやすい'],
    },
    briefing: {
      purpose: '話題の違和感を、確認できる材料だけで整理する。',
      coreMessage: answer,
      storyPattern: 'データ検証型',
      slideOutline: _normalizeSlideOutline([], 6),
      chapters: _normalizeSlideOutline([], 6).map((s, i) => ({ no: i + 1, role: s.slideType || s[0], slideType: s.slideType, claim: s.point || s.headline || s[1], dataNeeds: ['確認ソース'] })),
      riskChecklist: ['未確認の数字を断定しない', '出典日付を明記する'],
    },
    missingData: ['AI分析JSONの再生成確認', ...(researchSummary.articleCount ? [] : ['リサーチ記事'])],
    publishGates: ['強い数字はソースURL付きで確認する', 'AIフォールバック構成のため公開前に人間確認する'],
  };
}

// ─── 1モデル1案プロンプト ──────────────────────────────────────
function buildOnePlanSystemPrompt() {
  return `あなたはサッカー専門YouTube編集長AIです。
渡された記事と取得済みデータを読み込み、企画書を1案だけ作ってください。

【最優先：人間ドラマを発掘する】
視聴者が最後まで見るのは数字ではなく「人の物語」。以下を積極的に拾うこと：
- 選手の挫折・解雇・這い上がりのエピソード
- 移籍の舞台裏（破談・秘密交渉・監督の直接要望など）
- ライバルとの因縁・チームメイトとの関係
- 怪我・批判・プレッシャーの克服
これらがあれば必ずslideOutlineに組み込む。

【ルール】
- 確認できた事実のみ使う。記事にない数字を作らない
- 「取得済み構造化データ」にある具体値は、企画の根拠・必要データ・スライド構成に優先的に反映する
- stats/profile/comparison系スライドを出す場合は、取得済み構造化データのエンティティ名とラベル名をdataNeedsへ具体的に入れる
- 取得済み構造化データにない数字は作らない。不足している場合はmissingDataへ回す
- 各スライドに具体的な根拠・台本の種を入れること
- hookQuestion は視聴者が思わず「見たい」と感じる問いにすること
- 動画の長さ（targetMinutes）は材料の展開力に応じて4〜8分の間で自分で判断
  - 人間ドラマが豊富なら6〜8分
  - 速報・シンプルな移籍ニュースなら4〜5分
  - slideOutline の枚数は targetMinutes に合わせて調整（目安：1分あたり1〜1.5枚）
- 企画書段階で必ず「スライド型」を含める。後工程の手直しを減らすため、企画の勝ち筋をスライド構成に落として提案する
- ただしこの段階では完成台本を書かない。Step4で制作可能性・データ割当・slideType妥当性を確定する
- 企画は storyPattern で分類する（例: ニュース解説型 / 比較型 / 炎上反応型 / 選手深掘り型 / 人間ドラマ型 / データ検証型）
- slideOutline は opening で始め、ending で終える。中盤に reaction を1枚入れられる材料があるなら優先する
- slideTypeは次から選ぶ: opening / simple / insight / stats / profile / comparison / history / reaction / timeline / matchcard / picture / ending
- simple はニュース概要専用。データ主役なら stats/profile/comparison、背景や意味づけなら insight/history を使う
- 出力はJSONのみ（\`\`\`不要）`;
}

function buildOnePlanUserPrompt(topic, memo, researchSummary, fetchedSummary = {}) {
  const { articleText, wikiText, articleCount } = researchSummary;
  const { fetchedDataText, failedDataText, fetchedDataCount, failedDataCount } = fetchedSummary;
  return `## 案件: ${topic}

## 相棒メモ
${memo || 'なし'}

## 読んだ記事（${articleCount}件）
${articleText}
${wikiText ? `\n## Wikiデータ\n${wikiText}` : ''}

## 取得済み構造化データ（SofaScore / Transfermarkt等・${fetchedDataCount || 0}件）
${fetchedDataText || '（取得済み構造化データなし）'}
${failedDataText ? `\n## 取得失敗・未確認データ（${failedDataCount || 0}件・断定禁止）\n${failedDataText}` : ''}

## 出力JSON
{
  "hookQuestion": "視聴者を引き込む問い",
  "answer": "問いへの仮の答え",
  "angle": "動画の切り口（1〜2文）",
  "storyPattern": "ニュース解説型 / 比較型 / 炎上反応型 / 選手深掘り型 / 人間ドラマ型 / データ検証型 など",
  "targetMinutes": "あなたが判断した最適な動画尺（例: 6, 7, 5.5）",
  "recommendedSlideCount": 8,
  "purpose": "視聴者への約束（1文）",
  "coreMessage": "一文で言える結論",
  "risk": "この企画のリスクを短く",
  "slideOutline": [
    {"no":1,"slideType":"opening","headline":"スライドタイトル","point":"このスライドで言うこと・根拠・台本の種","dataNeeds":[],"productionCheck":"成立条件・確認ポイント"}
  ],
  "missingData": ["確認が必要なデータ"]
}`;
}

// 1モデルで1案生成
async function _generateOnePlan(topic, memo, researchSummary, fetchedSummary, providerOpts) {
  const { provider, model, label, maxTokens } = providerOpts;
  const system  = buildOnePlanSystemPrompt();
  const content = buildOnePlanUserPrompt(topic, memo, researchSummary, fetchedSummary);
  try {
    const raw = await callAI({
      system,
      messages: [{ role: 'user', content }],
      model,
      max_tokens: maxTokens || 6000,
      forceProvider: provider,
      label,
    });
    // ```json ブロック / 前置き文 / 後続テキスト を除去して JSON を抽出
    const cleaned = String(raw || '')
      .replace(/^```(?:json)?\s*/im, '')   // 先頭の```json
      .replace(/\s*```\s*$/m, '')          // 末尾の```
      .trim();
    const parsed = extractJSON(cleaned);
    if (!parsed) {
      console.warn(`[v3_planner] ${label} JSON parse failed. raw先頭300文字: ${String(raw||'').slice(0,300)}`);
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn(`[v3_planner] ${label} error: ${e.message}`);
    return null;
  }
}

// parsed単案 → themeProposal.candidates 形式に変換
// AIが決めた targetMinutes をそのまま使い、videoLengthType を逆算
function _inferProposalSlideType(slide, index, total) {
  if (index === 0) return 'opening';
  if (index === total - 1) return 'ending';
  const text = [
    slide?.slideType,
    slide?.role,
    slide?.headline,
    slide?.point,
    ...(Array.isArray(slide?.dataNeeds) ? slide.dataNeeds : []),
  ].join(' ');
  if (/reaction|reddit|comment|fan|sns|海外反応|反応|コメント/i.test(text)) return 'reaction';
  if (/match|score|fixture|試合|スコア|対戦/i.test(text)) return 'matchcard';
  if (/timeline|推移|年表|シーズン別/i.test(text)) return 'timeline';
  if (/history|経緯|過去|来歴|因縁|挫折|解雇|怪我|復活|人間ドラマ/i.test(text)) return 'history';
  if (/comparison|compare|vs|比較|対比|差|一方/i.test(text)) return 'comparison';
  if (/profile|プロフィール|経歴|年齢|所属|監督|選手|人物/i.test(text)) return 'profile';
  if (/stats|data|数字|数値|得点|ゴール|アシスト|順位|勝点|市場価値|出場|評価/i.test(text)) return 'stats';
  if (/概要|ニュース|何が起きた|整理/i.test(text)) return 'simple';
  return 'insight';
}

function _normalizeSlideOutline(slideOutline, targetCount) {
  const source = Array.isArray(slideOutline) ? slideOutline : [];
  const rows = source.length ? source : [
    { headline: '何が起きたのか', point: '話題の違和感を一言で提示する。', slideType: 'opening' },
    { headline: 'ニュース概要', point: '確認できた事実を整理する。', slideType: 'simple' },
    { headline: '背景', point: 'なぜ今この話題が重要なのかを説明する。', slideType: 'insight' },
    { headline: 'データで確認', point: '取得できる数字で主張を支える。', slideType: 'stats' },
    { headline: '人物・クラブ文脈', point: '選手やクラブの来歴、関係性、人間ドラマを足す。', slideType: 'profile' },
    { headline: '反応', point: '海外反応やファンの見方を挟む。', slideType: 'reaction' },
    { headline: '最終論点', point: 'ここまでの材料をまとめて、視聴者の見方を更新する。', slideType: 'insight' },
    { headline: '結論', point: '冒頭の問いに答えて締める。', slideType: 'ending' },
  ];
  const total = Math.max(1, targetCount || rows.length);
  return rows.map((slide, index) => {
    const type = slide.slideType || _inferProposalSlideType(slide, index, rows.length);
    return {
      no: slide.no || index + 1,
      slideType: type,
      headline: slide.headline || slide.title || slide.role || `Slide ${index + 1}`,
      point: slide.point || slide.claim || '',
      dataNeeds: Array.isArray(slide.dataNeeds) ? slide.dataNeeds : [],
      productionCheck: slide.productionCheck || '',
    };
  }).slice(0, total);
}

function _normalizeSingleToCandidate(parsed, modelLabel = '') {
  if (!parsed) return null;
  const rawSlideOutline = Array.isArray(parsed.slideOutline) ? parsed.slideOutline : [];

  // AIが返した targetMinutes を数値として取得（文字列 "6" / "5.5" / "6-7" 等を吸収）
  const rawMin = String(parsed.targetMinutes || '');
  const minNum = parseFloat(rawMin) || (rawSlideOutline.length <= 5 ? 4 : rawSlideOutline.length <= 7 ? 6 : 7);
  const targetMinutes = String(minNum);
  const recommendedSlideCount = Number(parsed.recommendedSlideCount) || rawSlideOutline.length || Math.round(minNum * 1.2);
  const slideOutline = _normalizeSlideOutline(rawSlideOutline, recommendedSlideCount);

  // videoLengthType を尺から逆算
  const videoLengthType = minNum <= 3 ? 'short' : minNum <= 5 ? 'standard' : 'long';

  return {
    hookQuestion:          parsed.hookQuestion || '',
    answer:                parsed.answer       || '',
    angle:                 parsed.angle        || '',
    storyPattern:          parsed.storyPattern || '',
    videoLengthType,
    targetMinutes,
    recommendedSlideCount: slideOutline.length || recommendedSlideCount,
    dataNeeds:             (Array.isArray(parsed.dataNeeds) && parsed.dataNeeds.length)
      ? parsed.dataNeeds
      : [...new Set(slideOutline.flatMap((s) => s.dataNeeds || []))],
    risk:                  parsed.risk         || '',
    slideOutline,
    _modelLabel:   modelLabel,
    _purpose:      parsed.purpose      || '',
    _coreMessage:  parsed.coreMessage  || '',
    _missingData:  parsed.missingData  || [],
  };
}

async function generateAIPlan(topic, memo, researchCorpus, wikiStories, fetchedData = []) {
  const researchSummary = buildResearchSummary(researchCorpus, wikiStories);
  const fetchedSummary = buildFetchedDataSummary(fetchedData);

  // 3モデルを並列実行（Sonnet / DeepSeek V4 Flash / DeepSeek Chat）
  console.log(`[v3_planner] 3モデル並列企画生成... fetchedData=${fetchedSummary.fetchedDataCount || 0}`);
  const [sonnetRaw, v4Raw, chatRaw] = await Promise.all([
    _generateOnePlan(topic, memo, researchSummary, fetchedSummary, {
      provider: 'anthropic', model: 'claude-sonnet-4-6',   label: '④plan_sonnet',   maxTokens: 6000,
    }),
    _generateOnePlan(topic, memo, researchSummary, fetchedSummary, {
      provider: 'deepseek',  model: 'deepseek-v4-flash',   label: '④plan_v4flash',  maxTokens: 6000,
    }),
    _generateOnePlan(topic, memo, researchSummary, fetchedSummary, {
      provider: 'deepseek',  model: 'deepseek-chat',       label: '④plan_chat',     maxTokens: 4000,
    }),
  ]);

  const candidates = [
    _normalizeSingleToCandidate(sonnetRaw, 'Sonnet'),
    _normalizeSingleToCandidate(v4Raw,     'DeepSeek V4 Flash'),
    _normalizeSingleToCandidate(chatRaw,   'DeepSeek Chat'),
  ].filter(Boolean);

  if (!candidates.length) {
    console.warn('[v3_planner] 全モデル失敗。フォールバックに切替');
    return buildFallbackAIPlan(topic, researchSummary, '全モデルJSON生成失敗');
  }

  // 不足データはsonnet優先でマージ
  const missingData = [...new Set([
    ...(sonnetRaw?._missingData || []),
    ...(v4Raw?._missingData     || []),
    ...(chatRaw?._missingData   || []),
  ])];

  // briefingはsonnet → v4 → chat の優先順で取得
  const bestRaw = sonnetRaw || v4Raw || chatRaw;
  const bestCandidate = candidates[0] || {};

  console.log(`[v3_planner] 完了: ${candidates.length}案生成`);

  return {
    ok: true,
    aiGenerated: true,
    topic,
    articleCount: researchSummary.articleCount,
    themeProposal: {
      candidates,
      selected:        0,
      selectedReason:  'Sonnet(A)・DeepSeek V4(B)・DeepSeek Chat(C) の3案。相棒が選んでください。',
      rejectedReasons: [],
    },
    briefing: {
      purpose:       bestRaw?.purpose      || bestRaw?._purpose     || '',
      coreMessage:   bestRaw?.coreMessage  || bestRaw?._coreMessage || '',
      storyPattern:  bestCandidate.storyPattern || '',
      slideOutline:  bestCandidate.slideOutline || [],
      chapters:      (bestCandidate.slideOutline || []).map((s, i) => ({
        no: i + 1, role: s.slideType || 'chapter', slideType: s.slideType || '',
        claim: s.point || s.headline || '', dataNeeds: s.dataNeeds || [],
      })),
      riskChecklist: [],
    },
    scriptStructure: [],
    scriptDraft: [],
    missingData,
    publishGates: [],
  };
}

// ─── 脚本構成生成 ────────────────────────────────────────────────────
// 採用した企画書のslideOutlineを元に、各スライドの
//   - slideType（rendering type）
//   - narration（ナレーション方向性・台本の種）
//   - dataNeeds（使う具体的なデータ）
//   - estimatedSec（推定尺）
// を生成する。
//
// slideType の選択肢（→ slides/*.js に対応するもの）:
//   opening / ending / stats / profile / comparison /
//   history / insight / reaction / timeline / matchcard / picture / universal
//
// 使い方:
//   const result = await generateScriptStructure(selectedCandidate, enrichedMemo, fetchedData, providerOpts);

// ─── slideType バリデータ ────────────────────────────────────────────
// LLM が提案した slideType を機械的に検証・補正する。
// 検証可能な制約（データ実在・個数・同質性）を決定論的にガードする。
// 閾値は SLIDE_RULES で一元管理。案件やデータ量に応じて調整可。

const SLIDE_RULES = {
  HISTORY_MIN_BEATS:  4,  // history 成立に必要な keyPoints 数
  STATS_MIN_SLOTS:    4,  // stats 成立に必要な数値スロット数
  TIMELINE_MIN_YEARS: 3,  // timeline 成立に必要な年号出現数
};

function _normalizeStr(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]/g, '');
}

function _slideText(slide) {
  return [
    slide.theme    || '',
    slide.headline || '',
    ...(Array.isArray(slide.keyPoints) ? slide.keyPoints : []),
    ...(Array.isArray(slide.dataNeeds) ? slide.dataNeeds : []),
  ].join(' ');
}

// スライドテキストに nameEn が部分一致する fetchedData エントリを返す
// フルネーム照合に加え、単語単位（"Tottenham" "Robertson" 等）でもフォールバック照合する
function _matchedEntities(slideText, fetchedData) {
  const norm = _normalizeStr(slideText);
  return (fetchedData || []).filter(d => {
    if (!d.ok || !d.nameEn) return false;
    // ① フルネーム完全一致
    if (norm.includes(_normalizeStr(d.nameEn))) return true;
    // ② 単語単位照合（"Andrew Robertson" → "andrew" "robertson" どちらかがあればOK）
    const words = d.nameEn.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    return words.some(w => norm.includes(w));
  });
}

// 複数エンティティが共通して持つ label（正規化）を返す
function _sharedLabels(entities) {
  if (entities.length < 2) return [];
  const labelSets = entities.map(e => new Set((e.slots || []).map(s => _normalizeStr(s.label))));
  return [...labelSets[0]].filter(l => labelSets.every(set => set.has(l)));
}

// テキスト内に出現する年号（19xx/20xx）の数を返す
function _countYears(text) {
  return (String(text || '').match(/\b(19|20)\d{2}\b/g) || []).length;
}

/**
 * LLM が付けた slideType を検証・補正する。
 * @param {Array} slides  - parsed.slides
 * @param {Array} fetchedData - SofaScore等の取得済みデータ配列
 * @returns {{ slides: Array, demotions: Array }}
 *   demotions: [{ no, from, to, reason }] ← ログ出力用
 */
function validateSlideTypes(slides, fetchedData) {
  if (!Array.isArray(slides) || !slides.length) return { slides, demotions: [] };
  const demotions = [];
  const lastNo = Math.max(...slides.map(s => s.no || 0));

  const result = slides.map(slide => {
    const s = { ...slide };
    const no     = s.no;
    const type   = s.slideType;
    const text   = _slideText(s);
    const entities = _matchedEntities(text, fetchedData);

    // ── 位置強制（opening / ending）──────────────────────────
    if (no === 1 && type !== 'opening') {
      demotions.push({ no, from: type, to: 'opening', reason: '1枚目は必ずopening' });
      s.slideType = 'opening';
      return s;
    }
    if (no === lastNo && type !== 'ending') {
      demotions.push({ no, from: type, to: 'ending', reason: '最終枚は必ずending' });
      s.slideType = 'ending';
      return s;
    }
    if (type === 'opening' && no !== 1) {
      demotions.push({ no, from: type, to: 'insight', reason: 'openingは1枚目のみ' });
      s.slideType = 'insight';
      return s;
    }
    if (type === 'ending' && no !== lastNo) {
      demotions.push({ no, from: type, to: 'insight', reason: 'endingは最終枚のみ' });
      s.slideType = 'insight';
      return s;
    }

    // ── 各型の制約チェック ────────────────────────────────────
    if (type === 'stats') {
      const hasStats = entities.some(e => (e.slots || []).length >= SLIDE_RULES.STATS_MIN_SLOTS);
      if (!hasStats) {
        demotions.push({ no, from: 'stats', to: 'insight', reason: `照合エンティティの数値スロット<${SLIDE_RULES.STATS_MIN_SLOTS}個` });
        s.slideType = 'insight';
      }

    } else if (type === 'timeline') {
      const yearCount = _countYears(text);
      if (yearCount < SLIDE_RULES.TIMELINE_MIN_YEARS) {
        demotions.push({ no, from: 'timeline', to: 'history', reason: `年号${yearCount}個<${SLIDE_RULES.TIMELINE_MIN_YEARS}個` });
        s.slideType = 'history';
      }

    } else if (type === 'comparison') {
      if (entities.length < 2) {
        demotions.push({ no, from: 'comparison', to: 'insight', reason: `照合エンティティ${entities.length}個<2個` });
        s.slideType = 'insight';
      } else {
        const shared = _sharedLabels(entities);
        if (!shared.length) {
          demotions.push({ no, from: 'comparison', to: 'insight', reason: '共通ラベルなし（異質比較）' });
          s.slideType = 'insight';
        }
      }

    } else if (type === 'history') {
      const beats = Array.isArray(s.keyPoints) ? s.keyPoints.length : 0;
      if (beats < SLIDE_RULES.HISTORY_MIN_BEATS) {
        demotions.push({ no, from: 'history', to: 'insight', reason: `keyPoints${beats}個<${SLIDE_RULES.HISTORY_MIN_BEATS}個` });
        s.slideType = 'insight';
      }

    } else if (type === 'profile') {
      if (entities.length > 1) {
        demotions.push({ no, from: 'profile', to: 'insight', reason: `複数エンティティ検出(${entities.map(e => e.nameEn).join(',')})` });
        s.slideType = 'insight';
      }

    } else if (type === 'matchcard') {
      const hasMatchSlot = entities.some(e =>
        (e.slots || []).some(slot => /score|goal|result|match/i.test(slot.label))
      );
      if (!hasMatchSlot) {
        const hasStats = entities.some(e => (e.slots || []).length >= SLIDE_RULES.STATS_MIN_SLOTS);
        const to = hasStats ? 'stats' : 'insight';
        demotions.push({ no, from: 'matchcard', to, reason: '試合スコアスロットなし' });
        s.slideType = to;
      }
    }
    // insight / picture / universal / reaction はそのまま通す
    // （picture/reaction のアセット実在チェックはこのレイヤーでは不可）

    return s;
  });

  return { slides: result, demotions };
}

const SLIDE_TYPE_OPTIONS = [
  'opening    — 冒頭フック・問い提示',
  'timeline   — 長期の数値推移・年表（成績推移・市場価値推移）',
  'stats      — 今季スタッツ・単発の数値（ゴール/順位/勝点など）',
  'profile    — 選手/監督のプロフィール・経歴',
  'comparison — 2エンティティのデータ対比',
  'history    — 過去の出来事・経緯・エピソード（人間ドラマ含む）',
  'insight    — 考察・解釈・論点まとめ・分析',
  'reaction   — 海外コメント・SNS反応・ファンの声',
  'matchcard  — 試合結果・スコア・ハイライト',
  'picture    — 画像主体のビジュアルスライド',
  'ending     — 結論・視聴者へのメッセージ・CTA',
  'universal  — 上記に当てはまらない自由形式',
].join('\n');

function buildScriptStructurePrompt(topic, selectedCandidate, enrichedMemo, fetchedData) {
  const slideText = (selectedCandidate.slideOutline || [])
    .map(s => `[${s.no}] [${s.slideType || 'insight'}] ${s.headline}\n  内容: ${s.point || ''}\n  必要データ: ${(s.dataNeeds || []).join(' / ') || 'なし'}\n  制作確認: ${s.productionCheck || 'なし'}`)
    .join('\n\n');

  const statsText = (fetchedData || []).filter(d => d.ok)
    .map(d => `${d.nameEn}: ${(d.slots||[]).slice(0,12).map(s=>`${s.label}:${s.value}`).join(' / ')}`)
    .join('\n') || '（なし）';

  const system = `あなたはサッカーYouTube制作設計AIです。企画書のslideOutlineを受け取り、
各スライドを実制作できる「脚本構成」に確定します。ナレーション本文は書きません。
この工程の役割は、企画書を作り直すことではなく、企画書の流れを守ったまま
「何を・どの順で・どのデータで見せるか」を検査・補正することです。
JSONのみ返してください。コードブロック不要。`;

  const user = `## 案件
${topic}

## 採用した企画書
フック: ${selectedCandidate.hookQuestion}
結論: ${selectedCandidate._coreMessage || ''}
想定尺: ${selectedCandidate.targetMinutes}分

## 各スライドの企画内容
${slideText}

【重要】企画書のスライド順・headline・pointを尊重すること。
- 話の順番を大きく変えない
- slideTypeは企画書案を優先し、取得済みデータで成立しない場合だけ補正する
- 補正した場合も、そのスライドが動画の約束にどう貢献するかは維持する

## 取得済みデータ（使えるデータ）
${statsText}

【重要】dataNeeds を書くときは、上記の英語エンティティ名（Andrew Robertson / Tottenham Hotspur 等）を
そのまま先頭に書くこと。例: "Andrew Robertson ゴール数 / アシスト数"、"Tottenham Hotspur 勝点 / 勝敗数"
→ この英語名がないと後工程でデータを照合できない

## 相棒メモ（文脈・確認済み事実）
${enrichedMemo || 'なし'}

## slideTypeの選択肢と意味
${SLIDE_TYPE_OPTIONS}

## スライド型の選択ルール（必ず守ること）

【STATS を最優先で使う】
- 上記「取得済みデータ」に該当エンティティの数値スロットが4個以上あるなら、必ずSTATSを使う
- 「残留争い」「低迷状況」「今季の活躍」など背景説明が主でも、数字を画面に出せるならSTATSにする
  → ナレーションで背景・文脈・理由を語りながら、画面には数字を出す構成が正解
- INSIGHTは数値データが一切ない純粋な考察・論点整理スライドだけに使う
  「データがあるのにINSIGHT」は禁止

【その他の制約】
- HISTORY: 時系列ビートが4個以上ある場合のみ。3個未満ならOPENINGかINSIGHTに吸収する
- COMPARISON: 左右で「同じデータ型」（ゴール数vsゴール数、勝点vs勝点 等）のみ比較可。
  「課題 vs 強み」など異質な軸の比較はNG → INSIGHTを使う
- TIMELINE: 数値の年別推移（市場価値推移・成績推移など）がある場合に使う

## 出力JSON
{
  "slides": [
    {
      "no": 1,
      "theme": "このスライドのテーマ（10字以内の一言）",
      "slideType": "opening",
      "headline": "スライドタイトル（画面に表示する見出し）",
      "keyPoints": [
        "視聴者に伝える論点1（事実・比較・問いなど具体的に）",
        "論点2",
        "論点3"
      ],
      "dataNeeds": [
        "実際に画面に出すデータ（例: Robertson リヴァプール在籍378試合）",
        "比較に使う数値（例: トッテナム 2年連続17位）"
      ],
      "estimatedSec": 45
    }
  ],
  "totalEstimatedSec": 420,
  "productionNotes": "編集・制作上の注意点（1〜2文）"
}`;

  return { system, user };
}

async function generateScriptStructure(topic, selectedCandidate, enrichedMemo, fetchedData, providerOpts = {}) {
  const { provider = 'deepseek', model = 'deepseek-chat', label = 'script_structure', maxTokens = 6000 } = providerOpts;
  const { system, user } = buildScriptStructurePrompt(topic, selectedCandidate, enrichedMemo, fetchedData);

  try {
    const raw = await callAI({
      system,
      messages: [{ role: 'user', content: user }],
      model,
      max_tokens: maxTokens,
      forceProvider: provider,
      label,
    });
    const cleaned = String(raw || '').replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
    const parsed = extractJSON(cleaned);
    if (!parsed) {
      console.warn(`[v3_planner] ${label} JSON parse failed.\n--- raw先頭600 ---\n${cleaned.slice(0,600)}\n--- raw末尾200 ---\n${cleaned.slice(-200)}`);
      return { ok: false, error: 'JSON parse failed' };
    }

    // ── slideType 機械バリデーション ──────────────────────────
    const { slides: validatedSlides, demotions } = validateSlideTypes(parsed.slides || [], fetchedData);
    parsed.slides = validatedSlides;
    if (demotions.length) {
      console.log(`[v3_planner] slideType補正(${demotions.length}件): ${demotions.map(d => `#${d.no} ${d.from}→${d.to}(${d.reason})`).join(' | ')}`);
    }

    console.log(`[v3_planner] ${label}: ${(parsed.slides||[]).length}スライド生成`);
    return { ok: true, ...parsed };
  } catch (e) {
    console.warn(`[v3_planner] ${label} error:`, e.message);
    return { ok: false, error: e.message };
  }
}

// ─── ハルシネーションチェック ──────────────────────────────────────
// 採用した企画書の各スライドの主張を記事コーパスと照合し、
// 「確認済み」「要確認」「修正候補」を返す
//
// 使い方:
//   const result = await validatePlan(selectedCandidate, researchCorpus, fetchedData);
//   // result.verified   : 根拠のある主張
//   // result.unverified : 記事で確認できなかった主張
//   // result.corrections: 誤りの可能性がある箇所と修正案
//   // result.ok         : true / false

async function validatePlan(selectedCandidate, researchCorpus, fetchedData) {
  if (!selectedCandidate) return { ok: false, error: 'no plan selected' };

  // 企画書の主張をまとめる
  const slideText = (selectedCandidate.slideOutline || [])
    .map(s => `[${s.no}] ${s.headline}\n  ${s.point || ''}`)
    .join('\n');

  // 記事コーパス（品質フィルタ済み・上位8件・1200文字）
  const domainCount = {};
  const articles = (researchCorpus?.learningCorpus || [])
    .filter(a => (a.text || '').length >= 300)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .filter(a => {
      const d = a.host || 'unknown';
      domainCount[d] = (domainCount[d] || 0) + 1;
      return domainCount[d] <= 2;
    })
    .slice(0, 8)
    .map((a, i) => `[記事${i+1}] ${a.title} (${a.host})\n${String(a.text || '').slice(0, 1200)}`)
    .join('\n\n---\n\n');

  // SofaScoreデータ（簡潔に）
  const statsText = (fetchedData || []).filter(d => d.ok)
    .map(d => `${d.nameEn}: ${d.slots?.slice(0, 8).map(s => `${s.label}:${s.value}`).join(' / ') || d.summary}`)
    .join('\n');

  const system = 'あなたはファクトチェック専門AIです。JSONのみ返してください。コードブロック不要。';
  const user = `以下の企画書の各スライドに書かれた「主張・数字・事実」を、記事コーパスと取得済みデータと照合してください。

## 企画書（採用案）
フック: ${selectedCandidate.hookQuestion}
${slideText}

## 記事コーパス（根拠資料）
${articles}

## 取得済みスタッツデータ
${statsText || '（なし）'}

## 出力JSON
{
  "verified": [
    {"claim": "確認できた主張・数字", "source": "記事N or SofaScore", "slideNo": 1}
  ],
  "unverified": [
    {"claim": "記事に根拠が見つからない主張", "issue": "なぜ確認できないか", "slideNo": 2}
  ],
  "corrections": [
    {"original": "企画書の誤記・誇張", "suggested": "正しい表現", "slideNo": 3}
  ],
  "summary": "全体的な品質評価（1〜2文）"
}`;

  try {
    const raw = await callAI({
      system,
      messages: [{ role: 'user', content: user }],
      model: 'claude-sonnet-4-6',
      max_tokens: 3500,
      forceProvider: 'anthropic',
      label: 'validate_plan',
    });
    const cleaned = String(raw || '').replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
    const parsed = extractJSON(cleaned);
    if (!parsed) {
      console.warn('[v3_planner] validatePlan JSON parse failed:', cleaned.slice(0, 200));
      return { ok: false, error: 'JSON parse failed', raw: cleaned.slice(0, 300) };
    }
    console.log(`[v3_planner] validatePlan: verified=${(parsed.verified||[]).length} unverified=${(parsed.unverified||[]).length} corrections=${(parsed.corrections||[]).length}`);
    return { ok: true, ...parsed };
  } catch (e) {
    console.warn('[v3_planner] validatePlan error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── ナレーション生成 ─────────────────────────────────────────────────
// generateScriptStructure の出力（slides配列）を受け取り、
// 各スライドのナレーション・画面テキスト・画像指示を生成する。
//
// 出力スライド形式:
//   { no, slideType, headline, narration, displayText, dataDisplay, imageInstruction, estimatedSec }
//
// 画像配置ルール（slideType別）:
//   opening/toc/ending/insight/reaction → background（背景1枚）
//   history/stats/profile              → left（左側1枚）
//   comparison                         → left+right（左右各1枚）
//
// 使い方:
//   const result = await generateNarration(topic, scriptSlides, enrichedMemo, fetchedData, providerOpts);

// slideType → 画像配置マッピング
const IMAGE_PLACEMENT = {
  opening:    'background',
  toc:        'background',
  ending:     'background',
  insight:    'background',
  reaction:   'background',
  history:    'left',
  stats:      'left',
  profile:    'left',
  timeline:   'left',
  matchcard:  'left',
  comparison: 'left+right',
  picture:    'background',
  universal:  'background',
};

function buildNarrationPrompt(topic, slides, enrichedMemo, fetchedData) {
  const statsText = (fetchedData || []).filter(d => d.ok)
    .map(d => `${d.nameEn}: ${(d.slots || []).slice(0, 15).map(s => `${s.label}:${s.value}`).join(' / ')}`)
    .join('\n') || '（なし）';

  const slideSummary = slides.map(s => {
    const placement = IMAGE_PLACEMENT[s.slideType] || 'background';
    return `[${s.no}] ${s.slideType.toUpperCase()}「${s.headline}」 画像配置:${placement}\n` +
      `  論点: ${(s.keyPoints || []).join(' / ')}\n` +
      `  データ: ${(s.dataNeeds || []).join(' / ')}`;
  }).join('\n\n');

  const system = `あなたはサッカーYouTubeのプロ脚本家です。
脚本構成を受け取り、各スライドのナレーション・画面テキスト・画像指示を作成します。

━━━ ⚡ 最低基準（絶対厳守）━━━
- **narration**: 220〜280字（opening は空文字固定 / reaction は 100〜140字 / toc は 150〜200字 / ending は 220〜280字）
  構造: [接続フレーズ 30〜50字] + [本題 190〜230字] = 合計 220〜280字
- **具体数字**: 取得済みデータにある数値（試合数・ゴール数・順位・年・勝率・評価・移籍金 等）は可能な限り全て言及する
- 「〜と言われています」「〜のようです」「〜かもしれません」等の冗長表現は削除。数字と事実で勝負
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【口調ルール】
- 視聴者に語りかける口調。熱量と説得力を持たせる
- 1文を短く切る。長い文は必ず分割する
- 断定系を多用（「〜だ」「〜している」「〜だった」）。体言止めも活用
- 選手名・クラブ名・大会名は全てカタカナ表記
- 「Reddit」は使わず「海外掲示板」と書く
- 確認できていない情報のみ「とも言われる」「可能性がある」と留保する

【スライド間接続ルール（重要）】
narration 冒頭は必ず接続フレーズで始める。箇条書き読み上げ感を消し、番組 MC のような流れを作る。
- 1枚目（opening 直後 or toc 直後）: 「まずは〜を見ていきましょう。」「では、今回の話題〜から見ていきましょう。」
- 中盤: 「では、〜とはどのような人物なのでしょうか。」「続いて、〜の歴史を振り返ります。」「ここで、〜の数字を確認しておきましょう。」
- 最終 insight / ending 直前: 「では本題、〜の核心に迫ります。」「ここまでの流れを踏まえて〜」
- ❌ 禁止: 体言止め列挙「〜。〜。」で始める / 主語省略「彼の経歴は〜」

【type 別ナレーション方針】
- opening: narration は **空文字 ""** 固定（タイトルのみ TTS 読み上げ）
- toc: 150〜200字。以降の構成を煽り入りで案内する
- stats / profile: 取得済みデータの数字を最大限に盛り込む。dataDisplay に実数値を列挙する
- comparison: 左右の数字を対比させ「この差が〜を意味する」まで踏み込む
- history: 時系列の転換点を際立たせる。単なる年表読み上げにしない
- insight: 考察・解釈を断定調で。「〜だからこそ〜が起きた」の因果構造で語る
- reaction: 100〜140字。海外掲示板の反応を臨場感ある口調で紹介する
- ending: 登録誘導・次回予告を含めて 220〜280字

【画像指示ルール】
各スライドに imageInstruction を出力する。配置は既に指定されている（background / left / left+right）。
- description: 画像の内容を日本語で具体的に記述
- searchKeywords: 画像検索に使う英語キーワード 3〜5語の配列
- comparison（left+right）の場合: left / right それぞれに description と searchKeywords を書く

【絶対ルール】
- JSONのみ返す。コードブロック不要
- JSON文字列の中で強調引用を使う場合は、半角ダブルクォート " を使わず、日本語の鉤括弧「」に置き換える
- どうしても半角ダブルクォートを入れる場合は必ず \\" のようにエスケープする
- 全スライド分出力する。途中で切らない`;

  const imageInstructionExample = `"imageInstruction": {
        "placement": "left",
        "description": "ロバートソンがリヴァプールのユニフォームでオーバーラップしているシーン",
        "searchKeywords": ["Andrew Robertson", "Liverpool", "action", "left back"]
      }`;
  const comparisonExample = `"imageInstruction": {
        "placement": "left+right",
        "left":  { "description": "ロバートソンのポートレート写真", "searchKeywords": ["Andrew Robertson", "portrait"] },
        "right": { "description": "ウドジェのポートレート写真",     "searchKeywords": ["Destiny Udogie", "portrait"] }
      }`;

  const user = `## 案件
${topic}

## 取得済みデータ（画面に出す実数値はここから引用）
${statsText}

## 相棒メモ
${enrichedMemo || 'なし'}

## 脚本構成（各スライドの設計図）
${slideSummary}

## 出力JSON（全スライド分・途中で切らないこと）
{
  "slides": [
    {
      "no": 1,
      "slideType": "opening",
      "headline": "スライドタイトル",
      "narration": "[接続フレーズ30〜50字]+[本題190〜230字]=220〜280字。断定系・短文・カタカナ名・数字最大言及",
      "displayText": ["画面に重ねるテキスト1（強調ワード・数字）", "テキスト2"],
      "dataDisplay": ["実数値1（取得済みデータから引用）", "実数値2"],
      ${imageInstructionExample},
      "estimatedSec": 50
    }
  ]
}

※ comparison スライドの imageInstruction は以下の形式:
${comparisonExample}`;

  return { system, user };
}

async function generateNarration(topic, scriptSlides, enrichedMemo, fetchedData, providerOpts = {}) {
  const { provider = 'deepseek', model = 'deepseek-chat', label = 'narration', maxTokens = 8000 } = providerOpts;
  const { system, user } = buildNarrationPrompt(topic, scriptSlides, enrichedMemo, fetchedData);

  try {
    const raw = await callAI({
      system,
      messages: [{ role: 'user', content: user }],
      model,
      max_tokens: maxTokens,
      forceProvider: provider,
      label,
    });
    const cleaned = String(raw || '').replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
    let parsed = extractJSON(cleaned);
    if (!parsed) {
      console.warn(`[v3_planner] ${label} JSON parse failed.\n--- raw先頭400 ---\n${cleaned.slice(0, 400)}`);
      try {
        const repairedRaw = await callAI({
          system: 'Repair invalid JSON. Output valid JSON only. No markdown.',
          messages: [{ role: 'user', content: buildNarrationRepairPrompt(cleaned, scriptSlides.length) }],
          model: 'deepseek-chat',
          max_tokens: maxTokens,
          forceProvider: 'deepseek',
          label: `${label}_json_repair`,
        });
        parsed = extractJSON(String(repairedRaw || '').replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim());
      } catch (repairError) {
        console.warn(`[v3_planner] ${label} JSON repair failed:`, repairError.message);
      }
      if (!parsed) return { ok: false, error: 'JSON parse failed' };
    }
    console.log(`[v3_planner] ${label}: ${(parsed.slides || []).length}スライド ナレーション生成完了`);
    return { ok: true, ...parsed };
  } catch (e) {
    console.warn(`[v3_planner] ${label} error:`, e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { generateAIPlan, validatePlan, generateScriptStructure, generateNarration, _validateSlideTypes: validateSlideTypes };
