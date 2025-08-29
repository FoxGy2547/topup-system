// /src/app/api/payment/verify/route.ts
import { NextRequest, NextResponse } from "next/server";
import mysql from "mysql2/promise";

export const runtime = "nodejs";

type Body = {
  username?: string;
  expectedAmount?: number;
  actualAmount?: number;
  ref?: string;
};

// --- DB pool (แก้ ENV ตามเครื่องได้) ---
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "chatbot_db",
  charset: "utf8mb4_general_ci",
  waitForConnections: true,
  connectionLimit: 10,
});

async function getBalance(username: string): Promise<number> {
  const [rows] = await pool.query("SELECT balance FROM users WHERE username=?", [username]);
  const r = Array.isArray(rows) ? (rows as any[])[0] : undefined;
  return Number(r?.balance ?? 0);
}
async function addBalance(username: string, delta: number): Promise<number> {
  await pool.query("UPDATE users SET balance = IFNULL(balance,0) + ? WHERE username=?", [delta, username]);
  return getBalance(username);
}

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

    // ตรงเป๊ะ
    if (Math.abs(actual - expected) < 0.01) {
      let newBalance: number | undefined;
      if (username) newBalance = await getBalance(username);
      return NextResponse.json({ status: "ok", actual, newBalance });
    }

    // จ่ายไม่พอ
    if (actual < expected) {
      const diff = Number((expected - actual).toFixed(2));
      let newBalance: number | undefined;
      if (username) newBalance = await getBalance(username);
      return NextResponse.json({ status: "under", diff, actual, newBalance });
    }

    // โอนเกิน → เก็บส่วนต่างเข้ากระเป๋า
    const over = Number((actual - expected).toFixed(2));
    let newBalance: number | undefined;
    if (username) {
      newBalance = await addBalance(username, over);
    }
    return NextResponse.json({ status: "over", diff: over, actual, newBalance });
  } catch (e) {
    console.error("verify error:", e);
    return NextResponse.json({ status: "fail" }, { status: 500 });
  }
}
