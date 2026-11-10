import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApi, type ScanRequest } from '../src/api.ts';
import { emptyLoad, loadFailed, loadSucceeded, loadView } from '../src/loading.ts';
import { errorMessage, messages, type Locale } from '../src/messages.ts';
import { createScanner, createUndo, createUndoSession } from '../src/scanner.ts';

const base = 'https://biletflow.example';
const token = 'test-access';
const eventId = 7;
const at = '2026-11-10T09:15:00Z';
const row = {
  ticket_id: 21, full_name: 'Әлия Тестова', masked_email: 'al***@example.com', status: 'active',
  checked_in_at: null, check_in_id: null, qr_payload: 'biletflow:ticket:v1:fixture',
};
const scan: ScanRequest = { qr_payload: row.qr_payload, request_id: '01000000-0000-4000-8000-000000000001' };
const undoId = '02000000-0000-4000-8000-000000000001';
const undone = { status: 'UNDONE', event_id: eventId, ticket_id: 21, check_in_id: 90, request_id: undoId, undone_at: at };

const reply = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });
const rejection = (code: string, status: number, message = 'server text') => reply({ detail: { code, message } }, status);
const ids = (prefix: string) => {
  let issued = 0;
  return () => `${prefix}000000-0000-4000-8000-00000000000${++issued}`;
};

test('a cancelled ticket, a refunded ticket and an undone check-in are three separate check-in results', async () => {
  for (const code of ['TICKET_CANCELLED', 'TICKET_REFUNDED', 'CHECK_IN_UNDONE']) {
    await assert.rejects(createApi(base, rejection(code, 409)).checkIn(token, eventId, scan), { code, status: 409 });
  }
  // The whole event being cancelled stays its own result and is not a ticket state.
  await assert.rejects(createApi(base, rejection('EVENT_CANCELLED', 409)).checkIn(token, eventId, scan),
    { code: 'EVENT_CANCELLED', status: 409 });
});

test('every lifecycle code has its own Russian and Kazakh text, and both languages define the same keys', () => {
  const codes = ['TICKET_CANCELLED', 'TICKET_REFUNDED', 'CHECK_IN_UNDONE', 'CHECK_IN_ALREADY_UNDONE',
    'CHECK_IN_NOT_FOUND', 'UNDO_NOT_ALLOWED'];
  for (const locale of ['ru', 'kk'] as Locale[]) {
    const texts = codes.map(code => errorMessage(new ApiError(code, 'Admit this visitor', 409), locale));
    assert.equal(new Set(texts).size, codes.length);
    assert.ok(texts.every(text => text !== messages[locale].errors.REQUEST_ERROR && !text.includes('Admit')));
  }
  assert.deepEqual(Object.keys(messages.kk).sort(), Object.keys(messages.ru).sort());
  assert.deepEqual(Object.keys(messages.kk.errors).sort(), Object.keys(messages.ru.errors).sort());
  assert.notEqual(messages.ru.errors.TICKET_CANCELLED, messages.ru.errors.EVENT_CANCELLED);
});

test('search reads ticket states and the current admission, and accepts a server without those fields', async () => {
  const rows = [
    row,
    { ...row, ticket_id: 22, checked_in_at: at, check_in_id: 90 },
    { ...row, ticket_id: 23, status: 'cancelled' },
    { ...row, ticket_id: 24, status: 'refunded' },
  ];
  assert.deepEqual(await createApi(base, reply(rows)).attendees(token, eventId, 'тест'), rows);

  const { status: _status, check_in_id: _checkIn, ...legacy } = row;
  assert.deepEqual(await createApi(base, reply([legacy, { ...legacy, ticket_id: 22, checked_in_at: at }]))
    .attendees(token, eventId, 'тест'), [row, { ...row, ticket_id: 22, checked_in_at: at }]);
});

