import { ApiError, getErrorMessage } from '../api/client.ts';
import { current } from '../i18n/index.ts';
import type { Messages } from '../i18n/index.ts';
import { formatNumber } from '../i18n/format.ts';
import type { TicketStatus } from '../tickets/model.ts';

export interface Order {
  id: number; event_id: number; ticket_type_id: number; buyer_id: number;
  status: keyof Messages['orders']['status']; attendee_name: string; attendee_email: string;
  subtotal_tiyn: number; processing_fee_tiyn: number; total_tiyn: number;
  ticket_id: number | null; expires_at: string; simulation: true;
  refunded_at?: string | null;
  discount_tiyn?: number; promo_code?: string | null; campaign_id?: number | null;
}
export interface FreeRegistration {
  id: number;
  attendee_name: string;
  attendee_email: string;
  status: TicketStatus;
  ticket_type_id: number;
  checked_in_at: string | null;
}
export interface ManagedOrders {
  orders: Order[];
  free_registrations: FreeRegistration[];
}
export interface Activation {
  event_id: number; activated: boolean; paid_sales_suspended: boolean; activation_fee_tiyn: number;
  steps: Record<'paid_type' | 'identity' | 'payout' | 'terms' | 'fee', { done: boolean }>;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}
function invalid(): never { throw new ApiError((m) => m.orders.malformed, { kind: 'response' }); }
function instant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
export function formatOrderAmount(tiyn: number): string {
  return `${formatNumber(tiyn / 100, { minimumFractionDigits: tiyn % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })} ₸`;
}
export function readOrder(value: unknown): Order {
  if (!record(value) || !integer(value.id, 1) || !integer(value.event_id, 1) || !integer(value.ticket_type_id, 1)
    || !integer(value.buyer_id, 1) || typeof value.status !== 'string' || !Object.hasOwn(current().orders.status, value.status)
    || typeof value.attendee_name !== 'string' || typeof value.attendee_email !== 'string'
    || !integer(value.subtotal_tiyn, 1) || !integer(value.total_tiyn) || !integer(value.discount_tiyn ?? 0)
    || value.total_tiyn !== value.subtotal_tiyn - Number(value.discount_tiyn ?? 0)
    || (value.campaign_id != null ? !integer(value.campaign_id, 1) || typeof value.promo_code !== 'string' || !/^BF-[A-F0-9]{12}$/.test(value.promo_code)
      : value.promo_code != null || Number(value.discount_tiyn ?? 0) !== 0)
    || !integer(value.processing_fee_tiyn) || value.processing_fee_tiyn > value.total_tiyn
    || (value.ticket_id !== null && !integer(value.ticket_id, 1))
    || ((value.status === 'paid' || value.status === 'refunded') !== (value.ticket_id !== null)) || value.simulation !== true
    || (value.status === 'refunded' ? !instant(value.refunded_at) : value.refunded_at != null)
    || !instant(value.expires_at)) return invalid();
  return value as unknown as Order;
}
export function readOrders(value: unknown): Order[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(readOrder);
}
export function readManagedOrders(value: unknown, eventId: number): ManagedOrders {
  if (!record(value) || !Array.isArray(value.free_registrations)) return invalid();
  const orders = readOrders(value.orders);
  if (orders.some((order) => order.event_id !== eventId)) return invalid();
  const free_registrations = value.free_registrations.map((item: unknown): FreeRegistration => {
    if (!record(item) || !integer(item.id, 1) || !integer(item.ticket_type_id, 1)
      || typeof item.attendee_name !== 'string' || typeof item.attendee_email !== 'string'
      || (item.status !== 'active' && item.status !== 'cancelled' && item.status !== 'refunded')
      || (item.checked_in_at !== null && !instant(item.checked_in_at))) return invalid();
    return {
      id: item.id, attendee_name: item.attendee_name, attendee_email: item.attendee_email,
      status: item.status, ticket_type_id: item.ticket_type_id, checked_in_at: item.checked_in_at,
    };
  });
  return { orders, free_registrations };
}
export function readBulkRefund(value: unknown): { refunded_count: number; refunds_tiyn: number } {
  if (!record(value) || !integer(value.refunded_count) || !integer(value.refunds_tiyn)) return invalid();
  return { refunded_count: value.refunded_count, refunds_tiyn: value.refunds_tiyn };
}
export function readActivation(value: unknown): Activation {
  if (!record(value) || !integer(value.event_id, 1) || typeof value.activated !== 'boolean'
    || typeof value.paid_sales_suspended !== 'boolean' || !integer(value.activation_fee_tiyn)
    || value.simulation !== true || !record(value.steps)) return invalid();
  for (const key of ['paid_type', 'identity', 'payout', 'terms', 'fee']) {
    if (!record(value.steps[key]) || typeof value.steps[key].done !== 'boolean') return invalid();
  }
  return value as unknown as Activation;
}
export function orderError(error: unknown): string {
  if (error instanceof ApiError) {
    const text = current().orders;
    if (error.code === 'TICKET_CHECKED_IN') return text.manage.checkedIn;
    if (error.code && Object.hasOwn(text.errors, error.code)) return text.errors[error.code as keyof typeof text.errors];
  }
  return getErrorMessage(error);
}
