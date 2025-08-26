'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Tesseract from 'tesseract.js';

/* ========================= Types ========================= */
type QuickReply = { label: string; value: string };
type ApiResponse = { reply?: string; quickReplies?: string[]; paymentRequest?: any };
type GameKey = 'gi' | 'hsr';

type GearItem = {
  url: string;
  piece?: string | null;
  setName?: string | null;
  mainStat?: { name: string; value: string } | null;
  substats?: Array<{ name: string; value: string }>;
};

type NluResp =
  | { intent: 'artifact_gi'; character?: string; normalized?: string }
  | { intent: 'relic_hsr'; character?: string; normalized?: string }
  | { intent: 'confirm' }
  | { intent: 'cancel' }
  | { intent: 'unknown' };

/* ========================= Utils ========================= */
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const toArabic = (s: string) =>
  [...(s || '')]
    .map((c) => {
      const i = THAI_DIGITS.indexOf(c);
      return i >= 0 ? String(i) : c;
    })
    .join('');
const norm = (s: string) =>
  toArabic(s)
    .replace(/\u200b/g, '')
    .replace(/[，、]/g, ',')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const splitLines = (s: string) =>
  norm(s)
    .split(/[\r\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/* ========================= Slots ========================= */
const GI_SLOTS = ['Flower', 'Plume', 'Sands', 'Goblet', 'Circlet'] as const;
const HSR_SLOTS = ['Head', 'Hands', 'Body', 'Feet', 'Planar Sphere', 'Link Rope'] as const;
type GiSlot = (typeof GI_SLOTS)[number];
type HsrSlot = (typeof HSR_SLOTS)[number];

/* ========================= Dictionaries (TH -> EN) ========================= */
const STAT_MAP: Record<string, string> = {
  // GI & HSR common
  'พลังชีวิต': 'HP',
  'พลังโจมตี': 'ATK',
  'พลังป้องกัน': 'DEF',
  'ความชำนาญธาตุ': 'Elemental Mastery',
  'การฟื้นฟูพลังงาน': 'Energy Recharge',
  'ฟื้นฟูพลังงาน': 'Energy Recharge',
  'อัตราคริติคอล': 'CRIT Rate',
  'อัตราคริ': 'CRIT Rate',
  'ความแรงคริติคอล': 'CRIT DMG',
  'ความแรงคริ': 'CRIT DMG',
  // HSR only
  'อัตราติดเอฟเฟกต์': 'Effect Hit Rate',
  'ต้านทานเอฟเฟกต์': 'Effect RES',
  'ความเร็ว': 'SPD',
  'ฟื้นพลังงาน': 'Energy Regeneration Rate',
  'ผลการทำลาย': 'Break Effect',
};

const PIECE_MAP_GI: Record<string, GiSlot> = {
  'flower of life': 'Flower',
  'plume of death': 'Plume',
  'sands of eon': 'Sands',
  'goblet of eonothem': 'Goblet',
  'circlet of logos': 'Circlet',
  'ดอกไม้': 'Flower',
  'ขนนก': 'Plume',
  'ทราย': 'Sands',
  'ถ้วย': 'Goblet',
  'มงกุฎ': 'Circlet',
};

const PIECE_MAP_HSR: Record<string, HsrSlot> = {
  head: 'Head',
  hands: 'Hands',
  body: 'Body',
  feet: 'Feet',
  'planar sphere': 'Planar Sphere',
  'link rope': 'Link Rope',
  'หัว': 'Head',
  'มือ': 'Hands',
  'ลำตัว': 'Body',
  'เท้า': 'Feet',
  'ทรงกลม': 'Planar Sphere',
  'เชือก': 'Link Rope',
};

function normalizeStatWords(line: string): string {
  let s = line;
  for (const [th, en] of Object.entries(STAT_MAP)) {
    if (s.includes(th)) s = s.replace(new RegExp(th, 'g'), en);
  }
  return s;
}
const normalizeLinesToEN = (lines: string[]) => lines.map((l) => normalizeStatWords(l));

/* ========================= API helpers ========================= */
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
    return (await r.json()) as NluResp;
  } catch {
    return { intent: 'unknown' };
  }
}

