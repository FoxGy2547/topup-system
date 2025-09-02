// /src/lib/gi-sync.ts
import { getPool } from '@/lib/db';

async function loadCheerio() {
  const cheerio = await import('cheerio');
  return cheerio;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) NinoSync/1.1 Chrome/120 Safari/537.36';

const FANDOM_LIST = 'https://genshin-impact.fandom.com/wiki/Character/List';
const FANDOM_COMP = 'https://genshin-impact.fandom.com/wiki/Character/Comparison';
const GGG_BASE = 'https://genshin.gg';
const GGG_BUILDS = `${GGG_BASE}/builds/`;

function esc(s: string) { return s.replace(/'/g, "''"); }
async function fetchHtml(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return await res.text();
}
function parseNum(txt: string) {
  const t = txt.replace(/[, ]/g, '').replace(/%/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}
function normKey(s: string) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/[’'`]/g, '').replace(/[()]/g, '').replace(/\s+/g, '');
}

// short_id: แยกด้วย “ช่องว่างเท่านั้น” (hyphen = คำเดียว)
function shortIdBySpaces(name: string) {
  const words = name.replace(/\s+/g, ' ').trim()
    .split(' ')
    .map(w => w.replace(/^[^A-Za-zก-๙]+|[^A-Za-zก-๙]+$/g, ''))
    .filter(Boolean);
  return words.map(w => (/^of$/i.test(w) ? 'o' : w[0].toUpperCase())).join('');
}

/* ========================= Fandom: Base Stats ========================= */

type BaseRow = {
  name: string; key: string; hp: number; atk: number; def: number;
  ascStat?: string; ascValue?: number;
};

function ascToCols(stat?: string, val?: number) {
  const z = { em:0, er:0, cr:0, cd:0, hydro:0, pyro:0, cryo:0, electro:0, anemo:0, geo:0, dendro:0, physical:0 };
  if (!stat || !val) return z;
  const s = stat.toLowerCase();
  if (s.includes('crit rate')) z.cr = val;
  else if (s.includes('crit dmg')) z.cd = val;
  else if (s.includes('energy recharge')) z.er = val;
  else if (s.includes('elemental mastery')) z.em = val;
  else if (s.includes('hydro dmg')) z.hydro = val;
  else if (s.includes('pyro dmg')) z.pyro = val;
  else if (s.includes('cryo dmg')) z.cryo = val;
  else if (s.includes('electro dmg')) z.electro = val;
  else if (s.includes('anemo dmg')) z.anemo = val;
  else if (s.includes('geo dmg')) z.geo = val;
  else if (s.includes('dendro dmg')) z.dendro = val;
  else if (s.includes('physical dmg')) z.physical = val;
  return z;
}

// ✅ เจาะ section “Playable Characters” ชัด ๆ แล้วอ่าน table ถัดมา
async function fandomPlayableNames(): Promise<string[]> {
  const html = await fetchHtml(FANDOM_LIST);
  const { load } = await loadCheerio();
  const $ = load(html);
  const names = new Set<string>();

  // หา heading ที่เขียนว่า "Playable Characters"
  const h = $('span.mw-headline, h2, h3').filter((_, el) =>
    /playable characters/i.test($(el).text())
  ).first();

  let table = h.length ? h.closest('h2,h3').nextAll('table').first() : $('table.article-table').first();
  if (!table.length) table = $('table').first();

  table.find('tbody tr').each((_, tr) => {
    const link = $(tr).find('a[href*="/wiki/"]').first();
    const name = (link.text() || '').trim();
    if (!name) return;
    if (!/^[A-Za-z]/.test(name)) return;
    names.add(name);
  });

  return Array.from(names);
}

// ✅ เล็งตารางที่มีหัว “Base Stats (Lv. 90)” + คอลัมน์ Asc Stat/Value
async function fandomComparisonRows(): Promise<BaseRow[]> {
  const html = await fetchHtml(FANDOM_COMP);
  const { load } = await loadCheerio();
  const $ = load(html);

  const out: BaseRow[] = [];

  $('table').each((_, tbl) => {
    const $tbl = $(tbl);
    const caption = $tbl.prev('h2,h3').text().toLowerCase();
    const looksRight = /base stats|lv\.?\s*90/i.test(caption);
    const headers = $tbl.find('th').map((__, th) => $(th).text().trim().toLowerCase()).get();

    const idxName = headers.findIndex(h => /name|character/.test(h));
    const idxHP   = headers.findIndex(h => /^hp\b/.test(h));
    const idxATK  = headers.findIndex(h => /^atk\b/.test(h));
    const idxDEF  = headers.findIndex(h => /^def\b/.test(h));
    const idxAS   = headers.findIndex(h => /ascension stat/.test(h));
    const idxAV   = headers.findIndex(h => /ascension value/.test(h));

    if (!looksRight && [idxAS, idxAV].some(i => i === -1)) return;
    if ([idxName, idxHP, idxATK, idxDEF].some(i => i === -1)) return;

    $tbl.find('tbody tr').each((__, tr) => {
      const cols = $(tr).find('td,th').map((___, td) => $(td).text().trim()).get();
      const name = (cols[idxName] || '').replace(/\s+/g, ' ').trim();
      if (!name) return;
      const hp = parseNum(cols[idxHP] || '0');
      const atk = parseNum(cols[idxATK] || '0');
      const def = parseNum(cols[idxDEF] || '0');
      if (hp <= 0 || atk <= 0 || def <= 0) return;
      const ascStat = idxAS >= 0 ? (cols[idxAS] || '').trim() || undefined : undefined;
      const ascValue = idxAV >= 0 ? (parseNum(cols[idxAV] || '0') || undefined) : undefined;

      out.push({ name, key: normKey(name), hp, atk, def, ascStat, ascValue });
    });
  });

  const map = new Map<string, BaseRow>();
  out.forEach(r => map.set(r.key, r));
  return Array.from(map.values());
}

function matchListToComparison(listNames: string[], comp: BaseRow[]) {
  const compMap = new Map(comp.map(r => [r.key, r]));
  const matched = new Map<string, BaseRow>();
  for (const name of listNames) {
    const key = normKey(name);
    const row = compMap.get(key) ?? comp.find(r => r.key === normKey(name.replace(/\(.*?\)/g, '').trim()));
    if (row) matched.set(row.key, row);
  }
  return Array.from(matched.values());
}

async function upsertBaseStats(rows: BaseRow[]) {
  const pool = getPool();
  for (const r of rows) {
    const asc = ascToCols(r.ascStat, r.ascValue);
    const emBase = asc.em || 0;
    const sql = `
INSERT INTO gi_base_stats
  (character_key, character_name, lvl, ascension,
   hp_base, atk_base, def_base, em_base, er_pct, cr_pct, cd_pct,
   hydro_dmg_pct, pyro_dmg_pct, cryo_dmg_pct, electro_dmg_pct, anemo_dmg_pct, geo_dmg_pct, dendro_dmg_pct, physical_dmg_pct)
VALUES
  ('${esc(r.name)}', '${esc(r.name)}', 90, 6,
   ${r.hp}, ${r.atk}, ${r.def}, ${emBase}, ${asc.er}, ${asc.cr}, ${asc.cd},
   ${asc.hydro}, ${asc.pyro}, ${asc.cryo}, ${asc.electro}, ${asc.anemo}, ${asc.geo}, ${asc.dendro}, ${asc.physical})
ON DUPLICATE KEY UPDATE
  hp_base=VALUES(hp_base), atk_base=VALUES(atk_base), def_base=VALUES(def_base), em_base=VALUES(em_base),
  er_pct=VALUES(er_pct), cr_pct=VALUES(cr_pct), cd_pct=VALUES(cd_pct),
  hydro_dmg_pct=VALUES(hydro_dmg_pct), pyro_dmg_pct=VALUES(pyro_dmg_pct), cryo_dmg_pct=VALUES(cryo_dmg_pct),
  electro_dmg_pct=VALUES(electro_dmg_pct), anemo_dmg_pct=VALUES(anemo_dmg_pct), geo_dmg_pct=VALUES(geo_dmg_pct),
  dendro_dmg_pct=VALUES(dendro_dmg_pct), physical_dmg_pct=VALUES(physical_dmg_pct);`.trim();
    await pool.query(sql);
  }
}

/* ========================= genshin.gg: Best Artifacts ========================= */

async function gggCharacterLinks(): Promise<{ name: string; url: string }[]> {
  const { load } = await loadCheerio();
  const html = await fetchHtml(GGG_BUILDS);
  const $ = load(html);
  const out: { name: string; url: string }[] = [];
  $('a[href^="/characters/"][href$="/"]').each((_, el) => {
    const href = $(el).attr('href')!;
    const label = ($(el).text() || $(el).attr('title') || $(el).attr('aria-label') || '').trim();
    if (!label) return;
    out.push({ name: label, url: new URL(href, GGG_BASE).toString() });
  });
  const map = new Map(out.map(x => [x.url, x]));
  return Array.from(map.values());
}

async function gggBestArtifacts(url: string): Promise<string[]> {
  const { load } = await loadCheerio();
  const html = await fetchHtml(url);
  const $ = load(html);

  const picks: string[] = [];
  const header = $('h2,h3').filter((_, el) => /best artifacts/i.test($(el).text())).first();
  if (!header.length) return picks;
  let section = header.parent();
  if (!section.length) section = header.next();

  section.find('*').each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, ' ').trim();
    if (!/(2|4)\b/.test(txt)) return;
    const mTwo = txt.match(/(.+?)\s+2\s+(.+?)\s+2\b/i);
    const mFour = txt.match(/(.+?)\s+4\b/i);
    if (mTwo) {
      const a = mTwo[1].trim(); const b = mTwo[2].trim();
      if (a && b) picks.push(`${a} (2) + ${b} (2)`);
      return;
    }
    if (mFour) {
      const a = mFour[1].trim();
      if (a) picks.push(`${a} (4)`);
    }
  });

  return Array.from(new Set(picks)).slice(0, 8);
}

