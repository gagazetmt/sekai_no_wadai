// scripts/_ligue1_clubs.js
// Ligue 1（フランス）の CL 経験クラブのみ（2025-26シーズン在籍）
// 直近 5 シーズン (2020-21 ~ 2024-25) で UCL/UEL 出場経験のあるクラブを抽出

const LEAGUE_SLUG = 'ligue-1';
const LEAGUE_NAME = 'Ligue 1';

const LIGUE1_CLUBS = {
  'psg':         { searchName: 'Paris Saint-Germain', name: 'Paris Saint-Germain', stadium: 'Parc des Princes',          manager: 'Luis Enrique' },
  'marseille':   { searchName: 'Marseille',           name: 'Olympique de Marseille', stadium: 'Stade Vélodrome',       manager: 'Roberto De Zerbi' },
  'lyon':        { searchName: 'Lyon',                name: 'Olympique Lyonnais',  stadium: 'Groupama Stadium',          manager: 'Paulo Fonseca' },
  'monaco':      { searchName: 'Monaco',              name: 'AS Monaco',           stadium: 'Stade Louis II',            manager: 'Sébastien Pocognoli' },
  'lille':       { searchName: 'Lille',               name: 'LOSC Lille',          stadium: 'Stade Pierre-Mauroy',       manager: 'Bruno Génésio' },
  'lens':        { searchName: 'Lens',                name: 'RC Lens',             stadium: 'Stade Bollaert-Delelis',    manager: 'Pierre Sage' },
  'rennes':      { searchName: 'Rennes',              name: 'Stade Rennais',       stadium: 'Roazhon Park',              manager: 'Habib Beye' },
  'brest':       { searchName: 'Brest',               name: 'Stade Brestois 29',   stadium: 'Stade Francis-Le Blé',      manager: 'Eric Roy' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, LIGUE1_CLUBS };
