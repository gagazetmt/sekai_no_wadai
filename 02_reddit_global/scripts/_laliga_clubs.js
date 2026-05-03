// scripts/_laliga_clubs.js
// LaLiga EA Sports 全クラブの slug マスタ（fetch 系スクリプト共通）
//   slug は laliga.com の URL slug をそのまま使用
//   現行クラブは 2025-26 シーズン基準

const LEAGUE_SLUG = 'la-liga';
const LEAGUE_NAME = 'La Liga';

// stadium は Wikimedia Commons 検索用、manager は SofaScore 検索用
const LALIGA_CLUBS = {
  // ── 現行 LaLiga EA Sports 20クラブ (2025-26) ──
  'athletic-bilbao':    { slug: 'athletic-club',     name: 'Athletic Club',          stadium: 'San Mamés',                  manager: 'Ernesto Valverde' },
  'atletico-madrid':    { slug: 'atletico-de-madrid', name: 'Atlético de Madrid',    stadium: 'Riyadh Air Metropolitano',   manager: 'Diego Simeone' },
  'osasuna':            { slug: 'c-a-osasuna',       name: 'CA Osasuna',             stadium: 'El Sadar Stadium',           manager: 'Alessio Lisci' },
  'celta-vigo':         { slug: 'rc-celta',          name: 'RC Celta',               stadium: 'Estadio Abanca-Balaídos',    manager: 'Claudio Giráldez' },
  'alaves':             { slug: 'd-alaves',          name: 'Deportivo Alavés',       stadium: 'Estadio Mendizorroza',       manager: 'Eduardo Coudet' },
  'elche':              { slug: 'elche-c-f',         name: 'Elche CF',               stadium: 'Estadio Manuel Martínez Valero', manager: 'Eder Sarabia' },
  'barcelona':          { slug: 'fc-barcelona',      name: 'FC Barcelona',           stadium: 'Spotify Camp Nou',           manager: 'Hansi Flick' },
  'getafe':             { slug: 'getafe-cf',         name: 'Getafe CF',              stadium: 'Coliseum Alfonso Pérez',     manager: 'José Bordalás' },
  'girona':             { slug: 'girona-fc',         name: 'Girona FC',              stadium: 'Estadi Montilivi',           manager: 'Míchel' },
  'levante':            { slug: 'levante-ud',        name: 'Levante UD',             stadium: 'Estadi Ciutat de València',  manager: 'Julián Calero' },
  'rayo-vallecano':     { slug: 'rayo-vallecano',    name: 'Rayo Vallecano',         stadium: 'Campo de Vallecas',          manager: 'Iñigo Pérez' },
  'espanyol':           { slug: 'rcd-espanyol',      name: 'RCD Espanyol',           stadium: 'RCDE Stadium',               manager: 'Manolo González' },
  'mallorca':           { slug: 'rcd-mallorca',      name: 'RCD Mallorca',           stadium: 'Estadi Mallorca Son Moix',   manager: 'Jagoba Arrasate' },
  'real-betis':         { slug: 'real-betis',        name: 'Real Betis',             stadium: 'Estadio Benito Villamarín',  manager: 'Manuel Pellegrini' },
  'real-madrid':        { slug: 'real-madrid',       name: 'Real Madrid',            stadium: 'Santiago Bernabéu Stadium',  manager: 'Xabi Alonso' },
  'real-oviedo':        { slug: 'real-oviedo',       name: 'Real Oviedo',            stadium: 'Estadio Carlos Tartiere',    manager: 'Veljko Paunović' },
  'real-sociedad':      { slug: 'real-sociedad',     name: 'Real Sociedad',          stadium: 'Reale Arena',                manager: 'Sergio Francisco' },
  'sevilla':            { slug: 'sevilla-fc',        name: 'Sevilla FC',             stadium: 'Ramón Sánchez Pizjuán Stadium', manager: 'Matías Almeyda' },
  'valencia':           { slug: 'valencia-cf',       name: 'Valencia CF',            stadium: 'Mestalla Stadium',           manager: 'Carlos Corberán' },
  'villarreal':         { slug: 'villarreal-cf',     name: 'Villarreal CF',          stadium: 'Estadio de la Cerámica',     manager: 'Marcelino' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, LALIGA_CLUBS };
