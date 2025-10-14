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
  | "waiting_uid_enka_gi"
  | "waiting_uid_enka_hsr"
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
    game: GameKey;
    uid: string;
    player?: string;
    characters?: Array<{ id: number; name: string; level: number }>;
    details?: Record<string, unknown>;
    pickedId?: number;
  };
};

/* ===================== Sessions ===================== */
const sessions: Record<string, Session> = Object.create(null);
function getSession(key: string) { if (!sessions[key]) sessions[key] = { state: "idle" }; return sessions[key]; }
function clientKey(req: Request, username?: string, sessionId?: string) {
  if (username) return `u:${username}`;
  if (sessionId) return `sid:${sessionId}`;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ua = (req.headers.get("user-agent") || "").slice(0, 80);
  return `ipua:${ip}:${ua}`;
}

/* ===================== Utils ===================== */
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
function toArabic(s: string) { return [...(s || "")].map((c) => { const i = THAI_DIGITS.indexOf(c); return i >= 0 ? String(i) : c; }).join(""); }
function normalize(s: string) {
  return toArabic(s).replace(/\u200b/g, "").replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}
function extractNums(text: string): string[] { return (toArabic(text).match(/\d{2,6}/g) || []).map((x) => x.replace(/^0+/, "")); }
function matchPackageByName(rows: Array<{ name: string; price: number }>, userText: string): number | null {
  const s = normalize(userText);
  if (/รายเดือน/.test(s)) {
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
  }
  for (let i = 0; i < rows.length; i++) {
    const n = normalize(String(rows[i].name));
    if (s === n || s.startsWith(n) || s.includes(n)) return i;
  }
  return null;
}
function pickIndexFromMessage(msg: string, max: number): number | null {
  const m = toArabic(msg).match(/\d{1,3}/); if (!m) return null;
  const n = parseInt(m[0], 10); if (Number.isNaN(n) || n < 1 || n > max) return null;
  return n - 1;
}

/* ===================== Data helpers ===================== */
async function fetchProducts(game: GameKey) {
  const [rows] = await db.query<RowDataPacket[]>("SELECT name, price FROM products WHERE gname = ? ORDER BY id", [game]);
  return rows as Array<{ name: string; price: number }>;
}
function renderProductList(rows: Array<{ name: string; price: number }>) {
  return rows.map((p, i) => `${i + 1}. ${p.name} - ${Number(p.price).toFixed(2)} บาท`).join("\n\n");
}
function parseAmountToReceive(game: GameKey, productName: string): string {
  const m = productName.match(/^(\d[\d,]*)\s+(Genesis|Oneiric)/i);
  if (m) { const qty = m[1].replace(/,/g, ""); const unit = /Genesis/i.test(m[2]) ? "Genesis Crystals" : "Oneiric Shard"; return `${qty} ${unit}`; }
  return productName;
}
async function fetchPlayerName(game: GameKey, uid: string): Promise<string> {
  try {
    const ua = { "User-Agent": "Mozilla/5.0 Chatbot" };
    if (game === "gi") {
      const r1 = await fetch(`https://enka.network/api/uid/${uid}`, { headers: ua, cache: "no-store" });
      if (r1.ok) { const j = await r1.json().catch(() => null); const name = j?.playerInfo?.nickname || j?.player?.nickname || j?.owner?.nickname; if (name) return String(name); }
    } else {
      const r1 = await fetch(`https://enka.network/api/hsr/uid/${uid}`, { headers: ua, cache: "no-store" });
      if (r1.ok) { const j = await r1.json().catch(() => null); const name = j?.playerInfo?.nickname || j?.owner?.nickname; if (name) return String(name); }
    }
  } catch {}
  return "";
}

