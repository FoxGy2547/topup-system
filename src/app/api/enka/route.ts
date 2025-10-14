/* src/app/api/enka/route.ts
   ดึงโปรไฟล์จาก enka.network (GI/HSR) แล้วสรุปตัวละคร + ของ/เรลิก
   — ไม่มี any — */

import { NextRequest, NextResponse } from "next/server";

type GameKey = "gi" | "hsr";

/* ---------- Common helpers ---------- */
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

function safeStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/* ---------- Types: GI (ตามโครงจริงที่ต้องใช้) ---------- */
type GiReMain = {
  mainPropId?: string;
  statType?: string;
  statValue?: number;
};
type GiReSub = {
  appendPropId?: string;
  statType?: string;
  statValue?: number;
};
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
  playerInfo?: { nickname?: string };
  propMap?: Record<string, { val?: number }>;
  level?: number;
  avatarLevel?: number;
  equipList?: GiEquip[];
};

type GiTop = {
  playerInfo?: { nickname?: string };
  owner?: { nickname?: string };
  player?: { nickname?: string };
  avatarInfoList?: GiCharacter[]; // บางเวอร์ชัน
  playerInfoList?: unknown;
  showAvatarInfoList?: unknown;
};

/* ---------- Types: HSR (ย่อเฉพาะที่ใช้) ---------- */
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
type HsrRelic = {
  flat?: HsrFlat;
  relic?: { level?: number };
};
type HsrCharacter = {
  avatarId?: number;
  avatar?: { id?: number };
  name?: string;
  avatarName?: string;
  level?: number;
  relics?: HsrRelic[];
};
type HsrTop = {
  playerDetailInfo?: { nickname?: string; avatarDetailList?: HsrCharacter[] };
  owner?: { nickname?: string };
  avatarDetailList?: HsrCharacter[];
};

/* ---------- Output types ---------- */
type ArtifactSummary = {
  piece: GiPiece;
  name: string;
  set?: string;
  main: string;
  subs: string[];
  level?: number;
  icon?: string;
};
type RelicSummary = {
  piece: string;
  name: string;
  set?: string;
  main: string;
  subs: string[];
  level?: number;
  icon?: string;
};
type CharacterLite = { id: number; name: string; level: number };
type GiDetail = { id: number; name: string; level: number; artifacts: ArtifactSummary[] };
type HsrDetail = { id: number; name: string; level: number; relics: RelicSummary[] };

/* ---------- Mappers (GI) ---------- */
function mapGiEquip(e: GiEquip): ArtifactSummary {
  const flat = e.flat ?? {};
  const slotRaw = flat.equipType;
  const slot: GiPiece =
    (slotRaw && GI_SLOT_MAP[slotRaw as GiSlotKey]) ?
      GI_SLOT_MAP[slotRaw as GiSlotKey] :
      "Unknown";

  const name = safeStr(flat.nameText);
  const main =
    flat.reliquaryMainstat
      ? `${safeStr(flat.reliquaryMainstat.mainPropId, safeStr(flat.reliquaryMainstat.statType))}:${flat.reliquaryMainstat.statValue ?? ""}`
      : flat.weaponStats?.length
      ? `${safeStr(flat.weaponStats[0].appendPropId)}:${flat.weaponStats[0].statValue ?? ""}`
      : "";

  const subs: string[] = [];
  (flat.reliquarySubstats ?? []).forEach((s) => {
    const k = safeStr(s.appendPropId, safeStr(s.statType));
    const v = s.statValue;
    subs.push(v != null ? `${k}:${v}` : k);
  });

  const setName = safeStr(flat.setNameText) || safeStr(flat.setNameTextMapHash);
  const setGuess = setName || (name ? name.split("'s")[0]?.trim() : "");

  return {
    piece: slot,
    name,
    set: setGuess || undefined,
    main,
    subs,
    level: e.reliquary?.level ?? e.weapon?.level ?? undefined,
    icon: safeStr(flat.icon) || undefined,
  };
}

