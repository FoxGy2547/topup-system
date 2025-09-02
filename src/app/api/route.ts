import { NextResponse } from "next/server";
import mysql, { RowDataPacket } from "mysql2/promise";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* ===================== DB Pool ===================== */
const db = mysql.createPool({
  host: process.env.DB_HOST || 'sql12.freesqldatabase.com',
  user: process.env.DB_USER || 'sql12796984',
  password: process.env.DB_PASS || 'n72gyyb4KT',
  database: process.env.DB_NAME || 'sql12796984',
  connectionLimit: 10,
});

/* ===================== Types ===================== */
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
  selectedIndex?: number;
  selectedName?: string;
  selectedPrice?: number;
  uid?: string;
  playerName?: string;
};

const sessions: Record<string, Session> = Object.create(null);
function getSession(key: string) {
  if (!sessions[key]) sessions[key] = { state: "idle" };
  return sessions[key];
}
function ukey(u?: string) {
  return u || "__anon__";
}

/* ===================== Utils ===================== */
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
function toArabic(s: string) {
  return [...(s || "")]
    .map((c) => {
      const i = THAI_DIGITS.indexOf(c);
      return i >= 0 ? String(i) : c;
    })
    .join("");
}
function normalize(s: string) {
  return toArabic(s)
    .replace(/\u200b/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function matchPackageByName(
  rows: Array<{ name: string; price: number }>,
  userText: string
): number | null {
  const s = normalize(userText);
  for (let i = 0; i < rows.length; i++) {
    const n = normalize(String(rows[i].name));
    if (s.includes(n)) return i;
    const num = String(rows[i].name).match(/\d{2,6}/)?.[0];
    if (num && s.includes(num)) return i;
  }
  return null;
}

/* ===================== Data helpers ===================== */
async function fetchProducts(game: GameKey) {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT name, price FROM products WHERE gname = ? ORDER BY id",
    [game]
  );
  return rows as Array<{ name: string; price: number }>;
}
function renderProductList(rows: Array<{ name: string; price: number }>) {
  return rows
    .map((p, i) => `${i + 1}. ${p.name} - ${Number(p.price).toFixed(2)} บาท`)
    .join("\n\n");
}
function parseAmountToReceive(game: GameKey, productName: string): string {
  const m = productName.match(/^(\d[\d,]*)\s+(Genesis|Oneiric)/i);
  if (m) {
    const qty = m[1].replace(/,/g, "");
    const unit = /Genesis/i.test(m[2]) ? "Genesis Crystals" : "Oneiric Shard";
    return `${qty} ${unit}`;
  }
  return productName;
}

/** ดึงชื่อผู้เล่นจาก enka */
async function fetchPlayerName(game: GameKey, uid: string): Promise<string> {
  try {
    const ua = { "User-Agent": "Mozilla/5.0 Chatbot" };
    if (game === "gi") {
      const r1 = await fetch(`https://enka.network/api/uid/${uid}`, {
        headers: ua,
        cache: "no-store",
      });
      if (r1.ok) {
        const j = await r1.json().catch(() => null);
        const name =
          j?.playerInfo?.nickname ||
          j?.player?.nickname ||
          j?.owner?.nickname;
        if (name) return String(name);
      }
      const r2 = await fetch(`https://enka.network/u/${uid}/`, {
        headers: ua,
        cache: "no-store",
      });
      if (r2.ok) {
        const html = await r2.text();
        const m = html.match(/ของ\s+(.+?)\s+\|/);
        if (m) return m[1].trim();
      }
    } else {
      const r1 = await fetch(`https://enka.network/api/hsr/uid/${uid}`, {
        headers: ua,
        cache: "no-store",
      });
      if (r1.ok) {
        const j = await r1.json().catch(() => null);
        const name = j?.playerInfo?.nickname || j?.owner?.nickname;
        if (name) return String(name);
      }
      const r2 = await fetch(`https://enka.network/hsr/${uid}/`, {
        headers: ua,
        cache: "no-store",
      });
      if (r2.ok) {
        const html = await r2.text();
        let m = html.match(/of\s+(.+?)\s+\|/i);
        if (m) return m[1].trim();
        m = html.match(/ของ\s+(.+?)\s+\|/);
        if (m) return m[1].trim();
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** สร้างข้อความโชว์ชื่อเต็มจากตัวย่อ (สำหรับแชท) */
async function resolveSetDisplay(game: GameKey, setShortRaw: string) {
  const table = game === "gi" ? "items_gi" : "items_hsr";

  const isPlus = setShortRaw.includes("+"); // 2+2
  const divider = isPlus ? "+" : "/";       // GI ใช้ "/" แทน "หรือ"
  const parts = setShortRaw
    .split(divider)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return setShortRaw;

  const ph = parts.map(() => "?").join(",");
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT short_id, name FROM ${table} WHERE short_id IN (${ph})`,
    parts
  );

  const map = new Map<string, string>();
  (rows as RowDataPacket[]).forEach((r) => {
    map.set(r.short_id as string, (r.name as string) || String(r.short_id));
  });

  if (isPlus) {
    if (parts.length === 2) {
      const [a, b] = parts;
      const n1 = map.get(a) || a;
      const n2 = map.get(b) || b;
      return `${n1} 2 ชิ้น + ${n2} 2 ชิ้น`;
    }
    return parts.map((p) => `${map.get(p) || p} 2 ชิ้น`).join(" + ");
  }

  if (parts.length === 1) {
    const a = parts[0];
    const n = map.get(a) || a;
    return `${n} 4 ชิ้น`;
  }
  if (parts.length === 2) {
    const [a, b] = parts;
    const n1 = map.get(a) || a;
    const n2 = map.get(b) || b;
    return `${n1} 4 ชิ้น หรือ ${n2} 4 ชิ้น`;
  }
  return parts.map((p) => `${map.get(p) || p} 4 ชิ้น`).join(" หรือ ");
}

/** ✅ สร้างข้อมูล frontend: แยกเป็นแถวของรายการ (ตัวย่อ + ชื่อเต็ม + จำนวนชิ้น) */
async function expandSetLines(game: GameKey, setShortRaw: string) {
  // return: SetItem[][]
  type SetItem = { short: string; full: string; pieces: number };
  const table = game === "gi" ? "items_gi" : "items_hsr";

  const hasPlus = setShortRaw.includes("+");   // 2+2
  const hasDash = setShortRaw.includes("-");   // HSR pair 4+2
  const sep = hasPlus ? "+" : hasDash ? "-" : "/";

  const tokens = setShortRaw.split(sep).map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return [] as SetItem[][];

  const ph = tokens.map(() => "?").join(",");
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT short_id, name FROM ${table} WHERE short_id IN (${ph})`,
    tokens
  );
  const nameMap = new Map<string, string>();
  (rows as RowDataPacket[]).forEach(r => {
    nameMap.set(String(r.short_id), String(r.name || r.short_id));
  });

  if (!hasPlus && !hasDash) {
    // GI: "A/B/C" -> หลายบรรทัด บรรทัดละ 1 ชิ้น (4 ชิ้น)
    return tokens.map(t => [({
      short: t,
      full: nameMap.get(t) || t,
      pieces: 4,
    })]);
  }

  if (hasDash) {
    // HSR: "Relic-Planar" -> 1 บรรทัด 2 ชิ้น (4 + 2)
    const [a, b] = tokens;
    if (!a || !b) return [];
    return [[
      { short: a, full: nameMap.get(a) || a, pieces: 4 },
      { short: b, full: nameMap.get(b) || b, pieces: 2 },
    ]];
  }

  if (hasPlus) {
    // 2+2: "A+B" -> 1 บรรทัด 2 ชิ้น (2+2)
    return [[
      ...tokens.map(t => ({ short: t, full: nameMap.get(t) || t, pieces: 2 })),
    ]];
  }

  return [];
}

/* ===================== Gemini (fallback-only) ===================== */
const genAI =
  process.env.GEMINI_API_KEY &&
  new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function geminiAssist(user: string) {
  if (!genAI) {
    return (
      "สนใจเติมเกมหรือดูข้อมูล artifact/relic ไหมคะ?\n" +
      "ลองพิมพ์: ‘เติม Genshin Impact’, ‘เติม Honkai: Star Rail’, ‘ดู artifact genshin impact’ หรือ ‘ดู relic honkai star rail’ ได้เลยน้า~"
    );
  }
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const system =
    "You are Ruby, a friendly Thai sales assistant. " +
    "ONLY guide users toward these supported intents: " +
    "1) เติม Genshin Impact, 2) เติม Honkai: Star Rail, 3) ดู artifact genshin impact, 4) ดู relic honkai star rail. " +
    "If the user asks other topics, politely steer them to those options. Keep it short and persuasive.";

  const prompt = `${system}\n\nUser: ${user}\nAssistant:`;
  const r = await model.generateContent(prompt);
  const out = r.response.text().trim();
  return out || "สนใจเติมเกมหรือดู artifact/relic ไหมคะ ✨";
}

/* ===================== Intent detection ===================== */
const GI_CHARGING = [
  "เติม genshin impact",
  "เติมเกนชิน",
  "เติม genshin",
  "เติม gi",
  "top up genshin",
  "ซื้อ genesis",
];
const HSR_CHARGING = [
  "เติม honkai: star rail",
  "เติม hsr",
  "เติม star rail",
  "เติม honkai star rail",
  "top up hsr",
  "ซื้อ oneiric",
];
const ARTIFACT_GI = [
  "ดู artifact genshin impact",
  "ดู artifact genshin",
  "ดู artifact",
  "artifact ตัวไหน",
  "artifact ที่เหมาะกับ",
];
const RELIC_HSR = [
  "ดู relic honkai star rail",
  "ดู relic star rail",
  "ดู relic",
  "relic ที่เหมาะกับ",
];
function hasAny(text: string, arr: string[]) {
  const t = normalize(text);
  return arr.some((k) => t.includes(normalize(k)));
}

/* ===================== Route ===================== */
export async function POST(req: Request) {
  const { message, username, password } = (await req.json()) as {
    message?: string;
    username?: string;
    password?: string;
  };

  const text: string = (message || "").toString().trim();
  const lower = normalize(text);
  const key = ukey(username);
  const s = getSession(key);

  /* ---------- Login ---------- */
  if (username && password && !message) {
    try {
      const [users] = await db.query<RowDataPacket[]>(
        "SELECT * FROM users WHERE username = ? AND password = ?",
        [username, password]
      );
      if (Array.isArray(users) && users.length > 0) {
        return NextResponse.json(
          { success: true, message: "เข้าสู่ระบบสำเร็จ" },
          { status: 200 }
        );
      }
      return NextResponse.json(
        { success: false, message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" },
        { status: 401 }
      );
    } catch (_e: unknown) {
      return NextResponse.json(
        { success: false, message: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" },
        { status: 500 }
      );
    }
  }

  /* ---------- Confirm order ---------- */
  if (s.state === "confirm_order") {
    if (/^ยืนยัน$/i.test(text)) {
      const uid = s.uid || "-";
      const player =
        (s.playerName && s.playerName.trim()) || (s.game === "gi" ? "-" : "");
      const pkg = s.selectedName || "-";
      const price = s.selectedPrice ?? 0;

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
        quickReplies: [],
        paymentRequest: { showQR: true },
      });
    }
    if (/^ยกเลิก$/i.test(text)) {
      sessions[key] = { state: "idle" };
      return NextResponse.json({
        reply:
          "ยกเลิกคำสั่งซื้อแล้วค่ะ ถ้าต้องการเริ่มใหม่ เลือกเมนูด้านล่างได้เลย",
        quickReplies: [],
      });
    }
    return NextResponse.json({
      reply: "กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก",
      quickReplies: ["ยืนยัน", "ยกเลิก"],
    });
  }

  /* ---------- Waiting UID ---------- */
  if (s.state === "waiting_uid_gi" || s.state === "waiting_uid_hsr") {
    const uidOnly = toArabic(text).replace(/\D/g, "");
    if (!uidOnly) {
      return NextResponse.json({ reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ" });
    }
    s.uid = uidOnly;

    const game: GameKey = s.state === "waiting_uid_gi" ? "gi" : "hsr";
    const player = await fetchPlayerName(game, uidOnly).catch(() => "");
    s.playerName = player || "";

    const gameName = game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
    const pkg = s.selectedName || "-";
    const price = s.selectedPrice ?? 0;
    const amount = parseAmountToReceive(game, pkg);

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

  /* ---------- เลือกแพ็ก ---------- */
  const isNumberPick = /^[1-9]\d?$/.test(toArabic(text)); // 1–99
  if (s.state === "waiting_gi" || s.state === "waiting_hsr") {
    const game: GameKey = s.state === "waiting_gi" ? "gi" : "hsr";
    const list = await fetchProducts(game);

    let idx: number | null = null;
    if (isNumberPick) idx = parseInt(toArabic(text), 10) - 1;
    else idx = matchPackageByName(list, text);

    if (idx == null || idx < 0 || idx >= list.length) {
      return NextResponse.json({
        reply:
          "ไม่พบแพ็กเกจที่คุณเลือกค่ะ ลองพิมพ์หมายเลข 1-7 หรือพิมพ์ตัวเลข/ชื่อแพ็กให้ชัดเจนอีกครั้งน้า~",
      });
    }

    const p = list[idx];
    s.selectedIndex = idx;
    s.selectedName = p.name;
    s.selectedPrice = Number(p.price);
    s.game = game;
    s.state = game === "gi" ? "waiting_uid_gi" : "waiting_uid_hsr";

    return NextResponse.json({
      reply: "กรุณาพิมพ์ UID ของคุณ (ตัวเลขเท่านั้น)",
    });
  }

  /* ---------- เติมเกม (Intents) ---------- */
  if (hasAny(lower, GI_CHARGING)) {
    const list = await fetchProducts("gi");
    s.state = "waiting_gi";
    s.game = "gi";
    const reply =
      `สวัสดีค่ะ รูบี้ยินดีช่วยเติม Genshin Impact นะคะ\n\n` +
      `${renderProductList(list)}\n\n` +
      `กรุณาพิมพ์หมายเลข 1-7 ได้เลยค่ะ`;
    return NextResponse.json({ reply });
  }

  if (hasAny(lower, HSR_CHARGING)) {
    const list = await fetchProducts("hsr");
    s.state = "waiting_hsr";
    s.game = "hsr";
    const reply =
      `สวัสดีค่ะ รูบี้ยินดีช่วยเติม Honkai: Star Rail นะคะ\n\n` +
      `${renderProductList(list)}\n\n` +
      `กรุณาพิมพ์หมายเลข 1-7 ได้เลยค่ะ`;
    return NextResponse.json({ reply });
  }

  /* ---------- artifact / relic ---------- */
  if (hasAny(lower, ARTIFACT_GI)) {
    s.state = "waiting_artifact_char";
    s.game = "gi";
    return NextResponse.json({
      reply: "อยากดู artifact ของตัวละครไหนคะ? พิมพ์ชื่อมาได้เลย~",
    });
  }
  if (hasAny(lower, RELIC_HSR)) {
    s.state = "waiting_relic_char";
    s.game = "hsr";
    return NextResponse.json({
      reply: "อยากดู relic ของตัวละครไหนคะ? พิมพ์ชื่อมาได้เลย~",
    });
  }

  /* ---------- รับชื่อตัวละคร -> ดึง set_short -> แปลงตัวย่อเป็นชื่อเต็ม + ส่งโครงสร้าง lines ---------- */
  if (s.state === "waiting_artifact_char" || s.state === "waiting_relic_char") {
    const game: GameKey = s.state === "waiting_artifact_char" ? "gi" : "hsr";
    const raw = text.trim();
    const q = `%${raw}%`;

    let [rows] = await db.query<RowDataPacket[]>(
      `SELECT set_short FROM character_sets WHERE game = ? AND character_name = ?`,
      [game, raw]
    );
    if (!rows || rows.length === 0) {
      [rows] = await db.query<RowDataPacket[]>(
        `SELECT set_short FROM character_sets
         WHERE game = ? AND (character_name LIKE ? OR REPLACE(LOWER(character_name),' ','') = REPLACE(LOWER(?),' ','')) 
         LIMIT 4`,
        [game, q, raw]
      );
    }

    s.state = "idle";

    if (!rows || rows.length === 0) {
      return NextResponse.json({
        reply: `ไม่พบข้อมูลเซ็ตของ ${raw} ค่ะ`,
      });
    }

    const textLines: string[] = [];
    const visualLines: { short: string; full: string; pieces: number }[][] = [];

    for (const r of rows as RowDataPacket[]) {
      const shortStr = String(r.set_short || "");
      // สำหรับข้อความในบับเบิล
      const disp = await resolveSetDisplay(game, shortStr);
      textLines.push(`- ${disp}`);
      // สำหรับ frontend แสดงรูป + ชื่อเต็ม (ใช้ตัวย่อเป็นไฟล์)
      const lines = await expandSetLines(game, shortStr);
      visualLines.push(...lines);
    }

    const head = game === "gi" ? "Artifact" : "Relic";
    return NextResponse.json({
      reply: `${head} ที่เหมาะกับ ${raw} คือ:\n${textLines.join("\n")}`,
      sets: { game, lines: visualLines },
      quickReplies: ["คำนวณสเตตจากรูป", "ดูเซ็ตตัวอื่น"],
    });
  }

  /* ---------- Fallback ---------- */
  if (s.state === "idle") {
    const reply = await geminiAssist(text).catch(() => "");
    const safe =
      reply ||
      "สวัสดีค่ะ ถ้าสนใจเติมเกมพิมพ์ ‘เติม Genshin Impact’ หรือ ‘เติม Honkai: Star Rail’ ได้เลยนะคะ ✨";
    return NextResponse.json({ reply: safe });
  }

  return NextResponse.json({
    reply:
      "ขอโทษค่ะ คำตอบนี้ไม่เข้าเงื่อนไขของขั้นตอนปัจจุบัน ลองพิมพ์ให้ตรงตามที่ถาม หรือพิมพ์ ‘ยกเลิก’ เพื่อเริ่มใหม่ได้เลยนะคะ~",
  });
}
