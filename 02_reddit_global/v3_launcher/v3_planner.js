// v3_launcher/v3_planner.js
// AI-powered editorial planning layer for V3.
// Takes the research corpus and generates a full autopilot plan via DeepSeek.

const path = require('path');
const { callAI } = require(path.join(__dirname, '..', 'scripts', 'ai_client'));

const ARTICLE_CHAR_LIMIT = 6500;
const MAX_ARTICLES = 15;
const MAX_WIKI_ENTRIES = 3;
const WIKI_CANDIDATE_CHAR_LIMIT = 400;

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
- history: 過去の経緯・比較軸の設定
- comparison: データ対比・クラブ/選手比較
- stats: 数字・スタッツ・順位・市場価値
- profile: 選手/監督のプロフィール・背景
- insight: 考察・解釈・論点まとめ
- ending: 結論・視聴者へのメッセージ

【絶対ルール】
- 確認できていない事実を断定しない
- 選手名・クラブ名・年号は記事の根拠があるものだけ使う
- 相棒メモの「取得済みデータ（企画書・脚本構成で優先使用）」にある数値・所属・年齢・負傷情報は、themeProposal と briefing の dataNeeds に優先的に反映する
- 相棒メモの「取得失敗・未確認データ」にある対象は、断定せず missingData または publishGates に回す
- 結論はJSON形式のみ。コードブロックや前置き文は不要
- JSONを途中で切らない。長文よりも完結したJSONを優先する
- この段階では脚本構成・ナレーション草稿・完成台本を書かない
- 相棒メモに「取得済みデータ」がある場合、そのラベル名（ゴール/アシスト/評価/クラブ/年齢等）をdataNeeds に入れること
- candidates は必ず3案出力する（A/B/C案として提示するため）
- candidates A/B/C は短尺・標準・長尺の提案に分け、videoLengthType / targetMinutes / recommendedSlideCount を必ず入れる
- 各 candidate の slideOutline は案件の材料量に応じて4〜8枚で可変にする。historyに今季スタッツを羅列せず、stats/profile/history/comparisonを役割で分ける`;
}

function buildUserPrompt(topic, memo, researchSummary) {
  const { articleText, wikiText, articleCount, wikiCount } = researchSummary;

  return `## 案件トピック
${topic}

## 相棒メモ（重要な方向性・注意点）
${memo || 'なし'}

## 読んだ記事（${articleCount}件）
${articleText}
${wikiText ? `\n## Wikiデータ（${wikiCount}件）\n${wikiText}` : ''}

## 出力してほしいJSON（\`\`\`不要）
{
  "themeProposal": {
    "candidates": [
      {
        "hookQuestion": "フックとなる問い",
        "answer": "仮の答え",
        "angle": "動画の切り口・約束",
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

function extractJSON(raw) {
  const s = String(raw || '').trim();
  try {
    return JSON.parse(s);
  } catch (_) {}
  const blockMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1].trim());
    } catch (_) {}
  }
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch (_) {}
  }
  return null;
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
        { hookQuestion: core, answer, angle: '違和感をデータで整理する', videoLengthType: 'short', targetMinutes: '1.5-2.5', recommendedSlideCount: 4, dataNeeds: ['一次情報または信頼できる記事'], risk: '未確認情報を断定しない' },
        { hookQuestion: `${topic}の背景にある構造は何か？`, answer: '単発ニュースではなく構造変化として見る。', angle: '背景解説型', videoLengthType: 'standard', targetMinutes: '3-4', recommendedSlideCount: 6, dataNeeds: ['時系列'], risk: '話を広げすぎない' },
        { hookQuestion: `${topic}を長尺で深掘るなら何を足すべきか？`, answer: '背景・比較・反論を分け、取得済みデータで納得感を積む。', angle: '深掘り型', videoLengthType: 'long', targetMinutes: '5-6', recommendedSlideCount: 8, dataNeeds: ['比較データ', 'プロフィール', '時系列'], risk: '材料不足なら短縮する' },
      ],
      selected: 0,
      selectedReason: 'AIのJSONが崩れたため、破綻しにくい安全な構成にフォールバック。',
      rejectedReasons: ['背景解説型はフックが弱くなりやすい'],
    },
    briefing: {
      purpose: '話題の違和感を、確認できる材料だけで整理する。',
      coreMessage: answer,
      chapters: slides.map((s, i) => ({ no: i + 1, role: s[0], claim: s[1], dataNeeds: ['確認ソース'] })),
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
- 各スライドに具体的な根拠・台本の種を入れること
- hookQuestion は視聴者が思わず「見たい」と感じる問いにすること
- 動画の長さ（targetMinutes）は材料の展開力に応じて4〜8分の間で自分で判断
  - 人間ドラマが豊富なら6〜8分
  - 速報・シンプルな移籍ニュースなら4〜5分
  - slideOutline の枚数は targetMinutes に合わせて調整（目安：1分あたり1〜1.5枚）
- slideOutlineにslideTypeは不要。headlineとpointで内容を示すだけでよい
  （slideTypeはStep4の脚本構成時に、利用可能データに基づいて決定する）
- 出力はJSONのみ（\`\`\`不要）`;
}

