/* src/app/api/advice/route.ts
   วิเคราะห์ Artifact (GI) / Relic (HSR) ด้วย Gemini
   — รองรับ 2.5 → 2.0 → 1.5 fallback — */

import { NextRequest, NextResponse } from "next/server";

type GameKey = "gi" | "hsr";

/* =============== GI Types =============== */
type TotalsGI = {
  er: number; cr: number; cd: number; em: number; hp_pct: number; atk_pct: number; def_pct: number;
};
type TotalsShownGI = {
  hp?: number; atk?: number; def?: number; em?: number;
  er?: number; cr?: number; cd?: number;
  pyro?: number; hydro?: number; cryo?: number; electro?: number; anemo?: number; geo?: number; dendro?: number; physical?: number;
};
type GearPiece = { piece: string; name: string; set?: string; main: string; subs: string[]; level?: number; };

type BodyGI =
  | { game: "gi"; mode?: "advice"; character: string; gear?: Record<string, GearPiece>; totalsFromGear?: TotalsGI; shownTotals?: TotalsShownGI; }
  | { game: "gi"; mode: "from-enka"; character: string; artifacts: GearPiece[]; totalsFromGear?: TotalsGI; shownTotals?: TotalsShownGI; };

/* =============== HSR Types =============== */
type TotalsShownHSR = {
  hp?: number; atk?: number; def?: number; spd?: number;
  cr?: number; cd?: number; err?: number; ehr?: number; be?: number;
  physical?: number; fire?: number; ice?: number; lightning?: number; wind?: number; quantum?: number; imaginary?: number;
};
type TotalsHSR = {
  cr?: number; cd?: number; err_pct?: number; ehr_pct?: number; be_pct?: number; spd_pct?: number; hp_pct?: number; atk_pct?: number; def_pct?: number;
};
type BodyHSR =
  | { game: "hsr"; mode?: "advice"; character: string; gear?: Record<string, GearPiece>; totalsFromGear?: TotalsHSR; shownTotals?: TotalsShownHSR; }
  | { game: "hsr"; mode: "from-enka"; character: string; artifacts: GearPiece[]; totalsFromGear?: TotalsHSR; shownTotals?: TotalsShownHSR; };

type Body = BodyGI | BodyHSR;

