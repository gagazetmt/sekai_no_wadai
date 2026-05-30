// scripts/modules/fetchers/transfermarkt_player_value.js
// Transfermarkt の marktwertverlauf ページから選手の市場価値推移を取得
//   /marktwertverlauf/spieler/{id} → Script JSON (優先) → HTML table (フォールバック)
//
// 使い方:
//   const { fetchPlayerValueHistory } = require('./transfermarkt_player_value');
//   const r = await fetchPlayerValueHistory(342229, 'kylian-mbappe');
//   // r: { ok: true, valueHistory: [{season:'24/25', date:'2024-06', valueEur:180000000, valueFmt:'€180M', club:'Real Madrid'},...] }

'use strict';

const { curlGet } = require('./_curl_cffi_caller');
const TM_REFERER = 'https://www.transfermarkt.com/';

function _fmtMW(euros) {
  if (!euros) return null;
  if (euros >= 1_000_000) return `€${(euros / 1_000_000).toFixed(0)}M`;
  if (euros >= 1_000) return `€${(euros / 1_000).toFixed(0)}K`;
  return `€${euros}`;
}

// "€ 95,00 Mio." / "€5m" / "5000000" → number
function _parseEuroStr(s) {
  if (!s) return null;
  const str = String(s).replace(/\s/g, '').toLowerCase();
  const mio = str.match(/([\d.,]+)\s*(?:mio|m(?!k))/);
  if (mio) return Math.round(parseFloat(mio[1].replace(',', '.')) * 1_000_000);
  const tsd = str.match(/([\d.,]+)\s*(?:tsd|k)/);
  if (tsd) return Math.round(parseFloat(tsd[1].replace(',', '.')) * 1_000);
  const raw = str.match(/[\d]+/);
  const n = raw ? parseInt(raw[0], 10) : null;
  return (n && n > 999) ? n : null;
}

