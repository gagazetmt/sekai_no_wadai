// scripts/utilities/country_codes.js
// SofaScore / FIFA の 3文字コード (alpha-3) を flagcdn の 2文字コード (alpha-2)
// 及び日本語名に変換するマップ。サッカー文脈でよく出る国を中心に、UK 4地域も含む。
//
// 使い方:
//   const { resolveCountry, getFlagPath } = require('./country_codes');
//   const c = resolveCountry('ARG');           // → { iso2: 'ar', ja: 'アルゼンチン' }
//   const p = getFlagPath('ARG');              // → 'images_stock/flags/ar.svg'

// 主要マッピング（不完全な国は適宜追加）
const ISO3_TO = {
  // ── サッカー超主要国 ──
  ARG: { iso2: 'ar', ja: 'アルゼンチン' },
  BRA: { iso2: 'br', ja: 'ブラジル' },
  ESP: { iso2: 'es', ja: 'スペイン' },
  ITA: { iso2: 'it', ja: 'イタリア' },
  FRA: { iso2: 'fr', ja: 'フランス' },
  DEU: { iso2: 'de', ja: 'ドイツ' },
  GER: { iso2: 'de', ja: 'ドイツ' },          // SofaScore 慣用
  POR: { iso2: 'pt', ja: 'ポルトガル' },
  NED: { iso2: 'nl', ja: 'オランダ' },
  NLD: { iso2: 'nl', ja: 'オランダ' },
  BEL: { iso2: 'be', ja: 'ベルギー' },
  CRO: { iso2: 'hr', ja: 'クロアチア' },
  HRV: { iso2: 'hr', ja: 'クロアチア' },
  SRB: { iso2: 'rs', ja: 'セルビア' },
  POL: { iso2: 'pl', ja: 'ポーランド' },
  AUT: { iso2: 'at', ja: 'オーストリア' },
  SUI: { iso2: 'ch', ja: 'スイス' },
  CHE: { iso2: 'ch', ja: 'スイス' },
  CZE: { iso2: 'cz', ja: 'チェコ' },
  DEN: { iso2: 'dk', ja: 'デンマーク' },
  DNK: { iso2: 'dk', ja: 'デンマーク' },
  SWE: { iso2: 'se', ja: 'スウェーデン' },
  NOR: { iso2: 'no', ja: 'ノルウェー' },
  FIN: { iso2: 'fi', ja: 'フィンランド' },
  ISL: { iso2: 'is', ja: 'アイスランド' },
  ROM: { iso2: 'ro', ja: 'ルーマニア' },
  ROU: { iso2: 'ro', ja: 'ルーマニア' },
  HUN: { iso2: 'hu', ja: 'ハンガリー' },
  BUL: { iso2: 'bg', ja: 'ブルガリア' },
  BGR: { iso2: 'bg', ja: 'ブルガリア' },
  GRE: { iso2: 'gr', ja: 'ギリシャ' },
  GRC: { iso2: 'gr', ja: 'ギリシャ' },
  TUR: { iso2: 'tr', ja: 'トルコ' },
  RUS: { iso2: 'ru', ja: 'ロシア' },
  UKR: { iso2: 'ua', ja: 'ウクライナ' },
  IRL: { iso2: 'ie', ja: 'アイルランド' },

  // ── UK 4地域（FIFA は別協会） ──
  ENG: { iso2: 'gb-eng', ja: 'イングランド' },
  SCO: { iso2: 'gb-sct', ja: 'スコットランド' },
  WAL: { iso2: 'gb-wls', ja: 'ウェールズ' },
  NIR: { iso2: 'gb-nir', ja: '北アイルランド' },
  GBR: { iso2: 'gb',     ja: 'イギリス' },     // 連合王国全体

  // ── 南米 ──
  URU: { iso2: 'uy', ja: 'ウルグアイ' },
  CHI: { iso2: 'cl', ja: 'チリ' },
  CHL: { iso2: 'cl', ja: 'チリ' },
  COL: { iso2: 'co', ja: 'コロンビア' },
  ECU: { iso2: 'ec', ja: 'エクアドル' },
  PAR: { iso2: 'py', ja: 'パラグアイ' },
  PRY: { iso2: 'py', ja: 'パラグアイ' },
  PER: { iso2: 'pe', ja: 'ペルー' },
  VEN: { iso2: 've', ja: 'ベネズエラ' },
  BOL: { iso2: 'bo', ja: 'ボリビア' },

  // ── 北米 ──
  USA: { iso2: 'us', ja: 'アメリカ合衆国' },
  CAN: { iso2: 'ca', ja: 'カナダ' },
  MEX: { iso2: 'mx', ja: 'メキシコ' },
  CRC: { iso2: 'cr', ja: 'コスタリカ' },
  CRI: { iso2: 'cr', ja: 'コスタリカ' },
  PAN: { iso2: 'pa', ja: 'パナマ' },
  HON: { iso2: 'hn', ja: 'ホンジュラス' },
  HND: { iso2: 'hn', ja: 'ホンジュラス' },
  JAM: { iso2: 'jm', ja: 'ジャマイカ' },

  // ── アジア ──
  JPN: { iso2: 'jp', ja: '日本' },
  KOR: { iso2: 'kr', ja: '韓国' },
  PRK: { iso2: 'kp', ja: '北朝鮮' },
  CHN: { iso2: 'cn', ja: '中国' },
  IDN: { iso2: 'id', ja: 'インドネシア' },
  THA: { iso2: 'th', ja: 'タイ' },
  VIE: { iso2: 'vn', ja: 'ベトナム' },
  VNM: { iso2: 'vn', ja: 'ベトナム' },
  PHL: { iso2: 'ph', ja: 'フィリピン' },
  MYS: { iso2: 'my', ja: 'マレーシア' },
  SGP: { iso2: 'sg', ja: 'シンガポール' },
  IND: { iso2: 'in', ja: 'インド' },
  IRN: { iso2: 'ir', ja: 'イラン' },
  IRQ: { iso2: 'iq', ja: 'イラク' },
  KSA: { iso2: 'sa', ja: 'サウジアラビア' },
  SAU: { iso2: 'sa', ja: 'サウジアラビア' },
  UAE: { iso2: 'ae', ja: 'アラブ首長国連邦' },
  ARE: { iso2: 'ae', ja: 'アラブ首長国連邦' },
  QAT: { iso2: 'qa', ja: 'カタール' },
  ISR: { iso2: 'il', ja: 'イスラエル' },
  AUS: { iso2: 'au', ja: 'オーストラリア' },
  NZL: { iso2: 'nz', ja: 'ニュージーランド' },
  UZB: { iso2: 'uz', ja: 'ウズベキスタン' },

  // ── アフリカ ──
  EGY: { iso2: 'eg', ja: 'エジプト' },
  MAR: { iso2: 'ma', ja: 'モロッコ' },
  ALG: { iso2: 'dz', ja: 'アルジェリア' },
  DZA: { iso2: 'dz', ja: 'アルジェリア' },
  TUN: { iso2: 'tn', ja: 'チュニジア' },
  NGA: { iso2: 'ng', ja: 'ナイジェリア' },
  GHA: { iso2: 'gh', ja: 'ガーナ' },
  CIV: { iso2: 'ci', ja: 'コートジボワール' },
  SEN: { iso2: 'sn', ja: 'セネガル' },
  CMR: { iso2: 'cm', ja: 'カメルーン' },
  RSA: { iso2: 'za', ja: '南アフリカ' },
  ZAF: { iso2: 'za', ja: '南アフリカ' },
  KEN: { iso2: 'ke', ja: 'ケニア' },
  ETH: { iso2: 'et', ja: 'エチオピア' },
  MLI: { iso2: 'ml', ja: 'マリ' },
  BFA: { iso2: 'bf', ja: 'ブルキナファソ' },
  GUI: { iso2: 'gn', ja: 'ギニア' },
  GIN: { iso2: 'gn', ja: 'ギニア' },
  COD: { iso2: 'cd', ja: 'コンゴ民主共和国' },
  ANG: { iso2: 'ao', ja: 'アンゴラ' },
  AGO: { iso2: 'ao', ja: 'アンゴラ' },

  // ── その他/小国 ──
  ALB: { iso2: 'al', ja: 'アルバニア' },
  ARM: { iso2: 'am', ja: 'アルメニア' },
  AZE: { iso2: 'az', ja: 'アゼルバイジャン' },
  BIH: { iso2: 'ba', ja: 'ボスニア' },
  BLR: { iso2: 'by', ja: 'ベラルーシ' },
  EST: { iso2: 'ee', ja: 'エストニア' },
  GEO: { iso2: 'ge', ja: 'ジョージア' },
  KAZ: { iso2: 'kz', ja: 'カザフスタン' },
  LAT: { iso2: 'lv', ja: 'ラトビア' },
  LVA: { iso2: 'lv', ja: 'ラトビア' },
  LTU: { iso2: 'lt', ja: 'リトアニア' },
  LUX: { iso2: 'lu', ja: 'ルクセンブルク' },
  MKD: { iso2: 'mk', ja: '北マケドニア' },
  MNE: { iso2: 'me', ja: 'モンテネグロ' },
  SVK: { iso2: 'sk', ja: 'スロバキア' },
  SVN: { iso2: 'si', ja: 'スロベニア' },
  XKX: { iso2: 'xk', ja: 'コソボ' },
  KOS: { iso2: 'xk', ja: 'コソボ' },
  CYP: { iso2: 'cy', ja: 'キプロス' },
  MLT: { iso2: 'mt', ja: 'マルタ' },
  MAT: { iso2: 'mt', ja: 'マルタ' },
};

