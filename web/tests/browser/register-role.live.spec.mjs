import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { liveApiUrl, verifyLiveSession } from './live-api.mjs';

async function register(page, role, email, password) {
  await page.goto('/register');
  await page.getByLabel('Имя', { exact: true }).fill(`Live ${role}`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  if (role === 'organizer') await page.getByRole('radio', { name: 'Организатор', exact: true }).check();
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
}

async function signIn(page, email, password) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

test('live local API: the role chosen on the form is stored, and only an organizer gets the cabinet in the menu', async ({ page, request }, testInfo) => {
  test.skip(process.env.RUN_LIVE_AUTH !== '1', 'Opt in only after verifying the local database.');
  test.setTimeout(90000);
  await verifyLiveSession(page, request, testInfo);
  const base = liveApiUrl();
  const nav = page.getByRole('navigation', { name: 'Основная навигация' });
  const registered = [];
  page.on('response', async (response) => {
    if (response.url() === base + '/auth/register' && response.status() === 201) registered.push((await response.json()).role);
  });

  const organizer = { email: `web-organizer-${randomUUID()}@example.com`, password: randomUUID() };
  await register(page, 'organizer', organizer.email, organizer.password);
  await expect(page).toHaveURL('/login?returnTo=%2Forganizer');
  await signIn(page, organizer.email, organizer.password);
  await expect(page).toHaveURL('/organizer');
  await expect(nav.getByRole('link', { name: 'Мои события' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('У вас пока нет созданных событий');
  await nav.getByRole('button', { name: 'Выйти' }).click();

  const attendee = { email: `web-attendee-${randomUUID()}@example.com`, password: randomUUID() };
  await register(page, 'attendee', attendee.email, attendee.password);
  await expect(page).toHaveURL('/login?returnTo=%2Fevents');
  await signIn(page, attendee.email, attendee.password);
  await expect(page).toHaveURL('/events');
  await expect(nav).toContainText('Live attendee');
  await expect(nav.getByRole('link', { name: 'Мои события' })).toHaveCount(0);
  expect(registered).toEqual(['organizer', 'attendee']);
});
