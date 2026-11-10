import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApi, type UndoReceipt } from '../src/api.ts';
import { createUndoStore } from '../src/undo.ts';

const base = 'https://biletflow.example';
const at = '2026-11-10T09:15:00Z';
const organizer = { token: 'organizer-access-1', userId: 5 };
const admin = { token: 'admin-access-1', userId: 9 };
const ids = () => {
  let issued = 0;
  return () => `02000000-0000-4000-8000-00000000000${++issued}`;
};
const receipt = (eventId: number, checkInId: number, requestId: string): UndoReceipt => ({
  status: 'UNDONE', event_id: eventId, ticket_id: 21, check_in_id: checkInId, request_id: requestId, undone_at: at,
});

// A server that keeps undo history the way the backend does: one reversal per check-in, the same receipt
// for a repeat of the same request by the same account, and a 401 for a token it no longer accepts.
function fakeServer() {
  const reversed = new Map<string, { requestId: string; userId: number }>();
  const sessions = new Map([[organizer.token, organizer.userId], [admin.token, admin.userId]]);
  const posts: { token: string; eventId: number; checkInId: number; requestId: string }[] = [];
  const faults: ('lose-response' | 'never-arrives')[] = [];
  let logins = 1;
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/login') {
      const { email } = JSON.parse(String(options?.body));
      return Response.json({ access_token: `${email}-access-${++logins}`, refresh_token: 'r', token_type: 'bearer' });
    }
    const token = (new Headers(options?.headers).get('Authorization') ?? '').replace('Bearer ', '');
    if (url.pathname === '/auth/me') {
      const userId = token.startsWith('organizer') ? organizer.userId : admin.userId;
      sessions.set(token, userId);
      return Response.json({ id: userId });
    }
    const [, eventId, checkInId] = /^\/events\/(\d+)\/check-ins\/(\d+)\/undo$/.exec(url.pathname) ?? [];
    const { request_id: requestId } = JSON.parse(String(options?.body));
    posts.push({ token, eventId: Number(eventId), checkInId: Number(checkInId), requestId });
    const fault = faults.shift();
    if (fault === 'never-arrives') throw new TypeError('offline');
    const userId = sessions.get(token);
    if (userId === undefined) return Response.json({ detail: 'Token expired' }, { status: 401 });
    const target = `${eventId}:${checkInId}`;
    const earlier = reversed.get(target);
    if (earlier && (earlier.requestId !== requestId || earlier.userId !== userId)) {
      const code = earlier.requestId === requestId ? 'REQUEST_ID_CONFLICT' : 'CHECK_IN_ALREADY_UNDONE';
      return Response.json({ detail: { code, message: 'x' } }, { status: 409 });
    }
    reversed.set(target, { requestId, userId });
    if (fault === 'lose-response') throw new TypeError('response lost');
    return Response.json(receipt(Number(eventId), Number(checkInId), requestId));
  };
  const api = createApi(base, fetcher);
  return { api, posts, faults, reversed, expire: (token: string) => sessions.delete(token) };
}

function storeFor(server: ReturnType<typeof fakeServer>) {
  return createUndoStore((token, eventId, checkInId, requestId) =>
    server.api.undoCheckIn(token, eventId, checkInId, requestId), ids());
}

test('undo, lost response, 401, sign in again: the same request is repeated for the same account and check-in', async () => {
  const server = fakeServer();
  const store = storeFor(server);
  // The scanner screen subscribes while it is mounted.
  let renders = 0;
  const unmountScanner = store.subscribe(() => { renders++; });

  server.faults.push('lose-response');
  assert.equal((await store.undo(organizer, 7, 90, 'Әлия'))?.error?.code, 'NETWORK_ERROR');
  assert.equal(server.reversed.size, 1); // the server did reverse the entry
  const kept = store.find(organizer.userId, 7, 90);
  assert.deepEqual([kept?.eventId, kept?.checkInId, kept?.userId, kept?.label, kept?.busy], [7, 90, 5, 'Әлия', false]);

  // The session expires before the retry.
  server.expire(organizer.token);
  const refused = await store.undo(organizer, 7, 90, 'Әлия');
  assert.deepEqual([refused?.error?.code, refused?.error?.status], ['UNAUTHORIZED', 401]);
  assert.equal(store.find(organizer.userId, 7, 90)?.expiredToken, organizer.token);
  assert.equal(store.find(organizer.userId, 7, 90)?.requestId, kept?.requestId);

  // "Sign in again" leaves the scanner: the screen unmounts and the session is dropped.
  assert.ok(renders > 0);
  unmountScanner();
  const signedOutRenders = renders;

  // Another account signs in on the same phone. It neither sees nor sends the organizer's request.
  assert.deepEqual(store.pending(admin.userId), []);
  assert.equal(store.find(admin.userId, 7, 90), undefined);

  // The organizer signs in again: a new token, the same user ID, a freshly mounted scanner.
  const session = await server.api.login('organizer', 'password', organizer.userId);
  assert.notEqual(session.token, organizer.token);
  assert.equal(session.userId, organizer.userId);
  const [pending] = store.pending(session.userId, 7);
  assert.deepEqual([pending.eventId, pending.checkInId, pending.requestId, pending.label],
    [7, 90, kept?.requestId, 'Әлия']);
  assert.notEqual(pending.expiredToken, session.token); // the retry is offered, not another sign-in

  const repeated = await store.undo(session, pending.eventId, pending.checkInId, pending.label);
  assert.deepEqual(repeated?.receipt, receipt(7, 90, kept!.requestId));
  assert.deepEqual(store.pending(session.userId), []);
  assert.equal(renders, signedOutRenders); // nothing was pushed into the unmounted screen

  assert.deepEqual(server.posts.map(post => [post.eventId, post.checkInId, post.requestId]),
    Array.from({ length: 3 }, () => [7, 90, kept?.requestId]));
  assert.deepEqual(server.posts.map(post => post.token), [organizer.token, organizer.token, session.token]);
  assert.equal(server.reversed.size, 1);
});

