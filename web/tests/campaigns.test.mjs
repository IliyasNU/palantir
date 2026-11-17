import test from 'node:test';
import assert from 'node:assert/strict';
import { readQuote } from '../src/campaigns/model.ts';
import { safeReturnTo } from '../src/auth/returnTo.ts';
import { readOrder } from '../src/orders/model.ts';

test('a free-after-discount quote and order must balance exactly in tiyn', () => {
  const q = {code: 'BF-ABCDEF123456', ticket_type_id: 2, subtotal_tiyn: 210, discount_tiyn: 210, total_tiyn: 0};
  assert.deepEqual(readQuote(q, 2), q);
  assert.throws(() => readQuote({...q, total_tiyn: 2}, 2));
  const o = {...q, promo_code: q.code, campaign_id: 1, id: 3, event_id: 4, buyer_id: 5, status: 'pending', attendee_name: 'Test',
    attendee_email: 'test@example.com', processing_fee_tiyn: 0, ticket_id: null, expires_at: '2030-02-01', simulation: true};
  assert.deepEqual(readOrder(o), o);
  assert.throws(() => readOrder({...o, processing_fee_tiyn: 1}));
  assert.throws(() => readOrder({...o, promo_code: null}));
});

test('authentication preserves only a local event/checkout campaign return path', () => {
  const t = 'pc_' + 'a'.repeat(32);
  for (const path of ['/events/7?campaign=' + t, '/events/7/checkout?type=2&campaign=' + t]) {
    assert.equal(safeReturnTo(path), path);
    assert.equal(safeReturnTo(path + '&next=https://outside.example'), '/events');
  }
});