function mapGiCharacter(c: GiCharacter): GiDetail {
  const id = c.avatarId ?? c.avatar?.id ?? 0;
  const name = c.name ?? c.avatarName ?? "Character";
  const level =
    c.propMap?.["4001"]?.val ??
    c.level ??
    c.avatarLevel ??
    1;

  const equips: GiEquip[] = Array.isArray(c.equipList) ? c.equipList : [];
  const mapped: ArtifactSummary[] = equips
    .map((eq: GiEquip) => mapGiEquip(eq))
    .filter((x: ArtifactSummary) => x.piece !== "Weapon" && x.piece !== "Unknown")
    .sort((a: ArtifactSummary, b: ArtifactSummary) => {
      const order: GiPiece[] = ["Flower", "Plume", "Sands", "Goblet", "Circlet", "Weapon", "Unknown"];
      return order.indexOf(a.piece) - order.indexOf(b.piece);
    });

  return { id, name, level, artifacts: mapped };
}

/* ---------- Mappers (HSR) ---------- */
function mapHsrRelic(r: HsrRelic): RelicSummary {
  const flat = r.flat ?? {};
  const main = flat.relicMainstat ? `${safeStr(flat.relicMainstat.type)}:${flat.relicMainstat.value ?? ""}` : "";
  const subs: string[] = [];
  (flat.relicSubstats ?? []).forEach((s) => subs.push(`${safeStr(s.type)}:${s.value ?? ""}`));
  return {
    piece: safeStr(flat.relicType),
    name: safeStr(flat.name),
    set: safeStr(flat.setName) || undefined,
    main,
    subs,
    level: r.relic?.level ?? undefined,
    icon: safeStr(flat.icon) || undefined,
  };
}

function mapHsrCharacter(c: HsrCharacter): HsrDetail {
  const id = c.avatarId ?? c.avatar?.id ?? 0;
  const name = c.name ?? c.avatarName ?? "Character";
  const level = c.level ?? 1;
  const relics: RelicSummary[] = (c.relics ?? []).map((r: HsrRelic) => mapHsrRelic(r));
  return { id, name, level, relics };
}

/* ---------- Route ---------- */
export async function POST(req: NextRequest) {
  try {
    const { game = "gi", uid } = (await req.json().catch(() => ({}))) as {
      game?: GameKey;
      uid?: string;
    };
    if (!uid) return NextResponse.json({ ok: false, error: "missing_uid" }, { status: 400 });

    const base = game === "hsr"
      ? "https://enka.network/api/hsr/uid/"
      : "https://enka.network/api/uid/";
    const url = base + encodeURIComponent(uid);

    const r = await fetch(url, { headers: { "User-Agent": "Chatbot/1.0" }, cache: "no-store" });
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: "fetch_failed", status: r.status }, { status: 502 });
    }

    if (game === "gi") {
      const j = (await r.json()) as unknown as GiTop;

      const list: GiCharacter[] =
        (j.avatarInfoList as GiCharacter[] | undefined) ?? [];

      if (!Array.isArray(list) || list.length === 0) {
        return NextResponse.json({ ok: false, error: "no_public_characters" }, { status: 404 });
      }

      const detailsArr: GiDetail[] = list.map((c: GiCharacter) => mapGiCharacter(c));
      const characters: CharacterLite[] = detailsArr.map((d) => ({
        id: d.id, name: d.name, level: d.level,
      }));

      const player =
        j.playerInfo?.nickname ??
        j.owner?.nickname ??
        j.player?.nickname ??
        "";

      const detailsRecord: Record<string, GiDetail> =
        Object.fromEntries(detailsArr.map((d) => [String(d.id), d]));

      return NextResponse.json({
        ok: true,
        game: "gi",
        player,
        uid,
        characters,
        details: detailsRecord,
      });
    } else {
      const j = (await r.json()) as unknown as HsrTop;
      const list: HsrCharacter[] =
        j.playerDetailInfo?.avatarDetailList ??
        j.avatarDetailList ??
        [];

      if (!Array.isArray(list) || list.length === 0) {
        return NextResponse.json({ ok: false, error: "no_public_characters" }, { status: 404 });
      }

      const detailsArr: HsrDetail[] = list.map((c: HsrCharacter) => mapHsrCharacter(c));
      const characters: CharacterLite[] = detailsArr.map((d) => ({
        id: d.id, name: d.name, level: d.level,
      }));

      const player = j.playerDetailInfo?.nickname ?? j.owner?.nickname ?? "";

      const detailsRecord: Record<string, HsrDetail> =
        Object.fromEntries(detailsArr.map((d) => [String(d.id), d]));

      return NextResponse.json({
        ok: true,
        game: "hsr",
        player,
        uid,
        characters,
        details: detailsRecord,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[enka] error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
