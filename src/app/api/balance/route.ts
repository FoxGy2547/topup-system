import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// 🔹 ตั้งค่า Supabase Client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const username = searchParams.get("username")?.trim();

    if (!username) {
      return NextResponse.json(
        { ok: false, message: "username required" },
        { status: 400 }
      );
    }

    // 🔸 อ่าน balance จากตาราง users
    const { data, error } = await supabase
      .from("users")
      .select("balance")
      .eq("username", username)
      .single<{ balance: number | null }>();

    if (error || !data) {
      return NextResponse.json(
        { ok: false, message: "user not found" },
        { status: 404 }
      );
    }

    const balance = Number(data.balance ?? 0);
    return NextResponse.json({ ok: true, balance });
  } catch (e) {
    console.error("balance error:", e);
    return NextResponse.json(
      { ok: false, message: "db error" },
      { status: 500 }
    );
  }
}
