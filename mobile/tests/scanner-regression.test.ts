import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApi, type Receipt, type ScanRequest } from '../src/api.ts';
import { createScanner, createScanSession } from '../src/scanner.ts';

function receiptFor(request: ScanRequest): Receipt {
  return {
    status: 'CHECKED_IN', event_id: 7, ticket_id: 21,
    request_id: request.request_id, checked_in_at: '2026-11-09T12:00:00Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('rapid retries keep one in-flight request and block a different ticket until the retry finishes', async () => {
  const sent: ScanRequest[] = [];
  const response = deferred<Receipt>();
  let ids = 0;
  const scanner = createScanner(request => {
    sent.push({ ...request });
    if (sent.length === 1) return Promise.reject(new ApiError('NETWORK_ERROR', 'lost response'));
    return response.promise;
  }, () => `request-${++ids}`);

  await scanner.scan('first-ticket');
  const retry = scanner.retry();
  assert.ok(retry);
  for (let press = 0; press < 10; press++) {
    assert.equal(scanner.retry(), null);
    assert.equal(scanner.scan('different-ticket'), null);
    assert.equal(scanner.next(), false);
  }
  assert.equal(scanner.mustResolve(), true);
  assert.deepEqual(sent, [sent[0], sent[0]]);
  assert.equal(ids, 1);

  response.resolve(receiptFor(sent[0]));
  assert.deepEqual(await retry, { receipt: receiptFor(sent[0]) });
  assert.equal(scanner.mustResolve(), false);
  assert.equal(scanner.next(), true);
});

test('event and ticket rejections after uncertainty preserve the original unresolved attempt', async context => {
  const rejections = [
    { code: 'INVALID_TICKET', status: 404 },
    { code: 'EVENT_NOT_FOUND', status: 404 },
    { code: 'EVENT_CANCELLED', status: 409 },
    { code: 'EVENT_NOT_PUBLISHED', status: 409 },
  ];
  for (const uncertain of ['NETWORK_ERROR', 'SERVER_ERROR']) {
    for (const rejection of rejections) {
      await context.test(`${uncertain} then ${rejection.code}`, async () => {
        const sent: ScanRequest[] = [];
        const scanner = createScanner(async request => {
          sent.push({ ...request });
          if (sent.length === 1) throw new ApiError(uncertain, 'unconfirmed');
          throw new ApiError(rejection.code, 'rejected', rejection.status);
        }, () => 'original-request');

        await scanner.scan('original-ticket');
        const result = await scanner.retry();
        assert.equal(result?.error?.code, rejection.code);
        assert.equal(result?.receipt, undefined);
        assert.equal(scanner.requestId(), 'original-request');
        assert.equal(scanner.mustResolve(), true);
        assert.equal(scanner.next(), false);
        assert.equal(scanner.scan('different-ticket'), null);
        assert.deepEqual(sent[1], sent[0]);
      });
    }
  }
});

test('malformed successful HTTP responses stay unresolved through the real API and scanner composition', async context => {
  const invalidReceipts = [
    { name: 'missing receipt', change: (_receipt: Receipt) => null },
    { name: 'different event', change: (receipt: Receipt) => ({ ...receipt, event_id: 8 }) },
    { name: 'different request', change: (receipt: Receipt) => ({ ...receipt, request_id: 'another-request' }) },
    // Negative receipt fixtures, not proposed cancellation/refund API codes.
    { name: 'cancelled state is not an admission', change: (receipt: Receipt) => ({ ...receipt, status: 'cancelled' }) },
    { name: 'refunded state is not an admission', change: (receipt: Receipt) => ({ ...receipt, status: 'refunded' }) },
  ];
  for (const invalid of invalidReceipts) {
    await context.test(invalid.name, async () => {
      const sent: ScanRequest[] = [];
      const api = createApi('https://biletflow.example', async (url, options) => {
        assert.equal(url, 'https://biletflow.example/events/7/check-in');
        assert.equal(options?.method, 'POST');
        assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer staff-token');
        const request = JSON.parse(String(options?.body)) as ScanRequest;
        sent.push(request);
        const receipt = receiptFor(request);
        return Response.json(sent.length === 1 ? invalid.change(receipt) : receipt);
      });
      const session = createScanSession((token, request) => api.checkIn(token, 7, request), () => 'original-request');
      session.setToken('staff-token');
      const { scanner } = session;

      const first = await scanner.scan('ticket');
      assert.equal(first?.error?.code, 'SERVER_ERROR');
      assert.equal(first?.receipt, undefined);
      assert.equal(scanner.mustResolve(), true);
      assert.equal(scanner.next(), false);
      assert.equal(scanner.scan('different-ticket'), null);

      assert.deepEqual(await scanner.retry(), { receipt: receiptFor(sent[0]) });
      assert.deepEqual(sent[1], sent[0]);
      assert.equal(scanner.mustResolve(), false);
      assert.equal(scanner.next(), true);
    });
  }
});

test('synchronous and untyped send failures release the busy lock but retain an uncertain request', async context => {
  for (const failure of [new Error('transport failed'), undefined]) {
    await context.test(failure instanceof Error ? 'synchronous Error' : 'untyped rejection', async () => {
      const sent: ScanRequest[] = [];
      const scanner = createScanner(request => {
        sent.push({ ...request });
        if (sent.length === 1) {
          if (failure instanceof Error) throw failure;
          return Promise.reject(failure);
        }
        return Promise.resolve(receiptFor(request));
      }, () => 'original-request');

      const result = await scanner.scan('ticket');
      assert.equal(result?.error?.code, 'SERVER_ERROR');
      assert.equal(result?.receipt, undefined);
      assert.equal(scanner.mustResolve(), true);
      assert.equal(scanner.next(), false);
      assert.deepEqual(await scanner.retry(), { receipt: receiptFor(sent[0]) });
      assert.deepEqual(sent[1], sent[0]);
      assert.equal(scanner.next(), true);
    });
  }
});

test('token refresh during an in-flight retry only affects the following retry of the same request', async () => {
  const sent: { token: string; request: ScanRequest }[] = [];
  const expiredResponse = deferred<Receipt>();
  let ids = 0;
  const session = createScanSession((token, request) => {
    sent.push({ token, request: { ...request } });
    if (sent.length === 1) return Promise.reject(new ApiError('NETWORK_ERROR', 'lost response'));
    if (sent.length === 2) return expiredResponse.promise;
    return Promise.resolve(receiptFor(request));
  }, () => `request-${++ids}`);
  session.setToken('old-token');
  const { scanner } = session;
  await scanner.scan('ticket');
  const retry = scanner.retry();
  session.setToken('fresh-token');
  assert.equal(scanner.retry(), null);
  assert.equal(scanner.scan('different-ticket'), null);
  assert.equal(sent[1].token, 'old-token');

  expiredResponse.reject(new ApiError('UNAUTHORIZED', 'expired', 401));
  assert.equal((await retry)?.error?.status, 401);
  assert.equal(scanner.mustResolve(), true);
  assert.equal(scanner.next(), false);
  assert.deepEqual(await scanner.retry(), { receipt: receiptFor(sent[0].request) });
  assert.deepEqual(sent.map(item => item.token), ['old-token', 'old-token', 'fresh-token']);
  assert.deepEqual(sent.map(item => item.request), [sent[0].request, sent[0].request, sent[0].request]);
  assert.equal(ids, 1);
  assert.equal(scanner.next(), true);
});

test('an invalid-ticket response for a campaign URL cannot become a successful admission', async () => {
  const payload = 'https://biletflow.example/events/7?campaign=opaque-test-token';
  const sent: ScanRequest[] = [];
  const api = createApi('https://biletflow.example', async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)) as ScanRequest);
    return Response.json({ detail: { code: 'INVALID_TICKET', message: 'Unknown ticket' } }, { status: 404 });
  });
  const session = createScanSession((token, request) => api.checkIn(token, 7, request), () => 'campaign-request');
  session.setToken('staff-token');
  const result = await session.scanner.scan(payload);
  assert.equal(result?.error?.code, 'INVALID_TICKET');
  assert.equal(result?.receipt, undefined);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].qr_payload, payload);
  assert.equal(session.scanner.mustResolve(), false);
  assert.equal(session.scanner.next(), true);
});