/* =============== Helpers =============== */
// ล้าง Markdown ให้เป็นข้อความธรรมดาเท่านั้น
function toPlain(text: string): string {
  let out = String(text ?? "");

  // normalize newlines
  out = out.replace(/\r\n/g, "\n");

  // strip bold/italic/underline/code
  out = out.replace(/\*\*(.*?)\*\*/g, "$1");
  out = out.replace(/__(.*?)__/g, "$1");
  out = out.replace(/_(.*?)_/g, "$1");
  out = out.replace(/`{1,3}([\s\S]*?)`{1,3}/g, "$1");

  // strip headings and quotes
  out = out.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");

  // แปลง bullet ที่ขึ้นต้นด้วย *, -, • เป็น "- "
  out = out.replace(/^\s*[\*\-•]\s+/gm, "- ");

  // กำจัด ** ที่อาจเหลือ และ * ซ้อน
  out = out.replace(/\*{2,}/g, "");
  // ตัด * เดี่ยวๆ ที่คั่นคำแบบ markdown เหลือบ้าง
  out = out.replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, "$1$2");

  // เก็บกวาดช่องว่างปลายบรรทัด และบรรทัดว่างเกิน
  out = out.replace(/[ \t]+$/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

/* =============== Prompt =============== */
function makePromptGI(b: BodyGI) {
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
    const t = (b as any).totalsFromGear as TotalsGI;
    lines.push(
      `สรุปรวมจากของ+อาวุธ (ยังไม่รวม Base/Ascension): ER ${t.er.toFixed(1)}% | CR ${t.cr.toFixed(1)}% | CD ${t.cd.toFixed(1)}% | EM ${t.em.toFixed(0)} | HP% ${t.hp_pct.toFixed(1)} | ATK% ${t.atk_pct.toFixed(1)} | DEF% ${t.def_pct.toFixed(1)}`
    );
  }

  if ((b as any).shownTotals) {
    const s = (b as any).shownTotals as TotalsShownGI;
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
  lines.push("- ดึง/อ้างอิง Base Lv.90 ของตัวละคร (HP/ATK/DEF + Base CR 5%, Base CD 50%, Base ER 100%).");
  lines.push("- ดึง/อ้างอิง Ascension Bonus Stat ที่เลเวล 90 แล้ว แล้วบวกเข้ากับ Base.");
  lines.push("- รวม Base + Ascension + ค่าจาก Artifact/Weapon ก่อนเทียบกับเป้าหมาย.");
  lines.push("- ถ้ามี shownTotals ให้ถือเป็นตัวเลขความจริง (ห้ามบอกว่าต่ำถ้าแตะเป้าแล้ว).");

  lines.push("");
  lines.push("เป้าหมาย (Golden Ratio โดยทั่วไป):");
  lines.push("- CR ประมาณ 70–80% | CD ประมาณ 130–160% | ER ประมาณ 120–150%");

  return [
    `คุณเป็นผู้เชี่ยวชาญ Genshin Impact ช่วยวิเคราะห์อาร์ติแฟกต์ให้ “${charName}” เป็นภาษาไทยแบบสั้น กระชับ อ่านง่าย`,
    lines.join("\n"),
    `รูปแบบผลลัพธ์ (ข้อความธรรมดา ไม่มี Markdown):`,
    `A) สรุปตัวเลขที่คำนวณได้หลังรวม Base+Ascension+ของ: CR/CD/ER (ถ้ามี shownTotals ให้ชี้ว่าตัดสินตาม shownTotals)`,
    `B) สรุปสเตตสำคัญที่ควรโฟกัส (อ้างอิง golden ratio)`,
    `C) ประเมิน main/sub รายชิ้นแบบย่อ (ดี/พอใช้/ควรเปลี่ยน + เหตุผลสั้น)`,
    `D) คำแนะนำเชิงปฏิบัติ`,
    `ห้ามใช้ตัวหนา/ตัวเอียง/หัวข้อ/โค้ดบล็อก และห้ามใช้สัญลักษณ์ ** __ _ \` # > ใดๆ`,
  ].join("\n\n");
}

function makePromptHSR(b: BodyHSR) {
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
    const t = (b as any).totalsFromGear as TotalsHSR;
    const f = (x?: number, p = 1) => (typeof x === "number" ? x.toFixed(p) : "-");
    lines.push(
      `สรุปรวมจากของ+Light Cone (ยังไม่รวม Base/Ascension): CR ${f(t.cr)}% | CD ${f(t.cd)}% | ERR ${f(t.err_pct)}% | EHR ${f(t.ehr_pct)}% | BE ${f(t.be_pct)}% | SPD% ${f(t.spd_pct)} | HP% ${f(t.hp_pct)} | ATK% ${f(t.atk_pct)} | DEF% ${f(t.def_pct)}`
    );
  }

  if ((b as any).shownTotals) {
    const s = (b as any).shownTotals as TotalsShownHSR;
    const pct = (x?: number) => (typeof x === "number" ? x * 100 : undefined);
    const hp = s.hp, atk = s.atk, def = s.def, spd = s.spd;
    const cr = pct(s.cr), cd = pct(s.cd), err = pct(s.err), ehr = pct(s.ehr), be = pct(s.be);
    const dmg = [
      ["Physical", pct(s.physical)], ["Fire", pct(s.fire)], ["Ice", pct(s.ice)], ["Lightning", pct(s.lightning)],
      ["Wind", pct(s.wind)], ["Quantum", pct(s.quantum)], ["Imaginary", pct(s.imaginary)],
    ].filter(x => typeof x[1] === "number").map(x => `${x[0]} ${(x[1] as number).toFixed(1)}%`).join(" / ");
    lines.push(`ค่าสรุปบนโปรไฟล์ (ถือเป็นค่าจริง): HP ${hp ?? "-"} | ATK ${atk ?? "-"} | DEF ${def ?? "-"} | SPD ${spd ?? "-"} | CR ${(cr ?? 0).toFixed(1)}% | CD ${(cd ?? 0).toFixed(1)}% | ERR ${(err ?? 0).toFixed(1)}% | EHR ${(ehr ?? 0).toFixed(1)}% | BE ${(be ?? 0).toFixed(1)}%`);
    if (dmg) lines.push(`DMG Bonus: ${dmg}`);
  }

  lines.push("");
  lines.push("เกณฑ์การคำนวณ (HSR):");
  lines.push("- ใช้ Base Lv.80/80 หรือ 80/90 ตามโปรไฟล์ + Ascension Bonus (CR/CD/HP%/ATK%/SPD/ERR/EHR/BE ฯลฯ).");
  lines.push("- รวม Base + Ascension + Relic/Ornament/Light Cone เพื่อค่าสุดท้าย ก่อนเทียบกับเป้าหมาย.");
  lines.push("- ถ้ามี shownTotals ให้ตัดสินตามนั้น ห้ามสรุปว่าต่ำถ้าค่าถึง/เกินเป้าแล้ว.");

  lines.push("");
  lines.push("เป้าหมายทั่วไป (กลางๆ):");
  lines.push("- DPS: CR 70–80% | CD 140–200% | ERR 100–120% | SPD ตาม breakpoint 120/134/147...");
  lines.push("- Debuffer/Support: เน้น EHR ≥ ~67% (ตามดีบัฟ), ERR 100–120%, SPD แตะ breakpoint ทีม.");

  return [
    `คุณเป็นผู้เชี่ยวชาญ Honkai: Star Rail ช่วยวิเคราะห์ Relic/Ornament ให้ “${charName}” เป็นภาษาไทยแบบสั้น กระชับ`,
    lines.join("\n"),
    `รูปแบบผลลัพธ์ (ข้อความธรรมดา ไม่มี Markdown):`,
    `A) สรุปตัวเลขหลังรวม Base+Ascension+ของ: CR/CD/ERR/EHR/SPD (ถ้ามี shownTotals ให้ชี้ว่าตัดสินตาม shownTotals)`,
    `B) โฟกัสสเตตตามบทบาท`,
    `C) ประเมิน main/sub รายชิ้น (ดี/พอใช้/ควรเปลี่ยน + เหตุผลสั้น)`,
    `D) คำแนะนำเชิงปฏิบัติ (แตะ SPD breakpoint, ปรับ EHR/ERR ฯลฯ)`,
    `ห้ามใช้ตัวหนา/ตัวเอียง/หัวข้อ/โค้ดบล็อก และห้ามใช้สัญลักษณ์ ** __ _ \` # > ใดๆ`,
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
    const body = (await req.json().catch(() => ({}))) as Body;
    if (!body || (body as any).game == null) {
      return NextResponse.json({ ok: false, error: "missing_game" }, { status: 400 });
    }
    const prompt = body.game === "gi"
      ? makePromptGI(body as BodyGI)
      : makePromptHSR(body as BodyHSR);

    try {
      const { text, model } = await callGemini(prompt);
      const plain = toPlain(text); // ล้าง Markdown อีกรอบกันพลาด
      if (!plain.trim()) {
        return NextResponse.json({ ok: false, error: "empty_text" }, { status: 200 });
      }
      return NextResponse.json({ ok: true, text: plain, game: (body as any).game, mode: (body as any).mode || "advice", model });
    } catch (e) {
      const msg = (e as Error)?.message || "gemini_error";
      return NextResponse.json({ ok: false, error: msg }, { status: 200 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[advice] error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
