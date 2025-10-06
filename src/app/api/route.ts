import { NextResponse } from "next/server";
import mysql, { RowDataPacket } from "mysql2/promise";

/* ===================== DB Pool ===================== */
const db = mysql.createPool({
  host: process.env.DB_HOST || "sql12.freesqldatabase.com",
  user: process.env.DB_USER || "sql12796984",
  password: process.env.DB_PASS || "n72gyyb4KT",
  database: process.env.DB_NAME || "sql12796984",
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

/** ใช้ username > sessionId > IP+UA เพื่อแยก session ต่อคนให้ชัด */
function clientKey(req: Request, username?: string, sessionId?: string) {
  if (username) return `u:${username}`;
  if (sessionId) return `sid:${sessionId}`;
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "0.0.0.0";
  const ua = (req.headers.get("user-agent") || "").slice(0, 80);
  return `ipua:${ip}:${ua}`;
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
  // ลอง exact number-in-name ก่อน
  for (let i = 0; i < rows.length; i++) {
    const num = String(rows[i].name).match(/\d{2,6}/)?.[0];
    if (num && s.includes(num)) return i;
  }
  // จากนั้นลองชื่อเต็ม/บางส่วน
  for (let i = 0; i < rows.length; i++) {
    const n = normalize(String(rows[i].name));
    if (s === n || s.startsWith(n) || s.includes(n)) return i;
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
  const divider = isPlus ? "+" : "/"; // GI ใช้ "/" แทน "หรือ"
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

/** ✅ สำหรับ frontend: คืนแถวของรายการ (ตัวย่อ + ชื่อเต็ม + จำนวนชิ้น) */
async function expandSetLines(game: GameKey, setShortRaw: string) {
  type SetItem = { short: string; full: string; pieces: number };
  const table = game === "gi" ? "items_gi" : "items_hsr";

  const hasPlus = setShortRaw.includes("+"); // 2+2
  const hasDash = setShortRaw.includes("-"); // HSR pair 4+2
  const sep = hasPlus ? "+" : hasDash ? "-" : "/";

  const tokens = setShortRaw.split(sep).map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) return [] as SetItem[][];

  const ph = tokens.map(() => "?").join(",");
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT short_id, name FROM ${table} WHERE short_id IN (${ph})`,
    tokens
  );
  const nameMap = new Map<string, string>();
  (rows as RowDataPacket[]).forEach((r) => {
    nameMap.set(String(r.short_id), String(r.name || r.short_id));
  });

  if (!hasPlus && !hasDash) {
    return tokens.map((t) => [
      { short: t, full: nameMap.get(t) || t, pieces: 4 },
    ]);
  }

  if (hasDash) {
    const [a, b] = tokens;
    if (!a || !b) return [];
    return [
      [
        { short: a, full: nameMap.get(a) || a, pieces: 4 },
        { short: b, full: nameMap.get(b) || b, pieces: 2 },
      ],
    ];
  }

  if (hasPlus) {
    return [[...tokens.map((t) => ({ short: t, full: nameMap.get(t) || t, pieces: 2 }))]];
  }

  return [];
}

/* ===================== Global Intents & helpers ===================== */
type Intent = "gi_topup" | "hsr_topup" | "artifact" | "relic" | "cancel" | "help";

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

const RE_CONFIRM = /^(ยืนยัน|ตกลง|ok|โอเค|confirm)$/i;
const RE_CANCEL = /^(ยกเลิก|cancel|ไม่เอา|ยกเลิกคำสั่ง)$/i;

function detectIntent(t: string): Intent | null {
  if (RE_CANCEL.test(t)) return "cancel";
  if (hasAny(t, GI_CHARGING)) return "gi_topup";
  if (hasAny(t, HSR_CHARGING)) return "hsr_topup";
  if (hasAny(t, ARTIFACT_GI)) return "artifact";
  if (hasAny(t, RELIC_HSR)) return "relic";
  if (/^(help|ช่วยด้วย|เมนู|เริ่มใหม่)$/i.test(t)) return "help";
  return null;
}

async function handleIntent(intent: Intent, s: Session) {
  if (intent === "cancel") {
    s.state = "idle";
    s.game = undefined;
    s.selectedIndex = undefined;
    s.selectedName = undefined;
    s.selectedPrice = undefined;
    s.uid = undefined;
    s.playerName = undefined;
    return {
      reply:
        "ยกเลิกขั้นตอนแล้ว เลือกต่อได้เลย:",
      quickReplies: [
        "เติม Genshin Impact",
        "เติม Honkai: Star Rail",
        "ดู Artifact Genshin Impact",
        "ดู Relic Honkai Star Rail",
      ],
    };
  }

  if (intent === "gi_topup") {
    const list = await fetchProducts("gi");
    s.state = "waiting_gi";
    s.game = "gi";
    return {
      reply:
        `สวัสดีค่ะ เติม Genshin Impact ได้เลย\n\n` +
        `${renderProductList(list)}\n\n` +
        `พิมพ์หมายเลข 1-${list.length} หรือพิมพ์ชื่อแพ็กก็ได้`,
    };
  }

  if (intent === "hsr_topup") {
    const list = await fetchProducts("hsr");
    s.state = "waiting_hsr";
    s.game = "hsr";
    return {
      reply:
        `สวัสดีค่ะ เติม Honkai: Star Rail ได้เลย\n\n` +
        `${renderProductList(list)}\n\n` +
        `พิมพ์หมายเลข 1-${list.length} หรือพิมพ์ชื่อแพ็กก็ได้`,
    };
  }

  if (intent === "artifact") {
    s.state = "waiting_artifact_char";
    s.game = "gi";
    return { reply: "อยากดู Artifact ของตัวไหนคะ? พิมพ์ชื่อมาได้เลย~" };
  }

  if (intent === "relic") {
    s.state = "waiting_relic_char";
    s.game = "hsr";
    return { reply: "อยากดู Relic ของตัวไหนคะ? พิมพ์ชื่อมาได้เลย~" };
  }

  return {
    reply:
      "เมนูหลัก:\n• เติม Genshin Impact\n• เติม Honkai: Star Rail\n• ดู Artifact Genshin Impact\n• ดู Relic Honkai: Star Rail",
    quickReplies: [
      "เติม Genshin Impact",
      "เติม Honkai: Star Rail",
      "ดู Artifact Genshin Impact",
      "ดู Relic Honkai Star Rail",
    ],
  };
}

/* ===================== Fallback (deterministic) ===================== */
function safeFallback() {
  return (
    "พิมพ์คำสั่งได้เลยนะคะ ✨\n" +
    "• เติม Genshin Impact / เติม Honkai: Star Rail\n" +
    "• ดู Artifact Genshin Impact / ดู Relic Honkai: Star Rail\n" +
    "• หรือพิมพ์ ยกเลิก เพื่อเริ่มใหม่"
  );
}

/* ===================== Route ===================== */
export async function POST(req: Request) {
  const { message, username, password, sessionId } = (await req.json()) as {
    message?: string;
    username?: string;
    password?: string;
    sessionId?: string;
  };

  const text: string = (message || "").toString().trim();
  const lower = normalize(text);
  const key = clientKey(req, username, sessionId);
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

  /* ---------- Global interrupt: สลับโหมดได้ทุกที่ ---------- */
  const intent = detectIntent(lower);
  if (intent) {
    const out = await handleIntent(intent, s);
    return NextResponse.json(out);
  }

  /* ---------- Confirm order ---------- */
  if (s.state === "confirm_order") {
    if (RE_CONFIRM.test(text)) {
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
    if (RE_CANCEL.test(text)) {
      sessions[key] = { state: "idle" };
      return NextResponse.json({
        reply:
          "ยกเลิกคำสั่งซื้อแล้วค่ะ ถ้าต้องการเริ่มใหม่ เลือกเมนูด้านล่างได้เลย",
        quickReplies: [
          "เติม Genshin Impact",
          "เติม Honkai: Star Rail",
          "ดู Artifact Genshin Impact",
          "ดู Relic Honkai Star Rail",
        ],
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
      return NextResponse.json({
        reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ",
      });
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
    if (isNumberPick)
      idx = Math.min(
        list.length - 1,
        Math.max(0, parseInt(toArabic(text), 10) - 1)
      );
    else idx = matchPackageByName(list, text);

    if (idx == null || idx < 0 || idx >= list.length) {
      return NextResponse.json({
        reply: `ไม่พบแพ็กเกจที่เลือกค่ะ ลองพิมพ์หมายเลข 1-${list.length} หรือพิมพ์ตัวเลข/ชื่อแพ็กให้ชัดเจนอีกครั้งน้า~`,
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

  /* ---------- artifact / relic ---------- */
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
      const disp = await resolveSetDisplay(game, shortStr);
      textLines.push(`- ${disp}`);
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
    return NextResponse.json({
      reply: safeFallback(),
      quickReplies: [
        "เติม Genshin Impact",
        "เติม Honkai: Star Rail",
        "ดู Artifact Genshin Impact",
        "ดู Relic Honkai Star Rail",
      ],
    });
  }

  return NextResponse.json({
    reply:
      "ขอโทษค่ะ คำตอบนี้ไม่เข้าเงื่อนไขของขั้นตอนปัจจุบัน ลองพิมพ์ให้ตรงตามที่ถาม หรือพิมพ์ ‘ยกเลิก’ เพื่อเริ่มใหม่ได้เลยนะคะ~",
  });
}
