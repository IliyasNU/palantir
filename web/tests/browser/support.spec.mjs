import { expect, test } from '@playwright/test';
import { eventDetails } from './event-fixture.mjs';

const api = 'http://localhost:8000';
const time = '2030-01-01T00:00:00Z';
const roleIds = { attendee: 4, organizer: 7, admin: 9, staff: 10 };
const event = { id: 42, title: eventDetails.title, status: 'published' };
const order = { id: 81, event_id: 42, ticket_type_id: 1, buyer_id: 4, status: 'paid', attendee_name: 'Fixture attendee',
  attendee_email: 'attendee@example.com', subtotal_tiyn: 10050, processing_fee_tiyn: 302, total_tiyn: 10050,
  ticket_id: 21, expires_at: time, simulation: true };
const ticket = { id: 21, event_id: 42, attendee_id: 4, qr_payload: 'fixture-qr', created_at: time, checked_in_at: null,
  event: { ...event, date: eventDetails.date, location: eventDetails.location } };
const contact = 'Обратиться в поддержку';
const caseUrl = '/support/cases/11';

async function installSession(page, role) {
  await page.route(`${api}/auth/login`, route => route.fulfill({ json: { access_token: 'fixture-token', token_type: 'bearer' } }));
  await page.route(`${api}/auth/me`, route => route.fulfill({
    json: { id: roleIds[role], role, full_name: `Fixture ${role}`, email: `${role}@example.com`, is_active: true, email_verified: true, created_at: time },
  }));
}

async function signIn(page, destination, role, alreadyOnLogin = false) {
  if (!alreadyOnLogin) {
    await installSession(page, role);
    await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
  }
  await page.getByLabel('Email', { exact: true }).fill(`${role}@example.com`);
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(destination);
}

function caseFixture({ kind = 'attendee', requester = 'attendee', viewerSide = 'requester', canManage = false, subject = 'Вопрос по оплате',
  body = 'Где посмотреть оплату?', category = 'payment', context = { event, order: null, ticket: null } } = {}) {
  return { id: 11, kind, category, subject, status: 'open',
    requester: { id: roleIds[requester], full_name: `Fixture ${requester}`, masked_email: 'f***@example.com' },
    assignee: null, event_id: context.event?.id ?? null, event_title: context.event?.title ?? null,
    order_id: context.order?.id ?? null, ticket_id: context.ticket?.id ?? null, created_at: time, updated_at: time,
    last_message_at: time, last_message_by: 'requester', viewer_side: viewerSide, can_manage: canManage, context,
    messages: [{ id: 1, case_id: 11, author_id: roleIds[requester], author_name: `Fixture ${requester}`,
      author_side: 'requester', body, created_at: time }] };
}

async function fillCase(page, category, subject, message) {
  await page.getByLabel('Категория').selectOption(category);
  await page.getByLabel('Тема', { exact: true }).fill(subject);
  await page.getByLabel('Сообщение', { exact: true }).fill(message);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
}

for (const [type, id, path] of [['event', 42, '/events/42'], ['order', 81, '/orders/81'], ['ticket', 21, '/tickets/21']]) {
  test(`attendee raises a case from the ${type} and sends only that source ID`, async ({ page }) => {
    const detail = caseFixture({ context: {
      event, order: type === 'event' ? null : { id: 81, total_tiyn: 10050, status: 'paid' },
      ticket: type === 'ticket' ? { id: 21, status: 'active' } : null,
    } });
    for (const [endpoint, json] of [['/events/42', eventDetails], ['/orders/81', order], ['/tickets/21', ticket], ['/tickets/me', []]]) {
      await page.route(api + endpoint, route => route.fulfill({ json }));
    }
    await page.route(`${api}/support/cases`, route => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers().authorization).toBe('Bearer fixture-token');
      expect(route.request().postDataJSON()).toEqual({ kind: 'attendee', category: 'payment', subject: detail.subject,
        message: detail.messages[0].body, [`${type}_id`]: id });
      return route.fulfill({ status: 201, json: detail });
    });
    await page.route(api + caseUrl, route => {
      if (route.request().method() === 'PATCH') {
        expect(route.request().postDataJSON()).toEqual({ status: 'resolved' });
        detail.status = 'resolved';
      }
      return route.fulfill({ json: detail });
    });
    await page.route(`${api}/support/cases/mine?*`, route => route.fulfill({ json: [detail] }));
    const source = `/support/new?${type}=${id}`;
    if (type === 'event') {
      await installSession(page, 'attendee');
      await page.goto(path);
      await page.getByRole('link', { name: contact, exact: true }).click();
      await expect(page).toHaveURL(source);
      await page.getByRole('main').getByRole('link', { name: 'Войти', exact: true }).click();
      await signIn(page, source, 'attendee', true);
    } else {
      await signIn(page, path, 'attendee');
      await page.getByRole('link', { name: contact, exact: true }).click();
      await expect(page).toHaveURL(source);
    }
    await fillCase(page, 'payment', detail.subject, detail.messages[0].body);
    await expect(page).toHaveURL(caseUrl);
    await expect(page.getByText(detail.messages[0].body, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Назначить себя' })).toHaveCount(0);
    if (type === 'event') {
      await page.getByRole('button', { name: 'Закрыть обращение', exact: true }).click();
      await expect(page.getByText('Закрыто', { exact: true })).toBeVisible();
      await page.getByRole('navigation').getByRole('link', { name: 'Поддержка' }).click();
      await page.getByRole('link', { name: detail.subject }).click();
      await expect(page).toHaveURL(caseUrl);
    }
  });
}

