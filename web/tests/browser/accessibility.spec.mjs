// Automated accessibility checks (axe-core, WCAG 2.1/2.2 A and AA rules) on the main pages, plus the
// keyboard paths that axe cannot see. Mocked HTTP only; any unmocked call to the API fails here.
import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { eventDetails } from './event-fixture.mjs';

const base = 'http://localhost:8000';
const created = '2030-01-01T00:00:00Z';
const person = (role, id = 1) => ({ id, email: `${role}@example.com`, full_name: `Fixture ${role}`, role, is_active: true, created_at: created });
const types = [
  { id: 1, event_id: 42, name: 'Стандарт', description: 'Вход в зал', quantity: 50, tickets_issued: 3, remaining: 47, price_tiyn: 0,
    sales_start: null, sales_end: null, order_limit: 1, hidden: false },
  { id: 2, event_id: 42, name: 'VIP', description: null, quantity: 10, tickets_issued: 0, remaining: 10, price_tiyn: 500000,
    sales_start: null, sales_end: null, order_limit: 1, hidden: false },
];
const event = { ...eventDetails, ticket_types: types, paid_sales_available: false };
const ticket = { id: 21, event_id: 42, attendee_id: 1, qr_payload: 'exact server opaque ticket value', created_at: created, checked_in_at: null,
  status: 'active',
  event: { id: 42, title: eventDetails.title, date: eventDetails.date, location: eventDetails.location, status: 'published' } };

async function mockApi(page, role = 'attendee') {
  await page.route((url) => url.origin === base, (route) => route.abort('failed'));
  const json = (path, body) => page.route(`${base}${path}`, (route) => route.fulfill({ json: body }));
  await json('/events', [event, { ...event, id: 43, title: 'Вечер джаза', location: 'Hall' }]);
  await json('/events/42', event);
  await json('/events/mine', [{ ...event, suspended: false }]);
  await json('/tickets/me', [ticket]);
  await json('/tickets/21', ticket);
  await json('/auth/login', { access_token: 'test-token', token_type: 'bearer' });
  await json('/auth/me', person(role));
  await page.route(`${base}/admin/users?*`, (route) => route.fulfill({ json: [person('admin'),
    { ...person('organizer', 5), full_name: 'Алия Организатор' }, { ...person('attendee', 6), is_active: false }] }));
  await page.route(`${base}/admin/events?*`, (route) => route.fulfill({ json: [{ ...event, suspended_at: null }] }));
  await page.route(`${base}/admin/action-log?*`, (route) => route.fulfill({ json: [{ id: 1, event_id: 42, occurred_at: created, actor_id: 1,
    actor_name: 'Fixture admin', action: 'event.suspended', entity_type: 'event', entity_id: 42, description: 'Suspended: spam' }] }));
}