test('search rejects rows whose state and admission contradict each other', async () => {
  for (const bad of [
    { ...row, status: 'expired' }, { ...row, status: null },
    { ...row, status: 'cancelled', checked_in_at: at, check_in_id: 90 },
    { ...row, status: 'refunded', checked_in_at: at },
    { ...row, check_in_id: 90 },
    { ...row, checked_in_at: at, check_in_id: 0 }, { ...row, checked_in_at: at, check_in_id: '90' },
  ]) {
    await assert.rejects(createApi(base, reply([bad])).attendees(token, eventId, 'тест'), { code: 'SERVER_ERROR' });
  }
});

test('the event list reads can_manage only as a boolean', async () => {
  const event = { id: 7, title: 'Fair', date: at, location: 'Hall', status: 'published' };
  const listed = await createApi(base, reply([{ ...event, can_manage: true }, { ...event, id: 8, can_manage: false }, { ...event, id: 9 }]))
    .events(token);
  assert.deepEqual(listed.map(item => item.can_manage), [true, false, undefined]);
  for (const value of ['true', 1, null]) {
    await assert.rejects(createApi(base, reply([{ ...event, can_manage: value }])).events(token), { code: 'SERVER_ERROR' });
  }
});

test('a check-in receipt may carry check_in_id, which must then be a positive integer', async () => {
  const receipt = { status: 'CHECKED_IN', event_id: eventId, ticket_id: 21, request_id: scan.request_id, checked_in_at: at };
  assert.equal((await createApi(base, reply({ ...receipt, check_in_id: 90 })).checkIn(token, eventId, scan)).check_in_id, 90);
  assert.equal((await createApi(base, reply(receipt)).checkIn(token, eventId, scan)).check_in_id, undefined);
  for (const value of [0, -1, 1.5, '90', null]) {
    await assert.rejects(createApi(base, reply({ ...receipt, check_in_id: value })).checkIn(token, eventId, scan),
      { code: 'SERVER_ERROR' });
  }
});

