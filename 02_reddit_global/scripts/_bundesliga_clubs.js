// scripts/_bundesliga_clubs.js
// Bundesliga 全クラブの slug マスタ（fetch 系スクリプト共通）
//   slug は bundesliga.com の URL slug をそのまま使用
//   現行クラブは 2025-26 シーズン基準

const LEAGUE_SLUG = 'bundesliga';
const LEAGUE_NAME = 'Bundesliga';

// stadium は Wikimedia Commons 検索用、manager は SofaScore 検索用
const BUNDESLIGA_CLUBS = {
  // ── 2025-26 Bundesliga 18クラブ ──
  'fc-bayern':              { slug: 'fc-bayern-muenchen',       name: 'FC Bayern München',       stadium: 'Allianz Arena',                manager: 'Vincent Kompany' },
  'bayer-leverkusen':       { slug: 'bayer-04-leverkusen',      name: 'Bayer 04 Leverkusen',     stadium: 'BayArena',                     manager: 'Erik ten Hag' },
  'rb-leipzig':             { slug: 'rb-leipzig',               name: 'RB Leipzig',              stadium: 'Red Bull Arena',               manager: 'Marco Rose' },
  'borussia-dortmund':      { slug: 'borussia-dortmund',        name: 'Borussia Dortmund',       stadium: 'Signal Iduna Park',            manager: 'Niko Kovač' },
  'eintracht-frankfurt':    { slug: 'eintracht-frankfurt',      name: 'Eintracht Frankfurt',     stadium: 'Deutsche Bank Park',           manager: 'Dino Toppmöller' },
  'vfb-stuttgart':          { slug: 'vfb-stuttgart',            name: 'VfB Stuttgart',           stadium: 'MHPArena',                     manager: 'Sebastian Hoeneß' },
  'borussia-moenchengladbach': { slug: 'borussia-moenchengladbach', name: 'Borussia Mönchengladbach', stadium: 'Borussia-Park',           manager: 'Gerardo Seoane' },
  'sc-freiburg':            { slug: 'sport-club-freiburg',      name: 'SC Freiburg',             stadium: 'Europa-Park Stadion',          manager: 'Julian Schuster' },
  'hoffenheim':             { slug: 'tsg-hoffenheim',           name: 'TSG 1899 Hoffenheim',     stadium: 'PreZero Arena',                manager: 'Christian Ilzer' },
  'fc-augsburg':            { slug: 'fc-augsburg',              name: 'FC Augsburg',             stadium: 'WWK Arena',                    manager: 'Jess Thorup' },
  'werder-bremen':          { slug: 'sv-werder-bremen',         name: 'SV Werder Bremen',        stadium: 'wohninvest WESERSTADION',      manager: 'Ole Werner' },
  'mainz':                  { slug: '1-fsv-mainz-05',           name: 'FSV Mainz 05',            stadium: 'MEWA Arena',                   manager: 'Bo Henriksen' },
  'wolfsburg':              { slug: 'vfl-wolfsburg',            name: 'VfL Wolfsburg',           stadium: 'Volkswagen Arena',             manager: 'Ralph Hasenhüttl' },
  'union-berlin':           { slug: '1-fc-union-berlin',        name: '1. FC Union Berlin',      stadium: 'An der Alten Försterei',       manager: 'Steffen Baumgart' },
  'heidenheim':             { slug: '1-fc-heidenheim-1846',     name: '1. FC Heidenheim 1846',   stadium: 'Voith-Arena',                  manager: 'Frank Schmidt' },
  // ── 2025-26 昇格組 ──
  'hamburger-sv':           { slug: 'hamburger-sv',             name: 'Hamburger SV',            stadium: 'Volksparkstadion',             manager: 'Merlin Polzin' },
  'koeln':                  { slug: '1-fc-koeln',               name: '1. FC Köln',              stadium: 'RheinEnergieStadion',          manager: 'Gerhard Struber' },
  'fortuna-duesseldorf':    { slug: 'fortuna-duesseldorf',      name: 'Fortuna Düsseldorf',      stadium: 'Merkur Spiel-Arena',           manager: 'Daniel Thioune' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, BUNDESLIGA_CLUBS };
