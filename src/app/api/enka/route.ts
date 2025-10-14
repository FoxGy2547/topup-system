/* src/app/api/enka/route.ts
   ดึงโปรไฟล์จาก enka.network (GI/HSR) + คืนตัวละคร, ของ/เรลิก, อาวุธ, ค่ารวม
   — ไม่มี implicit any — */
import { NextRequest, NextResponse } from "next/server";
import giMap from "@/data/gi_characters.json"; // map id -> ชื่อจริง

type GameKey = "gi" | "hsr";

/* ---------- helper: ชื่อจริงจาก json ---------- */
function giName(id?: number, fallback?: string): string {
  if (!id) return fallback || "";
  return (giMap as Record<string, string>)[String(id)] || fallback || `#${id}`;
}

/* ---------- ชื่อ prop ให้อ่านง่าย (ใช้ได้ทั้ง GI/HSR) ---------- */
const PROP_MAP: Record<string, string> = {
  FIGHT_PROP_BASE_HP: "HP",
  FIGHT_PROP_HP: "HP",
  FIGHT_PROP_HP_PERCENT: "HP%",
  FIGHT_PROP_BASE_ATTACK: "ATK",
  FIGHT_PROP_BASE_ATK: "ATK",
  FIGHT_PROP_ATTACK: "ATK",
  FIGHT_PROP_ATK: "ATK",
  FIGHT_PROP_ATK_PERCENT: "ATK%",
  FIGHT_PROP_BASE_DEFENSE: "DEF",
  FIGHT_PROP_BASE_DEF: "DEF",
  FIGHT_PROP_DEFENSE: "DEF",
  FIGHT_PROP_DEF: "DEF",
  FIGHT_PROP_DEF_PERCENT: "DEF%",
  FIGHT_PROP_CRITICAL: "CRIT Rate%",
  FIGHT_PROP_CRITICAL_HURT: "CRIT DMG%",
  FIGHT_PROP_CRIT_RATE: "CRIT Rate%",
  FIGHT_PROP_CRIT_DMG: "CRIT DMG%",
  FIGHT_PROP_CHARGE_EFFICIENCY: "Energy Recharge%",
  FIGHT_PROP_ELEMENT_MASTERY: "Elemental Mastery",
  FIGHT_PROP_HEAL_ADD: "Healing Bonus%",
  FIGHT_PROP_PHYSICAL_ADD_HURT: "Physical DMG%",
  FIGHT_PROP_FIRE_ADD_HURT: "Pyro DMG%",
  FIGHT_PROP_WATER_ADD_HURT: "Hydro DMG%",
  FIGHT_PROP_WIND_ADD_HURT: "Anemo DMG%",
  FIGHT_PROP_ELEC_ADD_HURT: "Electro DMG%",
  FIGHT_PROP_ICE_ADD_HURT: "Cryo DMG%",
  FIGHT_PROP_ROCK_ADD_HURT: "Geo DMG%",
  FIGHT_PROP_GRASS_ADD_HURT: "Dendro DMG%",
};
function prettyProp(key?: string): string {
  if (!key) return "";
  return PROP_MAP[key] || key;
}
function formatProp(key?: string, val?: number): string {
  const n = prettyProp(key);
  if (!n) return "";
  if (val == null) return n;
  return `${n}: ${Number(val).toFixed(n.endsWith("%") ? 1 : 0)}`;
}

/* ---------- GI Types (ที่ใช้จริง) ---------- */
const GI_SLOT_MAP = {
  EQUIP_BRACER: "Flower",
  EQUIP_NECKLACE: "Plume",
  EQUIP_SHOES: "Sands",
  EQUIP_RING: "Goblet",
  EQUIP_DRESS: "Circlet",
  EQUIP_WEAPON: "Weapon",
} as const;
type GiSlotKey = keyof typeof GI_SLOT_MAP;
type GiPiece =
  | typeof GI_SLOT_MAP["EQUIP_BRACER"]
  | typeof GI_SLOT_MAP["EQUIP_NECKLACE"]
  | typeof GI_SLOT_MAP["EQUIP_SHOES"]
  | typeof GI_SLOT_MAP["EQUIP_RING"]
  | typeof GI_SLOT_MAP["EQUIP_DRESS"]
  | typeof GI_SLOT_MAP["EQUIP_WEAPON"]
  | "Unknown";

