import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { liveApiUrl, verifyLiveSession } from './live-api.mjs';

test('real Campaign QR decodes, opens the discounted checkout and cannot admit the buyer', async ({page, request: raw}, testInfo) => {
  test.skip(process.env.RUN_LIVE_TICKETS !== '1', 'Requires a verified disposable API and database.');
  test.setTimeout(90000);
  const {request} = await verifyLiveSession(page, raw, testInfo);
  const base = liveApiUrl();
  async function send(method, path, data, headers = {}) {
    const response = await request[method](base + path, {data, headers});
    expect(response.ok(), path + ' returned ' + response.status()).toBe(true);
    return response.json();
  }
  const password = randomUUID();
  const owner = 'campaign-owner-' + randomUUID() + '@example.com';
  const buyer = 'campaign-buyer-' + randomUUID() + '@example.com';
  for (const [email, role] of [[owner, 'organizer'], [buyer, 'attendee']]) {
    await send('post', '/auth/register', {email, role, full_name: 'Campaign Test', password});
  }
  const session = await send('post', '/auth/login', {email: owner, password});
  const headers = {Authorization: 'Bearer ' + session.access_token};
  const event = await send('post', '/events', {title: 'Campaign browser test', date: '2030-07-15T12:00:00Z', location: 'Test Hall', capacity: 1}, headers);
  const eventPath = '/events/' + event.id;
  const published = await send('post', eventPath + '/publish', undefined, headers);
  await send('patch', eventPath + '/ticket-types/' + published.ticket_types[0].id, {price_tiyn: 10050}, headers);
  for (const [path, body] of [
    ['/organizer-profiles', {organization_name: 'Campaign Test'}],
    ['/organizer-profiles/me/confirm-identity'],
    ['/organizer-profiles/me/payout-details', {reference_last4: 'TEST'}],
    [eventPath + '/activation/terms'], [eventPath + '/activation/fee'],
  ]) await send('post', path, body, headers);
  const campaign = await send('post', eventPath + '/campaigns', {name: 'Demo', kind: 'percent', value: 25, max_uses: 1}, headers);
  const response = await request.get(base + eventPath + '/campaigns/' + campaign.id + '/qr.svg', {headers});
  expect(response.ok()).toBe(true);
  const svg = await response.body();
  await page.setContent('<img alt="Campaign QR" src="data:image/svg+xml;base64,' + svg.toString('base64') + '">');
  const png = PNG.sync.read(await page.getByAltText('Campaign QR').screenshot());
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
  expect(decoded).toBe(campaign.link);
  const link = new URL(decoded);
  expect(link.protocol).toBe('https:');
  // Exercise the decoded route on the isolated web server; no external navigation.
  await page.goto(link.pathname + link.search);
  await expect(page.getByRole('status').filter({hasText: campaign.code})).toBeVisible();
  await page.getByRole('link', {name: 'Войти, чтобы получить билет'}).click();
  await page.getByLabel('Email', {exact: true}).fill(buyer);
  await page.getByLabel('Пароль', {exact: true}).fill(password);
  await page.getByRole('button', {name: 'Войти', exact: true}).click();
  await page.getByRole('button', {name: 'Купить', exact: true}).click();
  await expect(page.getByRole('status').filter({hasText: campaign.code})).toContainText('75,37');
  await page.getByRole('button', {name: 'Продолжить к оплате'}).click();
  await page.getByRole('button', {name: 'Имитировать успешную оплату'}).click();
  await expect(page.getByRole('link', {name: 'Открыть билет'})).toBeVisible();
  const denied = await request.post(base + eventPath + '/check-in', {headers, data: {qr_payload: decoded, request_id: randomUUID()}});
  expect(denied.status()).toBe(409);
  expect((await denied.json()).detail.code).toBe('CAMPAIGN_QR_NOT_TICKET');
  const [report] = await send('get', eventPath + '/campaigns', undefined, headers);
  expect(report).toMatchObject({redemptions: 1, tickets_sold: 1, gross_tiyn: 10050, discount_tiyn: 2513, organizer_net_tiyn: 7311});
});
