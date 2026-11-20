import { ApiError } from '../api/client.ts';
import { current } from '../i18n/index.ts';

const amounts = ['gross_before_discount_tiyn', 'discounts_tiyn', 'gross_sales_tiyn', 'refunds_tiyn',
  'net_sales_tiyn', 'processing_fees_tiyn', 'estimated_payout_tiyn'] as const;
type Metrics = Record<typeof amounts[number] | 'sold' | 'checked_in', number>;
type SeriesEntry = Metrics & { id: number; name: string };
export interface Analytics extends Metrics {
  event_id: number;
  event_title: string;
  capacity: number;
  remaining: number;
  percent_sold: number;
  absent: number;
  percent_checked_in: number;
  daily: (Metrics & { date: string })[];
  ticket_types: SeriesEntry[];
  campaigns: (SeriesEntry & { redemptions: number })[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function metrics(value: unknown): value is Record<string, unknown> & Metrics {
  return record(value) && [...amounts, 'sold', 'checked_in'].every(key => count(value[key]));
}

function named(value: unknown): value is Record<string, unknown> & SeriesEntry {
  return metrics(value) && count(value.id) && value.id > 0 && typeof value.name === 'string';
}

function percent(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function readAnalytics(value: unknown, eventId: number): Analytics {
  if (!metrics(value) || value.event_id !== eventId || typeof value.event_title !== 'string'
    || !count(value.capacity) || !count(value.remaining) || !count(value.absent)
    || !percent(value.percent_sold) || !percent(value.percent_checked_in)
    || !Array.isArray(value.daily) || !value.daily.every(row => metrics(row) && typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    || !Array.isArray(value.ticket_types) || !value.ticket_types.every(named)
    || !Array.isArray(value.campaigns) || !value.campaigns.every(row => named(row) && count(row.redemptions))) {
    throw new ApiError((t) => t.analytics.malformed, { kind: 'response' });
  }
  return value as unknown as Analytics;
}

export function analyticsError(error: unknown) {
  const copy = current().analytics;
  if (error instanceof ApiError && error.code === 'INVALID_DATE_RANGE') return copy.invalidRange;
  if (error instanceof ApiError && error.status === 404) return copy.notFound;
  if (error instanceof ApiError && error.kind === 'response') return copy.malformed;
  return copy.failed;
}
