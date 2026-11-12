import { test, expect } from '@playwright/test';

test.use({ timezoneId: 'Asia/Almaty' }); // UTC+5: the form shows local time and the API receives UTC

const base = 'http://localhost:8000';
const account = (role) => ({ id: 3, email: `${role}@example.com`, full_name: `Fixture ${role}`, role, is_active: true, created_at: '2030-01-01T00:00:00Z' });
const draft = { id: 9, organizer_id: 3, title: 'Вечер джаза', description: null, date: '2030-07-15T12:00:00Z', location: 'Orange Hall',
  status: 'draft', capacity: 50, tickets_issued: 0, created_at: '2030-01-01T00:00:00Z', updated_at: '2030-01-01T00:00:00Z' };

async function login(page, role, destination = '/organizer') {
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', refresh_token: 'unused', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: account(role) }));
  await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
  await page.getByLabel('Email', { exact: true }).fill(`${role}@example.com`);
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('navigation')).toContainText(`Fixture ${role}`);
}
const go = (page, path) => page.evaluate((target) => {
  history.pushState(null, '', target);
  dispatchEvent(new PopStateEvent('popstate'));
}, path);

test('an organizer creates a draft, publishes it, edits it and cancels it at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  let current = { ...draft };
  const calls = [];
  await page.route(`${base}/events/mine`, (route) => route.fulfill({ json: [] }));
  await page.route(`${base}/events`, (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    calls.push(['POST /events', route.request().postDataJSON()]);
    return route.fulfill({ status: 201, json: current });
  });
  await page.route(`${base}/events/9`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: current });
    calls.push([`${route.request().method()} /events/9`, route.request().postDataJSON()]);
    current = { ...current, ...route.request().postDataJSON(), updated_at: '2030-01-02T00:00:00Z' };
    return route.fulfill({ json: current });
  });
  for (const action of ['publish', 'cancel']) {
    await page.route(`${base}/events/9/${action}`, (route) => {
      expect(route.request().method()).toBe('POST');
      calls.push([`POST /events/9/${action}`, route.request().postData()]);
      current = { ...current, status: action === 'publish' ? 'published' : 'cancelled' };
      return route.fulfill({ json: current });
    });
  }

  await login(page, 'organizer');
  await expect(page).toHaveURL('/organizer');
  await expect(page.getByRole('status')).toHaveText('У вас пока нет созданных событий.');
  await page.getByRole('link', { name: 'Создать событие' }).click();
  await expect(page).toHaveURL('/organizer/events/new');

  // The API limits are checked before anything is sent.
  await page.getByLabel('Название', { exact: true }).fill('ab');
  await page.getByLabel('Вместимость', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Создать черновик' }).click();
  for (const message of ['Название: от 3 до 200 символов.', 'Укажите дату и время начала.', 'Место проведения: от 2 до 255 символов.', 'Вместимость: целое число от 1 до 1 000 000.']) {
    await expect(page.getByRole('alert')).toContainText(message);
  }
  expect(calls).toHaveLength(0);

  await page.getByLabel('Название', { exact: true }).fill(' Вечер джаза ');
  await page.getByLabel('Дата и время начала', { exact: true }).fill('2030-07-15T17:00');
  await expect(page.getByText('Укажите время в вашем часовом поясе (Asia/Almaty).')).toBeVisible();
  await page.getByLabel('Место проведения', { exact: true }).fill('Orange Hall');
  await page.getByLabel('Вместимость', { exact: true }).fill('50');
  await page.getByRole('button', { name: 'Создать черновик' }).click();
  await expect(page).toHaveURL('/organizer/events/9/edit');
  expect(calls).toEqual([['POST /events', { title: 'Вечер джаза', description: null, date: '2030-07-15T12:00:00.000Z', location: 'Orange Hall', capacity: 50 }]]);
  await expect(page.getByRole('status')).toHaveText('Черновик создан. Проверьте данные и опубликуйте событие.');
  const status = page.getByRole('region', { name: 'Статус и публикация' });
  await expect(status).toContainText('Статус: Черновик');
  await expect(page.getByLabel('Дата и время начала', { exact: true })).toHaveValue('2030-07-15T17:00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await status.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(status).toContainText('Статус: Опубликовано');
  await expect(page.getByRole('status')).toHaveText('Событие опубликовано.');
  await expect(status.getByRole('button', { name: 'Опубликовать' })).toHaveCount(0);

  // Saving without changes sends nothing; an edit sends only the changed field.
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('status')).toHaveText('Изменений нет.');
  await page.getByLabel('Вместимость', { exact: true }).fill('60');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('status')).toHaveText('Изменения сохранены.');

  // Cancelling is irreversible, so it needs a second, explicit step.
  await status.getByRole('button', { name: 'Отменить событие' }).click();
  await status.getByRole('button', { name: 'Не отменять' }).click();
  await status.getByRole('button', { name: 'Отменить событие' }).click();
  await expect(status).toContainText('Это действие необратимо');
  await status.getByRole('button', { name: 'Да, отменить событие' }).click();
  await expect(status).toContainText('Статус: Отменено');
  await expect(status).toContainText('Его нельзя опубликовать снова.');
  await expect(status.getByRole('button')).toHaveCount(0);
  expect(calls.slice(1)).toEqual([['POST /events/9/publish', null], ['PATCH /events/9', { capacity: 60 }], ['POST /events/9/cancel', null]]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the cabinet lists own events in every status with links, and shows a suspension', async ({ page }) => {
  await page.route(`${base}/events/mine`, (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    return route.fulfill({ json: [draft, { ...draft, id: 10, title: 'Отменённый концерт', status: 'cancelled', tickets_issued: 12 },
      { ...draft, id: 11, title: 'Скрытый фестиваль', status: 'published', suspended: true }] });
  });
  await login(page, 'organizer', '/events');
  await page.route(`${base}/events`, (route) => route.fulfill({ json: [] }));
  await page.getByRole('navigation').getByRole('link', { name: 'Мои события' }).click();
  const items = page.getByRole('listitem');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Черновик');
  await expect(items.nth(0)).toContainText('15 июля 2030');
  await expect(items.nth(1)).toContainText('Отменено');
  await expect(items.nth(1)).toContainText('12');
  await expect(items.nth(2)).toContainText('Событие заблокировано администратором');
  await expect(page.getByRole('link', { name: 'Редактировать: Вечер джаза' })).toHaveAttribute('href', '/organizer/events/9/edit');
  await expect(page.getByRole('link', { name: 'Типы билетов: Вечер джаза' })).toHaveAttribute('href', '/organizer/events/9/ticket-types');
  await expect(page.getByRole('link', { name: 'Страница события: Вечер джаза' })).toHaveAttribute('href', '/events/9');
});

