// /src/app/api/user/update-balance/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const pool = getPool();

  try {
    const { username, amount } = await req.json();

    if (!username || typeof amount !== 'number' || !isFinite(amount)) {
      return NextResponse.json({ ok: false, message: 'bad params' }, { status: 400 });
    }

    // ใช้ทรานแซกชัน + อัปเดตแบบนิพจน์ (atomic) ป้องกัน race และปัดทศนิยมให้เรียบร้อย
    await pool.query('START TRANSACTION');

    const [res] = await pool.query(
      'UPDATE users SET balance = ROUND(COALESCE(balance, 0) + ?, 2) WHERE username = ?',
      [amount, username]
    );

    // ตรวจผลว่าอัปเดตโดนแถวไหม
    const updated = (res as any)?.affectedRows ?? (res as any)?.rowCount ?? 0;
    if (!updated) {
      await pool.query('ROLLBACK');
      return NextResponse.json({ ok: false, message: 'user not found' }, { status: 404 });
    }

    // อ่านค่าใหม่เพื่อส่งกลับ
    const [rows] = await pool.query('SELECT balance FROM users WHERE username = ? LIMIT 1', [username]);
    const row = Array.isArray(rows) ? (rows as any[])[0] : null;

    await pool.query('COMMIT');

    const balance = row && row.balance != null ? Number(row.balance) : 0;
    return NextResponse.json({ ok: true, balance });
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    return NextResponse.json({ ok: false, message: 'db error' }, { status: 500 });
  }
}
