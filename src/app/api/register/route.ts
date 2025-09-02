// /src/app/api/register/route.ts
import { NextRequest, NextResponse } from 'next/server';
import mysql, { RowDataPacket } from 'mysql2/promise';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username, password, tel, email } = body || {};

    if (!username || !password) {
      return NextResponse.json(
        { message: 'username/password required' },
        { status: 400 }
      );
    }

    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'sql12.freesqldatabase.com',
      user: process.env.DB_USER || 'sql12796984',
      password: process.env.DB_PASS || 'n72gyyb4KT',
      database: process.env.DB_NAME || 'sql12796984',
    });

    // ตรวจซ้ำ username
    const [rows] = await conn.execute<RowDataPacket[]>(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );
    if (rows.length > 0) {
      await conn.end();
      return NextResponse.json(
        { message: 'Username นี้ถูกใช้แล้ว' },
        { status: 409 }
      );
    }

    // แทรกข้อมูล
    await conn.execute(
      'INSERT INTO users (username, password, tel, email) VALUES (?, ?, ?, ?)',
      [username, password, tel || null, email || null]
    );

    await conn.end();
    return NextResponse.json({ ok: true });
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : 'error';
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
