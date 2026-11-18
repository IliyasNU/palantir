// Regression tests for the findings of Alibi's reviews of PR #22, #24 and #25. Each test names its finding.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient, getErrorMessage, issueMessage } from '../src/api/client.ts';
import { forgotPasswordError, forgotPasswordOutcome } from '../src/account/model.ts';
import { adminError, actionLogPath, suspensionReason } from '../src/admin/model.ts';
import { authErrorMessage, passwordIssues, validateRegistration } from '../src/auth/formErrors.ts';
import { createAuthStore } from '../src/auth/store.ts';
import { formatEventDate, readCatalog } from '../src/events/catalog.ts';
import { current, messages, setLocale } from '../src/i18n/index.ts';
import { formatDateTime, formatNumber } from '../src/i18n/format.ts';
import { eventPayload, organizerError } from '../src/organizer/model.ts';
import { ticketTypePrice } from '../src/ticket-types/model.ts';
import { withoutKazakhLocaleData } from './browser/fixtures/no-kazakh-intl.mjs';

const http = (status) => new ApiError('server wording', { kind: status === 422 ? 'validation' : 'http', status });
const inLocale = (locale, work) => { try { setLocale(locale); return work(); } finally { setLocale('ru'); } };
const failure = (work) => { try { work(); } catch (error) { return error; } throw new Error('expected a failure'); };

test('#22.1 forgot-password: only technical failures are retryable, and nothing depends on the account', () => {
  assert.equal(forgotPasswordOutcome(null), 'sent');
  // Refusals that could depend on the address read exactly like a success.
  for (const status of [400, 401, 403, 409]) assert.equal(forgotPasswordOutcome(http(status)), 'sent', String(status));
  for (const status of [404, 500, 502, 503]) assert.equal(forgotPasswordOutcome(http(status)), 'retry', String(status));
  assert.equal(forgotPasswordOutcome(http(429)), 'tooMany');
  assert.equal(forgotPasswordOutcome(http(422)), 'invalidEmail');
  for (const kind of ['network', 'timeout', 'response', 'configuration']) {
    assert.equal(forgotPasswordOutcome(new ApiError('x', { kind })), 'retry', kind);
  }
  assert.equal(forgotPasswordOutcome(new Error('unexpected')), 'retry');
  assert.equal(forgotPasswordError('retry', http(500)), messages.ru.api.server);
  assert.equal(forgotPasswordError('retry', http(404)), messages.ru.api.server);
  assert.equal(forgotPasswordError('tooMany', http(429)), messages.ru.api.tooMany);
  assert.equal(forgotPasswordError('invalidEmail', http(422)), messages.ru.account.forgot.invalidEmail);
  assert.equal(forgotPasswordError('retry', new ApiError((m) => m.api.network, { kind: 'network' })), messages.ru.api.network);
});

