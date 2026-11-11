import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, apiAddress, createApi } from '../src/api.ts';

const base = 'https://biletflow.example';
const scan = { qr_payload: 'biletflow:ticket:v1:test-token', request_id: 'request-1' };
const receipt = { status: 'CHECKED_IN', event_id: 7, ticket_id: 21, request_id: scan.request_id, checked_in_at: '2026-10-28T12:00:00Z' };
const reply = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('connection check requires both the real API and database to be healthy', async () => {
  const api = createApi(base, async (url, options) => {
    assert.equal(url, base + '/health');
    assert.equal(options?.method, 'GET');
    assert.equal(options?.body, undefined);
    assert.equal(new Headers(options?.headers).get('Authorization'), null);
    return Response.json({ status: 'ok', database: 'up' });
  });
  await api.health();
  for (const body of [null, {}, { status: 'ok' }, { status: 'degraded', database: 'down' }, { status: 'ok', database: 'down' }]) {
    await assert.rejects(createApi(base, reply(body)).health(), code('SERVER_ERROR'));
  }
  await assert.rejects(createApi(base, reply({ status: 'ok', database: 'up' }, 503)).health(), code('SERVER_ERROR'));
  await assert.rejects(createApi(base, async () => { throw new TypeError('offline'); }).health(), code('NETWORK_ERROR'));
});

test('login confirms account identity with the issued token', async () => {
  const api = createApi(base, async (url, options) => {
    if (url === base + '/auth/me') {
      assert.equal(options?.method, 'GET');
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer access');
      return Response.json({ id: 42 });
    }
    assert.equal(url, base + '/auth/login');
    assert.equal(options?.method, 'POST');
    assert.equal(new Headers(options?.headers).get('Authorization'), null);
    assert.deepEqual(JSON.parse(String(options?.body)), { email: 'staff@example.com', password: 'test-password' });
    return Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'bearer' });
  });
  assert.deepEqual(await api.login(' staff@example.com ', 'test-password'), { token: 'access', userId: 42 });
  assert.deepEqual(await api.login('staff@example.com', 'test-password', 42), { token: 'access', userId: 42 });
});

test('login does not expose a session for a different or unidentified account', async () => {
  for (const [user, expected] of [[{ id: 43 }, 'ACCOUNT_MISMATCH'], [{ id: '42' }, 'SERVER_ERROR']] as const) {
    const api = createApi(base, async url => Response.json(url === base + '/auth/me' ? user : { access_token: 'new' }));
    await assert.rejects(api.login('staff@example.com', 'test-password', 42), code(expected));
  }
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
    [404, 'EVENT_NOT_FOUND', 'EVENT_NOT_FOUND'],
    [409, 'EVENT_CANCELLED', 'EVENT_CANCELLED'],
    [409, 'EVENT_NOT_PUBLISHED', 'EVENT_NOT_PUBLISHED'],
    [409, 'REQUEST_ID_CONFLICT', 'REQUEST_ID_CONFLICT'],
    [422, 'INVALID_INPUT', 'INVALID_INPUT'],
    [401, '', 'UNAUTHORIZED'],
    [403, '', 'FORBIDDEN'],
    [501, '', 'SERVER_ERROR'],
    [503, '', 'SERVER_ERROR'],
  ] as const) {
    const api = createApi(base, reply({ detail: { code: serverCode } }, status));
    await assert.rejects(api.checkIn('access', 7, scan), code(expected));
  }
});

test('validation errors are readable even when FastAPI returns a list of fields', async () => {
  const api = createApi(base, reply({ detail: [{ loc: ['body', 'qr_payload'], msg: 'String too long' }] }, 422));
  await assert.rejects(api.checkIn('access', 7, scan), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'INVALID_INPUT');
    assert.match(error.message, /request format/);
    return true;
  });
});

test('staff events distinguish expired authentication from forbidden access', async () => {
  for (const detail of ['Access denied', { code: 'UNAUTHORIZED', message: 'Access denied' }]) {
    for (const status of [401, 403]) {
      const api = createApi(base, reply({ detail }, status));
      await assert.rejects(api.events('access'), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, status);
        assert.equal(error.code, status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN');
        assert.match(error.message, status === 401 ? /Sign in again/ : /organizer/);
        return true;
      });
    }
  }
});

test('a forbidden check-in never returns an admission receipt', async () => {
  const api = createApi(base, reply(receipt, 403));
  await assert.rejects(api.checkIn('access', 7, scan), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'FORBIDDEN');
    return true;
  });
});

test('all server failures stay unconfirmed even when the body claims success', async () => {
  for (const status of [500, 501, 502, 503, 504]) {
    await assert.rejects(createApi(base, reply(receipt, status)).checkIn('access', 7, scan), code('SERVER_ERROR'));
  }
});

test('a malformed event list is an error instead of an empty assignment', async () => {
  const event = { id: 7, title: 'Event', date: '2026-11-03T12:00:00Z', location: 'Hall' };
  for (const body of [null, {}, { events: [] }, [null], [{ ...event, id: 0 }], [{ ...event, date: 'invalid' }]]) {
    await assert.rejects(createApi(base, reply(body)).events('access'), code('SERVER_ERROR'));
  }
  assert.deepEqual(await createApi(base, reply([event])).events('access'), [event]);
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
  for (const address of ['', 'localhost:8000', 'http://localhost:8000', 'http://127.0.0.1:8000', 'https://user:password@example.com',
    'https://example.com/api?', 'https://example.com/api#', 'https://example.com/api?q=1', 'https://example.com/api#section']) {
    assert.throws(() => apiAddress(address), code('CONFIG_ERROR'));
  }
  assert.equal(apiAddress('http://192.168.1.100:8000/'), 'http://192.168.1.100:8000');
  assert.equal(apiAddress('https://example.com/api/'), 'https://example.com/api');
});
