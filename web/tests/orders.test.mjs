import test from 'node:test';
import assert from 'node:assert/strict';
import { readOrder, readOrders, readActivation, orderError } from '../src/orders/model.ts';
import { ApiError } from '../src/api/client.ts';
import { safeReturnTo } from '../src/auth/returnTo.ts';
import { ticketTypeUnavailable } from '../src/ticket-types/model.ts';
import { ticketErrorMessage } from '../src/tickets/model.ts';

const order = { id: 1, event_id: 2, ticket_type_id: 3, buyer_id: 4, status: 'pending', attendee_name: 'Test',
  attendee_email: 'test@example.com', subtotal_tiyn: 10050, processing_fee_tiyn: 302, total_tiyn: 10050,
  ticket_id: null, expires_at: '2030-01-01T10:00:00Z', simulation: true };
test('demo order preserves integer amounts and refuses invented tickets or a buyer surcharge', () => {
  assert.deepEqual(readOrder(order), order);
  assert.deepEqual(readOrders([order]), [order]);
  for (const changed of [{ total_tiyn: 10352 }, { subtotal_tiyn: 1.2 }, { simulation: false }, { ticket_id: 1 },
    { status: 'paid' }, { status: 'garbage' }, { processing_fee_tiyn: -1 }]) {
    assert.throws(() => readOrder({ ...order, ...changed }), ApiError);
  }
  assert.equal(readOrder({ ...order, status: 'paid', ticket_id: 5 }).ticket_id, 5);
});
test('activation requires the complete simulated checklist', () => {
  const state = { event_id: 1, activated: false, paid_sales_suspended: false, activation_fee_tiyn: 500000,
    simulation: true, steps: Object.fromEntries(['paid_type', 'identity', 'payout', 'terms', 'fee'].map((key) => [key, { done: false }])) };
  assert.equal(readActivation(state).event_id, 1);
  assert.throws(() => readActivation({ ...state, steps: {} }), ApiError);
});
test('P2 auth return permits only known checkout, order and activation paths', () => {
  for (const path of ['/orders', '/orders/12', '/events/42/checkout?type=3', '/organizer/events/42/activation']) assert.equal(safeReturnTo(path), path);
  for (const path of ['//evil.test', '/orders/1/pay', '/events/42/checkout?type=3&returnTo=https://evil.test', '/organizer/events/42/activation/fee']) assert.equal(safeReturnTo(path), '/events');
});
test('activated paid types still respect their sales window and inventory', () => {
  const kind = { hidden: false, price_tiyn: 123, remaining: 1, sales_start: null, sales_end: null };
  assert.equal(ticketTypeUnavailable(kind, 0, true), null);
  assert.match(ticketTypeUnavailable(kind, 0, false), /недоступны/);
  assert.match(ticketTypeUnavailable({ ...kind, sales_end: '2030-01-01' }, Date.parse('2030-01-02'), true), /закрыты/);
  assert.match(orderError(new ApiError('ignored', { kind: 'http', code: 'CLOSED_TICKET_EXISTS' })), /Повторная покупка/);
  assert.match(ticketErrorMessage(new ApiError('ignored', { kind: 'http', code: 'PENDING_ORDER_EXISTS' })), /Мои заказы/);
});
