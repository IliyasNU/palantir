import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApi, type ScanRequest } from '../src/api.ts';
import { createScanSession } from '../src/scanner.ts';

const base = 'https://biletflow.example';
const token = 'test-access';
const eventId = 7;
const counts = { event_id: eventId, capacity: 100, tickets_issued: 30, checked_in: 25 };
const arrivedAt = '2026-11-08T09:15:00Z';
const attendee = {
  ticket_id: 21,
  full_name: 'Тестовый Посетитель',
  masked_email: 'vi***@example.com',
  status: 'active',
  checked_in_at: null,
  check_in_id: null,
  qr_payload: 'biletflow:ticket:v1:fixture+/_-',
};

const reply = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });
const hasCode = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('attendance fetches the selected event counts with the staff bearer token', async () => {
  const api = createApi(base, async (url, options) => {
    assert.equal(url, `${base}/events/7/attendance`);
    assert.equal(options?.method, 'GET');
    assert.equal(options?.body, undefined);
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
    return Response.json(counts);
  });
  assert.deepEqual(await api.attendance(token, eventId), counts);
  const empty = { ...counts, tickets_issued: 0, checked_in: 0 };
  assert.deepEqual(await createApi(base, reply(empty)).attendance(token, eventId), empty);
});

test('attendance rejects malformed and inconsistent counts instead of showing false totals', async () => {
  for (const body of [null, [], {}, { ...counts, event_id: 8 }, { ...counts, capacity: 0 },
    { ...counts, checked_in: -1 }, { ...counts, tickets_issued: 30.5 }, { ...counts, checked_in: '25' },
    { ...counts, checked_in: 31 }, { ...counts, tickets_issued: 101 }]) {
    await assert.rejects(createApi(base, reply(body)).attendance(token, eventId), hasCode('SERVER_ERROR'));
  }
});

test('search encodes the full trimmed query and reads both new and checked-in tickets', async () => {
  const arrived = { ...attendee, ticket_id: 22, checked_in_at: arrivedAt, check_in_id: 90 };
  const api = createApi(base, async (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, base);
    assert.equal(target.pathname, '/events/7/attendees');
    assert.deepEqual([...target.searchParams], [['q', 'Ай +&? #@example.com']]);
    assert.equal(options?.method, 'GET');
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
    return Response.json([attendee, arrived]);
  });
  assert.deepEqual(await api.attendees(token, eventId, ' Ай +&? #@example.com '), [attendee, arrived]);
  assert.deepEqual(await createApi(base, reply([])).attendees(token, eventId, 'none'), []);
});

test('search with fewer than three trimmed characters makes no request', async () => {
  let requests = 0;
  const api = createApi(base, async () => { requests++; return Response.json([]); });
  for (const term of ['', '  ', ' аб ', '😀x']) {
    await assert.rejects(api.attendees(token, eventId, term), hasCode('QUERY_TOO_SHORT'));
  }
  assert.equal(requests, 0);
  assert.deepEqual(await api.attendees(token, eventId, ' абв '), []);
  assert.equal(requests, 1);
});

test('search rejects a bad response instead of offering a check-in for an invalid row', async () => {
  for (const body of [null, { attendees: [] }, [null], [{ ...attendee, ticket_id: 0 }],
    [{ ...attendee, full_name: null }], [{ ...attendee, masked_email: 123 }],
    [{ ...attendee, masked_email: undefined, email: 'unmasked@example.com' }], [{ ...attendee, checked_in_at: undefined }],
    [{ ...attendee, checked_in_at: 'yesterday' }], [{ ...attendee, qr_payload: '' }],
    [{ ...attendee, qr_payload: 'x'.repeat(513) }], Array.from({ length: 21 }, (_, i) => ({ ...attendee, ticket_id: i + 1 }))]) {
    await assert.rejects(createApi(base, reply(body)).attendees(token, eventId, 'тест'), hasCode('SERVER_ERROR'));
  }
});

test('attendance and search preserve authorization and distinguish missing events from missing routes', async () => {
  for (const [status, detail, expected] of [
    [401, 'Not authenticated', 'UNAUTHORIZED'],
    [403, { code: 'FORBIDDEN', message: 'Access denied' }, 'FORBIDDEN'],
    [404, { code: 'EVENT_NOT_FOUND', message: 'Unknown event' }, 'EVENT_NOT_FOUND'],
    [404, 'Not Found', 'NOT_AVAILABLE'],
  ] as const) {
    const api = createApi(base, reply({ detail }, status));
    await assert.rejects(api.attendance(token, eventId), { code: expected, status });
    await assert.rejects(api.attendees(token, eventId, 'visitor'), { code: expected, status });
  }
});

test('attendee search preserves QUERY_TOO_SHORT from the real API contract', async () => {
  const api = createApi(base, reply({ detail: { code: 'QUERY_TOO_SHORT', message: 'Search query is too short' } }, 422));
  await assert.rejects(api.attendees(token, eventId, '\u0085ab\u0085'), { code: 'QUERY_TOO_SHORT', status: 422 });
});

test('a manual mark and a QR scan use the same check-in path and the manual retry preserves its request ID', async () => {
  const posts: { path: string; authorization: string | null; request: ScanRequest }[] = [];
  const api = createApi(base, async (input, options) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/events/7/attendees') return Response.json([attendee]);
    assert.equal(options?.method, 'POST');
    const request = JSON.parse(String(options?.body)) as ScanRequest;
    posts.push({ path: pathname, authorization: new Headers(options?.headers).get('Authorization'), request });
    if (posts.length === 1) throw new TypeError('response lost');
    if (posts.length === 3) return Response.json({ detail: { code: 'ALREADY_CHECKED_IN' } }, { status: 409 });
    return Response.json({ status: 'CHECKED_IN', event_id: eventId, ticket_id: attendee.ticket_id,
      request_id: request.request_id, checked_in_at: arrivedAt });
  });
  const [match] = await api.attendees(token, eventId, 'тест');
  let issuedIds = 0;
  const scanSession = createScanSession((access, body) => api.checkIn(access, eventId, body),
    () => `01000000-0000-4000-8000-00000000000${++issuedIds}`);
  scanSession.setToken(token);
  const { scanner } = scanSession;

  assert.equal((await scanner.scan(match.qr_payload))?.error?.code, 'NETWORK_ERROR');
  assert.equal(scanner.next(), false);
  assert.equal(scanner.scan(match.qr_payload), null);
  assert.equal((await scanner.retry())?.receipt?.checked_in_at, arrivedAt);
  assert.equal(scanner.next(), true);
  assert.equal((await scanner.scan(attendee.qr_payload))?.error?.code, 'ALREADY_CHECKED_IN');

  assert.equal(posts.length, 3);
  assert.ok(posts.every(post => post.path === '/events/7/check-in' && post.authorization === `Bearer ${token}`));
  assert.ok(posts.every(post => post.request.qr_payload === attendee.qr_payload));
  assert.deepEqual(posts[1].request, posts[0].request);
  assert.notEqual(posts[2].request.request_id, posts[0].request.request_id);
});
