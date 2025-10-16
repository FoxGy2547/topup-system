import { NextResponse } from "next/server";
import mysql, { RowDataPacket } from "mysql2/promise";

// ใช้ไฟล์ map id→ชื่อของ HSR (เช่น { "130":"Ruan Mei", ... })
import HSR_NAME_BY_ID from "@/data/hsr_characters.json";

/* ===================== DB Pool ===================== */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
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
  | "waiting_pick_character"
  | "picked_character";

type Session = {
  state: StateKey;
  game?: GameKey;

  selectedIndex?: number;
  selectedName?: string;
  selectedPrice?: number;
  uid?: string;
  productList?: Array<{ name: string; price: number }>;

  enka?: {
    uid?: string;
    game?: GameKey;
    player?: string;
    characters?: { id: number; name: string; level: number }[];
    details?: Record<string, any>;
    selectedId?: number;
  };

  lastAdviceError?: string | null;
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
const toArabic = (s: string) =>
  [...(s || "")].map(c => {
    const i = THAI_DIGITS.indexOf(c);
    return i >= 0 ? String(i) : c;
  }).join("");

const normalize = (s: string) =>
  toArabic(s).replace(/\u200b/g, "")
    .replace(/[“”]/g, '"').replace(/[’‘]/g, "'")
    .replace(/[–—]/g, "-").replace(/\s+/g, " ")
    .trim().toLowerCase();

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
  if (Number.isNaN(n) || n < 1 || n > max) return null;
  return n - 1;
}

/* ===================== รูปโลคัล & เรนเดอร์ ===================== */
const ORDER_GI = ["Flower", "Plume", "Sands", "Goblet", "Circlet"];
const ORDER_HSR = ["HEAD", "HANDS", "BODY", "FEET", "PLANAR_SPHERE", "LINK_ROPE"];

type AnyGear = {
  piece: string;
  name: string;
  set?: string;
  main: string;
  subs?: string[];
  level?: number;
};

const keyizeHSR = (piece: string) =>
  piece.replace(/\s+/g, "_").replace(/-/g, "_").toUpperCase();

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
const displayPiece = (game: GameKey, raw: string) =>
  game === "gi"
    ? cap(raw)
    : keyizeHSR(raw).split("_").map(cap).join(" ");

const iconCatePath = (game: GameKey, raw: string) => {
  if (game === "gi") {
    const f = cap(raw).replace(/\s+/g, "");
    return `/pic/gi/cate/${f}.png`;
  }
  const f = keyizeHSR(raw).split("_").map(cap).join("_");
  return `/pic/hsr/cate/${f}.png`;
};

const escapeHtml = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const normColons = (s?: string) => String(s ?? "").replace(/\s*:\s*/g, ": ");

function renderGearHTML(list: AnyGear[], game: GameKey): string {
  if (!Array.isArray(list) || list.length === 0) return "<p>(ไม่พบชิ้นส่วน)</p>";

  const filtered = list.filter(g =>
    game === "gi" ? ORDER_GI.includes(g.piece) : ORDER_HSR.includes(keyizeHSR(g.piece))
  );
  const sorted = [...filtered].sort((a, b) =>
    game === "gi"
      ? ORDER_GI.indexOf(a.piece) - ORDER_GI.indexOf(b.piece)
      : ORDER_HSR.indexOf(keyizeHSR(a.piece)) - ORDER_HSR.indexOf(keyizeHSR(b.piece))
  );

  return `<ul style="margin:8px 0 0 18px;padding:0">
${sorted
  .map(g => {
    const title = `${escapeHtml(displayPiece(game, g.piece))}${typeof g.level === "number" ? ` [+${g.level}]` : ""}`;
    const main = escapeHtml(normColons(g.main) || "-");
    const subs = g.subs?.length
      ? `<ul style="margin:4px 0 0 18px;padding:0">
           ${g.subs.map(s => `<li style="margin:0;list-style:disc">${escapeHtml(normColons(s))}</li>`).join("")}
         </ul>`
      : "";
    return `
  <li style="margin:10px 0 14px 0">
    <div>
      <img src="${iconCatePath(game, g.piece)}" width="30" height="30" style="vertical-align:middle;margin-right:6px" />
      <span>${title}</span>
    </div>
    <div style="margin-top:4px">main: ${main}</div>
    <div>subs:</div>
    ${subs}
  </li>`;
  })
  .join("")}
</ul>`;
}

