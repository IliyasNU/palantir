import {test, expect} from '@playwright/test';
import {eventDetails} from './event-fixture.mjs';

const base = 'http://localhost:8000';
const account = {id: 7, role: 'admin', email: 'admin@example.com', full_name: 'Admin',
  is_active: true, created_at: '2030-01-01T00:00:00Z'};
const go = (page, path) => page.evaluate(path => {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);
async function login(page, path) {
  await page.route(base + '/auth/login', r => r.fulfill({json: {access_token: 'fixture', token_type: 'bearer'}}));
  await page.route(base + '/auth/me', r => r.fulfill({json: account}));
  await page.goto('/login');
  await page.getByLabel('Email', {exact: true}).fill(account.email);
  await page.getByLabel('Пароль', {exact: true}).fill('fixture-password');
  await page.getByRole('button', {name: 'Войти', exact: true}).click();
  await expect(page.getByText('Admin', {exact: true})).toBeVisible();
  await go(page, path);
}

test('a visible API failure changes language without another request', async ({page}) => {
  let calls = 0;
  await page.route(base + '/events', r => { calls++; return r.fulfill({status: 500}); });
  await page.goto('/events');
  await expect(page.getByRole('alert')).toContainText('Сервер временно недоступен');
  const before = calls;
  await page.getByRole('button', {name: 'Қазақша', exact: true}).click();
  await expect(page.getByRole('alert')).not.toContainText('Сервер временно недоступен');
  await expect(page.getByRole('alert')).not.toContainText('Server');
  expect(calls).toBe(before);
});

test('password recovery preserves a selected paid checkout', async ({page}) => {
  const path = '/events/42/checkout?type=1';
  await page.goto('/login?returnTo=' + encodeURIComponent(path));
  await page.getByRole('link', {name: 'Забыли пароль?'}).click();
  const link = await page.getByRole('link', {name: 'Перейти ко входу'}).getAttribute('href');
  expect(new URL(link, page.url()).searchParams.get('returnTo')).toBe(path);
});

test('a new SPA reset link clears invalid state and requires matching passwords', async ({page}) => {
  const requests = [];
  await page.route(base + '/auth/reset-password', r => {
    const body = r.request().postDataJSON();
    requests.push(body);
    return body.token === 'old' ? r.fulfill({status: 400, json: {detail: {code: 'INVALID_TOKEN'}}}) : r.fulfill({status: 204});
  });
  await page.goto('/reset-password?token=old');
  const fill = async (confirmation = 'new-password') => {
    await page.getByLabel('Новый пароль', {exact: true}).fill('new-password');
    await page.getByLabel('Повторите пароль', {exact: true}).fill(confirmation);
  };
  await fill();
  await page.getByRole('button', {name: 'Сохранить пароль'}).click();
  await expect(page.getByRole('alert')).toContainText('Ссылка недействительна');
  await go(page, '/reset-password?token=fresh');
  await fill('different');
  await page.getByRole('button', {name: 'Сохранить пароль'}).click();
  await expect(page.getByRole('alert')).toContainText('Пароли не совпадают');
  expect(requests).toHaveLength(1);
  await fill();
  await page.getByRole('button', {name: 'Сохранить пароль'}).click();
  await expect(page.getByRole('status')).toContainText('Пароль изменён');
  expect(requests.at(-1)).toEqual({token: 'fresh', new_password: 'new-password'});
});

test('a different verification link shows checking until its own answer', async ({page}) => {
  let finish;
  await page.route(base + '/auth/verify-email', r => r.request().postDataJSON().token === 'one'
    ? r.fulfill({json: account}) : new Promise(resolve => {finish = async () => {await r.fulfill({status: 400, json: {detail: {code: 'INVALID_TOKEN'}}}); resolve();};}));
  await page.goto('/verify-email?token=one');
  await expect(page.getByRole('status')).toContainText('Email подтверждён');
  await go(page, '/verify-email?token=two');
  await expect(page.getByRole('status')).not.toContainText('Email подтверждён');
  await expect.poll(() => !!finish).toBe(true);
  await finish();
  await expect(page.getByRole('alert')).toContainText('Ссылка недействительна');
});

test('admin controls have unique labels, protect admins and confirm reactivation', async ({page}) => {
  let writes = 0;
  let rows = [{...account, id: 8, full_name: 'Other Admin'},
    {...account, id: 9, role: 'organizer', email: 'a.b@example.com'},
    {...account, id: 10, role: 'attendee', email: 'a-b@example.com'},
    {...account, id: 11, role: 'attendee', email: 'inactive@example.com', is_active: false}];
  await page.route(base + '/admin/users?*', r => r.fulfill({json: rows}));
  await page.route(base + '/admin/users/11/reactivate', r => {writes++; return r.fulfill({json: {...rows[3], is_active: true}});});
  await login(page, '/admin/users');
  // Wait for the rows: before they load, "no buttons" would pass vacuously.
  await expect(page.getByRole('row').filter({hasText: 'Other Admin'})).toBeVisible();
  await expect(page.getByRole('row').filter({hasText: 'Other Admin'}).getByRole('button')).toHaveCount(0);
  await page.getByRole('button', {name: 'Заблокировать: a.b@example.com'}).click();
  await page.getByRole('button', {name: 'Заблокировать: a-b@example.com'}).click();
  const inputs = page.getByLabel('Причина блокировки', {exact: true});
  await expect(inputs).toHaveCount(2);
  expect(await inputs.nth(0).getAttribute('id')).not.toBe(await inputs.nth(1).getAttribute('id'));
  const row = page.getByRole('row').filter({hasText: 'inactive@example.com'});
  await row.getByRole('button', {name: 'Разблокировать: inactive@example.com'}).click();
  expect(writes).toBe(0);
  await row.getByRole('button', {name: 'Оставить блокировку', exact: true}).click();
  expect(writes).toBe(0);
  await row.getByRole('button', {name: 'Разблокировать: inactive@example.com'}).click();
  await row.getByRole('button', {name: 'Разблокировать', exact: true}).click();
  await expect.poll(() => writes).toBe(1);
  await expect(page.getByRole('status')).toContainText('разблокирован');
  await page.getByRole('button', {name: 'English', exact: true}).click();
  await expect(page.getByRole('status')).toContainText('reactivated');
});

test('reactivated events leave the suspended-only list', async ({page}) => {
  let event = {...eventDetails, suspended: true, suspended_at: '2030-01-01T00:00:00Z'};
  await page.route(base + '/admin/events?*', r => r.fulfill({json: [event]}));
  await page.route(base + '/admin/events/42/reactivate', r => {
    event = {...event, suspended: false, suspended_at: null};
    return r.fulfill({json: event});
  });
  await login(page, '/admin/events');
  await page.getByLabel('Блокировка', {exact: true}).selectOption('true');
  await page.getByRole('button', {name: /Разблокировать:/}).click();
  await page.getByRole('button', {name: 'Разблокировать', exact: true}).click();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('Kazakh server validation and event dates use readable localized text', async ({page}) => {
  await page.route(base + '/events', r => r.fulfill({json: [{...eventDetails, date: '2030-11-15T12:00:00Z'}]}));
  await page.goto('/events');
  await page.getByRole('button', {name: 'Қазақша', exact: true}).click();
  await expect(page.locator('time')).toContainText('қараша');
  await expect(page.locator('time')).not.toContainText('M11');
  await page.route(base + '/auth/register', r => r.fulfill({status: 422, json: {detail: [{loc: ['body', 'email'], msg: 'value is not a valid email address'}]}}));
  await page.goto('/register');
  await page.getByLabel('Email', {exact: true}).fill('test@example.com');
  await page.locator('input[name="full_name"]').fill('Example');
  await page.locator('input[name="password"]').fill('fixture-password');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText('value is not a valid');
});
