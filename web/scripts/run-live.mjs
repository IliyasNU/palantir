import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectLiveBackend, liveApiUrl, webRoot } from './live-environment.mjs';

const { values } = parseArgs({ options: {
  api: { type: 'string' }, project: { type: 'string' }, 'backend-ref': { type: 'string' },
  mode: { type: 'string', default: 'dev' }, channel: { type: 'string' }, 'preflight-only': { type: 'boolean' },
} });
if (!['dev', 'production'].includes(values.mode)) throw new Error('--mode must be dev or production');
const origin = liveApiUrl(values.api);
if (values['preflight-only']) {
  console.log(JSON.stringify(await inspectLiveBackend({ origin, project: values.project, backendRef: values['backend-ref'] }), null, 2));
} else {
  const env = { ...process.env,
    BILETFLOW_LIVE_API_URL: origin, BILETFLOW_TEST_COMPOSE_PROJECT: values.project ?? '',
    BILETFLOW_BACKEND_REF: values['backend-ref'] ?? '',
    BILETFLOW_PRODUCTION_PREVIEW: values.mode === 'production' ? '1' : '0',
    RUN_LIVE_AUTH: '1', RUN_LIVE_TICKETS: '1', RUN_LIVE_667: '1', RUN_LIVE_RECOVERY: '0', PLAYWRIGHT_NO_COPY_PROMPT: '1',
  };
  if (values.channel) env.PLAYWRIGHT_CHANNEL = values.channel;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)),
    'test', '--config', 'playwright.live.config.mjs'], { cwd: webRoot, env, stdio: 'inherit', windowsHide: true });
  child.on('error', () => { console.error('Unable to start Playwright'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
