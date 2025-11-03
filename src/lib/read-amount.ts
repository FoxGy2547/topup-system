import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { recognize } from "tesseract.js";

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const toArabic = (s: string) =>
  [...(s || "")].map(c => {
    const i = THAI_DIGITS.indexOf(c);
    return i >= 0 ? String(i) : c;
  }).join("");

const norm = (s: string) =>
  toArabic(s)
    .replace(/\u200b/g, "")
    .replace(/[，、]/g, ",")
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

async function ocrAllText(inputPath: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `kplus-${Date.now()}.png`);
  try {
    // 🔧 ปรับแต่งภาพให้คมขึ้นก่อน OCR
    await sharp(inputPath)
      .resize({ width: 1600, withoutEnlargement: false }) // ขยายช่วยให้ OCR อ่านตัวเลขดีขึ้น
      .grayscale()
      .normalize()
      .linear(1.2, -15)
      .threshold(180, { grayscale: true })                // เคาะเส้นตัวเลขให้ชัด
      .png({ compressionLevel: 9 })
      .toFile(tmp);

    const { data: { text } } = await recognize(tmp, "tha+eng");
    return norm(text || "");
  } finally {
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch {}
  }
}

/** แปลงเลขแบบ 1,100.00 → 1100.00 แล้ว parseFloat อย่างปลอดภัย */
function toNumberSafe(numStr: string): number {
  const s = numStr.replace(/,/g, "").replace(/[^\d.]/g, ""); // ❗️ลบคอมมา ไม่ใช่แปลงเป็นจุด
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function extractAmountBaht(text: string): number | null {
  const clean = norm(text);

  // เคสไทยยอดฮิตบนสลิป K+ / ธนาคารอื่น ๆ
  const patterns: RegExp[] = [
    /จำนวน(?:เงิน)?\s*:?\s*([0-9][\d,]*[.,]\d{2})\s*(?:บาท|THB)?/i,
    /ยอด(?:ชำระ|โอน|ที่ชำระ)\s*:?\s*([0-9][\d,]*[.,]\d{2})\s*(?:บาท|THB)?/i,
    /Amount\s*:?\s*([0-9][\d,]*[.,]\d{2})/i,
    /THB\s*([0-9][\d,]*[.,]\d{2})/i,
    /([0-9][\d,]*[.,]\d{2})\s*(?:บาท|THB)/i, // ตัวเลขตามด้วย บาท/THB
  ];

  for (const re of patterns) {
    const m = clean.match(re);
    if (m) {
      const v = toNumberSafe(m[1]);
      if (Number.isFinite(v)) return v;
    }
  }

  // Fallback: เอาตัวเลขทศนิยม 2 ตำแหน่ง “ที่ใหญ่ที่สุด” ในเพจ (มักเป็นยอดโอน)
  const all = [...clean.matchAll(/([0-9][\d,]*[.,]\d{2})/g)].map(m => toNumberSafe(m[1])).filter(Number.isFinite);
  if (all.length) {
    // ส่วนใหญ่ยอดจริงจะเป็นตัวเลขมากที่สุด (เช่น 518.00 > 0.00 ค่าธรรมเนียม)
    return all.sort((a, b) => b - a)[0]!;
  }

  return null;
}

export async function getAmountFromSlip(filePath: string): Promise<number | null> {
  const text = await ocrAllText(filePath);
  return extractAmountBaht(text);
}
