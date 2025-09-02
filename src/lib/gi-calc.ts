// /src/lib/gear-calc.ts
import type { GearItem, GiSlot } from '@/lib/gear-ocr';

type Totals = {
  hpFlat: number; hpPct: number;
  atkFlat: number; atkPct: number;
  defFlat: number; defPct: number;
  em: number; er: number; cr: number; cd: number;
  elem: Record<'Pyro'|'Hydro'|'Cryo'|'Electro'|'Anemo'|'Geo'|'Dendro', number>;
  phys: number;
};

const ELEM_KEYS: Array<keyof Totals['elem']> = ['Pyro','Hydro','Cryo','Electro','Anemo','Geo','Dendro'];

function emptyTotals(): Totals {
  return {
    hpFlat:0, hpPct:0, atkFlat:0, atkPct:0, defFlat:0, defPct:0,
    em:0, er:0, cr:0, cd:0,
    elem: { Pyro:0, Hydro:0, Cryo:0, Electro:0, Anemo:0, Geo:0, Dendro:0 },
    phys:0
  };
}

function add(t: Totals, name: string, value: string) {
  const v = parseFloat(String(value).replace(/[, ]/g, '').replace('%','')) || 0;
  const isPct = /%$/.test(String(value));
  const n = name.toLowerCase();

  if (/^hp$/.test(n) && !isPct) t.hpFlat += v;
  else if (/^hp/.test(n))       t.hpPct  += v;
  else if (/^atk$/.test(n) && !isPct) t.atkFlat += v;
  else if (/^atk/.test(n))            t.atkPct  += v;
  else if (/^def$/.test(n) && !isPct) t.defFlat += v;
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

export type GiAnalyzeResult = {
  character?: string;
  totals: Totals;
  lines: string[];
  summary: string;
};

/**
 * วิเคราะห์ Artifact รวม 5 ชิ้น (เวอร์ชันที่ page.tsx ของคุณเรียกใช้)
 * ลำดับพารามิเตอร์ = (characterName, gearMap)
 */
export async function analyzeGiArtifacts(
  characterName: string | undefined,
  gearMap: Partial<Record<GiSlot, GearItem>>
): Promise<GiAnalyzeResult> {
  const t = emptyTotals();

  (['Flower','Plume','Sands','Goblet','Circlet'] as const).forEach((slot) => {
    const it = gearMap[slot];
    if (!it) return;
    if (it.mainStat) add(t, it.mainStat.name, it.mainStat.value);
    (it.substats || []).forEach(s => add(t, s.name, s.value));
  });

  const elemMax = ELEM_KEYS.map(k => ({ k, v: t.elem[k] })).sort((a,b)=>b.v-a.v)[0];

  const tips: string[] = [];
  if (t.cd < 70) tips.push('คริดาเมจค่อนข้างต่ำ → หาจำนวนคริดาเมจเพิ่ม');
  if (t.cr < 40) tips.push('โอกาสคริต่ำ → ลองหาวงแหวนคริติคอล/ซับคริ');
  if (t.er < 120) tips.push('Energy Recharge ค่อนข้างต่ำ → ควรมีสัก ~140%');
  if (elemMax.v > 0) tips.push(`มีโบนัสธาตุเด่น: ${elemMax.k} DMG ~${elemMax.v.toFixed(1)}%`);
  if (elemMax.v === 0 && t.phys === 0) tips.push('ยังไม่มีโบนัสธาตุ/ฟิสิคัลจากโกเบล็ต → ลองใช้โกเบล็ตธาตุให้ตรงตัวละคร');

  const lines = [
    `สรุปรวมหลังใส่ของ:`,
    `• HP ${Math.round(t.hpFlat)} | ATK ${Math.round(t.atkFlat)} | DEF ${Math.round(t.defFlat)}`,
    `• EM ${Math.round(t.em)} | ER ${t.er.toFixed(1)}% | CR ${t.cr.toFixed(1)}% | CD ${t.cd.toFixed(1)}%`,
    `• DMG Bonus: Pyro ${t.elem.Pyro.toFixed(1)}% / Hydro ${t.elem.Hydro.toFixed(1)}% / Cryo ${t.elem.Cryo.toFixed(1)}% / Electro ${t.elem.Electro.toFixed(1)}% / Anemo ${t.elem.Anemo.toFixed(1)}% / Geo ${t.elem.Geo.toFixed(1)}% / Dendro ${t.elem.Dendro.toFixed(1)}% / Phys ${t.phys.toFixed(1)}%`,
    'ข้อเสนอแนะ:',
    ...(tips.length ? tips.map(s=>'• '+s) : ['• โอเคดีแล้ว'])
  ];

  const who = characterName ? `สำหรับ ${characterName}` : '';
  const summary = [`ผลคำนวณ${who}`, ...lines].join('\n');

  return { character: characterName, totals: t, lines, summary };
}

/** แปลงผลรวมเป็นข้อความสั้นส่งเข้าแชท */
export function formatGiAdvice(res: GiAnalyzeResult): string {
  return res.summary;
}
