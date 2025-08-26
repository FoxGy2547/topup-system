import { NextResponse } from "next/server";
import mysql, { RowDataPacket } from "mysql2/promise";

const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "chatbot_db",
  connectionLimit: 10,
});

type GameKey = "gi" | "hsr";
type StateKey =
  | "idle"
  | "waiting_gi"
  | "waiting_hsr"
  | "waiting_uid_gi"
  | "waiting_uid_hsr"
  | "confirm_order"
  | "waiting_artifact_char"
  | "waiting_relic_char";

type Session = {
  state: StateKey;
  game?: GameKey;
  selectedIndex?: number; // 0-based
  selectedName?: string;
  selectedPrice?: number;
  uid?: string;
  playerName?: string; // อาจว่างใน HSR
};

const sessions: Record<string, Session> = Object.create(null);
function getSession(key: string) {
  if (!sessions[key]) sessions[key] = { state: "idle" };
  return sessions[key];
}
function ukey(u?: string) { return u || "__anon__"; }

async function fetchProducts(game: GameKey) {
  const [rows]: [RowDataPacket[], any] = await db.query(
    "SELECT name, price FROM products WHERE gname = ? ORDER BY id",
    [game]
  );
  return rows as Array<{ name: string; price: number }>;
}
function renderProductList(rows: Array<{ name: string; price: number }>) {
  return rows.map((p, i) => `${i + 1}. ${p.name} - ${Number(p.price).toFixed(2)} บาท`).join("\n\n");
}
function parseAmountToReceive(game: GameKey, productName: string): string {
  // ดึงตัวเลขรวมชิ้น ถ้ามี เช่น "1090 Genesis Crystals ..."
  const m = productName.match(/^(\d[\d,]*)\s+(Genesis|Oneiric)/i);
  if (m) {
    const qty = m[1].replace(/,/g, "");
    const unit = /Genesis/i.test(m[2]) ? "Genesis Crystals" : "Oneiric Shard";
    return `${qty} ${unit}`;
  }
  // blessing / pass
  return productName;
}

async function fetchPlayerName(game: GameKey, uid: string): Promise<string> {
  try {
    const ua = { "User-Agent": "Mozilla/5.0 Chatbot" };
    if (game === "gi") {
      // JSON (ถ้าใช้ได้)
      const r1 = await fetch(`https://enka.network/api/uid/${uid}`, { headers: ua, cache: "no-store" });
      if (r1.ok) {
        const j = await r1.json().catch(() => null);
        const name = j?.playerInfo?.nickname || j?.player?.nickname || j?.owner?.nickname;
        if (name) return String(name);
      }
      // HTML fallback
      const r2 = await fetch(`https://enka.network/u/${uid}/`, { headers: ua, cache: "no-store" });
      if (r2.ok) {
        const html = await r2.text();
        // ตัวอย่างไตเติ้ล: "ตู้โชว์ตัวละครของ FoxGy | Enka.Network"
        const m = html.match(/ของ\s+(.+?)\s+\|/);
        if (m) return m[1].trim();
      }
    } else {
      // HSR: ลอง JSON endpoint (อาจไม่เปิด) แล้ว fallback HTML
      const r1 = await fetch(`https://enka.network/api/hsr/uid/${uid}`, { headers: ua, cache: "no-store" });
      if (r1.ok) {
        const j = await r1.json().catch(() => null);
        const name = j?.playerInfo?.nickname || j?.owner?.nickname;
        if (name) return String(name);
      }
      const r2 = await fetch(`https://enka.network/hsr/${uid}/`, { headers: ua, cache: "no-store" });
      if (r2.ok) {
        const html = await r2.text();
        // ไตเติ้ล: "Character Showcase of FoxGy | Enka.Network" (อังกฤษ) หรือรูปแบบคล้ายกัน
        let m = html.match(/of\s+(.+?)\s+\|/i);
        if (m) return m[1].trim();
        m = html.match(/ของ\s+(.+?)\s+\|/);
        if (m) return m[1].trim();
      }
    }
  } catch { /* ignore */ }
  return game === "gi" ? "" : "";
}

/**
 * แปลง short_id ของ set เป็นคำอธิบายที่มนุษย์อ่าน:
 * - "A+B"   => "<A> 2 ชิ้น + <B> 2 ชิ้น"
 * - "A/B"   => "<A> 4 ชิ้น หรือ <B> 4 ชิ้น"
 * - "A"     => "<A> 4 ชิ้น"
 */
