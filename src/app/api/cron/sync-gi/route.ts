// /src/app/api/cron/sync-gi/route.ts
import { NextResponse } from 'next/server';
import { syncGiAll } from '@/lib/gi-sync';
import { getPool } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIN_INTERVAL_MIN = Number(process.env.GI_SYNC_MIN_INTERVAL_MIN || 720); // ดีฟอลต์ 12 ชม.
const CRON_KEY = process.env.CRON_KEY;

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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!CRON_KEY || key !== CRON_KEY) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const okToRun = await canRun();
  if (!okToRun) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'interval_guard' });
  }

  try {
    const result = await syncGiAll();
    await markRun();
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
