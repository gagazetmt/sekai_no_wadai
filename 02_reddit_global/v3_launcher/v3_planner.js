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
2. このトピックで動画にできる切り口を2〜3案考え、各案の根拠・必要データ・リスクを整理する
3. 最もフックが強く、かつデータで支えられる1案を選ぶ
4. 選んだ案でのブリーフ（動画の約束・論点4〜6個・注意事項）を固める
5. スライド構成（6〜9枚）を設計し、各スライドのナレーション草稿を書く

【絶対ルール】
- 確認できていない事実を断定しない
- 選手名・クラブ名・年号は記事の根拠があるものだけ使う
- 結論はJSON形式のみ。コードブロックや前置き文は不要
- narrationは日本語で書く（20代前半向けサッカー解説、隣で観てる親近感）`;
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
        "dataNeeds": ["必要なデータ1", "必要なデータ2"],
        "risk": "この案のリスク"
      }
    ],
    "selected": 0,
    "selectedReason": "選んだ理由（読んだ記事ベースで具体的に）",
    "rejectedReasons": ["案Bを棄却した理由"]
  },
  "briefing": {
    "purpose": "この動画で視聴者に届ける約束（一文）",
    "coreMessage": "一文で言える結論",
    "chapters": [
      {"no": 1, "role": "hook", "claim": "主張", "dataNeeds": ["必要データ"]}
    ],
    "riskChecklist": ["確認すべき事実1", "言い過ぎてはいけないこと"]
  },
  "scriptStructure": [
    {
      "no": 1,
      "role": "hook",
      "headline": "スライドタイトル",
      "point": "このスライドで言うこと",
      "visualIntent": "見せ方の意図",
      "dataNeeds": ["必要データ"]
    }
  ],
  "scriptDraft": [
    {
      "slideNo": 1,
      "title": "スライドタイトル",
      "role": "hook",
      "narration": "ナレーション草稿（日本語・2〜4文）",
      "dataNeeds": ["必要データ"],
      "caution": "注意点（なければ空文字）"
    }
  ],
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

async function generateAIPlan(topic, memo, researchCorpus, wikiStories) {
  const researchSummary = buildResearchSummary(researchCorpus, wikiStories);
  const system = buildSystemPrompt();
  const userContent = buildUserPrompt(topic, memo, researchSummary);

  const raw = await callAI({
    system,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 4000,
    forceProvider: 'deepseek',
  });

  const parsed = extractJSON(raw);
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
    scriptStructure: parsed.scriptStructure || [],
    scriptDraft: parsed.scriptDraft || [],
    missingData: parsed.missingData || [],
    publishGates: parsed.publishGates || [],
  };
}

module.exports = { generateAIPlan };