test('#25.1 errors made in one language are shown in the language current when they render', async () => {
  const timeout = createApiClient('http://localhost:8000', (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }), 5);
  const registerTimeout = await timeout.request('/auth/register', { method: 'POST', body: {} }).catch((error) => error);
  const teapot = await createApiClient('http://localhost:8000', async () => new Response('', { status: 418 })).request('/x').catch((error) => error);
  const serverText = await createApiClient('http://localhost:8000', async () => Response.json({ detail: 'Ticket type is hidden' }, { status: 400 }))
    .request('/x').catch((error) => error);
  const store = createAuthStore(createApiClient('http://localhost:8000', async () => Response.json({})));
  const signedOut = await store.request('/tickets/me').catch((error) => error);
  // All made while Russian is current.
  const made = {
    registerTimeout, teapot, serverText, signedOut,
    catalog: failure(() => readCatalog({})),
    registration: failure(() => validateRegistration({ email: 'a@example.com', full_name: ' ', password: 'short' })),
    reason: failure(() => suspensionReason('x')),
    period: failure(() => actionLogPath({ action: '', eventId: '', from: '2030-01-02T00:00', to: '2030-01-01T00:00' }, 0)),
    event: failure(() => eventPayload({ title: '', description: '', date: '', location: '', capacity: '' })),
  };
  for (const locale of ['kk', 'en']) {
    inLocale(locale, () => {
      const text = messages[locale];
      assert.equal(getErrorMessage(made.registerTimeout), text.api.timeout + text.api.timeoutRegister);
      assert.equal(getErrorMessage(made.teapot), text.api.http(418));
      // FastAPI wording is English whatever the interface language: a translated text replaces it.
      assert.equal(getErrorMessage(made.serverText), text.api.http(400));
      assert.equal(getErrorMessage(made.signedOut), text.auth.signInToContinue);
      assert.equal(getErrorMessage(made.catalog), text.catalog.malformed);
      assert.equal(authErrorMessage(made.registration, 'register'), text.auth.checkForm);
      assert.deepEqual(made.registration.issues.map(issueMessage), [text.auth.nameRequired, text.auth.passwordShort]);
      assert.equal(adminError(made.reason), text.admin.reasonInvalid);
      assert.equal(adminError(made.period), text.admin.log.periodInvalid);
      assert.equal(organizerError(made.event), text.organizer.validation.form);
      assert.equal(issueMessage(made.event.issues[0]), text.organizer.validation.title);
    });
  }
});

test('#25.2 server validation issues get a translated text; local issues keep their specific one', () => {
  const server = { field: 'email', message: 'value is not a valid email address' };
  for (const locale of ['ru', 'kk', 'en']) {
    inLocale(locale, () => {
      assert.equal(issueMessage(server), messages[locale].api.invalid);
      assert.equal(issueMessage(passwordIssues('short')[0]), messages[locale].auth.passwordShort);
    });
  }
});

test('#25.3 money follows the language and omits decimals for whole tenge, also without Kazakh ICU data', () => {
  const plain = (value) => value.replace(/\s/g, ' ');
  const restore = withoutKazakhLocaleData();
  try {
    assert.equal(plain(inLocale('kk', () => ticketTypePrice(100050))), '1 000,50 ₸');
    assert.equal(plain(inLocale('kk', () => ticketTypePrice(100000))), '1 000 ₸');
    assert.equal(plain(inLocale('kk', () => formatNumber(1234567))), '1 234 567');
  } finally { restore(); }
  assert.equal(plain(inLocale('ru', () => ticketTypePrice(100000))), '1 000 ₸');
  assert.equal(inLocale('en', () => ticketTypePrice(100050)), '1,000.50 ₸');
  assert.equal(inLocale('en', () => ticketTypePrice(0)), messages.en.ticketTypes.free);
});

test('#25.4 Kazakh dates are readable in a browser without Kazakh ICU data, in the catalogue and in admin', () => {
  const restore = withoutKazakhLocaleData();
  try {
    // The emulation reproduces the review's Edge output for a formatter that relies on the browser.
    assert.match(new Date('2030-11-15T12:00:00Z').toLocaleString('kk-KZ', { dateStyle: 'medium', timeStyle: 'short' }), /^2030 M11 15/);
    for (const text of inLocale('kk', () => [formatEventDate('2030-11-15T12:00:00Z'), formatDateTime('2030-11-15T12:00:00Z', 'medium'),
      current().admin.events.suspendedSince(formatDateTime('2030-11-15T12:00:00Z', 'medium'))])) {
      assert.match(text, /^Бұғатталған уақыты: 15 қараша 2030, \d\d:\d\d$|^15 қараша 2030, \d\d:\d\d$/);
      assert.doesNotMatch(text, /M11/);
    }
  } finally { restore(); }
  assert.match(inLocale('ru', () => formatDateTime('2030-11-15T12:00:00Z', 'medium')), /2030/);
  assert.match(inLocale('en', () => formatDateTime('2030-11-15T12:00:00Z', 'long')), /November 2030/);
});
