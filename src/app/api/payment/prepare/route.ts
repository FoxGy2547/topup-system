// /src/app/api/payment/prepare/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
  try {
    const { username, amount } = await req.json();
    const want = Number(amount ?? 0);

    if (!username || !isFinite(want) || want <= 0) {
      return NextResponse.json({ ok: false, message: "bad input" }, { status: 400 });
    }

    // 1) อ่าน balance ปัจจุบัน
    const { data: user, error: selErr } = await supabase
      .from("users")
      .select("balance")
      .eq("username", username)
      .single<{ balance: number | null }>();

    if (selErr || !user) {
      return NextResponse.json({ ok: false, message: "user not found" }, { status: 404 });
    }

    const bal = Number(user.balance ?? 0);

    // 2) คำนวณยอดที่จะหักจากกระเป๋า
    const applied = Math.min(bal, want);
    const remaining = Number((want - applied).toFixed(2));
    const newBalance = Number((bal - applied).toFixed(2));

    // 3) อัปเดต balance ถ้ามีการหักจริง
    if (applied > 0) {
      const { error: updErr } = await supabase
        .from("users")
        .update({ balance: newBalance })
        .eq("username", username);

      if (updErr) {
        return NextResponse.json({ ok: false, message: "db error" }, { status: 500 });
      }
    }

    return NextResponse.json({
      ok: true,
      applied,       // ยอดที่หักจากกระเป๋าแล้ว
      remaining,     // ยอดที่ยังต้องชำระเพิ่ม
      newBalance,    // ยอดคงเหลือใหม่
    });
  } catch {
    return NextResponse.json({ ok: false, message: "db error" }, { status: 500 });
  }
}
