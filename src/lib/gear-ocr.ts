// /src/lib/gear-ocr.ts
import Tesseract from 'tesseract.js';

export type GameKey = 'gi' | 'hsr';

export type Stat = { name: string; value: string };
export type GearItem = {
  url: string;
  piece?: string | null;
  setName?: string | null;
  mainStat?: Stat | null;
  substats?: Stat[];
};

/* ====================== Normalize helpers ====================== */

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const toArabic = (s: string) =>
  [...(s || '')]
    .map((c) => {
      const i = THAI_DIGITS.indexOf(c);
      return i >= 0 ? String(i) : c;
    })
    .join('');

// ให้ % เป็นรูปเดียว และตัดช่องว่างหน้า %
const normalizePercentChars = (s: string) => s.replace(/[％﹪]/g, '%').replace(/\s+%/g, '%');

const splitlines = (s: string) =>
  normalizePercentChars(toArabic(s))
    .replace(/\u200b/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/，/g, ',')
    .replace(/[•·●○・*]/g, '•')
    .split(/\r?\n/)
    .map((x) => x.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean);

/* ====================== Dictionaries ====================== */

const STAT_MAP: Record<string, string> = {
  // GI/ทั่วไป (TH -> EN)
  'พลังชีวิต': 'HP',
  'พลังโจมตี': 'ATK',
  'พลังป้องกัน': 'DEF',
  'ความชำนาญธาตุ': 'Elemental Mastery',
  'อัตราการฟื้นฟูพลังงาน': 'Energy Recharge',
  'การฟื้นฟูพลังงาน': 'Energy Recharge',
  'อัตราคริติคอล': 'CRIT Rate',
  'อัตราคริ': 'CRIT Rate',
  'คริติคอลเรต': 'CRIT Rate',
  'โอกาสคริ': 'CRIT Rate',
  'ความแรงคริติคอล': 'CRIT DMG',
  'ความแรงคริ': 'CRIT DMG',
  'ดาเมจคริ': 'CRIT DMG',
  'คริติคอลดาเมจ': 'CRIT DMG',
  'โบนัสการรักษา': 'Healing Bonus',
  'โบนัสความเสียหายกายภาพ': 'Physical DMG Bonus',
  'ความเสียหายกายภาพ': 'Physical DMG Bonus',
  'โบนัสความเสียหายไฟ': 'Pyro DMG Bonus',
  'โบนัสความเสียหายน้ำ': 'Hydro DMG Bonus',
  'โบนัสความเสียหายไฟฟ้า': 'Electro DMG Bonus',
  'โบนัสความเสียหายน้ำแข็ง': 'Cryo DMG Bonus',
  'โบนัสความเสียหายลม': 'Anemo DMG Bonus',
  'โบนัสความเสียหายหิน': 'Geo DMG Bonus',
  'โบนัสความเสียหายหญ้า': 'Dendro DMG Bonus',
  // HSR
  'อัตราติดเอฟเฟกต์': 'Effect Hit Rate',
  'ต้านทานเอฟเฟกต์': 'Effect RES',
  'ต้านทานสถานะ': 'Effect RES',
  'ความเร็ว': 'SPD',
  'ฟื้นพลังงาน': 'Energy Regeneration Rate',
  'อัตราการฟื้นพลังงาน': 'Energy Regeneration Rate',
  'เอฟเฟกต์ทำลายล้าง': 'Break Effect',
  'เอฟเฟกต์ทำลาย': 'Break Effect',
  'ผลการทำลาย': 'Break Effect',
};

const GI_SLOTS = ['Flower', 'Plume', 'Sands', 'Goblet', 'Circlet'] as const;
const HSR_SLOTS = ['Head', 'Hands', 'Body', 'Feet', 'Planar Sphere', 'Link Rope'] as const;
export type GiSlot = (typeof GI_SLOTS)[number];
export type HsrSlot = (typeof HSR_SLOTS)[number];

const PIECE_MAP_GI: Record<string, GiSlot> = {
  'flower of life': 'Flower',
  'plume of death': 'Plume',
  'sands of eon': 'Sands',
  'goblet of eonothem': 'Goblet',
  'circlet of logos': 'Circlet',
  // TH
  'ดอกไม้': 'Flower',
  'ขนนก': 'Plume',
  'ทราย': 'Sands',
  'ถ้วย': 'Goblet',
  'มงกุฎ': 'Circlet',
};

