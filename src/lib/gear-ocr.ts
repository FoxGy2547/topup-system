// /src/lib/gear-ocr.ts
import { ocrWithFallback } from "@/lib/tess";

/* =========================================================
 * Types
 * =======================================================*/
export type GameKey = "gi" | "hsr";

export type Stat = { name: string; value: string };
export const GI_SLOTS = ["Flower", "Plume", "Sands", "Goblet", "Circlet"] as const;
export const HSR_SLOTS = ["Head", "Hands", "Body", "Feet", "Planar Sphere", "Link Rope"] as const;
export type GiSlot = (typeof GI_SLOTS)[number];
export type HsrSlot = (typeof HSR_SLOTS)[number];

export type GearItem = {
  url?: string;
  piece: GiSlot | HsrSlot;
  setName: string | null;
  mainStat: Stat | null;
  substats: Stat[];
};

/* =========================================================
 * DB helper (ใช้ lib/db ถ้ามี; ไม่งั้นสร้าง pool เอง)
 * =======================================================*/
import type { RowDataPacket } from "mysql2/promise";
let dbPool: any = null;
try {
  // ถ้าโปรเจกต์มีไฟล์ lib/db.ts ที่ export default pool หรือชื่อ db/pool ก็เอามาใช้ได้เลย
  // @ts-ignore
  const maybe = require("@/lib/db");
  dbPool = maybe.default || maybe.db || maybe.pool || null;
} catch {}
if (!dbPool) {
  // fallback: สร้าง pool เอง (ฝั่ง server เท่านั้น)
  // ไม่อยากซ้ำซ้อน ก็ชี้ env ชุดเดียวกับ API ของเธอนั่นแหละ
  const mysql = require("mysql2/promise");
  dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: 10,
  });
}

type SetRow = { name: string; short_id: string; set_kind?: string };
const setCache: { gi: SetRow[] | null; hsr: SetRow[] | null } = { gi: null, hsr: null };

async function loadSetCatalog(game: GameKey): Promise<SetRow[]> {
  if (setCache[game]) return setCache[game]!;
  const table = game === "gi" ? "items_gi" : "items_hsr";
  const [rows] = (await dbPool.query(
    `SELECT name, short_id, set_kind FROM ${table}`
  )) as [RowDataPacket[], any];
  setCache[game] = rows.map((r: any) => ({
    name: String(r.name || ""),
    short_id: String(r.short_id || ""),
    set_kind: String(r.set_kind || ""),
  }));
  return setCache[game]!;
}

/* =========================================================
 * Normalize helpers
 * =======================================================*/
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const toArabic = (s: string) =>
  [...(s || "")]
    .map((c) => {
      const i = THAI_DIGITS.indexOf(c);
      return i >= 0 ? String(i) : c;
    })
    .join("");

const normalizePercentChars = (s: string) =>
  s.replace(/[％﹪]/g, "%").replace(/\s+%/g, "%");

const splitlines = (s: string) =>
  normalizePercentChars(toArabic(s))
    .replace(/\u200b/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/，/g, ",")
    .replace(/[•·●○・*]/g, "•")
    .split(/\r?\n/)
    .map((x) => x.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean);

