import { test, expect } from '@playwright/test';

const base = 'http://localhost:8000';
const events = [
  { id: 7, organizer_id: 3, title: 'Хакатон NU', description: null, date: '2030-03-01T10:00:00Z',
    location: 'Астана', capacity: 50, tickets_issued: 12, status: 'published', created_at: '2030-01-01T00:00:00Z' },
  { id: 8, organizer_id: 3, title: 'Лекция по ИИ', description: null, date: '2030-04-01T10:00:00Z',
    location: 'Алматы', capacity: 30, tickets_issued: 0, status: 'draft', created_at: '2030-01-01T00:00:00Z' },
];

async function login(page, role) {
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: {
    id: 3, email: 'org@example.com', full_name: 'Test Organizer', role, is_active: true, created_at: '2030-01-01T00:00:00Z' } }));
  await page.goto(`/login?returnTo=${encodeURIComponent('/organizer')}`);
  await page.getByLabel('Email', { exact: true }).fill('org@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL('/organizer');
}

test('organizer sees own events with status and issued tickets, using the session token', async ({ page }) => {
  await page.route(`${base}/events/mine`, (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    return route.fulfill({ json: events });
  });
  await login(page, 'organizer');
  const list = page.getByRole('list', { name: 'Мои события' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list).toContainText('Хакатон NU');
  await expect(list).toContainText('Опубликовано · выдано 12 из 50');
  await expect(list).toContainText('Черновик · выдано 0 из 30');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Кабинет' })).toBeVisible();
});

test('attendee gets a clear refusal and no private request is sent', async ({ page }) => {
  let requested = false;
  await page.route(`${base}/events/mine`, (route) => { requested = true; return route.fulfill({ status: 403, json: {} }); });
  await login(page, 'attendee');
  await expect(page.getByRole('alert')).toContainText('Кабинет доступен только организаторам');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Кабинет' })).toHaveCount(0);
  expect(requested).toBe(false);
});

test('guest is offered a login that returns to the dashboard', async ({ page }) => {
  await page.goto('/organizer');
  await expect(page.getByRole('link', { name: 'Войти как организатор' })).toHaveAttribute('href', '/login?returnTo=%2Forganizer');
});