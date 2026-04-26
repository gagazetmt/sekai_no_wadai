// scripts/v2_video/slides/_common.js
// 全スライドテンプレート共通のベース CSS・カラーパレット・ユーティリティ

const fs   = require('fs');
const path = require('path');

const W = 1920, H = 1080;

// 型3 ダークネイビー基調（全スライド共通）
const PALETTE = {
  bg:      '#060e1c',
  surface: '#0d1830',
  accent:  '#f59e0b',
  text:    '#ffffff',
  muted:   '#94a3b8',
  blue:    '#93c5fd',   // 対比左
  red:     '#fca5a5',   // 対比右
  green:   '#10b981',
};

// HTMLエスケープ
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 画像を base64 で埋め込み（Puppeteer の file:// アクセス回避）
function imgDataUri(imgPath) {
  if (!imgPath) return null;
  try {
    // 絶対パスじゃなければプロジェクトルート基準で解決
    const abs = path.isAbsolute(imgPath)
      ? imgPath
      : path.join(__dirname, '..', '..', '..', imgPath.replace(/^\//, ''));
    if (!fs.existsSync(abs)) return null;
    const ext  = path.extname(abs).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const b64  = fs.readFileSync(abs).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch (_) { return null; }
}

// 共通 HTML wrapper。slideBody にスライド本体を渡すと 1920×1080 の完全な HTML を返す
function wrapHTML({ slideBody, extraStyles = '' }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>V2 Slide</title>
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: ${W}px;
  height: ${H}px;
  overflow: hidden;
  background: ${PALETTE.bg};
  font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif;
}
.slide {
  width: ${W}px;
  height: ${H}px;
  position: relative;
  color: ${PALETTE.text};
  overflow: hidden;
}
${extraStyles}
</style>
</head>
<body>
<div class="slide">${slideBody}</div>
</body>
</html>`;
}

// 字幕テキストを 2 行に自然分割（日本語向け）
//   - 句読点・スペース・「だ」「ます」「です」「！」「？」等の区切りを優先
//   - 区切りなければ中央付近で強制分割
//   - 30〜36字を超えたらフォントサイズも自動で1段階下げる
function splitSubtitle(text, maxLineLen = 36) {
  const t = String(text || '').trim();
  if (!t) return { lines: [], fontSize: null };
  if (t.length <= maxLineLen) return { lines: [t], fontSize: null };

  // 自然な区切り候補（位置, 強さ）を抽出
  const candidates = [];
  const breaks = ['。', '！', '？', '!', '?', '、', ',', ' ', '。', '・'];
  for (let i = Math.floor(t.length * 0.3); i < Math.floor(t.length * 0.7); i++) {
    if (breaks.includes(t[i])) candidates.push({ pos: i + 1, score: 10 - Math.abs(t.length / 2 - i) / 10 });
  }
  // 動詞の末尾「だ」「だ。」「ます」「です」も自然区切り
  const verbEnds = ['だ', 'ます', 'です', 'のだ', 'んだ'];
  for (const v of verbEnds) {
    let idx = t.indexOf(v);
    while (idx !== -1) {
      const end = idx + v.length;
      if (end > t.length * 0.3 && end < t.length * 0.7) {
        candidates.push({ pos: end, score: 8 });
      }
      idx = t.indexOf(v, idx + 1);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const splitAt = candidates.length ? candidates[0].pos : Math.floor(t.length / 2);

  const line1 = t.slice(0, splitAt).trim();
  const line2 = t.slice(splitAt).trim();
  const longest = Math.max(line1.length, line2.length);

  // 1行が長すぎたらフォント縮小
  let fontSize = null;
  if (longest > 30) fontSize = 32;
  if (longest > 38) fontSize = 28;
  if (longest > 46) fontSize = 24;

  return { lines: [line1, line2], fontSize };
}

// 字幕バー HTML を生成（共通）
//   options.height（px）: 字幕バー高さ。デフォルト 110
//   options.maxLineLen   : 1行最大文字数。デフォルト 36
function buildSubtitleBar(text, options = {}) {
  const t = String(text || '').trim();
  if (!t) return '';
  const height = options.height || 110;
  const maxLineLen = options.maxLineLen || 36;
  const { lines, fontSize } = splitSubtitle(t, maxLineLen);
  const fontStyle = fontSize ? `font-size: ${fontSize}px;` : '';
  const linesHtml = lines.map(l => `<div>${esc(l)}</div>`).join('');

  return `<div class="v2-sub-bar" style="position:absolute;bottom:0;left:0;right:0;height:${height}px;`
    + `background:rgba(0,0,0,0.92);border-top:3px solid rgba(245,158,11,0.5);`
    + `display:flex;align-items:center;justify-content:center;z-index:20">`
    + `<div style="color:#fff;font-size:38px;font-weight:800;text-align:center;`
    + `padding:0 70px;line-height:1.35;${fontStyle}">${linesHtml}</div></div>`;
}

// ═══════════════════════════════════════════════════════════
// 全スライド共通: 大会名/会場/チーム名 → 日本語化マップ
// ═══════════════════════════════════════════════════════════
const I18N = {
  // 大会
  'FA Cup': 'FAカップ',
  'EFL Cup': 'リーグカップ',
  'Premier League': 'プレミアリーグ',
  'La Liga': 'ラ・リーガ',                    'LaLiga': 'ラ・リーガ',
  'Bundesliga': 'ブンデスリーガ',
  'Serie A': 'セリエA',
  'Ligue 1': 'リーグ・アン',
  'Eredivisie': 'エールディヴィジ',
  'UEFA Champions League': 'UEFAチャンピオンズリーグ',  'Champions League': 'チャンピオンズリーグ',
  'UEFA Europa League': 'UEFAヨーロッパリーグ',         'Europa League': 'ヨーロッパリーグ',
  'UEFA Conference League': 'UEFAカンファレンスリーグ',
  'FIFA World Cup': 'FIFAワールドカップ',
  'UEFA European Championship': 'UEFA欧州選手権',
  'Copa America': 'コパ・アメリカ',
  'Copa del Rey': 'コパ・デル・レイ',
  'DFB-Pokal': 'DFBポカール',
  'Coppa Italia': 'コッパ・イタリア',
  'Coupe de France': 'クープ・ドゥ・フランス',
  'Supercopa de España': 'スーパーコパ・デ・エスパーニャ',
  'Community Shield': 'コミュニティ・シールド',
  // 会場
  'Wembley Stadium': 'ウェンブリー',                    'Wembley': 'ウェンブリー',
  'Old Trafford': 'オールド・トラッフォード',
  'Anfield': 'アンフィールド',
  'Etihad Stadium': 'エティハド',
  'Stamford Bridge': 'スタンフォード・ブリッジ',
  'Emirates Stadium': 'エミレーツ',
  'Tottenham Hotspur Stadium': 'トッテナム・ホットスパー・スタジアム',
  'St. James\' Park': 'セント・ジェームズ・パーク',
  'Goodison Park': 'グディソン・パーク',
  'Santiago Bernabéu': 'サンチアゴ・ベルナベウ',
  'Camp Nou': 'カンプ・ノウ',                            'Spotify Camp Nou': 'カンプ・ノウ',
  'Wanda Metropolitano': 'メトロポリターノ',             'Cívitas Metropolitano': 'メトロポリターノ',
  'Allianz Arena': 'アリアンツ・アレーナ',
  'Signal Iduna Park': 'ジグナル・イドゥナ・パルク',
  'San Siro': 'サン・シーロ',                            'Giuseppe Meazza': 'サン・シーロ',
  'Allianz Stadium': 'アリアンツ・スタジアム',
  'Stadio Olimpico': 'スタディオ・オリンピコ',
  'Parc des Princes': 'パルク・デ・プランス',
  // 主要チーム（プレミア）
  'Manchester City': 'マンチェスター・シティ',
  'Manchester United': 'マンチェスター・ユナイテッド',
  'Liverpool': 'リヴァプール',
  'Arsenal': 'アーセナル',
  'Chelsea': 'チェルシー',
  'Tottenham Hotspur': 'トッテナム',                      'Tottenham': 'トッテナム',
  'Newcastle United': 'ニューカッスル',                   'Newcastle': 'ニューカッスル',
  'Aston Villa': 'アストン・ヴィラ',
  'West Ham United': 'ウェストハム',                      'West Ham': 'ウェストハム',
  'Brighton & Hove Albion': 'ブライトン',                 'Brighton': 'ブライトン',
  'Crystal Palace': 'クリスタル・パレス',
  'Everton': 'エヴァートン',
  'Wolverhampton Wanderers': 'ウルブス',                  'Wolves': 'ウルブス',
  'Brentford': 'ブレントフォード',
  'Fulham': 'フラム',
  'Bournemouth': 'ボーンマス',
  'Nottingham Forest': 'ノッティンガム・フォレスト',
  'Leicester City': 'レスター',                           'Leicester': 'レスター',
  'Leeds United': 'リーズ',
  'Southampton': 'サウサンプトン',
  // ラ・リーガ
  'Real Madrid': 'レアル・マドリード',                    'Real Madrid CF': 'レアル・マドリード',
  'Barcelona': 'バルセロナ',                              'FC Barcelona': 'バルセロナ',
  'Atlético Madrid': 'アトレティコ・マドリード',          'Atletico Madrid': 'アトレティコ・マドリード',
  'Atlético de Madrid': 'アトレティコ・マドリード',
  'Real Betis': 'ベティス',
  'Real Sociedad': 'レアル・ソシエダ',
  'Athletic Bilbao': 'ビルバオ',                          'Athletic Club': 'ビルバオ',
  'Sevilla': 'セビージャ',
  'Valencia': 'バレンシア',
  'Villarreal': 'ビジャレアル',
  // ブンデスリーガ
  'Bayern Munich': 'バイエルン・ミュンヘン',              'FC Bayern München': 'バイエルン・ミュンヘン',
  'Borussia Dortmund': 'ドルトムント',
  'RB Leipzig': 'ライプツィヒ',
  'Bayer Leverkusen': 'レヴァークーゼン',
  'Eintracht Frankfurt': 'フランクフルト',
  'Borussia Mönchengladbach': 'ボルシアMG',
  // セリエA
  'Juventus': 'ユヴェントス',
  'Inter': 'インテル',                                    'Inter Milan': 'インテル',
  'AC Milan': 'ミラン',                                   'Milan': 'ミラン',
  'Napoli': 'ナポリ',
  'Roma': 'ローマ',                                       'AS Roma': 'ローマ',
  'Lazio': 'ラツィオ',
  'Atalanta': 'アタランタ',
  // リーグ・アン
  'PSG': 'パリ・サン＝ジェルマン',                        'Paris Saint-Germain': 'パリ・サン＝ジェルマン',
  'Marseille': 'マルセイユ',                              'Olympique de Marseille': 'マルセイユ',
  'Lyon': 'リヨン',                                       'Olympique Lyonnais': 'リヨン',
  'Monaco': 'モナコ',                                     'AS Monaco': 'モナコ',
};
function _t(s) { return s == null ? '' : (I18N[String(s).trim()] || s); }

// ═══════════════════════════════════════════════════════════
// チーム名 → 3文字略称（matchcard専用、他スライドでは未使用）
// ═══════════════════════════════════════════════════════════
const TEAM_ABBR = {
  'Manchester City': 'MCI', 'Manchester United': 'MUN', 'Liverpool': 'LIV', 'Arsenal': 'ARS', 'Chelsea': 'CHE',
  'Tottenham Hotspur': 'TOT', 'Tottenham': 'TOT', 'Newcastle United': 'NEW', 'Newcastle': 'NEW',
  'Aston Villa': 'AVL', 'West Ham United': 'WHU', 'West Ham': 'WHU', 'Brighton & Hove Albion': 'BHA', 'Brighton': 'BHA',
  'Crystal Palace': 'CRY', 'Everton': 'EVE', 'Wolverhampton Wanderers': 'WOL', 'Wolves': 'WOL',
  'Brentford': 'BRE', 'Fulham': 'FUL', 'Bournemouth': 'BOU', 'Nottingham Forest': 'NFO',
  'Leicester City': 'LEI', 'Leicester': 'LEI', 'Leeds United': 'LEE', 'Southampton': 'SOU',
  'Burnley': 'BUR', 'Sheffield United': 'SHU',
  'Real Madrid': 'RMA', 'Real Madrid CF': 'RMA', 'Barcelona': 'BAR', 'FC Barcelona': 'BAR',
  'Atlético Madrid': 'ATM', 'Atletico Madrid': 'ATM', 'Atlético de Madrid': 'ATM',
  'Real Betis': 'BET', 'Real Sociedad': 'RSO', 'Athletic Bilbao': 'ATH', 'Athletic Club': 'ATH',
  'Sevilla': 'SEV', 'Valencia': 'VAL', 'Villarreal': 'VIL',
  'Bayern Munich': 'BAY', 'FC Bayern München': 'BAY', 'Borussia Dortmund': 'BVB',
  'RB Leipzig': 'RBL', 'Bayer Leverkusen': 'B04', 'Eintracht Frankfurt': 'SGE', 'Borussia Mönchengladbach': 'BMG',
  'Juventus': 'JUV', 'Inter': 'INT', 'Inter Milan': 'INT', 'AC Milan': 'MIL', 'Milan': 'MIL',
  'Napoli': 'NAP', 'Roma': 'ROM', 'AS Roma': 'ROM', 'Lazio': 'LAZ', 'Atalanta': 'ATA',
  'PSG': 'PSG', 'Paris Saint-Germain': 'PSG', 'Marseille': 'OM', 'Olympique de Marseille': 'OM',
  'Lyon': 'OL', 'Olympique Lyonnais': 'OL', 'Monaco': 'MON', 'AS Monaco': 'MON',
};
function _abbr(name) {
  if (!name) return '???';
  const trimmed = String(name).trim();
  if (TEAM_ABBR[trimmed]) return TEAM_ABBR[trimmed];
  const cleaned = trimmed.replace(/^(FC|AC|AS|SC|SK|RC|CD)\s+/i, '');
  const words = cleaned.split(/\s+/);
  if (words.length >= 2) return words.map(w => w[0] || '').join('').slice(0, 3).toUpperCase();
  return cleaned.slice(0, 3).toUpperCase();
}

// ═══════════════════════════════════════════════════════════
// 選手名 → カタカナ短縮（マップ外は last word のみ）
// ═══════════════════════════════════════════════════════════
const PLAYER_NAMES = {
  // === Manchester City ===
  'Ederson': 'エデルソン', 'James Trafford': 'トラッフォード', 'Stefan Ortega': 'オルテガ',
  'Rúben Dias': 'ディアス', 'Ruben Dias': 'ディアス', 'John Stones': 'ストーンズ', 'Manuel Akanji': 'アカンジ',
  'Joško Gvardiol': 'グヴァルディオル', 'Josko Gvardiol': 'グヴァルディオル',
  'Nathan Aké': 'アケ', 'Nathan Ake': 'アケ',
  'Rayan Aït-Nouri': 'アイト＝ヌーリ', 'Rayan Ait-Nouri': 'アイト＝ヌーリ',
  'Kyle Walker': 'ウォーカー', 'Rodri': 'ロドリ',
  'Mateo Kovačić': 'コヴァチッチ', 'Mateo Kovacic': 'コヴァチッチ',
  'Matheus Nunes': 'M.ヌネス', 'Tijani Reijnders': 'レイナース', 'Bernardo Silva': 'B.シウバ',
  'Phil Foden': 'フォーデン', 'Kevin De Bruyne': 'デ・ブライネ', 'Jack Grealish': 'グリーリッシュ',
  'Rayan Cherki': 'シェルキ', 'Savinho': 'サビーニョ',
  'Jérémy Doku': 'ドク', 'Jeremy Doku': 'ドク',
  'Erling Haaland': 'ハーランド', 'Omar Marmoush': 'マルムーシュ',
  'Nico González': 'N.ゴンサレス', 'Nico Gonzalez': 'N.ゴンサレス',
  'Ilkay Gündoğan': 'ギュンドアン', 'Ilkay Gundogan': 'ギュンドアン',
  // === Southampton ===
  'Aaron Ramsdale': 'ラムズデール', 'Gavin Bazunu': 'バズヌ', 'Alex McCarthy': 'マッカーシー',
  'Kyle Walker-Peters': 'ウォーカー＝ピータース', 'Jan Bednarek': 'ベドナレク',
  'Taylor Harwood-Bellis': 'ハーウッド＝ベリス',
  'Welington': 'ウェリントン', 'Wellington': 'ウェリントン',
  'James Bree': 'ブリー', 'Nathan Wood': 'ウッド', 'Mateus Fernandes': 'M.フェルナンデス',
  'Flynn Downes': 'ダウンズ', 'Adam Lallana': 'ララーナ', 'Joe Aribo': 'アリボ',
  'Caspar Jander': 'ヤンダー', 'Will Smallbone': 'スモールボーン', 'Cameron Archer': 'アーチャー',
  'Ross Stewart': 'R.スチュワート', 'Finn Azaz': 'アザズ', 'Tom Fellows': 'フェロウズ',
  'Taylor Richards': 'T.リチャーズ', 'Joe Lumley': 'ラムリー',
  // === スーパースター（汎用） ===
  'Lionel Messi': 'メッシ', 'Cristiano Ronaldo': 'C.ロナウド',
  'Kylian Mbappé': 'エムバペ', 'Kylian Mbappe': 'エムバペ',
  'Jude Bellingham': 'ベリンガム',
  'Vinícius Júnior': 'ヴィニシウス', 'Vinicius Junior': 'ヴィニシウス',
  'Rodrygo': 'ロドリゴ', 'Robert Lewandowski': 'レヴァンドフスキ',
  'Lamine Yamal': 'ヤマル', 'Pedri': 'ペドリ', 'Gavi': 'ガビ', 'Frenkie de Jong': 'デ・ヨング',
  'Harry Kane': 'ケイン', 'Mohamed Salah': 'サラー', 'Bukayo Saka': 'サカ',
  'Martin Ødegaard': 'ウーデゴール', 'Martin Odegaard': 'ウーデゴール',
  'Kai Havertz': 'ハフェルツ', 'Declan Rice': 'ライス', 'Bruno Fernandes': 'B.フェルナンデス',
  'Marcus Rashford': 'ラッシュフォード', 'Cole Palmer': 'パーマー', 'Florian Wirtz': 'ヴィルツ',
  'Kingsley Coman': 'コマン', 'Joshua Kimmich': 'キミッヒ', 'Manuel Neuer': 'ノイアー',
  'Thibaut Courtois': 'クルトワ',
  'Marc-André ter Stegen': 'テア・シュテーゲン', 'Marc-Andre ter Stegen': 'テア・シュテーゲン',
};
function _player(raw) {
  if (!raw) return '';
  const t = String(raw).trim();
  if (PLAYER_NAMES[t]) return PLAYER_NAMES[t];
  // フォールバック: スペース区切りの最後の単語のみ
  const parts = t.split(/\s+/);
  return parts[parts.length - 1] || t;
}

// '2026-04-25' → '2026年4月25日'
function _fmtDate(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return d || '';
  return `${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

module.exports = {
  W, H, PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle, buildSubtitleBar,
  I18N, TEAM_ABBR, PLAYER_NAMES,
  _t, _abbr, _player, _fmtDate,
};