const clean = (s: string) =>
  normalizePercentChars(toArabic(s))
    .toLowerCase()
    .replace(/\u200b/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const compress = (s: string) => clean(s).replace(/[^a-z0-9ก-๙]/g, "");

/* =========================================================
 * Dictionaries / normalizers
 * =======================================================*/
const STAT_MAP: Record<string, string> = {
  // GI (TH -> EN)
  "พลังชีวิต": "HP",
  "พลังโจมตี": "ATK",
  "พลังป้องกัน": "DEF",
  "ความชำนาญธาตุ": "Elemental Mastery",
  "อัตราการฟื้นฟูพลังงาน": "Energy Recharge",
  "การฟื้นฟูพลังงาน": "Energy Recharge",
  "อัตราคริติคอล": "CRIT Rate",
  "อัตราคริ": "CRIT Rate",
  "คริติคอลเรต": "CRIT Rate",
  "โอกาสคริ": "CRIT Rate",
  "ความแรงคริติคอล": "CRIT DMG",
  "ความแรงคริ": "CRIT DMG",
  "ดาเมจคริ": "CRIT DMG",
  "คริติคอลดาเมจ": "CRIT DMG",
  "โบนัสการรักษา": "Healing Bonus",
  "โบนัสความเสียหายกายภาพ": "Physical DMG Bonus",
  "ความเสียหายกายภาพ": "Physical DMG Bonus",
  "โบนัสความเสียหายไฟ": "Pyro DMG Bonus",
  "โบนัสความเสียหายน้ำ": "Hydro DMG Bonus",
  "โบนัสความเสียหายไฟฟ้า": "Electro DMG Bonus",
  "โบนัสความเสียหายน้ำแข็ง": "Cryo DMG Bonus",
  "โบนัสความเสียหายลม": "Anemo DMG Bonus",
  "โบนัสความเสียหายหิน": "Geo DMG Bonus",
  "โบนัสความเสียหายหญ้า": "Dendro DMG Bonus",

  // HSR (TH -> EN)
  "อัตราติดเอฟเฟกต์": "Effect Hit Rate",
  "ต้านทานเอฟเฟกต์": "Effect RES",
  "ต้านทานสถานะ": "Effect RES",
  "ความเร็ว": "SPD",
  "ฟื้นพลังงาน": "Energy Regeneration Rate",
  "อัตราการฟื้นพลังงาน": "Energy Regeneration Rate",
  "เอฟเฟกต์ทำลายล้าง": "Break Effect",
  "เอฟเฟกต์ทำลาย": "Break Effect",
  "ผลการทำลาย": "Break Effect",
};

const PIECE_MAP_GI: Record<string, GiSlot> = {
  "flower of life": "Flower",
  "plume of death": "Plume",
  "sands of eon": "Sands",
  "goblet of eonothem": "Goblet",
  "circlet of logos": "Circlet",
  "ดอกไม้": "Flower",
  "ขนนก": "Plume",
  "ทราย": "Sands",
  "ถ้วย": "Goblet",
  "มงกุฎ": "Circlet",
};

// สำคัญมาก: ไม่มีอะไรส่งไป Body/Feet จากคำว่า sphere/rope
const PIECE_MAP_HSR: Record<string, HsrSlot> = {
  "planar\\s*sph?ere": "Planar Sphere",
  "sphere": "Planar Sphere",
  "orb": "Planar Sphere",
  "link\\s*rope": "Link Rope",
  "rope": "Link Rope",
  "belt": "Link Rope",
  "head": "Head",
  "hands": "Hands",
  "body": "Body",
  "feet": "Feet",
  // TH
  "ศีรษะ": "Head",
  "หัว": "Head",
  "มือ": "Hands",
  "ลำตัว": "Body",
  "เท้า": "Feet",
  "ลูกแก้ว": "Planar Sphere",
  "ทรงกลม": "Planar Sphere",
  "เชือกพลังงาน": "Link Rope",
  "เชือก": "Link Rope",
};

function fuzzyRegex(s: string) {
  return new RegExp(
    s
      .split("")
      .map((ch) => (/\s/.test(ch) ? ch : `${ch}\\s*`))
      .join(""),
    "gi"
  );
}

function normalizeStatWords(line: string): string {
  let s = normalizePercentChars(toArabic(line));
  for (const [th, en] of Object.entries(STAT_MAP)) {
    const re = fuzzyRegex(th);
    if (re.test(s)) s = s.replace(re, en);
  }
  s = s.replace(/(?:dmg|ดาเมจ)\s*คริ[ตท]?คอ?ล?/gi, "CRIT DMG");
  s = s.replace(/อัตรา\s*คริ(ติคอล)?/gi, "CRIT Rate");
  return s
    .replace(/[·•●○・]/g, "•")
    .replace(/\u200b/g, "")
    .replace(/[，、]/g, ",")
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}
const normalizeLinesToEN = (lines: string[]) => lines.map((l) => normalizeStatWords(l));

/* =========================================================
 * HSR slot detection — hard-lock label + voting
 * =======================================================*/
function forceSlotFromLabel(raw: string): HsrSlot | null {
  const s = clean(raw);
  if (/\bplanar\s*sph?ere\b|ลูกแก้ว|ทรงกลม/.test(s)) return "Planar Sphere";
  if (/\blink\s*rope\b|เชือก(?:พลังงาน)?\b|belt\b/.test(s)) return "Link Rope";
  return null;
}

function detectPieceGI(linesEN: string[], raw: string): GiSlot | null {
  const joined = linesEN.join(" ").toLowerCase();
  for (const [k, v] of Object.entries(PIECE_MAP_GI)) {
    if (new RegExp(k, "i").test(joined)) return v;
  }
  if (/(^|\s)4780(\s|$)/.test(joined)) return "Flower";
  if (/(^|\s)311(\s|$)/.test(joined)) return "Plume";
  return null;
}

function detectPieceHSR(linesEN: string[], raw: string): HsrSlot | null {
  const joined = clean(linesEN.join(" \n "));
  const rawL = clean(raw);

  const score: Record<HsrSlot, number> = {
    Head: 0,
    Hands: 0,
    Body: 0,
    Feet: 0,
    "Planar Sphere": 0,
    "Link Rope": 0,
  };
  const vote = (slot: HsrSlot, w = 1) => (score[slot] += w);

  // dictionary (raw ให้คะแนนสูงกว่า)
  for (const [k, v] of Object.entries(PIECE_MAP_HSR)) {
    const pat = new RegExp(k, "i");
    if (pat.test(joined)) vote(v, 3);
    if (pat.test(rawL)) vote(v, 5);
  }

  // header label EN/TH
  const reEN = /(head|hands|body|feet|planar\s*sph?ere|link\s*rope)\s*\+?\s*\d{1,2}\b/gi;
  const reTH = /(ศีรษะ|หัว|มือ|ลำตัว|เท้า|ลูกแก้ว|ทรงกลม|เชือก(?:พลังงาน)?)\s*\+?\s*\d{1,2}\b/gi;
  const mapEN: Record<string, HsrSlot> = {
    head: "Head",
    hands: "Hands",
    body: "Body",
    feet: "Feet",
    "planar sphere": "Planar Sphere",
    "link rope": "Link Rope",
  };
  const mapTH: Record<string, HsrSlot> = {
    "ศีรษะ": "Head",
    "หัว": "Head",
    "มือ": "Hands",
    "ลำตัว": "Body",
    "เท้า": "Feet",
    "ลูกแก้ว": "Planar Sphere",
    "ทรงกลม": "Planar Sphere",
    "เชือก": "Link Rope",
    "เชือกพลังงาน": "Link Rope",
  };
  let m: RegExpExecArray | null;
  while ((m = reEN.exec(rawL))) vote(mapEN[m[1]], 8);
  while ((m = reTH.exec(rawL))) vote(mapTH[m[1]], 8);

  // ค่าหลักคงที่
  if (/\bhp\b\s*705\b/.test(joined) || (/\b705\b/.test(joined) && /\bhp\b/.test(joined))) vote("Head", 4);
  if (/\batk\b\s*352\b/.test(joined) || (/\b352\b/.test(joined) && /\batk\b/.test(joined))) vote("Hands", 4);

  // SPD → Feet (ลดน้ำหนัก)
  if (/\bspd\b/.test(joined) || /ความเร็ว/.test(rawL)) vote("Feet", 1);

  // Break Effect → Link Rope
  if (/(break\s*effect|เอฟเฟกต์ทำลายล้าง|เอฟเฟกต์ทำลาย)\b/.test(rawL + " " + joined)) vote("Link Rope", 7);

  // DMG Bonus (ธาตุ/กายภาพ/จินตภาพฯ) → Planar Sphere
  if (
    /(dmg\s*bonus|pyro|hydro|electro|cryo|anemo|geo|dendro|quantum|imaginary|physical)/.test(
      rawL + " " + joined
    )
  )
    vote("Planar Sphere", 7);

  const order: HsrSlot[] = ["Planar Sphere", "Link Rope", "Feet", "Head", "Hands", "Body"];
  let best: HsrSlot | null = null;
  let bestScore = -1;
  for (const s of order) if (score[s] > bestScore) (best = s), (bestScore = score[s]);
  return bestScore > 0 ? best : null;
}

/* =========================================================
 * Main/Sub parsing
 * =======================================================*/
const MAIN_NAMES = [
  "HP",
  "ATK",
  "DEF",
  "Elemental Mastery",
  "Energy Recharge",
  "CRIT Rate",
  "CRIT DMG",
  "Healing Bonus",
  "Pyro DMG Bonus",
  "Hydro DMG Bonus",
  "Electro DMG Bonus",
  "Cryo DMG Bonus",
  "Anemo DMG Bonus",
  "Geo DMG Bonus",
  "Dendro DMG Bonus",
  "Physical DMG Bonus",
  // HSR
  "Effect Hit Rate",
  "Effect RES",
  "SPD",
  "Break Effect",
  "Energy Regeneration Rate",
];
const NAME_WORD_RE = new RegExp(
  `\\b(${MAIN_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|")})\\b`,
  "i"
);
const MAIN_NAME_FIRST = new RegExp(
  `\\b(${MAIN_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|")})\\b\\s*:?\\s*([0-9][\\d,.]*\\s*%?)`,
  "i"
);
const MAIN_NUM_FIRST = new RegExp(
  `([0-9][\\d,.]*\\s*%?)\\s*\\b(${MAIN_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|")})\\b`,
  "i"
);
const NUM_FLEX = /([0-9][\d.,]*\s*%?)/;

type Cand = {
  name: string;
  value: string;
  lineIdx: number;
  bullet: boolean;
  inHeader: boolean;
};

const bulletStart = /^\s*[•\-·●○・*]/;

function plausibleGIMain(name: string, value: string, piece: GiSlot | null): boolean {
  const isPct = /%$/.test(value);
  const v = parseFloat(value.replace("%", ""));
  if (isNaN(v)) return true;

  const isEM = /Elemental Mastery/i.test(name);
  const isER = /Energy Recharge/i.test(name);
  const isCR = /CRIT Rate/i.test(name);
  const isCD = /CRIT DMG/i.test(name);
  const isHB = /Healing Bonus/i.test(name);
  const isElem = /(Pyro|Hydro|Electro|Cryo|Anemo|Geo|Dendro) DMG Bonus/i.test(name);
  const isPhys = /Physical DMG Bonus/i.test(name);
  const isBasic = /\b(HP|ATK|DEF)\b/i.test(name);

  if (piece && (piece === "Sands" || piece === "Goblet" || piece === "Circlet")) {
    if (isEM) return !isPct && v >= 120 && v <= 240;
    if (isER) return isPct && v >= 40 && v <= 55;
    if (isCR) return isPct && v >= 28 && v <= 34;
    if (isCD) return isPct && v >= 58 && v <= 70;
    if (isHB) return isPct && v >= 30 && v <= 40;
    if (isElem) return isPct && v >= 40 && v <= 58;
    if (isPhys) return isPct && v >= 55 && v <= 70;
    if (isBasic) return isPct && v >= 40 && v <= 58;
    if (isPct && v < 15) return false;
  }
  return true;
}

function extractMainStatSmart(
  linesENIn: string[],
  piece: GiSlot | HsrSlot | null,
  game: GameKey
): Stat | null {
  const lines = linesENIn.map((x) => normalizeStatWords(x));

  if (game === "gi") {
    if (piece === "Flower") return { name: "HP", value: "4780" };
    if (piece === "Plume") return { name: "ATK", value: "311" };
  } else {
    if (piece === "Head") return { name: "HP", value: "705" };
    if (piece === "Hands") return { name: "ATK", value: "352" };
  }

  let headerEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\+?\s*20\b/.test(lines[i]) || bulletStart.test(lines[i])) {
      headerEnd = i;
      break;
    }
  }
  const headLimit = Math.min(24, lines.length);

  const cands: Cand[] = [];
  const pushCand = (name: string, value: string, i: number, inHeader: boolean) => {
    const v = normalizePercentChars(value).replace(/,/g, "").replace(/\s+/g, "");
    cands.push({ name, value: v, lineIdx: i, bullet: bulletStart.test(lines[i]), inHeader });
  };

  const scanRanges: Array<{ start: number; end: number; header: boolean }> = [
    { start: 0, end: Math.min(headLimit, headerEnd), header: true },
    { start: 0, end: Math.min(headLimit, lines.length), header: false },
  ];

  for (const rng of scanRanges) {
    for (let i = rng.start; i < rng.end; i++) {
      const ln = lines[i];

      let m = ln.match(MAIN_NAME_FIRST);
      if (m) {
        pushCand(m[1], m[2], i, rng.header);
        continue;
      }

      m = ln.match(MAIN_NUM_FIRST);
      if (m) {
        pushCand(m[2], m[1], i, rng.header);
        continue;
      }

      if (rng.header && NAME_WORD_RE.test(ln)) {
        const n = ln.match(NAME_WORD_RE)![1];
        for (let k = 1; k <= 2 && i + k < rng.end; k++) {
          const nx = lines[i + k];
          const mm = nx.match(NUM_FLEX);
          if (mm) {
            pushCand(n, mm[1], i, true);
            break;
          }
        }
      }
      if (rng.header) {
        const numHere = ln.match(NUM_FLEX);
        if (numHere) {
          for (let k = 1; k <= 2 && i - k >= rng.start; k++) {
            const pv = lines[i - k];
            const nn = pv.match(NAME_WORD_RE);
            if (nn) {
              pushCand(nn[1], numHere[1], i - k, true);
              break;
            }
          }
        }
      }
    }
  }

  if (!cands.length) return null;

  const score = (c: Cand) => {
    const headerBonus = c.inHeader ? 20 : 0;
    const pos = Math.max(0, 24 - c.lineIdx) * 2;
    const nobullet = c.bullet ? -16 : 16;
    let plaus = 0;
    const isPct = /%$/.test(c.value);
    const v = parseFloat(c.value.replace("%", ""));
    if (game === "gi" && (piece === "Sands" || piece === "Goblet" || piece === "Circlet")) {
      if (isPct) plaus += 6;
      if (!isPct && /Elemental Mastery/i.test(c.name)) plaus += 6;
      if (!isPct && !/Elemental Mastery/i.test(c.name)) plaus -= 8;
    }
    if (
      game === "hsr" &&
      (piece === "Body" || piece === "Feet" || piece === "Planar Sphere" || piece === "Link Rope")
    ) {
      if (isPct) plaus += 4;
    }
    if (!isNaN(v) && !isPct && v <= 60) plaus -= 4;
    if (game === "gi" && !plausibleGIMain(c.name, c.value, piece as GiSlot | null)) plaus -= 30;

    const important = /(DMG Bonus|CRIT|Recharge|Mastery|Effect|Break|SPD|Healing|Regeneration)/i.test(
      c.name
    )
      ? 3
      : 0;
    return headerBonus + pos + nobullet + plaus + important;
  };

  cands.sort((a, b) => score(b) - score(a));
  let winner: Cand | undefined = cands[0];
  if (game === "gi" && (piece === "Sands" || piece === "Goblet" || piece === "Circlet")) {
    winner = cands.find((c) => plausibleGIMain(c.name, c.value, piece as GiSlot | null));
  }
  if (!winner) winner = cands[0];
  return { name: winner.name, value: winner.value };
}

