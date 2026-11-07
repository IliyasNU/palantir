import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

test('real visitor claims, reopens and presents the exact backend ticket QR', async ({ page, request }) => {
  test.skip(process.env.RUN_LIVE_TICKETS !== '1', 'Only after verifying the isolated test database. Creates test users and one event.');
  test.setTimeout(90000);
  const database = new URL(process.env.DATABASE_URL ?? '');
  expect(process.env.ENVIRONMENT).toBe('test');
  expect(['127.0.0.1', 'localhost']).toContain(database.hostname);
  expect(database.pathname).toBe('/biletflow_test');
  const base = 'http://localhost:8000';
  const password = randomUUID();
  const organizerEmail = `ticket-owner-${randomUUID()}@example.com`;
  const visitorEmail = `ticket-visitor-${randomUUID()}@example.com`;
  const post = async (path, data, headers = {}) => {
    const response = await request.post(base + path, { data, headers });
    expect(response.ok(), `${path} must succeed`).toBe(true);
    return response.json();
  };
  // Setup is real HTTP, limited to the guarded disposable database.
  await post('/auth/register', { email: organizerEmail, password, full_name: 'Ticket Test Organizer', role: 'organizer' });
  const owner = await post('/auth/login', { email: organizerEmail, password });
  const ownerHeaders = { Authorization: `Bearer ${owner.access_token}` };
  const event = await post('/events', { title: `Ticket browser test ${randomUUID()}`, date: '2030-07-15T12:00:00Z', location: 'Test Hall', capacity: 1 }, ownerHeaders);
  await post(`/events/${event.id}/publish`, undefined, ownerHeaders);

  await page.goto(`/register?returnTo=${encodeURIComponent(`/events/${event.id}`)}`);
  await page.getByLabel('Имя', { exact: true }).fill('Real Ticket Visitor');
  await page.getByLabel('Email', { exact: true }).fill(visitorEmail);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/login');
  await page.getByLabel('Email', { exact: true }).fill(visitorEmail);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(event.title);
  const claimed = page.waitForResponse(response => response.url() === `${base}/events/${event.id}/tickets` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Получить бесплатный билет' }).click();
  const response = await claimed;
  expect(response.status()).toBe(201);
  const ticket = await response.json();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/tickets/${ticket.id}`);
  const qr = page.getByRole('img', { name: 'QR-код билета для проверки на входе' });
  await expect(qr).toBeVisible();
  const png = PNG.sync.read(Buffer.from((await qr.getAttribute('src')).split(',')[1], 'base64'));
  expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(ticket.qr_payload);

  // Same-session page navigation, never a page.goto/reload that would intentionally log out.
  await page.getByRole('link', { name: 'Открыть событие', exact: true }).click();
  await expect(page.getByRole('article')).toContainText('Осталось мест: 0');
  await page.getByRole('link', { name: 'Открыть мой билет' }).click();
  await expect(qr).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Мои билеты', exact: true }).click();
  await page.getByRole('link', { name: `Открыть билет №${ticket.id}`, exact: true }).click();
  await expect(qr).toBeVisible();

  const visitor = await post('/auth/login', { email: visitorEmail, password });
  const repeated = await request.post(`${base}/events/${event.id}/tickets`, { headers: { Authorization: `Bearer ${visitor.access_token}` } });
  expect(repeated.status()).toBe(200);
  expect((await repeated.json()).id).toBe(ticket.id);
  const foreign = await request.get(`${base}/tickets/${ticket.id}`, { headers: ownerHeaders });
  expect(foreign.status()).toBe(404);
  await post(`/events/${event.id}/cancel`, undefined, ownerHeaders);
  await page.getByRole('link', { name: 'Открыть событие', exact: true }).click();
  await page.getByRole('link', { name: 'Открыть мой билет' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/tickets/${ticket.id}`);
  const status = page.getByRole('status');
  await expect(status).toHaveCount(1);
  await expect(status).toContainText('Событие отменено');
  await expect(qr).toHaveCount(0);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Войти и открыть билет' })).toBeVisible();
  console.log('Real ticket flow: registration, login/me, claim 201, repeat 200, foreign 404, exact PNG QR decode, sold-out reopening, cancellation, logout.');
});