test('an undo still in flight when its screen unmounts keeps its outcome in the store', async () => {
  const server = fakeServer();
  const store = storeFor(server);
  const unmount = store.subscribe(() => {});
  server.faults.push('never-arrives');
  const inFlight = store.undo(organizer, 7, 90, 'Ticket #21');
  assert.equal(store.find(organizer.userId, 7, 90)?.busy, true);
  unmount();
  await inFlight;
  const kept = store.find(organizer.userId, 7, 90);
  assert.deepEqual([kept?.busy, kept?.lastError?.code, kept?.expiredToken], [false, 'NETWORK_ERROR', null]);
  assert.equal((await store.undo(organizer, 7, 90, 'Ticket #21'))?.receipt?.request_id, kept?.requestId);
});

test('another account undoing the same check-in uses its own request and leaves the first one intact', async () => {
  const server = fakeServer();
  const store = storeFor(server);
  server.faults.push('lose-response');
  await store.undo(organizer, 7, 90, 'Әлия');
  const first = store.find(organizer.userId, 7, 90)!;

  const second = await store.undo(admin, 7, 90, 'Әлия');
  assert.equal(second?.error?.code, 'CHECK_IN_ALREADY_UNDONE');
  assert.notEqual(server.posts[1].requestId, first.requestId);
  assert.equal(store.find(admin.userId, 7, 90), undefined); // a definite answer is not kept
  assert.deepEqual(store.find(organizer.userId, 7, 90), first);
  assert.equal((await store.undo(organizer, 7, 90, 'Әлия'))?.receipt?.request_id, first.requestId);
});

test('a second tap while an undo is in flight sends nothing, and a definite refusal is not kept', async () => {
  let release: ((value: UndoReceipt) => void) | undefined;
  const sent: string[] = [];
  const outcomes: (ApiError | null)[] = [null, new ApiError('UNDO_NOT_ALLOWED', 'organizer only', 403), null];
  const store = createUndoStore(async (_token, eventId, checkInId, requestId) => {
    sent.push(requestId);
    const outcome = outcomes[sent.length - 1];
    if (outcome) throw outcome;
    if (sent.length === 1) return new Promise<UndoReceipt>(resolve => { release = resolve; });
    return receipt(eventId, checkInId, requestId);
  }, ids());

  const first = store.undo(organizer, 7, 90, 'A');
  assert.equal(store.undo(organizer, 7, 90, 'A'), null);
  release?.(receipt(7, 90, sent[0]));
  assert.equal((await first)?.receipt?.check_in_id, 90);
  assert.equal(sent.length, 1);

  assert.equal((await store.undo(organizer, 7, 90, 'A'))?.error?.code, 'UNDO_NOT_ALLOWED');
  assert.equal(store.find(organizer.userId, 7, 90), undefined);
  assert.equal((await store.undo(organizer, 7, 90, 'A'))?.receipt?.status, 'UNDONE');
  assert.equal(new Set(sent).size, 3); // each settled request was a new one
});

test('server errors keep the request, each check-in and event has its own, and invalid targets send nothing', async () => {
  const sent: { eventId: number; checkInId: number; requestId: string }[] = [];
  const store = createUndoStore(async (_token, eventId, checkInId, requestId) => {
    sent.push({ eventId, checkInId, requestId });
    throw new ApiError('SERVER_ERROR', 'unknown', 503);
  }, ids());

  await store.undo(organizer, 7, 90, 'A');
  await store.undo(organizer, 7, 90, 'A');
  await store.undo(organizer, 7, 91, 'B');
  await store.undo(organizer, 8, 90, 'C');
  assert.equal(sent[1].requestId, sent[0].requestId);
  assert.equal(new Set(sent.map(item => item.requestId)).size, 3);
  assert.deepEqual(store.pending(organizer.userId, 7).map(entry => entry.checkInId), [90, 91]);
  assert.deepEqual(store.pending(organizer.userId).map(entry => entry.eventId), [7, 7, 8]);

  for (const [account, eventId, checkInId] of [[{ token: '', userId: 5 }, 7, 90], [{ token: 't', userId: 0 }, 7, 90],
    [organizer, 0, 90], [organizer, 7, 1.5], [organizer, 7, Number.NaN]] as const) {
    assert.equal(store.undo(account, eventId, checkInId, 'x'), null);
  }
  assert.equal(sent.length, 4);
});

test('subscribers are told when a request starts and when it settles', async () => {
  const store = createUndoStore(async (_token, eventId, checkInId, requestId) => receipt(eventId, checkInId, requestId), ids());
  const versions: number[] = [];
  store.subscribe(() => versions.push(store.version()));
  await store.undo(organizer, 7, 90, 'A');
  assert.equal(versions.length, 2);
  assert.ok(versions[1] > versions[0]);
});
