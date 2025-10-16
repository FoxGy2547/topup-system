// src/app/api/enka-hsr/route.ts
/**
 * ดึงโปรไฟล์จาก enka.network (HSR) แล้วคืน characters & details
 * แบบ "ชื่อจริง" โดยไม่ต้องพึ่งไฟล์ hsr_characters.json ภายในโปรเจกต์
 *
 * กลไก:
 *  - โหลดแผนที่ตัวละคร + loc (ข้อความ) จาก enka:
 *      characters: https://sr.enka.network/hsr_data/characters.json
 *      loc(th):    https://sr.enka.network/hsr_data/loc/th.json
 *      loc(en):    https://sr.enka.network/hsr_data/loc/en.json (fallback)
 *  - map avatarId -> name ด้วย nameTextMapHash จาก characters + loc
 *  - แคชไว้ในหน่วยความจำ (memory) ชั่วคราวเพื่อลด latency
 */

import { NextRequest, NextResponse } from 'next/server';

/* ======================== Remote maps ======================== */

type HsrCharacterIndex = {
  id: number;                        // avatarId
  nameTextMapHash?: number | string; // ใช้ไปเปิดใน loc
  // ช่องอื่น ๆ ไม่บังคับ
};

type LocMap = Record<string, string>;

const ENKA_URL = 'https://sr.enka.network/hsr_data';
const URLS = {
  characters: `${ENKA_URL}/characters.json`,
  locTH:      `${ENKA_URL}/loc/th.json`,
  locEN:      `${ENKA_URL}/loc/en.json`,
};

// memory cache แบบง่าย ๆ
let _mapReady = false;
let _id2name = new Map<number, string>();
let _loc: LocMap = {};
let _loadedAt = 0;
const MAX_AGE_MS = 1000 * 60 * 30; // 30 นาที

async function loadRemoteMaps(force = false) {
  if (!force && _mapReady && Date.now() - _loadedAt < MAX_AGE_MS) return;

  // โหลด characters index
  const [chRes, thRes] = await Promise.allSettled([
    fetch(URLS.characters, { cache: 'no-store' }),
    fetch(URLS.locTH,      { cache: 'no-store' }),
  ]);

  // loc -> th ถ้าไม่ได้ค่อย en
  if (thRes.status === 'fulfilled' && thRes.value.ok) {
    _loc = (await thRes.value.json()) as LocMap;
  } else {
    const en = await fetch(URLS.locEN, { cache: 'no-store' }).catch(() => null);
    _loc = en && en.ok ? ((await en.json()) as LocMap) : {};
  }

  // สร้าง id->name
  _id2name.clear();
  if (chRes.status === 'fulfilled' && chRes.value.ok) {
    const arr = (await chRes.value.json()) as HsrCharacterIndex[];
    for (const it of arr || []) {
      const hash = it?.nameTextMapHash;
      if (hash == null) continue;
      const key = String(hash);
      const name = _loc[key];
      if (name) _id2name.set(it.id, name);
    }
  }

  _loadedAt = Date.now();
  _mapReady = _id2name.size > 0;
}

// helper แปลง id -> ชื่อ (ดึงจากแคช/โหลดถ้ายัง)
async function hsrName(id?: number, fallback?: string) {
  if (!id) return fallback ?? '';
  await loadRemoteMaps(); // ensure map ready
  return _id2name.get(id) ?? fallback ?? `#${id}`;
}

/* ======================== Minimal types ======================== */

type HsrProp = { type?: string; value?: number };
type HsrRelic = {
  type?: number;
  level?: number;
  _flat?: { name?: string; setName?: string; props?: HsrProp[] };
  flat?: {
    relicType?: string; name?: string; setName?: string;
    relicMainstat?: HsrProp; relicSubstats?: HsrProp[];
  };
  relic?: { level?: number };
};

type HsrCharacter = {
  avatarId?: number;
  avatar?: { id?: number };
  name?: string;        // บาง response อาจมี
  avatarName?: string;  // บาง response อาจมี
  level?: number;
  relicList?: HsrRelic[];
  relics?: HsrRelic[];
  fightPropMap?: Record<string, number>;
};

type HsrTop =
  | { detailInfo?: { nickname?: string; avatarDetailList?: HsrCharacter[] }; uid?: string }
  | { playerDetailInfo?: { nickname?: string; avatarDetailList?: HsrCharacter[] }; uid?: string }
  | { owner?: { nickname?: string }; avatarDetailList?: HsrCharacter[]; uid?: string };

/* ======================== Output shape ======================== */

type CharacterLite = { id: number; name: string; level: number };
type RelicSummary = { piece: string; name: string; set?: string; main: string; subs: string[]; level?: number };
type HsrDetailOut = { id: number; name: string; level: number; relics: RelicSummary[]; shownTotals?: Record<string, number> };

/* ======================== Helpers ======================== */

function pieceFromType(t?: number, fallback?: string): string {
  switch (t) {
    case 1: return 'HEAD';
    case 2: return 'HANDS';
    case 3: return 'BODY';
    case 4: return 'FEET';
    case 5: return 'PLANAR_SPHERE';
    case 6: return 'LINK_ROPE';
    default: return fallback || 'Relic';
  }
}

