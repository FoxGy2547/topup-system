/* src/app/api/enka-hsr/route.ts
   ดึงโปรไฟล์จาก enka.network (HSR) + คืน characters & details แบบย่อ
   เน้นให้ “ดึงได้ก่อน” และ shape ใกล้เคียงฝั่ง GI ที่คุณใช้อยู่ */

import { NextRequest, NextResponse } from "next/server";

/* ---------- Minimal types จาก response ปัจจุบันของ enka HSR ---------- */
type HsrProp = { type?: string; value?: number };
type HsrRelic = {
  type?: number;                      // 1..6
  level?: number;
  _flat?: { name?: string; setName?: string; props?: HsrProp[] }; // บางฟอร์แมต
  flat?: {
    relicType?: string; name?: string; setName?: string;
    relicMainstat?: HsrProp; relicSubstats?: HsrProp[];
  };
  relic?: { level?: number };         // บางฟอร์แมต
};

type HsrCharacter = {
  avatarId?: number;
  avatar?: { id?: number };
  name?: string;
  avatarName?: string;
  level?: number;
  relicList?: HsrRelic[];             // ชื่อใน detailInfo
  relics?: HsrRelic[];                // เผื่ออีกฟอร์แมต
  fightPropMap?: Record<string, number>;
};

type HsrTop =
  | { detailInfo?: { nickname?: string; avatarDetailList?: HsrCharacter[] }; uid?: string }
  | { playerDetailInfo?: { nickname?: string; avatarDetailList?: HsrCharacter[] }; uid?: string }
  | { owner?: { nickname?: string }; avatarDetailList?: HsrCharacter[]; uid?: string };

/* ---------- Output shape ให้เข้ากับโค้ดหลัก ---------- */
type CharacterLite = { id: number; name: string; level: number };
type RelicSummary = { piece: string; name: string; set?: string; main: string; subs: string[]; level?: number };
type HsrDetailOut = { id: number; name: string; level: number; relics: RelicSummary[]; shownTotals?: Record<string, number> };

/* ---------- Helpers ---------- */
function pieceFromType(t?: number, fallback?: string): string {
  switch (t) {
    case 1: return "HEAD";
    case 2: return "HANDS";
    case 3: return "BODY";
    case 4: return "FEET";
    case 5: return "PLANAR_SPHERE";
    case 6: return "LINK_ROPE";
    default: return fallback || "Relic";
  }
}

function prettyProp(k?: string): string {
  if (!k) return "";
  const m: Record<string, string> = {
    HPAddedRatio: "HP%",
    AttackAddedRatio: "ATK%",
    DefenceAddedRatio: "DEF%",
    HPDelta: "HP",
    AttackDelta: "ATK",
    DefenceDelta: "DEF",
    CriticalChance: "CRIT Rate%",
    CriticalDamage: "CRIT DMG%",
    SpeedDelta: "SPD",
    StatusProbability: "Effect Hit%",
    EffectHitRate: "Effect Hit%",
    StatusResistance: "RES%",
    BreakDamageAddedRatio: "Break%",
    BreakDamageAddedRatioBase: "Break%",
    WindAddedRatio: "Wind DMG%",
    QuantumAddedRatio: "Quantum DMG%",
    IceAddedRatio: "Ice DMG%",
    FireAddedRatio: "Fire DMG%",
    PhysicalAddedRatio: "Physical DMG%",
    ImaginaryAddedRatio: "Imaginary DMG%",
    LightningAddedRatio: "Lightning DMG%",
    HealRatioBase: "Healing%",
    SPRatioBase: "Energy Regen%",
  };
  return m[k] || k;
}

function fmtStat(k?: string, v?: number): string {
  if (!k || v == null) return "";
  const name = prettyProp(k);
  const isPercent = /%$/.test(name) || /AddedRatio|Chance|Damage|Ratio|Base|Resist|Hit|Regen/i.test(k);
  const shown = isPercent ? (v * 100).toFixed(2) : Number(v).toFixed(0);
  return `${name}: ${shown}`;
}

function toRelicSummary(r: HsrRelic): RelicSummary {
  const piece =
    r.flat?.relicType ||
    pieceFromType(r.type) ||
    "Relic";

  let name = r.flat?.name || r._flat?.name || "";
  let set = r.flat?.setName || r._flat?.setName || undefined;

  let main = "";
  let subs: string[] = [];

  if (r.flat?.relicMainstat) main = fmtStat(r.flat.relicMainstat.type, r.flat.relicMainstat.value);
  if (r.flat?.relicSubstats?.length) subs = r.flat.relicSubstats.map(s => fmtStat(s.type, s.value)).filter(Boolean);

  // ฟอร์แมตอีกแบบ (_flat.props) main = index 0
  if (!main && r._flat?.props?.length) {
    const [m, ...rest] = r._flat.props;
    if (m) main = fmtStat(m.type, m.value);
    subs = rest.map(s => fmtStat(s.type, s.value)).filter(Boolean);
  }

  const level = r.relic?.level ?? r.level ?? undefined;
  return { piece, name, set, main, subs, level };
}

function mapHsrCharacter(c: HsrCharacter): HsrDetailOut {
  const id = c.avatarId ?? c.avatar?.id ?? 0;
  const name = c.name ?? c.avatarName ?? `#${id}`;
  const level = c.level ?? 1;
  const srcRelics = Array.isArray(c.relicList) ? c.relicList : (Array.isArray(c.relics) ? c.relics : []);
  const relics = srcRelics.map(toRelicSummary);
  return { id, name, level, relics, shownTotals: c.fightPropMap || {} };
}

/* ---------- Core fetch ---------- */
async function fetchHsr(uid: string) {
  const url = `https://enka.network/api/hsr/uid/${encodeURIComponent(uid)}`;
  const r = await fetch(url, { headers: { "User-Agent": "Chatbot/1.0" }, cache: "no-store" });
  if (!r.ok) return { ok: false as const, status: r.status };

  const j = (await r.json()) as HsrTop;

  const list: HsrCharacter[] =
    (j as any).detailInfo?.avatarDetailList ??
    (j as any).playerDetailInfo?.avatarDetailList ??
    (j as any).avatarDetailList ??
    [];

  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false as const, status: 404, error: "no_public_characters" };
  }

  const detailsArr = list.map(mapHsrCharacter);
  const characters: CharacterLite[] = detailsArr.map(d => ({ id: d.id, name: d.name, level: d.level }));
  const player =
    (j as any).detailInfo?.nickname ??
    (j as any).playerDetailInfo?.nickname ??
    (j as any).owner?.nickname ??
    "";

  const details = Object.fromEntries(detailsArr.map(d => [String(d.id), d]));
  return { ok: true as const, game: "hsr", player, uid, characters, details };
}

/* ---------- POST (ใช้งานจริง) ---------- */
export async function POST(req: NextRequest) {
  try {
    const { uid } = (await req.json().catch(() => ({}))) as { uid?: string };
    if (!uid) return NextResponse.json({ ok: false, error: "missing_uid" }, { status: 400 });

    const out = await fetchHsr(uid);
    if (!out.ok) return NextResponse.json(out, { status: out.status ?? 502 });
    return NextResponse.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/* ---------- GET (ไว้เทสในเบราว์เซอร์) ---------- */
export async function GET(req: NextRequest) {
  const uid = req.nextUrl.searchParams.get("uid") || "";
  if (!uid) return NextResponse.json({ ok: false, error: "missing_uid" }, { status: 400 });
  const out = await fetchHsr(uid);
  if (!out.ok) return NextResponse.json(out, { status: out.status ?? 502 });
  return NextResponse.json(out);
}
