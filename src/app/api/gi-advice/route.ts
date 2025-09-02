// /src/app/api/gi-advice/route.ts
import { NextRequest, NextResponse } from 'next/server';
import * as dbAny from '@/lib/db'; // <-- ใช้ namespace import จะไม่ชนว่ามี/ไม่มี default

/* ---------- DB helpers ---------- */
type Row = {
  character_key?: string;
  character_name?: string;
  hp_base?: number; atk_base?: number; def_base?: number; em_base?: number;
  er_pct?: number; cr_pct?: number; cd_pct?: number;
  pyro_dmg_pct?: number; hydro_dmg_pct?: number; cryo_dmg_pct?: number;
  electro_dmg_pct?: number; anemo_dmg_pct?: number; geo_dmg_pct?: number;
  dendro_dmg_pct?: number; phys_dmg_pct?: number; physical_dmg_pct?: number;
};

const TABLES = ['gi_characters', 'characters', 'gi_base', 'gi_character_base'];

// รองรับได้ทั้ง: query(sql,params), pool.query(sql,params), default.query, default(), ฯลฯ
async function dbQuery(sql: string, params: any[] = []) {
  const mod: any = dbAny;

  // รูปแบบ common
  if (typeof mod.query === 'function') {
    const res = await mod.query(sql, params);
    return normalizeResult(res);
  }
  if (mod.pool?.query) {
    const res = await mod.pool.query(sql, params);
    return normalizeResult(res);
  }

  // เผื่อมี default
  if (mod.default) {
    const d: any = mod.default;
    if (typeof d === 'function') {
      const res = await d(sql, params);
      return normalizeResult(res);
    }
    if (typeof d?.query === 'function') {
      const res = await d.query(sql, params);
      return normalizeResult(res);
    }
    if (d?.pool?.query) {
      const res = await d.pool.query(sql, params);
      return normalizeResult(res);
    }
  }

  throw new Error('No usable query() found in "@/lib/db". Export a function `query` or `pool.query`.');
}

// ปรับผลลัพธ์ให้กลายเป็น rows เสมอ (รองรับ mysql2/promise, pg, ฯลฯ)
function normalizeResult(res: any): any[] {
  // mysql2: [rows, fields]
  if (Array.isArray(res) && Array.isArray(res[0])) return res[0];
  // pg: { rows: [...] }
  if (res?.rows) return res.rows;
  // บาง lib คืนเป็น array อยู่แล้ว
  if (Array.isArray(res)) return res;
  return [];
}

async function findBaseRow(nameOrKey: string): Promise<Row | null> {
  for (const t of TABLES) {
    try {
      const rows: any[] = await dbQuery(
        `SELECT * FROM ${t} WHERE character_key = ? OR character_name = ? LIMIT 1`,
        [nameOrKey, nameOrKey]
      );
      if (rows && rows[0]) return rows[0] as Row;
    } catch {
      // ข้ามถ้าตารางไม่มี/สิทธิ์ไม่พอ
    }
  }
  return null;
}

function rowToBase(row: Row) {
  return {
    hp: row.hp_base ?? 0,
    atk: row.atk_base ?? 0,
    def: row.def_base ?? 0,
    em: row.em_base ?? 0,
    er: row.er_pct ?? 0,
    cr: row.cr_pct ?? 0,
    cd: row.cd_pct ?? 0,
    elem: {
      pyro: row.pyro_dmg_pct ?? 0,
      hydro: row.hydro_dmg_pct ?? 0,
      cryo: row.cryo_dmg_pct ?? 0,
      electro: row.electro_dmg_pct ?? 0,
      anemo: row.anemo_dmg_pct ?? 0,
      geo: row.geo_dmg_pct ?? 0,
      dendro: row.dendro_dmg_pct ?? 0,
      physical: row.phys_dmg_pct ?? row.physical_dmg_pct ?? 0,
    },
  };
}

/* ---------- Gemini helpers ---------- */
function makePrompt(character: string, gear: Record<string, any>) {
  const lines: string[] = [];
  for (const [slot, it] of Object.entries(gear)) {
    lines.push(`- ${slot}: set=${it.set ?? '-'} | main=${it.main ?? '-'} | subs=[${(it.subs ?? []).join(', ')}]`);
  }
  return [
    `คุณเป็นผู้เชี่ยวชาญ Genshin Impact ช่วยวิเคราะห์อาร์ติแฟกต์ให้ “${character}” เป็นภาษาไทยแบบสั้น กระชับ อ่านง่าย`,
    `ข้อมูลชิ้นที่มี:\n${lines.join('\n')}`,
    `ให้รูปแบบผลลัพธ์เป็นบล็อกข้อความธรรมดา (ไม่ต้องมาร์กดาวน์):`,
    `1) สรุปสเตตสำคัญที่ควรโฟกัสของตัวละครนี้`,
    `2) ประเมินว่า main/sub แต่ละชิ้นเข้าท่าหรือควรเปลี่ยน`,
    `3) แนะนำการปรับปรุง เช่น เปลี่ยน Goblet เป็นธาตุอะไร เป้า ER/CR/CD ประมาณเท่าไร`,
  ].join('\n\n');
}

async function callGemini(prompt: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' +
    encodeURIComponent(key);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  const text =
    j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ??
    j?.candidates?.[0]?.content?.parts?.[0]?.text ??
    '';
  return String(text || '').trim();
}

/* ---------- Route ---------- */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode || 'advice');

    // 1) โหมด base: ดึง base stat จาก DB
    if (mode === 'base') {
      const name = String(body.character || '').trim();
      if (!name) return NextResponse.json({ ok: false, error: 'missing_character' }, { status: 400 });
      const row = await findBaseRow(name);
      if (!row) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
      return NextResponse.json({ ok: true, base: rowToBase(row) });
    }

    // 2) โหมด advice (ดีฟอลต์): ใช้ Gemini ให้คำแนะนำ
    const character = String(body.character || 'ตัวละคร').trim();
    const gear = body.gear || {};
    const prompt = makePrompt(character, gear);
    const text = await callGemini(prompt);
    return NextResponse.json({ ok: true, text });
  } catch (err: any) {
    console.error('[gi-advice] error', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