/* ===================== Intents ===================== */
type Intent = "gi_topup" | "hsr_topup" | "artifact" | "relic" | "cancel" | "help" | "artifact_enka" | "relic_enka";
const GI_CHARGING = ["เติม genshin impact","เติมเกนชิน","เติม genshin","เติม gi","top up genshin","ซื้อ genesis"];
const HSR_CHARGING = ["เติม honkai: star rail","เติม hsr","เติม star rail","เติม honkai star rail","top up hsr","ซื้อ oneiric"];
const ARTIFACT_GI = ["ดู artifact genshin impact","ดู artifact genshin","ดู artifact","artifact ตัวไหน","artifact ที่เหมาะกับ"];
const RELIC_HSR = ["ดู relic honkai star rail","ดู relic star rail","ดู relic","relic ที่เหมาะกับ"];
const VIEW_ARTIFACT_FROM_ENKA = ["ดู artifact genshin", "artifact จาก uid", "ดึงของจาก uid"];
const VIEW_RELIC_FROM_ENKA = ["ดู relic star rail", "relic จาก uid", "ดึงของ hsr จาก uid"];

function hasAny(text: string, arr: string[]) { const t = normalize(text); return arr.some((k) => t.includes(normalize(k))); }
const RE_CONFIRM = /^(ยืนยัน|ตกลง|ok|โอเค|confirm)$/i;
const RE_CANCEL = /^(ยกเลิก|cancel|ไม่เอา|ยกเลิกคำสั่ง)$/i;
const RE_RESET = /^(ยกเลิก|ยกเลิกคำสั่ง|เปลี่ยนใจ|เริ่มใหม่|reset|cancel|stop)$/i;

/* ===================== Fallback ===================== */
function safeFallback() {
  return (
    "พิมพ์คำสั่งได้เลยนะคะ ✨\n" +
    "• เติม Genshin Impact / เติม Honkai: Star Rail\n" +
    "• ดู Artifact Genshin Impact (จากชื่อ) / ดู Relic Honkai: Star Rail (จากชื่อ)\n" +
    "• หรือจะพิมพ์ “ดู Artifact Genshin” / “ดู Relic Star Rail” เพื่อดึงจาก UID ก็ได้\n" +
    "• พิมพ์ ยกเลิก/เปลี่ยนใจ เพื่อรีเซ็ต"
  );
}

function detectIntent(t: string): Intent | null {
  if (RE_CANCEL.test(t)) return "cancel";
  if (hasAny(t, GI_CHARGING)) return "gi_topup";
  if (hasAny(t, HSR_CHARGING)) return "hsr_topup";
  if (hasAny(t, VIEW_ARTIFACT_FROM_ENKA)) return "artifact_enka";
  if (hasAny(t, VIEW_RELIC_FROM_ENKA)) return "relic_enka";
  if (hasAny(t, ARTIFACT_GI)) return "artifact";
  if (hasAny(t, RELIC_HSR)) return "relic";
  if (/^(help|ช่วยด้วย|เมนู|เริ่มใหม่)$/i.test(t)) return "help";
  return null;
}

