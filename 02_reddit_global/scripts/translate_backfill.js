// scripts/translate_backfill.js
// 既存 stories_*.json の未翻訳（titleJa無し）案件だけをバックフィル翻訳する

require("dotenv").config({ path: require('path').join(__dirname, "..", ".env"), quiet: true });

const fs   = require('fs');
const path = require('path');
const { callAI } = require('./ai_client');

const CTRL_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

function tryParseLenient(raw, wantArray = false) {
  if (!raw) return null;
  const cleaned = raw
    .replace(CTRL_RE, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  const pattern = wantArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const m = cleaned.match(pattern);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {}
  try {
    const lastClose = wantArray ? m[0].lastIndexOf(']') : m[0].lastIndexOf('}');
    if (lastClose > 0) return JSON.parse(m[0].slice(0, lastClose + 1));
  } catch (_) {}
  return null;
}

async function translateSingle(item) {
  const comments = (item.comments || []).slice(0, 5).map(c => `- ${c.body || ''}`).join('\n');
  const prompt = `以下のサッカー関連投稿を日本語に意訳してください。視聴者をクリックしたくさせる煽り・熱量を込めて。

Title: ${item.title}
Comments:
${comments}

【重要】JSONのみ返すこと。文字列内の改行は \\n、引用符は \\" でエスケープ。

{"titleJa":"日本語タイトル","commentsJa":["訳1","訳2","訳3","訳4","訳5"]}`;
  try {
    const raw = await callAI({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    });
    return tryParseLenient(raw, false);
  } catch (_) { return null; }
}

async function main() {
  const file = process.argv[2]
    || path.join(__dirname, '..', 'data', `stories_${new Date().toISOString().slice(0, 10).replace(/-/g, '_')}.json`);
  if (!fs.existsSync(file)) { console.error('❌ 対象ファイルなし:', file); process.exit(1); }

  console.log('📂 対象:', path.basename(file));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const todo = (data.posts || []).filter(p => !p.titleJa);
  console.log(`🔍 未翻訳: ${todo.length}件 / 全${data.posts.length}件`);
  if (!todo.length) { console.log('✅ すべて翻訳済み'); return; }

  let done = 0, fail = 0;
  for (const p of todo) {
    process.stdout.write(`  [${done + fail + 1}/${todo.length}] ${p.title.slice(0, 50)}... `);
    const res = await translateSingle(p);
    if (res?.titleJa) {
      p.titleJa = res.titleJa;
      p.comments = (p.comments || []).map((c, i) => ({ ...c, bodyJa: res.commentsJa?.[i] || c.body }));
      done++;
      console.log('✅');
    } else {
      fail++;
      console.log('❌');
    }
    await new Promise(r => setTimeout(r, 400));
  }

  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`🎯 完了: 成功${done} / 失敗${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
