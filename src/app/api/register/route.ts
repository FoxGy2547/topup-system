import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// 🔹 สร้าง Supabase Client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, // anon key
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username, password, tel, email } = body || {};

    if (!username || !password) {
      return NextResponse.json(
        { message: "username/password required" },
        { status: 400 }
      );
    }

    // 🔸 ตรวจว่าชื่อซ้ำหรือไม่
    const { data: existing, error: checkErr } = await supabase
      .from("users")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (checkErr) {
      console.error("checkErr", checkErr);
      return NextResponse.json(
        { message: "database error" },
        { status: 500 }
      );
    }

    if (existing) {
      return NextResponse.json(
        { message: "Username นี้ถูกใช้แล้ว" },
        { status: 409 }
      );
    }

    // 🔸 แทรกข้อมูลผู้ใช้ใหม่
    const { error: insertErr } = await supabase
      .from("users")
      .insert([
        {
          username,
          password,
          tel: tel || null,
          email: email || null,
          balance: 0, // ใส่ค่าเริ่มต้นไว้ด้วยก็ได้
        },
      ]);

    if (insertErr) {
      console.error("insertErr", insertErr);
      return NextResponse.json(
        { message: "insert error" },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { message: "internal error" },
      { status: 500 }
    );
  }
}
