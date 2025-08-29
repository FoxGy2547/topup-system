// /src/app/page.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Tesseract from 'tesseract.js';

// OCR เกียร์ (ถ้าใช้ฟีเจอร์นี้อยู่)
import { ocrGear, GearItem, GiSlot, HsrSlot, GameKey } from '@/lib/gear-ocr';

/* ====================== Types ====================== */
type QuickReply = { label: string; value: string };
type ApiResponse = { reply?: string; quickReplies?: string[]; paymentRequest?: any };

type NluResp =
  | { intent: 'artifact_gi'; character?: string }
  | { intent: 'relic_hsr'; character?: string }
  | { intent: 'confirm' }
  | { intent: 'cancel' }
  | { intent: 'unknown' };

/* ====================== Utils (normalize) ====================== */

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const toArabic = (s: string) =>
  [...(s || '')]
    .map((c) => {
      const i = THAI_DIGITS.indexOf(c);
      return i >= 0 ? String(i) : c;
    })
    .join('');

// splitlines แบบรักษา newline + ทำความสะอาดเบื้องต้น
const splitlines = (s: string) =>
  toArabic(s)
    .replace(/\u200b/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/，/g, ',')
    .replace(/[•·●○・*]/g, '•')
    .split(/\r?\n/)
    .map((x) => x.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean);

/* ====================== Slots ====================== */

const GI_SLOTS = ['Flower', 'Plume', 'Sands', 'Goblet', 'Circlet'] as const;
const HSR_SLOTS = ['Head', 'Hands', 'Body', 'Feet', 'Planar Sphere', 'Link Rope'] as const;

/* ====================== API helpers ====================== */

async function callAPI(userMessage: string, username?: string): Promise<ApiResponse> {
  const res = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: userMessage, username }),
  });
  return res.json();
}

async function nlu(text: string): Promise<NluResp> {
  try {
    const r = await fetch('/api/nlu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return await r.json();
  } catch {
    return { intent: 'unknown' };
  }
}

/* ====================== OCR: Slip ====================== */

// --- helpers for slip amount extraction ---
const AMT_KEY_POS = [
  'ยอดชำระ',
  'ยอดสุทธิ',
  'ยอดรวม',
  'รวมทั้งสิ้น',
  'สุทธิ',
  'จำนวนเงิน',
  'จำนวน',
  'รวม',
  'total',
  'amount',
  'paid',
  'payment',
];
const CURRENCY_HINT = ['บาท', 'บาทถ้วน', 'thb', '฿'];

function cleanSlipText(s: string) {
  return toArabic(s || '')
    .replace(/\u200b/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/，/g, ',')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAmountCandidates(lines: string[]) {
  const NUM =
    /(?:฿|\bTHB\b)?\s*(\d{1,3}(?:[,\s]\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2}))\b/g;

  type Cand = { value: number; raw: string; line: string; score: number };
  const out: Cand[] = [];

  const hasAny = (hay: string, arr: string[]) => arr.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(hay));

  for (const line0 of lines) {
    const line = line0.toLowerCase();
    let m: RegExpExecArray | null;
    while ((m = NUM.exec(line0))) {
      const raw = m[1];
      const v = parseFloat(raw.replace(/[, ]/g, ''));
      if (!isFinite(v)) continue;

      let score = 0;
      if (hasAny(line, AMT_KEY_POS)) score += 6;
      if (hasAny(line, CURRENCY_HINT)) score += 4;
      if (/\bfee|ค่าธรรมเนียม|charge/i.test(line)) score -= 5;
      if (/\btime|เวลา|วันที่|reference|ref\.?|เลขที่|เบอร์|บัญชี/i.test(line)) score -= 4;

      if (/\.\d{2}\b/.test(raw)) score += 2;
      if (/[,\s]\d{3}/.test(raw)) score += 1;

      out.push({ value: v, raw, line: line0, score });
    }
  }

  out.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.value - a.value));
  return out;
}

async function ocrSlipAmount(file: File): Promise<number | null> {
  const {
    data: { text },
  } = await Tesseract.recognize(file, 'tha+eng', {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
    langPath: '/tesseract/lang',
  } as any);

  const clean = cleanSlipText(text);
  const lines = clean.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const cands = parseAmountCandidates(lines);

  if (cands.length > 0) {
    const best = cands.find((c) => c.value >= 5) || cands[0];
    return best.value;
  }

  const fallback =
    /(ยอดชำระ|ยอดรวม|รวมทั้งสิ้น|สุทธิ|จำนวนเงิน|total|amount)[^0-9]{0,12}(?:฿|\bTHB\b)?\s*(\d{1,3}(?:[,\s]\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2}))\b/i;
  const mm = clean.match(fallback);
  if (mm) return parseFloat(mm[2].replace(/[, ]/g, ''));

  return null;
}

function getExpectedAmountFromMessages(msgs: any[]): number | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'bot' || typeof m.text !== 'string') continue;
    const text = m.text.replace(/，/g, ',').replace(/：/g, ':');
    const mm = text.match(/ยอดชำระ\s*[:：]?\s*([\d,]+(?:\.\d{1,2})?)\s*บาท/i);
    if (mm) {
      const v = parseFloat(mm[1].replace(/,/g, ''));
      if (!isNaN(v)) return v;
    }
  }
  return null;
}

/* ====================== UI: Liquid/Glass ====================== */

const glassIndigo =
  'bg-indigo-500/25 hover:bg-indigo-500/35 text-white backdrop-blur-md ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_30px_rgba(49,46,129,.35)] transition active:scale-[.98],hover:scale-105 hover:shadow-[0_6px_16px_rgba(0,0,0,0.6)]';
