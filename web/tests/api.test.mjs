import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient, getErrorMessage } from '../src/api/client.ts';

const baseUrl = 'http://localhost:8000';
const clientReturning = (response) => createApiClient(baseUrl, async () => response);

test('uses the configured base URL, JSON body, custom headers and explicit bearer token', async () => {
  const client = createApiClient('https://api.example.test/v1/', async (url, options) => {
    assert.equal(url, 'https://api.example.test/v1/auth/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.get('Content-Type'), 'application/json');
    assert.equal(options.headers.get('Accept'), 'application/json');
    assert.equal(options.headers.get('X-Request-ID'), 'test-request');
    assert.equal(options.headers.get('Authorization'), 'Bearer test-access-token');
    assert.deepEqual(JSON.parse(options.body), { email: 'test@example.com', password: 'test-password' });
    return Response.json({ id: 7 });
  });

  assert.deepEqual(await client.request('/auth/login', {
    method: 'POST',
    body: { email: 'test@example.com', password: 'test-password' },
    headers: { 'X-Request-ID': 'test-request' },
    token: 'test-access-token',
  }), { id: 7 });
});

test('GET has no body, content-type or invented authorization', async () => {
  const client = createApiClient(baseUrl, async (_url, options) => {
    assert.equal(options.body, undefined);
    assert.equal(options.headers.has('Content-Type'), false);
    assert.equal(options.headers.has('Authorization'), false);
    return Response.json({ status: 'ok' });
  });
  await client.request('/health');
});

test('FastAPI 422 produces readable field errors and preserves their locations', async () => {
  const client = clientReturning(Response.json({ detail: [
    { loc: ['body', 'email'], msg: 'value is not a valid email address', type: 'value_error' },
    { loc: ['body', 'attendees', 0, 'full_name'], msg: 'Field required', type: 'missing' },
    { loc: ['body', 'password'], msg: 'String should have at least 8 characters', input: 'private-input' },
  ] }, { status: 422 }));

  await assert.rejects(client.request('/auth/register'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, 'validation');
    assert.equal(error.status, 422);
    assert.deepEqual(error.issues.map((issue) => issue.field), ['email', 'attendees.0.full_name', 'password']);
    assert.match(error.message, /email: value is not a valid email address/);
    assert.match(error.message, /password: String should have at least 8 characters/);
    assert.doesNotMatch(error.message, /\[object Object\]|private-input/);
    return true;
  });
});

test('HTTP error supports FastAPI string detail and structured message detail', async () => {
  for (const detail of ['Email already registered', { message: 'Email already registered' }]) {
    const client = clientReturning(Response.json({ detail }, { status: 409 }));
    await assert.rejects(client.request('/auth/register'), (error) => {
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 409);
      assert.equal(error.message, 'Email already registered');
      return true;
    });
  }
});

test('unrecognized validation objects fall back to a readable message', async () => {
  for (const detail of [{ unexpected: true }, [{ msg: { nested: 'object' } }], null]) {
    const client = clientReturning(Response.json({ detail }, { status: 422 }));
    await assert.rejects(client.request('/auth/register'), (error) => {
      assert.equal(error.message, 'Проверьте введённые данные.');
      assert.deepEqual(error.issues, []);
      return true;
    });
  }
});

test('HTML, empty HTTP errors and server internals never become UI content', async () => {
  const responses = [
    new Response('<html>proxy error</html>', { status: 502 }),
    Response.json({ detail: 'private server internals' }, { status: 500 }),
    new Response(null, { status: 401 }),
  ];
  for (const response of responses) {
    const status = response.status;
    await assert.rejects(clientReturning(response).request('/health'), (error) => {
      assert.equal(error.kind, 'http');
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /<html>|private server internals|\[object Object\]/);
      assert.ok(error.message.length > 0);
      return true;
    });
  }
});

test('network rejection has a readable message and no HTTP status', async () => {
  const failure = new TypeError('Failed to fetch');
  const client = createApiClient(baseUrl, async () => { throw failure; });
  await assert.rejects(client.request('/health'), (error) => {
    assert.equal(error.kind, 'network');
    assert.equal(error.status, undefined);
    assert.equal(error.cause, failure);
    assert.match(getErrorMessage(error), /Не удалось связаться с сервером/);
    return true;
  });
});

test('connection loss while reading a response is also a network error', async () => {
  const client = createApiClient(baseUrl, async () => ({
    text: async () => { throw new TypeError('Connection closed'); },
  }));
  await assert.rejects(client.request('/health'), (error) => error.kind === 'network');
});

test('malformed successful JSON is a response error, not a fake success', async () => {
  const client = clientReturning(new Response('<html>not JSON</html>', { status: 200 }));
  await assert.rejects(client.request('/health'), (error) => {
    assert.equal(error.kind, 'response');
    assert.equal(error.status, 200);
    assert.doesNotMatch(error.message, /<html>/);
    return true;
  });
});

test('204 response resolves without trying to parse JSON', async () => {
  const client = clientReturning(new Response(null, { status: 204 }));
  assert.equal(await client.request('/resource', { method: 'DELETE' }), undefined);
});

test('AbortSignal is passed to fetch and cancellation is preserved', async () => {
  const controller = new AbortController();
  const failure = new DOMException('Cancelled', 'AbortError');
  const client = createApiClient(baseUrl, async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(failure);
    throw failure;
  });
  await assert.rejects(client.request('/health', { signal: controller.signal }), (error) => error === failure);
});

test('missing or invalid configuration fails before making a request', async () => {
  for (const url of [undefined, '', 'invalid', 'ftp://localhost', 'http://localhost:8000?query=1']) {
    const client = createApiClient(url, async () => {
      assert.fail('No fetch should occur with an invalid base URL');
    });
    await assert.rejects(client.request('/health'), (error) => error.kind === 'configuration');
  }
});

test('request paths cannot replace the configured server', async () => {
  const client = createApiClient(baseUrl, async () => { assert.fail('No fetch should occur'); });
  for (const path of ['https://other.example.test/health', '//other.example.test/health', 'health']) {
    await assert.rejects(client.request(path), (error) => error.kind === 'configuration');
  }
});

test('unknown UI errors are never coerced into [object Object]', () => {
  for (const error of [{ detail: { nested: 'object' } }, new Error('internal error'), null]) {
    assert.equal(getErrorMessage(error), 'Произошла ошибка. Попробуйте ещё раз.');
  }
});
