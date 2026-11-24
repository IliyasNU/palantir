import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client.ts';
import { safeReturnTo } from '../src/auth/returnTo.ts';
import { canManageEvents, canOrganize, emptyEventDraft, emptyOrganizerProfileDraft, eventDraft, eventPayload, localInputValue, organizerProfileDraft, organizerProfilePayload, organizerError, readManagedEvent, readManagedEvents, readOrganizerProfile, readStaffMembers, staffError } from '../src/organizer/model.ts';
import { messages } from '../src/i18n/messages.ts';

import { readEventHistory } from '../src/organizer/history.ts';

const organizerText = messages.ru.organizer;

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

test('organizer profile is validated, trimmed and converted to the API payload', () => {
  const profile = {
    id: 4, user_id: 3, organization_name: 'NU Robotics',
    description: 'Student club', contact_email: 'club@example.com',
    contact_phone: '+7 701 123 45 67', website: 'https://example.com',
    created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z',
  };
  assert.deepEqual(organizerProfileDraft(profile), {
    organization_name: 'NU Robotics', description: 'Student club',
    contact_email: 'club@example.com', contact_phone: '+7 701 123 45 67', website: 'https://example.com',
  });
  assert.deepEqual(emptyOrganizerProfileDraft(), {
    organization_name: '', description: '', contact_email: '', contact_phone: '', website: '',
  });
  assert.deepEqual(organizerProfilePayload({
    organization_name: ' NU Robotics ',
    description: '  ',
    contact_email: '',
    contact_phone: ' ',
    website: ' ',
  }), {
    organization_name: 'NU Robotics', description: null,
    contact_email: null, contact_phone: null, website: null,
  });
  for (const bad of [
    { ...emptyOrganizerProfileDraft(), organization_name: 'A' },
    { organization_name: 'Club', description: '', contact_email: 'not-email', contact_phone: '', website: '' },
    { organization_name: 'Club', description: '', contact_email: '', contact_phone: 'abc', website: '' },
    { organization_name: 'Club', description: '', contact_email: '', contact_phone: '', website: 'ftp://example.com' },
  ]) {
    assert.throws(() => organizerProfilePayload(bad), (error) => error instanceof ApiError && error.kind === 'validation');
  }
  assert.equal(readOrganizerProfile(profile).organization_name, 'NU Robotics');
  for (const bad of [null, {}, { ...profile, id: '4' }, { ...profile, contact_email: 123 }]) {
    assert.throws(() => readOrganizerProfile(bad), (error) => error instanceof ApiError && error.kind === 'response');
  }
});

test('staff lists and failures use strict contracts and localized API codes', () => {
  const member = {
    user_id: 12, email: 'staff@example.com', full_name: 'Staff Member',
    created_at: '2030-01-01T00:00:00Z',
  };
  assert.deepEqual(readStaffMembers([member]), [member]);
  assert.deepEqual(readStaffMembers([]), []);
  for (const bad of [null, {}, [{ ...member, user_id: '12' }], [{ ...member, email: null }], [null]]) {
    assert.throws(() => readStaffMembers(bad), (error) => error instanceof ApiError && error.kind === 'response');
  }
  const unknown = new ApiError('server text', { kind: 'http', status: 404, code: 'USER_NOT_FOUND' });
  const forbidden = new ApiError('server text', { kind: 'http', status: 403, code: 'FORBIDDEN' });
  assert.equal(staffError(unknown), organizerText.staff.userNotFound);
  assert.equal(staffError(forbidden), organizerText.staff.forbidden);
  assert.equal(staffError(new ApiError('Network lost', { kind: 'network' })), 'Network lost');
});

test('organizer routes are allowed after login; near misses are not', () => {
  for (const route of ['/organizer', '/organizer/', '/organizer/profile', '/organizer/events/new', '/organizer/events/42/edit', '/organizer/events/42/ticket-types']) {
    assert.equal(safeReturnTo(route), route);
  }
  // '/organizer/5' comes from Sanzhar's first version of this test: no route lives directly under /organizer.
  for (const route of ['/organizer/5', '/organizer/events', '/organizer/events/0/edit', '/organizer/events/42', '/organizer/events/new/edit', '/organizer/events/42/delete',
    '/organizerx', '/organizer//events/new', '/organizer?next=//evil.test', '/admin', '/admin/users']) {
    assert.equal(safeReturnTo(route), '/events', route);
  }
});

test('event history reads every order status and rejects an unknown status', () => {
  const statuses = ['pending', 'paid', 'failed', 'cancelled', 'expired', 'refunded'];
  const parse = (values) => readEventHistory({
    event, tickets: [], check_ins: [], has_more: false,
    orders: values.map((status, i) => ({ id: i + 1, status, total_tiyn: 12500, created_at: event.created_at })),
  }, event.id);
  assert.deepEqual(parse(statuses).orders.map(order => order.status), statuses);
  assert.throws(() => parse(['unknown']), ApiError);
});

test('the editor preserves a private event and submits only a changed visibility', () => {
  const original = readManagedEvent({ ...event, visibility: 'private' }, event.id);
  const form = eventDraft(original);
  assert.equal(form.visibility, 'private');
  assert.deepEqual(eventPayload(form, original), {});
  assert.deepEqual(eventPayload({ ...form, visibility: 'public' }, original), { visibility: 'public' });
  assert.equal(eventPayload({ ...form, visibility: 'unlisted' }).visibility, 'unlisted');
});
