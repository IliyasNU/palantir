import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApi, type Receipt, type ScanRequest } from '../src/api.ts';
import { createScanner, createScanSession } from '../src/scanner.ts';

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


test('Scan next cannot discard an unconfirmed request', async () => {
  const requests: ScanRequest[] = [];
  let ids = 0;
  const scanner = createScanner(async request => {
    requests.push({ ...request });
    if (requests.length === 1) throw new ApiError('NETWORK_ERROR', 'lost');
    return receipt;
  }, () => `request-${++ids}`);
  await scanner.scan('ticket');
  assert.equal(scanner.mustResolve(), true);
  assert.equal(scanner.next(), false);
  assert.equal(scanner.scan('another-ticket'), null);
  await scanner.retry();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(ids, 1);
  assert.equal(scanner.mustResolve(), false);
  assert.equal(scanner.next(), true);
});

test('403 after a lost response preserves uncertainty and the old request', async () => {
  let calls = 0;
  const scanner = createScanner(async () => {
    calls++;
    throw calls === 1
      ? new ApiError('NETWORK_ERROR', 'lost')
      : new ApiError('FORBIDDEN', 'revoked', 403);
  }, () => 'request-1');
  await scanner.scan('ticket');
  await scanner.retry();
  assert.equal(scanner.next(), false);
  assert.equal(scanner.mustResolve(), true);
});

test('first-request forbidden rejection permits leaving without admission', async () => {
  const scanner = createScanner(async () => {
    throw new ApiError('FORBIDDEN', 'denied', 403);
  }, () => 'request-1');
  const result = await scanner.scan('ticket');
  assert.equal(result?.receipt, undefined);
  assert.equal(scanner.mustResolve(), false);
  assert.equal(scanner.next(), true);
});

test('only the original staff account can resume a pending scan after reauthentication', async () => {
  const sent: { token: string; request: ScanRequest }[] = [];
  const api = createApi('https://biletflow.example', async (url, options) => {
    if (String(url).endsWith('/auth/login')) {
      const { email } = JSON.parse(String(options?.body));
      return Response.json({ access_token: email === 'other@example.com' ? 'other-token' : 'new-token' });
    }
    assert.ok(String(url).endsWith('/auth/me'));
    const auth = new Headers(options?.headers).get('Authorization');
    return Response.json({ id: auth === 'Bearer other-token' ? 43 : 42 });
  });
  const session = createScanSession(async (token, request) => {
    sent.push({ token, request: { ...request } });
    if (sent.length === 1) throw new ApiError('NETWORK_ERROR', 'lost');
    if (sent.length === 2) throw new ApiError('UNAUTHORIZED', 'expired', 401);
    return receipt;
  }, () => 'request-1');
  async function resume(email: string) {
    const freshSession = await api.login(email, 'password', 42);
    session.setToken(freshSession.token);
    return session.scanner.retry();
  }

  session.setToken('old-token');
  await session.scanner.scan('ticket');
  assert.equal((await session.scanner.retry())?.error?.status, 401);
  await assert.rejects(resume('other@example.com'), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(sent.length, 2);
  assert.equal(session.scanner.mustResolve(), true);
  assert.deepEqual(await resume('staff@example.com'), { receipt });
  assert.deepEqual(sent.map(item => item.token), ['old-token', 'old-token', 'new-token']);
  assert.deepEqual(sent[0].request, sent[2].request);
});

test('a duplicate response after a lost response does not establish the original outcome', async () => {
  let calls = 0;
  const scanner = createScanner(async () => {
    if (++calls === 1) throw new ApiError('NETWORK_ERROR', 'lost');
    throw new ApiError('ALREADY_CHECKED_IN', 'used', 409);
  }, () => 'request-1');
  await scanner.scan('ticket');
  await scanner.retry();
  assert.equal(scanner.mustResolve(), true);
  assert.equal(scanner.next(), false);
});

test('a request ID conflict after a lost response keeps the original scan blocked', async () => {
  const sent: ScanRequest[] = [];
  const scanner = createScanner(async request => {
    sent.push(request);
    if (sent.length === 1) throw new ApiError('NETWORK_ERROR', 'lost');
    throw new ApiError('REQUEST_ID_CONFLICT', 'conflict', 409);
  }, () => 'request-1');
  await scanner.scan('ticket');
  const result = await scanner.retry();
  assert.equal(result?.error?.code, 'REQUEST_ID_CONFLICT');
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(scanner.mustResolve(), true);
  assert.equal(scanner.next(), false);
});
