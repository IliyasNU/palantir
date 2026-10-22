import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type Receipt, type ScanRequest } from '../src/api.ts';
import { createScanner } from '../src/scanner.ts';

const receipt: Receipt = { status: 'CHECKED_IN', event_id: 7, ticket_id: 21, request_id: 'request-1', checked_in_at: '2026-10-28T12:00:00Z' };

test('20 camera callbacks send one request and remain locked until Scan next', async () => {
  let calls = 0;
  let finish!: (value: Receipt) => void;
  const scanner = createScanner(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, () => 'request-1');
  const first = scanner.scan('ticket');
  for (let i = 1; i < 20; i++) assert.equal(scanner.scan('ticket'), null);
  scanner.next(); // Cannot unlock while the server is still processing.
  assert.equal(scanner.scan('another-ticket'), null);
  assert.equal(scanner.retry(), null);
  assert.equal(calls, 1);
  finish(receipt);
  assert.deepEqual(await first, { receipt });
  assert.equal(scanner.scan('ticket'), null);
});

test('retry after a lost response keeps the same QR and request ID', async () => {
  const requests: ScanRequest[] = [];
  let ids = 0;
  const scanner = createScanner(async request => {
    requests.push({ ...request });
    if (requests.length === 1) throw new ApiError('NETWORK_ERROR', 'response lost');
    return receipt;
  }, () => `request-${++ids}`);
  assert.equal((await scanner.scan('ticket'))?.error?.code, 'NETWORK_ERROR');
  assert.deepEqual(await scanner.retry(), { receipt });
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(ids, 1);
});

test('an intentional rescan starts a new request and displays the backend duplicate error', async () => {
  let ids = 0;
  const requests: ScanRequest[] = [];
  const scanner = createScanner(async request => {
    requests.push(request);
    if (requests.length > 1) throw new ApiError('ALREADY_CHECKED_IN', 'Ticket used', 409);
    return receipt;
  }, () => `request-${++ids}`);
  await scanner.scan('ticket');
  scanner.next();
  const result = await scanner.scan('ticket');
  assert.equal(result?.error?.code, 'ALREADY_CHECKED_IN');
  assert.equal(result?.receipt, undefined);
  assert.notEqual(requests[0].request_id, requests[1].request_id);
});
