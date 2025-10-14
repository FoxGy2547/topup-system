// src/app/api/route.ts
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
  | "waiting_enka_uid"
  | "waiting_pick_character";

type Session = {
  state: StateKey;
  game?: GameKey;

  // topup
  selectedIndex?: number;
  selectedName?: string;
  selectedPrice?: number;
  uid?: string;
  productList?: Array<{ name: string; price: number }>;

  // enka
  enka?: {
    uid?: string;
    game?: GameKey;
    player?: string;
    characters?: { id: number; name: string; level: number }[];
    details?: Record<string, unknown>;
  };
};

/* ===================== Sessions ===================== */
const sessions: Record<string, Session> = Object.create(null);
function getSession(key: string) {
  if (!sessions[key]) sessions[key] = { state: "idle" };
  return sessions[key];
}
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
function extractMoney(text: string): number | null {
  const s = toArabic(text).replace(/[, ]/g, "");
  const m = s.match(/(?:฿|thb)?\s*(\d+(?:\.\d{1,2})?)(?:บาท|฿|thb)?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}
function pickIndexFromMessage(msg: string, max: number): number | null {
  const m = toArabic(msg).match(/\d{1,3}/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (Number.isNaN(n)) return null;
  if (n < 1 || n > max) return null;
  return n - 1;
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

/* ===================== Intents ===================== */
type Intent =
  | "gi_topup"
  | "hsr_topup"
  | "artifact_uid" // ดู artifact ด้วย UID (GI)
  | "relic_uid"    // ดู relic ด้วย UID (HSR)
  | "cancel"
  | "help";

const GI_CHARGING = [
  "เติม genshin impact", "เติมเกนชิน", "เติม genshin", "เติม gi",
  "top up genshin", "ซื้อ genesis", "เพชร genshin", "เจม genshin", "คริสตัล genshin",
];
const HSR_CHARGING = [
  "เติม honkai: star rail", "เติม hsr", "เติม star rail", "เติม honkai star rail",
  "top up hsr", "ซื้อ oneiric", "เพชร hsr", "คริสตัล hsr", "oneiric shard",
];

// บังคับ artifact/relic → โหมด UID เสมอ
const RE_ARTIFACT_ANY = /(artifact|อาร์ติ|อาร์ติแฟกต์)/i;
const RE_RELIC_ANY     = /(relic|เรลิก)/i;

function hasAny(text: string, arr: string[]) {
  const t = normalize(text);
  return arr.some((k) => t.includes(normalize(k)));
}

/* confirm/cancel/reset */
const RE_CONFIRM = /^(ยืนยัน|ตกลง|ok|โอเค|confirm)$/i;
const RE_CANCEL  = /^(ยกเลิก|ไม่เอา(?:ละ|แล้ว)?|พอ|ไว้ก่อน|cancel|stop)$/i;
const RE_RESET   = /^(ยกเลิก|ยกเลิกคำสั่ง|เปลี่ยนใจ|เริ่มใหม่|reset|cancel|stop|ไม่เอา(?:ละ|แล้ว)?|พอ|ไว้ก่อน)$/i;

function detectIntent(text: string): Intent | null {
  const t = text.trim();
  if (RE_CANCEL.test(t)) return "cancel";
  if (RE_ARTIFACT_ANY.test(t)) return "artifact_uid";
  if (RE_RELIC_ANY.test(t))     return "relic_uid";
  if (hasAny(t, GI_CHARGING))  return "gi_topup";
  if (hasAny(t, HSR_CHARGING)) return "hsr_topup";
  if (/^(help|ช่วยด้วย|เมนู|เริ่มใหม่)$/i.test(t)) return "help";
  return null;
}

/* ---------- Reply helpers ---------- */
function mainMenu() {
  return {
    reply:
`เมนูหลัก:
• เติม Genshin Impact
• เติม Honkai: Star Rail
• ดู Artifact Genshin (ใช้ UID)
• ดู Relic Star Rail (ใช้ UID)`,
    quickReplies: [
      "เติม Genshin Impact",
      "เติม Honkai: Star Rail",
      "ดู Artifact Genshin (จาก UID)",
      "ดู Relic Star Rail (จาก UID)",
    ],
  };
}

function onlyCancel() {
  return { quickReplies: ["ยกเลิก"] };
}

function sessionsReset(s: Session) {
  s.state = "idle";
  s.game = undefined;
  s.selectedIndex = undefined;
  s.selectedName = undefined;
  s.selectedPrice = undefined;
  s.uid = undefined;
  s.productList = undefined;
  s.enka = undefined;
}

/* ===================== Route ===================== */
export async function POST(req: Request) {
  const { message, username, sessionId } = (await req.json().catch(() => ({}))) as {
    message?: string;
    username?: string;
    sessionId?: string;
  };

  const text: string = (message || "").toString();
  const key = clientKey(req, username, sessionId);
  const s = getSession(key);

  /* ---------- Global reset ---------- */
  if (text && RE_RESET.test(text)) {
    sessions[key] = { state: "idle" };
    const menu = mainMenu();
    return NextResponse.json({
      reply: "รีเซ็ตขั้นตอนเรียบร้อย เริ่มใหม่ได้เลยค่ะ:",
      quickReplies: menu.quickReplies,
    });
  }

  /* ---------- Idle → detect intent ---------- */
  if (s.state === "idle") {
    const intent = detectIntent(text);
    if (intent === "cancel") {
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }
    if (intent === "gi_topup" || intent === "hsr_topup") {
      const game: GameKey = intent === "gi_topup" ? "gi" : "hsr";
      const list = await fetchProducts(game);
      s.state = game === "gi" ? "waiting_gi" : "waiting_hsr";
      s.game = game;
      s.productList = list;
      const head = game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
      return NextResponse.json({
        reply:
`สวัสดีค่ะ เติม ${head} ได้เลย

${renderProductList(list)}

พิมพ์หมายเลข 1-${list.length} หรือพิมพ์ราคา (เช่น 179)`,
        ...onlyCancel(),
      });
    }
    if (intent === "artifact_uid" || intent === "relic_uid") {
      s.state = "waiting_enka_uid";
      s.enka = { game: intent === "artifact_uid" ? "gi" : "hsr" };
      return NextResponse.json({
        reply: `กรุณาพิมพ์ UID ${s.enka.game === "gi" ? "Genshin" : "Star Rail"} ของคุณ (ตัวเลขเท่านั้น)`,
        ...onlyCancel(),
      });
    }
    // help / unknown
    return NextResponse.json(mainMenu());
  }

  /* ---------- เลือกแพ็ก ---------- */
  if (s.state === "waiting_gi" || s.state === "waiting_hsr") {
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }
    const game: GameKey = s.state === "waiting_gi" ? "gi" : "hsr";
    const list =
      s.productList && s.productList.length > 0
        ? s.productList
        : await fetchProducts(game);

    let idx: number | null = pickIndexFromMessage(text, list.length);
    if (idx == null) {
      const money = extractMoney(text);
      if (money != null) {
        let bestIdx: number | null = null;
        let bestDiff = Number.POSITIVE_INFINITY;
        for (let i = 0; i < list.length; i++) {
          const p = Number(list[i].price);
          const diff = Math.abs(p - money);
          const tol = money >= 1000 ? 10 : money >= 200 ? 5 : 2;
          if (diff <= tol && diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
          }
        }
        idx = bestIdx;
      }
    }

    if (idx == null || idx < 0 || idx >= list.length) {
      return NextResponse.json({
        reply: `ไม่พบแพ็กเกจที่เลือกค่ะ ลองพิมพ์หมายเลข 1-${list.length} หรือพิมพ์ราคา (เช่น 179)`,
        ...onlyCancel(),
      });
    }

    const p = list[idx];
    s.selectedIndex = idx;
    s.selectedName = p.name;
    s.selectedPrice = Number(p.price);
    s.game = game;
    s.state = game === "gi" ? "waiting_uid_gi" : "waiting_uid_hsr";
    s.productList = undefined;

    return NextResponse.json({
      reply: "กรุณาพิมพ์ UID ของคุณ (ตัวเลขเท่านั้น)",
      ...onlyCancel(),
    });
  }

  /* ---------- Waiting UID (Topup) ---------- */
  if (s.state === "waiting_uid_gi" || s.state === "waiting_uid_hsr") {
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }
    const uidOnly = toArabic(text).replace(/\D/g, "");
    if (!uidOnly) {
      return NextResponse.json({
        reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ",
        ...onlyCancel(),
      });
    }
    s.uid = uidOnly;

    const game: GameKey = s.state === "waiting_uid_gi" ? "gi" : "hsr";
    const gameName = game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
    const pkg = s.selectedName || "-";
    const price = s.selectedPrice ?? 0;
    const amount = parseAmountToReceive(game, pkg);

    s.state = "confirm_order";

    const reply =
`สรุปรายการสั่งซื้อ (รอยืนยัน)
เกม: ${gameName}
UID: ${uidOnly}
แพ็กเกจ: ${pkg}
จำนวนที่จะได้รับ: ${amount}
ราคา: ${price.toFixed(2)} บาท

กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก`;
    return NextResponse.json({
      reply,
      quickReplies: ["ยืนยัน", "ยกเลิก"],
    });
  }

  /* ---------- Confirm order ---------- */
  if (s.state === "confirm_order") {
    if (RE_CONFIRM.test(text)) {
      const uid = s.uid || "-";
      const pkg = s.selectedName || "-";
      const price = s.selectedPrice ?? 0;

      sessionsReset(s);

      const reply =
`รับคำยืนยันแล้วค่ะ ✅
ยอดชำระ: ${price.toFixed(2)} บาท
แพ็กเกจ: ${pkg}
UID: ${uid}

กรุณาสแกน QR เพื่อชำระเงินได้เลยค่ะ`;
      return NextResponse.json({
        reply,
        quickReplies: [],
        paymentRequest: { showQR: true },
      });
    }
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }
    return NextResponse.json({
      reply: "กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก",
      quickReplies: ["ยืนยัน", "ยกเลิก"],
    });
  }

  /* ---------- Artifact/Relic (ผ่าน UID Enka เท่านั้น) ---------- */
  if (s.state === "waiting_enka_uid") {
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }
    const uid = toArabic(text).replace(/\D/g, "");
    if (!uid) return NextResponse.json({ reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ", ...onlyCancel() });

    s.enka = s.enka || {};
    s.enka.uid = uid;

    const game = s.enka.game || "gi";
    try {
      const base = new URL(req.url).origin;
      const enkaUrl = `${base}/api/enka`;

      const r = await fetch(enkaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, uid }),
      });
      const j = await r.json();

      if (!j?.ok) {
        s.state = "idle";
        const menu = mainMenu();
        return NextResponse.json({
          reply: "ดึงข้อมูลจาก enka ไม่สำเร็จ ลองใหม่หรือเช็คว่าโปรไฟล์เปิดสาธารณะนะคะ",
          quickReplies: menu.quickReplies,
        });
      }
      s.state = "waiting_pick_character";
      s.enka.player = j.player as string;
      s.enka.characters = j.characters as { id: number; name: string; level: number }[];
      s.enka.details = j.details as Record<string, unknown>;

      const chips = (j.characters as { id: number; name: string; level: number }[])
        .slice(0, 10)
        .map((c) => `${c.name} (lv.${c.level})`);

      return NextResponse.json({
        reply: `พบตัวละครของ ${j.player} (UID: ${uid})\nเลือกตัวที่อยากดูของได้เลย:`,
        quickReplies: [...chips, "ยกเลิก"],
      });
    } catch {
      s.state = "idle";
      const menu = mainMenu();
      return NextResponse.json({ reply: "ดึงข้อมูลจาก enka ไม่สำเร็จค่ะ", quickReplies: menu.quickReplies });
    }
  }

  if (s.state === "waiting_pick_character") {
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }

    const target = (s.enka?.characters || []).find((c) =>
      new RegExp(`\\b${(c.name || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text)
    );
    if (!target) {
      const chips = (s.enka?.characters || [])
        .slice(0, 10)
        .map((c) => `${c.name} (lv.${c.level})`);
      return NextResponse.json({
        reply: "ไม่พบชื่อตัวละครนี้ในลิสต์ค่ะ ลองพิมพ์ให้ตรงหรือเลือกจากปุ่มด่วนด้านล่าง",
        quickReplies: [...chips, "ยกเลิก"],
      });
    }

    const d = (s.enka?.details as Record<string, unknown>) || {};
    const detail = d[String(target.id)] as {
      artifacts?: Array<{
        piece: string; name: string; set?: string; main: string; subs: string[]; level?: number;
      }>;
      totals?: Record<string, number>;
    };

    // แนะนำเซ็ตจาก DB
    let setRows: RowDataPacket[] = [];
    try {
      const raw = target.name;
      const q = `%${raw}%`;
      let [rows] = await db.query<RowDataPacket[]>(
        `SELECT set_short FROM character_sets WHERE game = ? AND character_name = ?`,
        [s.enka?.game || "gi", raw]
      );
      if (!rows || rows.length === 0) {
        [rows] = await db.query<RowDataPacket[]>(
          `SELECT set_short FROM character_sets
           WHERE game = ?
             AND (character_name LIKE ? OR REPLACE(LOWER(character_name),' ','') = REPLACE(LOWER(?),' ','')) 
           LIMIT 4`,
          [s.enka?.game || "gi", q, raw]
        );
      }
      setRows = rows || [];
    } catch {
      setRows = [];
    }

    s.state = "idle";

    const recSets = setRows.map((r) => `• ${String((r as any).set_short || "")}`).join("\n") || "• (ไม่พบข้อมูลในฐานข้อมูล)";
    const gearLines = (detail?.artifacts || []).map((a) => {
      const subs = a.subs && a.subs.length ? ` | subs=${a.subs.join(", ")}` : "";
      return `• ${a.piece}: ${a.name}${a.set ? ` (${a.set})` : ""} | main=${a.main}${subs}`;
    }).join("\n") || "(ไม่พบชิ้นส่วน)";

    const head = `ของที่สวมใส่ของ ${target.name} (เลเวล ${target.level})`;
    const recHead = `Artifact/Relic ที่ฐานข้อมูลแนะนำ:`;
    const ask = `ต้องการ “วิเคราะห์สเตตด้วย Gemini” ไหมคะ?`;

    return NextResponse.json({
      reply: `${head}\n${gearLines}\n\n${recHead}\n${recSets}\n\n${ask}`,
      quickReplies: ["วิเคราะห์สเตตด้วย Gemini", "ยกเลิก"],
    });
  }

  /* ---------- Fallback ---------- */
  if (s.state === "idle") {
    return NextResponse.json(mainMenu());
  }
  return NextResponse.json({
    reply:
      "ขอโทษค่ะ ตอนนี้กำลังอยู่ในขั้นตอนก่อนหน้าอยู่ค่ะ กรุณาตอบให้ตรงขั้นตอน หรือพิมพ์ ‘ยกเลิก/เปลี่ยนใจ’ เพื่อเริ่มใหม่ได้เลยนะคะ~",
    ...onlyCancel(),
  });
}
