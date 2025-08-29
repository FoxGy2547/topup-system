// /src/app/api/user/update-balance/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { username, amount } = await req.json();
    if (!username || typeof amount !== 'number' || !isFinite(amount)) {
      return NextResponse.json({ ok: false, message: 'bad params' }, { status: 400 });
    }
    const pool = getPool();

    // ใช้ transaction กัน race condition เล็ก ๆ
    await pool.query('START TRANSACTION');

    const [rows] = await pool.query('SELECT balance FROM users WHERE username = ? FOR UPDATE', [username]);
    const row = Array.isArray(rows) ? (rows as any[])[0] : null;
    if (!row) {
      await pool.query('ROLLBACK');
      return NextResponse.json({ ok: false, message: 'user not found' }, { status: 404 });
    }

    const current = Number(row.balance ?? 0);
    const next = Number((current + amount).toFixed(2));

    await pool.query('UPDATE users SET balance = ? WHERE username = ?', [next, username]);
    await pool.query('COMMIT');

    return NextResponse.json({ ok: true, balance: next });
  } catch (e) {
    try {
      const pool = getPool();
      await pool.query('ROLLBACK');
    } catch {}
    return NextResponse.json({ ok: false, message: 'db error' }, { status: 500 });
  }
}
