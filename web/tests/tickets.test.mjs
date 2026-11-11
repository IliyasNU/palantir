import assert from 'node:assert/strict';
import test from 'node:test';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { ApiError } from '../src/api/client.ts';
import { apiBaseUrl } from '../src/api/config.ts';
import { safeReturnTo, authLink } from '../src/auth/returnTo.ts';
import { readTicket, readTickets, ticketErrorMessage, ticketPdfName, ticketState } from '../src/tickets/model.ts';
import { ticketQrDataUrl } from '../src/tickets/qr.ts';

const ticket = {
  id: 21, event_id: 7, attendee_id: 3, qr_payload: 'server-owned-opaque-payload',
  created_at: '2030-01-01T00:00:00Z', checked_in_at: null,
  event: { id: 7, title: 'Test event', date: '2030-07-15T12:00:00Z', location: 'Hall', status: 'published' },
};

test('ticket contracts preserve the exact server payload and existing used/cancelled tickets', () => {
  // A server without ticket states sends no status: the ticket is active.
  assert.deepEqual(readTicket(ticket, 21, 7), { ...ticket, status: 'active' });
  const used = { ...ticket, status: 'active', checked_in_at: '2030-07-15T11:55:00Z', event: { ...ticket.event, status: 'cancelled' } };
  assert.deepEqual(readTickets([used]), [used]);
  assert.deepEqual(readTickets([]), []);
});

test('ticket status is read as sent, keeps id and QR payload, and contradictions are rejected', () => {
  for (const status of ['active', 'cancelled', 'refunded']) {
    const read = readTicket({ ...ticket, status }, 21, 7);
    assert.deepEqual([read.status, read.id, read.qr_payload], [status, ticket.id, ticket.qr_payload]);
  }
  for (const payload of [{ ...ticket, status: 'expired' }, { ...ticket, status: null }, { ...ticket, status: 1 },
    { ...ticket, status: 'cancelled', checked_in_at: '2030-07-15T11:55:00Z' },
    { ...ticket, status: 'refunded', checked_in_at: '2030-07-15T11:55:00Z' }]) {
    assert.throws(() => readTicket(payload), (error) => error.kind === 'response');
  }
});

test('only an active ticket of a live event shows its QR, prints, or can be cancelled by its holder', () => {
  const state = (changes = {}, event = {}) => {
    const { usable, printable, cancellable, label } = ticketState(readTicket({ ...ticket, ...changes, event: { ...ticket.event, ...event } }));
    return [usable, printable, cancellable, label];
  };
  assert.deepEqual(state(), [true, true, true, 'Билет готов к входу']);
  assert.deepEqual(state({ checked_in_at: '2030-07-15T11:55:00Z' }), [false, true, false, 'Билет уже использован']);
  assert.deepEqual(state({ status: 'cancelled' }), [false, false, false, 'Билет отменён']);
  assert.deepEqual(state({ status: 'refunded' }), [false, false, false, 'Билет возвращён']);
  // A cancelled event is a different thing from a cancelled ticket; the ticket itself can still be given up.
  assert.deepEqual(state({}, { status: 'cancelled' }), [false, false, true, 'Событие отменено']);
  assert.deepEqual(state({ status: 'cancelled' }, { status: 'cancelled' }), [false, false, false, 'Билет отменён']);
  assert.deepEqual(state({}, { status: 'draft' }), [false, true, true, 'Вход по билету сейчас недоступен']);
  assert.equal(ticketPdfName(21), 'biletflow-ticket-21.pdf');
  for (const [code, text] of [['TICKET_CANCELLED', 'отменён'], ['TICKET_REFUNDED', 'возвращён'], ['TICKET_CHECKED_IN', 'вход']]) {
    assert.ok(ticketErrorMessage(new ApiError('server text', { kind: 'http', status: 409, code })).includes(text));
  }
});

test('ticket readers reject an unexpected identity or malformed receipt instead of inventing a QR', () => {
  for (const payload of [null, [], { ...ticket, id: '21' }, { ...ticket, qr_payload: '' },
    { ...ticket, checked_in_at: 'invalid' }, { ...ticket, event: { ...ticket.event, id: 8 } }]) {
    assert.throws(() => readTicket(payload), (error) => error.kind === 'response');
  }
  assert.throws(() => readTicket(ticket, 22), (error) => error.kind === 'response');
  assert.throws(() => readTicket(ticket, undefined, 8), (error) => error.kind === 'response');
  assert.throws(() => readTickets({ items: [] }), (error) => error.kind === 'response');
});

test('an independent QR decoder reads the exact payload from the generated PNG', async () => {
  const payload = '  сервер:opaque/қонақ/🧾?value=1  ';
  const image = await ticketQrDataUrl(payload);
  assert.ok(image.startsWith('data:image/png;base64,'));
  const png = PNG.sync.read(Buffer.from(image.split(',')[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(decoded?.data, payload);
});

test('safe auth return now permits only the known ticket routes as well as events', () => {
  for (const path of ['/tickets', '/tickets/21', '/tickets/21/']) {
    assert.equal(safeReturnTo(path), path);
    assert.equal(new URL(authLink('/login', path), 'https://frontend.example').searchParams.get('returnTo'), path);
  }
  for (const path of ['/tickets/me', '/tickets/0', '/tickets/01', '/tickets/1?redirect=//evil.test', '/tickets/../admin', '//tickets/21']) {
    assert.equal(safeReturnTo(path), '/events');
  }
});

test('ticket failure codes have clear messages', () => {
  for (const [code, expected] of [['SOLD_OUT', /билетов больше нет/], ['EVENT_CANCELLED', /отменено/],
    ['EVENT_NOT_PUBLISHED', /не опубликовано/], ['TICKET_NOT_FOUND', /другому посетителю/]]) {
    assert.match(ticketErrorMessage(new ApiError('Backend message', { kind: 'http', status: 409, code })), expected);
  }
});

test('build and runtime share the same explicit API base validation', () => {
  assert.equal(apiBaseUrl('http://localhost:8001/'), 'http://localhost:8001');
  assert.equal(apiBaseUrl('https://api.example/v1/'), 'https://api.example/v1');
  assert.equal(apiBaseUrl('https://api.example/v1%3F%23/'), 'https://api.example/v1%3F%23');
  for (const value of [undefined, '', '/api', 'localhost:8000', 'ftp://api.example', 'https://u:p@api.example',
    'https://api.example?key=secret', 'https://api.example?', 'https://api.example#']) {
    assert.throws(() => apiBaseUrl(value));
  }
});
