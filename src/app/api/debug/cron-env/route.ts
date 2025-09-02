// src/app/api/debug/cron-env/route.ts
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

export async function GET() {
  const hasKey = !!process.env.CRON_KEY;
  const len = (process.env.CRON_KEY || '').length;
  return NextResponse.json({ 
    hasKey, 
    len, 
    nodeEnv: process.env.NODE_ENV 
  });
}
