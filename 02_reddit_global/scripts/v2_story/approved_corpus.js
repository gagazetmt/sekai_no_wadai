// scripts/v2_story/approved_corpus.js
// ═══════════════════════════════════════════════════════════════
// 承認済み narration のコーパス管理 (Few-shot RAG / 編集学習)
// ═══════════════════════════════════════════════════════════════
//
// 目的: 相棒が手で直して動画生成まで通したスライドを「承認済み」と見なし、
//       同じ type のカードを次回生成する時に few-shot 例として注入する。
//       AI 提案 → 手直し のループを学習で減らす狙い。
//
// トリガー: /v2/generate-video が呼ばれた瞬間 (= 相棒が動画生成 GO した = 内容承認)
// 保存場所: data/approved_scripts/{type}/{postId}_{idx}.json (1 スライド 1 ファイル)
// 取得: 同じ type で最新 N 件、同案件は除外
// ═══════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');

const CORPUS_DIR = path.join(__dirname, '..', '..', 'data', 'approved_scripts');

// type ホワイトリスト (opening/ending/toc は型ハマり過ぎで学習しない)
const LEARN_TYPES = new Set([
  'insight', 'stats', 'profile', 'comparison', 'history',
  'reaction', 'matchcard', 'ranking', 'timeline', 'picture',
]);

function _ensure(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function _sanitize(s) {
  return String(s || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
}

// ─── 単体保存 ───────────────────────────────────────────────
//   m: modules.json の 1 スライド (type / title / narration / mainKey / secondary / binding 含む)
function saveApprovedSlide(postId, idx, m) {
  if (!m || !LEARN_TYPES.has(m.type)) return false;
  const narration = String(m.narration || '').trim();
  if (narration.length < 60) return false;  // 極端に短いのは除外 (空 narration や reaction 軽量化)

  const typeDir = path.join(CORPUS_DIR, _sanitize(m.type));
  _ensure(typeDir);
  const file = path.join(typeDir, `${_sanitize(postId)}_${idx}.json`);
  const data = {
    postId, idx,
    type:      m.type,
    title:     m.title || '',
    narration,
    mainKey:   m.mainKey || '',
    secondary: m.secondary || '',
    recipeKey: m.binding?.recipeKey || '',
    savedAt:   new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn('[approved_corpus] save failed:', e.message);
    return false;
  }
}

// ─── 動画 1 本分まとめ保存 (generate-video フック想定) ─────
function saveApprovedModules(postId, modules) {
  if (!Array.isArray(modules)) return 0;
  let n = 0;
  modules.forEach((m, i) => { if (saveApprovedSlide(postId, i, m)) n++; });
  if (n > 0) console.log(`[approved_corpus] ${postId} から ${n} カード承認済みに保存`);
  return n;
}

// ─── 取得 ───────────────────────────────────────────────────
//   type の最新 N 件、 excludePostId 除外、 narration 100 文字未満はスキップ
function pickApprovedExamples(type, count = 3, excludePostId = null) {
  if (!type || !LEARN_TYPES.has(type)) return [];
  const typeDir = path.join(CORPUS_DIR, _sanitize(type));
  if (!fs.existsSync(typeDir)) return [];
  try {
    const files = fs.readdirSync(typeDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const fp = path.join(typeDir, f);
        const stat = fs.statSync(fp);
        return { fp, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const out = [];
    for (const { fp } of files) {
      if (out.length >= count) break;
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (excludePostId && data.postId === excludePostId) continue;
        if (!data.narration || data.narration.length < 100) continue;
        out.push(data);
      } catch (_) {}
    }
    return out;
  } catch (_) { return []; }
}

// ─── プロンプト用ブロック整形 ──────────────────────────────
function formatForPrompt(examples) {
  if (!examples || examples.length === 0) return '';
  const items = examples.slice(0, 3).map((ex, i) => {
    const n = String(ex.narration || '').slice(0, 400);
    return `例${i + 1} [${ex.type}]:\n  title: ${ex.title || ''}\n  narration: ${n}`;
  }).join('\n\n');
  return `━━━ 📝 参考スタイル: 承認済み narration ━━━
これは相棒が過去案件で「これで OK」と承認した narration の例。
**語り口・テンポ・数字の出し方・橋渡しのつなぎ** を参考にする。
内容そのもの (固有名詞・数字) は引用せず、 表現のスタイルだけ寄せる。

${items}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

module.exports = {
  saveApprovedSlide,
  saveApprovedModules,
  pickApprovedExamples,
  formatForPrompt,
};
