/**
 * download_logos.js
 * football-data.org API からチームロゴを取得し、200x200px に統一して保存する
 *
 * 事前準備:
 *   npm install axios sharp   ← 既に済み
 *   .env に FOOTBALL_DATA_API_KEY=xxx を追記
 *
 * 実行:
 *   node _tools/download_logos.js
 *
 * 仕組み:
 *   PL / PD / BL1 / SA / FL1 / CL の 6 コンペを一括取得（API呼び出し 6 回のみ）
 *   → 重複除外して全チームのクレスト URL をダウンロード
 *   → sharp で 200x200 透過 PNG に統一
 *   → 既存ファイルはスキップ（再実行安全）
 */

const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const API_KEY    = process.env.FOOTBALL_DATA_API_KEY;
const OUTPUT_DIR = path.join(__dirname, '..', 'logos');
const SIZE       = 200;

// football-data.org 無料プランは 10 req/min → 競技取得間は余裕を持って待機
const API_DELAY_MS  = 7000;
// 画像ダウンロードは API カウント対象外なので短くてOK
const IMG_DELAY_MS  = 200;

const COMPETITIONS = ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL'];

// ─── チーム名 → ファイル名マッピング ────────────────────────────────────────
// football-data.org が返す正式名称 → logos/ の PNG ファイル名
const NAME_TO_FILE = {
  // Premier League
  'Arsenal FC':                     'arsenal.png',
  'Aston Villa FC':                 'aston_villa.png',
  'AFC Bournemouth':                'bournemouth.png',
  'Brentford FC':                   'brentford.png',
  'Brighton & Hove Albion FC':      'brighton.png',
  'Chelsea FC':                     'chelsea.png',
  'Crystal Palace FC':              'crystal_palace.png',
  'Everton FC':                     'everton.png',
  'Fulham FC':                      'fulham.png',
  'Ipswich Town FC':                'ipswich.png',
  'Leicester City FC':              'leicester.png',
  'Liverpool FC':                   'liverpool.png',
  'Manchester City FC':             'man_city.png',
  'Manchester United FC':           'man_united.png',
  'Newcastle United FC':            'newcastle.png',
  'Nottingham Forest FC':           'nottm_forest.png',
  'Southampton FC':                 'southampton.png',
  'Tottenham Hotspur FC':           'tottenham.png',
  'West Ham United FC':             'west_ham.png',
  'Wolverhampton Wanderers FC':     'wolves.png',
  // La Liga
  'Athletic Club':                  'athletic_bilbao.png',
  'Club Atlético de Madrid':        'atletico_madrid.png',
  'FC Barcelona':                   'barcelona.png',
  'Real Betis Balompié':            'betis.png',
  'RC Celta de Vigo':               'celta_vigo.png',
  'RCD Espanyol de Barcelona':      'espanyol.png',
  'Getafe CF':                      'getafe.png',
  'Girona FC':                      'girona.png',
  'UD Las Palmas':                  'las_palmas.png',
  'CD Leganés':                     'leganes.png',
  'RCD Mallorca':                   'mallorca.png',
  'CA Osasuna':                     'osasuna.png',
  'Rayo Vallecano de Madrid':       'rayo_vallecano.png',
  'Real Madrid CF':                 'real_madrid.png',
  'Real Sociedad de Fútbol':        'real_sociedad.png',
  'Sevilla FC':                     'sevilla.png',
  'Valencia CF':                    'valencia.png',
  'Real Valladolid CF':             'valladolid.png',
  'Villarreal CF':                  'villarreal.png',
  // Bundesliga
  'FC Augsburg':                    'augsburg.png',
  'Bayer 04 Leverkusen':            'bayer_leverkusen.png',
  'FC Bayern München':              'bayern_munich.png',
  'VfL Bochum 1848':                'bochum.png',
  'Borussia Dortmund':              'borussia_dortmund.png',
  'Borussia Mönchengladbach':       'borussia_mgladbach.png',
  'Eintracht Frankfurt':            'eintracht_frankfurt.png',
  'Sport-Club Freiburg':            'freiburg.png',
  'SC Freiburg':                    'freiburg.png',
  '1. FC Heidenheim 1846':          'heidenheim.png',
  'TSG 1899 Hoffenheim':            'hoffenheim.png',
  'Holstein Kiel':                  'holstein_kiel.png',
  '1. FSV Mainz 05':                'mainz.png',
  'RB Leipzig':                     'rb_leipzig.png',
  'FC St. Pauli':                   'st_pauli.png',
  'FC St. Pauli 1910':             'st_pauli.png',
  'VfB Stuttgart':                  'stuttgart.png',
  '1. FC Union Berlin':             'union_berlin.png',
  'SV Werder Bremen':               'werder_bremen.png',
  'VfL Wolfsburg':                  'wolfsburg.png',
  // Serie A
  'AC Milan':                       'ac_milan.png',
  'AS Roma':                        'as_roma.png',
  'Atalanta BC':                    'atalanta.png',
  'Bologna FC 1909':                'bologna.png',
  'Cagliari Calcio':                'cagliari.png',
  'Como 1907':                      'como.png',
  'Empoli FC':                      'empoli.png',
  'ACF Fiorentina':                 'fiorentina.png',
  'Genoa CFC':                      'genoa.png',
  'Hellas Verona FC':               'hellas_verona.png',
  'Inter Milano':                   'inter_milan.png',
  'FC Internazionale Milano':       'inter_milan.png',
  'Juventus FC':                    'juventus.png',
  'SS Lazio':                       'lazio.png',
  'US Lecce':                       'lecce.png',
  'AC Monza':                       'monza.png',
  'SSC Napoli':                     'napoli.png',
  'Parma Calcio 1913':              'parma.png',
  'Torino FC':                      'torino.png',
  'Udinese Calcio':                 'udinese.png',
  'Venezia FC':                     'venezia.png',
  // Ligue 1
  'SCO Angers':                     'angers.png',
  'Angers SCO':                     'angers.png',
  'AJ Auxerre':                     'auxerre.png',
  'Stade Brestois 29':              'brest.png',
  'Le Havre AC':                    'le_havre.png',
  'RC Lens':                        'lens.png',
  'Racing Club de Lens':            'lens.png',
  'LOSC Lille':                     'lille.png',
  'Lille OSC':                      'lille.png',
  'Olympique Lyonnais':             'lyon.png',
  'Olympique de Marseille':         'marseille.png',
  'AS Monaco FC':                   'monaco.png',
  'Montpellier HSC':                'montpellier.png',
  'FC Nantes':                      'nantes.png',
  'OGC Nice':                       'nice.png',
  'Paris Saint-Germain FC':         'psg.png',
  'Stade de Reims':                 'reims.png',
  'Stade Rennais FC 1901':          'rennes.png',
  'AS Saint-Étienne':               'saint_etienne.png',
  'RC Strasbourg Alsace':           'strasbourg.png',
  'Toulouse FC':                    'toulouse.png',
  // UCL 常連（非5大リーグ）— API が返す正式名
  'FC Porto':                       'porto.png',
  'Sport Lisboa e Benfica':         'benfica.png',
  'Sporting Clube de Portugal':     'sporting_cp.png',
  'AFC Ajax':                       'ajax.png',
  'PSV':                            'psv.png',
  'Feyenoord Rotterdam':            'feyenoord.png',
  'Celtic FC':                      'celtic.png',
  'Rangers FC':                     'rangers.png',
  'Club Brugge KV':                 'club_brugge.png',
  'RSC Anderlecht':                 'anderlecht.png',
  'Royal Antwerp FC':               'royal_antwerp.png',
  'FC Shakhtar Donetsk':            'shakhtar_donetsk.png',
  'FC Dynamo Kyiv':                 'dynamo_kyiv.png',
  'FC Red Bull Salzburg':           'rb_salzburg.png',
  'SK Sturm Graz':                  'sturm_graz.png',
  'Galatasaray AŞ':                 'galatasaray.png',
  'Galatasaray SK':                 'galatasaray.png',
  'Beşiktaş JK':                   'besiktas.png',
  'GNK Dinamo Zagreb':              'dinamo_zagreb.png',
  'FK Crvena zvezda':               'red_star_belgrade.png',
  'SK Slavia Praha':                'slavia_prague.png',
  'FC Viktoria Plzeň':              'viktoria_plzen.png',
  'AC Sparta Praha':                'sparta_prague.png',
  'BSC Young Boys':                 'young_boys.png',
  'FC Midtjylland':                 'midtjylland.png',
  'FC København':                   'copenhagen.png',
  'Maccabi Haifa FC':               'maccabi_haifa.png',
  'Olympiakos CFP':                 'olympiakos.png',
  'PAE Olympiakos SFP':             'olympiakos.png',
  'AEK Athens FC':                  'aek_athens.png',
  'PAOK FC':                        'paok.png',
};

