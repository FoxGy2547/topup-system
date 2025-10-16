// src/app/page.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { ocrWithFallback } from '@/lib/tess';
import giMap from '@/data/gi_characters.json';
import hsrMap from '@/data/hsr_characters.json';

/* ====================== Types ====================== */
type GameKey = 'gi' | 'hsr';
type QuickReply = { label: string; value: string };

type ApiResponse = {
  reply?: string;
  // replyHtml ถูกยุบ: backend ส่ง HTML ใน reply โดยตรงแล้ว
  quickReplies?: string[];
  paymentRequest?: any;
  sets?: {
    game: GameKey;
    lines: { short: string; full: string; pieces: number }[][];
  };
};

type NluResp =
  | { intent: 'artifact_gi'; character?: string }
  | { intent: 'relic_hsr'; character?: string }
  | { intent: 'confirm' }
  | { intent: 'cancel' }
  | { intent: 'unknown' };

type ChatMessage = {
  role: 'user' | 'bot' | 'preview';
  text: string;
  html?: string;        // ✅ เก็บ HTML (มาจาก reply ถ้าเป็น HTML)
  imageUrl?: string;
  sets?: ApiResponse['sets'];
};

/* ====================== Utils ====================== */
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const toArabic = (s: string) =>
  [...(s || '')]
    .map((c) => {
      const i = THAI_DIGITS.indexOf(c);
      return i >= 0 ? String(i) : c;
    })
    .join('');

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

// ตรวจว่าดูเหมือน HTML มั้ย (ใช้เฉพาะกับ payload จาก backend)
const looksLikeHtml = (s?: string) =>
  !!s && /<\s*(?:div|span|img|ul|li|b|i|strong|br|a)\b|<\/\s*[a-z]/i.test(s);

