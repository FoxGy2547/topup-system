/* src/app/api/enka-hsr/route.ts
   ดึงโปรไฟล์จาก enka.network สำหรับ Honkai: Star Rail เท่านั้น + คืนตัวละคร/เรลิก + ค่าบนหน้า enka
   — ไม่มี implicit any — */
import { NextRequest, NextResponse } from "next/server";

/* ---------- ชื่อ prop ให้อ่านง่าย (HSR) ---------- */
const PROP_MAP: Record<string, string> = {
  FIGHT_PROP_HP: "HP",
  FIGHT_PROP_ATTACK: "ATK",
  FIGHT_PROP_DEFENSE: "DEF",
  FIGHT_PROP_SPEED: "SPD",
  FIGHT_PROP_CRIT_RATE: "CRIT Rate%",
  FIGHT_PROP_CRIT_DMG: "CRIT DMG%",
  FIGHT_PROP_BREAK_UP: "Break Effect%",
  FIGHT_PROP_ENERGY_REGENERATION: "Energy Regeneration Rate%",
  FIGHT_PROP_EFFECT_HIT_RATE: "Effect Hit Rate%",
  FIGHT_PROP_STATUS_RESISTANCE: "Effect RES%",
  FIGHT_PROP_FIRE_ADD_HURT: "Fire DMG%",
  FIGHT_PROP_ICE_ADD_HURT: "Ice DMG%",
  FIGHT_PROP_WIND_ADD_HURT: "Wind DMG%",
  FIGHT_PROP_THUNDER_ADD_HURT: "Lightning DMG%",
  FIGHT_PROP_PHYSICAL_ADD_HURT: "Physical DMG%",
  FIGHT_PROP_QUANTUM_ADD_HURT: "Quantum DMG%",
  FIGHT_PROP_IMAGINARY_ADD_HURT: "Imaginary DMG%",
};
function prettyProp(key?: string): string {
  if (!key) return "";
  return PROP_MAP[key] || key;
}

/* ---------- HSR Types (ที่ใช้จริง) ---------- */
type HsrMain = { type?: string; value?: number };
type HsrSub = { type?: string; value?: number };
type HsrFlat = {
  relicType?: string; // HEAD / HANDS / BODY / FEET / PLANAR_SPHERE / LINK_ROPE
  name?: string;
  setName?: string;
  icon?: string;
  relicMainstat?: HsrMain;
  relicSubstats?: HsrSub[];
};
type HsrRelic = { flat?: HsrFlat; relic?: { level?: number } };
type HsrCharacter = {
  avatarId?: number;
  avatar?: { id?: number };
  name?: string;
  avatarName?: string;
  level?: number;
  relics?: HsrRelic[];
  fightPropMap?: Record<string, number>;
};
type HsrTop = {
  playerDetailInfo?: { nickname?: string; avatarDetailList?: HsrCharacter[] };
  owner?: { nickname?: string };
  avatarDetailList?: HsrCharacter[];
};

/* ---------- Output ---------- */
export type RelicSummary = {
  piece: string;
  name: string;
  set?: string;
  main: string;
  subs: string[];
  level?: number;
  icon?: string; // intentionally undefined
};
export type CharacterLite = { id: number; name: string; level: number };
export type HsrDetail = {
  id: number;
  name: string;
  level: number;
  relics: RelicSummary[];
  shownTotals?: Record<string, number>;
};

/* ---------- Helpers ---------- */
function safeStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function mapHsrRelic(r: HsrRelic): RelicSummary {
  const flat = r.flat ?? {};
  const main = flat.relicMainstat
    ? `${prettyProp(flat.relicMainstat.type)}: ${flat.relicMainstat.value ?? ""}`
    : "";
  const subs: string[] = (flat.relicSubstats ?? []).map((s) => `${prettyProp(s.type)}: ${s.value ?? ""}`);
  return {
    piece: safeStr(flat.relicType),
    name: safeStr(flat.name),
    set: safeStr(flat.setName) || undefined,
    main,
    subs,
    level: r.relic?.level ?? undefined,
    icon: undefined,
  };
}
function mapHsrCharacter(c: HsrCharacter): HsrDetail {
  const id = c.avatarId ?? c.avatar?.id ?? 0;
  const name = (c.name ?? c.avatarName ?? `#${id}`).toString();
  const level = c.level ?? 1;
  const relics: RelicSummary[] = (c.relics ?? []).map((r) => mapHsrRelic(r));
  return { id, name, level, relics, shownTotals: c.fightPropMap || {} };
}

/* ---------- Route ---------- */
export async function POST(req: NextRequest) {
  try {
    const { uid } = (await req.json().catch(() => ({}))) as { uid?: string };
    if (!uid) return NextResponse.json({ ok: false, error: "missing_uid" }, { status: 400 });

    const url = "https://enka.network/api/hsr/uid/" + encodeURIComponent(uid);
    const r = await fetch(url, { headers: { "User-Agent": "Chatbot/1.0" }, cache: "no-store" });
    if (!r.ok) return NextResponse.json({ ok: false, error: "fetch_failed", status: r.status }, { status: 502 });

    const j = (await r.json()) as HsrTop;
    const list: HsrCharacter[] = j.playerDetailInfo?.avatarDetailList ?? j.avatarDetailList ?? [];
    if (!Array.isArray(list) || list.length === 0) {
      return NextResponse.json({ ok: false, error: "no_public_characters" }, { status: 404 });
    }
    const detailsArr = list.map(mapHsrCharacter);
    const characters: CharacterLite[] = detailsArr.map((d) => ({ id: d.id, name: d.name, level: d.level }));
    const player = j.playerDetailInfo?.nickname ?? j.owner?.nickname ?? "";
    const details = Object.fromEntries(detailsArr.map((d) => [String(d.id), d]));
    return NextResponse.json({ ok: true, game: "hsr", player, uid, characters, details });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[enka-hsr] error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
