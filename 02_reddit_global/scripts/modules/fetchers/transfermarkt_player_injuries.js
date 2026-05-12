// scripts/modules/fetchers/transfermarkt_player_injuries.js
// Transfermarkt の /verletzungen/spieler/{id} ページから怪我履歴を取得する
//
// 使い方:
//   const { fetchPlayerInjuries } = require('./transfermarkt_player_injuries');
//   const r = await fetchPlayerInjuries(playerId, slug);
//
// 仕組み:
//   1. /{slug}/verletzungen/spieler/{id} を Puppeteer で開く
//   2. table.items の tbody から各行を抽出
//      列: Season / Injury / from / until / Days / Games missed
//   3. 日付を dd/MM/yyyy → YYYY-MM-DD に変換、isOngoing フラグ付与
//
// データ特性:
//   - 過去の怪我履歴は完全に DB 保管されている
//   - 進行中の怪我も登録され、untilDate に「予測復帰日」が入る (Slot 等の監督発言反映)
//   - 反映ラグは数日〜1週間程度。直近すぎる怪我はまだ未登録の可能性あり

// 2026-05-12: Puppeteer → curl-cffi 移行
const { curlGet } = require('./_curl_cffi_caller');
const TM_REFERER = 'https://www.transfermarkt.com/';

// "11/02/2026" → "2026-02-11" (Europe → ISO)
function _toIsoDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// "110 days" → 110
function _parseDays(s) {
  const m = String(s || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// HTML table.items の各 <tr> の <td> テキスト配列を抽出
function _extractInjuryRows(html) {
  // table.items の最初の塊を探す → tbody → 各 tr の td
  const tableMatch = html.match(/<table[^>]*class="[^"]*items[^"]*"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableMatch) return [];
  const tbodyMatch = tableMatch[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  const tbodyHtml = tbodyMatch ? tbodyMatch[1] : tableMatch[1];
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRe.exec(tbodyHtml))) {
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let tdMatch;
    while ((tdMatch = tdRe.exec(trMatch[1]))) {
      const text = tdMatch[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// 怪我履歴を取得
//   返却: { ok, playerId, injuries: [{ season, injury, fromDate, untilDate, days, missedGames, isOngoing, isFuture }, ...] }
//     - isOngoing: untilDate が今日以降 (進行中 or 予測復帰日が未来)
//     - isFuture:  fromDate が今日より未来 (理論上ほぼ無いが念のため)
async function fetchPlayerInjuries(playerId, slug = 'spieler') {
  if (!playerId) return { ok: false, error: 'playerId required' };
  try {
    const url = `https://www.transfermarkt.com/${slug}/verletzungen/spieler/${playerId}`;
    const res = await curlGet(url, { referer: TM_REFERER, headers: { Accept: 'text/html' } });
    if (!res.ok) return { ok: false, error: 'http ' + res.status };

    const rows = _extractInjuryRows(res.body);

    const today = new Date().toISOString().slice(0, 10);
    const injuries = rows.map(cells => {
      if (!Array.isArray(cells) || cells.length < 5) return null;
      const fromDate  = _toIsoDate(cells[2]);
      const untilDate = _toIsoDate(cells[3]);
      return {
        season:      cells[0] || null,
        injury:      cells[1] || null,
        fromDate,
        untilDate,
        days:        _parseDays(cells[4]),
        missedGames: parseInt(cells[5], 10) || null,
        isOngoing:   !!(untilDate && untilDate >= today),
        isFuture:    !!(fromDate && fromDate > today),
      };
    }).filter(Boolean);

    return { ok: true, playerId: String(playerId), injuries };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchPlayerInjuries };
