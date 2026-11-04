import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client.ts';
import { filterEventsByTitle, readCatalog } from '../src/events/catalog.ts';

const event = {
  id: 42, organizer_id: 7, title: 'Вечер джаза', description: null,
  date: '2030-07-15T00:30:00Z', location: 'Алматы', capacity: 100,
  status: 'published', tickets_issued: 12,
  created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z',
};

test('catalog accepts the real EventRead array and a genuinely empty array', () => {
  const result = readCatalog([event]);
  assert.equal(result[0].id, 42);
  assert.equal(result[0].title, event.title);
  assert.equal(result[0].date, event.date);
  assert.equal(result[0].location, event.location);
  assert.deepEqual(readCatalog([]), []);
});

test('invalid payloads are errors rather than an empty catalog or a partial list', () => {
  for (const payload of [null, {}, { items: [event] }, [null], [event, { ...event, id: '43' }],
    [{ ...event, date: 'not a date' }], [{ ...event, title: null }], [{ ...event, location: null }]]) {
    assert.throws(() => readCatalog(payload), (error) => error instanceof ApiError && error.kind === 'response');
  }
});

test('search trims surrounding whitespace, ignores case, and searches only titles', () => {
  const events = readCatalog([event, { ...event, id: 43, title: 'Лекция о музыке', location: 'Джаз-клуб' }]);
  assert.deepEqual(filterEventsByTitle(events, '  ДЖаЗ \n').map((item) => item.id), [42]);
  assert.deepEqual(filterEventsByTitle(events, 'алматы'), []);
  assert.deepEqual(filterEventsByTitle(events, 'неизвестное событие'), []);
  assert.equal(filterEventsByTitle(events, ' \t ').length, 2);
  assert.equal(events.length, 2);
});