// ─── ユーティリティ ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** マッピングにない場合のフォールバック: 英数字のみ残してスネークケース化 */
function autoFilename(teamName) {
  return teamName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') + '.png';
}

async function fetchCompetitionTeams(code) {
  const res = await axios.get(
    `https://api.football-data.org/v4/competitions/${code}/teams`,
    { headers: { 'X-Auth-Token': API_KEY }, timeout: 10000 }
  );
  return res.data.teams;
}

async function downloadAndResize(imageUrl, outputPath) {
  const res = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  await sharp(Buffer.from(res.data))
    .resize(SIZE, SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outputPath);
}

// ─── メイン ──────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error('ERROR: .env に FOOTBALL_DATA_API_KEY が設定されていません');
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── STEP 1: 全コンペのチームを一括取得 ──────────────────────────────────
  console.log('【STEP 1】コンペティション別チーム取得\n');
  const allTeams = new Map(); // id → team

  for (const code of COMPETITIONS) {
    process.stdout.write(`  ${code} ... `);
    try {
      const teams = await fetchCompetitionTeams(code);
      teams.forEach(t => allTeams.set(t.id, t));
      console.log(`${teams.length} チーム取得`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
    // 最後のリクエスト後は待機不要
    if (code !== COMPETITIONS[COMPETITIONS.length - 1]) await sleep(API_DELAY_MS);
  }

  const teams = Array.from(allTeams.values());
  console.log(`\n合計 ${teams.length} チーム（重複除外済み）\n`);

  // ── STEP 2: ロゴをダウンロード & リサイズ ────────────────────────────────
  console.log('【STEP 2】ロゴダウンロード\n');
  const failed = [];
  let skipped = 0, success = 0;

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    const file = NAME_TO_FILE[team.name] || autoFilename(team.name);
    const outputPath = path.join(OUTPUT_DIR, file);
    const prefix = `[${String(i + 1).padStart(3, '0')}/${teams.length}]`;

    if (fs.existsSync(outputPath)) {
      console.log(`${prefix} SKIP     ${file}`);
      skipped++;
      continue;
    }
    if (!team.crest) {
      console.log(`${prefix} NO_CREST ${team.name}`);
      failed.push({ name: team.name, file, reason: 'クレストURLなし' });
      continue;
    }

    try {
      process.stdout.write(`${prefix} ${team.name} ... `);
      await downloadAndResize(team.crest, outputPath);
      console.log(`OK -> ${file}`);
      success++;
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      failed.push({ name: team.name, file, reason: err.message });
    }

    await sleep(IMG_DELAY_MS);
  }

  // ── サマリー ─────────────────────────────────────────────────────────────
  console.log('\n=== 完了 ===');
  console.log(`  成功:    ${success}`);
  console.log(`  スキップ:  ${skipped}`);
  console.log(`  失敗:    ${failed.length}`);

  if (failed.length > 0) {
    console.log('\n--- 失敗リスト ---');
    failed.forEach(f => console.log(`  ${f.name} (${f.file}) => ${f.reason}`));
    fs.writeFileSync(
      path.join(OUTPUT_DIR, '_failed.json'),
      JSON.stringify(failed, null, 2),
      'utf8'
    );
    console.log(`\n詳細: logos/_failed.json`);
  }
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
