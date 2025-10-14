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
  | "waiting_artifact_char"
  | "waiting_relic_char"
  | "waiting_enka_uid"
  | "waiting_pick_character";

type Session = {
  state: StateKey;
  game?: GameKey;
  selectedIndex?: number;
  selectedName?: string;
  selectedPrice?: number;
  uid?: string;
  playerName?: string;
  productList?: Array<{ name: string; price: number }>;
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
function extractNums(text: string): string[] {
  return (toArabic(text).match(/\d{2,6}/g) || []).map((x) => x.replace(/^0+/, ""));
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

/* ===================== Global intents ===================== */
type Intent = "gi_topup" | "hsr_topup" | "artifact" | "relic" | "cancel" | "help" | "artifact_enka" | "relic_enka";

const GI_CHARGING = [
  "เติม genshin impact", "เติมเกนชิน", "เติม genshin", "เติม gi", "top up genshin", "ซื้อ genesis",
  "เพชร genshin", "เจม genshin", "คริสตัล genshin",
];
const HSR_CHARGING = [
  "เติม honkai: star rail", "เติม hsr", "เติม star rail", "เติม honkai star rail", "top up hsr", "ซื้อ oneiric",
  "เพชร hsr", "คริสตัล hsr", "oneiric shard",
];
const ARTIFACT_GI = ["ดู artifact genshin", "artifact ตัวไหน", "artifact ที่เหมาะกับ", "artifact genshin impact"];
const RELIC_HSR = ["ดู relic", "relic ที่เหมาะกับ", "relic honkai", "relic star rail"];
const ARTIFACT_FROM_UID = ["ดู artifact จาก uid", "artifact จาก uid", "ดู artifact genshin (จาก uid)"];
const RELIC_FROM_UID = ["ดู relic จาก uid", "relic จาก uid", "ดู relic star rail (จาก uid)"];

function hasAny(text: string, arr: string[]) {
  const t = normalize(text);
  return arr.some((k) => t.includes(normalize(k)));
}

/* ยืนยัน/ยกเลิก ครอบจักรวาล */
const RE_CONFIRM = /^(ยืนยัน|ตกลง|ok|โอเค|confirm)$/i;
const RE_CANCEL = /^(ยกเลิก|ไม่เอา(?:ละ|แล้ว)?|พอ|ไว้ก่อน|cancel|stop)$/i;
const RE_RESET  = /^(ยกเลิก|ยกเลิกคำสั่ง|เปลี่ยนใจ|เริ่มใหม่|reset|cancel|stop|ไม่เอา(?:ละ|แล้ว)?|พอ|ไว้ก่อน)$/i;

function detectIntent(t: string): Intent | null {
  if (RE_CANCEL.test(t)) return "cancel";
  if (hasAny(t, GI_CHARGING)) return "gi_topup";
  if (hasAny(t, HSR_CHARGING)) return "hsr_topup";
  if (hasAny(t, ARTIFACT_FROM_UID)) return "artifact_enka";
  if (hasAny(t, RELIC_FROM_UID)) return "relic_enka";
  if (hasAny(t, ARTIFACT_GI)) return "artifact";
  if (hasAny(t, RELIC_HSR)) return "relic";
  if (/^(help|ช่วยด้วย|เมนู|เริ่มใหม่)$/i.test(t)) return "help";
  return null;
}

/* ---------- Matching แพ็กฉลาด ---------- */
function matchPackageByName(rows: Array<{ name: string; price: number }>, userText: string): number | null {
  const s = normalize(userText);
  if (/รายเดือน|พร|welkin|blessing|express\s*supply\s*pass|express\s*pass|monthly/.test(s)) {
    for (let i = 0; i < rows.length; i++) {
      const n = normalize(String(rows[i].name));
      if (/พรแห่งดวงจันทร์|welkin|express supply pass|express pass|monthly|รายเดือน/.test(n)) return i;
    }
  }
  const wantNums = extractNums(s);
  if (wantNums.length) {
    for (let i = 0; i < rows.length; i++) {
      const numsInName = extractNums(String(rows[i].name));
      if (numsInName.some((n) => wantNums.includes(n))) return i;
    }
    if (wantNums.includes("6480")) {
      const idx8080 = rows.findIndex((r) => /8080|6480\s*\+\s*1600/i.test(r.name));
      if (idx8080 >= 0) return idx8080;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const n = normalize(String(rows[i].name));
    if (s === n || s.startsWith(n) || s.includes(n)) return i;
  }
  return null;
}
function matchPackageSmart(rows: Array<{ name: string; price: number }>, text: string): number | null {
  const money = extractMoney(text);
  if (money != null) {
    let bestIdx: number | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rows.length; i++) {
      const p = Number(rows[i].price);
      const diff = Math.abs(p - money);
      const tol = money >= 1000 ? 10 : money >= 200 ? 5 : 2;
      if (diff <= tol && diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    if (bestIdx != null) return bestIdx;
  }
  const byName = matchPackageByName(rows, text);
  if (byName != null) return byName;
  return null;
}

/* ---------- Reply helpers ---------- */
function mainMenu() {
  return {
    reply:
      `เมนูหลัก:
• เติม Genshin Impact
• เติม Honkai: Star Rail
• ดู Artifact Genshin (จากชื่อ) / ดู Relic Star Rail (จากชื่อ)
• ดู Artifact Genshin (จาก UID) / ดู Relic Star Rail (จาก UID)`,
    quickReplies: [
      "เติม Genshin Impact",
      "เติม Honkai: Star Rail",
      "ดู Artifact Genshin",
      "ดู Relic Star Rail",
    ],
  };
}

async function handleIntent(intent: Intent, s: Session) {
  if (intent === "cancel") {
    sessionsReset(s);
    return {
      reply: "ยกเลิกขั้นตอนแล้ว เลือกต่อได้เลย:",
      quickReplies: [
        "เติม Genshin Impact",
        "เติม Honkai: Star Rail",
        "ดู Artifact Genshin",
        "ดู Relic Star Rail",
      ],
    };
  }
  if (intent === "gi_topup" || intent === "hsr_topup") {
    const game: GameKey = intent === "gi_topup" ? "gi" : "hsr";
    const list = await fetchProducts(game);
    s.state = game === "gi" ? "waiting_gi" : "waiting_hsr";
    s.game = game;
    s.productList = list;
    const head = game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
    return {
      reply:
        `สวัสดีค่ะ เติม ${head} ได้เลย\n\n` +
        `${renderProductList(list)}\n\n` +
        `พิมพ์หมายเลข 1-${list.length} หรือพิมพ์ราคา (เช่น 179) / ตัวเลขในชื่อแพ็ก (980, 6480) / หรือพิมพ์ "รายเดือน"`,
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
  if (intent === "artifact_enka" || intent === "relic_enka") {
    s.state = "waiting_enka_uid";
    s.enka = { game: intent === "artifact_enka" ? "gi" : "hsr" };
    return { reply: `กรุณาพิมพ์ UID ${s.enka.game === "gi" ? "Genshin" : "Star Rail"} ของคุณ (ตัวเลขเท่านั้น)` };
  }
  return mainMenu();
}

function sessionsReset(s: Session) {
  s.state = "idle";
  s.game = undefined;
  s.selectedIndex = undefined;
  s.selectedName = undefined;
  s.selectedPrice = undefined;
  s.uid = undefined;
  s.playerName = undefined;
  s.productList = undefined;
  s.enka = undefined;
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

  /* ---------- Global reset ---------- */
  if (text && RE_RESET.test(text)) {
    sessions[key] = { state: "idle" };
    return NextResponse.json({
      reply: "รีเซ็ตขั้นตอนเรียบร้อย เริ่มใหม่ได้เลยค่ะ:",
      quickReplies: [
        "เติม Genshin Impact",
        "เติม Honkai: Star Rail",
        "ดู Artifact Genshin",
        "ดู Relic Star Rail",
      ],
    });
  }

  /* ---------- Intent เมื่อ idle ---------- */
  if (s.state === "idle") {
    const intent = detectIntent(lower);
    if (intent) {
      const out = await handleIntent(intent, s);
      return NextResponse.json(out);
    }
  }

  /* ---------- เลือกแพ็ก ---------- */
  if (s.state === "waiting_gi" || s.state === "waiting_hsr") {
    if (RE_RESET.test(text) || RE_CANCEL.test(text)) {
      sessionsReset(s);
      return NextResponse.json(mainMenu());
    }
    const game: GameKey = s.state === "waiting_gi" ? "gi" : "hsr";
    const list =
      s.productList && s.productList.length > 0
        ? s.productList
        : await fetchProducts(game);

    let idx: number | null = pickIndexFromMessage(text, list.length);
    if (idx == null) idx = matchPackageSmart(list, text);

    if (idx == null || idx < 0 || idx >= list.length) {
      return NextResponse.json({
        reply: `ไม่พบแพ็กเกจที่เลือกค่ะ ลองพิมพ์หมายเลข 1-${list.length} หรือพิมพ์ราคา (เช่น 179) / ตัวเลขในชื่อแพ็ก (980, 6480) / หรือพิมพ์ "รายเดือน"`,
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
    });
  }

  /* ---------- Waiting UID (Topup) ---------- */
  if (s.state === "waiting_uid_gi" || s.state === "waiting_uid_hsr") {
    const uidOnly = toArabic(text).replace(/\D/g, "");
    if (!uidOnly) {
      return NextResponse.json({
        reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ (หรือพิมพ์ ‘ยกเลิก’ เพื่อเริ่มใหม่)",
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
      `สรุปรายการสั่งซื้อ (รอยืนยัน)\n` +
      `เกม: ${gameName}\n` +
      `UID: ${uidOnly}\n` +
      `ชื่อผู้เล่น: -\n` +
      `แพ็กเกจ: ${pkg}\n` +
      `จำนวนที่จะได้รับ: ${amount}\n` +
      `ราคา: ${price.toFixed(2)} บาท\n\n` +
      `กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก`;

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
        `รับคำยืนยันแล้วค่ะ ✅\n` +
        `ยอดชำระ: ${price.toFixed(2)} บาท\n` +
        `แพ็กเกจ: ${pkg}\n` +
        `UID: ${uid}\n\n` +
        `กรุณาสแกน QR เพื่อชำระเงินได้เลยค่ะ`;

      return NextResponse.json({
        reply,
        quickReplies: [],
        paymentRequest: { showQR: true },
      });
    }
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      return NextResponse.json(mainMenu());
    }
    return NextResponse.json({
      reply: "กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก",
      quickReplies: ["ยืนยัน", "ยกเลิก"],
    });
  }

  /* ---------- Artifact/Relic (จากชื่อ) ---------- */
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

    const setShorts = (rows as RowDataPacket[]).map((r) => String((r as any).set_short || ""));
    const head = game === "gi" ? "Artifact" : "Relic";
    const lines = setShorts.map((x) => `- ${x}`).join("\n");

    return NextResponse.json({
      reply: `${head} ที่เหมาะกับ ${raw} คือ:\n${lines}`,
      quickReplies: ["คำนวณสเตตจากรูป", "ดูเซ็ตตัวอื่น"],
    });
  }

  /* ---------- Artifact/Relic (จาก UID enka) ---------- */
  if (s.state === "waiting_enka_uid") {
    const uid = toArabic(text).replace(/\D/g, "");
    if (!uid) return NextResponse.json({ reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ" });

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
        return NextResponse.json({ reply: "ดึงข้อมูลจาก enka ไม่สำเร็จ ลองใหม่หรือเช็คว่าโปรไฟล์เปิดสาธารณะนะคะ" });
      }
      s.state = "waiting_pick_character";
      s.enka.player = j.player as string;
      s.enka.characters = j.characters as { id: number; name: string; level: number }[];
      s.enka.details = j.details as Record<string, unknown>;

      const chips = (j.characters as { id: number; name: string; level: number }[])
        .map((c) => `${c.name} (lv.${c.level})`);

      return NextResponse.json({
        reply: `พบตัวละครของ ${j.player} (UID: ${uid})\nเลือกตัวที่อยากดูของได้เลย:`,
        quickReplies: chips.slice(0, 10),
      });
    } catch {
      s.state = "idle";
      return NextResponse.json({ reply: "ดึงข้อมูลจาก enka ไม่สำเร็จค่ะ" });
    }
  }

  if (s.state === "waiting_pick_character") {
    const target = (s.enka?.characters || []).find((c) =>
      new RegExp(`\\b${(c.name || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text)
    );
    if (!target) {
      return NextResponse.json({ reply: "ไม่พบชื่อตัวละครนี้ในลิสต์ค่ะ ลองพิมพ์ชื่อให้ตรงหรือเลือกจากปุ่มด่วนด้านล่าง" });
    }

    const d = (s.enka?.details as Record<string, unknown>) || {};
    const detail = d[String(target.id)] as {
      artifacts?: Array<{
        piece: string; name: string; set?: string; main: string; subs: string[]; level?: number;
      }>;
      totalsFromGear?: { er: number; cr: number; cd: number; em: number; hp_pct: number; atk_pct: number; def_pct: number };
      shownTotals?: Record<string, number>;
    };

    s.state = "idle";
    if (!detail) return NextResponse.json({ reply: "ไม่พบรายละเอียดชิ้นส่วนของตัวละครนี้ค่ะ" });

    const lines = (detail.artifacts || []).map((a) => {
      const subs = a.subs && a.subs.length ? ` | subs=${a.subs.join(", ")}` : "";
      return `• ${a.piece}: ${a.name} | main=${a.main}${subs}`;
    }).join("\n");

    const head = `ของที่สวมใส่ของ ${target.name} (เลเวล ${target.level})`;
    const ask = `จะให้วิเคราะห์สเตตด้วย Gemini มั้ย?`;
    return NextResponse.json({
      reply: `${head}\n${lines}\n\n${ask}`,
      quickReplies: ["วิเคราะห์สเตตด้วย Gemini", "ดูเซ็ตตัวอื่น", "เมนู"],
    });
  }

  /* ---------- Fallback ---------- */
  if (s.state === "idle") {
    return NextResponse.json(mainMenu());
  }

  return NextResponse.json({
    reply:
      "ขอโทษค่ะ ตอนนี้กำลังอยู่ในขั้นตอนก่อนหน้าอยู่ค่ะ กรุณาตอบให้ตรงขั้นตอน หรือพิมพ์ ‘ยกเลิก/เปลี่ยนใจ’ เพื่อเริ่มใหม่ได้เลยนะคะ~",
  });
}
