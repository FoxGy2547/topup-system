// /src/lib/gi-calc.ts
import type { GearItem, GiSlot } from '@/lib/gear-ocr';

/* ========================= Types ========================= */
type Totals = {
  hpFlat: number; hpPct: number;
  atkFlat: number; atkPct: number;
  defFlat: number; defPct: number;
  em: number; er: number; cr: number; cd: number;
  elem: Record<'Pyro'|'Hydro'|'Cryo'|'Electro'|'Anemo'|'Geo'|'Dendro', number>;
  phys: number;
};

export type GiAnalyzeResult = {
  character?: string;
  totals: Totals;
  lines: string[];
  aiText?: string | null;
  summary: string;
  used: 'gemini' | 'local';
};

const ELEM_KEYS: Array<keyof Totals['elem']> = ['Pyro','Hydro','Cryo','Electro','Anemo','Geo','Dendro'];

/* ========================= Totals helpers ========================= */
function emptyTotals(): Totals {
  return {
    hpFlat:0, hpPct:0, atkFlat:0, atkPct:0, defFlat:0, defPct:0,
    em:0, er:0, cr:0, cd:0,
    elem: { Pyro:0, Hydro:0, Cryo:0, Electro:0, Anemo:0, Geo:0, Dendro:0 },
    phys:0
  };
}

function add(t: Totals, name: string, value: string) {
  const raw = String(value).trim();
  const v = parseFloat(raw.replace(/[, ]/g, '').replace('%','')) || 0;
  const pct = /%$/.test(raw);
  const n = name.toLowerCase();

  if (/^hp$/.test(n) && !pct) t.hpFlat += v;
  else if (/^hp/.test(n))       t.hpPct  += v;
  else if (/^atk$/.test(n) && !pct) t.atkFlat += v;
  else if (/^atk/.test(n))            t.atkPct  += v;
  else if (/^def$/.test(n) && !pct) t.defFlat += v;
  else if (/^def/.test(n))            t.defPct  += v;
  else if (/elemental\s*mastery/i.test(name)) t.em += v;
  else if (/energy\s*recharge/i.test(name))   t.er += v;
  else if (/crit\s*rate/i.test(name))         t.cr += v;
  else if (/crit\s*(?:dmg|damage)/i.test(name)) t.cd += v;
  else if (/physical\s*dmg/i.test(name))      t.phys += v;
  else {
    for (const k of ELEM_KEYS) {
      if (new RegExp(`${k}\\s*DMG`, 'i').test(name)) { t.elem[k] += v; break; }
    }
  }
}

/* ========================= API helpers ========================= */
// เรียก Gemini ผ่าน API ภายในโปรเจกต์
async function askGeminiAdvice(
  character: string,
  gear: Partial<Record<GiSlot, GearItem>>
): Promise<string | null> {
  try {
    const slim: Record<string, any> = {};
    (['Flower','Plume','Sands','Goblet','Circlet'] as const).forEach((slot) => {
      const it = gear[slot];
      if (!it) return;
      slim[slot] = {
        set: it.setName ?? null,
        main: it.mainStat ? `${it.mainStat.name} ${it.mainStat.value}` : null,
        subs: (it.substats || []).map((s) => `${s.name} ${s.value}`),
      };
    });

    const r = await fetch('/api/gi-advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'advice', character, gear: slim }),
    });
    const j = await r.json().catch(() => null);
    if (j?.ok && typeof j.text === 'string' && j.text.trim()) return j.text.trim();
  } catch {}
  return null;
}

// ดึง base stat จาก DB ผ่าน API ภายใน
type GiBase = {
  hp: number; atk: number; def: number; em: number;
  er: number; cr: number; cd: number;
  elem: { pyro: number; hydro: number; cryo: number; electro: number; anemo: number; geo: number; dendro: number; physical: number };
};
async function fetchGiBase(character: string): Promise<GiBase | null> {
  try {
    const r = await fetch('/api/gi-advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'base', character }),
    });
    const j = await r.json().catch(() => null);
    return j?.ok ? (j.base as GiBase) : null;
  } catch { return null; }
}

