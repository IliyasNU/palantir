import assert from 'node:assert/strict';
import test from 'node:test';
import { safeReturnTo, authLink } from '../src/auth/returnTo.ts';
import { ApiError } from '../src/api/client.ts';
import { ticketErrorMessage } from '../src/tickets/model.ts';

test('returnTo permits exactly the existing event/ticket route families', () => {
  for (const route of ['/events', '/events/', '/events/42', '/events/42/', '/tickets', '/tickets/', '/tickets/21', '/tickets/21/']) {
    assert.equal(safeReturnTo(route), route);
    let target = route;
    for (const form of ['/login', '/register', '/login']) {
      target = new URL(authLink(form, target), 'http://localhost:5173').searchParams.get('returnTo');
      assert.equal(target, route);
    }
  }
  for (const route of ['/organizer', '/admin', '/login', '/register', '/tickets/mine', '/events/0', '/tickets/-1', '/tickets/01',
    '/tickets/21/extra', '/tickets/../events', '/tickets/21?x=1', '/events/42#x', '//evil.example', 'https://evil.example',
    '/tickets/%32%31', '/events/42\n', ' /tickets/21', null, 42]) assert.equal(safeReturnTo(route), '/events');
});

test('ticket authorization failures have clear Russian messages', () => {
  assert.equal(ticketErrorMessage(new ApiError('Access denied', { kind: 'http', status: 403, code: 'FORBIDDEN' })),
    'У вас нет прав для этого действия с билетом.');
  assert.equal(ticketErrorMessage(new ApiError('Expired', { kind: 'http', status: 401 })),
    'Сессия завершена. Войдите снова, чтобы открыть билет или получить его.');
});
