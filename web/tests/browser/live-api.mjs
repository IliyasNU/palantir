import { writeFile } from 'node:fs/promises';
import { liveApiUrl as strictLiveApiUrl, inspectLiveBackend, webEvidence } from '../../scripts/live-environment.mjs';
import { installWriteGate, publicGet, verifiedRequests } from '../../scripts/live-browser-guard.mjs';

export { publicGet };

/** GitHub Actions starts the API directly with uvicorn on this origin, without Docker. */
export const ciApiUrl = 'http://localhost:8000';

const refuseCi = message => { throw new Error('Live preflight (CI mode): ' + message); };

/**
 * Selects how a live test proves its target before any request:
 * - BILETFLOW_LIVE_API_URL is set (scripts/run-live.mjs): the strict Docker-inspected path, unchanged;
 * - otherwise CI=true (GitHub Actions): the fixed CI origin, only with the workflow's
 *   ENVIRONMENT=test and a local biletflow_test DATABASE_URL;
 * - otherwise refused with the strict message, so a local run still needs the runner.
 * playwright.live.config.mjs (liveConfig) always needs the strict path: its evidence depends on it.
 * DATABASE_URL carries a password and is never copied into an error.
 */
export function liveTarget(env = process.env, { liveConfig = false } = {}) {
  if (env.BILETFLOW_LIVE_API_URL !== undefined) return { mode: 'strict', origin: strictLiveApiUrl(env.BILETFLOW_LIVE_API_URL) };
  if (env.CI !== 'true' || liveConfig) return { mode: 'strict', origin: strictLiveApiUrl('') }; // always throws
  if (env.ENVIRONMENT !== 'test') refuseCi('ENVIRONMENT must be "test"');
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { refuseCi('DATABASE_URL cannot be verified'); }
  if (!['127.0.0.1', 'localhost'].includes(database.hostname)) refuseCi('DATABASE_URL host must be 127.0.0.1 or localhost');
  if (database.pathname !== '/biletflow_test') refuseCi('DATABASE_URL database must be biletflow_test');
  return { mode: 'ci', origin: ciApiUrl };
}

/** The verified API origin; an explicit value is always validated by the strict rules. */
export function liveApiUrl(value, env = process.env) {
  return value === undefined ? liveTarget(env).origin : strictLiveApiUrl(value);
}

/** Called before any live API setup or form submission in every opt-in test. */
export async function verifyLiveSession(page, request, testInfo) {
  // CI mode: environment assertions only; no Docker inspection and no write gate.
  if (liveTarget(process.env, { liveConfig: testInfo.config.metadata?.liveMode !== undefined }).mode === 'ci') return { request };
  const origin = liveApiUrl();
  const startedAt = new Date().toISOString();
  const gate = await installWriteGate(page.context(), origin);
  // Any inspection failure leaves browser writes blocked and prevents API setup.
  const backend = await inspectLiveBackend({ origin });
  const catalog = await publicGet(page, origin, '/events', () => page.goto('/events'));
  const browser = page.context().browser();
  const evidence = {
    startedAt, verifiedAt: new Date().toISOString(), apiOrigin: origin,
    web: await webEvidence(), backend, clientProbe: catalog,
    browser: {
      name: browser?.browserType().name() ?? 'unknown',
      channel: testInfo.project.use.channel ?? 'unknown',
      version: browser?.version() ?? 'unknown',
      headless: testInfo.project.use.headless ?? 'unknown',
      viewport: page.viewportSize() ?? 'unknown',
    },
    mode: testInfo.config.metadata.liveMode ?? 'unknown',
  };
  await writeFile(testInfo.outputPath('preflight.json'), JSON.stringify(evidence, null, 2) + '\n');
  gate.allowVerifiedWrites();
  return { evidence, gate, request: verifiedRequests(request, origin) };
}
