import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type StaffSession } from '../src/api.ts';
import { createRenewer, renewalTime, tokenExpiry } from '../src/renewal.ts';

const jwt = (claims: unknown) => ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
const session: StaffSession = { token: 'access-1', userId: 42, refreshToken: 'refresh-1' };
const fresh: StaffSession = { token: 'access-2', userId: 42, refreshToken: 'refresh-2' };

test('token expiry is read from the exp claim and only when it is a usable number', () => {
  assert.equal(tokenExpiry(jwt({ sub: '42', type: 'access', exp: 1_800_000_000 })), 1_800_000_000_000);
  // Every payload length exercises a different base64 padding.
  for (const sub of ['4', '42', '420', '4200']) assert.equal(tokenExpiry(jwt({ sub, exp: 1_800_000_123 })), 1_800_000_123_000);
  for (const token of ['', 'opaque-token', 'a.b', 'a.!!!.c', jwt({ sub: '42' }), jwt({ exp: '1800000000' }), jwt({ exp: -5 }),
    jwt({ exp: null }), jwt([1_800_000_000]), jwt('text')]) {
    assert.equal(tokenExpiry(token), null, token);
  }
});

test('renewal is planned two minutes before the expiry, or halfway through a shorter token life', () => {
  const expiry = 1_800_000_000_000;
  assert.equal(renewalTime(expiry, expiry - 30 * 60_000), expiry - 120_000);
  assert.equal(renewalTime(expiry, expiry - 4 * 60_000), expiry - 120_000);
  assert.equal(renewalTime(expiry, expiry - 3 * 60_000), expiry - 90_000);
  assert.equal(renewalTime(expiry, expiry - 20_000), expiry - 10_000);
});

test('a token the phone clock sees as expired or about to expire plans no renewal, so no loop can start', () => {
  const expiry = 1_800_000_000_000;
  for (const receivedAt of [expiry - 9_999, expiry, expiry + 60_000, Number.NaN]) {
    assert.equal(renewalTime(expiry, receivedAt), null, String(receivedAt));
  }
  // Every planned renewal lies strictly after the moment the token was received.
  for (const life of [10_000, 15_000, 60_000, 240_000, 1_800_000]) {
    const due = renewalTime(expiry, expiry - life)!;
    assert.ok(due - (expiry - life) >= 5_000 && due < expiry, String(life));
  }
});

test('a renewal returns the new session of the same account', async () => {
  const calls: [string, number][] = [];
  const renew = createRenewer(async (refreshToken, userId) => { calls.push([refreshToken, userId]); return fresh; });
  assert.deepEqual(await renew(session), { session: fresh });
  assert.deepEqual(calls, [['refresh-1', 42]]);
});

test('parallel renewals of one session share a single request; the next renewal sends a new one', async () => {
  let calls = 0;
  let finish!: (value: StaffSession) => void;
  const renew = createRenewer(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const [first, second, third] = [renew(session), renew(session), renew({ ...session })];
  assert.equal(calls, 1);
  finish(fresh);
  assert.deepEqual(await Promise.all([first, second, third]), [{ session: fresh }, { session: fresh }, { session: fresh }]);
  const later = renew(fresh);
  assert.equal(calls, 2);
  finish({ ...fresh, token: 'access-3' });
  assert.deepEqual(await later, { session: { ...fresh, token: 'access-3' } });
});

test('another account never shares or receives a running renewal', async () => {
  const seen: number[] = [];
  const renew = createRenewer(async (_refreshToken, userId) => { seen.push(userId); return { ...fresh, userId }; });
  const other: StaffSession = { token: 'other', userId: 7, refreshToken: 'refresh-1' };
  assert.deepEqual(await Promise.all([renew(session), renew(other)]), [
    { session: fresh }, { session: { ...fresh, userId: 7 } },
  ]);
  assert.deepEqual(seen, [42, 7]);
  // A server answer for a different account is refused even if the request itself succeeded.
  const wrong = createRenewer(async () => ({ ...fresh, userId: 43 }));
  assert.deepEqual(await wrong(session), { rejected: true });
});

test('a session without a refresh token, or one the server refuses, needs a password sign-in', async () => {
  let calls = 0;
  const never = createRenewer(async () => { calls++; return fresh; });
  assert.deepEqual(await never(null), { rejected: true });
  assert.deepEqual(await never({ token: 'access-1', userId: 42 }), { rejected: true });
  assert.equal(calls, 0);
  for (const error of [new ApiError('UNAUTHORIZED', 'expired', 401), new ApiError('FORBIDDEN', 'disabled', 403),
    new ApiError('ACCOUNT_MISMATCH', 'other account'), new ApiError('NOT_AVAILABLE', 'no such route', 404),
    new ApiError('INVALID_INPUT', 'bad body', 422)]) {
    assert.deepEqual(await createRenewer(async () => { throw error; })(session), { rejected: true }, error.code);
  }
});

test('no definite answer keeps the session renewable', async () => {
  const offline = new ApiError('NETWORK_ERROR', 'offline');
  const failing = new ApiError('SERVER_ERROR', 'unavailable', 503);
  assert.deepEqual(await createRenewer(async () => { throw offline; })(session), { unavailable: offline });
  assert.deepEqual(await createRenewer(async () => { throw failing; })(session), { unavailable: failing });
  const unknown = await createRenewer(async () => { throw new TypeError('bug'); })(session);
  assert.equal('unavailable' in unknown && unknown.unavailable.code, 'SERVER_ERROR');
  // After a failure the same refresh token is sent again.
  let attempts = 0;
  const renew = createRenewer(async () => { if (++attempts === 1) throw offline; return fresh; });
  assert.deepEqual(await renew(session), { unavailable: offline });
  assert.deepEqual(await renew(session), { session: fresh });
  assert.equal(attempts, 2);
});
