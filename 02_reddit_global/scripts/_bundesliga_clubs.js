// scripts/_bundesliga_clubs.js
// Bundesliga 全クラブの slug マスタ（fetch 系スクリプト共通）
//   現行クラブは 2024-25 シーズン基準（18クラブ）
//   SofaScore ID は検索ベースで解決するので不要

const LEAGUE_SLUG = 'bundesliga';
const LEAGUE_NAME = 'Bundesliga';

// stadium は Wikimedia Commons 検索用、manager は SofaScore 検索用
const BUNDESLIGA_CLUBS = {
  'bayern-munich':    { name: 'FC Bayern München',            stadium: 'Allianz Arena',                  manager: 'Vincent Kompany' },
  'dortmund':         { name: 'Borussia Dortmund',            stadium: 'Signal Iduna Park',              manager: 'Niko Kovač' },
  'leverkusen':       { name: 'Bayer 04 Leverkusen',          stadium: 'BayArena',                       manager: 'Xabi Alonso' },
  'rb-leipzig':       { name: 'RB Leipzig',                   stadium: 'Red Bull Arena Leipzig',         manager: 'Marco Rose' },
  'frankfurt':        { name: 'Eintracht Frankfurt',          stadium: 'Deutsche Bank Park',             manager: 'Dino Toppmöller' },
  'stuttgart':        { name: 'VfB Stuttgart',                stadium: 'MHPArena Stuttgart',             manager: 'Sebastian Hoeneß' },
  'freiburg':         { name: 'SC Freiburg',                  stadium: 'Europa-Park Stadion',            manager: 'Julian Schuster' },
  'hoffenheim':       { name: 'TSG 1899 Hoffenheim',          stadium: 'PreZero Arena',                  manager: 'Christian Ilzer' },
  'werder-bremen':    { name: 'SV Werder Bremen',             stadium: 'wohninvest Weserstadion',        manager: 'Ole Werner' },
  'heidenheim':       { name: '1. FC Heidenheim 1846',        stadium: 'Voith-Arena',                    manager: 'Frank Schmidt' },
  'gladbach':         { name: 'Borussia Mönchengladbach',     stadium: 'Borussia-Park',                  manager: 'Gerardo Seoane' },
  'augsburg':         { name: 'FC Augsburg',                  stadium: 'WWK Arena',                      manager: 'Jess Thorup' },
  'union-berlin':     { name: '1. FC Union Berlin',           stadium: 'An der Alten Försterei',         manager: 'Bo Henriksen' },
  'wolfsburg':        { name: 'VfL Wolfsburg',                stadium: 'Volkswagen Arena',               manager: 'Ralph Hasenhüttl' },
  'bochum':           { name: 'VfL Bochum',                   stadium: 'Vonovia Ruhrstadion',            manager: 'Markus Feldhoff' },
  'mainz':            { name: '1. FSV Mainz 05',              stadium: 'MEWA Arena',                     manager: 'Bo Svensson' },
  'kiel':             { name: 'Holstein Kiel',                stadium: 'Holstein-Stadion',               manager: 'Marcel Rapp' },
  'st-pauli':         { name: 'FC St. Pauli',                 stadium: 'Millerntor-Stadion',             manager: 'Alexander Blessin' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, BUNDESLIGA_CLUBS };
