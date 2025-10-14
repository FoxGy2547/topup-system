// วิเคราะห์ Artifact/Weapon ของ Genshin ด้วย Gemini + แนบ golden ratio + ส่งเหตุผล error กลับให้ route หลัก
import { NextRequest, NextResponse } from "next/server";

type Totals = {
  er: number; cr: number; cd: number; em: number; hp_pct: number; atk_pct: number; def_pct: number;
};
type TotalsShown = {
  hp?: number; atk?: number; def?: number; em?: number;
  er?: number; cr?: number; cd?: number;
  pyro?: number; hydro?: number; cryo?: number; electro?: number; anemo?: number; geo?: number; dendro?: number; physical?: number;
};

type GearPiece = {
  piece: string; name: string; set?: string; main: string; subs: string[]; level?: number;
};

type AdviceBody =
  | { mode?: "advice"; character: string; gear: Record<string, GearPiece>; totalsFromGear?: Totals; shownTotals?: TotalsShown; }
  | { mode: "from-enka"; character: string; artifacts: GearPiece[]; totalsFromGear?: Totals; shownTotals?: TotalsShown; };

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
    lines.push(`สรุปรวมจากของ+อาวุธ: ER ${t.er.toFixed(1)}% | CR ${t.cr.toFixed(1)}% | CD ${t.cd.toFixed(1)}% | EM ${t.em.toFixed(0)} | HP% ${t.hp_pct.toFixed(1)} | ATK% ${t.atk_pct.toFixed(1)} | DEF% ${t.def_pct.toFixed(1)}`);
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
    lines.push(`ค่าสรุปบนโปรไฟล์: HP ${hp ?? "-"} | ATK ${atk ?? "-"} | DEF ${def ?? "-"} | EM ${em ?? "-"} | ER ${(er ?? 0).toFixed(1)}% | CR ${(cr ?? 0).toFixed(1)}% | CD ${(cd ?? 0).toFixed(1)}%`);
    if (dmgList) lines.push(`DMG Bonus: ${dmgList}`);
  }

  lines.push("");
  lines.push("แนวทางสัดส่วนสมดุล (Golden Ratio/เป้าหมายพื้นฐาน):");
  lines.push("- CR ~70–80% | CD ~130–160% | ER ~120–150% (ขึ้นกับความจำเป็นในการกดเบิร์ส)");
  lines.push("- ถึง CR ~70% แล้วค่อยดัน CD ต่อ ถ้า CR <60% ให้เติมจากหมวก/ซับก่อน");
  lines.push("- ถ้าตัวละครเน้นซัพพอร์ต/วงเบิร์สบ่อย ให้ให้ความสำคัญ ER ก่อน CR/CD");

  return [
    `คุณเป็นผู้เชี่ยวชาญ Genshin Impact ช่วยวิเคราะห์อาร์ติแฟกต์ให้ “${charName}” เป็นภาษาไทยแบบสั้น กระชับ อ่านง่าย`,
    lines.join("\n"),
    `รูปแบบผลลัพธ์ (ข้อความธรรมดา ไม่ต้องมาร์กดาวน์):`,
    `1) สรุปสเตตสำคัญที่ควรโฟกัส (อ้างอิง golden ratio หากไม่มีข้อยกเว้นของตัวละคร)`,
    `2) ประเมิน main/sub รายชิ้นว่า ดี/พอใช้/ควรเปลี่ยน พร้อมเหตุผลสั้น ๆ`,
    `3) ถ้า CR/CD/ER ยังต่ำกว่าเป้า ให้ระบุว่าขาดอะไรและควรเติมจากไหน (หมวก/ทราย/อาวุธ/ซับ)`,
  ].join("\n\n");
}

async function callGemini(prompt: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + encodeURIComponent(key);
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, maxOutputTokens: 700 } };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const status = r.status;
  let j: any = null;
  try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok) {
    console.error("[gi-advice] gemini http error", status, j);
    throw new Error(`gemini_http_${status}`);
  }
  const text =
    j?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("") ??
    j?.candidates?.[0]?.content?.parts?.[0]?.text ??
    "";
  return String(text || "").trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as AdviceBody;
    const prompt = makePrompt(body);
    let text = "";
    try {
      text = await callGemini(prompt);
    } catch (e) {
      const msg = (e as Error)?.message || "gemini_error";
      return NextResponse.json({ ok: false, error: msg }, { status: 200 });
    }
    if (!text.trim()) {
      return NextResponse.json({ ok: false, error: "empty_text" }, { status: 200 });
    }
    return NextResponse.json({ ok: true, text, mode: (body as any).mode || "advice" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gi-advice] error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