async function signIn(page, role, path) {
  await page.goto(`/login?returnTo=${encodeURIComponent(path)}`);
  await page.getByLabel('Email', { exact: true }).fill(`${role}@example.com`);
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toContainText(`Fixture ${role}`);
}
// Client-side navigation keeps the memory-only session.
const go = (page, path) => page.evaluate((target) => {
  history.pushState(null, '', target);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);

async function expectNoViolations(page, label) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = violations.map(({ id, impact, nodes }) => `${id} (${impact}): ${nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

const publicPages = [
  ['catalogue', '/events', 'Найдите повод быть вместе.'],
  ['event details', '/events/42', eventDetails.title],
  ['sign-in', '/login', 'Вход в BiletFlow'],
  ['registration', '/register', 'Регистрация в BiletFlow'],
  ['password reset request', '/forgot-password', 'Сброс пароля'],
  ['new password', '/reset-password?token=fixture', 'Смена пароля'],
  ['not found', '/no-such-page', 'Кажется, вы свернули не туда.'],
];

for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
  test.describe(`at ${viewport.width} px`, () => {
    test.use({ viewport });

    test('public pages have no axe violations in Russian, Kazakh and English', async ({ page }) => {
      await mockApi(page);
      for (const [label, path, heading] of publicPages) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
        await expect(page.getByRole('status').filter({ hasText: /Загружаем/ })).toHaveCount(0);
        await expectNoViolations(page, `${label} (ru)`);
      }
      for (const [language, lang] of [['Қазақша', 'kk'], ['English', 'en']]) {
        await page.goto('/events');
        await page.getByRole('button', { name: language, exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        await expectNoViolations(page, `catalogue (${lang})`);
        await page.goto('/register');
        await expectNoViolations(page, `registration (${lang})`);
        await page.getByRole('button', { name: 'Русский', exact: true }).click();
      }
    });

    test('signed-in attendee pages and the full-screen QR have no axe violations', async ({ page }) => {
      await mockApi(page);
      await signIn(page, 'attendee', '/tickets');
      await expect(page.getByRole('link', { name: 'Открыть билет №21' })).toBeVisible();
      await expectNoViolations(page, 'my tickets');
      await go(page, '/tickets/21');
      await expect(page.getByRole('img', { name: 'QR-код билета для проверки на входе' })).toBeVisible();
      await expectNoViolations(page, 'ticket');
      await page.getByRole('button', { name: 'Открыть QR-код на весь экран' }).click();
      await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
      await expectNoViolations(page, 'full-screen QR');
      await page.keyboard.press('Escape');
      await go(page, '/events/42');
      await expect(page.getByRole('link', { name: 'Открыть мой билет' })).toBeVisible();
      await expectNoViolations(page, 'event details (signed in)');
    });

    test('organizer and admin pages have no axe violations', async ({ page }) => {
      await mockApi(page, 'organizer');
      await signIn(page, 'organizer', '/organizer');
      await expect(page.getByRole('heading', { level: 3, name: eventDetails.title })).toBeVisible();
      await expectNoViolations(page, 'organizer cabinet');
      await go(page, '/organizer/events/new');
      await expect(page.getByLabel('Название', { exact: true })).toBeVisible();
      await expectNoViolations(page, 'new event');
      await go(page, '/organizer/events/42/edit');
      await expect(page.getByLabel('Название', { exact: true })).toHaveValue(eventDetails.title);
      await expectNoViolations(page, 'event editor');

      await page.unroute(`${base}/auth/me`);
      await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: person('admin') }));
      await signIn(page, 'admin', '/events');
      for (const [path, row] of [['/admin/users', 'Алия Организатор'], ['/admin/events', eventDetails.title], ['/admin/action-log', 'Suspended: spam']]) {
        await go(page, path);
        await expect(page.getByRole('row').filter({ hasText: row })).toBeVisible();
        await expectNoViolations(page, path);
      }
      await go(page, '/admin/users');
      await page.getByRole('button', { name: 'Заблокировать: organizer@example.com' }).click();
      await expectNoViolations(page, 'suspension reason form');
    });
  });
}

test('keyboard: the skip link moves focus to the content, and controls show a visible focus ring', async ({ page }) => {
  await mockApi(page);
  await page.goto('/events');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Перейти к содержимому' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toHaveAttribute('id', 'event-search');
  expect(await focused.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
});

test('keyboard: admin confirmation steps take focus and give it back when cancelled', async ({ page }) => {
  await mockApi(page, 'admin');
  await signIn(page, 'admin', '/events');
  await go(page, '/admin/users');
  const suspend = page.getByRole('button', { name: 'Заблокировать: organizer@example.com' });
  await suspend.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Причина блокировки', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Не блокировать', exact: true }).click();
  await expect(suspend).toBeFocused();

  const reactivate = page.getByRole('button', { name: 'Разблокировать: attendee@example.com' });
  await reactivate.focus();
  await page.keyboard.press('Enter');
  // The confirmation starts on the safe answer, so a second Enter changes nothing.
  const confirm = page.getByRole('group', { name: 'Подтвердите разблокировку.' });
  await expect(confirm.getByRole('button', { name: 'Оставить блокировку', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(reactivate).toBeFocused();
});

test('keyboard: the event cancellation question takes focus and gives it back when kept', async ({ page }) => {
  await mockApi(page, 'organizer');
  await signIn(page, 'organizer', '/organizer/events/42/edit');
  const cancel = page.getByRole('button', { name: 'Отменить событие', exact: true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Не отменять', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
});

test('the header keeps one row at 1280 px with the full language names, for organizers and admins', async ({ page }) => {
  for (const role of ['organizer', 'admin']) {
    await mockApi(page, role);
    await signIn(page, role, '/events');
    for (const language of ['Қазақша', 'English', 'Русский']) {
      await page.getByRole('button', { name: language, exact: true }).click();
      const header = await page.locator('.site-header').boundingBox();
      expect(header.height, `${role}, ${language}`).toBeLessThan(100);
    }
    await page.unrouteAll();
  }
});
