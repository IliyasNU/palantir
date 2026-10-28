import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient, ApiError } from '../src/api/client.ts';
import { createAuthStore } from '../src/auth/store.ts';
import { authLink, safeReturnTo } from '../src/auth/returnTo.ts';
import { authErrorMessage, validateRegistration } from '../src/auth/formErrors.ts';

const user = { id: 1, email: 'test@example.com', full_name: 'Test Visitor', role: 'attendee', is_active: true, created_at: '2026-10-28T00:00:00Z' };
const credentials = { email: user.email, password: 'test-only-password' };
const tokenPair = { access_token: 'test-only-access', refresh_token: 'unused-refresh', token_type: 'bearer' };
function fixture(handler = () => undefined) {
  const paths = [];
  const api = createApiClient('http://localhost:8000', async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    const custom = await handler(path, options);
    if (custom) return custom;
    if (path === '/auth/login') return Response.json(tokenPair);
    if (path === '/auth/me') return Response.json(user);
    throw new Error('Unexpected request');
  });
  return { store: createAuthStore(api), paths };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('registration forces attendee and never opens a session', async () => {
  const { store, paths } = fixture((path, options) => {
    assert.equal(path, '/auth/register');
    assert.equal(JSON.parse(options.body).role, 'attendee');
    assert.equal(options.headers.has('Authorization'), false);
    return Response.json(user, { status: 201 });
  });
  assert.equal((await store.register({ ...credentials, full_name: 'Test Visitor', role: 'admin' })).id, 1);
  assert.equal(store.getSnapshot().user, null);
  assert.deepEqual(paths, ['/auth/register']);
});

test('session opens only after /me and exposes no tokens in its snapshot', async () => {
  const me = deferred();
  const started = deferred();
  const { store } = fixture((path, options) => {
    if (path === '/auth/me') {
      assert.ok(options.headers.get('Authorization') === `Bearer ${tokenPair.access_token}`);
      started.resolve();
      return me.promise;
    }
  });
  const login = store.login(credentials);
  await started.promise;
  assert.equal(store.getSnapshot().status, 'authenticating');
  assert.equal(store.getSnapshot().user, null);
  me.resolve(Response.json(user));
  await login;
  assert.equal(store.getSnapshot().user.id, 1);
  assert.equal(store.getSnapshot().status, 'authenticated');
  assert.deepEqual(Object.keys(store.getSnapshot()).sort(), ['notice', 'status', 'user']);
});

test('failed login or failed /me leaves no authenticated session', async () => {
  for (const failedPath of ['/auth/login', '/auth/me']) {
    const { store } = fixture((path) => path === failedPath ? Response.json({ detail: 'Invalid credentials' }, { status: 401 }) : undefined);
    await assert.rejects(store.login(credentials), (error) => error.status === 401);
    assert.equal(store.getSnapshot().status, 'anonymous');
    assert.equal(store.getSnapshot().user, null);
  }
});

test('protected 401 clears session and prompts login', async () => {
  const { store } = fixture((path) => path === '/private' ? Response.json({ detail: 'Expired' }, { status: 401 }) : undefined);
  await store.login(credentials);
  await assert.rejects(store.request('/private'), (error) => error.status === 401);
  assert.deepEqual(store.getSnapshot(), { user: null, status: 'anonymous', notice: 'expired' });
});

test('protected 403 preserves user/session and exposes a permission notice', async () => {
  const { store } = fixture((path) => path === '/private' ? Response.json({ detail: 'Forbidden' }, { status: 403 }) : undefined);
  await store.login(credentials);
  await assert.rejects(store.request('/private'), (error) => error.status === 403);
  assert.equal(store.getSnapshot().user.id, 1);
  assert.equal(store.getSnapshot().status, 'authenticated');
  assert.equal(store.getSnapshot().notice, 'forbidden');
  assert.equal((await store.request('/auth/me')).id, 1);
});

test('logout clears the user and cancels private requests without calling a logout endpoint', async () => {
  const late = deferred();
  const started = deferred();
  let signal;
  const { store, paths } = fixture((path, options) => {
    if (path === '/private') { signal = options.signal; started.resolve(); return late.promise; }
  });
  await store.login(credentials);
  const request = store.request('/private');
  const rejected = assert.rejects(request, (error) => error.name === 'AbortError');
  await started.promise;
  store.logout();
  assert.equal(signal.aborted, true);
  assert.equal(store.getSnapshot().user, null);
  late.resolve(Response.json({ privateData: 'must not be returned' }));
  await rejected;
  assert.equal(paths.includes('/auth/logout'), false);
  await assert.rejects(store.request('/auth/me'), (error) => error.status === 401);
});

test('late 401 from an old session cannot clear a newer login', async () => {
  const late = deferred();
  const started = deferred();
  const { store } = fixture((path) => {
    if (path === '/private') { started.resolve(); return late.promise; }
  });
  await store.login(credentials);
  const request = store.request('/private');
  const rejected = assert.rejects(request, (error) => error.name === 'AbortError');
  await started.promise;
  store.logout();
  await store.login(credentials);
  late.resolve(Response.json({ detail: 'Expired' }, { status: 401 }));
  await rejected;
  assert.equal(store.getSnapshot().status, 'authenticated');
  assert.equal(store.getSnapshot().notice, null);
});

test('logout during login cannot be undone by a late /me response', async () => {
  const late = deferred();
  const started = deferred();
  const { store } = fixture((path) => {
    if (path === '/auth/me') { started.resolve(); return late.promise; }
  });
  const login = store.login(credentials);
  const rejected = assert.rejects(login, (error) => error.name === 'AbortError');
  await started.promise;
  store.logout();
  late.resolve(Response.json(user));
  await rejected;
  assert.equal(store.getSnapshot().status, 'anonymous');
});

test('new store starts anonymous (no persistence)', async () => {
  const first = fixture().store;
  await first.login(credentials);
  assert.equal(fixture().store.getSnapshot().user, null);
});

test('return destination allows only event routes and survives auth links', () => {
  for (const path of ['/events', '/events/42', '/events/42/']) assert.equal(safeReturnTo(path), path);
  for (const path of [undefined, '//evil.test', 'https://evil.test', '/\\evil.test', '/events/../login', '/login', '/register', '/events/%2f%2fevil', '/events/1?next=https://evil.test', '/events/1\n']) {
    assert.equal(safeReturnTo(path), '/events');
  }
  let destination = '/events/42';
  for (const page of ['/login', '/register', '/login']) {
    const url = new URL(authLink(page, destination), 'http://localhost:5173');
    destination = safeReturnTo(url.searchParams.get('returnTo'));
    assert.equal(destination, '/events/42');
  }
});

test('registration rejects whitespace names and passwords above bcrypt UTF-8 limit', () => {
  assert.throws(() => validateRegistration({ ...credentials, full_name: '   ' }), (error) => error.issues[0].field === 'full_name');
  assert.throws(() => validateRegistration({ ...credentials, full_name: 'Name', password: 'я'.repeat(37) }), (error) => error.issues[0].field === 'password');
  validateRegistration({ ...credentials, full_name: 'Name', password: 'я'.repeat(36) });
});

test('auth forms show clear wrong-password and duplicate-email messages', () => {
  assert.match(authErrorMessage(new ApiError('Incorrect email or password', { kind: 'http', status: 401 }), 'login'), /Неверный email или пароль/);
  assert.match(authErrorMessage(new ApiError('Conflict', { kind: 'http', status: 409 }), 'register'), /email уже зарегистрирован/);
});