async function resolveSetDisplay(game: GameKey, setShortRaw: string) {
  const table = game === "gi" ? "items_gi" : "items_hsr";

  const isPlus = setShortRaw.includes('+');    // 2+2
  const divider = isPlus ? '+' : '/';          // '+' : 'หรือ'
  const parts = setShortRaw.split(divider).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return setShortRaw;

  const ph = parts.map(() => "?").join(",");
  const [rows]: [RowDataPacket[], any] = await db.query(
    `SELECT short_id, name FROM ${table} WHERE short_id IN (${ph})`,
    parts
  );
  const map = new Map<string, string>();
  (rows as any[]).forEach(r => map.set(r.short_id, r.name));

  // 2+2
  if (isPlus) {
    if (parts.length === 2) {
      const [a, b] = parts;
      const n1 = map.get(a) || a;
      const n2 = map.get(b) || b;
      return `${n1} 2 ชิ้น + ${n2} 2 ชิ้น`;
    }
    return parts.map(p => (map.get(p) || p) + ' 2 ชิ้น').join(' + ');
  }

  // A/B (เลือกแบบใดแบบหนึ่ง 4 ชิ้น)
  if (parts.length === 1) {
    const a = parts[0];
    const n = map.get(a);
    return n ? `${n} 4 ชิ้น` : a;
  }
  if (parts.length === 2) {
    const [a, b] = parts;
    const n1 = map.get(a) || a;
    const n2 = map.get(b) || b;
    return `${n1} 4 ชิ้น หรือ ${n2} 4 ชิ้น`;
  }
  return parts.map(p => (map.get(p) || p) + ' 4 ชิ้น').join(' หรือ ');
}

