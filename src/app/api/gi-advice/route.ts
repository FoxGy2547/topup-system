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
type StatTotals = Partial<{
  hp: number; atk: number; def: number; em: number;
  er: number; cr: number; cd: number;
  elem_dmg: number; // goblet element dmg or general bonus (%)
}>;
type AdvicePayload = {
  mode?: "base" | "advice";
  character?: string;
  stats?: StatTotals; // current totals from player (optional)
  role?: string;      // optional hint: "burst dps" | "onfield dps" | "quick swap" | "reaction" | "healer" | "shield"
  gear?: Record<string, { set?: string; main?: string; subs?: string[] }>; // optional artifact snapshot
};

/* ---------- DB helpers ---------- */
const TABLES = ["gi_characters", "characters", "gi_base", "gi_character_base"];

// normalize any db module shape into rows
async function dbQuery(sql: string, params: any[] = []) {
  const mod: any = dbAny;
  if (typeof mod?.query === "function") return normalizeResult(await mod.query(sql, params));
  if (mod?.pool?.query) return normalizeResult(await mod.pool.query(sql, params));
  if (mod?.default) {
    const d: any = mod.default;
    if (typeof d === "function") return normalizeResult(await d(sql, params));
    if (typeof d?.query === "function") return normalizeResult(await d.query(sql, params));
    if (d?.pool?.query) return normalizeResult(await d.pool.query(sql, params));
  }
  throw new Error('No usable query() found in "@/lib/db". Export a function `query` or `pool.query`.');
}
function normalizeResult(res: any): any[] {
  if (Array.isArray(res) && Array.isArray(res[0])) return res[0]; // mysql2 [rows, fields]
  if (res?.rows) return res.rows; // pg
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
    } catch { /* ignore missing tables */ }
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

/* ---------- Practical target model (rule-based) ---------- */
// minimal per-character overrides (feel free to add more later)
const OVERRIDES: Record<string, Partial<StatTotals> & { er?: number; cr?: number; cd?: number }> = {
  // Off-field burst supports need high ER
  "xiangling": { er: 180, cr: 70, cd: 140 },
  "bennett":   { er: 180, cr: 60, cd: 120 },
  "xingqiu":   { er: 220, cr: 60, cd: 120 },
  "raidenshogun": { er: 220, cr: 65, cd: 130 },
  "furina": { er: 130, cr: 70, cd: 140 },
  "yelan": { er: 220, cr: 60, cd: 120 },
  "neuvillette": { er: 110, cr: 65, cd: 140, em: 0 }, // drives crit, DMG% goblet
  "nahida": { er: 120, em: 800, cr: 60, cd: 120 },
  "kazuha": { er: 140, em: 800, cr: 0, cd: 0 },
};
function toKey(s = "") { return s.toLowerCase().replace(/\s+/g, ""); }

function targetsFor(character: string, role?: string): Required<Pick<StatTotals, "er" | "cr" | "cd">> & StatTotals {
  const key = toKey(character);
  const base: Required<Pick<StatTotals, "er" | "cr" | "cd">> & StatTotals = {
    // generic defaults
    er: role?.toLowerCase().includes("burst") || role?.toLowerCase().includes("off")
      ? 160 : 130,
    cr: 70,
    cd: 140,
  };
  const o = OVERRIDES[key];
  return { ...base, ...(o ?? {}) };
}

function gap(current: number | undefined, target: number | undefined) {
  if (current == null || target == null) return null;
  const delta = +(current - target).toFixed(1);
  return { target, current, diff: +(-delta).toFixed(1), // positive = need more
           status: delta >= 0 ? "ok" : "need" };
}

