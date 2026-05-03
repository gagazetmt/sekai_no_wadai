// scripts/_pl_clubs.js
// Premier League 全クラブの ID/slug マスタ（fetch 系スクリプト共通）
//   ID/slug は premierleague.com/clubs から取得した正規値
//   現行クラブは 2025-26 シーズン基準

const LEAGUE_SLUG = 'premier-league';
const LEAGUE_NAME = 'Premier League';

const PL_CLUBS = {
  // ── 現行 PL 20クラブ (2025-26) ──
  'arsenal':                  { id: 3,   slug: 'Arsenal',                  name: 'Arsenal' },
  'aston-villa':              { id: 7,   slug: 'Aston-Villa',              name: 'Aston Villa' },
  'bournemouth':              { id: 91,  slug: 'Bournemouth',              name: 'Bournemouth' },
  'brentford':                { id: 94,  slug: 'Brentford',                name: 'Brentford' },
  'brighton':                 { id: 36,  slug: 'Brighton-and-Hove-Albion', name: 'Brighton & Hove Albion' },
  'burnley':                  { id: 90,  slug: 'Burnley',                  name: 'Burnley' },
  'chelsea':                  { id: 8,   slug: 'Chelsea',                  name: 'Chelsea' },
  'crystal-palace':           { id: 31,  slug: 'Crystal-Palace',           name: 'Crystal Palace' },
  'everton':                  { id: 11,  slug: 'Everton',                  name: 'Everton' },
  'fulham':                   { id: 54,  slug: 'Fulham',                   name: 'Fulham' },
  'leeds':                    { id: 2,   slug: 'Leeds-United',             name: 'Leeds United' },
  'liverpool':                { id: 14,  slug: 'Liverpool',                name: 'Liverpool' },
  'man-city':                 { id: 43,  slug: 'Manchester-City',          name: 'Manchester City' },
  'man-utd':                  { id: 1,   slug: 'Manchester-United',        name: 'Manchester United' },
  'newcastle':                { id: 4,   slug: 'Newcastle-United',         name: 'Newcastle United' },
  'nottingham-forest':        { id: 17,  slug: 'Nottingham-Forest',        name: 'Nottingham Forest' },
  'sunderland':               { id: 56,  slug: 'Sunderland',               name: 'Sunderland' },
  'tottenham':                { id: 6,   slug: 'Tottenham-Hotspur',        name: 'Tottenham Hotspur' },
  'west-ham':                 { id: 21,  slug: 'West-Ham-United',          name: 'West Ham United' },
  'wolves':                   { id: 39,  slug: 'Wolverhampton-Wanderers',  name: 'Wolverhampton Wanderers' },

  // ── 過去 PL 経験あり 29クラブ ──
  'barnsley':                 { id: 37,  slug: 'Barnsley',                 name: 'Barnsley' },
  'birmingham':               { id: 41,  slug: 'Birmingham-City',          name: 'Birmingham City' },
  'blackburn':                { id: 5,   slug: 'Blackburn-Rovers',         name: 'Blackburn Rovers' },
  'blackpool':                { id: 92,  slug: 'Blackpool',                name: 'Blackpool' },
  'bolton':                   { id: 30,  slug: 'Bolton-Wanderers',         name: 'Bolton Wanderers' },
  'bradford':                 { id: 55,  slug: 'Bradford-City',            name: 'Bradford City' },
  'cardiff':                  { id: 97,  slug: 'Cardiff-City',             name: 'Cardiff City' },
  'charlton':                 { id: 33,  slug: 'Charlton-Athletic',        name: 'Charlton Athletic' },
  'coventry':                 { id: 9,   slug: 'Coventry-City',            name: 'Coventry City' },
  'derby':                    { id: 24,  slug: 'Derby-County',             name: 'Derby County' },
  'huddersfield':             { id: 38,  slug: 'Huddersfield-Town',        name: 'Huddersfield Town' },
  'hull':                     { id: 88,  slug: 'Hull-City',                name: 'Hull City' },
  'ipswich':                  { id: 40,  slug: 'Ipswich-Town',             name: 'Ipswich Town' },
  'leicester':                { id: 13,  slug: 'Leicester-City',           name: 'Leicester City' },
  'luton':                    { id: 102, slug: 'Luton-Town',               name: 'Luton Town' },
  'middlesbrough':            { id: 25,  slug: 'Middlesbrough',            name: 'Middlesbrough' },
  'norwich':                  { id: 45,  slug: 'Norwich-City',             name: 'Norwich City' },
  'oldham':                   { id: 105, slug: 'Oldham-Athletic',          name: 'Oldham Athletic' },
  'portsmouth':               { id: 47,  slug: 'Portsmouth',               name: 'Portsmouth' },
  'qpr':                      { id: 52,  slug: 'Queens-Park-Rangers',      name: 'Queens Park Rangers' },
  'reading':                  { id: 108, slug: 'Reading',                  name: 'Reading' },
  'sheffield-united':         { id: 49,  slug: 'Sheffield-United',         name: 'Sheffield United' },
  'sheffield-wednesday':      { id: 19,  slug: 'Sheffield-Wednesday',      name: 'Sheffield Wednesday' },
  'southampton':              { id: 20,  slug: 'Southampton',              name: 'Southampton' },
  'stoke':                    { id: 110, slug: 'Stoke-City',               name: 'Stoke City' },
  'swansea':                  { id: 80,  slug: 'Swansea-City',             name: 'Swansea City' },
  'swindon':                  { id: 46,  slug: 'Swindon-Town',             name: 'Swindon Town' },
  'watford':                  { id: 57,  slug: 'Watford',                  name: 'Watford' },
  'west-brom':                { id: 35,  slug: 'West-Bromwich-Albion',     name: 'West Bromwich Albion' },
  'wigan':                    { id: 111, slug: 'Wigan-Athletic',           name: 'Wigan Athletic' },
  'wimbledon':                { id: 1736,slug: 'Wimbledon',                name: 'Wimbledon' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, PL_CLUBS };
