import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient, ApiError } from '../src/api/client.ts';
import { createAuthStore } from '../src/auth/store.ts';
import { passwordIssues, validateRegistration } from '../src/auth/formErrors.ts';
import { RESEND_INTERVAL_MS, forgotPasswordAnswered, isInvalidLink, linkErrorMessage, resendWaitMs, validateNewPassword } from '../src/account/model.ts';
import { messages } from '../src/i18n/messages.ts';

const accountText = messages.ru.account;

const user = { id: 1, email: 'test@example.com', full_name: 'Test Visitor', role: 'attendee', is_active: true, created_at: '2026-10-28T00:00:00Z' };
const invalidToken = new ApiError('The link is invalid or has expired', { kind: 'http', status: 400, code: 'INVALID_TOKEN' });

function signedIn(me) {
  const api = createApiClient('http://localhost:8000', async (url) => Response.json(new URL(url).pathname === '/auth/login'
    ? { access_token: 'test-only-access', refresh_token: 'unused', token_type: 'bearer' } : me));
  return createAuthStore(api);
}

test('a new password follows the registration rules', () => {
  assert.deepEqual(passwordIssues('long enough'), []);
  assert.deepEqual(passwordIssues('short').map((issue) => issue.field), ['password']);
  assert.equal(passwordIssues('я'.repeat(37)).length, 1); // 74 bytes of UTF-8
  assert.doesNotThrow(() => validateNewPassword('12345678'));
  for (const password of ['', '1234567', 'я'.repeat(37)]) {
    assert.throws(() => validateNewPassword(password), (error) => error instanceof ApiError && error.kind === 'validation'
      && error.issues.length === 1 && error.issues[0].field === 'password');
  }
  // Registration still reports the name and the same password messages.
  assert.throws(() => validateRegistration({ email: 'a@example.com', full_name: ' ', password: 'short' }),
    (error) => error instanceof ApiError && error.issues.map((issue) => issue.field).join() === 'full_name,password'
      && error.issues[1].message === passwordIssues('short')[0].message);
});

test('only 400 INVALID_TOKEN is reported as an invalid link', () => {
  assert.equal(isInvalidLink(invalidToken), true);
  assert.equal(linkErrorMessage(invalidToken), accountText.invalidLink);
  for (const other of [new ApiError('x', { kind: 'http', status: 400 }), new ApiError('x', { kind: 'http', status: 401, code: 'INVALID_TOKEN' }),
    new ApiError('offline', { kind: 'network' }), new Error('x'), null]) {
    assert.equal(isInvalidLink(other), false);
  }
  assert.equal(linkErrorMessage(new ApiError('new_password: too short', { kind: 'validation', status: 422 })), accountText.reset.checkForm);
  const offline = new ApiError('Не удалось связаться с сервером.', { kind: 'network' });
  assert.equal(linkErrorMessage(offline), offline.message);
  assert.doesNotMatch(linkErrorMessage(new Error('private stack')), /private/);
});

test('any HTTP answer to forgot-password counts as answered; a failed connection does not', () => {
  for (const status of [202, 400, 404, 422, 429, 500]) assert.equal(forgotPasswordAnswered(new ApiError('x', { kind: 'http', status })), true);
  assert.equal(forgotPasswordAnswered(new ApiError('offline', { kind: 'network' })), false);
  assert.equal(forgotPasswordAnswered(new ApiError('slow', { kind: 'timeout' })), false);
  assert.equal(forgotPasswordAnswered(new Error('x')), false);
});

test('the verification email can be requested once per minute', () => {
  const sent = 1_000_000;
  assert.equal(resendWaitMs(null, sent), 0);
  assert.equal(resendWaitMs(sent, sent), RESEND_INTERVAL_MS);
  assert.equal(resendWaitMs(sent, sent + 59_999), 1);
  assert.equal(resendWaitMs(sent, sent + 60_000), 0);
  assert.equal(resendWaitMs(sent, sent + 3_600_000), 0);
  // A clock moved back never extends the wait beyond one minute.
  assert.equal(resendWaitMs(sent, sent - 3_600_000), RESEND_INTERVAL_MS);
});

test('the session keeps email_verified only as a boolean and can mark its own account verified', async () => {
  const legacy = signedIn(user);
  await legacy.login({ email: user.email, password: 'test-only-password' });
  assert.equal('email_verified' in legacy.getSnapshot().user, false);
  legacy.markEmailVerified(user.id);
  assert.equal('email_verified' in legacy.getSnapshot().user, false);

  const odd = signedIn({ ...user, email_verified: 'false' });
  await odd.login({ email: user.email, password: 'test-only-password' });
  assert.equal('email_verified' in odd.getSnapshot().user, false);

  const store = signedIn({ ...user, email_verified: false });
  await store.login({ email: user.email, password: 'test-only-password' });
  assert.equal(store.getSnapshot().user.email_verified, false);
  let published = 0;
  store.subscribe(() => { published += 1; });
  store.markEmailVerified(2); // another account's link changes nothing here
  assert.deepEqual([store.getSnapshot().user.email_verified, published], [false, 0]);
  store.markEmailVerified(user.id);
  assert.deepEqual([store.getSnapshot().user.email_verified, published, store.getSnapshot().status], [true, 1, 'authenticated']);
  store.logout();
  store.markEmailVerified(user.id);
  assert.equal(store.getSnapshot().user, null);
});