function buildSetShort(picks: string[]) {
  const shorts: string[] = [];
  for (const p of picks) {
    const two = p.match(/^(.+?)\s*\(2\)\s*\+\s*(.+?)\s*\(2\)$/i);
    const four = p.match(/^(.+?)\s*\(4\)$/i);
    if (two) {
      const s1 = shortIdBySpaces(two[1]);
      const s2 = shortIdBySpaces(two[2]);
      shorts.push(`${s1}+${s2}`); // ภายใน 2+2 ใช้ '+'
    } else if (four) {
      shorts.push(shortIdBySpaces(four[1]));
    }
  }
  return Array.from(new Set(shorts)).join('/');
}

async function upsertItemsFromPicks(picks: string[]) {
  const pool = getPool();
  const names = new Set<string>();
  for (const p of picks) {
    const two = p.match(/^(.+?)\s*\(2\)\s*\+\s*(.+?)\s*\(2\)$/i);
    const four = p.match(/^(.+?)\s*\(4\)$/i);
    if (two) { names.add(two[1].trim()); names.add(two[2].trim()); }
    else if (four) { names.add(four[1].trim()); }
  }
  for (const n of names) {
    const sid = shortIdBySpaces(n);
    const sql = `
INSERT INTO items_gi (name, short_id)
VALUES ('${esc(n)}', '${esc(sid)}')
ON DUPLICATE KEY UPDATE short_id=VALUES(short_id);`.trim();
    await pool.query(sql);
  }
}

