import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client.ts';
import { safeReturnTo } from '../src/auth/returnTo.ts';
import { canUseOrganizerPage, readOrganizerEvents, statusLabel } from '../src/organizer/model.ts';

const event = {
  id: 7, organizer_id: 3, title: 'Хакатон NU', description: null, date: '2030-03-01T10:00:00Z',
  location: 'Астана', capacity: 50, tickets_issued: 12, status: 'draft', created_at: '2030-01-01T00:00:00Z',
};

test('reads the organizer events the dashboard needs', () => {
  assert.deepEqual(readOrganizerEvents([event]), [{
    id: 7, title: 'Хакатон NU', date: '2030-03-01T10:00:00Z', location: 'Астана',
    status: 'draft', capacity: 50, tickets_issued: 12,
  }]);
  assert.equal(statusLabel.draft, 'Черновик');
});

test('rejects a malformed or unknown-status list instead of drawing garbage', () => {
  for (const payload of [null, {}, [{ ...event, id: 0 }], [{ ...event, status: 'archived' }], [{ ...event, tickets_issued: '12' }]]) {
    assert.throws(() => readOrganizerEvents(payload), (error) => error instanceof ApiError && error.kind === 'response');
  }
});

test('only organizers may use the dashboard', () => {
  assert.equal(canUseOrganizerPage('organizer'), true);
  for (const role of ['attendee', 'admin', undefined]) 
    assert.equal(canUseOrganizerPage(role), false);
});

test('return destination accepts /organizer exactly and nothing under it', () => {
  assert.equal(safeReturnTo('/organizer'), '/organizer');
  assert.equal(safeReturnTo('/organizer/'), '/organizer/');
  assert.equal(safeReturnTo('/organizer/5'), '/events');
  assert.equal(safeReturnTo('/tickets/3'), '/tickets/3');
});