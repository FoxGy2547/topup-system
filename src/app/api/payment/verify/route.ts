import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { recognize } from "tesseract.js";

export const runtime = "nodejs";

// --- utils server OCR (fallback) ---
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const toArabic = (s: string) => [...(s||"")].map(c=>{
  const i = THAI_DIGITS.indexOf(c); return i>=0? String(i): c;
}).join("");
const normalize = (s: string) =>
  toArabic(s).replace(/\u200b/g,"").replace(/[，、]/g,",")
             .replace(/[“”]/g,'"').replace(/[’‘]/g,"'")
             .replace(/\s+/g," ").trim();

async function ocrAmountServer(filePath: string): Promise<number | null> {
  const tmp = path.join(os.tmpdir(), `slip-${Date.now()}.png`);
  await sharp(filePath).grayscale().normalize().png().toFile(tmp);
  const { data: { text } } = await recognize(tmp, "tha+eng"); // ไม่ชี้ workerPath ใด ๆ
  await fs.unlink(tmp).catch(()=>{});
  const clean = normalize(text || "");
  let m = clean.match(/จำนวน\s*:?\s*([0-9][\d,]*[.,]\d{2})\s*(บาท)?/i);
  if (!m) m = clean.match(/([0-9][\d,]*[.,]\d{2})\s*(บาท)?/i);
  return m ? parseFloat(m[1].replace(/,/g,".").replace(/[^\d.]/g,"")) : null;
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      // โหมดใหม่: รับตัวเลขจาก client OCR มาเลย
      const { expectedAmount, actualAmount } = await req.json();
      const expected = Number(expectedAmount);
      const actual = Number(actualAmount);
      if (!isFinite(expected) || !isFinite(actual)) return NextResponse.json({ status: "fail" });
      if (Math.abs(actual - expected) < 0.01) return NextResponse.json({ status: "ok", actual });
      if (actual < expected) return NextResponse.json({ status: "under", diff: expected - actual, actual });
      return NextResponse.json({ status: "over", diff: actual - expected, actual });
    }

    // เดิม: รับไฟล์ (fallback)
    const formData = await req.formData();
    const expected = parseFloat(formData.get("expectedAmount") as string);
    const file = formData.get("file") as File;
    if (!file || isNaN(expected)) return NextResponse.json({ status: "fail" });

    const bytes = Buffer.from(await file.arrayBuffer());
    const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${file.name}`);
    await fs.writeFile(tmpPath, bytes);

    try {
      const actual = await ocrAmountServer(tmpPath);
      if (actual == null) return NextResponse.json({ status: "fail" });
      if (Math.abs(actual - expected) < 0.01) return NextResponse.json({ status: "ok", actual });
      if (actual < expected) return NextResponse.json({ status: "under", diff: expected - actual, actual });
      return NextResponse.json({ status: "over", diff: actual - expected, actual });
    } finally {
      await fs.unlink(tmpPath).catch(()=>{});
    }
  } catch {
    return NextResponse.json({ status: "fail" });
  }
}