async function upsertCharacterSet(name: string, setShort: string) {
  const pool = getPool();
  const sql = `
INSERT INTO character_sets (character_name, game, set_short)
VALUES ('${esc(name)}', 'gi', '${esc(setShort)}')
ON DUPLICATE KEY UPDATE set_short=VALUES(set_short);`.trim();
  await pool.query(sql);
}

/* ========================= Public API ========================= */

export async function syncGiBaseStats() {
  const list = await fandomPlayableNames();
  const comp = await fandomComparisonRows();
  const rows = matchListToComparison(list, comp);
  await upsertBaseStats(rows);
  return { updated: rows.length, sample: rows.slice(0, 5).map(r => r.name) };
}

export async function syncGiRecommendedSets() {
  const chars = await gggCharacterLinks();
  let updated = 0;
  const touched: string[] = [];
  for (const c of chars) {
    const picks = await gggBestArtifacts(c.url);
    if (!picks.length) continue;
    await upsertItemsFromPicks(picks);
    const setShort = buildSetShort(picks);
    await upsertCharacterSet(c.name, setShort);
    updated++;
    if (touched.length < 5) touched.push(`${c.name} → ${setShort}`);
  }
  return { updated, sample: touched };
}

export async function syncGiAll() {
  const a = await syncGiRecommendedSets();
  const b = await syncGiBaseStats();
  return { sets_updated: a.updated, base_updated: b.updated, sets_sample: a.sample, base_sample: b.sample };
}
