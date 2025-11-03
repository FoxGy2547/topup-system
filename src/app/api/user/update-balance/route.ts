// /src/app/api/user/update-balance/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// ✅ สร้าง Supabase client (ใช้ anon key ถ้าแค่ update ได้ ให้เปิด policy เขียนก่อน)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
  try {
    const { username, amount } = await req.json();

    if (!username || typeof amount !== "number" || !isFinite(amount)) {
      return NextResponse.json({ ok: false, message: "bad params" }, { status: 400 });
    }

    // 🔹 ดึง balance ปัจจุบัน
    const { data: userRow, error: userErr } = await supabase
      .from("users")
      .select("balance")
      .eq("username", username)
      .single();

    if (userErr || !userRow) {
      return NextResponse.json({ ok: false, message: "user not found" }, { status: 404 });
    }

    const oldBalance = Number(userRow.balance ?? 0);
    const newBalance = Math.round((oldBalance + amount) * 100) / 100;

    // 🔹 อัปเดต balance
    const { error: updateErr } = await supabase
      .from("users")
      .update({ balance: newBalance })
      .eq("username", username);

    if (updateErr) {
      console.error("update error:", updateErr);
      return NextResponse.json({ ok: false, message: "db error" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, balance: newBalance });
  } catch (e) {
    console.error("internal error:", e);
    return NextResponse.json({ ok: false, message: "internal error" }, { status: 500 });
  }
}
