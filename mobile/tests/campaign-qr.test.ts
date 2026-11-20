import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../src/api.ts';
import { createScanSession } from '../src/scanner.ts';
import { errorMessage } from '../src/messages.ts';

test('campaign rejection explains the QR and leaves the scanner ready for the next ticket', async () => {
  const api = createApi('https://biletflow.example', async () =>
    Response.json({detail: {code: 'CAMPAIGN_QR_NOT_TICKET'}}, {status: 409}));
  const session = createScanSession((token, body) => api.checkIn(token, 7, body), () => 'campaign-qr-test');
  session.setToken('fixture');
  const result = await session.scanner.scan('https://biletflow.example/events/7?campaign=pc_' + 'a'.repeat(32));
  assert.equal(result?.receipt, undefined);
  assert.equal(result?.error?.code, 'CAMPAIGN_QR_NOT_TICKET');
  assert.equal(errorMessage(result?.error, 'ru'), 'Это QR акции, а не билет.');
  assert.equal(session.scanner.mustResolve(), false);
  assert.equal(session.scanner.next(), true);
});
