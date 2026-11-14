import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { build, preview } from 'vite';
import { writeFile } from 'node:fs/promises';
import { installWriteGate, publicGet } from '../../scripts/live-browser-guard.mjs';
import { startLiveWeb } from '../../scripts/live-web-server.mjs';
import { webRoot } from '../../scripts/live-environment.mjs';
import { verifyLiveSession } from './live-api.mjs';

async function receiver() {
  const writes = [];
  let redirect;
  const server = createServer((req, res) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) writes.push(req.method);
    req.resume();
    if (redirect && req.method === 'POST') {
      res.writeHead(307, { Location: redirect + '/auth/register', 'Access-Control-Allow-Origin': '*' });
      res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' });
    res.end(req.method === 'GET' ? '[]' : '{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { origin: 'http://127.0.0.1:' + server.address().port, writes, redirectTo: origin => { redirect = origin; },
    close: () => new Promise(done => server.close(done)) };
}
const attemptWrite = (page, origin) => page.evaluate(async url => {
  try { await fetch(url + '/auth/register', { method: 'POST', body: '{}' }); return 'sent'; } catch { return 'blocked'; }
}, origin);

test('old production dist cannot write to another origin; fresh build uses the selected origin', async ({ browser, request }, testInfo) => {
  test.skip(testInfo.config.metadata.isolationRegression !== true, 'Run explicitly with playwright.isolation.config.mjs; uses two disposable HTTP receivers, no database.');
  const other = await receiver(), selected = await receiver();
  const contexts = [];
  const pageAt = async () => {
    const context = await browser.newContext({ baseURL: 'http://localhost:5173' }); contexts.push(context);
    return context.newPage();
  };
  const originalApi = process.env.BILETFLOW_LIVE_API_URL, originalProject = process.env.BILETFLOW_TEST_COMPOSE_PROJECT;
  let server;
  try {
    const unverified = await pageAt();
    process.env.BILETFLOW_LIVE_API_URL = selected.origin;
    delete process.env.BILETFLOW_TEST_COMPOSE_PROJECT;
    await expect(async () => {
      const session = await verifyLiveSession(unverified, request, testInfo);
      await session.request.post(selected.origin + '/auth/register', { data: {} });
    }).rejects.toThrow(/BILETFLOW_TEST_COMPOSE_PROJECT/);
    await attemptWrite(unverified, selected.origin);
    await attemptWrite(unverified, other.origin);
    expect(selected.writes).toHaveLength(0);
    expect(other.writes).toHaveLength(0);

    // A real production bundle made with the wrong origin; no application mock mode.
    const outDir = testInfo.outputPath('stale-dist');
    process.env.VITE_API_URL = other.origin;
    await build({ root: webRoot, build: { outDir }, logLevel: 'silent' });
    const stale = await preview({ root: webRoot, build: { outDir }, preview: { host: 'localhost', port: 5173, strictPort: true }, logLevel: 'silent' });
    server = { close: () => stale.close() };
    const stalePage = await pageAt();
    const staleGate = await installWriteGate(stalePage.context(), selected.origin);
    await expect(publicGet(stalePage, selected.origin, '/events', () => stalePage.goto('/events')))
      .rejects.toThrow(/Browser API origin/);
    await attemptWrite(stalePage, other.origin);
    await attemptWrite(stalePage, selected.origin);
    expect(staleGate.blocked).toHaveLength(2);
    expect(other.writes).toHaveLength(0);
    expect(selected.writes).toHaveLength(0);
    await stalePage.context().close();
    await server.close(); server = null;

    // This is the same launcher used by production live config: it must replace stale dist.
    server = await startLiveWeb({ origin: selected.origin, production: true, outDir });
    const freshPage = await pageAt();
    const freshGate = await installWriteGate(freshPage.context(), selected.origin);
    const observed = await publicGet(freshPage, selected.origin, '/events', () => freshPage.goto('/events'));
    freshGate.allowVerifiedWrites(); // HTTP receiver test only; real live sessions require Docker proof first.
    await attemptWrite(freshPage, other.origin);
    await attemptWrite(freshPage, selected.origin);
    expect(other.writes).toHaveLength(0);
    expect(selected.writes).toEqual(['POST']);
    expect(observed.origin).toBe(selected.origin);
    selected.redirectTo(other.origin);
    expect(await attemptWrite(freshPage, selected.origin)).toBe('blocked');
    expect(other.writes).toHaveLength(0);
    expect(selected.writes).toEqual(['POST', 'POST']);
    await writeFile(testInfo.outputPath('isolation-evidence.json'), JSON.stringify({
      completedAt: new Date().toISOString(), receiverOnly: true, databaseUsed: false,
      otherOrigin: other.origin, selectedOrigin: selected.origin,
      unverifiedBackend: 'blocked before setup', staleDist: 'origin mismatch; writes blocked',
      redirectedWrite: 'blocked at selected origin; no replay to other origin', freshBuild: observed, otherWrites: other.writes.length, selectedWrites: selected.writes.length,
      browser: { name: browser.browserType().name(), version: browser.version(), channel: testInfo.project.use.channel ?? 'unknown' },
    }, null, 2) + '\n');
  } finally {
    for (const context of contexts) await context.close();
    if (server) await server.close();
    await other.close(); await selected.close();
    if (originalApi === undefined) delete process.env.BILETFLOW_LIVE_API_URL; else process.env.BILETFLOW_LIVE_API_URL = originalApi;
    if (originalProject === undefined) delete process.env.BILETFLOW_TEST_COMPOSE_PROJECT; else process.env.BILETFLOW_TEST_COMPOSE_PROJECT = originalProject;
  }
});