/* ===================== Data helpers ===================== */
async function fetchProducts(game: GameKey) {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT name, price FROM products WHERE gname = ? ORDER BY id",
    [game]
  );
  return rows as Array<{ name: string; price: number }>;
}
const renderProductList = (rows: Array<{ name: string; price: number }>) =>
  rows.map((p, i) => `${i + 1}. ${p.name} - ${Number(p.price).toFixed(2)} บาท`).join("\n\n");

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
type Intent = "gi_topup" | "hsr_topup" | "artifact_uid" | "relic_uid" | "cancel" | "help";

const GI_CHARGING = ["เติม genshin impact","เติมเกนชิน","เติม genshin","เติม gi","top up genshin","ซื้อ genesis","เพชร genshin","เจม genshin","คริสตัล genshin"];
const HSR_CHARGING = ["เติม honkai: star rail","เติม hsr","เติม star rail","เติม honkai star rail","top up hsr","ซื้อ oneiric","เพชร hsr","คริสตัล hsr","oneiric shard"];

const RE_ARTIFACT_ANY = /(artifact|อาร์ติ|อาร์ติแฟกต์)/i;
const RE_RELIC_ANY = /(relic|เรลิก)/i;

const hasAny = (text: string, arr: string[]) => {
  const t = normalize(text);
  return arr.some(k => t.includes(normalize(k)));
};

const RE_CONFIRM = /^(ยืนยัน|ตกลง|ok|โอเค|confirm)$/i;
const RE_CANCEL = /^(ยกเลิก|ไม่เอา(?:ละ|แล้ว)?|พอ|ไว้ก่อน|cancel|stop)$/i;
const RE_RESET  = /^(ยกเลิก|ยกเลิกคำสั่ง|เปลี่ยนใจ|เริ่มใหม่|reset|cancel|stop|ไม่เอา(?:ละ|แล้ว)?|พอ|ไว้ก่อน)$/i;
const RE_ANALYZE = /(วิเคราะห์สเตต|วิเคราะห์.*gemini|analy[sz])/i;

