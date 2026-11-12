// Runs the staff app's own API client and scanner against a real BiletFlow API and its PostgreSQL database.
// It registers throw-away accounts and events, so point it only at a disposable test database.
//
//   LIVE_API_URL=http://127.0.0.1:8001 LIVE_PSQL_URL=postgresql://user:pass@127.0.0.1:5433/db \
//   LIVE_CONFIRM_TEST_DATABASE=1 node --experimental-strip-types tests/live/staff-flow.live.ts
//
// LIVE_PSQL_URL is optional; without it the database assertions are skipped and reported as such.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ApiError, createApi, type ScanRequest } from '../../src/api.ts';
import { createRenewer, tokenExpiry } from '../../src/renewal.ts';
import { createScanner } from '../../src/scanner.ts';
import { createUndoStore } from '../../src/undo.ts';

const target = process.env.LIVE_API_URL ?? '';
const psqlUrl = process.env.LIVE_PSQL_URL ?? '';
if (!target || process.env.LIVE_CONFIRM_TEST_DATABASE !== '1') {
  console.error('Set LIVE_API_URL and LIVE_CONFIRM_TEST_DATABASE=1. This run writes test accounts and events.');
  process.exit(2);
}

// The client refuses loopback addresses because a phone cannot reach them. The run keeps that rule and
// only forwards the transport to the local test API.
const publicBase = 'http://biletflow-live.test';
let loseNextResponse = false;
let dropNextRequest = false;
const transport: typeof fetch = async (input, init) => {
  if (dropNextRequest) { dropNextRequest = false; throw new TypeError('request never left the phone'); }
  const response = await fetch(String(input).replace(publicBase, target), init);
  if (loseNextResponse) { loseNextResponse = false; await response.arrayBuffer(); throw new TypeError('response lost'); }
  return response;
};
const api = createApi(publicBase, transport);
const password = `Live-${randomUUID()}`;
const run = randomUUID().slice(0, 8);