// timestamp(ms) → "YYYY-MM" 文字列
function _tsToYM(ts) {
  const ms = ts > 9_999_999_999 ? ts : ts * 1000;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// シーズン文字列推定: "2024-06" → "24/25"
function _ymToSeason(ym) {
  if (!ym) return null;
  const year = parseInt(ym.slice(0, 4), 10);
  const month = parseInt(ym.slice(5, 7) || '1', 10);
  // 7月以降は新シーズン開幕
  const seasonStart = month >= 7 ? year : year - 1;
  const yy = String(seasonStart).slice(-2);
  const yy2 = String(seasonStart + 1).slice(-2);
  return `${yy}/${yy2}`;
}

// ① Script タグ内 JSON を探す（Highcharts / TM独自形式）
function _parseScriptData(html) {
  const entries = [];

  // パターン A: datum_mw / mw / verein  (TM 独自フォーマット)
  // {"datum_mw":"2023-06-15","mw":90000000,"verein_id":11,"verein":"Arsenal",...}
  const datumRegex = /\{[^{}]*"datum_mw"\s*:\s*"([\d\-]+)"[^{}]*"mw"\s*:\s*(\d+)[^{}]*\}/g;
  let m;
  while ((m = datumRegex.exec(html)) !== null) {
    try {
      const partial = m[0];
      const dateStr = m[1];   // "2023-06-15"
      const valueEur = parseInt(m[2], 10);
      const clubM = partial.match(/"(?:verein|club|clubName)"\s*:\s*"([^"]+)"/);
      const club = clubM ? clubM[1] : null;
      entries.push({ date: dateStr.slice(0, 7), valueEur, valueFmt: _fmtMW(valueEur), club });
    } catch (_) {}
  }
  if (entries.length >= 3) return entries;

  // パターン B: Highcharts series data [[timestamp_ms, value], ...]
  // series:[{data:[[1389830400000,5000000],[...],...]}]
  const seriesMatch = html.match(/series\s*:\s*\[\s*\{[\s\S]{0,200}?data\s*:\s*\[([\s\S]{10,8000}?)\]/);
  if (seriesMatch) {
    const raw = seriesMatch[1];
    const pairRe = /\[\s*(\d{10,13})\s*,\s*(\d{4,12})\s*\]/g;
    let pm;
    while ((pm = pairRe.exec(raw)) !== null) {
      const ts = parseInt(pm[1], 10);
      const valueEur = parseInt(pm[2], 10);
      if (valueEur > 0) {
        entries.push({ date: _tsToYM(ts), valueEur, valueFmt: _fmtMW(valueEur), club: null });
      }
    }
    if (entries.length >= 3) return entries;
  }

  return entries;
}

// ② HTML テーブル行をパース（フォールバック）
function _parseTableData(html) {
  const entries = [];

  // <table class="items"> を探す
  const tableRe = /<table[^>]*class="[^"]*(?:items|mwhistory)[^"]*"[^>]*>([\s\S]*?)<\/table>/i;
  const tm = tableRe.exec(html);
  if (!tm) return entries;

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(tm[1])) !== null) {
    const row = rm[1];
    if (/<th/i.test(row)) continue;

    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const tds = [];
    let tm2;
    while ((tm2 = tdRe.exec(row)) !== null) {
      tds.push(tm2[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&euro;/gi, '€').replace(/\s+/g, ' ').trim());
    }
    if (tds.length < 2) continue;

    // 日付セル: "Nov 13, 2023" / "Jun 2014" / "2023-06-15"
    const dateCell = tds[0];
    let dateStr = null;
    const fullDate = dateCell.match(/(\d{4})[\/\-](\d{2})/);
    if (fullDate) {
      dateStr = `${fullDate[1]}-${fullDate[2]}`;
    } else {
      const monthYear = dateCell.match(/([A-Za-z]+)\s+(\d{4})/);
      if (monthYear) {
        const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06', jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
        const mm = months[monthYear[1].toLowerCase().slice(0, 3)] || '01';
        dateStr = `${monthYear[2]}-${mm}`;
      }
    }
    if (!dateStr) continue;

    // 市場価値セル
    const valueRaw = tds.find(t => /mio|tsd|\d+m\b|€|eur/i.test(t));
    if (!valueRaw) continue;
    const valueEur = _parseEuroStr(valueRaw);
    if (!valueEur) continue;

    // クラブ（次のセル）
    const vIdx = tds.indexOf(valueRaw);
    const club = (vIdx >= 0 && tds[vIdx + 1]) ? tds[vIdx + 1].slice(0, 60) : null;

    entries.push({ date: dateStr, valueEur, valueFmt: _fmtMW(valueEur), club });
  }
  return entries;
}

async function fetchPlayerValueHistory(playerId, slug) {
  if (!playerId) return { ok: false, error: 'playerId required' };
  const slugStr = slug || 'player';
  const url = `https://www.transfermarkt.com/${slugStr}/marktwertverlauf/spieler/${playerId}`;

  try {
    const res = await curlGet(url, {
      referer: TM_REFERER,
      headers: { Accept: 'text/html' },
      timeout: 30,
    });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status || 'err'}` };

    const html = res.body;

    let entries = _parseScriptData(html);
    if (!entries.length) entries = _parseTableData(html);

    if (!entries.length) {
      return { ok: false, error: 'market value data not found', size: html.length };
    }

    // 新しい順ソート
    entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    // 年単位で最大値を1エントリに集約（同一年複数ポイント → ピーク値）
    const byYear = {};
    for (const e of entries) {
      const year = String(e.date || '').slice(0, 4);
      if (!year || year < '2010') continue;
      if (!byYear[year] || e.valueEur > (byYear[year].valueEur || 0)) {
        byYear[year] = e;
      }
    }

    const valueHistory = Object.values(byYear)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 12)
      .map(e => ({
        ...e,
        season: _ymToSeason(e.date),
      }));

    return { ok: true, valueHistory, rawCount: entries.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchPlayerValueHistory };
