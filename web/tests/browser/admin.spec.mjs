import { test, expect } from '@playwright/test';

test.use({ timezoneId: 'Asia/Almaty' });

const base = 'http://localhost:8000';
const account = (role, id = 1) => ({ id, email: `${role}@example.com`, full_name: `Fixture ${role}`, role, is_active: true, created_at: '2030-01-01T00:00:00Z' });
const users = [account('admin'), { ...account('organizer', 5), full_name: 'Алия Организатор' }, { ...account('attendee', 6), full_name: 'Спамер', is_active: false }];
const event = { id: 9, organizer_id: 5, title: 'Вечер джаза', description: null, date: '2030-07-15T12:00:00Z', location: 'Hall', status: 'published',
  capacity: 50, tickets_issued: 3, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z', suspended: false, suspended_at: null };
const entry = (id, more = {}) => ({ id, event_id: null, occurred_at: '2030-01-02T07:00:00Z', actor_id: 1, actor_name: 'Fixture admin',
  action: 'user.suspended', entity_type: 'user', entity_id: 6, description: 'Suspended the account: spam', ...more });

async function login(page, role) {
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', refresh_token: 'unused', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: account(role) }));
  await page.route(`${base}/events`, (route) => route.fulfill({ json: [] }));
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(`${role}@example.com`);
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toContainText(`Fixture ${role}`);
}
const go = (page, path) => page.evaluate((target) => {
  history.pushState(null, '', target);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);
const query = (request) => Object.fromEntries(new URL(request.url()).searchParams);
// The dev server runs React StrictMode, which starts each load twice; equal neighbours are one logical request.
const distinct = (list) => list.filter((item, index) => index === 0 || JSON.stringify(item) !== JSON.stringify(list[index - 1]));

test('a guest is asked to sign in and a non-admin gets the 403 page without any admin request', async ({ page }) => {
  const requested = [];
  page.on('request', (request) => { if (request.url().startsWith(`${base}/admin`)) requested.push(request.url()); });
  await page.goto('/admin');
  await expect(page.getByText('Войдите в аккаунт администратора.')).toBeVisible();
  for (const role of ['attendee', 'organizer']) {
    await login(page, role);
    await expect(page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link', { name: 'Администрирование' })).toHaveCount(0);
    for (const path of ['/admin', '/admin/users', '/admin/events', '/admin/action-log']) {
      await go(page, path);
      await expect(page.getByRole('heading', { name: '403 — доступ запрещён' })).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
    }
  }
  expect(requested).toEqual([]);
});

test('an admin searches users and suspends one with a reason, by API code on refusal, at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const calls = [];
  let rows = users.map((row) => ({ ...row }));
  await page.route(`${base}/admin/users?*`, (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    calls.push(['GET', query(route.request())]);
    const q = (query(route.request()).q ?? '').toLowerCase();
    return route.fulfill({ json: rows.filter((row) => row.full_name.toLowerCase().includes(q)) });
  });
  await page.route(`${base}/admin/users/*/*`, (route) => {
    const [, id, action] = new URL(route.request().url()).pathname.match(/users\/(\d+)\/(\w+)$/);
    calls.push([`POST ${id}/${action}`, route.request().postDataJSON()]);
    if (id === '5' && route.request().postDataJSON()?.reason === 'уже удалён') {
      return route.fulfill({ status: 404, json: { detail: { code: 'USER_NOT_FOUND', message: 'User not found' } } });
    }
    rows = rows.map((row) => (String(row.id) === id ? { ...row, is_active: action === 'reactivate' } : row));
    return route.fulfill({ json: rows.find((row) => String(row.id) === id) });
  });
  await login(page, 'admin');
  await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link', { name: 'Администрирование' }).click();
  const table = page.getByRole('table', { name: 'Пользователи' });
  await expect(table.getByRole('row')).toHaveCount(4);
  expect(distinct(calls)).toEqual([['GET', { limit: '50' }]]);
  // An admin cannot suspend their own account from here.
  await expect(table.getByRole('row', { name: /Fixture admin/ })).toContainText('Это ваш аккаунт');
  await expect(table.getByRole('row', { name: /Fixture admin/ }).getByRole('button')).toHaveCount(0);

  const target = table.getByRole('row', { name: /Алия Организатор/ });
  await target.getByRole('button', { name: 'Заблокировать: organizer@example.com' }).click();
  await target.getByLabel('Причина блокировки').fill('ab');
  await target.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(target.getByRole('alert')).toHaveText('Укажите причину: от 3 до 300 символов.');
  await target.getByLabel('Причина блокировки').fill('уже удалён');
  await target.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(target.getByRole('alert')).toHaveText('Пользователь не найден.');
  await target.getByLabel('Причина блокировки').fill('  Жалобы на мошенничество  ');
  await target.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Аккаунт «Алия Организатор» заблокирован.');
  await expect(target).toContainText('Заблокирован');
  await target.getByRole('button', { name: 'Разблокировать: organizer@example.com' }).click();
  await expect(page.getByRole('status')).toHaveText('Аккаунт «Алия Организатор» разблокирован.');
  expect(distinct(calls).slice(1)).toEqual([['POST 5/suspend', { reason: 'уже удалён' }], ['POST 5/suspend', { reason: 'Жалобы на мошенничество' }], ['POST 5/reactivate', null]]);

  // Server search by text; role and state narrow the loaded rows.
  await page.getByLabel('Имя или email').fill(' спам ');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  expect(calls.at(-1)).toEqual(['GET', { q: 'спам', limit: '50' }]);
  await page.getByLabel('Состояние').selectOption('true');
  await expect(page.getByRole('status')).toHaveText('Пользователи не найдены.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an admin filters events and suspends and reactivates one', async ({ page }) => {
  const calls = [];
  let current = { ...event };
  await page.route(`${base}/admin/events?*`, (route) => { calls.push(['GET', query(route.request())]); return route.fulfill({ json: [current, { ...event, id: 10, title: 'Черновик', status: 'draft' }] }); });
  await page.route(`${base}/admin/events/*/*`, (route) => {
    const action = route.request().url().split('/').at(-1);
    calls.push([`POST ${action}`, route.request().postDataJSON()]);
    current = { ...current, suspended: action === 'suspend', suspended_at: action === 'suspend' ? '2030-03-01T04:30:00Z' : null };
    return route.fulfill({ json: current });
  });
  await login(page, 'admin');
  await go(page, '/admin/events');
  const table = page.getByRole('table', { name: 'События' });
  const row = table.getByRole('row', { name: /Вечер джаза/ });
  await expect(row).toContainText('Опубликовано');
  await expect(row).toContainText('3 / 50');
  await row.getByRole('button', { name: 'Заблокировать: Вечер джаза #9' }).click();
  await row.getByLabel('Причина блокировки').fill('Подозрение на мошенничество');
  await row.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Событие «Вечер джаза» заблокировано и скрыто от посетителей.');
  await expect(row).toContainText('Заблокировано с 1 мар. 2030 г., 09:30');
  await row.getByRole('button', { name: 'Разблокировать: Вечер джаза #9' }).click();
  await expect(page.getByRole('status')).toHaveText('Блокировка события «Вечер джаза» снята.');
  await page.getByLabel('Статус').selectOption('draft');
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByLabel('Блокировка').selectOption('true');
  await expect.poll(() => calls.at(-1)).toEqual(['GET', { suspended: 'true', limit: '50' }]);
  expect(distinct(calls).slice(0, 3)).toEqual([['GET', { limit: '50' }], ['POST suspend', { reason: 'Подозрение на мошенничество' }], ['POST reactivate', null]]);
});

test('the action log is read only, filtered on the server and paged by offset', async ({ page }) => {
  const calls = [];
  await page.route(`${base}/admin/action-log?*`, (route) => {
    const params = query(route.request());
    calls.push(params);
    const offset = Number(params.offset);
    const rows = params.action ? [entry(900, { event_id: 7, action: 'event.suspended', entity_type: 'event', entity_id: 7 })]
      : Array.from({ length: offset === 0 ? 50 : 3 }, (_, index) => entry(offset + index + 1));
    return route.fulfill({ json: rows });
  });
  await login(page, 'admin');
  await go(page, '/admin/action-log');
  const table = page.getByRole('table', { name: 'Журнал действий' });
  await expect(table.getByRole('row')).toHaveCount(51);
  await expect(table.getByRole('row').nth(1)).toContainText('платформа');
  await expect(table.getByRole('row').nth(1)).toContainText('2 янв. 2030 г., 12:00');
  await expect(page.getByText('Журнал только для чтения')).toBeVisible();
  await expect(table.getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(page.getByText('Записи 51–53')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Дальше' })).toBeDisabled();
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(page.getByText('Записи 1–50')).toBeVisible();
  expect(distinct(calls)).toEqual([{ limit: '50', offset: '0' }, { limit: '50', offset: '50' }, { limit: '50', offset: '0' }]);
  const before = calls.length;

  await page.getByLabel('ID события').fill('семь');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page.getByRole('alert')).toHaveText('ID события: целое положительное число.');
  expect(calls).toHaveLength(before);
  await page.getByLabel('Действие или группа').fill('event');
  await page.getByLabel('ID события').fill('7');
  await page.getByLabel('С', { exact: true }).fill('2030-01-01T05:00');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('link', { name: '#7' })).toHaveAttribute('href', '/events/7');
  expect(calls.at(-1)).toEqual({ action: 'event', event_id: '7', date_from: '2030-01-01T00:00:00.000Z', limit: '50', offset: '0' });
});

test('a refusal from the API is shown as missing admin rights', async ({ page }) => {
  await page.route(`${base}/admin/users?*`, (route) => route.fulfill({ status: 403, json: { detail: 'You do not have permission to do this' } }));
  await login(page, 'admin');
  await go(page, '/admin/users');
  await expect(page.getByRole('region', { name: 'Пользователи' }).getByRole('alert')).toContainText('У вас нет прав администратора для этого действия.');
  await expect(page.getByText('You do not have permission')).toHaveCount(0);
});