/* ========================= OCR: K+ slip ========================= */
async function ocrSlipAmount(file: File): Promise<number | null> {
  const {
    data: { text },
  } = await Tesseract.recognize(file, 'tha+eng', {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
    langPath: '/tesseract/lang',
  } as any);

  const clean = norm(text || '');
  let m = clean.match(/จำนวน\s*:?\s*([0-9][\d,]*[.,]\d{2})\s*บาท?/i);
  if (!m) m = clean.match(/([0-9][\d,]*[.,]\d{2})\s*บาท?/i);
  return m ? parseFloat(m[1].replace(/,/g, '').replace(/[^\d.]/g, '')) : null;
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

/* ========================= OCR: Artifact / Relic ========================= */
function uniqStats(subs: Array<{ name: string; value: string }>) {
  const out: typeof subs = [];
  const seen = new Set<string>();
  for (const s of subs) {
    const k = `${s.name.toLowerCase()}|${s.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, 8);
}

function detectPieceGI(linesEN: string[], raw: string): GiSlot | null {
  const joined = linesEN.join(' ').toLowerCase();
  for (const [k, v] of Object.entries(PIECE_MAP_GI)) {
    if (joined.includes(k.toLowerCase())) return v;
  }
  // fallback by constants
  if (/(^|\s)4780(\s|$)/.test(joined)) return 'Flower';
  if (/(^|\s)311(\s|$)/.test(joined)) return 'Plume';
  return null;
}
function detectPieceHSR(linesEN: string[]): HsrSlot | null {
  const joined = linesEN.join(' ').toLowerCase();
  for (const [k, v] of Object.entries(PIECE_MAP_HSR)) {
    if (joined.includes(k.toLowerCase())) return v;
  }
  return null;
}

function parseGI(text: string) {
  const raw = text || '';
  const lines = splitLines(raw);
  const linesEN = normalizeLinesToEN(lines);
  const piece = detectPieceGI(linesEN, raw);
  const joined = linesEN.join(' ');

  let main = joined.match(
    /(HP|ATK|DEF|Elemental Mastery|Energy Recharge|CRIT RATE|CRIT DMG)\s*[: ]\s*([0-9][\d,]*\.?\d*%?)/i
  );
  let mainStat: { name: string; value: string } | null = null;
  if (main) {
    mainStat = { name: main[1], value: (main[2] || '').replace(/,/g, '') };
  } else if (piece === 'Flower' && joined.match(/\b4780\b/)) {
    mainStat = { name: 'HP', value: '4780' };
  } else if (piece === 'Plume' && joined.match(/\b311\b/)) {
    mainStat = { name: 'ATK', value: '311' };
  }

  const substats: Array<{ name: string; value: string }> = [];
  const subRe =
    /(HP|ATK|DEF|Elemental Mastery|Energy Recharge|CRIT RATE|CRIT DMG)\s*\+?\s*([0-9][\d,]*\.?\d*%?)/gi;
  let mm: RegExpExecArray | null;
  while ((mm = subRe.exec(joined))) {
    const name = mm[1];
    const value = mm[2].replace(/,/g, '');
    if (!mainStat || name !== mainStat.name || value !== mainStat.value) substats.push({ name, value });
  }

  const setGuess =
    joined.match(
      /(Gladiator.?s Finale|Golden Troupe|Deepwood Memories|Emblem of Severed Fate|Marechaussee Hunter|Shimenawa|Noblesse Oblige)/i
    )?.[1] ?? null;

  const level = joined.match(/\+(\d{1,2})/)?.[1] || null;

  return {
    game: 'gi' as const,
    setName: setGuess,
    pieceName: piece ?? null,
    piece,
    mainStat,
    substats: uniqStats(substats),
    level,
    raw: norm(raw),
  };
}

function parseHSR(text: string) {
  const raw = text || '';
  const lines = splitLines(raw);
  const linesEN = normalizeLinesToEN(lines);
  const joined = linesEN.join(' ');

  const piece = detectPieceHSR(linesEN);

  const m = joined.match(
    /(Effect Hit Rate|CRIT Rate|CRIT DMG|ATK|HP|DEF|Break Effect|SPD|Effect RES|Energy Regeneration Rate)\s*[: ]\s*([0-9][\d,]*\.?\d*%?)/i
  );
  const mainStat = m ? { name: m[1], value: m[2].replace(/,/g, '') } : null;

  const substats: Array<{ name: string; value: string }> = [];
  const re =
    /(ATK|HP|DEF|CRIT Rate|CRIT DMG|Effect RES|Effect Hit Rate|Break Effect|SPD)\s*([+ ]\s*)?([0-9][\d,]*\.?\d*%?)/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(joined))) {
    const name = mm[1];
    const value = (mm[3] || '').replace(/,/g, '');
    if (!mainStat || name !== mainStat.name || value !== mainStat.value) substats.push({ name, value });
  }

  const setGuess =
    joined.match(
      /(Genius of Brilliant Stars|Musketeer of Wild Wheat|Hunter of Glacial Forest|Band of Sizzling Thunder)/i
    )?.[1] ?? null;

  const level = joined.match(/\+(\d{1,2})/)?.[1] || null;

  return {
    game: 'hsr' as const,
    setName: setGuess,
    pieceName: piece ?? null,
    piece,
    mainStat,
    substats: uniqStats(substats),
    level,
    raw: norm(raw),
  };
}

async function ocrGear(file: File, game: GameKey) {
  const {
    data: { text },
  } = await Tesseract.recognize(file, 'tha+eng', {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
    langPath: '/tesseract/lang',
  } as any);
  return game === 'gi' ? parseGI(text) : parseHSR(text);
}

/* ========================= UI helpers ========================= */
function BotText({ text }: { text: string }) {
  const ls = text.split(/\r?\n/);
  return (
    <div className="bg-gray-700 p-3 rounded-xl inline-block whitespace-pre-wrap break-words">
      <div className="flex items-baseline space-x-1 mb-1">
        <span className="text-pink-300">Ruby</span>
        <span className="text-gray-400">:</span>
        <span className="text-white">{ls[0]}</span>
      </div>
      <div className="mt-1">{ls.slice(1).map((line, i) => <div key={i} className="text-white">{line}</div>)}</div>
    </div>
  );
}

/* ========================= Page ========================= */
export default function Page() {
  /* ---------- auth ---------- */
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loggedInUser, setLoggedInUser] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  /* ---------- chat ---------- */
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  /* ---------- quick replies ---------- */
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

  /* ---------- payment ---------- */
  const [showPaidButton, setShowPaidButton] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const fileSlipRef = useRef<HTMLInputElement | null>(null);
  const [paidSoFar, setPaidSoFar] = useState(0);

  /* ---------- artifact / relic ---------- */
  const [arMode, setArMode] = useState<null | GameKey>(null);
  const [readyCalc, setReadyCalc] = useState<null | GameKey>(null);
  const fileGearRef = useRef<HTMLInputElement | null>(null);
  const [gearGi, setGearGi] = useState<Partial<Record<GiSlot, GearItem>>>({});
  const [gearHsr, setGearHsr] = useState<Partial<Record<HsrSlot, GearItem>>>({});

  const expectedSlots: readonly (GiSlot | HsrSlot)[] =
    readyCalc === 'gi' ? GI_SLOTS : readyCalc === 'hsr' ? HSR_SLOTS : [];

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

  /* ---------- scroll ---------- */
  const handleScroll = () => {
    if (!chatRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
    setIsAutoScroll(scrollTop + clientHeight >= scrollHeight - 10);
  };
  useEffect(() => {
    if (isAutoScroll && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, isAutoScroll, haveSlots.length]);

  /* ---------- push helpers ---------- */
  const pushUser = (text: string) => setMessages((p) => [...p, { role: 'user', text }]);
  const pushBotMsg = (text: string, imageUrl?: string) =>
    setMessages((p) => [...p, { role: 'bot', text, imageUrl }]);
  const pushPreview = (text: string, url: string) =>
    setMessages((p) => [...p, { role: 'preview', text, imageUrl: url }]);

  const pushBot = (data: ApiResponse) => {
    if (!data.reply) return;
    const hasPayText = /กรุณาสแกน QR เพื่อชำระเงินได้เลยค่ะ/.test(data.reply);
    const enforcedQR = data.paymentRequest || hasPayText ? '/pic/qr/qr.jpg' : undefined;

    setMessages((p) => [...p, { role: 'bot', text: data.reply, imageUrl: enforcedQR }]);
    setShowPaidButton(!!enforcedQR);
    if (enforcedQR) setPaidSoFar(0);

    // ถ้าเป็นสรุป artifact/relic -> เปิดโหมดคำนวณ
    if (/(Artifact|Relic)\s+ที่เหมาะกับ/i.test(data.reply)) {
      setReadyCalc(arMode || null);
      setGearGi({});
      setGearHsr({});
      setDynamicQR(['คำนวณสเตตจากรูป', 'ดูเซ็ตตัวอื่น']);
      setConfirmMode(false);
      return;
    }

    // อย่างอื่น ใช้ quickReplies จาก server
    if (Array.isArray(data.quickReplies)) {
      setDynamicQR(data.quickReplies);
      setConfirmMode(
        data.quickReplies.length === 2 &&
          data.quickReplies.includes('ยืนยัน') &&
          data.quickReplies.includes('ยกเลิก')
      );
    } else {
      setDynamicQR([]);
      setConfirmMode(false);
    }
  };

  /* ---------- send ---------- */
  const handleSend = async () => {
    if (!input.trim()) return;
    const msg = input.trim();
    pushUser(msg);
    setInput('');
    setDynamicQR([]);
    if (!/^ยืนยัน$|^ยกเลิก$/i.test(msg)) setConfirmMode(false);
    setShowPaidButton(false);

    // ดูเซ็ตตัวอื่น
    if (/^ดูเซ็ตตัวอื่น$/i.test(msg)) {
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

    // โหมดถามชื่อตัวละคร -> ส่งตรงไป /api
    if (arMode && !readyCalc) {
      try {
        const data = await callAPI(msg, loggedInUser);
        pushBot(data);
        return;
      } catch {
        pushBotMsg('Ruby: Error getting response');
        return;
      }
    }

    // ใช้ NLU
    const n = await nlu(msg);

    if (n.intent === 'confirm') {
      const data = await callAPI('ยืนยัน', loggedInUser);
      pushBot(data);
      return;
    }
    if (n.intent === 'cancel') {
      const data = await callAPI('ยกเลิก', loggedInUser);
      pushBot(data);
      return;
    }
    if (n.intent === 'artifact_gi') {
      setArMode('gi');
      setReadyCalc(null);
      const open = await callAPI('ดู artifact genshin impact', loggedInUser);
      pushBot(open);
      if (n.character) {
        const detail = await callAPI(n.character, loggedInUser);
        pushBot(detail);
      }
      return;
    }
    if (n.intent === 'relic_hsr') {
      setArMode('hsr');
      setReadyCalc(null);
      const open = await callAPI('ดู relic honkai star rail', loggedInUser);
      pushBot(open);
      if (n.character) {
        const detail = await callAPI(n.character, loggedInUser);
        pushBot(detail);
      }
      return;
    }

    // default
    try {
      const data = await callAPI(msg, loggedInUser);
      pushBot(data);
    } catch {
      pushBotMsg('Ruby: Error getting response');
    }
  };

  const handleQuickReply = async (value: string) => {
    pushUser(value);
    setDynamicQR([]);
    if (!/^ยืนยัน$|^ยกเลิก$/i.test(value)) setConfirmMode(false);
    setShowPaidButton(false);

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

    try {
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
    } catch {
      pushBotMsg('Ruby: Error getting response');
    }
  };

  /* ---------- Upload payment slip ---------- */
  const fileSlipOnClick = () => fileSlipRef.current?.click();

  const handleUploadSlip = async (file: File) => {
    const expectedFull = getExpectedAmountFromMessages(messages);
    if (expectedFull == null) {
      pushBotMsg('Ruby: ไม่พบยอดชำระล่าสุดในแชท กรุณาลองใหม่ค่ะ');
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
        pushBotMsg('Ruby: อ่านยอดจากสลิปไม่สำเร็จค่ะ 🥲 กรุณาอัปโหลดใหม่');
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
        pushBotMsg('ชำระเงินเสร็จสิ้น ✅ ขอบคุณที่ใช้บริการค่ะ');
        setShowPaidButton(false);
        setDynamicQR([]);
        setConfirmMode(false);
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
        const diff = Number(result.diff).toFixed(2);
        pushBotMsg(`โอนเกินยอด (เกิน : ${diff} บาท)\nกรุณาติดต่อแอดมินเพื่อรับเงินส่วนเกินคืนนะคะ`);
        setShowPaidButton(false);
        setDynamicQR([]);
        setConfirmMode(false);
        setPaidSoFar(0);
      } else {
        pushBotMsg('Ruby: อ่านยอดจากสลิปไม่สำเร็จค่ะ 🥲');
      }
    } catch {
      pushBotMsg('Ruby: เกิดข้อผิดพลาดระหว่างตรวจยอดจากสลิปค่ะ');
    } finally {
      setVerifying(false);
    }
  };

  /* ---------- Upload Artifact/Relic ---------- */
  const handleUploadGear = async (file: File) => {
    if (!readyCalc) {
      pushBotMsg('ยังไม่ได้เลือกตัวละครเพื่อแนะนำก่อนนะคะ');
      return;
    }

    const url = URL.createObjectURL(file);
    pushPreview(`พรีวิวชิ้นจากภาพ (${readyCalc.toUpperCase()})`, url);

    try {
      const parsed = await ocrGear(file, readyCalc);
      const piece = parsed.piece || undefined;

      if (readyCalc === 'gi') {
        const slot = piece as GiSlot | undefined;
        if (slot && (GI_SLOTS as readonly GiSlot[]).includes(slot)) {
          setGearGi((prev) => ({
            ...prev,
            [slot]: {
              url,
              piece,
              setName: parsed.setName || null,
              mainStat: parsed.mainStat || null,
              substats: parsed.substats || [],
            },
          }));
        }
      } else {
        const slot = piece as HsrSlot | undefined;
        if (slot && (HSR_SLOTS as readonly HsrSlot[]).includes(slot)) {
          setGearHsr((prev) => ({
            ...prev,
            [slot]: {
              url,
              piece,
              setName: parsed.setName || null,
              mainStat: parsed.mainStat || null,
              substats: parsed.substats || [],
            },
          }));
        }
      }

      const head = parsed.setName ? `เซ็ต: ${parsed.setName}` : 'เซ็ต: (อ่านไม่ชัด)';
      const pieceLine = piece ? `ชิ้น: ${piece}` : 'ชิ้น: (ยังเดาไม่ได้)';
      const main = parsed.mainStat ? `Main Stat: ${parsed.mainStat.name} ${parsed.mainStat.value}` : 'Main Stat: -';
      const subs = parsed.substats.length
        ? parsed.substats.map((s) => `• ${s.name} ${s.value}`).join('\n')
        : '• (ไม่พบ substats ชัดเจน)';
      pushBotMsg([head, pieceLine, main, subs].join('\n'));

      // ตรวจครบ/ขาด แบบแยกสาขาให้ TypeScript รู้ชนิดแน่ชัด
      setTimeout(() => {
        if (readyCalc === 'gi') {
          const all = GI_SLOTS as readonly GiSlot[];
          const has = all.filter((slot) => !!gearGi[slot] || slot === (piece as GiSlot));
          const miss = all.filter((slot) => !has.includes(slot));

          if (miss.length) {
            pushBotMsg(`รับชิ้นนี้แล้วนะคะ เหลืออีก ${miss.length} ชิ้น: ${miss.join(', ')}`);
          } else {
            const lines: string[] = [
              `สรุป Artifact ครบ ${all.length} ชิ้นแล้วค่ะ ✨`,
              ...all.map((slot) => {
                const it = (slot === piece ? { ...gearGi[slot], setName: parsed.setName, mainStat: parsed.mainStat } : gearGi[slot]) as GearItem | undefined;
                const setName = it?.setName ? it.setName : '(อ่านไม่ชัด)';
                const mainShow = it?.mainStat ? `${it.mainStat.name} ${it.mainStat.value}` : '-';
                return `• ${slot}: ${setName} | Main: ${mainShow}`;
              }),
            ];
            pushBotMsg(lines.join('\n'));
          }
        } else if (readyCalc === 'hsr') {
          const all = HSR_SLOTS as readonly HsrSlot[];
          const has = all.filter((slot) => !!gearHsr[slot] || slot === (piece as HsrSlot));
          const miss = all.filter((slot) => !has.includes(slot));

          if (miss.length) {
            pushBotMsg(`รับชิ้นนี้แล้วนะคะ เหลืออีก ${miss.length} ชิ้น: ${miss.join(', ')}`);
          } else {
            const lines: string[] = [
              `สรุป Relic ครบ ${all.length} ชิ้นแล้วค่ะ ✨`,
              ...all.map((slot) => {
                const it = (slot === piece ? { ...gearHsr[slot], setName: parsed.setName, mainStat: parsed.mainStat } : gearHsr[slot]) as GearItem | undefined;
                const setName = it?.setName ? it.setName : '(อ่านไม่ชัด)';
                const mainShow = it?.mainStat ? `${it.mainStat.name} ${it.mainStat.value}` : '-';
                return `• ${slot}: ${setName} | Main: ${mainShow}`;
              }),
            ];
            pushBotMsg(lines.join('\n'));
          }
        }
      }, 0);
    } catch {
      pushBotMsg('อ่านจากภาพไม่สำเร็จค่ะ ลองอัปโหลดใหม่ (รูปชัด ๆ / ไม่เบลอ / ไม่มีเงา)');
    }
  };

  /* ---------- current quick replies ---------- */
  const currentQR: string[] = confirmMode
    ? ['ยืนยัน', 'ยกเลิก']
    : readyCalc
    ? ['คำนวณสเตตจากรูป', 'ดูเซ็ตตัวอื่น']
    : dynamicQR.length
    ? dynamicQR
    : defaults.map((q) => q.value);

  /* ========================= render ========================= */
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col md:flex-row p-4">
      {/* Login panel */}
      <div className="w-full md:w-1/4 bg-gray-800 rounded-xl shadow-lg p-6 mb-4 md:mb-0 md:mr-4">
        {isLoggedIn ? (
          <>
            <div className="text-center mb-6">
              <p className="text-lg">บัญชีที่เข้าสู่ระบบ: {loggedInUser}</p>
            </div>
            <div className="flex justify-center">
              <button
                className="bg-gray-700 text-white px-4 py-2 rounded-xl hover:bg-gray-600 transition"
                onClick={() => {
                  setIsLoggedIn(false);
                  setLoggedInUser('');
                  setMessages([{ role: 'bot', text: 'Ruby: คุณได้ออกจากระบบแล้วค่ะ' }]);
                  setIsOpen(false);
                  setDynamicQR([]);
                  setConfirmMode(false);
                  setShowPaidButton(false);
                  setPaidSoFar(0);
                  setArMode(null);
                  setReadyCalc(null);
                  setGearGi({});
                  setGearHsr({});
                }}
              >
                logout
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-center mb-6">
              <p className="text-lg">กรุณาเข้าสู่ระบบ</p>
            </div>
            <div className="mb-4">
              <label className="block text-sm mb-2">Username:</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-2 rounded-xl bg-gray-700 text-gray-100 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="ใส่ username..."
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm mb-2">Password:</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-2 rounded-xl bg-gray-700 text-gray-100 border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="ใส่ password..."
              />
            </div>
            <div className="flex justify-center">
              <button
                className="bg-gray-700 text-white px-4 py-2 rounded-xl hover:bg-gray-600 transition"
                onClick={async () => {
                  const res = await fetch('/api', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                  });
                  const data = await res.json();
                  if (data.success) {
                    setIsLoggedIn(true);
                    setLoggedInUser(username);
                    setMessages([{ role: 'bot', text: 'คุณได้เข้าสู่ระบบแล้ว! ตอนนี้สามารถใช้แชทบอทได้ค่ะ' }]);
                    setIsOpen(true);
                  } else {
                    setMessages([{ role: 'bot', text: 'Ruby: ' + (data.message || 'เข้าสู่ระบบไม่สำเร็จ') }]);
                  }
                }}
              >
                login
              </button>
            </div>
          </>
        )}
      </div>

      {/* Chat panel */}
      <div className="w-full md:w-3/4 flex flex-col">
        <main className="p-6 mb-4">
          <p>ยินดีต้อนรับสู่หน้าแชทบอท</p>
        </main>

        {isLoggedIn && isOpen && (
          <div className="bg-gray-800 rounded-xl shadow-xl flex flex-col h-[80vh]">
            <div className="flex justify-between items-center p-4 border-b border-gray-700 rounded-t-xl">
              <span className="font-medium text-xl">แชทบอท</span>
              <button className="text-gray-400 hover:text-gray-200" onClick={() => setIsOpen(false)}>
                ✕
              </button>
            </div>

            <div ref={chatRef} onScroll={handleScroll} className="p-4 overflow-y-auto flex-1 text-lg text-gray-200 space-y-4">
              {messages.map((msg, idx) => (
                <div key={idx} className="space-y-2">
                  {msg.role === 'user' ? (
                    <div className="flex justify-end">
                      <div className="bg-blue-600 text-white p-2 rounded-xl inline-block max-w-[85%]">{msg.text}</div>
                    </div>
                  ) : msg.role === 'preview' ? (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] bg-gray-800/60 border border-gray-700 rounded-xl p-2">
                        <p className="mb-2 text-sm text-gray-300">{msg.text || 'พรีวิว'}</p>
                        {msg.imageUrl && (
                          <Image
                            src={msg.imageUrl}
                            alt="Preview"
                            width={250}
                            height={339}
                            className="rounded-lg border border-gray-600 object-contain"
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
                            className="mt-2 rounded-xl border border-gray-600 max-w-full h-auto"
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
                    {(readyCalc === 'gi'
                      ? (GI_SLOTS as readonly GiSlot[])
                      : (HSR_SLOTS as readonly HsrSlot[])
                    ).map((slot) => {
                      const it: GearItem | undefined =
                        readyCalc === 'gi' ? gearGi[slot as GiSlot] : gearHsr[slot as HsrSlot];

                      return (
                        <div
                          key={slot}
                          className="bg-gray-800/60 border border-gray-700 rounded-lg p-2 flex flex-col items-center justify-center"
                        >
                          <span className="text-xs text-gray-300 mb-1">{slot}</span>
                          {it?.url ? (
                            <Image
                              src={it.url}
                              alt={slot}
                              width={140}
                              height={180}
                              className="rounded-md object-contain border border-gray-700"
                            />
                          ) : (
                            <div className="w-[140px] h-[180px] rounded-md border border-dashed border-gray-700 flex items-center justify-center text-xs text-gray-500">
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

            {/* Bottom Actions */}
            <div className="p-3 bg-gray-800 flex flex-wrap gap-3 rounded-b-xl">
              {showPaidButton ? (
                <button
                  onClick={fileSlipOnClick}
                  disabled={verifying}
                  className={`px-4 py-2 rounded-full shadow-md text-sm font-medium transition-all duration-200 transform hover:scale-105 ${
                    verifying ? 'bg-green-900 text-gray-300' : 'bg-green-600 hover:bg-green-700 text-white'
                  }`}
                >
                  {verifying ? 'กำลังตรวจสอบสลิป...' : 'อัปโหลดสลิป & ตรวจยอด'}
                </button>
              ) : (
                currentQR.map((value, index) => {
                  if (value === 'คำนวณสเตตจากรูป') {
                    const total = readyCalc === 'gi' ? 5 : 6;
                    const have = haveSlots.length;
                    return (
                      <button
                        key={`calc-${index}`}
                        onClick={() => fileGearRef.current?.click()}
                        className="px-4 py-2 rounded-full shadow-md text-sm font-medium bg-gradient-to-r from-purple-600 to-pink-600 text-white transform hover:scale-105"
                      >
                        อัปโหลดชิ้นจากรูป ({have}/{total})
                      </button>
                    );
                  }
                  const isConfirm = confirmMode && value.trim() === 'ยืนยัน';
                  const isCancel = confirmMode && value.trim() === 'ยกเลิก';
                  const base =
                    'px-4 py-2 rounded-full shadow-md transition-all duration-200 transform hover:scale-105 text-sm font-medium';
                  const color = confirmMode
                    ? isConfirm
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : isCancel
                      ? 'bg-red-600 hover:bg-red-700 text-white'
                      : 'bg-gray-600 hover:bg-gray-700 text-white'
                    : 'bg-gradient-to-r from-blue-600 to-purple-600 text-white';
                  const label = dynamicQR.length
                    ? value
                    : defaults.find((d) => d.value === value)?.label || value;
                  return (
                    <button
                      key={`qr-${index}-${value}`}
                      onClick={() => handleQuickReply(value)}
                      className={`${base} ${color}`}
                    >
                      {label}
                    </button>
                  );
                })
              )}
            </div>

            {/* Input */}
            <div className="p-2 flex items-center bg-gray-700 rounded-b-xl">
              <input
                type="text"
                placeholder="พิมพ์สั้น ๆ ได้เลย เดี๋ยวนีโนะตีความให้เอง~"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="w-full rounded-xl p-2 text-black bg-gray-200 flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              />
              <button
                onClick={handleSend}
                className="bg-blue-600 text-white px-3 py-1 rounded-xl hover:bg-blue-700 ml-2 transition"
              >
                →
              </button>
            </div>
          </div>
        )}

        {!isLoggedIn && <p className="text-center text-red-400">กรุณาเข้าสู่ระบบก่อนใช้งานแชทบอทค่ะ</p>}
        {!isOpen && isLoggedIn && (
          <button
            className="bg-gray-800 text-gray-100 px-4 py-2 rounded-xl shadow-xl hover:bg-gray-700 mx-auto block transition"
            onClick={() => setIsOpen(true)}
          >
            💬 แชทกับเรา
          </button>
        )}
      </div>

      {/* Hidden inputs */}
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
