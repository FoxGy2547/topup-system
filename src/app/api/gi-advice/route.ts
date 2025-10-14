// วิเคราะห์ Artifact/Weapon ของ Genshin ด้วย Gemini + รองรับส่ง “ค่าสรุปจาก enka” เข้ามาด้วย
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
  piece: string;       // Weapon/Flower/Plume/Sands/Goblet/Circlet
  name: string;
  set?: string;
  main: string;
  subs: string[];
  level?: number;
};

type AdviceBody =
  | {
      mode?: "advice";
      character: string;
      gear: Record<string, GearPiece>;
      totalsFromGear?: Totals;     // optional
      shownTotals?: TotalsShown;   // optional
    }
  | {
      mode: "from-enka";
      character: string;
      artifacts: GearPiece[];
      totalsFromGear?: Totals;
      shownTotals?: TotalsShown;
    };

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
      `สรุปรวมจากของ+อาวุธ: ER ${t.er.toFixed(1)}% | CR ${t.cr.toFixed(1)}% | CD ${t.cd.toFixed(1)}% | EM ${t.em.toFixed(0)} | HP% ${t.hp_pct.toFixed(1)} | ATK% ${t.atk_pct.toFixed(1)} | DEF% ${t.def_pct.toFixed(1)}`
    );
  }

  if ((b as any).shownTotals) {
    const s = (b as any).shownTotals as TotalsShown;

    // scale → เปอร์เซ็นต์จริง
    const pct = (x?: number) => (typeof x === "number" ? x * 100 : undefined);

    const hp = s.hp, atk = s.atk, def = s.def, em = s.em;
    const er = pct(s.er), cr = pct(s.cr), cd = pct(s.cd);
    const dmgList = [
      ["Pyro", pct(s.pyro)], ["Hydro", pct(s.hydro)], ["Cryo", pct(s.cryo)], ["Electro", pct(s.electro)],
      ["Anemo", pct(s.anemo)], ["Geo", pct(s.geo)], ["Dendro", pct(s.dendro)], ["Physical", pct(s.physical)],
    ]
      .filter((x) => typeof x[1] === "number")
      .map((x) => `${x[0]} ${(x[1] as number).toFixed(1)}%`)
      .join(" / ");

    lines.push(
      `ค่าสรุปบนโปรไฟล์: HP ${hp ?? "-"} | ATK ${atk ?? "-"} | DEF ${def ?? "-"} | EM ${em ?? "-"} | ER ${(er ?? 0).toFixed(1)}% | CR ${(cr ?? 0).toFixed(1)}% | CD ${(cd ?? 0).toFixed(1)}%`
    );
    if (dmgList) lines.push(`DMG Bonus: ${dmgList}`);
  }

  // ===== Golden ratio / แนวทางเป้าหมาย =====
  // (generic default; ตัวละครพิเศษให้ปรับตามคอนเท็กซ์ของเมน/อาวุธที่ส่งมา)
  lines.push(
    [
      "",
      "แนวทางสัดส่วนสมดุล (Golden Ratio/เป้าหมายพื้นฐาน):",
      "- CR ~70–80% | CD ~130–160% | ER ~120–150% (แล้วแต่ความจำเป็นกางสกิล/เบิร์ส)",
      "- ถ้าเป็นตัวซัพพอร์ต/เบอร์สต์บ่อย ให้ให้ความสำคัญ ER ก่อน CR/CD",
      "- เมื่อ CR ถึง ~70% ให้ดัน CD ต่อ, ถ้า CR ต่ำกว่า 60% ให้เติมจากหมวก/ซับก่อน",
    ].join("\n")
  );

  return [
    `คุณเป็นผู้เชี่ยวชาญ Genshin Impact ช่วยวิเคราะห์อาร์ติแฟกต์ให้ “${charName}” เป็นภาษาไทยแบบสั้น กระชับ อ่านง่าย`,
    lines.join("\n"),
    `รูปแบบผลลัพธ์ (ข้อความธรรมดา ไม่ต้องมาร์กดาวน์):`,
    `1) สรุปสเตตสำคัญที่ควรโฟกัสของตัวละครนี้ (อ้างอิง golden ratio ด้านบน ถ้าตัวนี้มีข้อยกเว้นให้ระบุ)`,
    `2) ประเมินว่า main/sub ของแต่ละชิ้น “ดี/พอใช้/ควรเปลี่ยน” (ให้เหตุผลสั้น ๆ)`,
    `3) ถ้า CR/CD/ER ยังต่ำกว่าเป้า ให้ชี้ว่า “ขาดอะไร” พร้อมตัวอย่างแนวทางเพิ่ม (เช่น หมวก CR, ทราย ER, ซับ ER/CR/CD)`,
  ].join("\n\n");
}

async function callGemini(prompt: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
    encodeURIComponent(key);
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 700 },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as any;
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
      // ถ้า key ไม่มี/เรียกล้มเหลว ให้บอกฝั่งหลักว่าไม่โอเค เพื่อให้เข้า fallback
      return NextResponse.json({ ok: false, error: (e as Error)?.message || "gemini_error" }, { status: 200 });
    }
    if (!text.trim()) {
      // บังคับ fallback เมื่อ Gemini ตอบว่าง
      return NextResponse.json({ ok: false, error: "empty_text" }, { status: 200 });
    }
    return NextResponse.json({ ok: true, text, mode: (body as any).mode || "advice" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gi-advice] error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
