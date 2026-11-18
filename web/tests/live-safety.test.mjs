import test from 'node:test';
import assert from 'node:assert/strict';
import { liveApiUrl, validateTopology, validateBinding } from '../scripts/live-environment.mjs';
import { assertPublicRequest, publicGet, verifiedRequests } from '../scripts/live-browser-guard.mjs';

function fixture() {
  const project = 'isolated-test', name = project + '_default';
  const labels = service => ({ 'com.docker.compose.project': project, 'com.docker.compose.service': service });
  const container = (id, service) => ({
    Id: id, State: { Running: true }, Config: { Labels: labels(service), Env: [] },
    HostConfig: { NetworkMode: name, Privileged: false }, Mounts: [],
    NetworkSettings: { Networks: { [name]: { IPAddress: id === 'db-id' ? '172.20.0.3' : '172.20.0.2', Aliases: [service] } }, Ports: {} },
  });
  const backend = container('api-id', 'backend'), database = container('db-id', 'db');
  backend.Config.Env = ['ENVIRONMENT=test', 'DATABASE_URL=postgresql+psycopg://test:fixture@db:5432/biletflow_test'];
  backend.NetworkSettings.Ports['8000/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '8002' }];
  database.Config.Env = ['POSTGRES_DB=biletflow_test', 'POSTGRES_USER=test', 'POSTGRES_PASSWORD=fixture'];
  const volume = { Name: project + '_postgres_data', Driver: 'local', Options: null,
    Labels: { 'com.docker.compose.project': project, 'com.docker.compose.volume': 'postgres_data' } };
  database.Mounts = [{ Type: 'volume', Destination: '/var/lib/postgresql/data', Name: volume.Name }];
  return { project, origin: 'http://localhost:8002', backend, database, volume, volumeUsers: ['db-id'],
    network: { Name: name, Driver: 'bridge', Labels: { 'com.docker.compose.project': project }, Containers: { 'api-id': {}, 'db-id': {} } } };
}
test('live origin must be explicit and local; environment labels do not authorize arbitrary origins', () => {
  assert.equal(liveApiUrl('http://127.0.0.1:8002'), 'http://127.0.0.1:8002');
  for (const value of ['', 'https://example.com', 'http://localhost:8002/events', 'http://u:p@localhost:8002', 'http://localhost:8002?', 'http://localhost:8002#']) {
    assert.throws(() => liveApiUrl(value));
  }
});
test('Docker proof rejects a wrong API port, shared volume, production DB and source mounts', () => {
  assert.equal(validateTopology(fixture()).databaseIp, '172.20.0.3');
  for (const mutate of [
    f => { f.origin = 'http://localhost:8001'; },
    f => { f.backend.Config.Env[0] = 'ENVIRONMENT=production'; },
    f => { f.backend.Config.Env[1] = 'DATABASE_URL=postgresql+psycopg://test:fixture@shared:5432/biletflow_test'; },
    f => { f.database.Config.Env[0] = 'POSTGRES_DB=team'; },
    f => { f.volume.Name = 'palantir_postgres_data'; },
    f => { f.volume.Labels = {}; },
    f => { f.volumeUsers.push('other-db'); },
    f => { f.backend.Mounts.push({ Type: 'bind', Destination: '/app' }); },
    f => { f.network.Containers.other = {}; },
  ]) {
    const value = fixture(); mutate(value); assert.throws(() => validateTopology(value));
  }
});
test('backend engine must match both the inspected PostgreSQL address and cluster ID', () => {
  const probe = { environment: 'test', sourceMatches: true, databaseHost: 'db', databasePort: 5432,
    database: 'biletflow_test', serverAddress: '172.20.0.3', serverPort: 5432, clusterId: 'cluster-1' };
  const identity = { database: 'biletflow_test', clusterId: 'cluster-1' };
  const topology = { databaseIp: '172.20.0.3' };
  validateBinding(probe, identity, topology);
  assert.throws(() => validateBinding(probe, { ...identity, clusterId: 'cluster-2' }, topology));
  assert.throws(() => validateBinding({ ...probe, serverAddress: '172.20.0.9' }, identity, topology));
});
const req = (url = 'http://localhost:8002/events', method = 'GET', headers = {}) => ({
  url: () => url, method: () => method, headers: () => headers, resourceType: () => 'fetch',
});
test('public request validation rejects wrong origin, query, auth and method', () => {
  assertPublicRequest(req(), 'http://localhost:8002', '/events');
  for (const request of [req('http://localhost:8001/events'), req('http://localhost:8002/events?q=x'),
    req(undefined, 'POST'), req(undefined, 'GET', { authorization: 'test-only' })]) {
    assert.throws(() => assertPublicRequest(request, 'http://localhost:8002', '/events'));
  }
});
test('public GET installs waits before navigation and cannot pass without a request', async () => {
  const order = [];
  const request = req();
  const page = {
    waitForRequest: predicate => { order.push('request'); assert.equal(predicate(request), true); return Promise.resolve(request); },
    waitForResponse: predicate => {
      order.push('response');
      const response = { request: () => request, status: () => 200 };
      assert.equal(predicate(response), true); return Promise.resolve(response);
    },
  };
  await publicGet(page, 'http://localhost:8002', '/events', async () => { order.push('navigate'); });
  assert.deepEqual(order, ['request', 'response', 'navigate']);
  await assert.rejects(publicGet({ ...page, waitForRequest: () => Promise.reject(new Error('no request')) },
    'http://localhost:8002', '/events', async () => {}), /no request/);
});
test('API setup refuses another origin and disables redirects', async () => {
  let calls = 0;
  const client = verifiedRequests({ post: async (_url, options) => { calls++; assert.equal(options.maxRedirects, 0); } }, 'http://localhost:8002');
  assert.throws(() => client.post('http://localhost:8001/auth/register'), /verified API/);
  assert.equal(calls, 0);
  await client.post('http://localhost:8002/auth/register');
  assert.equal(calls, 1);
});
