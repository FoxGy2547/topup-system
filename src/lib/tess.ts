// src/lib/tess.ts
'use client';

import Tesseract from 'tesseract.js';

type CoreChoice = 'simd' | 'nosimd';

const PATHS = {
  worker: '/tesseract/worker.min.js',
  coreSimd: '/tesseract/tesseract-core-simd-lstm.wasm.js',
  coreNoSimd: '/tesseract/tesseract-core-lstm.wasm.js',
  langPath: '/tesseract/lang',
};

function opts(core: CoreChoice) {
  return {
    workerPath: PATHS.worker,
    corePath: core === 'simd' ? PATHS.coreSimd : PATHS.coreNoSimd,
    langPath: PATHS.langPath,
    // เปิด progress (จะ log ใน console)
    logger: (m: any) => {
      if (m?.status) {
        // eslint-disable-next-line no-console
        console.log(`[tess:${core}]`, m.status, m.progress ?? '');
      }
    },
  } as any;
}

/** ลอง OCR: SIMD ก่อน → ถ้า error ค่อย fallback เป็น non-SIMD */
export async function ocrWithFallback(
  fileOrCanvas: File | HTMLCanvasElement | HTMLImageElement,
  lang = 'tha+eng'
): Promise<string> {
  const tryOne = async (c: CoreChoice) => {
    try {
      const { data } = await Tesseract.recognize(fileOrCanvas as any, lang, opts(c));
      return data?.text || '';
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[tess:${c}] failed`, e);
      throw e;
    }
  };

  // ถ้าหน้าเพจไม่ได้ crossOriginIsolated ส่วนใหญ่ SIMD จะเด้ง → ลองก่อน แล้วตกมาที่ no-simd
  try {
    return await tryOne('simd');
  } catch {
    return await tryOne('nosimd');
  }
}