function buildGapReport(character: string, stats?: StatTotals, role?: string) {
  const tg = targetsFor(character, role);
  const report: Record<string, any> = {};
  report.er   = gap(stats?.er, tg.er);
  report.cr   = gap(stats?.cr, tg.cr);
  report.cd   = gap(stats?.cd, tg.cd);
  if (tg.em)  report.em  = gap(stats?.em, tg.em);
  if (tg.elem_dmg) report.elem_dmg = gap(stats?.elem_dmg, tg.elem_dmg);
  // add simple crit-ratio hint if both present
  if (stats?.cr != null && stats?.cd != null) {
    const idealCd = +(stats.cr * 2).toFixed(1);
    report.crit_ratio = {
      ideal_cd_for_cr: idealCd,
      ratio_ok: stats.cd >= idealCd - 10 && stats.cd <= idealCd + 30,
    };
  }
  return { targets: tg, gaps: report };
}

/* ---------- Gemini helpers ---------- */
function gearToLines(gear: Record<string, any>) {
  const lines: string[] = [];
  for (const [slot, it] of Object.entries(gear || {})) {
    lines.push(`- ${slot}: set=${it?.set ?? "-"} | main=${it?.main ?? "-"} | subs=[${(it?.subs ?? []).join(", ")}]`);
  }
  return lines.join("\n");
}
function makePrompt(character: string, role: string | undefined, gear: Record<string, any>, stats: StatTotals | undefined, targets: any, gaps: any) {
  return [
    `คุณเป็นผู้เชี่ยวชาญ Genshin Impact ช่วยวิเคราะห์อาร์ติแฟกต์และสเตตของ “${character}” เป็นภาษาไทยแบบกระชับ อ่านง่าย`,
    role ? `บทบาท/สไตล์ที่ผู้ใช้ระบุ: ${role}` : ``,
    `สเตตปัจจุบัน (ถ้ามี): ${JSON.stringify(stats ?? {})}`,
    `เป้าหมายโดยประมาณ: ${JSON.stringify(targets)}`,
    `ส่วนต่างที่ยังขาด/เกิน: ${JSON.stringify(gaps)}`,
    `ชิ้นที่มีตอนนี้:\n${gearToLines(gear)}`,
    `ให้ตอบเป็นย่อหน้าสั้นๆ แบบธรรมดา (ไม่ต้องมาร์กดาวน์) และลงท้ายด้วย bullet ประมาณ 3 ข้อเป็นเช็คลิสต์สิ่งที่ควรทำก่อน เช่น เปลี่ยน main-stat, ปรับ ER, หา CR/CD เพิ่ม ฯลฯ`,
  ].filter(Boolean).join("\n\n");
}

async function callGemini(prompt: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + encodeURIComponent(key);
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 600 },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  const text =
    j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ??
    j?.candidates?.[0]?.content?.parts?.[0]?.text ??
    "";
  return String(text || "").trim();
}

/* ---------- Route ---------- */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as AdvicePayload;
    const mode = String(body.mode || "advice");

    // 1) base stats lookup
    if (mode === "base") {
      const name = String(body.character || "").trim();
      if (!name) return NextResponse.json({ ok: false, error: "missing_character" }, { status: 400 });
      const row = await findBaseRow(name);
      if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      return NextResponse.json({ ok: true, base: rowToBase(row) });
    }

    // 2) advice with practical targets + Gemini gap analysis
    const character = String(body.character || "ตัวละคร").trim();
    const role = typeof body.role === "string" ? body.role : undefined;
    const stats = body.stats || {};
    const gear = body.gear || {};

    // compute targets + gaps (rule-based first)
    const { targets, gaps } = buildGapReport(character, stats, role);

    // enrich prompt w/ db base if available
    let baseDb: any = null;
    const row = await findBaseRow(character);
    if (row) baseDb = rowToBase(row);

    const prompt = makePrompt(character, role, gear, stats, targets, gaps) +
      (baseDb ? `\n\nอ้างอิง base จาก DB: ${JSON.stringify(baseDb)}` : "");

    const text = await callGemini(prompt);

    return NextResponse.json({ ok: true, character, role, targets, gaps, base: baseDb, text });
  } catch (err: any) {
    console.error("[gi-advice] error", err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
