import { test, expect } from '@playwright/test';
import { eventDetails } from './event-fixture.mjs';

const base = 'http://localhost:8000';
const free = { id: 1, event_id: 42, name: 'Партер', description: null, quantity: 2,
  tickets_issued: 0, remaining: 2, price_tiyn: 0, sales_start: null, sales_end: null,
  order_limit: 1, hidden: false };
const paid = { ...free, id: 2, name: 'VIP', price_tiyn: 150050, quantity: 1, remaining: 1 };
const secondFree = { ...free, id: 3, name: 'Балкон' };

async function login(page, destination, role = 'attendee') {
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: {
    id: 1, email: 'fixture@example.com', full_name: 'P1 Test', role,
    is_active: true, created_at: '2030-01-01T00:00:00Z',
  } }));
  await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
  await page.getByLabel('Email', { exact: true }).fill('fixture@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(destination);
}

test('visitor selects a free type and sees it on the issued ticket', async ({ page }) => {
  const ticket = { id: 21, event_id: 42, attendee_id: 1, qr_payload: 'fixture opaque QR',
    created_at: '2030-01-01T00:00:00Z', checked_in_at: null, status: 'active',
    ticket_type_id: 3, ticket_type: { id: 3, name: 'Балкон', price_tiyn: 0 },
    event: { id: 42, title: eventDetails.title, date: eventDetails.date, location: eventDetails.location, status: 'published' } };
  await page.route(`${base}/events/42`, (route) => route.fulfill({ json: {
    ...eventDetails, ticket_types: [free, paid, secondFree],
  } }));
  await page.route(`${base}/tickets/me`, (route) => route.fulfill({ json: [] }));
  await page.route(`${base}/tickets/21`, (route) => route.fulfill({ json: ticket }));
  await page.route(`${base}/events/42/tickets`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ ticket_type_id: 3 });
    return route.fulfill({ status: 201, json: ticket });
  });
  await login(page, '/events/42');
  await expect(page.getByRole('radio', { name: /VIP/ })).toBeDisabled();
  const claim = page.getByRole('button', { name: 'Получить бесплатный билет' });
  await expect(claim).toBeDisabled();
  await page.getByRole('radio', { name: /Балкон/ }).check();
  await claim.click();
  await expect(page).toHaveURL('/tickets/21');
  await expect(page.locator('.ticket-details')).toContainText('Балкон');
});

test('organizer creates a paid type, edits its price and hides it', async ({ page }) => {
  const path = '/organizer/events/42/ticket-types';
  let rows = [free];
  let audit = [];
  await page.route(`${base}/events/42`, (route) => route.fulfill({ json: { ...eventDetails, organizer_id: 1 } }));
  await page.route(`${base}/events/42/ticket-types/manage`, (route) => route.fulfill({ json: rows }));
  await page.route(`${base}/events/42/action-log`, (route) => route.fulfill({ json: audit }));
  await page.route(`${base}/events/42/ticket-types`, (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toMatchObject({ name: 'VIP', price_tiyn: 150050, quantity: 1 });
    rows = [...rows, paid];
    return route.fulfill({ status: 201, json: paid });
  });
  await page.route(`${base}/events/42/ticket-types/2`, (route) => {
    expect(route.request().method()).toBe('PATCH');
    expect(route.request().postDataJSON()).toMatchObject({ price_tiyn: 200000, hidden: true });
    const updated = { ...paid, price_tiyn: 200000, hidden: true };
    rows = [free, updated];
    audit = [{ id: 1, event_id: 42, actor_id: 1, occurred_at: '2030-01-01T00:00:00Z',
      action: 'ticket_type.updated', description: 'hidden: false → true' }];
    return route.fulfill({ json: updated });
  });
  await login(page, path, 'organizer');
  await page.getByLabel('Название типа').fill('VIP');
  await page.getByLabel('Цена в тиынах').fill('150050');
  await page.getByLabel('Количество билетов типа').fill('1');
  await page.getByRole('button', { name: 'Создать тип' }).click();
  await page.getByRole('button', { name: 'Редактировать VIP' }).click();
  await page.getByLabel('Цена в тиынах').fill('200000');
  await page.getByLabel('Скрыть тип от посетителей').check();
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'VIP' })).toContainText('Скрыт');
  await expect(page.getByRole('region', { name: 'Журнал изменений типов' })).toContainText('ticket_type.updated');
});
