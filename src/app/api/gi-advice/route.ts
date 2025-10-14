// /src/app/api/gi-advice/route.ts
import { NextRequest, NextResponse } from "next/server";
import * as dbAny from "@/lib/db";

/* ---------- Types ---------- */
type Row = {
  character_key?: string;
  character_name?: string;
  hp_base?: number; atk_base?: number; def_base?: number; em_base?: number;
  er_pct?: number; cr_pct?: number; cd_pct?: number;
  pyro_dmg_pct?: number; hydro_dmg_pct?: number; cryo_dmg_pct?: number;
  electro_dmg_pct?: number; anemo_dmg_pct?: number; geo_dmg_pct?: number;
  dendro_dmg_pct?: number; phys_dmg_pct?: number; physical_dmg_pct?: number;
};
type ElementKey = "pyro" | "hydro" | "cryo" | "electro" | "anemo" | "geo" | "dendro" | "physical";
type StatTotals = Partial<{ hp: number; atk: number; def: number; em: number; er: number; cr: number; cd: number; elem_dmg: number }>;
type AdvicePayload = {
  mode?: "base" | "advice";
  character?: string;
  role?: string;
  element?: ElementKey;
  stats?: StatTotals;
  statsAreTotals?: boolean;
  gear?: Record<string, { set?: string; main?: string; subs?: string[] }>;
};

/* ---------- DB helpers ---------- */
const TABLES = ["gi_characters", "characters", "gi_base", "gi_character_base"];

async function dbQuery(sql: string, params: unknown[] = []) {
  const mod: any = dbAny;
  if (typeof mod?.query === "function") return normalizeResult(await mod.query(sql, params));
  if (mod?.pool?.query) return normalizeResult(await mod.pool.query(sql, params));
  if (mod?.default) {
    const d: any = mod.default;
    if (typeof d === "function") return normalizeResult(await d(sql, params));
    if (typeof d?.query === "function") return normalizeResult(await d.query(sql, params));
    if (d?.pool?.query) return normalizeResult(await d.pool.query(sql, params));
  }
  throw new Error('No usable query() found in "@/lib/db".');
}
function normalizeResult(res: any): any[] {
  if (Array.isArray(res) && Array.isArray(res[0])) return res[0];
  if (res?.rows) return res.rows;
  if (Array.isArray(res)) return res;
  return [];
}
async function findBaseRow(nameOrKey: string): Promise<Row | null> {
  for (const t of TABLES) {
    try {
      const rows: any[] = await dbQuery(
        `SELECT * FROM ${t} WHERE character_key = ? OR character_name = ? LIMIT 1`,
        [nameOrKey, nameOrKey]
      );
      if (rows && rows[0]) return rows[0] as Row;
    } catch {}
  }
  return null;
}
function rowToBase(row: Row) {
  return {
    hp: row.hp_base ?? 0,
    atk: row.atk_base ?? 0,
    def: row.def_base ?? 0,
    em: row.em_base ?? 0,
    er: row.er_pct ?? 0,
    cr: row.cr_pct ?? 0,
    cd: row.cd_pct ?? 0,
    elem: {
      pyro: row.pyro_dmg_pct ?? 0,
      hydro: row.hydro_dmg_pct ?? 0,
      cryo: row.cryo_dmg_pct ?? 0,
      electro: row.electro_dmg_pct ?? 0,
      anemo: row.anemo_dmg_pct ?? 0,
      geo: row.geo_dmg_pct ?? 0,
      dendro: row.dendro_dmg_pct ?? 0,
      physical: row.phys_dmg_pct ?? row.physical_dmg_pct ?? 0,
    },
  };
}
function detectElementFromBase(base: ReturnType<typeof rowToBase>): ElementKey | null {
  const entries = Object.entries(base.elem) as [ElementKey, number][];
  let best: ElementKey | null = null;
  let bestVal = 0;
  for (const [k, v] of entries) {
    if ((v ?? 0) > bestVal) { bestVal = v ?? 0; best = k; }
  }
  return bestVal > 0 ? best : null;
}

/* ---------- Targets + gap ---------- */
const OVERRIDES: Record<string, Partial<StatTotals> & { er?: number; cr?: number; cd?: number }> = {
  xiangling: { er: 180, cr: 70, cd: 140 },
  bennett: { er: 180, cr: 60, cd: 120 },
  xingqiu: { er: 220, cr: 60, cd: 120 },
  raidenshogun: { er: 220, cr: 65, cd: 130 },
  furina: { er: 130, cr: 70, cd: 140 },
  yelan: { er: 220, cr: 60, cd: 120 },
  neuvillette: { er: 110, cr: 65, cd: 140 },
  nahida: { er: 120, em: 800, cr: 60, cd: 120 },
  kazuha: { er: 140, em: 800, cr: 0, cd: 0 },
};
function toKey(s = "") { return s.toLowerCase().replace(/\s+/g, ""); }
function targetsFor(character: string, role?: string) {
  const key = toKey(character);
  const base = { er: role?.toLowerCase().includes("burst") || role?.toLowerCase().includes("off") ? 160 : 130, cr: 70, cd: 140 };
  return { ...base, ...(OVERRIDES[key] ?? {}) };
}
function gap(current?: number, target?: number) {
  if (current == null || target == null) return null;
  const need = +(target - current).toFixed(1);
  return { target, current, diff: need, status: need <= 0 ? "ok" : "need" };
}
function buildGapReport(character: string, stats?: StatTotals, role?: string) {
  const tg = targetsFor(character, role);
  const report: Record<string, unknown> = {};
  (report as any).er = gap(stats?.er, tg.er);
  (report as any).cr = gap(stats?.cr, tg.cr);
  (report as any).cd = gap(stats?.cd, tg.cd);
  if ((tg as any).em) (report as any).em = gap(stats?.em, (tg as any).em);
  if ((tg as any).elem_dmg) (report as any).elem_dmg = gap(stats?.elem_dmg, (tg as any).elem_dmg);
  if (stats?.cr != null && stats?.cd != null) {
    const idealCd = +(stats.cr * 2).toFixed(1);
    (report as any).crit_ratio = { ideal_cd_for_cr: idealCd, ratio_ok: stats.cd >= idealCd - 10 && stats.cd <= idealCd + 30 };
  }
  return { targets: tg, gaps: report };
}