function prettyProp(k?: string): string {
  if (!k) return '';
  const m: Record<string, string> = {
    HPAddedRatio: 'HP%',
    AttackAddedRatio: 'ATK%',
    DefenceAddedRatio: 'DEF%',
    HPDelta: 'HP',
    AttackDelta: 'ATK',
    DefenceDelta: 'DEF',
    CriticalChance: 'CRIT Rate%',
    CriticalDamage: 'CRIT DMG%',
    SpeedDelta: 'SPD',
    StatusProbability: 'Effect Hit%',
    EffectHitRate: 'Effect Hit%',
    StatusResistance: 'RES%',
    BreakDamageAddedRatio: 'Break%',
    BreakDamageAddedRatioBase: 'Break%',
    WindAddedRatio: 'Wind DMG%',
    QuantumAddedRatio: 'Quantum DMG%',
    IceAddedRatio: 'Ice DMG%',
    FireAddedRatio: 'Fire DMG%',
    PhysicalAddedRatio: 'Physical DMG%',
    ImaginaryAddedRatio: 'Imaginary DMG%',
    LightningAddedRatio: 'Lightning DMG%',
    HealRatioBase: 'Healing%',
    SPRatioBase: 'Energy Regen%',
  };
  return m[k] || k;
}

function fmtStat(k?: string, v?: number): string {
  if (!k || v == null) return '';
  const name = prettyProp(k);
  const isPercent =
    /%$/.test(name) ||
    /AddedRatio|Chance|Damage|Ratio|Base|Resist|Hit|Regen/i.test(k);
  const shown = isPercent ? (v * 100).toFixed(2) : Number(v).toFixed(0);
  return `${name}: ${shown}`;
}

function toRelicSummary(r: HsrRelic): RelicSummary {
  const piece =
    r.flat?.relicType ||
    pieceFromType(r.type) ||
    'Relic';

  // ชื่อ/เซ็ตใน Enka บางครั้งเป็น "hash string" (ตัวเลขยาว)
  const rawName = (r.flat?.name || r._flat?.name || '').trim();
  const rawSet  = (r.flat?.setName || r._flat?.setName || '').trim();

  // ถ้าเป็นเลขล้วน ให้ลองถอดด้วย loc
  const locName = /^\d+$/.test(rawName) ? (_loc?.[rawName] || rawName) : rawName;
  const locSet  = /^\d+$/.test(rawSet)  ? (_loc?.[rawSet]  || rawSet)  : rawSet;

  let main = '';
  let subs: string[] = [];

  if (r.flat?.relicMainstat) {
    main = fmtStat(r.flat.relicMainstat.type, r.flat.relicMainstat.value);
  }
  if (r.flat?.relicSubstats?.length) {
    subs = r.flat.relicSubstats.map((s) => fmtStat(s.type, s.value)).filter(Boolean);
  }

  if (!main && r._flat?.props?.length) {
    const [m, ...rest] = r._flat.props;
    if (m) main = fmtStat(m.type, m.value);
    subs = rest.map((s) => fmtStat(s.type, s.value)).filter(Boolean);
  }

  const level = r.relic?.level ?? r.level ?? undefined;
  return { piece, name: locName, set: locSet || undefined, main, subs, level };
}

async function mapHsrCharacter(c: HsrCharacter): Promise<HsrDetailOut> {
  const id = c.avatarId ?? c.avatar?.id ?? 0;
  // ใช้ชื่อจากแผนที่ระยะไกลก่อน ถ้าไม่มีค่อย fallback ชื่อที่ api ส่งมา
  const resolved = await hsrName(id, c.name ?? c.avatarName);
  const level = c.level ?? 1;
  const srcRelics = Array.isArray(c.relicList)
    ? c.relicList
    : (Array.isArray(c.relics) ? c.relics : []);
  const relics = srcRelics.map(toRelicSummary);
  return { id, name: resolved, level, relics, shownTotals: c.fightPropMap || {} };
}

/* ======================== Core fetch ======================== */

async function fetchHsr(uid: string) {
  // ให้แน่ใจว่า loc + characters พร้อมก่อน
  await loadRemoteMaps();

  const url = `https://enka.network/api/hsr/uid/${encodeURIComponent(uid)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Chatbot/1.0' }, cache: 'no-store' });
  if (!r.ok) return { ok: false as const, status: r.status };

  const j = (await r.json()) as HsrTop;

  const list =
    (j as any).detailInfo?.avatarDetailList ??
    (j as any).playerDetailInfo?.avatarDetailList ??
    (j as any).avatarDetailList ??
    [];

  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false as const, status: 404, error: 'no_public_characters' };
  }

  const detailsArr = await Promise.all(list.map(mapHsrCharacter));
  const characters: CharacterLite[] = detailsArr.map((d) => ({ id: d.id, name: d.name, level: d.level }));
  const player =
    (j as any).detailInfo?.nickname ??
    (j as any).playerDetailInfo?.nickname ??
    (j as any).owner?.nickname ??
    '';

  const uidStr =
    (j as any).uid ??
    (j as any).detailInfo?.uid ??
    (j as any).playerDetailInfo?.uid ??
    '';

  const details = Object.fromEntries(detailsArr.map((d) => [String(d.id), d]));
  return { ok: true as const, game: 'hsr', player, uid: uidStr || uid, characters, details };
}

/* ======================== HTTP ======================== */

export async function POST(req: NextRequest) {
  try {
    const { uid } = (await req.json().catch(() => ({}))) as { uid?: string };
    if (!uid) return NextResponse.json({ ok: false, error: 'missing_uid' }, { status: 400 });

    const out = await fetchHsr(uid);
    if (!out.ok) return NextResponse.json(out, { status: out.status ?? 502 });
    return NextResponse.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const uid = req.nextUrl.searchParams.get('uid') || '';
  if (!uid) return NextResponse.json({ ok: false, error: 'missing_uid' }, { status: 400 });
  const out = await fetchHsr(uid);
  if (!out.ok) return NextResponse.json(out, { status: out.status ?? 502 });
  return NextResponse.json(out);
}
