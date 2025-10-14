// วิเคราะห์ Artifact/Weapon ของ Genshin ด้วย Gemini
// - ใช้รุ่น 2.5 (ดีฟอลต์) และ fallback → 2.0 → 1.5
// - รวม Base Lv.90 + Ascension Bonus Stat เข้ากับของ/อาวุธก่อนตัดสิน
// - ถ้ามี shownTotals ให้ถือเป็นความจริง (ห้ามสรุปว่าต่ำถ้าแตะเป้าแล้ว)
import { NextRequest, NextResponse } from "next/server";

/* =============== Types =============== */
type Totals = {
  er: number; cr: number; cd: number; em: number; hp_pct: number; atk_pct: number; def_pct: number;
};
type TotalsShown = {
  hp?: number; atk?: number; def?: number; em?: number;
  er?: number; cr?: number; cd?: number;
  pyro?: number; hydro?: number; cryo?: number; electro?: number; anemo?: number; geo?: number; dendro?: number; physical?: number;
};
type GearPiece = { piece: string; name: string; set?: string; main: string; subs: string[]; level?: number; };

type AdviceBody =
  | { mode?: "advice"; character: string; gear: Record<string, GearPiece>; totalsFromGear?: Totals; shownTotals?: TotalsShown; }
  | { mode: "from-enka"; character: string; artifacts: GearPiece[]; totalsFromGear?: Totals; shownTotals?: TotalsShown; };

/* =============== Prompt =============== */
function makePrompt(b: AdviceBody) {
  const charName = (b as any).character;
  const lines: string[] = [];

  const pieces: GearPiece[] =
    (b as any).mode === "from-enka"
      ? ((b as any).artifacts || [])
      : Object.values(((b as any).gear || {}) as Record<string, GearPiece>);

  if (pieces.length) {
    lines.push("ของที่มี (ชื่อ/ชิ้น/เมน/ซับ):");
    for (const it of pieces) {
      lines.push(`- ${it.name || "-"} | ${it.piece} | main=${it.main || "-"} | subs=[${(it.subs || []).join(", ")}]`);
    }
  }

  if ((b as any).totalsFromGear) {
    const t = (b as any).totalsFromGear as Totals;
    lines.push(
      `สรุปรวมจากของ+อาวุธ (ยังไม่รวม Base/Ascension): ER ${t.er.toFixed(1)}% | CR ${t.cr.toFixed(1)}% | CD ${t.cd.toFixed(1)}% | EM ${t.em.toFixed(0)} | HP% ${t.hp_pct.toFixed(1)} | ATK% ${t.atk_pct.toFixed(1)} | DEF% ${t.def_pct.toFixed(1)}`
    );
  }

  if ((b as any).shownTotals) {
    const s = (b as any).shownTotals as TotalsShown;
    const pct = (x?: number) => (typeof x === "number" ? x * 100 : undefined);
    const hp = s.hp, atk = s.atk, def = s.def, em = s.em;
    const er = pct(s.er), cr = pct(s.cr), cd = pct(s.cd);
    const dmgList = [
      ["Pyro", pct(s.pyro)], ["Hydro", pct(s.hydro)], ["Cryo", pct(s.cryo)], ["Electro", pct(s.electro)],
      ["Anemo", pct(s.anemo)], ["Geo", pct(s.geo)], ["Dendro", pct(s.dendro)], ["Physical", pct(s.physical)],
    ].filter((x) => typeof x[1] === "number").map((x) => `${x[0]} ${(x[1] as number).toFixed(1)}%`).join(" / ");
    lines.push(
      `ค่าสรุปบนโปรไฟล์ (ถือเป็นค่าจริง): HP ${hp ?? "-"} | ATK ${atk ?? "-"} | DEF ${def ?? "-"} | EM ${em ?? "-"} | ER ${(er ?? 0).toFixed(1)}% | CR ${(cr ?? 0).toFixed(1)}% | CD ${(cd ?? 0).toFixed(1)}%`
    );
    if (dmgList) lines.push(`DMG Bonus: ${dmgList}`);
  }

  lines.push("");
  lines.push("เกณฑ์การคำนวณ:");
  lines.push("- ดึง/อ้างอิง “Base Lv.90 ของตัวละคร” (HP/ATK/DEF + Base CR 5%, Base CD 50%, Base ER 100%).");
  lines.push("- ดึง/อ้างอิง “Ascension Bonus Stat ของตัวละคร” ที่เลเวล 90 (เช่น บางตัวโตเป็น CRIT Rate หรือ CRIT DMG/HP%/EM/ER/Healing ฯลฯ) แล้ว *บวกเข้ากับ Base*.");
  lines.push("- รวม **Base + Ascension + ค่าจาก Artifact/Weapon** เพื่อได้ CR/CD/ER/ฯลฯ สุดท้าย ก่อนเทียบกับเป้าหมาย.");
  lines.push("- ถ้ามี `shownTotals` ให้ถือเป็นตัวเลขความจริงของหน้าตัวละคร และให้ใช้ในการตัดสินว่าถึงเป้า/เกินเป้าหรือยัง (ห้ามบอกว่าต่ำถ้าค่านั้นแตะเป้าแล้ว).");

  lines.push("");
  lines.push("เป้าหมาย (Golden Ratio โดยทั่วไป):");
  lines.push("- CR ~70–80% | CD ~130–160% | ER ~120–150% (ขึ้นกับการกดเบิร์สบ่อยแค่ไหน)");

  return [
    `คุณเป็นผู้เชี่ยวชาญ Genshin Impact ช่วยวิเคราะห์อาร์ติแฟกต์ให้ “${charName}” เป็นภาษาไทยแบบสั้น กระชับ อ่านง่าย`,
    lines.join("\n"),
    `รูปแบบผลลัพธ์ (ข้อความธรรมดา ไม่ต้องมาร์กดาวน์):`,
    `A) แสดง “สรุปตัวเลขที่คำนวณได้” หลังรวม Base+Ascension+ของ: CR/CD/ER (และถ้ามี shownTotals ให้แสดงควบคู่แล้วระบุว่าตัดสินตาม shownTotals)`,
    `B) สรุปสเตตสำคัญที่ควรโฟกัส (อ้างอิง golden ratio) — ห้ามบอกว่าต่ำถ้า shownTotals หรือผลรวม ≥ เป้า`,
    `C) ประเมิน main/sub รายชิ้นแบบย่อ (ดี/พอใช้/ควรเปลี่ยน + เหตุผลสั้น ๆ)`,
    `D) คำแนะนำเชิงปฏิบัติ (เช่น เพิ่ม CR จากหมวก/ซับ, ลด ER ถ้าเกิน ฯลฯ)`,
    `ในแต่ละหัวข้อการแนะนำให้ใส่ emoji ตามสีคาแรคเตอร์ตัวละครนั้นคั่นตามแต่ละข้อๆด้วย แบบนี้
    A :
    emoji
    B :
    emoji
    C :
    emoji
    D :`,
  ].join("\n\n");
}