test('API refusals are shown by code and a missing event is not editable', async ({ page }) => {
  await page.route(`${base}/events/mine`, (route) => route.fulfill({ json: [] }));
  await page.route(`${base}/events/9`, (route) => (route.request().method() === 'GET'
    ? route.fulfill({ json: { ...draft, status: 'published', tickets_issued: 40, suspended: true } })
    : route.fulfill({ status: 409, json: { detail: { code: 'CAPACITY_BELOW_ISSUED', message: 'Capacity cannot be lower than the tickets already issued' } } })));
  await page.route(`${base}/events/404`, (route) => route.fulfill({ status: 404, json: { detail: { code: 'EVENT_NOT_FOUND', message: 'Event not found' } } }));
  await login(page, 'organizer');
  await go(page, '/organizer/events/9/edit');
  await expect(page.getByRole('region', { name: 'Статус и публикация' })).toContainText('Событие заблокировано администратором и скрыто от посетителей.');
  await page.getByLabel('Вместимость', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('alert')).toHaveText('Вместимость нельзя сделать меньше числа уже выданных билетов.');
  await expect(page.getByRole('alert')).not.toContainText('Capacity cannot');
  await go(page, '/organizer/events/404/edit');
  await expect(page.getByRole('status')).toHaveText('Такого события нет или оно вам недоступно.');
  await go(page, '/organizer/events/abc/edit');
  await expect(page.getByRole('status')).toHaveText('Такого события нет или оно вам недоступно.');
});

test('visitors and guests cannot open the cabinet; an admin can edit an event but has no cabinet', async ({ page }) => {
  const requested = [];
  page.on('request', (request) => { if (request.url().includes('/events/mine')) requested.push(request.url()); });
  await page.goto('/organizer');
  await expect(page.getByRole('link', { name: 'Войти', exact: true }).last()).toHaveAttribute('href', '/login?returnTo=%2Forganizer');
  await login(page, 'attendee');
  await expect(page).toHaveURL('/organizer');
  await expect(page.getByRole('alert')).toContainText('У вас нет прав для доступа к кабинету организатора.');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Мои события' })).toHaveCount(0);
  await go(page, '/organizer/events/new');
  await expect(page.getByRole('alert')).toContainText('У вас нет прав для доступа к кабинету организатора.');
  await expect(page.getByLabel('Название', { exact: true })).toHaveCount(0);

  await page.route(`${base}/events/9`, (route) => route.fulfill({ json: draft }));
  await login(page, 'admin');
  await expect(page.getByRole('alert')).toContainText('У вас нет прав для доступа к кабинету организатора.');
  await go(page, '/organizer/events/9/edit');
  await expect(page.getByLabel('Название', { exact: true })).toHaveValue('Вечер джаза');
  expect(requested).toEqual([]);
});
