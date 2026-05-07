// scripts/modules/fetchers/wiki_managerial_stats.js
// Wikipedia 英語版から監督の "Managerial record by team and tenure" テーブルを抽出
//   Transfermarkt fetcher と組み合わせて、過去シーズンの W/D/L 内訳を補完する用途
//
// 使い方:
//   const { fetchWikipediaManagerialStats } = require('./wiki_managerial_stats');
//   const stats = await fetchWikipediaManagerialStats('Mikel Arteta');
//   // stats: {
//   //   ok: true, source: 'wikipedia', pageTitle: 'Mikel Arteta',
//   //   rows: [
//   //     { team: 'Arsenal', from: '2019-12-22', to: 'Present',
//   //       p: 349, w: 210, d: 66, l: 73, winPct: 60.2 },
//   //   ],
//   //   total: { p: 349, w: 210, d: 66, l: 73, winPct: 60.2 },
//   // }
//
// パース対象:
//   - {| class="wikitable" .. |+ Managerial record by team and tenure ... |}
//   - 各行で {{Win draw lose|p|w|d|l}} / {{WDL|p|w|d|l}} テンプレートから戦績抽出
//   - Arteta / Simeone は本ページ直下、Pep のように長い記事は Career statistics サブセクション
//   - どちらも caption が共通なので caption アンカーで統一抽出

const axios = require('axios');

const UA = 'SoccerYTBot/2.0 (soccer-yt-project)';
const API = 'https://en.wikipedia.org/w/api.php';

async function _fetchWikitext(pageTitle) {
  try {
    const res = await axios.get(API, {
      params: {
        action: 'parse',
        format: 'json',
        page: pageTitle,
        prop: 'wikitext',
        formatversion: 2,
        redirects: 1,
      },
      headers: { 'User-Agent': UA },
      timeout: 30000,
      validateStatus: () => true,
    });
    if (res.status !== 200) return null;
    return res.data?.parse?.wikitext || null;
  } catch (_) {
    return null;
  }
}

// 「June 21, 2007」「21 June 2007」「2008-07-01」「Present」など多様な日付表現を ISO に
//   失敗時は元文字列を返す（"Present" などをそのまま保持）
const _MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
function _normalizeDate(s) {
  if (!s) return null;
  let t = String(s).replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1');
  t = t.replace(/<ref[\s\S]*?<\/ref>/gi, '').replace(/{{efn[\s\S]*?}}/gi, '').replace(/[''']/g, '').trim();

  if (/^present$/i.test(t)) return 'Present';
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // "21 June 2007" / "21 June, 2007"
  let m = t.match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (m) {
    const mo = _MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  // "June 21, 2007"
  m = t.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mo = _MONTHS[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return t || null;
}

// Wikipedia リンク表記を表示文字列に: "[[Arsenal F.C.|Arsenal]]" → "Arsenal"
//   セル内の "align=left|" や "align=\"center\"|" のようなインライン属性も先に剥がす
function _stripWikiLinks(s) {
  if (!s) return '';
  return String(s)
    // セルのインライン属性 (align=left| / align="left"| / style="..."| など) を除去
    .replace(/^\s*[a-z]+\s*=\s*"?[^"\|]*"?\s*\|\s*/gi, '')
    .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/{{[a-z]+\|[\s\S]*?}}/gi, '')
    .replace(/[''']/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// {{WDL|p|w|d|l}} / {{Win draw lose|p|w|d|l|decimals=1}} / {{WDLtot|p|w|d|l}} などから数値抽出
//   isTotal=true なら "totals" 系テンプレ ({{WDLtot}} や {{Win draw lose totals}}) でヒットしたことを示す
function _parseWDLTemplate(text) {
  if (!text) return null;
  const m = text.match(/{{(Win\s*draw\s*lose\s*totals|WDLtot|Win\s*draw\s*lose|WDL)\b([^}]*?)\|(\d+)\|(\d+)\|(\d+)\|(\d+)/i);
  if (!m) return null;
  const tplName = m[1].toLowerCase().replace(/\s+/g, '');
  const isTotal = /totals?$/.test(tplName) || tplName === 'wdltot';
  const p = parseInt(m[3], 10), w = parseInt(m[4], 10), d = parseInt(m[5], 10), l = parseInt(m[6], 10);
  const winPct = p > 0 ? Math.round((w / p) * 1000) / 10 : null;
  return { p, w, d, l, winPct, isTotal };
}

// 該当 wikitable を caption で特定して切り出す（{| ... |} を返す）
function _extractManagerialTable(wikitext) {
  if (!wikitext) return null;
  // 全ての {| ... |} ブロックを探索（ネスト無視のため非貪欲ではなく行ベースで対応）
  const lines = wikitext.split('\n');
  let depth = 0, start = -1;
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^{\|/.test(ln)) {
      if (depth === 0) start = i;
      depth++;
    } else if (/^\|}/.test(ln)) {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(lines.slice(start, i + 1).join('\n'));
        start = -1;
      }
    }
  }
  // caption に "Managerial record by team and tenure" を含むものを優先
  const target = blocks.find(b => /\|\+\s*Managerial record by team and tenure/i.test(b));
  if (target) return target;
  // フォールバック: 列に "Win %" を含み P/W/D/L を持つ wikitable
  return blocks.find(b => /Win\s*%/i.test(b) && /Matches played|\bP\b/.test(b)) || null;
}