function buildOnePlanUserPrompt(topic, memo, researchSummary) {
  const { articleText, wikiText, articleCount } = researchSummary;
  return `## 案件: ${topic}

## 相棒メモ
${memo || 'なし'}

## 読んだ記事（${articleCount}件）
${articleText}
${wikiText ? `\n## Wikiデータ\n${wikiText}` : ''}

## 出力JSON
{
  "hookQuestion": "視聴者を引き込む問い",
  "answer": "問いへの仮の答え",
  "angle": "動画の切り口（1〜2文）",
  "targetMinutes": "あなたが判断した最適な動画尺（例: 6, 7, 5.5）",
  "purpose": "視聴者への約束（1文）",
  "coreMessage": "一文で言える結論",
  "risk": "この企画のリスクを短く",
  "slideOutline": [
    {"no":1,"headline":"スライドタイトル","point":"このスライドで言うこと・根拠・台本の種"}
  ],
  "missingData": ["確認が必要なデータ"]
}`;
}

// 1モデルで1案生成
async function _generateOnePlan(topic, memo, researchSummary, providerOpts) {
  const { provider, model, label, maxTokens } = providerOpts;
  const system  = buildOnePlanSystemPrompt();
  const content = buildOnePlanUserPrompt(topic, memo, researchSummary);
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
function _normalizeSingleToCandidate(parsed, modelLabel = '') {
  if (!parsed) return null;
  const slideOutline = Array.isArray(parsed.slideOutline) ? parsed.slideOutline : [];

  // AIが返した targetMinutes を数値として取得（文字列 "6" / "5.5" / "6-7" 等を吸収）
  const rawMin = String(parsed.targetMinutes || '');
  const minNum = parseFloat(rawMin) || (slideOutline.length <= 5 ? 4 : slideOutline.length <= 7 ? 6 : 7);
  const targetMinutes = String(minNum);

  // videoLengthType を尺から逆算
  const videoLengthType = minNum <= 3 ? 'short' : minNum <= 5 ? 'standard' : 'long';

  return {
    hookQuestion:          parsed.hookQuestion || '',
    answer:                parsed.answer       || '',
    angle:                 parsed.angle        || '',
    videoLengthType,
    targetMinutes,
    recommendedSlideCount: slideOutline.length || Math.round(minNum * 1.2),
    dataNeeds:             parsed.dataNeeds    || [],
    risk:                  parsed.risk         || '',
    slideOutline,
    _modelLabel:   modelLabel,
    _purpose:      parsed.purpose      || '',
    _coreMessage:  parsed.coreMessage  || '',
    _missingData:  parsed.missingData  || [],
  };
}

async function generateAIPlan(topic, memo, researchCorpus, wikiStories) {
  const researchSummary = buildResearchSummary(researchCorpus, wikiStories);

  // 3モデルを並列実行（Sonnet / DeepSeek V4 Flash / DeepSeek Chat）
  console.log('[v3_planner] 3モデル並列企画生成...');
  const [sonnetRaw, v4Raw, chatRaw] = await Promise.all([
    _generateOnePlan(topic, memo, researchSummary, {
      provider: 'anthropic', model: 'claude-sonnet-4-6',   label: '④plan_sonnet',   maxTokens: 6000,
    }),
    _generateOnePlan(topic, memo, researchSummary, {
      provider: 'deepseek',  model: 'deepseek-v4-flash',   label: '④plan_v4flash',  maxTokens: 6000,
    }),
    _generateOnePlan(topic, memo, researchSummary, {
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
      chapters:      (bestRaw?.slideOutline || []).map((s, i) => ({
        no: i + 1, role: s.slideType || 'chapter',
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
    .map(s => `[${s.no}] ${s.headline}\n  内容: ${s.point || ''}`)
    .join('\n\n');

  const statsText = (fetchedData || []).filter(d => d.ok)
    .map(d => `${d.nameEn}: ${(d.slots||[]).slice(0,12).map(s=>`${s.label}:${s.value}`).join(' / ')}`)
    .join('\n') || '（なし）';

  const system = `あなたはサッカーYouTube脚本構成AIです。企画書のslideOutlineを受け取り、
各スライドの詳細な脚本構成（slideType・ナレーション方向性・使うデータ・推定尺）を作成します。
JSONのみ返してください。コードブロック不要。`;

  const user = `## 案件
${topic}

## 採用した企画書
フック: ${selectedCandidate.hookQuestion}
結論: ${selectedCandidate._coreMessage || ''}
想定尺: ${selectedCandidate.targetMinutes}分

## 各スライドの企画内容
${slideText}

## 取得済みデータ（使えるデータ）
${statsText}

## 相棒メモ（文脈・確認済み事実）
${enrichedMemo || 'なし'}

## slideTypeの選択肢と意味
${SLIDE_TYPE_OPTIONS}

## 出力JSON
{
  "slides": [
    {
      "no": 1,
      "headline": "スライドタイトル",
      "slideType": "opening",
      "narration": "このスライドで言うこと（2〜4文。具体的な数字・固有名詞・台本の種を入れる）",
      "dataNeeds": ["使う具体的なデータ（例: Robertson 今季アシスト数、Tottenham 順位）"],
      "estimatedSec": 45
    }
  ],
  "totalEstimatedSec": 420,
  "productionNotes": "撮影・編集上の注意点（1〜2文）"
}`;

  return { system, user };
}

async function generateScriptStructure(topic, selectedCandidate, enrichedMemo, fetchedData, providerOpts = {}) {
  const { provider = 'deepseek', model = 'deepseek-chat', label = 'script_structure' } = providerOpts;
  const { system, user } = buildScriptStructurePrompt(topic, selectedCandidate, enrichedMemo, fetchedData);

  try {
    const raw = await callAI({
      system,
      messages: [{ role: 'user', content: user }],
      model,
      max_tokens: 5000,
      forceProvider: provider,
      label,
    });
    const cleaned = String(raw || '').replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
    const parsed = extractJSON(cleaned);
    if (!parsed) {
      console.warn(`[v3_planner] ${label} JSON parse failed. raw先頭200: ${cleaned.slice(0,200)}`);
      return { ok: false, error: 'JSON parse failed' };
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

module.exports = { generateAIPlan, validatePlan, generateScriptStructure };
