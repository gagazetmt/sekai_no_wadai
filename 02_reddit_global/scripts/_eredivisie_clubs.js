// scripts/_eredivisie_clubs.js
// Eredivisie（オランダ）の CL/UEL 経験クラブのみ
// Ajax / PSV / Feyenoord は UCL 常連、AZ / Twente は UEL 常連

const LEAGUE_SLUG = 'eredivisie';
const LEAGUE_NAME = 'Eredivisie';

const EREDIVISIE_CLUBS = {
  'ajax':      { searchName: 'Ajax',      name: 'AFC Ajax',      stadium: 'Johan Cruijff Arena',  manager: 'John Heitinga' },
  'psv':       { searchName: 'PSV',       name: 'PSV Eindhoven', stadium: 'Philips Stadion',      manager: 'Peter Bosz' },
  'feyenoord': { searchName: 'Feyenoord', name: 'Feyenoord',     stadium: 'De Kuip',              manager: 'Robin van Persie' },
  'az':        { searchName: 'AZ Alkmaar', name: 'AZ Alkmaar',   stadium: 'AFAS Stadion',         manager: 'Maarten Martens' },
  'twente':    { searchName: 'Twente',    name: 'FC Twente',     stadium: 'De Grolsch Veste',     manager: 'Joseph Oosting' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, EREDIVISIE_CLUBS };
