// v3_launcher/v3_planner.js
// AI-powered editorial planning layer for V3.
// Takes the research corpus and generates a full autopilot plan via DeepSeek.

const path = require('path');
const { callAI } = require(path.join(__dirname, '..', 'scripts', 'ai_client'));

const ARTICLE_CHAR_LIMIT = 1200;
const MAX_ARTICLES = 6;
const MAX_WIKI_ENTRIES = 3;
const WIKI_CANDIDATE_CHAR_LIMIT = 400;

function buildResearchSummary(researchCorpus, wikiStories) {
  const articles = (researchCorpus?.learningCorpus || []).slice(0, MAX_ARTICLES);
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
- 各 candidate の slideOutline は4〜7枚の構成案を必ず出力する`;
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

function buildCompactRepairPrompt(topic, memo, raw) {
  return `前回のJSONが途中で切れました。今度は必ず完結した短いJSONだけを返してください。

topic: ${topic}
memo: ${memo || 'なし'}

前回出力の冒頭:
${String(raw || '').slice(0, 1200)}

必須条件:
- candidatesは3件（各案にslideOutline 4〜5枚を含める）
- briefing.chaptersは4〜6件（各chapterにslideTypeを入れる）
- 文字数を抑える
- 脚本構成とナレーション草稿は書かない
- JSON以外の文章は禁止

{
  "themeProposal": {"candidates": [], "selected": 0, "selectedReason": "", "rejectedReasons": []},
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
        { hookQuestion: core, answer, angle: '違和感をデータで整理する', dataNeeds: ['一次情報または信頼できる記事'], risk: '未確認情報を断定しない' },
        { hookQuestion: `${topic}の背景にある構造は何か？`, answer: '単発ニュースではなく構造変化として見る。', angle: '背景解説型', dataNeeds: ['時系列'], risk: '話を広げすぎない' },
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

async function generateAIPlan(topic, memo, researchCorpus, wikiStories) {
  const researchSummary = buildResearchSummary(researchCorpus, wikiStories);
  const system = buildSystemPrompt();
  const userContent = buildUserPrompt(topic, memo, researchSummary);

  const raw = await callAI({
    system,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 8000,
    forceProvider: 'deepseek',
    label: '④plan_generate',
  });

  let parsed = extractJSON(raw);
  if (!parsed) {
    console.warn(`[v3_planner] primary JSON parse failed, retrying compact repair. raw=${String(raw).slice(0, 180)}`);
    const retryRaw = await callAI({
      system: 'あなたはJSON修復専用AIです。必ず完結したJSONだけを返してください。',
      messages: [{ role: 'user', content: buildCompactRepairPrompt(topic, memo, raw) }],
      max_tokens: 3500,
      forceProvider: 'deepseek',
      label: '④plan_repair',
    });
    parsed = extractJSON(retryRaw);
    if (!parsed) {
      console.warn(`[v3_planner] compact repair JSON parse failed. retryRaw=${String(retryRaw).slice(0, 180)}`);
      return buildFallbackAIPlan(topic, researchSummary, 'AI JSON parse failed after compact retry');
    }
  }
  if (!parsed) {
    throw new Error(`AI応答のJSONパース失敗: ${String(raw).slice(0, 200)}`);
  }

  return {
    ok: true,
    aiGenerated: true,
    topic,
    articleCount: researchSummary.articleCount,
    themeProposal: parsed.themeProposal || {},
    briefing: parsed.briefing || {},
    scriptStructure: [],
    scriptDraft: [],
    missingData: parsed.missingData || [],
    publishGates: parsed.publishGates || [],
  };
}

module.exports = { generateAIPlan };
