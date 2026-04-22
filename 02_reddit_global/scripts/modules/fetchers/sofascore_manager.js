// scripts/modules/fetchers/sofascore_manager.js
// SofaScore から監督情報（経歴・戦績・フォーメーション）を取得

const axios = require('axios');

const BASE_URL = 'https://api.sofascore.com/api/v1';
const HEADERS  = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'application/json',
  'Referer':    'https://www.sofascore.com/',
  'Origin':     'https://www.sofascore.com',
};

async function apiGet(endpoint) {
  const res = await axios.get(`${BASE_URL}${endpoint}`, { headers: HEADERS, timeout: 12000 });
  return res.data;
}

// 監督名でID検索（チーム詳細経由）
async function findManagerId(managerName) {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(managerName)}`);
  // type=manager が返る場合
  const managers = (data.results || []).filter(r => r.type === 'manager');
  if (managers.length) return managers[0].entity?.id;

  // チームから逆引き（監督名でチーム検索してチーム詳細を見る）
  const teams = (data.results || []).filter(r => r.type === 'team');
  for (const t of teams.slice(0, 3)) {
    try {
      const td = await apiGet(`/team/${t.entity.id}`);
      if (td.team?.manager?.name?.toLowerCase().includes(managerName.toLowerCase())) {
        return td.team.manager.id;
      }
    } catch (_) {}
  }
  return null;
}

async function fetchSofaScoreManager(managerName, managerId = null) {
  if (!managerName && !managerId) return { ok: false, error: '監督名またはIDが必要です' };

  try {
    // ID解決
    const id = managerId || await findManagerId(managerName);
    if (!id) return { ok: false, error: `"${managerName}" の監督IDが見つかりません` };

    const data = await apiGet(`/manager/${id}`);
    const m    = data.manager || {};

    // キャリア整形
    const career = (m.teams || []).map(t => {
      const from = t.inTeamFrom  ? new Date(t.inTeamFrom  * 1000).toISOString().slice(0, 7) : '?';
      const to   = t.inTeamUntil ? new Date(t.inTeamUntil * 1000).toISOString().slice(0, 7) : '現在';
      return { club: t.name, from, to };
    });

    // 通算成績
    const perf = m.performance || {};
    const winRate = perf.total
      ? ((perf.wins / perf.total) * 100).toFixed(1)
      : null;

    const careerStr = career.slice(0, 8).map(c => `${c.club}（${c.from}〜${c.to}）`).join(' → ');

    return {
      ok:                true,
      managerId:         id,
      name:              m.name,
      nationality:       m.nationality,
      preferredFormation: m.preferredFormation || null,
      career,
      performance: perf.total ? {
        total:         perf.total,
        wins:          perf.wins,
        draws:         perf.draws,
        losses:        perf.losses,
        winRate:       parseFloat(winRate),
        goalsScored:   perf.goalsScored,
        goalsConceded: perf.goalsConceded,
      } : null,
      summary:
        `【監督情報】${m.name}（${m.nationality || '不明'}）\n` +
        (m.preferredFormation ? `基本システム: ${m.preferredFormation}\n` : '') +
        (perf.total ? `通算: ${perf.total}試合 ${perf.wins}勝${perf.draws}分${perf.losses}敗（勝率${winRate}%）\n` : '') +
        `経歴: ${careerStr || '（情報なし）'}`,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreManager, findManagerId };
