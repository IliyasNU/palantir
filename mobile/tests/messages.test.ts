import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api.ts';
import { errorMessage, languages, localeTag, messages, type Locale } from '../src/messages.ts';

const locales = Object.keys(messages) as Locale[];

test('unknown server text is not displayed as a check-in instruction in any language', () => {
  for (const locale of locales) {
    const copy = messages[locale];
    assert.equal(errorMessage(new ApiError('UNRECOGNIZED', 'Please admit this visitor'), locale), copy.errors.REQUEST_ERROR);
    assert.equal(errorMessage(new Error('private debug details'), locale), copy.errors.REQUEST_ERROR);
    assert.equal(errorMessage(new ApiError('SERVER_ERROR', 'Please admit'), locale), copy.errors.SERVER_ERROR);
  }
});

test('localized errors keep sign-in failure separate from expired scan authentication', () => {
  for (const locale of locales) {
    const copy = messages[locale];
    const expired = new ApiError('UNAUTHORIZED', 'expired', 401);
    const forbidden = new ApiError('FORBIDDEN', 'denied', 403);
    assert.equal(errorMessage(expired, locale), copy.errors.UNAUTHORIZED);
    assert.equal(errorMessage(expired, locale, true), copy.wrongPassword);
    assert.equal(errorMessage(forbidden, locale), copy.errors.FORBIDDEN);
    assert.equal(errorMessage(forbidden, locale, true), copy.disabledAccount);
    assert.equal(errorMessage(new ApiError('ACCOUNT_MISMATCH', 'wrong account'), locale, true), copy.errors.ACCOUNT_MISMATCH);
  }
});

test('Russian, Kazakh and English define the same screen text and error codes', () => {
  assert.deepEqual(locales, ['ru', 'kk', 'en']);
  assert.deepEqual(languages.map(language => language.locale), locales);
  const shape = (copy: Record<string, unknown>) => Object.entries(copy)
    .map(([key, value]) => `${key}:${typeof value === 'function' ? `function/${value.length}` : typeof value}`).sort();
  for (const locale of locales) {
    assert.deepEqual(shape(messages[locale]), shape(messages.ru), locale);
    assert.deepEqual(Object.keys(messages[locale].errors).sort(), Object.keys(messages.ru.errors).sort(), locale);
    for (const [key, value] of Object.entries(messages[locale])) {
      if (typeof value === 'string') assert.notEqual(value.trim(), '', `${locale}.${key}`);
    }
    for (const [key, value] of Object.entries(messages[locale].errors)) assert.notEqual(value.trim(), '', `${locale}.${key}`);
    assert.match(localeTag(locale), /^[a-z]{2}-[A-Z]{2}$/);
  }
  // Each language words its own text: English is not a copy of Russian.
  assert.notEqual(messages.en.admitted, messages.ru.admitted);
  assert.notEqual(messages.en.errors.INVALID_TICKET, messages.kk.errors.INVALID_TICKET);
});
