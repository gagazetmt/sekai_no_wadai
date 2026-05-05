// scripts/v2_video/_e2e_orchestrate.js
// 1案件を Step1〜Step4 まで自動で通すスクリプト
//
// 使い方:
//   node scripts/v2_video/_e2e_orchestrate.js [<storyTitleSubstring>]
//
// 動作:
//   1. 直近 stories から 1 件選択（引数のサブストリングと部分一致するもの、無ければ先頭）
//   2. saved_projects.json に保存
//   3. /api/v3/suggest-labels → poll
//   4. /api/v3/fetch-all → poll
//   5. /api/v3/propose-modules → poll
//   6. /api/v3/generate-scenario → poll
//   7. /api/v2/generate-video → poll
//   8. 出力 mp4 URL 表示

const fs   = require('fs');
const path = require('path');
const http = require('http');

const LAUNCHER = 'http://localhost:3004';
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SAVED = path.join(DATA_DIR, 'saved_projects.json');

function safeId(s) { return (s || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_'); }

function http_call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(LAUNCHER + urlPath);
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(txt) }); }
        catch (_) { resolve({ status: res.statusCode, body: txt }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function pollJob(statusPath, jobId, label, maxMin = 8) {
  const started = Date.now();
  while (Date.now() - started < maxMin * 60 * 1000) {
    await new Promise(r => setTimeout(r, 4000));
    const r = await http_call('GET', `${statusPath}?jobId=${encodeURIComponent(jobId)}`);
    if (r.status === 404) { throw new Error(label + ' job 404 - vanished'); }
    const j = r.body;
    if (j.status === 'error') throw new Error(label + ' error: ' + j.error);
    if (j.status === 'done')  return j.result;
    process.stdout.write(`\r${label}: ${j.status} (${((Date.now()-started)/1000).toFixed(0)}s)   `);
  }
  throw new Error(label + ' timeout');
}

(async () => {
  const titleHint = process.argv[2] || '';

  // 1. 直近 stories から選ぶ
  const storyFiles = fs.readdirSync(DATA_DIR)
    .filter(f => /^stories_\d{4}_\d{2}_\d{2}\.json$/.test(f))
    .sort().reverse().slice(0, 3);
  let pick = null;
  let pickFile = null;
  for (const f of storyFiles) {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    const posts = d.posts || [];
    if (titleHint) {
      const m = posts.find(p => (p.title || '').toLowerCase().includes(titleHint.toLowerCase()));
      if (m) { pick = m; pickFile = f; break; }
    } else if (posts.length) {
      pick = posts[0]; pickFile = f; break;
    }
  }
  if (!pick) throw new Error('no story found' + (titleHint ? ' matching: ' + titleHint : ''));
  console.log(`📰 選択案件: "${pick.title.slice(0, 80)}"`);
  console.log(`   from ${pickFile}, id=${pick.id}`);

  // 2. saved_projects に保存
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(SAVED, 'utf8')); } catch (_) {}
  if (!Array.isArray(saved)) saved = [];
  if (!saved.find(p => p.id === pick.id)) {
    saved.unshift(pick);
    fs.writeFileSync(SAVED, JSON.stringify(saved, null, 2));
    console.log('  ✓ saved_projects に追加');
  }

  // 3. AI ラベル提案ジョブ
  console.log('\n[Step2] AIラベル提案...');
  const sl = await http_call('POST', '/api/v3/suggest-labels', { post: pick });
  if (!sl.body || !sl.body.jobId) throw new Error('suggest-labels jobId 受信失敗');
  const slResult = await pollJob('/api/v3/suggest-labels-status', sl.body.jobId, 'suggest', 5);
  console.log(`\n  ✓ entities=${slResult.entities?.length || 0} matches=${slResult.matches?.length || 0} searches=${slResult.searches?.length || 0}`);

  // si に保存（手動マージ）
  let si = await http_call('GET', `/api/si-data?postId=${encodeURIComponent(pick.id)}`).then(r => r.body);
  if (!si || !si.boxes) si = { postId: pick.id, version: 'v3', boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } } };
  for (const e of (slResult.entities || [])) {
    if (!si.boxes.entity.items.find(x => x.label === e.name)) si.boxes.entity.items.push({ label: e.name, role: e.role });
  }
  for (const m of (slResult.matches || []))   { if (!si.boxes.match.items.find(x => x.label === m))    si.boxes.match.items.push({ label: m }); }
  for (const s of (slResult.searches || []))  { if (!si.boxes.search.items.find(x => x.label === s))   si.boxes.search.items.push({ label: s }); }
  await http_call('POST', '/api/si-data', { postId: pick.id, siData: si });

  // 4. fetch-all（全ラベル取得）
  console.log('\n[Step2] 全ラベルデータ取得...');
  const items = [
    ...si.boxes.entity.items.map(x => ({ box: 'entity', label: x.label, role: x.role })),
    ...si.boxes.match.items.map(x => ({ box: 'match', label: x.label })),
    ...si.boxes.search.items.map(x => ({ box: 'search', label: x.label })),
  ];
  const fa = await http_call('POST', '/api/v3/fetch-all', { postId: pick.id, items });
  console.log(`  ✓ ${fa.body?.count || 0} 件処理 / 画像取得 ${fa.body?.imageJobsKicked || 0} ラベル`);

  // 5. propose-modules
  console.log('\n[Step3] 構成提案...');
  const pm = await http_call('POST', '/api/v3/propose-modules', { postId: pick.id, count: 7 });
  if (!pm.body || !pm.body.jobId) throw new Error('propose-modules jobId 受信失敗');
  const pmResult = await pollJob('/api/v3/propose-modules-status', pm.body.jobId, 'propose', 5);
  if (!pmResult || !Array.isArray(pmResult.modules)) throw new Error('propose-modules empty result');
  console.log(`\n  ✓ ${pmResult.modules.length} スライド構成`);
  for (const m of pmResult.modules) console.log(`    - ${m.type}: ${m.scriptDir?.slice(0, 60) || ''}`);

  // 構成を保存
  await http_call('POST', '/api/save-modules', { postId: pick.id, modules: pmResult.modules });

  // 6. generate-scenario
  console.log('\n[Step3] 脚本生成...');
  const gs = await http_call('POST', '/api/v3/generate-scenario', { postId: pick.id, modules: pmResult.modules, post: pick });
  if (!gs.body || !gs.body.jobId) throw new Error('generate-scenario jobId 受信失敗');
  const gsResult = await pollJob('/api/v3/scenario-status', gs.body.jobId, 'scenario', 8);
  console.log(`\n  ✓ 脚本完成`);

  // 7. generate-video
  console.log('\n[Step4] 動画生成...');
  const gv = await http_call('POST', '/api/v2/generate-video', { postId: pick.id });
  if (!gv.body || !gv.body.jobId) throw new Error('generate-video jobId 受信失敗');
  const gvResult = await pollJob('/api/v2/video-status', gv.body.jobId, 'video', 15);
  console.log(`\n  ✓ 動画完成: ${gvResult?.outputVideo || '?'}`);

  console.log('\n=== 完了 ===');
  console.log(`postId: ${pick.id}`);
  console.log(`URL: http://37.60.224.54:3004/v2_videos/${path.basename(gvResult?.outputVideo || '')}`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
