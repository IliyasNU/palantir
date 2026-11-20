import { test, expect } from '@playwright/test';
import { eventDetails } from './event-fixture.mjs';

const base = 'http://localhost:8000';
const metrics = {
  sold: 4, checked_in: 3, gross_before_discount_tiyn: 20100, discounts_tiyn: 5000,
  gross_sales_tiyn: 15100, refunds_tiyn: 5000, net_sales_tiyn: 10100,
  processing_fees_tiyn: 303, estimated_payout_tiyn: 9797,
};
const type = { ...metrics, id: 1, name: 'VIP' };
const data = {
  ...metrics, event_id: 42, event_title: eventDetails.title, capacity: 10, remaining: 5,
  percent_sold: 40, absent: 1, percent_checked_in: 75,
  daily: [{ ...metrics, date: '2026-11-19' }], ticket_types: [type],
  campaigns: [{ ...metrics, id: 3, name: 'Opening', redemptions: 2 }],
};

async function signIn(page, path, role) {
  await page.route(base + '/auth/login', r => r.fulfill({ json: { access_token: 'fixture', token_type: 'bearer' } }));
  await page.route(base + '/auth/me', r => r.fulfill({ json: {
    id: 7, email: 'owner@example.com', full_name: 'Analytics Owner', role,
    is_active: true, created_at: '2026-01-01T00:00:00Z',
  } }));
  await page.goto('/login?returnTo=' + encodeURIComponent(path));
  await page.getByLabel('Email', { exact: true }).fill('owner@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(path);
}

test('organizer analytics links, filters and accessible charts fit at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const queries = [];
  await page.route(base + '/events/mine', r => r.fulfill({ json: [eventDetails] }));
  await page.route(base + '/events/42', r => r.fulfill({ json: eventDetails }));
  await page.route(base + '/tickets/me', r => r.fulfill({ json: [] }));
  await page.route(base + '/events/42/analytics*', r => {
    const params = Object.fromEntries(new URL(r.request().url()).searchParams);
    queries.push(params);
    return r.fulfill({ json: params.ticket_type_id ? { ...data, capacity: 4, remaining: 0, percent_sold: 100 } : data });
  });
  await signIn(page, '/organizer', 'organizer');
  await expect(page.getByRole('link', { name: /^Аналитика:/ })).toHaveAttribute('href', '/organizer/events/42/analytics');
  await page.getByRole('link', { name: /^Страница события:/ }).click();
  await expect(page).toHaveURL('/events/42');
  await page.getByRole('link', { name: 'Аналитика', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Аналитика', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Продажи по дням · Действующие билеты' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Продажи по дням' })).toContainText('2026-11-19');
  await expect(page.getByRole('img', { name: 'По типам билетов · Действующие билеты' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'По типам билетов' })).toContainText('VIP');
  await expect(page.getByRole('table', { name: 'По кампаниям' })).toContainText('Opening');
  await expect(page.getByText('101 ₸', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('С даты').fill('2026-11-20');
  await page.getByLabel('По дату').fill('2026-11-19');
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.getByRole('alert')).toContainText('Дата начала должна быть не позже');
  expect(queries.every(query => Object.keys(query).length === 0)).toBe(true);
  await page.getByLabel('С даты').fill('2026-11-19');
  await page.getByLabel('Тип билета', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect.poll(() => queries.at(-1)).toEqual({
    date_from: '2026-11-19', date_to: '2026-11-19', ticket_type_id: '1',
  });
  await expect(page.getByText(/100\s?%/)).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'By campaign' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('attendees see no analytics link or report and a refused organizer sees no data', async ({ page }) => {
  let requests = 0;
  await page.route(base + '/events/42', r => r.fulfill({ json: { ...eventDetails, organizer_id: 8 } }));
  await page.route(base + '/tickets/me', r => r.fulfill({ json: [] }));
  await page.route(base + '/events/42/analytics', r => {
    requests++;
    return r.fulfill({ status: 404, json: { detail: { code: 'EVENT_NOT_FOUND' } } });
  });
  await signIn(page, '/events/42', 'attendee');
  await expect(page.getByRole('heading', { name: eventDetails.title })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Аналитика', exact: true })).toHaveCount(0);
  await signIn(page, '/organizer/events/42/analytics', 'attendee');
  await expect(page.getByRole('status')).toHaveText('Событие или тип билета не найден.');
  expect(requests).toBe(0);
  await signIn(page, '/organizer/events/42/analytics', 'organizer');
  await expect(page.getByRole('alert')).toContainText('Событие или тип билета не найден.');
  expect(requests).toBeGreaterThan(0);
  await expect(page.getByRole('table')).toHaveCount(0);
});