function uniqStats(subs: Stat[]) {
  const out: Stat[] = [];
  const seen = new Set<string>();
  for (const s of subs) {
    const k = `${s.name.toLowerCase()}|${s.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, 8);
}

function extractSubstatsSmart(linesENIn: string[], mainStat: Stat | null): Stat[] {
  const lines = linesENIn.map((x) => normalizeStatWords(x));

  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (bulletStart.test(lines[i])) {
      startIdx = i;
      break;
    }
  }

  const out: Stat[] = [];
  const push = (s: Stat) => {
    if (mainStat && s.name.toLowerCase() === mainStat.name.toLowerCase() && s.value === mainStat.value)
      return;
    if (!out.some((x) => x.name.toLowerCase() === s.name.toLowerCase() && x.value === s.value))
      out.push(s);
  };

  const NAME_FIRST =
    /(HP|ATK|DEF|Elemental Mastery|Energy Recharge|CRIT Rate|CRIT DMG|Effect Hit Rate|Effect RES|SPD|Break Effect|Energy Regeneration Rate|(?:Pyro|Hydro|Electro|Cryo|Anemo|Geo|Dendro) DMG Bonus|Physical DMG Bonus)\s*\+?\s*([0-9][\d,.]*\s*%?)/i;
  const NUM_FIRST =
    /\+?\s*([0-9][\d,.]*\s*%?)\s*(HP|ATK|DEF|Elemental Mastery|Energy Recharge|CRIT Rate|CRIT DMG|Effect Hit Rate|Effect RES|SPD|Break Effect|Energy Regeneration Rate|(?:Pyro|Hydro|Electro|Cryo|Anemo|Geo|Dendro) DMG Bonus|Physical DMG Bonus)/i;

  const NAME_ONLY = new RegExp(
    `^(HP|ATK|DEF|Elemental Mastery|Energy Recharge|CRIT Rate|CRIT DMG|Effect Hit Rate|Effect RES|SPD|Break Effect|Energy Regeneration Rate|(?:Pyro|Hydro|Electro|Cryo|Anemo|Geo|Dendro) DMG Bonus|Physical DMG Bonus)$`,
    "i"
  );
  const PURE_NUM = /^\+?\s*[0-9][\d,.]*\s*%?\s*$/;

  for (let i = startIdx; i < Math.min(lines.length, startIdx + 20); i++) {
    const raw = lines[i];
    const line = raw.replace(bulletStart, "").trim();
    if (!line) continue;

    let m = line.match(NAME_FIRST);
    if (m) {
      push({ name: m[1], value: m[2].replace(/,/g, "").replace(/\s+/g, "") });
      continue;
    }

    m = line.match(NUM_FIRST);
    if (m) {
      push({ name: m[2], value: m[1].replace(/,/g, "").replace(/\s+/g, "") });
      continue;
    }

    const nameOnly = line.match(NAME_ONLY);
    if (nameOnly && i + 1 < lines.length) {
      const nx = lines[i + 1].replace(bulletStart, "").trim();
      const vv = nx.match(PURE_NUM);
      if (vv) {
        push({ name: nameOnly[1], value: vv[0].replace(/,/g, "").replace(/\s+/g, "") });
        continue;
      }
    }
  }

  return uniqStats(out);
}

/* =========================================================
 * Guess setName from DB (ไม่ใช้ Regex รายชื่อแล้ว)
 * =======================================================*/
async function guessSetNameFromText(game: GameKey, rawText: string): Promise<string | null> {
  const catalog = await loadSetCatalog(game);
  if (!catalog.length) return null;

  const hay1 = clean(rawText);
  const hay2 = compress(rawText);

  let best: { name: string; score: number } | null = null;

  for (const r of catalog) {
    const needle1 = clean(r.name);
    const needle2 = compress(r.name);
    let s = 0;
    if (hay1.includes(needle1)) s += needle1.length * 2; // ตรงคำพร้อมเว้นวรรค
    if (hay2.includes(needle2)) s += needle2.length; // แบบบีบอักษร
    // เผื่อ OCR ตัดคำเป็นบรรทัด: ลองอนุญาตช่องว่างแบบ fuzzy
    const fuzzy = new RegExp(needle1.replace(/\s+/g, "\\s*"), "i");
    if (fuzzy.test(hay1)) s += needle1.length;

    if (s > 0 && (!best || s > best.score)) {
      best = { name: r.name, score: s };
    }
  }
  return best?.name ?? null;
}

/* =========================================================
 * Parse by game (setName จาก DB)
 * =======================================================*/
async function parseGI(text: string) {
  const lines = splitlines(text || "");
  const linesEN = normalizeLinesToEN(lines);

  const piece = detectPieceGI(linesEN, text) || "Sands";
  const mainStat = extractMainStatSmart(linesEN, piece, "gi");
  const substats = extractSubstatsSmart(linesEN, mainStat);

  const setName = await guessSetNameFromText("gi", text);
  return { piece, mainStat: mainStat || null, substats, setName } as Pick<
    GearItem,
    "piece" | "mainStat" | "substats" | "setName"
  >;
}

async function parseHSR(text: string) {
  const lines = splitlines(text || "");
  const linesEN = normalizeLinesToEN(lines);

  const forced = forceSlotFromLabel(text);
  let piece = forced ?? detectPieceHSR(linesEN, text) ?? "Body";

  const mainStat = extractMainStatSmart(linesEN, piece, "hsr");
  const substats = extractSubstatsSmart(linesEN, mainStat);

  // override ตามค่าหลัก ถ้าไม่ได้ถูกบังคับจาก label
  if (!forced && mainStat) {
    const n = mainStat.name.toLowerCase();
    const pct = /%/.test(mainStat.value || "");
    if (/energy\s*regeneration|ฟื้นพลังงาน/.test(n)) piece = "Link Rope";
    else if (/break\s*effect|เอฟเฟกต์ทำลาย/.test(n)) piece = "Link Rope";
    else if (/spd/.test(n) && pct) piece = "Feet";
    else if (/dmg\s*bonus|pyro|hydro|electro|cryo|anemo|geo|dendro|quantum|imaginary|physical/.test(n))
      piece = "Planar Sphere";
  }

  const setName = await guessSetNameFromText("hsr", text);
  return { piece, mainStat: mainStat || null, substats, setName } as Pick<
    GearItem,
    "piece" | "mainStat" | "substats" | "setName"
  >;
}

/* =========================================================
 * Public API
 * =======================================================*/
export async function ocrGear(file: File | Blob, game: GameKey): Promise<GearItem> {
  const text = await ocrWithFallback(file, "tha+eng");
  const parsed = game === "gi" ? await parseGI(text) : await parseHSR(text);
  return {
    url: "",
    piece: parsed.piece as GiSlot | HsrSlot,
    setName: parsed.setName || null,
    mainStat: parsed.mainStat,
    substats: parsed.substats,
  };
}

/* =========================================================
 * Aggregate + Advice (GI) — โค้ดเดิมของเธอ เอามาให้ครบ
 * =======================================================*/
const num = (s?: string | null) => {
  if (!s) return 0;
  const m = String(s).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
};
const isPct = (s?: string | null) => /%/.test(String(s || ""));

function canonKey(name: string) {
  const k = name.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^crit( |-)rate|^cr($| )|อัตราคริ|คริติคอลเรต/i.test(k)) return "cr_pct";
  if (/^crit( |-)dmg|^cd($| )|คริติคอลดาเมจ|ความแรงคริ/i.test(k)) return "cd_pct";
  if (/^energy recharge|^er($| )|ฟื้นฟูพลังงาน/i.test(k)) return "er_pct";
  if (/^elemental mastery|^em($| )|ความชำนาญธาตุ/i.test(k)) return "em";
  if (/^hp%?$/.test(k)) return isPct(name) ? "hp_pct" : "hp_flat";
  if (/^atk%?$/.test(k)) return isPct(name) ? "atk_pct" : "atk_flat";
  if (/^def%?$/.test(k)) return isPct(name) ? "def_pct" : "def_flat";
  if (/healing bonus/i.test(name)) return "heal_pct";
  if (/physical dmg bonus/i.test(name)) return "phys_pct";
  if (/pyro dmg bonus/i.test(name)) return "pyro_pct";
  if (/hydro dmg bonus/i.test(name)) return "hydro_pct";
  if (/cryo dmg bonus/i.test(name)) return "cryo_pct";
  if (/electro dmg bonus/i.test(name)) return "electro_pct";
  if (/anemo dmg bonus/i.test(name)) return "anemo_pct";
  if (/geo dmg bonus/i.test(name)) return "geo_pct";
  if (/dendro dmg bonus/i.test(name)) return "dendro_pct";
  return "";
}

export function aggregateGiArtifacts(gear: Partial<Record<GiSlot, GearItem>>) {
  const out = {
    hp_flat: 0,
    atk_flat: 0,
    def_flat: 0,
    hp_pct: 0,
    atk_pct: 0,
    def_pct: 0,
    em: 0,
    er_pct: 0,
    cr_pct: 0,
    cd_pct: 0,
    pyro_pct: 0,
    hydro_pct: 0,
    cryo_pct: 0,
    electro_pct: 0,
    anemo_pct: 0,
    geo_pct: 0,
    dendro_pct: 0,
    phys_pct: 0,
    heal_pct: 0,
  };
  const add = (name?: string | null, val?: string | null) => {
    if (!name || !val) return;
    const key = canonKey(name);
    if (!key) return;
    (out as any)[key] += num(val);
  };

  (GI_SLOTS as readonly GiSlot[]).forEach((slot) => {
    const it = gear[slot];
    if (!it) return;
    if (it.mainStat) add(it.mainStat.name, it.mainStat.value);
    (it.substats || []).forEach((s) => add(s.name, s.value));
  });
  return out;
}

export type GiAdvice = {
  char: string;
  totals: {
    hp_flat: number;
    atk_flat: number;
    def_flat: number;
    em: number;
    er_pct: number;
    cr_pct: number;
    cd_pct: number;
    dmg: {
      pyro: number;
      hydro: number;
      cryo: number;
      electro: number;
      anemo: number;
      geo: number;
      dendro: number;
      physical: number;
    };
  };
  notes: string[];
};

export async function analyzeGiArtifacts(
  char: string,
  gear: Partial<Record<GiSlot, GearItem>>
): Promise<GiAdvice> {
  const agg = aggregateGiArtifacts(gear);
  const dmg = {
    pyro: agg.pyro_pct,
    hydro: agg.hydro_pct,
    cryo: agg.cryo_pct,
    electro: agg.electro_pct,
    anemo: agg.anemo_pct,
    geo: agg.geo_pct,
    dendro: agg.dendro_pct,
    physical: agg.phys_pct,
  };

  const base = { er: 100, cr: 5, cd: 50 };

  const totals = {
    hp_flat: agg.hp_flat,
    atk_flat: agg.atk_flat,
    def_flat: agg.def_flat,
    em: agg.em,
    er_pct: base.er + agg.er_pct,
    cr_pct: base.cr + agg.cr_pct,
    cd_pct: base.cd + agg.cd_pct,
    dmg,
  };

  const notes: string[] = [];
  const isFurina = /furina/i.test(char);

  if (totals.er_pct < 130) notes.push("Energy Recharge ยังต่ำ (<130%) → หา ER จากซับ/ทรายเพิ่ม");
  else if (totals.er_pct < 160)
    notes.push(`Energy Recharge รวม ~${totals.er_pct.toFixed(0)}% พอใช้ได้ ถ้าหมุนสกิลไม่พอ ลองดันไป ~180%`);

  if (totals.cr_pct < 55) notes.push("คริเรตต่ำ (<55%) → ต้องการ CR เพิ่ม");
  if (totals.cd_pct < 120) notes.push("คริดาเมจยังน้อย (<120%) → หา CD เพิ่มจากซับ/หมวก");

  const maxElem = Object.entries(dmg).sort((a, b) => b[1] - a[1])[0];
  if (!maxElem || maxElem[1] < 15) {
    if (isFurina) notes.push("ยังไม่มีโบนัสธาตุเด่น → ลอง Goblet Hydro DMG (แทน HP%) จะดาเมจขึ้นชัด");
    else notes.push("ยังไม่มีโบนัสธาตุ/ฟิสิคัล → ใช้ Goblet ธาตุให้ตรงคาแรกเตอร์");
  }
  if (isFurina) {
    const gobletMain = gear.Goblet?.mainStat?.name || "";
    if (/hp%/i.test(gobletMain) && totals.dmg.hydro < 30) {
      notes.push("Furina ชอบ Goblet Hydro DMG มากกว่า HP% ถ้าทีมต้องการดาเมจ");
    }
  }

  return { char, totals, notes };
}

export function formatGiAdvice(r: GiAdvice) {
  const lines = [
    `ผลคำนวณสำหรับ ${r.char}`,
    `สรุปรวมจากของ (รวมฐาน CR5%/CD50%/ER100%):`,
    `• HP +${r.totals.hp_flat} | ATK +${r.totals.atk_flat} | DEF +${r.totals.def_flat}`,
    `• EM ${r.totals.em} | ER ${r.totals.er_pct.toFixed(1)}% | CR ${r.totals.cr_pct.toFixed(1)}% | CD ${r.totals.cd_pct.toFixed(1)}%`,
    `• DMG Bonus: Pyro ${r.totals.dmg.pyro}% / Hydro ${r.totals.dmg.hydro}% / Cryo ${r.totals.dmg.cryo}% / Electro ${r.totals.dmg.electro}% / Anemo ${r.totals.dmg.anemo}% / Geo ${r.totals.dmg.geo}% / Dendro ${r.totals.dmg.dendro}% / Phys ${r.totals.dmg.physical}%`,
  ];
  if (r.notes.length) {
    lines.push("ข้อเสนอแนะ:");
    r.notes.forEach((n) => lines.push(`• ${n}`));
  }
  return lines.join("\n");
}
