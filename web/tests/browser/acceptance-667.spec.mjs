import { test, expect } from '@playwright/test';
import { eventDetails } from './event-fixture.mjs';

const base = 'http://localhost:8000';
const visitor = { id: 1, email: 'acceptance@example.com', full_name: 'Acceptance Visitor', role: 'attendee', is_active: true, created_at: '2030-01-01T00:00:00Z' };
const ticket = { id: 21, event_id: 42, attendee_id: 1, qr_payload: 'test-only-existing-ticket', created_at: visitor.created_at, checked_in_at: null,
  event: { id: 42, title: eventDetails.title, date: eventDetails.date, location: eventDetails.location, status: 'published' } };

test.use({ viewport: { width: 375, height: 812 } });

async function authRoutes(page) {
  await page.route(base + '/auth/register', (route) => {
    expect(route.request().postDataJSON().role).toBe('attendee');
    return route.fulfill({ status: 201, json: visitor });
  });
  await page.route(base + '/auth/login', (route) => route.fulfill({ json: { access_token: 'test-only-token', token_type: 'bearer' } }));
  await page.route(base + '/auth/me', (route) => route.fulfill({ json: visitor }));
}

async function signIn(page) {
  await page.getByLabel('Email', { exact: true }).fill(visitor.email);
  await page.getByLabel('Пароль', { exact: true }).fill('test-only-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

async function fits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const scenario of ['available', 'sold-out', 'cancelled']) {
  test(`guest register/login reaches the ${scenario} event action and ticket at 375px`, async ({ page }) => {
    const existing = scenario !== 'available';
    const status = scenario === 'cancelled' ? 'cancelled' : 'published';
    const currentTicket = { ...ticket, event: { ...ticket.event, status } };
    await authRoutes(page);
    await page.route(base + '/events/42', (route) => route.fulfill({ json: {
      ...eventDetails, status, tickets_issued: existing ? eventDetails.capacity : 0,
    } }));
    await page.route(base + '/tickets/me', (route) => route.fulfill({ json: existing ? [currentTicket] : [] }));
    await page.route(base + '/tickets/21', (route) => route.fulfill({ json: currentTicket }));
    let claims = 0;
    await page.route(base + '/events/42/tickets', (route) => {
      claims++;
      return route.fulfill({ status: 201, json: currentTicket });
    });

    await page.goto('/events/42');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(eventDetails.title);
    await fits(page);
    await page.getByRole('link', { name: existing ? 'Войти и проверить мои билеты' : 'Войти, чтобы получить билет', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fevents%2F42$/);
    await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click();
    await page.getByLabel('Имя', { exact: true }).fill(visitor.full_name);
    await page.getByLabel('Email', { exact: true }).fill(visitor.email);
    await page.getByLabel('Пароль', { exact: true }).fill('test-only-password');
    await fits(page);
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fevents%2F42$/);
    await expect(page.getByRole('status')).toContainText('Аккаунт создан');
    await signIn(page);
    await expect(page).toHaveURL('/events/42');

    if (existing) {
      await expect(page.getByRole('button', { name: 'Получить бесплатный билет' })).toHaveCount(0);
      await page.getByRole('link', { name: 'Открыть мой билет', exact: true }).click();
    } else await page.getByRole('button', { name: 'Получить бесплатный билет', exact: true }).click();
    await expect(page).toHaveURL('/tickets/21');
    await expect(page.getByRole('article')).toContainText(eventDetails.title);
    if (status === 'cancelled') {
      await expect(page.getByRole('status')).toContainText('Событие отменено');
      await expect(page.getByRole('img')).toHaveCount(0);
    } else await expect(page.getByRole('img', { name: 'QR-код билета для проверки на входе' })).toBeVisible();
    await fits(page);
    expect(claims).toBe(existing ? 0 : 1);
  });
}

for (const phase of ['lookup', 'claim']) {
  for (const status of [401, 403]) {
    test(`ticket ${phase} HTTP ${status} uses the shared session policy`, async ({ page }) => {
      await authRoutes(page);
      await page.route(base + '/events/42', (route) => route.fulfill({ json: eventDetails }));
      let denied = true;
      const rejection = { status, json: { detail: { code: status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED', message: 'Access denied' } } };
      await page.route(base + '/tickets/me', (route) => route.fulfill(denied && phase === 'lookup' ? rejection : { json: [] }));
      await page.route(base + '/events/42/tickets', (route) => route.fulfill(rejection));
      await page.goto('/login?returnTo=%2Fevents%2F42');
      await signIn(page);
      await expect(page).toHaveURL('/events/42');
      if (phase === 'claim') await page.getByRole('button', { name: 'Получить бесплатный билет' }).click();

      if (status === 401) {
        const again = page.getByRole('link', { name: 'Войти снова', exact: true });
        await expect(again).toHaveAttribute('href', '/login?returnTo=%2Fevents%2F42');
        await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toHaveCount(0);
        denied = false;
        await again.click();
        await signIn(page);
        await expect(page).toHaveURL('/events/42');
        await expect(page.getByRole('button', { name: 'Получить бесплатный билет' })).toBeVisible();
      } else {
        await expect(page.getByRole('navigation')).toContainText(visitor.full_name);
        await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
        await expect(page.locator('.ticket-actions [role="alert"]')).toHaveText('У вас нет прав для этого действия с билетом.');
        await expect(page.getByRole('link', { name: 'Войти снова', exact: true })).toHaveCount(0);
      }
      await fits(page);
    });
  }
}

test('direct event and ticket links survive reload with an explicit login return', async ({ page }) => {
  await authRoutes(page);
  await page.route(base + '/events/42', (route) => route.fulfill({ json: eventDetails }));
  await page.route(base + '/tickets/me', (route) => route.fulfill({ json: [ticket] }));
  await page.route(base + '/tickets/21', (route) => route.fulfill({ json: ticket }));
  await page.goto('/events/42');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(eventDetails.title);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(eventDetails.title);
  await page.goto('/tickets/21');
  await page.getByRole('link', { name: 'Войти и открыть билет' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Ftickets%2F21$/);
  await signIn(page);
  await expect(page).toHaveURL('/tickets/21');
  await expect(page.getByRole('article')).toContainText('Билет №21');
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('link', { name: 'Войти и открыть билет' }).click();
  await signIn(page);
  await expect(page).toHaveURL('/tickets/21');
  await expect(page.getByRole('article')).toContainText('Билет №21');
  await fits(page);
});
