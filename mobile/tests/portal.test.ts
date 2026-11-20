import assert from 'node:assert/strict';
import test from 'node:test';
import { isPortalUrl, portalArea, portalEntry, readTicketPdfMessage } from '../src/portal.ts';

const origin = 'https://biletflow.example';
const base64 = Buffer.from('%PDF-1.3\nfixture\n%%EOF\n').toString('base64');

test('each portal section opens its web entry point using the configured origin', () => {
  assert.deepEqual(portalEntry(origin, 'attendee', false), { origin, url: origin + '/events' });
  assert.equal(portalEntry(origin + '/', 'organizer', false)?.url, origin + '/organizer');
  assert.equal(portalEntry(origin, 'admin', false)?.url, origin + '/admin');
  assert.equal(portalArea('https://untrusted.example'), 'attendee');
});

test('development permits private LAN HTTP, while release builds require a root HTTPS address', () => {
  const local = 'http://192.168.1.10:5173';
  assert.equal(portalEntry(local, 'attendee', true)?.url, local + '/events');
  assert.equal(portalEntry(local, 'attendee', false), null);
  for (const invalid of [undefined, 'http://public.example', origin + '/events', origin + '?', origin + '#',
    'https://user:password@biletflow.example', 'file:///index.html']) {
    assert.equal(portalEntry(invalid, 'attendee', true), null);
  }
});

test('navigation stays on the configured origin, including scheme and port', () => {
  assert.equal(isPortalUrl(origin + '/login?returnTo=/tickets/21', origin), true);
  for (const invalid of [origin + '.other.example', origin + ':8443', 'http://biletflow.example',
    'blob:' + origin + '/xyz', 'data:text/html,example', 'intent://other-app']) {
    assert.equal(isPortalUrl(invalid, origin), false);
  }
});

test('PDF messages from iOS document URLs and Android sender origins produce a local ticket filename', () => {
  const message = JSON.stringify({ type: 'biletflow-ticket-pdf', ticketId: 21, base64 });
  const expected = { name: 'biletflow-ticket-21.pdf', base64 };
  assert.deepEqual(readTicketPdfMessage(message, origin + '/tickets/21', origin), expected);
  assert.deepEqual(readTicketPdfMessage(message, origin, origin), expected);
  assert.equal(readTicketPdfMessage(message, 'https://other.example/tickets/21', origin), null);
  for (const invalid of [null, { type: 'share', ticketId: 21, base64 },
    { type: 'biletflow-ticket-pdf', ticketId: '../secret', base64 },
    { type: 'biletflow-ticket-pdf', ticketId: 21, base64: 'aGVsbG8=' }]) {
    assert.equal(readTicketPdfMessage(JSON.stringify(invalid), origin, origin), null);
  }
});
