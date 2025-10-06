// src/app/api/sets/route.ts
import { NextResponse } from "next/server";
import mysql from "mysql2/promise";

export const dynamic = "force-dynamic"; // กัน build-time caching

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const game = (searchParams.get("game") || "hsr") as "gi" | "hsr";
    const table = game === "gi" ? "items_gi" : "items_hsr";

    const pool = mysql.createPool({
      host: process.env.DB_HOST!,
      user: process.env.DB_USER!,
      password: process.env.DB_PASS!,
      database: process.env.DB_NAME!,
      connectionLimit: 10,
    });

    const [rows] = await pool.query(
      `SELECT name, short_id, set_kind FROM ${table}`
    );

    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    console.error("GET /api/sets error:", e);
    return NextResponse.json({ ok: false, rows: [] }, { status: 500 });
  }
}
