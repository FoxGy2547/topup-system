import { NextResponse } from "next/server";
import mysql, { RowDataPacket } from "mysql2/promise";

const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "chatbot_db",
  connectionLimit: 10,
});

export async function POST(req: Request) {
  const { name } = await req.json();
  if (!name) {
    return NextResponse.json({ success: false, message: "กรุณาระบุชื่อ relic set" });
  }

  const [rows]: [RowDataPacket[], any] = await db.query(
    "SELECT * FROM items_hsr WHERE name LIKE ? OR short_id LIKE ?",
    [`%${name}%`, `%${name}%`]
  );

  if (!rows.length) {
    return NextResponse.json({ success: false, message: `ไม่พบ relic set: ${name}` });
  }

  return NextResponse.json({ success: true, data: rows });
}
