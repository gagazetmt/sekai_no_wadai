// scripts/_scottish_clubs.js
// Scottish Premiership の CL/UEL 経験クラブのみ
// Celtic / Rangers が UCL 常連、Aberdeen / Hearts は EL 経験

const LEAGUE_SLUG = 'scottish-premiership';
const LEAGUE_NAME = 'Scottish Premiership';

const SCOTTISH_CLUBS = {
  'celtic':   { searchName: 'Celtic',   name: 'Celtic FC',   stadium: 'Celtic Park',     manager: 'Brendan Rodgers' },
  'rangers':  { searchName: 'Rangers',  name: 'Rangers FC',  stadium: 'Ibrox Stadium',   manager: 'Russell Martin' },
  'aberdeen': { searchName: 'Aberdeen', name: 'Aberdeen FC', stadium: 'Pittodrie Stadium', manager: 'Jimmy Thelin' },
  'hearts':   { searchName: 'Heart of Midlothian', name: 'Heart of Midlothian', stadium: 'Tynecastle Park', manager: 'Derek McInnes' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, SCOTTISH_CLUBS };
