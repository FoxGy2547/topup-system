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
  | "waiting_pick_character"
  | "picked_character";

type Session = {
  state: StateKey;
  game?: GameKey;

  // topup
  selectedIndex?: number;
  selectedName?: string;
  selectedPrice?: number;
  uid?: string;
  uidName?: string; // เก็บชื่อ (nickname) ที่ดึงจาก Enka
  productList?: Array<{ name: string; price: number }>;

  // enka
  enka?: {
    uid?: string;
    game?: GameKey;
    player?: string;
    characters?: { id: number; name: string; level: number }[];
    details?: Record<string, any>;
    selectedId?: number;
    chipMap?: Record<string, string>; // << เพิ่ม: map label -> ชื่อ
  };

  lastAdviceError?: string | null;
  busy?: boolean;
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

/* ===================== Icons & Ordering (LOCAL PATH) ===================== */
/* GI:  /pic/gi/cate/{Piece}.png          → Flower.png, Plume.png ...
   HSR: /pic/hsr/cate/{Word_Case}.png     → Planar_Sphere.png, Link_Rope.png ...
   และแสดงชื่อชิ้นแบบ Title Case (ตัวแรกใหญ่ของแต่ละคำ) */

const ORDER_GI = ["Flower", "Plume", "Sands", "Goblet", "Circlet"] as const;
const ORDER_HSR = ["HEAD", "HANDS", "BODY", "FEET", "PLANAR_SPHERE", "LINK_ROPE"] as const;

const GI_CATE_BASE = "/pic/gi/cate/";
const HSR_CATE_BASE = "/pic/hsr/cate/";

function capFirst(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}
function titleCaseWords(s: string) {
  return s
    .split(/\s+/)
    .map(capFirst)
    .join(" ");
}

/* แปลงชื่อชิ้น HSR ให้เป็นคีย์มาตรฐาน (HEAD/HANDS/...) */
function keyizeHSR(piece: string) {
  return piece.replace(/\s+/g, "_").replace(/-/g, "_").toUpperCase();
}

/** ชื่อไว้แสดงผล: GI = Flower/Plume/... ; HSR = Planar Sphere/Link Rope/... */
function displayPiece(game: GameKey, rawPiece: string) {
  if (game === "gi") {
    return titleCaseWords(String(rawPiece).replace(/_/g, " "));
  }
  const words = keyizeHSR(rawPiece).split("_").map(capFirst);
  return words.join(" ");
}

/** path รูป cate/ */
function iconPath(game: GameKey, rawPiece: string) {
  if (game === "gi") {
    const name = displayPiece("gi", rawPiece).replace(/\s+/g, "");
    return `${GI_CATE_BASE}${name}.png`;
  }
  const words = keyizeHSR(rawPiece).split("_").map(capFirst);
  const name = words.join("_");
  return `${HSR_CATE_BASE}${name}.png`;
}

type AnyGear = {
  piece: string;
  name: string;
  set?: string;
  main: string;
  subs?: string[];
  level?: number;
};

/* ฟอร์แมตโคลอน */
function normalizeColons(s?: string) {
  return String(s ?? "").replace(/\s*:\s*/g, ": ");
}

/* ========== Render (HTML พร้อม <img src="/pic/..."> ใน reply เดียว) ========== */
function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function renderGearHTML(list: AnyGear[], game: GameKey): string {
  if (!Array.isArray(list) || list.length === 0) return "<i>(ไม่พบชิ้นส่วน)</i>";

  const filtered = list.filter((g) =>
    game === "gi"
      ? (ORDER_GI as readonly string[]).includes(g.piece)
      : (ORDER_HSR as readonly string[]).includes(keyizeHSR(g.piece))
  );
  const sorted = [...filtered].sort((a, b) => {
    if (game === "gi") {
      return (ORDER_GI as readonly string[]).indexOf(a.piece) - (ORDER_GI as readonly string[]).indexOf(b.piece);
    }
    return (
      (ORDER_HSR as readonly string[]).indexOf(keyizeHSR(a.piece)) -
      (ORDER_HSR as readonly string[]).indexOf(keyizeHSR(b.piece))
    );
  });

  const blocks: string[] = [];
  for (const g of sorted) {
    const src = iconPath(game, g.piece);
    const piece = escapeHtml(displayPiece(game, g.piece));
    const level = typeof g.level === "number" ? ` [+${g.level}]` : "";
    const main = escapeHtml(normalizeColons(g.main) || "-");
    const subs = g.subs?.length
      ? `<ul style="margin:0;padding-left:1.2em">${g.subs
          .map((s) => `<li>${escapeHtml(normalizeColons(s))}</li>`)
          .join("")}</ul>`
      : "";

    blocks.push(
      [
        `<div style="margin:0 0 10px 0">`,
        `<img src="${src}" alt="${piece}" width="28" height="28" />`,
        ` <b>${piece}${level}</b><br/>`,
        `main: ${main}<br/>`,
        `subs:<br/>${subs}`,
        `</div>`,
      ].join("")
    );
  }
  return blocks.join("");
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
  return rows.map((p, i) => `${i + 1}. ${p.name} - ${Number(p.price).toFixed(2)} บาท`).join("\n\n");
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
type Intent = "gi_topup" | "hsr_topup" | "artifact_uid" | "relic_uid" | "cancel" | "help";

const GI_CHARGING = [
  "เติม genshin impact",
  "เติมเกนชิน",
  "เติม genshin",
  "เติม gi",
  "top up genshin",
  "ซื้อ genesis",
  "เพชร genshin",
  "เจม genshin",
  "คริสตัล genshin",
];
const HSR_CHARGING = [
  "เติม honkai: star rail",
  "เติม hsr",
  "เติม star rail",
  "เติม honkai star rail",
  "top up hsr",
  "ซื้อ oneiric",
  "เพชร hsr",
  "คริสตัล hsr",
  "oneiric shard",
];

const RE_ARTIFACT_ANY = /(artifact|อาร์ติ|อาร์ติแฟกต์)/i;
const RE_RELIC_ANY = /(relic|เรลิก)/i;

function hasAny(text: string, arr: string[]) {
  const t = normalize(text);
  return arr.some((k) => t.includes(normalize(k)));
}

const RE_CONFIRM = /^(ยืนยัน|ตกลง|ok|โอเค|confirm)$/i;
const RE_CANCEL = /^(ยกเลิก|ไม่เอา(?:ละ|แล้ว)?|พอ|ไว้ก่อน|cancel|stop)$/i;
const RE_RESET =
  /^(ยกเลิก|ยกเลิกคำสั่ง|เปลี่ยนใจ|เริ่มใหม่|reset|cancel|stop|ไม่เอา(?:ละ|แล้ว)?|พอ|ไว้ก่อน)$/i;
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
  s.uidName = undefined;
  s.productList = undefined;
  s.enka = undefined;
  s.lastAdviceError = null;
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
    if (!uidOnly) {
      return NextResponse.json({ reply: "กรุณาพิม์ UID เป็นตัวเลขเท่านั้นค่ะ", ...onlyCancel() });
    }
    s.uid = uidOnly;
    s.uidName = undefined; // เคลียร์ก่อน

    const game: GameKey = s.state === "waiting_uid_gi" ? "gi" : "hsr";
    const gameName = game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
    const pkg = s.selectedName || "-";
    const price = s.selectedPrice ?? 0;
    const amount = parseAmountToReceive(game, pkg);

    // ดึงชื่อจาก Enka (ถ้าดึงไม่ได้จะเงียบ ๆ แล้วไปต่อ)
    try {
      const base = new URL(req.url).origin;
      const enkaUrl = game === "hsr" ? `${base}/api/enka-hsr` : `${base}/api/enka-gi`;
      const r = await fetch(enkaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: uidOnly }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok && j?.player) s.uidName = String(j.player);
    } catch {}

    s.state = "confirm_order";

    const nameLine = s.uidName ? `ชื่อ: ${s.uidName}\n` : "";
    const reply = `สรุปรายการสั่งซื้อ (รอยืนยัน)
เกม: ${gameName}
UID: ${uidOnly}
${nameLine}แพ็กเกจ: ${pkg}
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
      const nameLine = s.uidName ? `ชื่อ: ${s.uidName}\n` : "";

      sessionsReset(s);

      const reply = `รับคำยืนยันแล้วค่ะ ✅
ยอดชำระ: ${price.toFixed(2)} บาท
แพ็กเกจ: ${pkg}
${nameLine}UID: ${uid}

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
    if (!uid)
      return NextResponse.json({ reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ", ...onlyCancel() });

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
      s.enka.chipMap = Object.create(null); // << เตรียมเก็บ label -> name

      const chips = (s.enka.characters || [])
        .slice(0, 12)
        .map((c) => {
          const fromDetail = s.enka?.details?.[String(c.id)];
          const showName: string = (fromDetail && fromDetail.name) || c.name || `#${c.id}`;
          const label = `${showName}`;
          s.enka!.chipMap![label] = showName; // << เก็บ mapping
          return label;
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

    // แปลงข้อความที่รับมาให้เป็น "ชื่อ" ถ้าเป็นป้ายปุ่ม
    const rawUser = text.trim();
    const mappedFromChip = s.enka?.chipMap?.[rawUser];
    const userText = mappedFromChip || rawUser;

    // เดิม: รองรับการพิมพ์เป็น id ด้วย
    const idMatch = game === "hsr" ? userText.match(/\b#?(\d{3,6})\b/) : userText.match(/\b#?(\d{5,9})\b/);

    let target: { id: number; name: string; level: number } | null = null;

    if (idMatch) {
      const pickId = Number(idMatch[1]);
      target = chars.find((c) => c.id === pickId) || null;
    }
    if (!target) {
      target =
        chars.find((c) => {
          const nameFromDetail = details[String(c.id)]?.name as string | undefined;
          const nm = (nameFromDetail || c.name || "").trim();
          if (!nm) return false;
          // ใช้ข้อความที่ปรับจากปุ่มแล้ว (userText)
          const re = new RegExp(`\\b${nm.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
          return re.test(userText);
        }) || null;
    }

    if (!target) {
      const chips = chars.slice(0, 12).map((c) => {
        const nm = details[String(c.id)]?.name || c.name;
        const label = `${nm}`;
        // เผื่อผู้ใช้ย้อนกลับมาใหม่ ให้มี map พร้อมใช้
        if (!s.enka?.chipMap) s.enka = { ...(s.enka || {}), chipMap: Object.create(null) };
        s.enka!.chipMap![label] = nm;
        return label;
      });
      return NextResponse.json({
        reply: "ไม่พบตัวละครนี้ในลิสต์ค่ะ ลองพิมพ์ให้ตรงหรือเลือกจากปุ่มด้านล่าง",
        quickReplies: [...chips, "ยกเลิก"],
      });
    }

    const d = details[String(target.id)] as {
      name?: string;
      artifacts?: Array<{
        piece: string;
        name: string;
        set?: string;
        main: string;
        subs: string[];
        level?: number;
      }>;
      totalsFromGear?: {
        er: number;
        cr: number;
        cd: number;
        em: number;
        hp_pct: number;
        atk_pct: number;
        def_pct: number;
      };
      shownTotals?: {
        hp?: number;
        atk?: number;
        def?: number;
        em?: number;
        er?: number;
        cr?: number;
        cd?: number;
        pyro?: number;
        hydro?: number;
        cryo?: number;
        electro?: number;
        anemo?: number;
        geo?: number;
        dendro?: number;
        physical?: number;
      };
      relics?: Array<{
        piece: string;
        name: string;
        set?: string;
        main: string;
        subs: string[];
        level?: number;
      }>;
    };

    /* ==== “ชุดที่แนะนำ” จาก DB ==== */
    let setRows: RowDataPacket[] = [];
    try {
      const raw = d?.name || target.name || `#${target.id}`;
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

    function shortToIconsHTML(combo: string): string {
      if (!combo) return "";

      const gameFolder = (s.enka?.game || "gi") === "gi" ? "gi" : "hsr";

      // GI: ใช้ "/" แยกเซ็ต
      if (gameFolder === "gi") {
        const codes = combo.split("/").map((s) => s.trim()).filter(Boolean);
        if (!codes.length) return "";
        const imgs = codes
          .map((c) => `<img src="/pic/${gameFolder}/${c}.png" alt="${c}" width="50" height="50" />`)
          .join("");
        return `<span style="display:inline-block;vertical-align:middle">${imgs}</span>`;
      }

      // HSR: รองรับ Cavern-Planar "A-B/..." → ซีกซ้าย 4, ขวา 2
      const raw = combo.trim();
      const chopTail = (s: string) => s.split("/")[0]?.trim() || "";

      let cav = "";
      let plan = "";

      if (raw.includes("-")) {
        const [left, right] = raw.split("-", 2);
        cav = chopTail(left);
        plan = chopTail(right);
      } else {
        cav = chopTail(raw);
      }

      const parts: string[] = [];
      if (cav) {
        parts.push(
          `<img src="/pic/hsr/${cav}.png" alt="${cav} (4 ชิ้น)" width="50" height="50" title="${cav} (4 ชิ้น)" />`
        );
      }
      if (plan) {
        parts.push(
          `<img src="/pic/hsr/${plan}.png" alt="${plan} (2 ชิ้น)" width="50" height="50" title="${plan} (2 ชิ้น)" />`
        );
      }

      if (!parts.length) return "";
      const imgs = parts.join("");
      return `<span style="display:inline-block;vertical-align:middle">${imgs}</span>`;
    }

    const recLinesHtml: string[] = [];
    for (const r of setRows) {
      const combo = String((r as any).set_short || "");
      const icons = shortToIconsHTML(combo);
      if (icons) {
        recLinesHtml.push(`<div>•&nbsp;${icons}</div>`);
      }
    }
    const recSetsHtml = recLinesHtml.join("") || `<div>• (ไม่พบข้อมูลในฐานข้อมูล)</div>`;

    s.state = "picked_character";
    s.enka = s.enka || {};
    s.enka.selectedId = target.id;

    // เลือก list ที่จะแสดง (GI = artifacts, HSR = relics)
    const listForShow =
      (Array.isArray(d?.artifacts) && d!.artifacts!.length ? d!.artifacts! : d?.relics || []) as AnyGear[];

    const gearHtml = renderGearHTML(listForShow, game);
    const shownName = d?.name || target.name || `#${target.id}`;
    const headHtml = `<div><b>ของที่สวมใส่ของ ${shownName} (เลเวล ${target.level})</b></div>`;
    const recHeadHtml = `<div style="margin-top:8px"><b>Artifact/Relic ที่ฐานข้อมูลแนะนำ:</b></div>`;
    const askText = `ต้องการ “วิเคราะห์สเตตด้วย Gemini” ไหมคะ?`;
    const htmlPayload = `${headHtml}${gearHtml}${recHeadHtml}${recSetsHtml}<div style="margin-top:8px">${escapeHtml(
      askText
    )}</div>`;

    return NextResponse.json({
      reply: htmlPayload,
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
          ? {
              game: "gi",
              mode: "from-enka",
              character: d.name || `#${id}`,
              artifacts: d.artifacts || [],
              totalsFromGear: d.totalsFromGear || {},
              shownTotals: d.shownTotals || {},
            }
          : {
              game: "hsr",
              mode: "from-enka",
              character: d.name || `#${id}`,
              artifacts: d.relics || [],
              shownTotals: d.shownTotals || {},
            };

      const r = await fetch(`${base}/api/advice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({} as any));

      const textOut = String(j?.text || "").trim();
      s.lastAdviceError = j?.ok ? null : (j?.error as string) || null;

      if (j?.ok && textOut) {
        return NextResponse.json({
          reply: `${thinking}\n\n📊 ผลการวิเคราะห์สำหรับ ${d.name}:\n${textOut}`,
          quickReplies: ["ยกเลิก"],
        });
      }

      const fb =
        game === "gi"
          ? simpleFallbackAdvice(d?.totalsFromGear, d?.shownTotals)
          : simpleFallbackAdviceHSR(d?.shownTotals);
      const reason = s.lastAdviceError ? `\n(สาเหตุเข้าโหมดสำรอง: ${s.lastAdviceError})` : r.ok ? "" : `\n(HTTP ${r.status})`;
      return NextResponse.json({
        reply: `${thinking}\n\n📊 ผลวิเคราะห์ (โหมดสำรอง) สำหรับ ${d.name}:\n${fb}${reason}`,
        quickReplies: ["ยกเลิก"],
      });
    } catch (e) {
      s.lastAdviceError = (e as Error)?.message || "unknown_error";
      const fb =
        (s.enka?.game || "gi") === "gi" ? simpleFallbackAdvice(d?.totalsFromGear, d?.shownTotals) : simpleFallbackAdviceHSR(d?.shownTotals);
      return NextResponse.json({
        reply: `⌛ กำลังคำนวณคำแนะนำ…\n\n📊 ผลวิเคราะห์ (โหมดสำรอง) สำหรับ ${d.name}:\n${fb}\n(สาเหตุเข้าโหมดสำรอง: ${s.lastAdviceError})`,
        quickReplies: ["ยกเลิก"],
      });
    }
  }

  /* ---------- Fallback + Sticky step ---------- */
  if (s.state === "idle") {
    return NextResponse.json(mainMenu());
  }

  const step =
    s.state === "waiting_enka_uid"
      ? "ขอ UID"
      : s.state === "waiting_pick_character"
      ? "เลือกตัวละคร"
      : s.state === "picked_character"
      ? "วิเคราะห์สเตต"
      : s.state === "waiting_gi" || s.state === "waiting_hsr"
      ? "เลือกแพ็ก"
      : s.state === "waiting_uid_gi" || s.state === "waiting_uid_hsr"
      ? "ขอ UID"
      : s.state === "confirm_order"
      ? "ยืนยันคำสั่งซื้อ"
      : "ดำเนินการ";

  return NextResponse.json({
    reply: `เรากำลังอยู่ที่ขั้น “${step}” อยู่เลยนะ ช่วยตอบให้ตรงขั้น หรือพิมพ์ ‘ยกเลิก/เปลี่ยนใจ’ เพื่อเริ่มใหม่ได้เลย~`,
    ...onlyCancel(),
  });
}

/* ===== helper fallback แบบเบา ๆ (GI) ===== */
function simpleFallbackAdvice(
  totals?: {
    er?: number;
    cr?: number;
    cd?: number;
    em?: number;
    hp_pct?: number;
    atk_pct?: number;
    def_pct?: number;
  },
  shown?: { er?: number; cr?: number; cd?: number }
): string {
  const cr = totals?.cr ?? (shown?.cr != null ? shown.cr * 100 : 0);
  const cd = totals?.cd ?? (shown?.cd != null ? shown.cd * 100 : 0);
  const erShown = shown?.er != null ? shown.er * 100 : undefined;
  const er = totals?.er != null ? totals?.er + 100 : erShown ?? 0;

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