test('organizer files a platform case from the cabinet', async ({ page }) => {
  const detail = caseFixture({ kind: 'organizer', requester: 'organizer', category: 'activation',
    context: { event: null, order: null, ticket: null }, subject: 'Активация продаж' });
  await page.route(`${api}/events/mine`, route => route.fulfill({ json: [] }));
  await page.route(`${api}/support/cases`, route => {
    expect(route.request().postDataJSON()).toEqual({
      kind: 'organizer', category: 'activation', subject: detail.subject, message: detail.messages[0].body,
    });
    return route.fulfill({ status: 201, json: detail });
  });
  await page.route(api + caseUrl, route => route.fulfill({ json: detail }));
  await signIn(page, '/organizer', 'organizer');
  await page.getByRole('link', { name: 'Написать в поддержку платформы' }).click();
  await expect(page.getByRole('option', { name: 'Получение билета' })).toHaveCount(0);
  await fillCase(page, 'activation', detail.subject, detail.messages[0].body);
  await expect(page).toHaveURL(caseUrl);
  await expect(page.getByRole('heading', { name: detail.subject })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Управление обращением' })).toHaveCount(0);
});

test('an event organizer filters their event queue, assigns, changes status, and replies', async ({ page }) => {
  const detail = caseFixture({ viewerSide: 'staff', canManage: true });
  const patches = [];
  await page.route(`${api}/events/mine`, route => route.fulfill({ json: [eventDetails] }));
  await page.route(`${api}/events/42/support-cases?*`, route => {
    const status = new URL(route.request().url()).searchParams.get('status');
    return route.fulfill({ json: status === null || status === detail.status ? [detail] : [] });
  });
  await page.route(api + caseUrl, route => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON();
      patches.push(patch);
      if ('assignee_id' in patch) detail.assignee = { id: patch.assignee_id, full_name: 'Fixture organizer' };
      if ('status' in patch) detail.status = patch.status;
    }
    return route.fulfill({ json: detail });
  });
  await page.route(`${api}${caseUrl}/messages`, route => {
    expect(route.request().method()).toBe('POST');
    const message = { id: 2, case_id: 11, author_id: 7, author_name: 'Fixture organizer',
      author_side: 'staff', ...route.request().postDataJSON(), created_at: time };
    detail.messages.push(message);
    return route.fulfill({ status: 201, json: message });
  });
  await signIn(page, '/organizer', 'organizer');
  await page.getByRole('link', { name: /Обращения по событию/ }).click();
  await page.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('resolved');
  await expect(page.getByText('Обращений пока нет.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('open');
  await page.getByRole('link', { name: detail.subject }).click();
  await page.getByRole('button', { name: 'Назначить себя' }).click();
  await expect(page.getByText('Fixture organizer', { exact: true }).last()).toBeVisible();
  await page.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('waiting_for_customer');
  await page.getByRole('button', { name: 'Сохранить статус' }).click();
  await expect(page.getByText('Ожидает ответа автора', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Ответить', { exact: true }).fill('Напишите номер заказа.');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('Напишите номер заказа.', { exact: true })).toBeVisible();
  expect(patches).toEqual([{ assignee_id: 7 }, { status: 'waiting_for_customer' }]);
});

test('admin filters platform cases and an assignment error follows the locale', async ({ page }) => {
  const detail = caseFixture({ kind: 'organizer', requester: 'organizer', viewerSide: 'staff', canManage: true });
  const queries = [];
  await page.route(`${api}/support/cases/mine?*`, route => route.fulfill({ json: [] }));
  await page.route(`${api}/admin/support-cases?*`, route => {
    queries.push(new URL(route.request().url()).searchParams.get('kind'));
    return route.fulfill({ json: [detail] });
  });
  await page.route(api + caseUrl, route => {
    if (route.request().method() === 'PATCH') {
      expect(route.request().postDataJSON()).toEqual({ assignee_id: 123 });
      return route.fulfill({ status: 422, json: { detail: { code: 'INVALID_ASSIGNEE', message: 'Private server detail' } } });
    }
    return route.fulfill({ json: detail });
  });
  await signIn(page, '/support', 'admin');
  await page.getByRole('link', { name: 'Очередь поддержки' }).click();
  await expect(page).toHaveURL('/admin/support');
  await page.getByLabel('Вид обращения').selectOption('organizer');
  await page.getByRole('link', { name: detail.subject }).click();
  expect(queries).toContain('organizer');
  await page.getByLabel('ID ответственного').fill('123');
  await page.getByRole('button', { name: 'Назначить', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Этот пользователь не может обрабатывать обращение.');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('This user cannot handle the support case.');
});

test('event check-in staff are not treated as support case handlers', async ({ page }) => {
  await signIn(page, '/organizer/events/42/support', 'staff');
  await expect(page.getByRole('alert')).toHaveText('У вас нет доступа к этому действию.');
  await expect(page.getByRole('button', { name: 'Назначить себя' })).toHaveCount(0);
});
