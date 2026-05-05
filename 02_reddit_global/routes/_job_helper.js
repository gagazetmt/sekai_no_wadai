// routes/_job_helper.js
// 長時間処理を非同期ジョブ化するための共通モジュール
//
// 使い方:
//   const { createJob, updateJob, readJob } = require('./_job_helper');
//   router.post('/long-task', (req, res) => {
//     const jobId = createJob('mylabel');
//     res.json({ ok: true, jobId });
//     (async () => {
//       try {
//         updateJob(jobId, { status: 'running', step: 'phase1' });
//         const result = await heavyWork();
//         updateJob(jobId, { status: 'done', result });
//       } catch (e) {
//         updateJob(jobId, { status: 'error', error: e.message });
//       }
//     })();
//   });
//   router.get('/job-status', (req, res) => {
//     res.json(readJob(req.query.jobId) || { error: 'not found' });
//   });

const fs   = require('fs');
const path = require('path');

const JOB_DIR = path.join(__dirname, '..', 'data', 'v2_jobs');
if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR, { recursive: true });

function jobPath(jobId) { return path.join(JOB_DIR, jobId + '.json'); }

// ID生成: prefix_<タイムスタンプ>_<ランダム>
function genJobId(prefix = 'job') {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function createJob(prefix, initial = {}) {
  const jobId = genJobId(prefix);
  const data = {
    jobId,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...initial,
  };
  try {
    fs.writeFileSync(jobPath(jobId), JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn(`[job:${jobId}] create write failed:`, e.message);
  }
  return jobId;
}

function readJob(jobId) {
  if (!jobId) return null;
  try {
    return JSON.parse(fs.readFileSync(jobPath(jobId), 'utf8'));
  } catch (_) { return null; }
}

function updateJob(jobId, patch) {
  if (!jobId) return;
  const cur = readJob(jobId) || { jobId };
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(jobPath(jobId), JSON.stringify(next, null, 2));
  } catch (e) {
    console.warn(`[job:${jobId}] update write failed:`, e.message);
  }
  return next;
}

// 古いジョブの cleanup（24時間超）。任意で呼び出す
function cleanupOldJobs(maxAgeHours = 24) {
  try {
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    for (const f of fs.readdirSync(JOB_DIR)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(JOB_DIR, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch (_) {}
    }
  } catch (_) {}
}

module.exports = { createJob, readJob, updateJob, jobPath, cleanupOldJobs };
