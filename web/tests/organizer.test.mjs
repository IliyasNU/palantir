import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client.ts';
import { safeReturnTo } from '../src/auth/returnTo.ts';
import { canManageEvents, canOrganize, emptyEventDraft, eventDraft, eventPayload, localInputValue, organizerError, readManagedEvent, readManagedEvents } from '../src/organizer/model.ts';
import { organizerText } from '../src/organizer/strings.ts';

process.env.TZ = 'Asia/Almaty'; // UTC+5 without daylight saving: local 17:00 is 12:00 UTC

const event = { id: 9, organizer_id: 3, title: 'Вечер джаза', description: 'Живая музыка', date: '2030-07-15T12:00:00Z',
  location: 'Orange Hall', status: 'draft', capacity: 50, tickets_issued: 0, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z' };
const draft = { title: ' Вечер джаза ', description: '  ', date: '2030-07-15T17:00', location: ' Orange Hall ', capacity: '50' };
const issues = (work) => { try { work(); } catch (error) { return error.issues.map((issue) => issue.field); } return null; };

test('only organizers get the cabinet; organizers and admins may open the editor', () => {
  assert.deepEqual(['organizer', 'admin', 'attendee', 'ORGANIZER'].map((role) => canOrganize({ role })), [true, false, false, false]);
  assert.deepEqual(['organizer', 'admin', 'attendee'].map((role) => canManageEvents({ role })), [true, true, false]);
  assert.equal(canOrganize(null) || canManageEvents(null), false);
});

test('a managed event reports suspension from either API field and rejects malformed lists', () => {
  assert.equal(readManagedEvent(event, 9).suspended, false);
  assert.equal(readManagedEvent({ ...event, suspended: true }, 9).suspended, true);
  assert.equal(readManagedEvent({ ...event, suspended_at: '2030-02-01T00:00:00Z' }, 9).suspended, true);
  assert.equal(readManagedEvent({ ...event, suspended: 'yes', suspended_at: null }, 9).suspended, false);
  assert.deepEqual(readManagedEvents([event, { ...event, id: 10 }]).map((item) => item.id), [9, 10]);
  assert.deepEqual(readManagedEvents([]), []);
  for (const bad of [null, {}, [{ ...event, id: '9' }], [{ ...event, title: '' }], [null]]) {
    assert.throws(() => readManagedEvents(bad), (error) => error instanceof ApiError && error.kind === 'response');
  }
});

test('a new event is trimmed, validated with the API limits and sent in UTC', () => {
  assert.deepEqual(eventPayload(draft), { title: 'Вечер джаза', description: null, date: '2030-07-15T12:00:00.000Z', location: 'Orange Hall', capacity: 50 });
  assert.equal(eventPayload({ ...draft, description: ' Текст ' }).description, 'Текст');
  assert.deepEqual(issues(() => eventPayload(emptyEventDraft())), ['title', 'date', 'location', 'capacity']);
  assert.deepEqual(issues(() => eventPayload({ ...draft, title: 'ab' })), ['title']);
  assert.deepEqual(issues(() => eventPayload({ ...draft, title: 'я'.repeat(201) })), ['title']);
  assert.equal(issues(() => eventPayload({ ...draft, title: 'я'.repeat(200), location: 'я'.repeat(255) })), null);
  assert.deepEqual(issues(() => eventPayload({ ...draft, description: 'я'.repeat(5001) })), ['description']);
  assert.deepEqual(issues(() => eventPayload({ ...draft, date: 'tomorrow' })), ['date']);
  assert.deepEqual(issues(() => eventPayload({ ...draft, location: 'x' })), ['location']);
  for (const capacity of ['0', '-5', '1.5', '1e3', '1000001', ' ', 'много']) {
    assert.deepEqual(issues(() => eventPayload({ ...draft, capacity })), ['capacity'], capacity);
  }
  assert.equal(eventPayload({ ...draft, capacity: ' 1000000 ' }).capacity, 1_000_000);
});

test('the edit form shows local time and sends only what changed', () => {
  assert.equal(localInputValue(event.date), '2030-07-15T17:00');
  const original = readManagedEvent(event, 9);
  const form = eventDraft(original);
  assert.deepEqual(form, { title: 'Вечер джаза', description: 'Живая музыка', date: '2030-07-15T17:00', location: 'Orange Hall', capacity: '50' });
  assert.deepEqual(eventPayload(form, original), {});
  assert.deepEqual(eventPayload({ ...form, capacity: '60' }, original), { capacity: 60 });
  assert.deepEqual(eventPayload({ ...form, description: '' }, original), { description: null });
  assert.deepEqual(eventPayload({ ...form, date: '2030-07-16T09:30' }, original), { date: '2030-07-16T04:30:00.000Z' });
  assert.deepEqual(eventPayload({ ...form, title: 'Ночь джаза', location: 'Blue Hall' }, original), { title: 'Ночь джаза', location: 'Blue Hall' });
  // Seconds the minute-precision input cannot show are kept when the date is not touched.
  const precise = readManagedEvent({ ...event, date: '2030-07-15T12:00:45Z' }, 9);
  assert.deepEqual(eventPayload({ ...eventDraft(precise), title: 'Новое имя' }, precise), { title: 'Новое имя' });
  assert.deepEqual(issues(() => eventPayload({ ...form, capacity: '0' }, original)), ['capacity']);
});

test('management errors are shown by API code', () => {
  const failure = (status, code) => new ApiError('server text', { kind: 'http', status, code });
  assert.equal(organizerError(failure(409, 'CAPACITY_BELOW_ISSUED')), organizerText.errors.CAPACITY_BELOW_ISSUED);
  assert.equal(organizerError(failure(409, 'TICKET_TYPES_CAPACITY')), organizerText.errors.TICKET_TYPES_CAPACITY);
  assert.equal(organizerError(failure(409, 'EVENT_CANCELLED')), organizerText.errors.EVENT_CANCELLED);
  assert.equal(organizerError(failure(404, 'EVENT_NOT_FOUND')), organizerText.errors.EVENT_NOT_FOUND);
  assert.equal(organizerError(failure(403, 'FORBIDDEN')), organizerText.errors.forbidden);
  assert.equal(organizerError(failure(403)), organizerText.errors.forbidden);
  assert.equal(organizerError(new ApiError('Не удалось связаться с сервером.', { kind: 'network' })), 'Не удалось связаться с сервером.');
  assert.doesNotMatch(organizerError(new Error('private stack')), /private/);
});

test('organizer routes are allowed after login; near misses are not', () => {
  for (const route of ['/organizer', '/organizer/', '/organizer/events/new', '/organizer/events/42/edit', '/organizer/events/42/ticket-types']) {
    assert.equal(safeReturnTo(route), route);
  }
  for (const route of ['/organizer/events', '/organizer/events/0/edit', '/organizer/events/42', '/organizer/events/new/edit', '/organizer/events/42/delete',
    '/organizerx', '/organizer//events/new', '/organizer?next=//evil.test', '/admin', '/admin/users']) {
    assert.equal(safeReturnTo(route), '/events', route);
  }
});