// 国名 (英語) → ISO3 マップ（SofaScore countryName からの解決用）
const NAME_TO_ISO3 = {
  // 例: 'Argentina': 'ARG'
  // 必要時に拡張。基本は countryCode 直接使えれば不要
  Argentina: 'ARG', Brazil: 'BRA', Spain: 'ESP', Italy: 'ITA', France: 'FRA',
  Germany: 'DEU', Portugal: 'POR', Netherlands: 'NED', Belgium: 'BEL',
  Croatia: 'CRO', Serbia: 'SRB', Poland: 'POL', Austria: 'AUT', Switzerland: 'SUI',
  'Czech Republic': 'CZE', Czechia: 'CZE',
  Denmark: 'DEN', Sweden: 'SWE', Norway: 'NOR', Finland: 'FIN', Iceland: 'ISL',
  Romania: 'ROM', Hungary: 'HUN', Bulgaria: 'BUL', Greece: 'GRE', Turkey: 'TUR',
  Russia: 'RUS', Ukraine: 'UKR', Ireland: 'IRL',
  England: 'ENG', Scotland: 'SCO', Wales: 'WAL', 'Northern Ireland': 'NIR',
  Uruguay: 'URU', Chile: 'CHI', Colombia: 'COL', Ecuador: 'ECU', Paraguay: 'PAR',
  Peru: 'PER', Venezuela: 'VEN', Bolivia: 'BOL',
  'United States': 'USA', USA: 'USA', Canada: 'CAN', Mexico: 'MEX',
  Japan: 'JPN', 'South Korea': 'KOR', 'Republic of Korea': 'KOR',
  China: 'CHN', Indonesia: 'IDN', Thailand: 'THA', Vietnam: 'VIE', Philippines: 'PHL',
  Malaysia: 'MYS', Singapore: 'SGP', India: 'IND',
  Iran: 'IRN', Iraq: 'IRQ', 'Saudi Arabia': 'KSA', 'United Arab Emirates': 'UAE',
  Qatar: 'QAT', Israel: 'ISR', Australia: 'AUS', 'New Zealand': 'NZL',
  Egypt: 'EGY', Morocco: 'MAR', Algeria: 'ALG', Tunisia: 'TUN', Nigeria: 'NGA',
  Ghana: 'GHA', 'Ivory Coast': 'CIV', "Côte d'Ivoire": 'CIV', Senegal: 'SEN',
  Cameroon: 'CMR', 'South Africa': 'RSA',
};

function resolveCountry(input) {
  if (!input) return null;
  const k = String(input).trim();
  // alpha-3 直接ヒット
  if (ISO3_TO[k.toUpperCase()]) return ISO3_TO[k.toUpperCase()];
  // 国名から
  const iso3 = NAME_TO_ISO3[k];
  if (iso3) return ISO3_TO[iso3];
  return null;
}

function getFlagPath(input) {
  const c = resolveCountry(input);
  if (!c) return null;
  return `images_stock/flags/${c.iso2}.svg`;
}

module.exports = { ISO3_TO, NAME_TO_ISO3, resolveCountry, getFlagPath };