async function raw(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(target + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function account(label: string, fullName: string, role = 'attendee') {
  const email = `live-${run}-${label}@example.com`;
  const created = await raw('POST', '/auth/register', undefined, { email, full_name: fullName, password, role });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const session = await api.login(email, password);
  return { email, fullName, ...session };
}

function sql(query: string): string | null {
  if (!psqlUrl) return null;
  return execFileSync('psql', [psqlUrl, '-X', '-Atc', query], { encoding: 'utf8' }).trim();
}
const rows = (ticketId: number) => sql(
  `SELECT count(*) || '/' || count(*) FILTER (WHERE undone_at IS NULL) FROM check_ins WHERE ticket_id = ${ticketId}`);

const results: { step: string; outcome: string }[] = [];
async function step(name: string, body: () => Promise<void>) {
  try {
    await body();
    results.push({ step: name, outcome: 'passed' });
  } catch (error) {
    results.push({ step: name, outcome: `FAILED: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` });
  }
}
const code = async (attempt: Promise<unknown>) => {
  try { await attempt; return 'ok'; } catch (error) { return error instanceof ApiError ? error.code : `unexpected ${error}`; }
};
const scannerFor = (token: string, eventId: number) =>
  createScanner((request: ScanRequest) => api.checkIn(token, eventId, request), randomUUID);

const organizer = await account('organizer', 'Live Organizer', 'organizer');
const otherOrganizer = await account('other-organizer', 'Other Organizer', 'organizer');
const staff = await account('staff', 'Live Staff');
const outsider = await account('outsider', 'Not Assigned');
const visitors = {
  camera: await account('camera', 'Айгерим Камера'),
  manual: await account('manual', 'Әлия Нұрланқызы'),
  lost: await account('lost', 'Данияр Потерянный'),
  cancelled: await account('cancelled', 'Отмена Билетова'),
  refunded: await account('refunded', 'Возврат Билетов'),
  pending: await account('pending', 'Ожидание Ответа'),
  undo: await account('undo', 'Қайрат Отменов'),
  elsewhere: await account('elsewhere', 'Другое Событие'),
};

async function event(owner: { token: string }, title: string) {
  const created = await raw('POST', '/events', owner.token, {
    title, date: '2030-06-01T12:00:00Z', location: 'Orange Hall', capacity: 50,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const published = await raw('POST', `/events/${created.data.id}/publish`, owner.token);
  assert.equal(published.status, 200);
  return published.data.id as number;
}
const eventId = await event(organizer, `Live staff flow ${run}`);
const otherEventId = await event(organizer, `Live other event ${run}`);
const foreignEventId = await event(otherOrganizer, `Live foreign event ${run}`);
assert.equal((await raw('POST', `/events/${eventId}/staff`, organizer.token, { email: staff.email })).status, 201);

const tickets: Record<string, { id: number; qr_payload: string }> = {};
for (const [label, visitor] of Object.entries(visitors)) {
  const claimed = await raw('POST', `/events/${label === 'elsewhere' ? otherEventId : eventId}/tickets`, visitor.token);
  assert.equal(claimed.status, 201, JSON.stringify(claimed.data));
  tickets[label] = claimed.data;
}

await step('health reports the API and database ready', async () => { await api.health(); });

await step('assigned staff, the organizer and an unassigned account each see their own event list', async () => {
  const mine = await api.events(staff.token);
  assert.deepEqual(mine.map(item => [item.id, item.can_manage]), [[eventId, false]]);
  const owned = (await api.events(organizer.token)).filter(item => [eventId, otherEventId].includes(item.id));
  assert.deepEqual(owned.map(item => item.can_manage), [true, true]);
  assert.ok(!(await api.events(organizer.token)).some(item => item.id === foreignEventId));
  assert.deepEqual(await api.events(outsider.token), []);
});

await step('an unassigned account is refused attendance, search and check-in', async () => {
  assert.equal(await code(api.attendance(outsider.token, eventId)), 'FORBIDDEN');
  assert.equal(await code(api.attendees(outsider.token, eventId, 'Айгерим')), 'FORBIDDEN');
  const result = await scannerFor(outsider.token, eventId).scan(tickets.camera.qr_payload);
  assert.equal(result?.error?.code, 'FORBIDDEN');
  assert.equal(rows(tickets.camera.id) ?? '0/0', '0/0');
});

await step('attendance starts with every issued ticket and nobody checked in', async () => {
  const counts = await api.attendance(staff.token, eventId);
  assert.deepEqual([counts.tickets_issued, counts.checked_in, counts.capacity], [7, 0, 50]);
});

await step('search finds a Kazakh name in another letter case and by e-mail, with a masked address', async () => {
  for (const query of ['әлия', 'ӘЛИЯ', 'нұрланқызы', 'НҰРЛАНҚЫЗЫ', `live-${run}-manual`]) {
    const found = await api.attendees(staff.token, eventId, query);
    assert.deepEqual(found.map(item => item.ticket_id), [tickets.manual.id], query);
    assert.equal(found[0].masked_email, 'li***@example.com');
    assert.deepEqual([found[0].status, found[0].checked_in_at, found[0].check_in_id], ['active', null, null]);
  }
});

const camera = scannerFor(staff.token, eventId);
await step('a camera scan of a web-issued ticket admits once and writes one row', async () => {
  const result = await camera.scan(tickets.camera.qr_payload);
  assert.equal(result?.receipt?.ticket_id, tickets.camera.id);
  assert.equal(camera.scan(tickets.camera.qr_payload), null); // the QR is still in front of the camera
  assert.equal(rows(tickets.camera.id) ?? '1/1', '1/1');
});

await step('scanning the same ticket again, another event\'s ticket and non-ticket QR codes are rejected', async () => {
  assert.equal(camera.next(), true);
  assert.equal((await camera.scan(tickets.camera.qr_payload))?.error?.code, 'ALREADY_CHECKED_IN');
  for (const payload of [tickets.elsewhere.qr_payload, 'https://biletflow.example/events/7?utm_campaign=promo',
    'biletflow:ticket:v1:not-a-real-token', 'WIFI:S:guest;T:WPA;P:secret;;']) {
    assert.equal(camera.next(), true);
    assert.equal((await camera.scan(payload))?.error?.code, 'INVALID_TICKET', payload.slice(0, 24));
  }
  assert.equal(rows(tickets.camera.id) ?? '1/1', '1/1');
  assert.equal(rows(tickets.elsewhere.id) ?? '0/0', '0/0');
});

await step('manual admission from a search result uses the same check-in and then shows the entry time', async () => {
  const [match] = await api.attendees(staff.token, eventId, 'ӘЛИЯ');
  const result = await scannerFor(staff.token, eventId).scan(match.qr_payload);
  assert.equal(result?.receipt?.ticket_id, tickets.manual.id);
  const [after] = await api.attendees(staff.token, eventId, 'әлия');
  assert.equal(after.checked_in_at, result?.receipt?.checked_in_at.replace('+00:00', 'Z'));
  assert.equal(after.check_in_id, result?.receipt?.check_in_id);
  assert.equal(rows(tickets.manual.id) ?? '1/1', '1/1');
});

await step('a response lost after the server committed is replayed with the same request ID: one row', async () => {
  const scanner = scannerFor(staff.token, eventId);
  loseNextResponse = true;
  const first = await scanner.scan(tickets.lost.qr_payload);
  assert.equal(first?.error?.code, 'NETWORK_ERROR');
  assert.equal(scanner.mustResolve(), true);
  assert.equal(scanner.next(), false);
  assert.equal(rows(tickets.lost.id) ?? '1/1', '1/1'); // committed although the phone saw a failure
  const requestId = scanner.requestId();
  const retry = await scanner.retry();
  assert.equal(retry?.receipt?.request_id, requestId);
  assert.equal(scanner.mustResolve(), false);
  assert.equal(rows(tickets.lost.id) ?? '1/1', '1/1');
});

await step('attendance equals the current admissions in the database', async () => {
  const counts = await api.attendance(staff.token, eventId);
  assert.deepEqual([counts.tickets_issued, counts.checked_in], [7, 3]);
  const stored = sql(`SELECT count(*) FROM check_ins WHERE event_id = ${eventId} AND undone_at IS NULL`);
  assert.equal(stored ?? '3', '3');
});

await step('a cancelled ticket and a refunded ticket are rejected with their own results and leave the totals', async () => {
  assert.equal((await raw('POST', `/tickets/${tickets.cancelled.id}/cancel`, visitors.cancelled.token)).data.status, 'cancelled');
  assert.equal((await raw('POST', `/tickets/${tickets.refunded.id}/refund`, visitors.refunded.token)).status, 403);
  assert.equal((await raw('POST', `/tickets/${tickets.refunded.id}/refund`, organizer.token)).data.status, 'refunded');

  const scanner = scannerFor(staff.token, eventId);
  assert.equal((await scanner.scan(tickets.cancelled.qr_payload))?.error?.code, 'TICKET_CANCELLED');
  assert.equal(scanner.next(), true);
  assert.equal((await scanner.scan(tickets.refunded.qr_payload))?.error?.code, 'TICKET_REFUNDED');
  assert.equal(rows(tickets.cancelled.id) ?? '0/0', '0/0');
  assert.equal(rows(tickets.refunded.id) ?? '0/0', '0/0');

  assert.equal((await api.attendees(staff.token, eventId, 'Отмена Билетова'))[0].status, 'cancelled');
  assert.equal((await api.attendees(staff.token, eventId, 'Возврат Билетов'))[0].status, 'refunded');
  const counts = await api.attendance(staff.token, eventId);
  assert.deepEqual([counts.tickets_issued, counts.checked_in], [5, 3]);
});

await step('an unknown result followed by a cancellation settles as not admitted', async () => {
  const scanner = scannerFor(staff.token, eventId);
  dropNextRequest = true;
  assert.equal((await scanner.scan(tickets.pending.qr_payload))?.error?.code, 'NETWORK_ERROR');
  assert.equal(scanner.mustResolve(), true);
  assert.equal((await raw('POST', `/tickets/${tickets.pending.id}/cancel`, organizer.token)).status, 200);
  assert.equal((await scanner.retry())?.error?.code, 'TICKET_CANCELLED');
  assert.equal(scanner.mustResolve(), false);
  assert.equal(rows(tickets.pending.id) ?? '0/0', '0/0');
});

const undoScanner = scannerFor(staff.token, eventId);
const firstEntry = (await undoScanner.scan(tickets.undo.qr_payload))?.receipt;
const firstScan: ScanRequest = { qr_payload: tickets.undo.qr_payload, request_id: firstEntry?.request_id ?? '' };

await step('assigned staff cannot undo; outsiders and a wrong event are refused', async () => {
  assert.ok(firstEntry?.check_in_id);
  assert.equal(await code(api.undoCheckIn(staff.token, eventId, firstEntry.check_in_id, randomUUID())), 'UNDO_NOT_ALLOWED');
  assert.equal(await code(api.undoCheckIn(outsider.token, eventId, firstEntry.check_in_id, randomUUID())), 'FORBIDDEN');
  assert.equal(await code(api.undoCheckIn(organizer.token, otherEventId, firstEntry.check_in_id, randomUUID())), 'CHECK_IN_NOT_FOUND');
  assert.equal(rows(tickets.undo.id) ?? '1/1', '1/1');
});

await step('undo, lost response, sign in again: the same request is repeated under the new token and reverses once', async () => {
  const store = createUndoStore((token, event, id, requestId) => api.undoCheckIn(token, event, id, requestId), randomUUID);
  const checkInId = firstEntry!.check_in_id!;
  loseNextResponse = true;
  const lost = store.undo(organizer, eventId, checkInId, visitors.undo.fullName);
  assert.equal(store.undo(organizer, eventId, checkInId, visitors.undo.fullName), null); // a second tap in flight
  assert.equal((await lost)?.error?.code, 'NETWORK_ERROR');
  assert.equal(rows(tickets.undo.id) ?? '1/0', '1/0'); // already reversed on the server
  const kept = store.find(organizer.userId, eventId, checkInId)!;

  // The stored token stops working (here: a token the server does not accept), so the retry gets a 401.
  const expired = await store.undo({ ...organizer, token: 'expired-token' }, eventId, checkInId, kept.label);
  assert.deepEqual([expired?.error?.code, store.find(organizer.userId, eventId, checkInId)?.requestId],
    ['UNAUTHORIZED', kept.requestId]);
  // Another account on the same phone has nothing to repeat.
  assert.deepEqual(store.pending(otherOrganizer.userId), []);

  const again = await api.login(organizer.email, password, organizer.userId);
  assert.notEqual(again.token, organizer.token);
  const [pending] = store.pending(again.userId, eventId);
  const repeated = await store.undo(again, pending.eventId, pending.checkInId, pending.label);
  assert.deepEqual([repeated?.receipt?.status, repeated?.receipt?.request_id, repeated?.receipt?.check_in_id],
    ['UNDONE', kept.requestId, checkInId]);
  assert.deepEqual(store.pending(again.userId), []);
  assert.equal(sql(`SELECT undo_request_id FROM check_ins WHERE id = ${checkInId}`) ?? kept.requestId, kept.requestId);
  assert.equal(await code(api.undoCheckIn(organizer.token, eventId, checkInId, randomUUID())), 'CHECK_IN_ALREADY_UNDONE');
  assert.equal(rows(tickets.undo.id) ?? '1/0', '1/0');
});

await step('after the undo the search, the totals and the old request all show the visitor as not admitted', async () => {
  const [found] = await api.attendees(staff.token, eventId, 'Қайрат');
  assert.deepEqual([found.status, found.checked_in_at, found.check_in_id], ['active', null, null]);
  assert.equal((await api.attendance(staff.token, eventId)).checked_in, 3);
  assert.equal(await code(api.checkIn(staff.token, eventId, firstScan)), 'CHECK_IN_UNDONE');
  assert.equal(rows(tickets.undo.id) ?? '1/0', '1/0');
});

await step('a new scan admits the visitor again as a new record and the old request stays history', async () => {
  assert.equal(undoScanner.next(), true);
  const again = await undoScanner.scan(tickets.undo.qr_payload);
  assert.equal(again?.receipt?.ticket_id, tickets.undo.id);
  assert.notEqual(again?.receipt?.check_in_id, firstEntry?.check_in_id);
  assert.equal(await code(api.checkIn(staff.token, eventId, firstScan)), 'CHECK_IN_UNDONE');
  assert.equal(rows(tickets.undo.id) ?? '2/1', '2/1');
  assert.equal((await api.attendance(staff.token, eventId)).checked_in, 4);
  assert.equal((await raw('POST', `/tickets/${tickets.undo.id}/cancel`, organizer.token)).data.detail.code, 'TICKET_CHECKED_IN');
});

await step('revoked staff lose attendance, search and check-in at once; reassignment restores them', async () => {
  const me = await raw('GET', '/auth/me', staff.token);
  assert.equal((await raw('DELETE', `/events/${eventId}/staff/${me.data.id}`, organizer.token)).status, 204);
  assert.equal(await code(api.attendance(staff.token, eventId)), 'FORBIDDEN');
  assert.equal(await code(api.attendees(staff.token, eventId, 'Айгерим')), 'FORBIDDEN');
  assert.equal((await scannerFor(staff.token, eventId).scan(tickets.camera.qr_payload))?.error?.code, 'FORBIDDEN');
  assert.deepEqual(await api.events(staff.token), []);
  assert.equal((await raw('POST', `/events/${eventId}/staff`, organizer.token, { email: staff.email })).status, 201);
  assert.equal((await api.attendance(staff.token, eventId)).checked_in, 4);
});

await step('an invalid session is reported as sign-in required, never as an admission', async () => {
  assert.equal(await code(api.attendance('not-a-token', eventId)), 'UNAUTHORIZED');
  assert.equal((await scannerFor('not-a-token', eventId).scan(tickets.camera.qr_payload))?.error?.code, 'UNAUTHORIZED');
});

await step('a session is renewed with its refresh token, for the same account only', async () => {
  // The real access token carries the expiry the app plans its renewal from.
  const expiry = tokenExpiry(staff.token);
  assert.ok(expiry !== null && expiry > Date.now() && expiry < Date.now() + 24 * 3_600_000, String(expiry));
  const renew = createRenewer((refreshToken, userId) => api.refresh(refreshToken, userId));
  const renewed = await renew(staff);
  assert.ok('session' in renewed, JSON.stringify(renewed));
  assert.equal(renewed.session.userId, staff.userId);
  assert.ok(renewed.session.refreshToken);
  assert.deepEqual((await api.events(renewed.session.token)).map(item => item.id), [eventId]);
  // The renewed pair renews again, as it does through a long shift.
  assert.ok('session' in await renew(renewed.session));
  // An access token is not a refresh token, another account's refresh token is not this account's,
  // and garbage is refused: each needs a password sign-in.
  for (const refreshToken of [staff.token, outsider.refreshToken, 'not-a-token']) {
    assert.deepEqual(await renew({ ...staff, refreshToken }), { rejected: true });
  }
});

await step('final database state matches what the phone was shown', async () => {
  const current = sql(`SELECT count(*) FROM check_ins WHERE event_id = ${eventId} AND undone_at IS NULL`);
  const history = sql(`SELECT count(*) FROM check_ins WHERE event_id = ${eventId}`);
  const active = sql(`SELECT count(*) FROM tickets WHERE event_id = ${eventId} AND status = 'active'`);
  const counts = await api.attendance(staff.token, eventId);
  assert.deepEqual([current ?? '4', history ?? '5', active ?? '4'], ['4', '5', '4']);
  assert.deepEqual([counts.checked_in, counts.tickets_issued], [4, 4]);
});

const version = sql(
  `SELECT current_setting('server_version') || ', provider ' || datlocprovider::text || ', locale ' || coalesce(daticulocale, datcollate)`
  + ` || ', ' || pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()`);
console.log(`API ${target} · PostgreSQL ${version ?? 'not inspected (LIVE_PSQL_URL unset)'} · Node ${process.version}`);
for (const { step: name, outcome } of results) console.log(`${outcome.startsWith('passed') ? 'ok  ' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` — ${outcome}`}`);
const failed = results.filter(result => !result.outcome.startsWith('passed')).length;
console.log(`${results.length - failed} passed, ${failed} failed${psqlUrl ? '' : ' (database assertions skipped)'}`);
process.exit(failed ? 1 : 0);