type GiReMain = { mainPropId?: string; statType?: string; statValue?: number };
type GiReSub = { appendPropId?: string; statType?: string; statValue?: number };
type GiFlat = {
  equipType?: GiSlotKey | string;
  nameText?: string;
  icon?: string;
  setNameText?: string;
  setNameTextMapHash?: string;
  reliquaryMainstat?: GiReMain;
  reliquarySubstats?: GiReSub[];
  weaponStats?: { appendPropId?: string; statValue?: number }[];
};
type GiEquip = {
  flat?: GiFlat;
  reliquary?: { level?: number };
  weapon?: { level?: number };
};
type GiCharacter = {
  avatarId?: number;
  avatar?: { id?: number };
  name?: string;
  avatarName?: string;
  propMap?: Record<string, { val?: number }>;
  fightPropMap?: Record<string, number>;
  level?: number;
  avatarLevel?: number;
  equipList?: GiEquip[];
};
type GiTop = {
  playerInfo?: { nickname?: string };
  owner?: { nickname?: string };
  player?: { nickname?: string };
  avatarInfoList?: GiCharacter[];
};

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
export type ArtifactSummary = {
  piece: GiPiece;
  name: string;
  set?: string;
  main: string;
  subs: string[];
  level?: number;
  icon?: string; // ยังคง type เดิมไว้ เพื่อไม่ให้ระบบอื่นพัง แต่จะ "ไม่คืนค่า" (undefined)
};
export type RelicSummary = {
  piece: string;
  name: string;
  set?: string;
  main: string;
  subs: string[];
  level?: number;
  icon?: string; // เช่นเดียวกัน ไม่คืนค่า
};

export type CharacterLite = { id: number; name: string; level: number };
export type GiDetail = {
  id: number;
  name: string;
  level: number;
  artifacts: ArtifactSummary[]; // มี Weapon ด้วย
  totalsFromGear: Totals; // รวมจาก main/sub + weapon
  shownTotals?: TotalsShown; // ค่าที่เห็นบนหน้า enka (fightPropMap)
};
export type HsrDetail = {
  id: number;
  name: string;
  level: number;
  relics: RelicSummary[];
  shownTotals?: Record<string, number>;
};

type Totals = {
  er: number;
  cr: number;
  cd: number;
  em: number;
  hp_pct: number;
  atk_pct: number;
  def_pct: number;
};
type TotalsShown = {
  hp?: number;
  atk?: number;
  def?: number;
  em?: number;
  er?: number;
  cr?: number;
  cd?: number;
  pyro?: number;
  hydro?: number;
  cryo?: number;
  electro?: number;
  anemo?: number;
  geo?: number;
  dendro?: number;
  physical?: number;
};

/* ---------- Helpers ---------- */
function safeStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function parseLineToTotal(line: string, acc: Totals): void {
  const [kRaw, vRaw] = line.split(":").map((s) => s.trim());
  if (!kRaw || !vRaw) return;
  const v = Number(vRaw);
  if (!Number.isFinite(v)) return;
  switch (kRaw) {
    case "Energy Recharge%": acc.er += v; break;
    case "CRIT Rate%": acc.cr += v; break;
    case "CRIT DMG%": acc.cd += v; break;
    case "Elemental Mastery": acc.em += v; break;
    case "HP%": acc.hp_pct += v; break;
    case "ATK%": acc.atk_pct += v; break;
    case "DEF%": acc.def_pct += v; break;
    default: break;
  }
}
function calcTotalsFromArtifacts(arts: ArtifactSummary[]): Totals {
  const acc: Totals = { er: 0, cr: 0, cd: 0, em: 0, hp_pct: 0, atk_pct: 0, def_pct: 0 };
  for (const a of arts) {
    if (a.main) parseLineToTotal(a.main, acc);
    for (const s of a.subs) parseLineToTotal(s, acc);
  }
  return acc;
}

/* ---------- GI mappers (ทนเคสอาวุธ & ไม่คืน icon) ---------- */
function mapGiEquip(e: GiEquip): ArtifactSummary {
  const flat = e.flat ?? {};

  // Enka บางเคสไม่ส่ง equipType → ใช้ทั้ง flag e.weapon และเช็คข้อความ "WEAPON"
  const looksLikeWeapon =
    !!e.weapon || String(flat.equipType || "").toUpperCase().includes("WEAPON");

  let slot: GiPiece;
  if (looksLikeWeapon) {
    slot = "Weapon";
  } else {
    const slotRaw = flat.equipType;
    slot =
      slotRaw && (GI_SLOT_MAP as Record<string, GiPiece>)[slotRaw as string]
        ? (GI_SLOT_MAP as Record<string, GiPiece>)[slotRaw as string]
        : "Unknown";
  }

  const main = looksLikeWeapon
    ? (flat.weaponStats && flat.weaponStats.length > 0
        ? formatProp(flat.weaponStats[0].appendPropId, flat.weaponStats[0].statValue)
        : "")
    : (flat.reliquaryMainstat
        ? formatProp(
            flat.reliquaryMainstat.mainPropId || flat.reliquaryMainstat.statType,
            flat.reliquaryMainstat.statValue
          )
        : "");

  const subs: string[] = looksLikeWeapon
    ? (flat.weaponStats && flat.weaponStats.length > 1
        ? flat.weaponStats.slice(1).map((ws) => formatProp(ws.appendPropId, ws.statValue))
        : [])
    : ((flat.reliquarySubstats ?? []).map((s) =>
        formatProp(s.appendPropId || s.statType, s.statValue)
      ));

  const name = safeStr(flat.nameText);
  const setName = safeStr(flat.setNameText) || safeStr(flat.setNameTextMapHash);
  const setGuess = looksLikeWeapon ? "" : (setName || (name ? name.split("'s")[0]?.trim() : ""));

  return {
    piece: slot,
    name,
    set: setGuess || undefined,
    main,
    subs,
    level: e.reliquary?.level ?? e.weapon?.level ?? undefined,
    icon: undefined, // << ไม่คืนไอคอนจาก Enka แล้วจ้า
  };
}

