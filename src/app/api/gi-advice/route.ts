// src/app/api/gi-advice/route.ts
// วิเคราะห์ Artifact/Weapon ของ Genshin ด้วย Gemini + รองรับส่ง “ค่าสรุปจาก enka” เข้ามาด้วย
import { NextRequest, NextResponse } from "next/server";

type Totals = {
  er: number; cr: number; cd: number; em: number; hp_pct: number; atk_pct: number; def_pct: number;
};
type TotalsShown = {
  hp?: number; atk?: number; def?: number; em?: number; er?: number; cr?: number; cd?: number;
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
      totalsFromGear?: Totals;     // (ออปชัน) รวมจาก main/sub/weapon
      shownTotals?: TotalsShown;   // (ออปชัน) ค่าที่หน้า enka แสดงจริง
    }
  | {
      mode: "from-enka";
      character: string;
      artifacts: GearPiece[];      // ส่ง artifacts (รวมอาวุธ) มาเป็นอาเรย์ก็ได้
      totalsFromGear?: Totals;
      shownTotals?: TotalsShown;
    };

function makePrompt(b: AdviceBody) {
  const charName = b.character;
  const lines: string[] = [];

  const pieces: GearPiece[] =
    (b.mode === "from-enka" ? b.artifacts : Object.values((b as any).gear || {})) || [];

  if (pieces.length) {
    lines.push("ของที่มี (ชื่อ/ชิ้น/เมน/ซับ):");
    for (const it of pieces) {
      lines.push(
        `- ${it.name || "-"} | ${it.piece} | main=${it.main || "-"} | subs=[${(it.subs || []).join(", ")}]`
      );
    }
  }

  if (b.totalsFromGear) {
    const t = b.totalsFromGear;
    lines.push(
      `สรุปรวมจากของ+อาวุธ: ER ${t.er.toFixed(1)}% | CR ${t.cr.toFixed(1)}% | CD ${t.cd.toFixed(1)}% | EM ${t.em.toFixed(0)} | HP% ${t.hp_pct.toFixed(1)} | ATK% ${t.atk_pct.toFixed(1)} | DEF% ${t.def_pct.toFixed(1)}`
    );
  }

  if (b.shownTotals) {
    const s = b.shownTotals;
    const dmg = [
      ["Pyro", s.pyro], ["Hydro", s.hydro], ["Cryo", s.cryo], ["Electro", s.electro],
      ["Anemo", s.anemo], ["Geo", s.geo], ["Dendro", s.dendro], ["Physical", s.physical]
    ]
      .filter((x) => typeof x[1] === "number")
      .map((x) => `${x[0]} ${(x[1] as number).toFixed(1)}%`)
      .join(" / ");
    lines.push(
      `ค่าสรุปบนโปรไฟล์: HP ${s.hp ?? "-"} | ATK ${s.atk ?? "-"} | DEF ${s.def ?? "-"} | EM ${s.em ?? "-"} | ER ${(s.er ?? 0).toFixed(1)}% | CR ${(s.cr ?? 0).toFixed(1)}% | CD ${(s.cd ?? 0).toFixed(1)}%`
    );
    if (dmg) lines.push(`DMG Bonus: ${dmg}`);
  }

  return [
    `คุณเป็นผู้เชี่ยวชาญ Genshin Impact ช่วยวิเคราะห์อาร์ติแฟกต์ให้ “${charName}” เป็นภาษาไทยแบบสั้น กระชับ อ่านง่าย`,
    lines.join("\n"),
    `รูปแบบผลลัพธ์ (ข้อความธรรมดา ไม่ต้องมาร์กดาวน์):`,
    `1) สรุปสเตตสำคัญที่ควรโฟกัสของตัวละครนี้ (ระบุเป้าหมายเช่น CR/CD/ER โดยประมาณ)`,
    `2) ประเมินว่า main/sub ของแต่ละชิ้น “ใช้ได้/ควรเปลี่ยน” อย่างย่อ`,
    `3) ถ้าค่าสรุปรวมยัง “ต่ำกว่าเป้า” ให้ชี้ว่า “ขาดอะไร” ชัด ๆ (เช่น ER ต่ำ ให้หา ER จากไหน, CR ต่ำ ให้เพิ่ม CR จากวงแหวน ฯลฯ)`,
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
  const j = (await r.json()) as unknown as Record<string, unknown>;
  const text =
    (j as any)?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ??
    (j as any)?.candidates?.[0]?.content?.parts?.[0]?.text ??
    "";
  return String(text || "").trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as AdviceBody;
    const mode = (body as any).mode || "advice";
    const prompt = makePrompt(body);
    const text = await callGemini(prompt);
    return NextResponse.json({ ok: true, text, mode });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gi-advice] error", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
