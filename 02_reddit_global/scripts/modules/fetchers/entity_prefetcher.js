// scripts/modules/fetchers/entity_prefetcher.js
// モジュール提案と同時に SofaScore からエンティティを並列プリフェッチする

const { fetchSofaScorePlayer }  = require('./sofascore_player');
const { fetchSofaScoreTeam }    = require('./sofascore_team');
const { fetchSofaScoreManager } = require('./sofascore_manager');
const { getCategory }           = require('../../stat_presets');

// エンティティ配列を並列で SofaScore から取得
// entities: [{type: "player"|"team"|"manager"|"entity", nameEn: "..."}]
// → { "player:erling haaland": {type, nameEn, data}, ... }
async function prefetchEntities(entities = []) {
  if (!entities.length) return {};

  const results = await Promise.all(
    entities.map(async e => {
      const key = `${e.type}:${e.nameEn.toLowerCase()}`;
      try {
        let data = null;
        if (e.type === 'player') {
          const r = await fetchSofaScorePlayer(e.nameEn);
          data = r.ok ? r : null;
        } else if (e.type === 'team') {
          const r = await fetchSofaScoreTeam(e.nameEn);
          data = r.ok ? r : null;
        } else if (e.type === 'manager') {
          const r = await fetchSofaScoreManager(e.nameEn);
          data = r.ok ? r : null;
        } else if (e.type === 'entity') {
          // typeが曖昧な場合: player → team → manager の順でフォールバック
          const rp = await fetchSofaScorePlayer(e.nameEn);
          if (rp.ok) { data = rp; }
          else {
            const rt = await fetchSofaScoreTeam(e.nameEn);
            if (rt.ok) { data = rt; }
            else {
              const rm = await fetchSofaScoreManager(e.nameEn);
              data = rm.ok ? rm : null;
            }
          }
        }
        console.log(`[prefetch] ${e.type}:${e.nameEn} → ${data ? 'OK' : 'NG'}`);
        return { key, type: e.type, nameEn: e.nameEn, data };
      } catch (err) {
        console.warn(`[prefetch] ${e.nameEn} 失敗: ${err.message}`);
        return { key, type: e.type, nameEn: e.nameEn, data: null };
      }
    })
  );

  return Object.fromEntries(results.map(r => [r.key, r]));
}

// モジュールの種別・paramsから対応するエンティティデータを探す
// manager モジュールはチームデータを使う（standing に勝敗が入っているため）
function findEntityData(mod, entityMap) {
  const cat    = getCategory(mod.id);
  const params = mod.params || {};

  const searches = [];
  if (cat === 'player' || cat === 'transfer' || cat === 'injury') {
    if (params.playerNameEn) searches.push({ type: 'player', name: params.playerNameEn });
  }
  if (cat === 'team' || cat === 'manager') {
    if (params.clubNameEn) searches.push({ type: 'team', name: params.clubNameEn });
    if (params.clubName)   searches.push({ type: 'team', name: params.clubName });
  }
  // match 系は home/away 両方から探す
  if (cat === 'match') {
    if (params.homeTeam) searches.push({ type: 'team', name: params.homeTeam });
    if (params.awayTeam) searches.push({ type: 'team', name: params.awayTeam });
  }
  // 汎用フォールバック
  if (params.playerNameEn) searches.push({ type: 'player', name: params.playerNameEn });
  if (params.clubNameEn)   searches.push({ type: 'team',   name: params.clubNameEn });

  for (const { type, name } of searches) {
    // 完全一致
    const key = `${type}:${name.toLowerCase()}`;
    if (entityMap[key]?.data) return entityMap[key].data;

    // 部分一致（"Manchester City" vs "Man City" 等）
    const found = Object.values(entityMap).find(e =>
      e.type === type && e.data && (
        e.nameEn.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(e.nameEn.toLowerCase())
      )
    );
    if (found?.data) return found.data;
  }

  return null;
}

module.exports = { prefetchEntities, findEntityData };
