import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, apiAddress, createApi } from '../src/api.ts';

const base = 'https://biletflow.example';
const scan = { qr_payload: 'biletflow:ticket:v1:test-token', request_id: 'request-1' };
const receipt = { status: 'CHECKED_IN', event_id: 7, ticket_id: 21, request_id: scan.request_id, checked_in_at: '2026-10-28T12:00:00Z' };
const reply = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('login uses the existing JSON endpoint and does not send an auth header', async () => {
  const api = createApi(base, async (url, options) => {
    assert.equal(url, base + '/auth/login');
    assert.equal(options?.method, 'POST');
    assert.equal(new Headers(options?.headers).get('Authorization'), null);
    assert.deepEqual(JSON.parse(String(options?.body)), { email: 'staff@example.com', password: 'test-password' });
    return Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'bearer' });
  });
  assert.equal(await api.login(' staff@example.com ', 'test-password'), 'access');
});

test('event list sends the access token; an empty assignment is allowed', async () => {
  const api = createApi(base, async (url, options) => {
    assert.equal(url, base + '/staff/events');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer access');
    return Response.json([]);
  });
  assert.deepEqual(await api.events('access'), []);
});

test('a missing staff endpoint is not shown as an empty event list', async () => {
  await assert.rejects(createApi(base, reply({ detail: 'Not Found' }, 404)).events('access'), code('NOT_AVAILABLE'));
});

test('check-in sends the selected event, QR and request ID, then verifies the receipt', async () => {
  const api = createApi(base, async (url, options) => {
    assert.equal(url, base + '/events/7/check-in');
    assert.deepEqual(JSON.parse(String(options?.body)), scan);
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer access');
    return Response.json(receipt);
  });
  assert.deepEqual(await api.checkIn('access', 7, scan), receipt);
});

test('HTTP errors distinguish duplicate, invalid ticket and access problems', async () => {
  for (const [status, serverCode, expected] of [
    [409, 'ALREADY_CHECKED_IN', 'ALREADY_CHECKED_IN'],
    [404, 'INVALID_TICKET', 'INVALID_TICKET'],
    [401, '', 'UNAUTHORIZED'],
    [403, '', 'UNAUTHORIZED'],
    [503, '', 'SERVER_ERROR'],
  ] as const) {
    const api = createApi(base, reply({ detail: { code: serverCode } }, status));
    await assert.rejects(api.checkIn('access', 7, scan), code(expected));
  }
});

test('a 2xx response with missing or mismatched receipt data is never success', async () => {
  for (const body of [null, {}, { ...receipt, status: 'INVALID_TICKET' }, { ...receipt, event_id: 8 },
    { ...receipt, request_id: 'another-request' }, { ...receipt, checked_in_at: 'not-a-date' }]) {
    await assert.rejects(createApi(base, reply(body)).checkIn('access', 7, scan), code('SERVER_ERROR'));
  }
});

test('disconnection and timeout leave check-in unconfirmed', async () => {
  const offline: typeof fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(createApi(base, offline).checkIn('access', 7, scan), code('NETWORK_ERROR'));
  const stalled: typeof fetch = (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(createApi(base, stalled, 10).checkIn('access', 7, scan), code('NETWORK_ERROR'));
});

test('configuration requires a reachable backend address instead of phone localhost', () => {
  for (const address of ['', 'localhost:8000', 'http://localhost:8000', 'http://127.0.0.1:8000', 'https://user:password@example.com']) {
    assert.throws(() => apiAddress(address), code('CONFIG_ERROR'));
  }
  assert.equal(apiAddress('http://192.168.1.100:8000/'), 'http://192.168.1.100:8000');
  assert.equal(apiAddress('https://example.com/api/'), 'https://example.com/api');
});
