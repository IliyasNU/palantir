import assert from 'node:assert/strict';

const apiRequest = (request, path) => ['fetch', 'xhr'].includes(request.resourceType())
  && new URL(request.url()).pathname === path;
export function assertPublicRequest(request, origin, path) {
  const url = new URL(request.url());
  assert.equal(url.origin, origin, 'Browser API origin differs from the verified backend');
  assert.equal(url.pathname, path);
  assert.equal(request.method(), 'GET', 'Public request must be GET');
  assert.equal(url.search === '' && !url.href.includes('?'), true, 'Public requests must not contain query parameters');
  assert.equal(request.headers().authorization === undefined, true, 'Guest request must not carry Authorization');
}
export async function publicGet(page, origin, path, navigate, status = 200) {
  // Both waits are installed before the navigation/click/reload.
  const requested = page.waitForRequest(request => apiRequest(request, path), { timeout: 10000 });
  const responded = page.waitForResponse(response => apiRequest(response.request(), path), { timeout: 10000 });
  // Avoid dangling rejected waiters if origin/request validation fails early.
  requested.catch(() => {}); responded.catch(() => {});
  await navigate();
  const request = await requested;
  assertPublicRequest(request, origin, path);
  const response = await responded;
  assertPublicRequest(response.request(), origin, path);
  assert.equal(response.status(), status, 'Unexpected public API response');
  return { origin, method: request.method(), path, query: '', authorization: false, status: response.status() };
}

export async function installWriteGate(context, origin) {
  // Keep the real browser transport/CORS. Fetch must not replay a POST after 307/308.
  await context.addInitScript(() => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      return nativeFetch(input, ['GET', 'HEAD', 'OPTIONS'].includes(method) ? init : { ...init, redirect: 'error' });
    };
  });
  let verified = false;
  const blocked = [];
  await context.route('**/*', async route => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      && (!verified || new URL(request.url()).origin !== origin)) {
      // Store only method and origin; bodies/headers may contain passwords or tokens.
      blocked.push({ method: request.method(), origin: new URL(request.url()).origin });
      await route.abort('blockedbyclient');
    } else await route.fallback();
  });
  return {
    blocked,
    allowVerifiedWrites() { verified = true; },
  };
}

export function verifiedRequests(request, origin) {
  return new Proxy(request, {
    get(target, property) {
      if (['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head'].includes(property)) {
        return (url, options = {}) => {
          assert.equal(new URL(url).origin, origin, 'HTTP setup must use the verified API origin');
          // Do not follow a redirect into another backend, including after a POST.
          return target[property](url, { ...options, maxRedirects: 0 });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