const PIECE_MAP_HSR: Record<string, HsrSlot> = {
  head: 'Head',
  hands: 'Hands',
  body: 'Body',
  feet: 'Feet',
  'planar sphere': 'Planar Sphere',
  'link rope': 'Link Rope',
  // TH
  'ศีรษะ': 'Head',
  'หัว': 'Head',
  'มือ': 'Hands',
  'ลำตัว': 'Body',
  'เท้า': 'Feet',
  'ทรงกลม': 'Planar Sphere',
  'ทรงกลมแผนภาพ': 'Planar Sphere',
  'เชือก': 'Link Rope',
  'โซ่': 'Link Rope',
};

function normalizeStatWords(line: string): string {
  const fuzzy = (s: string) => s.split('').map((ch) => (/\s/.test(ch) ? ch : `${ch}\\s*`)).join('');
  let s = normalizePercentChars(toArabic(line));

  // map คำไทย→EN แบบยอมเว้นวรรคผิด ๆ
  for (const [th, en] of Object.entries(STAT_MAP)) {
    const re = new RegExp(fuzzy(th), 'gi');
    if (re.test(s)) s = s.replace(re, en);
  }

  // HSR ไทยที่เขียนปนอังกฤษ
  s = s.replace(/(?:dmg|ดาเมจ)\s*คริ[ตท]?คอ?ล?/gi, 'CRIT DMG');
  s = s.replace(/อัตรา\s*คริ(ติคอล)?/gi, 'CRIT Rate');

  // ทำความสะอาด
  return s
    .replace(/[·•●○・]/g, '•')
    .replace(/\u200b/g, '')
    .replace(/[，、]/g, ',')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const normalizeLinesToEN = (lines: string[]) => lines.map((l) => normalizeStatWords(l));

/* ====================== Piece detection ====================== */

function detectPieceGI(linesEN: string[], raw: string): GiSlot | null {
  const joined = linesEN.join(' ').toLowerCase();
  for (const [k, v] of Object.entries(PIECE_MAP_GI)) {
    if (joined.includes(k.toLowerCase())) return v;
  }
  // Fallback ด้วยค่าคงที่
  if (/(^|\s)4780(\s|$)/.test(joined)) return 'Flower';
  if (/(^|\s)311(\s|$)/.test(joined)) return 'Plume';
  return null;
}

function detectPieceHSR(linesEN: string[]): HsrSlot | null {
  const joined = linesEN.join(' ').toLowerCase();
  for (const [k, v] of Object.entries(PIECE_MAP_HSR)) {
    if (joined.includes(k.toLowerCase())) return v;
  }
  if (/\bHP\b\s*705\b/i.test(joined)) return 'Head';
  if (/\bATK\b\s*352\b/i.test(joined)) return 'Hands';
  return null;
}

/* ====================== Main/Sub parsing ====================== */

// รายชื่อค่าสเตตที่รองรับ
const MAIN_NAMES = [
  'HP','ATK','DEF',
  'Elemental Mastery','Energy Recharge',
  'CRIT Rate','CRIT DMG','Healing Bonus',
  'Pyro DMG Bonus','Hydro DMG Bonus','Electro DMG Bonus','Cryo DMG Bonus','Anemo DMG Bonus','Geo DMG Bonus','Dendro DMG Bonus',
  'Physical DMG Bonus',
  // HSR
  'Effect Hit Rate','Effect RES','SPD','Break Effect','Energy Regeneration Rate',
];

const NAME_WORD_RE = new RegExp(`\\b(${MAIN_NAMES.map(n => n.replace(/ /g,'\\s+')).join('|')})\\b`, 'i');
const MAIN_NAME_FIRST = new RegExp(`\\b(${MAIN_NAMES.map(n => n.replace(/ /g,'\\s+')).join('|')})\\b\\s*:?\\s*([0-9][\\d,.]*\\s*%?)`, 'i');
const MAIN_NUM_FIRST  = new RegExp(`([0-9][\\d,.]*\\s*%?)\\s*\\b(${MAIN_NAMES.map(n => n.replace(/ /g,'\\s+')).join('|')})\\b`, 'i');
const NUM_FLEX = /([0-9][\d.,]*\s*%?)/;

type Cand = { name: string; value: string; lineIdx: number; bullet: boolean; inHeader: boolean };

function plausibleGIMain(name: string, value: string, piece: GiSlot | null): boolean {
  const isPct = /%$/.test(value);
  const v = parseFloat(value.replace('%',''));
  if (isNaN(v)) return true;

  const isEM = /Elemental Mastery/i.test(name);
  const isER = /Energy Recharge/i.test(name);
  const isCR = /CRIT Rate/i.test(name);
  const isCD = /CRIT DMG/i.test(name);
  const isHB = /Healing Bonus/i.test(name);
  const isElem = /(Pyro|Hydro|Electro|Cryo|Anemo|Geo|Dendro) DMG Bonus/i.test(name);
  const isPhys = /Physical DMG Bonus/i.test(name);
  const isBasic = /\b(HP|ATK|DEF)\b/i.test(name);

  if (piece && (piece === 'Sands' || piece === 'Goblet' || piece === 'Circlet')) {
    if (isEM)   return !isPct && v >= 120 && v <= 240;
    if (isER)   return isPct && v >= 40 && v <= 55;
    if (isCR)   return isPct && v >= 28 && v <= 34;
    if (isCD)   return isPct && v >= 58 && v <= 70;
    if (isHB)   return isPct && v >= 30 && v <= 40;
    if (isElem) return isPct && v >= 40 && v <= 58;
    if (isPhys) return isPct && v >= 55 && v <= 70;
    if (isBasic) return isPct && v >= 40 && v <= 58;
    if (isPct && v < 15) return false; // กันตัวเลข sub เล็ก ๆ
  }
  return true;
}

function extractMainStatSmart(linesENIn: string[], piece: GiSlot | HsrSlot | null, game: GameKey): Stat | null {
  const lines = linesENIn.map((x) => normalizeStatWords(x));
  const bulletStart = /^\s*[•\-·●○・*]/;

  // override slot main ตายตัว
  if (game === 'gi') {
    if (piece === 'Flower') return { name: 'HP', value: '4780' };
    if (piece === 'Plume')  return { name: 'ATK', value: '311' };
  } else {
    if (piece === 'Head')  return { name: 'HP',  value: '705' };
    if (piece === 'Hands') return { name: 'ATK', value: '352' };
  }

  // ขอบเขต "หัวการ์ด" = ก่อนถึง +20 หรือบูลเล็ตตัวแรก
  let headerEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\+?\s*20\b/.test(lines[i]) || bulletStart.test(lines[i])) { headerEnd = i; break; }
  }
  const headLimit = Math.min(24, lines.length);

  const cands: Cand[] = [];
  const pushCand = (name: string, value: string, i: number, inHeader: boolean) => {
    const v = normalizePercentChars(value).replace(/,/g, '').replace(/\s+/g, '');
    cands.push({ name, value: v, lineIdx: i, bullet: bulletStart.test(lines[i]), inHeader });
  };

  const scanRanges: Array<{start:number; end:number; header:boolean}> = [
    { start: 0, end: Math.min(headLimit, headerEnd), header: true },   // โฟกัสหัวก่อน
    { start: 0, end: Math.min(headLimit, lines.length), header: false } // เผื่อ OCR แหวก
  ];

  for (const rng of scanRanges) {
    for (let i = rng.start; i < rng.end; i++) {
      const ln = lines[i];

      // name -> value
      let m = ln.match(MAIN_NAME_FIRST);
      if (m) { pushCand(m[1], m[2], i, rng.header); continue; }

      // value -> name
      m = ln.match(MAIN_NUM_FIRST);
      if (m) { pushCand(m[2], m[1], i, rng.header); continue; }

      // ชื่อ/ค่าอยู่คนละบรรทัด (ส่อง 2 บรรทัด)
      if (rng.header && NAME_WORD_RE.test(ln)) {
        const n = ln.match(NAME_WORD_RE)![1];
        for (let k = 1; k <= 2 && i + k < rng.end; k++) {
          const nx = lines[i + k];
          const mm = nx.match(NUM_FLEX);
          if (mm) { pushCand(n, mm[1], i, true); break; }
        }
      }
      if (rng.header) {
        const numHere = ln.match(NUM_FLEX);
        if (numHere) {
          for (let k = 1; k <= 2 && i - k >= rng.start; k++) {
            const pv = lines[i - k];
            const nn = pv.match(NAME_WORD_RE);
            if (nn) { pushCand(nn[1], numHere[1], i - k, true); break; }
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
    const v = parseFloat(c.value.replace('%',''));

    if (game === 'gi' && (piece === 'Sands' || piece === 'Goblet' || piece === 'Circlet')) {
      if (isPct) plaus += 6;
      if (!isPct && /Elemental Mastery/i.test(c.name)) plaus += 6;
      if (!isPct && !/Elemental Mastery/i.test(c.name)) plaus -= 8;
    }
    if (game === 'hsr' && (piece === 'Body' || piece === 'Feet' || piece === 'Planar Sphere' || piece === 'Link Rope')) {
      if (isPct) plaus += 4;
    }
    if (!isNaN(v) && !isPct && v <= 60) plaus -= 4;

    // GI domain filter
    if (game === 'gi' && !plausibleGIMain(c.name, c.value, piece as GiSlot | null)) plaus -= 30;

    const important = /(DMG Bonus|CRIT|Recharge|Mastery|Effect|Break|SPD|Healing|Regeneration)/i.test(c.name) ? 3 : 0;
    return headerBonus + pos + nobullet + plaus + important;
  };

  // จัดตามคะแนน
  cands.sort((a, b) => score(b) - score(a));

  // ถ้าเป็น GI variable slot แล้วคัดไม่ผ่าน domain ให้ลองหา candidate ถัด ๆ ไปที่ผ่าน
  let winner: Cand | undefined = cands[0];
  if (game === 'gi' && (piece === 'Sands' || piece === 'Goblet' || piece === 'Circlet')) {
    winner = cands.find(c => plausibleGIMain(c.name, c.value, piece as GiSlot | null));
  }
  if (!winner) winner = cands[0];

  return { name: winner.name, value: winner.value };
}

/* ----- Substats ----- */

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
  const bulletStart = /^\s*[•\-·●○・*]/;

  // เริ่มอ่านตั้งแต่บูลเล็ตรายการแรกลงไป (กันลาก main มาปะปน)
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (bulletStart.test(lines[i])) { startIdx = i; break; }
  }

  const out: Stat[] = [];
  const push = (s: Stat) => {
    if (mainStat && s.name.toLowerCase() === mainStat.name.toLowerCase() && s.value === mainStat.value) return;
    if (!out.some((x) => x.name.toLowerCase() === s.name.toLowerCase() && x.value === s.value)) out.push(s);
  };

  const NAME_FIRST =
    /(HP|ATK|DEF|Elemental Mastery|Energy Recharge|CRIT Rate|CRIT DMG|Effect Hit Rate|Effect RES|SPD|Break Effect|Energy Regeneration Rate|(?:Pyro|Hydro|Electro|Cryo|Anemo|Geo|Dendro) DMG Bonus|Physical DMG Bonus)\s*\+?\s*([0-9][\d,.]*\s*%?)/i;
  const NUM_FIRST =
    /\+?\s*([0-9][\d,.]*\s*%?)\s*(HP|ATK|DEF|Elemental Mastery|Energy Recharge|CRIT Rate|CRIT DMG|Effect Hit Rate|Effect RES|SPD|Break Effect|Energy Regeneration Rate|(?:Pyro|Hydro|Electro|Cryo|Anemo|Geo|Dendro) DMG Bonus|Physical DMG Bonus)/i;

  const NAME_ONLY = new RegExp(
    `^(HP|ATK|DEF|Elemental Mastery|Energy Recharge|CRIT Rate|CRIT DMG|Effect Hit Rate|Effect RES|SPD|Break Effect|Energy Regeneration Rate|(?:Pyro|Hydro|Electro|Cryo|Anemo|Geo|Dendro) DMG Bonus|Physical DMG Bonus)$`,
    'i'
  );
  const PURE_NUM = /^\+?\s*[0-9][\d,.]*\s*%?\s*$/;

  for (let i = startIdx; i < Math.min(lines.length, startIdx + 20); i++) {
    const raw = lines[i];
    const line = raw.replace(bulletStart, '').trim();
    if (!line) continue;

    let m = line.match(NAME_FIRST);
    if (m) { push({ name: m[1], value: m[2].replace(/,/g, '').replace(/\s+/g, '') }); continue; }

    m = line.match(NUM_FIRST);
    if (m) { push({ name: m[2], value: m[1].replace(/,/g, '').replace(/\s+/g, '') }); continue; }

    // ข้ามบรรทัด: ชื่ออยู่บรรทัดนี้ → เลขอยู่บรรทัดถัดไป
    const nameOnly = line.match(NAME_ONLY);
    if (nameOnly && i + 1 < lines.length) {
      const nx = lines[i + 1].replace(bulletStart, '').trim();
      const vv = nx.match(PURE_NUM);
      if (vv) { push({ name: nameOnly[1], value: vv[0].replace(/,/g, '').replace(/\s+/g, '') }); continue; }
    }
  }

  return uniqStats(out);
}

/* ====================== parse GI / HSR ====================== */

function parseGI(text: string) {
  const raw = text || '';
  const lines = splitlines(raw);
  const linesEN = normalizeLinesToEN(lines);
  const joined = linesEN.join(' ');

  const piece = detectPieceGI(linesEN, raw);
  const mainStat = extractMainStatSmart(linesEN, piece, 'gi');
  const substats = extractSubstatsSmart(linesEN, mainStat);

  const setGuess =
    joined.match(
      /(Gladiator.?s Finale|Golden Troupe|Marechaussee Hunter|Noblesse Oblige|Viridescent Venerer|Deepwood Memories|Emblem of Severed Fate|Echoes of an Offering|Husk of Opulent Dreams|Tenacity of the Millelith|Blizzard Strayer|Shimenawa.?s Reminiscence|Heart of Depth)/i
    )?.[1] ?? null;

  return {
    game: 'gi' as const,
    setName: setGuess,
    pieceName: piece ?? null,
    piece,
    mainStat: mainStat || null,
    substats,
  };
}

function parseHSR(text: string) {
  const raw = text || '';
  const lines = splitlines(raw);
  const linesEN = normalizeLinesToEN(lines);
  const joined = linesEN.join(' ');

  const piece = detectPieceHSR(linesEN);
  const mainStat = extractMainStatSmart(linesEN, piece, 'hsr');
  const substats = extractSubstatsSmart(linesEN, mainStat);

  const setGuess =
    joined.match(
      /(Musketeer of Wild Wheat|Eagle of Twilight Line|Hunter of Glacial Forest|Band of Sizzling Thunder|Genius of Brilliant Stars|Firesmith of Lava-Forging|Knight of Purity Palace|Champion of Streetwise Boxing|Guard of Wuthering Snow|Passerby of Wandering Cloud|Poet of Mourning Collapse|Bone Collection.?s Serene Demesne|The Ashblazing Grand Duke|Longevous Disciple|Messenger Traversing Hackerspace|Pioneer Diver of Dead Waters|Wastelander of Banditry Desert|Prisoner in Deep Confinement|Thief of Shooting Meteor|Sprightly Vonwacq|Space Sealing Station|Fleet of the Ageless|Rutilant Arena|Inert Salsotto|Talia: Kingdom of Banditry|Pan-Galactic Commercial Enterprise)/i
    )?.[1] ?? null;

  return {
    game: 'hsr' as const,
    setName: setGuess,
    pieceName: piece ?? null,
    piece,
    mainStat: mainStat || null,
    substats,
  };
}

/* ====================== Public API ====================== */

export async function ocrGear(file: File, game: GameKey) {
  const {
    data: { text },
  } = await Tesseract.recognize(file, 'tha+eng', {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/tesseract-core-lstm.wasm.js',
    langPath: '/tesseract/lang',
  } as any);

  return game === 'gi' ? parseGI(text) : parseHSR(text);
}
