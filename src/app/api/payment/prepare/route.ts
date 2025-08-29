import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { username, amount } = await req.json();
    const want = Number(amount ?? 0);
    if (!username || !isFinite(want) || want <= 0) {
      return NextResponse.json({ ok: false, message: 'bad input' }, { status: 400 });
    }

    const pool = getPool();

    // 1) อ่าน balance ปัจจุบัน
    const [rows] = await pool.query('SELECT balance FROM users WHERE username = ? LIMIT 1', [username]);
    const row = Array.isArray(rows) && (rows as any[])[0];
    const bal = row?.balance != null ? Number(row.balance) : 0;

    // 2) คำนวณยอดที่จะหักจากกระเป๋า
    const applied = Math.min(bal, want);
    const remaining = Number((want - applied).toFixed(2));
    const newBalance = Number((bal - applied).toFixed(2));

    // 3) อัปเดต balance ถ้ามีการหักจริง
    if (applied > 0) {
      await pool.query('UPDATE users SET balance = ? WHERE username = ? LIMIT 1', [newBalance, username]);
    }

    return NextResponse.json({
      ok: true,
      applied,       // ยอดที่หักจากกระเป๋าแล้ว
      remaining,     // ยอดที่ยังต้องชำระเพิ่ม
      newBalance,    // ยอดคงเหลือใหม่
    });
  } catch (e) {
    return NextResponse.json({ ok: false, message: 'db error' }, { status: 500 });
  }
}