const glassGreen =
  'bg-emerald-500/25 hover:bg-emerald-500/35 text-white backdrop-blur-md ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_30px_rgba(5,150,105,.35)],hover:scale-105 hover:shadow-[0_6px_16px_rgba(0,0,0,0.6)]';
const glassRed =
  'bg-rose-500/30 hover:bg-rose-500/40 text-white backdrop-blur-md ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_30px_rgba(225,29,72,.35)],hover:scale-105 hover:shadow-[0_6px_16px_rgba(0,0,0,0.6)]';
const glassGray =
  'bg-white/10 hover:bg-white/15 text-white backdrop-blur-md ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_30px_rgba(0,0,0,.25)],hover:scale-105 hover:shadow-[0_6px_16px_rgba(0,0,0,0.6)]';
const bubbleUser =
  'bg-indigo-400/18 text-white backdrop-blur-md ring-3 ring-white/10 rounded-2xl ' +
  'shadow-[inset_0_1px_0_rgba(255,255,255,.28),0_8px_22px_rgba(49,46,129,.28)] ' +
  'before:absolute before:-top-0.5 before:left-3 before:right-3 before:h-[2px] before:rounded-full before:bg-white/50 before:opacity-50 before:blur-[1px] ' +
  'relative';

function GlassPill({
  children,
  className = '',
  color = 'indigo',
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  className?: string;
  color?: 'indigo' | 'green' | 'red' | 'gray';
  onClick?: () => void;
  disabled?: boolean;
}) {
  const c =
    color === 'green' ? glassGreen : color === 'red' ? glassRed : color === 'gray' ? glassGray : glassIndigo;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-full font-medium ${c} ${disabled ? 'opacity-60 cursor-not-allowed' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

/** บับเบิลข้อความแบบ glass ของ Ruby (ไม่ลอย/ไม่ซ้ำ Ruby:) */
function BotText({ text }: { text: string }) {
  const tidy = (s: string) => s.replace(/^\s*Ruby\s*:\s*/i, '');
  const lines = (text || '').split(/\r?\n/).map(tidy);

  return (
    <div className="inline-block max-w-[44rem]">
      <div
        className={[
          'relative px-4 py-2 rounded-2xl  text-[0.98rem] leading-relaxed whitespace-pre-wrap break-words',
          'bg-white/8 backdrop-blur-md ring-3 ring-white/15',
          'shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_28px_rgba(0,0,0,.35)]',
          'before:absolute before:-top-0.5 before:left-3 before:right-3 before:h-[2px] before:rounded-full before:bg-white/60 before:opacity-70 before:blur-[1px]',
        ].join(' ')}
      >
        <div className="mb-1 flex items-baseline gap-1">
          <span className="text-pink-300 font-semibold">Ruby</span>
          <span className="text-gray-300">:</span>
          <span className="text-gray-100">{lines[0]}</span>
        </div>
        {lines.length > 1 && (
          <div className="space-y-1 text-gray-100">
            {lines.slice(1).map((ln, i) => (
              <div key={i}>{ln}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ====================== Menu extraction (แก้ปัญหาต้องกดซ้ำ) ====================== */

/** ตัดราคาที่ท้ายข้อความ เช่น " - 179.00 บาท" และ " - 1,100.00 บาท" */
function stripPriceSuffix(s: string) {
  return s.replace(/\s*-\s*[\d,]+(?:\.\d{2})?\s*(?:บาท|฿|THB)?\s*$/i, '').trim();
}

/** แยกเมนูแบบมีเลขนำหน้าให้ได้ mapping 1..N -> label ที่อ่านรู้เรื่อง */
function buildMenuMap(reply: string): Record<number, string> {
  const lines = reply.split(/\r?\n/);
  let cur: number | null = null;
  const acc: Record<number, string[]> = {};

  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(\d+)[.)]\s*(.*)$/);
    if (m) {
      cur = parseInt(m[1], 10);
      acc[cur] = [m[2].trim()];
      continue;
    }
    if (cur != null) {
      if (line) acc[cur].push(line);
    }
  }

  const out: Record<number, string> = {};
  for (const k of Object.keys(acc)) {
    const idx = parseInt(k, 10);
    const joined = acc[idx].join(' ').replace(/\s{2,}/g, ' ').trim();
    out[idx] = stripPriceSuffix(joined);
  }
  return out;
}

/* ====================== Page Component ====================== */

export default function Page() {
  /* ------------ auth ------------ */
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loggedInUser, setLoggedInUser] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  /* balance */
  const [balance, setBalance] = useState(0);

  const requestBalance = async () => {
    if (!loggedInUser) return;
    try {
      const r = await fetch(`/api/balance?username=${encodeURIComponent(loggedInUser)}`);
      const j = await r.json();
      if (j?.ok) setBalance(Number(j.balance) || 0);
    } catch {}
  };

  /* ------------ chat ------------ */
  const [isOpen, setIsOpen] = useState(true);
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  /* ------------ quick replies ------------ */
  const defaults: QuickReply[] = useMemo(
    () => [
      { label: 'เติม Genshin Impact', value: 'เติม Genshin Impact' },
      { label: 'เติม Honkai: Star Rail', value: 'เติม Honkai: Star Rail' },
      { label: 'ดู Artifact Genshin', value: 'ดู artifact genshin impact' },
      { label: 'ดู Relic Star Rail', value: 'ดู relic honkai star rail' },
    ],
    []
  );
  const [dynamicQR, setDynamicQR] = useState<string[]>([]);
  const [confirmMode, setConfirmMode] = useState(false);

  // จดจำเมนู 1..N ที่เพิ่งโชว์ เพื่อ map เลข -> ข้อความ
  const [pendingNumberRange, setPendingNumberRange] = useState<{ min: number; max: number; label: string } | null>(null);
  const [menuMap, setMenuMap] = useState<Record<number, string>>({});

  // จดจำ state รอ UID
  const [awaitingUID, setAwaitingUID] = useState(false);

  /* ------------ payment ------------ */
  const [showPaidButton, setShowPaidButton] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const fileSlipRef = useRef<HTMLInputElement | null>(null);
  const [paidSoFar, setPaidSoFar] = useState(0);

  /* ------------ artifact / relic ------------ */
  const [arMode, setArMode] = useState<GameKey | null>(null);
  const [readyCalc, setReadyCalc] = useState<GameKey | null>(null);
  const fileGearRef = useRef<HTMLInputElement | null>(null);

  const [gearGi, setGearGi] = useState<Partial<Record<GiSlot, GearItem>>>({});
  const [gearHsr, setGearHsr] = useState<Partial<Record<HsrSlot, GearItem>>>({});

  const expectedSlots = useMemo(
    () => (readyCalc === 'gi' ? (GI_SLOTS as readonly string[]) : readyCalc === 'hsr' ? (HSR_SLOTS as readonly string[]) : []),
    [readyCalc]
  );

  const haveSlots = useMemo(() => {
    if (readyCalc === 'gi') return GI_SLOTS.filter((s) => !!gearGi[s]);
    if (readyCalc === 'hsr') return HSR_SLOTS.filter((s) => !!gearHsr[s]);
    return [];
  }, [readyCalc, gearGi, gearHsr]);

  const missingSlots = useMemo(() => {
    if (readyCalc === 'gi') return GI_SLOTS.filter((s) => !gearGi[s]);
    if (readyCalc === 'hsr') return HSR_SLOTS.filter((s) => !gearHsr[s]);
    return [];
  }, [readyCalc, gearGi, gearHsr]);

  /* ------------ scroll ------------ */
  const handleScroll = () => {
    if (!chatRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
    setIsAutoScroll(scrollTop + clientHeight >= scrollHeight - 10);
  };
  useEffect(() => {
    if (isAutoScroll && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, isAutoScroll, haveSlots.length]);

  /* ------------ push helpers ------------ */
  const pushUser = (text: string) => setMessages((p) => [...p, { role: 'user', text }]);

  const pushBotMsg = (text: string, imageUrl?: string) =>
    setMessages((p) => [...p, { role: 'bot', text, imageUrl }]);

  const pushPreview = (text: string, url: string) =>
    setMessages((p) => [...p, { role: 'preview', text, imageUrl: url }]);

  const isUnknownReply = (t?: string) =>
    !!t && /ขอโทษค่ะ.*ไม่เข้าใจ|กรุณาระบุใหม่|i don't understand|unknown/i.test(t);

  const pushBot = (data: ApiResponse) => {
    if (!data.reply) return;
    const reply = data.reply || '';

    const hasPayText = /กรุณาสแกน QR เพื่อชำระเงินได้เลยค่ะ/.test(reply);
    const enforcedQR = data.paymentRequest || hasPayText ? '/pic/qr/qr.jpg' : undefined;

    setMessages((p) => [...p, { role: 'bot', text: reply, imageUrl: enforcedQR }]);
    setShowPaidButton(!!enforcedQR);
    if (enforcedQR) setPaidSoFar(0);

    // เมื่อ bot แนะนำ artifact/relic เสร็จ → เปิดโหมดคำนวณ
    if (/(Artifact|Relic)\s+ที่เหมาะกับ/i.test(reply)) {
      setReadyCalc(arMode || null);
      setGearGi({});
      setGearHsr({});
      setDynamicQR(['คำนวณสเตตจากรูป', 'ดูเซ็ตตัวอื่น']);
      setConfirmMode(false);
      setPendingNumberRange(null);
      setMenuMap({});
      setAwaitingUID(false);
      return;
    }

    // quick replies จาก backend
    if (Array.isArray(data.quickReplies)) {
      setDynamicQR(data.quickReplies);
      setConfirmMode(
        data.quickReplies.length === 2 && data.quickReplies.includes('ยืนยัน') && data.quickReplies.includes('ยกเลิก')
      );
    } else {
      setDynamicQR([]);
      setConfirmMode(false);
    }

    // === ตรวจจับเมนูตัวเลข ===
    let minSel = 1;
    let maxSel = 0;
    const rangeMatch = reply.match(/หมายเลข\s*(\d+)\s*-\s*(\d+)/i);
    if (rangeMatch) {
      minSel = parseInt(rangeMatch[1], 10);
      maxSel = parseInt(rangeMatch[2], 10);
    }
    const menu = buildMenuMap(reply);
    const keys = Object.keys(menu).map((k) => parseInt(k, 10)).filter((x) => !isNaN(x));
    if (keys.length) {
      if (!maxSel) {
        maxSel = Math.max(...keys);
        minSel = Math.min(...keys);
      }
      setMenuMap(menu);

      const label = /\bแพ็กเกจ|package/i.test(reply) ? 'แพ็กเกจ' : 'ตัวเลือก';
      setPendingNumberRange({ min: minSel, max: maxSel, label });

      if (!Array.isArray(data.quickReplies) || data.quickReplies.length === 0) {
        const buttons = [];
        for (let i = minSel; i <= maxSel && buttons.length < 10; i++) buttons.push(String(i));
        setDynamicQR(buttons);
      }
    } else {
      setPendingNumberRange(null);
      setMenuMap({});
    }

    // === ตรวจจับ state รอ UID ===
    if (/กรุณาพิมพ์\s*UID\b/i.test(reply)) {
      setAwaitingUID(true);
      // เมื่อขอ UID ไม่ควรมีเมนูตัวเลขค้างอยู่
      setPendingNumberRange(null);
      setMenuMap({});
      setDynamicQR([]);
      return;
    }

    // ถ้าไปสเตจสรุป/ยืนยัน/จ่ายเงินแล้ว ให้ถือว่าพ้น state รอ UID
    if (/สรุปรายการ|กรุณากดยืนยัน|ยอดชำระ|รับคำยืนยันแล้ว/i.test(reply)) {
      setAwaitingUID(false);
    }
  };

  /* ------------ robust send chains ------------ */
  const robustSendPackage = async (title: string, n: number | undefined, username?: string) => {
    // primary = ชื่อแพ็กเกจ
    let data = await callAPI(title, username);
    if (!isUnknownReply(data.reply)) return data;

    // fallback เลขล้วน
    if (typeof n === 'number') {
      data = await callAPI(String(n), username);
      if (!isUnknownReply(data.reply)) return data;

      // fallback คำกริยา
      data = await callAPI(`เลือกแพ็กเกจ ${n}`, username);
    }
    return data;
  };

  const robustSendUID = async (uid: string, username?: string) => {
    const tries = [uid, `UID: ${uid}`, `uid: ${uid}`, `UID ${uid}`, `uid ${uid}`];
    let data: ApiResponse = {};
    for (const t of tries) {
      data = await callAPI(t, username);
      if (!isUnknownReply(data.reply)) return data;
    }
    return data;
  };

  /* ------------ ย้าย flow ยืนยันมาอยู่ส่วนกลาง ------------ */
  const processConfirm = async () => {
    // 1) ขอให้บอทสรุปรายการก่อน (ให้บับเบิลขึ้น)
    const res = await callAPI('ยืนยัน', loggedInUser);
    pushBot(res);

    // 2) อ่านยอดชำระล่าสุด แล้วตัดเงินในกระเป๋าก่อน (พอแล้วจบ, ไม่พอค่อยโอนเพิ่ม)
    try {
      const expected = getExpectedAmountFromMessages([
        ...messages,
        { role: 'bot', text: res.reply || '' },
      ]) ?? 0;

      // โหลด balance ปัจจุบันจาก DB
      let have = 0;
      try {
        const r = await fetch(`/api/balance?username=${encodeURIComponent(loggedInUser)}`);
        const j = await r.json();
        have = j?.ok ? Number(j.balance || 0) : 0;
      } catch {}

      const use = Math.min(have, expected);
      const remain = Math.max(0, Number((expected - use).toFixed(2)));

      if (use > 0) {
        // ใช้ endpoint ที่ให้มา: /api/user/update-balance (amount บวก/ลบได้)
        const r = await fetch('/api/user/update-balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: loggedInUser, amount: -use }),
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) setBalance(Number(j.balance ?? have - use));
        pushBotMsg(`หักจากกระเป๋าแล้ว ${use.toFixed(2)} บาท`);
      }

      setPaidSoFar(use); // ให้ขั้นตอนสลิปรู้ว่าเราจ่ายไปแล้วเท่าไร

      if (remain === 0) {
        setShowPaidButton(false);
        pushBotMsg('ชำระเงินเสร็จสิ้น ✅ ขอบคุณที่ใช้บริการค่ะ');
        setTimeout(() => pushBotMsg('ขอบคุณที่ใช้บริการค่ะ 💖'), 1800);
      } else {
        setShowPaidButton(true);
        pushBotMsg(`ยอดคงเหลือที่ต้องโอนเพิ่ม: ${remain.toFixed(2)} บาท`);
      }
    } catch {
      setShowPaidButton(true);
    }
  };

  /* ------------ send ------------ */
  const handleSend = async () => {
    if (!input.trim()) return;
    const original = input.trim();
    pushUser(original);
    setInput('');
    setDynamicQR([]);
    if (!/^ยืนยัน$|^ยกเลิก$/i.test(original)) setConfirmMode(false);
    setShowPaidButton(false);

    // ถ้ากำลังรอ UID อยู่ ให้พยายามกรอก UID แบบ robust (แก้เคส "ไม่เข้าใจ")
    if (awaitingUID && /^\d{6,12}$/.test(original)) {
      const data = await robustSendUID(original, loggedInUser);
      pushBot(data);
      return;
    }

    // ถ้า user พิมพ์เป็นเลข และเรามีเมนู -> map เป็นข้อความ option ให้ backend เข้าใจง่ายขึ้น
    if (/^\d{1,3}$/.test(original) && (pendingNumberRange || Object.keys(menuMap).length)) {
      const n = parseInt(original, 10);
      if (
        (!pendingNumberRange || (n >= pendingNumberRange.min && n <= pendingNumberRange.max)) &&
        menuMap[n]
      ) {
        const title = menuMap[n];
        const data = await robustSendPackage(title, n, loggedInUser);
        pushBot(data);
        return;
      }
    }

    // ปุ่ม "ดูเซ็ตตัวอื่น"
    if (/^ดูเซ็ตตัวอื่น$/i.test(original)) {
      if (!arMode) {
        pushBotMsg('ยังไม่ได้เลือกเกมนะคะ เลือก "ดู Artifact Genshin" หรือ "ดู Relic Star Rail" ก่อนน้า~');
        return;
      }
      setReadyCalc(null);
      setGearGi({});
      setGearHsr({});
      const open = await callAPI(arMode === 'gi' ? 'ดู artifact genshin impact' : 'ดู relic honkai star rail', loggedInUser);
      pushBot(open);
      return;
    }

    // อยู่ในโหมดรอตัวละคร → ส่งตรงให้ /api
    if (arMode && !readyCalc) {
      const data = await callAPI(original, loggedInUser);
      pushBot(data);
      return;
    }

    // ใช้ NLU (ยืนยัน/ยกเลิก/สลับโหมดเกม)
    const nluRes = await nlu(original);
    if (nluRes.intent === 'confirm') {
      await processConfirm();
      return;
    }
    if (nluRes.intent === 'cancel') {
      const data = await callAPI('ยกเลิก', loggedInUser);
      pushBot(data);
      return;
    }
    if (nluRes.intent === 'artifact_gi') {
      setArMode('gi');
      setReadyCalc(null);
      const open = await callAPI('ดู artifact genshin impact', loggedInUser);
      pushBot(open);
      if (nluRes.character) {
        const detail = await callAPI(nluRes.character, loggedInUser);
        pushBot(detail);
      }
      return;
    }
    if (nluRes.intent === 'relic_hsr') {
      setArMode('hsr');
      setReadyCalc(null);
      const open = await callAPI('ดู relic honkai star rail', loggedInUser);
      pushBot(open);
      if (nluRes.character) {
        const detail = await callAPI(nluRes.character, loggedInUser);
        pushBot(detail);
      }
      return;
    }

    // default
    const data = await callAPI(original, loggedInUser);
    pushBot(data);
  };

  const handleQuickReply = async (value: string) => {
    pushUser(value);
    setDynamicQR([]);
    if (!/^ยืนยัน$|^ยกเลิก$/i.test(value)) setConfirmMode(false);
    setShowPaidButton(false);

    // ✅ กรณีกดปุ่ม "ยืนยัน" ให้วิ่งเข้าฟังก์ชันเดียวกัน
    if (value.trim() === 'ยืนยัน') {
      await processConfirm();
      return;
    }
    if (value.trim() === 'ยกเลิก') {
      const data = await callAPI('ยกเลิก', loggedInUser);
      pushBot(data);
      return;
    }

    // ปุ่ม "ดูเซ็ตตัวอื่น"
    if (value.trim() === 'ดูเซ็ตตัวอื่น') {
      if (!arMode) {
        pushBotMsg('ยังไม่ได้เลือกเกมนะคะ เลือก "ดู Artifact Genshin" หรือ "ดู Relic Star Rail" ก่อนน้า~');
        return;
      }
      setReadyCalc(null);
      setGearGi({});
      setGearHsr({});
      const open = await callAPI(
        arMode === 'gi' ? 'ดู artifact genshin impact' : 'ดู relic honkai star rail',
        loggedInUser
      );
      pushBot(open);
      return;
    }

    // ถ้าปุ่มเป็นเลขและเรามี mapping -> ส่งชื่อแพ็กเกจ
    if (/^\d+$/.test(value) && (pendingNumberRange || Object.keys(menuMap).length)) {
      const n = parseInt(value, 10);
      if (
        (!pendingNumberRange || (n >= pendingNumberRange.min && n <= pendingNumberRange.max)) &&
        menuMap[n]
      ) {
        const title = menuMap[n];
        const data = await robustSendPackage(title, n, loggedInUser);
        pushBot(data);
        return;
      }
    }

    const data = await callAPI(value, loggedInUser);
    pushBot(data);

    if (/ดู artifact genshin impact/i.test(value)) {
      setArMode('gi');
      setReadyCalc(null);
    }
    if (/ดู relic honkai star rail/i.test(value)) {
      setArMode('hsr');
      setReadyCalc(null);
    }
  };

  /* ------------ Upload payment slip ------------ */
  const fileSlipOnClick = () => fileSlipRef.current?.click();

  const handleUploadSlip = async (file: File) => {
    const expectedFull = getExpectedAmountFromMessages(messages);
    if (expectedFull == null) {
      pushBotMsg('ไม่พบยอดชำระล่าสุดในแชท กรุณาลองใหม่ค่ะ');
      return;
    }

    const remaining = Math.max(0, Number((expectedFull - paidSoFar).toFixed(2)));
    if (remaining <= 0) {
      pushBotMsg('รายการนี้ชำระครบแล้วค่ะ ✅ หากต้องการเริ่มใหม่ เลือกเมนูด้านล่างได้เลย');
      setShowPaidButton(false);
      return;
    }

    try {
      setVerifying(true);
      const url = URL.createObjectURL(file);
      pushPreview('พรีวิวสลิปที่อัปโหลด', url);

      const actual = await ocrSlipAmount(file);
      if (actual == null || Number.isNaN(actual)) {
        pushBotMsg('อ่านยอดจากสลิปไม่สำเร็จค่ะ 🥲 กรุณาอัปโหลดใหม่');
        return;
      }

      const res = await fetch('/api/payment/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedAmount: remaining, actualAmount: actual }),
      });
      const result = await res.json();

      if (result.status === 'ok') {
        setPaidSoFar(0);
        setShowPaidButton(false);
        setDynamicQR([]);
        setConfirmMode(false);
        pushBotMsg('ชำระเงินเสร็จสิ้น ✅ ขอบคุณที่ใช้บริการค่ะ');
        setTimeout(() => pushBotMsg('ขอบคุณที่ใช้บริการค่ะ 💖'), 1800);
        requestBalance();
      } else if (result.status === 'under') {
        const received = Number(result.actual || 0);
        const diff = Number(result.diff).toFixed(2);
        setPaidSoFar((prev) => Number((prev + received).toFixed(2)));
        setMessages((p) => [
          ...p,
          {
            role: 'bot',
            text: `ยังขาดอีก ${diff} บาทค่ะ\nกรุณาโอนเพิ่มให้ครบยอด แล้วอัปโหลดสลิปอีกครั้ง`,
            imageUrl: '/pic/qr/qr.jpg',
          },
        ]);
        setShowPaidButton(true);
      } else if (result.status === 'over') {
        const diff = Number(result.diff || 0);
        // โอนเกิน → เก็บส่วนเกินเข้ากระเป๋า
        const r = await fetch('/api/user/update-balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: loggedInUser, amount: diff }),
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) setBalance(Number(j.balance ?? balance) || balance + diff);

        pushBotMsg(`โอนเกินยอด (เกิน : ${diff.toFixed(2)} บาท)\nเก็บไว้ในกระเป๋าเงินของคุณแล้วค่ะ`);
        setShowPaidButton(false);
        setDynamicQR([]);
        setConfirmMode(false);
        setPaidSoFar(0);
        setTimeout(() => pushBotMsg('ขอบคุณที่ใช้บริการค่ะ 💖'), 1800);
        requestBalance();
      } else {
        pushBotMsg('อ่านยอดจากสลิปไม่สำเร็จค่ะ 🥲');
      }
    } catch {
      pushBotMsg('เกิดข้อผิดพลาดระหว่างตรวจยอดจากสลิปค่ะ');
    } finally {
      setVerifying(false);
    }
  };

  /* ------------ Upload Artifact/Relic ------------ */
  const handleUploadGear = async (file: File) => {
    if (!readyCalc) {
      pushBotMsg('ยังไม่ได้เลือกตัวละครเพื่อแนะนำก่อนนะคะ');
      return;
    }

    const url = URL.createObjectURL(file);
    pushPreview(`พรีวิวชิ้นจากภาพ (${readyCalc.toUpperCase()})`, url);

    try {
      const parsed = await ocrGear(file, readyCalc);
      const piece = parsed.piece as any;

      if (readyCalc === 'gi') {
        const slot = piece as GiSlot | undefined;
        if (slot && (GI_SLOTS as readonly string[]).includes(slot)) {
          const newItem: GearItem = {
            url,
            piece: slot,
            setName: parsed.setName || null,
            mainStat: parsed.mainStat || null,
            substats: parsed.substats || [],
          };
          const next = { ...gearGi, [slot]: newItem };
          setGearGi(next);

          const head = parsed.setName ? `เซ็ต: ${parsed.setName}` : 'เซ็ต: (อ่านไม่ชัด)';
          const pieceLine = piece ? `ชิ้น: ${piece}` : 'ชิ้น: (ยังเดาไม่ได้)';
          const main = parsed.mainStat ? `Main Stat: ${parsed.mainStat.name} ${parsed.mainStat.value}` : 'Main Stat: -';
          const subs =
            parsed.substats.length
              ? parsed.substats.map((s) => `• ${s.name} ${s.value}`).join('\n')
              : '• (ไม่พบ substats ชัดเจน)';
          pushBotMsg([head, pieceLine, main, subs].join('\n'));

          const need = GI_SLOTS.filter((s) => !next[s as GiSlot]);
          if (need.length) pushBotMsg(`รับชิ้นนี้แล้วนะคะ เหลืออีก ${need.length} ชิ้น: ${need.join(', ')}`);
          else {
            const ms = GI_SLOTS.map((s) => {
              const it = next[s as GiSlot];
              const mainS = it?.mainStat ? ` | Main: ${it.mainStat.name} ${it.mainStat.value}` : ' | Main: -';
              const setS = it?.setName ? it.setName : '(อ่านไม่ชัด)';
              return `• ${s}: ${setS}${mainS}`;
            }).join('\n');
            pushBotMsg(`สรุป Artifact ครบ 5 ชิ้นแล้วค่ะ ✨\n${ms}`);
          }
        }
      } else {
        const slot = piece as HsrSlot | undefined;
        if (slot && (HSR_SLOTS as readonly string[]).includes(slot)) {
          const newItem: GearItem = {
            url,
            piece: slot,
            setName: parsed.setName || null,
            mainStat: parsed.mainStat || null,
            substats: parsed.substats || [],
          };
          const next = { ...gearHsr, [slot]: newItem };
          setGearHsr(next);

          const head = parsed.setName ? `เซ็ต: ${parsed.setName}` : 'เซ็ต: (อ่านไม่ชัด)';
          const pieceLine = piece ? `ชิ้น: ${piece}` : 'ชิ้น: (ยังเดาไม่ได้)';
          const main = parsed.mainStat ? `Main Stat: ${parsed.mainStat.name} ${parsed.mainStat.value}` : 'Main Stat: -';
          const subs =
            parsed.substats.length
              ? parsed.substats.map((s) => `• ${s.name} ${s.value}`).join('\n')
              : '• (ไม่พบ substats ชัดเจน)';
          pushBotMsg([head, pieceLine, main, subs].join('\n'));

          const need = HSR_SLOTS.filter((s) => !next[s as HsrSlot]);
          if (need.length) pushBotMsg(`รับชิ้นนี้แล้วนะคะ เหลืออีก ${need.length} ชิ้น: ${need.join(', ')}`);
          else {
            const ms = HSR_SLOTS.map((s) => {
              const it = next[s as HsrSlot];
              const mainS = it?.mainStat ? ` | Main: ${it.mainStat.name} ${it.mainStat.value}` : ' | Main: -';
              const setS = it?.setName ? it.setName : '(อ่านไม่ชัด)';
              return `• ${s}: ${setS}${mainS}`;
            }).join('\n');
            pushBotMsg(`สรุป Relic ครบ 6 ชิ้นแล้วค่ะ ✨\n${ms}`);
          }
        }
      }
    } catch {
      pushBotMsg('อ่านจากภาพไม่สำเร็จค่ะ ลองอัปโหลดใหม่ (รูปชัด ๆ / ไม่เบลอ / ไม่มีเงา)');
    }
  };

  /* ------------ current quick replies ------------ */
  const currentQR: string[] = confirmMode
    ? ['ยืนยัน', 'ยกเลิก']
    : readyCalc
      ? ['คำนวณสเตตจากรูป', 'ดูเซ็ตตัวอื่น']
      : dynamicQR.length
        ? dynamicQR
        : defaults.map((q) => q.value);

  /* ------------ render ------------ */
  return (
    <div className="min-h-screen bg-[#0f1623] text-gray-100 flex flex-col md:flex-row p-4 gap-4">
      {/* Left: Login/Balance */}
      <div className="w-full md:w-1/4 bg-white/5 backdrop-blur-xl rounded-2xl shadow-2xl ring-1 ring-white/10 p-6">
        {isLoggedIn ? (
          <>
            <div className="text-center mb-3">
              <p className="text-lg">
                บัญชีที่เข้าสู่ระบบ: <span className="font-semibold">{loggedInUser}</span>
              </p>
              <p className="text-emerald-300 mt-2">
                ยอดคงเหลือในกระเป๋า: <span className="font-semibold">{balance.toFixed(2)}</span> บาท
              </p>
            </div>
            <div className="flex gap-3 justify-center">
              <GlassPill color="indigo" onClick={requestBalance}>รีเฟรชยอด</GlassPill>
              <GlassPill
                color="indigo"
                onClick={() => {
                  setIsLoggedIn(false);
                  setLoggedInUser('');
                  setBalance(0);
                  setMessages([{ role: 'bot', text: 'คุณได้ออกจากระบบแล้วค่ะ' }]);
                  setIsOpen(false);
                  setDynamicQR([]); setConfirmMode(false);
                  setShowPaidButton(false); setPaidSoFar(0);
                  setArMode(null); setReadyCalc(null);
                  setGearGi({}); setGearHsr({});
                  setPendingNumberRange(null); setMenuMap({});
                  setAwaitingUID(false);
                }}
              >
                logout
              </GlassPill>
            </div>
          </>
        ) : (
          <>
            <div className="text-center mb-6">
              <p className="text-lg">กรุณาเข้าสู่ระบบ</p>
            </div>
            <div className="mb-4">
              <label className="block text-sm mb-2 opacity-80">Username:</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-2 rounded-xl bg-white/10 text-gray-100 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                placeholder="ใส่ username..."
              />
            </div>
            <div className="mb-6">
              <label className="block text-sm mb-2 opacity-80">Password:</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-2 rounded-xl bg-white/10 text-gray-100 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                placeholder="ใส่ password..."
              />
            </div>
            <div className="flex justify-center">
              <GlassPill
                color="indigo"
                className="w-full justify-center"
                onClick={async () => {
                  // (เดโม) Login ตรง ๆ และโหลดยอดคงเหลือ
                  setIsLoggedIn(true);
                  setLoggedInUser(username || 'user');
                  setMessages([{ role: 'bot', text: 'คุณได้เข้าสู่ระบบแล้ว! ตอนนี้สามารถใช้แชทบอทได้ค่ะ' }]);
                  setIsOpen(true);
                  setTimeout(requestBalance, 200);
                }}
              >
                เข้าสู่ระบบ
              </GlassPill>
            </div>
          </>
        )}
      </div>

      {/* Chat */}
      <div className="w-full md:w-3/4 flex flex-col">
        <main className="p-1 mb-2">
          <p className="opacity-80">ยินดีต้อนรับสู่หน้าแชทบอท</p>
        </main>

        {isLoggedIn && isOpen && (
          <div className="bg-white/5 backdrop-blur-xl rounded-2xl shadow-2xl ring-1 ring-white/10 flex flex-col h-[80vh]">
            <div className="flex justify-between items-center p-4 border-b border-white/10 rounded-t-2xl">
              <span className="font-medium text-xl">แชทบอท</span>
              <button
                className="rounded-full px-2 py-1 hover:bg-white/10"
                onClick={() => setIsOpen(false)}
                aria-label="close chat"
              >
                ✕
              </button>
            </div>

            <div ref={chatRef} onScroll={handleScroll} className="p-4 overflow-y-auto flex-1 text-lg space-y-4">
              {messages.map((msg, idx) => (
                <div key={idx} className="space-y-2">
                  {msg.role === 'user' ? (
                    <div className="flex justify-end">
                      <div className={`p-2 rounded-2xl inline-block max-w-[85%] ${bubbleUser}`}>{msg.text}</div>
                    </div>
                  ) : msg.role === 'preview' ? (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] bg-white/6 backdrop-blur-md ring-1 ring-white/10 rounded-2xl p-2 shadow">
                        <p className="mb-2 text-sm text-gray-200/80">{msg.text || 'พรีวิว'}</p>
                        {msg.imageUrl && (
                          <Image
                            src={msg.imageUrl}
                            alt="Preview"
                            width={250}
                            height={339}
                            className="rounded-xl ring-1 ring-white/10 object-contain"
                          />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-start">
                      <div className="max-w-[85%]">
                        <BotText text={msg.text} />
                        {msg.imageUrl && (
                          <Image
                            src={msg.imageUrl}
                            alt="QR"
                            width={250}
                            height={339}
                            className="mt-2 rounded-2xl ring-1 ring-white/10 max-w-full h-auto"
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Grid preview of collected gear */}
              {readyCalc && haveSlots.length > 0 && (
                <div className="mt-2">
                  <p className="text-sm text-gray-300 mb-2">
                    {readyCalc === 'gi'
                      ? `ชิ้นที่มีแล้ว (${haveSlots.length}/5): ${haveSlots.join(', ')}`
                      : `ชิ้นที่มีแล้ว (${haveSlots.length}/6): ${haveSlots.join(', ')}`}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                    {expectedSlots.map((slotName) => {
                      const it =
                        readyCalc === 'gi'
                          ? gearGi[slotName as GiSlot]
                          : (gearHsr[slotName as HsrSlot] as GearItem | undefined);
                      return (
                        <div
                          key={slotName}
                          className="bg-white/6 backdrop-blur-md ring-1 ring-white/10 rounded-xl p-2 flex flex-col items-center justify-center"
                        >
                          <span className="text-xs text-gray-300 mb-1">{slotName}</span>
                          {it?.url ? (
                            <Image
                              src={it.url}
                              alt={slotName}
                              width={140}
                              height={180}
                              className="rounded-md object-contain ring-1 ring-white/10"
                            />
                          ) : (
                            <div className="w-[140px] h-[180px] rounded-md border border-dashed border-white/15 flex items-center justify-center text-xs text-gray-400">
                              ยังไม่อัปโหลด
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {missingSlots.length > 0 && (
                    <p className="text-sm text-gray-300 mt-2">
                      เหลืออีก {missingSlots.length} ชิ้น: {missingSlots.join(', ')}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Bottom buttons */}
            <div className="p-3 bg-transparent flex flex-wrap gap-3 rounded-b-2xl border-t border-white/10">
              {showPaidButton ? (
                <GlassPill
                  onClick={fileSlipOnClick}
                  disabled={verifying}
                  color="green"
                  className="shadow-emerald-900/40"
                >
                  {verifying ? 'กำลังตรวจสอบสลิป...' : 'อัปโหลดสลิป & ตรวจยอด'}
                </GlassPill>
              ) : (
                currentQR.map((value, index) => {
                  if (value === 'คำนวณสเตตจากรูป') {
                    const total = readyCalc === 'gi' ? 5 : 6;
                    const have = haveSlots.length;
                    return (
                      <GlassPill key={`calc-${index}`} color="indigo" onClick={() => fileGearRef.current?.click()}>
                        อัปโหลดชิ้นจากรูป ({have}/{total})
                      </GlassPill>
                    );
                  }
                  const isConfirm = confirmMode && value.trim() === 'ยืนยัน';
                  const isCancel = confirmMode && value.trim() === 'ยกเลิก';
                  const color = confirmMode ? (isConfirm ? 'green' : isCancel ? 'red' : 'gray') : 'indigo';
                  const label = /^\d+$/.test(value)
                    ? value
                    : dynamicQR.length
                      ? value
                      : defaults.find((d) => d.value === value)?.label || value;
                  return (
                    <GlassPill key={`qr-${index}-${value}`} color={color as any} onClick={() => handleQuickReply(value)}>
                      {label}
                    </GlassPill>
                  );
                })
              )}
            </div>

            {/* input */}
            <div className="p-2 flex items-center gap-2 bg-transparent rounded-b-2xl">
              <input
                type="text"
                placeholder={awaitingUID ? 'ใส่ UID ตัวเลขล้วน (เช่น 835235056)' : 'พิมพ์เลขเลือกแพ็กเกจได้เลย (เช่น 2) หรือพิมพ์ข้อความ'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="w-full rounded-full px-4 py-2 text-gray-100 bg-white/10 backdrop-blur-md ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              />
              <GlassPill color="indigo" onClick={handleSend}>
                →
              </GlassPill>
            </div>
          </div>
        )}

        {!isLoggedIn && (
          <p className="text-center text-rose-300/90 mt-4">กรุณาเข้าสู่ระบบก่อนใช้งานแชทบอทค่ะ</p>
        )}
        {!isOpen && isLoggedIn && (
          <div className="mx-auto mt-2">
            <GlassPill color="indigo" onClick={() => setIsOpen(true)}>
              💬 แชทกับเรา
            </GlassPill>
          </div>
        )}
      </div>

      {/* hidden inputs */}
      <input
        ref={fileSlipRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) await handleUploadSlip(file);
          if (fileSlipRef.current) fileSlipRef.current.value = '';
        }}
      />
      <input
        ref={fileGearRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) await handleUploadGear(file);
          if (fileGearRef.current) fileGearRef.current.value = '';
        }}
      />
    </div>
  );
}