/* ========================= Local fallback ========================= */
function buildLocalSummary(characterName: string | undefined, t: Totals) {
  const elemMax = ELEM_KEYS.map(k => ({ k, v: t.elem[k] })).sort((a,b)=>b.v-a.v)[0];

  const tips: string[] = [];
  if (t.cd < 120) tips.push('คริดาเมจยังน้อย (<120%) → หา CD เพิ่มจากซับ/หมวก');
  if (t.cr < 55)  tips.push('คริเรตต่ำ (<55%) → ต้องการ CR เพิ่ม');
  if (t.er < 130) tips.push('Energy Recharge ต่ำ → เป้าหมาย ~140% ขึ้นไป');
  if (elemMax.v > 0) tips.push(`มีโบนัสธาตุเด่น: ${elemMax.k} DMG ~${elemMax.v.toFixed(1)}%`);
  if (elemMax.v === 0 && t.phys === 0) tips.push('ยังไม่มีโบนัสธาตุ/ฟิสิคัลจากโกเบล็ต → ใช้ Goblet ธาตุให้ตรงคาแรกเตอร์');

  const lines = [
    `สรุปรวมหลังใส่ของ:`,
    `• HP ${Math.round(t.hpFlat)} | ATK ${Math.round(t.atkFlat)} | DEF ${Math.round(t.defFlat)}`,
    `• EM ${Math.round(t.em)} | ER ${t.er.toFixed(1)}% | CR ${t.cr.toFixed(1)}% | CD ${t.cd.toFixed(1)}%`,
    `• DMG Bonus: Pyro ${t.elem.Pyro.toFixed(1)}% / Hydro ${t.elem.Hydro.toFixed(1)}% / Cryo ${t.elem.Cryo.toFixed(1)}% / Electro ${t.elem.Electro.toFixed(1)}% / Anemo ${t.elem.Anemo.toFixed(1)}% / Geo ${t.elem.Geo.toFixed(1)}% / Dendro ${t.elem.Dendro.toFixed(1)}% / Phys ${t.phys.toFixed(1)}%`,
    'ข้อเสนอแนะ:',
    ...(tips.length ? tips.map(s=>'• '+s) : ['• โอเคดีแล้ว']),
  ];

  const who = characterName ? `สำหรับ ${characterName}` : '';
  const summary = [`ผลคำนวณ${who}`, ...lines].join('\n');
  return { lines, summary };
}

/* ========================= Public API ========================= */
export async function analyzeGiArtifacts(
  characterName: string | undefined,
  gearMap: Partial<Record<GiSlot, GearItem>>
): Promise<GiAnalyzeResult> {
  // 1) รวมสเตตจากของ
  const totals = emptyTotals();
  (['Flower','Plume','Sands','Goblet','Circlet'] as const).forEach((slot) => {
    const it = gearMap[slot];
    if (!it) return;
    if (it.mainStat) add(totals, it.mainStat.name, it.mainStat.value);
    (it.substats || []).forEach(s => add(totals, s.name, s.value));
  });

  // 2) ผสาน base stat จาก DB (ถ้ามี)
  const base = characterName ? await fetchGiBase(characterName) : null;
  if (base) {
    totals.er += base.er ?? 0;
    totals.cr += base.cr ?? 0;
    totals.cd += base.cd ?? 0;
    totals.elem.Pyro    += base.elem.pyro;
    totals.elem.Hydro   += base.elem.hydro;
    totals.elem.Cryo    += base.elem.cryo;
    totals.elem.Electro += base.elem.electro;
    totals.elem.Anemo   += base.elem.anemo;
    totals.elem.Geo     += base.elem.geo;
    totals.elem.Dendro  += base.elem.dendro;
    totals.phys         += base.elem.physical;
  } else {
    // fallback ฐานขั้นต่ำให้ดูสมจริง
    totals.er += 100; totals.cr += 5; totals.cd += 50;
  }

  // 3) ถาม Gemini
  const who = characterName || 'ตัวละคร';
  const ai = await askGeminiAdvice(who, gearMap);

  if (ai) {
    return {
      character: characterName,
      totals,
      lines: ai.split(/\r?\n/).slice(0, 20),
      aiText: ai,
      summary: ai,
      used: 'gemini',
    };
  }

  // 4) fallback
  const local = buildLocalSummary(characterName, totals);
  return {
    character: characterName,
    totals,
    lines: local.lines,
    aiText: null,
    summary: local.summary,
    used: 'local',
  };
}

export function formatGiAdvice(res: GiAnalyzeResult): string {
  return (res.aiText && res.aiText.trim()) || res.summary;
}
