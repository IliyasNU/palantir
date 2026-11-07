/** Explicit opt-in tests only; the application has no mock/live switch. */
export function liveApiUrl() {
  const url = new URL(process.env.BILETFLOW_LIVE_API_URL || 'http://localhost:8000');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Live tests require an explicit local HTTP API origin.');
  }
  return url.origin;
}

export function requireTestDatabase() {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.ENVIRONMENT !== 'test'
    || !['127.0.0.1', 'localhost'].includes(database.hostname)
    || database.pathname !== '/biletflow_test') {
    throw new Error('Verify an isolated local biletflow_test database before running live tests.');
  }
}
