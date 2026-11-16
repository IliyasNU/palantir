import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApi } from '../src/api.ts';
import { BATCH, QUEUE_LIMIT, createOfflineQueue, queueFor, type QueuedScan, type SyncItem } from '../src/offline.ts';

function ids() {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
}
const at = () => new Date('2030-06-01T10:00:00Z');
const accept = (scans: QueuedScan[]): SyncItem[] => scans.map(scan => ({ client_scan_id: scan.client_scan_id, result: 'accepted',
  ticket_id: 1, checked_in_at: '2030-06-01T10:05:00Z' }));

test('a scan is queued once with its own id and the time it was scanned', () => {
  const queue = createOfflineQueue(ids(), at);
  assert.equal(queue.add('ticket-a'), 'queued');
  assert.equal(queue.add('ticket-a'), 'duplicate');
  assert.equal(queue.add(''), 'invalid');
  assert.equal(queue.add('x'.repeat(513)), 'invalid');
  assert.equal(queue.add('ticket-b'), 'queued');
  assert.deepEqual(queue.items(), [
    { client_scan_id: '00000000-0000-4000-8000-000000000001', qr_payload: 'ticket-a', scanned_at: '2030-06-01T10:00:00.000Z' },
    { client_scan_id: '00000000-0000-4000-8000-000000000002', qr_payload: 'ticket-b', scanned_at: '2030-06-01T10:00:00.000Z' }]);
  const full = createOfflineQueue(ids(), at);
  for (let index = 0; index < QUEUE_LIMIT; index += 1) assert.equal(full.add(`ticket-${index}`), 'queued');
  assert.equal(full.add('one-more'), 'full');
});

test('a sync empties the queue in batches, in the order scanned, and reports conflicts and refusals', async () => {
  const queue = createOfflineQueue(ids(), at);
  for (let index = 0; index < BATCH + 3; index += 1) queue.add(`ticket-${index}`);
  const batches: number[] = [];
  const outcome = await queue.sync(async scans => {
    batches.push(scans.length);
    return scans.map((scan): SyncItem => scan.qr_payload === 'ticket-1'
      ? { client_scan_id: scan.client_scan_id, result: 'conflict', code: 'ALREADY_CHECKED_IN', conflict: { checked_in_at: '2030-06-01T09:59:00Z', staff_name: 'Other staff' } }
      : scan.qr_payload === 'ticket-101' ? { client_scan_id: scan.client_scan_id, result: 'rejected', code: 'TICKET_CANCELLED' }
        : { client_scan_id: scan.client_scan_id, result: 'accepted', ticket_id: 1, checked_in_at: '2030-06-01T10:05:00Z' });
  });
  assert.deepEqual(batches, [BATCH, 3]);
  assert.equal(outcome?.accepted, BATCH + 1);
  assert.deepEqual(outcome?.conflicts, [{ qr_payload: 'ticket-1', scanned_at: '2030-06-01T10:00:00.000Z', code: 'ALREADY_CHECKED_IN',
    conflict: { checked_in_at: '2030-06-01T09:59:00Z', staff_name: 'Other staff' } }]);
  assert.deepEqual(outcome?.rejected, [{ qr_payload: 'ticket-101', scanned_at: '2030-06-01T10:00:00.000Z', code: 'TICKET_CANCELLED' }]);
  assert.equal(outcome?.error, undefined);
  assert.equal(queue.size(), 0);
});

test('a lost connection keeps the unsent scans with the same ids, so the next sync is a safe repeat', async () => {
  const queue = createOfflineQueue(ids(), at);
  for (let index = 0; index < BATCH + 2; index += 1) queue.add(`ticket-${index}`);
  const before = queue.items().slice(BATCH).map(scan => scan.client_scan_id);
  let calls = 0;
  const failed = await queue.sync(async scans => {
    calls += 1;
    if (calls === 2) throw new ApiError('NETWORK_ERROR', 'offline');
    return accept(scans);
  });
  assert.equal(failed?.accepted, BATCH);
  assert.equal(failed?.error?.code, 'NETWORK_ERROR');
  assert.deepEqual(queue.items().map(scan => scan.client_scan_id), before);
  const sent: string[] = [];
  const done = await queue.sync(async scans => { sent.push(...scans.map(scan => scan.client_scan_id)); return accept(scans); });
  assert.deepEqual(sent, before);
  assert.equal(done?.accepted, 2);
  assert.equal(queue.size(), 0);
});

