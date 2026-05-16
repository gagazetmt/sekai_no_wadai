// _test_step3a_prep_boundary_dict.js
// 1本撮りパイプライン Step3 前処理: 境界マッチ用辞書を生成
//
// 目的:
//   - modules.json の各 narration から「末尾20字」を切出
//   - applyJpDict + kuroshiro でひらがな化 + 正規化
//   - 検索辞書として JSON に保存（再利用可、目視 debug 可）
//
// 使い方:
//   node _test_step3a_prep_boundary_dict.js                       # 既定: _test_hearts_modules.json
//   node _test_step3a_prep_boundary_dict.js <path/to/modules.json>
//
// 出力:
//   _test_step3_out/boundary_dict_<postId>.json
//
// 設計判断:
//   - opening (narration 空) は除外
//   - 最後の module は境界不要なので tail 抽出は全 module 分やるが、 phase 2 で N-1 個だけ使う
//   - 末尾20字は「文末→遡って20字」。改行は除去後にカウント

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { applyJpDict } = require('./scripts/v2_video/jp_dict');

const TAIL_LEN = parseInt(process.env.BOUNDARY_TAIL_LEN || '20', 10);
const OUT_DIR = path.join(__dirname, '_test_step3_out');

// kuroshiro 初期化（漢字→ひらがな）
let _kuroshiro = null;
async function getKuroshiro() {
  if (_kuroshiro) return _kuroshiro;
  const Kuroshiro = require('kuroshiro').default;
  const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
  const k = new Kuroshiro();
  await k.init(new KuromojiAnalyzer());
  _kuroshiro = k;
  return k;
}

// ASR / 原文 共通の正規化（境界マッチ前の最終形）
//   - 改行・空白除去
//   - 句読点・記号除去
//   - カタカナ→ひらがな
function normalizeForMatch(s) {
  if (!s) return '';
  // カタカナ→ひらがな (U+30A1-U+30F6 を U+3041-U+3096 にシフト)
  let t = String(s).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  // 空白・改行・タブ
  t = t.replace(/[\s　]/g, '');
  // 句読点・記号類
  t = t.replace(/[、。「」『』（）()！!？?・…―\-—:：;；,\.]/g, '');
  // 絵文字
  t = t.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, '');
  return t;
}

// 原文 narration → 末尾 N 字を「正規化された形」で取り出す
async function buildTail(rawNarration, tailLen) {
  if (!rawNarration) return { raw: '', dict: '', hira: '', tail: '' };
  const dictApplied = applyJpDict(rawNarration);     // 既知語の読みを揃える
  const k = await getKuroshiro();
  const hira = await k.convert(dictApplied, { to: 'hiragana' });  // 漢字→ひらがな
  const normalized = normalizeForMatch(hira);
  // 末尾 tailLen 字
  const tail = normalized.slice(-tailLen);
  return { raw: rawNarration, dict: dictApplied, hira, normalized, tail };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const modulesPath = path.resolve(process.argv[2] || path.join(__dirname, '_test_hearts_modules.json'));
  if (!fs.existsSync(modulesPath)) throw new Error(`modules.json not found: ${modulesPath}`);

  const j = JSON.parse(fs.readFileSync(modulesPath, 'utf8'));
  const postId = j.postId || 'unknown';
  const modules = Array.isArray(j.modules) ? j.modules : [];

  console.log(`📂 modules.json: ${modulesPath}`);
  console.log(`📦 postId: ${postId} / modules: ${modules.length}`);
  console.log(`✂️ tail length: ${TAIL_LEN} 字`);
  console.log(`⏳ kuroshiro 初期化中...`);

  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    const narration = m.narration || m.narrationText || m.text || '';
    if (!narration.trim()) {
      results.push({
        idx: i,
        type: m.type || '',
        skip: true,
        reason: 'empty narration',
      });
      console.log(`  m${i} (${m.type}): SKIP (empty)`);
      continue;
    }
    const built = await buildTail(narration, TAIL_LEN);
    results.push({
      idx: i,
      type: m.type || '',
      narrationLen: narration.length,
      narrationHead: narration.slice(0, 30),
      narrationTail: narration.slice(-30),  // 原文末尾30字 (確認用)
      tail20Raw: built.raw.slice(-TAIL_LEN),         // 原文末尾 N 字 (生)
      tail20Hira: built.tail,                        // 正規化済みひらがな末尾 N 字
      _debug: {
        dictApplied: built.dict.slice(-40),         // 辞書適用後 (末尾40字)
        normalized: built.normalized.slice(-40),    // 正規化後 (末尾40字)
      },
    });
    console.log(`  m${i} (${m.type}): ${narration.length}字 / tail="${built.tail}"`);
  }

  const dict = {
    postId,
    sourceModulesJson: modulesPath,
    tailLen: TAIL_LEN,
    generatedAt: new Date().toISOString(),
    modules: results,
  };
  const outPath = path.join(OUT_DIR, `boundary_dict_${postId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(dict, null, 2), 'utf8');
  console.log(`\n✅ 完了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`📝 dict: ${outPath}`);

  // 重複チェック (末尾20字が他 module と被ってないか)
  const tails = results.filter(r => !r.skip).map(r => r.tail20Hira);
  const dups = tails.filter((t, i) => tails.indexOf(t) !== i);
  if (dups.length) {
    console.warn(`\n⚠️ 重複した tail20Hira: ${JSON.stringify(dups)}`);
    console.warn(`   この末尾は phase 2 で誤マッチする可能性あり。 TAIL_LEN を増やすこと推奨。`);
  } else {
    console.log(`✓ 末尾20字 全 module ユニーク (誤マッチ懸念なし)`);
  }
}

main().catch(e => {
  console.error('✗ 失敗:', e.message);
  console.error(e.stack);
  process.exit(1);
});
