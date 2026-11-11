import { ApiError, getErrorMessage } from '../api/client.ts';
import ticketTypeNamePolicy from '../../../backend/app/assets/ticket-type-name.json' with { type: 'json' };

export { ticketTypeNamePolicy };

const SALES_NOT_STARTED = 'Продажи ещё не начались';
const SALES_CLOSED = 'Продажи закрыты';

export interface TicketTypeSummary {
  id: number;
  name: string;
  price_tiyn: number;
}

export interface TicketType extends TicketTypeSummary {
  event_id: number;
  description: string | null;
  quantity: number;
  tickets_issued: number;
  remaining: number;
  sales_start: string | null;
  sales_end: string | null;
  order_limit: number;
  hidden: boolean;
}

export interface TicketTypeDraft {
  name: string;
  description: string;
  price_tiyn: string;
  quantity: string;
  sales_start: string;
  sales_end: string;
  order_limit: string;
  hidden: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function optionalDate(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}
function malformed(): ApiError {
  return new ApiError('Сервер вернул некорректный тип билета. Попробуйте позже.', { kind: 'response' });
}

export function readTicketTypeSummary(payload: unknown): TicketTypeSummary {
  if (!record(payload) || !integer(payload.id, 1) || typeof payload.name !== 'string' || !payload.name.trim()
    || !integer(payload.price_tiyn, 0)) throw malformed();
  return { id: payload.id, name: payload.name, price_tiyn: payload.price_tiyn };
}

export function readTicketTypes(payload: unknown, eventId: number): TicketType[] {
  if (!Array.isArray(payload)) throw malformed();
  const seen = new Set<number>();
  return payload.map((item: unknown) => {
    const summary = readTicketTypeSummary(item);
    if (!record(item) || item.event_id !== eventId || seen.has(summary.id)
      || (item.description !== null && typeof item.description !== 'string')
      || !integer(item.quantity, 0) || !integer(item.tickets_issued, 0) || item.tickets_issued > item.quantity
      || !integer(item.remaining, 0) || item.remaining !== item.quantity - item.tickets_issued
      || !integer(item.order_limit, 1) || typeof item.hidden !== 'boolean'
      || !optionalDate(item.sales_start) || !optionalDate(item.sales_end)) throw malformed();
    seen.add(summary.id);
    return { ...summary, event_id: eventId, description: item.description,
      quantity: item.quantity, tickets_issued: item.tickets_issued, remaining: item.remaining,
      sales_start: item.sales_start, sales_end: item.sales_end, order_limit: item.order_limit, hidden: item.hidden };
  });
}

/** Money is received as integer tiyn; this is display-only, never a checkout calculation. */
export function ticketTypePrice(priceTiyn: number): string {
  if (priceTiyn === 0) return 'Бесплатно';
  return `${new Intl.NumberFormat('ru-KZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(priceTiyn / 100)} ₸`;
}

export function ticketTypeUnavailable(type: TicketType, now = Date.now()): string | null {
  if (type.hidden) return 'Тип скрыт';
  if (type.price_tiyn > 0) return 'Платные продажи пока недоступны';
  if (type.sales_start !== null && Date.parse(type.sales_start) > now) return SALES_NOT_STARTED;
  if (type.sales_end !== null && Date.parse(type.sales_end) <= now) return SALES_CLOSED;
  if (type.remaining === 0) return 'Билетов этого типа нет';
  return null;
}

export function emptyTicketTypeDraft(): TicketTypeDraft {
  return { name: '', description: '', price_tiyn: '0', quantity: '0', sales_start: '', sales_end: '', order_limit: '1', hidden: false };
}

function localDate(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ticketTypeDraft(type: TicketType): TicketTypeDraft {
  return { name: type.name, description: type.description ?? '', price_tiyn: String(type.price_tiyn), quantity: String(type.quantity),
    sales_start: localDate(type.sales_start), sales_end: localDate(type.sales_end), order_limit: String(type.order_limit), hidden: type.hidden };
}

/** Validate input without rounding fractional prices or quantities into accepted numbers. */
export function ticketTypePayload(draft: TicketTypeDraft, original?: TicketType) {
  const fail = (message: string): never => { throw new ApiError(message, { kind: 'validation' }); };
  const number = (value: string, minimum: number, label: string) => {
    if (!/^\d+$/.test(value) || !integer(Number(value), minimum)) return fail(`${label}: нужно целое число от ${minimum}.`);
    return Number(value);
  };
  const date = (value: string) => {
    if (!value) return null;
    if (!Number.isFinite(Date.parse(value))) return fail('Проверьте начало и конец продаж.');
    return new Date(value).toISOString();
  };
  const name = draft.name.trim();
  if (!name) fail('Укажите название типа билета.');
  if ([...name].length > ticketTypeNamePolicy.maxLength) fail(`Название типа должно быть не длиннее ${ticketTypeNamePolicy.maxLength} символов.`);
  const salesStart = original && draft.sales_start === localDate(original.sales_start) ? original.sales_start : date(draft.sales_start);
  const salesEnd = original && draft.sales_end === localDate(original.sales_end) ? original.sales_end : date(draft.sales_end);
  if (salesStart && salesEnd && Date.parse(salesEnd) <= Date.parse(salesStart)) fail('Конец продаж должен быть позже начала.');
  const payload = { name, description: draft.description.trim() || null,
    price_tiyn: number(draft.price_tiyn, 0, 'Цена в тиынах'), quantity: number(draft.quantity, 0, 'Количество'),
    sales_start: salesStart, sales_end: salesEnd, order_limit: number(draft.order_limit, 1, 'Лимит на заказ'), hidden: draft.hidden };
  if (!original) return payload;
  return Object.fromEntries((Object.keys(payload) as (keyof typeof payload)[])
    .filter((field) => payload[field] !== original[field])
    .map((field) => [field, payload[field]]));
}

export function ticketTypeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'TICKET_TYPES_CAPACITY': return 'Сумма количеств типов превышает вместимость события. Уменьшите количество одного из типов.';
      case 'TICKET_TYPE_BELOW_ISSUED': return 'Количество типа нельзя уменьшить ниже числа действующих билетов.';
      case 'TICKET_TYPE_NOT_FOUND': return 'Тип билета не найден для этого события.';
      case 'TICKET_TYPE_REQUIRED': return 'Выберите тип бесплатного билета.';
      case 'TICKET_TYPE_HIDDEN': return 'Этот тип билета скрыт. Обновите страницу события.';
      case 'TICKET_TYPE_SALES_NOT_STARTED': return SALES_NOT_STARTED;
      case 'TICKET_TYPE_SALES_ENDED': return SALES_CLOSED;
      case 'TICKET_TYPE_SOLD_OUT': return 'Билеты выбранного типа закончились. Выберите другой тип или обновите страницу.';
      case 'PAID_TICKETS_NOT_SUPPORTED': return 'Платные продажи пока недоступны. Выберите бесплатный тип.';
    }
  }
  return getErrorMessage(error);
}
