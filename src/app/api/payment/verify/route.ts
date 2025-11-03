import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Body = {
  username?: string;
  expectedAmount?: number;
  actualAmount?: number;
  ref?: string;
};

type UserRow = { balance: number | null };

/* ---------------- Supabase Client ---------------- */
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, // ใช้ anon key (ต้องมี RLS policy ให้สิทธิอ่าน/อัปเดต)
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/* ---------------- Helpers ---------------- */
async function getBalance(username: string): Promise<number> {
  const { data, error } = await supabase
    .from("users")
    .select("balance")
    .eq("username", username)
    .single<UserRow>();

  if (error || !data) return 0;
  return Number(data.balance ?? 0);
}

async function addBalance(username: string, delta: number): Promise<number> {
  // สเต็ปง่าย ๆ: อ่าน -> คำนวณ -> อัปเดต (ต้องมี RLS UPDATE)
  const current = await getBalance(username);
  const next = Math.round((current + delta) * 100) / 100;

  const { error } = await supabase
    .from("users")
    .update({ balance: next })
    .eq("username", username);

  if (error) throw error;
  return next;
}

/* ---------------- Route ---------------- */
export async function POST(req: NextRequest) {
  try {
    const ct = req.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      return NextResponse.json({ error: "JSON only" }, { status: 400 });
    }

    const body = (await req.json()) as Body;
    const expected = Number(body.expectedAmount);
    const actual = Number(body.actualAmount);
    const username = (body.username || "").trim();

    if (!isFinite(expected) || !isFinite(actual)) {
      return NextResponse.json({ status: "fail", reason: "bad_number" }, { status: 400 });
    }

    // จ่ายตรงเป๊ะ
    if (Math.abs(actual - expected) < 0.01) {
      const newBalance = username ? await getBalance(username) : undefined;
      return NextResponse.json({ status: "ok", actual, newBalance });
    }

    // จ่ายไม่พอ
    if (actual < expected) {
      const diff = Number((expected - actual).toFixed(2));
      const newBalance = username ? await getBalance(username) : undefined;
      return NextResponse.json({ status: "under", diff, actual, newBalance });
    }

    // โอนเกิน → เก็บส่วนต่างเข้ากระเป๋า
    const over = Number((actual - expected).toFixed(2));
    const newBalance = username ? await addBalance(username, over) : undefined;

    return NextResponse.json({ status: "over", diff: over, actual, newBalance });
  } catch (e) {
    console.error("verify error:", e);
    return NextResponse.json({ status: "fail" }, { status: 500 });
  }
}
