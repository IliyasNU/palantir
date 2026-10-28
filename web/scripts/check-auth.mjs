import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Intentionally fixed to the local stack; never accepts an external API target.
const base = 'http://localhost:8000';
async function request(path, options, status) {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}: unexpected HTTP status`);
  console.log(`${options?.method ?? 'GET'} ${path} -> ${response.status}`);
  return response.json();
}
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const health = await request('/health', undefined, 200);
assert.equal(health.database, 'up');
const credentials = { email: `fe01-http-${randomUUID()}@example.com`, password: randomUUID() };
const user = await request('/auth/register', post({ ...credentials, full_name: 'FE01 HTTP Visitor', role: 'attendee' }), 201);
assert.equal(user.role, 'attendee');
assert.equal('access_token' in user, false);
const tokens = await request('/auth/login', post(credentials), 200);
assert.ok(typeof tokens.access_token === 'string' && tokens.access_token.length > 0);
const me = await request('/auth/me', { headers: { Authorization: `Bearer ${tokens.access_token}` } }, 200);
assert.equal(me.id, user.id);
await request('/auth/login', post({ email: credentials.email, password: 'wrong-password' }), 401);
await request('/auth/register', post({ ...credentials, full_name: 'FE01 HTTP Visitor', role: 'attendee' }), 409);
console.log(`Local attendee created: id=${user.id}. No passwords or tokens are logged.`);