/* ---------- Reply helpers ---------- */
function mainMenu() {
  return {
    reply: `เมนูหลัก:
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
const onlyCancel = () => ({ quickReplies: ["ยกเลิก"] });
function sessionsReset(s: Session) {
  s.state = "idle";
  s.game = undefined;
  s.selectedIndex = undefined;
  s.selectedName = undefined;
  s.selectedPrice = undefined;
  s.uid = undefined;
  s.productList = undefined;
  s.enka = undefined;
  s.lastAdviceError = null;
}

/* ===================== Route ===================== */
export async function POST(req: Request) {
  const { message, username, sessionId } = (await req.json().catch(() => ({}))) as {
    message?: string; username?: string; sessionId?: string;
  };

  const text: string = (message || "").toString();
  const key = clientKey(req, username, sessionId);
  const s = getSession(key);

  /* ---------- Global reset ---------- */
  if (text && RE_RESET.test(text)) {
    sessions[key] = { state: "idle" };
    const menu = mainMenu();
    return NextResponse.json({ reply: "รีเซ็ตขั้นตอนเรียบร้อย เริ่มใหม่ได้เลยค่ะ:", quickReplies: menu.quickReplies });
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
        reply: `สวัสดีค่ะ เติม ${head} ได้เลย

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
    const list = s.productList && s.productList.length > 0 ? s.productList : await fetchProducts(game);

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
          if (diff <= tol && diff < bestDiff) { bestDiff = diff; bestIdx = i; }
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

    return NextResponse.json({ reply: "กรุณาพิมพ์ UID ของคุณ (ตัวเลขเท่านั้น)", ...onlyCancel() });
  }

  /* ---------- Waiting UID (Topup) ---------- */
  if (s.state === "waiting_uid_gi" || s.state === "waiting_uid_hsr") {
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }
    const uidOnly = toArabic(text).replace(/\D/g, "");
    if (!uidOnly) return NextResponse.json({ reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ", ...onlyCancel() });

    s.uid = uidOnly;

    const game: GameKey = s.state === "waiting_uid_gi" ? "gi" : "hsr";
    const gameName = game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
    const pkg = s.selectedName || "-";
    const price = s.selectedPrice ?? 0;
    const amount = parseAmountToReceive(game, pkg);

    s.state = "confirm_order";
    const reply = `สรุปรายการสั่งซื้อ (รอยืนยัน)
เกม: ${gameName}
UID: ${uidOnly}
แพ็กเกจ: ${pkg}
จำนวนที่จะได้รับ: ${amount}
ราคา: ${price.toFixed(2)} บาท

กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก`;
    return NextResponse.json({ reply, quickReplies: ["ยืนยัน", "ยกเลิก"] });
  }

  /* ---------- Confirm order ---------- */
  if (s.state === "confirm_order") {
    if (RE_CONFIRM.test(text)) {
      const uid = s.uid || "-";
      const pkg = s.selectedName || "-";
      const price = s.selectedPrice ?? 0;

      sessionsReset(s);

      const reply = `รับคำยืนยันแล้วค่ะ ✅
ยอดชำระ: ${price.toFixed(2)} บาท
แพ็กเกจ: ${pkg}
UID: ${uid}

กรุณาสแกน QR เพื่อชำระเงินได้เลยค่ะ`;
      return NextResponse.json({ reply, quickReplies: [], paymentRequest: { showQR: true } });
    }
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }
    return NextResponse.json({ reply: "กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก", quickReplies: ["ยืนยัน", "ยกเลิก"] });
  }

  /* ---------- Artifact/Relic (ผ่าน UID Enka) ---------- */
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
      const enkaUrl = game === "hsr" ? `${base}/api/enka-hsr` : `${base}/api/enka-gi`;

      const r = await fetch(enkaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
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
      s.enka.details = j.details as Record<string, any>;

      // ปรับ label ชื่อให้เป็น "ชื่อจริง (lv.X)" — ถ้าไม่มีชื่อ ใช้แมปจากไฟล์ JSON → สุดท้ายค่อย #id
      const chips = (s.enka.characters || []).slice(0, 12).map((c) => {
        const byDetail = s.enka?.details?.[String(c.id)]?.name as string | undefined;
        const byPayload = c.name;
        const byJson = (HSR_NAME_BY_ID as Record<string, string>)[String(c.id)];
        const show = (byDetail || byPayload || byJson || `#${c.id}`).trim();
        return `${show} (lv.${c.level})`;
      });

      return NextResponse.json({
        reply: `กำลังดึงข้อมูลจาก Enka... สำเร็จแล้ว!
พบตัวละครของ ${j.player} (UID: ${uid})
เลือกตัวที่อยากดูของได้เลย:`,
        quickReplies: [...chips, "ยกเลิก"],
      });
    } catch {
      s.state = "idle";
      const menu = mainMenu();
      return NextResponse.json({ reply: "ดึงข้อมูลจาก enka ไม่สำเร็จค่ะ", quickReplies: menu.quickReplies });
    }
  }

  /* ===================== เลือกตัวละคร (รองรับ HSR) ===================== */
  if (s.state === "waiting_pick_character") {
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }

    const chars = s.enka?.characters || [];
    const details = s.enka?.details || {};
    const game = (s.enka?.game || "gi") as GameKey;

    // หา target จาก (1) ID ในข้อความ (2) ชื่อที่ตรงกับปุ่ม/รายละเอียด
    const idMatch = text.match(/\b#?(\d{3,9})\b/);
    let target: { id: number; name: string; level: number } | null = null;

    if (idMatch) {
      const pickId = Number(idMatch[1]);
      target = chars.find((c) => c.id === pickId) || null;
    }
    if (!target) {
      target =
        chars.find((c) => {
          const byDetail = details[String(c.id)]?.name as string | undefined;
          const byPayload = c.name;
          const byJson = (HSR_NAME_BY_ID as Record<string, string>)[String(c.id)];
          const nm = (byDetail || byPayload || byJson || "").trim();
          if (!nm) return false;
          const re = new RegExp(`\\b${nm.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
          return re.test(text);
        }) || null;
    }

    if (!target) {
      const chips = chars.slice(0, 12).map((c) => {
        const byDetail = details[String(c.id)]?.name as string | undefined;
        const byPayload = c.name;
        const byJson = (HSR_NAME_BY_ID as Record<string, string>)[String(c.id)];
        const show = (byDetail || byPayload || byJson || `#${c.id}`).trim();
        return `${show} (lv.${c.level})`;
      });
      return NextResponse.json({
        reply: "ไม่พบตัวละครนี้ในลิสต์ค่ะ ลองพิมพ์ให้ตรงหรือเลือกจากปุ่มด้านล่าง",
        quickReplies: [...chips, "ยกเลิก"],
      });
    }

    const d = details[String(target.id)] as {
      name?: string;
      artifacts?: AnyGear[];
      totalsFromGear?: any;
      shownTotals?: any;
      relics?: AnyGear[];
    };

    /* ==== ชุดที่แนะนำ (HSR ใช้ไฟล์รูปตามรหัสย่อ) ==== */
    let setRows: RowDataPacket[] = [];
    try {
      const rawName =
        d?.name ||
        target.name ||
        (HSR_NAME_BY_ID as Record<string, string>)[String(target.id)] ||
        `#${target.id}`;
      const q = `%${rawName}%`;
      let [rows] = await db.query<RowDataPacket[]>(
        `SELECT set_short FROM character_sets WHERE game = ? AND character_name = ?`,
        [s.enka?.game || "hsr", rawName]
      );
      if (!rows || rows.length === 0) {
        [rows] = await db.query<RowDataPacket[]>(
          `SELECT set_short FROM character_sets
           WHERE game = ?
             AND (character_name LIKE ? 
                  OR REPLACE(LOWER(character_name),' ','') = REPLACE(LOWER(?),' ','')) 
           LIMIT 4`,
          [s.enka?.game || "hsr", q, rawName]
        );
      }
      setRows = rows || [];
    } catch {
      setRows = [];
    }

    // "GoBS-PCCE/..." → แสดงรูปซ้าย (4 ชิ้น) + ขวา (2 ชิ้น)
    function shortToIconsHTML(combo: string): string {
      if (!combo) return "";
      const take = (s: string) => s.split("/")[0]?.trim() || "";

      let cav = "";
      let plan = "";

      if (combo.includes("-")) {
        const [left, right] = combo.split("-", 2);
        cav = take(left);
        plan = take(right);
      } else {
        cav = take(combo);
      }

      const imgs: string[] = [];
      if (cav) imgs.push(`<img src="/pic/hsr/${cav}.png" width="50" height="50" title="${cav} (4 ชิ้น)" />`);
      if (plan) imgs.push(`<img src="/pic/hsr/${plan}.png" width="50" height="50" title="${plan} (2 ชิ้น)" />`);
      return imgs.length ? `<span>${imgs.join("")}</span>` : "";
    }

    const recLines: string[] = [];
    for (const r of setRows) {
      const combo = String((r as any).set_short || "");
      const icons = shortToIconsHTML(combo);
      if (icons) recLines.push(`• ${icons}`);
    }
    const recSetsHtml = recLines.length ? recLines.join("<br/>") : "• (ไม่พบข้อมูลในฐานข้อมูล)";

    // เลือก list ที่จะแสดง (GI = artifacts, HSR = relics)
    const listForShow = (Array.isArray(d?.artifacts) && d!.artifacts!.length
      ? d!.artifacts!
      : d?.relics || []) as AnyGear[];

    const gearHtml = renderGearHTML(listForShow, game);

    const shownName =
      d?.name ||
      target.name ||
      (HSR_NAME_BY_ID as Record<string, string>)[String(target.id)] ||
      `#${target.id}`;

    const head = `ของที่สวมใส่ของ ${shownName} (เลเวล ${target.level})`;
    const recHead = `Artifact/Relic ที่ฐานข้อมูลแนะนำ:`;
    const ask = `ต้องการ “วิเคราะห์สเตตด้วย Gemini” ไหมคะ?`;

    return NextResponse.json({
      // ส่งเป็น HTML ให้ฟรอนต์โชว์รูป (ใช้ replyHtml)
      replyHtml: `
        <div>
          <div style="margin-bottom:10px">${escapeHtml(head)}</div>
          ${gearHtml}
          <div style="margin-top:14px">${escapeHtml(recHead)}</div>
          <div style="margin-top:6px;line-height:1.2">${recSetsHtml}</div>
          <div style="margin-top:12px">${escapeHtml(ask)}</div>
        </div>
      `,
      reply: `${head}\n(ดูในโหมดมีรูป)`,
      quickReplies: ["วิเคราะห์สเตตด้วย Gemini", "ยกเลิก"],
    });
  }

  /* ---------- วิเคราะห์หลังเลือกตัวละคร ---------- */
  if (s.state === "picked_character") {
    if (RE_CANCEL.test(text)) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({ reply: "ยกเลิกแล้วค่ะ", quickReplies: menu.quickReplies });
    }
    if (!RE_ANALYZE.test(text)) {
      return NextResponse.json({
        reply: "หากต้องการให้ช่วยประเมินสเตต กด “วิเคราะห์สเตตด้วย Gemini” หรือพิมพ์วิเคราะห์ได้เลยนะคะ",
        quickReplies: ["วิเคราะห์สเตตด้วย Gemini", "ยกเลิก"],
      });
    }

    const game: GameKey = s.enka?.game || "gi";
    const id = s.enka?.selectedId;
    const details = s.enka?.details || {};
    const d = id ? details[String(id)] : null;

    if (!d) {
      sessionsReset(s);
      const menu = mainMenu();
      return NextResponse.json({
        reply: "ไม่พบข้อมูลตัวละครสำหรับวิเคราะห์ค่ะ ลองเริ่มใหม่อีกครั้งนะคะ",
        quickReplies: menu.quickReplies,
      });
    }

    try {
      const base = new URL(req.url).origin;
      const thinking = `⌛ กำลังคำนวณคำแนะนำ…`;

      const body =
        game === "gi"
          ? { game: "gi", mode: "from-enka", character: d.name || `#${id}`, artifacts: d.artifacts || [], totalsFromGear: d.totalsFromGear || {}, shownTotals: d.shownTotals || {} }
          : { game: "hsr", mode: "from-enka", character: d.name || `#${id}`, artifacts: d.relics || [], shownTotals: d.shownTotals || {} };

      const r = await fetch(`${base}/api/advice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));

      const textOut = String(j?.text || "").trim();
      s.lastAdviceError = j?.ok ? null : (j?.error as string) || null;

      if (j?.ok && textOut) {
        return NextResponse.json({
          reply: `${thinking}\n\n📊 ผลการวิเคราะห์สำหรับ ${d.name}:\n${textOut}`,
          quickReplies: ["ยกเลิก"],
        });
      }

      const fb = game === "gi" ? simpleFallbackAdvice(d?.totalsFromGear, d?.shownTotals) : simpleFallbackAdviceHSR(d?.shownTotals);
      const reason = s.lastAdviceError ? `\n(สาเหตุเข้าโหมดสำรอง: ${s.lastAdviceError})` : r.ok ? "" : `\n(HTTP ${r.status})`;
      return NextResponse.json({
        reply: `${thinking}\n\n📊 ผลวิเคราะห์ (โหมดสำรอง) สำหรับ ${d.name}:\n${fb}${reason}`,
        quickReplies: ["ยกเลิก"],
      });
    } catch (e) {
      const fb = (s.enka?.game || "gi") === "gi" ? simpleFallbackAdvice(d?.totalsFromGear, d?.shownTotals) : simpleFallbackAdviceHSR(d?.shownTotals);
      return NextResponse.json({
        reply: `⌛ กำลังคำนวณคำแนะนำ…\n\n📊 ผลวิเคราะห์ (โหมดสำรอง) สำหรับ ${d.name}:\n${fb}`,
        quickReplies: ["ยกเลิก"],
      });
    }
  }

  /* ---------- Fallback + Sticky step ---------- */
  if (s.state === "idle") return NextResponse.json(mainMenu());

  const step =
    s.state === "waiting_enka_uid" ? "ขอ UID"
    : s.state === "waiting_pick_character" ? "เลือกตัวละคร"
    : s.state === "picked_character" ? "วิเคราะห์สเตต"
    : s.state === "waiting_gi" || s.state === "waiting_hsr" ? "เลือกแพ็ก"
    : s.state === "waiting_uid_gi" || s.state === "waiting_uid_hsr" ? "ขอ UID"
    : s.state === "confirm_order" ? "ยืนยันคำสั่งซื้อ" : "ดำเนินการ";

  return NextResponse.json({
    reply: `เรากำลังอยู่ที่ขั้น “${step}” อยู่เลยนะ ช่วยตอบให้ตรงขั้น หรือพิมพ์ ‘ยกเลิก/เปลี่ยนใจ’ เพื่อเริ่มใหม่ได้เลย~`,
    ...onlyCancel(),
  });
}

/* ===== helper fallback แบบเบา ๆ (GI) ===== */
function simpleFallbackAdvice(
  totals?: { er?: number; cr?: number; cd?: number; em?: number; hp_pct?: number; atk_pct?: number; def_pct?: number; },
  shown?: { er?: number; cr?: number; cd?: number }
): string {
  const cr = totals?.cr ?? (shown?.cr != null ? shown.cr * 100 : 0);
  const cd = totals?.cd ?? (shown?.cd != null ? shown.cd * 100 : 0);
  const erShown = shown?.er != null ? shown.er * 100 : undefined;
  const er = totals?.er != null ? totals.er + 100 : erShown ?? 0;
  const target = { cr: 70, cd: 140, er: 120 };
  const lack: string[] = [];
  if (cr < target.cr) lack.push(`CR ต่ำ (ปัจจุบัน ~${cr.toFixed(0)}%) → เติม CR จากหมวก/ซับ`);
  if (cd < target.cd) lack.push(`CD ต่ำ (ปัจจุบัน ~${cd.toFixed(0)}%) → หา CD จากซับ หรือใช้หมวก CR แล้วดัน CD จากซับ`);
  if (er < target.er) lack.push(`ER ต่ำ (รวม ~${er.toFixed(0)}%) → หา ER จากทราย/ซับ/อาวุธ ให้แตะ ~${target.er}%`);
  return lack.length ? lack.join("\n") : "ค่าสรุปพื้นฐานถึงเกณฑ์แล้ว โฟกัสรีโรลซับให้สวยขึ้นต่อได้เลย";
}

/* ===== helper fallback แบบเบา ๆ (HSR) ===== */
function simpleFallbackAdviceHSR(
  shown?: { cr?: number; cd?: number; err?: number; ehr?: number; spd?: number }
): string {
  const pct = (x?: number) => (typeof x === "number" ? x * 100 : 0);
  const cr = pct(shown?.cr);
  const cd = pct(shown?.cd);
  const err = pct(shown?.err);
  const ehr = pct(shown?.ehr);
  const spd = shown?.spd ?? 0;
  const lacks: string[] = [];
  if (cr < 70) lacks.push(`CR ต่ำ (~${cr.toFixed(0)}%) → เติม CR จากซับ/ชิ้นส่วน`);
  if (cd < 140) lacks.push(`CD ต่ำ (~${cd.toFixed(0)}%) → หา CD จากซับหรือเปลี่ยนหมวก CR/CD ตามที่ขาด`);
  if (err < 100) lacks.push(`ERR ต่ำ (~${err.toFixed(0)}%) → หา ERR จากเชือก/ซับ ให้แตะ 100–120%`);
  if (spd < 120) lacks.push(`SPD ต่ำ (~${spd.toFixed(0)}) → พยายามแตะ breakpoint 120/134/147 ตามทีม`);
  if (ehr < 67) lacks.push(`EHR ต่ำ (~${ehr.toFixed(0)}%) สำหรับสายดีบัฟควร ≥ ~67%`);
  return lacks.length ? lacks.join("\n") : "ค่าสรุปพื้นฐานถึงเกณฑ์ทั่วไปแล้ว เน้นรีโรลซับค่า CR/CD/SPD ให้สมดุลตามบทบาท";
}

/* ---------- Intent detector ---------- */
function detectIntent(text: string): Intent | null {
  const t = text.trim();
  if (RE_CANCEL.test(t)) return "cancel";
  if (RE_ARTIFACT_ANY.test(t)) return "artifact_uid";
  if (RE_RELIC_ANY.test(t)) return "relic_uid";
  if (hasAny(t, GI_CHARGING)) return "gi_topup";
  if (hasAny(t, HSR_CHARGING)) return "hsr_topup";
  if (/^(help|ช่วยด้วย|เมนู|เริ่มใหม่)$/i.test(t)) return "help";
  return null;
}
