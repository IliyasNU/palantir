import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client.ts';
import { safeReturnTo } from '../src/auth/returnTo.ts';
import { LOG_PAGE, actionLogPath, adminError, adminPath, isAdmin, readActionLogEntry, readAdminEvent, readAdminUser, readList, roleLabel,
  suspensionReason } from '../src/admin/model.ts';
import { adminText } from '../src/admin/strings.ts';

process.env.TZ = 'Asia/Almaty'; // UTC+5

const user = { id: 5, email: 'a@example.com', full_name: 'Алия', role: 'organizer', is_active: true, created_at: '2030-01-01T00:00:00Z' };
const event = { id: 9, organizer_id: 5, title: 'Вечер джаза', description: null, date: '2030-07-15T12:00:00Z', location: 'Hall', status: 'published',
  capacity: 50, tickets_issued: 3, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z', suspended: false, suspended_at: null };
const entry = { id: 1, event_id: null, occurred_at: '2030-01-02T00:00:00Z', actor_id: 1, actor_name: 'Admin', action: 'user.suspended',
  entity_type: 'user', entity_id: 5, description: 'Suspended the account: spam' };
const malformed = (error) => error instanceof ApiError && error.kind === 'response';

test('only the admin role opens moderation, and /admin is never a post-login destination', () => {
  assert.deepEqual(['admin', 'organizer', 'attendee', 'Admin'].map((role) => isAdmin({ role })), [true, false, false, false]);
  assert.equal(isAdmin(null), false);
  for (const route of ['/admin', '/admin/users', '/admin/events', '/admin/action-log']) assert.equal(safeReturnTo(route), '/events');
});

test('admin answers are validated field by field', () => {
  assert.deepEqual(readAdminUser({ ...user, hashed_password: 'never kept' }), user);
  assert.equal(readAdminEvent(event).suspended_at, null);
  assert.equal(readAdminEvent({ ...event, suspended_at: '2030-02-01T00:00:00Z' }).suspended_at, '2030-02-01T00:00:00Z');
  assert.deepEqual(readActionLogEntry(entry), entry);
  assert.equal(readActionLogEntry({ ...entry, event_id: 9 }).event_id, 9);
  assert.deepEqual(readList([user, user], readAdminUser).length, 2);
  for (const bad of [null, [], { ...user, id: 0 }, { ...user, is_active: 'yes' }, { ...user, created_at: 'soon' }]) assert.throws(() => readAdminUser(bad), malformed);
  for (const bad of [{ ...event, suspended_at: undefined }, { ...event, suspended_at: 5 }, { ...event, id: '9' }, { ...event, title: '' }]) assert.throws(() => readAdminEvent(bad), malformed);
  for (const bad of [{ ...entry, event_id: 0 }, { ...entry, actor_name: null }, { ...entry, occurred_at: '' }]) assert.throws(() => readActionLogEntry(bad), malformed);
  assert.throws(() => readList({ items: [] }, readAdminUser), malformed);
});

test('queries carry only the filters that have a value', () => {
  assert.equal(adminPath('/admin/users', { q: '', limit: 50 }), '/admin/users?limit=50');
  assert.equal(adminPath('/admin/events', { q: 'джаз & рок', suspended: 'true', limit: 50 }), '/admin/events?q=%D0%B4%D0%B6%D0%B0%D0%B7+%26+%D1%80%D0%BE%D0%BA&suspended=true&limit=50');
  assert.equal(adminPath('/admin/users', { q: null, role: undefined }), '/admin/users');
});

test('a suspension reason is trimmed and held to the API limits', () => {
  assert.equal(suspensionReason('  spam  '), 'spam');
  assert.equal(suspensionReason('я'.repeat(300)).length, 300);
  for (const reason of ['', '  ', 'ab', ' ab ', 'я'.repeat(301)]) {
    assert.throws(() => suspensionReason(reason), (error) => adminError(error) === adminText.reasonInvalid);
  }
});

test('the action log query pages by offset and sends the period in UTC', () => {
  const none = { action: '', eventId: '', from: '', to: '' };
  assert.equal(actionLogPath(none, 0), `/admin/action-log?limit=${LOG_PAGE}&offset=0`);
  assert.equal(actionLogPath({ action: ' user ', eventId: ' 7 ', from: '2030-01-01T05:00', to: '2030-01-02T05:00' }, 100),
    '/admin/action-log?action=user&event_id=7&date_from=2030-01-01T00%3A00%3A00.000Z&date_to=2030-01-02T00%3A00%3A00.000Z&limit=50&offset=100');
  for (const eventId of ['0', '-1', '1.5', 'abc', '12345678901']) {
    assert.throws(() => actionLogPath({ ...none, eventId }, 0), (error) => adminError(error) === adminText.log.eventIdInvalid, eventId);
  }
  assert.throws(() => actionLogPath({ ...none, from: 'yesterday' }, 0), (error) => adminError(error) === adminText.log.periodInvalid);
  assert.throws(() => actionLogPath({ ...none, from: '2030-01-02T00:00', to: '2030-01-01T00:00' }, 0), (error) => adminError(error) === adminText.log.periodInvalid);
});

test('admin errors are shown by API code, never as raw server text', () => {
  const failure = (status, code) => new ApiError('raw server text', { kind: status === 422 ? 'validation' : 'http', status, code });
  assert.equal(adminError(failure(404, 'USER_NOT_FOUND')), adminText.errors.USER_NOT_FOUND);
  assert.equal(adminError(failure(404, 'EVENT_NOT_FOUND')), adminText.errors.EVENT_NOT_FOUND);
  assert.equal(adminError(failure(409, 'CANNOT_SUSPEND_SELF')), adminText.errors.CANNOT_SUSPEND_SELF);
  assert.equal(adminError(failure(403)), adminText.errors.forbidden);
  assert.equal(adminError(failure(422)), adminText.errors.invalid);
  assert.equal(adminError(new ApiError('Не удалось связаться с сервером.', { kind: 'network' })), 'Не удалось связаться с сервером.');
  assert.doesNotMatch(adminError(new Error('private stack')), /private/);
  assert.deepEqual(['admin', 'organizer', 'attendee', 'auditor', 'constructor'].map(roleLabel), ['Администратор', 'Организатор', 'Посетитель', 'auditor', 'constructor']);
});
