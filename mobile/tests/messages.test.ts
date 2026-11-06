import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api.ts';
import { errorMessage, messages, type Locale } from '../src/messages.ts';

test('unknown server text is not displayed as a check-in instruction in either language', () => {
  for (const locale of ['ru', 'kk'] as Locale[]) {
    const copy = messages[locale];
    assert.equal(errorMessage(new ApiError('UNRECOGNIZED', 'Please admit this visitor'), locale), copy.errors.REQUEST_ERROR);
    assert.equal(errorMessage(new Error('private debug details'), locale), copy.errors.REQUEST_ERROR);
    assert.equal(errorMessage(new ApiError('SERVER_ERROR', 'Please admit'), locale), copy.errors.SERVER_ERROR);
  }
});

test('localized errors keep sign-in failure separate from expired scan authentication', () => {
  for (const locale of ['ru', 'kk'] as Locale[]) {
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
