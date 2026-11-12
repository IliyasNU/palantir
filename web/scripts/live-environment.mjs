import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const webRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(webRoot, '..');
const fail = message => { throw new Error('Live preflight: ' + message); };
const check = (condition, message) => { if (!condition) fail(message); };

export function command(program, args, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(program + ' inspection timed out')); }, 20000);
    child.stdout.on('data', data => output.push(data));
    child.stderr.on('data', data => errors.push(data)); // Only known safe probe stages may be reported.
    child.on('error', () => { clearTimeout(timer); reject(new Error(program + ' inspection unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      const stage = Buffer.concat(errors).toString().match(/Backend binding probe failed at (source files|uvicorn process|resolved engine|read-only database identity);/)?.[1];
      if (code !== 0) reject(new Error(program + ' ' + args[0] + ' read-only inspection failed' + (stage ? ': ' + stage : '')));
      else resolveResult(Buffer.concat(output));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function liveApiUrl(value = process.env.BILETFLOW_LIVE_API_URL) {
  let url;
  try { url = new URL(value); } catch { fail('BILETFLOW_LIVE_API_URL must explicitly select the local test API'); }
  check(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && !url.username && !url.password && url.pathname === '/' && !url.href.includes('?') && !url.href.includes('#'),
  'only a local HTTP origin without credentials/path/query/hash is supported');
  return url.origin;
}
const envMap = container => Object.fromEntries(container.Config.Env.map(value => {
  const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
}));

export function validateTopology({ project, origin, backend, database, network, volume, volumeUsers }) {
  check(/^[a-z0-9][a-z0-9_-]+$/.test(project), 'explicit Compose project required');
  for (const [container, service] of [[backend, 'backend'], [database, 'db']]) {
    check(container.State.Running && container.Config.Labels['com.docker.compose.project'] === project
      && container.Config.Labels['com.docker.compose.service'] === service, 'wrong project/service or stopped container');
    check(container.HostConfig.NetworkMode !== 'host' && !container.HostConfig.Privileged, 'unsupported container isolation');
    check(Object.keys(container.NetworkSettings.Networks).length === 1, 'requires a dedicated project network');
  }
  check(backend.Mounts.length === 0, 'backend must run from its image without source/env mounts');
  const apiEnv = envMap(backend), dbEnv = envMap(database);
  check(apiEnv.ENVIRONMENT === 'test' && dbEnv.POSTGRES_DB === 'biletflow_test', 'not a dedicated test database');
  let dbUrl;
  try { dbUrl = new URL(apiEnv.DATABASE_URL); } catch { fail('backend DATABASE_URL cannot be verified'); }
  check(dbUrl.protocol === 'postgresql+psycopg:' && dbUrl.hostname === 'db' && dbUrl.pathname === '/biletflow_test'
    && (dbUrl.port || '5432') === '5432' && !dbUrl.search && !dbUrl.hash, 'backend points to an unexpected database');
  check(decodeURIComponent(dbUrl.username) === dbEnv.POSTGRES_USER
    && decodeURIComponent(dbUrl.password) === dbEnv.POSTGRES_PASSWORD, 'backend database credentials do not match this DB service');
  const ports = backend.NetworkSettings.Ports['8000/tcp'] ?? [];
  check(ports.length === 1 && ports[0].HostIp === '127.0.0.1'
    && ports[0].HostPort === (new URL(origin).port || '80'), 'API origin does not map to this backend container');
  check(network.Labels?.['com.docker.compose.project'] === project && network.Driver === 'bridge'
    && Object.keys(network.Containers ?? {}).sort().join() === [backend.Id, database.Id].sort().join(), 'network shared with another container');
  const netName = network.Name;
  check(Object.keys(backend.NetworkSettings.Networks)[0] === netName
    && Object.keys(database.NetworkSettings.Networks)[0] === netName, 'backend and database network mismatch');
  check(database.NetworkSettings.Networks[netName].Aliases.includes('db'), 'DB service alias missing');
  check(database.Mounts.length === 1 && database.Mounts[0].Type === 'volume'
    && database.Mounts[0].Destination === '/var/lib/postgresql/data'
    && database.Mounts[0].Name === volume.Name, 'unexpected PostgreSQL mount');
  check(volume.Name === project + '_postgres_data'
    && volume.Labels?.['com.docker.compose.project'] === project
    && volume.Labels?.['com.docker.compose.volume'] === 'postgres_data'
    && volume.Driver === 'local' && !Object.keys(volume.Options ?? {}).length, 'volume not owned by this test project');
  check(volumeUsers.length === 1 && volumeUsers[0] === database.Id, 'database volume shared with another container');
  return { databaseIp: database.NetworkSettings.Networks[netName].IPAddress, dbUser: dbEnv.POSTGRES_USER };
}

export function validateBinding(probe, databaseIdentity, topology) {
  check(probe.environment === 'test' && probe.sourceMatches && probe.databaseHost === 'db'
    && probe.databasePort === 5432 && probe.database === 'biletflow_test', 'resolved FastAPI engine is not the test database');
  check(probe.serverAddress === topology.databaseIp && probe.serverPort === 5432, 'FastAPI connection points outside the DB container');
  check(probe.clusterId === databaseIdentity.clusterId && databaseIdentity.database === probe.database,
    'FastAPI and inspected PostgreSQL are different clusters/databases');
}

export async function inspectLiveBackend({ origin = liveApiUrl(), project = process.env.BILETFLOW_TEST_COMPOSE_PROJECT,
  backendRef = process.env.BILETFLOW_BACKEND_REF } = {}) {
  check(typeof project === 'string' && /^[a-z0-9][a-z0-9_-]+$/.test(project), 'BILETFLOW_TEST_COMPOSE_PROJECT is required');
  check(typeof backendRef === 'string' && /^[a-f0-9]{40}$/.test(backendRef), 'BILETFLOW_BACKEND_REF must be a full locally available Git SHA');
  const json = async args => JSON.parse((await command('docker', args)).toString());
  const contexts = await json(['context', 'inspect']);
  check(contexts.length === 1 && /^(npipe:\/\/|unix:\/\/)/.test(contexts[0].Endpoints.docker.Host),
    'remote Docker contexts are not supported');
  check(!process.env.DOCKER_HOST || /^(npipe:\/\/|unix:\/\/)/.test(process.env.DOCKER_HOST), 'remote DOCKER_HOST is not supported');
  const ids = (await command('docker', ['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project])).toString().trim().split(/\s+/).filter(Boolean);
  check(ids.length === 2, 'requires exactly one backend and one DB in the test project');
  const containers = await json(['inspect', ...ids]);
  const backend = containers.find(item => item.Config.Labels['com.docker.compose.service'] === 'backend');
  const database = containers.find(item => item.Config.Labels['com.docker.compose.service'] === 'db');
  check(backend && database, 'test services missing');
  const netName = Object.keys(backend.NetworkSettings.Networks)[0];
  const [network] = await json(['network', 'inspect', netName]);
  const [volume] = await json(['volume', 'inspect', project + '_postgres_data']);
  const volumeUsers = (await command('docker', ['ps', '-aq', '--no-trunc', '--filter', 'volume=' + volume.Name])).toString().trim().split(/\s+/).filter(Boolean);
  const topology = validateTopology({ project, origin, backend, database, network, volume, volumeUsers });
  // An immutable /app plus the running worker environment binds the probe to the server.
  const changes = (await command('docker', ['diff', backend.Id])).toString().split('\n');
  check(!changes.some(line => /^[ACD] \/app(?:\/|$)/.test(line)), 'backend filesystem changed after container creation');
  const paths = (await command('git', ['ls-tree', '-r', '--name-only', backendRef, '--', 'backend/app', 'backend/requirements.txt', 'backend/requirements-dev.txt'])).toString().trim().split('\n');
  check(paths.includes('backend/app/db/session.py') && paths.includes('backend/app/core/config.py'), 'backend source revision unavailable');
  const manifest = {};
  for (const path of paths) {
    manifest[path.slice('backend/'.length)] = createHash('sha256').update((await command('git', ['show', backendRef + ':' + path])).toString().replaceAll('\r\n', '\n')).digest('hex');
  }
  const probeSource = await readFile(new URL('./live-backend-probe.py', import.meta.url));
  const probe = JSON.parse((await command('docker', ['exec', '-i', backend.Id, 'python', '-B', '-', JSON.stringify(manifest)], probeSource)).toString());
  const sql = "SELECT json_build_object('database', current_database(), 'clusterId', system_identifier::text) FROM pg_control_system()";
  const databaseIdentity = JSON.parse((await command('docker', ['exec', database.Id, 'psql', '-U', topology.dbUser, '-d', 'biletflow_test', '-Atc', sql])).toString());
  validateBinding(probe, databaseIdentity, topology);
  const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(5000), redirect: 'error' });
  check(health.status === 200 && (await health.json()).database === 'up', 'API /health did not confirm a live database');
  return {
    checkedAt: new Date().toISOString(), origin, project, volume: volume.Name, database: probe.database,
    databaseClusterId: probe.clusterId, backendContainerId: backend.Id, databaseContainerId: database.Id,
    imageId: backend.Image, sourceSha: backendRef,
    sourceVerification: 'app Python files and requirements match Git revision after CRLF normalization; no /app changes or mounts',
    buildCommit: 'unknown', // This image carries no verified build provenance.
    binding: 'running uvicorn environment + app engine SELECT matches inspected DB cluster and IP',
  };
}

export async function webEvidence() {
  try {
    const sha = (await command('git', ['rev-parse', 'HEAD'])).toString().trim();
    const branch = (await command('git', ['branch', '--show-current'])).toString().trim() || 'detached';
    const changes = (await command('git', ['status', '--porcelain=v1', '--untracked-files=all'])).toString().split('\n').filter(Boolean);
    const paths = (await command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'web'])).toString().split('\0').filter(Boolean).sort();
    const hash = createHash('sha256');
    for (const path of paths) {
      if (path.endsWith('.md') || /(^|\/)\.env(?:\.|$)/.test(path)) continue;
      hash.update(path).update('\0');
      try { hash.update(await readFile(resolve(repoRoot, path))); } catch { hash.update('missing'); }
      hash.update('\0');
    }
    return { sha, branch, worktree: changes.length ? 'dirty' : 'clean', changes,
      codeSha256: hash.digest('hex') };
  } catch { return { sha: 'unknown', branch: 'unknown', worktree: 'unknown', changes: 'unknown', codeSha256: 'unknown' }; }
}
