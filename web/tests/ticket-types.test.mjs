import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client.ts';
import { safeReturnTo } from '../src/auth/returnTo.ts';
import { readEventDetails } from '../src/events/details.ts';
import { readTicket } from '../src/tickets/model.ts';
import { emptyTicketTypeDraft, readTicketTypes, ticketTypeDraft, ticketTypeError, ticketTypeNamePolicy, ticketTypePayload, ticketTypePrice, ticketTypeUnavailable } from '../src/ticket-types/model.ts';

const type = { id: 3, event_id: 42, name: 'Стандарт', description: null, price_tiyn: 0,
  quantity: 12, tickets_issued: 2, remaining: 10, sales_start: null, sales_end: null, order_limit: 1, hidden: false };
const event = { id: 42, organizer_id: 1, title: 'Событие', description: null, date: '2030-05-01T12:00:00Z',
  location: 'Зал', status: 'published', capacity: 100, tickets_issued: 2, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

test('typed event contracts keep exact integer prices and reject wrong event/counters/duplicates', () => {
  assert.deepEqual(readTicketTypes([type], 42), [type]);
  assert.deepEqual(readEventDetails({ ...event, ticket_types: [type] }, 42).ticket_types, [type]);
  assert.equal(readEventDetails(event, 42).ticket_types, undefined);
  for (const value of [[{ ...type, event_id: 43 }], [{ ...type, price_tiyn: 1.5 }], [{ ...type, tickets_issued: 13 }],
    [{ ...type, remaining: 8 }], [{ ...type, hidden: 'false' }], [{ ...type, sales_start: 'bad' }], [type, type]]) {
    assert.throws(() => readTicketTypes(value, 42), (error) => error.kind === 'response');
  }
});

test('availability distinguishes sold out, sales windows, hidden and paid types', () => {
  const now = Date.parse('2030-04-01T00:00:00Z');
  assert.equal(ticketTypeUnavailable(type, now), null);
  assert.match(ticketTypeUnavailable({ ...type, quantity: 2, remaining: 0 }, now), /нет/);
  assert.match(ticketTypeUnavailable({ ...type, sales_start: '2030-05-01T00:00:00Z' }, now), /ещё не/);
  assert.equal(ticketTypeUnavailable({ ...type, sales_end: '2030-04-01T00:00:00Z' }, now), 'Продажи закрыты');
  assert.match(ticketTypeUnavailable({ ...type, price_tiyn: 12500 }, now), /Платные/);
  assert.match(ticketTypeUnavailable({ ...type, hidden: true }, now), /скрыт/);
  assert.equal(ticketTypePrice(0), 'Бесплатно');
  assert.match(ticketTypePrice(123450).replace(/\s/g, ''), /^1234,50₸$/);
});

test('type editor does not round fractional prices, quantities or order limits', () => {
  const draft = { ...emptyTicketTypeDraft(), name: ' VIP ', description: ' balcony ', quantity: '5', price_tiyn: '12345' };
  assert.deepEqual(ticketTypePayload(draft), { name: 'VIP', description: 'balcony', quantity: 5, price_tiyn: 12345,
    sales_start: null, sales_end: null, order_limit: 1, hidden: false });
  for (const change of [{ name: ' ' }, { price_tiyn: '1.1' }, { price_tiyn: '-1' }, { quantity: '3.5' },
    { quantity: '' }, { order_limit: '0' }, { sales_start: 'invalid' }, { sales_start: '2030-05-01T12:00', sales_end: '2030-05-01T11:00' }]) {
    assert.throws(() => ticketTypePayload({ ...draft, ...change }), (error) => error.kind === 'validation');
  }
  assert.equal(ticketTypeDraft(type).name, 'Стандарт');
});

test('ticket keeps type identity and rejects a mismatched summary without changing the QR', () => {
  const ticket = { id: 21, event_id: 42, attendee_id: 2, qr_payload: 'exact opaque value', created_at: '2030-01-01T00:00:00Z',
    checked_in_at: null, status: 'active', event: { id: 42, title: event.title, date: event.date, location: 'Зал', status: 'published' },
    ticket_type_id: 3, ticket_type: { id: 3, name: type.name, price_tiyn: 0 } };
  const result = readTicket(ticket);
  assert.equal(result.ticket_type.name, type.name);
  assert.equal(result.qr_payload, ticket.qr_payload);
  assert.throws(() => readTicket({ ...ticket, ticket_type_id: 4 }), (error) => error.kind === 'response');
  assert.throws(() => readTicket({ ...ticket, ticket_type: undefined }), (error) => error.kind === 'response');
});

test('the editor counts name length in Unicode code points like the API', () => {
  const name = '🎟'.repeat(ticketTypeNamePolicy.maxLength);
  const draft = { ...emptyTicketTypeDraft(), name };
  assert.equal(ticketTypePayload(draft).name, name);
  assert.throws(() => ticketTypePayload({ ...draft, name: name + 'Ш' }), (error) => error.kind === 'validation');
});

test('editing price preserves a sales window with sub-minute precision', () => {
  const original = { ...type, sales_start: '2030-04-01T12:00:15Z', sales_end: '2030-04-01T12:00:45Z' };
  assert.deepEqual(ticketTypePayload({ ...ticketTypeDraft(original), price_tiyn: '10000' }, original), { price_tiyn: 10000 });
});

test('only the exact ticket-type management route is allowed after login', () => {
  assert.equal(safeReturnTo('/organizer/events/42/ticket-types'), '/organizer/events/42/ticket-types');
  for (const path of ['/organizer/events/0/ticket-types', '/organizer/events/01/ticket-types', '/organizer/events/42/orders',
    '/organizer/events/42/ticket-types?returnTo=//evil.test', '//organizer/events/42/ticket-types']) assert.equal(safeReturnTo(path), '/events');
  assert.match(ticketTypeError(new ApiError('server', { kind: 'http', status: 409, code: 'TICKET_TYPES_CAPACITY' })), /вместимость/);
});
