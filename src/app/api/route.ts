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
  /** snapshot ลิสต์แพ็กที่แสดงให้ผู้ใช้รอบล่าสุด ป้องกันลิสต์สลับระหว่างเลือก */
  productList?: Array<{ name: string; price: number }>;
};

/* ===================== Sessions ===================== */
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
  // match ตัวเลขในชื่อก่อน (เช่น "6480 Genesis")
  for (let i = 0; i < rows.length; i++) {
    const num = String(rows[i].name).match(/\d{2,6}/)?.[0];
    if (num && s.includes(num)) return i;
  }
  // จากนั้นค่อย match ชื่อเต็ม/บางส่วน
  for (let i = 0; i < rows.length; i++) {
    const n = normalize(String(rows[i].name));
    if (s === n || s.startsWith(n) || s.includes(n)) return i;
  }
  return null;
}

function pickIndexFromMessage(msg: string, max: number): number | null {
  const m = toArabic(msg).match(/\d{1,3}/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (Number.isNaN(n)) return null;
  if (n < 1 || n > max) return null;
  return n - 1; // 1-based -> 0-based
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
    .join("\\n\\n");
}
function parseAmountToReceive(game: GameKey, productName: string): string {
  const m = productName.match(/^(\\d[\\d,]*)\\s+(Genesis|Oneiric)/i);
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
          (j as any)?.playerInfo?.nickname ||
          (j as any)?.player?.nickname ||
          (j as any)?.owner?.nickname;
        if (name) return String(name);
      }
      const r2 = await fetch(`https://enka.network/u/${uid}/`, {
        headers: ua,
        cache: "no-store",
      });
      if (r2.ok) {
        const html = await r2.text();
        const m = html.match(/ของ\\s+(.+?)\\s+\\|/);
        if (m) return m[1].trim();
      }
    } else {
      const r1 = await fetch(`https://enka.network/api/hsr/uid/${uid}`, {
        headers: ua,
        cache: "no-store",
      });
      if (r1.ok) {
        const j = await r1.json().catch(() => null);
        const name = (j as any)?.playerInfo?.nickname || (j as any)?.owner?.nickname;
        if (name) return String(name);
      }
      const r2 = await fetch(`https://enka.network/hsr/${uid}/`, {
        headers: ua,
        cache: "no-store",
      });
      if (r2.ok) {
        const html = await r2.text();
        let m = html.match(/of\\s+(.+?)\\s+\\|/i);
        if (m) return m[1].trim();
        m = html.match(/ของ\\s+(.+?)\\s+\\|/);
        if (m) return m[1].trim();
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** แปลงตัวย่อ Relic/Planar เป็นชื่อเต็ม (รองรับ Cavern, Planar, และคู่ 4+2) */
async function resolveSetDisplay(game: GameKey, setShortRaw: string) {
  const table = game === "gi" ? "items_gi" : "items_hsr";

  async function getNames(ids: string[]) {
    const cleaned = ids.map((x) => x.trim()).filter(Boolean);
    if (cleaned.length === 0) return new Map<string, string>();

    const placeholders = cleaned.map(() => "?").join(",");
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT short_id, name FROM ${table} WHERE short_id IN (${placeholders})`,
      cleaned
    );

    const map = new Map<string, string>();
    (rows as RowDataPacket[]).forEach((r) => {
      map.set(String((r as any).short_id), String((r as any).name || (r as any).short_id));
    });
    cleaned.forEach((id) => {
      if (!map.has(id)) map.set(id, id);
    });
    return map;
  }

  const raw = setShortRaw.trim();

  // [1] HSR Relic-Planar (4+2): "Relic-Planar" โดย Planar อาจมีหลายตัวเลือกคั่นด้วย "/"
  if (raw.includes("-")) {
    const [relicRaw, planarRaw] = raw.split("-").map((s) => s.trim());
    const relicIds = relicRaw.split("/").map((s) => s.trim());
    const planarIds = planarRaw.split("/").map((s) => s.trim());

    const map = await getNames([...relicIds, ...planarIds]);
    const relicNames = relicIds.map((id) => map.get(id)!).join(" หรือ ");
    const planarNames = planarIds.map((id) => map.get(id)!).join(" หรือ ");

    return `${relicNames} 4 ชิ้น + ${planarNames} 2 ชิ้น`;
  }

  // [2] 2+2 : "A+B"
  if (raw.includes("+")) {
    const ids = raw.split("+").map((s) => s.trim());
    const map = await getNames(ids);
    const parts = ids.map((id) => `${map.get(id)} 2 ชิ้น`);
    return parts.join(" + ");
  }

  // [3] ตัวเลือกหลายชุดด้วย "/" (Planar หรือ GI แบบ “หรือ”)
  if (raw.includes("/")) {
    const ids = raw.split("/").map((s) => s.trim());
    const map = await getNames(ids);
    const names = ids.map((id) => map.get(id)).join(" หรือ ");
    return `${names} 2 ชิ้น`;
  }

  // [4] เดี่ยว ๆ 4 ชิ้น
  const map = await getNames([raw]);
  return `${map.get(raw)} 4 ชิ้น`;
}

/** สำหรับ frontend: คืนแถวของรายการ (ตัวย่อ + ชื่อเต็ม + จำนวนชิ้น) */
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
    nameMap.set(String((r as any).short_id), String((r as any).name || (r as any).short_id));
  });

  if (!hasPlus && !hasDash) {
    // GI: "A/B/C" -> หลายบรรทัด บรรทัดละ 4 ชิ้น
    return tokens.map((t) => [
      { short: t, full: nameMap.get(t) || t, pieces: 4 },
    ]);
  }

  if (hasDash) {
    // HSR: "Relic-Planar" -> 1 บรรทัด (4 + 2)
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
    // 2+2: "A+B" -> 1 บรรทัด (2+2)
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
/** อนุญาตให้ “ยุติ/เปลี่ยนใจ/เริ่มใหม่” ได้จากทุกที่ */
const RE_RESET = /^(ยกเลิก|ยกเลิกคำสั่ง|เปลี่ยนใจ|เริ่มใหม่|reset|cancel|stop)$/i;

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
    s.productList = undefined;
    return {
      reply: "ยกเลิกขั้นตอนแล้ว เลือกต่อได้เลย:",
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
    s.productList = list;
    return {
      reply:
        `สวัสดีค่ะ เติม Genshin Impact ได้เลย\\n\\n` +
        `${renderProductList(list)}\\n\\n` +
        `พิมพ์หมายเลข 1-${list.length} หรือพิมพ์ชื่อแพ็กก็ได้`,
    };
  }

  if (intent === "hsr_topup") {
    const list = await fetchProducts("hsr");
    s.state = "waiting_hsr";
    s.game = "hsr";
    s.productList = list;
    return {
      reply:
        `สวัสดีค่ะ เติม Honkai: Star Rail ได้เลย\\n\\n` +
        `${renderProductList(list)}\\n\\n` +
        `พิมพ์หมายเลข 1-${list.length} หรือพิมพ์ชื่อแพ็กก็ได้`,
    };
  }

  if (intent === "artifact") {
    s.state = "waiting_artifact_char";
    s.game = "gi";
    s.productList = undefined;
    return { reply: "อยากดู Artifact ของตัวไหนคะ? พิมพ์ชื่อมาได้เลย~" };
  }

  if (intent === "relic") {
    s.state = "waiting_relic_char";
    s.game = "hsr";
    s.productList = undefined;
    return { reply: "อยากดู Relic ของตัวไหนคะ? พิมพ์ชื่อมาได้เลย~" };
  }

  return {
    reply:
      "เมนูหลัก:\\n• เติม Genshin Impact\\n• เติม Honkai: Star Rail\\n• ดู Artifact Genshin Impact\\n• ดู Relic Honkai: Star Rail",
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
    "พิมพ์คำสั่งได้เลยนะคะ ✨\\n" +
    "• เติม Genshin Impact / เติม Honkai: Star Rail\\n" +
    "• ดู Artifact Genshin Impact / ดู Relic Honkai: Star Rail\\n" +
    "• หรือพิมพ์ ยกเลิก/เปลี่ยนใจ เพื่อเริ่มใหม่"
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

  /* ---------- Global reset: อนุญาตจากทุก state ---------- */
  if (text && RE_RESET.test(text)) {
    sessions[key] = { state: "idle" };
    return NextResponse.json({
      reply: "รีเซ็ตขั้นตอนเรียบร้อย เริ่มใหม่ได้เลยค่ะ:",
      quickReplies: [
        "เติม Genshin Impact",
        "เติม Honkai: Star Rail",
        "ดู Artifact Genshin Impact",
        "ดู Relic Honkai Star Rail",
      ],
    });
  }

  /* ---------- Intent: อนุญาตเฉพาะตอน idle เท่านั้น ---------- */
  if (s.state === "idle") {
    const intent = detectIntent(lower);
    if (intent) {
      const out = await handleIntent(intent, s);
      return NextResponse.json(out);
    }
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
        `รับคำยืนยันแล้วค่ะ ✅\\n` +
        `ยอดชำระ: ${price.toFixed(2)} บาท\\n` +
        `แพ็กเกจ: ${pkg}\\n` +
        `UID: ${uid}\\n` +
        `ชื่อผู้เล่น: ${player || "-"}\\n\\n` +
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
    const uidOnly = toArabic(text).replace(/\\D/g, "");
    if (!uidOnly) {
      return NextResponse.json({
        reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ (หรือพิมพ์ ‘ยกเลิก’ เพื่อเริ่มใหม่)",
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
      `สรุปรายการสั่งซื้อ (รอยืนยัน)\\n` +
      `เกม: ${gameName}\\n` +
      `UID: ${uidOnly}\\n` +
      `ชื่อผู้เล่น: ${s.playerName || "-"}\\n` +
      `แพ็กเกจ: ${pkg}\\n` +
      `จำนวนที่จะได้รับ: ${amount}\\n` +
      `ราคา: ${price.toFixed(2)} บาท\\n\\n` +
      `กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก`;

    return NextResponse.json({
      reply,
      quickReplies: ["ยืนยัน", "ยกเลิก"],
    });
  }

  /* ---------- เลือกแพ็ก ---------- */
  if (s.state === "waiting_gi" || s.state === "waiting_hsr") {
    const game: GameKey = s.state === "waiting_gi" ? "gi" : "hsr";
    const list =
      s.productList && s.productList.length > 0
        ? s.productList
        : await fetchProducts(game);

    // 1) พยายามจับเลขจากข้อความ (รองรับ “เลือก 6”, “เบอร์ 4”, ฯลฯ)
    let idx: number | null = pickIndexFromMessage(text, list.length);

    // 2) ถ้าไม่ใช่เลข ให้ลองเทียบชื่อแพ็ก (รวมตัวเลขในชื่อ)
    if (idx == null) idx = matchPackageByName(list, text);

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
    s.productList = undefined; // lock-in แล้วเคลียร์ เพื่อกันลิสต์สลับ

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
      const shortStr = String((r as any).set_short || "");
      const disp = await resolveSetDisplay(game, shortStr);
      textLines.push(`- ${disp}`);
      const lines = await expandSetLines(game, shortStr);
      visualLines.push(...lines);
    }

    const head = game === "gi" ? "Artifact" : "Relic";
    return NextResponse.json({
      reply: `${head} ที่เหมาะกับ ${raw} คือ:\\n${textLines.join("\\n")}`,
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
      "ขอโทษค่ะ ตอนนี้กำลังอยู่ในขั้นตอนก่อนหน้าอยู่ค่ะ กรุณาตอบให้ตรงขั้นตอน หรือพิมพ์ ‘ยกเลิก/เปลี่ยนใจ’ เพื่อเริ่มใหม่ได้เลยนะคะ~",
  });
}