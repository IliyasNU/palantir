import test from 'node:test';
import assert from 'node:assert/strict';
import { ciApiUrl, liveApiUrl, liveTarget, verifyLiveSession } from './browser/live-api.mjs';

const strictMessage = /BILETFLOW_LIVE_API_URL must explicitly select the local test API/;
const ciEnv = (overrides = {}) => ({
  CI: 'true', ENVIRONMENT: 'test',
  DATABASE_URL: 'postgresql+psycopg://biletflow_test:fixture-only@127.0.0.1:5432/biletflow_test', ...overrides,
});
const without = (env, name) => { const copy = { ...env }; delete copy[name]; return copy; };

test('BILETFLOW_LIVE_API_URL always selects the strict runner path, also in CI', () => {
  for (const env of [{ BILETFLOW_LIVE_API_URL: 'http://127.0.0.1:8002' }, ciEnv({ BILETFLOW_LIVE_API_URL: 'http://127.0.0.1:8002' })]) {
    assert.deepEqual(liveTarget(env), { mode: 'strict', origin: 'http://127.0.0.1:8002' });
    assert.equal(liveApiUrl(undefined, env), 'http://127.0.0.1:8002');
  }
  // A set but unusable value is never replaced by CI mode.
  assert.throws(() => liveTarget(ciEnv({ BILETFLOW_LIVE_API_URL: '' })), strictMessage);
  assert.throws(() => liveTarget(ciEnv({ BILETFLOW_LIVE_API_URL: 'https://example.com' })), /only a local HTTP origin/);
  assert.throws(() => liveApiUrl('http://localhost:8000/events', ciEnv()), /only a local HTTP origin/);
});

test('CI mode needs ENVIRONMENT=test and a local biletflow_test DATABASE_URL, all three', () => {
  assert.deepEqual(liveTarget(ciEnv()), { mode: 'ci', origin: ciApiUrl });
  assert.equal(ciApiUrl, 'http://localhost:8000');
  assert.equal(liveApiUrl(undefined, ciEnv()), 'http://localhost:8000');
  const localhost = 'postgresql+psycopg://biletflow_test:fixture-only@localhost:5432/biletflow_test';
  assert.equal(liveTarget(ciEnv({ DATABASE_URL: localhost })).mode, 'ci');
  const cases = [
    [ciEnv({ ENVIRONMENT: 'production' }), /ENVIRONMENT must be "test"/],
    [without(ciEnv(), 'ENVIRONMENT'), /ENVIRONMENT must be "test"/],
    [ciEnv({ DATABASE_URL: 'postgresql+psycopg://biletflow_test:fixture-only@db.example.com:5432/biletflow_test' }), /host must be 127\.0\.0\.1 or localhost/],
    [ciEnv({ DATABASE_URL: 'postgresql+psycopg://biletflow_test:fixture-only@127.0.0.1:5432/biletflow' }), /database must be biletflow_test/],
    [ciEnv({ DATABASE_URL: 'not a url' }), /DATABASE_URL cannot be verified/],
    [without(ciEnv(), 'DATABASE_URL'), /DATABASE_URL cannot be verified/],
  ];
  for (const [env, message] of cases) {
    assert.throws(() => liveTarget(env), error => {
      assert.match(error.message, message);
      assert.equal(error.message.includes('fixture-only'), false, 'the database password must not reach an error');
      return true;
    });
    assert.throws(() => liveApiUrl(undefined, env), message);
  }
});

test('without the runner variable and outside CI=true the live target is refused', () => {
  for (const env of [{}, without(ciEnv(), 'CI'), ciEnv({ CI: '1' }), ciEnv({ CI: 'TRUE' }), ciEnv({ CI: 'false' })]) {
    assert.throws(() => liveTarget(env), strictMessage);
    assert.throws(() => liveApiUrl(undefined, env), strictMessage);
  }
  // playwright.live.config.mjs belongs to the runner: CI mode never replaces its Docker proof.
  assert.throws(() => liveTarget(ciEnv(), { liveConfig: true }), strictMessage);
});

test('a CI session returns the plain request fixture without touching the page or Docker', async () => {
  const names = ['BILETFLOW_LIVE_API_URL', 'CI', 'ENVIRONMENT', 'DATABASE_URL'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const untouched = new Proxy({}, { get: (_target, property) => { throw new Error('CI mode used page.' + String(property)); } });
  const request = { marker: 'request fixture' };
  try {
    delete process.env.BILETFLOW_LIVE_API_URL;
    Object.assign(process.env, ciEnv());
    const session = await verifyLiveSession(untouched, request, { config: { metadata: {} } });
    assert.deepEqual(Object.keys(session), ['request']);
    assert.equal(session.request, request);
    await assert.rejects(verifyLiveSession(untouched, request, { config: { metadata: { liveMode: 'dev' } } }), strictMessage);
    process.env.ENVIRONMENT = 'production';
    await assert.rejects(verifyLiveSession(untouched, request, { config: { metadata: {} } }), /ENVIRONMENT must be "test"/);
    delete process.env.CI;
    await assert.rejects(verifyLiveSession(untouched, request, { config: { metadata: {} } }), strictMessage);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});
