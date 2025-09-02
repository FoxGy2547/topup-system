// src/app/api/cron/sync-gi/route.ts
import { NextResponse } from 'next/server';
import { syncGiAll } from '@/lib/gi-sync';
import { getPool } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIN_INTERVAL_MIN = Number(process.env.GI_SYNC_MIN_INTERVAL_MIN || 720); // 12 ชม.
const CRON_KEY = process.env.CRON_KEY || '';

async function canRun(): Promise<boolean> {
  const pool = getPool();
  const [rows]: any = await pool.query(
    "SELECT v FROM admin_kv WHERE k='gi_sync_last_run' LIMIT 1"
  );
  const iso = rows?.[0]?.v || '1970-01-01T00:00:00Z';
  const last = new Date(iso).getTime();
  const now = Date.now();
  const diffMin = (now - last) / 60000;
  return diffMin >= MIN_INTERVAL_MIN;
}

async function markRun() {
  const pool = getPool();
  await pool.query(
    "INSERT INTO admin_kv (k, v) VALUES ('gi_sync_last_run', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)",
    [new Date().toISOString()]
  );
}

async function tableCounts() {
  const pool = getPool();
  const [a]: any = await pool.query('SELECT COUNT(*) AS c FROM gi_base_stats');
  const [b]: any = await pool.query('SELECT COUNT(*) AS c FROM character_sets WHERE game="gi"');
  const [c]: any = await pool.query('SELECT COUNT(*) AS c FROM items_gi');
  return { gi_base_stats: a[0]?.c ?? 0, character_sets: b[0]?.c ?? 0, items_gi: c[0]?.c ?? 0 };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key') || '';
  const force = url.searchParams.get('force') === '1';

  // ✅ อนุญาตถ้าอย่างใดอย่างหนึ่งผ่าน:
  // 1) key ตรงกับ CRON_KEY   หรือ
  // 2) เป็น Scheduled Cron จริง (Vercel ใส่ header x-vercel-cron: 1 มาให้)
  const isVercelCron = req.headers.get('x-vercel-cron') === '1';
  const authorized = (CRON_KEY && key === CRON_KEY) || isVercelCron;

  if (!authorized) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized', hint: 'pass ?key=<CRON_KEY> or run via Vercel Cron (x-vercel-cron header)' },
      { status: 401 }
    );
  }

  if (!force) {
    const okToRun = await canRun();
    if (!okToRun) {
      const counts = await tableCounts();
      return NextResponse.json({ ok: true, skipped: true, reason: 'interval_guard', counts });
    }
  }

  try {
    const result = await syncGiAll();
    await markRun();
    const counts = await tableCounts();
    return NextResponse.json({ ok: true, ...result, counts });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
