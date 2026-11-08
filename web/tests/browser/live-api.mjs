import { writeFile } from 'node:fs/promises';
import { liveApiUrl, inspectLiveBackend, webEvidence } from '../../scripts/live-environment.mjs';
import { installWriteGate, publicGet, verifiedRequests } from '../../scripts/live-browser-guard.mjs';

export { liveApiUrl, publicGet };

/** Called before any live API setup or form submission in every opt-in test. */
export async function verifyLiveSession(page, request, testInfo) {
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