// テーブル本体から行を抽出
//   各行: |team |from |to {{WDL|p|w|d|l}} or {{Win draw lose|p|w|d|l|decimals=1}}
function _parseTableRows(table) {
  if (!table) return { rows: [], total: null };
  // テーブル行は "|-" で区切られる
  const rowChunks = table.split(/^\|-\s*$/m).map(s => s.trim()).filter(Boolean);
  const rows = [];
  let total = null;

  for (const chunk of rowChunks) {
    // 純粋なヘッダ行 (caption / 列見出し定義) はスキップ
    //   ただし Career total 行は "!colspan=3|Career total" で始まりつつ {{WDLtot}} を含むので
    //   ヘッダ判定は「! 行のみで、! 以降に WDL テンプレも | 行も無い」場合のみに限定する
    const hasWDL = /{{(?:Win\s*draw|WDL)/i.test(chunk);
    const hasDataLine = /^\|/m.test(chunk);
    const isPureHeader = /^[!|+\s]/.test(chunk) && !hasWDL && !hasDataLine;
    if (isPureHeader) continue;

    // 戦績テンプレートを抽出。totals 系 ({{WDLtot|}} 等) は team 行ではなく合計行
    const wdl = _parseWDLTemplate(chunk);
    if (wdl?.isTotal) {
      total = { p: wdl.p, w: wdl.w, d: wdl.d, l: wdl.l, winPct: wdl.winPct };
      continue;
    }

    // データ行は team / from / to の3セルあるはず（戦績は WDL テンプレで wdl に取得済み）
    if (!wdl) continue;
    const cellLines = chunk.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));

    // team, from, to を順番に取る
    const cellsCleaned = cellLines.map(l => l.replace(/^\|+/, '').replace(/^[a-z]+="[^"]*"\|/i, '').trim());
    // align="..." を含む場合 split で残るので個別 strip
    const stripped = cellsCleaned.map(c => _stripWikiLinks(c));
    if (stripped.length < 3) continue;
    const team = stripped[0];
    const from = _normalizeDate(stripped[1]);
    const to   = _normalizeDate(stripped[2]);
    if (!team || !from) continue;

    rows.push({
      team, from, to,
      p: wdl.p, w: wdl.w, d: wdl.d, l: wdl.l, winPct: wdl.winPct,
    });
  }

  return { rows, total };
}

// 監督名 → Wikipedia から Managerial statistics を取得
//   先に "{name}" 直 → 失敗時に redirected (action=parse の redirects=1 で自動)
//   返却: { ok, source, pageTitle, rows[], total } | { ok:false, error }
async function fetchWikipediaManagerialStats(name) {
  if (!name) return { ok: false, error: 'name required' };
  const tried = [];

  // 1st: 名前直
  const candidates = [name.replace(/\s+/g, '_'), `${name.replace(/\s+/g, '_')}_managerial_career`];
  for (const cand of candidates) {
    tried.push(cand);
    const wt = await _fetchWikitext(cand);
    if (!wt) continue;
    const table = _extractManagerialTable(wt);
    if (!table) continue;
    const parsed = _parseTableRows(table);
    if (!parsed.rows.length) continue;
    return {
      ok: true,
      source: 'wikipedia',
      pageTitle: cand.replace(/_/g, ' '),
      rows: parsed.rows,
      total: parsed.total,
    };
  }
  return { ok: false, error: 'no managerial stats table found', tried };
}

module.exports = {
  fetchWikipediaManagerialStats,
};
