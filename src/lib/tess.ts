// /src/lib/tess.ts
// Helper สำหรับ OCR ที่จะเลือก path ที่ใช้ได้จริง (Local -> CDN) อัตโนมัติ
import Tesseract from 'tesseract.js';

const ORIGIN =
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : '';

const local = {
  worker: `${ORIGIN}/tesseract/worker.min.js`,
  coreSimd: `${ORIGIN}/tesseract/tesseract-core-simd-lstm.wasm.js`,
  coreNoSimd: `${ORIGIN}/tesseract/tesseract-core-lstm.wasm.js`,
  langBase: `${ORIGIN}/tesseract/lang`,
};

// CDN สำรอง (ล็อกเวอร์ชันตามแพ็กเกจคุณ: tesseract.js@5.1.1)
const cdn = {
  worker: `https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js`,
  coreSimd: `https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm.js`,
  coreNoSimd: `https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-lstm.wasm.js`,
  langBase: `https://tessdata.projectnaptha.com/4.0.0_best`, // มี thai/eng เป็น .traineddata.gz
};

// เช็คว่า URL ใช้งานได้ไหม (HEAD -> 200/OK)
async function ok(url: string) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}

// เลือก worker/core/lang ที่ใช้ได้จริง
async function resolvePaths() {
  // worker
  const workerPath = (await ok(local.worker)) ? local.worker : cdn.worker;
  // core (ลอง SIMD ก่อน)
  const corePath = (await ok(local.coreSimd))
    ? local.coreSimd
    : (await ok(local.coreNoSimd))
    ? local.coreNoSimd
    : (await ok(cdn.coreSimd))
    ? cdn.coreSimd
    : cdn.coreNoSimd;

  // lang base (โฟลเดอร์)
  const langBase = (await ok(`${local.langBase}/eng.traineddata`))
    ? local.langBase
    : cdn.langBase;

  return { workerPath, corePath, langPath: langBase };
}

/**
 * OCR ด้วยเส้นทางที่ fallback อัตโนมัติ (Local -> CDN)
 * @param file รูปภาพ (File/Blob/URL)
 * @param lang เช่น 'tha+eng'
 */
export async function ocrWithFallback(
  file: any,
  lang = 'tha+eng'
): Promise<string> {
  const { workerPath, corePath, langPath } = await resolvePaths();

  // ป้องกันโหลดนานเกิน – ตัดหลัง 30s
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error('OCR timeout')), 30_000)
  );

  const run = (async () => {
    const { data } = await Tesseract.recognize(file, lang, {
      workerPath,
      corePath,
      langPath,
      // ลด noise นิดหน่อย
      tessedit_char_blacklist: '§¶‘’“”|',
    } as any);
    return data.text || '';
  })();

  return Promise.race([run, timeout]);
}
