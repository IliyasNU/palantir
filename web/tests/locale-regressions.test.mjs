import test from 'node:test';
import assert from 'node:assert/strict';
import {setLocale, current} from '../src/i18n/index.ts';
import {ApiError, getErrorMessage} from '../src/api/client.ts';
import {ticketTypePrice} from '../src/ticket-types/model.ts';
import {formatEventDate} from '../src/events/catalog.ts';

test('stored API failures, integer money and Kazakh dates follow the selected locale', () => {
  try {
    setLocale('ru');
    const error = new ApiError(current().api.server, {kind: 'http', status: 500});
    assert.equal(ticketTypePrice(100000).replace(/\s/g, ''), '1000₸');
    setLocale('en');
    assert.equal(getErrorMessage(error), current().api.server);
    assert.equal(ticketTypePrice(100000).replace(/\s/g, ''), '1,000₸');
    assert.equal(ticketTypePrice(100050).replace(/\s/g, ''), '1,000.50₸');
    setLocale('kk');
    assert.match(formatEventDate('2030-11-15T12:00:00Z'), /қараша/);
    assert.doesNotMatch(formatEventDate('2030-11-15T12:00:00Z'), /M11/);
    assert.equal(getErrorMessage(error), current().api.server);
  } finally {
    setLocale('ru');
  }
});