export async function POST(req: Request) {
  const { message, username, password } = await req.json();
  const text: string = (message || "").toString().trim();
  const lower = text.toLowerCase();
  const key = ukey(username);
  const s = getSession(key);

  // ---- login (เรียกด้วย {username,password})
  if (username && password && !message) {
    try {
      const [users]: [RowDataPacket[], any] = await db.query(
        "SELECT * FROM users WHERE username = ? AND password = ?",
        [username, password]
      );
      if (Array.isArray(users) && users.length > 0) {
        return NextResponse.json({ success: true, message: "เข้าสู่ระบบสำเร็จ" }, { status: 200 });
      }
      return NextResponse.json({ success: false, message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 });
    } catch (e) {
      return NextResponse.json({ success: false, message: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" }, { status: 500 });
    }
  }

  // ---- confirm order
  if (s.state === "confirm_order") {
    if (/^ยืนยัน$/i.test(text)) {
      const gameName = s.game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
      const uid = s.uid || "-";
      const player = (s.playerName && s.playerName.trim()) || (s.game === "gi" ? "-" : "");
      const pkg = s.selectedName || "-";
      const price = s.selectedPrice ?? 0;

      // reset session
      sessions[key] = { state: "idle" };

      const reply =
        `รับคำยืนยันแล้วค่ะ ✅\n` +
        `ยอดชำระ: ${price.toFixed(2)} บาท\n` +
        `แพ็กเกจ: ${pkg}\n` +
        `UID: ${uid}\n` +
        `ชื่อผู้เล่น: ${player || "-"}\n\n` +
        `กรุณาสแกน QR เพื่อชำระเงินได้เลยค่ะ`;

      return NextResponse.json({
        reply,
        quickReplies: [], // หน้าเว็บจะโชว์ปุ่มอัปโหลดสลิปแทน
        paymentRequest: { showQR: true },
      });
    }
    if (/^ยกเลิก$/i.test(text)) {
      sessions[key] = { state: "idle" };
      return NextResponse.json({
        reply: "ยกเลิกคำสั่งซื้อแล้วค่ะ ถ้าต้องการเริ่มใหม่ เลือกเมนูด้านล่างได้เลย",
        quickReplies: [],
      });
    }
    // ถ้าพิมพ์อย่างอื่น ขอกดยืนยัน/ยกเลิกก่อน
    return NextResponse.json({
      reply: "กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก",
      quickReplies: ["ยืนยัน", "ยกเลิก"],
    });
  }

  // ---- รอ UID หลังเลือกแพ็ก
  if (s.state === "waiting_uid_gi" || s.state === "waiting_uid_hsr") {
    const uidOnly = text.replace(/\D/g, "");
    if (!uidOnly) {
      return NextResponse.json({ reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ" });
    }
    s.uid = uidOnly;

    // ดึงชื่อผู้เล่น (GI จะพยายามให้ขึ้นชื่อจริง, HSR อนุโลมว่างได้)
    const game: GameKey = s.state === "waiting_uid_gi" ? "gi" : "hsr";
    const player = await fetchPlayerName(game, uidOnly).catch(() => "");
    s.playerName = player || (game === "hsr" ? "" : "");

    const gameName = game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
    const pkg = s.selectedName || "-";
    const price = s.selectedPrice ?? 0;
    const amount = parseAmountToReceive(game, pkg);

    // ต่อไปคือขั้น "รอยืนยัน"
    s.state = "confirm_order";

    const reply =
      `สรุปรายการสั่งซื้อ (รอยืนยัน)\n` +
      `เกม: ${gameName}\n` +
      `UID: ${uidOnly}\n` +
      `ชื่อผู้เล่น: ${s.playerName || "-"}\n` +
      `แพ็กเกจ: ${pkg}\n` +
      `จำนวนที่จะได้รับ: ${amount}\n` +
      `ราคา: ${price.toFixed(2)} บาท\n\n` +
      `กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก`;

    return NextResponse.json({
      reply,
      quickReplies: ["ยืนยัน", "ยกเลิก"],
    });
  }

  // ---- เลือกแพ็ก 1–7 (ตอนอยู่หน้ารายการ)
  const isPick = /^[1-7]$/.test(text);
  if ((s.state === "waiting_gi" || s.state === "waiting_hsr") && isPick) {
    const idx = parseInt(text, 10) - 1;
    const game: GameKey = s.state === "waiting_gi" ? "gi" : "hsr";
    const list = await fetchProducts(game);
    const p = list[idx];
    if (!p) {
      return NextResponse.json({ reply: "หมายเลขไม่ถูกต้องค่ะ กรุณาเลือก 1-7" });
    }
    s.selectedIndex = idx;
    s.selectedName = p.name;
    s.selectedPrice = Number(p.price);
    s.game = game;
    s.state = game === "gi" ? "waiting_uid_gi" : "waiting_uid_hsr";

    return NextResponse.json({ reply: "กรุณาพิมพ์ UID ของคุณ (ตัวเลขเท่านั้น)" });
  }

  // ---- เติมเกม (เปิดรายการ)
  if (lower.includes("เติม genshin impact") || lower.includes("เติมเกนชิน")) {
    const list = await fetchProducts("gi");
    s.state = "waiting_gi";
    s.game = "gi";
    const reply =
      `สวัสดีค่ะ รูบี้ยินดีช่วยเหลือเกี่ยวกับการเติมเงิน Genshin Impact นะคะ\n\n` +
      `${renderProductList(list)}\n\n` +
      `กรุณาพิมพ์หมายเลข 1-7 เพื่อเลือกแพ็กเกจที่ต้องการได้เลยค่ะ`;
    return NextResponse.json({ reply });
  }

  if (lower.includes("เติม honkai: star rail") || lower.includes("เติม hsr")) {
    const list = await fetchProducts("hsr");
    s.state = "waiting_hsr";
    s.game = "hsr";
    const reply =
      `สวัสดีค่ะ รูบี้ยินดีช่วยเหลือเกี่ยวกับการเติมเงิน Honkai: Star Rail นะคะ\n\n` +
      `${renderProductList(list)}\n\n` +
      `กรุณาพิมพ์หมายเลข 1-7 เพื่อเลือกแพ็กเกจที่ต้องการได้เลยค่ะ`;
    return NextResponse.json({ reply });
  }

  // ---- Artifact/Relic (ถามชื่อตัวละครก่อน)
  if (lower.includes("ดู artifact genshin impact")) {
    s.state = "waiting_artifact_char";
    s.game = "gi";
    return NextResponse.json({ reply: "อยากดู artifact ของตัวละครไหนคะ? พิมพ์ชื่อมาได้เลย~" });
  }
  if (lower.includes("ดู relic honkai star rail")) {
    s.state = "waiting_relic_char";
    s.game = "hsr";
    return NextResponse.json({ reply: "อยากดู relic ของตัวละครไหนคะ? พิมพ์ชื่อมาได้เลย~" });
  }

  // ---- รับชื่อตัวละครเพื่อดึง set
  if (s.state === "waiting_artifact_char" || s.state === "waiting_relic_char") {
    const game: GameKey = s.state === "waiting_artifact_char" ? "gi" : "hsr";
    const charName = text.trim();

    const [rows]: [RowDataPacket[], any] = await db.query(
      `SELECT set_short FROM character_sets WHERE game = ? AND character_name = ?`,
      [game, charName]
    );

    // reset state
    s.state = "idle";

    if (!rows || rows.length === 0) {
      return NextResponse.json({ reply: `ไม่พบข้อมูลเซ็ตของ ${charName} ค่ะ` });
    }

    const lines: string[] = [];
    for (const r of rows as any[]) {
      const disp = await resolveSetDisplay(game, r.set_short);
      lines.push(`- ${disp}`);
    }
    const head = game === "gi" ? "Artifact" : "Relic";
    return NextResponse.json({
      reply: `${head} ที่เหมาะกับ ${charName} คือ:\n${lines.join("\n")}`,
      quickReplies: ["คำนวณสเตตจากรูป", "ดูเซ็ตตัวอื่น"], // ให้เว็บบังคับเปิดโหมดคำนวณต่อ
    });
  }

  // ---- ไม่เข้าเงื่อนไข
  return NextResponse.json({ reply: "ขอโทษค่ะ ฉันไม่เข้าใจคำถาม กรุณาระบุใหม่อีกครั้งนะคะ!" });
}
