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
    await sharp(inputPath)
      .grayscale()
      .normalize()
      .linear(1.2, -15)
      .png({ compressionLevel: 9 })
      .toFile(tmp);

    const { data: { text } } = await recognize(tmp, "tha+eng");
    return norm(text || "");
  } finally {
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch {}
  }
}

function extractAmountBaht(text: string): number | null {
  const clean = norm(text);

  const near = clean.match(/จำนวน\s*:?\s*([0-9][\d,]*[.,]\d{2})\s*(บาท)?/i);
  if (near) return parseFloat(near[1].replace(/,/g, ".").replace(/[^\d.]/g, ""));

  const anyNum = clean.match(/([0-9][\d,]*[.,]\d{2})\s*(บาท)?/i);
  return anyNum ? parseFloat(anyNum[1].replace(/,/g, ".").replace(/[^\d.]/g, "")) : null;
}

export async function getAmountFromSlip(filePath: string): Promise<number | null> {
  const text = await ocrAllText(filePath);
  return extractAmountBaht(text);
}