/* ===================== Route ===================== */
export async function POST(req: Request) {
  const { message, username, password, sessionId } = (await req.json()) as {
    message?: string; username?: string; password?: string; sessionId?: string;
  };

  const text: string = (message || "").toString().trim();
  const lower = normalize(text);
  const key = clientKey(req, username, sessionId);
  const s = getSession(key);

  /* ---------- Login ---------- */
  if (username && password && !message) {
    try {
      const [users] = await db.query<RowDataPacket[]>("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
      if (Array.isArray(users) && users.length > 0) return NextResponse.json({ success: true, message: "เข้าสู่ระบบสำเร็จ" }, { status: 200 });
      return NextResponse.json({ success: false, message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 });
    } catch { return NextResponse.json({ success: false, message: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" }, { status: 500 }); }
  }

  /* ---------- Global reset ---------- */
  if (text && RE_RESET.test(text)) {
    sessions[key] = { state: "idle" };
    return NextResponse.json({
      reply: "รีเซ็ตขั้นตอนเรียบร้อย เริ่มใหม่ได้เลยค่ะ:",
      quickReplies: ["เติม Genshin Impact","เติม Honkai: Star Rail","ดู Artifact Genshin","ดู Relic Star Rail"],
    });
  }

  /* ---------- Intent (idle เท่านั้น) ---------- */
  if (s.state === "idle") {
    const intent = detectIntent(lower);
    if (intent === "gi_topup" || intent === "hsr_topup") {
      const game: GameKey = intent === "gi_topup" ? "gi" : "hsr";
      const list = await fetchProducts(game);
      s.state = game === "gi" ? "waiting_gi" : "waiting_hsr";
      s.game = game;
      s.productList = list;
      return NextResponse.json({ reply: `สวัสดีค่ะ เติม ${game === "gi" ? "Genshin Impact" : "Honkai: Star Rail"} ได้เลย\n\n${renderProductList(list)}\n\nพิมพ์หมายเลข 1-${list.length} หรือพิมพ์ชื่อแพ็กก็ได้` });
    }
    if (intent === "artifact") { s.state = "waiting_artifact_char"; s.game = "gi"; return NextResponse.json({ reply: "อยากดู Artifact ของตัวไหนคะ? พิมพ์ชื่อมาได้เลย~" }); }
    if (intent === "relic") { s.state = "waiting_relic_char"; s.game = "hsr"; return NextResponse.json({ reply: "อยากดู Relic ของตัวไหนคะ? พิมพ์ชื่อมาได้เลย~" }); }
    if (intent === "artifact_enka") { s.state = "waiting_uid_enka_gi"; s.enka = { game: "gi", uid: "" }; return NextResponse.json({ reply: "กรุณาพิมพ์ UID Genshin ของคุณ (ตัวเลขเท่านั้น)" }); }
    if (intent === "relic_enka") { s.state = "waiting_uid_enka_hsr"; s.enka = { game: "hsr", uid: "" }; return NextResponse.json({ reply: "กรุณาพิมพ์ UID Honkai: Star Rail ของคุณ (ตัวเลขเท่านั้น)" }); }
  }

  /* ---------- เติมเงิน: เลือกแพ็ก ---------- */
  if (s.state === "waiting_gi" || s.state === "waiting_hsr") {
    const game: GameKey = s.state === "waiting_gi" ? "gi" : "hsr";
    const list = s.productList?.length ? s.productList : await fetchProducts(game);
    let idx: number | null = pickIndexFromMessage(text, list.length);
    if (idx == null) idx = matchPackageByName(list, text);
    if (idx == null || idx < 0 || idx >= list.length) return NextResponse.json({ reply: `ไม่พบแพ็กเกจที่เลือกค่ะ ลองพิมพ์หมายเลข 1-${list.length} หรือพิมพ์ตัวเลข/ชื่อแพ็กให้ชัดเจนอีกครั้งน้า~` });
    const p = list[idx]; s.selectedIndex = idx; s.selectedName = p.name; s.selectedPrice = Number(p.price); s.game = game;
    s.state = game === "gi" ? "waiting_uid_gi" : "waiting_uid_hsr"; s.productList = undefined;
    return NextResponse.json({ reply: "กรุณาพิมพ์ UID ของคุณ (ตัวเลขเท่านั้น)" });
  }

  /* ---------- เติมเงิน: รับ UID ---------- */
  if (s.state === "waiting_uid_gi" || s.state === "waiting_uid_hsr") {
    const uidOnly = toArabic(text).replace(/\D/g, ""); if (!uidOnly) return NextResponse.json({ reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ (หรือพิมพ์ ‘ยกเลิก’ เพื่อเริ่มใหม่)" });
    s.uid = uidOnly;
    const game: GameKey = s.state === "waiting_uid_gi" ? "gi" : "hsr";
    const player = await fetchPlayerName(game, uidOnly).catch(() => "");
    s.playerName = player || "";
    const gameName = game === "gi" ? "Genshin Impact" : "Honkai: Star Rail";
    const pkg = s.selectedName || "-"; const price = s.selectedPrice ?? 0; const amount = parseAmountToReceive(game, pkg);
    s.state = "confirm_order";
    const reply = `สรุปรายการสั่งซื้อ (รอยืนยัน)\nเกม: ${gameName}\nUID: ${uidOnly}\nชื่อผู้เล่น: ${s.playerName || "-"}\nแพ็กเกจ: ${pkg}\nจำนวนที่จะได้รับ: ${amount}\nราคา: ${price.toFixed(2)} บาท\n\nกรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก`;
    return NextResponse.json({ reply, quickReplies: ["ยืนยัน", "ยกเลิก"] });
  }

  /* ---------- เติมเงิน: ยืนยัน ---------- */
  if (s.state === "confirm_order") {
    if (RE_CONFIRM.test(text)) {
      const uid = s.uid || "-";
      const player = (s.playerName?.trim() || (s.game === "gi" ? "-" : "")) as string;
      const pkg = s.selectedName || "-"; const price = s.selectedPrice ?? 0;
      sessions[key] = { state: "idle" };
      const reply = `รับคำยืนยันแล้วค่ะ ✅\nยอดชำระ: ${price.toFixed(2)} บาท\nแพ็กเกจ: ${pkg}\nUID: ${uid}\nชื่อผู้เล่น: ${player || "-"}\n\nกรุณาสแกน QR เพื่อชำระเงินได้เลยค่ะ`;
      return NextResponse.json({ reply, quickReplies: [], paymentRequest: { showQR: true } });
    }
    if (RE_CANCEL.test(text)) {
      sessions[key] = { state: "idle" };
      return NextResponse.json({ reply: "ยกเลิกคำสั่งซื้อแล้วค่ะ ถ้าต้องการเริ่มใหม่ เลือกเมนูด้านล่างได้เลย", quickReplies: ["เติม Genshin Impact","เติม Honkai: Star Rail","ดู Artifact Genshin","ดู Relic Star Rail"] });
    }
    return NextResponse.json({ reply: "กรุณากดยืนยันเพื่อดำเนินการต่อ หรือยกเลิก", quickReplies: ["ยืนยัน", "ยกเลิก"] });
  }

  /* ---------- ENKA: รับ UID + ดึงข้อมูล ---------- */
  if (s.state === "waiting_uid_enka_gi" || s.state === "waiting_uid_enka_hsr") {
    const uidOnly = toArabic(text).replace(/\D/g, ""); if (!uidOnly) return NextResponse.json({ reply: "กรุณาพิมพ์ UID เป็นตัวเลขเท่านั้นค่ะ" });
    const game: GameKey = s.state === "waiting_uid_enka_gi" ? "gi" : "hsr";
    s.enka = { ...(s.enka || { game }), game, uid: uidOnly };

    // เรียก /api/enka แบบ absolute จาก req.url (ทำงานได้ทั้ง dev/Vercel)
    let j: any | null = null;
    try {
      const internalApiUrl = new URL("/api/enka", req.url).toString();
      const r = await fetch(internalApiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ game, uid: uidOnly }), cache: "no-store" });
      if (r.ok) j = await r.json();
    } catch {}

    // fallback: ยิงไป enka API ตรง ถ้า route ภายในใช้ไม่ได้
    if (!j || !j.ok) {
      try {
        const enkaUrl = game === "gi" ? `https://enka.network/api/uid/${uidOnly}` : `https://enka.network/api/hsr/uid/${uidOnly}`;
        const r2 = await fetch(enkaUrl, { headers: { "User-Agent": "Chatbot/1.0" }, cache: "no-store" });
        if (r2.ok) {
          const raw = await r2.json();
          if (game === "gi") {
            const list = Array.isArray(raw?.avatarInfoList) ? raw.avatarInfoList : [];
            const characters = list.map((c: any) => ({
              id: c?.avatarId ?? c?.avatar?.id ?? 0,
              name: c?.name ?? c?.avatarName ?? "Character",
              level: c?.propMap?.["4001"]?.val ?? c?.level ?? c?.avatarLevel ?? 1,
            }));
            j = { ok: true, game: "gi", player: raw?.playerInfo?.nickname ?? raw?.owner?.nickname ?? "", uid: uidOnly, characters, details: {} };
          } else {
            const list = Array.isArray(raw?.playerDetailInfo?.avatarDetailList) ? raw.playerDetailInfo.avatarDetailList
              : Array.isArray(raw?.avatarDetailList) ? raw.avatarDetailList : [];
            const characters = list.map((c: any) => ({
              id: c?.avatarId ?? c?.avatar?.id ?? 0,
              name: c?.name ?? c?.avatarName ?? "Character",
              level: c?.level ?? 1,
            }));
            j = { ok: true, game: "hsr", player: raw?.playerDetailInfo?.nickname ?? raw?.owner?.nickname ?? "", uid: uidOnly, characters, details: {} };
          }
        }
      } catch {}
    }

    if (!j || !j.ok || !j.characters?.length) {
      s.state = "idle";
      return NextResponse.json({ reply: "ดึงข้อมูลจาก enka ไม่สำเร็จ ลองใหม่หรือตรวจสอบว่าโปรไฟล์เปิดสาธารณะนะคะ" });
    }

    s.enka.player = j.player;
    s.enka.characters = j.characters;
    s.enka.details = j.details || {};
    s.state = "waiting_pick_character";

    const names = (j.characters as Array<{ name: string }>).map((c) => c.name);
    return NextResponse.json({ reply: `พบตัวละครของ ${j.player} (UID: ${uidOnly})\nเลือกตัวที่อยากดูของได้เลย:`, quickReplies: names.slice(0, 12) });
  }

  /* ---------- ENKA: เลือกตัวละคร ---------- */
  if (s.state === "waiting_pick_character" && s.enka?.characters?.length) {
    const t = lower;
    const candidates = s.enka.characters!;
    const hit = candidates.find((c) => normalize(c.name) === t || normalize(c.name).includes(t));
    if (!hit) {
      return NextResponse.json({ reply: "ไม่พบชื่อตัวละครในลิสต์ที่ดึงมา ลองพิมพ์ชื่อให้ชัดอีกครั้ง หรือพิมพ์ ‘ยกเลิก’ เพื่อเริ่มใหม่ค่ะ", quickReplies: candidates.slice(0, 12).map((c) => c.name) });
    }
    s.enka.pickedId = hit.id;
    s.state = "idle";

    const detail = s.enka.details?.[String(hit.id)] as any;
    if (!detail) return NextResponse.json({ reply: `ไม่พบรายละเอียดของ ${hit.name} ค่ะ` });

    if (s.enka.game === "gi") {
      const arts = (detail.artifacts || []) as any[];
      const lines = arts.map((a) => `• ${a.piece}: ${a.set ? `${a.set} | ` : ""}${a.main}${a.subs?.length ? ` | ${a.subs.join(", ")}` : ""}`).join("\n");
      return NextResponse.json({ reply: `ของที่สวมใส่ของ ${hit.name} (เลเวล ${hit.level})\n${lines || "- ไม่มีอาร์ติแฟกต์ -"}\n\nจะให้วิเคราะห์สเตตด้วย Gemini มั้ย?`, artifacts: arts, quickReplies: ["วิเคราะห์สเตตด้วย Gemini", "ดูตัวอื่น"] });
    } else {
      const relics = (detail.relics || []) as any[];
      const lines = relics.map((a) => `• ${a.piece}: ${a.set ? `${a.set} | ` : ""}${a.main}${a.subs?.length ? ` | ${a.subs.join(", ")}` : ""}`).join("\n");
      return NextResponse.json({ reply: `เรลิกของ ${hit.name} (เลเวล ${hit.level})\n${lines || "- ไม่มีเรลิก -"}\n\nจะให้วิเคราะห์ต่อมั้ย?`, relics, quickReplies: ["วิเคราะห์สเตตด้วย Gemini", "ดูตัวอื่น"] });
    }
  }

  /* ---------- Fallback ---------- */
  if (s.state === "idle") {
    return NextResponse.json({ reply: safeFallback(), quickReplies: ["เติม Genshin Impact","เติม Honkai: Star Rail","ดู Artifact Genshin","ดู Relic Star Rail"] });
  }

  return NextResponse.json({ reply: "ขอโทษค่ะ ตอนนี้อยู่ในขั้นตอนก่อนหน้าอยู่ กรุณาตอบให้ตรงขั้นตอน หรือพิมพ์ ‘ยกเลิก/เปลี่ยนใจ’ เพื่อเริ่มใหม่ได้เลยนะคะ~" });
}
