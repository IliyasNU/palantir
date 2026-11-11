import { useEffect, useState } from 'react';
import type { TicketType } from './model';

export function useTicketTypeClock(types: readonly TicketType[] | undefined): number {
  const [time, setTime] = useState(Date.now);

  useEffect(() => {
    const boundaries = (types ?? []).flatMap(({ sales_start, sales_end }) => [sales_start, sales_end])
      .filter((value): value is string => value !== null)
      .map((value) => Date.parse(value));
    if (boundaries.length === 0) return;

    let timer: number | undefined;
    function refresh() {
      const now = Date.now();
      setTime((previous) => boundaries.some((boundary) => (boundary <= previous) !== (boundary <= now)) ? now : previous);
      // Wake on the next boundary. Recheck at least once per second in case the wall clock jumps.
      const delay = boundaries.reduce((wait, boundary) => boundary > now ? Math.min(wait, boundary - now) : wait, 1000);
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, delay);
    }
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [types]);

  return time;
}
