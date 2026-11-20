import { test, expect } from '@playwright/test';

const base = 'http://localhost:8000';
const created = (role) => ({ id: 30, email: `${role}@example.com`, full_name: 'New Account', role, is_active: true, created_at: '2030-01-01T00:00:00Z' });

test.beforeEach(async ({ page }) => {
  await page.route((url) => url.origin === base, (route) => route.abort('failed'));
});

async function fill(page, role) {
  await page.getByLabel('Имя', { exact: true }).fill('New Account');
  await page.getByLabel('Email', { exact: true }).fill(`${role}@example.com`);
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
}

test('registration offers attendee by default and organizer, and sends only the chosen role', async ({ page }) => {
  const bodies = [];
  await page.route(`${base}/auth/register`, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: created(bodies.at(-1).role) });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/register');
  const group = page.getByRole('group', { name: 'Тип аккаунта' });
  const attendee = group.getByRole('radio', { name: 'Посетитель', exact: true });
  const organizer = group.getByRole('radio', { name: 'Организатор', exact: true });
  await expect(attendee).toBeChecked();
  await expect(organizer).not.toBeChecked();
  await expect(attendee).toHaveAccessibleDescription('Получает билеты и проходит на события.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await fill(page, 'attendee');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL('/login?returnTo=%2Fevents');
  await expect(page.getByRole('status')).toHaveText('Аккаунт создан. Войдите с вашим email и паролем.');

  await page.goto('/register');
  // The choice works from the keyboard: arrows move between the two radios.
  await page.getByRole('radio', { name: 'Посетитель', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'Организатор', exact: true })).toBeChecked();
  await fill(page, 'organizer');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL('/login?returnTo=%2Forganizer');
  await expect(page.getByRole('status')).toHaveText('Аккаунт организатора создан. Войдите, чтобы открыть кабинет организатора.');
  expect(bodies.map((body) => body.role)).toEqual(['attendee', 'organizer']);
  expect(Object.keys(bodies[1]).sort()).toEqual(['email', 'full_name', 'password', 'role']);
});

test('a tampered role value is never sent: anything but organizer registers an attendee', async ({ page }) => {
  const roles = [];
  await page.route(`${base}/auth/register`, (route) => {
    roles.push(route.request().postDataJSON().role);
    return route.fulfill({ status: 201, json: created('attendee') });
  });
  await page.goto('/register');
  await page.getByRole('radio', { name: 'Организатор', exact: true }).evaluate((input) => { input.value = 'admin'; input.checked = true; });
  await fill(page, 'attendee');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(roles).toEqual(['attendee']);
});

test('after a new organizer signs in, the menu shows the organizer cabinet and opens it', async ({ page }) => {
  await page.route(`${base}/auth/register`, (route) => route.fulfill({ status: 201, json: created('organizer') }));
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: created('organizer') }));
  await page.route(`${base}/events/mine`, (route) => route.fulfill({ json: [] }));
  await page.goto('/register');
  await page.getByRole('radio', { name: 'Организатор', exact: true }).check();
  await fill(page, 'organizer');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('status')).toHaveText('Аккаунт организатора создан. Войдите, чтобы открыть кабинет организатора.');
  const nav = page.getByRole('navigation', { name: 'Основная навигация' });
  await expect(nav.getByRole('link', { name: 'Мои события' })).toHaveCount(0);
  await page.getByLabel('Email', { exact: true }).fill('organizer@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL('/organizer');
  await expect(nav.getByRole('link', { name: 'Мои события' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Кабинет организатора');
});

test('an organizer who registered from an event page goes back to that event', async ({ page }) => {
  await page.route(`${base}/auth/register`, (route) => route.fulfill({ status: 201, json: created('organizer') }));
  await page.goto('/register?returnTo=%2Fevents%2F42');
  await page.getByRole('radio', { name: 'Организатор', exact: true }).check();
  await fill(page, 'organizer');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL('/login?returnTo=%2Fevents%2F42');
});

test('the role choice is translated', async ({ page }) => {
  await page.goto('/register');
  await page.getByRole('button', { name: 'Қазақша', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Аккаунт түрі' })).toContainText('Ұйымдастырушы');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  const group = page.getByRole('group', { name: 'Account type' });
  await expect(group.getByRole('radio', { name: 'Attendee', exact: true })).toBeChecked();
  await expect(group.getByRole('radio', { name: 'Organizer', exact: true })).toBeVisible();
});