test('an incomplete answer is no answer: nothing leaves the queue', async () => {
  const queue = createOfflineQueue(ids(), at);
  queue.add('ticket-a');
  queue.add('ticket-b');
  const outcome = await queue.sync(async scans => accept(scans.slice(0, 1)));
  assert.equal(outcome?.error?.code, 'SERVER_ERROR');
  assert.equal(outcome?.accepted, 1); // counted, but the batch stays queued and is repeated with the same ids
  assert.equal(queue.size(), 2);
});

test('only one sync runs at a time, and each account and event has its own queue', async () => {
  const queue = createOfflineQueue(ids(), at);
  queue.add('ticket-a');
  let release: (items: SyncItem[]) => void = () => {};
  const first = queue.sync(scans => new Promise<SyncItem[]>(resolve => { release = () => resolve(accept(scans)); }));
  assert.equal(queue.busy(), true);
  assert.equal(await queue.sync(async scans => accept(scans)), null);
  release([]);
  assert.equal((await first)?.accepted, 1);
  assert.equal(queue.busy(), false);
  const newId = ids();
  assert.equal(queueFor(7, 1, newId), queueFor(7, 1, newId));
  assert.notEqual(queueFor(7, 1, newId), queueFor(7, 2, newId));
  assert.notEqual(queueFor(7, 1, newId), queueFor(8, 1, newId));
});

test('the API client accepts only a complete, ordered sync answer', async () => {
  const scans = [{ client_scan_id: 'a', qr_payload: 'ticket-a', scanned_at: '2030-06-01T10:00:00.000Z' },
    { client_scan_id: 'b', qr_payload: 'ticket-b', scanned_at: '2030-06-01T10:00:01.000Z' }];
  const answer = (results: unknown, eventId = 5) => createApi('https://api.example.test', async (url, init) => {
    assert.equal(String(url), 'https://api.example.test/events/5/check-in/sync');
    assert.deepEqual(JSON.parse(String(init?.body)), { scans });
    return new Response(JSON.stringify({ event_id: eventId, accepted: 1, conflicts: 1, rejected: 0, results }), { status: 200 });
  }).syncScans('token', 5, scans);
  const good = [{ client_scan_id: 'a', result: 'accepted', code: null, ticket_id: 3, check_in_id: 9, checked_in_at: '2030-06-01T10:05:00Z', conflict: null },
    { client_scan_id: 'b', result: 'conflict', code: 'ALREADY_CHECKED_IN', ticket_id: null, check_in_id: null, checked_in_at: null,
      conflict: { checked_in_at: '2030-06-01T09:00:00Z', staff_name: 'Other' } }];
  assert.deepEqual(await answer(good), [{ client_scan_id: 'a', result: 'accepted', ticket_id: 3, checked_in_at: '2030-06-01T10:05:00Z' },
    { client_scan_id: 'b', result: 'conflict', code: 'ALREADY_CHECKED_IN', conflict: { checked_in_at: '2030-06-01T09:00:00Z', staff_name: 'Other' } }]);
  for (const broken of [good.slice(0, 1), [good[1], good[0]], [{ ...good[0], result: 'ok' }, good[1]], [{ ...good[0], ticket_id: null }, good[1]],
    [good[0], { ...good[1], code: null }], 'nothing']) {
    await assert.rejects(answer(broken), (error: unknown) => error instanceof ApiError && error.code === 'SERVER_ERROR');
  }
  await assert.rejects(answer(good, 6), (error: unknown) => error instanceof ApiError && error.code === 'SERVER_ERROR');
});
