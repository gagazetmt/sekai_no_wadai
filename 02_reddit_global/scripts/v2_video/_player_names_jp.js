// scripts/v2_video/_player_names_jp.js
// 選手名 (英語) → カタカナ 変換辞書 + ヘルパー
//
// 方針:
//   1. 完全一致辞書ヒットを最優先
//   2. 苗字のみマッチもサポート（"Bukayo Saka" → "Saka" でヒット）
//   3. 未収録は原文 (英語) を返す
//
// 拡張方針:
//   - 主要リーグの先発級選手を中心に随時追加
//   - SofaScore lineup の name フィールドに合わせる
//   - 表記揺れ ("Mohamed Salah" / "Mohammed Salah") は両方登録
//
// 将来案: ja.wikipedia ルックアップを fetcher に組み込んで自動収集

const FULL_NAME = {
  // ── Premier League — Arsenal ──
  'Bukayo Saka':            'ブカヨ・サカ',
  'Martin Ødegaard':        'マルティン・ウーデゴール',
  'Martin Odegaard':        'マルティン・ウーデゴール',
  'Declan Rice':            'デクラン・ライス',
  'Gabriel Martinelli':     'ガブリエル・マルティネッリ',
  'Gabriel Jesus':          'ガブリエル・ジェズス',
  'Gabriel Magalhães':      'ガブリエウ・マガリャンイス',
  'Gabriel Magalhaes':      'ガブリエウ・マガリャンイス',
  'William Saliba':         'ウィリアム・サリバ',
  'Ben White':              'ベン・ホワイト',
  'Kai Havertz':            'カイ・ハフェルツ',
  'David Raya':             'ダビド・ラヤ',
  'Bukayo':                 'ブカヨ',
  'Saka':                   'サカ',
  'Rice':                   'ライス',
  'Saliba':                 'サリバ',
  'Ødegaard':               'ウーデゴール',
  'Odegaard':               'ウーデゴール',
  'Havertz':                'ハフェルツ',
  'Martinelli':             'マルティネッリ',
  'Eze':                    'エゼ',
  'Eberechi Eze':           'エベレチ・エゼ',

  // ── Manchester City ──
  'Erling Haaland':         'アーリング・ハーランド',
  'Erling Braut Haaland':   'アーリング・ハーランド',
  'Haaland':                'ハーランド',
  'Phil Foden':             'フィル・フォーデン',
  'Foden':                  'フォーデン',
  'Kevin De Bruyne':        'ケビン・デ・ブライネ',
  'De Bruyne':              'デ・ブライネ',
  'Bernardo Silva':         'ベルナルド・シウバ',
  'Rodri':                  'ロドリ',
  'Rodrigo Hernández':      'ロドリ',
  'Rúben Dias':             'ルベン・ディアス',
  'Ruben Dias':             'ルベン・ディアス',
  'Dias':                   'ディアス',
  'Joško Gvardiol':         'ヨシュコ・グヴァルディオル',
  'Josko Gvardiol':         'ヨシュコ・グヴァルディオル',
  'Gvardiol':               'グヴァルディオル',
  'Ederson':                'エデルソン',
  'Stefan Ortega':          'シュテファン・オルテガ',
  'Jérémy Doku':            'ジェレミー・ドク',
  'Jeremy Doku':            'ジェレミー・ドク',
  'Doku':                   'ドク',
  'Mateo Kovačić':          'マテオ・コヴァチッチ',
  'Kovacic':                'コヴァチッチ',

  // ── Liverpool ──
  'Mohamed Salah':          'モハメド・サラー',
  'Mohammed Salah':         'モハメド・サラー',
  'Salah':                  'サラー',
  'Virgil van Dijk':        'フィルジル・ファン・ダイク',
  'van Dijk':               'ファン・ダイク',
  'Trent Alexander-Arnold': 'トレント・アレクサンダー＝アーノルド',
  'Alexander-Arnold':       'アレクサンダー＝アーノルド',
  'Andrew Robertson':       'アンドリュー・ロバートソン',
  'Robertson':              'ロバートソン',
  'Alisson':                'アリソン',
  'Alisson Becker':         'アリソン・ベッカー',
  'Cody Gakpo':             'コーディ・ハクポ',
  'Gakpo':                  'ハクポ',
  'Luis Díaz':              'ルイス・ディアス',
  'Luis Diaz':              'ルイス・ディアス',
  'Darwin Núñez':           'ダルウィン・ヌニェス',
  'Darwin Nunez':           'ダルウィン・ヌニェス',
  'Núñez':                  'ヌニェス',
  'Nunez':                  'ヌニェス',
  'Dominik Szoboszlai':     'ドミニク・ソボスライ',
  'Szoboszlai':             'ソボスライ',
  'Alexis Mac Allister':    'アレクシス・マック・アリスター',
  'Mac Allister':           'マック・アリスター',
  'Curtis Jones':           'カーティス・ジョーンズ',
  'Ryan Gravenberch':       'ライアン・フラーフェンベルフ',
  'Gravenberch':            'フラーフェンベルフ',

  // ── Chelsea ──
  'Cole Palmer':            'コール・パーマー',
  'Palmer':                 'パーマー',
  'Enzo Fernández':         'エンソ・フェルナンデス',
  'Enzo Fernandez':         'エンソ・フェルナンデス',
  'Moisés Caicedo':         'モイセス・カイセド',
  'Moises Caicedo':         'モイセス・カイセド',
  'Caicedo':                'カイセド',
  'Reece James':            'リース・ジェイムズ',
  'Levi Colwill':           'レヴィ・コルウィル',
  'Nicolas Jackson':        'ニコラ・ジャクソン',
  'Robert Sánchez':         'ロベルト・サンチェス',
  'Robert Sanchez':         'ロベルト・サンチェス',
  'Conor Gallagher':        'コナー・ギャラガー',
  'Christopher Nkunku':     'クリストフェル・ンクンク',
  'Nkunku':                 'ンクンク',
  'Mykhailo Mudryk':        'ミハイロ・ムドリク',
  'Mudryk':                 'ムドリク',
  'Pedro Neto':             'ペドロ・ネト',

  // ── Manchester United ──
  'Bruno Fernandes':        'ブルーノ・フェルナンデス',
  'Marcus Rashford':        'マーカス・ラッシュフォード',
  'Rashford':               'ラッシュフォード',
  'Casemiro':               'カゼミーロ',
  'Lisandro Martínez':      'リサンドロ・マルティネス',
  'Lisandro Martinez':      'リサンドロ・マルティネス',
  'Raphaël Varane':         'ラファエル・ヴァラン',
  'Raphael Varane':         'ラファエル・ヴァラン',
  'Varane':                 'ヴァラン',
  'André Onana':            'アンドレ・オナナ',
  'Andre Onana':            'アンドレ・オナナ',
  'Onana':                  'オナナ',
  'Rasmus Højlund':         'ラスムス・ホイルンド',
  'Rasmus Hojlund':         'ラスムス・ホイルンド',
  'Højlund':                'ホイルンド',
  'Hojlund':                'ホイルンド',
  'Kobbie Mainoo':          'コビー・メイヌー',
  'Mainoo':                 'メイヌー',
  'Alejandro Garnacho':     'アレハンドロ・ガルナチョ',
  'Garnacho':               'ガルナチョ',

  // ── Tottenham ──
  'Son Heung-Min':          'ソン・フンミン',
  'Son Heung-min':          'ソン・フンミン',
  'Heung-Min Son':          'ソン・フンミン',
  'Son':                    'ソン',
  'Harry Kane':             'ハリー・ケイン',
  'Kane':                   'ケイン',
  'James Maddison':         'ジェームズ・マディソン',
  'Maddison':               'マディソン',
  'Cristian Romero':        'クリスティアン・ロメロ',
  'Romero':                 'ロメロ',
  'Micky van de Ven':       'ミッキー・ファン・デ・フェン',
  'Pedro Porro':            'ペドロ・ポロ',
  'Dejan Kulusevski':       'デヤン・クルゼフスキ',
  'Kulusevski':             'クルゼフスキ',
  'Yves Bissouma':          'イブ・ビスマ',
  'Bissouma':               'ビスマ',

  // ── 海外日本代表組（jp_dict と被るが念のため） ──
  '三笘 薫':                'ミトマ カオル',
  '三笘薫':                  'ミトマ カオル',
  'Kaoru Mitoma':           'ミトマ カオル',
  'Mitoma':                 'ミトマ',
  '久保 建英':              'クボ タケフサ',
  'Takefusa Kubo':          'クボ タケフサ',
  'Kubo':                   'クボ',
  'Wataru Endo':            'エンドウ ワタル',
  'Endo':                   'エンドウ',
  'Tomiyasu':               'トミヤス',
  'Takehiro Tomiyasu':      'トミヤス タケヒロ',

  // ── La Liga 主要 ──
  'Vinícius Júnior':        'ヴィニシウス・ジュニオール',
  'Vinicius Junior':        'ヴィニシウス・ジュニオール',
  'Vinicius Jr.':           'ヴィニシウス・ジュニオール',
  'Vinicius':               'ヴィニシウス',
  'Vinícius Jr':            'ヴィニシウス',
  'Jude Bellingham':        'ジュード・ベリンガム',
  'Bellingham':             'ベリンガム',
  'Kylian Mbappé':          'キリアン・ムバッペ',
  'Kylian Mbappe':          'キリアン・ムバッペ',
  'Mbappé':                 'ムバッペ',
  'Mbappe':                 'ムバッペ',
  'Rodrygo':                'ロドリゴ',
  'Federico Valverde':      'フェデリコ・バルベルデ',
  'Valverde':               'バルベルデ',
  'Eduardo Camavinga':      'エドゥアルド・カマヴィンガ',
  'Camavinga':              'カマヴィンガ',
  'Aurélien Tchouaméni':    'オーレリアン・チュアメニ',
  'Aurelien Tchouameni':    'オーレリアン・チュアメニ',
  'Tchouaméni':             'チュアメニ',
  'Tchouameni':             'チュアメニ',
  'Thibaut Courtois':       'ティボー・クルトワ',
  'Courtois':               'クルトワ',
  'Antonio Rüdiger':        'アントニオ・リュディガー',
  'Antonio Rudiger':        'アントニオ・リュディガー',
  'Rüdiger':                'リュディガー',
  'Rudiger':                'リュディガー',
  'Eder Militão':           'エデル・ミリトン',
  'Eder Militao':           'エデル・ミリトン',
  'Militão':                'ミリトン',
  'Militao':                'ミリトン',
  'Robert Lewandowski':     'ロベルト・レヴァンドフスキ',
  'Lewandowski':            'レヴァンドフスキ',
  'Pedri':                  'ペドリ',
  'Gavi':                   'ガビ',
  'Lamine Yamal':           'ラミン・ヤマル',
  'Yamal':                  'ヤマル',
  'Ronald Araújo':          'ロナルド・アラウホ',
  'Ronald Araujo':          'ロナルド・アラウホ',
  'Araújo':                 'アラウホ',
  'Araujo':                 'アラウホ',
  'Ferran Torres':          'フェラン・トーレス',
  'Frenkie de Jong':        'フレンキー・デ・ヨング',
  'de Jong':                'デ・ヨング',
  'Marc-André ter Stegen':  'マルク＝アンドレ・テア・シュテーゲン',
  'ter Stegen':             'テア・シュテーゲン',

  // ── Atletico Madrid ──
  'Antoine Griezmann':      'アントワーヌ・グリーズマン',
  'Griezmann':              'グリーズマン',
  'Julián Álvarez':         'フリアン・アルバレス',
  'Julian Alvarez':         'フリアン・アルバレス',
  'Álvarez':                'アルバレス',
  'Alvarez':                'アルバレス',
  'Koke':                   'コケ',
  'Marcos Llorente':        'マルコス・ジョレンテ',
  'Llorente':               'ジョレンテ',
  'Jan Oblak':              'ヤン・オブラク',
  'Oblak':                  'オブラク',
  'José María Giménez':     'ホセ・ヒメネス',
  'Jose Maria Gimenez':     'ホセ・ヒメネス',
  'Giménez':                'ヒメネス',
  'Gimenez':                'ヒメネス',

  // ── 監督 ──
  'Pep Guardiola':          'ペップ・グアルディオラ',
  'Diego Simeone':          'ディエゴ・シメオネ',
  'Mikel Arteta':           'ミケル・アルテタ',
  'Carlo Ancelotti':        'カルロ・アンチェロッティ',
  'Ancelotti':              'アンチェロッティ',
  'Jürgen Klopp':           'ユルゲン・クロップ',
  'Klopp':                  'クロップ',
  'Hansi Flick':            'ハンジ・フリック',
  'Flick':                  'フリック',
  'Xavi Hernández':         'シャビ・エルナンデス',
  'Xavi':                   'シャビ',
  'José Mourinho':          'ジョゼ・モウリーニョ',
  'Mourinho':               'モウリーニョ',
  'Enzo Maresca':           'エンソ・マレスカ',
  'Maresca':                'マレスカ',
};

// 苗字 (full name の最後の単語) でもう一度引く保険
function _lastNameFallback(name) {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  return FULL_NAME[last] || null;
}

function toKatakana(name) {
  if (!name) return name;
  const s = String(name).trim();
  // 1. フル一致
  if (FULL_NAME[s]) return FULL_NAME[s];
  // 2. 苗字フォールバック ("Bukayo Saka" → "Saka")
  const last = _lastNameFallback(s);
  if (last) return last;
  // 3. 既に日本語が含まれてれば原文（漢字 or カタカナ）
  if (/[぀-ヿ一-鿿]/.test(s)) return s;
  // 4. 未収録 → 原文 (英語) を返す（運用しながら辞書を広げる）
  return s;
}

module.exports = { FULL_NAME, toKatakana };
