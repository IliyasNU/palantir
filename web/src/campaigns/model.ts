import { ApiError } from '../api/client.ts';

export const isCampaignToken = (s: string | null): s is string => !!s && /^pc_[0-9a-f]{32}$/.test(s);
const money = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function invalid(): never { throw new ApiError('Сервер вернул некорректные данные кампании.', { kind: 'response' }); }

export interface Quote { code: string; ticket_type_id: number | null; subtotal_tiyn: number | null; discount_tiyn: number | null; total_tiyn: number | null }
export function readQuote(v: unknown, typeId: number | null): Quote {
  if (!record(v) || typeof v.code !== 'string' || !/^BF-[A-F0-9]{12}$/.test(v.code) || v.ticket_type_id !== typeId) return invalid();
  if (typeId === null ? [v.subtotal_tiyn, v.discount_tiyn, v.total_tiyn].some(x => x !== null)
      : !money(v.subtotal_tiyn) || !money(v.discount_tiyn) || !money(v.total_tiyn) || v.subtotal_tiyn - v.discount_tiyn !== v.total_tiyn) return invalid();
  return v as unknown as Quote;
}

export interface Campaign {
  id: number; name: string; code: string; link: string; enabled: boolean; max_uses: number;
  redemptions: number; orders: number; tickets_sold: number; gross_tiyn: number; discount_tiyn: number; net_sales_tiyn: number; organizer_net_tiyn: number;
}
export function readCampaigns(value: unknown, eventId: number): Campaign[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(v => {
    if (!record(v) || !money(v.id) || v.id === 0 || typeof v.name !== 'string' || typeof v.code !== 'string'
        || typeof v.enabled !== 'boolean' || typeof v.link !== 'string'
        || ['max_uses','redemptions','orders','tickets_sold','gross_tiyn','discount_tiyn','net_sales_tiyn','organizer_net_tiyn'].some(k => !money(v[k]))) return invalid();
    let url: URL;
    try { url = new URL(v.link); } catch { return invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/events/' + eventId || !isCampaignToken(url.searchParams.get('campaign'))) return invalid();
    return v as unknown as Campaign;
  });
}