/* =============== Gemini Caller (2.5 → 2.0 → 1.5) =============== */
const PREFERRED_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash"];

async function callGeminiWithModel(prompt: string, model: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, maxOutputTokens: 700 } };

  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const status = r.status;
  let j: any = null;
  try { j = await r.json(); } catch {}

  if (!r.ok) {
    const apiMsg = j?.error?.message || JSON.stringify(j || {});
    const err = new Error(`gemini_http_${status}:${apiMsg}`);
    (err as any).isModelNotAvailable = status === 404 || status === 400;
    throw err;
  }

  const text =
    j?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("") ??
    j?.candidates?.[0]?.content?.parts?.[0]?.text ??
    "";
  return String(text || "").trim();
}

async function callGemini(prompt: string) {
  const models = [PREFERRED_MODEL, ...FALLBACK_MODELS];
  const errors: string[] = [];
  for (const m of models) {
    try {
      const text = await callGeminiWithModel(prompt, m);
      if (text) return { text, model: m };
    } catch (e) {
      const msg = (e as Error)?.message || "gemini_error";
      errors.push(`[${m}] ${msg}`);
      if (!(e as any)?.isModelNotAvailable) break;
    }
  }
  throw new Error(`no_model_available | ${errors.join(" | ")}`);
}

/* =============== Route =============== */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as AdviceBody;
    const prompt = makePrompt(body);

    try {
      const { text, model } = await callGemini(prompt);
      if (!text.trim()) {
        return NextResponse.json({ ok: false, error: "empty_text" }, { status: 200 });
      }
      return NextResponse.json({ ok: true, text, mode: (body as any).mode || "advice", model });
    } catch (e) {
      const msg = (e as Error)?.message || "gemini_error";
      return NextResponse.json({ ok: false, error: msg }, { status: 200 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gi-advice] error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
