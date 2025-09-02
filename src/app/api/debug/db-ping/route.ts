import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
export const runtime = 'nodejs';
export async function GET() {
  try {
    const pool = getPool();
    const [dbName]: any = await pool.query('SELECT DATABASE() AS db');
    return NextResponse.json({ ok: true, db: dbName?.[0]?.db || null });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
