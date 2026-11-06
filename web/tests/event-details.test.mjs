import assert from 'node:assert/strict';
import test from 'node:test';
import { eventStatusLabel, parseEventId, readEventDetails, remainingSeats } from '../src/events/details.ts';

const event = {
  id: 42, organizer_id: 7, title: 'Встреча разработчиков', description: null,
  date: '2030-07-15T00:30:00Z', location: 'Большой зал', status: 'published', capacity: 100, tickets_issued: 12,
  created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z',
};

test('remaining seats uses the explicit clamped formula', () => {
  assert.equal(remainingSeats(100, 12), 88);
  assert.equal(remainingSeats(100, 100), 0);
  assert.equal(remainingSeats(100, 101), 0);
  assert.equal(remainingSeats(100, 0), 100);
});

test('missing, coerced, negative and non-finite counters never invent availability', () => {
  for (const invalid of [undefined, null, '100', false, -1, 1.5, Infinity, NaN]) {
    assert.equal(remainingSeats(invalid, 0), null);
    assert.equal(remainingSeats(100, invalid), null);
  }
  assert.equal(remainingSeats(0, 0), null);
});

test('EventRead fields are preserved; missing counters degrade only availability', () => {
  assert.deepEqual(readEventDetails(event, 42), event);
  const { capacity, tickets_issued, ...withoutCounters } = event;
  const parsed = readEventDetails(withoutCounters, 42);
  assert.equal(parsed.title, event.title);
  assert.equal(parsed.description, null);
  assert.equal(parsed.capacity, null);
  assert.equal(parsed.tickets_issued, null);
  assert.equal(remainingSeats(parsed.capacity, parsed.tickets_issued), null);
  assert.equal(readEventDetails({ ...event, capacity: '100', tickets_issued: -1 }, 42).capacity, null);
});

test('malformed responses and a different event ID are rejected', () => {
  for (const payload of [null, [], { ...event, id: 43 }, { ...event, date: 'invalid' }, { ...event, title: null }]) {
    assert.throws(() => readEventDetails(payload, 42), (error) => error.kind === 'response');
  }
});

test('event status is explicit, including cancellation and unknown status', () => {
  assert.equal(eventStatusLabel(readEventDetails({ ...event, status: 'cancelled' }, 42).status), 'Отменено');
  assert.equal(eventStatusLabel('draft'), 'Черновик');
  assert.equal(eventStatusLabel('published'), 'Опубликовано');
  assert.equal(eventStatusLabel(readEventDetails({ ...event, status: 'unexpected' }, 42).status), 'Неизвестный статус');
});

test('only safe positive numeric event IDs reach the API', () => {
  assert.equal(parseEventId('42'), 42);
  for (const id of [undefined, '0', '-1', '01', '1.5', '42\n', '../auth/me', '9007199254740992']) assert.equal(parseEventId(id), null);
});
