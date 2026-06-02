// v3_launcher/v3_synthesizer.js
// Step 3→4 間の情報統合エージェント。
// リサーチ・Wiki・SofaScore データを Gemini で横断合成し、
// DeepSeek 企画 AI が使いやすい構造化ブリーフィングを生成する。

const path = require('path');
const { callAI } = require(path.join(__dirname, '..', 'scripts', 'ai_client'));

const MAX_ARTICLES = 8;
const ARTICLE_CHAR = 1400;
const MAX_WIKI = 4;
const WIKI_CHAR = 300;

function buildPrompt(topic, rawMemo, research, wikiStories, fetchedData) {
  const articles = (research?.learningCorpus || []).slice(0, MAX_ARTICLES);
  const articleText = articles.length
    ? articles.map((a, i) => `[記事${i + 1}] ${a.title || ''} (${a.host || ''})\n${String(a.text || '').slice(0, ARTICLE_CHAR)}`).join('\n\n---\n\n')
    : '（記事なし）';

  const wikiText = (wikiStories?.results || []).slice(0, MAX_WIKI)
    .map((w) => `[Wiki: ${w.entity}] ${(w.sideStoryCandidates || []).map((c) => c.text || '').join(' ').slice(0, WIKI_CHAR)}`)
    .join('\n') || '（なし）';

  const statsText = (fetchedData || []).filter((d) => d.ok)
    .map((d) => {
      const slots = (d.slots || []).map((s) => `${s.label}: ${s.value}`).join(' / ');
      return `${d.nameEn} (${d.type}): ${slots || d.summary || ''}`;
    }).join('\n') || '（なし）';

  return `あなたはサッカー動画制作の情報統合AIです。
以下の情報源を横断して読み、企画AIへの最適なブリーフィングJSONを生成してください。

## トピック
${topic}

## 重要ルール
- これはサッカー動画の企画材料です。F1、モータースポーツ、レース、Fernando Alonso は、案件が明示的にF1でない限り無視してください。
- サッカー文脈の "Alonso" は Xabi Alonso として扱い、Fernando Alonso を人物欄・事実・論点に入れないでください。
- 記事コーパスに別競技の検索ノイズが混じっていても、サッカー案件に直接関係する人物、監督、クラブ、大会だけを採用してください。

## 相棒メモ
${rawMemo || 'なし'}

## 記事コーパス
${articleText}

## Wikiデータ
${wikiText}

## SofaScore / Transfermarktデータ
${statsText}

## 出力JSON（\`\`\`不要、日本語）
{
  "verifiedFacts": [{"claim": "複数ソースで確認できた事実", "source": "ソース名", "confidence": "high|medium"}],
  "keyStats": {"エンティティ名": {"ラベル": "値"}},
  "topAngles": [{"angle": "企画の切り口", "evidenceBasis": "根拠要約30字以内", "strength": "strong|medium"}],
  "contextSummary": "企画AIへの背景説明200字以内",
  "dataGaps": ["不足している重要データ"],
  "warnings": ["断定を避けるべき主張（歴史的事実の誤認候補を含む）"]
}`;
}

function parseResult(raw) {
  const s = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

function buildEnrichedMemo(synthesis, rawMemo) {
  if (!synthesis) return rawMemo || '';
  const parts = [];
  if (rawMemo) parts.push(rawMemo);

  if (synthesis.contextSummary) {
    parts.push(`[背景サマリー]\n${synthesis.contextSummary}`);
  }

  const facts = (synthesis.verifiedFacts || []).filter((f) => f.confidence === 'high' || f.confidence === 'medium');
  if (facts.length) {
    parts.push(`[確認済み事実（優先使用）]\n${facts.map((f) => `・${f.claim}（${f.source}）`).join('\n')}`);
  }

  if (synthesis.keyStats && Object.keys(synthesis.keyStats).length) {
    const lines = Object.entries(synthesis.keyStats).map(([name, data]) => {
      const vals = typeof data === 'object' && data !== null
        ? Object.entries(data).map(([k, v]) => `${k}: ${v}`).join(' / ')
        : String(data);
      return `${name}: ${vals}`;
    });
    parts.push(`[主要スタッツ（優先使用）]\n${lines.join('\n')}`);
  }

  if ((synthesis.warnings || []).length) {
    parts.push(`[断定禁止事項]\n${synthesis.warnings.map((w) => `⚠ ${w}`).join('\n')}`);
  }

  if ((synthesis.dataGaps || []).length) {
    parts.push(`[不足データ（missingDataに回す）]\n${synthesis.dataGaps.join('\n')}`);
  }

  return parts.join('\n\n');
}

async function synthesizeStepData({ topic, rawMemo, research, wikiStories, fetchedData }) {
  const prompt = buildPrompt(topic, rawMemo, research, wikiStories, fetchedData);
  let synthesis = null;
  try {
    const raw = await callAI({
      system: 'あなたはサッカー動画制作の情報統合AIです。JSONのみ返してください。',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1800,
      forceProvider: 'gemini',
      label: '3.5synthesize',
    });
    synthesis = parseResult(raw);
    if (synthesis) {
      console.log(`[v3_synthesizer] OK facts=${(synthesis.verifiedFacts || []).length} angles=${(synthesis.topAngles || []).length} warnings=${(synthesis.warnings || []).length}`);
    } else {
      console.warn('[v3_synthesizer] JSON parse failed, falling back to raw memo');
    }
  } catch (e) {
    console.warn('[v3_synthesizer] failed, falling back to raw memo:', e.message);
  }
  return {
    synthesis,
    enrichedMemo: buildEnrichedMemo(synthesis, rawMemo),
  };
}

module.exports = { synthesizeStepData };
