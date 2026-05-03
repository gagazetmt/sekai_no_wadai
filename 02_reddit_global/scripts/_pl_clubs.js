// scripts/_pl_clubs.js
// Premier League 全クラブの ID/slug マスタ（fetch 系スクリプト共通）
//   ID/slug は premierleague.com/clubs から取得した正規値
//   現行クラブは 2025-26 シーズン基準

const LEAGUE_SLUG = 'premier-league';
const LEAGUE_NAME = 'Premier League';

// stadium は Wikimedia Commons 検索用の正式名
// manager は現行 PL 20クラブのみ（過去PLは履歴管理が複雑なので未設定）
const PL_CLUBS = {
  // ── 現行 PL 20クラブ (2025-26) ──
  'arsenal':                  { id: 3,   slug: 'Arsenal',                  name: 'Arsenal',                       stadium: 'Emirates Stadium',           manager: 'Mikel Arteta' },
  'aston-villa':              { id: 7,   slug: 'Aston-Villa',              name: 'Aston Villa',                   stadium: 'Villa Park',                 manager: 'Unai Emery' },
  'bournemouth':              { id: 91,  slug: 'Bournemouth',              name: 'Bournemouth',                   stadium: 'Vitality Stadium',           manager: 'Andoni Iraola' },
  'brentford':                { id: 94,  slug: 'Brentford',                name: 'Brentford',                     stadium: 'Gtech Community Stadium',    manager: 'Keith Andrews' },
  'brighton':                 { id: 36,  slug: 'Brighton-and-Hove-Albion', name: 'Brighton & Hove Albion',        stadium: 'Falmer Stadium',             manager: 'Fabian Hürzeler' },
  'burnley':                  { id: 90,  slug: 'Burnley',                  name: 'Burnley',                       stadium: 'Turf Moor',                  manager: 'Scott Parker' },
  'chelsea':                  { id: 8,   slug: 'Chelsea',                  name: 'Chelsea',                       stadium: 'Stamford Bridge',            manager: 'Enzo Maresca' },
  'crystal-palace':           { id: 31,  slug: 'Crystal-Palace',           name: 'Crystal Palace',                stadium: 'Selhurst Park',              manager: 'Oliver Glasner' },
  'everton':                  { id: 11,  slug: 'Everton',                  name: 'Everton',                       stadium: 'Goodison Park',              manager: 'David Moyes' },
  'fulham':                   { id: 54,  slug: 'Fulham',                   name: 'Fulham',                        stadium: 'Craven Cottage',             manager: 'Marco Silva' },
  'leeds':                    { id: 2,   slug: 'Leeds-United',             name: 'Leeds United',                  stadium: 'Elland Road',                manager: 'Daniel Farke' },
  'liverpool':                { id: 14,  slug: 'Liverpool',                name: 'Liverpool',                     stadium: 'Anfield',                    manager: 'Arne Slot' },
  'man-city':                 { id: 43,  slug: 'Manchester-City',          name: 'Manchester City',               stadium: 'Etihad Stadium',             manager: 'Pep Guardiola' },
  'man-utd':                  { id: 1,   slug: 'Manchester-United',        name: 'Manchester United',             stadium: 'Old Trafford',               manager: 'Ruben Amorim' },
  'newcastle':                { id: 4,   slug: 'Newcastle-United',         name: 'Newcastle United',              stadium: "St James' Park",             manager: 'Eddie Howe' },
  'nottingham-forest':        { id: 17,  slug: 'Nottingham-Forest',        name: 'Nottingham Forest',             stadium: 'City Ground',                manager: 'Sean Dyche' },
  'sunderland':               { id: 56,  slug: 'Sunderland',               name: 'Sunderland',                    stadium: 'Stadium of Light',           manager: 'Régis Le Bris' },
  'tottenham':                { id: 6,   slug: 'Tottenham-Hotspur',        name: 'Tottenham Hotspur',             stadium: 'Tottenham Hotspur Stadium',  manager: 'Thomas Frank' },
  'west-ham':                 { id: 21,  slug: 'West-Ham-United',          name: 'West Ham United',               stadium: 'London Stadium',             manager: 'Nuno Espírito Santo' },
  'wolves':                   { id: 39,  slug: 'Wolverhampton-Wanderers',  name: 'Wolverhampton Wanderers',       stadium: 'Molineux Stadium',           manager: 'Vítor Pereira' },

  // ── 過去 PL 経験あり 29クラブ ──
  'barnsley':                 { id: 37,  slug: 'Barnsley',                 name: 'Barnsley',                      stadium: 'Oakwell' },
  'birmingham':               { id: 41,  slug: 'Birmingham-City',          name: 'Birmingham City',               stadium: "St Andrew's" },
  'blackburn':                { id: 5,   slug: 'Blackburn-Rovers',         name: 'Blackburn Rovers',              stadium: 'Ewood Park' },
  'blackpool':                { id: 92,  slug: 'Blackpool',                name: 'Blackpool',                     stadium: 'Bloomfield Road' },
  'bolton':                   { id: 30,  slug: 'Bolton-Wanderers',         name: 'Bolton Wanderers',              stadium: 'Toughsheet Community Stadium' },
  'bradford':                 { id: 55,  slug: 'Bradford-City',            name: 'Bradford City',                 stadium: 'Valley Parade' },
  'cardiff':                  { id: 97,  slug: 'Cardiff-City',             name: 'Cardiff City',                  stadium: 'Cardiff City Stadium' },
  'charlton':                 { id: 33,  slug: 'Charlton-Athletic',        name: 'Charlton Athletic',             stadium: 'The Valley' },
  'coventry':                 { id: 9,   slug: 'Coventry-City',            name: 'Coventry City',                 stadium: 'Coventry Building Society Arena' },
  'derby':                    { id: 24,  slug: 'Derby-County',             name: 'Derby County',                  stadium: 'Pride Park' },
  'huddersfield':             { id: 38,  slug: 'Huddersfield-Town',        name: 'Huddersfield Town',             stadium: "John Smith's Stadium" },
  'hull':                     { id: 88,  slug: 'Hull-City',                name: 'Hull City',                     stadium: 'MKM Stadium' },
  'ipswich':                  { id: 40,  slug: 'Ipswich-Town',             name: 'Ipswich Town',                  stadium: 'Portman Road' },
  'leicester':                { id: 13,  slug: 'Leicester-City',           name: 'Leicester City',                stadium: 'King Power Stadium' },
  'luton':                    { id: 102, slug: 'Luton-Town',               name: 'Luton Town',                    stadium: 'Kenilworth Road' },
  'middlesbrough':            { id: 25,  slug: 'Middlesbrough',            name: 'Middlesbrough',                 stadium: 'Riverside Stadium' },
  'norwich':                  { id: 45,  slug: 'Norwich-City',             name: 'Norwich City',                  stadium: 'Carrow Road' },
  'oldham':                   { id: 105, slug: 'Oldham-Athletic',          name: 'Oldham Athletic',               stadium: 'Boundary Park' },
  'portsmouth':               { id: 47,  slug: 'Portsmouth',               name: 'Portsmouth',                    stadium: 'Fratton Park' },
  'qpr':                      { id: 52,  slug: 'Queens-Park-Rangers',      name: 'Queens Park Rangers',           stadium: 'Loftus Road' },
  'reading':                  { id: 108, slug: 'Reading',                  name: 'Reading',                       stadium: 'Madejski Stadium' },
  'sheffield-united':         { id: 49,  slug: 'Sheffield-United',         name: 'Sheffield United',              stadium: 'Bramall Lane' },
  'sheffield-wednesday':      { id: 19,  slug: 'Sheffield-Wednesday',      name: 'Sheffield Wednesday',           stadium: 'Hillsborough Stadium' },
  'southampton':              { id: 20,  slug: 'Southampton',              name: 'Southampton',                   stadium: "St Mary's Stadium" },
  'stoke':                    { id: 110, slug: 'Stoke-City',               name: 'Stoke City',                    stadium: 'bet365 Stadium' },
  'swansea':                  { id: 80,  slug: 'Swansea-City',             name: 'Swansea City',                  stadium: 'Swansea.com Stadium' },
  'swindon':                  { id: 46,  slug: 'Swindon-Town',             name: 'Swindon Town',                  stadium: 'County Ground Swindon' },
  'watford':                  { id: 57,  slug: 'Watford',                  name: 'Watford',                       stadium: 'Vicarage Road' },
  'west-brom':                { id: 35,  slug: 'West-Bromwich-Albion',     name: 'West Bromwich Albion',          stadium: 'The Hawthorns' },
  'wigan':                    { id: 111, slug: 'Wigan-Athletic',           name: 'Wigan Athletic',                stadium: 'Brick Community Stadium' },
  'wimbledon':                { id: 1736,slug: 'Wimbledon',                name: 'Wimbledon',                     stadium: 'Plough Lane' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, PL_CLUBS };
