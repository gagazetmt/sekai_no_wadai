// scripts/_seriea_clubs.js
// Serie A 全20クラブ（2025-26シーズン）
// 取得は SofaScore API ベース（公式サイトが画像を出さないため）
//   slug は識別用、searchName は SofaScore 検索クエリ

const LEAGUE_SLUG = 'serie-a';
const LEAGUE_NAME = 'Serie A';

const SERIEA_CLUBS = {
  'inter-milan':    { searchName: 'Inter',          name: 'FC Internazionale Milano',  stadium: 'Stadio Giuseppe Meazza',         manager: 'Cristian Chivu' },
  'ac-milan':       { searchName: 'AC Milan',       name: 'AC Milan',                  stadium: 'Stadio Giuseppe Meazza',         manager: 'Massimiliano Allegri' },
  'juventus':       { searchName: 'Juventus',       name: 'Juventus FC',               stadium: 'Allianz Stadium',                manager: 'Igor Tudor' },
  'napoli':         { searchName: 'Napoli',         name: 'SSC Napoli',                stadium: 'Diego Armando Maradona',         manager: 'Antonio Conte' },
  'roma':           { searchName: 'AS Roma',        name: 'AS Roma',                   stadium: 'Stadio Olimpico',                manager: 'Gian Piero Gasperini' },
  'lazio':          { searchName: 'Lazio',          name: 'SS Lazio',                  stadium: 'Stadio Olimpico',                manager: 'Maurizio Sarri' },
  'atalanta':       { searchName: 'Atalanta',       name: 'Atalanta BC',               stadium: 'Gewiss Stadium',                 manager: 'Ivan Jurić' },
  'fiorentina':     { searchName: 'Fiorentina',     name: 'ACF Fiorentina',            stadium: 'Stadio Artemio Franchi',         manager: 'Stefano Pioli' },
  'bologna':        { searchName: 'Bologna',        name: 'Bologna FC 1909',           stadium: 'Stadio Renato Dall\'Ara',        manager: 'Vincenzo Italiano' },
  'torino':         { searchName: 'Torino',         name: 'Torino FC',                 stadium: 'Stadio Olimpico Grande Torino',  manager: 'Marco Baroni' },
  'genoa':          { searchName: 'Genoa',          name: 'Genoa CFC',                 stadium: 'Stadio Luigi Ferraris',          manager: 'Patrick Vieira' },
  'udinese':        { searchName: 'Udinese',        name: 'Udinese Calcio',            stadium: 'Bluenergy Stadium',              manager: 'Kosta Runjaić' },
  'cagliari':       { searchName: 'Cagliari',       name: 'Cagliari Calcio',           stadium: 'Unipol Domus',                   manager: 'Fabio Pisacane' },
  'parma':          { searchName: 'Parma',          name: 'Parma Calcio 1913',         stadium: 'Stadio Ennio Tardini',           manager: 'Carlos Cuesta' },
  'lecce':          { searchName: 'Lecce',          name: 'US Lecce',                  stadium: 'Stadio Via del Mare',            manager: 'Eusebio Di Francesco' },
  'verona':         { searchName: 'Hellas Verona',  name: 'Hellas Verona FC',          stadium: 'Stadio Marc\'Antonio Bentegodi', manager: 'Paolo Zanetti' },
  'como':           { searchName: 'Como',           name: 'Como 1907',                 stadium: 'Stadio Giuseppe Sinigaglia',     manager: 'Cesc Fàbregas' },
  'sassuolo':       { searchName: 'Sassuolo',       name: 'US Sassuolo Calcio',        stadium: 'MAPEI Stadium',                  manager: 'Fabio Grosso' },
  'pisa':           { searchName: 'Pisa',           name: 'Pisa SC',                   stadium: 'Arena Garibaldi',                manager: 'Alberto Gilardino' },
  'cremonese':      { searchName: 'Cremonese',      name: 'US Cremonese',              stadium: 'Stadio Giovanni Zini',           manager: 'Davide Nicola' },
};

module.exports = { LEAGUE_SLUG, LEAGUE_NAME, SERIEA_CLUBS };