/* ---------- Merge totals with base ---------- */
function mergeWithBase(
  user: StatTotals | undefined,
  base: ReturnType<typeof rowToBase> | null,
  element?: ElementKey,
  statsAreTotals?: boolean
): StatTotals {
  const u = user || {};
  if (!base || statsAreTotals) return { ...u };
  const usedElem = element || detectElementFromBase(base) || undefined;
  const elemBonus = usedElem ? base.elem[usedElem] : 0;
  return {
    hp: (u.hp ?? 0) + (base.hp ?? 0),
    atk: (u.atk ?? 0) + (base.atk ?? 0),
    def: (u.def ?? 0) + (base.def ?? 0),
    em: (u.em ?? 0) + (base.em ?? 0),
    er: (u.er ?? 0) + (base.er ?? 0),
    cr: (u.cr ?? 0) + (base.cr ?? 0),
    cd: (u.cd ?? 0) + (base.cd ?? 0),
    elem_dmg: (u.elem_dmg ?? 0) + (elemBonus ?? 0),
  };
}

/* ---------- Gemini ---------- */
function gearToLines(gear: Record<string, any>) {
  const lines: string[] = [];
  for (const [slot, it] of Object.entries(gear || {})) {
    lines.push(`- ${slot}: set=${(it as any)?.set ?? "-"} | main=${(it as any)?.main ?? "-"} | subs=[${(((it as any)?.subs ?? []) as string[]).join(", ")}]`);
  }
  return lines.join("\n");
}
function makePrompt(character: string, role: string | undefined, gear: Record<string, any>, totals: StatTotals, targets: any, gaps: any, element?: ElementKey) {
  return [
    `คุณเป็นผู้เชี่ยวชาญ Genshin Impact ช่วยวิเคราะห์ให้ “${character}” เป็นภาษาไทยแบบกระชับ อ่านง่าย`,
    role ? `บทบาท/สไตล์ที่ผู้ใช้ระบุ: ${role}` : ``,
    element ? `ธาตุที่ใช้ในการคำนวณ DMG%: ${element}` : ``,
    `ค่าสรุปรวมหลังบวก Base Lv90: ${JSON.stringify(totals)}`,
    `เป้าหมายโดยประมาณ: ${JSON.stringify(targets)}`,
    `ส่วนต่างที่ยังขาด/เกิน: ${JSON.stringify(gaps)}`,
    `ชิ้นที่มีตอนนี้:\n${gearToLines(gear)}`,
    `ช่วยบอกว่าอะไร "ขาด" หรือ "เกิน" พร้อมข้อเสนอแนะที่ทำได้จริง และสรุปเป็นเช็คลิสต์ 3 ข้อท้ายข้อความ`,
  ].filter(Boolean).join("\n\n");
}
async function callGemini(prompt: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + encodeURIComponent(key);
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, maxOutputTokens: 600 } };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  const text = (j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "") as string;
  return String(text || "").trim();
}

/* ---------- Route ---------- */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as AdvicePayload;
    const mode = String(body.mode || "advice");

    if (mode === "base") {
      const name = String(body.character || "").trim();
      if (!name) return NextResponse.json({ ok: false, error: "missing_character" }, { status: 400 });
      const row = await findBaseRow(name);
      if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      return NextResponse.json({ ok: true, base: rowToBase(row) });
    }

    const character = String(body.character || "ตัวละคร").trim();
    const role = typeof body.role === "string" ? body.role : undefined;
    const element = body.element;
    const userStats = body.stats || {};
    const gear = body.gear || {};
    const statsAreTotals = !!body.statsAreTotals;

    const row = await findBaseRow(character);
    const base = row ? rowToBase(row) : null;

    const totals = mergeWithBase(userStats, base, element, statsAreTotals);
    const { targets, gaps } = buildGapReport(character, totals, role);

    const prompt = makePrompt(character, role, gear, totals, targets, gaps, element);
    const text = await callGemini(prompt);

    return NextResponse.json({ ok: true, character, role, element, totals, targets, gaps, base, usedMerge: !statsAreTotals, text });
  } catch (err: any) {
    console.error("[gi-advice] error", err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
