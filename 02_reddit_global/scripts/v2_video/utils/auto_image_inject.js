// scripts/v2_video/utils/auto_image_inject.js
// profile/stats スライド用に、選手 entity から「国旗」「クラブロゴ」を自動注入する。
// 既存ストック（images_stock/flags / club_logos_index.json）を参照して mod.flagImage / mod.clubLogo を埋める。
//
// 使い方:
//   const { injectAutoImages } = require('./utils/auto_image_inject');
//   modules.forEach(m => injectAutoImages(m, siData));
//
// 対象:
//   mod.type === 'profile' && primary entity が role:player のとき
//   既に手動で flagImage / clubLogo が指定されてる場合は触らない（手動 override 尊重）

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..', '..', '..');
const FLAGS_DIR  = path.join(ROOT, 'images_stock', 'flags');
const CLUB_INDEX = path.join(ROOT, 'data', 'club_logos_index.json');

let _clubIndexCache = null;

function _loadClubIndex() {
  if (_clubIndexCache !== null) return _clubIndexCache;
  try {
    const raw = JSON.parse(fs.readFileSync(CLUB_INDEX, 'utf8'));
    _clubIndexCache = raw && raw.clubs ? raw : { clubs: {} };
  } catch (_) {
    _clubIndexCache = { clubs: {} };
  }
  return _clubIndexCache;
}

// alpha2 ('JP', 'FR', ...) → flag SVG の相対パス（無ければ null）
function _flagPathForAlpha2(alpha2) {
  if (!alpha2) return null;
  const code = String(alpha2).toLowerCase();
  for (const ext of ['svg', 'png', 'jpg']) {
    const p = path.join(FLAGS_DIR, `${code}.${ext}`);
    if (fs.existsSync(p)) {
      return path.relative(ROOT, p).replace(/\\/g, '/');
    }
  }
  return null;
}

// SofaScore teamId → club logo 相対パス
function _clubLogoForSofaTeamId(sofaTeamId) {
  if (!sofaTeamId) return null;
  const idx = _loadClubIndex();
  const id = String(sofaTeamId);
  const entry = Object.values(idx.clubs || {}).find(c => String(c.sofaTeamId || '') === id);
  return entry?.localPath || null;
}

// クラブ名（"Paris Saint-Germain" / "Inter Milan" 等）→ club logo 相対パス
function _clubLogoForName(name) {
  if (!name) return null;
  const lc = String(name).toLowerCase();
  const idx = _loadClubIndex();
  const entries = Object.values(idx.clubs || {});
  // 完全一致 → 部分一致 で探索
  const exact = entries.find(c => (c.clubName || '').toLowerCase() === lc);
  if (exact) return exact.localPath;
  const part = entries.find(c => {
    const cn = (c.clubName || '').toLowerCase();
    return cn && (cn.includes(lc) || lc.includes(cn));
  });
  return part?.localPath || null;
}

// si_data から mainKey に対応する entity を引く
function _findEntity(si, mainKey) {
  if (!si || !mainKey) return null;
  const m = String(mainKey).match(/^entity:(.+)$/);
  if (!m) return null;
  const label = m[1];
  const items = si.boxes?.entity?.items || [];
  return items.find(it => it.label === label) || null;
}

// メイン: mod に flagImage / clubLogo を自動注入（profile タイプのみ）
function injectAutoImages(mod, si) {
  if (!mod || mod.type !== 'profile') return;
  // 手動指定があれば触らない
  if (mod.flagImage && mod.clubLogo) return;

  const entity = _findEntity(si, mod.mainKey);
  if (!entity || entity.role !== 'player') return;

  // 国旗（alpha2 → flag）
  if (!mod.flagImage) {
    const alpha2 = entity.sofa?.country?.alpha2
                || entity.sofa?.countryAlpha2
                || entity.sofa?.country?.code
                || (entity.tm?.nationality && _alpha2FromNation(entity.tm.nationality))
                || null;
    const flagPath = _flagPathForAlpha2(alpha2);
    if (flagPath) mod.flagImage = flagPath;
  }

  // クラブロゴ（sofa.team.id → 公式ロゴ / 名前マッチ fallback）
  if (!mod.clubLogo) {
    const teamId = entity.sofa?.team?.id || entity.sofa?.teamId || null;
    let logoPath = _clubLogoForSofaTeamId(teamId);
    if (!logoPath) {
      const teamName = entity.sofa?.team?.name || entity.sofa?.team || entity.sofa?.currentTeam || '';
      logoPath = _clubLogoForName(teamName);
    }
    if (logoPath) mod.clubLogo = logoPath;
  }
}

// 国名 → alpha2 軽量マップ（Transfermarkt の "Spain" / "France" 等英語名から）
//   主要サッカー国だけ抑える。それ以外は null（fallback）
const _NATION_MAP = {
  'Spain': 'es', 'France': 'fr', 'Germany': 'de', 'Italy': 'it', 'England': 'gb', 'United Kingdom': 'gb',
  'Portugal': 'pt', 'Netherlands': 'nl', 'Belgium': 'be', 'Argentina': 'ar', 'Brazil': 'br',
  'Japan': 'jp', 'South Korea': 'kr', 'Korea Republic': 'kr', 'United States': 'us', 'USA': 'us',
  'Mexico': 'mx', 'Croatia': 'hr', 'Serbia': 'rs', 'Poland': 'pl', 'Denmark': 'dk', 'Sweden': 'se',
  'Norway': 'no', 'Switzerland': 'ch', 'Austria': 'at', 'Czech Republic': 'cz', 'Czechia': 'cz',
  'Russia': 'ru', 'Ukraine': 'ua', 'Greece': 'gr', 'Turkey': 'tr', 'Morocco': 'ma', 'Senegal': 'sn',
  'Nigeria': 'ng', 'Cameroon': 'cm', 'Ivory Coast': 'ci', 'Egypt': 'eg', 'Algeria': 'dz',
  'Tunisia': 'tn', 'Saudi Arabia': 'sa', 'Iran': 'ir', 'Australia': 'au', 'Canada': 'ca',
  'Uruguay': 'uy', 'Chile': 'cl', 'Colombia': 'co', 'Peru': 'pe', 'Ecuador': 'ec', 'Paraguay': 'py',
  'Wales': 'gb-wls', 'Scotland': 'gb-sct', 'Northern Ireland': 'gb-nir', 'Republic of Ireland': 'ie',
  'Georgia': 'ge', 'Armenia': 'am', 'Albania': 'al', 'Slovakia': 'sk', 'Slovenia': 'si',
  'Hungary': 'hu', 'Romania': 'ro', 'Bulgaria': 'bg',
};
function _alpha2FromNation(nation) {
  return _NATION_MAP[nation] || null;
}

module.exports = { injectAutoImages };
