// src/app/api/gi/analyze/route.ts
import { NextResponse } from 'next/server';
import { getGiBaseByNameOrKey, mapStatName, sumStats, combineTotals, suggestImprovements, GearPiece } from '@/lib/gi-calc';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const character: string = (body.character || '').trim();
    const pieces: GearPiece[] = Array.isArray(body.pieces) ? body.pieces : [];

    if (!character) return NextResponse.json({ ok:false, error:'missing character' }, { status: 400 });
    if (pieces.length < 3) return NextResponse.json({ ok:false, error:'need at least 3 pieces' }, { status: 400 });

    const base = await getGiBaseByNameOrKey(character);
    if (!base) return NextResponse.json({ ok:false, error:'character not found in gi_base_stats' }, { status: 404 });

    // รวมสเตตจาก artifact
    const stats = [];
    for (const p of pieces) {
      if (p?.mainStat) stats.push(mapStatName(p.mainStat.name, p.mainStat.value));
      for (const s of (p.substats || [])) stats.push(mapStatName(s.name, s.value));
    }
    const fromArt = sumStats(stats);

    const combined = combineTotals(base, fromArt);
    const tips = suggestImprovements(base.character_name || character, combined.totals, fromArt);

    return NextResponse.json({
      ok: true,
      character: base.character_name || character,
      base: combined.base,
      fromArtifacts: fromArt,
      totals: combined.totals,
      suggestions: tips,
    });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e?.message || String(e) }, { status: 500 });
  }
}
