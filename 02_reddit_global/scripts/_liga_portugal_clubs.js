// scripts/_liga_portugal_clubs.js
// Liga Portugal（ポルトガル）の CL 経験クラブのみ
// Porto / Benfica / Sporting / Braga が UCL/UEL 常連

const LEAGUE_SLUG = 'liga-portugal';
const LEAGUE_NAME = 'Liga Portugal';

const LIGA_PORTUGAL_CLUBS = {
  'porto':     { searchName: 'Porto',     name: 'FC Porto',     stadium: 'Estádio do Dragão',        manager: 'Francesco Farioli' },
  'benfica':   { searchName: 'Benfica',   name: 'SL Benfica',   stadium: 'Estádio da Luz',           manager: 'José Mourinho' },
  'sporting':  { searchName: 'Sporting CP', name: 'Sporting CP', stadium: 'Estádio José Alvalade',  manager: 'Rui Borges' },
  'braga':     { searchName: 'Braga',     name: 'SC Braga',     stadium: 'Estádio Municipal de Braga', manager: 'Carlos Carvalhal' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, LIGA_PORTUGAL_CLUBS };