/* ---------- Map id -> display name (สำหรับปุ่ม quick reply ที่เป็น "#1234 (lv.xx)") ---------- */
function mapCharNameById(idNum: number): string | null {
  if (idNum >= 10_000_000) {
    return (giMap as Record<string, string>)[String(idNum)] ?? null; // GI ids: 100000xx
  }
  return (hsrMap as Record<string, string>)[String(idNum)] ?? null; // HSR ids: 1xxx
}
function prettifyCharHashLabel(base: string): string {
  // จับรูปแบบ "#1310 (lv.80)" หรือ "#1412" หรือ "#10000002 (lv.90)"
  const m = base.match(/^\s*#?\s*(\d{3,12})\b(.*)$/);
  if (!m) return base;
  const idNum = parseInt(m[1], 10);
  if (!isFinite(idNum)) return base;
  const suffix = m[2] || '';
  const name = mapCharNameById(idNum);
  return name ? `${name}${suffix}` : base;
}

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
const AMT_KEY_POS = [
  'ยอดชำระ','ยอดสุทธิ','ยอดรวม','รวมทั้งสิ้น','สุทธิ','จำนวนเงิน','จำนวน','รวม','total','amount','paid','payment',
];
const CURRENCY_HINT = ['บาท','บาทถ้วน','thb','฿'];

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
  const NUM = /(?:฿|\bTHB\b)?\s*(\d{1,3}(?:[,\s]\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2}))\b/g;
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
  const text = await ocrWithFallback(file, 'tha+eng');
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
function getExpectedAmountFromMessages(msgs: ChatMessage[]): number | null {
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

/* ====================== UI helpers ====================== */
const glassIndigo =
  'bg-indigo-500/25 hover:bg-indigo-500/35 text-white backdrop-blur-md ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_30px_rgba(49,46,129,.35)] transition active:scale-[.98],hover:scale-105 hover:shadow-[0_6px_16px_rgba(0,0,0,0.6)]';
const glassGreen =
  'bg-emerald-500/25 hover:bg-emerald-500/35 text-white backdrop-blur-md ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_30px_rgba(5,150,105,.35)],hover:scale-105 hover:shadow-[0_6px_16px_rgba(0,0,0,0.6)]';
const glassRed =
  'bg-rose-500/30 hover:bg-rose-500/40 text-white backdrop-blur-md ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,.35)],hover:scale-105 hover:shadow-[0_6px_16px_rgba(0,0,0,0.6)]';
const glassGray =
  'bg-white/10 hover:bg-white/15 text-white backdrop-blur-md ring-1 ring-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_30px_rgba(0,0,0,.25)],hover:scale-105 hover:shadow-[0_6px_16px_rgba(0,0,0,0.6)]';
const bubbleUser =
  'bg-indigo-400/18 text-white backdrop-blur-md ring-3 ring-white/10 rounded-2xl ' +
  'shadow-[inset_0_1px_0_rgba(255,255,255,.28),0_8px_22px_rgba(49,46,129,.28)] ' +
  'before:absolute before:-top-0.5 before:left-3 before:right-3 before:h-[2px] before:rounded-full before:bg-white/50 before:opacity-50 before:blur-[1px] ' +
  'relative';

function GlassPill({
  children, className = '', color = 'indigo', onClick, disabled = false,
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

/* ====================== Sets renderer ====================== */
function getSetIconPath(game: GameKey | null | undefined, shortId: string) {
  if (!shortId) return null;
  const folder = game === 'hsr' ? 'hsr' : 'gi';
  const fileName = shortId.trim();
  return `/pic/${folder}/${fileName}.png`;
}

function SetChip({
  game, short, full, pieces,
}: {
  game: GameKey | null | undefined;
  short: string;
  full: string;
  pieces: number;
}) {
  const icon = getSetIconPath(game, short);
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      {icon && (
        <Image
          src={icon}
          alt={full}
          width={28}
          height={28}
          className="rounded-md ring-1 ring-white/15 bg-white/10 object-contain flex-shrink-0"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
      )}
      <span className="text-gray-100">{full} {pieces} ชิ้น</span>
    </div>
  );
}

function AdviceFromBackend({ sets }: { sets: NonNullable<ApiResponse['sets']> }) {
  return (
    <div className="space-y-2">
      {sets.lines.map((line, idx) => (
        <div key={idx} className="flex items-center gap-4 flex-wrap">
          {line.map((it, j) => (
            <SetChip key={`${idx}-${j}-${it.short}`} game={sets.game} short={it.short} full={it.full} pieces={it.pieces} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ====================== Sanitize & BotText ====================== */
// ✅ ปล่อย <img src="/pic/..."> (local path) และ http(s) โดเมนเดียวกับแอป + โดเมน fandom ที่เคยใช้
const EXTRA_IMG_HOST_WHITELIST = new Set([
  'genshin-impact.fandom.com',
  'honkai-star-rail.fandom.com',
]);

function sanitizeBotHtml(src: string) {
  let s = src || '';

  // ตัด script/style ทั้งบล็อก
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\1\s*>/gi, '');

  // ลบ on* event ทั้งหมด
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');

  // ปลอดภัยกับ <a> — href เฉพาะ http(s) และ relative path, ใส่ rel, target
  s = s.replace(/<a([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs, inner) => {
    const href = /href\s*=\s*"(.*?)"/i.exec(attrs)?.[1] || '';
    if (!href) return inner;
    if (/^https?:\/\//i.test(href)) {
      try {
        const u = new URL(href);
        const sameHost = typeof window !== 'undefined' && u.hostname === window.location.hostname;
        if (sameHost || EXTRA_IMG_HOST_WHITELIST.has(u.hostname)) {
          return `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        }
      } catch {}
      return inner;
    }
    // allow relative
    if (href.startsWith('/')) {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    }
    return inner;
  });

  // แปลง <img> ให้เหลือเฉพาะ src,width,height,alt และตรวจโดเมน/พาธ
  s = s.replace(/<img([^>]*?)>/gi, (_m, attrs) => {
    const get = (name: string, def = '') => {
      const re = new RegExp(`${name}\\s*=\\s*"(.*?)"`, 'i');
      return re.exec(attrs)?.[1] ?? def;
    };
    const srcUrl = get('src');
    if (!srcUrl) return '';
    // ✅ อนุญาต path ภายในโปรเจกต์ เช่น /pic/...
    if (srcUrl.startsWith('/pic/')) {
      const alt = get('alt', '');
      const w = get('width', '30');
      const h = get('height', '30');
      return `<img src="${srcUrl}" alt="${alt}" width="${w}" height="${h}" style="vertical-align:middle;margin-right:6px" />`;
    }
    // อนุญาต http(s) โดเมนเดียวกัน และ fandom whitelist
    if (/^https?:\/\//i.test(srcUrl)) {
      try {
        const u = new URL(srcUrl);
        const sameHost = typeof window !== 'undefined' && u.hostname === window.location.hostname;
        if (sameHost || EXTRA_IMG_HOST_WHITELIST.has(u.hostname)) {
          const alt = get('alt', '');
          const w = get('width', '30');
          const h = get('height', '30');
          return `<img src="${srcUrl}" alt="${alt}" width="${w}" height="${h}" style="vertical-align:middle;margin-right:6px" />`;
        }
      } catch {}
    }
    return ''; // ไม่ผ่านเกณฑ์
  });

  return s;
}

// ให้เว้นวรรคหลัง ":" 1 ช่องในโหมดข้อความ (หลีกเลี่ยง URL)
function fixColonSpace(line: string) {
  if (/^https?:\/\//i.test(line.trim())) return line;
  return line.replace(/:\s*/g, ': ');
}

function BotText({ text, html, sets }: { text: string; html?: string; sets?: ApiResponse['sets'] }) {
  const tidyHead = (s: string) => s.replace(/^\s*Ruby\s*:\s*/i, '');
  const lines = (text || '').split(/\r?\n/);
  const body = lines.slice(1).join('\n');

  const hasHtmlPayload = !!html;
  const containsHtmlInBody = /<|&lt;/.test(body);

  // ✅ ถ้าเป็น HTML ไม่ต้องแสดงหัวข้อความ (ไม่งั้นจะซ้ำ)
  const headText = hasHtmlPayload || containsHtmlInBody ? '' : tidyHead(lines[0] || '');

  return (
    <div className="inline-block max-w-[44rem]">
      <div
        className={[
          'relative px-4 py-2 rounded-2xl text-[0.98rem] leading-relaxed whitespace-pre-wrap break-words',
          'bg-white/8 backdrop-blur-md ring-3 ring-white/15',
          'shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_10px_28px_rgba(0,0,0,0.35)]',
          'before:absolute before:-top-0.5 before:left-3 before:right-3 before:h-[2px] before:rounded-full before:bg-white/60 before:opacity-70 before:blur-[1px]',
        ].join(' ')}
      >
        <div className="mb-1 flex items-baseline gap-1">
          <span className="text-pink-300 font-semibold">Ruby</span>
          <span className="text-gray-300">:</span>
          {headText && <span className="text-gray-100">{headText}</span>}
        </div>

        {sets ? (
          <AdviceFromBackend sets={sets} />
        ) : hasHtmlPayload ? (
          <div className="space-y-1 text-gray-100" dangerouslySetInnerHTML={{ __html: sanitizeBotHtml(html!) }} />
        ) : containsHtmlInBody ? (
          <div className="space-y-1 text-gray-100" dangerouslySetInnerHTML={{ __html: sanitizeBotHtml(body) }} />
        ) : (
          lines.length > 1 && (
            <div className="space-y-1 text-gray-100">
              {lines.slice(1).map((ln, i) => (<div key={i}>{fixColonSpace(ln)}</div>))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/* ====================== Menu extraction ====================== */
function stripPriceSuffix(s: string) {
  return s.replace(/\s*-\s*[\d,]+(?:\.\d{2})?\s*(?:บาท|฿|THB)?\s*$/i, '').trim();
}
function buildMenuMap(reply: string): Record<number, string> {
  const textOnly = reply.replace(/<[^>]+>/g, ' '); // กันกรณี reply เป็น HTML
  const lines = textOnly.split(/\r?\n/);
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

/* ====================== Page ====================== */
export default function Page() {
  /* auth */
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loggedInUser, setLoggedInUser] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showRegister, setShowRegister] = useState(false);
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regTel, setRegTel] = useState('');
  const [regEmail, setRegEmail] = useState('');

  const handleRegister = async () => {
    if (!regUsername || !regPassword) {
      setMessages((p) => [...p, { role: 'bot', text: 'กรุณากรอก Username/Password ให้ครบค่ะ' } as ChatMessage]);
      return;
    }
    try {
      const r = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: regUsername.trim(),
          password: regPassword,
          tel: regTel || undefined,
          email: regEmail || undefined,
        }),
      });
      const j = await r.json();
      if (r.ok && j?.ok) {
        setMessages((p) => [...p, { role: 'bot', text: 'สมัครสมาชิกสำเร็จ! ลองเข้าสู่ระบบได้เลยค่ะ' } as ChatMessage]);
        setUsername(regUsername.trim());
        setPassword(regPassword);
        setShowRegister(false);
      } else {
        setMessages((p) => [...p, { role: 'bot', text: j?.message || 'สมัครไม่สำเร็จค่ะ' } as ChatMessage]);
      }
    } catch {
      setMessages((p) => [...p, { role: 'bot', text: 'เกิดข้อผิดพลาดระหว่างสมัครสมาชิกค่ะ' } as ChatMessage]);
    }
  };

  /* balance (polling) */
  const [balance, setBalance] = useState(0);
  const requestBalance = async () => {
    if (!loggedInUser) return;
    try {
      const r = await fetch(`/api/balance?username=${encodeURIComponent(loggedInUser)}`);
      const j = await r.json();
      if (j?.ok) setBalance(Number(j.balance) || 0);
    } catch {}
  };
  const VIS_POLL_MS = 20_000;
  const HIDDEN_POLL_MS = 120_000;
  const pollTimerRef = useRef<number | null>(null);
  const stopBalancePolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };
  const startBalancePolling = () => {
    stopBalancePolling();
    const ms = document.visibilityState === 'visible' ? VIS_POLL_MS : HIDDEN_POLL_MS;
    requestBalance();
    pollTimerRef.current = window.setInterval(requestBalance, ms);
  };
  useEffect(() => {
    if (isLoggedIn && loggedInUser) {
      startBalancePolling();
      const onFocus = () => requestBalance();
      const onVis = () => { startBalancePolling(); requestBalance(); };
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVis);
      return () => {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVis);
        stopBalancePolling();
      };
    } else {
      stopBalancePolling();
    }
  }, [isLoggedIn, loggedInUser]);

  /* chat */
  const [isOpen, setIsOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  /* quick replies */
  const defaults: QuickReply[] = useMemo(
    () => [
      { label: 'เติม Genshin Impact', value: 'เติม Genshin Impact' },
      { label: 'เติม Honkai: Star Rail', value: 'เติม Honkai: Star Rail' },
      { label: 'ดู Artifact Genshin (จาก UID)', value: 'ดู artifact genshin impact (จาก UID)' },
      { label: 'ดู Relic Star Rail (จาก UID)', value: 'ดู relic honkai star rail (จาก UID)' },
    ],
    []
  );
  const [dynamicQR, setDynamicQR] = useState<string[]>([]);
  const [confirmMode, setConfirmMode] = useState(false);

  // สำหรับเมนูหมายเลข
  const [pendingNumberRange, setPendingNumberRange] =
    useState<{ min: number; max: number; label: string } | null>(null);
  const [menuMap, setMenuMap] = useState<Record<number, string>>({});

  // รอ UID?
  const [awaitingUID, setAwaitingUID] = useState(false);

  /* payment slip */
  const [showPaidButton, setShowPaidButton] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const fileSlipRef = useRef<HTMLInputElement | null>(null);
  const [paidSoFar, setPaidSoFar] = useState(0);

  /* scroll */
  const handleScroll = () => {
    if (!chatRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatRef.current;
    setIsAutoScroll(scrollTop + clientHeight >= scrollHeight - 10);
  };
  useEffect(() => {
    if (isAutoScroll && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, isAutoScroll]);

  /* push helpers */
  const pushUser = (text: string) => setMessages((p) => [...p, { role: 'user', text } as ChatMessage]);
  const pushBotMsg = (text: string, imageUrl?: string) =>
    setMessages((p) => [...p, { role: 'bot', text, imageUrl } as ChatMessage]);
  const pushPreview = (text: string, url: string) =>
    setMessages((p) => [...p, { role: 'preview', text, imageUrl: url } as ChatMessage]);

  const isUnknownReply = (t?: string) =>
    !!t && /ขอโทษค่ะ.*ไม่เข้าใจ|กรุณาระบุใหม่|i don't understand|unknown/i.test(t);

  const pushBot = (data: ApiResponse) => {
    if (!data.reply) return;
    const reply = data.reply || '';

    // ✅ ถ้า reply เป็น HTML ให้ใส่ลง field html ด้วย
    const html = looksLikeHtml(reply) ? reply : undefined;

    const hasPayText = /กรุณาสแกน QR เพื่อชำระเงินได้เลยค่ะ/.test(reply);
    const enforcedQR = data.paymentRequest || hasPayText ? '/pic/qr/qr.jpg' : undefined;

    setMessages((p) => [
      ...p,
      { role: 'bot', text: reply, html, imageUrl: enforcedQR, sets: data.sets } as ChatMessage,
    ]);

    setShowPaidButton(!!enforcedQR);
    if (enforcedQR) setPaidSoFar(0);

    // quick replies จาก backend
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

    // ตรวจเมนูตัวเลข (ข้ามถ้า reply เป็น HTML)
    if (!html) {
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
          const buttons: string[] = [];
          for (let i = minSel; i <= maxSel && buttons.length < 10; i++) buttons.push(String(i));
          setDynamicQR(buttons);
        }
      } else {
        setPendingNumberRange(null);
        setMenuMap({});
      }

      // ตรวจ state รอ UID (เฉพาะข้อความธรรมดา)
      if (/กรุณาพิมพ์\s*UID\b/i.test(reply)) {
        setAwaitingUID(true);
        setPendingNumberRange(null);
        setMenuMap({});
        setDynamicQR([]);
        return;
      }
      if (/สรุปรายการ|กรุณากดยืนยัน|ยอดชำระ|รับคำยืนยันแล้ว/i.test(reply)) {
        setAwaitingUID(false);
      }
    } else {
      // เป็น HTML: ไม่ใช่ขั้นเมนู/UID
      setPendingNumberRange(null);
      setMenuMap({});
    }
  };

  /* robust send chains */
  const robustSendPackage = async (title: string, n: number | undefined, username?: string) => {
    let data = await callAPI(title, username);
    if (!isUnknownReply(data.reply)) return data;
    if (typeof n === 'number') {
      data = await callAPI(String(n), username);
      if (!isUnknownReply(data.reply)) return data;
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

  /* confirm flow */
  const processConfirm = async () => {
    const res = await callAPI('ยืนยัน', loggedInUser);
    pushBot(res);

    try {
      const expected = getExpectedAmountFromMessages([
        ...messages,
        { role: 'bot', text: res.reply || '' } as ChatMessage,
      ]) ?? 0;

      let have = 0;
      try {
        const r = await fetch(`/api/balance?username=${encodeURIComponent(loggedInUser)}`);
        const j = await r.json();
        have = j?.ok ? Number(j.balance || 0) : 0;
      } catch {}

      const use = Math.min(have, expected);
      const remain = Math.max(0, Number((expected - use).toFixed(2)));

      if (use > 0) {
        const r = await fetch('/api/user/update-balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: loggedInUser, amount: -use }),
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) setBalance(Number(j.balance ?? have - use));
        pushBotMsg(`หักจากกระเป๋าแล้ว ${use.toFixed(2)} บาท`);
      }

      setPaidSoFar(use);

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

  /* send */
  const handleSend = async () => {
    if (!input.trim()) return;
    const original = input.trim();
    setInput('');
    pushUser(original);
    setDynamicQR([]);
    if (!/^ยืนยัน$|^ยกเลิก$/i.test(original)) setConfirmMode(false);
    setShowPaidButton(false);

    if (awaitingUID && /^\d{6,12}$/.test(original)) {
      const data = await robustSendUID(original, loggedInUser);
      pushBot(data);
      return;
    }

    if (/^\d{1,3}$/.test(original) && (pendingNumberRange || Object.keys(menuMap).length)) {
      const n = parseInt(original, 10);
      if ((!pendingNumberRange || (n >= pendingNumberRange.min && n <= pendingNumberRange.max)) && menuMap[n]) {
        const title = menuMap[n];
        const data = await robustSendPackage(title, n, loggedInUser);
        pushBot(data);
        return;
      }
    }

    const nluRes = await nlu(original);
    if (nluRes.intent === 'confirm') { await processConfirm(); return; }
    if (nluRes.intent === 'cancel') { const data = await callAPI('ยกเลิก', loggedInUser); pushBot(data); return; }

    // เปิดเมนูดูเซ็ต (ไม่ทำ OCR/อัปโหลดแล้ว)
    if (nluRes.intent === 'artifact_gi') {
      const open = await callAPI('ดู artifact genshin impact', loggedInUser);
      pushBot(open);
      if (nluRes.character) { const detail = await callAPI(nluRes.character, loggedInUser); pushBot(detail); }
      return;
    }
    if (nluRes.intent === 'relic_hsr') {
      const open = await callAPI('ดู relic honkai star rail', loggedInUser);
      pushBot(open);
      if (nluRes.character) { const detail = await callAPI(nluRes.character, loggedInUser); pushBot(detail); }
      return;
    }

    const data = await callAPI(original, loggedInUser);
    pushBot(data);
  };

  const handleQuickReply = async (value: string) => {
    pushUser(value);
    setDynamicQR([]);
    if (!/^ยืนยัน$|^ยกเลิก$/i.test(value)) setConfirmMode(false);
    setShowPaidButton(false);

    if (value.trim() === 'ยืนยัน') { await processConfirm(); return; }
    if (value.trim() === 'ยกเลิก') { const data = await callAPI('ยกเลิก', loggedInUser); pushBot(data); return; }

    const data = await callAPI(value, loggedInUser);
    pushBot(data);
  };

  /* upload slip */
  const fileSlipOnClick = () => fileSlipRef.current?.click();
  const handleUploadSlip = async (file: File) => {
    const expectedFull = getExpectedAmountFromMessages(messages);
    if (expectedFull == null) { pushBotMsg('ไม่พบยอดชำระล่าสุดในแชท กรุณาลองใหม่ค่ะ'); return; }

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
      if (actual == null || Number.isNaN(actual)) { pushBotMsg('อ่านยอดจากสลิปไม่สำเร็จค่ะ 🥲 กรุณาอัปโหลดใหม่'); return; }

      const res = await fetch('/api/payment/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedAmount: remaining, actualAmount: actual }),
      });
      const result = await res.json();

      if (result.status === 'ok') {
        setPaidSoFar(0); setShowPaidButton(false); setDynamicQR([]); setConfirmMode(false);
        pushBotMsg('ชำระเงินเสร็จสิ้น ✅ ขอบคุณที่ใช้บริการค่ะ');
        setTimeout(() => pushBotMsg('ขอบคุณที่ใช้บริการค่ะ 💖'), 1800);
        requestBalance();
      } else if (result.status === 'under') {
        const received = Number(result.actual || 0);
        const diff = Number(result.diff).toFixed(2);
        setPaidSoFar((prev) => Number((prev + received).toFixed(2)));
        setMessages((p) => [
          ...p,
          { role: 'bot', text: `ยังขาดอีก ${diff} บาทค่ะ\nกรุณาโอนเพิ่มให้ครบยอด แล้วอัปโหลดสลิปอีกครั้ง`, imageUrl: '/pic/qr/qr.jpg' } as ChatMessage,
        ]);
        setShowPaidButton(true);
      } else if (result.status === 'over') {
        const diff = Number(result.diff || 0);
        const r = await fetch('/api/user/update-balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: loggedInUser, amount: diff }),
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) setBalance(Number(j.balance ?? balance) || balance + diff);

        pushBotMsg(`โอนเกินยอด (เกิน : ${diff.toFixed(2)} บาท)\nเก็บไว้ในกระเป๋าเงินของคุณแล้วค่ะ`);
        setShowPaidButton(false); setDynamicQR([]); setConfirmMode(false); setPaidSoFar(0);
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

  /* current quick replies */
  const currentQR: string[] = confirmMode
    ? ['ยืนยัน', 'ยกเลิก']
    : dynamicQR.length
      ? dynamicQR
      : defaults.map((q) => q.value);

  /* render */
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
              <GlassPill
                color="indigo"
                onClick={() => {
                  setIsLoggedIn(false);
                  setLoggedInUser('');
                  setBalance(0);
                  setMessages([{ role: 'bot', text: 'คุณได้ออกจากระบบแล้วค่ะ' } as ChatMessage]);
                  setIsOpen(false);
                  setDynamicQR([]); setConfirmMode(false);
                  setShowPaidButton(false); setPaidSoFar(0);
                  setPendingNumberRange(null); setMenuMap({});
                  setAwaitingUID(false);
                }}
              >
                ออกจากระบบ
              </GlassPill>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-center mb-4 gap-2">
              <button
                className={`px-3 py-1 rounded-full text-sm ${!showRegister ? 'bg-white/15 ring-1 ring-white/20' : 'hover:bg-white/10'}`}
                onClick={() => setShowRegister(false)}
              >
                เข้าสู่ระบบ
              </button>
              <button
                className={`px-3 py-1 rounded-full text-sm ${showRegister ? 'bg-white/15 ring-1 ring-white/20' : 'hover:bg-white/10'}`}
                onClick={() => setShowRegister(true)}
              >
                สมัครสมาชิก
              </button>
            </div>

            {!showRegister ? (
              <>
                <div className="text-center mb-6">
                  <p className="text-lg">กรุณาเข้าสู่ระบบ</p>
                </div>
                <div className="mb-4">
                  <label className="block text-sm mb-2 opacity-80">Username :</label>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full p-2 rounded-xl bg-white/10 text-gray-100 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                    placeholder="ใส่ username..."
                  />
                </div>
                <div className="mb-6">
                  <label className="block text-sm mb-2 opacity-80">Password :</label>
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
                      setIsLoggedIn(true);
                      setLoggedInUser(username || 'user');
                      setMessages([{ role: 'bot', text: 'คุณได้เข้าสู่ระบบแล้ว! ตอนนี้สามารถใช้แชทบอทได้ค่ะ' } as ChatMessage]);
                      setIsOpen(true);
                      setTimeout(requestBalance, 200);
                    }}
                  >
                    เข้าสู่ระบบ
                  </GlassPill>
                </div>
              </>
            ) : (
              <>
                <div className="text-center mb-6">
                  <p className="text-lg">สมัครสมาชิก</p>
                </div>
                <div className="mb-3">
                  <label className="block text-sm mb-2 opacity-80">Username :</label>
                  <input
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    className="w-full p-2 rounded-xl bg-white/10 text-gray-100 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                    placeholder="ตั้ง username..."
                  />
                </div>
                <div className="mb-3">
                  <label className="block text-sm mb-2 opacity-80">Password :</label>
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    className="w-full p-2 rounded-xl bg-white/10 text-gray-100 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                    placeholder="ตั้ง password..."
                  />
                </div>
                <div className="mb-3">
                  <label className="block text-sm mb-2 opacity-80">เบอร์โทร :</label>
                  <input
                    value={regTel}
                    onChange={(e) => setRegTel(e.target.value)}
                    className="w-full p-2 rounded-xl bg-white/10 text-gray-100 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                    placeholder="080xxxxxxx"
                  />
                </div>
                <div className="mb-6">
                  <label className="block text-sm mb-2 opacity-80">อีเมล :</label>
                  <input
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    className="w-full p-2 rounded-xl bg-white/10 text-gray-100 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                    placeholder="you@example.com"
                  />
                </div>
                <div className="flex gap-3">
                  <GlassPill color="green" className="flex-1 justify-center" onClick={handleRegister}>
                    สมัครสมาชิก
                  </GlassPill>
                  <GlassPill color="gray" className="flex-1 justify-center" onClick={() => setShowRegister(false)}>
                    กลับไปล็อกอิน
                  </GlassPill>
                </div>
              </>
            )}
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
              <button className="rounded-full px-2 py-1 hover:bg-white/10" onClick={() => setIsOpen(false)} aria-label="close chat">✕</button>
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
                        <BotText text={msg.text} html={msg.html} sets={msg.sets} />
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
            </div>

            {/* Bottom buttons */}
            <div className="p-3 bg-transparent flex flex-wrap gap-3 rounded-b-2xl border-t border-white/10">
              {showPaidButton ? (
                <GlassPill onClick={fileSlipOnClick} disabled={verifying} color="green" className="shadow-emerald-900/40">
                  {verifying ? 'กำลังตรวจสอบสลิป...' : 'อัปโหลดสลิป & ตรวจยอด'}
                </GlassPill>
              ) : (
                currentQR.map((value, index) => {
                  const isConfirm = confirmMode && value.trim() === 'ยืนยัน';
                  const isCancel = confirmMode && value.trim() === 'ยกเลิก';
                  const color = confirmMode ? (isConfirm ? 'green' : isCancel ? 'red' : 'gray') : 'indigo';

                  // base label เดิม
                  const base =
                    /^\d+$/.test(value)
                      ? value
                      : dynamicQR.length
                        ? value
                        : defaults.find((d) => d.value === value)?.label || value;

                  // ✅ แปลง "#id (lv.xx)" -> "ชื่อจริง (lv.xx)" ด้วยแผนที่ gi/hsr
                  const label = prettifyCharHashLabel(base);

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
                placeholder={awaitingUID ? 'ใส่ UID ตัวเลขล้วน (เช่น 800000000)' : 'พิมพ์ตรงนี้เลยจ้าา'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="w-full rounded-full px-4 py-2 text-gray-100 bg-white/10 backdrop-blur-md ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              />
              <GlassPill color="indigo" onClick={handleSend}>→</GlassPill>
            </div>
          </div>
        )}

        {!isLoggedIn && <p className="text-center text-rose-300/90 mt-4">กรุณาเข้าสู่ระบบก่อนใช้งานแชทบอทค่ะ</p>}
        {!isOpen && isLoggedIn && (
          <div className="mx-auto mt-2">
            <GlassPill color="indigo" onClick={() => setIsOpen(true)}>💬 แชทกับเรา</GlassPill>
          </div>
        )}
      </div>

      {/* hidden input: slip only */}
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
    </div>
  );
}
