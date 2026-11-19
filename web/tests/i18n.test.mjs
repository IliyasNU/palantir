import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, getErrorMessage } from '../src/api/client.ts';
import { authErrorMessage, passwordIssues } from '../src/auth/formErrors.ts';
import { formatEventDate } from '../src/events/catalog.ts';
import { eventStatusLabel } from '../src/events/details.ts';
import { DEFAULT_LOCALE, current, dateLocale, getLocale, isLocale, locales, messages, setLocale } from '../src/i18n/index.ts';
import { organizerError } from '../src/organizer/model.ts';
import { ticketTypePrice } from '../src/ticket-types/model.ts';

const names = Object.keys(messages);
const shape = (value, path = '') => Object.entries(value).flatMap(([key, item]) => (typeof item === 'object'
  ? shape(item, `${path}${key}.`) : [`${path}${key}:${typeof item === 'function' ? `function/${item.length}` : typeof item}`])).sort();

test('Kazakh, Russian and English define the same keys with the same kinds of values', () => {
  assert.deepEqual(names.sort(), ['en', 'kk', 'ru']);
  assert.deepEqual(locales.map((item) => item.locale), ['kk', 'ru', 'en']);
  const expected = shape(messages.ru);
  assert.ok(expected.length > 350, String(expected.length));
  for (const name of names) assert.deepEqual(shape(messages[name]), expected, name);
});

test('no text is empty and each language is actually translated', () => {
  const texts = (value) => Object.values(value).flatMap((item) => (typeof item === 'object' ? texts(item) : [item]));
  const sample = { status: 404, count: 3, id: 7, name: 'Имя', time: '12:00', price: '500 ₸', label: 'Метка' };
  const render = (item) => (typeof item === 'function' ? item(...Array.from({ length: item.length }, (_, index) => Object.values(sample)[index])) : item);
  const rendered = Object.fromEntries(names.map((name) => [name, texts(messages[name]).map(render)]));
  for (const name of names) {
    for (const text of rendered[name]) assert.ok(typeof text === 'string' && text.trim() !== '' && !text.includes('undefined'), `${name}: ${text}`);
  }
  // A handful of words are the same everywhere (Email, UTC examples); nearly everything else must differ.
  for (const [left, right] of [['ru', 'kk'], ['ru', 'en'], ['kk', 'en']]) {
    const same = rendered[left].filter((text, index) => text === rendered[right][index]);
    assert.ok(same.length <= 12, `${left}/${right} share ${same.length}: ${same.slice(0, 20).join(' | ')}`);
  }
});

test('Russian is the default and switching changes texts produced outside React', () => {
  assert.equal(DEFAULT_LOCALE, 'ru');
  assert.equal(getLocale(), 'ru');
  const offline = new ApiError('x', { kind: 'http', status: 403, code: 'CAPACITY_BELOW_ISSUED' });
  const seen = {};
  for (const name of ['ru', 'kk', 'en', 'ru']) {
    setLocale(name);
    assert.equal(getLocale(), name);
    assert.equal(current(), messages[name]);
    seen[name] = [getErrorMessage(new Error('private')), eventStatusLabel('draft'), ticketTypePrice(0), passwordIssues('x')[0].message,
      authErrorMessage(new ApiError('x', { kind: 'http', status: 401 }), 'login'), organizerError(offline), formatEventDate('2030-07-15T12:00:00Z')];
    assert.equal(dateLocale(), locales.find((item) => item.locale === name).tag);
  }
  assert.equal(seen.ru[1], 'Черновик');
  assert.equal(seen.en[1], 'Draft');
  assert.equal(seen.en[2], 'Free');
  assert.match(seen.en[6], /July 2030/);
  assert.match(seen.ru[6], /июля 2030/);
  for (let index = 0; index < seen.ru.length; index++) assert.equal(new Set([seen.ru[index], seen.kk[index], seen.en[index]]).size, 3, String(index));
});

test('an unknown language is ignored', () => {
  for (const value of ['de', '', 'RU', null, undefined, 'constructor', '__proto__']) {
    assert.equal(isLocale(value), false, String(value));
    setLocale(value);
    assert.equal(getLocale(), 'ru');
  }
  assert.deepEqual(['ru', 'kk', 'en'].map(isLocale), [true, true, true]);
});

test('the choice is kept in localStorage, and blocked or invalid storage falls back to Russian', async () => {
  const data = new Map([['biletflow.locale', 'kk']]);
  globalThis.localStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
  const restored = await import('../src/i18n/index.ts?restored');
  assert.equal(restored.getLocale(), 'kk');
  restored.setLocale('en');
  assert.equal(data.get('biletflow.locale'), 'en');

  data.set('biletflow.locale', 'klingon');
  assert.equal((await import('../src/i18n/index.ts?invalid')).getLocale(), 'ru');

  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const blocked = await import('../src/i18n/index.ts?blocked');
  assert.equal(blocked.getLocale(), 'ru');
  blocked.setLocale('kk');
  assert.equal(blocked.getLocale(), 'kk');
  delete globalThis.localStorage;
});
