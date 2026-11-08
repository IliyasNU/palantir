import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { eventDetails } from './event-fixture.mjs';

const base = 'http://localhost:8000';
const ticket = { id: 21, event_id: 42, attendee_id: 1, qr_payload: 'exact server opaque ticket value', created_at: '2030-01-01T00:00:00Z', checked_in_at: null,
  event: { id: 42, title: eventDetails.title, date: eventDetails.date, location: eventDetails.location, status: 'published' } };

async function login(page, destination) {
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: { id: 1, email: 'fixture@example.com', full_name: 'Ticket Visitor', role: 'attendee', is_active: true, created_at: ticket.created_at } }));
  await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
  await page.getByLabel('Email', { exact: true }).fill('fixture@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(destination);
}

async function decodedQr(page) {
  const image = page.getByRole('img', { name: 'QR-код билета для проверки на входе' });
  await expect(image).toBeVisible();
  const src = await image.getAttribute('src');
  const png = PNG.sync.read(Buffer.from(src.split(',')[1], 'base64'));
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
}

test('visitor claims a ticket once, opens its exact QR, and sees it in My tickets', async ({ page }) => {
  await page.route(`${base}/events/42`, (route) => route.fulfill({ json: eventDetails }));
  let claimed = false;
  let claims = 0;
  await page.route(`${base}/tickets/me`, (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    return route.fulfill({ json: claimed ? [ticket] : [] });
  });
  await page.route(`${base}/events/42/tickets`, (route) => {
    claims++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postData()).toBe(null);
    claimed = true;
    return route.fulfill({ status: 201, json: ticket });
  });
  await page.route(`${base}/tickets/21`, (route) => route.fulfill({ json: ticket }));
  await login(page, '/events/42');
  await page.getByRole('button', { name: 'Получить бесплатный билет' }).click();
  await expect(page).toHaveURL('/tickets/21');
  expect(await decodedQr(page)).toBe(ticket.qr_payload);
  await page.getByRole('link', { name: 'Открыть событие', exact: true }).click();
  await page.getByRole('link', { name: 'Открыть мой билет' }).click();
  await expect(page).toHaveURL('/tickets/21');
  expect(claims).toBe(1);
  await page.getByRole('navigation').getByRole('link', { name: 'Мои билеты', exact: true }).click();
  await page.getByRole('link', { name: 'Открыть билет №21' }).click();
  expect(await decodedQr(page)).toBe(ticket.qr_payload);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Войти и открыть билет' })).toHaveAttribute('href', '/login?returnTo=%2Ftickets%2F21');
});

for (const status of ['published', 'cancelled']) {
  test(`existing ticket remains openable for a sold-out ${status} event`, async ({ page }) => {
    await page.route(`${base}/events/42`, (route) => route.fulfill({ json: { ...eventDetails, status, tickets_issued: eventDetails.capacity } }));
    await page.route(`${base}/tickets/me`, (route) => route.fulfill({ json: [{ ...ticket, event: { ...ticket.event, status } }] }));
    await page.route(`${base}/tickets/21`, (route) => route.fulfill({ json: { ...ticket, event: { ...ticket.event, status } } }));
    await login(page, '/events/42');
    await page.getByRole('link', { name: 'Открыть мой билет' }).click();
    await expect(page).toHaveURL('/tickets/21');
    if (status === 'cancelled') {
      await expect(page.locator('.ticket-details').getByRole('status')).toContainText('Событие отменено');
      await expect(page.getByRole('img')).toHaveCount(0);
    } else expect(await decodedQr(page)).toBe(ticket.qr_payload);
  });
}

test('claim races show sold-out errors; an existing 200 ticket is accepted', async ({ page }) => {
  await page.route(`${base}/events/42`, (route) => route.fulfill({ json: eventDetails }));
  await page.route(`${base}/tickets/me`, (route) => route.fulfill({ json: [] }));
  let retry = false;
  await page.route(`${base}/events/42/tickets`, (route) => route.fulfill(retry ? { status: 200, json: ticket }
    : { status: 409, json: { detail: { code: 'SOLD_OUT', message: 'No tickets left' } } }));
  await page.route(`${base}/tickets/21`, (route) => route.fulfill({ json: ticket }));
  await login(page, '/events/42');
  await page.getByRole('button', { name: 'Получить бесплатный билет' }).click();
  await expect(page.getByRole('alert')).toContainText('Свободных билетов больше нет');
  retry = true;
  await page.getByRole('button', { name: 'Получить бесплатный билет' }).click();
  await expect(page).toHaveURL('/tickets/21');
});

test('foreign ticket 404 reveals no QR and an anonymous visitor sends no private request', async ({ page }) => {
  let privateRequests = 0;
  await page.route(`${base}/tickets/21`, (route) => { privateRequests++; return route.fulfill({ status: 404, json: { detail: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } } }); });
  await page.goto('/tickets/21');
  await expect(page.getByRole('link', { name: 'Войти и открыть билет' })).toBeVisible();
  expect(privateRequests).toBe(0);
  await login(page, '/tickets/21');
  await expect(page.getByRole('status')).toContainText('принадлежит другому');
  await expect(page.getByRole('img')).toHaveCount(0);
});