function mapGiShownTotals(c: GiCharacter): TotalsShown {
  const fp = c.fightPropMap || {};
  const get = (k: string): number | undefined => {
    const v = fp[k];
    return typeof v === "number" ? v : undefined;
  };
  return {
    hp: get("FIGHT_PROP_HP"),
    atk: get("FIGHT_PROP_ATTACK"),
    def: get("FIGHT_PROP_DEFENSE"),
    em: get("FIGHT_PROP_ELEMENT_MASTERY"),
    er: get("FIGHT_PROP_CHARGE_EFFICIENCY"),
    cr: get("FIGHT_PROP_CRITICAL"),
    cd: get("FIGHT_PROP_CRITICAL_HURT"),
    pyro: get("FIGHT_PROP_FIRE_ADD_HURT"),
    hydro: get("FIGHT_PROP_WATER_ADD_HURT"),
    cryo: get("FIGHT_PROP_ICE_ADD_HURT"),
    electro: get("FIGHT_PROP_ELEC_ADD_HURT"),
    anemo: get("FIGHT_PROP_WIND_ADD_HURT"),
    geo: get("FIGHT_PROP_ROCK_ADD_HURT"),
    dendro: get("FIGHT_PROP_GRASS_ADD_HURT"),
    physical: get("FIGHT_PROP_PHYSICAL_ADD_HURT"),
  };
}

function mapGiCharacter(c: GiCharacter): GiDetail {
  const id = c.avatarId ?? c.avatar?.id ?? 0;
  const name = giName(id, c.name ?? c.avatarName);
  const level = c.propMap?.["4001"]?.val ?? c.level ?? c.avatarLevel ?? 1;

  const equips: GiEquip[] = Array.isArray(c.equipList) ? c.equipList : [];
  const mapped: ArtifactSummary[] = equips
    .map((eq) => mapGiEquip(eq))
    .filter((x) => x.piece !== "Unknown")
    .sort((a, b) => {
      const order: GiPiece[] = ["Weapon", "Flower", "Plume", "Sands", "Goblet", "Circlet", "Unknown"];
      return order.indexOf(a.piece) - order.indexOf(b.piece);
    });

  const totalsFromGear = calcTotalsFromArtifacts(mapped);
  const shownTotals = mapGiShownTotals(c);

  return { id, name, level, artifacts: mapped, totalsFromGear, shownTotals };
}

/* ---------- HSR mappers (ไม่คืน icon) ---------- */
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
    icon: undefined, // << ไม่คืนไอคอนจาก Enka แล้วจ้า
  };
}
function mapHsrCharacter(c: HsrCharacter): HsrDetail {
  const id = c.avatarId ?? c.avatar?.id ?? 0;
  const name = giName(id, c.name ?? c.avatarName);
  const level = c.level ?? 1;
  const relics: RelicSummary[] = (c.relics ?? []).map((r) => mapHsrRelic(r));
  return { id, name, level, relics, shownTotals: c.fightPropMap || {} };
}

/* ---------- Route ---------- */
export async function POST(req: NextRequest) {
  try {
    const { game = "gi", uid } = (await req.json().catch(() => ({}))) as { game?: GameKey; uid?: string };
    if (!uid) return NextResponse.json({ ok: false, error: "missing_uid" }, { status: 400 });

    const base = game === "hsr" ? "https://enka.network/api/hsr/uid/" : "https://enka.network/api/uid/";
    const url = base + encodeURIComponent(uid);

    const r = await fetch(url, { headers: { "User-Agent": "Chatbot/1.0" }, cache: "no-store" });
    if (!r.ok) return NextResponse.json({ ok: false, error: "fetch_failed", status: r.status }, { status: 502 });

    if (game === "gi") {
      const j = (await r.json()) as GiTop;
      const list: GiCharacter[] = j.avatarInfoList ?? [];
      if (!Array.isArray(list) || list.length === 0) {
        return NextResponse.json({ ok: false, error: "no_public_characters" }, { status: 404 });
      }
      const detailsArr = list.map(mapGiCharacter);
      const characters: CharacterLite[] = detailsArr.map((d) => ({ id: d.id, name: d.name, level: d.level }));
      const player = j.playerInfo?.nickname ?? j.owner?.nickname ?? j.player?.nickname ?? "";
      const details = Object.fromEntries(detailsArr.map((d) => [String(d.id), d]));
      return NextResponse.json({ ok: true, game: "gi", player, uid, characters, details });
    } else {
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
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[enka] error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