test('undo posts its own request ID to the check-in it reverses and needs a matching UNDONE receipt', async () => {
  const api = createApi(base, async (url, options) => {
    assert.equal(url, `${base}/events/7/check-ins/90/undo`);
    assert.equal(options?.method, 'POST');
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${token}`);
    assert.deepEqual(JSON.parse(String(options?.body)), { request_id: undoId });
    return Response.json(undone);
  });
  assert.deepEqual(await api.undoCheckIn(token, eventId, 90, undoId), undone);

  for (const body of [null, {}, { ...undone, status: 'CHECKED_IN' }, { ...undone, event_id: 8 },
    { ...undone, check_in_id: 91 }, { ...undone, request_id: scan.request_id }, { ...undone, ticket_id: 0 },
    { ...undone, undone_at: 'soon' }, { ...undone, undone_at: undefined }]) {
    await assert.rejects(createApi(base, reply(body)).undoCheckIn(token, eventId, 90, undoId), { code: 'SERVER_ERROR' });
  }
});

test('undo keeps permission, missing-record and already-undone answers apart', async () => {
  for (const [status, detail, expected] of [
    [403, { code: 'UNDO_NOT_ALLOWED', message: 'Organizer only' }, 'UNDO_NOT_ALLOWED'],
    [403, { code: 'FORBIDDEN', message: 'Not staff' }, 'FORBIDDEN'],
    [403, 'This account is disabled', 'FORBIDDEN'],
    [404, { code: 'CHECK_IN_NOT_FOUND', message: 'Missing' }, 'CHECK_IN_NOT_FOUND'],
    [404, { code: 'EVENT_NOT_FOUND', message: 'Missing' }, 'EVENT_NOT_FOUND'],
    [404, 'Not Found', 'NOT_AVAILABLE'],
    [409, { code: 'CHECK_IN_ALREADY_UNDONE', message: 'Done' }, 'CHECK_IN_ALREADY_UNDONE'],
    [409, { code: 'REQUEST_ID_CONFLICT', message: 'Conflict' }, 'REQUEST_ID_CONFLICT'],
    [401, 'Not authenticated', 'UNAUTHORIZED'],
    [503, { code: 'DATABASE_UNAVAILABLE', message: 'Down' }, 'SERVER_ERROR'],
  ] as const) {
    await assert.rejects(createApi(base, reply({ detail }, status)).undoCheckIn(token, eventId, 90, undoId),
      { code: expected, status });
  }
});

test('a final ticket state or an undone check-in settles an earlier unknown result as not admitted', async () => {
  for (const code of ['TICKET_CANCELLED', 'TICKET_REFUNDED', 'CHECK_IN_UNDONE']) {
    const sent: ScanRequest[] = [];
    const scanner = createScanner(async request => {
      sent.push(request);
      throw sent.length === 1 ? new ApiError('NETWORK_ERROR', 'lost') : new ApiError(code, 'final', 409);
    }, ids('01'));

    assert.equal((await scanner.scan(row.qr_payload))?.error?.code, 'NETWORK_ERROR');
    assert.equal(scanner.mustResolve(), true);
    assert.equal((await scanner.retry())?.error?.code, code);
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(scanner.mustResolve(), false);
    assert.equal(scanner.next(), true);
  }
});

test('other rejections after an unknown result, and a server error that only names a final state, settle nothing', async () => {
  for (const later of [new ApiError('ALREADY_CHECKED_IN', 'used', 409), new ApiError('FORBIDDEN', 'denied', 403),
    new ApiError('TICKET_CANCELLED', 'proxy error', 502), new ApiError('TICKET_CANCELLED', 'no status')]) {
    let attempts = 0;
    const scanner = createScanner(async () => {
      throw ++attempts === 1 ? new ApiError('SERVER_ERROR', 'unknown', 500) : later;
    }, ids('01'));
    await scanner.scan(row.qr_payload);
    await scanner.retry();
    assert.equal(scanner.mustResolve(), true);
    assert.equal(scanner.next(), false);
  }
});

test('a first scan of a closed ticket is a plain rejection and the next ticket can be scanned', async () => {
  const scanner = createScanner(async () => { throw new ApiError('TICKET_REFUNDED', 'refunded', 409); }, ids('01'));
  assert.equal((await scanner.scan(row.qr_payload))?.error?.code, 'TICKET_REFUNDED');
  assert.equal(scanner.mustResolve(), false);
  assert.equal(scanner.next(), true);
});

test('a second tap while an undo is in flight sends nothing', async () => {
  let release: (() => void) | undefined;
  const sent: string[] = [];
  const undo = createUndo(async (_checkInId, requestId) => {
    sent.push(requestId);
    await new Promise<void>(resolve => { release = resolve; });
    return { ...undone, request_id: requestId } as typeof undone & { status: 'UNDONE' };
  }, ids('02'));

  const first = undo.undo(90);
  assert.equal(undo.undo(90), null);
  assert.equal(undo.undo(91), null);
  release?.();
  assert.equal((await first)?.receipt?.check_in_id, 90);
  assert.equal(sent.length, 1);
});

test('an undo whose response was lost is retried with the same request ID and reversed once', async () => {
  const sent: { checkInId: number; requestId: string }[] = [];
  const reversed = new Map<number, string>();
  const undo = createUndo(async (checkInId, requestId) => {
    sent.push({ checkInId, requestId });
    const earlier = reversed.get(checkInId);
    if (earlier !== undefined && earlier !== requestId) throw new ApiError('CHECK_IN_ALREADY_UNDONE', 'done', 409);
    reversed.set(checkInId, requestId); // the server commits even when the reply never arrives
    if (sent.length === 1) throw new ApiError('NETWORK_ERROR', 'response lost');
    return { ...undone, check_in_id: checkInId, request_id: requestId } as typeof undone & { status: 'UNDONE' };
  }, ids('02'));

  assert.equal((await undo.undo(90))?.error?.code, 'NETWORK_ERROR');
  assert.equal(undo.unconfirmed(90), true);
  assert.equal(undo.requestId(), sent[0].requestId);
  const retried = await undo.undo(90);
  assert.equal(retried?.receipt?.request_id, sent[0].requestId);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(undo.unconfirmed(90), false);
  assert.equal(undo.requestId(), null);

  // A later, separate undo of the same record is a new request and is told the truth by the server.
  assert.equal((await undo.undo(90))?.error?.code, 'CHECK_IN_ALREADY_UNDONE');
  assert.notEqual(sent[2].requestId, sent[0].requestId);
  assert.equal(undo.unconfirmed(90), false);
});

test('an undo keeps its request ID through server errors and re-login, and drops it on a definite answer', async () => {
  const outcomes: (ApiError | null)[] = [
    new ApiError('SERVER_ERROR', 'unknown', 500), new ApiError('UNAUTHORIZED', 'expired', 401),
    new ApiError('UNDO_NOT_ALLOWED', 'organizer only', 403), null,
  ];
  const sent: string[] = [];
  const undo = createUndo(async (checkInId, requestId) => {
    sent.push(requestId);
    const outcome = outcomes[sent.length - 1];
    if (outcome) throw outcome;
    return { ...undone, check_in_id: checkInId, request_id: requestId } as typeof undone & { status: 'UNDONE' };
  }, ids('02'));

  assert.equal((await undo.undo(90))?.error?.code, 'SERVER_ERROR');
  assert.equal((await undo.undo(90))?.error?.code, 'UNAUTHORIZED');
  assert.equal(undo.unconfirmed(90), true);
  assert.equal((await undo.undo(90))?.error?.code, 'UNDO_NOT_ALLOWED');
  assert.equal(undo.unconfirmed(90), false);
  assert.equal((await undo.undo(90))?.receipt?.status, 'UNDONE');
  assert.deepEqual([sent[0] === sent[1], sent[1] === sent[2], sent[2] === sent[3]], [true, true, false]);
});

test('each check-in gets its own undo request ID and invalid targets send nothing', async () => {
  const sent: { checkInId: number; requestId: string }[] = [];
  const undo = createUndo(async (checkInId, requestId) => {
    sent.push({ checkInId, requestId });
    throw new TypeError('offline');
  }, ids('02'));

  assert.equal((await undo.undo(90))?.error?.code, 'SERVER_ERROR');
  assert.equal((await undo.undo(91))?.error?.code, 'SERVER_ERROR');
  assert.notEqual(sent[1].requestId, sent[0].requestId);
  for (const target of [0, -1, 1.5, Number.NaN]) assert.equal(undo.undo(target), null);
  assert.equal(sent.length, 2);
});

test('an undo session sends the current token, including one renewed after it was created', async () => {
  const seen: string[] = [];
  const api = createApi(base, async (_url, options) => {
    seen.push(new Headers(options?.headers).get('Authorization') ?? '');
    return Response.json({ ...undone, request_id: JSON.parse(String(options?.body)).request_id });
  });
  const session = createUndoSession((access, id, requestId) => api.undoCheckIn(access, eventId, id, requestId), ids('02'));
  session.setToken('first');
  await session.undo(90);
  session.setToken('renewed');
  await session.undo(90);
  assert.deepEqual(seen, ['Bearer first', 'Bearer renewed']);
});

test('a manual attendance refresh shows loading, then new totals, and keeps the last totals when it fails', () => {
  const first = { event_id: eventId, capacity: 100, tickets_issued: 30, checked_in: 25 };
  let state = emptyLoad<typeof first>();
  assert.deepEqual(loadView(state, '0:0'), { loading: true, failed: false, empty: true });

  state = loadSucceeded('0:0', first, 1000);
  assert.deepEqual(loadView(state, '0:0'), { loading: false, failed: false, empty: false });
  // A tap on refresh, or a confirmed check-in elsewhere on the screen, asks for a new request.
  assert.deepEqual(loadView(state, '0:1'), { loading: true, failed: false, empty: false });
  assert.equal(state.data, first);

  const failed = loadFailed(state, '0:1', new ApiError('NETWORK_ERROR', 'offline'));
  assert.deepEqual(loadView(failed, '0:1'), { loading: false, failed: true, empty: false });
  assert.deepEqual([failed.data, failed.at], [first, 1000]);

  const second = { ...first, checked_in: 26 };
  state = loadSucceeded('1:1', second, 2000);
  assert.deepEqual([state.data, state.at, state.error], [second, 2000, null]);
  assert.equal(loadView(loadFailed(emptyLoad(), '0:0', undefined), '0:0').failed, true);
});
