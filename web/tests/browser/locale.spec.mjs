import { test, expect } from '@playwright/test';

const base = 'http://localhost:8000';
const account = (role) => ({ id: 3, email: `${role}@example.com`, full_name: `Fixture ${role}`, role, is_active: true, created_at: '2030-01-01T00:00:00Z' });
const event = { id: 42, organizer_id: 3, title: 'Jazz Night', description: null, date: '2030-07-15T12:00:00Z', location: 'Orange Hall',
  status: 'published', capacity: 50, tickets_issued: 0, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z' };
const language = (page, name) => page.getByRole('group').getByRole('button', { name, exact: true });

test('the interface starts in Russian and switches to Kazakh and English, keeping the choice after a reload', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.route(`${base}/events`, (route) => route.fulfill({ json: [event] }));
  await page.goto('/events');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Найдите повод быть вместе.');
  await expect(language(page, 'Русский')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status')).toHaveText('Найдено событий: 1');

  await language(page, 'Қазақша').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Бірге болуға себеп табыңыз.');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Іс-шаралар', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Табылған іс-шаралар: 1');
  await expect(language(page, 'Қазақша')).toHaveAttribute('aria-pressed', 'true');
  await expect(language(page, 'Русский')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Бірге болуға себеп табыңыз.');
  expect(await page.evaluate(() => localStorage.getItem('biletflow.locale'))).toBe('kk');

  await language(page, 'English').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Find a reason to be together.');
  await expect(page.getByRole('status')).toHaveText('Events found: 1');
  await expect(page.getByText('15 July 2030')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to BiletFlow');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Sign in to BiletFlow — BiletFlow');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('errors and the account, organizer and admin screens follow the chosen language', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('biletflow.locale', 'en'); });
  await page.route(`${base}/events`, (route) => route.fulfill({ status: 500, body: 'error' }));
  await page.goto('/events');
  await expect(page.getByRole('alert')).toContainText('Could not load the events');
  await expect(page.getByRole('alert')).toContainText('The server is temporarily unavailable. Try again later.');

  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Password reset');
  await page.goto('/reset-password');
  await expect(page.getByRole('alert')).toContainText('The link is invalid or has expired.');

  await page.route(`${base}/auth/login`, (route) => route.fulfill({ status: 401, json: { detail: 'Incorrect email or password' } }));
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('organizer@example.com');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password. Check them and try again.');

  await page.unroute(`${base}/auth/login`);
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', refresh_token: 'unused', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: account('organizer') }));
  await page.route(`${base}/events/mine`, (route) => route.fulfill({ json: [{ ...event, status: 'draft' }] }));
  await page.goto('/login?returnTo=%2Forganizer');
  await page.getByLabel('Email', { exact: true }).fill('organizer@example.com');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Organizer cabinet');
  await expect(page.getByRole('listitem')).toContainText('Draft');
  await expect(page.getByRole('link', { name: 'Edit: Jazz Night' })).toBeVisible();
  await page.getByRole('link', { name: 'Create an event' }).click();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('alert')).toContainText('Title: from 3 to 200 characters.');

  // Switching while signed in keeps the session and re-renders the open screen.
  await page.getByRole('group', { name: 'Interface language' }).getByRole('button', { name: 'Қазақша' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Жаңа іс-шара');
  await expect(page.getByRole('navigation')).toContainText('Fixture organizer');
  await page.evaluate(() => { history.pushState(null, '', '/admin'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('heading', { name: '403 — кіруге тыйым салынған' })).toBeVisible();
});

test('an unknown stored language falls back to Russian', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('biletflow.locale', 'klingon'); });
  await page.route(`${base}/events`, (route) => route.fulfill({ json: [] }));
  await page.goto('/events');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Найдите повод быть вместе.');
});
