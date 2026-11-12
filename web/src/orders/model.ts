import { ApiError, getErrorMessage } from '../api/client.ts';

export const DEMO_NOTICE = 'Демонстрационная оплата, деньги не списываются';
export const statusLabels = { pending: 'Ожидает оплаты', paid: 'Оплачен (демо)', failed: 'Оплата отклонена', cancelled: 'Заказ отменён', expired: 'Резерв истёк' };
export interface Order {
  id: number; event_id: number; ticket_type_id: number; buyer_id: number;
  status: keyof typeof statusLabels; attendee_name: string; attendee_email: string;
  subtotal_tiyn: number; processing_fee_tiyn: number; total_tiyn: number;
  ticket_id: number | null; expires_at: string; simulation: true;
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
function invalid(): never { throw new ApiError('Сервер вернул некорректные данные демо-заказа.', { kind: 'response' }); }
export function readOrder(value: unknown): Order {
  if (!record(value) || !integer(value.id, 1) || !integer(value.event_id, 1) || !integer(value.ticket_type_id, 1)
    || !integer(value.buyer_id, 1) || typeof value.status !== 'string' || !Object.hasOwn(statusLabels, value.status)
    || typeof value.attendee_name !== 'string' || typeof value.attendee_email !== 'string'
    || !integer(value.subtotal_tiyn, 1) || !integer(value.total_tiyn, 1) || value.total_tiyn !== value.subtotal_tiyn
    || !integer(value.processing_fee_tiyn) || value.processing_fee_tiyn > value.total_tiyn
    || (value.ticket_id !== null && !integer(value.ticket_id, 1))
    || ((value.status === 'paid') !== (value.ticket_id !== null)) || value.simulation !== true
    || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) return invalid();
  return value as unknown as Order;
}
export function readOrders(value: unknown): Order[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(readOrder);
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
    const messages: Record<string, string> = {
      CLOSED_TICKET_EXISTS: 'У вас уже был билет на это событие. Повторная покупка после отмены пока недоступна.',
      ACTIVE_TICKET_EXISTS: 'У вас уже есть билет на это событие.',
      PENDING_ORDER_EXISTS: 'У вас есть незавершённый заказ. Откройте «Мои заказы».',
      ORDER_EXPIRED: 'Время резерва истекло. Место освобождено, билет не выдан.',
      PAID_SALES_NOT_ACTIVATED: 'Организатор ещё не активировал платные продажи.',
      PAID_SALES_SUSPENDED: 'Платные продажи приостановлены.', EVENT_SUSPENDED: 'Продажи события приостановлены.',
      EVENT_CANCELLED: 'Событие отменено.', EVENT_NOT_PUBLISHED: 'Событие ещё не опубликовано.',
      TICKET_TYPE_SALES_NOT_STARTED: 'Продажи ещё не начались.', TICKET_TYPE_SALES_ENDED: 'Продажи закрыты.',
      SOLD_OUT: 'Свободных мест нет.', TICKET_TYPE_SOLD_OUT: 'Билетов этого типа нет.',
      TICKET_TYPE_HIDDEN: 'Этот тип больше не продаётся.', ORDER_NOT_FOUND: 'Заказ не найден.',
      IDEMPOTENCY_CONFLICT: 'Этот запрос уже использован. Проверьте «Мои заказы».',
      ORGANIZER_PROFILE_NOT_FOUND: 'Сначала создайте профиль организатора.',
    };
    const message = error.code ? messages[error.code] : undefined;
    if (message) return message;
  }
  return getErrorMessage(error);
}
