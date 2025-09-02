'use client';

import useSWR from 'swr';

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: 'no-store' });
  const j = await r.json();
  const bal = Number(j?.balance ?? j?.data?.balance ?? 0);
  return { balance: Number.isFinite(bal) ? bal : 0 };
};

/**
 * ดึงยอดเงินแบบอัตโนมัติ (polling) + รองรับ optimistic update
 * - ส่ง username ถ้า login แล้ว, ถ้ายังไม่ login ให้ส่ง null/undefined
 * - refreshInterval: 1500ms (ปรับได้)
 */
export function useBalance(username?: string | null) {
  const key = username ? `/api/balance?username=${encodeURIComponent(username)}` : null;

  const { data, error, isLoading, mutate } = useSWR(
    key,
    fetcher,
    {
      refreshInterval: 1500,
      dedupingInterval: 800,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    }
  );

  return {
    balance: data?.balance ?? 0,
    isLoading,
    isError: !!error,
    mutate,
  };
}
