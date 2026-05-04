// scripts/_bundesliga_clubs.js
// Bundesliga 全クラブの slug マスタ（fetch 系スクリプト共通）
//   slug は bundesliga.com の URL slug をそのまま使用
//   現行クラブは 2025-26 シーズン基準
//
// manager は初期値（SofaScore 等で動的解決を推奨）
// stadium は Wikimedia Commons 検索用

const LEAGUE_SLUG = 'bundesliga';
const LEAGUE_NAME = 'Bundesliga';

const BUNDESLIGA_CLUBS = {
  // ── 現行 Bundesliga 18クラブ (2025-26) ──
  'bayern-munich':         { slug: 'fc-bayern-muenchen',        name: 'FC Bayern München',           stadium: 'Allianz Arena',                 manager: 'Vincent Kompany' },
  'bayer-leverkusen':      { slug: 'bayer-04-leverkusen',       name: 'Bayer 04 Leverkusen',         stadium: 'BayArena',                      manager: 'Erik ten Hag' },
  'eintracht-frankfurt':   { slug: 'eintracht-frankfurt',       name: 'Eintracht Frankfurt',         stadium: 'Deutsche Bank Park',            manager: 'Dino Toppmöller' },
  'borussia-dortmund':     { slug: 'borussia-dortmund',         name: 'Borussia Dortmund',           stadium: 'SIGNAL IDUNA PARK',             manager: 'Niko Kovač' },
  'freiburg':              { slug: 'sport-club-freiburg',       name: 'SC Freiburg',                 stadium: 'Europa-Park Stadion',           manager: 'Julian Schuster' },
  'mainz':                 { slug: '1-fsv-mainz-05',            name: '1. FSV Mainz 05',             stadium: 'MEWA ARENA',                    manager: 'Bo Henriksen' },
  'rb-leipzig':            { slug: 'rb-leipzig',                name: 'RB Leipzig',                  stadium: 'Red Bull Arena Leipzig',        manager: 'Ole Werner' },
  'werder-bremen':         { slug: 'sv-werder-bremen',          name: 'SV Werder Bremen',            stadium: 'Weserstadion',                  manager: 'Horst Steffen' },
  'vfb-stuttgart':         { slug: 'vfb-stuttgart',             name: 'VfB Stuttgart',               stadium: 'MHPArena',                      manager: 'Sebastian Hoeneß' },
  'borussia-monchengladbach': { slug: 'borussia-moenchengladbach', name: 'Borussia Mönchengladbach', stadium: 'BORUSSIA-PARK',                 manager: 'Gerardo Seoane' },
  'wolfsburg':             { slug: 'vfl-wolfsburg',             name: 'VfL Wolfsburg',               stadium: 'Volkswagen Arena',              manager: 'Paul Simonis' },
  'augsburg':              { slug: 'fc-augsburg',               name: 'FC Augsburg',                 stadium: 'WWK ARENA',                     manager: 'Sandro Wagner' },
  'union-berlin':          { slug: '1-fc-union-berlin',         name: '1. FC Union Berlin',          stadium: 'An der Alten Försterei',        manager: 'Steffen Baumgart' },
  'st-pauli':              { slug: 'fc-st-pauli',               name: 'FC St. Pauli',                stadium: 'Millerntor-Stadion',            manager: 'Alexander Blessin' },
  'hoffenheim':            { slug: 'tsg-hoffenheim',            name: 'TSG 1899 Hoffenheim',         stadium: 'PreZero Arena',                 manager: 'Christian Ilzer' },
  'heidenheim':            { slug: '1-fc-heidenheim-1846',      name: '1. FC Heidenheim 1846',       stadium: 'Voith-Arena',                   manager: 'Frank Schmidt' },
  'cologne':               { slug: '1-fc-koeln',                name: '1. FC Köln',                  stadium: 'RheinEnergieSTADION',           manager: 'Lukas Kwasniok' },
  'hamburg':               { slug: 'hamburger-sv',              name: 'Hamburger SV',                stadium: 'Volksparkstadion',              manager: 'Merlin Polzin' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, BUNDESLIGA_CLUBS };
