import { build, createServer, preview } from 'vite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveApiUrl, webRoot } from './live-environment.mjs';

export async function startLiveWeb({ origin, production, outDir = resolve(webRoot, 'dist'), port = 5173 }) {
  // Vite's process env has priority over .env* in both build and dev.
  process.env.VITE_API_URL = liveApiUrl(origin);
  const serverOptions = { host: 'localhost', port, strictPort: true };
  if (production) {
    // Never serve a pre-existing dist selected only via preview environment.
    await build({ root: webRoot, build: { outDir }, logLevel: 'warn' });
    const server = await preview({ root: webRoot, build: { outDir }, preview: serverOptions });
    return { close: () => server.close() };
  }
  const server = await createServer({ root: webRoot, server: serverOptions });
  await server.listen();
  return { close: () => server.close() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startLiveWeb({ origin: liveApiUrl(), production: process.env.BILETFLOW_PRODUCTION_PREVIEW === '1' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
}
