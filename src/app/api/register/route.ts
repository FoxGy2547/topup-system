// /src/app/api/register/route.ts
import { NextResponse } from 'next/server';
import mysql from 'mysql2/promise';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { username, password, tel, email } = body || {};

    if (!username || !password) {
      return NextResponse.json({ message: 'username/password required' }, { status: 400 });
    }

    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'chatbot_db',
    });

    // ตรวจซ้ำ username
    const [rows] = await conn.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (Array.isArray(rows) && rows.length > 0) {
      await conn.end();
      return NextResponse.json({ message: 'Username นี้ถูกใช้แล้ว' }, { status: 409 });
    }

    // แทรกข้อมูล (ตามคอลัมน์ในรูป)
    await conn.execute(
      'INSERT INTO users (username, password, tel, email) VALUES (?, ?, ?, ?)',
      [username, password, tel || null, email || null]
    );

    await conn.end();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ message: e?.message || 'error' }, { status: 500 });
  }
}
