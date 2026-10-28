import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function loginForm(page, email, password) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

async function registrationForm(page, email, password, name = 'FE01 Browser Visitor') {
  await page.getByLabel('Имя', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
}

test('public event routes and login/register links preserve the selected event', async ({ page }) => {
  await page.goto('/events/42');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Подробнее о событии');
  await page.getByRole('link', { name: 'Войти и вернуться к этому событию' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fevents%2F42$/);
  await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click();
  await expect(page).toHaveURL(/\/register\?returnTo=%2Fevents%2F42$/);
  await page.getByRole('link', { name: 'Перейти ко входу' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fevents%2F42$/);
  await page.getByRole('navigation').getByRole('link', { name: 'События', exact: true }).click();
  await expect(page).toHaveURL('/events');
});

test('network errors and FastAPI 422 are readable in the actual forms (mocked HTTP)', async ({ page }) => {
  await page.route('http://localhost:8000/auth/login', (route) => route.abort('failed'));
  await page.goto('/login');
  await loginForm(page, 'fixture@example.com', 'test-only-password');
  await expect(page.getByRole('alert')).toContainText('Не удалось связаться с сервером');
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeEnabled();
  await page.route('http://localhost:8000/auth/register', (route) => route.fulfill({
    status: 422,
    json: { detail: [{ loc: ['body', 'email'], msg: 'value is not a valid email address', type: 'value_error' }] },
  }));
  await page.goto('/register');
  await registrationForm(page, 'fixture@example.com', 'test-only-password');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('alert')).toContainText('Email: value is not a valid email address');
  await expect(page.getByRole('alert')).not.toContainText('[object Object]');
});

test('unsafe return URL falls back to events and session does not survive reload (mocked HTTP)', async ({ page }) => {
  await page.route('http://localhost:8000/auth/login', (route) => route.fulfill({
    json: { access_token: 'test-only-token', refresh_token: 'test-unused-refresh', token_type: 'bearer' },
  }));
  await page.route('http://localhost:8000/auth/me', (route) => route.fulfill({
    json: { id: 1, email: 'fixture@example.com', full_name: 'Browser Fixture', role: 'attendee', is_active: true, created_at: '2026-10-28T00:00:00Z' },
  }));
  await page.goto('/login?returnTo=https%3A%2F%2Fevil.example');
  await loginForm(page, 'fixture@example.com', 'test-only-password');
  await expect(page).toHaveURL('/events');
  await expect(page.getByRole('navigation')).toContainText('Browser Fixture');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.reload();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Войти', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation')).not.toContainText('Browser Fixture');
});

test('registration validates UTF-8 password limit locally and fits a mobile viewport', async ({ page }) => {
  let requests = 0;
  await page.route('http://localhost:8000/**', (route) => { requests += 1; return route.abort(); });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/register');
  await registrationForm(page, 'fixture@example.com', 'я'.repeat(37));
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('alert')).toContainText('Пароль слишком длинный');
  expect(requests).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('live local API: register, duplicate guard, wrong password, login/me, logout, reload and duplicate email', async ({ page }) => {
  test.skip(process.env.RUN_LIVE_AUTH !== '1', 'Opt in only after verifying the local Compose database.');
  const email = `fe01-browser-${randomUUID()}@example.com`;
  const password = randomUUID();
  const responses = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === 'http://localhost:8000') responses.push({ path: url.pathname, status: response.status() });
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let registerRequests = 0;
  await page.route('http://localhost:8000/auth/register', async (route) => {
    registerRequests += 1;
    expect(route.request().postDataJSON().role).toBe('attendee');
    await gate;
    await route.continue();
  });
  await page.goto('/events/42');
  await page.getByRole('link', { name: 'Войти и вернуться к этому событию' }).click();
  await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click();
  await registrationForm(page, email, password);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('button', { name: 'Создаём аккаунт…' })).toBeDisabled();
  await page.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => registerRequests).toBe(1);
  release();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fevents%2F42$/);
  await expect(page.getByRole('status')).toContainText('Аккаунт создан');
  await expect(page.getByRole('button', { name: 'Выйти' })).toHaveCount(0);
  await loginForm(page, email, 'wrong-password');
  await expect(page.getByRole('alert')).toContainText('Неверный email или пароль');
  await loginForm(page, email, password);
  await expect(page).toHaveURL('/events/42');
  await expect(page.getByRole('navigation')).toContainText('FE01 Browser Visitor');
  expect(responses.some((r) => r.path === '/auth/me' && r.status === 200)).toBe(true);
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL('/events/42');
  await expect(page.getByRole('navigation')).not.toContainText('FE01 Browser Visitor');
  expect(responses.some((r) => r.path === '/auth/logout' || r.path === '/auth/refresh')).toBe(false);
  await page.getByRole('navigation').getByRole('link', { name: 'Войти', exact: true }).click();
  await loginForm(page, email, password);
  await expect(page).toHaveURL('/events/42');
  await page.reload();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Войти', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Регистрация' }).click();
  await registrationForm(page, email, password);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('alert')).toContainText('email уже зарегистрирован');
});
