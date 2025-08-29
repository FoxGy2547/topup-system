// /src/app/api/balance/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const username = searchParams.get('username')?.trim();
    if (!username) {
      return NextResponse.json({ ok: false, message: 'username required' }, { status: 400 });
    }

    const pool = getPool();
    const [rows] = await pool.query('SELECT balance FROM users WHERE username = ? LIMIT 1', [username]);

    // ✅ อ่านแถวแรกให้ถูกต้อง แล้วแปลงเป็น number
    const row = Array.isArray(rows) ? (rows as any[])[0] : null;
    const balance = row && row.balance != null ? Number(row.balance) : 0;

    return NextResponse.json({ ok: true, balance });
  } catch (e) {
    return NextResponse.json({ ok: false, message: 'db error' }, { status: 500 });
  }
}
