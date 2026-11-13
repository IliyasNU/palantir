import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type StaffSession } from '../src/api.ts';
import { createRenewer, renewCurrentSession, type Renewal } from '../src/renewal.ts';

const old: StaffSession = { userId: 42, token: 'access-old', refreshToken: 'refresh-old' };
const signedIn: StaffSession = { userId: 42, token: 'access-login', refreshToken: 'refresh-login' };
const renewed: StaffSession = { userId: 42, token: 'access-renewed', refreshToken: 'refresh-renewed' };

for (const result of [{ rejected: true }, { unavailable: new ApiError('NETWORK_ERROR', 'offline') },
  { session: renewed }] satisfies Renewal[]) {
  test(`a late ${Object.keys(result)[0]} renewal preserves a newer password login`, async () => {
    let current: StaffSession | null = old;
    let finish!: (value: Renewal) => void;
    const pending = renewCurrentSession(() => current, value => { current = value; },
      () => new Promise(resolve => { finish = resolve; }));
    // The same account signs in again while an old background request is still running.
    current = signedIn;
    finish(result);
    const answer = await pending;
    // Events/scan callers sign out on `rejected`: an obsolete answer must not clear the new login.
    if (answer === 'rejected') current = null;
    assert.equal(answer, signedIn);
    assert.equal(current, signedIn);
  });
}

test('logout or an account change during renewal cannot receive the old account token', async () => {
  for (const replacement of [null, { ...signedIn, userId: 7 }]) {
    let current: StaffSession | null = old;
    let finish!: (value: Renewal) => void;
    const pending = renewCurrentSession(() => current, value => { current = value; },
      () => new Promise(resolve => { finish = resolve; }));
    current = replacement;
    finish({ session: renewed });
    assert.equal(await pending, 'rejected');
    assert.equal(current, replacement);
  }
});

test('parallel callers store one renewal and both return the current session', async () => {
  let current: StaffSession | null = old;
  let finish!: (value: StaffSession) => void;
  let sends = 0;
  let writes = 0;
  const renew = createRenewer(() => { sends++; return new Promise(resolve => { finish = resolve; }); });
  const call = () => renewCurrentSession(() => current, value => { current = value; writes++; }, renew);
  const first = call();
  const second = call();
  finish(renewed);
  assert.deepEqual(await Promise.all([first, second]), [renewed, renewed]);
  assert.equal(sends, 1);
  assert.equal(writes, 1);
});
